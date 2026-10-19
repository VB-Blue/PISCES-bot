import { t, languages, useLocale, setLocale, type Locale } from './i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Lightning, UsersThree, CursorClick, FolderOpen, Globe, Plus, RocketLaunch, Terminal, Trash } from '@phosphor-icons/react'
import type { Prefs } from './types'
import { IconButton, Toggle, cleanError } from './ui'
import { RuntimeRecovery } from './RuntimeStatus'

export function usePrefs(notify: (text: string) => void) {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const generation = useRef(0), wasReady = useRef(false)
  const reload = useCallback(async () => {
    if (!window.memoryDesktop) { setLoading(false); return }
    setLoading(true)
    const request = ++generation.current
    try { const value = await window.memoryDesktop.prefs(); if (request === generation.current) { setPrefs(value); setError('') } }
    catch (reason) { if (request === generation.current) setError(cleanError(reason)) }
    finally { if (request === generation.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void reload()
    return window.memoryDesktop?.onRuntimeState?.(state => {
      const ready = state.online && state.ready && !state.stopping
      if (ready && !wasReady.current) void reload()
      else if (state.stopped || state.stopping) { generation.current++; setError(t('后台执行已停止')); setLoading(false) }
      wasReady.current = ready
    })
  }, [reload])
  const update = useCallback(async (patch: Partial<Prefs>) => {
    if (!window.memoryDesktop || !prefs) return
    const previous = prefs
    setPrefs({ ...prefs, ...patch })
    try { setPrefs(await window.memoryDesktop.savePrefs({ ...prefs, ...patch })) } catch (error) { setPrefs(previous); notify(cleanError(error)) }
  }, [prefs])
  return { prefs, update, loading, error, reload }
}

const rows = [
  { key: 'web', icon: Globe, title: '联网搜索与读网页', text: '搜索资料、读取网页正文。只读，不会提交表单；访问你没提到过的网站前会先问你。' },
  { key: 'files', icon: FolderOpen, title: '查看与读取文件', text: '自动读取下面“可访问的文件夹”里的文件；其他位置会先问你。写入文件永远需要你确认。' },
  { key: 'commands', icon: Terminal, title: '执行命令', text: '在 PowerShell 里执行命令。每一条都会先让你核对，危险命令直接禁止。' },
  { key: 'control', icon: CursorClick, title: '控制其他软件', text: '看到软件窗口（截图）并代你点击、拖动、输入、按快捷键，用来操作 Photoshop、Word 等。每个软件第一次都要你允许；操作时本程序最小化，按 Ctrl+Alt+Q 随时停止。需要支持图片输入的模型。' },
  { key: 'delegate', icon: UsersThree, title: '子代理（多代理协作）', text: '复杂任务里，AI 可以把互相独立的部分交给子代理并行处理（查资料、整理文件、操作软件）。子代理受同样的授权约束，不能再派生、不能改记忆；同一时间只有一个能操作屏幕。' },
  { key: 'background', icon: Lightning, title: '后台任务', text: '允许 AI 把耗时的、定时的事放到后台去做（创建前会问你）。后台任务里的每个敏感操作仍然会单独征求你的同意，你不在时会等你，并发通知提醒。' },
  { key: 'apps', icon: RocketLaunch, title: '启动软件与打开网址', text: '打开 Word、浏览器等软件或文件。第一次打开某个目标时会先问你。' },
] as const

export function CapabilityPanel({ notify }: { notify: (text: string) => void }) {
  const { prefs, update, loading, error, reload } = usePrefs(notify)
  if (!window.memoryDesktop) return <p className="field-note">{t("本机能力需要在桌面程序中管理。")}</p>
  if (error) return <RuntimeRecovery error={error} retry={reload} />
  if (loading || !prefs) return <p className="field-note">{t("正在读取…")}</p>
  const addFolder = async () => {
    try {
      const folder = await window.memoryDesktop!.pickFolder()
      if (folder && !prefs.roots.includes(folder)) await update({ roots: [...prefs.roots, folder] })
    } catch (error) { notify(cleanError(error)) }
  }
  return <div className="capability-panel">
    {rows.map(row => <div className="capability-row" key={row.key}><span className="capability-icon"><row.icon size={20} weight="light" /></span><div><b>{t(row.title)}</b><p>{t(row.text)}</p></div><Toggle checked={prefs[row.key]} label={t(row.title)} onChange={() => void update({ [row.key]: !prefs[row.key] })} /></div>)}
    <div className="roots">
      <div className="roots-head"><b>{t("已永久允许")}</b></div>
      {prefs.grants?.length ? <ul>{prefs.grants.map(grant => <li key={grant.key}><code>{grant.label}</code><IconButton label={t("撤销 {p0}", { p0: grant.label })} onClick={() => void update({ grants: prefs.grants.filter(item => item.key !== grant.key) })}><Trash size={14} /></IconButton></li>)}</ul> : <p className="field-note">{t("在授权弹窗里点“永久允许”后，网站、文件夹、软件会出现在这里，随时可以撤销。")}</p>}
    </div>
    <div className="roots">
      <div className="roots-head"><b>{t("可访问的文件夹")}</b><button type="button" className="button secondary" onClick={() => void addFolder()}><Plus size={14} />{t("添加文件夹")}</button></div>
      <ul>{prefs.defaultRoots?.filter(root => !prefs.roots.includes(root)).map(root => <li key={root}><code>{root}</code><small>{t("默认")}</small></li>)}
        {prefs.roots.map(root => <li key={root}><code>{root}</code><IconButton label={t("移除 {p0}", { p0: root })} onClick={() => void update({ roots: prefs.roots.filter(item => item !== root) })}><Trash size={14} /></IconButton></li>)}</ul>
    </div>
  </div>
}

function LanguagePreference({ notify }: { notify: (text: string) => void }) {
  const locale = useLocale(), [saving, setSaving] = useState(false)
  const change = async (value: Locale) => {
    const previous = locale; setSaving(true); setLocale(value)
    try { if (window.memoryDesktop) await window.memoryDesktop.saveUiLocale(value) }
    catch { setLocale(previous); notify(t('语言设置未能保存，请重试')) }
    finally { setSaving(false) }
  }
  return <div className="capability-row plain language-preference"><div><b>{t('界面语言')}</b><p>{t('立即切换界面语言，任务正文和记忆保持原文。')}</p></div><select aria-label={t('界面语言')} value={locale} disabled={saving} onChange={event => void change(event.target.value as Locale)}>{languages.map(language => <option key={language.id} value={language.id} lang={language.id}>{language.name}</option>)}</select></div>
}

export function GeneralPrefs({ notify }: { notify: (text: string) => void }) {
  const { prefs, update, loading, error, reload } = usePrefs(notify)
  if (!window.memoryDesktop) return <p className="field-note">{t("这些选项需要在桌面程序中设置。")}</p>
  if (error) return <RuntimeRecovery error={error} retry={reload} />
  if (loading || !prefs) return <p className="field-note">{t("正在读取…")}</p>
  const items = [
    { key: 'autoLearn', title: '自动整理记忆', text: '每轮对话后，用已配置的 AI 提取值得长期记住的偏好和可复用的做法（多一次很短的请求）。记住的内容会显示在回答下方，可随时撤销。' },
    { key: 'closeToTray', title: '关闭窗口时留在托盘', text: '关闭后继续在后台运行，定时提醒才会准时弹出。关闭此项则点关闭即退出。' },
    { key: 'openAtLogin', title: '开机自动启动', text: '登录 Windows 后自动运行，保证提醒不会错过。' },
  ] as const
  return <div className="capability-panel"><LanguagePreference notify={notify} /><div className="capability-row plain"><div><b>{t("子代理使用的模型")}</b><p>{t("留空则与默认服务相同，只在子代理用到默认服务时生效。配置了多个服务时，请到「AI 服务 → 任务分配」为各类代理指定服务。")}</p></div><TextPref value={prefs.subagentModel || ''} placeholder={t("同主模型")} onCommit={value => void update({ subagentModel: value })} /></div><div className="capability-row plain"><div><b>{t("最大输出长度")}</b><p>{t("单次回复最多生成多少 token。写长文档、或使用会先“思考”的模型时需要调高；服务不支持过大的值时会自动退回 4096。")}</p></div><TokenInput value={prefs.maxTokens} onCommit={value => void update({ maxTokens: value })} /></div>{items.map(item => <div className="capability-row plain" key={item.key}><div><b>{t(item.title)}</b><p>{t(item.text)}</p></div><Toggle checked={prefs[item.key]} label={t(item.title)} onChange={() => void update({ [item.key]: !prefs[item.key] })} /></div>)}</div>
}

function TokenInput({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => { const parsed = Math.round(Number(draft)); const next = Number.isFinite(parsed) && parsed > 0 ? Math.max(1024, Math.min(64000, parsed)) : value; setDraft(String(next)); if (next !== value) onCommit(next) }
  return <input className="number-input" inputMode="numeric" value={draft} aria-label={t("最大输出长度")} onChange={event => setDraft(event.target.value.replace(/[^0-9]/g, ''))} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
}

function TextPref({ value, placeholder, onCommit }: { value: string; placeholder: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <input className="number-input wide-input" value={draft} placeholder={placeholder} aria-label={placeholder} onChange={event => setDraft(event.target.value)} onBlur={() => { if (draft.trim() !== value) onCommit(draft.trim()) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
}
