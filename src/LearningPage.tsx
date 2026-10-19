import { t } from './i18n'
import { ArrowRight, BookOpen, Brain, DownloadSimple, ThumbsUp } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { AssistantState, SubjectState } from './types'
import { MethodList } from './AssistantPanels'
import { Badge, Empty, PageHeader, dayTime } from './ui'
import type { useMemoryStore } from './MemoryPage'

const kindLabel = { preference: '偏好', fact: '事实', habit: '习惯', goal: '目标', lesson: '纠正' } as const

// Growth, shown as evidence: what was learned, from where, and how often it was actually used.
export function LearningPage({ store, assistantState, refreshAssistant, replay, busy, exportData, openMemory, coreLearning, refreshCoreMemory, coreOnline }: {
  store: ReturnType<typeof useMemoryStore>; assistantState: AssistantState | null; refreshAssistant: () => void; replay: (id: string) => void; busy: boolean; exportData: () => void
  openMemory: () => void; coreLearning: unknown; refreshCoreMemory: () => void; coreOnline: boolean
}) {
  const { memories, playbooks, stats } = store
  const timeline = [
    ...memories.map(item => ({ id: item.id, time: item.createdAt, title: item.text, tag: kindLabel[item.kind], from: item.source, uses: item.hits })),
    ...playbooks.map(item => ({ id: item.id, time: item.createdAt, title: item.title + '（' + item.steps.length + ' 步）', tag: '做法', from: item.source, uses: item.uses })),
  ].sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 12)
  const used = memories.filter(item => item.hits > 0).length + playbooks.filter(item => item.uses > 0).length
  const verified = assistantState?.methods.filter(method => method.status === 'verified').length || 0
  const [subject, setSubject] = useState<SubjectState | null>(null)
  useEffect(() => { window.memoryDesktop?.subjectState?.().then(setSubject).catch(() => {}) }, [])
  const routeLabel: Record<string, string> = { skill: '本地技能', 'skill+plan': '技能＋规划', plan: '规划执行', direct: '直接执行' }
  return <section className="page learning-page">
    <PageHeader eyebrow="LEARNING FROM REAL WORK" title={t("越用越懂你")} description={t("每次对话里学到的偏好、总结的做法、你的纠正，都会在之后的回答里被用上。")} action={<button className="button secondary" onClick={exportData}><DownloadSimple size={15} />{t("导出记录")}</button>} />
    <div className="learning-metrics four">
      <div><span>{t("记住的关于你的事")}</span><strong>{stats?.memories ?? 0}<small>{t("条")}</small></strong><p>{t("其中")}{stats?.pinned ?? 0}{t("条始终参考")}</p></div>
      <div><span>{t("保存的做法")}</span><strong>{stats?.playbooks ?? 0}<small>{t("套")}</small></strong><p>{t("任务后的总结，仍需在新任务中验证")}</p></div>
      <div><span>{t("你的纠正")}</span><strong>{stats?.lessons ?? 0}<small>{t("条")}</small></strong><p>{t("点“踩”并说明后长期生效")}</p></div>
      <div><span>{t("提供过的记忆")}</span><strong>{used}<small>{t("条")}</small></strong><p>{t("按请求选入过上下文")}</p></div>
    </div>
    {stats?.core && <p className="memory-core-link">{!stats.core.linked ? t("记忆只保存在本机，没有连接核心") : stats.core.online ? t("记忆由核心（记忆体）保存，已同步到第 {p0} 版", { p0: stats.core.revision }) : t("核心暂未连接：{p0} 条变更已在本机排队，连接后自动交给核心", { p0: stats.core.pending })}</p>}

    {subject && <>
      <div className="section-heading"><h3>{subject.authority === 'canonical_core' ? t("核心保存的近期任务") : t("桌面端的既有任务记录")}</h3></div>
      <div className="learning-metrics four">
        <div><span>{t("最近接手的任务")}</span><strong>{subject.autonomy.tasks}<small>{t("件")}</small></strong><p>{t("由主体负责到底，完成后按标准核对")}</p></div>
        <div><span>{t("核对通过")}</span><strong>{subject.autonomy.passed}<small>{t("件")}</small></strong><p>{t("有证据才算完成，不信自述")}</p></div>
        <div><span>{t("本地完成")}</span><strong>{subject.autonomy.handledLocally}<small>{t("件")}</small></strong><p>{t("结果核对通过，并且本轮模型调用为 0")}</p></div>
        <div><span>{t("登记的模型调用")}</span><strong>{subject.autonomy.modelCalls}<small>{t("次")}</small></strong><p>{t("结合完成结果判断方法是否有效")}</p></div>
      </div>
      {subject.tasks.length > 0 && <div className="learn-timeline">{subject.tasks.slice(0, 8).map(task => <div className="learn-item" key={task.id}><span className="learn-dot" /><div><p>{task.intent?.goal || task.request}</p><small>{dayTime(task.createdAt)} · {routeLabel[task.route] || task.route || t("进行中")} · {task.status === 'done' ? t("✅ 已核对") : task.status === 'unverified' ? t("⚠️ 未通过核对{p0}", { p0: (task.verification?.unmet.length ? '：' + task.verification.unmet[0] : '') }) : task.status === 'interrupted' ? t("被中断") : t("进行中")}</small></div></div>)}</div>}
    </>}

    <div className="section-heading"><h3>{t("最近学到的")}</h3><button onClick={openMemory}>{t("管理全部")}<ArrowRight size={14} /></button></div>
    {timeline.length ? <div className="learn-timeline">{timeline.map(item => <div className="learn-item" key={item.id}><span className="learn-dot" /><div><p>{item.title}</p><small>{dayTime(item.time)} · {item.from === 'user' ? t("你添加") : item.from === 'feedback' ? t("来自你的纠正") : item.from === 'auto' ? t("自动学到") : t("AI 记住")}{item.uses > 0 && t(" · 已参考 {p0} 次", { p0: item.uses })}</small></div><Badge tone={item.tag === '纠正' ? 'amber' : ''}>{item.tag}</Badge></div>)}</div>
      : <Empty icon={Brain} title={t("还没有学到什么")} text={t("先正常使用：聊聊你的工作习惯，让它帮你完成几个任务。学到的内容会出现在这里，并显示被用了几次。")} action={<button className="button secondary" onClick={openMemory}>{t("手动告诉它一件事")}<ArrowRight size={15} /></button>} />}

    <div className="learning-contract"><div className="contract-icon"><ThumbsUp size={22} weight="light" /></div><div><b>{t("怎样让它学得更准")}</b><p>{t("回答下方的“赞/踩”会调整经验的权重；“踩”时写一句原因，会变成长期遵守的纠正。记忆里不对的内容可以直接编辑或删除。")}</p></div></div>

    <div className="section-heading"><h3>{t("核心的文件方法学习")}</h3><Badge>{coreOnline ? t("核心在线") : t("核心未连接")}</Badge></div>
    <p className="field-note wide">{t("这是PISCES AI核心里经过独立复做验证的方法（目前限于“读文本文件 → 生成清单并校验”）。已验证")}{verified}{t("个。")}</p>
    <MethodList state={assistantState} refresh={refreshAssistant} replay={replay} busy={busy} />
    <details className="raw-details"><summary><BookOpen size={15} />{t("核心学习状态（技术详情）")}</summary>
      <button className="button secondary" onClick={refreshCoreMemory}>{t("读取")}</button>{coreLearning ? <pre className="core-json">{JSON.stringify(coreLearning, null, 2)}</pre> : <p className="field-note">{t("点击“读取”获取核心的规则与摄取状态。")}</p>}</details>
  </section>
}
