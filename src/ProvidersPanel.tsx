import { t } from './i18n'
import { useEffect, useMemo, useState } from 'react'
import { ArrowClockwise, CheckCircle, Plus, Star, Trash, WarningCircle } from '@phosphor-icons/react'
import type { AgentRole, ProviderDraft, ProviderInsight, ProviderStore, ServiceHealth, Strength } from './types'
import { Badge, Toggle, cleanError } from './ui'

const presets = [
  { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', strengths: ['vision', 'strong'] as Strength[] },
  { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', strengths: ['cheap', 'code'] as Strength[] },
  { name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', strengths: ['long'] as Strength[] },
  { name: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', strengths: ['fast', 'cheap'] as Strength[] },
  { name: 'Moonshot', endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', strengths: ['long'] as Strength[] },
  { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', model: '', strengths: [] as Strength[] },
  { name: 'Ollama 本机', endpoint: 'http://127.0.0.1:11434/v1', model: '', strengths: ['cheap'] as Strength[] },
]
const strengthLabels: Record<Strength, string> = { strong: '强推理', fast: '速度快', cheap: '便宜', vision: '能看图', code: '擅长代码', long: '长文本' }
const roleRows: { role: AgentRole; title: string; text: string }[] = [
  { role: 'researcher', title: '资料员', text: '联网查资料、核实事实' },
  { role: 'coder', title: '程序员', text: '写代码、跑命令、处理文件' },
  { role: 'operator', title: '操作员', text: '看屏幕操作软件，需要能看图的服务' },
  { role: 'writer', title: '写作员', text: '起草和整理较长的文字' },
  { role: 'reviewer', title: '复核员', text: '独立核对其他代理的结论' },
  { role: 'planner', title: '规划者', text: '“规划 / 执行 / 审阅”模式里的规划' },
  { role: 'verifier', title: '审阅者', text: '“规划 / 执行 / 审阅”模式里的审阅' },
  { role: 'learner', title: '记忆整理', text: '每轮结束后提取值得记住的内容' },
]

export type ProviderForm = { profiles: ProviderDraft[]; defaultId: string; routes: ProviderStore['routes']; failover: boolean }
export const toForm = (store: ProviderStore): ProviderForm => ({ profiles: store.profiles.map(item => ({ ...item })), defaultId: store.defaultId, routes: { ...store.routes }, failover: store.failover })

export function ProvidersPanel({ form, setForm }: { form: ProviderForm; setForm: (next: ProviderForm) => void }) {
  const [selected, setSelected] = useState(form.defaultId || form.profiles[0]?.id || '')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [listing, setListing] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; text: string }>({ state: 'idle', text: '' })
  const [filter, setFilter] = useState('')
  const current = form.profiles.find(item => item.id === selected) ?? form.profiles[0]
  useEffect(() => { setResult(null); setModels([]); setFilter(''); setListing({ state: 'idle', text: '' }) }, [current?.id])
  // Read the service's model list by itself as soon as there is an address and a key (typed or saved).
  const canList = !!current?.endpoint.trim() && (!!current?.apiKey || (current?.hasApiKey && !current?.clearApiKey) || /localhost|127\.0\.0\.1/.test(current?.endpoint || ''))
  const loadModels = async () => {
    if (!current || !window.memoryDesktop?.listModels || !canList) return
    setListing({ state: 'loading', text: '正在读取这个服务提供的模型…' })
    try {
      const reply = await window.memoryDesktop.listModels({ endpoint: current.endpoint, apiKey: current.apiKey, profileId: current.hasApiKey && !current.clearApiKey ? current.id : undefined })
      setModels(reply.models)
      setListing({ state: 'done', text: '这个服务提供 ' + reply.models.length + ' 个模型，点一下即可选用' })
    } catch (failure) { setModels([]); setListing({ state: 'error', text: cleanError(failure) }) }
  }
  useEffect(() => {
    if (!canList) return
    const timer = setTimeout(() => { void loadModels() }, 700)
    return () => clearTimeout(timer)
  }, [current?.id, current?.endpoint, current?.apiKey, canList])
  // What automatic routing assumes about this service, and how it has been doing lately.
  const [insight, setInsight] = useState<ProviderInsight | null>(null)
  useEffect(() => {
    if (!current || !window.memoryDesktop?.providerInsight) return
    const timer = setTimeout(() => { window.memoryDesktop!.providerInsight!(form.profiles.map(item => ({ id: item.id, model: item.model, endpoint: item.endpoint }))).then(setInsight).catch(() => setInsight(null)) }, 300)
    return () => clearTimeout(timer)
  }, [current?.id, current?.model, current?.endpoint])
  const inferred = current ? insight?.inferred[current.id] || [] : []
  const health = current ? insight?.health[current.id] : undefined
  const shownModels = useMemo(() => models.filter(item => !filter.trim() || item.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 200), [models, filter])
  const names = useMemo(() => form.profiles.map(item => item.name), [form.profiles])

  const patch = (change: Partial<ProviderDraft>) => { if (current) { setForm({ ...form, profiles: form.profiles.map(item => item.id === current.id ? { ...item, ...change } : item) }); if ('endpoint' in change || 'model' in change || 'apiKey' in change) setResult(null) } }
  const add = (preset?: typeof presets[number]) => {
    const id = crypto.randomUUID()
    let name = preset?.name || '新服务'
    for (let n = 2; names.some(item => item.toLowerCase() === name.toLowerCase()); n++) name = (preset?.name || '新服务') + ' ' + n
    const draft: ProviderDraft = { id, name, endpoint: preset?.endpoint || '', model: preset?.model || '', hasApiKey: false, strengths: preset?.strengths || [], note: '', maxConcurrent: 2, noFailover: false }
    setForm({ ...form, profiles: [...form.profiles, draft], defaultId: form.defaultId || id })
    setSelected(id)
  }
  const remove = () => {
    if (!current) return
    const profiles = form.profiles.filter(item => item.id !== current.id)
    const routes = Object.fromEntries(Object.entries(form.routes).filter(([, id]) => id !== current.id))
    setForm({ ...form, profiles, routes, defaultId: form.defaultId === current.id ? (profiles[0]?.id || '') : form.defaultId })
    setSelected(profiles[0]?.id || '')
  }
  const test = async () => {
    if (!current) return
    if (!window.memoryDesktop) return setResult({ ok: false, text: '网页预览不能测试连接，请使用桌面程序。' })
    setTesting(true); setResult(null)
    try {
      const reply = await window.memoryDesktop.testAI({ endpoint: current.endpoint, model: current.model, apiKey: current.apiKey, profileId: current.hasApiKey && !current.clearApiKey ? current.id : undefined })
      if (reply.models.length) { setModels(reply.models); setListing({ state: 'done', text: '这个服务提供 ' + reply.models.length + ' 个模型，点一下即可选用' }) } else if (reply.listError) setListing({ state: 'error', text: reply.listError })
      setResult({ ok: true, text: reply.modelChecked ? '连接成功，模型可以正常回复。' : '连接成功' + (reply.models.length ? `，服务提供 ${reply.models.length} 个模型。` : '。填写模型名称后可再测一次。') })
    } catch (failure) { setResult({ ok: false, text: cleanError(failure) }) } finally { setTesting(false) }
  }
  const toggleStrength = (tag: Strength) => patch({ strengths: current!.strengths.includes(tag) ? current!.strengths.filter(item => item !== tag) : [...current!.strengths, tag] })

  return <div className="providers">
    <div className="provider-tabs" role="tablist" aria-label={t("AI 服务")}>
      {form.profiles.map(item => <button type="button" role="tab" aria-selected={item.id === current?.id} key={item.id} className={item.id === current?.id ? 'active' : ''} onClick={() => setSelected(item.id)}>
        {item.id === form.defaultId && <Star size={12} weight="fill" />}{item.name || t("未命名")}
      </button>)}
      <button type="button" className="provider-add" onClick={() => add()}><Plus size={13} />{t("添加服务")}</button>
    </div>

    {!current && <div className="provider-empty"><p>{t("还没有 AI 服务。选一个常用服务开始，之后可以继续添加更多：不同任务可以分配给不同的服务。")}</p>
      <div className="preset-row">{presets.map(item => <button type="button" key={item.name} onClick={() => add(item)}>{t(item.name)}</button>)}</div></div>}

    {current && <div className="provider-editor">
      <div className="preset-row" aria-label={t("常用服务")}>{presets.map(item => <button type="button" key={item.name} className={current.endpoint === item.endpoint ? 'active' : ''} onClick={() => { patch({ endpoint: item.endpoint, model: item.model || current.model, strengths: current.strengths.length ? current.strengths : item.strengths }); setModels([]) }}>{t(item.name)}</button>)}</div>
      <div className="settings-grid">
        <label>{t("名称")}<input value={current.name} onChange={event => patch({ name: event.target.value })} placeholder={t("例如 DeepSeek")} autoComplete="off" /></label>
        <label>{t("模型名称")}<input list="provider-models" value={current.model} onChange={event => patch({ model: event.target.value })} placeholder={t("填写或从列表选择")} autoComplete="off" /><datalist id="provider-models">{models.map(item => <option key={item} value={item} />)}</datalist></label>
      </div>
      <div className="model-picker">
        <div className="model-picker-head"><span className={'model-picker-status ' + listing.state}>{listing.state === 'idle' ? (canList ? '' : t("填好服务地址和密钥后，会自动列出可用模型")) : listing.text}</span>
          {canList && <button type="button" onClick={() => void loadModels()} disabled={listing.state === 'loading'}>{listing.state === 'loading' ? t("读取中…") : t("刷新模型列表")}</button>}</div>
        {models.length > 0 && <>
          {models.length > 12 && <input className="model-filter" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("在 {p0} 个模型里搜索", { p0: models.length })} aria-label={t("搜索模型")} />}
          <div className="model-list" role="listbox" aria-label={t("可用模型")}>{shownModels.map(item => <button type="button" role="option" aria-selected={item === current.model} key={item} className={item === current.model ? 'on' : ''} onClick={() => patch({ model: item })}>{item}</button>)}</div>
        </>}
      </div>
      <label>{t("服务地址")}<input value={current.endpoint} onChange={event => patch({ endpoint: event.target.value })} placeholder={t("https://你的服务地址/v1")} autoComplete="off" /></label>
      <label>{t("API 密钥")}<input type="password" value={current.apiKey || ''} onChange={event => patch({ apiKey: event.target.value, clearApiKey: false })} placeholder={current.hasApiKey && !current.clearApiKey ? t("已加密保存，留空保留") : t("本机服务可留空")} autoComplete="new-password" /></label>
      {current.hasApiKey && <label className="check-label"><input type="checkbox" checked={!!current.clearApiKey} onChange={event => patch({ clearApiKey: event.target.checked, apiKey: '' })} />{t("移除已保存的密钥")}</label>}

      <div className="provider-tags" role="group" aria-label={t("擅长")}>
        <span>{t("擅长（帮助自动分配）")}</span>
        {(Object.keys(strengthLabels) as Strength[]).map(tag => <button type="button" key={tag} aria-pressed={current.strengths.includes(tag)} className={current.strengths.includes(tag) ? 'on' : ''} onClick={() => toggleStrength(tag)}>{t(strengthLabels[tag])}</button>)}
      </div>
      {current.strengths.length === 0 && inferred.length > 0 && <p className="field-note">{t("没有勾选时，按模型名自动识别为：")}{inferred.map(tag => t(strengthLabels[tag])).join('、')}</p>}
      {health && insight && <p className="field-note">{healthText(health, insight.now)}</p>}
      <label>{t("备注（会告诉主代理，帮助它分配任务）")}<input value={current.note} onChange={event => patch({ note: event.target.value })} placeholder={t("例如：中文写作好，价格低，限流较严")} autoComplete="off" /></label>
      <div className="settings-grid">
        <label>{t("此 API 的最大并发数")}<input inputMode="numeric" value={current.maxConcurrent} onChange={event => patch({ maxConcurrent: Math.max(1, Math.min(8, Number(event.target.value.replace(/[^0-9]/g, '')) || 1)) })} /></label>
        <div className="provider-flags">
          <label className="check-label"><input type="checkbox" checked={!current.noFailover} onChange={event => patch({ noFailover: !event.target.checked })} />{t("参与自动切换（出错时可作为备用，也会收到对话内容）")}</label>
        </div>
      </div>
      <div className="test-row">
        <button type="button" className="button secondary" disabled={testing || !current.endpoint} onClick={() => void test()}>{testing ? t("正在测试…") : <><ArrowClockwise size={14} />{t("测试连接")}</>}</button>
        <button type="button" className="button secondary" disabled={form.defaultId === current.id} onClick={() => setForm({ ...form, defaultId: current.id })}><Star size={14} />{form.defaultId === current.id ? t("当前默认") : t("设为默认")}</button>
        <button type="button" className="button secondary danger" onClick={remove}><Trash size={14} />{t("删除")}</button>
        {result && <span className={result.ok ? 'test-ok' : 'test-fail'} role="status">{result.ok ? <CheckCircle size={15} weight="fill" /> : <WarningCircle size={15} weight="fill" />}{t(result.text)}</span>}
      </div>
    </div>}

    {form.profiles.length > 0 && <div className="provider-routing">
      <div className="settings-title"><h3>{t("任务分配")}</h3><Badge>{t("自动分配")}</Badge></div>
      <p className="field-note">{t("对话、后台任务和子代理都会按任务能力选择服务：代码交给擅长代码的，看图交给能看图的，写作和复核交给强推理的，查资料交给速度快的。没有匹配时使用默认服务。下表可指定各类任务使用的服务，对话中也可手动选择。")}</p>
      <p className="field-note">{t("自动分配还会看实际情况：最近连续失败的服务暂时避开，默认服务忙时分流给其他服务；没勾选擅长时，按模型名自动识别它擅长什么。")}</p>
      <div className="route-table">
        {roleRows.map(row => <div className="route-row" key={row.role}>
          <div><b>{t(row.title)}</b><small>{t(row.text)}</small></div>
          <select aria-label={t("{p0}使用的服务", { p0: t(row.title) })} value={form.routes[row.role] || ''} onChange={event => { const routes = { ...form.routes }; if (event.target.value) routes[row.role] = event.target.value; else delete routes[row.role]; setForm({ ...form, routes }) }}>
            <option value="">{t("自动")}</option>
            {form.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>)}
      </div>
      <div className="capability-row plain"><div><b>{t("出错时自动切换服务")}</b><p>{t("当前服务欠费、限流、断网或密钥失效时，同一次任务换用下一个服务继续，并在步骤里提示。控制软件的任务始终只用你授权的那一个服务。")}</p></div><Toggle checked={form.failover} label={t("出错时自动切换服务")} onChange={() => setForm({ ...form, failover: !form.failover })} /></div>
    </div>}
  </div>
}

function healthText(health: ServiceHealth, now: number) {
  if (health.coolingUntil > now) return t("最近连续失败 {p0} 次，自动分配暂时避开它，{p1} 后再试", { p0: health.consecutiveFailures, p1: new Date(health.coolingUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
  return t("最近 {p0} 次调用成功 {p1} 次", { p0: health.calls, p1: health.ok }) + (health.medianMs ? t("，一般 {p0} 秒完成", { p0: Math.round(health.medianMs / 100) / 10 }) : '')
}
