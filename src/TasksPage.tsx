import { t } from './i18n'
import { useCallback, useEffect, useState } from 'react'
import { ArrowClockwise, CheckCircle, Prohibit, SquaresFour, WarningCircle, Wrench } from '@phosphor-icons/react'
import type { AssistantState, ToolAuditEntry } from './types'
import { Badge, Empty, PageHeader, Tabs, cleanError, dayTime } from './ui'

const workStatus: Record<string, string> = { actions_verified: '动作已验证', running: '进行中', verified: '已校验', advice_only: '仅建议', failed: '失败', cancelled: '已停止', result_unknown: '结果待核对', finished: '已完成' }
const operationLabel: Record<string, string> = { read_file: '读取文件', write_inventory: '生成清单', observe_desktop: '观察窗口', desktop_action: '操作窗口', create_artifact: '生成内容' }

export function TasksPage({ state, refreshAssistant, notify }: { state: AssistantState | null; refreshAssistant: () => void; notify: (text: string) => void }) {
  const [tab, setTab] = useState<'activity' | 'works'>('activity')
  const [audit, setAudit] = useState<ToolAuditEntry[]>([])
  const load = useCallback(async () => {
    if (!window.memoryDesktop) return
    try { setAudit(await window.memoryDesktop.toolAudit()) } catch (error) { notify(cleanError(error)) }
  }, [])
  useEffect(() => { void load() }, [load])
  return <section className="page">
    <PageHeader eyebrow="WORK, STEP BY STEP" title={t("任务")} description={t("AI 在你的电脑上做过的每一件事都记在这里，改动类操作还会标明你是否批准。")} action={<button className="button secondary" onClick={() => { void load(); refreshAssistant() }}><ArrowClockwise size={15} />{t("刷新")}</button>} />
    <Tabs value={tab} onChange={setTab} items={[{ id: 'activity', label: '本机操作记录', count: audit.length }, { id: 'works', label: '核心工作单', count: state?.works.length }]} />
    {tab === 'activity' && (audit.length ? <div className="audit-list">{audit.map((entry, index) => <div className={`audit-row ${entry.ok ? 'ok' : entry.denied ? 'denied' : 'failed'}`} key={index}>
      <span className="audit-icon">{entry.ok ? <CheckCircle size={18} weight="fill" /> : entry.denied ? <Prohibit size={18} /> : <WarningCircle size={18} weight="fill" />}</span>
      <div><b>{entry.summary}</b>{entry.error && <p>{entry.error}</p>}<small>{dayTime(entry.ts)}</small></div>
      <Badge tone={entry.ok ? 'green' : entry.denied ? 'amber' : ''}>{entry.ok ? t("已完成") : entry.denied ? t("你已拒绝") : t("失败")}</Badge></div>)}</div>
      : <Empty icon={Wrench} title={t("还没有操作记录")} text={t("让助手去搜索资料、整理文件或打开软件，它每次动手都会记在这里。")} />)}
    {tab === 'works' && (state?.works.length ? <div className="work-list">{[...state.works].reverse().map(work => <details className="work-card" key={work.id}>
      <summary><div><b>{work.goal.slice(0, 90)}</b><small>{dayTime(work.created_at)} · {work.calls.length}{t("次模型调用 ·")}{work.receipts.length}{t("个步骤")}</small></div><Badge tone={work.status === 'failed' ? '' : 'green'}>{workStatus[work.status] || work.status}</Badge></summary>
      {work.result && <p className="message-text">{work.result}</p>}
      {work.receipts.map(receipt => <div className="tool-feedback" key={receipt.id}><b>{operationLabel[receipt.operation] || receipt.operation}</b><span>{receipt.status === 'verified' ? t("已验证") : receipt.status}</span>{receipt.error && <p className="error-text">{receipt.error}</p>}</div>)}
      <details className="raw-details"><summary>{t("技术详情")}</summary><pre className="core-json">{JSON.stringify({ calls: work.calls, receipts: work.receipts }, null, 2)}</pre></details></details>)}</div>
      : <Empty icon={SquaresFour} title={t("还没有核心工作单")} text={t("在“智能助手”模式下处理文件、操作软件窗口时，核心会签发工作单并保存真实回执。")} />)}
  </section>
}
