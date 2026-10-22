import { t, useLocale, systemText } from './i18n'
import type { DesktopSelection } from "./types"
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowUp, ArrowRight, ArrowClockwise, Brain, ChatCircle, Check, CaretDown, CaretRight, Copy, FileText, Folder, GearSix, Globe, List, Minus, Monitor, Moon,
  Paperclip, Plus, ShieldCheck, Sparkle, Square, SquaresFour, Sun, Target, Trash, WarningCircle, X, BookOpen, MagnifyingGlass, Clock, Lightning, Plug, ShieldWarning, SpeakerHigh, UsersThree, Fingerprint, CheckCircle,
} from '@phosphor-icons/react'
import type { AssistantState, Attachment, ConnectionSettings, Persona, ProviderStore, CoreReceipt, CoreSession, DesktopActionApproval, LearnedItem, Message, Mode, Reminder, Session, ToolApproval, View } from './types'
import { blankSession, loadWorkspace, persistWorkspace } from './store'
import { normalizeWorkbench, workInstruction, type WorkbenchState, type WorkFilter } from './workbenchState'
import './core.css'
import './markdown.css'
import './features.css'
import { Badge, Empty, IconButton, PageHeader, cleanError, clock as date, fileSize as size } from './ui'
import { SettingsModal } from './SettingsModal'
import { JobsPage } from './JobsPage'
import { ConnectorsPage } from './ConnectorsPage'
import { CommandPalette, type Command } from './CommandPalette'
import { defaultPersona } from './PersonaPanel'
import { useCheckpoints, useConnectors, useJobs } from './agentState'
import { RuntimeStatus } from './RuntimeStatus'
import './refresh.css'
import './design.css'
import { Avatar, BRAND_NAME } from './Brand'
import { ToolApprovalModal } from './ToolApproval'
import { MemoryPage, useMemoryStore, type MemoryTab } from './MemoryPage'
import { LearningPage } from './LearningPage'
import { TasksPage,ConversationWorkDetails } from './PersistentTasksPage'
import { ControlPage } from './ControlPage'
import { GoalsPage } from './GoalsPage'
import { LongGoalsPage } from './LongGoalsPage'
import { UsagePanel } from './UsagePanel'
import { BrowserPage } from './BrowserPage'
import { FeedbackBar, MemoryTrail, SubjectBadge, WorkProcess } from './ChatExtras'
import { RequirementChecks } from './RequirementMemory'
import { MessageRenderer,extractPreview } from './MessageRenderer'
import { PreviewPane,artifactPreview,type Preview } from './PreviewPane'
import { PresenceHome, WorkScene, HistoryPage } from './Presence'
import { collectWork, lastReply, type WorkEntry } from './presenceModel'
import { SectionNavigation } from './SectionNavigation'
import { NewWorkForm, type NewWorkValue } from './NewWorkForm'
import './presence.css'
import './product.css'

const navigation: { id: View; label: string; icon: typeof ChatCircle }[] = [
  { id: 'home', label: '此刻', icon: Sun },
  { id: 'work', label: '一起在做', icon: CheckCircle },
  { id: 'history', label: '交流记录', icon: ChatCircle },
  { id: 'abilities', label: '本机能力', icon: ShieldCheck },
  { id: 'services', label: 'AI 服务', icon: Sparkle },
  { id: 'core', label: '核心连接', icon: Brain },
  { id: 'changes', label: '更改记录', icon: FileText },
  { id: 'chat', label: '对话', icon: ChatCircle },
  { id: 'jobs', label: '后台', icon: Lightning },
  { id: 'connectors', label: '连接器', icon: Plug },
  { id: 'tasks', label: '任务', icon: SquaresFour },
  { id: 'control', label: '桌面控制', icon: Monitor },
  { id: 'learning', label: '学习记录', icon: Brain },
  { id: 'memory', label: '记忆', icon: BookOpen },
  { id: 'goals', label: '目标与提醒', icon: Target },
  { id: 'operations', label: '长期目标', icon: Target },
  { id: 'usage', label: '用量与预算', icon: Brain },
  { id: 'browser', label: '浏览器', icon: Globe },
]
type ChatTurn = { id: string; sessionId: string; messageId: string }
type ComposerState = { attachments: Attachment[]; multiAgent: boolean; desktopTarget: DesktopSelection | null }
const blankComposer = (): ComposerState => ({ attachments: [], multiAgent: false, desktopTarget: null })
const greeting = () => { const hour = new Date().getHours(); return hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好' }
const defaultSettings: ConnectionSettings = { endpoint: '', model: '', coreUrl: 'http://127.0.0.1:18789', hasApiKey: false, hasCoreToken: false }
export default function App() {
  useLocale()
  const [workspace, setWorkspace] = useState(loadWorkspace)
  const [view, setView] = useState<View>('home')
  const [memoryTab, setMemoryTab] = useState<MemoryTab>('portrait')
  const [workFocus, setWorkFocus] = useState('')
  const [workCreating, setWorkCreating] = useState(false)
  const [initialWorkFilter, setInitialWorkFilter] = useState<WorkFilter>('all')
  const [activeId, setActiveId] = useState(workspace.sessions[0].id)
  const [mode, setMode] = useState<Mode>(workspace.sessions[0].mode)
  const [composers, setComposers] = useState<Record<string, ComposerState>>({})
  const [search, setSearch] = useState('')
  const [settings, setSettings] = useState(defaultSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelMenu, setModelMenu] = useState(false)
  const [inspector, setInspector] = useState(false)
  const [preview,setPreview]=useState<Preview|null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [core, setCore] = useState<'disconnected' | 'checking' | 'connected'>('disconnected')
  const [coreNote, setCoreNote] = useState('尚未连接现有核心')
  const coreActivityAt = useRef(0)
  useEffect(() => window.memoryDesktop?.onCoreConnection?.(state => {
    coreActivityAt.current = Date.now()
    setCore(state.online ? 'connected' : 'disconnected'); setCoreNote(state.online ? '' : state.error || '尚未连接现有核心')
  }), [])
  const [runningSessions, setRunningSessions] = useState<string[]>([])
  const [auxiliarySessions, setAuxiliarySessions] = useState<string[]>([])
  const [toast, setToast] = useState('')
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [approvalQueue, setApprovalQueue] = useState<(ToolApproval | DesktopActionApproval)[]>([])
  const [settingsTab, setSettingsTab] = useState<'ai' | 'persona' | 'abilities' | 'core' | 'general'>('ai')
  const [editingId, setEditingId] = useState('')
  const [controlLog, setControlLog] = useState<unknown>(null)
  const [coreSessions, setCoreSessions] = useState<CoreSession[]>([])
  const [coreLearning, setCoreLearning] = useState<unknown>(null)
  const [controlInput, setControlInput] = useState('')
  const [assistantState, setAssistantState] = useState<AssistantState | null>(null)
  const [assistantReady, setAssistantReady] = useState(false)
  const [providerStore, setProviderStore] = useState<ProviderStore | null>(null)
  const [persona, setPersona] = useState<Persona>(defaultPersona)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [jobFocus, setJobFocus] = useState('')
  const jobCtl = useJobs(text => setToast(text))
  const connectorState = useConnectors(text => setToast(text))
  const checkpointState = useCheckpoints(text => setToast(text), jobCtl.jobs.length + ':' + jobCtl.jobs.filter(item => item.status === 'done').length)
  const [desktopConsent, setDesktopConsent] = useState(false)
  const [desktopProgress, setDesktopProgress] = useState('')
  const [desktopReceipt, setDesktopReceipt] = useState<CoreReceipt | null>(null)
  const [desktopAuthOpen, setDesktopAuthOpen] = useState(false)
  const [pendingDesktopText, setPendingDesktopText] = useState('')
  const requests = useRef(new Map<string, ChatTurn>())
  const completedTurns = useRef(new Map<string, ChatTurn>())
  const memStoreRef = useRef<ReturnType<typeof useMemoryStore>>(null as never)
  const chatEnd = useRef<HTMLDivElement>(null)
  const upload = useRef<HTMLInputElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const assistantLoading = useRef(false)
  const active = workspace.sessions.find(session => session.id === activeId) || workspace.sessions[0]
  const activeRef = useRef(active.id)
  activeRef.current = active.id
  const currentComposer = composers[active.id] || blankComposer()
  const input = active.draft || '', chatProfile = active.profile || ''
  const chatServices = (providerStore?.profiles || []).filter(item => (item.kind || 'chat') === 'chat')
  const { attachments, multiAgent, desktopTarget } = currentComposer
  const busy = runningSessions.includes(active.id) || auxiliarySessions.includes(active.id)
  const anyBusy = runningSessions.length > 0 || auxiliarySessions.length > 0
  const setAuxiliarySession = (sessionId: string) => setAuxiliarySessions(previous => sessionId ? [...new Set([...previous, sessionId])] : previous.filter(id => id !== active.id))
  const patchComposer = (change: Partial<ComposerState> | ((previous: ComposerState) => Partial<ComposerState>)) => {
    const sessionId = active.id
    setComposers(previous => { const old = previous[sessionId] || blankComposer(); return { ...previous, [sessionId]: { ...old, ...(typeof change === 'function' ? change(old) : change) } } })
  }
  const setInput = (draft: string) => setWorkspace(previous => ({ ...previous, sessions: previous.sessions.map(session => session.id === active.id ? { ...session, draft } : session) }))
  const setChatProfile = (profile: string) => setWorkspace(previous => ({ ...previous, sessions: previous.sessions.map(session => session.id === active.id ? { ...session, profile } : session) }))
  const setAttachments = (value: Attachment[] | ((previous: Attachment[]) => Attachment[])) => patchComposer(previous => ({ attachments: typeof value === 'function' ? value(previous.attachments) : value }))
  const setMultiAgent = (value: boolean) => patchComposer({ multiAgent: value })
  const setDesktopTarget = (value: DesktopSelection | null) => patchComposer({ desktopTarget: value })
  const toolApproval = approvalQueue[0] && 'kind' in approvalQueue[0] ? approvalQueue[0] as ToolApproval : null
  const actionApproval = approvalQueue[0] && !('kind' in approvalQueue[0]) ? approvalQueue[0] as DesktopActionApproval : null
  const dismissApproval = (approvalId: string) => setApprovalQueue(previous => previous.filter(item => item.approvalId !== approvalId))
  const syncRuns = () => setRunningSessions([...requests.current.values()].map(turn => turn.sessionId))
  const notify = (text: string) => setToast(text)
  const memStore = useMemoryStore(notify)
  memStoreRef.current = memStore
  const desktopApproval = actionApproval || toolApproval
  const lastAssistant = [...active.messages].reverse().find(message => message.role === 'assistant')
  const openSettings = (tab: 'ai' | 'persona' | 'abilities' | 'core' | 'general' = 'ai') => { setSettingsTab(tab); setSettingsOpen(true) }
  const prefill = (text: string) => { setInput(text); composer.current?.focus() }

  useEffect(() => { document.documentElement.dataset.theme = workspace.theme }, [workspace.theme])
  // Streaming updates the workspace on every token; write once the stream pauses, and flush on close.
  const latestWorkspace = useRef(workspace)
  latestWorkspace.current = workspace
  useEffect(() => {
    const timer = setTimeout(() => {
      try { persistWorkspace(workspace) } catch { setToast('本地存储已满，请导出工作记录后清理旧对话') }
    }, 600)
    return () => clearTimeout(timer)
  }, [workspace])
  useEffect(() => {
    const flush = () => { try { persistWorkspace(latestWorkspace.current, true) } catch { /* quota: nothing more to do while closing */ } }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])
  useEffect(() => {
    window.memoryDesktop?.settings().then(setSettings).catch(error => setToast(cleanError(error)))
    window.memoryDesktop?.providers().then(setProviderStore).catch(() => {})
    window.memoryDesktop?.prefs().then(value => { if (value.persona) setPersona(value.persona) }).catch(() => {})
    window.memoryDesktop?.reminders().then(setReminders).catch(() => {})
    const offDelta = window.memoryDesktop?.onChatDelta(value => {
      const current = requests.current.get(value.id)
      if (!current || value.id !== current.id) return
      setWorkspace(previous => ({ ...previous, sessions: previous.sessions.map(session => session.id === current.sessionId ? { ...session, messages: session.messages.map(message => message.id === current.messageId ? { ...message, content: value.reset ? '' : message.content + value.text } : message) } : session) }))
    })
    const offReceipt = window.memoryDesktop?.onCoreReceipt(value => {
      const current = requests.current.get(value.id)
      if (!current || current.id !== value.id) return
      setCore('connected'); setCoreNote('本地主体已接收对话，事实与方法仍需验证')
      updateMessages(current.sessionId, messages => messages.map(message => message.id === current.messageId ? { ...message, core: value.receipt } : message))
    })
    const offFired = window.memoryDesktop?.onReminderFired(reminder => {
      notify('提醒：' + reminder.content)
      window.memoryDesktop?.reminders().then(setReminders).catch(() => {})
    })
    const offClicked = window.memoryDesktop?.onReminderClicked(() => {
      setView('goals')
    })
    const offApproval = window.memoryDesktop?.onDesktopApproval(approval => {
      if ('closed' in approval) { dismissApproval(approval.approvalId); return }
      const sessionTitle = latestWorkspace.current.sessions.find(item => item.id === approval.sessionId)?.title
      const scoped = 'kind' in approval && sessionTitle ? { ...approval, lines: [t("对话：{p0}", { p0: sessionTitle }), ...approval.lines] } : approval
      setApprovalQueue(previous => previous.some(item => item.approvalId === approval.approvalId) ? previous : [...previous, scoped])
    })
    const offPlan = window.memoryDesktop?.onPlan(value => {
      const current = requests.current.get(value.id)
      if (!current || current.id !== value.id) return
      updateMessages(current.sessionId, messages => messages.map(message => message.id === current.messageId ? { ...message, plan: value.plan } : message))
    })
    const offUsed = window.memoryDesktop?.onMemoryUsed(value => {
      const current = requests.current.get(value.id)
      if (!current || current.id !== value.id) return
      updateMessages(current.sessionId, messages => messages.map(message => message.id === current.messageId ? { ...message, memoryUsed: value.memories, playbooksUsed: value.playbooks } : message))
    })
    const offLearned = window.memoryDesktop?.onMemoryLearned(value => {
      const target = requests.current.get(value.id) || completedTurns.current.get(value.id)
      if (!target) return
      updateMessages(target.sessionId, messages => messages.map(message => message.id === target.messageId ? { ...message, learned: [...(message.learned || []), ...value.items.filter(item => !(message.learned || []).some(old => old.id === item.id))] } : message))
      void memStoreRef.current.reload()
      notify(value.items[0].type === 'playbook' ? '学到一套做法：' + value.items[0].title : '记住了：' + value.items[0].text)
    })
    return () => { offDelta?.(); offReceipt?.(); offFired?.(); offClicked?.(); offApproval?.(); offUsed?.(); offLearned?.(); offPlan?.() }
  }, [])
  useEffect(() => { document.documentElement.style.setProperty('--persona', persona.color) }, [persona.color])
  useEffect(() => window.memoryDesktop?.onJobFocus(id => { setWorkFocus('job:' + id); setWorkCreating(false); setInitialWorkFilter('all'); setView('work') }), [])
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 4200); return () => clearTimeout(timer) } }, [toast])
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: busy ? 'instant' : 'smooth', block: 'end' }) }, [active.messages, busy])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[aria-modal="true"]'))) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); newWork() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(open => !open) }
      if (event.key === 'Escape') { setPaletteOpen(false); setSettingsOpen(false); setModelMenu(false); setMobileNav(false); setDesktopAuthOpen(false) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mode])

  const updateMessages = (sessionId: string, fn: (messages: Message[]) => Message[]) => setWorkspace(previous => ({ ...previous, sessions: previous.sessions.map(session => session.id === sessionId ? { ...session, messages: fn(session.messages), updated: new Date().toISOString() } : session) }))
  function newChat() {
    const session = { ...blankSession(), mode }
    setWorkspace(previous => ({ ...previous, sessions: [session, ...previous.sessions] }))
    setActiveId(session.id); setView('chat'); setPreview(null); setMobileNav(false)
  }
  function newWork() {
    setWorkCreating(true); setWorkFocus(''); setInitialWorkFilter('all'); setView('work'); setPreview(null); setMobileNav(false)
  }
  function selectSession(session: Session) {
    setActiveId(session.id); setView('chat'); setMode(session.mode); setPreview(null); setMobileNav(false)
  }
  function selectMode(next: Mode) {
    setWorkspace(previous => ({ ...previous, sessions: previous.sessions.map(session => session.id === active.id ? { ...session, mode: next } : session) }))
    setMode(next); setModelMenu(false)
  }
  async function forgetLearned(messageId: string, item: LearnedItem) {
    try {
      if (item.type === 'playbook') await window.memoryDesktop?.memory.removePlaybook(item.id)
      else if (item.type === 'profile') await window.memoryDesktop?.memory.undoProfile()
      else if (item.type === 'skill') await window.memoryDesktop?.memory.removeSkill(item.id)
      else if (item.type === 'requirement') { const rule = (await window.memoryDesktop!.memory.requirements()).find(value => value.id === item.id); if (rule) await window.memoryDesktop!.memory.saveRequirements([{ ...rule, enabled: false }]) }
      else await window.memoryDesktop?.memory.remove(item.id)
      updateMessages(active.id, messages => messages.map(entry => entry.id === messageId ? { ...entry, learned: entry.learned?.filter(old => old.id !== item.id) } : entry))
      void memStore.reload(); notify('已撤销')
    } catch (error) { notify(cleanError(error)) }
  }
  function renameSession(session: Session, title: string) {
    setEditingId('')
    const value = title.trim().slice(0, 40)
    if (value && value !== session.title) setWorkspace(previous => ({ ...previous, sessions: previous.sessions.map(item => item.id === session.id ? { ...item, title: value } : item) }))
  }
  async function checkCore() {
    if (!window.memoryDesktop) return notify('浏览器预览不访问本机核心，请从桌面程序连接')
    setCore('checking')
    try {
      await window.memoryDesktop.coreStatus()
      setCore('connected'); setCoreNote('核心在线；对话、共享会话与桌面任务通道已连接')
      notify('现有核心已连接')
    } catch (error) { setCore('disconnected'); setCoreNote(cleanError(error)); notify('核心未连接：' + cleanError(error)) }
  }
  async function startCore() {
    if (!window.memoryDesktop) return notify('请在桌面程序中启动核心')
    setCore('checking')
    try {
      if (settings.coreUrl === 'http://127.0.0.1:8787') setSettings(await window.memoryDesktop.saveSettings({ ...settings, coreUrl: 'http://127.0.0.1:18789' }))
      await window.memoryDesktop.startCore(); setCore('connected'); setCoreNote('已连接主线核心，后台付费研究保持关闭'); notify('主线核心已就绪')
    }
    catch (error) { setCore('disconnected'); setCoreNote(cleanError(error)); notify(cleanError(error)) }
  }
  async function refreshCoreMemory() {
    if (!window.memoryDesktop) return notify('请在桌面程序中读取核心记忆')
    try {
      const sessions = await window.memoryDesktop.coreSessions(); setCoreSessions(sessions.items)
      setCoreLearning(await window.memoryDesktop.learningState()); setCore('connected'); notify('已读取核心会话与学习状态')
    } catch (error) { notify(cleanError(error)) }
  }
  async function refreshAssistant(quiet = false) {
    if (!window.memoryDesktop) return quiet ? undefined : notify('请从桌面程序读取主体档案与工作单')
    if (assistantLoading.current) return
    assistantLoading.current = true
    const started = Date.now()
    try { setAssistantState(await window.memoryDesktop.assistantState()); setCore('connected') } catch (error) { if (started >= coreActivityAt.current) { setCore('disconnected'); setCoreNote(cleanError(error)); if (!quiet) notify(cleanError(error)) } } finally { assistantLoading.current = false; setAssistantReady(true) }
  }
  useEffect(() => {
    if (!window.memoryDesktop) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => { await refreshAssistant(true); if (!disposed) timer = setTimeout(() => void read(), anyBusy ? 3000 : 15000) }
    void read()
    const focus = () => { void refreshAssistant(true); void memStoreRef.current.reload() }
    window.addEventListener('focus', focus)
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener('focus', focus) }
  }, [anyBusy])
  async function replayMethod(id: string) {
    if (busy || !window.memoryDesktop) return
    setAuxiliarySession(active.id)
    try {
      const files = await window.memoryDesktop.pickFiles()
      if (!files.length) return
      const result = await window.memoryDesktop.replayMethod({ session: active.id, methodId: id, files: files.map(file => file.path!) })
      notify(result.work.status === 'verified' ? '核心已在新文件上独立复做，模型调用为 0' : '复做未通过，请查看任务回执')
      await refreshAssistant()
    } catch (error) { notify(cleanError(error)) } finally { setAuxiliarySession('') }
  }
  async function openCoreSession(session: CoreSession) {
    const cached = workspace.sessions.find(item => item.id === session.session)
    if (cached) return selectSession(cached)
    try {
      const result = await window.memoryDesktop!.coreHistory(session.session)
      const restored: Session = { id: session.session, title: result.items.find(item => item.role === 'user')?.content.slice(0, 22) || '核心会话', updated: session.latest_message_at, mode: 'core', messages: result.items.map(item => ({ id: item.record_id, role: item.role, content: item.content, source: 'core' })) }
      setWorkspace(previous => ({ ...previous, sessions: [restored, ...previous.sessions] })); selectSession(restored)
    } catch (error) { notify(cleanError(error)) }
  }
  useEffect(() => { setDesktopConsent(false) }, [settings.endpoint, settings.model, activeId])
  useEffect(() => window.memoryDesktop?.onToolReceipt(step => {
    const current = requests.current.get(step.id)
    if (!current || step.id !== current.id) return
    if (step.phase === 'observed' && step.receipt && step.workId && typeof step.revision === 'number') {
      updateMessages(current.sessionId, messages => messages.map(message => {
        if (message.id !== current.messageId) return message
        const cache = message.taskEvidence
        const receipts = cache && cache.workId === step.workId && cache.revision === step.revision ? cache.receipts.filter(item => item.id !== step.receipt!.id) : []
        return { ...message, coreWorkId: step.workId, taskEvidence: { workId: step.workId!, revision: step.revision!, receipts: [...receipts, step.receipt!].slice(-24) } }
      }))
      void refreshAssistant(true)
    }
    if (step.label) {
      updateMessages(current.sessionId, messages => messages.map(message => {
        if (message.id !== current.messageId) return message
        const steps = [...(message.steps || [])]
        if (step.phase === 'running') steps.push({ label: step.label!, status: 'running' })
        else {
          const index = steps.map(item => item.status === 'running' && item.label === step.label).lastIndexOf(true)
          const settled = { label: step.label!, status: step.ok === false ? 'failed' as const : 'ok' as const, ...(step.error ? { error: step.error } : {}), ...(step.file ? { file: step.file } : {}), ...(step.files?.length ? { files: step.files } : {}) }
          if (index >= 0) steps[index] = settled; else steps.push(settled)
        }
        return { ...message, steps }
      }))
    }
    if (current.sessionId === activeRef.current && (step.operation === 'observe_desktop' || step.operation === 'desktop_action')) setDesktopProgress(step.phase === 'running' ? (step.operation === 'observe_desktop' ? '核心正在观察窗口…' : '核心正在执行并核对结果…') : (step.receipt?.status === 'verified' ? '已收到真实界面回执' : '步骤失败，AI 将收到反馈'))
  }), [])
  // After the assistant launches software, one click binds that window and opens the usual per-turn authorization.
  async function operateOpenedWindow() {
    await selectDesktopWindow()
    setPendingDesktopText('继续刚才的任务：在刚打开的软件窗口里完成')
    setDesktopAuthOpen(true)
  }
  async function selectDesktopWindow() {
    if (busy || !window.memoryDesktop) return
    try {
      setDesktopConsent(false)
      const target = await window.memoryDesktop.selectDesktop()
      setDesktopTarget(target); selectMode('core'); setView('chat')
      notify('已选择 ' + target.title + '；发送前请确认本轮授权')
    } catch (error) { notify(cleanError(error)) }
  }
  async function desktopTask(execute: boolean) {
    if (busy || !controlInput.trim()) return
    if (!window.memoryDesktop) return notify('请在桌面程序中提交桌面任务')
    setAuxiliarySession(active.id); setDesktopReceipt(null)
    try {
      const receipt = await window.memoryDesktop.desktopTask({ id: crypto.randomUUID(), session: active.id, instruction: controlInput.trim(), execute })
      setDesktopReceipt(receipt); setCore('connected')
      notify('已收到核心桌面回执，请查看执行状态')
    } catch (error) { notify('任务连接未完成：' + cleanError(error) + '；请读取核心操作记录确认状态') }
    finally { setAuxiliarySession('') }
  }
  async function pickFiles() {
    try {
      if (window.memoryDesktop) { const files = await window.memoryDesktop.pickFiles(); setAttachments(previous => [...previous, ...files].slice(0, 10)) }
      else upload.current?.click()
    } catch (error) { notify(cleanError(error)) }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          e.preventDefault()
          if(file.size>20_000_000){notify('单个附件最多 20 MB');return}
          if(window.memoryDesktop){
            const name='剪贴板截图_'+Date.now()+'.png'
            void file.arrayBuffer().then(bytes=>window.memoryDesktop!.importAttachment({name,bytes:new Uint8Array(bytes)})).then(added=>{setAttachments(prev=>[...prev,added].slice(0,10));notify('截图已压缩并添加，发送时提供给 AI')}).catch(error=>notify(cleanError(error)))
            return
          }
          const reader = new FileReader()
          reader.onload = ev => {
            const dataUrl = ev.target?.result as string
            const name = `剪贴板截图_${new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '')}.png`
            setAttachments(prev => [...prev, { name, size: file.size, isImage: true, dataUrl }].slice(0, 10))
            notify('已从剪贴板添加截图')
          }
          reader.readAsDataURL(file)
          break
        }
      }
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (!files || !files.length) return
    if (window.memoryDesktop) {
      // Desktop: the main process authorizes the dropped paths, exactly as the file picker does.
      window.memoryDesktop.addDroppedFiles(Array.from(files))
        .then(added => { setAttachments(previous => [...previous, ...added].slice(0, 10)); if (added.length) notify(`已添加 ${added.length} 个文件`) })
        .catch(error => notify(cleanError(error)))
      return
    }
    for (let i = 0; i < Math.min(files.length, 10); i++) {
      const file = files[i]
      const isImage = file.type.startsWith('image/')
      if (isImage) {
        const reader = new FileReader()
        reader.onload = ev => {
          const dataUrl = ev.target?.result as string
          setAttachments(prev => [...prev, { name: file.name, size: file.size, isImage: true, dataUrl }].slice(0, 10))
          notify(`已添加图片：${file.name}`)
        }
        reader.readAsDataURL(file)
      } else {
        const path = (file as unknown as { path?: string }).path
        setAttachments(prev => [...prev, { name: file.name, size: file.size, path, isImage: false }].slice(0, 10))
        notify(`已添加文件：${file.name}`)
      }
    }
  }

  async function performSend(overrideText?: string, options?: { forcePlain?: boolean; target?: DesktopSelection | null; consent?: boolean; base?: Message[]; attachments?: Attachment[]; session?: Session; keepWork?: boolean }) {
    const text = (overrideText !== undefined ? overrideText : input).trim()
    const sendMode = options?.session?.mode || mode
    const sessionId = options?.session?.id || active.id
    if ((!text && !(options?.attachments ?? attachments).length) || [...requests.current.values()].some(turn => turn.sessionId === sessionId) || auxiliarySessions.includes(sessionId)) return
    const slash = /^\/(后台|bg|记住|remember)\s+([\s\S]+)$/i.exec(text)
    if (slash && window.memoryDesktop) {
      setInput('')
      if (/^(后台|bg)$/i.test(slash[1])) {
        const job = await jobCtl.create({ goal: slash[2] })
        if (job) { notify('已放到后台：' + job.title); setJobFocus(job.id); navigate('jobs') }
      } else {
        try { await window.memoryDesktop.memory.add({ kind: 'fact', text: slash[2].trim() }); notify('记住了：' + slash[2].trim().slice(0, 30)); void memStore.reload() } catch (error) { notify(cleanError(error)) }
      }
      return
    }
    if (!window.memoryDesktop || (sendMode === 'live' && (!settings.endpoint || !settings.model))) {
      setSettingsOpen(true)
      notify(window.memoryDesktop ? '先配置 AI，保存后再发送' : '网页是界面预览；真实 AI 对话请打开桌面程序')
      return
    }

    // Whether to open or drive software is the model's decision (it has launch_app, screenshot, click ...); only an explicitly chosen window needs the legacy per-turn consent.
    const currentTarget = options?.target !== undefined ? options.target : desktopTarget
    const currentConsent = options?.consent !== undefined ? options.consent : desktopConsent

    if (sendMode === 'core' && !options?.forcePlain) {
      if (currentTarget && !currentConsent) {
        setPendingDesktopText(text)
        setDesktopAuthOpen(true)
        return
      }
    }

    const taskDesktopTarget = (sendMode === 'core' && !options?.forcePlain) ? currentTarget?.id : undefined
    const taskDesktopConsent = (sendMode === 'core' && !options?.forcePlain) ? currentConsent : false
    setDesktopConsent(false); setDesktopProgress('')
    const sendAttachments = options?.attachments ?? attachments
    const imageAttachments = sendAttachments.filter(file => file.isImage && file.dataUrl)
    if(imageAttachments.length>5){notify('每轮最多发送 5 张图片，请先移除多余图片');return}
    const images = imageAttachments.map(file => file.dataUrl as string)
    const textAttachments = sendAttachments.filter(file => !file.isImage)
    const selectedFiles = textAttachments.map(file => file.path).filter((path): path is string => !!path)
    const content = (text || '请查看这些附件。') +
      (textAttachments.length ? '\n\n本轮授权读取的文件正文：\n' + textAttachments.map(file => file.name + (file.truncated ? '（正文超出上限，已截取）' : '')).join('\n') : '') +
      (imageAttachments.length ? '\n\n[包含图片附件: ' + imageAttachments.map(file => file.name).join(', ') + ']' : '')
    const messageId = crypto.randomUUID()
    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content, images: images.length ? images : undefined, raw: { text, attachments: sendAttachments } }
    const prior = options?.base ?? options?.session?.messages ?? active.messages
    // A failed turn is dropped as a pair, so a retry or a new message never sees two user turns in a row.
    const history = [...prior.filter((message, index) => !message.error && !(message.role === 'user' && prior[index + 1]?.error)), userMessage]
    updateMessages(sessionId, messages => [...(options?.base ?? messages), userMessage, { id: messageId, role: 'assistant', content: '' }])
    setWorkspace(previous => ({ ...previous, sessions: previous.sessions.map(session => session.id === sessionId && session.title === '新对话' ? { ...session, title: (text || sendAttachments[0]?.name || '附件对话').slice(0, 22) } : session) }))
    if (!options?.keepWork) { setInput(''); setAttachments([]) }
    setPendingDesktopText('')
    const id = crypto.randomUUID()
    requests.current.set(id, { id, sessionId, messageId }); syncRuns()
    if (!options?.keepWork) setView('chat')
    try {
      {
        const args = {
          id,
          session: sessionId,
          profile: providerStore?.profiles.some(item => item.id === (options?.session ? options.session.profile : chatProfile)) ? (options?.session ? options.session.profile : chatProfile) : undefined,
          files: selectedFiles,
          multiAgent,
          desktopTarget: taskDesktopTarget,
          desktopConsent: taskDesktopConsent,
          goals: workspace.goals,
          attachedPaths: sendAttachments.filter(item => item.path).map(item => ({ name: item.name, path: item.path })),
          // Only the newest turn carries images; resending every screenshot each turn exhausts the request size and cost.
          messages: history.slice(-50).map((message, index, all) => ({
            role: message.role,
            content: message.role === 'assistant' && message.steps?.length ? message.content + '\n\n〔这一轮实际执行的操作：' + message.steps.map(step => (step.status === 'failed' ? '✗' : '✓') + step.label).join('；').slice(0, 1500) + '〕' : message.content,
            ...(index === all.length - 1 && message.images?.length ? { images: message.images } : {}),
          })),
        }
        const result = sendMode === 'core' ? await window.memoryDesktop!.assistantChat(args) : await window.memoryDesktop!.chat(args)
        const artifacts=result.work?.receipts.filter(r=>r.operation==='create_artifact'&&r.status==='verified').map(r=>artifactPreview(result.work!.id,r))||[]
        const visual=artifacts.at(-1)||extractPreview(result.text);if(visual && activeRef.current === sessionId)setPreview(visual)
        updateMessages(sessionId, messages => messages.map(message => message.id === messageId ? { ...message, content: result.text, requirementsCheck: result.requirementsCheck, artifacts, service: result.service, usage: result.usage?.total_tokens, source: result.source, ...(result.work ? { coreWorkId: result.work.id, ...(result.work.cognition ? { taskEvidence: { workId: result.work.id, revision: result.work.cognition.revision, receipts: result.work.receipts.slice(-24) } } : {}) } : {}), ...(result.plan ? { plan: result.plan } : {}), ...(result.subject ? { subject: result.subject } : {}), ...(result.steps ? { steps: result.steps.map(item => ({ label: item.label, status: item.ok ? 'ok' as const : 'failed' as const, ...(item.error ? { error: item.error } : {}) })) } : {}), ...(result.core ? { core: result.core } : {}), ...(result.notice ? { warning: result.notice } : {}) } : message))
        if (result.notice) { if (/暂未连接|未连接/.test(result.notice)) setCore('disconnected'); setCoreNote(result.notice) }
      }
    } catch (error) {
      updateMessages(sessionId, messages => messages.map(message => message.id === messageId ? { ...message, steps: message.steps?.map(item => item.status === 'running' ? { ...item, status: 'failed' as const, error: '未完成' } : item), content: (message.content || message.core?.reply || '') + '\n\n回复未完成：' + cleanError(error), source: message.core && !message.content ? 'core' : message.source, error: true, warning: message.core ? '核心回合已提交；停止或 AI 失败不会撤销该回合。' : undefined } : message))
    } finally { const turn = requests.current.get(id); if (turn) completedTurns.current.set(id, turn); setTimeout(() => completedTurns.current.delete(id), 300000); requests.current.delete(id); syncRuns(); if (sendMode === 'core') await refreshAssistant(true) }
    return true
  }
  function retryReply(assistantId: string) {
    if (busy) return notify('请先停止当前回复')
    const index = active.messages.findIndex(message => message.id === assistantId)
    const user = active.messages[index - 1]
    if (index < 1 || user?.role !== 'user') return
    void performSend(user.raw?.text ?? user.content, { base: active.messages.slice(0, index - 1), attachments: user.raw?.attachments ?? [] })
  }
  async function send(event?: FormEvent) {
    event?.preventDefault()
    await performSend()
  }
  async function stopReply(sessionId = activeRef.current) { const turn = [...requests.current.values()].find(item => item.sessionId === sessionId); if (turn) { try { await window.memoryDesktop?.cancelChat(turn.id) } catch (error) { notify(cleanError(error)) } } }
  async function exportData() {
    try {
      const requirements = window.memoryDesktop ? await window.memoryDesktop.memory.requirements() : []
      const data = JSON.stringify({ ...workspace, durableRequirements: requirements }, null, 2)
      if (window.memoryDesktop) { const result = await window.memoryDesktop.exportWorkspace(data); if (result.saved) notify('工作记录已导出') }
      else { const link = document.createElement('a'); const url = URL.createObjectURL(new Blob([data], { type: 'application/json' })); link.href = url; link.download = 'PISCES AI工作记录.json'; link.click(); URL.revokeObjectURL(url); notify('工作记录已导出') }
    } catch (error) { notify(cleanError(error)) }
  }
  function deleteSession(session: Session) {
    if ([...requests.current.values()].some(turn => turn.sessionId === session.id) || auxiliarySessions.includes(session.id)) return notify('请先停止这段对话的回复')
    if (!confirm('删除这条对话？已记住的偏好和经验不会被删除。')) return
    const next = workspace.sessions.filter(item => item.id !== session.id)
    if (!next.length) next.push({ ...blankSession(), mode })
    setWorkspace(previous => ({ ...previous, sessions: next }))
    if (activeId === session.id) { setActiveId(next[0].id); setMode(next[0].mode) }
  }
  const navigate = (next: View) => { if (['tasks', 'learning', 'memory'].includes(next)) void refreshAssistant(true); if (next === 'learning' || next === 'memory') void memStore.reload(); setView(next); setMobileNav(false); setModelMenu(false) }
  const jobWaiting = jobCtl.jobs.filter(item => item.status === 'waiting').length
  const jobRunning = jobCtl.jobs.filter(item => item.status === 'running' || item.status === 'queued').length
  const connectorsReady = connectorState.connectors.filter(item => item.status === 'ready').length
  const speak = (text: string) => {
    const synth = window.speechSynthesis
    if (!synth) return notify('当前环境不支持朗读')
    if (synth.speaking) { synth.cancel(); return }
    const utterance = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, '（代码已省略）').replace(/[#*_`>|]+/g, ' ').slice(0, 3000))
    utterance.lang = 'zh-CN'
    synth.speak(utterance)
  }
  const paletteCommands: Command[] = [
    { id: 'new', group: '操作', label: '新任务', hint: 'Ctrl N', icon: <Plus size={16} />, keywords: 'new task work 新事情', run: newWork },
    { id: 'new-chat', group: '操作', label: '新交流', icon: <ChatCircle size={16} />, keywords: 'new chat 问答 对话', run: newChat },
    { id: 'job', group: '操作', label: '新建后台任务…', hint: '交给后台去做', icon: <Lightning size={16} />, keywords: 'background 后台 定时 任务', run: () => { setView('jobs') } },
    { id: 'theme', group: '操作', label: workspace.theme === 'light' ? '切换到深色' : '切换到浅色', icon: workspace.theme === 'light' ? <Moon size={16} /> : <Sun size={16} />, keywords: 'theme dark light 主题', run: () => setWorkspace(previous => ({ ...previous, theme: previous.theme === 'light' ? 'dark' : 'light' })) },
    ...navigation.map(item => ({ id: 'go-' + item.id, group: '前往', label: item.label, icon: <item.icon size={16} />, keywords: item.id, run: () => navigate(item.id) })),
    { id: 's-ai', group: '设置', label: 'AI 服务与任务分配', icon: <Sparkle size={16} />, keywords: 'api 模型 密钥 分配', run: () => openSettings('ai') },
    { id: 's-general', group: '设置', label: '界面语言与通用设置', icon: <Globe size={16} />, keywords: 'language locale general settings 语言 語言 English 中文', run: () => openSettings('general') },
    { id: 's-persona', group: '设置', label: '助手名字、头像与风格', icon: <Sparkle size={16} />, keywords: 'persona 人设 风格', run: () => openSettings('persona') },
    { id: 's-abilities', group: '设置', label: '本机能力与权限', icon: <ShieldWarning size={16} />, keywords: '权限 能力', run: () => openSettings('abilities') },
    ...(providerStore && chatServices.length > 1 ? [{ id: 'svc-default', group: '本次对话使用的服务', label: '默认（' + (providerStore.profiles.find(item => item.id === providerStore.defaultId)?.name || '') + '）', icon: <Sparkle size={16} />, run: () => setChatProfile('') }, ...chatServices.filter(item => item.id !== providerStore.defaultId).map(item => ({ id: 'svc-' + item.id, group: '本次对话使用的服务', label: item.name, hint: item.model, icon: <Sparkle size={16} />, run: () => setChatProfile(item.id) }))] : []),
    ...jobCtl.jobs.filter(item => ['running', 'waiting', 'scheduled'].includes(item.status)).slice(0, 6).map(item => ({ id: 'job-' + item.id, group: '后台任务', label: item.title, hint: item.status === 'waiting' ? '等你确认' : item.status === 'running' ? '运行中' : '已安排', icon: <Lightning size={16} />, run: () => { setJobFocus(item.id); navigate('jobs') } })),
    ...workspace.sessions.slice(0, 12).map(item => ({ id: 'chat-' + item.id, group: '最近对话', label: item.title, icon: <ChatCircle size={16} />, run: () => selectSession(item) })),
  ]
  const shownSessions = workspace.sessions.filter(session => !search.trim() || (session.title + '\n' + session.messages.map(message => message.content).join('\n')).includes(search.trim()))
  const groupedSessions = (() => {
    const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const today = dayStart(new Date())
    const buckets: { label: string; items: Session[] }[] = [{ label: '今天', items: [] }, { label: '昨天', items: [] }, { label: '过去 7 天', items: [] }, { label: '更早', items: [] }]
    for (const session of shownSessions) {
      const days = Math.round((today - dayStart(new Date(session.updated))) / 86400000)
      buckets[days <= 0 ? 0 : days === 1 ? 1 : days <= 7 ? 2 : 3].items.push(session)
    }
    return buckets.filter(bucket => bucket.items.length)
  })()
  const activeService = providerStore?.profiles.find(item => item.id === (providerStore.profiles.some(entry => entry.id === chatProfile) ? chatProfile : providerStore.defaultId))

  const section = ['memory', 'learning'].includes(view) ? 'about' : ['connectors', 'abilities', 'services', 'core', 'control', 'usage', 'browser'].includes(view) ? 'tools' : view === 'home' ? 'home' : view === 'history' ? 'history' : 'work'
  const primaryNavigation: { id: View; section: string; label: string; icon: typeof Sun }[] = [
    { id: 'home', section: 'home', label: '此刻', icon: Sun },
    { id: 'work', section: 'work', label: '一起在做', icon: CheckCircle },
    { id: 'memory', section: 'about', label: '关于你', icon: Fingerprint },
    { id: 'connectors', section: 'tools', label: '工具与连接', icon: Plug },
  ]
  const workEntries = collectWork(workspace, assistantState, jobCtl.jobs, runningSessions)
  const openEntry = (entry: WorkEntry) => {
    if (entry.job) { setJobFocus(entry.job.id); navigate('jobs'); return }
    if (entry.record) { navigate('tasks'); return }
    const session = workspace.sessions.find(item => item.id === entry.sessionId)
    if (session) { selectSession(session); return }
    if (entry.sessionId) { void openCoreSession({ session: entry.sessionId, user_id: assistantState?.profile.user_id || '', latest_message_preview: entry.title, latest_message_at: entry.time, message_count: 0 }); return }
    notify('这件事没有关联交流，可以从新的要求继续')
  }
  const continueEntry = (entry: WorkEntry) => {
    if (entry.record) {
      const session = workspace.sessions.find(item => item.id === entry.sessionId)
      if (session) selectSession(session)
      else { const session = { ...blankSession(), mode, draft: '继续处理这件事：' + entry.title + (entry.record.notes ? '\n' + entry.record.notes : '') }; setWorkspace(previous => ({ ...previous, sessions: [session, ...previous.sessions] })); selectSession(session) }
    } else openEntry(entry)
  }
  const changeWorkbench = (value: Partial<WorkbenchState>) => setWorkspace(previous => ({ ...previous, workbench: normalizeWorkbench({ ...previous.workbench, ...value }) }))
  const changeWorkDraft = (id: string, value: string, expected?: string) => setWorkspace(previous => {
    const state = normalizeWorkbench(previous.workbench)
    if (expected !== undefined && (state.drafts[id] || '') !== expected) return previous
    return { ...previous, workbench: normalizeWorkbench({ ...state, drafts: { ...state.drafts, [id]: value } }) }
  })
  const createWork = async (value: NewWorkValue): Promise<boolean> => {
    if (!window.memoryDesktop) throw new Error('请在桌面程序中创建任务')
    const job = await jobCtl.create(value)
    if (!job) return false
    setWorkCreating(false); setWorkFocus('job:' + job.id); setInitialWorkFilter('all'); changeWorkbench({ selected: 'job:' + job.id }); setPreview(null); setView('work')
    return true
  }
  const instructEntry = async (entry: WorkEntry, text: string): Promise<boolean> => {
    if (!window.memoryDesktop) throw new Error('请从桌面程序处理任务')
    if (entry.job) return !!(await jobCtl.instruct(entry.job.id, text))
    if (entry.sessionId && [...requests.current.values()].some(turn => turn.sessionId === entry.sessionId)) throw new Error('这项任务正在处理，请等待或停止当前任务')
    let session = workspace.sessions.find(item => item.id === entry.sessionId)
    if (!session) {
      const id = entry.sessionId || crypto.randomUUID()
      const history = entry.sessionId && !entry.record ? await window.memoryDesktop.coreHistory(entry.sessionId) : { items: [] }
      session = { id, title: entry.title, updated: new Date().toISOString(), mode: 'core', messages: history.items.map(item => ({ id: item.record_id, role: item.role, content: item.content, source: 'core' as const })) }
      setWorkspace(previous => ({ ...previous, sessions: [session!, ...previous.sessions] }))
    }
    setActiveId(session.id); setMode(session.mode); setWorkFocus(entry.id)
    return (await performSend(workInstruction(entry, text), { session, keepWork: true, attachments: [], target: null, consent: false })) === true
  }
  const settingProps = { settings, coreNote, close: () => setSettingsOpen(false), checkCore, startCore, persona, onPersona: setPersona, notify,
    providersChanged: (store: ProviderStore) => { setProviderStore(store); if (!store.profiles.some(item => item.id === chatProfile)) setChatProfile('') },
    save: (value: ConnectionSettings) => { setSettings(value); if (value.coreUrl !== settings.coreUrl || value.hasCoreToken !== settings.hasCoreToken) { setCore('disconnected'); setCoreNote('设置已更新，请重新检查连接') } },
  }
  const composerArea = <div className="composer-area" onDragOver={event => event.preventDefault()} onDrop={handleDrop}>
        {mode === 'core' && desktopTarget && <div className="desktop-scope-panel">
          <div>
            <Monitor size={16} />
            <b>{desktopTarget ? desktopTarget.title : t("让 AI 操作一个软件窗口")}</b>
            <button type="button" disabled={busy} onClick={selectDesktopWindow}>{desktopTarget ? t("重新选择") : t("选择当前软件")}</button>
            {desktopTarget && <button type="button" disabled={busy} onClick={() => { setDesktopTarget(null); setDesktopConsent(false) }}>{t("清除")}</button>}
            {desktopTarget && <button type="button" disabled={busy} style={{ color: desktopConsent ? '#22c55e' : 'var(--accent)', fontWeight: 600 }} onClick={() => { setPendingDesktopText(input.trim()); setDesktopAuthOpen(true) }}>{desktopConsent ? t("✓ 本轮已确权") : t("确权弹窗")}</button>}
          </div>
          {desktopTarget ? <>
            <p>{desktopTarget.process}{t("· 本轮最多 12 个动作 · 5 分钟有效 · 点击、文本输入、编辑按键")}</p>
            <label><input type="checkbox" checked={desktopConsent} disabled={busy || !settings.endpoint || !settings.model} onChange={event => setDesktopConsent(event.target.checked)} />{t("允许为本轮目标读取此窗口的界面文字并交给已配置 AI，执行上述低风险操作。")}</label>
            <small>AI：{settings.model || t("尚未配置")} · {settings.endpoint || t("请在设置中填写地址")}{t("。删除、提交等动作会停止，需另行确认。不会上传截图。")}</small>
          </> : <p>{t("先打开目标软件，再回到这里选择。任务运行时助手会最小化；切换目标会使执行停止。")}</p>}
          {busy && desktopProgress && <p role="status">{systemText(desktopProgress)}</p>}
        </div>}

        {attachments.length > 0 && <div className="attachments">{attachments.map((file, index) => <div className="attachment" key={index}>{file.isImage && file.dataUrl ? <img src={file.dataUrl} alt={file.name} style={{ width: 26, height: 26, objectFit: 'cover', borderRadius: 4 }} /> : <FileText size={16} />}<span><b>{file.name}</b><small>{size(file.size)} · {file.isImage ? t("图片已就绪") : (file.kind || t("文件正文"))}{file.truncated ? t(" · 正文已截取") : ''}</small></span><IconButton label={t("移除附件 {p0}", { p0: file.name })} onClick={() => setAttachments(previous => previous.filter((_file, current) => current !== index))}><X size={13} /></IconButton></div>)}</div>}

        <form className="composer" onSubmit={send}>
          {/^\/\S*$/.test(input) && <div className="slash-menu" role="listbox" aria-label={t("快捷命令")}>{[['/后台', '放到后台去做：/后台 每天 8 点汇总新闻'], ['/记住', '让我记住一件事：/记住 我不吃辣'], ['/新对话', '开始新对话'], ['/设置', '打开设置']].filter(([cmd]) => cmd.startsWith(input)).map(([cmd, hint]) => <button type="button" role="option" aria-selected="false" key={cmd} onClick={() => { if (cmd === '/新对话') { setInput(''); newChat() } else if (cmd === '/设置') { setInput(''); openSettings('ai') } else { setInput(cmd + ' '); composer.current?.focus() } }}><b>{cmd}</b><span>{hint}</span></button>)}</div>}
          <textarea ref={composer} value={input} onChange={event => setInput(event.target.value)} onPaste={handlePaste} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} placeholder={view === 'home' ? t("随时说一句，接着当前事情做…") : t("加一句要求，接着这件事做…")} rows={view === 'home' ? 1 : 2} aria-label={t("输入消息")} disabled={busy} />
          <div className="composer-toolbar">
            <div>
              <IconButton label={t("选择文件或图片")} onClick={pickFiles} disabled={busy}><Paperclip size={19} /></IconButton>
              {mode === 'core' && <button type="button" className={'chip toggle-chip' + (multiAgent ? ' on' : '')} aria-pressed={multiAgent} disabled={busy} onClick={() => setMultiAgent(!multiAgent)} title={t("规划 / 执行 / 审阅：三个工作者依次协作，最多 8 次模型调用")}><UsersThree size={14} />{t("规划·执行·审阅")}</button>}
              {chatServices.length > 1 && <select className="profile-picker" aria-label={t("本次对话使用的 AI 服务")} title={t("自动按任务能力选择服务，也可为这段对话指定服务")} value={chatServices.some(item => item.id === chatProfile) ? chatProfile : ''} disabled={busy} onChange={event => setChatProfile(event.target.value)}>
                <option value="">{t("自动：按任务能力分配")}</option>
                {chatServices.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
              </select>}
            </div>
            {busy ? <IconButton label={t("停止回复")} className="send-button" onClick={() => void stopReply()}><Square size={16} weight="fill" /></IconButton> : <button className="send-button" type="submit" title={t("发送消息")} aria-label={t("发送消息")} disabled={!input.trim() && attachments.length === 0}><ArrowUp size={19} weight="bold" /></button>}
          </div>
        </form>
        {view !== 'home' && active.messages.length === 0 && <div className="quick-start" aria-label={t("快速开始")}>
          <button type="button" onClick={() => prefill('帮我看看「下载」文件夹里有什么，按类型给出整理方案，先不要移动任何文件')}><Folder size={16} />{t("整理文件")}</button>
          <button type="button" onClick={() => prefill('帮我搜索并总结这个主题的最新进展：')}><Globe size={16} />{t("联网查资料")}</button>
          <button type="button" onClick={() => prefill('帮我写一份文档：')}><FileText size={16} />{t("写文档")}</button>
          <button type="button" onClick={() => prefill('明天早上九点提醒我')}><Clock size={16} />{t("设提醒")}</button>
          <button type="button" onClick={() => { setInput('/后台 '); composer.current?.focus() }}><Lightning size={16} />{t("交给后台")}</button>
          <button type="button" onClick={() => navigate('connectors')}><Plug size={16} />{t("连接服务")}</button>
        </div>}
        <div className="composer-note"><span>{t("Enter 发送，Shift+Enter 换行 · 完成以实际结果为准")}</span></div>
      </div>

  return <div className={`app ${mobileNav ? 'nav-open' : ''}`} data-view={view} data-ai-ready={!!settings.endpoint && !!settings.model} data-running-count={runningSessions.length}>
    {mobileNav && <button className="nav-backdrop" aria-label={t("关闭侧栏")} onClick={() => setMobileNav(false)} />}
    <aside className="sidebar presence-sidebar">
      <div className="brand"><Avatar value="mark" size={24} className="brand-mark" /><span className="brand-name">{BRAND_NAME}</span><button className="palette-hint" onClick={() => setPaletteOpen(true)} title={t("搜索与命令（Ctrl+K）")} aria-label={t("打开命令面板")}><MagnifyingGlass size={15} /></button></div>
      <button type="button" className="sidebar-new-work" onClick={newWork}><Plus size={18} /><span>{t("新事情")}</span><kbd>Ctrl N</kbd></button>
      <button type="button" className="sidebar-search" onClick={() => setPaletteOpen(true)}><MagnifyingGlass size={17} /><span>{t("搜索与操作")}</span><kbd>Ctrl K</kbd></button>
      <div className="sidebar-navigation-scroll"><span className="navigation-caption">{t("工作空间")}</span><nav aria-label={t("主导航")}>{primaryNavigation.map(item => <button type="button" key={item.id} className={`nav-item ${section === item.section ? 'active' : ''}`} aria-current={section === item.section ? 'page' : undefined} onClick={() => { if (item.id === 'work') setInitialWorkFilter('all'); navigate(item.id) }}><item.icon size={20} weight="regular" /><span>{t(item.label)}</span>{item.section === 'work' && jobWaiting > 0 && <span className="nav-dot" title={t("有任务等待确认")} />}</button>)}</nav>
      <SectionNavigation section={section} view={view} memoryTab={memoryTab} navigate={navigate} memory={next => { if (next === 'learning') navigate('learning'); else { setMemoryTab(next as MemoryTab); navigate('memory') } }} />
      </div>
      <div className="presence-sidebar-footer"><button type="button" className={'nav-item' + (view === 'history' ? ' active' : '')} onClick={() => navigate('history')}><ChatCircle size={19} />{t("交流记录")}</button><button type="button" className="nav-item" aria-label={t("设置")} onClick={() => openSettings('persona')}><GearSix size={19} />{t("设置")}</button><RuntimeStatus openWork={() => navigate('work')}><button type="button" className="presence-sidebar-state" onClick={() => navigate('work')}><span className={'status-dot' + (anyBusy || jobRunning ? ' ready' : '')} />{jobWaiting ? t("有事情等你确认") : anyBusy || jobRunning ? t("事情正在推进") : t("随时接着做")}</button></RuntimeStatus></div>
    </aside>

    <main className="main">
      <header className="topbar presence-topbar">
        <div className="topbar-left"><IconButton label={t("展开侧栏")} className="menu-mobile" onClick={() => setMobileNav(!mobileNav)}><List size={20} /></IconButton><span className="presence-topbar-label">{view === 'home' ? t("今天") : section === 'work' ? t("工作现场") : section === 'about' ? t("对你的理解与积累") : section === 'tools' ? t("可调用的能力") : t("之前的交流")}</span>
          {view === 'chat' && <div className="mode-wrap"><button className="mode-select" aria-label={t("选择工作模式")} onClick={() => setModelMenu(!modelMenu)} aria-expanded={modelMenu}><span className="ai-symbol"><Sparkle size={18} weight="fill" /></span>{mode === 'core' ? (settings.model ? t("智能助手") : t("本地核心")) : t("直接 AI")}<CaretDown size={13} /></button>{modelMenu && <><button className="popover-backdrop" aria-label={t("关闭模式选择")} onClick={() => setModelMenu(false)} /><div className="mode-menu"><button onClick={() => selectMode('core')}><Brain size={19} /><span><b>{t("智能助手")}</b><small>{t("长期记忆 + 全部本机工具；手动选定的软件窗口经核心审计")}</small></span>{mode === 'core' && <Check size={16} />}</button><button onClick={() => selectMode('live')}><Sparkle size={19} /><span><b>{t("直接 AI")}</b><small>{t("不经过核心；同样可用搜索、文件、命令与记忆")}</small></span>{mode === 'live' && <Check size={16} />}</button><button className="menu-settings" onClick={() => { openSettings('ai'); setModelMenu(false) }}><GearSix size={16} />{t("管理 AI 与核心连接")}</button></div></>}</div>}
        </div>
        <div className="topbar-right">
          {section === 'tools' && <div className="connection-status"><button className={'status-pill ai ' + (settings.endpoint && settings.model ? 'ready' : 'warn')} onClick={() => navigate('services')}><span className={`status-dot ${settings.endpoint && settings.model ? 'ready' : ''}`} />{settings.model ? activeService?.name || t("AI 已配置") : t("未配置 AI")}</button><button className={'status-pill core ' + (core === 'connected' ? 'ready' : '')} title={systemText(coreNote)} onClick={checkCore}><span className={`status-dot ${core === 'connected' ? 'ready' : ''}`} />{core === 'checking' ? t("连接中") : core === 'connected' ? t("核心在线") : t("检查核心连接")}</button></div>}
          {view === 'chat' && <IconButton label={inspector ? t("收起学习侧栏") : t("打开学习侧栏")} onClick={() => setInspector(!inspector)}><Fingerprint size={18} /></IconButton>}
          <IconButton className="theme-toggle" label={workspace.theme === 'light' ? t("切换深色") : t("切换浅色")} onClick={() => setWorkspace(previous => ({ ...previous, theme: previous.theme === 'light' ? 'dark' : 'light' }))}>{workspace.theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</IconButton>
          {window.memoryDesktop && <div className="window-actions"><IconButton label={t("最小化")} onClick={() => window.memoryDesktop?.window('minimize')}><Minus size={16} /></IconButton><IconButton label={t("最大化或还原")} onClick={() => window.memoryDesktop?.window('maximize')}><Square size={12} /></IconButton><IconButton label={t("关闭窗口")} className="close-window" onClick={() => window.memoryDesktop?.window('close')}><X size={17} /></IconButton></div>}
        </div>
      </header>

      {view !== 'jobs' && jobWaiting > 0 && (() => { const job = jobCtl.jobs.find(item => item.status === 'waiting')!; return <div className="job-banner" role="status"><ShieldWarning size={17} weight="fill" /><span>{t("后台任务「")}{job.title}{t("」在等你确认：")}{job.approval?.title}{jobWaiting > 1 ? t("（还有 {p0} 个）", { p0: (jobWaiting - 1) }) : ''}</span><button type="button" onClick={() => { setWorkFocus('job:' + job.id); setWorkCreating(false); setInitialWorkFilter('all'); navigate('work') }}>{t("查看并确认")}</button></div> })()}
      <div className="content-shell"><div className={'presence-body presence-section-' + section}>
        {['abilities','services','core'].includes(view) && <div className="presence-view-header"><div className="presence-page-heading"><div><h1>{view === 'abilities' ? t("本机能力") : view === 'services' ? t("AI 服务") : t("核心连接")}</h1><p>{view === 'abilities' ? t("查看助手能做什么，并管理工具的使用范围。") : view === 'services' ? t("管理可调用的模型服务与连接。") : t("本地记忆、持续任务与核心运行状态。")}</p></div></div></div>}
        <div className="presence-view-content">
        {view === 'home' && <PresenceHome name={persona.name} entries={workEntries} checkpoints={checkpointState.items} memories={memStore.memories} latest={lastReply(active)} busy={anyBusy} composer={<NewWorkForm compact draft={normalizeWorkbench(workspace.workbench).drafts['new-work'] || ''} changeDraft={(value, expected) => changeWorkDraft('new-work', value, expected)} create={createWork} available={!!window.memoryDesktop} />} open={entry => { setWorkFocus(entry.id); navigate('work') }} openWork={filter => { setInitialWorkFilter(filter || 'all'); navigate('work') }} facts={assistantState?.continuity?.facts || []} suggest={text => changeWorkDraft('new-work', text)} openMemory={() => navigate('memory')} desktop={!!window.memoryDesktop} away={() => void window.memoryDesktop?.window('minimize')} />}
        {view === 'work' && <WorkScene entries={workEntries} focus={workFocus} open={openEntry} newWork={newWork} creating={workCreating} closeCreation={() => setWorkCreating(false)} create={createWork} actJob={jobCtl.act} preview={setPreview} continueWork={continueEntry} checkpoints={checkpointState.items} workbench={normalizeWorkbench(workspace.workbench)} initialFilter={initialWorkFilter} ready={(assistantReady && jobCtl.ready) || !window.memoryDesktop} connectionError={assistantReady && core === 'disconnected' ? coreNote : undefined} reconnect={() => void refreshAssistant(true)} changeWorkbench={changeWorkbench} changeDraft={changeWorkDraft} instruct={instructEntry} busySessions={runningSessions} stop={sessionId => void stopReply(sessionId)} />}
        {view === 'history' && <HistoryPage sessions={workspace.sessions} runningSessions={runningSessions} query={search.trim()} setQuery={setSearch} open={selectSession} remove={deleteSession} create={newChat} />}
        {['abilities', 'services', 'core'].includes(view) && <SettingsModal key={view} embedded initialTab={view === 'abilities' ? 'abilities' : view === 'services' ? 'ai' : 'core'} {...settingProps} />}

        {view === 'chat' && <section className={'chat-workspace' + (active.messages.length === 0 ? ' empty' : '')}><div className="chat-scroll">{!settings.endpoint && <div className="model-hint"><Sparkle size={14} /><span>{t("还没有配置 AI：现在只能由本地核心做简单回复，不能搜索、写文件或打开软件。")}</span><button onClick={() => openSettings('ai')}>{t("去配置")}</button></div>}{active.messages.length === 0 ? <div className="welcome"><Avatar value={persona.avatar} size={48} className="welcome-mark" /><h1>{greeting()}{t("，今天想完成什么？")}</h1><p>{memStore.stats?.memories ? t("我记得关于你的 {p0} 件事，回答时会参考。", { p0: memStore.stats.memories }) : t("聊得越多，我越了解你的习惯。")}</p></div> : <div className="messages">{active.messages.map(message => <div key={message.id} className={`message ${message.role} ${message.error ? 'message-error' : ''}`}>{message.role === 'assistant' && <Avatar value={persona.avatar} size={26} className="assistant-mark" />}<div className="message-content">{message.role === 'assistant' && <div className="message-author">{persona.name} <span>{message.source === 'core' ? t("本地主体") : message.core ? t("AI · 待验证建议") : 'AI'}</span></div>}
              {message.images && message.images.length > 0 && <div className="message-images" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '6px 0' }}>{message.images.map((img, i) => <img key={i} src={img} alt={t("附件图片")} style={{ maxWidth: '280px', maxHeight: '180px', borderRadius: '8px', border: '1px solid var(--border)', objectFit: 'contain', background: 'rgba(0,0,0,0.05)' }} />)}</div>}
              {message.role === 'assistant' && <WorkProcess message={message} running={(busy && message.id === active.messages.at(-1)?.id) || !!message.steps?.some(step => step.status === 'running')} />}{message.content ? (message.role === 'assistant' ? <MessageRenderer content={message.content} onPreview={setPreview} /> : <div className="message-text">{message.content}</div>) : <div className="thinking"><span /><span /><span /><small>{t("正在回复")}</small></div>}
              {message.artifacts?.map((artifact,i)=><button className="artifact-link" key={i} onClick={()=>setPreview(artifact)}>{t("查看")}{artifact.title} ↗</button>)}
              {message.core && <CoreEvidence receipt={message.core} />}
              {message.role==='assistant' && <ConversationWorkDetails work={assistantState?.works.find(work=>work.id===(message.coreWorkId || message.core?.turnId))} />}
              {message.role==='assistant' && !!message.content && !message.error && !busy && <button className="persistent-promote" onClick={()=>{const question=active.messages[active.messages.findIndex(entry=>entry.id===message.id)-1];const title=(question?.raw?.text||question?.content||active.title).slice(0,200);const now=new Date().toISOString();setWorkspace(prev=>({...prev,tasks:[{id:crypto.randomUUID(),title,notes:message.content.slice(0,3000),sessionId:active.id,status:'active',createdAt:now,updatedAt:now},...(prev.tasks||[])]}));notify('已加入持续任务；可以从任务页回到这段对话继续跟进')}}>{t("加入持续任务")}</button>}
              {message.warning && <p className={message.error ? 'error-text' : 'notice-text'}>{message.warning}</p>}
              {message.role === 'assistant' && message.subject && <SubjectBadge subject={message.subject} />}
              {message.requirementsCheck && <RequirementChecks report={message.requirementsCheck} />}
              {message.role === 'assistant' && <MemoryTrail message={message} onOpenMemory={() => navigate('memory')} onForget={item => void forgetLearned(message.id, item)} />}
              {message.role === 'assistant' && (message.content || message.error) && <div className="message-footer"><button onClick={async () => { try { await navigator.clipboard.writeText(message.content); notify('已复制') } catch { notify('复制失败，请手动选择文本') } }}><Copy size={13} />{t("复制")}</button><button onClick={() => speak(message.content)}><SpeakerHigh size={13} />{t("朗读")}</button>{!busy && (message.error || message.id === active.messages.at(-1)?.id) && <button onClick={() => retryReply(message.id)}><ArrowClockwise size={13} />{message.error ? t("重试") : t("重新生成")}</button>}{!busy && mode === 'core' && message.steps?.some(step => step.status === 'ok' && step.label.startsWith('启动：')) && <button onClick={() => void operateOpenedWindow()}><Monitor size={13} />{t("软件打开后，点这里让 AI 操作它")}</button>}{!busy && !message.error && <FeedbackBar message={message} question={active.messages[active.messages.findIndex(entry => entry.id === message.id) - 1]?.raw?.text || ''} notify={notify} onVoted={vote => updateMessages(active.id, messages => messages.map(entry => entry.id === message.id ? { ...entry, vote } : entry))} />}{message.service && <span title={message.service.reason}>{message.service.name} · {message.service.model}</span>}{message.usage !== undefined && <span>{t("服务报告")}{message.usage.toLocaleString()} tokens</span>}{message.error && <span className="error-text"><WarningCircle size={13} />{t("未完成")}</span>}</div>}
            </div>
          </div>)}
          <div ref={chatEnd} />
        </div>}
      </div>

      {composerArea}
    </section>}

        {('chat work jobs changes'.split(' ').includes(view)) && preview && <PreviewPane value={preview} close={() => setPreview(null)} hidden={settingsOpen || desktopAuthOpen || !!desktopApproval} />}
        {view === 'chat' && inspector && !preview && <aside className="inspector"><div className="inspector-heading"><Brain size={18} /><b>{t("记忆与操作")}</b><IconButton label={t("收起侧栏")} onClick={() => setInspector(false)}><X size={15} /></IconButton></div><p className="inspector-intro">{t("这里显示最近一条回答参考了哪些记忆、做了哪些操作。")}</p><div className="inspector-section-title"><span>{t("参考的记忆")}</span><span>{String((lastAssistant?.memoryUsed?.length || 0) + (lastAssistant?.playbooksUsed?.length || 0)).padStart(2, '0')}</span></div>{(lastAssistant?.memoryUsed?.length || lastAssistant?.playbooksUsed?.length) ? <div className="mini-traces">{lastAssistant?.memoryUsed?.map(item => <button key={item.id} onClick={() => navigate('memory')}><span className="trace-dot" /><div><b>{item.text.slice(0, 40)}</b><small>{item.kind}</small></div><CaretRight size={13} /></button>)}{lastAssistant?.playbooksUsed?.map(item => <button key={item.id} onClick={() => navigate('memory')}><span className="trace-dot" /><div><b>{item.title}</b><small>{t("经验手册")}</small></div><CaretRight size={13} /></button>)}</div> : <div className="inspector-empty"><BookOpen size={25} weight="light" /><b>{t("还没有用到记忆")}</b><p>{t("聊聊你的习惯和偏好，下一次它就会参考。")}</p></div>}<div className="inspector-section-title"><span>{t("本轮操作")}</span><span>{String(lastAssistant?.steps?.length || 0).padStart(2, '0')}</span></div>{lastAssistant?.steps?.length ? <div className="mini-traces">{lastAssistant.steps.map((step, index) => <button key={index} onClick={() => navigate('tasks')}><span className="trace-dot" /><div><b>{step.label}</b><small>{step.status === 'ok' ? t("完成") : step.status === 'failed' ? t("失败") : t("进行中")}</small></div><CaretRight size={13} /></button>)}</div> : <div className="inspector-empty"><Lightning size={25} weight="light" /><b>{t("没有执行操作")}</b><p>{t("需要时它会搜索、读写文件或打开软件。")}</p></div>}<div className="inspector-footer"><span className="core-offline"><Brain size={11} />{memStore.stats?.memories ?? 0}{t("条记忆 ·")}{memStore.stats?.playbooks ?? 0}{t("套做法")}</span><button onClick={() => navigate('learning')}>{t("看看它学到了什么")}<ArrowRight size={14} /></button></div></aside>}

        {(view === 'jobs' || view === 'changes') && <JobsPage key={view} initialTab={view === 'changes' ? 'changes' : 'active'} ctl={jobCtl} checkpoints={checkpointState.items} reloadCheckpoints={checkpointState.reload} notify={notify} focusId={jobFocus} clearFocus={() => setJobFocus('')} preview={setPreview} />}

        {view === 'connectors' && <ConnectorsPage connectors={connectorState.connectors} setConnectors={connectorState.setConnectors} notify={notify} />}

        {view === 'tasks' && <TasksPage workspace={workspace} setWorkspace={setWorkspace} openSession={id=>{const session=workspace.sessions.find(s=>s.id===id);if(session)selectSession(session)}} />}

        {view === 'learning' && <LearningPage store={memStore} assistantState={assistantState} refreshAssistant={() => void refreshAssistant()} replay={replayMethod} busy={busy} exportData={exportData} openMemory={() => navigate('memory')} coreLearning={coreLearning} refreshCoreMemory={refreshCoreMemory} coreOnline={core === 'connected'} />}

        {view === 'memory' && <MemoryPage activeTab={memoryTab} onTabChange={setMemoryTab} workspace={workspace} selectSession={selectSession} deleteSession={deleteSession} coreSessions={coreSessions} openCoreSession={openCoreSession} refreshCoreMemory={refreshCoreMemory} assistantState={assistantState} refreshAssistant={() => void refreshAssistant()} saveProfile={async value => { try { await window.memoryDesktop!.saveProfile(value); await refreshAssistant(); notify('用户档案已保存到核心') } catch (error) { notify(cleanError(error)) } }} notify={notify} exportData={exportData} store={memStore} />}

        {view === 'goals' && <GoalsPage workspace={workspace} setWorkspace={setWorkspace} reminders={reminders} setReminders={setReminders} notify={notify} />}
        {view === 'operations' && <LongGoalsPage openJob={id => { setJobFocus(id); navigate('jobs') }} openUsage={() => navigate('usage')} />}
        {view === 'usage' && <UsagePanel />}
        {view === 'browser' && <BrowserPage />}

        {view === 'control' && <ControlPage coreOnline={core === 'connected'} busy={busy} target={desktopTarget} selectWindow={selectDesktopWindow} clearTarget={() => { setDesktopTarget(null); setDesktopConsent(false) }} goChat={() => setView('chat')} checkCore={checkCore} instruction={controlInput} setInstruction={setControlInput} runTask={desktopTask} receipt={desktopReceipt && <CoreEvidence receipt={desktopReceipt} />} controlLog={controlLog} loadLog={async () => { if (!window.memoryDesktop) return notify('请在桌面程序中读取核心操作记录'); try { const result = await window.memoryDesktop.controlLog(); setControlLog(result.data) } catch (error) { notify(cleanError(error)) } }} notify={notify} />}
        </div>
      </div></div>
    </main>
    <input
      ref={upload}
      type="file"
      multiple
      accept="image/*,.pdf,.docx,.txt,.md,.json,.csv,.rs,.py,.js,.ts,.html,.css,.xml,.yaml,.yml,.log"
      hidden
      onChange={event => {
        const files = Array.from(event.target.files || [])
        for (const file of files) {
          const isImage = file.type.startsWith('image/')
          if (isImage) {
            const reader = new FileReader()
            reader.onload = ev => {
              const dataUrl = ev.target?.result as string
              setAttachments(prev => [...prev, { name: file.name, size: file.size, isImage: true, dataUrl }].slice(0, 10))
            }
            reader.readAsDataURL(file)
          } else {
            setAttachments(prev => [...prev, { name: file.name, size: file.size, isImage: false }].slice(0, 10))
          }
        }
        event.target.value = ''
      }}
    />
    {desktopAuthOpen && <DesktopAuthModal
      text={pendingDesktopText || input.trim()}
      target={desktopTarget}
      settings={settings}
      onSelectTarget={selectDesktopWindow}
      onAuthorizeAndSend={() => {
        setDesktopConsent(true)
        setDesktopAuthOpen(false)
        void performSend(pendingDesktopText || input.trim(), { target: desktopTarget, consent: true })
      }}
      onSendAsPlain={() => {
        setDesktopAuthOpen(false)
        void performSend(pendingDesktopText || input.trim(), { forcePlain: true })
      }}
      onClose={() => setDesktopAuthOpen(false)}
    />}
    {actionApproval && <ActionApprovalModal key={actionApproval.approvalId}
      approval={actionApproval}
      onResolve={async approved => {
        await window.memoryDesktop?.resolveDesktopApproval({
          approvalId: actionApproval.approvalId,
          approved,
        })
        dismissApproval(actionApproval.approvalId)
        notify(approved ? '批准意愿已记录；实际执行以核心回执为准' : '已拒绝此高风险操作')
      }}
    />}
    {toolApproval && <ToolApprovalModal key={toolApproval.approvalId} approval={toolApproval} onResolve={async decision => { try { await window.memoryDesktop?.resolveDesktopApproval({ approvalId: toolApproval.approvalId, decision }) } finally { dismissApproval(toolApproval.approvalId) } }} />}
    {paletteOpen && <CommandPalette commands={paletteCommands} close={() => setPaletteOpen(false)} />}
    {settingsOpen && <SettingsModal initialTab={settingsTab} notify={notify} settings={settings} coreNote={coreNote} close={() => setSettingsOpen(false)} checkCore={checkCore} startCore={startCore} persona={persona} onPersona={setPersona} providersChanged={store => { setProviderStore(store); if (!store.profiles.some(item => item.id === chatProfile)) setChatProfile('') }} save={value => { setSettings(value); setCore('disconnected'); setCoreNote('设置已更新，请重新检查连接'); notify('连接设置已保存') }} />}
    {toast && <div className="toast" role="status"><Check size={16} /><span>{systemText(toast)}</span><IconButton label={t("关闭提示")} onClick={() => setToast('')}><X size={14} /></IconButton></div>}
  </div>
}

function DesktopAuthModal({
  text,
  target,
  settings,
  onSelectTarget,
  onAuthorizeAndSend,
  onSendAsPlain,
  onClose,
}: {
  text: string
  target: DesktopSelection | null
  settings: ConnectionSettings
  onSelectTarget: () => Promise<void>
  onAuthorizeAndSend: () => void
  onSendAsPlain: () => void
  onClose: () => void
}) {
  const [selecting, setSelecting] = useState(false)
  const handleSelect = async () => {
    setSelecting(true)
    try {
      await onSelectTarget()
    } finally {
      setSelecting(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
        <div className="modal-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldCheck size={20} weight="bold" color="var(--accent)" />
              <h2 id="auth-modal-title">{t("桌面软件任务确权")}</h2>
              <Badge tone="amber">{t("单轮前置授权")}</Badge>
            </div>
            <p>{t("识别到软件操作意图。为保障系统安全，PISCES AI需先绑定目标窗口并取得本轮确权。")}</p>
          </div>
          <IconButton label={t("关闭")} onClick={onClose}><X size={19} /></IconButton>
        </div>

        <div className="auth-body">
          <div className="auth-intent-box">
            <small>{t("待执行的任务意图")}</small>
            <b>{text || t("在软件窗口中执行操作")}</b>
          </div>

          <div className="auth-section-title">
            <span>{t("1. 目标软件窗口")}</span>
            <span style={{ fontSize: '11px', color: target ? 'var(--accent)' : 'var(--muted)' }}>
              {target ? t("● 窗口已绑定") : t("○ 尚未绑定")}
            </span>
          </div>

          <div className={`auth-target-card ${target ? 'ready' : ''}`}>
            <div className="auth-target-info">
              <Monitor size={24} weight={target ? 'fill' : 'regular'} color={target ? 'var(--accent)' : 'var(--muted)'} />
              <div className="auth-target-text">
                <b>{target ? target.title : t("未绑定目标软件窗口")}</b>
                <small>{target ? t("{p0} · PID {p1} · 5分钟内有效", { p0: target.process, p1: target.id.split(':')[0] || 'active' }) : t("先在电脑中打开目标软件（如 Word），再点击右侧按钮捕获")}</small>
              </div>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={selecting}
              onClick={handleSelect}
              style={{ whiteSpace: 'nowrap' }}
            >
              {selecting ? t("正在捕获…") : target ? t("更换窗口") : t("捕获当前软件")}
            </button>
          </div>

          <div className="auth-section-title">
            <span>{t("2. 确权与安全范围")}</span>
          </div>

          <div className="auth-scope-list">
            <div className="auth-scope-item">
              <Check size={15} color="#22c55e" />
              <span><strong>{t("界面感知：")}</strong>{t("仅读取该窗口的 UI 控件文字结构；")}<strong>{t("不上传屏幕截图")}</strong>。</span>
            </div>
            <div className="auth-scope-item">
              <Check size={15} color="#22c55e" />
              <span><strong>{t("低风险动作：")}</strong>{t("仅在文档/输入框中执行点击、文字录入与必要编辑键（单轮最多 12 个动作）。")}</span>
            </div>
            <div className="auth-scope-item">
              <WarningCircle size={15} color="#f59e0b" />
              <span><strong>{t("安全边界：")}</strong>{t("严禁删除、提交、发送、支付、全局快捷键；切换或关闭目标窗口立即停止。")}</span>
            </div>
            <div className="auth-scope-item">
              <Sparkle size={15} color="var(--accent)" />
              <span><strong>{t("外部顾问：")}</strong>{t("提取的界面文本将发送至已配置的 AI（")}{settings.model || t("尚未配置模型")}）。</span>
            </div>
          </div>
        </div>

        <div className="auth-footer">
          <button type="button" className="button secondary" onClick={onSendAsPlain}>{t("仅作普通问答发送（不操作软件）")}</button>
          <div className="auth-footer-actions">
            <button type="button" className="button secondary" onClick={onClose}>{t("取消")}</button>
            <button
              type="button"
              className="button primary"
              disabled={!target || selecting}
              onClick={onAuthorizeAndSend}
            >
              <Check size={15} weight="bold" />{t("确认授权并立即执行")}</button>
          </div>
        </div>
      </section>
    </div>
  )
}

function CoreEvidence({ receipt }: { receipt: CoreReceipt }) {
  return <details className="core-receipt"><summary><Brain size={15} /><span>{t("本地主体回执")}</span><Badge>{receipt.desktop ? t("桌面状态：{p0}", { p0: String(receipt.desktop.execution || 'unknown') }) : t("对话已接收")}</Badge><CaretDown size={13} /></summary><p>{t("回执证明核心接收了本轮。事实正确性与方法习得需要另行验证。")}</p><small>{t("回合")}{receipt.turnId}</small><div className="message-text">{receipt.reply}</div><pre className="core-json">{JSON.stringify(receipt.desktop || receipt.evidence, null, 2)}</pre></details>
}

function ActionApprovalModal({ approval, onResolve }: { approval: DesktopActionApproval; onResolve: (approved: boolean) => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false)
  const resolve = async (approved: boolean) => {
    setSubmitting(true)
    try { await onResolve(approved) } finally { setSubmitting(false) }
  }
  const p = (approval.proposal || {}) as Record<string, unknown>
  const opName = String(p.operation || approval.operation || '未知操作')
  const opLabel = opName === 'click' ? '鼠标点击' : opName === 'type_text' ? '键盘文本输入' : opName === 'scroll' ? '页面翻页滚动' : opName === 'key_chord' ? '按键组合' : opName

  return (
    <div className="modal-backdrop">
      <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title" style={{ maxWidth: 540 }}>
        <div className="modal-header">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <WarningCircle size={22} weight="bold" color="#eab308" />
              <h2 id="approval-title">{t("高风险动作人工审批")}</h2>
              <Badge tone="amber">{t("需要用户确认")}</Badge>
            </div>
            <p>{t("AI 正在请求执行关键操作。为防止意外提交或破坏性修改，需经您授权确认。")}</p>
          </div>
        </div>
        <div className="auth-body">
          <div className="auth-intent-box" style={{ borderColor: 'rgba(234, 179, 8, 0.4)' }}>
            <small>{t("目标软件窗口")}</small>
            <b>{approval.windowTitle || t("当前前台授权窗口")}</b>
          </div>
          <div style={{ background: 'var(--surface-subtle)', padding: 14, borderRadius: 10, fontSize: 13, border: '1px solid var(--border)' }}>
            <div style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>{t("操作类型:")}</span>
              <b>{opLabel}</b>
            </div>
            {Boolean(p.element_id) && (
              <div style={{ marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>{t("目标控件 ID:")}</span>
                <code>{String(p.element_id)}</code>
              </div>
            )}
            {Boolean(p.text) && (
              <div style={{ marginBottom: 6 }}>
                <span style={{ color: 'var(--text-muted)', display: 'block' }}>{t("输入文本内容:")}</span>
                <div style={{ background: 'var(--surface)', padding: '6px 8px', borderRadius: 6, marginTop: 4, fontFamily: 'monospace' }}>{String(p.text)}</div>
              </div>
            )}
            {approval.reason && (
              <div style={{ marginTop: 8, color: '#eab308', fontSize: 12 }}>
                <span>{t("安全拦截说明:")}{approval.reason}</span>
              </div>
            )}
          </div>
          <p className="field-note">{t("点击「确认允许」后，助手将标记此关键步骤为已确权并继续执行后续步骤；点击「拒绝」则安全中止本次动作。")}</p>
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" className="button secondary" disabled={submitting} onClick={() => resolve(false)}>
            <X size={15} />{t("拒绝此操作")}</button>
          <button type="button" className="button primary" disabled={submitting} style={{ background: '#16a34a', borderColor: '#16a34a' }} onClick={() => resolve(true)}>
            <Check size={15} />{t("确认允许并继续")}</button>
        </div>
      </section>
    </div>
  )
}
