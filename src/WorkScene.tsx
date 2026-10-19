import { t, systemText } from './i18n'
import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUp, ArrowUpRight, CheckCircle, Clock, FileText, Folder, Info, MagnifyingGlass, Monitor, Pause, Play, Plus, SidebarSimple, SpinnerGap, Square, WarningCircle, X } from '@phosphor-icons/react'
import type { AssistantWork, Checkpoint } from './types'
import { entrySteps, type WorkEntry, workStatus } from './presenceModel'
import { dayTime, cleanError } from './ui'
import type { Preview } from './PreviewPane'
import { MessageRenderer } from './MessageRenderer'
import { TaskWorkspace } from './TaskWorkspace'
import { currentAction, inferWorkKind, kindNames, phaseNames, planFor, taskConditions, workPhase, workTitle, type WorkKind } from './workPresentation'
import { filterWork, groupedWork, needsAttention, type WorkbenchState, type WorkFilter } from './workbenchState'
import './workbench.css'
import { NewWorkForm, type NewWorkValue } from './NewWorkForm'
import { ApprovalCard, type JobController } from './JobsPage'
import { RequirementChecks } from './RequirementMemory'

const kindIcons = { document: FileText, data: FileText, files: Folder, research: MagnifyingGlass, desktop: Monitor, followup: Clock, general: CheckCircle }
const roleNames: Record<string, string> = { executor: '执行者', researcher: '资料员', coder: '程序员', operator: '操作员', writer: '写作员', reviewer: '复核员' }
function allocationText(node: ReturnType<typeof planFor>[number]) {
  const state = node.allocation
  if (!state) return ''
  const pending = state.waiting_for === 'dependencies' ? '等待前置验收' : state.waiting_for === 'resource' ? '等待文件或执行资源' : state.waiting_for === 'capacity' ? '等待执行容量' : '等待服务响应'
  return [t(roleNames[node.role] || '执行者'), state.service, ['doing', 'running'].includes(node.status) ? state.current_action?.label ? systemText(state.current_action.label) : t('等待服务响应') : node.status === 'pending' ? t(pending) : ''].filter(Boolean).join(' · ')
}
const prompts: Record<WorkKind, { label: string; text: string }[]> = {
  document: [{ label: '修改正文', text: '继续修改这份内容：' }, { label: '核对内容', text: '核对这份内容与当前要求，还有哪些地方需要改进？' }],
  data: [{ label: '调整口径', text: '调整分析口径：' }, { label: '检查异常', text: '检查当前数据中的异常，并说明核对依据。' }],
  files: [{ label: '调整方案', text: '调整文件整理方案：' }, { label: '核对改动', text: '核对这件事实际改动了哪些文件。' }],
  research: [{ label: '补充问题', text: '继续研究这个问题：' }, { label: '核对来源', text: '核对当前结论的来源，区分已读取的原文和仍需确认的线索。' }],
  desktop: [{ label: '补充要求', text: '继续处理这件事：' }, { label: '核对结果', text: '先核对已有操作和实际结果，再说明下一步。' }],
  followup: [{ label: '补充安排', text: '补充下一步安排：' }, { label: '更新进展', text: '这件事有新进展：' }],
  general: [{ label: '继续处理', text: '接着处理：' }, { label: '补充要求', text: '补充一个要求：' }],
}

function TaskInspector({ entry, close, open }: { entry: WorkEntry; close: () => void; open: (entry: WorkEntry) => void }) {
  const steps = entrySteps(entry), conditions = taskConditions(entry, true), fullConditions = taskConditions(entry)
  const plan = planFor(entry)
  const verification = entry.work?.cognition?.verification?.result as { passed?: boolean; checks?: { passed: boolean | null; how?: string }[] } | undefined
  return <aside className="work-inspector" aria-label={t("任务详情")}>
    <header><b>{t("任务详情")}</b><button type="button" aria-label={t("关闭任务详情")} onClick={close}><X size={17} /></button></header>
    <div className="work-inspector-scroll">
      <section><h3>{t("当前目标")}</h3><p>{entry.work?.cognition?.request || entry.request || entry.job?.goal || entry.record?.notes || entry.title}</p></section>
      <section><h3>{t("任务状态")}</h3><dl><div><dt>{t("状态")}</dt><dd>{t(entry.status)}</dd></div>{entry.work?.cognition && <div><dt>{t("要求版本")}</dt><dd>{entry.work.cognition.revision}</dd></div>}<div><dt>{t("最近更新")}</dt><dd>{dayTime(entry.time)}</dd></div><div><dt>{t("记录来源")}</dt><dd>{entry.work ? t("本地核心") : entry.job ? t("后台任务") : entry.record ? t("你留下的记录") : t("关联交流")}</dd></div></dl></section>
      {!!conditions.length && <section><h3>{t("完成要求")}</h3><ul className="inspector-criteria">{conditions.map((condition, index) => { const check = verification?.checks?.[index]; return <li key={index}><span>{check?.passed === true ? <CheckCircle className="verification-check" size={15} aria-label={t("已核对")} /> : check?.passed === false ? <WarningCircle size={15} aria-label={t("尚未满足")} /> : index + 1}</span><p title={fullConditions[index]}>{condition}{check?.how && <small>{check.how}</small>}</p></li> })}</ul>{verification?.passed !== undefined && <p className="work-verification-note">{verification.passed ? t("已按本轮要求核对通过") : t("本轮要求尚未全部满足")}</p>}</section>}
      {!!plan.length && <section className="inspector-full-plan"><h3>{t('完整执行计划')}<small>{plan.length}</small></h3><ol>{plan.map((node, index) => <li key={node.id}><b>{index + 1}. {node.text}</b><small>{t(node.status === 'verified' ? '已核对' : node.status === 'done' ? '已报告完成' : node.status === 'doing' ? '进行中' : node.status === 'pending' ? '待执行' : '结果待核对')}</small>{node.expect && <p>{t('预期：')}{node.expect}</p>}{!!node.dependencies.length && <p>{t('前置：')}{node.dependencies.map(id => plan.find(item => item.id === id)?.text || id).join('、')}</p>}{node.unmet.map((item, itemIndex) => <p className="work-send-error" key={itemIndex}>{item}</p>)}</li>)}</ol></section>}
      <section><h3>{t("执行记录")}<small>{steps.length}</small></h3>{steps.length ? <ol className="inspector-events">{steps.map((step, index) => <li key={index} className={step.status}>{step.status === 'ok' ? <CheckCircle size={15} /> : step.status === 'failed' ? <WarningCircle size={15} /> : <SpinnerGap size={15} />}<div><b>{systemText(step.label)}</b><p>{step.status === 'ok' ? t("已返回成功观察") : step.status === 'failed' ? step.error || t("未完成") : t("等待执行结果")}</p></div></li>)}</ol> : <p className="work-muted">{t("还没有工具操作记录。")}</p>}{entry.work?.receipts_partial && <p className="work-muted">{t("显示最近 80 条已保存记录。")}</p>}</section>
      <button type="button" className="work-inspector-link" onClick={() => open(entry)}>{t("打开")}{entry.job ? t("后台详情") : entry.record ? t("任务记录") : t("关联交流")}<ArrowUpRight size={14} /></button>
    </div>
  </aside>
}

function TaskControls({ entry, act }: { entry: WorkEntry; act: JobController['act'] }) {
  const job = entry.job!, [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState('')
  const action = async (value: 'pause' | 'resume' | 'cancel' | 'start') => {
    if (busy) return
    setBusy(true); setError('')
    try { if (!await act(job.id, value)) setError(t('操作未能提交，请检查连接后再试。')); else setConfirm(false) }
    catch (reason) { setError(cleanError(reason)) }
    finally { setBusy(false) }
  }
  return <div className="work-task-controls" aria-label={t('当前任务控制')}>
    {job.status === 'scheduled' && <button type="button" disabled={busy} onClick={() => void action('start')}><Play size={14} />{t('现在开始')}</button>}
    {['running', 'queued', 'waiting', 'scheduled'].includes(job.status) && <button type="button" disabled={busy} onClick={() => void action('pause')}><Pause size={14} />{t('暂停任务')}</button>}
    {['paused', 'interrupted', 'failed', 'unverified'].includes(job.status) && <button type="button" disabled={busy} onClick={() => void action('resume')}><Play size={14} />{t('检查进度并继续')}</button>}
    {!['done', 'cancelled'].includes(job.status) && <button type="button" className={confirm ? 'danger' : ''} disabled={busy} onClick={() => confirm ? void action('cancel') : setConfirm(true)}><Square size={12} />{confirm ? t('确认取消') : t('取消任务')}</button>}
    {confirm && <button type="button" disabled={busy} onClick={() => setConfirm(false)}>{t('保留任务')}</button>}
    {error && <span className="work-send-error" role="alert">{error}</span>}
  </div>
}

function TaskRunSummary({ entry, act, inspectPlan }: { entry: WorkEntry; act?: JobController['act']; inspectPlan: () => void }) {
  const phase = workPhase(entry), plan = planFor(entry), action = currentAction(entry)
  const active = plan.filter(item => ['doing', 'running'].includes(item.status)).length
  const adjustment = entry.job && [...entry.job.log].reverse().find(log => log.kind === 'user')
  const verification = entry.work?.cognition?.verification?.result as { passed?: boolean; unmet?: string[] } | undefined
  const remaining = plan.filter(item => item.status !== 'verified'), visiblePlan = ['result', 'stopped', 'followup'].includes(phase) ? [] : (remaining.length ? remaining : plan.slice(-1)).slice(0, 3)
  const next = phase === 'paused' ? '由你恢复后，检查已保存进度并继续' : phase === 'waiting' ? '处理当前确认后，任务会自动继续' : entry.job?.status === 'interrupted' ? '检查已有操作与产物，再继续执行' : phase === 'review' && entry.job?.retryableFailure ? 'AI 服务恢复后，点击“检查进度并继续”接续此任务' : phase === 'review' ? '检查未满足的要求和已有操作' : phase === 'followup' ? entry.job?.runAt ? t('将在 {p0} 开始', { p0: dayTime(entry.job.runAt) }) : '补充要求或承接为可执行任务' : phase === 'result' ? '查看结果，或补充要求继续这件事' : phase === 'stopped' ? '执行已结束，记录和已有结果仍可查看' : plan.find(item => item.status === 'pending')?.text || '根据实际结果推进，并核对交付'
  return <section className={'work-run-summary ' + phase} aria-label={t('任务进度与下一步')}>
    <div className="work-run-goal"><span>{t('目标')}</span><p title={entry.job?.goal || entry.work?.cognition?.request || entry.request}>{entry.job?.goal || entry.work?.cognition?.request || entry.request || entry.title}</p></div>
    {adjustment && <div className="work-run-adjustment"><span>{t('最新补充')}</span><p title={adjustment.text}>{adjustment.text}</p></div>}
    {phase !== 'result' && <div className="work-run-facts" role="status"><div><span>{t(phase === 'waiting' || phase === 'paused' || phase === 'review' || phase === 'followup' ? '当前状态' : '当前动作')}</span><b>{active > 1 && phase === 'executing' ? t('{p0} 项分工进行中', { p0: active }) : systemText(action)}</b></div><div><span>{t('下一步')}</span><p>{systemText(next)}</p></div></div>}
    {!!plan.length && <div className="work-run-plan">
      <div><b>{t(plan.some(item => item.executionMode === 'parallel') ? '执行分工' : '执行计划')}</b><small>{t('{p0}/{p1} 步已核对', { p0: plan.filter(item => item.status === 'verified').length, p1: plan.length })}</small><button type="button" onClick={inspectPlan}>{t('查看完整计划')}<ArrowRight size={12} /></button></div>
      {!!visiblePlan.length && <ol>{visiblePlan.map((item, index) => <li className={item.status} key={item.id + ':' + index}>
        <span>{item.status === 'verified' ? <CheckCircle size={14} /> : ['doing', 'running', 'in_progress'].includes(item.status) ? <SpinnerGap size={14} /> : ['unknown', 'needs_recheck', 'blocked'].includes(item.status) ? <WarningCircle size={14} /> : index + 1}</span>
        <p title={item.text}>{item.text}{item.allocation && <small className="work-node-allocation">{allocationText(item)}</small>}</p>
        <b>{t(({ verified: '已核对', done: '已报告完成', completed: '已报告完成', doing: '进行中', running: '进行中', in_progress: '进行中', blocked: '需处理', unknown: '结果待核对', needs_recheck: '恢复待核对', pending: '待执行' } as Record<string, string>)[item.status] || item.status)}</b>
      </li>)}</ol>}
    </div>}
    {verification?.passed !== undefined && <p className={'work-result-check ' + (verification.passed ? 'passed' : 'unmet')}>{verification.passed ? <CheckCircle size={15} /> : <WarningCircle size={15} />}<span>{t(verification.passed ? '已按本轮要求核对通过' : '本轮要求尚未全部满足')}{!verification.passed && verification.unmet?.length ? ' · ' + verification.unmet.slice(0, 3).join('；') : ''}</span></p>}
    {entry.job?.persistenceError && <p className="work-send-error" role="alert">{t('任务记录保存异常：')}{entry.job.persistenceError}</p>}
    {entry.job && act && !['done', 'cancelled'].includes(entry.job.status) && <TaskControls key={entry.job.id} entry={entry} act={act} />}
    {phase === 'waiting' && entry.job?.approval && act && <ApprovalCard key={entry.job.approval.id} job={entry.job} act={act} />}
  </section>
}

export function WorkScene({ entries, focus, open, newWork, preview, continueWork, checkpoints = [], workbench = { drafts: {}, views: {} }, changeWorkbench, changeDraft, instruct, busySessions = [], stop, ready = true, connectionError, reconnect, initialFilter = 'all', creating = false, closeCreation, create, actJob }: {
  entries: WorkEntry[]; focus: string; open: (entry: WorkEntry) => void; newWork: () => void; preview: (value: Preview) => void; continueWork: (entry: WorkEntry) => void; checkpoints?: Checkpoint[]
  workbench?: WorkbenchState; changeWorkbench?: (value: Partial<WorkbenchState>) => void; changeDraft?: (id: string, value: string, expected?: string) => void; instruct?: (entry: WorkEntry, text: string) => Promise<boolean>; busySessions?: string[]; stop?: (sessionId?: string) => void; ready?: boolean; connectionError?: string; reconnect?: () => void; initialFilter?: WorkFilter
  creating?: boolean; closeCreation?: () => void; create?: (value: NewWorkValue) => Promise<boolean>; actJob?: JobController['act']
}) {
  const [selectedId, setSelectedId] = useState(workbench.selected || '')
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<WorkFilter>(initialFilter)
  useEffect(() => setFilter(initialFilter), [initialFilter])
  const [localViews, setLocalViews] = useState<Record<string, WorkKind>>({}), [localInspector, setLocalInspector] = useState(false)
  const [submissions, setSubmissions] = useState<string[]>([]), [sendErrors, setSendErrors] = useState<Record<string, string>>({})
  const search = useRef<HTMLInputElement>(null), input = useRef<HTMLTextAreaElement>(null)
  const inspectorTrigger = useRef<HTMLButtonElement>(null)
  const views = changeWorkbench ? workbench.views : localViews, inspector = changeWorkbench ? workbench.inspector === true : localInspector
  const select = (id: string) => { setSelectedId(id); changeWorkbench?.({ selected: id }); closeCreation?.() }
  const toggleInspector = (value: boolean) => { setLocalInspector(value); changeWorkbench?.({ inspector: value }); if (!value) inspectorTrigger.current?.focus() }
  useEffect(() => {
    if (!inspector) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); toggleInspector(false) } }
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close)
  }, [inspector])
  useEffect(() => { if (focus) select(focus) }, [focus])
  useEffect(() => { if (ready && !creating && !entries.some(entry => entry.id === selectedId)) { const next = entries.find(entry => entry.id === focus)?.id || entries[0]?.id || ''; if (next !== selectedId) select(next) } }, [entries, selectedId, focus, ready, creating])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === '/' && !event.ctrlKey && !event.metaKey && !(event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable))) { event.preventDefault(); search.current?.focus() } }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [])
  const selected = entries.find(entry => entry.id === selectedId) || (ready ? entries[0] : undefined), work = selected?.work
  const workId = selected?.job?.workId || work?.id, revision = selected?.job?.workRevision || work?.cognition?.revision
  const detailKey = workId ? JSON.stringify([workId, revision, selected?.job?.updatedAt, work?.status, work?.cognition?.updated_at, work?.receipts.length, work?.receipts.at(-1)?.id, work?.receipts.at(-1)?.status]) : ''
  const [detail, setDetail] = useState<{ key: string; work: AssistantWork } | null>(null), [detailState, setDetailState] = useState<{ key: string; status: 'loading' | 'ready' | 'summary' | 'error'; error?: string }>({ key: '', status: 'ready' }), [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false; const api = window.memoryDesktop
    if (workId && api && !creating) {
      setDetailState({ key: detailKey, status: 'loading' })
      api.workDetail(workId).then(value => {
        if (cancelled) return
        if (value?.id === workId && (!revision || value.cognition?.revision === revision)) { setDetail({ key: detailKey, work: value }); setDetailState({ key: detailKey, status: 'ready' }) }
        else setDetailState({ key: detailKey, status: 'summary' })
      }).catch(error => { if (!cancelled) setDetailState({ key: detailKey, status: 'error', error: cleanError(error) }) })
    }
    return () => { cancelled = true }
  }, [detailKey, retry, creating])
  const shown = selected && detail?.key === detailKey ? { ...selected, work: detail.work, status: selected.job ? selected.status : workStatus(detail.work.status) } : selected
  const kind = shown ? views[shown.id] || inferWorkKind(shown) : 'general', Icon = kindIcons[kind]
  const phase = shown ? workPhase(shown) : 'planning', steps = shown ? entrySteps(shown) : []
  const filtered = filterWork(entries, filter, query), groups = groupedWork(filtered)
  const draft = selected ? workbench.drafts[selected.id] || '' : ''
  const setDraft = (value: string) => { if (selected) changeDraft?.(selected.id, value.slice(0, 16000)) }
  const currentBusy = !!selected?.job && ['running', 'waiting', 'queued'].includes(selected.job.status) || !!selected?.sessionId && busySessions.includes(selected.sessionId)
  const submission = selected && submissions.includes(selected.id) ? selected.id : null
  const sendError = selected ? sendErrors[selected.id] || '' : ''
  const submit = async () => {
    if (!shown || !draft.trim() || !instruct || submission || (currentBusy && !shown.job)) return
    const id = shown.id, sent = draft; setSubmissions(previous => [...previous, id]); setSendErrors(previous => ({ ...previous, [id]: '' }))
    try { if (await instruct(shown, sent)) changeDraft?.(id, '', sent) }
    catch (error) { setSendErrors(previous => ({ ...previous, [id]: cleanError(error) })) }
    finally { setSubmissions(previous => previous.filter(item => item !== id)) }
  }
  return <div className={'work-scene workbench' + (inspector && !creating ? ' has-inspector' : '')}>
    <div className="work-task-switcher"><label>{t('当前任务')}<select aria-label={t('切换任务')} value={creating ? '' : selected?.id || ''} onChange={event => select(event.target.value)}><option value="" disabled>{t('选择任务')}</option>{entries.map(entry => <option key={entry.id} value={entry.id}>{t(workTitle(entry))} · {t(entry.status)}</option>)}</select></label><button type="button" onClick={newWork}><Plus size={15} />{t('新任务')}</button></div>
    <aside className="scene-list" aria-label={t("工作列表")}>
      <header className="work-list-heading"><b>{t("工作")}</b><span>{entries.length}</span><button type="button" title={t("新的事情")} aria-label={t("新的事情")} onClick={newWork}><Plus size={18} /></button></header>
      {connectionError && <div className="work-connection-state" role="status"><WarningCircle size={14} /><span title={connectionError}>{t("核心未连接，记录尚未更新")}</span><button type="button" onClick={reconnect}>{t("重连")}</button></div>}
      <div className="work-search"><MagnifyingGlass size={15} /><input ref={search} aria-label={t("搜索当前工作")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索工作")} />{query ? <button type="button" aria-label={t("清空工作搜索")} onClick={() => setQuery('')}><X size={13} /></button> : <kbd>/</kbd>}</div>
      <div className="work-filters" role="group" aria-label={t("筛选工作")}>{([{ id: 'all', label: '全部' }, { id: 'active', label: '进行中' }, { id: 'attention', label: '需处理' }, { id: 'finished', label: '已结束' }] as const).map(item => <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{t(item.label)}{item.id === 'attention' && entries.some(needsAttention) && <i />}</button>)}</div>
      <div className="work-list-scroll" role="listbox" aria-label={t("任务")} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.scene-list-row')], index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
        if (buttons[next]) { event.preventDefault(); buttons[next].focus(); buttons[next].click() }
      }}>
        {groups.map(group => <div className="work-list-group" key={t(group.label)}><div className="work-group-label">{t(group.label)}<span>{group.items.length}</span></div>{group.items.map(entry => { const display = shown?.id === entry.id ? shown : entry, entryKind = views[entry.id] || inferWorkKind(display), ItemIcon = kindIcons[entryKind], entryPhase = workPhase(entry); return <button type="button" role="option" aria-selected={selected?.id === entry.id} tabIndex={selected?.id === entry.id || (!filtered.some(item => item.id === selected?.id) && groups[0]?.items[0]?.id === entry.id) ? 0 : -1} key={entry.id} data-work-id={entry.id} className={'scene-list-row' + (selected?.id === entry.id ? ' selected' : '')} onClick={() => select(entry.id)}><ItemIcon size={17} /><span><b title={entry.title}>{t(workTitle(display))}</b><small><i className={'work-state-dot ' + entryPhase} />{t(entry.status)}<span>{dayTime(entry.time).replace('今天 ', '')}</span></small></span></button> })}</div>)}
        {!filtered.length && <div className="work-list-empty"><MagnifyingGlass size={23} /><b>{entries.length ? t("没有匹配的工作") : t("从一件事开始")}</b><p>{entries.length ? t("试试其他关键词或筛选条件。") : t("进度、结果和下一步会留在这里。")}</p>{entries.length ? <button type="button" onClick={() => { setQuery(''); setFilter('all') }}>{t("清除筛选")}</button> : <button type="button" onClick={newWork}>{t("新的事情")}<Plus size={14} /></button>}</div>}
      </div>
      <footer className="work-list-footer"><span>{entries.filter(entry => workPhase(entry) === 'executing').length}{t("件正在执行")}</span><button type="button" onClick={newWork}><Plus size={14} />{t("新建")}</button></footer>
    </aside>
    {creating && create ? <section className="scene-detail new-work-scene"><header className="new-work-heading"><b>{t('新任务')}</b><button type="button" onClick={closeCreation}>{t('返回工作')}<X size={16} /></button></header><div className="new-work-canvas"><NewWorkForm draft={workbench.drafts['new-work'] || ''} changeDraft={(value, expected) => changeDraft?.('new-work', value, expected)} create={create} available={!!window.memoryDesktop} /></div></section> : shown ? <section className="scene-detail">
      <header className="work-detail-header"><div className="work-detail-heading"><span className="work-kind-icon"><Icon size={21} /></span><div><div className="work-breadcrumb">{t(kindNames[kind])}<span>·</span>{dayTime(shown.time)}</div><h2 title={shown.title}>{t(workTitle(shown))}</h2></div></div><div className="work-detail-actions"><span className={'work-phase-badge ' + phase}><i />{t(shown.status)}</span><button type="button" className={inspector ? 'selected' : ''} ref={inspectorTrigger} aria-label={t("任务详情")} aria-expanded={inspector} title={t("任务详情与执行记录")} onClick={() => toggleInspector(!inspector)}><SidebarSimple size={19} /></button><button type="button" aria-label={t("打开关联交流或任务详情")} title={t("打开原始记录")} onClick={() => open(shown)}><ArrowUpRight size={18} /></button></div></header>
      {detailState.key === detailKey && ['loading', 'error', 'summary'].includes(detailState.status) && <div className={'work-load-state ' + detailState.status} role="status">{detailState.status === 'loading' ? <><SpinnerGap size={14} />{t("正在读取已保存的内容…")}</> : <><Info size={14} /><span>{detailState.status === 'error' ? t("详情未能读取，当前保留已载入的记录。") : t("当前核心只提供摘要，显示已有记录。")}</span><button type="button" title={detailState.error} onClick={() => setRetry(value => value + 1)}>{t("重新读取")}</button></>}</div>}
      <TaskRunSummary entry={shown} act={actJob} inspectPlan={() => toggleInspector(true)} />
      <div className="work-canvas" aria-label={t("工作内容")}>
        {(shown.job?.acceptance?.requirementsCheck || shown.message?.requirementsCheck) && <RequirementChecks report={(shown.job?.acceptance?.requirementsCheck || shown.message?.requirementsCheck)!} />}
        <TaskWorkspace key={shown.id + ':' + kind} entry={shown} kind={kind} override={views[shown.id]} chooseKind={value => { const next = { ...views }; if (value) next[shown.id] = value; else delete next[shown.id]; setLocalViews(next); changeWorkbench?.({ views: next }) }} checkpoints={checkpoints} preview={preview} open={open} continueWork={continueWork} externalDetails inlineInstructions={!!instruct} />
      </div>
      <div className="work-compose-dock">
        <div className="work-activity" role="status"><span className={'work-activity-icon ' + phase}>{phase === 'executing' ? <SpinnerGap size={15} /> : phase === 'review' || phase === 'waiting' ? <WarningCircle size={15} /> : <CheckCircle size={15} />}</span><b>{t(phaseNames[phase])}</b><span>{systemText(currentAction(shown))}</span>{steps.length > 0 && <button type="button" onClick={() => toggleInspector(true)}>{t("操作记录：{p0}", { p0: steps.length })}<ArrowRight size={12} /></button>}</div>
        {instruct && changeWorkbench ? <>
          <div className="work-prompt-actions">{prompts[kind].map(prompt => <button type="button" key={prompt.label} onClick={() => { setDraft(draft ? draft + '\n' + t(prompt.text) : t(prompt.text)); input.current?.focus() }}>{t(prompt.label)}</button>)}</div>
          <form className="work-inline-composer" onSubmit={event => { event.preventDefault(); void submit() }}><textarea ref={input} aria-label={t("补充当前任务要求")} placeholder={shown.job ? t("补充要求，任务会在下一步接收…") : t("补充要求，接着这件事做…")} rows={1} maxLength={16000} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} /><div>{currentBusy && stop && !shown.job ? <button type="button" aria-label={t("停止当前任务")} onClick={() => stop(shown.sessionId)}><Square size={15} weight="fill" /></button> : <button type="submit" aria-label={t("发送任务要求")} disabled={!draft.trim() || submission !== null || (currentBusy && !shown.job)}>{submission === shown.id ? <SpinnerGap size={16} /> : <ArrowUp size={17} weight="bold" />}</button>}</div></form>
          <div className="work-compose-note"><span>{currentBusy && !shown.job ? t("当前任务正在处理，草稿会保留在这里。") : t("要求发给当前任务 · Enter 发送，Shift+Enter 换行")}</span>{draft && <span>{t("草稿自动保存在本机")}</span>}</div>
          {sendError && <div role="alert" className="work-send-error">{sendError}{t("· 要求已保留，可再次发送。")}</div>}
          {shown.message?.content && <details className={'work-latest-reply' + (shown.message.error ? ' failed' : '')}><summary>{shown.message.error ? t("本轮未完成 · 查看反馈") : t("最新回应")}<span>{shown.message.content.replace(/[#*`]/g, '').slice(0, 70)}</span></summary><MessageRenderer content={shown.message.content} onPreview={preview} /></details>}
        </> : <button type="button" className="work-inspector-link" onClick={() => continueWork(shown)}>{t("补充当前任务要求")}<ArrowRight size={14} /></button>}
      </div>
    </section> : !ready ? <div className="work-loading-placeholder" role="status"><SpinnerGap size={24} /><p>{t("正在读取工作记录…")}</p></div> : <div className="scene-empty"><CheckCircle size={32} weight="light" /><h2>{t("开始一件具体的事")}</h2><p>{t("创建任务后，内容、进度和执行记录会在这里持续接续。")}</p><button type="button" onClick={newWork}>{t("新的事情")}<Plus size={16} /></button></div>}
    {shown && inspector && !creating && <TaskInspector entry={shown} close={() => toggleInspector(false)} open={open} />}
  </div>
}
