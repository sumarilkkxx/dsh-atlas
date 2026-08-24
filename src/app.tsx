import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, AtSign, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleMinus, CirclePlus, Command, FileText, Focus, GitBranch, ListTodo, LoaderCircle, MessageSquareText, Minus, Moon, MoreHorizontal, Paperclip, Plus, Search, Send, Shield, Sun, Trash2, Wrench, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogTitle } from './components/ui/dialog'
import { cardSize, DEFAULT_CARD_SIZE, draftCardPosition, draftConnector, graphView as buildGraphView, latestCardIds, layoutConversationGraph, revealConversationPath } from './lib/conversation-graph'

type Point = { x: number; y: number }
type CardSize = { width: number; height: number }
type Process = { callId: string; name: string; arguments?: string | null; result: string | null; meta?: Record<string, unknown> | null; error?: string | null }
type Message = { sourceSeq: number; kind: string; text: string; process: Process[]; at?: string }
type Task = { id: string; sessionId: string; sourceSeq: number; content: string; status: string; updatedAt?: string }
type MarkerKind = 'none' | 'conclusion' | 'verify' | 'ruleout' | 'decision' | 'pivot' | 'open'
type Marker = { important: boolean; kind: MarkerKind; updatedAt?: string | null }
type CardMetrics = { llmMs?: number; ttftAverageMs?: number; tokensPerSecond?: number; cacheHitPercent?: number; inputTokens?: number; outputTokens?: number }
type Card = { id: string; sessionId: string; cwd: string; title: string; summary: string; sourceSeq: number | null; branchSeq?: number | null; parentCardId?: string; parentSessionId: string | null; position: Point | null; size?: CardSize | null; tools: number; todos: number; metrics?: CardMetrics | null; messages: Message[]; tasks: Task[]; marker: Marker }
type Workspace = { id?: string; cwd: string; title: string; sessionCount: number }
type DshWorkspace = { id: string; title: string; path: string | null; sessionIds: string[] }
type Compose = { kind: 'new' } | { kind: 'continue' | 'branch'; card: Card }
type RpcPending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }
type ThemeOverride = 'light' | 'dark' | null
type SessionNode = { id: string; card: Card; parentId: string | null; children: SessionNode[] }
type ModelEffort = { id: string; name: string; description?: string }
type ModelChoice = { id: string; name: string; description?: string; reasoning?: { defaultEffort?: string; efforts: ModelEffort[] } }
type ModelGroup = { id: string; name: string; models: ModelChoice[] }
type ModelSelection = { provider: string; model: string; reasoningEffort?: string }
type ModelDirectory = { current: ModelSelection | null; routable: boolean | null; groups: ModelGroup[]; failures: { id: string; name: string; message: string }[] }
type PermissionOption = { value: string; name: string; description?: string }
type PermissionDirectory = { currentValue: string; options: PermissionOption[] }
type AttachmentKind = 'pdf' | 'word' | 'spreadsheet' | 'code' | 'text'
type FileAttachment = { name: string; mime: string; size: number; kind: AttachmentKind; extractedChars: number; truncated: boolean }
type CommandDescriptor = { name: string; description: string; input?: { hint: string } }
type SkillDescriptor = { name: string; description?: string; userInvocable?: boolean }
type ContextItem = { id: string; kind: 'file' | 'card'; label: string; detail: string; content: string; attachment?: FileAttachment }
type DeleteMode = 'single' | 'subtree'
type DeleteState = { card: Card; mode: DeleteMode; successorId?: string }
type UndoNotice = { operationId: string; count: number; title: string }
type ResizeEdge = { left: boolean; right: boolean; top: boolean; bottom: boolean }
type ConversationSummary = { rootSessionId: string; revision: string; text: string; provider?: string | null; model?: string | null; generatedAt?: string }
type Filter = 'all' | 'tools' | 'todos' | 'attachments' | 'marked' | MarkerKind

const demoCards: Card[] = [
  { id: 's:turn:1', sessionId: 's', cwd: 'passport-web', title: '梳理登录回调异常', summary: '用户反馈生产环境在登录后反复回到登录页，需要定位回调链路与环境配置差异。', sourceSeq: 1, branchSeq: 2, parentSessionId: null, position: { x: 70, y: 190 }, tools: 2, todos: 1, metrics: { llmMs: 9500, ttftAverageMs: 1200, tokensPerSecond: 96, cacheHitPercent: 73, inputTokens: 48100, outputTokens: 576 }, messages: [], tasks: [{ id: 'demo-task', sessionId: 's', sourceSeq: 1, content: '核对生产回调地址', status: 'pending' }], marker: { important: true, kind: 'verify' } },
  { id: 's:turn:4', sessionId: 's', cwd: 'passport-web', title: '检查中间件与回调地址', summary: '确认生产环境缺少协议前缀导致 URL 比较失败。', sourceSeq: 4, branchSeq: 5, parentCardId: 's:turn:1', parentSessionId: null, position: { x: 440, y: 190 }, tools: 3, todos: 0, metrics: { llmMs: 15700, ttftAverageMs: 790, tokensPerSecond: 142.9, cacheHitPercent: 99, inputTokens: 49952, outputTokens: 1908 }, messages: [], tasks: [], marker: { important: false, kind: 'decision' } },
  { id: 'b:turn:6', sessionId: 'b', cwd: 'passport-web', title: '另一种思路：关闭 URL 校验', summary: '此做法会削弱生产环境安全边界，因此不建议采用。', sourceSeq: 6, branchSeq: 7, parentCardId: 's:turn:4', parentSessionId: 's', position: { x: 810, y: 440 }, tools: 1, todos: 0, messages: [], tasks: [], marker: { important: false, kind: 'ruleout' } },
]
const isDevPreview = location.port === '5173'
const readCollapsed = () => { try { const value = JSON.parse(localStorage.getItem('dsh-atlas:collapsed:v1') ?? '[]'); return new Set<string>(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []) } catch { return new Set<string>() } }
const readCamera = () => { try { const value = JSON.parse(localStorage.getItem('dsh-atlas:camera:v3') ?? '{}'); return { scale: finite(value.scale, 1), offset: { x: finite(value.x, 0), y: finite(value.y, 0) } } } catch { return { scale: 1, offset: { x: 0, y: 0 } } } }
const readThemeOverride = (): ThemeOverride => { const value = localStorage.getItem('dsh-atlas:theme:v1'); return value === 'light' || value === 'dark' ? value : null }
const readSidebarCollapsed = () => { try { return localStorage.getItem('dsh-atlas:sidebar-collapsed:v1') === 'true' } catch { return false } }
const FILTER_OPTIONS: { id: Filter; label: string }[] = [{ id: 'all', label: '全部' }, { id: 'tools', label: '工具' }, { id: 'todos', label: '待办' }, { id: 'attachments', label: '附件' }, { id: 'marked', label: '重点' }, { id: 'conclusion', label: '结论' }, { id: 'verify', label: '待验证' }]

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
  const [filter, setFilter] = useState<Filter>('all')
  const [scale, setScale] = useState(camera.scale)
  const [zoomText, setZoomText] = useState(() => String(Math.round(camera.scale * 100)))
  const [offset, setOffset] = useState<Point>(camera.offset)
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [detail, setDetail] = useState<Card | null>(null)
  const [compose, setCompose] = useState<Compose | null>(null)
  const [live, setLive] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(!isDevPreview)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [hostDark, setHostDark] = useState(false)
  const [themeOverride, setThemeOverride] = useState<ThemeOverride>(readThemeOverride)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [openCardMenuId, setOpenCardMenuId] = useState<string | null>(null)
  const [nativeModel, setNativeModel] = useState('使用当前 DSH 模型')
  const [sidebarDeleteMode, setSidebarDeleteMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set())
  const [sidebarDeleteConfirm, setSidebarDeleteConfirm] = useState(false)
  const [sidebarDeleting, setSidebarDeleting] = useState(false)
  const [conversationSummary, setConversationSummary] = useState<ConversationSummary | null>(null)
  const [summaryRefreshing, setSummaryRefreshing] = useState(false)
  const [summaryRefreshVersion, setSummaryRefreshVersion] = useState(0)
  const [deletion, setDeletion] = useState<DeleteState | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [archiveCard, setArchiveCard] = useState<Card | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const pan = useRef<{ x: number; y: number; offset: Point } | null>(null)
  const dragging = useRef<{ card: Card; origin: Point; pointer: Point; latest: Point; moved: boolean } | null>(null)
  const resizing = useRef<{ card: Card; edge: ResizeEdge; origin: CardSize; originPosition: Point; pointer: Point; latest: CardSize; latestPosition: Point; moved: boolean } | null>(null)
  const suppressClickUntil = useRef(0)
  const pending = useRef(new Map<string, RpcPending>())
  const focusRef = useRef<() => void>(() => {})
  const dshWorkspacesRef = useRef<DshWorkspace[]>([])
  const cardsRef = useRef(cards)
  const activeSessionRef = useRef(activeSession)
  const nativeSessionRef = useRef('')
  const loadVersion = useRef(0)
  const loadAbort = useRef<AbortController | null>(null)
  const hasLoaded = useRef(isDevPreview)
  const undoTimer = useRef<number | null>(null)
  const summaryRequest = useRef(0)
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
    loadAbort.current?.abort()
    const controller = new AbortController()
    loadAbort.current = controller
    const initial = !hasLoaded.current
    if (initial) setLoading(true); else setRefreshing(true)
    try {
      const response = await fetch('/atlas/api/conversations', { signal: controller.signal })
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? '无法读取对话投影')
      const data = await response.json() as { cards: Card[]; workspaces: Workspace[] }
      if (version !== loadVersion.current) return
      setCards(Array.isArray(data.cards) ? data.cards : [])
      if (Array.isArray(data.workspaces)) {
        setWorkspaces(data.workspaces)
        setCwd(value => value || data.workspaces[0]?.cwd || '')
      }
      hasLoaded.current = true
    } catch (reason) {
      if (version === loadVersion.current && !isDevPreview && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : '无法读取对话投影')
    } finally { if (version === loadVersion.current) { if (initial) setLoading(false); setRefreshing(false) } }
  }, [])

  useEffect(() => { void load(); return () => loadAbort.current?.abort() }, [load])
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
        if (id) setCollapsed(value => revealConversationPath(cardsRef.current, id, value))
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
      if (data.type === 'atlas:command-directory') settle(data.requestId, Array.isArray(data.commands) ? data.commands : [])
      if (data.type === 'atlas:skill-directory') settle(data.requestId, Array.isArray(data.skills) ? data.skills : [])
      if (data.type === 'atlas:permission-directory') settle(data.requestId, data.permissions)
      if (data.type === 'atlas:permission-selected') settle(data.requestId, data.permissions)
      if (data.type === 'atlas:command-ran') settle(data.requestId, data.result)
      if (data.type === 'atlas:map-opened') { setDetail(null); setDraft(''); setSummaryRefreshVersion(value => value + 1); window.setTimeout(() => focusRef.current(), 0) }
    }
    window.addEventListener('message', receive); post('atlas:ready')
    return () => { window.removeEventListener('message', receive) }
  }, [load, post, settle])
  useEffect(() => () => { for (const item of pending.current.values()) { window.clearTimeout(item.timer); item.reject(new Error('Atlas 已关闭')) }; pending.current.clear(); if (undoTimer.current !== null) window.clearTimeout(undoTimer.current) }, [])
  useEffect(() => {
    if (compose === null) return
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>('[data-compose-draft] textarea')?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [compose])
  useEffect(() => { try { localStorage.setItem('dsh-atlas:collapsed:v1', JSON.stringify([...collapsed])) } catch { /* storage can be disabled */ } }, [collapsed])
  useEffect(() => { const timer = window.setTimeout(() => { try { localStorage.setItem('dsh-atlas:camera:v3', JSON.stringify({ scale, x: offset.x, y: offset.y })) } catch { /* storage can be disabled */ } }, 200); return () => window.clearTimeout(timer) }, [offset, scale])
  useEffect(() => { setZoomText(String(Math.round(scale * 100))) }, [scale])
  useEffect(() => { try { if (themeOverride) localStorage.setItem('dsh-atlas:theme:v1', themeOverride); else localStorage.removeItem('dsh-atlas:theme:v1') } catch { /* storage can be disabled */ } }, [themeOverride])
  useEffect(() => { try { localStorage.setItem('dsh-atlas:sidebar-collapsed:v1', String(sidebarCollapsed)) } catch { /* storage can be disabled */ } }, [sidebarCollapsed])
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
  const positions = useMemo(() => layoutConversationGraph(canvasCards) as Map<string, Point>, [canvasCards])
  const graph = useMemo(() => buildGraphView(canvasCards, collapsed) as { cards: Card[]; childCounts: Map<string, number> }, [canvasCards, collapsed])
  const continuableCardIds = useMemo(() => latestCardIds(canvasCards) as Set<string>, [canvasCards])
  const matchingCards = useMemo(() => graph.cards.filter(card => matchesCard(card, query, filter)), [filter, graph.cards, query])
  const matchingIds = useMemo(() => new Set(matchingCards.map(card => card.id)), [matchingCards])
  const searchActive = query.trim() !== '' || filter !== 'all'
  const matchingSessionIds = useMemo(() => new Set(workspaceCards.filter(card => matchesCard(card, query, filter)).map(card => card.sessionId)), [filter, query, workspaceCards])
  const sidebarTree = useMemo(() => searchActive ? filterSessionTree(sessionTree, matchingSessionIds) : sessionTree, [matchingSessionIds, searchActive, sessionTree])
  const sidebarSessionCount = useMemo(() => countSessionTree(sidebarTree), [sidebarTree])
  const sidebarSessionNodes = useMemo(() => flattenSessionNodes(sidebarTree), [sidebarTree])
  const selectedSidebarNodes = useMemo(() => sidebarSessionNodes.filter(node => selectedSessionIds.has(node.id)), [selectedSessionIds, sidebarSessionNodes])
  const allSidebarSelected = sidebarSessionNodes.length > 0 && selectedSidebarNodes.length === sidebarSessionNodes.length
  const canvasTasks = useMemo(() => canvasCards.flatMap(card => card.tasks.map(task => ({ task, card }))).sort((a, b) => a.task.status.localeCompare(b.task.status) || a.card.title.localeCompare(b.card.title)), [canvasCards])
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
  const fallbackBrief = useMemo(() => conversationBrief(canvasCards), [canvasCards])
  const historyBrief = conversationSummary?.rootSessionId === resolvedCanvasRoot ? conversationSummary.text : fallbackBrief
  useEffect(() => {
    if (isDevPreview || !resolvedCanvasRoot || canvasCards.length === 0) return
    const revision = conversationRevision(canvasCards)
    const request = ++summaryRequest.current
    const isCurrent = () => request === summaryRequest.current
    const readOrRefresh = async () => {
      try {
        const cachedResponse = await fetch(`/atlas/api/conversations/${encodeURIComponent(resolvedCanvasRoot)}/summary`)
        const cached = cachedResponse.ok ? (await cachedResponse.json() as { summary?: ConversationSummary | null }).summary ?? null : null
        if (!isCurrent()) return
        if (cached) setConversationSummary(cached)
        if (cached?.revision === revision) return
        setSummaryRefreshing(true)
        const directory = await rpc('atlas:get-models', { sessionId: activeSession || resolvedCanvasRoot }) as ModelDirectory
        if (!directory.current) throw new Error('请先为该对话选择可用模型')
        const response = await fetch(`/atlas/api/conversations/${encodeURIComponent(resolvedCanvasRoot)}/summary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, transcript: conversationTranscript(canvasCards), selection: directory.current }) })
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? '无法生成会话摘要')
        const body = await response.json() as { summary: ConversationSummary }
        if (isCurrent()) setConversationSummary(body.summary)
      } catch (reason) {
        if (isCurrent()) setError(reason instanceof Error ? reason.message : '会话摘要更新失败')
      } finally { if (isCurrent()) setSummaryRefreshing(false) }
    }
    void readOrRefresh()
  // Deliberately refreshes only when the map is opened/switched, never on each card projection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedCanvasRoot, summaryRefreshVersion])
  const composeAnchor = compose?.kind === 'new' ? undefined : compose?.card
  const composePoint = useMemo(() => compose ? draftCardPosition(graph.cards, positions, composeAnchor) as Point | null : null, [compose, composeAnchor, graph.cards, positions])
  const branchCount = new Set(canvasCards.filter(card => card.sessionId !== resolvedCanvasRoot).map(card => card.sessionId)).size
  useEffect(() => {
    if (!resolvedCanvasRoot) return
    setCanvasRootSession(value => value === resolvedCanvasRoot ? value : resolvedCanvasRoot)
    setExpandedSessions(value => value.has(resolvedCanvasRoot) ? value : new Set([...value, resolvedCanvasRoot]))
  }, [resolvedCanvasRoot])
  const focusCardFromLeft = useCallback((card: Card, point: Point) => {
    const canvas = stage.current
    if (!canvas) return
    const size = cardSize(card)
    const leftGutter = Math.min(72, Math.max(28, Math.round(canvas.clientWidth * .06)))
    const cardHalfWidth = size.width * scale / 2
    const targetCenterX = Math.max(24, Math.min(leftGutter + cardHalfWidth, canvas.clientWidth - cardHalfWidth - 24))
    setOffset({ x: Math.round(targetCenterX - (point.x + size.width / 2) * scale), y: Math.round(canvas.clientHeight / 2 - (point.y + size.height / 2) * scale) })
  }, [scale])
  const focusActive = useCallback(() => {
    const card = canvasCards.find(item => item.sessionId === activeSession) ?? canvasCards[0]
    const point = card && positions.get(card.id)
    if (point && card) focusCardFromLeft(card, point)
  }, [activeSession, canvasCards, focusCardFromLeft, positions])
  const fitVisibleConversation = useCallback((cardsToFit: Card[], nextPositions: Map<string, Point>) => {
    const canvas = stage.current
    if (!canvas || cardsToFit.length === 0) return
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
    for (const card of cardsToFit) {
      const point = nextPositions.get(card.id)
      if (!point) continue
      const size = cardSize(card)
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x + size.width); maxY = Math.max(maxY, point.y + size.height)
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return
    const padding = Math.min(72, Math.max(32, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * .08)))
    const fitScale = Math.max(.5, Math.min(1, (canvas.clientWidth - padding * 2) / Math.max(1, maxX - minX), (canvas.clientHeight - padding * 2) / Math.max(1, maxY - minY)))
    setScale(Math.round(fitScale * 100) / 100)
    setOffset({ x: Math.round(canvas.clientWidth / 2 - (minX + maxX) / 2 * fitScale), y: Math.round(canvas.clientHeight / 2 - (minY + maxY) / 2 * fitScale) })
  }, [])
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
  function updateCardSize(card: Card, next: CardSize, persist = false, position?: Point) {
    const size = { width: Math.round(Math.max(360, Math.min(820, next.width))), height: Math.round(Math.max(250, Math.min(720, next.height))) }
    setCards(all => all.map(item => item.id === card.id ? { ...item, size, ...(position ? { position } : {}) } : item))
    if (persist) { void saveCardSize(card.id, size); if (position) void savePosition(card.id, position) }
  }
  function beginResize(event: React.PointerEvent<HTMLElement>, card: Card, edge: ResizeEdge) {
    event.preventDefault(); event.stopPropagation()
    const origin = cardSize(card) as CardSize
    const originPosition = positions.get(card.id); if (!originPosition) return
    resizing.current = { card, edge, origin, originPosition, pointer: { x: event.clientX, y: event.clientY }, latest: origin, latestPosition: originPosition, moved: false }
    const moveSize = (pointer: PointerEvent) => {
      const current = resizing.current; if (!current) return
      const dx = (pointer.clientX - current.pointer.x) / scale; const dy = (pointer.clientY - current.pointer.y) / scale
      const next = { width: current.origin.width + (current.edge.right ? dx : 0) - (current.edge.left ? dx : 0), height: current.origin.height + (current.edge.bottom ? dy : 0) - (current.edge.top ? dy : 0) }
      const bounded = { width: Math.round(Math.max(360, Math.min(820, next.width))), height: Math.round(Math.max(250, Math.min(720, next.height))) }
      const nextPosition = { x: current.originPosition.x + (current.edge.left ? current.origin.width - bounded.width : 0), y: current.originPosition.y + (current.edge.top ? current.origin.height - bounded.height : 0) }
      current.latest = bounded; current.latestPosition = nextPosition; current.moved ||= Math.hypot(pointer.clientX - current.pointer.x, pointer.clientY - current.pointer.y) > 3
      updateCardSize(current.card, bounded, false, nextPosition)
    }
    const finish = () => {
      document.removeEventListener('pointermove', moveSize); document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', finish)
      const current = resizing.current; resizing.current = null
      if (current?.moved) { suppressClickUntil.current = Date.now() + 220; updateCardSize(current.card, current.latest, true, current.latestPosition) }
    }
    document.addEventListener('pointermove', moveSize); document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', finish)
  }
  function move(event: React.PointerEvent<HTMLDivElement>) { if (pan.current) setOffset({ x: pan.current.offset.x + event.clientX - pan.current.x, y: pan.current.offset.y + event.clientY - pan.current.y }) }
  function stop() { pan.current = null }
  async function open(card: Card) {
    if (Date.now() < suppressClickUntil.current) return
    setActiveSession(card.sessionId); setCollapsed(value => revealConversationPath(cards, card.sessionId, value)); setDetail(card)
    try { const response = await fetch(`/atlas/api/cards/${encodeURIComponent(card.id)}`); if (response.ok) { const body = await response.json(); setDetail(value => value?.id === card.id ? { ...value, messages: body.messages ?? value.messages } : value) } } catch { /* projected card still has a usable summary */ }
  }
  async function saveMarker(card: Card, marker: Marker) {
    try {
      const response = await fetch(`/atlas/api/cards/${encodeURIComponent(card.id)}/marker`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(marker) })
      const body = await response.json().catch(() => ({})) as { marker?: Marker; error?: string }
      if (!response.ok || !body.marker) throw new Error(body.error ?? '保存标记失败，请重试')
      setCards(all => all.map(item => item.id === card.id ? { ...item, marker: body.marker! } : item))
      setDetail(value => value?.id === card.id ? { ...value, marker: body.marker! } : value)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存标记失败，请重试') }
  }
  function selectSession(card: Card) {
    setCanvasRootSession(rootSessionId(workspaceCards, card.sessionId)); setActiveSession(card.sessionId); setDetail(null)
    setSummaryRefreshVersion(value => value + 1)
    setCollapsed(value => revealConversationPath(cards, card.sessionId, value))
    post('atlas:activate-session', { sessionId: card.sessionId })
    window.setTimeout(() => focusRef.current(), 0)
  }
  function exitSidebarDeleteMode() { setSidebarDeleteMode(false); setSelectedSessionIds(new Set()); setSidebarDeleteConfirm(false) }
  function toggleSidebarSelection(id: string) {
    setSelectedSessionIds(value => {
      const next = new Set(value)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleAllSidebarSelections() { setSelectedSessionIds(allSidebarSelected ? new Set() : new Set(sidebarSessionNodes.map(node => node.id))) }
  async function confirmSidebarDelete() {
    if (selectedSidebarNodes.length === 0 || sidebarDeleting) return
    setSidebarDeleting(true); setError('')
    try {
      // Hiding a parent session also hides its projected descendants, so only send root selections.
      const selected = new Set(selectedSidebarNodes.map(node => node.id))
      const targets = selectedSidebarNodes.filter(node => !hasSelectedSessionAncestor(node, selected, sidebarSessionNodes))
      for (const node of targets) {
        const response = await fetch(`/atlas/api/cards/${encodeURIComponent(node.card.id)}/hide`, { method: 'POST' })
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? '移除会话失败，请重试')
      }
      exitSidebarDeleteMode(); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '移除会话失败，请重试') }
    finally { setSidebarDeleting(false) }
  }
  function arrange() {
    const next = layoutConversationGraph(canvasCards, true)
    setCards(all => all.map(card => next.has(card.id) ? { ...card, position: next.get(card.id)! } : card))
    fitVisibleConversation(graph.cards, next)
    for (const [id, point] of next) void savePosition(id, point)
  }
  function toggleTheme() { setThemeOverride(dark ? 'light' : 'dark') }
  function requestDelete(card: Card) { const plan = planDeletion(canvasCards, card.id); setDeletion({ card, mode: 'single', successorId: plan.mainSuccessor?.id ?? plan.directChildren[0]?.id }) }
  function requestArchive(card: Card) { setArchiveCard(card) }
  async function confirmArchive() {
    if (!archiveCard || archiving) return
    setArchiving(true); setError('')
    try {
      const response = await fetch(`/atlas/api/cards/${encodeURIComponent(archiveCard.id)}/hide`, { method: 'POST' })
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? '归档失败，请重试')
      setArchiveCard(null); setDetail(null); await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '归档失败，请重试') }
    finally { setArchiving(false) }
  }
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
  function commitZoom(value = zoomText) { const percent = Number(value.replace('%', '').trim()); if (!Number.isFinite(percent)) return setZoomText(String(Math.round(scale * 100))); zoomAt(percent / 100); setZoomText(String(Math.round(Math.max(50, Math.min(400, percent))))) }
  async function submitCompose(value = draft) {
    const text = value.trim(); if (!compose || text === '' || busy) return
    setBusy(true); setError('')
    try {
      if (compose.kind === 'new') {
        const session = await rpc('atlas:create-session', { workspaceId: selectedDshWorkspace?.id, cwd: cwd || undefined }) as { id: string }
        await rpc('atlas:send-message', { sessionId: session.id, text }); setActiveSession(session.id)
      } else if (compose.kind === 'continue') {
        await rpc('atlas:send-message', { sessionId: compose.card.sessionId, text }); setActiveSession(compose.card.sessionId)
      } else {
        const session = await rpc('atlas:fork-session', { sessionId: compose.card.sessionId, atSeq: compose.card.branchSeq ?? compose.card.sourceSeq ?? undefined }) as { id: string }
        await rpc('atlas:send-message', { sessionId: session.id, text }); setActiveSession(session.id)
      }
      setCompose(null); setDraft(''); window.setTimeout(() => void load(), 180)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作未完成') }
    finally { setBusy(false) }
  }
  async function continueConversation(sessionId: string, text: string) {
    if (text.trim() === '' || busy) return
    setBusy(true); setError(''); setActiveSession(sessionId); setDetail(null); setDraft('')
    setCanvasRootSession(rootSessionId(workspaceCards, sessionId)); setCollapsed(value => revealConversationPath(cards, sessionId, value))
    try { await rpc('atlas:send-message', { sessionId, text }); window.setTimeout(() => { void load(); focusRef.current() }, 180) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '消息发送失败') }
    finally { setBusy(false) }
  }
  async function runCommand(sessionId: string, line: string) {
    if (busy) return null
    setBusy(true); setError('')
    try { const result = await rpc('atlas:run-command', { sessionId, line }); setDraft(''); window.setTimeout(() => void load(), 180); return result }
    catch (reason) { setError(reason instanceof Error ? reason.message : '命令执行失败'); return null }
    finally { setBusy(false) }
  }

  return <main className={`atlas-shell ${dark ? 'atlas-dark' : ''}`} onPointerDownCapture={event => {
    if (!(event.target as HTMLElement).closest('.atlas-card-menu-wrap')) setOpenCardMenuId(null)
  }}>
    <header className="atlas-topbar"><div className="atlas-brand"><span className="atlas-mark">A</span><span>DSH Atlas</span></div><div className="atlas-search atlas-search-mobile"><Search className="size-4" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、对话、工具与待办" aria-label="搜索会话历史" /></div><div className="atlas-topbar-actions"><button className="atlas-theme-switch" type="button" role="switch" aria-checked={dark} onClick={toggleTheme} aria-label="切换深色或浅色主题" title={dark ? '切换为浅色主题' : '切换为深色主题'}><Sun className="atlas-theme-sun size-3.5" /><Moon className="atlas-theme-moon size-3.5" /><span className="atlas-theme-knob" /></button></div></header>
    <div className={`atlas-layout ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}><aside className="atlas-sidebar"><button type="button" className="atlas-sidebar-toggle" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}><ChevronLeft className="size-4" /></button><button type="button" className="atlas-new-session" onClick={() => { setCompose({ kind: 'new' }); setDraft('') }}><Plus className="size-3.5" /><span>新会话</span></button><div className="atlas-search atlas-search-sidebar"><Search className="size-4" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、对话、工具与待办" aria-label="搜索会话历史" /></div><div className="atlas-filter-row" role="group" aria-label="筛选画布卡片">{FILTER_OPTIONS.map(item => <button key={item.id} type="button" className={filter === item.id ? 'is-active' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><div className="atlas-section-title"><span>工作目录</span></div>{dshWorkspaces.length > 0 ? <select className="atlas-workspace-select" value={selectedDshWorkspaceId} onChange={event => { const workspace = dshWorkspaces.find(item => item.id === event.target.value); setSelectedDshWorkspaceId(event.target.value); setCwd(workspace?.path ?? ''); setDetail(null); setCanvasRootSession('') }}>{dshWorkspaces.map(item => <option key={item.id} value={item.id}>{item.title} · {item.sessionIds.length}</option>)}</select> : <select className="atlas-workspace-select" value={cwd} onChange={event => { setCwd(event.target.value); setDetail(null); setCanvasRootSession('') }}>{workspaces.map(item => <option key={item.cwd} value={item.cwd}>{item.title} · {item.sessionCount}</option>)}</select>}<div className="atlas-section-title atlas-session-heading"><span>{searchActive ? '搜索到的会话' : '会话'}</span><div className="atlas-session-heading-actions">{sidebarDeleteMode ? <><button type="button" className="atlas-select-all" onClick={toggleAllSidebarSelections}>{allSidebarSelected ? '取消全选' : '全选'}</button><span>{selectedSidebarNodes.length}/{sidebarSessionCount}</span><button type="button" className="atlas-session-delete-trigger" onClick={exitSidebarDeleteMode} aria-label="取消批量删除" title="取消"><X className="size-3.5" /></button><button type="button" className="atlas-session-delete-trigger is-danger" disabled={selectedSidebarNodes.length === 0} onClick={() => setSidebarDeleteConfirm(true)} aria-label="删除已选会话" title="删除已选"><Trash2 className="size-3.5" /></button></> : <><span>{sidebarSessionCount}</span><button type="button" className="atlas-session-delete-trigger" onClick={() => { setSidebarDeleteMode(true); setSelectedSessionIds(new Set()) }} aria-label="批量删除会话" title="批量删除会话"><Trash2 className="size-3.5" /></button></>}</div></div><nav className="atlas-nav" aria-label={searchActive ? '搜索到的会话历史' : '会话与分支'}>{sidebarTree.map(node => <SessionNav key={node.id} node={node} activeSession={activeSession} canvasRoot={resolvedCanvasRoot} expanded={expandedSessions} onToggle={id => setExpandedSessions(value => { const next = new Set(value); if (next.has(id)) next.delete(id); else next.add(id); return next })} onSelect={selectSession} selectionMode={sidebarDeleteMode} selectedSessionIds={selectedSessionIds} onSelectForDelete={toggleSidebarSelection} />)}{searchActive && sidebarTree.length === 0 && <p className="atlas-nav-empty">没有匹配的会话历史</p>}</nav>{canvasTasks.length > 0 && <section className="atlas-task-list" aria-label="当前画布待办"><div className="atlas-section-title"><span>待办</span><span>{canvasTasks.length}</span></div>{canvasTasks.slice(0, 8).map(({ task, card }) => <button type="button" key={task.id} onClick={() => void open(card)} title={`定位到「${card.title}」`}><ListTodo className="size-3.5" /><span>{task.content}</span><em>{task.status}</em></button>)}</section>}</aside>
      <section className="atlas-stage-wrap"><div className="atlas-stage-header"><div className="atlas-conversation-brief" tabIndex={0}><span>AI 摘要</span><p title={historyBrief}>{historyBrief}</p><div className="atlas-brief-popover" role="tooltip">{historyBrief}</div><small>{summaryRefreshing ? '正在根据会话历史更新摘要 · ' : ''}{refreshing && <span className="atlas-refresh-status"><LoaderCircle className="size-3 animate-spin" />后台同步中</span>}{searchActive ? `${matchingCards.length} / ${graph.cards.length} 张命中` : `${graph.cards.length} 张可见卡片`} · {branchCount} 个分支 · 可续问、折叠与移动</small></div><div className="atlas-stage-actions"><Button className="atlas-arrange-button" variant="outline" size="sm" onClick={arrange}>整理节点</Button><Button className="atlas-mobile-new" size="sm" onClick={() => { setCompose({ kind: 'new' }); setDraft('') }}><Plus className="size-3.5" />新建</Button><Button variant="outline" size="sm" onClick={focusActive}><Focus className="size-3.5" />定位</Button><div className="atlas-zoom"><button onClick={() => zoomAt(scale - .1)} aria-label="缩小"><Minus className="size-3.5" /></button><input value={zoomText} inputMode="numeric" aria-label="画布缩放百分比" onChange={event => setZoomText(event.target.value.replace(/[^0-9.]/g, ''))} onBlur={() => commitZoom()} onKeyDown={event => { if (event.key === 'Enter') { event.currentTarget.blur(); commitZoom(event.currentTarget.value) } }} /><span>%</span><button onClick={() => zoomAt(scale + .1)} aria-label="放大"><Plus className="size-3.5" /></button></div></div></div>
        {error && <div className="atlas-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
        <div ref={stage} className="atlas-stage" onDragStart={event => event.preventDefault()} onPointerDown={event => { if (!(event.target as HTMLElement).closest('[data-card]')) { event.preventDefault(); window.getSelection()?.removeAllRanges(); pan.current = { x: event.clientX, y: event.clientY, offset }; event.currentTarget.setPointerCapture(event.pointerId) } }} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onWheel={event => { if ((event.target as HTMLElement).closest('[data-card]')) return; event.preventDefault(); zoomAt(scale + (event.deltaY < 0 ? .08 : -.08), event.clientX, event.clientY) }}>
          <div className="atlas-grid" />{loading && workspaceCards.length === 0 && <div className="atlas-empty"><LoaderCircle className="size-5 animate-spin" />正在同步 DSH 对话…</div>}{!loading && workspaceCards.length === 0 && <div className="atlas-empty"><MessageSquareText className="size-6" /><strong>当前工作区还没有可整理的对话</strong><span>在 DSH 中开始一次对话，Atlas 会自动生成卡片。</span></div>}
          <div className="atlas-world" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}>
            <svg className="atlas-connections" width="3600" height="2400" aria-hidden="true">
              {graph.cards.map(card => { const parent = card.parentCardId && canvasCards.find(item => item.id === card.parentCardId); const from = parent && positions.get(parent.id); const to = positions.get(card.id)!; const preview = deletePreviewIds.has(card.id) || (card.parentCardId ? deletePreviewIds.has(card.parentCardId) : false); const matched = searchActive && (matchingIds.has(card.id) || Boolean(card.parentCardId && matchingIds.has(card.parentCardId))); return from && parent ? <path key={card.id} d={connectorPath(from, to, card.parentSessionId !== null, cardSize(parent), cardSize(card))} className={`${card.parentSessionId ? 'atlas-connection is-branch' : 'atlas-connection'} ${preview ? 'is-delete-preview' : ''} ${matched ? 'is-search-match' : ''}`} /> : null })}
              {reconnectPreview.map(({ fromId, child }) => { const parent = canvasCards.find(card => card.id === fromId); const from = positions.get(fromId); const to = positions.get(child.id); return from && to && parent ? <path key={`preview:${child.id}`} d={connectorPath(from, to, child.parentSessionId !== null, cardSize(parent), cardSize(child))} className="atlas-connection is-reconnect-preview" /> : null })}
              {composeAnchor && composePoint && positions.get(composeAnchor.id) && <path d={draftConnector(positions.get(composeAnchor.id)!, composePoint, cardSize(composeAnchor), DEFAULT_CARD_SIZE)} className="atlas-connection is-draft" />}
            </svg>
              {graph.cards.map(card => <CardView key={card.id} card={card} point={positions.get(card.id)!} active={card.sessionId === activeSession} deleting={deletePreviewIds.has(card.id)} matched={searchActive && matchingIds.has(card.id)} live={live[card.sessionId]} childCount={graph.childCounts.get(card.id) ?? 0} collapsed={collapsed.has(card.id)} canContinue={continuableCardIds.has(card.id)} menuOpen={openCardMenuId === card.id} onMenuOpenChange={open => setOpenCardMenuId(open ? card.id : null)} draft={draft} setDraft={setDraft} busy={busy} fallbackModel={nativeModel} rpc={rpc} contextCards={canvasCards} onOpen={() => void open(card)} onDrag={event => beginDrag(event, card)} onResize={(event, edge) => beginResize(event, card, edge)} onContinue={() => { setCompose({ kind: 'continue', card }); setDraft('') }} onBranch={() => { setCompose({ kind: 'branch', card }); setDraft('') }} onSend={text => continueConversation(card.sessionId, text)} onCommand={line => runCommand(card.sessionId, line)} onOpenDsh={() => post('atlas:open-session', { sessionId: card.sessionId })} onArchive={() => requestArchive(card)} onDelete={() => requestDelete(card)} onMarker={marker => void saveMarker(card, marker)} onToggle={() => toggleChildren(card.id)} />)}
            {compose && composePoint && <DraftCardView compose={compose} point={composePoint} draft={draft} setDraft={setDraft} busy={busy} fallbackModel={nativeModel} rpc={rpc} contextCards={canvasCards} onCancel={() => { if (!busy) { setCompose(null); setDraft('') } }} onSubmit={text => submitCompose(text)} onCommand={line => compose.kind === 'new' ? Promise.resolve(null) : runCommand(compose.card.sessionId, line)} />}
          </div>
        </div>
      </section>
    </div>
    <Dialog open={detail !== null} onOpenChange={value => { if (!value) { setDetail(null); setDraft('') } }}><DialogContent className="atlas-detail-dialog"><div className="atlas-detail-content">{detail && <><header className="atlas-detail-header"><div className="flex gap-2"><Badge>{detail.parentSessionId ? '分支' : '会话'}</Badge><Badge>{detail.tools} 次工具</Badge></div><DialogTitle className="atlas-detail-title">对话详情</DialogTitle><p className="atlas-detail-subtitle" title={detail.title}>{previewText(detail.title)}</p></header><div className="atlas-detail-messages">{detail.messages.length ? detail.messages.map(message => <MessageView key={`${message.sourceSeq}:${message.kind}`} message={message} dark={dark} />) : <MarkdownText text={live[detail.sessionId] || detail.summary} />}{live[detail.sessionId] && <div className="atlas-detail-message is-assistant is-live"><span>DSH · 回复中</span><MarkdownText text={live[detail.sessionId]} /></div>}</div><footer className="atlas-detail-actions"><Button variant="outline" onClick={() => { setDetail(null); setCompose({ kind: 'branch', card: detail }); setDraft('') }}><GitBranch className="size-3.5" />从此回答分支</Button><Button variant="outline" onClick={() => post('atlas:open-session', { sessionId: detail.sessionId })}>在 DSH 中打开</Button></footer></>}</div></DialogContent></Dialog>
    <Dialog open={deletion !== null} onOpenChange={value => { if (!value && !deleting) setDeletion(null) }}><DialogContent className="atlas-delete-dialog"><div className="pr-7">{deletion && deletePlan && <><div className="atlas-delete-icon"><Trash2 className="size-5" /></div><DialogTitle className="mt-3 text-xl text-[var(--fg-2)]">删除卡片节点</DialogTitle><p className="atlas-delete-intro">操作只影响 Atlas 画布，DSH 原始对话会保留。</p><div className="atlas-delete-options" role="radiogroup" aria-label="删除范围"><button type="button" role="radio" aria-checked={deletion.mode === 'single'} className={deletion.mode === 'single' ? 'is-selected' : ''} onClick={() => setDeletion(value => value ? { ...value, mode: 'single' } : value)}><span className="atlas-delete-radio" /><span><strong>仅删除当前节点</strong><small>{deletePlan.directChildren.length > 0 ? `后续 ${deletePlan.directChildren.length} 个直接节点将自动接到上一个节点` : '删除这一张卡片，不影响其它节点'}</small></span></button>{deletePlan.descendants.length > 1 && <button type="button" role="radio" aria-checked={deletion.mode === 'subtree'} className={deletion.mode === 'subtree' ? 'is-selected is-danger' : ''} onClick={() => setDeletion(value => value ? { ...value, mode: 'subtree' } : value)}><span className="atlas-delete-radio" /><span><strong>删除此节点及所有后续</strong><small>共 {deletePlan.descendants.length} 张卡片{deletePlan.branchCount > 0 ? `、${deletePlan.branchCount} 个分支` : ''}，主线和分支后续都会删除</small></span></button>}</div>{deletion.mode === 'single' && !deletePlan.target.parentCardId && !deletePlan.mainSuccessor && deletePlan.directChildren.length > 1 && <label className="atlas-successor-field"><span>选择新的起始节点</span><select value={deletion.successorId ?? ''} onChange={event => setDeletion(value => value ? { ...value, successorId: event.target.value } : value)}>{deletePlan.directChildren.map(card => <option key={card.id} value={card.id}>{card.title}</option>)}</select><small>其它直接分支会自动连接到这个节点。</small></label>}<div className="atlas-delete-actions"><Button variant="outline" disabled={deleting} onClick={() => setDeletion(null)}>取消</Button><Button className="atlas-danger-button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{deletion.mode === 'subtree' ? `删除 ${deletePlan.descendants.length} 张卡片` : '删除当前节点'}</Button></div></>}</div></DialogContent></Dialog>
    <Dialog open={sidebarDeleteConfirm} onOpenChange={value => { if (!value && !sidebarDeleting) setSidebarDeleteConfirm(false) }}><DialogContent className="atlas-delete-dialog"><div className="pr-7"><div className="atlas-delete-icon"><Trash2 className="size-5" /></div><DialogTitle className="mt-3 text-xl text-[var(--fg-2)]">移除 {selectedSidebarNodes.length} 条会话记录</DialogTitle><p className="atlas-delete-intro">将所选会话从 Atlas 侧栏与画布视图移除；DSH 中的原始对话和消息不会被删除。</p><div className="atlas-delete-actions"><Button variant="outline" disabled={sidebarDeleting} onClick={() => setSidebarDeleteConfirm(false)}>取消</Button><Button className="atlas-danger-button" disabled={sidebarDeleting} onClick={() => void confirmSidebarDelete()}>{sidebarDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}确认移除</Button></div></div></DialogContent></Dialog>
    <Dialog open={archiveCard !== null} onOpenChange={value => { if (!value && !archiving) setArchiveCard(null) }}><DialogContent className="atlas-delete-dialog"><div className="pr-7">{archiveCard && <><div className="atlas-delete-icon"><Archive className="size-5" /></div><DialogTitle className="mt-3 text-xl text-[var(--fg-2)]">归档当前会话</DialogTitle><p className="atlas-delete-intro">“{archiveCard.title}”及其后续分支将从 Atlas 画布隐藏，但不会删除 DSH 中的原始对话。</p><div className="atlas-delete-actions"><Button variant="outline" disabled={archiving} onClick={() => setArchiveCard(null)}>取消</Button><Button disabled={archiving} onClick={() => void confirmArchive()}>{archiving ? <LoaderCircle className="size-4 animate-spin" /> : <Archive className="size-4" />}归档会话</Button></div></>}</div></DialogContent></Dialog>
    {undoNotice && <div className="atlas-undo-toast" role="status"><span>已删除 {undoNotice.count} 张卡片</span><button type="button" onClick={() => void undoDelete()}>撤销</button><button type="button" aria-label="关闭撤销提示" onClick={() => setUndoNotice(null)}><X className="size-4" /></button></div>}
  </main>
}

function NativeComposer({ sessionId, draft, setDraft, busy, fallbackModel, rpc, contextCards, sourceCard, onSend, onCommand }: { sessionId: string; draft: string; setDraft: (value: string | ((previous: string) => string)) => void; busy: boolean; fallbackModel: string; rpc: (type: string, body?: object) => Promise<unknown>; contextCards: Card[]; sourceCard: Card; onSend: (text: string) => Promise<void>; onCommand: (line: string) => Promise<unknown> }) {
  const [directory, setDirectory] = useState<ModelDirectory | null>(null)
  const [permissions, setPermissions] = useState<PermissionDirectory | null>(null)
  const [commands, setCommands] = useState<CommandDescriptor[]>([])
  const [skills, setSkills] = useState<SkillDescriptor[]>([])
  const [menu, setMenu] = useState<'model' | 'models' | 'effort' | 'permission' | 'command' | 'mention' | 'history' | 'skills' | null>(null)
  const [modelBusy, setModelBusy] = useState(false)
  const [permissionBusy, setPermissionBusy] = useState(false)
  const [modelError, setModelError] = useState('')
  const [permissionError, setPermissionError] = useState('')
  const [contextError, setContextError] = useState('')
  const [commandError, setCommandError] = useState('')
  const [contextItems, setContextItems] = useState<ContextItem[]>([])
  const [notice, setNotice] = useState('')
  const [permissionConfirm, setPermissionConfirm] = useState<PermissionOption | null>(null)
  const [permissionAcknowledged, setPermissionAcknowledged] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLFormElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const loadModels = useCallback(async () => {
    setModelBusy(true); setModelError('')
    try { setDirectory(await rpc('atlas:get-models', { sessionId }) as ModelDirectory) }
    catch (reason) { setModelError(reason instanceof Error ? reason.message : '模型目录加载失败') }
    finally { setModelBusy(false) }
  }, [rpc, sessionId])
  const loadCommands = useCallback(async () => {
    setCommandError('')
    try { setCommands(await rpc('atlas:get-commands', { sessionId }) as CommandDescriptor[]) }
    catch (reason) { setCommandError(reason instanceof Error ? reason.message : '命令目录加载失败') }
  }, [rpc, sessionId])
  const loadSkills = useCallback(async () => {
    try { setSkills(await rpc('atlas:get-skills', { sessionId }) as SkillDescriptor[]) }
    catch { setSkills([]) }
  }, [rpc, sessionId])
  const loadPermissions = useCallback(async () => {
    setPermissionBusy(true); setPermissionError('')
    try { setPermissions(await rpc('atlas:get-permissions', { sessionId }) as PermissionDirectory) }
    catch (reason) { setPermissionError(reason instanceof Error ? reason.message : '权限范围加载失败') }
    finally { setPermissionBusy(false) }
  }, [rpc, sessionId])
  useEffect(() => { setMenu(null); setContextItems([]); void Promise.all([loadModels(), loadCommands(), loadSkills(), loadPermissions()]) }, [loadCommands, loadModels, loadPermissions, loadSkills])
  useEffect(() => {
    if (menu === null) return
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (target && (popup.current?.contains(target) || target.closest('[data-composer-trigger]'))) return
      setMenu(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', escape) }
  }, [menu])
  const choices = directory?.groups.flatMap(group => group.models.map(model => ({ group, model }))) ?? []
  const currentChoice = choices.find(choice => choice.group.id === directory?.current?.provider && choice.model.id === directory.current.model)
  const currentEffort = directory?.current?.reasoningEffort ?? currentChoice?.model.reasoning?.defaultEffort
  const effortLabel = currentChoice?.model.reasoning?.efforts.find(item => item.id === currentEffort)?.name ?? currentEffort
  const modelLabel = currentChoice?.model.name ?? fallbackModel.split('，')[0]?.replace(/ · .*/, '') ?? '选择模型'
  const permissionLabel = permissionName(permissions?.currentValue)
  const selectModel = async (selection: ModelSelection) => {
    setModelBusy(true); setModelError('')
    try { setDirectory(await rpc('atlas:select-model', { sessionId, selection }) as ModelDirectory); setMenu(null) }
    catch (reason) { setModelError(reason instanceof Error ? reason.message : '模型切换失败') }
    finally { setModelBusy(false) }
  }
  const selectPermission = async (option: PermissionOption) => {
    setPermissionBusy(true); setPermissionError('')
    try { setPermissions(await rpc('atlas:select-permission', { sessionId, preset: option.value }) as PermissionDirectory); setMenu(null); return true }
    catch (reason) { setPermissionError(reason instanceof Error ? reason.message : '权限范围切换失败'); return false }
    finally { setPermissionBusy(false) }
  }
  const addFiles = async (list: FileList | null) => {
    if (!list) return
    const next: ContextItem[] = []
    let total = contextItems.filter(item => item.kind === 'file').reduce((sum, item) => sum + (item.attachment?.size ?? new Blob([item.content]).size), 0)
    let totalText = contextItems.filter(item => item.kind === 'file').reduce((sum, item) => sum + item.content.length, 0)
    for (const file of [...list]) {
      if (file.size > MAX_ATTACHMENT_BYTES || total + file.size > MAX_ATTACHMENT_TOTAL_BYTES) { setContextError(`单个文件不能超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}，本次合计不能超过 ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)}`); continue }
      try {
        const attachment = await extractFileAttachment(file)
        const remaining = MAX_ATTACHMENT_TOTAL_TEXT_LENGTH - totalText
        if (remaining < 800) { setContextError(`已达到本次附件可读内容上限（${Math.round(MAX_ATTACHMENT_TOTAL_TEXT_LENGTH / 1000)}k 字符）`); break }
        const content = attachment.text.slice(0, remaining)
        const meta = { ...attachment.meta, extractedChars: content.length, truncated: attachment.meta.truncated || content.length < attachment.text.length }
        next.push({ id: crypto.randomUUID(), kind: 'file', label: attachment.name, detail: `${attachmentLabel(attachment.kind)} · ${formatBytes(attachment.meta.size)}${meta.truncated ? ' · 已截取正文' : ''}`, content, attachment: meta })
        total += file.size
        totalText += content.length
      } catch (reason) { setContextError(reason instanceof Error ? reason.message : `无法读取文件：${file.name}`) }
    }
    setContextItems(value => [...value, ...next])
    if (fileInput.current) fileInput.current.value = ''
  }
  const submit = async () => {
    const text = draft.trim()
    if (busy || (text === '' && contextItems.length === 0)) return
    if (text === '/model') { setMenu('model'); return }
    if (text.startsWith('/')) {
      const result = await onCommand(text) as { status?: { running?: boolean; model?: string; effort?: string }; result?: { text?: string } } | null
      if (result?.status) setNotice(`会话${result.status.running ? '正在运行' : '空闲'} · ${result.status.model ?? modelLabel}${result.status.effort ? ` · ${result.status.effort}` : ''}`)
      else if (result?.result?.text) setNotice(result.result.text)
      else if (result) setNotice(`${text.split(/\s/, 1)[0]} 已提交给 DSH`)
      return
    }
    const attached = contextItems.map(serializeContextItem).join('')
    await onSend(`${text}${attached}`.trim())
    setContextItems([])
  }
  const commandQuery = draft.trimStart().replace(/^\//, '').toLocaleLowerCase()
  const visibleCommands = useMemo(() => commands.filter(command => `${command.name} ${command.description}`.toLocaleLowerCase().includes(commandQuery)), [commandQuery, commands])
  const mentionQuery = (draft.match(/(?:^|\s)@([^\s]*)$/)?.[1] ?? '').toLocaleLowerCase()
  const cardContexts = useMemo(() => {
    const seen = new Set<string>()
    return [sourceCard, ...contextCards].filter(card => !seen.has(card.id) && seen.add(card.id)).map(card => {
      const transcript = card.messages.filter(message => message.kind === 'user' || message.kind === 'assistant').map(message => `${message.kind === 'user' ? '用户' : '助手'}：${message.text}`).join('\n\n')
      const complete = `对话卡片：${card.title}\n\n${transcript || card.summary}`
      const content = complete.slice(0, MAX_CONVERSATION_CONTEXT_LENGTH)
      return { id: `card:${card.id}`, kind: 'card' as const, label: card.title, detail: `${card.sessionId === sourceCard.sessionId ? '当前会话' : '对话历史'} · ${card.messages.length} 条消息${content.length < complete.length ? ' · 已截取' : ''}`, content }
    }).filter(item => `${item.label} ${item.detail}`.toLocaleLowerCase().includes(mentionQuery))
  }, [contextCards, mentionQuery, sourceCard])
  const visibleSkills = useMemo(() => skills.filter(skill => skill.userInvocable !== false && `${skill.name} ${skill.description ?? ''}`.toLocaleLowerCase().includes(mentionQuery)), [mentionQuery, skills])
  const selectedCardIds = new Set(contextItems.filter(item => item.kind === 'card').map(item => item.id))
  const allCardsSelected = cardContexts.length > 0 && cardContexts.every(item => selectedCardIds.has(item.id))
  const stripMention = (value: string) => value.replace(/(?:^|\s)@[^\s]*$/, match => match.startsWith(' ') ? ' ' : '')
  const toggleCard = (item: ContextItem) => setContextItems(value => value.some(existing => existing.id === item.id) ? value.filter(existing => existing.id !== item.id) : [...value, item])
  const toggleAllCards = () => setContextItems(value => {
    const files = value.filter(item => item.kind !== 'card')
    return allCardsSelected ? files : [...files, ...cardContexts]
  })
  const finishContextSelection = () => { setDraft(stripMention); setMenu(null) }
  const chooseSkill = (skill: SkillDescriptor) => {
    setDraft(value => {
      const replacement = `/${skill.name} `
      return value.match(/(?:^|\s)@[^\s]*$/) ? value.replace(/(?:^|\s)@[^\s]*$/, match => `${match.startsWith(' ') ? ' ' : ''}${replacement}`) : `${value.trimEnd()} ${replacement}`.trimStart()
    })
    setMenu(null)
  }
  const commandVisible = menu === 'command' || (menu === null && draft.trimStart().startsWith('/'))
  const mentionVisible = menu === 'mention' || (menu === null && draft.match(/(?:^|\s)@[^\s]*$/) !== null)
  const modelMenuVisible = menu === 'model' || menu === 'models' || menu === 'effort'
  return <>
  <form ref={composer} className="atlas-native-composer mt-4" data-composer-card onSubmit={event => { event.preventDefault(); void submit() }}>
    {modelMenuVisible && <div ref={popup} className="atlas-native-menu atlas-model-menu" role="menu" aria-label="模型与推理等级">
      <div className="atlas-menu-head">{menu !== 'model' && <button type="button" onClick={() => setMenu('model')} aria-label="返回模型设置"><ChevronLeft className="size-4" /></button>}<strong>{menu === 'model' ? '模型设置' : menu === 'models' ? '选择模型' : '推理等级'}</strong>{modelBusy && <LoaderCircle className="size-4 animate-spin" />}</div>
      {modelError && <div className="atlas-menu-error"><span>{modelError}</span><button type="button" onClick={() => void loadModels()}>重试</button></div>}
      {menu === 'model' && <div className="atlas-menu-overview"><button type="button" className="atlas-menu-cell" onClick={() => setMenu('models')}><span>模型</span><em>{modelLabel}</em><ChevronRight className="size-3.5" /></button><button type="button" className="atlas-menu-cell" disabled={!currentChoice?.model.reasoning?.efforts.length} onClick={() => setMenu('effort')}><span>推理等级</span><em>{effortLabel ?? '默认'}</em><ChevronRight className="size-3.5" /></button></div>}
      {menu === 'models' && <div className="atlas-model-groups">{directory?.groups.map(group => <section key={group.id}><h4>{group.name}</h4>{group.models.map(model => { const selected = group.id === directory.current?.provider && model.id === directory.current.model; return <button type="button" role="menuitemradio" aria-checked={selected} disabled={modelBusy} key={`${group.id}:${model.id}`} onClick={() => { if (selected) { setMenu(null); return } void selectModel({ provider: group.id, model: model.id, ...(model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}) }) }}><span><strong>{model.name}</strong>{model.description && <small>{model.description}</small>}</span>{selected && <Check className="size-4" />}</button>})}</section>)}</div>}
      {menu === 'effort' && <div className="atlas-model-groups">{currentChoice?.model.reasoning?.efforts.map(effort => { const selected = effort.id === currentEffort; return <button type="button" role="menuitemradio" aria-checked={selected} disabled={modelBusy} key={effort.id} onClick={() => void selectModel({ provider: currentChoice.group.id, model: currentChoice.model.id, reasoningEffort: effort.id })}><span><strong>{effort.name}</strong>{effort.description && <small>{effort.description}</small>}</span>{selected && <Check className="size-4" />}</button>})}</div>}
    </div>}
    {menu === 'permission' && <div ref={popup} className="atlas-native-menu atlas-permission-menu" role="menu" aria-label="权限范围">{permissionError && <div className="atlas-menu-error"><span>{permissionError}</span><button type="button" onClick={() => void loadPermissions()}>重试</button></div>}{permissions?.options.map(option => { const selected = option.value === permissions.currentValue; return <button type="button" role="menuitemradio" aria-checked={selected} disabled={permissionBusy} key={option.value} onClick={() => { if (selected) { setMenu(null); return } if (option.value === 'danger-full-access') { setPermissionConfirm(option); setPermissionAcknowledged(false); setMenu(null) } else void selectPermission(option) }}><Shield className="size-4" /><span><strong>{permissionName(option.value, option.name)}</strong>{option.description && <small>{option.description}</small>}</span>{selected && <Check className="size-4" />}</button>})}{permissionBusy && <div className="atlas-menu-loading"><LoaderCircle className="size-4 animate-spin" />正在同步 DSH 权限</div>}</div>}
    {commandVisible && <div ref={popup} className="atlas-native-menu atlas-command-help" role="menu" aria-label="DSH 命令目录">{commandError && <div className="atlas-menu-error"><span>{commandError}</span><button type="button" onClick={() => void loadCommands()}>重试</button></div>}{visibleCommands.map(command => <button type="button" role="menuitem" key={command.name} onClick={() => { if (command.name === 'model') { setDraft('/model'); setMenu('model') } else { setDraft(`/${command.name}${command.input ? ' ' : ''}`); setMenu(null) } }}><span><code>/{command.name}</code>{command.description}</span><small>{command.input?.hint ?? '执行命令'}</small></button>)}{!commandError && visibleCommands.length === 0 && <p className="atlas-menu-empty">当前 DSH Profile 没有匹配的命令</p>}</div>}
    {mentionVisible && <div ref={popup} className="atlas-native-menu atlas-mention-menu" role="menu" aria-label="添加上下文">{contextError && <div className="atlas-menu-error"><span>{contextError}</span><button type="button" onClick={() => setContextError('')}>关闭</button></div>}<button type="button" role="menuitem" onClick={() => { setDraft(stripMention); setMenu(null); fileInput.current?.click() }}><Paperclip className="size-4" /><span><strong>选择本地文件</strong><small>PDF、Word、Excel、代码与配置文件</small></span><ChevronRight className="size-3.5" /></button><button type="button" role="menuitem" onClick={() => setMenu('history')}><MessageSquareText className="size-4" /><span><strong>对话历史</strong><small>全部或多选单独的对话卡片</small></span><ChevronRight className="size-3.5" /></button><button type="button" role="menuitem" onClick={() => setMenu('skills')}><Command className="size-4" /><span><strong>Skills</strong><small>{visibleSkills.length} 个可调用技能</small></span><ChevronRight className="size-3.5" /></button></div>}
    {menu === 'history' && <div ref={popup} className="atlas-native-menu atlas-context-picker" role="menu" aria-label="选择对话历史"><div className="atlas-menu-head"><button type="button" onClick={() => setMenu('mention')} aria-label="返回上下文分类"><ChevronLeft className="size-4" /></button><strong>对话历史</strong><button type="button" className="atlas-menu-done" onClick={finishContextSelection}>完成</button></div><div className="atlas-context-list"><button type="button" role="menuitemcheckbox" aria-checked={allCardsSelected} onClick={toggleAllCards}><span className="atlas-context-check">{allCardsSelected && <Check className="size-3" />}</span><span><strong>全部对话</strong><small>选择画布中的 {cardContexts.length} 张对话卡片</small></span></button>{cardContexts.map(item => <button type="button" role="menuitemcheckbox" aria-checked={selectedCardIds.has(item.id)} key={item.id} onClick={() => toggleCard(item)}><span className="atlas-context-check">{selectedCardIds.has(item.id) && <Check className="size-3" />}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span></button>)}</div></div>}
    {menu === 'skills' && <div ref={popup} className="atlas-native-menu atlas-context-picker" role="menu" aria-label="选择 Skills"><div className="atlas-menu-head"><button type="button" onClick={() => setMenu('mention')} aria-label="返回上下文分类"><ChevronLeft className="size-4" /></button><strong>Skills</strong></div><div className="atlas-context-list">{visibleSkills.map(skill => <button type="button" role="menuitem" key={skill.name} onClick={() => chooseSkill(skill)}><Command className="size-4" /><span><strong>/{skill.name}</strong><small>{skill.description ?? 'DSH Skill'}</small></span><ChevronRight className="size-3.5" /></button>)}{visibleSkills.length === 0 && <p className="atlas-menu-empty">当前会话没有可调用的 Skill</p>}</div></div>}
    {notice && <div className="atlas-composer-notice"><span>{notice}</span><button type="button" aria-label="关闭状态" onClick={() => setNotice('')}><X className="size-3" /></button></div>}
    {contextItems.length > 0 && <div className="atlas-attachment-rail" aria-label="已添加的上下文">{contextItems.map(item => <span key={item.id} title={item.detail}>{item.kind === 'card' ? <MessageSquareText className="size-3.5" /> : <FileText className="size-3.5" />}<b>{item.label}</b>{item.attachment && <small>{attachmentLabel(item.attachment.kind)}</small>}<button type="button" aria-label={`移除 ${item.label}`} onClick={() => setContextItems(value => value.filter(existing => existing.id !== item.id))}><X className="size-3" /></button></span>)}</div>}
    <textarea className="atlas-native-input" value={draft} onChange={event => { const value = event.target.value; setDraft(value); if (value.match(/(?:^|\s)@[^\s]*$/)) setMenu('mention'); else if (value.trimStart().startsWith('/')) setMenu('command'); else setMenu(null) }} onKeyDown={event => { if (event.key === 'Escape') { setMenu(null); return } if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} placeholder="一起探索未至之境，输入/命令或@上下文" maxLength={16000} disabled={busy} />
    <div className="atlas-native-footer"><div className="atlas-native-left"><button type="button" data-composer-trigger className="atlas-plus-button" onClick={() => setMenu(menu === 'command' ? null : 'command')} aria-label="打开 DSH 命令"><Plus className="size-4" /></button><button type="button" data-composer-trigger className="atlas-permission-trigger" onClick={() => setMenu(menu === 'permission' ? null : 'permission')} aria-label={`权限范围：${permissionLabel}`} aria-haspopup="menu" aria-expanded={menu === 'permission'}><Shield className="size-4" /><span>{permissionLabel}</span><ChevronDown className="size-3.5" /></button><button type="button" data-composer-trigger className="atlas-utility-button" onClick={() => { setMenu(null); fileInput.current?.click() }} title="选择本地文件" aria-label="选择本地文件"><Paperclip className="size-4" /></button><button type="button" data-composer-trigger className="atlas-utility-button" onClick={() => setMenu(menu === 'mention' ? null : 'mention')} title="添加上下文" aria-label="添加上下文"><AtSign className="size-4" /></button></div><div className="atlas-native-right"><div className="atlas-model-trigger-wrap"><button type="button" data-composer-trigger className="atlas-model-trigger" onClick={() => setMenu(modelMenuVisible ? null : 'model')} aria-label={`模型：${modelLabel}${effortLabel ? `，推理等级 ${effortLabel}` : ''}`} aria-haspopup="menu" aria-expanded={modelMenuVisible}><Bot className="size-4" /><span>{modelLabel}</span>{effortLabel && <em>{effortLabel}</em>}<ChevronDown className="size-3.5" /></button></div><button className="atlas-send-button" type="submit" disabled={busy || (!draft.trim() && contextItems.length === 0)} aria-label="发送消息">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}</button></div></div>
    <input ref={fileInput} className="sr-only" type="file" multiple accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.rtf,.json,.jsonc,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.java,.go,.rs,.rb,.php,.c,.h,.cpp,.cc,.cxx,.hpp,.cs,.swift,.kt,.kts,.scala,.sh,.bash,.zsh,.ps1,.sql,.css,.scss,.less,.html,.htm,.xml,.svg,.vue,.svelte,.astro,.yaml,.yml,.toml,.ini,.cfg,.conf,.properties,.env,.graphql,.gql,.log,.lock,Dockerfile,Makefile" onChange={event => void addFiles(event.target.files)} />
  </form>
  <Dialog open={permissionConfirm !== null} onOpenChange={value => { if (!value && !permissionBusy) setPermissionConfirm(null) }}><DialogContent className="atlas-permission-dialog"><div className="pr-7"><div className="atlas-permission-icon"><Shield className="size-5" /></div><DialogTitle className="mt-3 text-xl text-[var(--fg-2)]">启用全部权限</DialogTitle><p className="atlas-delete-intro">DSH 将允许此会话访问工作区之外的文件，并按当前审批策略执行命令。该设置会真实应用到当前会话。</p><label className="atlas-permission-confirm"><input type="checkbox" checked={permissionAcknowledged} onChange={event => setPermissionAcknowledged(event.target.checked)} /><span>我了解此权限范围，并确认继续</span></label>{permissionError && <p className="atlas-permission-dialog-error">{permissionError}</p>}<div className="atlas-delete-actions"><Button variant="outline" disabled={permissionBusy} onClick={() => setPermissionConfirm(null)}>取消</Button><Button disabled={permissionBusy || !permissionAcknowledged} onClick={() => { if (permissionConfirm) void selectPermission(permissionConfirm).then(changed => { if (changed) setPermissionConfirm(null) }) }}>{permissionBusy ? <LoaderCircle className="size-4 animate-spin" /> : <Shield className="size-4" />}确认全部权限</Button></div></div></DialogContent></Dialog>
  </>
}

function DraftCardView({ compose, point, draft, setDraft, busy, fallbackModel, rpc, contextCards, onCancel, onSubmit, onCommand }: { compose: Compose; point: Point; draft: string; setDraft: (value: string | ((previous: string) => string)) => void; busy: boolean; fallbackModel: string; rpc: (type: string, body?: object) => Promise<unknown>; contextCards: Card[]; onCancel: () => void; onSubmit: (text: string) => Promise<void>; onCommand: (line: string) => Promise<unknown> }) {
  const isNew = compose.kind === 'new'
  const sourceCard = isNew ? contextCards[0] : compose.card
  return <article data-card data-compose-draft className="atlas-card atlas-draft-card" style={{ left: point.x, top: point.y, width: DEFAULT_CARD_SIZE.width, minHeight: DEFAULT_CARD_SIZE.height }} aria-label={isNew ? '新对话草稿' : compose.kind === 'branch' ? '新分支草稿' : '新追问草稿'}>
    <header><div className="flex items-center gap-2"><span className="atlas-card-dot" /><Badge>{isNew ? '新对话' : compose.kind === 'branch' ? '新的分支' : '新的追问'}</Badge></div><button type="button" className="atlas-draft-cancel" onClick={onCancel} disabled={busy} aria-label="取消草稿"><X className="size-4" /></button></header>
    {isNew ? <form className="atlas-inline-new-form" onSubmit={event => { event.preventDefault(); void onSubmit(draft) }}><textarea autoFocus value={draft} onChange={event => setDraft(event.target.value)} placeholder="输入第一条消息" maxLength={4000} disabled={busy} /><div><span>将在当前 DSH 工作区创建会话</span><Button size="sm" type="submit" disabled={busy || !draft.trim()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}开始</Button></div></form> : sourceCard && <NativeComposer sessionId={sourceCard.sessionId} draft={draft} setDraft={setDraft} busy={busy} fallbackModel={fallbackModel} rpc={rpc} contextCards={contextCards} sourceCard={sourceCard} onSend={onSubmit} onCommand={onCommand} />}
  </article>
}

function CardView({ card, point, active, deleting, matched, live, childCount, collapsed, canContinue, menuOpen, onMenuOpenChange, draft, setDraft, busy, fallbackModel, rpc, contextCards, onOpen, onDrag, onResize, onContinue, onBranch, onSend, onCommand, onOpenDsh, onArchive, onDelete, onMarker, onToggle }: { card: Card; point: Point; active: boolean; deleting: boolean; matched: boolean; live?: string; childCount: number; collapsed: boolean; canContinue: boolean; menuOpen: boolean; onMenuOpenChange: (open: boolean) => void; draft: string; setDraft: (value: string | ((previous: string) => string)) => void; busy: boolean; fallbackModel: string; rpc: (type: string, body?: object) => Promise<unknown>; contextCards: Card[]; onOpen: () => void; onDrag: (event: React.PointerEvent<HTMLElement>) => void; onResize: (event: React.PointerEvent<HTMLElement>, edge: ResizeEdge) => void; onContinue: () => void; onBranch: () => void; onSend: (text: string) => Promise<void>; onCommand: (line: string) => Promise<unknown>; onOpenDsh: () => void; onArchive: () => void; onDelete: () => void; onMarker: (marker: Marker) => void; onToggle: () => void }) {
  const choose = (marker: Marker) => onMarker(marker)
  const canBranch = Number.isInteger(card.branchSeq)
  const isFreshConversation = card.sourceSeq === null && card.messages.length === 0
  const fileCount = cardAttachmentCount(card)
  const size = cardSize(card) as CardSize
  const title = previewText(card.title)
  const summary = previewText(live?.trim() || card.summary)
  const edgeAt = (event: React.PointerEvent<HTMLElement>): ResizeEdge | null => {
    if ((event.target as HTMLElement).closest('button, a, input, textarea, select, [data-no-drag]')) return null
    const rect = event.currentTarget.getBoundingClientRect(); const threshold = 11
    const edge = { left: event.clientX - rect.left <= threshold, right: rect.right - event.clientX <= threshold, top: event.clientY - rect.top <= threshold, bottom: rect.bottom - event.clientY <= threshold }
    return edge.left || edge.right || edge.top || edge.bottom ? edge : null
  }
  const cursorFor = (edge: ResizeEdge | null) => edge === null ? 'grab' : (edge.left || edge.right) && (edge.top || edge.bottom) ? 'nwse-resize' : edge.left || edge.right ? 'ew-resize' : 'ns-resize'
  return <article data-card data-card-id={card.id} className={`atlas-card ${isFreshConversation ? 'is-fresh-conversation' : ''} ${active ? 'is-active' : ''} ${card.parentSessionId ? 'is-branch' : ''} ${deleting ? 'is-delete-preview' : ''} ${matched ? 'is-search-match' : ''}`} style={{ left: point.x, top: point.y, width: size.width, height: size.height }} onPointerDown={event => { const edge = edgeAt(event); if (edge) onResize(event, edge); else onDrag(event) }} onPointerMove={event => { event.currentTarget.style.cursor = cursorFor(edgeAt(event)) }} onPointerLeave={event => { event.currentTarget.style.cursor = 'grab' }} onClick={event => { if (!(event.target as HTMLElement).closest('button, a, input, textarea, select, [data-no-drag]')) onOpen() }} title="拖动卡片移动；拖动边框可调整大小">
    {canContinue && <button className="atlas-card-connector atlas-card-continue" onClick={event => { event.stopPropagation(); onContinue() }} aria-label="添加追问" title="添加追问"><Plus className="size-3.5" /></button>}
    {!canContinue && childCount > 0 && <button className="atlas-card-connector atlas-card-fold" onClick={event => { event.stopPropagation(); onToggle() }} aria-label={collapsed ? `展开 ${childCount} 个后续节点` : `折叠 ${childCount} 个后续节点`} title={collapsed ? '展开后续对话' : '折叠后续对话'}>{collapsed ? <CirclePlus className="size-3.5" /> : <CircleMinus className="size-3.5" />}</button>}
    {canBranch && <button className="atlas-card-connector atlas-card-branch" onClick={event => { event.stopPropagation(); onBranch() }} aria-label="从此回答创建分支" title="从此回答创建分支"><GitBranch className="size-3.5" /></button>}
    <header><div className="flex items-center gap-2"><span className="atlas-card-dot" /><Badge>{isFreshConversation ? '新对话' : card.parentSessionId ? '另一种思路' : '对话'}</Badge>{card.marker.important && <span className="atlas-marker-chip">重点</span>}{card.marker.kind !== 'none' && <span className={`atlas-marker-chip is-${card.marker.kind}`}>{markerLabel(card.marker.kind)}</span>}</div><div className="atlas-card-menu-wrap" data-no-drag><button className="atlas-card-menu-trigger" onClick={event => { event.stopPropagation(); onMenuOpenChange(!menuOpen) }} aria-label={`打开 ${card.title} 的卡片菜单`} aria-expanded={menuOpen} title="卡片状态"><MoreHorizontal className="size-4" /></button>{menuOpen && <div className="atlas-card-menu atlas-card-status-menu" role="menu"><div className="atlas-card-menu-label">卡片状态</div><button role="menuitemcheckbox" aria-checked={card.marker.important} onClick={event => { event.stopPropagation(); choose({ ...card.marker, important: !card.marker.important }) }}><Check className={`size-3.5 ${card.marker.important ? '' : 'invisible'}`} />重点</button>{(['conclusion', 'verify'] as MarkerKind[]).map(kind => <button key={kind} role="menuitemcheckbox" aria-checked={card.marker.kind === kind} onClick={event => { event.stopPropagation(); choose({ ...card.marker, kind: card.marker.kind === kind ? 'none' : kind }) }}><Check className={`size-3.5 ${card.marker.kind === kind ? '' : 'invisible'}`} />{markerLabel(kind)}</button>)}<button role="menuitem" className="is-danger" onClick={event => { event.stopPropagation(); onMenuOpenChange(false); onDelete() }}><Trash2 className="size-3.5" />删除卡片</button></div>}</div></header>{isFreshConversation ? <div className="atlas-fresh-conversation" data-no-drag><h3>开始新对话</h3><p>输入消息以开始当前会话</p><NativeComposer sessionId={card.sessionId} draft={draft} setDraft={setDraft} busy={busy} fallbackModel={fallbackModel} rpc={rpc} contextCards={contextCards} sourceCard={card} onSend={onSend} onCommand={onCommand} /></div> : <><h3 title={card.title}>{title}</h3><div className="atlas-card-summary" title={live?.trim() || card.summary}>{summary}</div><footer className="atlas-card-footer"><span>{fileCount > 0 && <><FileText className="size-3.5" />{fileCount}</>}{card.tools > 0 && <>{fileCount > 0 && ' · '}<Wrench className="size-3.5" />{card.tools}</>}{card.todos > 0 && ` · 待办 ${card.todos}`}</span><div className="atlas-card-actions"><button onClick={event => { event.stopPropagation(); onOpen() }}>查看详情</button><button onClick={event => { event.stopPropagation(); onOpenDsh() }}>返回 DSH</button><button onClick={event => { event.stopPropagation(); onArchive() }}>存档</button></div></footer><CardMetricsBar metrics={card.metrics} /></>}
  </article>
}
function CardMetricsBar({ metrics }: { metrics?: CardMetrics | null }) {
  if (!metrics) return null
  const items = [
    finiteMetric(metrics.llmMs) && ['LLM', formatMetricDuration(metrics.llmMs!)],
    finiteMetric(metrics.ttftAverageMs) && ['首 token', formatMetricDuration(metrics.ttftAverageMs!)],
    finiteMetric(metrics.tokensPerSecond) && ['速率', `${formatMetricRate(metrics.tokensPerSecond!)} tok/s`],
    finiteMetric(metrics.cacheHitPercent) && ['缓存', `${Math.round(metrics.cacheHitPercent!)}%`],
    finiteMetric(metrics.inputTokens) && finiteMetric(metrics.outputTokens) && ['Token', `${formatMetricTokens(metrics.inputTokens!)} → ${formatMetricTokens(metrics.outputTokens!)}`],
  ].filter(Boolean) as string[][]
  if (items.length === 0) return null
  return <div className="atlas-card-metrics" aria-label="本卡片模型性能汇总" title="本卡片内所有 LLM 调用的聚合结果">{items.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>
}
function SessionNav({ node, activeSession, canvasRoot, expanded, onToggle, onSelect, selectionMode, selectedSessionIds, onSelectForDelete, depth = 0 }: { node: SessionNode; activeSession: string; canvasRoot: string; expanded: Set<string>; onToggle: (id: string) => void; onSelect: (card: Card) => void; selectionMode: boolean; selectedSessionIds: Set<string>; onSelectForDelete: (id: string) => void; depth?: number }) {
  const isExpanded = expanded.has(node.id)
  return <div className={`atlas-session-node ${depth > 0 ? 'is-branch' : ''}`}>
    <div className={`atlas-session-row ${node.children.length === 0 ? 'is-leaf' : ''} ${selectionMode ? 'is-selecting' : ''}`}>
      {selectionMode && <input className="atlas-session-checkbox" type="checkbox" checked={selectedSessionIds.has(node.id)} onChange={() => onSelectForDelete(node.id)} onClick={event => event.stopPropagation()} aria-label={`选择 ${node.card.title}`} />}
      {node.children.length > 0 && <button className="atlas-session-toggle" onClick={() => onToggle(node.id)} aria-label={isExpanded ? `收起 ${node.card.title} 的分支` : `展开 ${node.card.title} 的分支`} aria-expanded={isExpanded}>{isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button>}
      <button className={`atlas-session-title-button ${node.id === activeSession ? 'is-active' : ''} ${node.id === canvasRoot ? 'is-canvas-root' : ''}`} onClick={() => selectionMode ? onSelectForDelete(node.id) : onSelect(node.card)} title={node.card.title}>{depth > 0 && <span className="atlas-branch-badge">分支</span>}<span className="atlas-session-title truncate">{node.card.title}</span></button>
    </div>
    {isExpanded && node.children.length > 0 && <div className="atlas-session-children">{node.children.map(child => <SessionNav key={child.id} node={child} activeSession={activeSession} canvasRoot={canvasRoot} expanded={expanded} onToggle={onToggle} onSelect={onSelect} selectionMode={selectionMode} selectedSessionIds={selectedSessionIds} onSelectForDelete={onSelectForDelete} depth={depth + 1} />)}</div>}
  </div>
}
function MarkdownText({ text, compact = false }: { text: string; compact?: boolean }) { return <div className={`atlas-markdown ${compact ? 'is-compact' : ''}`}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: props => <a {...props} target="_blank" rel="noreferrer" /> }}>{text}</ReactMarkdown></div> }
function MessageView({ message, dark }: { message: Message; dark: boolean }) {
  const artifacts = message.process.filter(isArtifact)
  const tools = message.process.filter(item => !isArtifact(item))
  const attachmentMessage = splitAttachmentMessage(message.text)
  return <div className={`atlas-detail-message is-${message.kind}`}><span>{message.kind === 'user' ? '你的消息' : message.kind === 'assistant' ? 'DSH' : message.kind === 'todo' ? '待办' : '系统'}</span>{attachmentMessage.body && <MarkdownText text={attachmentMessage.body} />}{attachmentMessage.attachments.length > 0 && <AttachmentList attachments={attachmentMessage.attachments} />}{artifacts.map(item => <ArtifactView key={item.callId} item={item} dark={dark} />)}{tools.length > 0 && <details className="atlas-process-group"><summary>{tools.length} 次工具活动</summary><div>{tools.map(item => <details key={item.callId} className="atlas-process"><summary>{item.name} · {item.error ? '失败' : item.result === null ? '进行中' : '已完成'}</summary>{item.arguments && <pre>{item.arguments}</pre>}{item.result && <pre>{item.result}</pre>}{item.error && <pre>{item.error}</pre>}</details>)}</div></details>}</div>
}
function AttachmentList({ attachments }: { attachments: FileAttachment[] }) {
  return <div className="atlas-message-attachments" aria-label="本条消息附带的文件">{attachments.map((attachment, index) => <div key={`${attachment.name}-${index}`}><FileText className="size-4" /><span><strong>{attachment.name}</strong><small>{attachmentLabel(attachment.kind)} · {attachment.size > 0 ? formatBytes(attachment.size) : '已提取正文'}{attachment.truncated ? ' · 正文已截取' : ''}</small></span></div>)}</div>
}
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
function planDeletion(cards: Card[], cardId: string) {
  const target = cards.find(card => card.id === cardId)!
  const children = new Map<string, Card[]>(); for (const card of cards) if (card.parentCardId) children.set(card.parentCardId, [...(children.get(card.parentCardId) ?? []), card])
  const descendants: Card[] = []; const queue = target ? [target] : []; const seen = new Set<string>()
  while (queue.length) { const card = queue.shift()!; if (seen.has(card.id)) continue; seen.add(card.id); descendants.push(card); queue.push(...(children.get(card.id) ?? [])) }
  const directChildren = target ? children.get(target.id) ?? [] : []
  return { target, directChildren, mainSuccessor: directChildren.find(card => card.sessionId === target.sessionId), descendants, branchCount: new Set(descendants.filter(card => card.parentSessionId !== null).map(card => card.sessionId)).size }
}
function buildSessionTree(cards: Card[]) {
  const first = new Map<string, Card>(); for (const card of cards) if (!first.has(card.sessionId)) first.set(card.sessionId, card)
  const nodes = new Map<string, SessionNode>(); for (const [id, card] of first) nodes.set(id, { id, card, parentId: sessionParent(cards, id), children: [] })
  const roots: SessionNode[] = []
  for (const node of nodes.values()) { const parent = node.parentId && nodes.get(node.parentId); if (parent && parent.id !== node.id) parent.children.push(node); else roots.push(node) }
  return roots
}
function filterSessionTree(nodes: SessionNode[], matchingSessionIds: Set<string>): SessionNode[] {
  return nodes.flatMap(node => {
    const children = filterSessionTree(node.children, matchingSessionIds)
    return matchingSessionIds.has(node.id) || children.length > 0 ? [{ ...node, children }] : []
  })
}
function countSessionTree(nodes: SessionNode[]): number { return nodes.reduce((total, node) => total + 1 + countSessionTree(node.children), 0) }
function flattenSessionNodes(nodes: SessionNode[]): SessionNode[] { return nodes.flatMap(node => [node, ...flattenSessionNodes(node.children)]) }
function hasSelectedSessionAncestor(node: SessionNode, selected: Set<string>, nodes: SessionNode[]) {
  const parentById = new Map(nodes.map(item => [item.id, item.parentId]))
  let parentId = node.parentId
  while (parentId) { if (selected.has(parentId)) return true; parentId = parentById.get(parentId) ?? null }
  return false
}
function previewText(value: string) {
  const text = String(value ?? '').replace(/```[\s\S]*?```/g, ' 代码片段 ').replace(/!?(?:\[[^\]]*\]\([^)]*\))/g, ' ').replace(/[>#*_`|]/g, ' ').replace(/\s+/g, ' ').trim()
  return text || '暂无可用摘要'
}
function conversationBrief(cards: Card[]) {
  const summaries = [...cards].sort((a, b) => (b.sourceSeq ?? -1) - (a.sourceSeq ?? -1)).map(card => previewText(card.summary)).filter(text => text !== '暂无可用摘要')
  return summaries[0] ?? previewText(cards[0]?.title ?? '当前会话暂无可用摘要')
}
function conversationRevision(cards: Card[]) {
  return `v1-${stableHash(cards.map(card => [card.id, card.sourceSeq, card.title, card.summary, card.marker.important, card.marker.kind, ...card.tasks.map(task => `${task.content}:${task.status}`)].join('\u001f')).join('\u001e'))}`
}
function conversationTranscript(cards: Card[]) {
  const lines = [...cards].sort((a, b) => (a.sourceSeq ?? -1) - (b.sourceSeq ?? -1)).slice(-18).flatMap((card, index) => [
    `第 ${index + 1} 轮 · 用户：${previewText(card.title).slice(0, 420)}`,
    `DSH：${previewText(card.summary).slice(0, 720)}`,
    card.tasks.length > 0 ? `待办：${card.tasks.slice(0, 5).map(task => `${task.content}（${task.status}）`).join('；')}` : '',
  ].filter(Boolean))
  return lines.join('\n').slice(0, 15_000)
}
function stableHash(value: string) {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16_777_619) }
  return (hash >>> 0).toString(36)
}
function sessionParent(cards: Card[], sessionId: string) { return cards.find(card => card.sessionId === sessionId && card.parentSessionId)?.parentSessionId ?? null }
function rootSessionId(cards: Card[], sessionId: string) { const seen = new Set<string>(); let current = sessionId; while (current && !seen.has(current)) { seen.add(current); const parent = sessionParent(cards, current); if (!parent || !cards.some(card => card.sessionId === parent)) return current; current = parent } return sessionId }
function conversationCards(cards: Card[], rootId: string) {
  if (!rootId) return []
  const included = new Set([rootId]); let changed = true
  while (changed) { changed = false; for (const card of cards) if (card.parentSessionId && included.has(card.parentSessionId) && !included.has(card.sessionId)) { included.add(card.sessionId); changed = true } }
  return cards.filter(card => included.has(card.sessionId))
}
function matchesCard(card: Card, query: string, filter: Filter) {
  if (filter === 'tools' && card.tools === 0) return false
  if (filter === 'todos' && card.todos === 0) return false
  if (filter === 'attachments' && !cardHasAttachments(card)) return false
  if (filter === 'marked' && !card.marker.important) return false
  if (filter !== 'all' && filter !== 'tools' && filter !== 'todos' && filter !== 'attachments' && filter !== 'marked' && card.marker.kind !== filter) return false
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return true
  const haystack = [card.title, card.summary, ...card.tasks.map(task => `${task.content} ${task.status}`), ...card.messages.flatMap(message => [message.text, ...message.process.flatMap(item => [item.name, item.arguments ?? '', item.result ?? '', item.error ?? ''])])].join('\n').toLocaleLowerCase()
  return haystack.includes(needle)
}
function cardAttachmentCount(card: Card) { return card.messages.reduce((total, message) => total + splitAttachmentMessage(message.text).attachments.length, 0) }
function cardHasAttachments(card: Card) { return cardAttachmentCount(card) > 0 }
function markerLabel(kind: MarkerKind) {
  return ({ conclusion: '关键结论', verify: '待验证', ruleout: '已排除', decision: '已决定', pivot: '已转向', open: '开放问题', none: '' } as Record<MarkerKind, string>)[kind]
}
function connectorPath(from: Point, to: Point, branch: boolean, fromSize: CardSize, toSize: CardSize) {
  const fromX = from.x + fromSize.width; const fromY = from.y + fromSize.height / 2; const toX = to.x; const toY = to.y + toSize.height / 2
  const distance = Math.abs(toX - fromX); const bend = Math.max(24, Math.min(180, distance * .42)); const arch = branch ? 54 : 30
  const xDirection = toX >= fromX ? 1 : -1; const yDirection = toY >= fromY ? -1 : 1
  return `M ${fromX} ${fromY} C ${fromX + xDirection * bend} ${fromY + yDirection * arch}, ${toX - xDirection * bend} ${toY - yDirection * arch}, ${toX} ${toY}`
}
async function savePosition(id: string, position: Point) { await fetch(`/atlas/api/cards/${encodeURIComponent(id)}/position`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position }) }).catch(() => {}) }
async function saveCardSize(id: string, size: CardSize) { await fetch(`/atlas/api/cards/${encodeURIComponent(id)}/size`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size }) }).catch(() => {}) }
function without(record: Record<string, string>, id: string) { const next = { ...record }; delete next[id]; return next }
function finite(value: unknown, fallback: number) { return Number.isFinite(Number(value)) ? Number(value) : fallback }
function finiteMetric(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function formatMetricDuration(ms: number) { const seconds = ms / 1000; return `${seconds < 1 ? Math.round(seconds * 100) / 100 : Math.round(seconds * 10) / 10}s` }
function formatMetricRate(value: number) { return String(value >= 10 ? Math.round(value) : Math.round(value * 10) / 10) }
function formatMetricTokens(value: number) { return value < 1000 ? String(Math.round(value)) : value < 1_000_000 ? `${Math.round(value / 100) / 10}K` : `${Math.round(value / 100_000) / 10}M` }
function number3(value: unknown): [number, number, number] { const items = Array.isArray(value) ? value : []; return [finite(items[0], 0), finite(items[1], 0), finite(items[2], 0)] }
function validColor(value: unknown) { return typeof value === 'string' && /^(?:#[0-9a-f]{3,8}|[a-z]+)$/i.test(value.trim()) ? value.trim() : null }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.round(value / 102.4) / 10} KB` : `${Math.round(value / 104857.6) / 10} MB` }
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
const MAX_ATTACHMENT_TOTAL_BYTES = 24 * 1024 * 1024
const MAX_ATTACHMENT_TEXT_LENGTH = 48_000
const MAX_ATTACHMENT_TOTAL_TEXT_LENGTH = 96_000
const MAX_CONVERSATION_CONTEXT_LENGTH = 24_000
type ExtractedAttachment = { name: string; kind: AttachmentKind; text: string; meta: FileAttachment }

async function extractFileAttachment(file: File): Promise<ExtractedAttachment> {
  const kind = attachmentKind(file)
  if (kind === null) {
    const extension = file.name.split('.').at(-1)?.toLowerCase()
    if (extension === 'doc') throw new Error(`暂不支持旧版 Word 文档：${file.name}。请另存为 .docx 后再上传`)
    throw new Error(`暂不支持此文件类型：${file.name}。可上传 PDF、.docx、.xlsx/.xls、CSV、代码或配置文件`)
  }
  let text = ''
  if (kind === 'pdf') {
    const [pdfjs, pdfWorker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs?url'),
    ])
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker.default
    const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) } as any).promise
    const pages: string[] = []
    for (let number = 1; number <= Math.min(document.numPages, 80); number += 1) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      const value = content.items.map(item => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim()
      if (value) pages.push(`第 ${number} 页\n${value}`)
      if (pages.join('\n').length >= MAX_ATTACHMENT_TEXT_LENGTH) break
    }
    text = pages.join('\n\n')
    if (text === '') throw new Error(`无法从 ${file.name} 提取可读文本；扫描版 PDF 请先进行 OCR`)
  } else if (kind === 'word') {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    text = result.value
    if (text.trim() === '') throw new Error(`无法从 ${file.name} 提取可读文本`)
  } else if (kind === 'spreadsheet') {
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
    text = workbook.SheetNames.slice(0, 20).map(name => {
      const sheet = workbook.Sheets[name]
      return `工作表：${name}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim()}`
    }).filter(Boolean).join('\n\n')
    if (text.trim() === '') throw new Error(`Excel 文件 ${file.name} 没有可读取的单元格内容`)
  } else text = await file.text()
  const compact = text.replaceAll('\u0000', '').trim()
  const truncated = compact.length > MAX_ATTACHMENT_TEXT_LENGTH
  const limited = compact.slice(0, MAX_ATTACHMENT_TEXT_LENGTH)
  const meta: FileAttachment = { name: file.name, mime: file.type || attachmentMime(kind), size: file.size, kind, extractedChars: limited.length, truncated }
  return { name: file.name, kind, text: limited, meta }
}

function attachmentKind(file: File): AttachmentKind | null {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
  if (extension === 'pdf') return 'pdf'
  if (extension === 'docx') return 'word'
  if (extension === 'xlsx' || extension === 'xls') return 'spreadsheet'
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'astro', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'graphql', 'gql'].includes(extension) || ['dockerfile', 'makefile', '.env'].includes(file.name.toLowerCase())) return 'code'
  if (['txt', 'md', 'rtf', 'csv', 'log', 'lock'].includes(extension)) return 'text'
  return null
}
function attachmentMime(kind: AttachmentKind) { return ({ pdf: 'application/pdf', word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', code: 'text/plain', text: 'text/plain' } as Record<AttachmentKind, string>)[kind] }
function attachmentLabel(kind: AttachmentKind) { return ({ pdf: 'PDF', word: 'Word', spreadsheet: 'Excel', code: '代码/配置', text: '文本' } as Record<AttachmentKind, string>)[kind] }
function permissionName(value?: string, fallback?: string) {
  if (value === 'read-only') return '只读'
  if (value === 'workspace-write') return '工作区写入'
  if (value === 'danger-full-access') return '全部权限'
  return fallback || value || '权限范围'
}
function escapeAttachmentAttribute(value: string) { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') }
function serializeContextItem(item: ContextItem) {
  if (item.kind === 'file' && item.attachment) {
    const attachment = item.attachment
    const text = item.content.slice(0, MAX_ATTACHMENT_TEXT_LENGTH).replaceAll('</atlas_attachment>', '&lt;/atlas_attachment&gt;')
    return `\n\n<atlas_attachment name="${escapeAttachmentAttribute(attachment.name)}" kind="${attachment.kind}" mime="${escapeAttachmentAttribute(attachment.mime)}" bytes="${attachment.size}" truncated="${attachment.truncated}">\n${text}\n</atlas_attachment>`
  }
  return `\n\n<atlas_context type="${item.kind}" label="${escapeAttachmentAttribute(item.label)}">\n${item.content}\n</atlas_context>`
}
function splitAttachmentMessage(text: string) {
  const attachments: FileAttachment[] = []
  const body = text.replace(/<atlas_attachment\s+([^>]*)>[\s\S]*?<\/atlas_attachment>/gi, (_all, rawAttributes: string) => {
    const read = (name: string) => decodeAttachmentAttribute(new RegExp(`${name}="([^"]*)"`, 'i').exec(rawAttributes)?.[1] ?? '')
    const kind = read('kind')
    const knownKind: AttachmentKind = kind === 'pdf' || kind === 'word' || kind === 'spreadsheet' || kind === 'code' || kind === 'text' ? kind : 'text'
    const name = read('name') || '未命名文件'
    const size = Number(read('bytes'))
    attachments.push({ name, kind: knownKind, mime: read('mime') || attachmentMime(knownKind), size: Number.isFinite(size) ? size : 0, extractedChars: 0, truncated: read('truncated') === 'true' })
    return ''
  }).trim()
  return { body, attachments }
}
function decodeAttachmentAttribute(value: string) { return value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') }
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
