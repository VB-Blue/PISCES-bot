import { t, currentLocale } from './i18n'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Folder } from '@phosphor-icons/react'

export const clock = (value: string | number) => new Date(value).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })
export const dayTime = (value: string | number) => {
  const when = new Date(value)
  if (!Number.isFinite(when.getTime())) return t('时间未记录')
  const today = new Date()
  const sameDay = when.toDateString() === today.toDateString()
  return (sameDay ? t('今天') + ' ' : when.toLocaleDateString(currentLocale(), { month: 'numeric', day: 'numeric' }) + ' ') + clock(value)
}
export const fileSize = (value: number) => value > 1024 * 1024 ? (value / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(value / 1024)) + ' KB'
export const cleanError = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : t('操作失败，请重试')

export function IconButton({ label, children, onClick, className = '', disabled = false }: { label: string; children: ReactNode; onClick?: () => void; className?: string; disabled?: boolean }) {
  label = t(label)
  const id = useId(), [tip, setTip] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hide = () => { clearTimeout(timer.current); setTip(false) }
  useEffect(() => () => clearTimeout(timer.current), [])
  return <button type="button" className={`icon-button ${className}`} aria-label={label} aria-describedby={tip ? id : undefined} onPointerEnter={() => { if (!disabled) timer.current = setTimeout(() => setTip(true), 450) }} onPointerLeave={hide} onFocus={() => { if (!disabled) setTip(true) }} onBlur={hide} onClick={() => { hide(); onClick?.() }} disabled={disabled}>{children}{tip && <span id={id} className="ui-tooltip" role="tooltip">{label}</span>}</button>
}
export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  label = t(label)
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? 'on' : ''}`} onClick={onChange}><span /></button>
}
export function Empty({ icon: Icon = Folder, title, text, action }: { icon?: typeof Folder; title: string; text: string; action?: ReactNode }) {
  title = t(title); text = t(text)
  return <div className="empty"><div className="empty-icon"><Icon size={26} weight="light" /></div><h3>{title}</h3><p>{text}</p>{action}</div>
}
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{typeof children === 'string' ? t(children) : children}</span> }
export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  title = t(title); description = t(description)
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>
}
export function Tabs<T extends string>({ value, onChange, items, orientation = 'horizontal', label }: { value: T; onChange: (next: T) => void; items: { id: T; label: string; count?: number }[]; orientation?: 'horizontal' | 'vertical'; label?: string }) {
  const forward = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight', backward = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
  return <div className={'page-tabs ' + orientation} role="tablist" aria-label={label ? t(label) : undefined} aria-orientation={orientation} onKeyDown={event => { if (![forward, backward, 'Home', 'End'].includes(event.key) || !items.length) return; const current = Math.max(0, items.findIndex(item => item.id === value)), index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === forward ? 1 : -1) + items.length) % items.length; event.preventDefault(); onChange(items[index].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus() }}>{items.map(item => <button type="button" key={item.id} role="tab" tabIndex={value === item.id ? 0 : -1} aria-selected={value === item.id} className={value === item.id ? 'active' : ''} onClick={() => onChange(item.id)}>{t(item.label)}{item.count !== undefined && <span>{item.count}</span>}</button>)}</div>
}
