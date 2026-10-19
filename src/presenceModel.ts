import type { AssistantState, AssistantWork, Checkpoint, Job, Message, PersistentTask, Session, ToolStep, Workspace } from './types'

export type WorkEntry = {
  id: string; title: string; summary: string; status: string; time: string; ongoing: boolean
  sessionId?: string; request?: string; job?: Job; work?: AssistantWork; message?: Message; record?: PersistentTask
}
export type PresenceEvent = { id: string; text: string; time: string; entryId?: string }

const statusLabels: Record<string, string> = {
  running: '进行中', queued: '排队中', waiting: '等你确认', scheduled: '已安排', paused: '已暂停', done: '已完成',
  failed: '未完成', cancelled: '已停止', interrupted: '待恢复', result_unknown: '结果待核对',
  actions_verified: '操作已验证', verified: '操作已验证', advice_only: '建议已记录', active: '持续跟进',
  checked_by_desktop: '结果已核对', unverified: '结果待核对', observed_success: '已返回观察', dispatch_started: '执行中', denied: '未执行',
  needs_replan: '要求已变，待调整',
}
export const workStatus = (value: string) => statusLabels[value] || value
export const timeValue = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0
export const operationLabel = (value: string) => ({ read_file: '读取文件', read_text: '读取文件', write_text: '写入文件', list_dir: '查看目录', find_files: '查找文件', search_text: '查找内容', web_search: '搜索资料', fetch_url: '读取网页', update_plan: '更新计划', remember: '保存记忆', run_skill: '执行已有方法', schedule_reminder: '安排提醒', delegate: '协作执行', write_inventory: '生成清单', observe_desktop: '观察窗口', list_windows: '查看软件窗口', inspect_window: '查看窗口', desktop_action: '操作窗口', create_artifact: '生成内容', open_artifact: '打开文档' }[value] || value)

// Project only observed execution and explicit records. Ordinary questions do not become tasks.
export function collectWork(workspace: Workspace, state: AssistantState | null, jobs: Job[], busySessions: string | string[] = []): WorkEntry[] {
  const runningSessions = new Set(typeof busySessions === 'string' ? [busySessions] : busySessions)
  const works = state?.works || []
  const linkedFor = (work: AssistantWork) => workspace.sessions.flatMap(session => [...session.messages].reverse().filter(message => message.role === 'assistant' && (message.coreWorkId || message.core?.turnId) === work.id).map(message => ({ message, sessionId: session.id, time: session.updated }))).sort((a, b) => timeValue(b.time) - timeValue(a.time))[0]
  const jobWorkIds = new Set(jobs.map(job => job.workId).filter(Boolean))
  const entries: WorkEntry[] = jobs.map(job => {
    const work = works.find(item => item.id === job.workId && (!job.workRevision || item.cognition?.revision === job.workRevision))
    const linked = work && linkedFor(work)
    return { id: 'job:' + job.id, title: job.title, summary: [...job.log].reverse().find(log => log.kind === 'step' || log.kind === 'agent')?.text || job.goal, status: workStatus(job.status), time: job.updatedAt, ongoing: ['running', 'queued', 'waiting'].includes(job.status), sessionId: job.session || linked?.sessionId, request: job.goal, job, ...(work ? { work } : {}), ...(linked ? { message: linked.message } : {}) }
  })
  for (const work of works) {
    if (jobWorkIds.has(work.id)) continue
    if (work.status === 'advice_only' && !work.receipts.length) continue
    const linked = linkedFor(work)
    entries.push({ id: 'core:' + work.id, title: work.goal, summary: work.receipts.at(-1) ? operationLabel(work.receipts.at(-1)!.operation) + ' · ' + workStatus(work.receipts.at(-1)!.status) : work.result || '已提交工作，等待执行记录', status: workStatus(work.status), time: work.cognition?.updated_at || work.created_at, ongoing: work.status === 'running', sessionId: linked?.sessionId || work.session, request: work.cognition?.request, ...(linked ? { message: linked.message } : {}), work })
  }
  for (const session of [...workspace.sessions].sort((a, b) => Number(runningSessions.has(b.id)) - Number(runningSessions.has(a.id)) || timeValue(b.updated) - timeValue(a.updated))) {
    const message = [...session.messages].reverse().find(item => item.role === 'assistant')
    if (!message || works.some(work => work.id === (message.coreWorkId || message.core?.turnId))) continue
    const savedWorkId = message.coreWorkId || message.core?.turnId
    if (savedWorkId && (jobWorkIds.has(savedWorkId) || entries.some(entry => entry.id === 'core:' + savedWorkId))) continue
    const running = runningSessions.has(session.id)
    if (!running && !message.steps?.length && !message.artifacts?.length && !message.plan?.length && !message.taskEvidence?.receipts.length) continue
    entries.push({ id: savedWorkId ? 'core:' + savedWorkId : 'session:' + session.id, title: session.title, summary: message.steps?.at(-1)?.label || message.plan?.find(item => item.status === 'doing')?.text || (running ? '正在处理你的要求' : '执行记录保存在这段交流里'), status: running ? '进行中' : message.error ? '未完成' : '回复已收到', time: session.updated, ongoing: running, sessionId: session.id, request: [...session.messages].reverse().find(item => item.role === 'user')?.raw?.text || [...session.messages].reverse().find(item => item.role === 'user')?.content, message })
  }
  for (const record of workspace.tasks || []) entries.push({ id: 'record:' + record.id, title: record.title, summary: record.notes || '你明确创建的跟进记录', status: workStatus(record.status), time: record.updatedAt, ongoing: record.status === 'active', sessionId: record.sessionId, record })
  return entries.sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || timeValue(b.time) - timeValue(a.time))
}

export function collectEvents(entries: WorkEntry[], checkpoints: Checkpoint[]): PresenceEvent[] {
  const events: PresenceEvent[] = []
  for (const entry of entries) {
    if (entry.job) {
      for (const [index, log] of entry.job.log.slice(-3).entries()) events.push({ id: entry.id + ':' + index + ':' + log.ts, text: log.text, time: log.ts, entryId: entry.id })
      if (!entry.job.log.length) events.push({ id: entry.id, text: entry.title + ' · ' + entry.status, time: entry.time, entryId: entry.id })
    } else events.push({ id: entry.id, text: entry.title + ' · ' + entry.status, time: entry.time, entryId: entry.id })
  }
  for (const item of checkpoints) events.push({ id: 'change:' + item.id, text: (item.status === 'reverted' ? '已撤销：' : '文件已更改：') + item.path.split(/[\\/]/).at(-1), time: item.ts })
  return events.sort((a, b) => timeValue(b.time) - timeValue(a.time)).slice(0, 5)
}

export function entrySteps(entry: WorkEntry): ToolStep[] {
  if (entry.work) return entry.work.receipts.map(receipt => ({ label: operationLabel(receipt.operation), status: ['verified', 'observed_success'].includes(receipt.status) ? 'ok' : ['failed', 'result_unknown', 'denied'].includes(receipt.status) ? 'failed' : 'running', error: receipt.error || (receipt.status === 'result_unknown' ? '结果待核对，请先检查，不能直接重复操作' : undefined) }))
  if (entry.message) return entry.message.steps || []
  if (entry.job) return entry.job.log.filter(log => log.kind === 'step').map(log => ({ label: log.text, status: log.ok === true ? 'ok' : log.ok === false ? 'failed' : 'running', error: log.error }))
  return []
}

export const lastReply = (session: Session) => [...session.messages].reverse().find(message => message.role === 'assistant')
