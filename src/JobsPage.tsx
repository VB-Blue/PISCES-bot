import { t } from './i18n'
import { RequirementChecks } from './RequirementMemory'
import { useEffect, useMemo, useState } from 'react'
import { ArrowCounterClockwise, CalendarBlank, CheckCircle, Clock, Gear, HandPalm, Lightning, Pause, Play, Plus, Repeat, ShieldWarning, SpinnerGap, Stop, Trash, WarningCircle, XCircle } from '@phosphor-icons/react'
import type { Checkpoint, Job, JobStatus } from './types'
import { Badge, Empty, PageHeader, Tabs, dayTime } from './ui'
import { MessageRenderer } from './MessageRenderer'
import type { Preview } from './PreviewPane'

export type JobController = {
  jobs: Job[]
  create: (value: { title?: string; goal: string; runAt?: number | null; repeat?: Job['repeat'] }) => Promise<Job | undefined>
  act: (id: string, action: 'pause' | 'resume' | 'cancel' | 'start' | 'remove' | 'approve', decision?: 'once' | 'session' | 'always' | 'deny', approvalId?: string) => Promise<Job | null | undefined>
  instruct: (id: string, text: string) => Promise<Job | undefined>
}
type Controller = JobController
type Tab = 'active' | 'scheduled' | 'finished' | 'changes'

const statusInfo: Record<JobStatus, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: 'info' }, running: { label: '运行中', tone: 'live' }, waiting: { label: '等你确认', tone: 'warn' }, scheduled: { label: '已安排', tone: 'info' },
  paused: { label: '已暂停', tone: 'muted' }, done: { label: '已完成', tone: 'ok' }, failed: { label: '失败', tone: 'bad' }, unverified: { label: '结果待核对', tone: 'warn' }, cancelled: { label: '已取消', tone: 'muted' }, interrupted: { label: '待恢复', tone: 'warn' },
}
const repeatLabel = { hourly: '每小时', daily: '每天', weekly: '每周' } as const
const examples = ['每天早上 8 点联网汇总前一天的科技新闻，存成一份文档', '检查「下载」文件夹，按类型给出整理方案（先不要移动文件）', '每周五下午整理本周的待办，生成周报草稿']

function StatusPill({ status }: { status: JobStatus }) {
  const info = statusInfo[status]
  return <span className={'job-pill ' + info.tone}>{status === 'running' && <SpinnerGap size={12} className="spin" />}{status === 'waiting' && <HandPalm size={12} weight="fill" />}{t(info.label)}</span>
}

function startOptions() {
  const at = (days: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime() }
  const now = new Date()
  return [
    { id: 'now', label: '马上开始', time: null as number | null },
    { id: 'hour', label: '1 小时后', time: Date.now() + 3600_000 },
    ...(now.getHours() < 20 ? [{ id: 'tonight', label: '今晚 20:00', time: at(0, 20) }] : []),
    { id: 'morning', label: '明早 8:00', time: at(now.getHours() < 8 ? 0 : 1, 8) },
    { id: 'custom', label: '自定义时间…', time: -1 },
  ]
}

function NewJob({ create, onCreated }: { create: Controller['create']; onCreated: (job: Job) => void }) {
  const [goal, setGoal] = useState('')
  const [when, setWhen] = useState('now')
  const [custom, setCustom] = useState('')
  const [repeat, setRepeat] = useState<'' | 'hourly' | 'daily' | 'weekly'>('')
  const [busy, setBusy] = useState(false)
  const options = useMemo(startOptions, [])
  const submit = async () => {
    const choice = options.find(item => item.id === when)
    const time = when === 'custom' ? (custom ? new Date(custom).getTime() : NaN) : choice?.time ?? null
    if (when === 'custom' && !Number.isFinite(time)) return
    setBusy(true)
    const job = await create({ goal, runAt: time, repeat: repeat || null })
    setBusy(false)
    if (job) { setGoal(''); setWhen('now'); setRepeat(''); onCreated(job) }
  }
  return <section className="job-new" aria-label={t("新建后台任务")}>
    <textarea value={goal} onChange={event => setGoal(event.target.value)} rows={3} placeholder={t("交给我一件事，然后你可以去忙别的。写清楚想要什么结果，例如：每天早上 8 点汇总科技新闻并存成文档")} aria-label={t("后台任务内容")} />
    <div className="job-new-row">
      <label><Clock size={14} /><select value={when} onChange={event => setWhen(event.target.value)} aria-label={t("开始时间")}>{options.map(item => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></label>
      {when === 'custom' && <input type="datetime-local" value={custom} onChange={event => setCustom(event.target.value)} aria-label={t("自定义开始时间")} />}
      <label><Repeat size={14} /><select value={repeat} onChange={event => setRepeat(event.target.value as typeof repeat)} aria-label={t("重复")}><option value="">{t("不重复")}</option><option value="hourly">{t("每小时")}</option><option value="daily">{t("每天")}</option><option value="weekly">{t("每周")}</option></select></label>
      <button type="button" className="button primary" disabled={busy || goal.trim().length < 4 || (when === 'custom' && !custom)} onClick={() => void submit()}><Lightning size={15} weight="fill" />{when === 'now' ? t("开始") : t("安排")}</button>
    </div>
    {!goal && <div className="job-examples">{examples.map(item => <button type="button" key={item} onClick={() => setGoal(item)}>{item}</button>)}</div>}
  </section>
}

export function ApprovalCard({ job, act }: { job: Job; act: Controller['act'] }) {
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState('')
  const answer = async (decision: 'once' | 'session' | 'deny') => {
    if (submitting) return
    setSubmitting(true); setError('')
    try { if (!await act(job.id, 'approve', decision, job.approval?.id)) setError(t('确认未能提交，请检查连接后再试。')) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSubmitting(false) }
  }
  const approval = job.approval!
  return <div className={'job-approval ' + approval.risk} role="alert">
    <div className="job-approval-head"><ShieldWarning size={18} weight="fill" /><div><b>{approval.title}</b><small>{t("后台任务「")}{job.title}{t("」在等你")}</small></div></div>
    <ul>{approval.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
    <div className="job-approval-actions">
      <button type="button" className="button primary" disabled={submitting} onClick={() => void answer('once')}>{submitting ? t('正在提交…') : t("允许这一次")}</button>
      {approval.allowSession && <button type="button" className="button secondary" disabled={submitting} onClick={() => void answer('session')}>{t("这个任务里都允许")}</button>}
      <button type="button" className="button secondary danger" disabled={submitting} onClick={() => void answer('deny')}>{t("拒绝")}</button>
    </div>
    {error && <p className="work-send-error" role="alert">{error}</p>}
  </div>
}

function JobCard({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }) {
  const last = [...job.log].reverse().find(item => item.kind === 'step' || item.kind === 'agent')
  return <button type="button" className={'job-card ' + (selected ? 'selected ' : '') + job.status} onClick={onSelect}>
    <div className="job-card-top"><b>{job.title}</b><StatusPill status={job.status} /></div>
    <p>{job.status === 'scheduled' && job.runAt ? t("下一次：{p0}", { p0: dayTime(job.runAt) }) : last ? last.text.replace(/\s+/g, ' ').slice(0, 90) : job.goal.slice(0, 90)}</p>
    <div className="job-card-meta">{job.repeat && <span><Repeat size={12} />{repeatLabel[job.repeat]}</span>}{job.steps > 0 && <span>{job.steps}{t("步")}</span>}{job.runs > 1 && <span>{t("第")}{job.runs}{t("次")}</span>}<span>{dayTime(job.updatedAt)}</span></div>
  </button>
}

function JobDetail({ job, ctl, onClose, preview }: { job: Job; ctl: Controller; onClose: () => void; preview: (value: Preview) => void }) {
  const [text, setText] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => { setConfirmDelete(false); setText('') }, [job.id])
  const live = ['running', 'waiting', 'queued'].includes(job.status)
  const send = async () => { if (!text.trim()) return; const done = await ctl.instruct(job.id, text); if (done) setText('') }
  return <aside className="job-detail" aria-label={t("任务详情")}>
    <div className="job-detail-head">
      <div><StatusPill status={job.status} /><h2>{job.title}</h2></div>
      <button type="button" className="icon-button job-close" aria-label={t("关闭详情")} onClick={onClose}><XCircle size={20} /></button>
    </div>
    <div className="job-controls">
      {job.status === 'scheduled' && <button type="button" className="button secondary" onClick={() => void ctl.act(job.id, 'start')}><Play size={14} weight="fill" />{t("现在开始")}</button>}
      {['running', 'queued', 'scheduled'].includes(job.status) && <button type="button" className="button secondary" onClick={() => void ctl.act(job.id, 'pause')}><Pause size={14} weight="fill" />{t("暂停")}</button>}
      {['paused', 'interrupted', 'failed', 'unverified', 'cancelled'].includes(job.status) && <button type="button" className="button secondary" onClick={() => void ctl.act(job.id, 'resume')}><ArrowCounterClockwise size={14} />{t("检查进度并继续")}</button>}
      {(live || job.status === 'scheduled' || job.status === 'paused') && <button type="button" className="button secondary danger" onClick={() => void ctl.act(job.id, 'cancel')}><Stop size={14} weight="fill" />{t("取消")}</button>}
      {!live && (confirmDelete
        ? <button type="button" className="button secondary danger" onClick={() => { void ctl.act(job.id, 'remove'); onClose() }}>{t("确认删除")}</button>
        : <button type="button" className="button secondary" onClick={() => setConfirmDelete(true)}><Trash size={14} />{t("删除")}</button>)}
    </div>
    <p className="job-goal">{job.goal}</p>
    {job.acceptance?.requirementsCheck && <RequirementChecks report={job.acceptance.requirementsCheck} />}
    <dl className="job-facts">
      <div><dt>{t("创建")}</dt><dd>{dayTime(job.createdAt)}</dd></div>
      {job.runAt && <div><dt>{t("下次运行")}</dt><dd>{dayTime(job.runAt)}</dd></div>}
      {job.repeat && <div><dt>{t("重复")}</dt><dd>{repeatLabel[job.repeat]}</dd></div>}
      <div><dt>{t("已执行")}</dt><dd>{job.steps}{t("步 ·")}{job.runs}{t("次")}</dd></div>
    </dl>
    {job.approval && <ApprovalCard job={job} act={ctl.act} />}
    {job.error && <div className="job-error"><WarningCircle size={15} weight="fill" />{job.error}</div>}
    {job.result && <section className="job-result"><h3>{t("已有结果")}</h3><MessageRenderer content={job.result} onPreview={preview} /></section>}
    <section className="job-timeline" aria-label={t("进度记录")}>
      <h3>{t("进度")}</h3>
      <ol>{job.log.map((item, index) => <li key={index} className={item.kind + (item.ok === false ? ' failed' : '')}><span className="tl-dot">{item.kind === 'step' ? (item.ok === false ? <WarningCircle size={13} weight="fill" /> : <CheckCircle size={13} weight="fill" />) : null}</span><div><span className="tl-text">{item.kind === 'user' ? t("你补充：") : ''}{item.text.length > 400 && item.kind === 'agent' ? item.text.slice(0, 400) + '…' : item.text}</span>{item.error && <small>{item.error}</small>}<time>{dayTime(item.ts)}</time></div></li>)}</ol>
    </section>
    <form className="job-instruct" onSubmit={event => { event.preventDefault(); void send() }}>
      <input value={text} onChange={event => setText(event.target.value)} placeholder={live ? t("补充一句，它会在下一步看到…") : job.status === 'done' ? t("还想让它接着做点什么？") : t("补充说明…")} aria-label={t("给任务补充说明")} />
      <button type="submit" className="button secondary" disabled={!text.trim()}>{t("发送")}</button>
    </form>
  </aside>
}

function Changes({ items, reload, notify }: { items: Checkpoint[]; reload: () => void; notify: (text: string) => void }) {
  const [armed, setArmed] = useState('')
  const undo = async (item: Checkpoint) => {
    if (armed !== item.id) { setArmed(item.id); return }
    try { const done = await window.memoryDesktop!.revertCheckpoint(item.id); notify(done.restored); reload() }
    catch (error) { notify(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '撤销失败') }
    setArmed('')
  }
  if (!items.length) return <Empty icon={ArrowCounterClockwise} title={t("还没有改动记录")} text={t("助手每次修改或覆盖你的文件前，都会先保留一份原件。出了问题可以在这里一键撤销。")} />
  return <ul className="change-list">{items.map(item => <li key={item.id} className={item.status}>
    <div><b>{item.summary}</b><code>{item.path}</code><small>{dayTime(item.ts)}{item.by ? ' · ' + item.by : ''}</small></div>
    {item.status === 'active' ? <button type="button" className={'button secondary' + (armed === item.id ? ' danger' : '')} onClick={() => void undo(item)} onBlur={() => setArmed('')}><ArrowCounterClockwise size={14} />{armed === item.id ? (item.existed ? t("确认恢复原样") : t("确认删除此文件")) : t("撤销")}</button> : <Badge>{t("已撤销")}</Badge>}
  </li>)}</ul>
}

export function JobsPage({ ctl, checkpoints, reloadCheckpoints, notify, focusId, clearFocus, preview, initialTab = 'active' }: { ctl: Controller; checkpoints: Checkpoint[]; reloadCheckpoints: () => void; notify: (text: string) => void; focusId: string; clearFocus: () => void; preview: (value: Preview) => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [selectedId, setSelectedId] = useState('')
  const groups = useMemo(() => ({
    active: ctl.jobs.filter(item => ['running', 'waiting', 'queued', 'paused', 'interrupted', 'unverified'].includes(item.status)),
    scheduled: ctl.jobs.filter(item => item.status === 'scheduled'),
    finished: ctl.jobs.filter(item => ['done', 'failed', 'cancelled'].includes(item.status)),
  }), [ctl.jobs])
  useEffect(() => {
    if (!focusId) return
    const job = ctl.jobs.find(item => item.id === focusId)
    if (job) { setTab(['running', 'waiting', 'queued', 'paused', 'interrupted', 'unverified'].includes(job.status) ? 'active' : job.status === 'scheduled' ? 'scheduled' : 'finished'); setSelectedId(job.id) }
    clearFocus()
  }, [focusId, ctl.jobs])
  const waiting = ctl.jobs.filter(item => item.approval)
  const selected = ctl.jobs.find(item => item.id === selectedId)
  const list = tab === 'changes' ? [] : groups[tab]
  if (!window.memoryDesktop) return <div className="page"><Empty icon={Clock} title={t("定时与后台")} text={t("在桌面程序中安排任务，查看执行与更改记录。")} /></div>
  return <div className="page jobs-page">
    <PageHeader eyebrow="BACKGROUND" title={t("后台任务")} description={t("把耗时的、要定时的、要反复做的事交给我，你可以离开。需要你确认时会通知你，所有改动都能撤销。")} />
    {tab !== 'changes' && <NewJob create={ctl.create} onCreated={job => { setTab(job.status === 'scheduled' ? 'scheduled' : 'active'); setSelectedId(job.id) }} />}
    {waiting.length > 0 && <div className="job-attention-summary" role="status"><ShieldWarning size={17} /><span>{t('{p0} 件任务等待确认', { p0: waiting.length })}</span><button type="button" className="presence-text-link" onClick={() => { setTab('active'); setSelectedId(waiting[0].id) }}>{t('查看并处理')}</button></div>}
    <Tabs value={tab} onChange={setTab} items={[{ id: 'active', label: '执行与恢复', count: groups.active.length }, { id: 'scheduled', label: '定时', count: groups.scheduled.length }, { id: 'finished', label: '已结束', count: groups.finished.length }, { id: 'changes', label: '改动记录', count: checkpoints.filter(item => item.status === 'active').length }]} />
    {tab === 'changes' ? <Changes items={checkpoints} reload={reloadCheckpoints} notify={notify} /> :
      <div className={'jobs-layout' + (selected ? ' has-detail' : '')}>
        <div className="job-list">
          {list.length === 0 && <Empty icon={tab === 'scheduled' ? CalendarBlank : Gear} title={tab === 'active' ? t("现在没有进行中的任务") : tab === 'scheduled' ? t("没有定时任务") : t("还没有结束的任务")} text={tab === 'active' ? t("在上面写一件事，或在对话里说“这个放到后台去做”。") : tab === 'scheduled' ? t("给任务选一个开始时间，或设置重复周期，它会准时开始。") : t("做完的任务和结果会留在这里。")} />}
          {list.map(job => <JobCard key={job.id} job={job} selected={job.id === selectedId} onSelect={() => setSelectedId(job.id === selectedId ? '' : job.id)} />)}
        </div>
        {selected && <JobDetail job={selected} ctl={ctl} preview={preview} onClose={() => setSelectedId('')} />}
      </div>}
  </div>
}
