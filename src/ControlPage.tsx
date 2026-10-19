import { t } from './i18n'
import type { ReactNode } from 'react'
import { ArrowClockwise, ArrowRight, Monitor, ShieldCheck } from '@phosphor-icons/react'
import type { DesktopSelection } from './types'
import { CapabilityPanel } from './Capabilities'
import { Badge, Empty, PageHeader } from './ui'

export function ControlPage({ coreOnline, busy, target, selectWindow, clearTarget, goChat, checkCore, instruction, setInstruction, runTask, receipt, controlLog, loadLog, notify }: {
  coreOnline: boolean; busy: boolean; target: DesktopSelection | null; selectWindow: () => void; clearTarget: () => void; goChat: () => void; checkCore: () => void
  instruction: string; setInstruction: (value: string) => void; runTask: (execute: boolean) => void; receipt: ReactNode; controlLog: unknown; loadLog: () => void; notify: (text: string) => void
}) {
  return <section className="page">
    <PageHeader eyebrow="YOUR COMPUTER, ONE WORKSPACE" title={t("桌面控制")} description={t("决定 AI 能在这台电脑上做什么，并让它操作你指定的软件窗口。")} action={<button className="button secondary" onClick={checkCore}><ArrowClockwise size={15} />{t("检查核心连接")}</button>} />

    <div className="control-section">
      <div className="section-heading"><h3>{t("1. 让 AI 控制软件")}</h3><Badge tone={coreOnline ? 'green' : ''}>{coreOnline ? t("核心在线") : t("需要核心在线")}</Badge></div>
      <div className="control-steps"><div><b>{t("在对话里直接说")}</b><small>{t("例如“用 Photoshop 把这张照片拉正并提亮”。AI 会自己打开软件、找到窗口")}</small></div><div><b>{t("第一次允许该软件")}</b><small>{t("弹窗里选“允许”或“永久允许 软件控制 xxx”。每个软件单独授权")}</small></div><div><b>{t("它看图、点击、输入")}</b><small>{t("AI 截图看到界面，再点击、拖动、按快捷键、输入文字，每一步后复查；按 Ctrl+Alt+Q 随时停止")}</small></div></div>
      <div className={`target-card ${target ? 'ready' : ''}`}>
        <Monitor size={26} weight={target ? 'fill' : 'light'} />
        <div><b>{target ? target.title : t("备用：由核心绑定窗口")}</b><small>{target ? t("{p0} · 5 分钟内有效", { p0: target.process }) : t("点击右侧按钮，把前台软件设为操作目标")}</small></div>
        <button className="button secondary" disabled={busy} onClick={selectWindow}>{target ? t("重新选择") : t("选择当前软件")}</button>
        {target && <button className="button secondary" disabled={busy} onClick={clearTarget}>{t("清除")}</button>}
        {target && <button className="button primary" onClick={goChat}>{t("去对话")}<ArrowRight size={15} /></button>}
      </div>
      <p className="field-note wide">{t("AI 看到的是被授权窗口的截图，会发送给你配置的模型，所以需要支持图片输入的模型。密码管理器、终端、系统安全窗口一律拒绝；Win 键组合和 Alt+F4 不允许。下面是备用方式：由核心先绑定一个窗口，只读界面文字、不发截图。")}</p>
    </div>

    <div className="control-section">
      <div className="section-heading"><h3>{t("2. 允许 AI 使用的本机能力")}</h3></div>
      <CapabilityPanel notify={notify} />
    </div>

    <details className="control-section advanced">
      <summary><h3>{t("高级：直接给核心下发桌面指令")}</h3></summary>
      <div className="desktop-task-form">
        <label htmlFor="desktop-instruction">{t("指令")}</label>
        <textarea id="desktop-instruction" value={instruction} onChange={event => setInstruction(event.target.value)} placeholder={t("例如：在记事本中点击文件菜单")} disabled={busy} />
        <p>{t("目标是打开助手之前的前台窗口。预览不执行动作；执行时由核心判断权限并验证结果。")}</p>
        <div><button className="button secondary" disabled={busy || !instruction.trim()} onClick={() => runTask(false)}>{t("预览")}</button><button className="button primary" disabled={busy || !instruction.trim()} onClick={() => runTask(true)}>{busy ? t("等待核心回执…") : t("让核心执行")}<ArrowRight size={15} /></button></div>
        {receipt}
      </div>
      <div className="section-heading"><h3>{t("核心返回的操作记录")}</h3><button onClick={loadLog}><ArrowClockwise size={14} />{t("读取")}</button></div>
      {controlLog ? <pre className="core-json">{JSON.stringify(controlLog, null, 2)}</pre> : <Empty icon={ShieldCheck} title={t("还没有读取")} text={t("连接中断不等于动作被撤销，请核对记录后再重试。")} />}
    </details>
  </section>
}
