// The supplied fingerprint mark; coordinates retain the reference geometry.
import { FINGERPRINT_DOTS } from './brand-fingerprint'

export const BRAND_NAME = 'PISCES AI'
const isMark = (value?: string) => !value || value === 'mark' || value === '🧠'

export function PiscesMark({ size = 24 }: { size?: number }) {
  return <svg viewBox="32 32 176 176" width={size} height={size} fill="currentColor" aria-hidden="true">
    {FINGERPRINT_DOTS.map(([cx, cy, r], index) => <circle key={index} cx={cx} cy={cy} r={r} />)}
  </svg>
}

export function Avatar({ value, size = 28, className = '' }: { value?: string; size?: number; className?: string }) {
  const mark = isMark(value)
  return <span className={`avatar ${mark ? 'mark' : 'glyph'} ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.52), borderRadius: Math.round(size * 0.32) }} aria-hidden="true">
    {mark
      ? <PiscesMark size={Math.round(size * 0.82)} />
      : value}
  </span>
}
