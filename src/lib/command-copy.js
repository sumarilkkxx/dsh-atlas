const BUILTIN_COMMAND_COPY = {
  compact: { description: '压缩当前卡片所属会话的历史上下文，不生成模型回答' },
  export: { description: '导出当前卡片所属会话的日志压缩包' },
  feedback: { description: '提交对当前卡片所属会话的反馈' },
  goal: { description: '查看或管理当前卡片所属会话的长期任务目标' },
  permission: { description: '切换当前卡片所属会话的权限与审批策略' },
  plan: { description: '设置当前卡片所属会话的计划模式；可附带规划任务' },
  status: { description: '查看当前卡片所属会话的模型、运行与权限状态' },
  model: { description: '查看或切换当前卡片所属会话使用的模型' },
}

export function localizeCommandDescriptor(command) {
  const known = BUILTIN_COMMAND_COPY[command.name]
  return known ? { ...command, description: known.description } : command
}

export function localizeCommandResult(line, value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  const name = /^\/([^\s]+)/.exec(typeof line === 'string' ? line.trim() : '')?.[1]
  if (name === 'compact') {
    const compacted = /^Compacted\s+(\d+)\s+history items?\s+\(~([\d,]+)\s+tokens?\)\.?$/i.exec(text)
    if (compacted) return `已压缩 ${compacted[1]} 条历史记录（约 ${compacted[2]} Token）。`
    if (/^No compactable history(?: items?)?(?: yet)?\.?$/i.test(text)) return '当前没有可压缩的历史记录。'
  }
  if (name === 'plan') {
    if (/^Plan mode (?:is )?on\.?/i.test(text)) return '已进入规划模式。使用 /plan off 可退出。'
    if (/^Plan mode (?:is )?off\.?/i.test(text)) return '已退出规划模式。'
  }
  if (name === 'goal' && /^No (?:active )?goal (?:is )?(?:currently )?set\.?/i.test(text)) return '当前会话尚未设置长期任务目标。'
  if (name === 'permission') {
    const current = /^current preset\s+([^\s]+)\s+\(available:\s*([^)]*)\)\.?$/i.exec(text)
    if (current) return `当前权限：${permissionName(current[1])}（可选：${current[2].split(',').map(item => permissionName(item.trim())).join('、')}）。`
    const changed = /^(?:permission )?preset (?:set|changed) to\s+([^\s.]+)\.?$/i.exec(text)
    if (changed) return `权限已切换为：${permissionName(changed[1])}。`
  }
  return text
}

function permissionName(value) {
  return ({ 'read-only': '只读', 'workspace-write': '工作区写入', 'danger-full-access': '全部权限' })[value] ?? value
}

export function commandClaimForInput(value, commands) {
  const match = /^\/([^\s]+)\s([\s\S]*)$/.exec(value.trimStart())
  if (!match) return null
  const command = commands.find(item => item.name === match[1])
  if (!command) return null
  return { command, remainder: match[2], executeImmediately: !command.input && match[2] === '' }
}

export function completedCommandLookup(value, commands) {
  const match = /^\/([^\s]+)$/.exec(value.trim())
  if (!match) return null
  return commands.find(item => item.name === match[1]) ?? null
}
