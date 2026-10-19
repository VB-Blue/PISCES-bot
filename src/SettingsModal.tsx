import { t, systemText } from './i18n'
import { useRef, useState, type FormEvent } from 'react'
import { useEffect } from 'react'
import { ArrowClockwise, ArrowRight, Brain, GearSix, Monitor, Play, Sparkle, WarningCircle, X } from '@phosphor-icons/react'
import type { ConnectionSettings, Persona, ProviderStore } from './types'
import { PersonaPanel } from './PersonaPanel'
import { ProvidersPanel, toForm, type ProviderForm } from './ProvidersPanel'
import { CapabilityPanel, GeneralPrefs } from './Capabilities'
import { Badge, IconButton, cleanError } from './ui'
import { useDialog } from './useDialog'
import { RuntimeRecovery } from './RuntimeStatus'

type Tab = 'ai' | 'persona' | 'abilities' | 'core' | 'general'

export function SettingsModal({ settings, coreNote, close, checkCore, startCore, save, providersChanged, persona, onPersona, notify, initialTab = 'ai', embedded = false }: {
  settings: ConnectionSettings; coreNote: string; close: () => void; checkCore: () => void; startCore: () => void; save: (value: ConnectionSettings) => void; providersChanged: (value: ProviderStore) => void; persona: Persona; onPersona: (value: Persona) => void; notify: (text: string) => void; initialTab?: Tab; embedded?: boolean
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [form, setForm] = useState({ coreUrl: settings.coreUrl, coreToken: '', clearCoreToken: false })
  const [ai, setAi] = useState<ProviderForm | null>(null)
  const [error, setError] = useState('')
  const [providerError, setProviderError] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAI, setSavedAI] = useState('')
  const [savedCore, setSavedCore] = useState(() => JSON.stringify(form))
  const [discard, setDiscard] = useState(false)
  const dialog = useRef<HTMLElement>(null), discardDialog = useRef<HTMLDivElement>(null)
  const dirty = (ai !== null && savedAI !== '' && JSON.stringify(ai) !== savedAI) || JSON.stringify(form) !== savedCore
  const requestClose = () => { if (saving) return; if (dirty) setDiscard(true); else close() }
  useDialog(dialog, !embedded, requestClose)
  useDialog(discardDialog, discard, () => setDiscard(false), 'button')
  const loadProviders = async () => {
    if (!window.memoryDesktop) { setAi({ profiles: [], defaultId: '', routes: {}, failover: true }); return }
    try { const store = await window.memoryDesktop.providers(); const value = toForm(store); setAi(value); setSavedAI(JSON.stringify(value)); setProviderError('') }
    catch (failure) { setProviderError(cleanError(failure)) }
  }
  useEffect(() => {
    if (tab !== 'ai' || ai) return
    void loadProviders()
    return window.memoryDesktop?.onRuntimeState?.(state => { if (state.online && state.ready && !state.stopping) void loadProviders() })
  }, [tab, ai])
  const field = (key: 'coreUrl' | 'coreToken', value: string) => setForm(previous => ({ ...previous, [key]: value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (!window.memoryDesktop) { setError('网页仅供预览。请启动桌面程序保存连接设置；密钥不会保存在浏览器。'); return }
    if (ai && (!embedded || tab === 'ai')) for (const item of ai.profiles) if (!item.name.trim() || !item.endpoint.trim() || !item.model.trim()) { setTab('ai'); setError('「' + (item.name || '未命名服务') + '」还缺少名称、服务地址或模型名称。'); return }
    setSaving(true)
    try {
      if (ai && (!embedded || tab === 'ai')) providersChanged(await window.memoryDesktop.saveProviders(ai))
      save(embedded && tab !== 'core' ? await window.memoryDesktop.settings() : await window.memoryDesktop.saveSettings(form))
      if (ai) setSavedAI(JSON.stringify(ai))
      setSavedCore(JSON.stringify(form))
      if (embedded) notify('配置已保存'); else close()
    }
    catch (failure) { setError(cleanError(failure)) }
    finally { setSaving(false) }
  }

  const sections = [{ id: 'persona' as const, label: '助手', description: '称呼与交流方式', icon: Sparkle }, { id: 'general' as const, label: '通用', description: '外观与运行偏好', icon: GearSix }, { id: 'ai' as const, label: 'AI 服务', description: '模型与连接配置', icon: Brain }, { id: 'abilities' as const, label: '本机能力', description: '工具与使用权限', icon: Monitor }, { id: 'core' as const, label: '核心', description: '本地记忆与任务', icon: Play }]
  return <div className={embedded ? 'settings-embedded' : 'modal-backdrop'} onMouseDown={event => { if (!embedded && event.target === event.currentTarget) requestClose() }}>
    <section ref={dialog} className="settings-modal" role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : true} aria-labelledby={embedded ? undefined : 'settings-title'} tabIndex={embedded ? undefined : -1}>
      {!embedded && <div className="modal-header"><div><h2 id="settings-title" tabIndex={-1} data-dialog-focus>{t("设置")}</h2><p>{t("让助手以适合你的方式工作。")}</p></div><IconButton label={t("关闭设置")} onClick={requestClose}><X size={19} /></IconButton></div>}
      <form onSubmit={submit}>
        {!embedded && <div className="settings-tabs settings-navigation" role="tablist" aria-label={t("设置分区")} aria-orientation="vertical" onKeyDown={event => { if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return; const index = sections.findIndex(item => item.id === tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + sections.length) % sections.length; event.preventDefault(); setTab(sections[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus() }}>{sections.map(item => <button type="button" role="tab" id={'settings-nav-' + item.id} aria-controls={'settings-panel-' + item.id} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} key={item.id} onClick={() => setTab(item.id)}><item.icon size={18} /><span><b>{t(item.label)}</b><small>{t(item.description)}</small></span></button>)}</div>}
        <div className="settings-body" role="tabpanel" id={'settings-panel-' + tab} aria-labelledby={embedded ? undefined : 'settings-nav-' + tab}>
          {tab === 'ai' && <div className="settings-section">
            <div className="settings-title"><Sparkle size={18} /><h3>{t("AI 服务")}</h3><Badge>{t("兼容 Chat Completions")}</Badge></div>
            {ai ? <ProvidersPanel form={ai} setForm={setAi} /> : providerError ? <RuntimeRecovery error={providerError} retry={loadProviders} /> : <p className="field-note">{t("正在读取…")}</p>}
            <p className="field-note">{t("可以配置多个服务。只在你发送消息、或每轮结束整理记忆时调用 AI，密钥由桌面端加密保存。要使用本机工具，所选模型需要支持函数调用（tools）；不支持时会自动退回纯对话。")}</p>
          </div>}
          {tab === 'persona' && <div className="settings-section"><div className="settings-title"><Sparkle size={18} /><h3>{t("我的助手")}</h3></div><PersonaPanel value={persona} onChange={next => { onPersona(next); void window.memoryDesktop?.savePrefs({ persona: next }).catch(error => setError(cleanError(error))) }} /></div>}
          {tab === 'abilities' && <div className="settings-section"><div className="settings-title"><Monitor size={18} /><h3>{t("AI 在这台电脑上能做什么")}</h3></div><CapabilityPanel notify={notify} /></div>}
          {tab === 'core' && <div className="settings-section">
            <div className="settings-title"><Brain size={18} /><h3>{t("PISCES AI核心")}</h3></div>
            <label>{t("本机核心地址")}<input value={form.coreUrl} onChange={event => field('coreUrl', event.target.value)} placeholder="http://127.0.0.1:18789" /></label>
            <label>{t("核心访问令牌（可选）")}<input type="password" value={form.coreToken} onChange={event => field('coreToken', event.target.value)} placeholder={settings.hasCoreToken ? t("已加密保存，留空保留") : t("核心启用认证时填写")} autoComplete="new-password" /></label>
            {settings.hasCoreToken && <label className="check-label"><input type="checkbox" checked={form.clearCoreToken} onChange={event => setForm(previous => ({ ...previous, clearCoreToken: event.target.checked }))} />{t("移除核心令牌")}</label>}
            <div className="connection-check"><span>{systemText(coreNote)}</span><button type="button" onClick={checkCore}><ArrowClockwise size={14} />{t("检查已保存连接")}</button></div>
            <button type="button" className="button secondary" onClick={startCore}><Play size={14} />{t("启动主线核心（18789）")}</button>
            <p className="field-note">{t("核心不在线时，普通对话会自动改由 AI 直接回答；文件清单、软件窗口操作等需要核心的功能会提示连接。")}</p>
          </div>}
          {tab === 'general' && <div className="settings-section"><div className="settings-title"><GearSix size={18} /><h3>{t("通用")}</h3></div><GeneralPrefs notify={notify} /></div>}
          {!window.memoryDesktop && <div className="preview-note"><Monitor size={17} />{t("当前为浏览器预览，真实连接请使用桌面程序。")}</div>}
          {error && <div className="form-error" role="alert"><WarningCircle size={17} />{systemText(error)}</div>}
        </div>
        {(!embedded || tab === 'ai' || tab === 'core') && <div className="modal-footer"><span className={'settings-save-state' + (dirty ? ' dirty' : '')} role="status">{dirty ? t("连接配置有未保存的修改") : tab === 'ai' || tab === 'core' ? t("连接配置需要保存后生效") : t("这些选项即时生效")}</span>{!embedded && <button type="button" className="button secondary" onClick={requestClose} disabled={saving}>{dirty ? t("取消") : t("关闭")}</button>}{(dirty || tab === 'ai' || tab === 'core') && <button type="submit" className="button primary" disabled={saving}>{saving ? t("正在保存…") : t("保存配置")}<ArrowRight size={15} /></button>}</div>}
      </form>
      {discard && <div className="settings-discard-backdrop"><div ref={discardDialog} className="settings-discard" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-description" tabIndex={-1}><WarningCircle size={26} /><h3 id="discard-title">{t("还有未保存的连接配置")}</h3><p id="discard-description">{t("关闭后，本次对 AI 服务或核心连接的修改会被放弃。")}</p><div><button type="button" className="button primary" onClick={() => setDiscard(false)}>{t("继续编辑")}</button><button type="button" className="button secondary" onClick={close}>{t("放弃修改")}</button></div></div></div>}
    </section>
  </div>
}
