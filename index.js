import { readFile } from 'node:fs/promises'
import { AtlasInputError, AtlasNotFoundError, AtlasStore } from './src/server/store.js'

export const name = 'atlas'
export const inject = ['webServer', 'sessions', 'sessionQuery']

const MAX_BODY_BYTES = 64 * 1024

export function apply(ctx, config = {}) {
  const store = new AtlasStore(config.dataFile)
  const trustedHosts = new Set(['localhost', '127.0.0.1', '::1', ...(config.trustedHosts ?? []).map(hostnameOf).filter(Boolean)])
  const autoProjection = config.autoProjection !== false
  const report = error => ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
  ctx.effect(() => () => { void store.close() }, 'atlas: store close')

  const replay = session => {
    const replayFrom = session?.header?.parentSession === undefined ? 0 : session.firstLiveSeq
    void store.projectSession(session, replayFrom).catch(report)
  }
  let scheduled = false
  const batchedProjection = new Map()
  let projectionSerial = Promise.resolve()
  const queueProjection = (session, event) => {
    const batch = batchedProjection.get(session.id) ?? { session, events: [] }
    batch.events.push(event)
    batchedProjection.set(session.id, batch)
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const batches = [...batchedProjection.values()]
      batchedProjection.clear()
      projectionSerial = projectionSerial.then(async () => {
        for (const batch of batches) await store.projectEvents(batch.session, batch.events)
      }).catch(report)
    })
  }

  if (autoProjection) {
    ctx.on('session/created', replay)
    ctx.on('session/event', queueProjection)
    for (const session of ctx.sessions.list()) replay(session)
    void projectColdSessions(ctx.sessionQuery, store).catch(report)
  }

  const api = async (req, res) => {
    try {
      const host = hostnameOf(req.headers.host)
      if (!trustedHosts.has(host)) return sendJson(res, 403, { error: '不被信任的 Host' })
      const path = new URL(req.url ?? '/', 'http://atlas.local').pathname
      if (path === '/atlas/api/graph' && req.method === 'GET') return sendJson(res, 200, await store.graph())
      if (path === '/atlas/api/conversations' && req.method === 'GET') return sendJson(res, 200, await store.conversationCards(new URL(req.url ?? '/', 'http://atlas.local').searchParams.get('cwd') ?? undefined))
      if (path === '/atlas/api/workspaces' && req.method === 'GET') return sendJson(res, 200, { workspaces: (await store.graph()).workspaces })
      if (path === '/atlas/api/sessions/sync' && req.method === 'POST') { const body = await readJson(req); return sendJson(res, 200, await store.syncSessions(body.sessions, body.removedSessionIds)) }
      const detail = /^\/atlas\/api\/cards\/([^/]+)$/.exec(path)
      if (detail !== null && req.method === 'GET') return sendJson(res, 200, await store.cardDetail(decodeURIComponent(detail[1])))
      const position = /^\/atlas\/api\/cards\/([^/]+)\/position$/.exec(path)
      if (position !== null && req.method === 'PATCH') { const id = decodeURIComponent(position[1]); const body = await readJson(req); return sendJson(res, 200, { position: id.includes(':') ? await store.setCardPosition(id, body.position) : await store.setPosition(id, body.position) }) }
      const hide = /^\/atlas\/api\/cards\/([^/]+)\/hide$/.exec(path)
      if (hide !== null && req.method === 'POST') { await store.hide(sessionIdForCard(decodeURIComponent(hide[1]))); return sendJson(res, 204) }
      const remove = /^\/atlas\/api\/cards\/([^/]+)\/delete$/.exec(path)
      if (remove !== null && req.method === 'POST') { const body = await readJson(req); return sendJson(res, 200, await store.deleteCard(decodeURIComponent(remove[1]), body.mode, body.successorCardId)) }
      const undoDelete = /^\/atlas\/api\/deletions\/([^/]+)\/undo$/.exec(path)
      if (undoDelete !== null && req.method === 'POST') return sendJson(res, 200, await store.undoDelete(decodeURIComponent(undoDelete[1])))
      const rename = /^\/atlas\/api\/cards\/([^/]+)\/title$/.exec(path)
      if (rename !== null && req.method === 'PATCH') { await store.rename(sessionIdForCard(decodeURIComponent(rename[1])), (await readJson(req)).title); return sendJson(res, 204) }
      return sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      if (error instanceof AtlasNotFoundError) return sendJson(res, 404, { error: error.message })
      if (error instanceof AtlasInputError) return sendJson(res, 400, { error: error.message })
      if (error instanceof SyntaxError || error?.message === '请求内容过大') return sendJson(res, 400, { error: error.message || '请求不是有效 JSON' })
      report(error)
      return sendJson(res, 500, { error: 'Atlas 数据暂时不可用' })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/atlas', handler: (_req, res) => redirect(res, '/atlas/') }), 'atlas: redirect')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/atlas/', handler: async (_req, res) => sendFile(res, 'text/html; charset=utf-8', await page()) }), 'atlas: page')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/atlas/assets/atlas.js', handler: async (_req, res) => sendFile(res, 'text/javascript; charset=utf-8', await asset('assets/atlas.js')) }), 'atlas: app')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/atlas/assets/style.css', handler: async (_req, res) => sendFile(res, 'text/css; charset=utf-8', await asset('assets/style.css')) }), 'atlas: styles')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/atlas/assets/three.min.js', handler: async (_req, res) => sendFile(res, 'text/javascript; charset=utf-8', await asset('three.min.js')) }), 'atlas: legacy three renderer')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/atlas/api', handler: api }), 'atlas: api')
}

async function projectColdSessions(sessionQuery, store) {
  if (typeof sessionQuery?.listSessions !== 'function' || typeof sessionQuery?.readSession !== 'function') return
  const records = await sessionQuery.listSessions()
  let cursor = 0
  const workers = Array.from({ length: Math.min(4, records.length) }, async () => {
    while (cursor < records.length) {
      const record = records[cursor++]
      const snapshot = await sessionQuery.readSession(record.header.id)
      await store.replaceSessionProjection({ id: snapshot.session.id, header: snapshot.session }, snapshot.events)
    }
  })
  await Promise.all(workers)
}

async function asset(path) { return readFile(new URL(`./dist/${path}`, import.meta.url), 'utf8') }
async function page() { return (await asset('index.html')).replaceAll('"/assets/', '"/atlas/assets/') }
async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function sendJson(res, status, body) {
  if (status === 204) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end() }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
function sendFile(res, contentType, body) { res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }); res.end(body) }
function redirect(res, location) { res.writeHead(302, { location }); res.end() }
function hostnameOf(authority) {
  const value = String(authority ?? '').trim().toLowerCase()
  if (value.startsWith('[')) { const close = value.indexOf(']'); return close === -1 ? value.slice(1) : value.slice(1, close) }
  return (value.match(/:/g)?.length ?? 0) <= 1 ? value.replace(/:\d+$/, '') : value
}
function sessionIdForCard(id) {
  const match = /^(.*):(?:turn:\d+|session)$/.exec(id)
  return match?.[1] ?? id
}
