import { t } from './i18n'
import type { View } from './types'
import type { MemoryTab } from './MemoryPage'
import { Tabs } from './ui'

export function SectionNavigation({ section, view, memoryTab, navigate, memory }: { section: string; view: View; memoryTab: MemoryTab; navigate: (view: View) => void; memory: (tab: string) => void }) {
  if (section === 'home' || section === 'history') return null
  return <div className="section-navigation" data-section-navigation>
    <span className="navigation-caption">{section === 'work' ? t("工作管理") : section === 'about' ? t("认识与积累") : t("工具管理")}</span>
    {section === 'work' && <Tabs<View> orientation="vertical" label={t("工作管理")} value={view} onChange={navigate} items={[{ id: 'work', label: '当前工作' }, { id: 'operations', label: '长期目标' }, { id: 'jobs', label: '定时与后台' }, { id: 'goals', label: '目标与提醒' }, { id: 'tasks', label: '任务记录' }, { id: 'changes', label: '更改记录' }, ...(view === 'chat' ? [{ id: 'chat' as View, label: '当前交流' }] : [])]} />}
    {section === 'tools' && <Tabs<View> orientation="vertical" label={t("工具管理")} value={view} onChange={navigate} items={[{ id: 'browser', label: '浏览器' }, { id: 'connectors', label: 'MCP 连接' }, { id: 'abilities', label: '本机能力' }, { id: 'control', label: '桌面控制' }, { id: 'services', label: 'AI 服务' }, { id: 'usage', label: '用量与预算' }, { id: 'core', label: '核心连接' }]} />}
    {section === 'about' && <Tabs<string> orientation="vertical" label={t("认识与积累")} value={view === 'learning' ? 'learning' : ['profile','chats','core'].includes(memoryTab) ? 'profile' : memoryTab} onChange={memory} items={[{ id: 'portrait', label: '对你的理解' }, { id: 'mine', label: '记住的事' }, { id: 'skills', label: '软件技能' }, { id: 'playbooks', label: '经验手册' }, { id: 'learning', label: '学习记录' }, { id: 'profile', label: '档案与会话' }]} />}
  </div>
}
