import type { Workspace, Session, Message } from './types'
import { normalizeWorkbench } from './workbenchState.ts'

export const workspaceKey = 'memory-desktop-workspace-v1'
export const blankSession = (): Session => ({ id: crypto.randomUUID(), title: '新对话', updated: new Date().toISOString(), mode: 'core', messages: [] })
export const initialWorkspace = (): Workspace => ({ version: 1, appearanceVersion: 3, sessions: [blankSession()], traces: [], observe: true, theme: 'light', goals: [], approval: 'pending', memoryHidden: [] })

// The desktop app keeps conversations in a file owned by the main process; the page's localStorage is only the
// fallback for the browser preview and the source for a one-time migration of older data.
function storedWorkspace(): string | null {
  try { const fromFile = window.memoryDesktop?.loadWorkspace?.(); if (fromFile) return fromFile } catch { /* fall back */ }
  try { return localStorage.getItem(workspaceKey) } catch { return null }
}

export function loadWorkspace(): Workspace {
  try {
    const value = JSON.parse(storedWorkspace() || 'null')
    if (value?.version !== 1 || !Array.isArray(value.sessions) || !value.sessions.length || !Array.isArray(value.traces)) return initialWorkspace()
    // Keep storage bounded; no API credentials or canonical core memories are stored here.
    const sessions = value.sessions.filter((session: Session) => session && typeof session.id === 'string' && Array.isArray(session.messages) && (session.mode as string) !== 'demo' && session.id !== 'demo-archive')
    if (!sessions.length) return initialWorkspace()
    return { ...initialWorkspace(), ...value, workbench: normalizeWorkbench(value.workbench), appearanceVersion: 3, sessions, traces: value.traces.filter((trace: { source?: string }) => trace.source !== 'demo'), theme: value.theme === 'dark' ? 'dark' : 'light' }
  } catch { return initialWorkspace() }
}

// Images are kept in memory only: base64 payloads would exhaust the localStorage quota within a few screenshots.
const slimMessage = (message: Message): Message => ({ ...message, images: undefined, raw: message.raw ? { ...message.raw, attachments: message.raw.attachments.map(item => ({ ...item, dataUrl: undefined })) } : undefined })

// `closing`: the page is going away, so write synchronously and wait for the main process to confirm.
export function persistWorkspace(workspace: Workspace, closing = false) {
  const json = JSON.stringify({ ...workspace, workbench: normalizeWorkbench(workspace.workbench), sessions: workspace.sessions.map(session => ({ ...session, messages: session.messages.slice(-100).map(slimMessage) })), traces: workspace.traces.slice(0, 200) })
  const api = window.memoryDesktop
  let saved = false
  if (api?.saveWorkspace) {
    if (closing) saved = api.saveWorkspaceSync(json) === true
    else { api.saveWorkspace(json); saved = true }
  }
  // localStorage is a best-effort mirror; its quota is small, so a failure only matters when the file path is unavailable.
  try { localStorage.setItem(workspaceKey, json) } catch (error) { if (!saved) throw error }
}
