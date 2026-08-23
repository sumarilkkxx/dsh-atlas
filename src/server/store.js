import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const MAX_TEXT_LENGTH = 8_000
const MAX_TITLE_LENGTH = 160
const MAX_SUMMARY_LENGTH = 360
const MARKER_KINDS = new Set(['none', 'conclusion', 'verify', 'ruleout', 'decision', 'pivot', 'open'])

export class AtlasStore {
  constructor(dataFile) {
    if (typeof dataFile !== 'string' || dataFile.length === 0) throw new Error('atlas: config.dataFile must be a non-empty path')
    this.dataFile = dataFile
    this.db = undefined
    this.undoOperations = new Map()
    this.ready = this.open()
  }

  async open() {
    await mkdir(dirname(this.dataFile), { recursive: true })
    this.db = new DatabaseSync(this.dataFile, { timeout: 2_500, enableForeignKeyConstraints: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS atlas_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS atlas_node (
        session_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        parent_session_id TEXT,
        seed_length INTEGER,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS atlas_message (
        session_id TEXT NOT NULL REFERENCES atlas_node(session_id) ON DELETE CASCADE,
        source_seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        turn_number INTEGER,
        step_number INTEGER,
        process_json TEXT,
        at TEXT NOT NULL,
        PRIMARY KEY (session_id, source_seq)
      );
      CREATE TABLE IF NOT EXISTS atlas_task (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES atlas_node(session_id) ON DELETE CASCADE,
        source_seq INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS atlas_card_position (
        card_id TEXT PRIMARY KEY,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS atlas_card_size (
        card_id TEXT PRIMARY KEY,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS atlas_hidden_card (
        card_id TEXT PRIMARY KEY,
        hidden_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS atlas_card_parent_override (
        card_id TEXT PRIMARY KEY,
        parent_card_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS atlas_card_marker (
        card_id TEXT PRIMARY KEY,
        important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
        kind TEXT NOT NULL DEFAULT 'none' CHECK (kind IN ('none', 'conclusion', 'verify', 'ruleout', 'decision', 'pivot', 'open')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS atlas_pending_tool (
        session_id TEXT NOT NULL REFERENCES atlas_node(session_id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        turn_number INTEGER,
        step_number INTEGER,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, call_id)
      );
      CREATE TABLE IF NOT EXISTS atlas_conversation_summary (
        root_session_id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        text TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        generated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS atlas_node_cwd_idx ON atlas_node(cwd, updated_at DESC);
      CREATE INDEX IF NOT EXISTS atlas_message_session_idx ON atlas_message(session_id, source_seq);
      INSERT OR IGNORE INTO atlas_meta(key, value) VALUES ('schema_version', '1');
      UPDATE atlas_meta SET value = '6' WHERE key = 'schema_version';
    `)
  }

  async close() {
    await this.ready
    if (this.db?.isOpen) this.db.close()
  }

  async graph() {
    await this.ready
    const nodes = this.db.prepare(`
      SELECT n.session_id, n.cwd, n.title, n.parent_session_id, n.seed_length, n.x, n.y, n.hidden, n.updated_at,
             COUNT(m.source_seq) AS message_count,
             SUM(CASE WHEN m.kind = 'assistant' THEN 1 ELSE 0 END) AS reply_count
      FROM atlas_node n LEFT JOIN atlas_message m ON m.session_id = n.session_id
      WHERE n.hidden = 0 GROUP BY n.session_id ORDER BY n.created_at ASC, n.session_id ASC
    `).all().map(row => ({
      id: row.session_id,
      cwd: row.cwd,
      title: row.title,
      parentSessionId: row.parent_session_id,
      seedLength: row.seed_length,
      position: { x: row.x, y: row.y },
      updatedAt: row.updated_at,
      messageCount: Number(row.message_count),
      replyCount: Number(row.reply_count ?? 0),
    }))
    return { nodes, workspaces: this.workspaceSummaries(nodes) }
  }

  async conversationCards(cwd = undefined) {
    await this.ready
    const scoped = typeof cwd === 'string'
    const parameters = scoped ? [cwd] : []
    // The sidebar is a conversation timeline, not a "recently touched" list.  A
    // projection refresh updates `updated_at`, so ordering by it made a selected
    // conversation jump to a different position after every click.  Keep the
    // insertion order stable and only use updates to refresh the card contents.
    const nodes = this.db.prepare(`SELECT session_id, cwd, title, parent_session_id, seed_length, x, y, created_at, updated_at FROM atlas_node WHERE hidden = 0 ${scoped ? 'AND cwd = ?' : ''} ORDER BY created_at ASC, session_id ASC`).all(...parameters)
    const messageRows = this.db.prepare(`SELECT m.session_id, m.source_seq, m.kind, m.text, m.turn_number, m.step_number, m.process_json, m.at
      FROM atlas_message m JOIN atlas_node n ON n.session_id = m.session_id
      WHERE n.hidden = 0 ${scoped ? 'AND n.cwd = ?' : ''} ORDER BY m.session_id, m.source_seq`).all(...parameters)
    const messagesBySession = new Map()
    for (const row of messageRows) messagesBySession.set(row.session_id, [...(messagesBySession.get(row.session_id) ?? []), toMessage(row)])
    const taskRows = this.db.prepare(`SELECT t.id, t.session_id, t.source_seq, t.content, t.status, t.updated_at
      FROM atlas_task t JOIN atlas_node n ON n.session_id = t.session_id
      WHERE n.hidden = 0 ${scoped ? 'AND n.cwd = ?' : ''} ORDER BY t.session_id, t.source_seq, t.id`).all(...parameters)
    const tasksBySession = new Map()
    for (const row of taskRows) tasksBySession.set(row.session_id, [...(tasksBySession.get(row.session_id) ?? []), toTask(row)])
    const positions = new Map(this.db.prepare('SELECT card_id, x, y FROM atlas_card_position').all().map(row => [row.card_id, { x: row.x, y: row.y }]))
    const sizes = new Map(this.db.prepare('SELECT card_id, width, height FROM atlas_card_size').all().map(row => [row.card_id, { width: row.width, height: row.height }]))
    const cards = []
    const cardsBySession = new Map()
    const lastCardBySession = new Map()
    for (const node of nodes) {
      const messages = messagesBySession.get(node.session_id) ?? []
      const tasks = tasksBySession.get(node.session_id) ?? []
      const turns = messages.filter(message => message.kind === 'user')
      const sessionCards = []
      if (turns.length === 0) {
        sessionCards.push(this.sessionCard(node, messages, tasks, null, undefined, positions, sizes))
        cards.push(...sessionCards)
        cardsBySession.set(node.session_id, sessionCards)
        lastCardBySession.set(node.session_id, `${node.session_id}:session`)
        continue
      }
      for (const [index, turn] of turns.entries()) {
        const next = turns[index + 1]
        const range = messages.filter(message => message.sourceSeq >= turn.sourceSeq && (next === undefined || message.sourceSeq < next.sourceSeq))
        const taskRange = tasks.filter(task => task.sourceSeq >= turn.sourceSeq && (next === undefined || task.sourceSeq < next.sourceSeq))
        const previous = index === 0 ? undefined : sessionCards.at(-1)?.id
        sessionCards.push(this.sessionCard(node, range, taskRange, turn, previous, positions, sizes))
      }
      cards.push(...sessionCards)
      cardsBySession.set(node.session_id, sessionCards)
      lastCardBySession.set(node.session_id, `${node.session_id}:turn:${turns.at(-1).sourceSeq}`)
    }
    for (const card of cards) {
      if (card.parentSessionId === null || card.parentCardId !== undefined) continue
      const parentCards = cardsBySession.get(card.parentSessionId) ?? []
      const anchor = parentCards.filter(item => item.sourceSeq === null || card.seedLength === null || item.sourceSeq < card.seedLength).at(-1)
      card.parentCardId = anchor?.id ?? lastCardBySession.get(card.parentSessionId)
    }
    const hiddenCards = new Set(this.db.prepare('SELECT card_id FROM atlas_hidden_card').all().map(row => row.card_id))
    const parentOverrides = new Map(this.db.prepare('SELECT card_id, parent_card_id FROM atlas_card_parent_override').all().map(row => [row.card_id, row.parent_card_id]))
    for (const card of cards) if (parentOverrides.has(card.id)) card.parentCardId = parentOverrides.get(card.id) ?? undefined
    const markers = new Map(this.db.prepare('SELECT card_id, important, kind, updated_at FROM atlas_card_marker').all().map(row => [row.card_id, toMarker(row)]))
    for (const card of cards) card.marker = markers.get(card.id) ?? emptyMarker()
    return { cards: cards.filter(card => !hiddenCards.has(card.id)), workspaces: this.workspaceSummaries(nodes.map(toNode)) }
  }

  sessionCard(node, messages, tasks, turn, parentCardId, positions, sizes) {
    const sourceSeq = turn?.sourceSeq ?? null
    const id = sourceSeq === null ? `${node.session_id}:session` : `${node.session_id}:turn:${sourceSeq}`
    const answer = [...messages].reverse().find(message => message.kind === 'assistant')
    const process = messages.flatMap(message => message.process ?? [])
    const saved = positions.get(id)
    const savedSize = sizes.get(id)
    return {
      id, sessionId: node.session_id, cwd: node.cwd, title: displayMessageText(turn?.text ?? node.title),
      summary: displayMessageText(answer?.text ?? (turn === undefined ? '等待这条会话的第一条消息。' : '等待回复…')),
      sourceSeq, branchSeq: answer?.sourceSeq ?? sourceSeq, parentSessionId: node.parent_session_id, seedLength: node.seed_length,
      parentCardId, position: saved === undefined ? null : { x: saved.x, y: saved.y }, size: savedSize === undefined ? null : { width: savedSize.width, height: savedSize.height },
      tools: process.length, todos: tasks.length, updatedAt: node.updated_at,
      messages, process, tasks,
    }
  }

  async setCardMarker(cardId, marker) {
    await this.ready
    const normalized = normalizeMarker(marker)
    const { cards } = await this.conversationCards()
    if (!cards.some(card => card.id === cardId)) throw new AtlasNotFoundError('对话卡片不存在')
    if (!normalized.important && normalized.kind === 'none') {
      this.db.prepare('DELETE FROM atlas_card_marker WHERE card_id = ?').run(cardId)
      return emptyMarker()
    }
    const updatedAt = now()
    this.db.prepare(`INSERT INTO atlas_card_marker(card_id, important, kind, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(card_id) DO UPDATE SET important = excluded.important, kind = excluded.kind, updated_at = excluded.updated_at`)
      .run(cardId, normalized.important ? 1 : 0, normalized.kind, updatedAt)
    return { ...normalized, updatedAt }
  }

  async conversationSummary(rootSessionId) {
    await this.ready
    if (typeof rootSessionId !== 'string' || rootSessionId.trim() === '') throw new AtlasInputError('会话标识无效')
    const row = this.db.prepare('SELECT root_session_id, revision, text, provider, model, generated_at FROM atlas_conversation_summary WHERE root_session_id = ?').get(rootSessionId)
    return row === undefined ? null : toConversationSummary(row)
  }

  async saveConversationSummary(rootSessionId, summary) {
    await this.ready
    if (typeof rootSessionId !== 'string' || rootSessionId.trim() === '') throw new AtlasInputError('会话标识无效')
    const revision = typeof summary?.revision === 'string' ? summary.revision.trim() : ''
    const text = typeof summary?.text === 'string' ? summary.text.replace(/\s+/g, ' ').trim() : ''
    if (revision === '' || revision.length > 160) throw new AtlasInputError('摘要版本无效')
    if (text === '') throw new AtlasInputError('摘要不能为空')
    if (text.length > MAX_SUMMARY_LENGTH) throw new AtlasInputError(`摘要不能超过 ${MAX_SUMMARY_LENGTH} 个字符`)
    const provider = typeof summary?.provider === 'string' ? summary.provider.slice(0, 120) : null
    const model = typeof summary?.model === 'string' ? summary.model.slice(0, 160) : null
    const generatedAt = now()
    this.db.prepare(`INSERT INTO atlas_conversation_summary(root_session_id, revision, text, provider, model, generated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(root_session_id) DO UPDATE SET
      revision = excluded.revision, text = excluded.text, provider = excluded.provider, model = excluded.model, generated_at = excluded.generated_at`)
      .run(rootSessionId, revision, text, provider, model, generatedAt)
    return { rootSessionId, revision, text, provider, model, generatedAt }
  }

  workspaceSummaries(nodes) {
    const grouped = new Map()
    for (const node of nodes) {
      const current = grouped.get(node.cwd) ?? { id: node.cwd, cwd: node.cwd, title: workspaceTitle(node.cwd), sessionCount: 0, updatedAt: node.updatedAt ?? node.updated_at }
      current.sessionCount += 1
      if (String(node.updatedAt ?? node.updated_at) > current.updatedAt) current.updatedAt = node.updatedAt ?? node.updated_at
      grouped.set(node.cwd, current)
    }
    return [...grouped.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  async detail(sessionId) {
    await this.ready
    const node = this.node(sessionId)
    const messages = this.db.prepare('SELECT source_seq, kind, text, turn_number, step_number, process_json, at FROM atlas_message WHERE session_id = ? ORDER BY source_seq').all(sessionId).map(toMessage)
    return { node: toNode(node), messages }
  }

  async cardDetail(cardId) {
    await this.ready
    const parsed = parseCardId(cardId)
    const node = this.node(parsed.sessionId)
    if (parsed.sourceSeq === null) return this.detail(parsed.sessionId)
    const next = this.db.prepare('SELECT source_seq FROM atlas_message WHERE session_id = ? AND kind = ? AND source_seq > ? ORDER BY source_seq LIMIT 1').get(parsed.sessionId, 'user', parsed.sourceSeq)
    const rows = next === undefined
      ? this.db.prepare('SELECT source_seq, kind, text, turn_number, step_number, process_json, at FROM atlas_message WHERE session_id = ? AND source_seq >= ? ORDER BY source_seq').all(parsed.sessionId, parsed.sourceSeq)
      : this.db.prepare('SELECT source_seq, kind, text, turn_number, step_number, process_json, at FROM atlas_message WHERE session_id = ? AND source_seq >= ? AND source_seq < ? ORDER BY source_seq').all(parsed.sessionId, parsed.sourceSeq, next.source_seq)
    return { node: toNode(node), messages: rows.map(toMessage) }
  }

  async setPosition(sessionId, position) {
    await this.ready
    const x = boundedCoordinate(position?.x)
    const y = boundedCoordinate(position?.y)
    const changed = this.db.prepare('UPDATE atlas_node SET x = ?, y = ?, updated_at = ? WHERE session_id = ?').run(x, y, now(), sessionId).changes
    if (changed === 0) throw new AtlasNotFoundError('对话卡片不存在')
    return { x, y }
  }

  async setCardPosition(cardId, position) {
    await this.ready
    const x = boundedCoordinate(position?.x)
    const y = boundedCoordinate(position?.y)
    this.db.prepare('INSERT INTO atlas_card_position(card_id, x, y, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET x = excluded.x, y = excluded.y, updated_at = excluded.updated_at').run(cardId, x, y, now())
    return { x, y }
  }

  async setCardSize(cardId, size) {
    await this.ready
    const { cards } = await this.conversationCards()
    if (!cards.some(card => card.id === cardId)) throw new AtlasNotFoundError('对话卡片不存在')
    const width = boundedCardDimension(size?.width, 360, 820, 'width')
    const height = boundedCardDimension(size?.height, 250, 720, 'height')
    this.db.prepare('INSERT INTO atlas_card_size(card_id, width, height, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET width = excluded.width, height = excluded.height, updated_at = excluded.updated_at').run(cardId, width, height, now())
    return { width, height }
  }

  async rename(sessionId, title) {
    await this.ready
    const changed = this.db.prepare('UPDATE atlas_node SET title = ?, updated_at = ? WHERE session_id = ?').run(titleOf(title, 'DSH 对话'), now(), sessionId).changes
    if (changed === 0) throw new AtlasNotFoundError('对话卡片不存在')
  }

  async hide(sessionId) {
    await this.ready
    const descendants = this.db.prepare(`WITH RECURSIVE descendants(session_id) AS (SELECT session_id FROM atlas_node WHERE session_id = ? UNION ALL SELECT node.session_id FROM atlas_node node JOIN descendants parent ON node.parent_session_id = parent.session_id) SELECT session_id FROM descendants`).all(sessionId)
    const changed = this.db.prepare('UPDATE atlas_node SET hidden = 1, updated_at = ? WHERE session_id = ?').run(now(), sessionId).changes
    if (changed === 0) throw new AtlasNotFoundError('对话卡片不存在')
    const update = this.db.prepare('UPDATE atlas_node SET hidden = 1, updated_at = ? WHERE session_id = ?')
    for (const row of descendants.slice(1)) update.run(now(), row.session_id)
  }

  async deleteCard(cardId, mode = 'single', successorCardId = undefined) {
    await this.ready
    if (mode !== 'single' && mode !== 'subtree') throw new AtlasInputError('删除模式无效')
    const { cards } = await this.conversationCards()
    const target = cards.find(card => card.id === cardId)
    if (target === undefined) throw new AtlasNotFoundError('对话卡片不存在')
    const children = new Map()
    for (const card of cards) if (card.parentCardId) children.set(card.parentCardId, [...(children.get(card.parentCardId) ?? []), card])
    const descendants = []
    const queue = [target]
    const seen = new Set()
    while (queue.length > 0) {
      const card = queue.shift()
      if (seen.has(card.id)) continue
      seen.add(card.id); descendants.push(card)
      if (mode === 'subtree') queue.push(...(children.get(card.id) ?? []))
    }
    const directChildren = mode === 'single' ? children.get(target.id) ?? [] : []
    const promotedRoot = mode === 'single' && !target.parentCardId && directChildren.length > 0
      ? directChildren.find(card => card.sessionId === target.sessionId) ?? directChildren.find(card => card.id === successorCardId)
      : undefined
    if (mode === 'single' && !target.parentCardId && directChildren.length > 1 && promotedRoot === undefined) throw new AtlasInputError('请选择新的起始节点')
    const previousOverrides = directChildren.map(card => {
      const row = this.db.prepare('SELECT parent_card_id FROM atlas_card_parent_override WHERE card_id = ?').get(card.id)
      return { cardId: card.id, existed: row !== undefined, parentCardId: row?.parent_card_id ?? null }
    })
    const operationId = randomUUID()
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const hide = this.db.prepare('INSERT OR REPLACE INTO atlas_hidden_card(card_id, hidden_at) VALUES (?, ?)')
      for (const card of descendants) hide.run(card.id, timestamp)
      if (mode === 'single') {
        const reparent = this.db.prepare('INSERT INTO atlas_card_parent_override(card_id, parent_card_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET parent_card_id = excluded.parent_card_id, updated_at = excluded.updated_at')
        for (const child of directChildren) reparent.run(child.id, target.parentCardId ?? (child.id === promotedRoot?.id ? null : promotedRoot?.id ?? null), timestamp)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.undoOperations.set(operationId, { hiddenCardIds: descendants.map(card => card.id), previousOverrides, createdAt: Date.now() })
    for (const [id, operation] of this.undoOperations) if (Date.now() - operation.createdAt > 5 * 60_000) this.undoOperations.delete(id)
    return {
      operationId,
      mode,
      deletedCount: descendants.length,
      branchCount: new Set(descendants.filter(card => card.parentSessionId !== null).map(card => card.sessionId)).size,
      reconnectedCount: directChildren.length,
    }
  }

  async undoDelete(operationId) {
    await this.ready
    const operation = this.undoOperations.get(operationId)
    if (operation === undefined) throw new AtlasNotFoundError('撤销操作已过期')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const reveal = this.db.prepare('DELETE FROM atlas_hidden_card WHERE card_id = ?')
      for (const cardId of operation.hiddenCardIds) reveal.run(cardId)
      const removeOverride = this.db.prepare('DELETE FROM atlas_card_parent_override WHERE card_id = ?')
      const restoreOverride = this.db.prepare('INSERT INTO atlas_card_parent_override(card_id, parent_card_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET parent_card_id = excluded.parent_card_id, updated_at = excluded.updated_at')
      for (const item of operation.previousOverrides) {
        if (item.existed) restoreOverride.run(item.cardId, item.parentCardId, now())
        else removeOverride.run(item.cardId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.undoOperations.delete(operationId)
    return { restoredCount: operation.hiddenCardIds.length }
  }

  async syncSessions(sessions, removedSessionIds = []) {
    await this.ready
    if (!Array.isArray(sessions) || !Array.isArray(removedSessionIds)) throw new AtlasInputError('sessions 必须是数组')
    for (const id of removedSessionIds) if (typeof id === 'string') this.db.prepare('DELETE FROM atlas_node WHERE session_id = ?').run(id)
    for (const item of sessions) {
      if (typeof item?.id !== 'string' || item.id === '' || item.blank === true || typeof item.cwd !== 'string' || item.cwd === '') continue
      const existing = this.db.prepare('SELECT hidden FROM atlas_node WHERE session_id = ?').get(item.id)
      if (existing?.hidden === 1) continue
      // `sessions.list` does not consistently expose a parent for an existing
      // fork.  Treat an absent parent as unknown here; otherwise selecting a
      // branch rewrites its durable relationship to a root session.
      const header = { meta: { cwd: item.cwd } }
      if (typeof item.parentId === 'string' && item.parentId !== '') header.parentSession = item.parentId
      this.ensureNode({ id: item.id, title: item.title, header })
    }
    return this.graph()
  }

  async projectSession(session, replayFrom = 0) {
    await this.ready
    this.ensureNode(session)
    for (const event of session.events ?? []) if (event.seq >= replayFrom) this.projectEventInternal(session, event)
  }

  async projectEvent(session, event) {
    await this.ready
    this.ensureNode(session)
    this.projectEventInternal(session, event)
  }

  async projectEvents(session, events) {
    await this.ready
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ensureNode(session)
      for (const event of events) this.projectEventInternal(session, event)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async replaceSessionProjection(session, events, replayFrom = 0) {
    await this.ready
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ensureNode(session)
      this.db.prepare('DELETE FROM atlas_message WHERE session_id = ?').run(session.id)
      this.db.prepare('DELETE FROM atlas_task WHERE session_id = ?').run(session.id)
      this.db.prepare('DELETE FROM atlas_pending_tool WHERE session_id = ?').run(session.id)
      for (const event of events ?? []) if (event.seq >= replayFrom) this.projectEventInternal(session, event)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  ensureNode(session) {
    const id = session?.id
    if (typeof id !== 'string' || id === '') return
    const existing = this.db.prepare('SELECT session_id, parent_session_id FROM atlas_node WHERE session_id = ?').get(id)
    const header = session.header ?? {}
    const cwd = sessionCwd(session)
    const hasParentSession = Object.prototype.hasOwnProperty.call(header, 'parentSession')
    const requestedParentSessionId = typeof header.parentSession === 'string' ? header.parentSession : hasParentSession ? null : undefined
    const parentSessionId = requestedParentSessionId === undefined ? existing?.parent_session_id ?? null : requestedParentSessionId
    const seedLength = Number.isSafeInteger(header.seedLength) ? header.seedLength : null
    const title = titleOf(session.title, parentSessionId === null ? 'DSH 对话' : '另一种思路')
    if (existing !== undefined) {
      this.db.prepare('UPDATE atlas_node SET cwd = ?, title = ?, parent_session_id = ?, seed_length = COALESCE(?, seed_length), updated_at = ? WHERE session_id = ?').run(cwd, title, parentSessionId, seedLength, now(), id)
      return
    }
    const parent = parentSessionId === null ? undefined : this.db.prepare('SELECT x, y FROM atlas_node WHERE session_id = ?').get(parentSessionId)
    const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM atlas_node').get().count)
    const x = parent === undefined ? 70 + (count % 3) * 42 : Number(parent.x) + 390
    const y = parent === undefined ? 120 + Math.floor(count / 3) * 250 : Number(parent.y)
    this.db.prepare('INSERT INTO atlas_node(session_id, cwd, title, parent_session_id, seed_length, x, y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, cwd, title, parentSessionId, seedLength, x, y, now(), now())
  }

  projectEventInternal(session, event) {
    if (!Number.isSafeInteger(event?.seq)) return
    const sessionId = session.id
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      this.db.prepare('UPDATE atlas_node SET title = ?, updated_at = ? WHERE session_id = ?').run(titleOf(event.data.title, 'DSH 对话'), eventTime(event), sessionId)
      return
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') return this.foldToolEvent(sessionId, event)
    const projection = projectable(event)
    if (projection === null) return
    const insert = this.db.prepare('INSERT OR IGNORE INTO atlas_message(session_id, source_seq, kind, text, turn_number, step_number, process_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sessionId, event.seq, projection.kind, projection.text, projection.turn, projection.step, projection.kind === 'assistant' ? '[]' : null, eventTime(event))
    if (projection.kind === 'assistant') this.attachPendingTools(sessionId, projection.turn, projection.step, event.seq)
    if (insert.changes > 0) this.db.prepare('UPDATE atlas_node SET updated_at = ?, title = CASE WHEN title = ? AND ? = ? THEN ? ELSE title END WHERE session_id = ?').run(eventTime(event), 'DSH 对话', projection.kind, 'user', titleFromText(displayMessageText(projection.text)), sessionId)
    if (event.type === 'todo/write') this.replaceTasks(sessionId, event)
  }

  foldToolEvent(sessionId, event) {
    const callId = String(event.type === 'tool/call' ? event.data?.callId ?? '' : event.data?.message?.source?.callId ?? '')
    if (callId === '') return
    const exact = this.db.prepare('SELECT source_seq, process_json FROM atlas_message WHERE session_id = ? AND kind = ? AND turn_number IS ? AND step_number IS ? ORDER BY source_seq DESC LIMIT 1').get(sessionId, 'assistant', event.data?.turn ?? null, event.data?.step ?? null)
    const target = exact ?? this.db.prepare('SELECT source_seq, process_json FROM atlas_message WHERE session_id = ? AND kind = ? AND turn_number IS ? ORDER BY source_seq DESC LIMIT 1').get(sessionId, 'assistant', event.data?.turn ?? null)
    if (target === undefined) return this.rememberPendingTool(sessionId, event, callId)
    const process = JSON.parse(target.process_json ?? '[]')
    const entry = process.find(item => item.callId === callId)
    if (event.type === 'tool/call') {
      if (entry === undefined) process.push({ callId, name: String(event.data?.name ?? '工具调用'), arguments: String(event.data?.arguments ?? ''), result: null, error: null })
      else {
        entry.name = String(event.data?.name ?? entry.name ?? '工具调用')
        entry.arguments = String(event.data?.arguments ?? entry.arguments ?? '')
      }
    } else if (entry === undefined) {
      process.push({ callId, name: '工具调用', arguments: null, result: contentText(event.data?.message?.content), meta: toolPresentationMeta(event.data?.message), error: event.data?.error ? `${event.data.error.name}: ${event.data.error.code}` : null })
    } else {
      entry.result = contentText(event.data?.message?.content)
      entry.meta = toolPresentationMeta(event.data?.message) ?? entry.meta
      entry.error = event.data?.error ? `${event.data.error.name}: ${event.data.error.code}` : null
    }
    this.db.prepare('UPDATE atlas_message SET process_json = ? WHERE session_id = ? AND source_seq = ?').run(JSON.stringify(process), sessionId, target.source_seq)
    this.dedupeToolCall(sessionId, callId, target.source_seq)
  }

  rememberPendingTool(sessionId, event, callId) {
    const row = this.db.prepare('SELECT payload_json FROM atlas_pending_tool WHERE session_id = ? AND call_id = ?').get(sessionId, callId)
    const entry = row === undefined ? { callId, name: '工具调用', arguments: null, result: null, error: null } : JSON.parse(row.payload_json)
    if (event.type === 'tool/call') {
      entry.name = String(event.data?.name ?? entry.name)
      entry.arguments = String(event.data?.arguments ?? '')
    } else {
      entry.result = contentText(event.data?.message?.content)
      entry.meta = toolPresentationMeta(event.data?.message) ?? entry.meta
      entry.error = event.data?.error ? `${event.data.error.name}: ${event.data.error.code}` : null
    }
    this.db.prepare(`INSERT INTO atlas_pending_tool(session_id, call_id, turn_number, step_number, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, call_id) DO UPDATE SET
      turn_number = excluded.turn_number, step_number = excluded.step_number,
      payload_json = excluded.payload_json, updated_at = excluded.updated_at`).run(sessionId, callId, event.data?.turn ?? null, event.data?.step ?? null, JSON.stringify(entry), eventTime(event))
  }

  attachPendingTools(sessionId, turn, step, sourceSeq) {
    const rows = this.db.prepare('SELECT call_id, payload_json FROM atlas_pending_tool WHERE session_id = ? AND turn_number IS ? ORDER BY updated_at').all(sessionId, turn)
    if (rows.length === 0) return
    const target = this.db.prepare('SELECT process_json FROM atlas_message WHERE session_id = ? AND source_seq = ?').get(sessionId, sourceSeq)
    if (target === undefined) return
    const process = JSON.parse(target.process_json ?? '[]')
    for (const row of rows) {
      const pending = JSON.parse(row.payload_json)
      const existing = process.find(item => item.callId === row.call_id)
      if (existing === undefined) process.push(pending)
      else Object.assign(existing, pending)
      this.db.prepare('DELETE FROM atlas_pending_tool WHERE session_id = ? AND call_id = ?').run(sessionId, row.call_id)
    }
    this.db.prepare('UPDATE atlas_message SET process_json = ? WHERE session_id = ? AND source_seq = ?').run(JSON.stringify(process), sessionId, sourceSeq)
    for (const row of rows) this.dedupeToolCall(sessionId, row.call_id, sourceSeq)
  }

  dedupeToolCall(sessionId, callId, keepSourceSeq) {
    const rows = this.db.prepare('SELECT source_seq, process_json FROM atlas_message WHERE session_id = ? AND kind = ? AND source_seq <> ? AND process_json IS NOT NULL').all(sessionId, 'assistant', keepSourceSeq)
    const update = this.db.prepare('UPDATE atlas_message SET process_json = ? WHERE session_id = ? AND source_seq = ?')
    for (const row of rows) {
      const process = JSON.parse(row.process_json ?? '[]')
      const filtered = process.filter(item => item.callId !== callId)
      if (filtered.length !== process.length) update.run(JSON.stringify(filtered), sessionId, row.source_seq)
    }
  }

  replaceTasks(sessionId, event) {
    const tasks = Array.isArray(event.data?.todos) ? event.data.todos : []
    this.db.prepare('DELETE FROM atlas_task WHERE session_id = ?').run(sessionId)
    const insert = this.db.prepare('INSERT INTO atlas_task(id, session_id, source_seq, content, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const [index, task] of tasks.entries()) {
      if (typeof task?.content !== 'string' || task.content.trim() === '') continue
      insert.run(`${sessionId}:${event.seq}:${index}`, sessionId, event.seq, task.content.slice(0, MAX_TEXT_LENGTH), String(task.status ?? 'todo'), eventTime(event))
    }
  }

  node(sessionId) {
    const node = this.db.prepare('SELECT session_id, cwd, title, parent_session_id, seed_length, x, y, hidden, updated_at FROM atlas_node WHERE session_id = ?').get(sessionId)
    if (node === undefined) throw new AtlasNotFoundError('对话卡片不存在')
    return node
  }
}

export class AtlasNotFoundError extends Error {}
export class AtlasInputError extends Error {}

function projectable(event) {
  switch (event.type) {
    case 'user/message': {
      const sourceKind = event.data?.source?.kind
      if (typeof sourceKind === 'string' && sourceKind !== 'user') return null
      const text = contentText(event.data?.content)
      return text === '' || runtimeContext(text) ? null : { kind: 'user', text, turn: null, step: null }
    }
    case 'assistant/message': return note('assistant', contentText(event.data?.message?.content), event.data?.turn, event.data?.step)
    case 'todo/write': return note('todo', (event.data?.todos ?? []).map(item => `[${item.status}] ${item.content}`).join('\n'), null, null)
    case 'turn/end': return event.data?.reason?.kind === 'error' ? note('error', String(event.data.reason.error?.message ?? '对话执行失败'), null, null) : null
    default: return null
  }
}

function note(kind, text, turn, step) { const normalized = String(text ?? '').trim(); return normalized === '' ? null : { kind, text: normalized.slice(0, MAX_TEXT_LENGTH), turn: Number.isSafeInteger(turn) ? turn : null, step: Number.isSafeInteger(step) ? step : null } }
function contentText(content) { return Array.isArray(content) ? content.flatMap(block => block?.type === 'text' ? [block.text] : block?.type === 'tool-result' ? [contentText(block.content)] : []).filter(value => typeof value === 'string' && value.trim() !== '').join('\n') : '' }
function toolPresentationMeta(message) {
  const direct = message?.meta ?? message?.presentationMeta
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct
  const visit = content => {
    if (!Array.isArray(content)) return null
    for (const block of content) {
      const meta = block?.meta ?? block?.presentationMeta
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) return meta
      const nested = visit(block?.content)
      if (nested !== null) return nested
    }
    return null
  }
  return visit(message?.content)
}
function parseCardId(cardId) {
  const turn = /^(.*):turn:(\d+)$/.exec(cardId)
  if (turn !== null) return { sessionId: turn[1], sourceSeq: Number(turn[2]) }
  const session = /^(.*):session$/.exec(cardId)
  return { sessionId: session?.[1] ?? cardId, sourceSeq: null }
}
function runtimeContext(text) { return text.trimStart().startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.') }
function sessionCwd(session) { const cwd = session?.header?.meta?.cwd ?? session?.header?.cwd; return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '未指定工作目录' }
function titleOf(value, fallback) { return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_TITLE_LENGTH) : fallback }
function titleFromText(text) { const compact = text.replaceAll(/\s+/g, ' ').trim(); return (compact.length > 54 ? `${compact.slice(0, 54)}…` : compact) || 'DSH 对话' }
function displayMessageText(text) {
  return String(text ?? '').replace(/<atlas_attachment\s+([^>]*)>[\s\S]*?<\/atlas_attachment>/gi, (_all, attributes) => {
    const name = /name="([^"]*)"/i.exec(String(attributes))?.[1]?.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') ?? '文件'
    return `\n[附件：${name}]\n`
  }).trim()
}
function boundedCoordinate(value) { const number = Number(value); if (!Number.isFinite(number)) throw new AtlasInputError('position must be finite'); return Math.round(Math.max(-4000, Math.min(8000, number))) }
function boundedCardDimension(value, minimum, maximum, name) { const number = Number(value); if (!Number.isFinite(number)) throw new AtlasInputError(`${name} must be finite`); return Math.round(Math.max(minimum, Math.min(maximum, number))) }
function eventTime(event) { return typeof event?.time === 'string' ? event.time : Number.isFinite(event?.time) ? new Date(event.time).toISOString() : now() }
function now() { return new Date().toISOString() }
function toNode(row) { return { id: row.session_id, cwd: row.cwd, title: row.title, parentSessionId: row.parent_session_id, seedLength: row.seed_length, position: { x: row.x, y: row.y }, hidden: row.hidden === 1, updatedAt: row.updated_at } }
function toMessage(row) { return { sourceSeq: row.source_seq, kind: row.kind, text: row.text, turn: row.turn_number, step: row.step_number, process: row.process_json === null ? [] : JSON.parse(row.process_json), at: row.at } }
function toTask(row) { return { id: row.id, sessionId: row.session_id, sourceSeq: row.source_seq, content: row.content, status: row.status, updatedAt: row.updated_at } }
function toConversationSummary(row) { return { rootSessionId: row.root_session_id, revision: row.revision, text: row.text, provider: row.provider, model: row.model, generatedAt: row.generated_at } }
function emptyMarker() { return { important: false, kind: 'none', updatedAt: null } }
function toMarker(row) { return { important: row.important === 1, kind: MARKER_KINDS.has(row.kind) ? row.kind : 'none', updatedAt: row.updated_at } }
function normalizeMarker(marker) {
  const important = marker?.important === true
  const kind = typeof marker?.kind === 'string' && MARKER_KINDS.has(marker.kind) ? marker.kind : undefined
  if (kind === undefined) throw new AtlasInputError('标记类型无效')
  return { important, kind }
}
function workspaceTitle(cwd) { const segment = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).at(-1); return segment?.trim() || '未指定工作目录' }
