import { t, systemText } from './i18n'
import { useState } from 'react'
import { Brain, Check, FileText, FolderOpen, SpinnerGap, ThumbsDown, ThumbsUp, WarningCircle, X } from '@phosphor-icons/react'
import type { LearnedItem, Message } from './types'
import { cleanError } from './ui'

// The assistant's own checklist for a long task, kept current as it works.
export function PlanList({ plan }: { plan?: Message['plan'] }) {
  if (!plan?.length) return null
  const done = plan.filter(item => item.status === 'done').length
  return <div className="plan-list" aria-label={t("任务计划")}><div className="plan-head">{t("计划")}{done}/{plan.length}</div>{plan.map((item, index) => <div key={index} className={'plan-item ' + item.status}><span className="plan-mark">{item.status === 'done' ? <Check size={12} weight="bold" /> : item.status === 'doing' ? <SpinnerGap size={12} className="spin" /> : item.status === 'blocked' ? <WarningCircle size={12} /> : null}</span><span>{item.text}</span></div>)}</div>
}

// What the assistant did while answering: one line per tool call, live while the turn runs.
type Step = NonNullable<Message['steps']>[number]
const AGENT_PREFIX = /^\[([^\]]{1,40})\]\s*/
const StepChip = ({ step, label }: { step: Step; label: string }) => <div className={`step-chip ${step.status}${/^切换服务/.test(step.label) ? ' notice' : ''}`} title={systemText(step.error || step.label)}>
  {step.status === 'running' ? <SpinnerGap size={13} className="spin" /> : step.status === 'ok' ? <Check size={13} weight="bold" /> : <WarningCircle size={13} />}
  <span>{systemText(label)}</span>{step.error && <small>{step.error.slice(0, 80)}</small>}</div>

// Steps from sub-agents arrive as "[name] ..."; show each helper as its own row of work so a team is visible as a team.
export function StepList({ steps }: { steps?: Message['steps'] }) {
  if (!steps?.length) return null
  const items: ({ kind: 'step'; step: Step } | { kind: 'agent'; name: string; steps: Step[] })[] = []
  for (const step of steps) {
    const match = AGENT_PREFIX.exec(step.label)
    if (!match) { items.push({ kind: 'step', step }); continue }
    const existing = items.find((item): item is Extract<typeof item, { kind: 'agent' }> => item.kind === 'agent' && item.name === match[1])
    if (existing) existing.steps.push(step); else items.push({ kind: 'agent', name: match[1], steps: [step] })
  }
  return <div className="step-list" aria-label={t("本轮执行的操作")}>{items.map((item, index) => {
    if (item.kind === 'step') return <StepChip key={index} step={item.step} label={item.step.label} />
    const running = item.steps.some(step => step.status === 'running')
    const failed = item.steps.some(step => step.status === 'failed')
    const [agent, service] = item.name.split('·')
    return <details key={index} className={'agent-group ' + (running ? 'running' : failed ? 'failed' : 'ok')} open={running}>
      <summary><span className="agent-dot">{running ? <SpinnerGap size={13} className="spin" /> : failed ? <WarningCircle size={13} /> : <Check size={13} weight="bold" />}</span><b>{agent}</b>{service && <em>{service}</em>}<small>{item.steps.length}{t("步")}</small></summary>
      <div className="agent-steps">{item.steps.map((step, position) => <StepChip key={position} step={step} label={step.label.replace(AGENT_PREFIX, '')} />)}</div>
    </details>
  })}</div>
}

// While a turn runs, the plan and each step stay visible. Once it is done, the process folds into one line
// and what was actually delivered (the files) comes first.
export function WorkProcess({ message, running }: { message: Message; running: boolean }) {
  const steps = message.steps || []
  if (!steps.length && !message.plan?.length) return null
  if (running) return <><PlanList plan={message.plan} /><StepList steps={steps} /></>
  const files = [...new Set(steps.filter(step => step.status === 'ok').flatMap(step => [...(step.file ? [step.file] : []), ...(step.files || [])]))]
  const failed = steps.filter(step => step.status === 'failed').length
  const work = steps.filter(step => !/^(切换服务|任务：|制定计划|重新规划|更新计划|核对完成标准)/.test(step.label)).length
  // Which service answered matters to the user, so a switch stays visible.
  const notices = steps.filter(step => /^切换服务/.test(step.label))
  return <>
    {files.map(file => <FileResult key={file} file={file} />)}
    {notices.length > 0 && <div className="step-list">{notices.map((step, index) => <StepChip key={index} step={step} label={step.label} />)}</div>}
    <details className="work-process">
      <summary>{t("处理过程")}<small>{work}{t("步")}{failed ? ' · ' + t("{p0} 步未成功（已换方法）", { p0: failed }) : ''}</small></summary>
      <PlanList plan={message.plan} /><StepList steps={steps} />
    </details>
  </>
}

// Pictures and videos open right in the conversation; everything else is a file card.
const IMAGE_FILE = /.(png|jpe?g|webp|gif|bmp)$/i, VIDEO_FILE = /.(mp4|webm|m4v|mov)$/i
export const mediaUrl = (file: string) => 'memory://app/__media?path=' + encodeURIComponent(file)

function FileResult({ file }: { file: string }) {
  const [note, setNote] = useState('')
  const [broken, setBroken] = useState(false)
  const media = IMAGE_FILE.test(file) ? 'image' : VIDEO_FILE.test(file) ? 'video' : ''
  const name = file.split(/[\\/]/).pop() || file
  const act = async (open: boolean) => { setNote(''); try { await (open ? window.memoryDesktop?.openFile(file) : window.memoryDesktop?.revealFile(file)) } catch (error) { setNote(cleanError(error)) } }
  if (media && !broken) return <figure className="media-result">
    {media === 'image' ? <img src={mediaUrl(file)} alt={name} loading="lazy" onError={() => setBroken(true)} /> : <video src={mediaUrl(file)} controls preload="metadata" onError={() => setBroken(true)} />}
    <figcaption><span title={file}>{name}</span>{window.memoryDesktop && <><button type="button" onClick={() => void act(true)}>{t("打开")}</button><button type="button" onClick={() => void act(false)}><FolderOpen size={13} />{t("在文件夹中显示")}</button></>}{note && <small className="error-text">{note}</small>}</figcaption>
  </figure>
  return <div className="file-result">
    <FileText size={22} weight="duotone" />
    <div><b>{name}</b><small title={file}>{file}</small>{note && <small className="error-text">{note}</small>}</div>
    {window.memoryDesktop && <><button type="button" className="button primary" onClick={() => void act(true)}>{t("打开")}</button><button type="button" className="button secondary" onClick={() => void act(false)}><FolderOpen size={14} />{t("在文件夹中显示")}</button></>}
  </div>
}

// How the subject handled this turn: as a task it verified, by a local skill, or understood from experience.
export function SubjectBadge({ subject }: { subject: NonNullable<Message['subject']> }) {
  if (!['skill', 'skill+plan', 'plan', 'direct'].includes(subject.route) && !subject.localUnderstanding) return null
  const parts = [subject.passed === true ? '✅ PISCES AI已核对结果' : subject.passed === false ? '⚠️ 核对未通过' : '', subject.route === 'skill' ? '用本地技能完成' + (subject.skill ? '「' + subject.skill + '」' : '') : '', subject.localUnderstanding ? '认出是做过的事' : '', subject.modelCalls !== null ? subject.modelCalls + ' 次模型调用' : ''].filter(Boolean)
  return <div className="subject-badge">{parts.join(' · ')}</div>
}

// Which memories shaped this answer, and what was newly learned from it: the visible part of "getting smarter".
export function MemoryTrail({ message, onOpenMemory, onForget }: { message: Message; onOpenMemory: () => void; onForget: (item: LearnedItem) => void }) {
  const used = (message.memoryUsed?.length || 0) + (message.playbooksUsed?.length || 0)
  if (!used && !message.learned?.length) return null
  return <div className="memory-trail">
    {used > 0 && <details className="trail-used"><summary><Brain size={13} />{t("参考了")}{used}{t("条记忆/经验")}</summary><ul>
      {message.memoryUsed?.map(item => <li key={item.id}>{item.text}</li>)}{message.playbooksUsed?.map(item => <li key={item.id}>{t("经验：")}{item.title}</li>)}</ul>
      <button type="button" onClick={onOpenMemory}>{t("管理记忆")}</button></details>}
    {message.learned?.map(item => <div className="trail-learned" key={item.id}><Brain size={13} weight="fill" /><span>{item.type === 'playbook' ? t("学到一套做法：{p0}", { p0: item.title }) : item.type === 'skill' ? t("学会一个软件技能：{p0}", { p0: item.title }) : item.type === 'profile' ? t("更了解你了：{p0}", { p0: item.text }) : t("记住了：{p0}", { p0: item.text })}</span>
      <button type="button" aria-label={t("撤销这条记忆")} title={t("撤销")} onClick={() => onForget(item)}><X size={12} /></button></div>)}
  </div>
}

export function FeedbackBar({ message, question, notify, onVoted }: { message: Message; question: string; notify: (text: string) => void; onVoted: (vote: 'up' | 'down') => void }) {
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  if (!window.memoryDesktop || message.error) return null
  const send = async (vote: 'up' | 'down', text = '') => {
    setBusy(true)
    try {
      const result = await window.memoryDesktop!.memory.feedback({ vote, note: text, question, playbooks: message.playbooksUsed?.map(item => item.id), memories: message.memoryUsed?.map(item => item.id) })
      onVoted(vote); setAsking(false)
      notify(vote === 'up' ? '收到，会更多地这样做' : result.lesson ? '已记为长期纠正，之后的回答会遵守' : '已记录反馈')
    } catch (error) { notify(cleanError(error)) } finally { setBusy(false) }
  }
  if (message.vote) return <span className="vote-done">{message.vote === 'up' ? <ThumbsUp size={13} weight="fill" /> : <ThumbsDown size={13} weight="fill" />}{t("已反馈")}</span>
  return <>
    <button type="button" aria-label={t("回答得好")} title={t("回答得好")} disabled={busy} onClick={() => void send('up')}><ThumbsUp size={13} /></button>
    <button type="button" aria-label={t("回答得不好")} title={t("回答得不好")} disabled={busy} onClick={() => setAsking(value => !value)}><ThumbsDown size={13} /></button>
    {asking && <form className="vote-form" onSubmit={event => { event.preventDefault(); void send('down', note) }}>
      <input autoFocus value={note} maxLength={300} onChange={event => setNote(event.target.value)} placeholder={t("哪里不对？写下来会成为长期纠正（可留空）")} aria-label={t("反馈说明")} />
      <button type="submit" className="button primary" disabled={busy}>{t("提交")}</button></form>}
  </>
}
