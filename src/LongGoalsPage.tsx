import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Clock, Pause, PencilSimple, Play, Plus, Stop, Target } from '@phosphor-icons/react'
import type { LongGoal, LongGoalConfig, ProviderStore } from './types'
import { t, systemText } from './i18n'
import { cleanError, dayTime } from './ui'
import './long-goals.css'

type Draft = { title: string; objective: string; criteria: string; constraints: string; watchPaths: string; minIntervalMinutes: string; maxIntervalMinutes: string; dailyTokenLimit: string; runTokenLimit: string; profile: string }
const fresh = (): Draft => ({ title: '', objective: '', criteria: '', constraints: '', watchPaths: '', minIntervalMinutes: '60', maxIntervalMinutes: '360', dailyTokenLimit: '200000', runTokenLimit: '80000', profile: '' })
const draftFor = (goal: LongGoal): Draft => ({ title: goal.title, objective: goal.objective, criteria: goal.criteria || '', constraints: goal.constraints || '', watchPaths: goal.watchPaths?.join('\n') || '', minIntervalMinutes: String(goal.minIntervalMinutes), maxIntervalMinutes: String(goal.maxIntervalMinutes), dailyTokenLimit: String(goal.dailyTokenLimit), runTokenLimit: String(goal.runTokenLimit), profile: goal.profile || '' })
const names: Record<LongGoal['status'], string> = { active: '持续运行', reviewing: '复核本轮', attention: '需要处理', budget: '预算暂停', paused: '已暂停', stopped: '已停止' }

export function LongGoalsPage({ openJob, openUsage }: { openJob: (id: string) => void; openUsage: () => void }) {
  const [items, setItems] = useState<LongGoal[]>([]), [selected, setSelected] = useState(''), [editing, setEditing] = useState('')
  const [draft, setDraft] = useState<Draft>(fresh), [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(!window.memoryDesktop)
  const [services, setServices] = useState<ProviderStore | null>(null)
  useEffect(() => { window.memoryDesktop?.providers?.().then(setServices).catch(() => setServices(null)) }, [])
  const chat = (services?.profiles || []).filter(item => (item.kind || 'chat') === 'chat')
  const generation = useRef(0)
  const creationKey = useRef('')
  const merge = (value: LongGoal) => setItems(previous => {
    const prior = previous.find(item => item.id === value.id)
    if (prior && (prior.generation > value.generation || Date.parse(prior.updatedAt) > Date.parse(value.updatedAt))) return previous
    return prior ? previous.map(item => item.id === value.id ? value : item) : [value, ...previous]
  })
  useEffect(() => {
    const api = window.memoryDesktop
    if (!api) return
    let live = true
    const reload = () => { const request = ++generation.current; void api.longGoals().then(values => { if (live && request === generation.current) values.forEach(merge) }).catch(reason => { if (live) setError(cleanError(reason)) }).finally(() => { if (live) setReady(true) }) }
    const offGoal = api.onLongGoal(value => { if (!live) return; if ('error' in value) setError(value.error); else merge(value) })
    const offUsage = api.onUsage(reload)
    reload()
    return () => { live = false; offGoal(); offUsage() }
  }, [])
  useEffect(() => { if (editing === 'new') localStorage.setItem('pisces.longGoal.draft', JSON.stringify(draft)) }, [draft, editing])
  const goal = items.find(item => item.id === selected) || items[0]
  const edit = (value?: LongGoal) => {
    setError('')
    if (value) { setSelected(value.id); setDraft(draftFor(value)); setEditing(value.id) }
    else {
      let saved: Partial<Draft> = {}
      try { saved = JSON.parse(localStorage.getItem('pisces.longGoal.draft') || '{}') } catch {}
      creationKey.current = localStorage.getItem('pisces.longGoal.creationKey') || crypto.randomUUID()
      localStorage.setItem('pisces.longGoal.creationKey', creationKey.current)
      setDraft({ ...fresh(), ...saved }); setEditing('new')
    }
  }
  const save = async () => {
    const api = window.memoryDesktop
    if (!api || busy) return
    setBusy(true); setError('')
    try {
      const current = items.find(item => item.id === editing)
      const config: LongGoalConfig = { title: draft.title, objective: draft.objective, criteria: draft.criteria, constraints: draft.constraints, watchPaths: draft.watchPaths.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        minIntervalMinutes: Number(draft.minIntervalMinutes), maxIntervalMinutes: Number(draft.maxIntervalMinutes), dailyTokenLimit: Number(draft.dailyTokenLimit), runTokenLimit: Number(draft.runTokenLimit),
        profile: draft.profile, ...(current ? { id: current.id, revision: current.revision } : { creationKey: creationKey.current }) }
      const value = await api.saveLongGoal(config); merge(value); setSelected(value.id)
      if (editing === 'new') { localStorage.removeItem('pisces.longGoal.draft'); localStorage.removeItem('pisces.longGoal.creationKey') }
      setEditing('')
    } catch (reason) { setError(cleanError(reason)) }
    finally { setBusy(false) }
  }
  const act = async (action: 'pause' | 'resume' | 'run' | 'stop') => {
    if (!goal || !window.memoryDesktop || busy) return
    setBusy(true); setError('')
    try { merge(await window.memoryDesktop.longGoalAction({ id: goal.id, action })) }
    catch (reason) { setError(cleanError(reason)) }
    finally { setBusy(false) }
  }
  const field = (key: keyof Draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }))
  const canEdit = goal && ['paused', 'attention', 'budget', 'stopped'].includes(goal.status)
  return <section className="long-goals-page">
    <div className="presence-page-heading"><div><h1>{t('长期目标')}</h1><p>{t('定义想持续达成的结果，助手按实际进展安排每一轮工作。')}</p></div><button type="button" className="button primary" disabled={!window.memoryDesktop || busy} onClick={() => edit()}><Plus size={16} />{t('新的长期目标')}</button></div>
    {!window.memoryDesktop && <p className="goal-notice">{t('请在桌面程序中查看实际用量和执行长期目标。')}</p>}
    {error && <p className="goal-notice error-text" role="alert">{systemText(error)}</p>}
    {editing ? <form className="long-goal-editor" aria-label={t('编辑长期目标')} onSubmit={event => { event.preventDefault(); void save() }}>
      <label><span>{t('目标名称（可选）')}</span><input type="text" maxLength={90} value={draft.title} onChange={event => field('title', event.target.value)} /></label>
      <label><span>{t('想持续达成什么')}</span><textarea autoFocus rows={4} required minLength={4} maxLength={6000} value={draft.objective} onChange={event => field('objective', event.target.value)} placeholder={t('用自己的话描述目标、可用资料和希望看到的结果。')} /></label>
      <div className="goal-editor-columns"><label><span>{t('如何检查效果（可选）')}</span><textarea rows={3} maxLength={2000} value={draft.criteria} onChange={event => field('criteria', event.target.value)} /></label><label><span>{t('约束条件（可选）')}</span><textarea rows={3} maxLength={3000} value={draft.constraints} onChange={event => field('constraints', event.target.value)} placeholder={t('例如：资料范围、需要保留的记录、什么时候找你。')} /></label></div>
      <div className="goal-editor-numbers">{([['minIntervalMinutes', '最短检查间隔（分钟）', 5, 10080], ['maxIntervalMinutes', '最长检查间隔（分钟）', Number(draft.minIntervalMinutes) || 5, 43200], ['dailyTokenLimit', '目标每日 token 预算', 1024, 1000000000], ['runTokenLimit', '每轮 token 预算', 1024, Number(draft.dailyTokenLimit) || 1000000000]] as const).map(([key, label, min, max]) => <label key={key}><span>{t(label)}</span><input type="number" required min={min} max={max} step="1" value={draft[key]} onChange={event => field(key, event.target.value)} /></label>)}</div>
      {chat.length > 1 && <label><span>{t('这个目标使用的 AI 服务')}</span><select value={chat.some(item => item.id === draft.profile) ? draft.profile : ''} onChange={event => field('profile', event.target.value)}><option value="">{t('自动：按任务能力分配')}</option>{chat.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>}
      <label><span>{t('仅在这些文件变化后运行（可选，每行一个路径）')}</span><textarea rows={2} value={draft.watchPaths} onChange={event => field('watchPaths', event.target.value)} /><small className="goal-subtle">{t('只监测已授权目录中的文件。来源没有变化时，检查不调用模型；留空则按间隔持续执行。')}</small></label>
      <p className="goal-subtle">{t('沿用已授权工具；新增权限或无法核对的操作会暂停。电脑需保持开机联网，后台需持续运行。')}</p>
      <div className="goal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setEditing('')}>{t('取消')}</button><button className="button primary" disabled={busy || !window.memoryDesktop}>{editing === 'new' ? t('创建并开始') : t('保存为暂停状态')}</button></div>
    </form> : !ready ? <p className="goal-empty-inline">{t('正在读取长期目标…')}</p> : !items.length ? <div className="long-goal-empty"><Target size={32} weight="light" /><h2>{t('把一个持续目标交给助手')}</h2><p>{t('每轮留下真实结果、用量记录与下一步安排，你随时可以暂停或修改。')}</p><button type="button" className="button secondary" disabled={!window.memoryDesktop} onClick={() => edit()}>{t('定义第一个目标')}<ArrowRight size={16} /></button></div> : <div className="long-goal-layout">
      <nav className="long-goal-list" aria-label={t('长期目标列表')}>{items.map(item => <button type="button" key={item.id} aria-current={goal?.id === item.id ? 'true' : undefined} onClick={() => { setSelected(item.id); setError('') }}><span className={'goal-status-dot ' + item.status} /><span><b>{item.title}</b><small>{t(names[item.status])} · {t('已执行 {p0} 轮', { p0: item.cycle })}</small></span></button>)}</nav>
      {goal && <article className="long-goal-detail"><div className="goal-detail-heading"><span className={'goal-state ' + goal.status}>{t(names[goal.status])}</span><div className="goal-actions">{canEdit ? <><button type="button" className="button secondary" disabled={busy} onClick={() => edit(goal)}><PencilSimple size={15} />{t('修改目标')}</button><button type="button" className="button primary" disabled={busy} onClick={() => void act('resume')}><Play size={15} />{t('继续')}</button></> : <button type="button" className="button secondary" disabled={busy} onClick={() => void act('pause')}><Pause size={15} />{t('暂停')}</button>}{goal.status !== 'stopped' && <button type="button" className="button secondary" disabled={busy} onClick={() => void act('stop')}><Stop size={15} />{t('停止')}</button>}</div></div>
        <h2>{goal.title}</h2><p className="goal-objective">{goal.objective}</p>
        {(goal.notice || goal.persistenceError) && <p className="goal-notice" role="status">{systemText(goal.persistenceError || goal.notice)}</p>}
        <dl className="goal-current"><div><dt>{t('下一步')}</dt><dd>{goal.nextAction || t('先检查现状并制定本轮计划')}</dd></div><div><dt>{t('下次执行')}</dt><dd><Clock size={14} />{goal.nextRunAt ? dayTime(new Date(goal.nextRunAt).toISOString()) : goal.jobId && ['active', 'reviewing'].includes(goal.status) ? t('当前轮处理中') : t('等待继续')}</dd></div><div><dt>{t('今日预算占用')}</dt><dd>{goal.usage.accountedTokens.toLocaleString()} / {goal.dailyTokenLimit.toLocaleString()} tokens<button type="button" onClick={openUsage}>{t('查看用量')}</button></dd></div></dl>
        <div className="goal-actions">{goal.jobId && <button type="button" className="button secondary" onClick={() => openJob(goal.jobId!)}>{t('查看当前轮任务')}<ArrowRight size={15} /></button>}{goal.status === 'active' && !goal.jobId && <button type="button" className="button secondary" disabled={busy} onClick={() => void act('run')}><Play size={15} />{t('现在检查')}</button>}</div>
        {(goal.criteria || goal.constraints) && <details className="goal-conditions"><summary>{t('检查标准与约束')}</summary>{goal.criteria && <p>{goal.criteria}</p>}{goal.constraints && <p>{goal.constraints}</p>}</details>}
        <h3 className="goal-section-title">{t('每轮结果与调整')}</h3>{goal.history.length ? <ol className="goal-history">{[...goal.history].reverse().map(item => <li key={item.id}><header><b>{t('第 {p0} 轮', { p0: item.cycle })}</b><time>{dayTime(item.time)}</time><button type="button" onClick={() => openJob(item.jobId)}>{t('查看执行记录')}<ArrowRight size={13} /></button></header><p>{item.summary}</p><details><summary>{t('查看本轮结果')}</summary><p>{item.result}</p></details></li>)}</ol> : <p className="goal-empty-inline">{t('首轮完成并复核后，结果与下一步会留在这里。')}</p>}
      </article>}
    </div>}
  </section>
}
