import { t } from './i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowClockwise, BookOpen, Brain, ChatCircle, Check, DownloadSimple, MagnifyingGlass, PencilSimple, Plus, PushPin, Trash, X } from '@phosphor-icons/react'
import type { AssistantState, CoreSession, HistoryHit, MemoryItem, MemoryStats, Playbook, Session, Skill, UserUnderstanding, Workspace } from './types'
import { ProfileEditor } from './AssistantPanels'
import { RequirementMemory } from './RequirementMemory'
import { Badge, Empty, IconButton, PageHeader, Tabs, cleanError, dayTime } from './ui'

const kindLabel: Record<MemoryItem['kind'], string> = { preference: '偏好', fact: '事实', habit: '习惯', goal: '目标', lesson: '纠正' }
const sourceLabel: Record<MemoryItem['source'], string> = { user: '你添加', ai: 'AI 记住', auto: '自动学到', feedback: '你的纠正' }
export type MemoryTab = 'portrait' | 'mine' | 'skills' | 'playbooks' | 'chats' | 'core' | 'profile'
type Tab = MemoryTab

function CoreFactRow({ fact, refresh, notify }: { fact: UserUnderstanding; refresh: () => void; notify: (text: string) => void }) {
  const labels: Record<string, string> = { 'reply.length': '回答的详细程度', 'reply.language': '回复语言', 'reply.style': '回复风格', 'answer.length': '回答的详细程度' }
  const label = labels[fact.key] || (/[\u4e00-\u9fff]/.test(fact.key) ? fact.key.replace(/[._]/g, ' · ') : '关于你的认识')
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(fact.pending_update?.value || fact.value)
  const [saving, setSaving] = useState(false)
  async function save(next: string | null) {
    if (saving || (next !== null && !next.trim())) return
    setSaving(true)
    try { await window.memoryDesktop!.editUserFact({ key: fact.key, revision: fact.revision, value: next?.trim() ?? null }); setEditing(false); refresh(); notify(next === null ? '这条认识已从核心移除' : '已保存你的确认与纠正') }
    catch (error) { notify(cleanError(error)) } finally { setSaving(false) }
  }
  return <div className="core-fact-row"><div className="core-fact-heading"><b>{t(label)}</b><span className="presence-status">{fact.status === 'confirmed' ? t("你确认的") : t("候选理解")}</span></div><p>{fact.value}</p><small>{fact.source === 'user_explicit_editor' ? t("你确认或纠正的内容：") : t("依据你的原话：")}{fact.quote}</small>{fact.pending_update && <p>{t("新的理解待确认：")}{fact.pending_update.value}<small>{t("依据你的原话：")}{fact.pending_update.quote}</small></p>}{fact.previous_values.length > 0 && <details><summary>{t("查看更正来源")}</summary>{fact.previous_values.slice(-3).map(item => <p key={item.revision}>{t("旧值：")}{item.value}{t("· 依据：")}{item.quote}</p>)}</details>}{editing ? <form onSubmit={event => { event.preventDefault(); void save(value) }}><input aria-label={t("纠正 {p0}", { p0: t(label) })} value={value} maxLength={500} onChange={event => setValue(event.target.value)} /><button type="submit" className="button secondary" disabled={saving}>{t("保存纠正")}</button><button type="button" className="presence-text-link" onClick={() => setEditing(false)}>{t("取消")}</button></form> : <div className="core-fact-actions">{(fact.status !== 'confirmed' || fact.pending_update) && <button type="button" className="presence-text-link" disabled={saving} onClick={() => void save(fact.pending_update?.value || fact.value)}>{t("确认这个理解")}</button>}<button type="button" className="presence-text-link" onClick={() => { setValue(fact.pending_update?.value || fact.value); setEditing(true) }}>{t("纠正")}</button><button type="button" className="presence-text-link" disabled={saving} onClick={() => void save(null)}>{t("删除")}</button></div>}</div>
}


export function useMemoryStore(notify: (text: string) => void) {
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [playbooks, setPlaybooks] = useState<Playbook[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const reload = useCallback(async () => {
    if (!window.memoryDesktop) return
    try { const value = await window.memoryDesktop.memory.list(); setMemories(value.memories); setPlaybooks(value.playbooks); setStats(value.stats) } catch (error) { notify(cleanError(error)) }
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { memories, playbooks, stats, reload }
}

// The living profile the assistant reads before every reply. The learner keeps it current; the user can edit or undo.
function Portrait({ notify }: { notify: (text: string) => void }) {
  const [text, setText] = useState('')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const load = useCallback(async () => { if (!window.memoryDesktop) return; try { const value = await window.memoryDesktop.memory.profile(); setText(value.profile); setDraft(value.profile) } catch (error) { notify(cleanError(error)) } }, [])
  useEffect(() => { void load() }, [load])
  const save = async () => { try { await window.memoryDesktop!.memory.saveProfile(draft); setEditing(false); notify('已保存'); await load() } catch (error) { notify(cleanError(error)) } }
  const undo = async () => { try { await window.memoryDesktop!.memory.undoProfile(); notify('已撤销上一次修改'); await load() } catch (error) { notify(cleanError(error)) } }
  if (!window.memoryDesktop) return <Empty icon={Brain} title={t("需要桌面程序")} text={t("画像保存在桌面程序的本地目录里。")} />
  return <div className="portrait">
    <p className="portrait-note">{t("助手每次回答前都会先读这份画像。每轮对话后它会根据你说的话和你的反应自动更新；标“（推测）”的是它的推断。你可以直接修改，也可以撤销上一次修改。")}</p>
    {editing
      ? <form onSubmit={event => { event.preventDefault(); void save() }}><textarea rows={16} value={draft} maxLength={6000} onChange={event => setDraft(event.target.value)} aria-label={t("用户画像")} /><div><button className="button primary" type="submit">{t("保存")}</button><button className="button secondary" type="button" onClick={() => { setEditing(false); setDraft(text) }}>{t("取消")}</button></div></form>
      : text ? <pre className="portrait-text">{text}</pre> : <Empty icon={Brain} title={t("还在了解你")} text={t("多聊几次，助手会在这里写下它对你的了解：你是谁、在做什么、喜欢怎样的帮助。也可以点“编辑”直接告诉它。")} />}
    {!editing && <div className="portrait-actions"><button className="button secondary" onClick={() => setEditing(true)}><PencilSimple size={15} />{t("编辑")}</button><button className="button secondary" onClick={() => void undo()}><ArrowClockwise size={15} />{t("撤销上一次修改")}</button></div>}
  </div>
}

const stepLine = (step: Skill['steps'][number]) => {
  const target = step.target as { type?: string; name?: string } | string | undefined
  const name = typeof target === 'string' ? target : target?.name || target?.type || ''
  return ({ launch: '启动 ' + name, open: '打开窗口「' + step.window + '」', click: '点击「' + name + '」', type: '输入「' + String(step.text || '').slice(0, 30) + '」', keys: '按键 ' + step.keys, click_text: '点击文字「' + step.text + '」', scroll: '滚动', click_xy: '点击窗口内某处', drag: '拖动', wait: '等待「' + (step.text || step.window) + '」' } as Record<string, string>)[step.op] || step.op
}

// Software skills: procedures recorded from successful work and replayed locally without the model.
function SkillList({ notify }: { notify: (text: string) => void }) {
  const [skills, setSkills] = useState<Skill[]>([])
  const load = useCallback(async () => { if (!window.memoryDesktop) return; try { setSkills(await window.memoryDesktop.memory.skills()) } catch (error) { notify(cleanError(error)) } }, [])
  useEffect(() => { void load() }, [load])
  if (!skills.length) return <Empty icon={BookOpen} title={t("还没有软件技能")} text={t("助手用软件完成一件以后可能重复的事之后，会把操作步骤保存成技能。下次同类任务直接在本地回放，几乎不用调用模型，更快也更稳。")} />
  return <div className="playbook-list">{skills.map(item => <div className="playbook-card" key={item.id}>
    <div className="playbook-head"><div><b>{item.title}</b><small>{item.app}{item.trigger && t(" · 适用：{p0}", { p0: item.trigger })}</small></div>
      <Badge tone={item.failures > item.successes ? 'amber' : ''}>{t("成功")}{item.successes}{t("· 失败")}{item.failures}</Badge>
      <IconButton label={t("删除这个技能")} onClick={async () => { try { await window.memoryDesktop!.memory.removeSkill(item.id); await load() } catch (error) { notify(cleanError(error)) } }}><Trash size={16} /></IconButton></div>
    {item.params.length > 0 && <small>{t("参数：")}{item.params.map(param => param.name + (param.description ? '（' + param.description + '）' : '')).join('，')}</small>}
    <ol>{item.steps.map((step, index) => <li key={index}>{stepLine(step)}</li>)}</ol>
    <small>{t("用过")}{item.uses}{t("次")}{item.lastError && t(" · 上次失败：{p0}", { p0: item.lastError })} · {dayTime(item.createdAt)}</small>
  </div>)}</div>
}

function MemoryRow({ item, reload, notify }: { item: MemoryItem; reload: () => Promise<void>; notify: (text: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await reload() } catch (error) { notify(cleanError(error)) } }
  return <div className={`memory-row ${item.kind}`}>
    <Badge tone={item.kind === 'lesson' ? 'amber' : ''}>{t(kindLabel[item.kind])}</Badge>
    <div className="memory-body">
      {editing
        ? <form onSubmit={event => { event.preventDefault(); void act(async () => { await window.memoryDesktop!.memory.update(item.id, { text: draft }); setEditing(false) }) }}>
          <input autoFocus value={draft} maxLength={400} onChange={event => setDraft(event.target.value)} aria-label={t("记忆内容")} />
          <IconButton label={t("保存")} onClick={() => void act(async () => { await window.memoryDesktop!.memory.update(item.id, { text: draft }); setEditing(false) })}><Check size={15} /></IconButton>
          <IconButton label={t("取消")} onClick={() => { setEditing(false); setDraft(item.text) }}><X size={15} /></IconButton></form>
        : <p>{item.text}</p>}
      <small>{t(sourceLabel[item.source])} · {dayTime(item.createdAt)}{item.hits > 0 && t(" · 被参考 {p0} 次", { p0: item.hits })}</small>
    </div>
    <IconButton label={item.pinned ? t("取消“始终参考”") : t("设为“始终参考”")} className={item.pinned ? 'selected-icon' : ''} onClick={() => void act(() => window.memoryDesktop!.memory.update(item.id, { pinned: !item.pinned }))}><PushPin size={16} weight={item.pinned ? 'fill' : 'regular'} /></IconButton>
    <IconButton label={t("编辑")} onClick={() => setEditing(true)}><PencilSimple size={16} /></IconButton>
    <IconButton label={t("删除这条记忆")} onClick={() => void act(() => window.memoryDesktop!.memory.remove(item.id))}><Trash size={16} /></IconButton>
  </div>
}

function PlaybookCard({ item, reload, notify }: { item: Playbook; reload: () => Promise<void>; notify: (text: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [trigger, setTrigger] = useState(item.trigger)
  const [steps, setSteps] = useState(item.steps.join('\n'))
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await reload() } catch (error) { notify(cleanError(error)) } }
  return <div className="playbook-card">
    <div className="playbook-head"><div><b>{item.title}</b>{item.trigger && <small>{t("适用：")}{item.trigger}</small>}</div>
      <Badge>{item.source === 'auto' ? t("自动总结") : item.source === 'ai' ? t("AI 总结") : t("你添加")}</Badge>
      <IconButton label={t("编辑")} onClick={() => setEditing(value => !value)}><PencilSimple size={16} /></IconButton>
      <IconButton label={t("删除这套做法")} onClick={() => void act(() => window.memoryDesktop!.memory.removePlaybook(item.id))}><Trash size={16} /></IconButton></div>
    {editing
      ? <form className="playbook-edit" onSubmit={event => { event.preventDefault(); void act(async () => { await window.memoryDesktop!.memory.updatePlaybook(item.id, { title, trigger, steps: steps.split('\n') }); setEditing(false) }) }}>
        <input value={title} onChange={event => setTitle(event.target.value)} aria-label={t("标题")} /><input value={trigger} onChange={event => setTrigger(event.target.value)} placeholder={t("什么时候适用")} aria-label={t("适用场景")} />
        <textarea rows={5} value={steps} onChange={event => setSteps(event.target.value)} aria-label={t("步骤（每行一步）")} /><div><button className="button primary" type="submit">{t("保存")}</button><button className="button secondary" type="button" onClick={() => setEditing(false)}>{t("取消")}</button></div></form>
      : <ol>{item.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
    <small>{t("用过")}{item.uses}{t("次")}{item.score !== 0 && t(" · 评价 {p0}{p1}", { p0: item.score > 0 ? '+' : '', p1: item.score })} · {dayTime(item.createdAt)}</small>
  </div>
}

export function MemoryPage({ workspace, selectSession, deleteSession, coreSessions, openCoreSession, refreshCoreMemory, assistantState, refreshAssistant, saveProfile, notify, exportData, store, activeTab, onTabChange }: {
  workspace: Workspace; selectSession: (session: Session) => void; deleteSession: (session: Session) => void; coreSessions: CoreSession[]; openCoreSession: (session: CoreSession) => void; refreshCoreMemory: () => void
  assistantState: AssistantState | null; refreshAssistant: () => void; saveProfile: (value: NonNullable<AssistantState['profile']>) => Promise<void>; notify: (text: string) => void; exportData: () => void
  store: ReturnType<typeof useMemoryStore>; activeTab?: MemoryTab; onTabChange?: (tab: MemoryTab) => void
}) {
  const [localTab, setLocalTab] = useState<Tab>('portrait')
  const tab = activeTab || localTab
  const headings: Record<Tab, [string, string]> = {
    portrait: ['对你的理解', '你明确告诉我的、仍待确认的认识，都可以查看来源、纠正与删除。'],
    mine: ['记住的事', '保存偏好、事实与纠正，按需要查找、补充或整理。'],
    skills: ['软件技能', '查看已保存的操作方法、成功记录与适用条件。'],
    playbooks: ['经验手册', '把已经学到的做法留在这里，后续工作可以继续使用。'],
    chats: ['对话记忆', '搜索之前的交流，带着已有内容继续。'],
    core: ['核心会话', '查看本地核心保存的会话与任务上下文。'],
    profile: ['我的档案', '让助手了解你的目标、偏好与边界，你随时可以修改。'],
  }
  const setTab = onTabChange || setLocalTab
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | MemoryItem['kind']>('all')
  const [draft, setDraft] = useState('')
  const [draftKind, setDraftKind] = useState<MemoryItem['kind']>('preference')
  const [pinNew, setPinNew] = useState(false)
  const [hits, setHits] = useState<HistoryHit[]>([])
  const { memories, playbooks, reload } = store

  const shown = useMemo(() => memories.filter(item => (kind === 'all' || item.kind === kind) && (!query.trim() || item.text.includes(query.trim()))), [memories, kind, query])
  const shownBooks = useMemo(() => playbooks.filter(item => !query.trim() || (item.title + item.trigger + item.steps.join('')).includes(query.trim())), [playbooks, query])
  const sessions = useMemo(() => workspace.sessions.filter(session => session.messages.length && (!query.trim() || (session.title + session.messages.map(message => message.content).join('\n')).includes(query.trim()))), [workspace.sessions, query])
  useEffect(() => {
    if (tab !== 'chats' || !query.trim() || !window.memoryDesktop) { setHits([]); return }
    const timer = setTimeout(() => { window.memoryDesktop!.memory.searchHistory(query.trim()).then(setHits).catch(() => setHits([])) }, 250)
    return () => clearTimeout(timer)
  }, [tab, query])

  const add = async () => {
    if (!draft.trim() || !window.memoryDesktop) return
    try {
      const result = await window.memoryDesktop.memory.add({ kind: draftKind, text: draft, pinned: pinNew })
      setDraft(''); notify(result.duplicate ? '已经记过类似的内容' : '已记住'); await reload()
    } catch (error) { notify(cleanError(error)) }
  }

  return <section className="page memory-page">
    <PageHeader eyebrow="A MEMORY YOU CAN INSPECT" title={headings[tab][0]} description={headings[tab][1]} action={<button className="button secondary" onClick={exportData}><DownloadSimple size={15} />{t("导出")}</button>} />
    {tab !== 'portrait' && <div className="search-field"><MagnifyingGlass size={17} /><input placeholder={t("搜索记忆、经验、对话…")} aria-label={t("搜索")} value={query} onChange={event => setQuery(event.target.value)} />{query && <IconButton label={t("清除搜索")} onClick={() => setQuery('')}><X size={14} /></IconButton>}</div>}
    {!activeTab && <Tabs value={tab} onChange={setTab} items={[{ id: 'portrait', label: '对你的理解' }, { id: 'mine', label: '记住的事', count: memories.length }, { id: 'skills', label: '软件技能' }, { id: 'playbooks', label: '经验手册', count: playbooks.length }, { id: 'chats', label: '对话' }, { id: 'core', label: '核心会话' }, { id: 'profile', label: '我的档案' }]} />}
    {activeTab && ['profile', 'chats', 'core'].includes(tab) && <Tabs value={tab} onChange={setTab} items={[{ id: 'profile', label: '我的档案' }, { id: 'chats', label: '对话记忆' }, { id: 'core', label: '核心会话' }]} />}

    {tab === 'portrait' && <div className="understanding-layout"><div>
      <h2>{t("你明确告诉我的")}</h2>
      {memories.filter(item => item.source === 'user' || item.source === 'feedback').map(item => <MemoryRow key={item.id} item={item} reload={reload} notify={notify} />)}
      {assistantState?.continuity?.facts.filter(fact => fact.status === 'confirmed').map(fact => <CoreFactRow key={fact.key} fact={fact} refresh={refreshAssistant} notify={notify} />)}
      {!memories.some(item => item.source === 'user' || item.source === 'feedback') && !assistantState?.continuity?.facts.some(fact => fact.status === 'confirmed') && <p className="presence-muted">{t("你手动添加的内容和明确纠正会留在这里。")}</p>}
      <h2>{t("还没有确认的理解")}</h2>
      {memories.filter(item => item.source === 'ai' || item.source === 'auto').map(item => <MemoryRow key={item.id} item={item} reload={reload} notify={notify} />)}
      {assistantState?.continuity?.facts.filter(fact => fact.status === 'candidate').map(fact => <CoreFactRow key={fact.key} fact={fact} refresh={refreshAssistant} notify={notify} />)}
      {!memories.some(item => item.source === 'ai' || item.source === 'auto') && !assistantState?.continuity?.facts.some(fact => fact.status === 'candidate') && <p className="presence-muted">{t("暂时没有候选理解。")}</p>}
      <details className="understanding-portrait"><summary>{t("查看与编辑完整画像")}</summary><Portrait notify={notify} /></details>
    </div><aside><h2>{t("最近提供给助手的记忆")}</h2>{(() => { const recent = [...workspace.sessions].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated)).map(session => [...session.messages].reverse().find(message => message.role === 'assistant' && message.memoryUsed?.length)).find(Boolean); return recent?.memoryUsed?.length ? recent.memoryUsed.map(item => <p key={item.id}>{item.text}<small>{t("来源：实际上下文记录")}</small></p>) : <p className="presence-muted">{t("每一轮提供的记忆会留在交流记录里。")}</p> })()}<p className="understanding-note">{t("理解不对时可以编辑或删除；完整画像也可以撤销上一次修改。")}</p></aside></div>}
    {tab === 'mine' && <>
      {window.memoryDesktop && <RequirementMemory notify={notify} />}
      {!window.memoryDesktop && <Empty icon={Brain} title={t("需要桌面程序")} text={t("记忆保存在桌面程序的本地目录里，网页预览不可用。")} />}
      {window.memoryDesktop && <>
        <form className="memory-add" onSubmit={event => { event.preventDefault(); void add() }}>
          <select value={draftKind} onChange={event => setDraftKind(event.target.value as MemoryItem['kind'])} aria-label={t("类型")}>{(['preference', 'fact', 'habit', 'goal'] as const).map(item => <option key={item} value={item}>{t(kindLabel[item])}</option>)}</select>
          <input value={draft} maxLength={400} onChange={event => setDraft(event.target.value)} placeholder={t("告诉助手一件关于你的事，例如：我习惯用要点式的简短回答")} aria-label={t("新记忆")} />
          <label className="check-label"><input type="checkbox" checked={pinNew} onChange={event => setPinNew(event.target.checked)} />{t("始终参考")}</label>
          <button className="button primary" disabled={!draft.trim()}><Plus size={15} />{t("记住")}</button></form>
        <div className="kind-filter">{(['all', 'preference', 'fact', 'habit', 'goal', 'lesson'] as const).map(item => <button key={item} className={kind === item ? 'active' : ''} onClick={() => setKind(item)}>{item === 'all' ? t("全部") : t(kindLabel[item])}</button>)}</div>
        {shown.length ? <div className="memory-rows">{shown.map(item => <MemoryRow key={item.id} item={item} reload={reload} notify={notify} />)}</div>
          : <Empty icon={Brain} title={memories.length ? t("没有匹配的记忆") : t("还没有记住任何事")} text={t("和助手聊天时，它会自动记下你的偏好和习惯，也可以直接说“记住……”。你也能在上面手动添加。")} />}
      </>}
    </>}

    {tab === 'skills' && <SkillList notify={notify} />}

    {tab === 'playbooks' && (shownBooks.length ? <div className="playbook-list">{shownBooks.map(item => <PlaybookCard key={item.id} item={item} reload={reload} notify={notify} />)}</div>
      : <Empty icon={BookOpen} title={t("还没有经验手册")} text={t("助手用工具成功完成多步骤任务后，会把可复用的做法总结在这里。下次遇到类似任务会先参考，你给回答点“赞/踩”会调整它们的权重。")} />)}

    {tab === 'chats' && <>
      {sessions.length ? <div className="memory-rows">{sessions.map(session => <div className="chat-row" key={session.id}><span className="memory-icon"><ChatCircle size={18} /></span>
        <div className="memory-body"><button onClick={() => selectSession(session)}>{session.title}</button><small>{dayTime(session.updated)} · {session.messages.length}{t("条消息")}</small><p>{(query.trim() ? session.messages.find(message => message.content.includes(query.trim()))?.content : session.messages.find(message => message.role === 'user')?.content)?.slice(0, 120)}</p></div>
        <IconButton label={t("删除对话 {p0}", { p0: session.title })} onClick={() => deleteSession(session)}><Trash size={16} /></IconButton></div>)}</div>
        : <Empty icon={ChatCircle} title={query ? t("没有匹配的对话") : t("还没有对话")} text={t("完成一段对话后会出现在这里。")} />}
      {hits.length > 0 && <><div className="section-heading"><h3>{t("更早的对话片段")}</h3></div><div className="memory-rows">{hits.map((hit, index) => <div className="chat-row" key={index}><span className="memory-icon"><ChatCircle size={18} /></span><div className="memory-body"><small>{dayTime(hit.ts)}</small><p>{t("你：")}{hit.user.slice(0, 120)}</p><p>{t("助手：")}{hit.assistant.slice(0, 160)}</p></div></div>)}</div></>}
    </>}

    {tab === 'core' && <>
      <div className="section-heading"><h3>{t("核心主体里的会话")}</h3><button onClick={refreshCoreMemory}><ArrowClockwise size={14} />{t("读取核心")}</button></div>
      {coreSessions.length ? <div className="memory-rows">{coreSessions.map(session => <div className="chat-row" key={session.session}><span className="memory-icon"><Brain size={18} /></span><div className="memory-body"><button onClick={() => openCoreSession(session)}>{session.latest_message_preview.slice(0, 70) || session.session}</button><small>{dayTime(session.latest_message_at)} · {session.message_count}{t("条主体消息")}</small></div></div>)}</div>
        : <Empty icon={Brain} title={t("读取核心会话")} text={t("点击右上“读取核心”。这些消息保存在PISCES AI核心里，核心需要在线。")} />}
    </>}

    {tab === 'profile' && <ProfileEditor profile={assistantState?.profile} refresh={refreshAssistant} notify={notify} save={saveProfile} />}
  </section>
}
