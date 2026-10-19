import { t } from './i18n'
import { useState } from 'react'
import { ArrowClockwise, CaretDown, CaretRight, Eye, Lock, PencilSimple, Plug, Plus, Power, Trash, Warning } from '@phosphor-icons/react'
import type { Connector, ConnectorDraft } from './types'
import { Badge, Empty, PageHeader, Toggle, cleanError } from './ui'

const presets: { name: string; command: string; args: string[]; env?: string; note: string }[] = [
  { name: '文件系统', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\文档'], note: '让 AI 读写指定文件夹（把最后一项改成你的文件夹）' },
  { name: 'GitHub', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: 'GITHUB_PERSONAL_ACCESS_TOKEN=', note: '查看和管理仓库、Issue、PR；需要访问令牌' },
  { name: '知识图谱记忆', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], note: '给 AI 一个可查询的关系记忆' },
]
const accessInfo = {
  read: { label: '只读', text: '只能查看，任何会改动数据的工具都不会提供给 AI。', icon: Eye },
  ask: { label: '改动前确认', text: '查看自动进行；会改动数据的工具每次先问你。', icon: Lock },
  auto: { label: '自动', text: '改动也自动进行；标记为“可能删除或覆盖”的工具仍会先问你。', icon: Power },
} as const
const policyLabel = { '': '跟随连接器', allow: '始终允许', ask: '每次询问', deny: '禁用' } as const
const kindLabel = { read: '只读', write: '会改动', destructive: '可能删除' } as const

const toDraft = (item: Connector): ConnectorDraft => ({ id: item.id, name: item.name, command: item.command, args: item.args, enabled: item.enabled, access: item.access, overrides: item.overrides })
const parseEnv = (text: string) => Object.fromEntries(text.split('\n').map(line => line.trim()).filter(line => line.includes('=')).map(line => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim()] }).filter(([key]) => key))

function AddForm({ initial, onSave, onCancel, editing = false }: { initial?: typeof presets[number] & { access?: Connector['access'] }; onSave: (draft: ConnectorDraft) => Promise<boolean>; onCancel: () => void; editing?: boolean }) {
  const [name, setName] = useState(initial?.name || '')
  const [command, setCommand] = useState(initial?.command || 'npx')
  const [args, setArgs] = useState((initial?.args || []).join('\n'))
  const [env, setEnv] = useState(initial?.env || '')
  const [access, setAccess] = useState<ConnectorDraft['access']>(initial?.access || 'ask')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    const ok = await onSave({ name, command, args: args.split('\n').map(line => line.trim()).filter(Boolean), enabled: true, access, overrides: {}, env: parseEnv(env) })
    setBusy(false)
    if (ok) onCancel()
  }
  return <form className="connector-form" onSubmit={event => { event.preventDefault(); void submit() }}>
    <div className="settings-grid">
      <label>{t("名称")}<input value={name} onChange={event => setName(event.target.value)} placeholder={t("例如 GitHub")} autoComplete="off" /></label>
      <label>{t("启动命令")}<input value={command} onChange={event => setCommand(event.target.value)} placeholder="npx" autoComplete="off" /></label>
    </div>
    <label>{t("参数（每行一个）")}<textarea value={args} onChange={event => setArgs(event.target.value)} rows={3} placeholder={t("-y\n@modelcontextprotocol/server-filesystem\nD:\\文档")} /></label>
    <label>{t("环境变量（每行 名称=值，值会加密保存，不会再显示）")}<textarea value={env} onChange={event => setEnv(event.target.value)} rows={2} placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=..." autoComplete="off" /></label>
    <div className="access-picker" role="radiogroup" aria-label={t("权限")}>{(Object.keys(accessInfo) as (keyof typeof accessInfo)[]).map(key => { const Icon = accessInfo[key].icon; return <button type="button" role="radio" aria-checked={access === key} key={key} className={access === key ? 'on' : ''} onClick={() => setAccess(key)}><Icon size={16} /><b>{t(accessInfo[key].label)}</b><small>{t(accessInfo[key].text)}</small></button> })}</div>
    <div className="connector-form-actions"><button type="button" className="button secondary" onClick={onCancel}>{t("取消")}</button><button type="submit" className="button primary" disabled={busy || !name.trim() || !command.trim()}>{busy ? t("正在连接…") : editing ? t("保存配置") : t("添加并连接")}</button></div>
  </form>
}

function ConnectorCard({ item, save, connect, remove }: { item: Connector; save: (patch: Partial<ConnectorDraft>) => Promise<boolean>; connect: () => void; remove: () => void }) {
  const [open, setOpen] = useState(true)
  const [editing, setEditing] = useState(false)
  const [armed, setArmed] = useState(false)
  const setOverride = (tool: string, value: string) => { const overrides = { ...item.overrides }; if (value) overrides[tool] = value as 'allow'; else delete overrides[tool]; void save({ overrides }) }
  return <article className={'connector-card ' + item.status}>
    <div className="connector-head">
      <span className={'status-light ' + item.status} title={item.status} />
      <div className="connector-title"><b>{item.name}</b><small>{item.status === 'ready' ? t("已连接") : item.status === 'starting' ? t("正在连接") : item.status === 'error' ? t("连接异常") : t("尚未连接")}{t(" · {p0} 个工具", { p0: item.tools.length })}</small></div>
      <Toggle checked={item.enabled} label={t("启用 {p0}", { p0: item.name })} onChange={() => void save({ enabled: !item.enabled })} />
    </div>
    <details className="connector-technical"><summary>{t("连接配置")}</summary><code>{item.command} {item.args.join(' ')}</code>{item.envKeys.length > 0 && <p>{t("已保存环境变量：")}{item.envKeys.join('、')}</p>}</details>
    {item.status === 'error' && <p className="connector-error"><Warning size={14} weight="fill" />{item.error || t("连接失败")}<button type="button" onClick={connect}><ArrowClockwise size={13} />{t("重试")}</button></p>}
    {item.status === 'starting' && <p className="field-note">{t("正在连接…")}</p>}
    {editing && <div className="connector-edit-form"><p className="field-note">{t("已保存的敏感值保持隐藏；留空保留原值，填写同名变量可更新。")}</p><AddForm editing initial={{ name: item.name, command: item.command, args: item.args, note: '', access: item.access }} onCancel={() => setEditing(false)} onSave={draft => save({ name: draft.name, command: draft.command, args: draft.args, access: draft.access, env: draft.env })} /></div>}
    <div className="access-picker compact" role="radiogroup" aria-label={t("{p0}的权限", { p0: item.name })}>{(Object.keys(accessInfo) as (keyof typeof accessInfo)[]).map(key => { const Icon = accessInfo[key].icon; return <button type="button" role="radio" aria-checked={item.access === key} key={key} className={item.access === key ? 'on' : ''} title={t(accessInfo[key].text)} onClick={() => void save({ access: key })}><Icon size={14} />{t(accessInfo[key].label)}</button> })}</div>
    <p className="field-note">{t(accessInfo[item.access].text)}</p>
    {item.status === 'ready' && <>
      <button type="button" className="connector-toggle" onClick={() => setOpen(!open)}>{open ? <CaretDown size={13} /> : <CaretRight size={13} />}{t("{p0} 个工具 · {p1} 个被禁用", { p0: item.tools.length, p1: item.tools.filter(tool => tool.policy === 'deny').length })}</button>
      {open && <ul className="connector-tools">{item.tools.map(tool => <li key={tool.name} className={tool.policy}>
        <div><b>{tool.name}</b><Badge tone={tool.kind === 'read' ? '' : tool.kind === 'destructive' ? 'bad' : 'warn'}>{t(kindLabel[tool.kind])}</Badge><small>{tool.description}</small></div>
        <select aria-label={t("{p0}的权限", { p0: tool.name })} value={item.overrides[tool.name] || ''} onChange={event => setOverride(tool.name, event.target.value)}>{(Object.keys(policyLabel) as (keyof typeof policyLabel)[]).map(key => <option key={key} value={key}>{t(policyLabel[key])}</option>)}</select>
      </li>)}</ul>}
    </>}
    <div className="connector-actions">
      <button type="button" className="button secondary" onClick={() => setEditing(!editing)}><PencilSimple size={13} />{t("编辑配置")}</button>
      <button type="button" className="button secondary" onClick={connect}><ArrowClockwise size={13} />{t("重新连接")}</button>
      <button type="button" className={'button secondary danger'} onClick={() => armed ? remove() : setArmed(true)} onBlur={() => setArmed(false)}><Trash size={13} />{armed ? t("确认删除") : t("删除")}</button>
    </div>
  </article>
}

export function ConnectorsPage({ connectors, setConnectors, notify }: { connectors: Connector[]; setConnectors: (list: Connector[]) => void; notify: (text: string) => void }) {
  const [adding, setAdding] = useState<typeof presets[number] | 'blank' | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const selected = connectors.find(item => item.id === selectedId) || connectors[0]
  const apply = async (drafts: ConnectorDraft[]) => {
    try { setConnectors(await window.memoryDesktop!.saveConnectors(drafts)); return true }
    catch (error) { notify(cleanError(error)); return false }
  }
  if (!window.memoryDesktop) return <div className="page"><Empty icon={Plug} title={t("MCP 连接")} text={t("在桌面程序中添加连接器、查看工具并设置权限。")} /></div>
  return <div className="page connectors-page">
    <PageHeader eyebrow="CONNECTORS" title={t("连接器")} description={t("把 GitHub、Notion、数据库等外部服务接进来（MCP 协议）。你决定每个连接器能做到哪一步：只读、改动前确认，或自动。")} action={<button type="button" className="button primary" onClick={() => setAdding('blank')}><Plus size={15} />{t("添加连接器")}</button>} />
    <div className="connector-toolbar"><h2>{t("我的连接")}<span>{connectors.length}</span></h2></div>
    {adding && <section className="connector-add">
      <div className="preset-row" aria-label={t("常用连接器")}>{presets.map(item => <button type="button" key={item.name} className={adding !== 'blank' && adding.name === item.name ? 'active' : ''} title={t(item.note)} onClick={() => setAdding(item)}>{t(item.name)}</button>)}<button type="button" className={adding === 'blank' ? 'active' : ''} onClick={() => setAdding('blank')}><PencilSimple size={12} />{t("自定义")}</button></div>
      {adding !== 'blank' && <p className="field-note">{t(adding.note)}{t("。这是示例命令，需要电脑上已安装 Node.js；具体参数请以该服务的说明为准。")}</p>}
      <AddForm key={adding === 'blank' ? 'blank' : adding.name} initial={adding === 'blank' ? undefined : adding} onCancel={() => setAdding(null)} onSave={draft => apply([...connectors.map(toDraft), draft])} />
    </section>}
    {connectors.length === 0 && !adding
      ? <Empty icon={Plug} title={t("还没有连接器")} text={t("连接后，AI 在对话和后台任务里都可以使用这些服务的工具，所有改动操作都在你设定的权限之内。")} action={<button type="button" className="button secondary" onClick={() => setAdding('blank')}><Plus size={14} />{t("添加第一个连接器")}</button>} />
      : <div className="connector-workbench"><aside className="connector-list">{connectors.map(item => <button type="button" className={'connector-list-row' + (selected?.id === item.id ? ' selected' : '')} key={item.id} onClick={() => setSelectedId(item.id)}><span className={'status-dot' + (item.status === 'ready' ? ' ready' : '')} /><span><b>{item.name}</b><small>stdio · {t(({ stopped: '未连接', starting: '连接中', ready: '已连接', error: '连接失败' })[item.status])}</small></span><CaretRight size={14} /></button>)}<div className="scene-new"><p className="field-note">{t("从预设添加")}</p><div className="preset-row">{presets.map(item => <button type="button" key={item.name} onClick={() => setAdding(item)}>{t(item.name)}</button>)}</div></div></aside>{selected && <ConnectorCard key={selected.id} item={selected}
        save={patch => apply(connectors.map(entry => entry.id === selected.id ? { ...toDraft(entry), ...patch } : toDraft(entry)))}
        connect={() => { void window.memoryDesktop!.connectConnector(selected.id).then(setConnectors).catch(error => notify(cleanError(error))) }}
        remove={() => void apply(connectors.filter(entry => entry.id !== selected.id).map(toDraft))} />}</div>}
    <section className="sentinel-note"><h3>{t("权限如何生效")}</h3>
      <ul><li><b>{t("只读")}</b>{t("：AI 根本看不到会改动数据的工具。")}</li><li><b>{t("改动前确认")}</b>{t("：工具是否只读以服务自己的声明为准；没有声明的一律按“会改动”处理。")}</li><li>{t("每个工具都可以单独改成“始终允许 / 每次询问 / 禁用”。")}</li><li>{t("密钥以加密形式保存在本机，不会显示，也不会发给 AI。")}</li><li>{t("后台任务和子代理使用同样的权限；需要确认时会通知你。")}</li></ul></section>
  </div>
}
