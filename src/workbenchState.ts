import type { WorkEntry } from './presenceModel'
import { workKinds, workPhase, type WorkKind } from './workPresentation.ts'

export type WorkbenchState = { drafts: Record<string, string>; views: Record<string, WorkKind>; selected?: string; inspector?: boolean }
export type WorkFilter = 'all' | 'active' | 'attention' | 'finished'
export function normalizeWorkbench(value: unknown): WorkbenchState {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const drafts: Record<string, string> = {}, views: Record<string, WorkKind> = {}
  for (const [key, draft] of Object.entries(raw.drafts && typeof raw.drafts === 'object' ? raw.drafts : {}).slice(-100)) {
    if (key.length <= 160 && typeof draft === 'string' && draft) drafts[key] = draft.slice(0, 16000)
  }
  for (const [key, view] of Object.entries(raw.views && typeof raw.views === 'object' ? raw.views : {}).slice(-100)) {
    if (key.length <= 160 && workKinds.includes(view as WorkKind)) views[key] = view as WorkKind
  }
  return { drafts, views, ...(typeof raw.selected === 'string' && raw.selected.length <= 160 ? { selected: raw.selected } : {}), inspector: raw.inspector === true }
}
export const needsAttention = (entry: WorkEntry) => ['waiting', 'review'].includes(workPhase(entry))
export function filterWork(entries: WorkEntry[], filter: WorkFilter, query: string) {
  const needle = query.trim().toLocaleLowerCase()
  return entries.filter(entry => {
    const phase = workPhase(entry)
    const matchesPhase = filter === 'all' || (filter === 'attention' ? needsAttention(entry) : filter === 'active' ? ['planning', 'executing'].includes(phase) : ['result', 'stopped'].includes(phase))
    return matchesPhase && (!needle || [entry.title, entry.summary, entry.request].join(' ').toLocaleLowerCase().includes(needle))
  })
}
export function groupedWork(entries: WorkEntry[]) {
  return [
    { label: '需要处理', items: entries.filter(needsAttention) },
    { label: '正在推进', items: entries.filter(entry => ['planning', 'executing'].includes(workPhase(entry))) },
    { label: '已暂停', items: entries.filter(entry => workPhase(entry) === 'paused') },
    { label: '持续跟进', items: entries.filter(entry => workPhase(entry) === 'followup') },
    { label: '近期结果', items: entries.filter(entry => workPhase(entry) === 'result') },
    { label: '已取消', items: entries.filter(entry => workPhase(entry) === 'stopped') },
  ].filter(group => group.items.length)
}
export function workInstruction(entry: WorkEntry, text: string) {
  return '接着「' + entry.title + '」这件事：\n' + text + (entry.record?.notes ? '\n已有跟进说明：' + entry.record.notes.slice(0, 3000) : '')
}
export type DiffLine = { before?: string; after?: string; oldLine?: number; newLine?: number; change: 'same' | 'removed' | 'added' }
export function documentDiff(before: string, after: string): { lines: DiffLine[]; partial: boolean } {
  const oldLines = before.replace(/\r\n/g, '\n').split('\n'), newLines = after.replace(/\r\n/g, '\n').split('\n')
  const a = oldLines.slice(0, 300), b = newLines.slice(0, 300), width = b.length + 1
  const lengths = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lengths[i * width + j] = a[i] === b[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
  const lines: DiffLine[] = []; let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ before: a[i], after: b[j], oldLine: ++i, newLine: ++j, change: 'same' }) }
    else if (i < a.length && (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) { lines.push({ before: a[i], oldLine: ++i, change: 'removed' }) }
    else { lines.push({ after: b[j], newLine: ++j, change: 'added' }) }
  }
  return { lines, partial: oldLines.length > 300 || newLines.length > 300 }
}
