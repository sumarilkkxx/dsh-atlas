export const DEFAULT_CARD_SIZE = { width: 480, height: 380 }
export const EMPTY_SESSION_CARD_SIZE = { width: 480, height: 390 }
const CARD_GAP_X = 96
const CARD_GAP_Y = 64

export function cardSize(card) {
  const width = Number(card?.size?.width)
  const height = Number(card?.size?.height)
  const isEmptySession = card?.sourceSeq === null && Array.isArray(card?.messages) && card.messages.length === 0
  const fallback = isEmptySession ? EMPTY_SESSION_CARD_SIZE : DEFAULT_CARD_SIZE
  return {
    width: Number.isFinite(width) ? Math.max(360, Math.min(820, Math.round(width))) : fallback.width,
    height: Number.isFinite(height) ? Math.max(250, Math.min(720, Math.round(height))) : fallback.height,
  }
}

export function latestCardIds(cards) {
  const latest = new Map()
  for (const card of cards) latest.set(card.sessionId, card.id)
  return new Set(latest.values())
}

export function graphView(cards, collapsed) {
  const children = new Map()
  const knownIds = new Set(cards.map(card => card.id))
  for (const card of cards) {
    if (!card.parentCardId || !knownIds.has(card.parentCardId)) continue
    children.set(card.parentCardId, [...(children.get(card.parentCardId) ?? []), card.id])
  }
  const hidden = new Set()
  for (const rootId of collapsed) {
    if (!knownIds.has(rootId)) continue
    const visited = new Set([rootId])
    const visit = parentId => {
      for (const childId of children.get(parentId) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        hidden.add(childId)
        visit(childId)
      }
    }
    visit(rootId)
  }
  // A malformed cycle must not make a user's explicitly collapsed card vanish.
  for (const rootId of collapsed) hidden.delete(rootId)
  return {
    cards: cards.filter(card => !hidden.has(card.id)),
    childCounts: new Map(cards.map(card => [card.id, children.get(card.id)?.length ?? 0])),
  }
}

export function layoutConversationGraph(cards, force = false) {
  const sessions = new Map()
  for (const card of cards) if (!sessions.has(card.sessionId)) sessions.set(card.sessionId, card.parentSessionId ?? null)
  const childrenBySession = new Map()
  for (const [sessionId, parentId] of sessions) {
    if (!parentId || !sessions.has(parentId)) continue
    childrenBySession.set(parentId, [...(childrenBySession.get(parentId) ?? []), sessionId])
  }
  const laneBySession = new Map()
  const placeSession = sessionId => {
    if (laneBySession.has(sessionId)) return
    laneBySession.set(sessionId, laneBySession.size)
    for (const childId of childrenBySession.get(sessionId) ?? []) placeSession(childId)
  }
  for (const [sessionId, parentId] of sessions) if (!parentId || !sessions.has(parentId)) placeSession(sessionId)
  for (const sessionId of sessions.keys()) placeSession(sessionId)

  const byId = new Map(cards.map(card => [card.id, card]))
  const positioned = new Map()
  const occupied = []
  const laneHeight = Math.max(DEFAULT_CARD_SIZE.height, ...cards.map(card => cardSize(card).height))
  const overlaps = (a, aSize, b, bSize) => a.x < b.x + bSize.width + CARD_GAP_X / 2
    && a.x + aSize.width + CARD_GAP_X / 2 > b.x
    && a.y < b.y + bSize.height + CARD_GAP_Y / 2
    && a.y + aSize.height + CARD_GAP_Y / 2 > b.y
  const firstAvailable = (position, size) => {
    let candidate = { ...position }
    while (occupied.some(item => overlaps(candidate, size, item.position, item.size))) candidate = { ...candidate, y: candidate.y + laneHeight + CARD_GAP_Y }
    return candidate
  }
  const positionFor = (card, visiting = new Set()) => {
    if (positioned.has(card.id)) return positioned.get(card.id)
    const lane = laneBySession.get(card.sessionId) ?? 0
    if (visiting.has(card.id)) return { x: 70, y: 90 + lane * (laneHeight + CARD_GAP_Y) }
    visiting.add(card.id)
    const parent = card.parentCardId ? byId.get(card.parentCardId) : undefined
    const parentPosition = parent ? positionFor(parent, visiting) : undefined
    visiting.delete(card.id)
    const natural = parentPosition
      ? { x: parentPosition.x + cardSize(parent).width + CARD_GAP_X, y: 90 + lane * (laneHeight + CARD_GAP_Y) }
      : { x: 70, y: 90 + lane * (laneHeight + CARD_GAP_Y) }
    const saved = !force && card.position ? { ...card.position } : undefined
    const position = saved ?? firstAvailable(natural, cardSize(card))
    positioned.set(card.id, position)
    occupied.push({ position, size: cardSize(card) })
    return position
  }
  for (const card of cards) positionFor(card)
  return positioned
}

export function revealConversationPath(cards, sessionId, collapsed) {
  const byId = new Map(cards.map(card => [card.id, card]))
  const next = new Set(collapsed)
  for (const card of cards) {
    if (card.sessionId !== sessionId) continue
    const seen = new Set([card.id])
    let parentId = card.parentCardId
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      next.delete(parentId)
      parentId = byId.get(parentId)?.parentCardId
    }
  }
  return next
}

export function draftCardPosition(cards, positions, sourceCard) {
  if (!sourceCard) return { x: 70, y: 90 }
  const source = positions.get(sourceCard.id)
  if (!source) return null
  const draftSize = DEFAULT_CARD_SIZE
  let position = { x: source.x + cardSize(sourceCard).width + CARD_GAP_X, y: source.y }
  const occupied = cards.map(card => ({ position: positions.get(card.id), size: cardSize(card) })).filter(item => item.position)
  const overlaps = (a, b) => a.x < b.position.x + b.size.width + CARD_GAP_X / 2 && a.x + draftSize.width + CARD_GAP_X / 2 > b.position.x && a.y < b.position.y + b.size.height + CARD_GAP_Y / 2 && a.y + draftSize.height + CARD_GAP_Y / 2 > b.position.y
  while (occupied.some(item => overlaps(position, item))) position = { ...position, y: position.y + draftSize.height + CARD_GAP_Y }
  return position
}

export function draftConnector(from, to, sourceSize = DEFAULT_CARD_SIZE, targetSize = DEFAULT_CARD_SIZE) {
  const fromX = from.x + sourceSize.width
  const fromY = from.y + sourceSize.height / 2
  const toX = to.x
  const toY = to.y + targetSize.height / 2
  const bend = Math.max(24, Math.min(180, Math.abs(toX - fromX) * 0.42))
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`
}
