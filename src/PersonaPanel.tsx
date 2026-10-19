import { t } from './i18n'
import type { Persona } from './types'
import { Avatar, BRAND_NAME } from './Brand'

export const defaultPersona: Persona = { name: BRAND_NAME, avatar: 'mark', color: '#000000', style: 'balanced', custom: '' }
const avatars = ['🌱', '🦉', '🐙', '🛰️', '🔮', '🦊', '🍀']
const colors = ['#000000', '#2e7b60', '#3b6fd4', '#7a55c9', '#c2557a', '#c7792a', '#2a8a9a', '#5b6573']
const styles: { id: Persona['style']; label: string; sample: string }[] = [
  { id: 'balanced', label: '均衡', sample: '清楚、自然，该详细时详细。' },
  { id: 'concise', label: '简洁', sample: '先给结论，再给必要的理由。' },
  { id: 'warm', label: '温和', sample: '像一位细心的朋友，会关心你的状态。' },
  { id: 'professional', label: '专业', sample: '条理严谨，会列出依据和风险。' },
  { id: 'playful', label: '轻松', sample: '可以适度幽默，但不影响准确。' },
  { id: 'custom', label: '自定义', sample: '用你自己的话描述想要的说话方式。' },
]

export function PersonaPanel({ value, onChange }: { value: Persona; onChange: (next: Persona) => void }) {
  const set = (patch: Partial<Persona>) => onChange({ ...value, ...patch })
  return <div className="persona-panel">
    <div className="persona-preview" style={{ ['--persona' as string]: value.color }}>
      <Avatar value={value.avatar} size={52} />
      <div><b>{value.name || 'PISCES AI'}</b><p>{t(styles.find(item => item.id === value.style)?.sample)}</p></div>
    </div>
    <label>{t("名字")}<input value={value.name} maxLength={20} onChange={event => set({ name: event.target.value })} placeholder={t("给助手起个名字")} autoComplete="off" /></label>
    <div className="persona-row"><span>{t("头像")}</span><div className="avatar-choices"><button type="button" aria-label={t("默认标志")} aria-pressed={value.avatar === 'mark' || value.avatar === '🧠'} className={value.avatar === 'mark' || value.avatar === '🧠' ? 'on' : ''} onClick={() => set({ avatar: 'mark' })}><Avatar value="mark" size={26} /></button>{avatars.map(item => <button type="button" key={item} aria-pressed={value.avatar === item} className={value.avatar === item ? 'on' : ''} onClick={() => set({ avatar: item })}>{item}</button>)}
      <input className="avatar-custom" value={avatars.includes(value.avatar) || value.avatar === 'mark' || value.avatar === '🧠' ? '' : value.avatar} maxLength={4} placeholder={t("自定")} aria-label={t("自定义头像字符")} onChange={event => event.target.value && set({ avatar: event.target.value })} /></div></div>
    <div className="persona-row"><span>{t("主题色")}</span><div className="color-choices">{colors.map(item => <button type="button" key={item} aria-label={t("主题色 {p0}", { p0: item })} aria-pressed={value.color === item} className={value.color === item ? 'on' : ''} style={{ background: item }} onClick={() => set({ color: item })} />)}</div></div>
    <div className="persona-row"><span>{t("说话风格")}</span><div className="style-choices">{styles.map(item => <button type="button" key={item.id} aria-pressed={value.style === item.id} className={value.style === item.id ? 'on' : ''} onClick={() => set({ style: item.id })}>{t(item.label)}</button>)}</div></div>
    {value.style === 'custom' && <label>{t("描述风格")}<textarea rows={3} maxLength={400} value={value.custom} onChange={event => set({ custom: event.target.value })} placeholder={t("例如：像一位耐心的老师，先问我想学到什么程度，再一步步讲。")} /></label>}
    <p className="field-note">{t("名字和风格会告诉 AI，每次对话和后台任务都遵循；头像和主题色只改变界面外观。助手的事实准确性和安全边界不受风格影响。")}</p>
  </div>
}
