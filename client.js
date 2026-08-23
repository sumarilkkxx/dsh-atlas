window.__ModuleLoader__.load({
  id: 'dsh-atlas',
  factory: () => {
    const module = { exports: {} }
    const currentSession = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const id = snapshot.current
      if (id === undefined) return null
      const session = snapshot.byId[id]
      return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null }
    }
    const sessionSnapshot = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.ids.map(id => {
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null, parentId: session.parentId ?? null, blank: session.blank }
      }).filter(Boolean)
    }
    const workspaceSnapshot = ctx => {
      const sessions = ctx.sessions.list.getSnapshot()
      const snapshot = ctx.workspaces.list.getSnapshot()
      const accounted = new Set(snapshot.items.flatMap(workspace => workspace.sessionIds))
      return [...snapshot.items.map(workspace => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })), { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: sessions.ids.filter(id => !accounted.has(id)) }]
    }
    module.exports.inject = ['sessions', 'workspaces', 'modelDirectories', 'remote', 'remote.commands', 'connection']
    module.exports.apply = ctx => {
      const prompt = async (sessionId, text) => {
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined) throw new Error('关联的 DSH 对话已不可用')
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受这条消息')
      }
      const sessionFace = sessionId => {
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined) throw new Error('关联的 DSH 对话已不可用')
        return session
      }
      const modelDirectory = async sessionId => {
        const directory = ctx.modelDirectories.directoryFor(sessionId)
        await directory.load()
        return { directory, snapshot: directory.store.getSnapshot() }
      }
      const permissionDirectory = sessionId => {
        const session = sessionFace(sessionId)
        const face = session.projections.faceOf('permissions')
        const value = face.getSnapshot()
        if (value === undefined || value === null || !Array.isArray(value.options)) throw new Error('当前 DSH Profile 未提供权限范围投影')
        return { face, session, snapshot: { currentValue: value.currentValue, options: value.options.filter(option => option?.value !== 'custom') } }
      }
      const style = document.createElement('style')
      style.textContent = '.dsh-atlas-switch{position:fixed;z-index:120;top:12px;left:50%;display:flex;gap:2px;transform:translateX(-50%);border:1px solid #d9e0e4;border-radius:999px;background:rgba(255,255,255,.96);padding:3px;backdrop-filter:blur(10px);-webkit-app-region:no-drag}.dsh-atlas-switch button{height:28px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:#5b6876;font:600 12px "Microsoft YaHei UI","PingFang SC","Segoe UI",sans-serif;cursor:pointer;-webkit-app-region:no-drag}.dsh-atlas-switch button.active{background:#172033;color:#fff}.dsh-atlas-switch button:focus-visible{outline:2px solid #0b9b83;outline-offset:2px}.dsh-atlas-overlay{position:fixed;z-index:100;inset:0;background:#f7f8fa}.dsh-atlas-overlay[hidden]{display:none}.dsh-atlas-overlay iframe{display:block;width:100%;height:100%;border:0}'
      document.head.append(style)
      const host = document.createElement('div')
      host.className = 'dsh-atlas-host'
      host.innerHTML = '<div class="dsh-atlas-switch" role="group" aria-label="视图切换"><button type="button" data-view="dialog" class="active" aria-pressed="true">对话</button><button type="button" data-view="atlas" aria-pressed="false">卡片视图</button></div><section class="dsh-atlas-overlay" hidden><iframe title="DSH Atlas 卡片视图" src="/atlas/"></iframe></section>'
      document.body.append(host)
      const dialogButton = host.querySelector('[data-view="dialog"]')
      const atlasButton = host.querySelector('[data-view="atlas"]')
      const overlay = host.querySelector('.dsh-atlas-overlay')
      const frame = host.querySelector('iframe')
      const send = (type, payload = {}) => frame.contentWindow?.postMessage({ source: 'dsh-atlas', type, ...payload }, location.origin)
      let syncQueued = false
      let knownSessionIds = new Set()
      const syncSessions = () => {
        if (syncQueued) return
        syncQueued = true
        queueMicrotask(() => {
          syncQueued = false
          const sessions = sessionSnapshot(ctx)
          const sessionIds = new Set(sessions.map(session => session.id))
          const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
          knownSessionIds = sessionIds
          void fetch('/atlas/api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, removedSessionIds }) }).catch(() => {})
        })
      }
      const syncTheme = () => send('atlas:theme', { dark: document.body?.hasAttribute?.('data-ds-dark-theme') === true })
      const nativeState = () => {
        const buttons = typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll('button')] : []
        const model = buttons.find(button => button.getAttribute('aria-label')?.startsWith('选择模型'))?.getAttribute('aria-label') ?? '使用当前 DSH 模型'
        send('atlas:native-state', { model })
      }
      const nativeComposer = async (sessionId, draft = '', action = 'focus') => {
        try { const opened = ctx.sessions.open(sessionId); if (opened && typeof opened.then === 'function') await opened } catch { send('atlas:error', { message: '关联的 DSH 对话已不可用' }); return }
        close()
        const activate = attempt => window.setTimeout(() => {
          const buttons = typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll('button')] : []
          if (action === 'model') {
            const button = buttons.find(item => item.getAttribute('aria-label')?.startsWith('选择模型'))
            if (button) return button.click()
            if (attempt < 8) activate(attempt + 1)
            return
          }
          if (action === 'command') {
            const button = buttons.find(item => item.getAttribute('aria-label') === '命令' && !item.hasAttribute('disabled'))
            if (button) return button.click()
            if (attempt < 8) activate(attempt + 1)
            return
          }
          const inputs = typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll('textarea,input')] : []
          const input = inputs.find(element => /描述你想要构建|给智能体发消息/.test(element.getAttribute('placeholder') ?? ''))
          if (input === undefined || !('value' in input)) { if (attempt < 8) activate(attempt + 1); return }
          input.focus()
          if (draft !== '') {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
            setter?.call(input, draft)
            const EventCtor = window.InputEvent ?? window.Event
            if (EventCtor) input.dispatchEvent(new EventCtor('input', { bubbles: true, inputType: 'insertText', data: draft }))
          }
        }, attempt === 0 ? 120 : 100)
        activate(0)
      }
      const liveUnsubscribers = new Map()
      const liveRunning = new Map()
      let refreshTimer = null
      const refreshAfterProjection = (delay = 180) => {
        if (refreshTimer !== null) window.clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(() => {
          refreshTimer = null
          if (!overlay.hidden) send('atlas:refresh')
        }, delay)
      }
      const syncLiveSessions = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        for (const id of snapshot.ids) {
          if (liveUnsubscribers.has(id)) continue
          const scope = ctx.sessions.scope(id)
          const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
          if (session === undefined) continue
          const publish = () => {
            if (overlay.hidden) return
            const state = session.getSnapshot()
            const wasRunning = liveRunning.get(id) === true
            liveRunning.set(id, state.running === true)
            const text = state.partial?.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n') ?? ''
            send('atlas:live-reply', { sessionId: id, running: state.running, text })
            if (wasRunning && state.running !== true) refreshAfterProjection()
          }
          liveUnsubscribers.set(id, session.subscribe(publish))
          publish()
        }
        for (const [id, unsubscribe] of liveUnsubscribers) if (!snapshot.ids.includes(id)) { unsubscribe(); liveUnsubscribers.delete(id); liveRunning.delete(id) }
      }
      const setView = atlas => {
        dialogButton.classList.toggle('active', !atlas)
        dialogButton.setAttribute('aria-pressed', String(!atlas))
        atlasButton.classList.toggle('active', atlas)
        atlasButton.setAttribute('aria-pressed', String(atlas))
      }
      const close = () => { overlay.hidden = true; setView(false) }
      const open = () => { overlay.hidden = false; setView(true); syncSessions(); syncLiveSessions(); syncTheme(); nativeState(); send('atlas:workspaces', { workspaces: workspaceSnapshot(ctx) }); send('atlas:current-session', { session: currentSession(ctx) }); send('atlas:map-opened') }
      const onMessage = event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-atlas') return
        if (event.data.type === 'atlas:ready' || event.data.type === 'atlas:request-current') { syncSessions(); syncLiveSessions(); syncTheme(); nativeState(); send('atlas:workspaces', { workspaces: workspaceSnapshot(ctx) }); return send('atlas:current-session', { session: currentSession(ctx) }) }
        if (event.data.type === 'atlas:close') return close()
        if (event.data.type === 'atlas:open-session') {
          try { const opened = ctx.sessions.open(event.data.sessionId); if (opened && typeof opened.then === 'function') opened.then(close).catch(() => send('atlas:error', { message: '关联的 DSH 对话已不可用' })); else close() } catch { send('atlas:error', { message: '关联的 DSH 对话已不可用' }) }
          return
        }
        if (event.data.type === 'atlas:fork-session') {
          const atSeq = Number.isInteger(event.data.atSeq) ? event.data.atSeq : undefined
          ctx.sessions.fork({ sessionId: event.data.sessionId, atSeq, increaseTitle: true }).then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            send('atlas:forked-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? 'DSH 分支' } })
          }).catch(() => send('atlas:error', { requestId: event.data.requestId, message: '无法创建分支，请确认源对话已结束当前轮次' }))
        }
        if (event.data.type === 'atlas:activate-session') { try { ctx.sessions.open(event.data.sessionId) } catch { send('atlas:error', { message: '关联的 DSH 对话已不可用' }) }; return }
        if (event.data.type === 'atlas:open-native-composer') { nativeComposer(event.data.sessionId, typeof event.data.draft === 'string' ? event.data.draft : ''); return }
        if (event.data.type === 'atlas:open-native-models') { nativeComposer(event.data.sessionId, '', 'model'); return }
        if (event.data.type === 'atlas:open-native-command') { nativeComposer(event.data.sessionId, '', 'command'); return }
        if (event.data.type === 'atlas:open-native-files') { nativeComposer(event.data.sessionId, '@'); return }
        if (event.data.type === 'atlas:get-models') {
          modelDirectory(event.data.sessionId).then(({ snapshot }) => send('atlas:model-directory', { requestId: event.data.requestId, directory: snapshot })).catch(error => send('atlas:error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : '模型目录加载失败' }))
          return
        }
        if (event.data.type === 'atlas:get-commands') {
          Promise.resolve().then(async () => {
            const result = await ctx.remote.commands.list(event.data.sessionId)
            if (!result.ok) throw new Error(result.error?.message ?? '无法读取 DSH 命令目录')
            send('atlas:command-directory', { requestId: event.data.requestId, commands: result.value ?? [] })
          }).catch(error => send('atlas:error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : '无法读取 DSH 命令目录' }))
          return
        }
        if (event.data.type === 'atlas:get-skills') {
          Promise.resolve().then(async () => {
            const { result } = await ctx.connection.api.skills.list({ sessionId: event.data.sessionId }, new AbortController().signal)
            if (!result.ok) throw new Error(result.error?.message ?? '无法读取 DSH 技能目录')
            send('atlas:skill-directory', { requestId: event.data.requestId, skills: result.value?.skills ?? [] })
          }).catch(error => send('atlas:error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : '无法读取 DSH 技能目录' }))
          return
        }
        if (event.data.type === 'atlas:get-permissions') {
          Promise.resolve().then(() => {
            const { snapshot } = permissionDirectory(event.data.sessionId)
            send('atlas:permission-directory', { requestId: event.data.requestId, permissions: snapshot })
          }).catch(error => send('atlas:error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : '权限范围加载失败' }))
          return
        }
        if (event.data.type === 'atlas:select-permission') {
          const preset = typeof event.data.preset === 'string' ? event.data.preset.trim() : ''
          Promise.resolve().then(async () => {
            const initial = permissionDirectory(event.data.sessionId)
            if (!initial.snapshot.options.some(option => option.value === preset)) throw new Error('该权限范围不在当前 DSH 会话的可用预设中')
            const result = await initial.session.command(`/permission ${preset}`)
            if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受权限切换')
            if (result.value?.matched !== true) throw new Error('当前 DSH Profile 未启用 /permission 命令')
            let snapshot = permissionDirectory(event.data.sessionId).snapshot
            for (let attempt = 0; attempt < 8 && snapshot.currentValue !== preset; attempt += 1) {
              await new Promise(resolve => window.setTimeout(resolve, 120 * (attempt + 1)))
              snapshot = permissionDirectory(event.data.sessionId).snapshot
            }
            if (snapshot.currentValue !== preset) throw new Error('DSH 未确认权限切换，Atlas 不会仅更新页面显示')
            send('atlas:permission-selected', { requestId: event.data.requestId, permissions: snapshot })
          }).catch(error => send('atlas:error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : '权限范围切换失败' }))
          return
        }
        if (event.data.type === 'atlas:select-model') {
          const selection = event.data.selection
          if (selection === null || typeof selection !== 'object' || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return send('atlas:error', { requestId: event.data.requestId, message: '模型选择参数无效' })
          Promise.resolve().then(async () => {
            const directory = ctx.modelDirectories.directoryFor(event.data.sessionId)
            const catalog = await directory.load()
            const provider = selection.provider.trim()
            const model = selection.model.trim()
            const available = catalog.groups?.some(group => group.id === provider && group.models?.some(item => item.id === model))
            if (!available) throw new Error('该模型不在当前 DSH 会话的可用模型目录中，请刷新后重试')
            const requested = { provider, model, ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.trim() !== '' ? { reasoningEffort: selection.reasoningEffort } : {}) }
            await directory.select(requested)
            let snapshot = directory.store.getSnapshot()
            for (let attempt = 0; attempt < 3 && (snapshot.current?.provider !== requested.provider || snapshot.current.model !== requested.model); attempt += 1) {
              await new Promise(resolve => window.setTimeout(resolve, 120 * (attempt + 1)))
              await directory.load()
              snapshot = directory.store.getSnapshot()
            }
            const current = snapshot.current
            if (current?.provider !== requested.provider || current.model !== requested.model) throw new Error('DSH 未确认模型切换，Atlas 不会仅更新页面显示')
            send('atlas:model-selected', { requestId: event.data.requestId, directory: snapshot })
          }).catch(error => send('atlas:error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : '模型切换失败' }))
          return
        }
        if (event.data.type === 'atlas:run-command') {
          const line = typeof event.data.line === 'string' ? event.data.line.trim() : ''
          if (!line.startsWith('/')) return send('atlas:error', { requestId: event.data.requestId, message: '命令必须以 / 开头' })
          const face = sessionFace(event.data.sessionId)
          Promise.resolve(face.command(line)).then(async result => {
            if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受该命令')
            if (result.value?.matched !== true && line === '/status') {
              const state = typeof face.getSnapshot === 'function' ? face.getSnapshot() : {}
              const directory = ctx.modelDirectories.directoryFor(event.data.sessionId)
              await directory.load().catch(() => undefined)
              const current = directory.store.getSnapshot().current
              send('atlas:command-ran', { requestId: event.data.requestId, result: { matched: true, status: { running: state.running === true, model: current?.model, effort: current?.reasoningEffort } } })
              return
            }
            if (result.value?.matched !== true) throw new Error(`未知命令：${line}`)
            send('atlas:command-ran', { requestId: event.data.requestId, result: result.value })
          }).catch(error => send('atlas:error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : '命令执行失败' }))
          return
        }
        if (event.data.type === 'atlas:send-message') {
          const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
          if (text === '') return send('atlas:error', { requestId: event.data.requestId, message: '消息不能为空' })
          prompt(event.data.sessionId, text).then(() => send('atlas:message-sent', { requestId: event.data.requestId, sessionId: event.data.sessionId })).catch(error => send('atlas:error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' }))
          return
        }
        if (event.data.type === 'atlas:create-session') {
          const workspaceId = typeof event.data.workspaceId === 'string' && event.data.workspaceId !== '' && event.data.workspaceId !== 'dsh-ungrouped' ? event.data.workspaceId : undefined
          const cwd = typeof event.data.cwd === 'string' && event.data.cwd !== '' ? event.data.cwd : undefined
          const create = workspaceId === undefined ? ctx.sessions.create(cwd === undefined ? {} : { cwd }) : ctx.sessions.create({ workspaceId })
          create.then(id => { const snapshot = ctx.sessions.list.getSnapshot(); send('atlas:created-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? '新会话', cwd: snapshot.byId[id]?.cwd ?? cwd ?? null } }) }).catch(() => send('atlas:error', { requestId: event.data.requestId, message: '无法创建对话，请先在 DSH 选择工作目录' }))
        }
      }
      const syncCurrent = () => { syncSessions(); syncLiveSessions(); syncTheme(); if (!overlay.hidden) { send('atlas:workspaces', { workspaces: workspaceSnapshot(ctx) }); send('atlas:current-session', { session: currentSession(ctx) }); refreshAfterProjection() } }
      const themeObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(syncTheme)
      themeObserver?.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      const unsubscribe = ctx.sessions.list.subscribe(syncCurrent)
      const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(syncCurrent)
      dialogButton.addEventListener('click', close)
      atlasButton.addEventListener('click', open)
      window.addEventListener('message', onMessage)
      ctx.effect(() => () => {
        unsubscribe()
        unsubscribeWorkspaces()
        themeObserver?.disconnect()
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe()
        if (refreshTimer !== null) window.clearTimeout(refreshTimer)
        dialogButton.removeEventListener('click', close)
        atlasButton.removeEventListener('click', open)
        window.removeEventListener('message', onMessage)
        host.remove()
        style.remove()
      }, 'atlas: view switch')
    }
    return module.exports
  },
})
