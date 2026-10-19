import type { WorkEntry } from './presenceModel'
import type { WorkReceipt } from './types'

export const workKinds = ['document', 'data', 'files', 'research', 'desktop', 'followup', 'general'] as const
export type WorkKind = typeof workKinds[number]
export const kindNames: Record<WorkKind, string> = { document: '文档与写作', data: '数据与表格', files: '文件整理', research: '资料与研究', desktop: '软件与图像', followup: '持续跟进', general: '通用工作' }
export type WorkPhase = 'planning' | 'executing' | 'waiting' | 'paused' | 'review' | 'result' | 'followup' | 'stopped'
export const phaseNames: Record<WorkPhase, string> = { planning: '准备与计划', executing: '正在执行', waiting: '等待你处理', paused: '已暂停', review: '需要恢复或核对', result: '结果与交付', followup: '安排与跟进', stopped: '已取消' }
type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const text = (value: unknown, limit = 16000) => typeof value === 'string' ? value.slice(0, limit) : ''
export const fileName = (path: string) => path.split(/[\\/]/).at(-1) || path
export const intentOf = (entry: WorkEntry) => object(entry.work?.cognition?.intent)

// A conversation may retain a richer, read-only receipt projection than the bounded core list.
// Its work/revision/status must agree with the core; it never changes the task's authority.
export function receiptsFor(entry: WorkEntry): WorkReceipt[] {
  const work = entry.work
  if (!work) return entry.message?.taskEvidence?.workId === entry.message?.coreWorkId ? entry.message?.taskEvidence?.receipts || [] : []
  const cache = entry.message?.taskEvidence
  if (!cache || cache.workId !== work.id || cache.revision !== work.cognition?.revision) return work.receipts
  return work.receipts.map(receipt => {
    const detail = cache.receipts.find(item => item.id === receipt.id && item.operation === receipt.operation && item.status === receipt.status)
    const preview = receipt.evidence.observation, full = detail?.evidence.observation
    return detail && detail.evidence.source === receipt.evidence.source && detail.evidence.turn_id === receipt.evidence.turn_id && detail.evidence.revision === receipt.evidence.revision && (typeof preview !== 'string' || (typeof full === 'string' && full.startsWith(preview))) ? detail : receipt
  })
}
export function observations(entry: WorkEntry) {
  return receiptsFor(entry).filter(receipt => ['observed_success', 'verified'].includes(receipt.status)).flatMap(receipt => {
    const raw = receipt.evidence.observation
    let value: unknown = receipt.evidence
    if (typeof raw === 'string') { try { value = JSON.parse(raw) } catch { return [] } }
    const data = object(value)
    return data.ok === false ? [] : [{ receipt, data }]
  })
}
export function resultOf(entry: WorkEntry) {
  // Failed core turns historically put their exception in result. Only real outputs belong on the content surface.
  const workResult = entry.work && !['failed', 'cancelled', 'interrupted'].includes(entry.work.status) ? entry.work.result : ''
  return entry.job?.result || workResult || entry.record?.notes || (!entry.message?.error ? entry.message?.content : '') || ''
}
export function failureOf(entry: WorkEntry) {
  return entry.job?.error || (entry.message?.error ? entry.message.content : '') || (entry.work?.status === 'failed' ? entry.work.result : '') || ''
}
export function workPhase(entry: WorkEntry): WorkPhase {
  // A job owns the scheduling lifecycle. Its bound work supplies evidence, never overrides pause/cancel.
  const status = entry.job?.status || entry.work?.status || entry.record?.status || entry.status
  if (status === 'cancelled') return 'stopped'
  if (status === 'paused') return 'paused'
  if (status === 'running' && entry.job?.currentAction && ['unknown', 'needs_recheck'].includes(entry.job.currentAction.status)) return 'review'
  if (['result_unknown', 'unverified', 'failed', 'interrupted', '未完成', '待恢复'].includes(status) || (!entry.job && entry.message?.error)) return 'review'
  if (['checked_by_desktop', 'done', 'finished'].includes(status)) return 'result'
  if ((status === 'running' && entry.job?.approval) || status === 'waiting' || (status === 'running' && intentOf(entry).ask && !entry.work?.receipts.length)) return 'waiting'
  if (status === 'needs_replan') return 'planning'
  if (entry.record || status === 'scheduled') return 'followup'
  if (status === 'running' || status === 'queued' || entry.ongoing) return (entry.work?.receipts.length || entry.message?.steps?.length || entry.job?.steps || entry.job?.plan?.some(item => item.status === 'doing')) ? 'executing' : 'planning'
  return resultOf(entry) ? 'result' : 'review'
}

export function planFor(entry: WorkEntry) {
  const live = entry.job?.plan?.length && (!entry.work || (entry.job.workId === entry.work.id && (entry.job.workRevision ?? -1) >= (entry.work.cognition?.revision ?? 0)))
  const coreAhead = entry.work?.cognition && entry.job && entry.work.cognition.revision > (entry.job.workRevision ?? -1)
  const plan = coreAhead ? entry.work!.cognition!.plan : live ? entry.job!.plan! : entry.work?.cognition?.plan.length ? entry.work.cognition.plan : entry.job?.plan || entry.message?.plan || []
  return plan.map((item, index) => { const assigned = item as typeof item & import('./types').NodeAssignment; return { id: item.id || String(index + 1), text: item.do || ('text' in item ? String(item.text) : ''), expect: item.expect || '', status: item.verification?.passed === true ? 'verified' : item.runtime_status || item.status || 'pending', dependencies: item.depends_on || [], unmet: item.verification?.unmet || (item.verification?.reason ? [item.verification.reason] : []), role: assigned.role || 'executor', executionMode: assigned.execution?.mode || 'serial', allocation: assigned.execution_state } })
}

export function currentAction(entry: WorkEntry) {
  const phase = workPhase(entry)
  if (phase === 'waiting') return entry.job?.approval?.title || text(intentOf(entry).ask) || '等待补充信息或确认'
  if (phase === 'paused') return '已停止派发新操作；恢复后继续这件任务'
  if (entry.job?.status === 'interrupted') return entry.job.error || '执行已中断，需要核对已有结果后恢复'
  if (phase === 'review') return entry.job?.currentAction?.error || failureOf(entry) || entry.work?.receipts.at(-1)?.error || '核对已有结果，再决定下一步'
  if (phase === 'stopped') return '这件任务已取消'
  if (phase === 'followup') return entry.job?.runAt ? '等待安排的开始时间' : '已有跟进记录，尚未启动执行'
  if (phase === 'result') return '结果已保留，可以查看交付物或补充要求'
  if (entry.job?.status === 'queued') return '正在排队，执行资源可用后开始'
  if (entry.job?.currentAction?.status === 'running') return entry.job.currentAction.label || entry.job.currentAction.operation
  const step = entry.message?.steps?.find(item => item.status === 'running')
  if (step) return step.label
  return planFor(entry).find(item => ['doing', 'running', 'in_progress'].includes(item.status))?.text || entry.summary || '正在理解目标并准备执行'
}

export function workTitle(entry: WorkEntry) {
  const intent = intentOf(entry)
  const readable = (value: unknown) => typeof value === 'string' && value.trim().length <= 80 && !/(?:[a-z]:[\\/]|(?:^|\s)\/[\w.-]+\/|\\\\)/i.test(value)
  for (const value of [intent.title, intent.goal, entry.title]) if (readable(value) && !['task', 'document', 'data', 'files', 'research', 'desktop', 'general'].includes(String(value))) return String(value).trim()
  const output = [...filesFor(entry)].reverse().find(file => file.action.includes('已写入') && /\.(?:md|txt|docx|pdf|xlsx|csv|html)$/i.test(file.path))
  if (output) return fileName(output.path)
  return readable(intent.kind) ? String(intent.kind).trim() : kindNames[inferWorkKind(entry)]
}
export function inferWorkKind(entry: WorkEntry): WorkKind {
  const intent = intentOf(entry)
  if (typeof intent.presentation === 'string' && workKinds.includes(intent.presentation as WorkKind) && intent.presentation !== 'general') return intent.presentation as WorkKind
  if (entry.record) return 'followup'
  const request = [text(intent.kind), text(intent.goal), entry.request || entry.job?.goal || entry.title].join(' ').toLowerCase()
  // Task purpose takes precedence over incidental file formats or tool operations.
  if (/统计|销售额|销量|数据分析|分析.{0,8}数据|透视|柱状|折线|电子表格|\b(analytics|spreadsheet|pivot)\b/.test(request)) return 'data'
  if (/整理.{0,8}(文件|目录)|分类.{0,8}文件|文件.{0,8}(归类|分类|整理)|重命名|目录树|\b(organize files|file organization)\b/.test(request)) return 'files'
  if (/调研|研究|查资料|搜集资料|新闻|来源|比较.{0,10}(产品|方案|资料)|\b(research|sources)\b/.test(request)) return 'research'
  if (/修图|图像|图片处理|操作软件|操作窗口|点击|记事本|计算器|\b(desktop|photoshop)\b/.test(request)) return 'desktop'
  if (/提醒|跟进|定时|监控|持续关注|\b(reminder|monitor)\b/.test(request)) return 'followup'
  if (/文档|周报|草稿|写作|文章|报告|邮件|总结|\b(document|draft|report)\b/.test(request)) return 'document'
  if (entry.job?.runAt || entry.job?.repeat) return 'followup'
  const seen = observations(entry)
  if (tablesFor(entry).length) return 'data'
  if (seen.some(item => ['web_search', 'news_search', 'fetch_url'].includes(item.receipt.operation))) return 'research'
  if (seen.some(item => ['list_dir', 'find_files'].includes(item.receipt.operation))) return 'files'
  if (seen.some(item => /desktop|window|screenshot|inspect_window/.test(item.receipt.operation))) return 'desktop'
  if (seen.some(item => ['read_text', 'read_file'].includes(item.receipt.operation) && typeof (item.data.text || item.data.content) === 'string') || entry.message?.artifacts?.some(item => item.kind === 'document')) return 'document'
  return 'general'
}

export type DocumentBody = { id: string; title: string; path: string; content: string; source: string; partial: boolean; previous?: string }
export function documentsFor(entry: WorkEntry): DocumentBody[] {
  const documents: DocumentBody[] = []
  for (const { receipt, data } of observations(entry)) {
    if (!['read_text', 'read_file'].includes(receipt.operation)) continue
    const path = text(data.path || data.name || receipt.file_id, 500)
    const content = text(data.text || data.content)
    if (!content || /\.(csv|tsv|json)$/i.test(path)) continue
    const index = documents.findIndex(item => item.path === path && path)
    const previous = index >= 0 ? documents.splice(index, 1)[0] : undefined
    documents.push({ id: receipt.id, path, title: fileName(path) || '读回的正文', content, source: '文件读回', partial: data.truncated === true || data._preview_truncated === true, ...(previous ? { previous: previous.content === content ? previous.previous : previous.content } : {}) })
  }
  if (!documents.length && resultOf(entry)) {
    const previous = !!entry.job?.result && entry.job.status !== 'done'
    documents.push({ id: entry.id, path: '', title: previous ? '上次成功结果' : '当前正文', content: resultOf(entry), source: previous ? '上次成功结果' : entry.record ? '你留下的说明' : '助手提交的内容', partial: false })
  }
  return documents.slice(-6)
}

export type WorkTable = { id: string; title: string; source: string; columns: string[]; rows: string[][]; partial: boolean }
function grid(columns: string[], rows: string[][], extra: Omit<WorkTable, 'columns' | 'rows'>): WorkTable | null {
  if (columns.length < 2 || !rows.length) return null
  return { ...extra, columns: columns.slice(0, 24).map(value => value.slice(0, 160)), rows: rows.slice(0, 100).map(row => columns.slice(0, 24).map((_, index) => String(row[index] ?? '').slice(0, 500))), partial: extra.partial || rows.length > 100 || columns.length > 24 }
}
export function parseDelimited(content: string, delimiter: ',' | '\t', partial = false): { columns: string[]; rows: string[][] } | null {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false
  for (let index = 0; index < Math.min(content.length, 60000); index++) {
    const char = content[index]
    if (char === '"') { if (quoted && content[index + 1] === '"') { cell += '"'; index++ } else if (quoted || !cell) quoted = !quoted; else cell += char }
    else if (char === delimiter && !quoted) { row.push(cell); cell = '' }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && content[index + 1] === '\n') index++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; if (rows.length > 101) break }
    else cell += char
  }
  if (quoted && !partial) return null // A clipped JSON/text observation cannot invent a completed cell.
  if (!partial && (row.length || cell)) { row.push(cell); if (row.some(Boolean)) rows.push(row) }
  if (rows.length < 2 || rows[0].length < 2 || rows.some(row => row.length !== rows[0].length)) return null
  return { columns: rows[0].map(value => value.replace(/^\uFEFF/, '').trim()), rows: rows.slice(1) }
}
export function markdownTables(content: string): { columns: string[]; rows: string[][] }[] {
  const lines = content.split(/\r?\n/); const tables: { columns: string[]; rows: string[][] }[] = []
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(value => value.trim().replace(/\\\|/g, '|'))
  let fenced = false
  for (let index = 0; index < lines.length - 1; index++) {
    if (/^\s*```/.test(lines[index])) { fenced = !fenced; continue }
    if (fenced || !lines[index].includes('|')) continue
    const separator = cells(lines[index + 1]); const columns = cells(lines[index])
    if (separator.length !== columns.length || columns.length < 2 || !separator.every(value => /^:?-{3,}:?$/.test(value))) continue
    const rows: string[][] = []; index += 2
    while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { const values = cells(lines[index]); if (values.length !== columns.length) break; rows.push(values); index++ }
    if (rows.length) tables.push({ columns, rows }); index--
  }
  return tables
}
export function tablesFor(entry: WorkEntry): WorkTable[] {
  const tables: WorkTable[] = []
  for (const { receipt, data } of observations(entry)) {
    const path = text(data.path, 500), content = text(data.text || data.content, 60000)
    if (content && /\.(csv|tsv)$/i.test(path)) {
      const partial = data.truncated === true || data._preview_truncated === true
      const parsed = parseDelimited(content, /\.tsv$/i.test(path) ? '\t' : ',', partial)
      const table = parsed && grid(parsed.columns, parsed.rows, { id: receipt.id, title: fileName(path), source: '文件读回 · ' + path, partial })
      if (table) tables.push(table)
    }
  }
  markdownTables(resultOf(entry)).forEach((table, index) => { const value = grid(table.columns, table.rows, { id: entry.id + ':answer:' + index, title: '回答中的表格' + (index ? ' ' + (index + 1) : ''), source: '助手提交的表格 · 内容是否正确以任务核对为准', partial: false }); if (value) tables.push(value) })
  return tables.slice(-8)
}
export function numberValue(value: string): number | null {
  const plain = value.trim().replace(/[¥￥$€£,，\s]/g, '')
  if (!/^-?(?:\d+\.?\d*|\.\d+)%?$/.test(plain)) return null
  const number = Number(plain.replace(/%$/, ''))
  return Number.isFinite(number) ? number : null
}
export function numericColumns(table: WorkTable) {
  return table.columns.map((_, index) => index).filter(index => table.rows.every(row => numberValue(row[index]) !== null) && new Set(table.rows.map(row => row[index].trim().endsWith('%'))).size === 1)
}

export type WorkFile = { path: string; name: string; type: 'dir' | 'file'; action: string; receiptId: string; size?: number; content?: string }
export function filesFor(entry: WorkEntry): WorkFile[] {
  const files: WorkFile[] = []
  const put = (value: WorkFile) => { const index = files.findIndex(file => file.path.toLowerCase() === value.path.toLowerCase()); if (index >= 0) files[index] = { ...files[index], ...value, action: files[index].action.includes('已写入') && value.action === '已读取' ? '已写入 · 已读取' : value.action }; else files.push(value) }
  for (const { receipt, data } of observations(entry)) {
    const path = text(data.path, 500)
    if (path && ['read_text', 'read_file', 'write_text', 'write_document', 'edit_text', 'edit_image'].includes(receipt.operation)) put({ path, name: fileName(path), type: 'file', action: ['write_text', 'write_document', 'edit_text', 'edit_image'].includes(receipt.operation) ? '已写入' : '已读取', receiptId: receipt.id, ...(typeof data.size === 'number' || typeof data.bytes === 'number' ? { size: Number(data.size ?? data.bytes) } : {}), ...(typeof data.text === 'string' ? { content: text(data.text) } : {}) })
    if (receipt.operation.startsWith('mcp_') && object(data.evidence).source === 'mcp' && Array.isArray(data.artifacts)) for (const raw of data.artifacts.slice(0,8)) { const item=object(raw), artifactPath=text(item.path,500); if (/\.(docx?|xlsx?|pptx?|pdf|md|txt|csv|json|html?|png|jpe?g|webp|svg)$/i.test(artifactPath)) put({path:artifactPath,name:fileName(artifactPath),type:'file',action:'连接器产物',receiptId:receipt.id}) }
    if (receipt.operation === 'list_dir' && path && Array.isArray(data.entries)) for (const item of data.entries.slice(0, 200)) { const value = object(item), name = text(value.name, 200); if (name && !/[\\/]/.test(name)) put({ path: path.replace(/[\\/]$/, '') + (path.includes('\\') ? '\\' : '/') + name, name, type: value.type === 'dir' ? 'dir' : 'file', action: '目录观察', receiptId: receipt.id, ...(typeof value.size === 'number' ? { size: value.size } : {}) }) }
    if (receipt.operation === 'find_files' && Array.isArray(data.found)) for (const item of data.found.slice(0, 100)) { const value = object(item), found = text(value.path, 500); if (found) put({ path: found, name: fileName(found), type: value.type === 'dir' ? 'dir' : 'file', action: '已找到', receiptId: receipt.id }) }
  }
  return files.slice(-200)
}
export type ResearchSource = { url: string; title: string; snippet: string; read: boolean; from: string }
export function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null } catch { return null }
}
export function sourcesFor(entry: WorkEntry): ResearchSource[] {
  const sources: ResearchSource[] = []
  const put = (value: ResearchSource) => { const index = sources.findIndex(item => item.url === value.url); if (index >= 0) sources[index] = { ...value, read: value.read || sources[index].read }; else sources.push(value) }
  for (const { receipt, data } of observations(entry)) {
    if (!['web_search', 'news_search', 'fetch_url'].includes(receipt.operation)) continue
    const list = receipt.operation === 'fetch_url' ? [data] : Array.isArray(data.results) ? data.results : []
    for (const raw of list.slice(0, 30)) { const item = object(raw), url = safeWebUrl(item.url); if (url) put({ url, title: text(item.title, 180) || new URL(url).hostname, snippet: text(item.snippet || item.description || item.text, 500), read: receipt.operation === 'fetch_url', from: receipt.operation === 'fetch_url' ? '网页读取回执' : '搜索回执' }) }
  }
  for (const match of resultOf(entry).matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) { const url = safeWebUrl(match[2]); if (url && !sources.some(item => item.url === url)) put({ url, title: match[1].slice(0, 180), snippet: '', read: false, from: '回答中的引用' }) }
  return sources.slice(0, 40)
}
export function windowsFor(entry: WorkEntry) {
  return observations(entry).filter(item => /window|desktop|screenshot/.test(item.receipt.operation)).flatMap(({ data, receipt }) => {
    const values = Array.isArray(data.windows) ? data.windows : [data.window || data]
    return values.slice(0, 20).flatMap(raw => { const item = object(raw), title = text(item.title || item.window_title || (typeof data.window === 'string' ? data.window : ''), 200); return title ? [{ id: receipt.id + ':' + title, title, process: text(item.process || item.process_name, 100) }] : [] })
  }).slice(-12)
}
export function taskConditions(entry: WorkEntry, compact = false) {
  const intent = intentOf(entry), criteria = Array.isArray(intent.done_criteria) ? intent.done_criteria : []
  return criteria.slice(0, 8).map(value => { const item = object(value), fullTarget = text(item.target, 500), target = compact && ['file_exists', 'file_contains'].includes(String(item.check)) ? fileName(fullTarget) : fullTarget, valueText = text(item.value, 300); return ({ file_exists: '交付文件：' + target, file_contains: target + ' 包含：' + valueText, answer_contains: '回答包含：' + valueText, window_shows: target + ' 显示：' + valueText, judgement: valueText } as Record<string, string>)[String(item.check)] || valueText }).filter(Boolean)
}
