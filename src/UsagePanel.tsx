import { useEffect, useState } from 'react'
import { ArrowClockwise, Gauge } from '@phosphor-icons/react'
import type { UsageSummary } from './types'
import { t, systemText } from './i18n'
import { cleanError, dayTime } from './ui'
import './long-goals.css'

const roleNames: Record<string, string> = { executor: '执行', understanding: '理解', planner: '规划', verifier: '复核', learner: '记忆整理', goal_review: '目标复核', service_test: '连接测试' }
const statuses: Record<string, string> = { running: '进行中', done: '已报告', unknown: '用量未知', failed: '请求失败', not_sent: '未发出' }
export function UsagePanel() {
  const [usage, setUsage] = useState<UsageSummary | null>(null), [error, setError] = useState(''), [budget, setBudget] = useState(''), [busy, setBusy] = useState(false)
  const reload = () => window.memoryDesktop?.usageSummary().then(value => { setUsage(value); setError('') }).catch(reason => setError(cleanError(reason)))
  useEffect(() => {
    const api = window.memoryDesktop
    if (!api) return
    const unsubscribe = api.onUsage(setUsage)
    void api.usageSummary().then(value => { setUsage(value); setBudget(String(value.policy.dailyTokenLimit)) }).catch(reason => setError(cleanError(reason)))
    return unsubscribe
  }, [])
  const save = async () => {
    if (!window.memoryDesktop || busy) return
    setBusy(true); setError('')
    try { const value = await window.memoryDesktop.saveUsagePolicy({ dailyTokenLimit: Number(budget) }); setUsage(value); setBudget(String(value.policy.dailyTokenLimit)) }
    catch (reason) { setError(cleanError(reason)) }
    finally { setBusy(false) }
  }
  return <section className="usage-page">
    <div className="presence-page-heading"><div><h1>{t('用量与预算')}</h1><p>{t('理解、规划、执行、复核、子任务和记忆整理共用一份账本。')}</p></div><button type="button" className="button secondary" onClick={reload}><ArrowClockwise size={16} />{t('刷新')}</button></div>
    {!window.memoryDesktop && <p className="goal-notice">{t('请在桌面程序中查看实际用量和执行长期目标。')}</p>}
    {(error || usage?.persistenceError) && <p className="goal-notice error-text" role="alert">{systemText(error || usage?.persistenceError || '')}</p>}
    {usage && <>
      <p className="goal-subtle">{usage.day} · {usage.timeZone}</p>
      <dl className="usage-metrics"><div><dt>{t('服务已报告')}</dt><dd>{usage.reportedTokens.toLocaleString()}<small> tokens</small></dd></div><div><dt>{t('未知用量预估')}</dt><dd>{usage.estimatedTokens.toLocaleString()}<small> tokens</small></dd></div><div><dt>{t('进行中预留')}</dt><dd>{usage.reservedTokens.toLocaleString()}<small> tokens</small></dd></div><div><dt>{t('今日调用')}</dt><dd>{usage.calls.toLocaleString()}<small>{t('次')}</small></dd></div></dl>
      <div className="usage-budget"><Gauge size={22} /><div><h2>{t('全局每日 token 预算')}</h2><p>{t('发起请求前预留额度，并行任务共同遵守。0 表示不设全局上限。')}</p><p>{t('今日预算占用：{p0}', { p0: usage.accountedTokens.toLocaleString() })}{usage.policy.dailyTokenLimit ? ' / ' + usage.policy.dailyTokenLimit.toLocaleString() : ''}</p></div><form onSubmit={event => { event.preventDefault(); void save() }}><label><span className="sr-only">{t('全局每日 token 预算')}</span><input type="number" min="0" max="1000000000" step="1" value={budget} onChange={event => setBudget(event.target.value)} required /></label><button className="button primary" disabled={busy}>{t('保存预算')}</button></form></div>
      <p className="goal-subtle">{t('服务未返回用量或请求中断时，按预留量计入预算。预留量是保守估算；实际计费以服务商账单为准。')}</p>
      <h2 className="goal-section-title">{t('最近模型调用')}</h2>
      <div className="usage-table"><table><thead><tr><th>{t('时间')}</th><th>{t('用途')}</th><th>{t('模型')}</th><th>{t('服务已报告')}</th><th>{t('预算占用')}</th><th>{t('状态')}</th></tr></thead><tbody>{usage.records.map(record => <tr key={record.id}><td>{dayTime(record.startedAt)}</td><td>{record.scopeLabel}<small className="usage-role">{t(roleNames[record.role] || record.role)}</small></td><td>{record.model}</td><td title={t('输入 {p0} · 输出 {p1}', { p0: record.inputTokens ?? '?', p1: record.outputTokens ?? '?' })}>{record.totalTokens === null ? t('未报告') : record.totalTokens.toLocaleString()}</td><td>{(record.status === 'running' ? record.reservedTokens : record.chargedTokens).toLocaleString()}</td><td>{t(statuses[record.status] || record.status)}</td></tr>)}</tbody></table>{!usage.records.length && <p className="goal-empty-inline">{t('账本启用后，实际发起的模型请求会出现在这里。')}</p>}</div>
    </>}
  </section>
}
