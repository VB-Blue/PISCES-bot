import { t } from './i18n'
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { ArrowsClockwise, Bell, Check, Clock, Plus, Target, Trash, X } from '@phosphor-icons/react'
import type { Reminder, Workspace } from './types'
import { Badge, Empty, IconButton, PageHeader, cleanError } from './ui'

const delays = [[1, '1 分钟后'], [5, '5 分钟后'], [10, '10 分钟后'], [30, '30 分钟后'], [60, '1 小时后'], [120, '2 小时后']] as const
const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)

export function GoalsPage({ workspace, setWorkspace, reminders, setReminders, notify }: {
  workspace: Workspace; setWorkspace: Dispatch<SetStateAction<Workspace>>; reminders: Reminder[]; setReminders: Dispatch<SetStateAction<Reminder[]>>; notify: (text: string) => void
}) {
  const [goalInput, setGoalInput] = useState('')
  const [content, setContent] = useState('')
  const [when, setWhen] = useState<'delay' | 'at'>('delay')
  const [minutes, setMinutes] = useState(10)
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 3600_000)))
  const [repeat, setRepeat] = useState<'' | 'daily' | 'weekly'>('')
  const ordered = useMemo(() => [...reminders].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (a.status === 'pending' ? a.triggerAt - b.triggerAt : b.triggerAt - a.triggerAt)), [reminders])
  const pending = reminders.filter(item => item.status === 'pending').length

  const create = async () => {
    if (!content.trim() || !window.memoryDesktop) return
    try {
      const target = new Date(at).getTime()
      if (when === 'at' && !(target > Date.now())) return notify('提醒时间必须晚于现在')
      const created = await window.memoryDesktop.createReminder({ content: content.trim(), ...(when === 'delay' ? { delaySeconds: minutes * 60 } : { targetTime: new Date(at).toISOString() }), ...(repeat ? { repeat } : {}) })
      setReminders(previous => [...previous, created]); setContent(''); notify(`已设定提醒：${created.targetDateStr}`)
    } catch (error) { notify(cleanError(error)) }
  }
  const cancel = async (item: Reminder) => { try { await window.memoryDesktop?.cancelReminder(item.id); setReminders(previous => previous.map(entry => entry.id === item.id ? { ...entry, status: 'cancelled' } : entry)) } catch (error) { notify(cleanError(error)) } }
  const remove = async (item: Reminder) => { try { await window.memoryDesktop?.deleteReminder(item.id); setReminders(previous => previous.filter(entry => entry.id !== item.id)) } catch (error) { notify(cleanError(error)) } }

  return <section className="page">
    <PageHeader eyebrow="KEEP THE NEXT STEP IN SIGHT" title={t("目标与提醒")} description={t("待办会告诉 AI（它回答时会参考未完成的目标）；提醒到点会在 Windows 通知里弹出，也可以直接对 AI 说。")} />
    <div className="section-heading"><h3>{t("待办目标")}</h3><Badge>{workspace.goals.filter(goal => !goal.done).length}{t("项未完成")}</Badge></div>
    <form className="goal-form" onSubmit={event => { event.preventDefault(); if (!goalInput.trim()) return; setWorkspace(previous => ({ ...previous, goals: [...previous.goals, { id: crypto.randomUUID(), title: goalInput.trim(), done: false }] })); setGoalInput('') }}>
      <Plus size={19} /><input value={goalInput} onChange={event => setGoalInput(event.target.value)} placeholder={t("添加一个待办，例如：本周把季度报告写完")} aria-label={t("新目标")} /><button className="button primary" disabled={!goalInput.trim()}>{t("添加")}</button></form>
    <div className="goal-list">{workspace.goals.length ? workspace.goals.map(goal => <div key={goal.id} className={`goal-row ${goal.done ? 'done' : ''}`}>
      <button className="goal-check" aria-label={t("{p0}目标 {p1}", { p0: goal.done ? '重新打开' : '完成', p1: goal.title })} onClick={() => setWorkspace(previous => ({ ...previous, goals: previous.goals.map(item => item.id === goal.id ? { ...item, done: !item.done } : item) }))}>{goal.done && <Check size={13} weight="bold" />}</button>
      <span>{goal.title}</span><IconButton label={t("删除目标 {p0}", { p0: goal.title })} onClick={() => setWorkspace(previous => ({ ...previous, goals: previous.goals.filter(item => item.id !== goal.id) }))}><Trash size={16} /></IconButton></div>)
      : <Empty icon={Target} title={t("还没有待办")} text={t("添加后，助手在回答相关问题时会参考你的目标。")} />}</div>

    <div className="section-heading reminders-heading"><h3>{t("定时提醒")}</h3><Badge tone={pending ? 'green' : ''}>{pending}{t("个待提醒")}</Badge></div>
    <form className="reminder-form" onSubmit={event => { event.preventDefault(); void create() }}>
      <div className="goal-form"><Clock size={19} /><input value={content} onChange={event => setContent(event.target.value)} placeholder={t("提醒我什么？例如：下午三点开会")} aria-label={t("提醒内容")} maxLength={200} /></div>
      <div className="reminder-options">
        <select value={when} onChange={event => setWhen(event.target.value as 'delay' | 'at')} aria-label={t("时间方式")}><option value="delay">{t("多久之后")}</option><option value="at">{t("指定时间")}</option></select>
        {when === 'delay' ? <select value={minutes} onChange={event => setMinutes(Number(event.target.value))} aria-label={t("多久之后")}>{delays.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
          : <input type="datetime-local" value={at} min={localInput(new Date())} onChange={event => setAt(event.target.value)} aria-label={t("提醒时间")} />}
        <select value={repeat} onChange={event => setRepeat(event.target.value as '' | 'daily' | 'weekly')} aria-label={t("重复")}><option value="">{t("不重复")}</option><option value="daily">{t("每天")}</option><option value="weekly">{t("每周")}</option></select>
        <button className="button primary" disabled={!content.trim() || !window.memoryDesktop}><Plus size={15} />{t("设定提醒")}</button></div>
      {!window.memoryDesktop && <p className="field-note">{t("网页预览不能设定系统提醒，请使用桌面程序。")}</p>}
    </form>
    <div className="goal-list">{ordered.length ? ordered.map(item => <div key={item.id} className={`goal-row ${item.status !== 'pending' ? 'done' : ''}`}>
      <span className="reminder-icon">{item.repeat ? <ArrowsClockwise size={18} /> : <Bell size={18} weight={item.status === 'fired' ? 'fill' : 'regular'} />}</span>
      <div className="reminder-text"><b>{item.content}</b><small>{item.status === 'pending' ? t("下次：") : item.status === 'fired' ? t("提醒于：") : t("原定：")}{item.targetDateStr}{item.repeat && t(" · 每{p0}", { p0: item.repeat === 'daily' ? '天' : '周' })}{item.late && t(" · 上次因程序未运行而延迟")}</small></div>
      <Badge tone={item.status === 'pending' ? 'green' : ''}>{item.status === 'pending' ? t("待提醒") : item.status === 'fired' ? t("已提醒") : t("已取消")}</Badge>
      {item.status === 'pending' && <IconButton label={t("取消提醒")} onClick={() => void cancel(item)}><X size={16} /></IconButton>}
      <IconButton label={t("删除记录")} onClick={() => void remove(item)}><Trash size={16} /></IconButton></div>)
      : <Empty icon={Clock} title={t("暂无提醒")} text={t("在上面添加，或对助手说“十分钟后提醒我喝水”“每天早上九点提醒我看邮件”。程序需要在后台运行，设置里可选开机自启。")} />}</div>
  </section>
}
