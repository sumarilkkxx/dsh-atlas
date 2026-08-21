import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AtSign, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleMinus, CirclePlus, Command, FileText, Focus, GitBranch, LoaderCircle, MessageSquareText, Minus, Moon, MoreHorizontal, Paperclip, Plus, Search, Send, Sun, Trash2, Wrench, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogTitle } from './components/ui/dialog'

type Point = { x: number; y: number }
type Process = { callId: string; name: string; arguments?: string | null; result: string | null; meta?: Record<string, unknown> | null; error?: string | null }
type Message = { sourceSeq: number; kind: string; text: string; process: Process[]; at?: string }
type Card = { id: string; sessionId: string; cwd: string; title: string; summary: string; sourceSeq: number | null; branchSeq?: number | null; parentCardId?: string; parentSessionId: string | null; position: Point | null; tools: number; todos: number; messages: Message[] }
type Workspace = { id?: string; cwd: string; title: string; sessionCount: number }
type DshWorkspace = { id: string; title: string; path: string | null; sessionIds: string[] }
type Compose = { kind: 'new' } | { kind: 'branch'; card: Card }
type RpcPending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }
type ThemeOverride = 'light' | 'dark' | null
type SessionNode = { id: string; card: Card; parentId: string | null; children: SessionNode[] }
type ModelEffort = { id: string; name: string; description?: string }
type ModelChoice = { id: string; name: string; description?: string; reasoning?: { defaultEffort?: string; efforts: ModelEffort[] } }
type ModelGroup = { id: string; name: string; models: ModelChoice[] }
type ModelSelection = { provider: string; model: string; reasoningEffort?: string }
type ModelDirectory = { current: ModelSelection | null; routable: boolean | null; groups: ModelGroup[]; failures: { id: string; name: string; message: string }[] }
type AttachedFile = { id: string; name: string; size: number; text: string }
type DeleteMode = 'single' | 'subtree'
type DeleteState = { card: Card; mode: DeleteMode; successorId?: string }
type UndoNotice = { operationId: string; count: number; title: string }

const demoCards: Card[] = [
  { id: 's:turn:1', sessionId: 's', cwd: 'passport-web', title: '梳理登录回调异常', summary: '用户反馈生产环境在登录后反复回到登录页，需要定位回调链路与环境配置差异。', sourceSeq: 1, branchSeq: 2, parentSessionId: null, position: { x: 70, y: 190 }, tools: 2, todos: 1, messages: [] },
  { id: 's:turn:4', sessionId: 's', cwd: 'passport-web', title: '检查中间件与回调地址', summary: '确认生产环境缺少协议前缀导致 URL 比较失败。', sourceSeq: 4, branchSeq: 5, parentCardId: 's:turn:1', parentSessionId: null, position: { x: 440, y: 190 }, tools: 3, todos: 0, messages: [] },
  { id: 'b:turn:6', sessionId: 'b', cwd: 'passport-web', title: '另一种思路：关闭 URL 校验', summary: '此做法会削弱生产环境安全边界，因此不建议采用。', sourceSeq: 6, branchSeq: 7, parentCardId: 's:turn:4', parentSessionId: 's', position: { x: 810, y: 440 }, tools: 1, todos: 0, messages: [] },
]
const isDevPreview = location.port === '5173'
const readCollapsed = () => { try { const value = JSON.parse(localStorage.getItem('dsh-atlas:collapsed:v1') ?? '[]'); return new Set<string>(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []) } catch { return new Set<string>() } }
const readCamera = () => { try { const value = JSON.parse(localStorage.getItem('dsh-atlas:camera:v1') ?? '{}'); return { scale: finite(value.scale, 1), offset: { x: finite(value.x, 0), y: finite(value.y, 0) } } } catch { return { scale: 1, offset: { x: 0, y: 0 } } } }
const readThemeOverride = (): ThemeOverride => { const value = localStorage.getItem('dsh-atlas:theme:v1'); return value === 'light' || value === 'dark' ? value : null }

export function App() {
  const camera = useMemo(readCamera, [])
  const [cards, setCards] = useState<Card[]>(isDevPreview ? demoCards : [])
  const [workspaces, setWorkspaces] = useState<Workspace[]>(isDevPreview ? [{ cwd: 'passport-web', title: 'passport-web', sessionCount: 3 }] : [])
  const [dshWorkspaces, setDshWorkspaces] = useState<DshWorkspace[]>([])
  const [selectedDshWorkspaceId, setSelectedDshWorkspaceId] = useState('')
  const [cwd, setCwd] = useState('')
  const [activeSession, setActiveSession] = useState(isDevPreview ? demoCards[0].sessionId : '')
  const [canvasRootSession, setCanvasRootSession] = useState(isDevPreview ? demoCards[0].sessionId : '')
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set(isDevPreview ? [demoCards[0].sessionId] : []))
  const [query, setQuery] = useState('')
  const [scale, setScale] = useState(camera.scale)
  const [offset, setOffset] = useState<Point>(camera.offset)
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [detail, setDetail] = useState<Card | null>(null)
  const [compose, setCompose] = useState<Compose | null>(null)
  const [live, setLive] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!isDevPreview)
  const [error, setError] = useState('')
  const [hostDark, setHostDark] = useState(false)
  const [themeOverride, setThemeOverride] = useState<ThemeOverride>(readThemeOverride)
  const [nativeModel, setNativeModel] = useState('使用当前 DSH 模型')
  const [deletion, setDeletion] = useState<DeleteState | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const pan = useRef<{ x: number; y: number; offset: Point } | null>(null)
  const dragging = useRef<{ card: Card; origin: Point; pointer: Point; latest: Point; moved: boolean } | null>(null)
  const suppressClickUntil = useRef(0)
  const pending = useRef(new Map<string, RpcPending>())
  const focusRef = useRef<() => void>(() => {})
  const dshWorkspacesRef = useRef<DshWorkspace[]>([])
  const cardsRef = useRef(cards)
  const activeSessionRef = useRef(activeSession)
  const nativeSessionRef = useRef('')
  const loadVersion = useRef(0)
  const undoTimer = useRef<number | null>(null)
  cardsRef.current = cards
  activeSessionRef.current = activeSession

  const post = useCallback((type: string, body = {}) => window.parent.postMessage({ source: 'dsh-atlas', type, ...body }, location.origin), [])
  const rpc = useCallback((type: string, body = {}) => new Promise<unknown>((resolve, reject) => {
    if (window.parent === window) return reject(new Error('请从 DSH 页面打开 Atlas 后再执行此操作'))
    const requestId = crypto.randomUUID()
    const timer = window.setTimeout(() => { pending.current.delete(requestId); reject(new Error('DSH 响应超时，请重试')) }, 20_000)
    pending.current.set(requestId, { resolve, reject, timer })
    post(type, { ...body, requestId })
  }), [post])
  const settle = useCallback((requestId: unknown, value: unknown, message?: string) => {
    if (typeof requestId !== 'string') return false
    const item = pending.current.get(requestId)
    if (!item) return false
    pending.current.delete(requestId); window.clearTimeout(item.timer)
    if (message) item.reject(new Error(message)); else item.resolve(value)
    return true
  }, [])
  const load = useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true)
    try {
      const response = await fetch('/atlas/api/conversations')
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? '无法读取对话投影')
      const data = await response.json() as { cards: Card[]; workspaces: Workspace[] }
      if (version !== loadVersion.current) return
      setCards(Array.isArray(data.cards) ? data.cards : [])
      if (Array.isArray(data.workspaces)) {
        setWorkspaces(data.workspaces)
        setCwd(value => value || data.workspaces[0]?.cwd || '')
      }
    } catch (reason) {
      if (version === loadVersion.current && !isDevPreview) setError(reason instanceof Error ? reason.message : '无法读取对话投影')
    } finally { if (version === loadVersion.current) setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.source !== 'dsh-atlas') return
      const data = event.data
      if (data.type === 'atlas:current-session') {
        const id = data.session?.id ?? ''
        if (id === nativeSessionRef.current) return
        nativeSessionRef.current = id
        setActiveSession(id)
        if (id) setCanvasRootSession(id)
        setDetail(value => value && value.sessionId !== id ? null : value)
        if (id) setSelectedDshWorkspaceId(value => dshWorkspacesRef.current.find(item => item.sessionIds.includes(id))?.id ?? value)
        if (id) setCollapsed(value => revealSession(cardsRef.current, id, value))
        if (id) window.setTimeout(() => focusRef.current(), 0)
      }
      if (data.type === 'atlas:workspaces' && Array.isArray(data.workspaces)) {
        dshWorkspacesRef.current = data.workspaces
        setDshWorkspaces(data.workspaces)
        setSelectedDshWorkspaceId(value => data.workspaces.some((item: DshWorkspace) => item.id === value) ? value : data.workspaces.find((item: DshWorkspace) => item.sessionIds.includes(activeSessionRef.current))?.id ?? data.workspaces[0]?.id ?? '')
      }
      if (data.type === 'atlas:refresh') void load()
      if (data.type === 'atlas:theme') setHostDark(data.dark === true)
      if (data.type === 'atlas:native-state' && typeof data.model === 'string') setNativeModel(data.model.replace(/^选择模型，当前\s*/, ''))
      if (data.type === 'atlas:live-reply' && typeof data.sessionId === 'string') setLive(value => data.running ? { ...value, [data.sessionId]: String(data.text ?? '') } : without(value, data.sessionId))
      if (data.type === 'atlas:error') { if (!settle(data.requestId, null, String(data.message ?? '操作未完成'))) setError(String(data.message ?? '操作未完成')) }
      if (['atlas:created-session', 'atlas:forked-session'].includes(data.type)) settle(data.requestId, data.session)
      if (data.type === 'atlas:message-sent') settle(data.requestId, { sessionId: data.sessionId })
      if (data.type === 'atlas:model-directory') settle(data.requestId, data.directory)
      if (data.type === 'atlas:model-selected') settle(data.requestId, data.directory)
      if (data.type === 'atlas:command-ran') settle(data.requestId, data.result)
      if (data.type === 'atlas:map-opened') { setDetail(null); setDraft(''); window.setTimeout(() => focusRef.current(), 0) }
    }
    window.addEventListener('message', receive); post('atlas:ready')
    return () => { window.removeEventListener('message', receive) }
  }, [load, post, settle])
  useEffect(() => () => { for (const item of pending.current.values()) { window.clearTimeout(item.timer); item.reject(new Error('Atlas 已关闭')) }; pending.current.clear(); if (undoTimer.current !== null) window.clearTimeout(undoTimer.current) }, [])
  useEffect(() => { try { localStorage.setItem('dsh-atlas:collapsed:v1', JSON.stringify([...collapsed])) } catch { /* storage can be disabled */ } }, [collapsed])
  useEffect(() => { const timer = window.setTimeout(() => { try { localStorage.setItem('dsh-atlas:camera:v1', JSON.stringify({ scale, x: offset.x, y: offset.y })) } catch { /* storage can be disabled */ } }, 200); return () => window.clearTimeout(timer) }, [offset, scale])
  useEffect(() => { try { if (themeOverride) localStorage.setItem('dsh-atlas:theme:v1', themeOverride); else localStorage.removeItem('dsh-atlas:theme:v1') } catch { /* storage can be disabled */ } }, [themeOverride])

  const selectedDshWorkspace = dshWorkspaces.find(item => item.id === selectedDshWorkspaceId)
  const workspaceCards = useMemo(() => selectedDshWorkspace === undefined
    ? cards.filter(card => !cwd || card.cwd === cwd)
    : cards.filter(card => selectedDshWorkspace.sessionIds.includes(card.sessionId)), [cards, cwd, selectedDshWorkspace])
  const sessionTree = useMemo(() => buildSessionTree(workspaceCards), [workspaceCards])
  const resolvedCanvasRoot = useMemo(() => {
    if (workspaceCards.some(card => card.sessionId === canvasRootSession)) return rootSessionId(workspaceCards, canvasRootSession)
    if (workspaceCards.some(card => card.sessionId === activeSession)) return rootSessionId(workspaceCards, activeSession)
    return sessionTree[0]?.id ?? ''
  }, [activeSession, canvasRootSession, sessionTree, workspaceCards])
  const canvasCards = useMemo(() => conversationCards(workspaceCards, resolvedCanvasRoot), [resolvedCanvasRoot, workspaceCards])
  const positions = useMemo(() => layout(canvasCards), [canvasCards])
  const graph = useMemo(() => graphView(canvasCards, collapsed), [canvasCards, collapsed])
  const visible = useMemo(() => graph.cards.filter(card => `${card.title} ${card.summary}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [graph.cards, query])
  const deletePlan = useMemo(() => deletion ? planDeletion(canvasCards, deletion.card.id) : null, [canvasCards, deletion])
  const deletePreviewIds = useMemo(() => new Set(deletion?.mode === 'subtree' ? deletePlan?.descendants.map(card => card.id) ?? [] : deletion ? [deletion.card.id] : []), [deletePlan, deletion])
  const reconnectPreview = useMemo(() => {
    if (deletion?.mode !== 'single' || !deletePlan) return []
    if (deletePlan.target.parentCardId) return deletePlan.directChildren.map(child => ({ fromId: deletePlan.target.parentCardId!, child }))
    const promoted = deletePlan.mainSuccessor ?? deletePlan.directChildren.find(card => card.id === deletion.successorId)
    return promoted ? deletePlan.directChildren.filter(card => card.id !== promoted.id).map(child => ({ fromId: promoted.id, child })) : []
  }, [deletePlan, deletion])
  const dark = themeOverride ? themeOverride === 'dark' : hostDark
  useEffect(() => { document.documentElement.classList.toggle('atlas-dark', dark); return () => document.documentElement.classList.remove('atlas-dark') }, [dark])
  const rootCard = canvasCards.find(card => card.sessionId === resolvedCanvasRoot) ?? canvasCards[0]
  const branchCount = new Set(canvasCards.filter(card => card.sessionId !== resolvedCanvasRoot).map(card => card.sessionId)).size
  useEffect(() => {
    if (!resolvedCanvasRoot) return
    setCanvasRootSession(value => value === resolvedCanvasRoot ? value : resolvedCanvasRoot)
    setExpandedSessions(value => value.has(resolvedCanvasRoot) ? value : new Set([...value, resolvedCanvasRoot]))
  }, [resolvedCanvasRoot])
  const focusActive = useCallback(() => {
    const card = canvasCards.find(item => item.sessionId === activeSession) ?? canvasCards[0]
    const point = card && positions.get(card.id)
    if (point && stage.current) setOffset({ x: Math.round(stage.current.clientWidth / 2 - (point.x + 155) * scale), y: Math.round(stage.current.clientHeight / 2 - (point.y + 110) * scale) })
  }, [activeSession, canvasCards, positions, scale])
  focusRef.current = focusActive

  function beginDrag(event: React.PointerEvent<HTMLElement>, card: Card) {
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select, [data-no-drag]')) return
    event.preventDefault(); event.stopPropagation()
    const origin = positions.get(card.id); if (!origin) return
    dragging.current = { card, origin, pointer: { x: event.clientX, y: event.clientY }, latest: origin, moved: false }
    const moveCard = (pointer: PointerEvent) => {
      const d = dragging.current; if (!d) return
      const next = { x: Math.round(d.origin.x + (pointer.clientX - d.pointer.x) / scale), y: Math.round(d.origin.y + (pointer.clientY - d.pointer.y) / scale) }
      d.latest = next; d.moved ||= Math.hypot(pointer.clientX - d.pointer.x, pointer.clientY - d.pointer.y) > 3
      setCards(all => all.map(item => item.id === card.id ? { ...item, position: next } : item))
    }
    const finish = () => {
      document.removeEventListener('pointermove', moveCard); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', finish)
      const d = dragging.current; dragging.current = null
      if (d?.moved) { suppressClickUntil.current = Date.now() + 220; void savePosition(d.card.id, d.latest) }
    }
    document.addEventListener('pointermove', moveCard); document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', finish)
  }
  function move(event: React.PointerEvent<HTMLDivElement>) { if (pan.current) setOffset({ x: pan.current.offset.x + event.clientX - pan.current.x, y: pan.current.offset.y + event.clientY - pan.current.y }) }
  function stop() { pan.current = null }
  async function open(card: Card) {
    if (Date.now() < suppressClickUntil.current) return
    setActiveSession(card.sessionId); setCollapsed(value => revealSession(cards, card.sessionId, value)); setDetail(card)
    try { const response = await fetch(`/atlas/api/cards/${encodeURIComponent(card.id)}`); if (response.ok) { const body = await response.json(); setDetail(value => value?.id === card.id ? { ...value, messages: body.messages ?? value.messages } : value) } } catch { /* projected card still has a usable summary */ }
  }
  function selectSession(card: Card) {
    setCanvasRootSession(rootSessionId(workspaceCards, card.sessionId)); setActiveSession(card.sessionId); setDetail(null)
    setCollapsed(value => revealSession(cards, card.sessionId, value))
    window.setTimeout(() => focusRef.current(), 0)
  }
  function arrange() { const next = layout(canvasCards, true); setCards(all => all.map(card => next.has(card.id) ? { ...card, position: next.get(card.id)! } : card)); for (const [id, point] of next) void savePosition(id, point) }
  function toggleTheme() { setThemeOverride(dark ? 'light' : 'dark') }
  function requestDelete(card: Card) { const plan = planDeletion(canvasCards, card.id); setDeletion({ card, mode: 'single', successorId: plan.mainSuccessor?.id ?? plan.directChildren[0]?.id }) }
  async function confirmDelete() {
    if (!deletion || deleting) return
    setDeleting(true); setError('')
    try {
      const response = await fetch(`/atlas/api/cards/${encodeURIComponent(deletion.card.id)}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: deletion.mode, successorCardId: deletion.successorId }) })
      const body = await response.json().catch(() => ({})) as { operationId?: string; deletedCount?: number; error?: string }
      if (!response.ok || !body.operationId) throw new Error(body.error ?? '删除失败，请重试')
      const notice = { operationId: body.operationId, count: body.deletedCount ?? 1, title: deletion.card.title }
      setDeletion(null); setDetail(null); setUndoNotice(notice); await load()
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
      undoTimer.current = window.setTimeout(() => { setUndoNotice(value => value?.operationId === notice.operationId ? null : value); undoTimer.current = null }, 8_000)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败，请重试') }
    finally { setDeleting(false) }
  }
  async function undoDelete() {
    const notice = undoNotice; if (!notice) return
    if (undoTimer.current !== null) { window.clearTimeout(undoTimer.current); undoTimer.current = null }
    setUndoNotice(null)
    try {
      const response = await fetch(`/atlas/api/deletions/${encodeURIComponent(notice.operationId)}/undo`, { method: 'POST' })
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? '无法撤销删除')
      await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法撤销删除') }
  }
  function toggleChildren(cardId: string) { setCollapsed(value => { const next = new Set(value); if (next.has(cardId)) next.delete(cardId); else next.add(cardId); return next }) }
  function zoomAt(nextScale: number, clientX?: number, clientY?: number) { const value = Math.min(4, Math.max(.5, Math.round(nextScale * 100) / 100)); if (!stage.current || clientX === undefined || clientY === undefined) return setScale(value); const bounds = stage.current.getBoundingClientRect(); const local = { x: clientX - bounds.left, y: clientY - bounds.top }; const world = { x: (local.x - offset.x) / scale, y: (local.y - offset.y) / scale }; setOffset({ x: local.x - world.x * value, y: local.y - world.y * value }); setScale(value) }
  async function submitCompose() {
    const text = draft.trim(); if (!compose || text === '' || busy) return
    setBusy(true); setError('')
    try {
      if (compose.kind === 'new') {
        const session = await rpc('atlas:create-session', { workspaceId: selectedDshWorkspace?.id, cwd: cwd || undefined }) as { id: string }
        await rpc('atlas:send-message', { sessionId: session.id, text }); setActiveSession(session.id)
      } else {
        const session = await rpc('atlas:fork-session', { sessionId: compose.card.sessionId, atSeq: compose.card.branchSeq ?? compose.card.sourceSeq ?? undefined }) as { id: string }
        await rpc('atlas:send-message', { sessionId: session.id, text }); setActiveSession(session.id)
      }
      setCompose(null); setDraft(''); window.setTimeout(() => void load(), 180)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作未完成') }
    finally { setBusy(false) }
  }
  async function continueConversation(text: string) { if (!detail || text.trim() === '' || busy) return; setBusy(true); try { await rpc('atlas:send-message', { sessionId: detail.sessionId, text }); setDraft(''); window.setTimeout(() => void load(), 180) } catch (reason) { setError(reason instanceof Error ? reason.message : '消息发送失败') } finally { setBusy(false) } }
  async function runCommand(line: string) { if (!detail || busy) return null; setBusy(true); try { const result = await rpc('atlas:run-command', { sessionId: detail.sessionId, line }); setDraft(''); window.setTimeout(() => void load(), 180); return result } catch (reason) { setError(reason instanceof Error ? reason.message : '命令执行失败'); return null } finally { setBusy(false) } }

  return <main className={`atlas-shell ${dark ? 'atlas-dark' : ''}`}>
    <header className="atlas-topbar"><div className="atlas-brand"><span className="atlas-mark">A</span><span>DSH Atlas</span></div><div className="atlas-search atlas-search-mobile"><Search className="size-4" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索当前画布" aria-label="搜索对话卡片" /></div><div className="atlas-topbar-actions"><Button variant="outline" size="sm" onClick={toggleTheme} aria-label={dark ? '切换为浅色背景' : '切换为深色背景'} title={dark ? '切换为浅色背景' : '切换为深色背景'}>{dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}<span className="atlas-theme-label">{dark ? '浅色' : '深色'}</span></Button></div></header>
    <div className="atlas-layout"><aside className="atlas-sidebar"><Button size="sm" className="w-full justify-start" onClick={() => { setCompose({ kind: 'new' }); setDraft('') }}><Plus className="size-4" />新建对话</Button><div className="atlas-search atlas-search-sidebar"><Search className="size-4" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索当前画布" aria-label="搜索对话卡片" /></div><div className="atlas-section-title"><span>工作目录</span></div>{dshWorkspaces.length > 0 ? <select className="atlas-workspace-select" value={selectedDshWorkspaceId} onChange={event => { const workspace = dshWorkspaces.find(item => item.id === event.target.value); setSelectedDshWorkspaceId(event.target.value); setCwd(workspace?.path ?? ''); setDetail(null); setCanvasRootSession('') }}>{dshWorkspaces.map(item => <option key={item.id} value={item.id}>{item.title} · {item.sessionIds.length}</option>)}</select> : <select className="atlas-workspace-select" value={cwd} onChange={event => { setCwd(event.target.value); setDetail(null); setCanvasRootSession('') }}>{workspaces.map(item => <option key={item.cwd} value={item.cwd}>{item.title} · {item.sessionCount}</option>)}</select>}<div className="atlas-section-title"><span>会话</span><span>{sessionTree.length}</span></div><nav className="atlas-nav" aria-label="会话与分支">{sessionTree.map(node => <SessionNav key={node.id} node={node} activeSession={activeSession} canvasRoot={resolvedCanvasRoot} expanded={expandedSessions} onToggle={id => setExpandedSessions(value => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); return next })} onSelect={selectSession} />)}</nav><p className="atlas-sidebar-footer">每个主会话使用独立画布；展开子菜单可定位其分支。Atlas 不改变 DSH 历史。</p></aside>
      <section className="atlas-stage-wrap"><div className="atlas-stage-header"><div><h1>{rootCard?.title ?? '对话卡片'}</h1><p>{visible.length} 张可见卡片 · {branchCount} 个分支 · 可续问、折叠与移动</p></div><div className="atlas-stage-actions"><Button className="atlas-arrange-button" variant="outline" size="sm" onClick={arrange}>整理节点</Button><Button className="atlas-mobile-new" size="sm" onClick={() => { setCompose({ kind: 'new' }); setDraft('') }}><Plus className="size-3.5" />新建</Button><Button variant="outline" size="sm" onClick={focusActive}><Focus className="size-3.5" />定位</Button><div className="atlas-zoom"><button onClick={() => zoomAt(scale - .1)} aria-label="缩小"><Minus className="size-3.5" /></button><span>{Math.round(scale * 100)}%</span><button onClick={() => zoomAt(scale + .1)} aria-label="放大"><Plus className="size-3.5" /></button></div></div></div>
        {error && <div className="atlas-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
        <div ref={stage} className="atlas-stage" onPointerDown={event => { if (!(event.target as HTMLElement).closest('[data-card]')) { pan.current = { x: event.clientX, y: event.clientY, offset }; event.currentTarget.setPointerCapture(event.pointerId) } }} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onWheel={event => { if ((event.target as HTMLElement).closest('[data-card]')) return; event.preventDefault(); zoomAt(scale + (event.deltaY < 0 ? .08 : -.08), event.clientX, event.clientY) }}>
          <div className="atlas-grid" />{loading && <div className="atlas-empty"><LoaderCircle className="size-5 animate-spin" />正在同步 DSH 对话…</div>}{!loading && workspaceCards.length === 0 && <div className="atlas-empty"><MessageSquareText className="size-6" /><strong>当前工作区还没有可整理的对话</strong><span>在 DSH 中开始一次对话，Atlas 会自动生成卡片。</span></div>}
          <div className="atlas-world" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}><svg className="atlas-connections" width="3600" height="2400" aria-hidden="true">{visible.map(card => { const from = card.parentCardId && positions.get(card.parentCardId); const to = positions.get(card.id)!; const preview = deletePreviewIds.has(card.id) || (card.parentCardId ? deletePreviewIds.has(card.parentCardId) : false); return from ? <path key={card.id} d={connectorPath(from, to, card.parentSessionId !== null)} className={`${card.parentSessionId ? 'atlas-connection is-branch' : 'atlas-connection'} ${preview ? 'is-delete-preview' : ''}`} /> : null })}{reconnectPreview.map(({ fromId, child }) => { const from = positions.get(fromId); const to = positions.get(child.id); return from && to ? <path key={`preview:${child.id}`} d={connectorPath(from, to, child.parentSessionId !== null)} className="atlas-connection is-reconnect-preview" /> : null })}</svg>{visible.map(card => <CardView key={card.id} card={card} point={positions.get(card.id)!} active={card.sessionId === activeSession} deleting={deletePreviewIds.has(card.id)} live={live[card.sessionId]} childCount={graph.childCounts.get(card.id) ?? 0} collapsed={collapsed.has(card.id)} onOpen={() => void open(card)} onDrag={event => beginDrag(event, card)} onBranch={() => { setCompose({ kind: 'branch', card }); setDraft('') }} onDelete={() => requestDelete(card)} onToggle={() => toggleChildren(card.id)} />)}</div>
        </div>
      </section>
    </div>
    <Dialog open={detail !== null} onOpenChange={value => { if (!value) { setDetail(null); setDraft('') } }}><DialogContent className="atlas-detail-dialog max-h-[min(880px,calc(100vh-24px))] overflow-hidden"><div className="flex max-h-[calc(100vh-58px)] flex-col pr-7">{detail && <><div className="mb-3 flex gap-2"><Badge>{detail.parentSessionId ? '分支' : '会话'}</Badge><Badge>{detail.tools} 次工具</Badge></div><DialogTitle className="text-xl font-semibold tracking-tight text-[var(--fg-2)]">{detail.title}</DialogTitle><div className="atlas-detail-messages mt-4">{detail.messages.length ? detail.messages.map(message => <MessageView key={`${message.sourceSeq}:${message.kind}`} message={message} dark={dark} />) : <MarkdownText text={live[detail.sessionId] || detail.summary} />}{live[detail.sessionId] && <div className="atlas-detail-message is-assistant is-live"><span>DSH · 回复中</span><MarkdownText text={live[detail.sessionId]} /></div>}</div><div className="mt-4 flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => { setDetail(null); setCompose({ kind: 'branch', card: detail }); setDraft('') }}><GitBranch className="size-3.5" />从此回答分支</Button><Button variant="outline" onClick={() => post('atlas:open-session', { sessionId: detail.sessionId })}>在 DSH 中打开</Button></div><NativeComposer sessionId={detail.sessionId} draft={draft} setDraft={setDraft} busy={busy} fallbackModel={nativeModel} rpc={rpc} onSend={continueConversation} onCommand={runCommand} /></>}</div></DialogContent></Dialog>
    <Dialog open={compose !== null} onOpenChange={value => { if (!value && !busy) { setCompose(null); setDraft('') } }}><DialogContent><div className="pr-7"><Badge>{compose?.kind === 'branch' ? '新分支' : '新对话'}</Badge><DialogTitle className="mt-3 text-xl text-[var(--text-strong)]">{compose?.kind === 'branch' ? `从「${compose.card.title}」继续` : '开始一条新对话'}</DialogTitle><p className="mt-2 text-sm text-[var(--text-muted)]">{compose?.kind === 'branch' ? '将从这张卡片对应的回答位置创建原生 DSH 分支。' : `对话将创建在 ${selectedDshWorkspace?.title ?? workspaces.find(item => item.cwd === cwd)?.title ?? '当前 DSH 工作区'}。`}</p><form className="mt-5" onSubmit={event => { event.preventDefault(); void submitCompose() }}><textarea autoFocus className="atlas-compose atlas-compose-large" value={draft} onChange={event => setDraft(event.target.value)} placeholder="输入第一条消息…" maxLength={4000} disabled={busy} /><div className="mt-4 flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => { setCompose(null); setDraft('') }}>取消</Button><Button type="submit" disabled={busy || !draft.trim()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}{compose?.kind === 'branch' ? '创建并发送' : '开始对话'}</Button></div></form></div></DialogContent></Dialog>
    <Dialog open={deletion !== null} onOpenChange={value => { if (!value && !deleting) setDeletion(null) }}><DialogContent className="atlas-delete-dialog"><div className="pr-7">{deletion && deletePlan && <><div className="atlas-delete-icon"><Trash2 className="size-5" /></div><DialogTitle className="mt-3 text-xl text-[var(--fg-2)]">删除卡片节点</DialogTitle><p className="atlas-delete-intro">选择如何处理“{deletion.card.title}”。操作只影响 Atlas 画布，DSH 原始对话会保留。</p><div className="atlas-delete-options" role="radiogroup" aria-label="删除范围"><button type="button" role="radio" aria-checked={deletion.mode === 'single'} className={deletion.mode === 'single' ? 'is-selected' : ''} onClick={() => setDeletion(value => value ? { ...value, mode: 'single' } : value)}><span className="atlas-delete-radio" /><span><strong>仅删除当前节点</strong><small>{deletePlan.directChildren.length > 0 ? `后续 ${deletePlan.directChildren.length} 个直接节点将自动接到上一个节点` : '删除这一张卡片，不影响其它节点'}</small></span></button>{deletePlan.descendants.length > 1 && <button type="button" role="radio" aria-checked={deletion.mode === 'subtree'} className={deletion.mode === 'subtree' ? 'is-selected is-danger' : ''} onClick={() => setDeletion(value => value ? { ...value, mode: 'subtree' } : value)}><span className="atlas-delete-radio" /><span><strong>删除此节点及所有后续</strong><small>共 {deletePlan.descendants.length} 张卡片{deletePlan.branchCount > 0 ? `、${deletePlan.branchCount} 个分支` : ''}，主线和分支后续都会删除</small></span></button>}</div>{deletion.mode === 'single' && !deletePlan.target.parentCardId && !deletePlan.mainSuccessor && deletePlan.directChildren.length > 1 && <label className="atlas-successor-field"><span>选择新的起始节点</span><select value={deletion.successorId ?? ''} onChange={event => setDeletion(value => value ? { ...value, successorId: event.target.value } : value)}>{deletePlan.directChildren.map(card => <option key={card.id} value={card.id}>{card.title}</option>)}</select><small>其它直接分支会自动连接到这个节点。</small></label>}<div className="atlas-delete-actions"><Button variant="outline" disabled={deleting} onClick={() => setDeletion(null)}>取消</Button><Button className="atlas-danger-button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{deletion.mode === 'subtree' ? `删除 ${deletePlan.descendants.length} 张卡片` : '删除当前节点'}</Button></div></>}</div></DialogContent></Dialog>
    {undoNotice && <div className="atlas-undo-toast" role="status"><span>已删除 {undoNotice.count} 张卡片</span><button type="button" onClick={() => void undoDelete()}>撤销</button><button type="button" aria-label="关闭撤销提示" onClick={() => setUndoNotice(null)}><X className="size-4" /></button></div>}
  </main>
}

const nativeCommands = [
  { line: '/status', label: '查看会话状态', detail: '模型、上下文与运行状态' },
  { line: '/compact', label: '压缩上下文', detail: '释放上下文空间并保留摘要' },
  { line: '/model', label: '选择模型', detail: '打开当前会话的模型目录' },
]

function NativeComposer({ sessionId, draft, setDraft, busy, fallbackModel, rpc, onSend, onCommand }: { sessionId: string; draft: string; setDraft: (value: string | ((previous: string) => string)) => void; busy: boolean; fallbackModel: string; rpc: (type: string, body?: object) => Promise<unknown>; onSend: (text: string) => Promise<void>; onCommand: (line: string) => Promise<unknown> }) {
  const [directory, setDirectory] = useState<ModelDirectory | null>(null)
  const [menu, setMenu] = useState<'root' | 'model' | 'effort' | 'command' | null>(null)
  const [modelBusy, setModelBusy] = useState(false)
  const [modelError, setModelError] = useState('')
  const [files, setFiles] = useState<AttachedFile[]>([])
  const [notice, setNotice] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLFormElement>(null)
  const loadModels = useCallback(async () => {
    setModelBusy(true); setModelError('')
    try { setDirectory(await rpc('atlas:get-models', { sessionId }) as ModelDirectory) }
    catch (reason) { setModelError(reason instanceof Error ? reason.message : '模型目录加载失败') }
    finally { setModelBusy(false) }
  }, [rpc, sessionId])
  useEffect(() => { setMenu(null); setFiles([]); void loadModels() }, [loadModels])
  useEffect(() => {
    if (menu === null) return
    const close = (event: MouseEvent) => { if (!composer.current?.contains(event.target as Node)) setMenu(null) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])
  const choices = directory?.groups.flatMap(group => group.models.map(model => ({ group, model }))) ?? []
  const currentChoice = choices.find(choice => choice.group.id === directory?.current?.provider && choice.model.id === directory.current.model)
  const currentEffort = directory?.current?.reasoningEffort ?? currentChoice?.model.reasoning?.defaultEffort
  const effortLabel = currentChoice?.model.reasoning?.efforts.find(item => item.id === currentEffort)?.name ?? currentEffort
  const modelLabel = currentChoice?.model.name ?? fallbackModel.split('，')[0]?.replace(/ · .*/, '') ?? '选择模型'
  const selectModel = async (selection: ModelSelection) => {
    setModelBusy(true); setModelError('')
    try { setDirectory(await rpc('atlas:select-model', { sessionId, selection }) as ModelDirectory); setMenu(null) }
    catch (reason) { setModelError(reason instanceof Error ? reason.message : '模型切换失败') }
    finally { setModelBusy(false) }
  }
  const addFiles = async (list: FileList | null) => {
    if (!list) return
    const next: AttachedFile[] = []
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of [...list]) {
      if (file.size > 256 * 1024 || total + file.size > 512 * 1024) { setModelError('单个文件不能超过 256 KB，合计不能超过 512 KB'); break }
      try { next.push({ id: crypto.randomUUID(), name: file.name, size: file.size, text: await file.text() }); total += file.size }
      catch { setModelError(`无法读取文件：${file.name}`) }
    }
    setFiles(value => [...value, ...next])
    if (fileInput.current) fileInput.current.value = ''
  }
  const submit = async () => {
    const text = draft.trim()
    if (busy || (text === '' && files.length === 0)) return
    const command = nativeCommands.find(item => item.line === text)
    if (command && command.line !== '/model') { const result = await onCommand(command.line) as { status?: { running?: boolean; model?: string; effort?: string } } | null; if (result?.status) setNotice(`会话${result.status.running ? '正在运行' : '空闲'} · ${result.status.model ?? modelLabel}${result.status.effort ? ` · ${result.status.effort}` : ''}`); else if (result) setNotice(`${command.line} 已提交给 DSH`); return }
    if (command?.line === '/model') { setMenu('root'); return }
    const attached = files.map(file => `\n\n<attached_file name="${file.name.replaceAll('"', '&quot;')}">\n${file.text}\n</attached_file>`).join('')
    await onSend(`${text}${attached}`.trim())
    setFiles([])
  }
  const commandVisible = menu === 'command' || draft.trimStart().startsWith('/')
  const mentionVisible = draft.match(/(?:^|\s)@[^\s]*$/) !== null
  return <form ref={composer} className="atlas-native-composer mt-4" data-composer-card onSubmit={event => { event.preventDefault(); void submit() }}>
    {(menu === 'root' || menu === 'model' || menu === 'effort') && <div className="atlas-native-menu atlas-model-menu" role="menu" aria-label="模型与推理等级">
      <div className="atlas-menu-head">{menu !== 'root' && <button type="button" onClick={() => setMenu('root')} aria-label="返回"><ChevronLeft className="size-4" /></button>}<strong>{menu === 'root' ? '模型与推理等级' : menu === 'model' ? '选择模型' : '推理等级'}</strong>{modelBusy && <LoaderCircle className="size-4 animate-spin" />}</div>
      {modelError && <div className="atlas-menu-error"><span>{modelError}</span><button type="button" onClick={() => void loadModels()}>重试</button></div>}
      {menu === 'root' && <><button type="button" role="menuitem" className="atlas-menu-cell" onClick={() => setMenu('model')}><span>模型</span><em>{modelLabel}</em><ChevronRight className="size-4" /></button>{currentChoice?.model.reasoning && <button type="button" role="menuitem" className="atlas-menu-cell" onClick={() => setMenu('effort')}><span>推理等级</span><em>{effortLabel ?? '默认'}</em><ChevronRight className="size-4" /></button>}</>}
      {menu === 'model' && <div className="atlas-model-groups">{directory?.groups.map(group => <section key={group.id}><h4>{group.name}</h4>{group.models.map(model => { const selected = group.id === directory.current?.provider && model.id === directory.current.model; return <button type="button" role="menuitemradio" aria-checked={selected} disabled={modelBusy} key={model.id} onClick={() => void selectModel({ provider: group.id, model: model.id, ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}) })}><span><strong>{model.name}</strong>{model.description && <small>{model.description}</small>}</span>{selected && <Check className="size-4" />}</button>})}</section>)}</div>}
      {menu === 'effort' && <div className="atlas-model-groups">{currentChoice?.model.reasoning?.efforts.map(effort => { const selected = effort.id === currentEffort; return <button type="button" role="menuitemradio" aria-checked={selected} disabled={modelBusy} key={effort.id} onClick={() => void selectModel({ provider: currentChoice.group.id, model: currentChoice.model.id, reasoningEffort: effort.id })}><span><strong>{effort.name}</strong>{effort.description && <small>{effort.description}</small>}</span>{selected && <Check className="size-4" />}</button>})}</div>}
    </div>}
    {commandVisible && <div className="atlas-native-menu atlas-command-help" role="menu" aria-label="命令">{nativeCommands.map(command => <button type="button" role="menuitem" key={command.line} onClick={() => { setDraft(command.line); setMenu(command.line === '/model' ? 'root' : null) }}><span><code>{command.line}</code>{command.label}</span><small>{command.detail}</small></button>)}</div>}
    {mentionVisible && <div className="atlas-native-menu atlas-mention-menu" role="menu" aria-label="引用与文件"><button type="button" role="menuitem" onClick={() => fileInput.current?.click()}><Paperclip className="size-4" /><span><strong>选择本地文件</strong><small>作为上下文附加到本次消息</small></span></button>{files.map(file => <button type="button" role="menuitem" key={file.id} onClick={() => setDraft(draft.replace(/@[^\s]*$/, `@${file.name} `))}><FileText className="size-4" /><span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span></button>)}</div>}
    {notice && <div className="atlas-composer-notice"><span>{notice}</span><button type="button" aria-label="关闭状态" onClick={() => setNotice('')}><X className="size-3" /></button></div>}
    {files.length > 0 && <div className="atlas-attachment-rail">{files.map(file => <span key={file.id}><FileText className="size-3.5" />{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles(value => value.filter(item => item.id !== file.id))}><X className="size-3" /></button></span>)}</div>}
    <textarea className="atlas-native-input" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} placeholder="给智能体发消息" maxLength={16000} disabled={busy} />
    <div className="atlas-native-footer"><div className="atlas-native-left"><button type="button" className="atlas-plus-button" onClick={() => setMenu(menu === 'command' ? null : 'command')} aria-label="命令"><Plus className="size-4" /></button><button type="button" onClick={() => fileInput.current?.click()} title="选择本地文件"><Paperclip className="size-4" /><span>文件</span></button><button type="button" onClick={() => { setDraft(value => `${value}${value && !value.endsWith(' ') ? ' ' : ''}@`); setMenu(null) }} title="插入引用"><AtSign className="size-4" /></button></div><div className="atlas-native-right"><div className="atlas-model-trigger-wrap"><button type="button" className="atlas-model-trigger" onClick={() => setMenu(menu === 'root' ? null : 'root')} aria-haspopup="menu" aria-expanded={menu === 'root' || menu === 'model' || menu === 'effort'}><Bot className="size-4" /><span>{modelLabel}</span>{effortLabel && <em>{effortLabel}</em>}<ChevronDown className="size-3.5" /></button></div><button className="atlas-send-button" type="submit" disabled={busy || (!draft.trim() && files.length === 0)} aria-label="发送消息">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}</button></div></div>
    <input ref={fileInput} className="sr-only" type="file" multiple accept=".txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.java,.go,.rs,.css,.html,.xml,.yaml,.yml,.toml,.ini,.log" onChange={event => void addFiles(event.target.files)} />
  </form>
}

function CardView({ card, point, active, deleting, live, childCount, collapsed, onOpen, onDrag, onBranch, onDelete, onToggle }: { card: Card; point: Point; active: boolean; deleting: boolean; live?: string; childCount: number; collapsed: boolean; onOpen: () => void; onDrag: (event: React.PointerEvent<HTMLElement>) => void; onBranch: () => void; onDelete: () => void; onToggle: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  return <article data-card data-card-id={card.id} className={`atlas-card ${active ? 'is-active' : ''} ${card.parentSessionId ? 'is-branch' : ''} ${deleting ? 'is-delete-preview' : ''}`} style={{ left: point.x, top: point.y }} onPointerDown={onDrag} onClick={onOpen} title="按住卡片拖动；单击查看详情"><header><div className="flex items-center gap-2"><span className="atlas-card-dot" /><Badge>{card.parentSessionId ? '另一种思路' : '对话'}</Badge></div><div className="atlas-card-menu-wrap"><button className="atlas-card-menu-trigger" onClick={event => { event.stopPropagation(); setMenuOpen(value => !value) }} aria-label={`打开 ${card.title} 的卡片菜单`} aria-expanded={menuOpen} title="卡片操作"><MoreHorizontal className="size-4" /></button>{menuOpen && <div className="atlas-card-menu" role="menu"><button role="menuitem" onClick={event => { event.stopPropagation(); setMenuOpen(false); onDelete() }}><Trash2 className="size-3.5" />删除卡片</button></div>}</div></header><h3>{card.title}</h3><div className="atlas-card-summary" onWheel={event => event.stopPropagation()}><MarkdownText text={live?.trim() || card.summary} compact /></div><footer><span>{card.tools > 0 && <><Wrench className="size-3.5" />{card.tools}</>}{card.todos > 0 && ` · 待办 ${card.todos}`}</span><div className="flex gap-1">{childCount > 0 && <button onClick={event => { event.stopPropagation(); onToggle() }} aria-label={collapsed ? `展开 ${childCount} 个后续节点` : `折叠 ${childCount} 个后续节点`}>{collapsed ? <CirclePlus className="size-3.5" /> : <CircleMinus className="size-3.5" />}</button>}<button onClick={event => { event.stopPropagation(); onBranch() }} aria-label="从此回答创建分支"><GitBranch className="size-3.5" /></button><button onClick={event => { event.stopPropagation(); onOpen() }} aria-label="查看详情"><ChevronRight className="size-4" /></button></div></footer></article>
}
function SessionNav({ node, activeSession, canvasRoot, expanded, onToggle, onSelect, depth = 0 }: { node: SessionNode; activeSession: string; canvasRoot: string; expanded: Set<string>; onToggle: (id: string) => void; onSelect: (card: Card) => void; depth?: number }) {
  const isExpanded = expanded.has(node.id)
  return <div className={`atlas-session-node ${depth > 0 ? 'is-branch' : ''}`}>
    <div className="atlas-session-row">
      {node.children.length > 0 ? <button className="atlas-session-toggle" onClick={() => onToggle(node.id)} aria-label={isExpanded ? `收起 ${node.card.title} 的分支` : `展开 ${node.card.title} 的分支`} aria-expanded={isExpanded}>{isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button> : <span className="atlas-session-spacer" />}
      <button className={`${node.id === activeSession ? 'is-active' : ''} ${node.id === canvasRoot ? 'is-canvas-root' : ''}`} onClick={() => onSelect(node.card)} title={node.card.title}>{depth > 0 ? <GitBranch className="size-3.5" /> : <MessageSquareText className="size-4" />}<span className="truncate">{node.card.title}</span>{depth > 0 && <span className="atlas-branch-badge">分支</span>}</button>
    </div>
    {isExpanded && node.children.length > 0 && <div className="atlas-session-children">{node.children.map(child => <SessionNav key={child.id} node={child} activeSession={activeSession} canvasRoot={canvasRoot} expanded={expanded} onToggle={onToggle} onSelect={onSelect} depth={depth + 1} />)}</div>}
  </div>
}
function MarkdownText({ text, compact = false }: { text: string; compact?: boolean }) { return <div className={`atlas-markdown ${compact ? 'is-compact' : ''}`}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: props => <a {...props} target="_blank" rel="noreferrer" /> }}>{text}</ReactMarkdown></div> }
function MessageView({ message, dark }: { message: Message; dark: boolean }) { return <div className={`atlas-detail-message is-${message.kind}`}><span>{message.kind === 'user' ? '你的消息' : message.kind === 'assistant' ? 'DSH' : message.kind === 'todo' ? '待办' : '系统'}</span><MarkdownText text={message.text} />{message.process.map(item => isArtifact(item) ? <ArtifactView key={item.callId} item={item} dark={dark} /> : <details key={item.callId} className="atlas-process"><summary>{item.name} · {item.error ? '失败' : item.result === null ? '进行中' : '已完成'}</summary>{item.arguments && <pre>{item.arguments}</pre>}{item.result && <pre>{item.result}</pre>}{item.error && <pre>{item.error}</pre>}</details>)}</div> }
function ArtifactView({ item, dark }: { item: Process; dark: boolean }) {
  const args = useMemo(() => parseToolArguments(item.arguments), [item.arguments])
  const meta = item.meta ?? {}
  const engine = args.engine === 'mermaid' || meta.engine === 'mermaid' ? 'mermaid' : args.engine === 'three' || meta.engine === 'three' ? 'three' : 'echarts'
  const option = useMemo(() => normalizeObject(args.option ?? (meta.engine === 'echarts' ? meta.payload : undefined)), [args.option, meta])
  const maps = useMemo(() => normalizeObject(args.maps ?? meta.maps), [args.maps, meta])
  const spec = useMemo(() => normalizeObject(args.spec ?? (meta.engine === 'three' ? meta.payload : undefined)), [args.spec, meta])
  const html = typeof args.html === 'string' ? args.html : typeof meta.html === 'string' ? meta.html : ''
  const title = typeof args.title === 'string' ? args.title : typeof meta.title === 'string' ? meta.title : undefined
  const height = args.height ?? meta.height
  if (item.name === 'render_html' && html) return <section className="atlas-artifact"><header>{title ?? 'HTML 画布'}</header><iframe sandbox="allow-scripts" title={title ?? 'HTML 画布'} srcDoc={sandboxHtml(html)} style={{ height: artifactHeight(height, 400) }} /></section>
  if (item.name !== 'render_artifact') return null
  const code = typeof args.code === 'string' ? args.code : meta.engine === 'mermaid' && typeof meta.payload === 'string' ? meta.payload : ''
  return <section className="atlas-artifact"><header>{title ?? (engine === 'mermaid' ? 'Mermaid 图表' : engine === 'three' ? '3D 场景' : 'ECharts 图表')}</header>{engine === 'mermaid' ? <MermaidArtifact code={code} dark={dark} height={artifactHeight(height, 360)} /> : engine === 'three' ? <ThreeArtifact spec={spec} dark={dark} height={artifactHeight(height, 400)} /> : <EchartsArtifact option={option} maps={maps} dark={dark} height={artifactHeight(height, 360)} />}</section>
}
function EchartsArtifact({ option, maps, dark, height }: { option: Record<string, unknown> | null; maps: Record<string, unknown> | null; dark: boolean; height: number }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => { let disposed = false; let chart: { dispose: () => void; setOption: (value: unknown) => void } | null = null; void loadGlobalScript('/plugins/dsh-artifact/assets/echarts.min.js', 'echarts').then(async api => { if (!container.current || disposed || !option) return; if (usesEchartsGl(option)) await loadGlobalScript('/plugins/dsh-artifact/assets/echarts-gl.min.js', 'echarts', true); if (maps) for (const [name, value] of Object.entries(maps)) api.registerMap?.(name, value); const created = api.init(container.current, dark ? 'dark' : undefined) as { dispose: () => void; setOption: (value: unknown) => void }; chart = created; created.setOption(option) }).catch(error => { if (container.current) container.current.textContent = `图表加载失败：${error instanceof Error ? error.message : String(error)}` }); return () => { disposed = true; chart?.dispose() } }, [dark, maps, option])
  return <div ref={container} className="atlas-artifact-canvas" style={{ height }} />
}
function MermaidArtifact({ code, dark, height }: { code: string; dark: boolean; height: number }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => { let disposed = false; void loadGlobalScript('/plugins/dsh-artifact/assets/mermaid.min.js', 'mermaid').then(async api => { if (!container.current || disposed || !code) return; api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' }); const result = await api.render(`atlas-mermaid-${crypto.randomUUID()}`, code); if (!disposed && container.current) container.current.innerHTML = result.svg }).catch(error => { if (container.current) container.current.textContent = `图表加载失败：${error instanceof Error ? error.message : String(error)}` }); return () => { disposed = true; if (container.current) container.current.innerHTML = '' } }, [code, dark])
  return <div ref={container} className="atlas-artifact-canvas is-mermaid" style={{ height }} />
}
function ThreeArtifact({ spec, dark, height }: { spec: Record<string, unknown> | null; dark: boolean; height: number }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let disposed = false
    let cleanup = () => {}
    void loadGlobalScript('/atlas/assets/three.min.js', 'THREE').then(THREE => {
      const element = container.current
      if (!element || disposed || !spec) return
      const width = element.clientWidth || 640
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(width, height)
      element.replaceChildren(renderer.domElement)
      const scene = new THREE.Scene(); scene.background = new THREE.Color(validColor(spec.background) ?? (dark ? '#080d18' : '#f7f8fa'))
      const camera = new THREE.PerspectiveCamera(48, width / height, .1, 300)
      scene.add(new THREE.AmbientLight(0xffffff, finite(spec.ambient, .75)))
      const light = new THREE.DirectionalLight(0xffffff, 1); light.position.set(6, 10, 8); scene.add(light)
      const group = new THREE.Group(); scene.add(group)
      const materials = new Map<string, any>()
      const material = (color: unknown) => { const value = validColor(color) ?? '#4d6bfe'; if (!materials.has(value)) materials.set(value, new THREE.MeshStandardMaterial({ color: value, roughness: .48, metalness: .08 })); return materials.get(value) }
      const geometries: any[] = []
      const meshes = Array.isArray(spec.meshes) ? spec.meshes : []
      for (const raw of meshes) {
        const item = normalizeObject(raw) ?? {}; const size = Math.max(.02, finite(item.size, 1)); let geometry
        if (item.shape === 'sphere') geometry = new THREE.SphereGeometry(size / 2, 18, 12)
        else if (item.shape === 'cone') geometry = new THREE.ConeGeometry(size / 2, size, 20)
        else if (item.shape === 'cylinder') geometry = new THREE.CylinderGeometry(size / 2, size / 2, size, 20)
        else if (item.shape === 'torus') geometry = new THREE.TorusGeometry(size / 2, size / 7, 14, 36)
        else geometry = new THREE.BoxGeometry(size, size, size)
        geometries.push(geometry)
        const mesh = new THREE.Mesh(geometry, material(item.color)); const position = number3(item.position); const rotation = number3(item.rotation)
        mesh.position.set(...position); mesh.rotation.set(...rotation); group.add(mesh)
      }
      const bounds = new THREE.Box3().setFromObject(group); const sphere = bounds.getBoundingSphere(new THREE.Sphere()); const center = sphere.center; const radius = Math.max(sphere.radius, .7)
      let theta = .75; let phi = 1.05; let distance = Math.max(radius * 3.1, 3); let dragging = false; let lastX = 0; let lastY = 0; let frame = 0
      const placeCamera = () => { const sin = Math.sin(phi); camera.position.set(center.x + distance * sin * Math.cos(theta), center.y + distance * Math.cos(phi), center.z + distance * sin * Math.sin(theta)); camera.lookAt(center) }
      const animate = () => { if (disposed) return; if (!dragging) theta += .0018; placeCamera(); renderer.render(scene, camera); frame = requestAnimationFrame(animate) }
      const down = (event: PointerEvent) => { dragging = true; lastX = event.clientX; lastY = event.clientY; renderer.domElement.setPointerCapture(event.pointerId) }
      const move = (event: PointerEvent) => { if (!dragging) return; theta -= (event.clientX - lastX) * .009; phi = Math.min(Math.PI - .12, Math.max(.12, phi + (event.clientY - lastY) * .009)); lastX = event.clientX; lastY = event.clientY }
      const up = () => { dragging = false }
      const wheel = (event: WheelEvent) => { event.preventDefault(); distance = Math.min(radius * 12, Math.max(radius * 1.5, distance * Math.exp(event.deltaY * .001))) }
      const resize = new ResizeObserver(() => { const nextWidth = element.clientWidth || width; renderer.setSize(nextWidth, height); camera.aspect = nextWidth / height; camera.updateProjectionMatrix() })
      renderer.domElement.addEventListener('pointerdown', down); renderer.domElement.addEventListener('pointermove', move); renderer.domElement.addEventListener('pointerup', up); renderer.domElement.addEventListener('pointercancel', up); renderer.domElement.addEventListener('wheel', wheel, { passive: false }); resize.observe(element); animate()
      cleanup = () => { cancelAnimationFrame(frame); resize.disconnect(); renderer.domElement.removeEventListener('pointerdown', down); renderer.domElement.removeEventListener('pointermove', move); renderer.domElement.removeEventListener('pointerup', up); renderer.domElement.removeEventListener('pointercancel', up); renderer.domElement.removeEventListener('wheel', wheel); for (const geometry of geometries) geometry.dispose(); for (const value of materials.values()) value.dispose(); renderer.dispose(); renderer.domElement.remove() }
    }).catch(error => { if (container.current) container.current.textContent = `3D 场景加载失败：${error instanceof Error ? error.message : String(error)}` })
    return () => { disposed = true; cleanup() }
  }, [dark, height, spec])
  return <div ref={container} className="atlas-artifact-canvas is-three" style={{ height }} />
}
function graphView(cards: Card[], collapsed: Set<string>) { const children = new Map<string, string[]>(); for (const card of cards) if (card.parentCardId) children.set(card.parentCardId, [...(children.get(card.parentCardId) ?? []), card.id]); const hidden = new Set<string>(); const visit = (id: string, seen = new Set<string>()) => { if (seen.has(id)) return; seen.add(id); for (const child of children.get(id) ?? []) { hidden.add(child); visit(child, seen) } }; for (const id of collapsed) visit(id); for (const id of collapsed) hidden.delete(id); return { cards: cards.filter(card => !hidden.has(card.id)), childCounts: new Map(cards.map(card => [card.id, children.get(card.id)?.length ?? 0])) } }
function planDeletion(cards: Card[], cardId: string) {
  const target = cards.find(card => card.id === cardId)!
  const children = new Map<string, Card[]>(); for (const card of cards) if (card.parentCardId) children.set(card.parentCardId, [...(children.get(card.parentCardId) ?? []), card])
  const descendants: Card[] = []; const queue = target ? [target] : []; const seen = new Set<string>()
  while (queue.length) { const card = queue.shift()!; if (seen.has(card.id)) continue; seen.add(card.id); descendants.push(card); queue.push(...(children.get(card.id) ?? [])) }
  const directChildren = target ? children.get(target.id) ?? [] : []
  return { target, directChildren, mainSuccessor: directChildren.find(card => card.sessionId === target.sessionId), descendants, branchCount: new Set(descendants.filter(card => card.parentSessionId !== null).map(card => card.sessionId)).size }
}
function revealSession(cards: Card[], sessionId: string, collapsed: Set<string>) { const byId = new Map(cards.map(card => [card.id, card])); const next = new Set(collapsed); let changed = false; for (const card of cards.filter(item => item.sessionId === sessionId)) { const seen = new Set<string>(); let parent = card.parentCardId; while (parent && !seen.has(parent)) { seen.add(parent); if (next.delete(parent)) changed = true; parent = byId.get(parent)?.parentCardId } } return changed ? next : collapsed }
function layout(cards: Card[], force = false) { const positions = new Map<string, Point>(); const roots = new Map<string, number>(); let root = 0; for (const card of cards) { const parent = card.parentCardId ? positions.get(card.parentCardId) : undefined; const rootLane = parent ? (roots.get(card.parentCardId!) ?? 0) : root++; const computed = parent ? { x: parent.x + 370, y: parent.y + (card.parentSessionId ? 270 : 0) } : { x: 70, y: 90 + rootLane * 280 }; positions.set(card.id, !force && card.position ? card.position : computed); roots.set(card.id, rootLane) } return positions }
function buildSessionTree(cards: Card[]) {
  const first = new Map<string, Card>(); for (const card of cards) if (!first.has(card.sessionId)) first.set(card.sessionId, card)
  const nodes = new Map<string, SessionNode>(); for (const [id, card] of first) nodes.set(id, { id, card, parentId: sessionParent(cards, id), children: [] })
  const roots: SessionNode[] = []
  for (const node of nodes.values()) { const parent = node.parentId && nodes.get(node.parentId); if (parent && parent.id !== node.id) parent.children.push(node); else roots.push(node) }
  return roots
}
function sessionParent(cards: Card[], sessionId: string) { return cards.find(card => card.sessionId === sessionId && card.parentSessionId)?.parentSessionId ?? null }
function rootSessionId(cards: Card[], sessionId: string) { const seen = new Set<string>(); let current = sessionId; while (current && !seen.has(current)) { seen.add(current); const parent = sessionParent(cards, current); if (!parent || !cards.some(card => card.sessionId === parent)) return current; current = parent } return sessionId }
function conversationCards(cards: Card[], rootId: string) {
  if (!rootId) return []
  const included = new Set([rootId]); let changed = true
  while (changed) { changed = false; for (const card of cards) if (card.parentSessionId && included.has(card.parentSessionId) && !included.has(card.sessionId)) { included.add(card.sessionId); changed = true } }
  return cards.filter(card => included.has(card.sessionId))
}
function connectorPath(from: Point, to: Point, branch: boolean) {
  const fromX = from.x + 304; const fromY = from.y + 104; const toX = to.x; const toY = to.y + 104
  const distance = Math.abs(toX - fromX); const bend = Math.max(24, Math.min(180, distance * .42)); const arch = branch ? 54 : 30
  const xDirection = toX >= fromX ? 1 : -1; const yDirection = toY >= fromY ? -1 : 1
  return `M ${fromX} ${fromY} C ${fromX + xDirection * bend} ${fromY + yDirection * arch}, ${toX - xDirection * bend} ${toY - yDirection * arch}, ${toX} ${toY}`
}
async function savePosition(id: string, position: Point) { await fetch(`/atlas/api/cards/${encodeURIComponent(id)}/position`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position }) }).catch(() => {}) }
function without(record: Record<string, string>, id: string) { const next = { ...record }; delete next[id]; return next }
function finite(value: unknown, fallback: number) { return Number.isFinite(Number(value)) ? Number(value) : fallback }
function number3(value: unknown): [number, number, number] { const items = Array.isArray(value) ? value : []; return [finite(items[0], 0), finite(items[1], 0), finite(items[2], 0)] }
function validColor(value: unknown) { return typeof value === 'string' && /^(?:#[0-9a-f]{3,8}|[a-z]+)$/i.test(value.trim()) ? value.trim() : null }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.round(value / 102.4) / 10} KB` : `${Math.round(value / 104857.6) / 10} MB` }
const globalScripts = new Map<string, Promise<any>>()
function loadGlobalScript(src: string, globalName: string, force = false) {
  const global = (window as unknown as Record<string, any>)[globalName]; if (!force && global) return Promise.resolve(global)
  const existing = globalScripts.get(src); if (existing) return existing
  const promise = new Promise<any>((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = () => { const api = (window as unknown as Record<string, any>)[globalName]; if (api) resolve(api); else reject(new Error(`${globalName} 未注册`)) }; script.onerror = () => reject(new Error(`无法加载 ${src}`)); document.head.append(script) })
  globalScripts.set(src, promise); return promise
}
function parseToolArguments(raw?: string | null): Record<string, any> { if (!raw) return {}; try { const value = JSON.parse(raw); if (typeof value === 'string') return parseToolArguments(value); if (value && typeof value === 'object' && !Array.isArray(value)) { if ('arguments' in value && !('option' in value || 'code' in value || 'html' in value || 'engine' in value)) return typeof value.arguments === 'string' ? parseToolArguments(value.arguments) : value.arguments; return value } } catch { /* malformed tool arguments stay hidden */ } return {} }
function normalizeObject(value: unknown): Record<string, unknown> | null { if (typeof value === 'string') { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null } catch { return null } } return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function isArtifact(item: Process) { return item.name === 'render_artifact' || item.name === 'render_html' }
function artifactHeight(value: unknown, fallback: number) { return Math.min(520, Math.max(220, finite(value, fallback))) }
function usesEchartsGl(option: Record<string, unknown>) { const series = Array.isArray(option.series) ? option.series : []; return series.some(item => item && typeof item === 'object' && ['scatter3D', 'bar3D', 'line3D', 'lines3D', 'surface', 'map3D'].includes(String((item as { type?: unknown }).type))) || 'globe' in option || 'grid3D' in option }
function sandboxHtml(html: string) { const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">`; if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`); return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${html}</body></html>` }
