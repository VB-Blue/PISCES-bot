import { t, systemText } from './i18n'
import { useRef, useState } from 'react'
import { Check, ShieldWarning, X } from '@phosphor-icons/react'
import type { ToolApproval } from './types'
import { Badge } from './ui'
import { useDialog } from './useDialog'

const riskLabel = { low: '低风险', medium: '会改变本机', high: '高风险' }

// Shown whenever the assistant wants to change something on this computer. Nothing runs until the user answers.
export function ToolApprovalModal({ approval, onResolve }: { approval: ToolApproval; onResolve: (decision: 'once' | 'session' | 'always' | 'deny') => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false)
  const answer = async (decision: 'once' | 'session' | 'always' | 'deny') => { setSubmitting(true); try { await onResolve(decision) } finally { setSubmitting(false) } }
  const dialog = useRef<HTMLElement>(null)
  useDialog(dialog, true, () => { if (!submitting) void answer('deny') }, '.button.primary')
  const [headline, ...details] = approval.lines
  return <div className="modal-backdrop">
    <section ref={dialog} className="auth-modal" role="alertdialog" aria-modal="true" aria-labelledby="tool-approval-title" tabIndex={-1} style={{ maxWidth: 560 }}>
      <div className="modal-header"><div>
        <div className="approval-title-row"><ShieldWarning size={22} weight="bold" color={approval.risk === 'high' ? 'var(--red)' : 'var(--amber)'} /><h2 id="tool-approval-title">{t(approval.title)}</h2><Badge tone={approval.risk === 'low' ? '' : 'amber'}>{t(riskLabel[approval.risk])}</Badge></div>
        <p>{t("AI 请求执行下面的操作。确认之前不会有任何改动。")}</p></div></div>
      <div className="auth-body">
        <div className="approval-detail"><code>{headline}</code>{details.map((line, index) => <p key={index}>{systemText(line)}</p>)}</div>
        {approval.risk === 'high' && <p className="field-note">{t("请逐字核对命令或路径。你可以拒绝后让 AI 换一种更安全的做法。")}</p>}
      </div>
      <div className="modal-footer approval-footer">
        <button type="button" className="button secondary" disabled={submitting} onClick={() => void answer('deny')}><X size={15} />{t("拒绝")}</button>
        {approval.allowSession && <button type="button" className="button secondary" disabled={submitting} onClick={() => void answer('session')}>{approval.sessionScope === 'conversation' ? t("本次对话内不再询问只读命令") : t("本次运行内不再询问")}</button>}
        {approval.allowAlways && <button type="button" className="button secondary always" disabled={submitting} title={t("之后不再询问，可在 设置 → 本机能力 里撤销")} onClick={() => void answer('always')}>{t("永久允许")}{approval.grantLabel ? ' ' + approval.grantLabel : ''}</button>}
        <button type="button" className="button primary" disabled={submitting} onClick={() => void answer('once')}><Check size={15} />{t("允许这一次")}</button>
      </div>
    </section>
  </div>
}
