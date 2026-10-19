import { useCallback, useEffect, useState } from 'react'
import { t } from './i18n'
import type { DurableRequirement, RequirementsCheck } from './types'
import { cleanError, dayTime } from './ui'
import './requirements.css'

const checks = { semantic: '按完整正文复核', contains: '必须包含文字', not_contains: '禁止出现文字', min_length: '最少非空白字符数', max_length: '最多非空白字符数' } as const
function OriginalRequirement({ text }: { text: string }) {
  if (text.length <= 600 && text.split('\n').length <= 8) return <p className="requirement-original">{text}</p>
  return <details className="requirement-full-text"><summary>{t('查看完整原文')} · {text.length.toLocaleString()} {t('字')}</summary><p className="requirement-original">{text}</p></details>
}
export function RequirementChecks({ report }: { report: RequirementsCheck }) {
  return <details className="requirement-checks"><summary>{t('长期要求逐条检查')} · {report.checks.filter(item => item.status === 'passed').length}/{report.checks.length} · {t(report.passed ? '全部通过' : '尚未通过')}</summary>
    <p>{dayTime(report.checkedAt)}</p><ol>{report.checks.map((item, index) => <li key={item.id + ':' + index} data-status={item.status}>
      <strong>{t(({ passed: '通过', failed: '未通过', unknown: '无法核实' })[item.status])} · v{item.revision}</strong><OriginalRequirement text={item.text} />
      {item.source && <small>{item.source}</small>}<p>{item.reason}</p>{item.evidence && <blockquote>{item.evidence}</blockquote>}
    </li>)}</ol>
  </details>
}
export function RequirementMemory({ notify }: { notify: (text: string) => void }) {
  const [items, setItems] = useState<DurableRequirement[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<DurableRequirement | null>(null)
  const [text, setText] = useState('')
  const [scope, setScope] = useState('')
  const [domain, setDomain] = useState<'writing' | 'all'>('writing')
  const [checkType, setCheckType] = useState<keyof typeof checks>('semantic')
  const [checkValue, setCheckValue] = useState('')
  const [busy, setBusy] = useState(false)
  const reload = useCallback(async () => { try { setItems(await window.memoryDesktop!.memory.requirements()); setError('') } catch (cause) { setError(cleanError(cause)) } }, [])
  useEffect(() => { void reload() }, [reload])
  function reset() { setEditing(null); setText(''); setScope(''); setDomain('writing'); setCheckType('semantic'); setCheckValue('') }
  function edit(item: DurableRequirement) { setEditing(item); setText(item.text); setScope(item.scope); setDomain(item.domain); setCheckType(item.check.type); setCheckValue(item.check.value === undefined ? '' : String(item.check.value)) }
  async function save() {
    if (busy || !text.trim()) return
    setBusy(true)
    try {
      const check = { type: checkType, ...(checkType === 'semantic' ? {} : { value: ['min_length', 'max_length'].includes(checkType) ? Number(checkValue) : checkValue }) }
      await window.memoryDesktop!.memory.saveRequirements([{ ...(editing ? { id: editing.id, revision: editing.revision, enabled: editing.enabled } : {}), text, domain, scope, check }])
      reset(); await reload(); notify('长期要求已完整保存')
    } catch (cause) { setError(cleanError(cause)) } finally { setBusy(false) }
  }
  async function toggle(item: DurableRequirement) {
    if (busy) return
    setBusy(true)
    try { await window.memoryDesktop!.memory.saveRequirements([{ ...item, enabled: !item.enabled }]); await reload(); if (editing?.id === item.id) reset() }
    catch (cause) { setError(cleanError(cause)) } finally { setBusy(false) }
  }
  return <section className="requirement-memory" aria-label={t('长期要求')}>
    <div className="section-heading"><h2>{t('长期要求')}</h2><button type="button" className="button secondary" onClick={() => void reload()}>{t('刷新')}</button></div>
    <p className="presence-muted">{t('相关任务会完整读取所有适用要求，并在交付前逐条检查。换对话或重启后继续保留。')}</p>
    {error && <p className="error-text" role="alert">{error}</p>}
    <form className="requirement-editor" onSubmit={event => { event.preventDefault(); void save() }}>
      <label>{t('要求原文')}<textarea value={text} rows={4} maxLength={20000} onChange={event => setText(event.target.value)} placeholder={t('每条要求单独保存；可以包含多段原文。')} /></label>
      <div className="requirement-fields"><label>{t('适用类型')}<select value={domain} onChange={event => setDomain(event.target.value as 'writing' | 'all')}><option value="writing">{t('写作与内容任务')}</option><option value="all">{t('所有任务')}</option></select></label>
        <label>{t('适用项目或网站')}<input maxLength={300} value={scope} onChange={event => setScope(event.target.value)} placeholder={t('留空表示所有相关任务；填写时按任务中的名称匹配')} /></label>
        <label>{t('检查方式')}<select value={checkType} onChange={event => setCheckType(event.target.value as keyof typeof checks)}>{Object.entries(checks).map(([key, value]) => <option key={key} value={key}>{t(value)}</option>)}</select></label>
        {checkType !== 'semantic' && <label>{t('检查值')}<input required value={checkValue} onChange={event => setCheckValue(event.target.value)} type={['min_length', 'max_length'].includes(checkType) ? 'number' : 'text'} min={1} /></label>}</div>
      <div className="requirement-actions"><button className="button primary" disabled={busy || !text.trim()}>{t(editing ? '保存修改' : '保存要求')}</button>{editing && <button type="button" className="button secondary" onClick={reset}>{t('取消')}</button>}</div>
    </form>
    <div className="requirement-list">{items.map(item => <article className="requirement-card" key={item.id}>
      <div className="requirement-card-head"><strong>{t(item.domain === 'writing' ? '写作与内容任务' : '所有任务')}{item.scope ? ' · ' + item.scope : ''}</strong><small>v{item.revision} · {t(item.enabled ? '已启用' : '已停用')}</small></div>
      <OriginalRequirement text={item.text} /><small>{t(checks[item.check.type])}{item.check.value !== undefined ? '：' + item.check.value : ''} · {dayTime(item.updatedAt)}</small>
      <div className="requirement-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => edit(item)}>{t('编辑')}</button><button type="button" className="button secondary" disabled={busy} onClick={() => void toggle(item)}>{t(item.enabled ? '停用' : '启用')}</button></div>
      {!!item.history.length && <details><summary>{t('查看历史版本')}</summary>{[...item.history].reverse().map(previous => <div key={previous.revision}><small>v{previous.revision} · {dayTime(previous.changedAt)}</small><OriginalRequirement text={previous.text} /></div>)}</details>}
    </article>)}</div>
    {!items.length && !error && <p className="presence-muted">{t('还没有长期要求。可以在这里保存，也可以在对话中说“记住以下写作要求：”并逐条列出。')}</p>}
  </section>
}
