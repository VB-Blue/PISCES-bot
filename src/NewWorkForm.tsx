import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Clock, Paperclip, SpinnerGap } from '@phosphor-icons/react'
import type { Job, ProviderStore } from './types'
import { t } from './i18n'
import { cleanError } from './ui'

export type NewWorkValue = { goal: string; runAt?: number | null; repeat?: Job['repeat']; profile?: string }

// Drafts are local UI preferences. Only jobs:create creates an executable task.
export function NewWorkForm({ draft, changeDraft, create, compact = false, available = true }: { draft: string; changeDraft: (value: string, expected?: string) => void; create: (value: NewWorkValue) => Promise<boolean>; compact?: boolean; available?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [scheduled, setScheduled] = useState(false), [when, setWhen] = useState(''), [repeat, setRepeat] = useState<Job['repeat']>(null)
  // With more than one AI service the task can be pinned to one; otherwise it is assigned automatically.
  const [services, setServices] = useState<ProviderStore | null>(null), [profile, setProfile] = useState('')
  useEffect(() => { window.memoryDesktop?.providers?.().then(setServices).catch(() => setServices(null)) }, [])
  const submit = async () => {
    if (busy || !draft.trim() || !available) return
    const runAt = scheduled && when ? new Date(when).getTime() : null
    if (scheduled && (!runAt || !Number.isFinite(runAt) || runAt <= Date.now())) { setError(t('请选择未来的开始时间')); return }
    const sent = draft
    setBusy(true); setError('')
    try {
      if (await create({ goal: sent.trim(), runAt, repeat, ...(profile ? { profile } : {}) })) { changeDraft('', sent); setScheduled(false); setWhen(''); setRepeat(null) }
      else setError(t('任务未能创建，要求已保留。请检查连接后再试。'))
    } catch (reason) { setError(cleanError(reason)) }
    finally { setBusy(false) }
  }
  const attach = async () => {
    try {
      const files = await window.memoryDesktop?.pickFiles() || []
      const paths = files.map(file => file.path).filter(Boolean)
      if (paths.length) { changeDraft((draft ? draft + '\n\n' : '') + t('资料路径：') + '\n' + paths.join('\n')); input.current?.focus() }
    } catch (reason) { setError(cleanError(reason)) }
  }
  return <form className={'new-work-form' + (compact ? ' compact' : '')} aria-label={t('创建执行任务')} onSubmit={event => { event.preventDefault(); void submit() }}>
    {!compact && <div className="new-work-intro"><h2>{t('交给助手一件事')}</h2><p>{t('写清楚想得到的结果、资料位置和必要约束。任务创建后，计划、执行和结果会留在同一个工作现场。')}</p></div>}
    <label className="new-work-goal"><span>{t('要完成什么')}</span><textarea ref={input} autoFocus={!compact} aria-label={t('新任务目标')} placeholder={t('例如：读取这个目录的资料和销售表，统计各地区销售额，生成经营报告并核对结果。')} value={draft} maxLength={16000} disabled={busy} rows={compact ? 3 : 6} onChange={event => changeDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} /></label>
    <div className="new-work-options"><button type="button" disabled={busy || !available} onClick={() => void attach()}><Paperclip size={16} />{t('添加资料')}</button><button type="button" disabled={busy} aria-pressed={scheduled} onClick={() => setScheduled(value => !value)}><Clock size={16} />{scheduled ? t('已设置开始时间') : t('安排开始时间')}</button>{(services?.profiles.length ?? 0) > 1 && <select className="profile-picker" aria-label={t('这个任务使用的 AI 服务')} value={services!.profiles.some(item => item.id === profile) ? profile : ''} disabled={busy} onChange={event => setProfile(event.target.value)}><option value="">{t('自动：按任务能力分配')}</option>{services!.profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select>}</div>
    {scheduled && <div className="new-work-schedule"><label>{t('开始时间')}<input type="datetime-local" aria-label={t('任务开始时间')} value={when} onChange={event => setWhen(event.target.value)} disabled={busy} /></label><label>{t('重复')}<select aria-label={t('任务重复周期')} value={repeat || ''} onChange={event => setRepeat(event.target.value as Job['repeat'] || null)} disabled={busy}><option value="">{t('不重复')}</option><option value="hourly">{t('每小时')}</option><option value="daily">{t('每天')}</option><option value="weekly">{t('每周')}</option></select></label></div>}
    {error && <p className="work-send-error" role="alert">{error}</p>}
    {!available && <p className="work-send-error" role="status">{t('请在桌面程序中创建和执行任务。')}</p>}
    <div className="new-work-submit"><small>{t('草稿保存在本机 · Ctrl+Enter 开始')}</small><button className="button primary" type="submit" disabled={busy || draft.trim().length < 4 || !available}>{busy ? <SpinnerGap className="spin" size={16} /> : <ArrowRight size={16} />}{scheduled ? t('创建并安排') : t('开始任务')}</button></div>
  </form>
}
