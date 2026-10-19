import { t, currentLocale } from './i18n'
import { useState, type ReactNode } from 'react'
import { ArrowRight, ArrowUpRight, ChartBar, BellSlash, CheckCircle, Clock, FileText, Fingerprint, Folder, MagnifyingGlass, Monitor, Plus, WarningCircle } from '@phosphor-icons/react'
import type { Checkpoint, Message, MemoryItem, Session, UserUnderstanding } from './types'
import { collectEvents, entrySteps, workStatus, type WorkEntry } from './presenceModel'
import { dayTime } from './ui'
import type { Preview } from './PreviewPane'
import { inferWorkKind, kindNames, workPhase, workTitle } from './workPresentation'
import { needsAttention, type WorkFilter } from './workbenchState'

function WorkRow({ entry, open }: { entry: WorkEntry; open: (entry: WorkEntry) => void }) {
  const steps = entrySteps(entry)
  const kind = inferWorkKind(entry), phase = workPhase(entry), Icon = {document:FileText,data:FileText,files:Folder,research:MagnifyingGlass,desktop:Monitor,followup:Clock,general:CheckCircle}[kind]
  return <button type="button" className="presence-work-row" onClick={() => open(entry)}>
    <div className="home-work-type"><Icon size={18} /><span>{t(kindNames[kind])}</span><span className={'presence-status ' + phase}>{t(entry.status)}</span></div>
    <div className="presence-row-heading"><b title={entry.title}>{t(workTitle(entry))}</b><ArrowUpRight size={19} /></div>
    <p>{entry.work?.receipts.at(-1) ? t(steps.at(-1)?.label) + ' · ' + t(workStatus(entry.work.receipts.at(-1)!.status)) : entry.summary}</p>
    <div className="home-work-footer">{steps.length ? <span>{steps.at(-1)?.status === 'failed' ? <WarningCircle size={14} /> : <CheckCircle size={14} />}{t(steps.at(-1)?.label)}<small>{t("操作记录：{p0}", { p0: steps.length })}</small></span> : <span><Clock size={14} />{entry.record ? t("已有跟进安排") : t("等待新的操作记录")}</span>}<small>{dayTime(entry.time)}</small></div>
  </button>
}

export function PresenceHome({ entries, checkpoints, memories, latest, composer, open, openWork, openMemory, away, desktop, busy, name, facts = [], suggest }: {
  entries: WorkEntry[]; checkpoints: Checkpoint[]; memories: MemoryItem[]; latest?: Message; composer: ReactNode
  open: (entry: WorkEntry) => void; openWork: (filter?: WorkFilter) => void; openMemory: () => void; away: () => void; desktop: boolean; busy: boolean; name: string; facts?: UserUnderstanding[]; suggest?: (text: string) => void
}) {
  const events = collectEvents(entries, checkpoints)
  const eventText = (event: (typeof events)[number]) => {
    const entry = entries.find(item => item.id === event.entryId)
    if (entry && (!entry.job || !entry.job.log.length)) return entry.title + ' · ' + t(entry.status)
    const point = checkpoints.find(item => 'change:' + item.id === event.id)
    return point ? t(point.status === 'reverted' ? '已撤销：{p0}' : '文件已更改：{p0}', { p0: point.path.split(/[\\/]/).at(-1) }) : event.text
  }
  const ongoing = entries.filter(entry => ['planning','executing'].includes(workPhase(entry)))
  const attention = entries.filter(needsAttention), completed = entries.filter(entry => workPhase(entry) === 'result')
  const shown = [...attention, ...ongoing, ...entries.filter(entry => !needsAttention(entry) && !ongoing.includes(entry))].slice(0, 2)
  const [expanded, setExpanded] = useState(false)
  const usedPreference = latest?.memoryUsed?.find(item => item.kind === 'preference' || item.kind === 'lesson')
  const preference = memories.find(item => (item.kind === 'preference' || item.kind === 'lesson') && (item.source === 'user' || item.source === 'feedback'))
  const confirmed = facts.find(fact => fact.status === 'confirmed' && !fact.pending_update)
  const preferenceText = usedPreference?.text || confirmed?.value || preference?.text
  const pendingFacts = facts.filter(fact => fact.status !== 'confirmed' || fact.pending_update).length
  const date = new Date().toLocaleDateString(currentLocale(), { month: 'long', day: 'numeric', weekday: 'long' })
  return <section className="presence-home">
    <div className="presence-intro"><div><span className="presence-eyebrow">{date}<span>·</span>{t("{p0}在这里", { p0: name })}</span><h1>{attention.length ? t("有 {p0} 件事情需要你。", { p0: attention.length }) : busy || ongoing.length ? t("事情在继续。") : entries.length ? t("进展都在这里。") : t("今天，从一件事开始。")}</h1><p>{attention.length ? t("先处理需要确认或核对的事项，再接着往下做。") : ongoing.length ? t("{p0} 件事正在推进，新的进展会回到这里。", { p0: ongoing.length }) : entries.length ? t("已有的结果、要求与安排都留着，随时继续。") : t("告诉我你想完成什么，我们从这里一起往下做。")}</p></div>{desktop && <button type="button" className="presence-away" onClick={away}><BellSlash size={17} />{t("我先去忙")}</button>}</div>
    {entries.length > 0 && <div className="home-overview" aria-label={t("工作概览")}><button type="button" onClick={() => openWork('attention')}><span className="overview-dot attention" />{t("需处理")}<b>{attention.length}</b></button><button type="button" onClick={() => openWork('active')}><span className="overview-dot active" />{t("正在推进")}<b>{ongoing.length}</b></button><button type="button" onClick={() => openWork('finished')}><span className="overview-dot" />{t("已有结果")}<b>{completed.length}</b></button><button type="button" className="home-overview-all" onClick={() => openWork()}>{t("全部工作")}<ArrowRight size={15} /></button></div>}
    <div className="presence-home-grid">
      <div className="presence-current"><div className="presence-section-heading"><span>{attention.length ? t("优先处理") : ongoing.length ? t("正在推进") : t("最近在做")}</span><small>{shown.length > 0 ? t("{p0} 件", { p0: shown.length }) : t("从一句话开始")}</small></div>
        <div className="home-current-work">{shown.length ? shown.map(entry => <WorkRow key={entry.id} entry={entry} open={open} />) : <div className="presence-blank"><span className="home-empty-mark"><Plus size={28} weight="light" /></span><h2>{t("把一件事交给我")}</h2><p>{t("可以从一份文档、一组数据，或一个还没理清的问题开始。")}</p>{suggest && <div className="home-starters">{['帮我写一份周报','一起分析一份数据','整理我的工作资料'].map(text => <button type="button" key={text} onClick={() => suggest(t(text))}><span className="home-starter-label">{text.includes('周报') ? <FileText size={18} /> : text.includes('数据') ? <ChartBar size={18} /> : <Folder size={18} />}{t(text)}</span><ArrowUpRight size={14} /></button>)}</div>}</div>}</div>
        <div className="presence-home-composer"><div className="home-composer-label">{t("交给助手一件新任务")}</div>{composer}</div>
      </div>
      <aside className="presence-changes"><div className="home-activity-panel"><div className="presence-section-heading"><span>{t("最新动态")}</span><span className="home-activity-mark"><span />{t("实际记录")}</span></div>{events.length ? <ol>{events.slice(0, expanded ? 5 : 3).map(event => <li key={event.id}><small>{dayTime(event.time)}</small><button type="button" onClick={() => { const entry = entries.find(item => item.id === event.entryId); if (entry) open(entry); else openWork() }}>{eventText(event)}</button></li>)}</ol> : <div className="home-activity-empty"><Clock size={22} /><p>{t("开始一件事后，新的进展会留在这里。")}</p></div>}{events.length > 3 && <button type="button" className="presence-text-link" onClick={() => setExpanded(value => !value)}>{expanded ? t("收起动态") : t("查看更早的动态")}<ArrowRight size={15} /></button>}</div>
      <button type="button" className="presence-preference" onClick={openMemory}><Fingerprint size={22} /><span><small>{usedPreference ? t("本轮参考的偏好") : confirmed ? t("经过你确认的认识") : preference ? t("你告诉我的偏好") : t("对你的理解")}</small><b>{preferenceText || (pendingFacts ? t("{p0} 条认识等待你核对", { p0: pendingFacts }) : t("把你的习惯告诉我"))}</b><small>{usedPreference ? t("来自本轮记忆使用记录") : preferenceText ? t("可查看、纠正与删除") : t("每条认识都可以查看来源与纠正")}<ArrowRight size={13} /></small></span></button></aside>
    </div>
  </section>
}

export { WorkScene } from './WorkScene'

export function HistoryPage({ sessions, runningSessions = [], query, setQuery, open, remove, create }: { sessions: Session[]; runningSessions?: string[]; query: string; setQuery: (value: string) => void; open: (session: Session) => void; remove: (session: Session) => void; create: () => void }) {
  const shown = sessions.filter(session => (session.messages.length || session.draft?.trim()) && (!query.trim() || (session.title + session.messages.map(message => message.content).join('\n')).includes(query.trim())))
  return <section className="presence-history"><div className="presence-page-heading"><div><h1>{t("交流记录")}</h1><p>{t("之前说过的事情都在这里，随时回来继续。")}</p></div><button type="button" className="button secondary" onClick={create}><Plus size={15} />{t("新的交流")}</button></div><input className="history-query" aria-label={t("搜索交流记录")} placeholder={t("搜索标题或内容…")} value={query} onChange={event => setQuery(event.target.value)} />{shown.length ? shown.map(session => <div className="presence-history-row session-row" key={session.id}><button type="button" onClick={() => open(session)}><span><b>{session.title}</b><small>{runningSessions.includes(session.id) && <>{t("正在回复")} · </>}{dayTime(session.updated)} · {session.messages.length}{t("条消息")}</small></span><ArrowRight size={15} /></button><button type="button" className="history-remove" aria-label={t("删除对话 {p0}", { p0: session.title })} onClick={() => remove(session)}>{t("删除")}</button></div>) : <div className="presence-blank"><h2>{query ? t("没有匹配的交流") : t("从第一件事开始")}</h2><p>{t("你的交流记录保存在本机。")}</p></div>}</section>
}
