import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DotsThree, Pause, Play, SignOut, WarningCircle } from '@phosphor-icons/react'
import { t, systemText } from './i18n'
import './runtime.css'

type State = Awaited<ReturnType<NonNullable<Window['memoryDesktop']>['runtimeStatus']>>
export function RuntimeRecovery({ error, retry }: { error: string; retry: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  const reconnect = async () => {
    if (busy) return
    setBusy(true); setFailure('')
    try { await window.memoryDesktop?.startRuntime(); await retry() }
    catch (reason) { setFailure(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <div className="runtime-recovery" role="status"><WarningCircle size={18} /><div><b>{t('后台尚未就绪')}</b><p>{systemText(failure || error)}</p><button type="button" className="button secondary" disabled={busy} onClick={() => void reconnect()}><Play size={14} />{busy ? t('正在启动后台…') : t('启动后台并重新读取')}</button></div></div>
}
export function RuntimeStatus({ children, openWork }: { children: ReactNode; openWork: () => void }) {
  const [state, setState] = useState<State | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const api = window.memoryDesktop
    if (!api?.runtimeStatus) return
    let disposed = false
    const read = async () => { try { const value = await api.runtimeStatus(); if (!disposed) setState(value) } catch { if (!disposed) setState({ online: false, ready: false, mode: 'independent' }) } }
    const unsubscribe = api.onRuntimeState?.(value => { if (!disposed) setState(value) })
    void read(); const timer = setInterval(() => void read(), 8000)
    return () => { disposed = true; clearInterval(timer); unsubscribe?.() }
  }, [])
  if (!window.memoryDesktop?.runtimeStatus || state?.mode === 'in_process') return <>{children}</>
  const online = state?.online && state.ready && !state.stopping, waiting = state?.counts?.waiting || 0
  const action = async (kind: 'start' | 'stop' | 'quit') => {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (kind === 'quit') { await window.memoryDesktop!.window('quit'); return }
      if (kind === 'stop') await window.memoryDesktop!.stopRuntime(); else await window.memoryDesktop!.startRuntime()
      setState(await window.memoryDesktop!.runtimeStatus()); if (menu.current) menu.current.open = false
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <div className="runtime-status">
    <button type="button" className="presence-sidebar-state" onClick={openWork} title={online ? t('退出界面后，后台任务仍会继续；需要确认时保持等待。') : state?.error || t('后台未连接，任务不会从这个界面派发。')}>
      <span className={'status-dot' + (online ? ' ready' : '')} />{state?.stopping ? t('正在暂停后台任务') : online && waiting ? t('{p0} 件任务等待确认', { p0: waiting }) : online ? t('后台执行在线') : state?.stopped ? t('后台执行已停止') : state === null ? t('正在连接后台') : t('后台连接中断')}
    </button>
    <details className="runtime-menu" ref={menu} onKeyDown={event => { if (event.key === 'Escape' && menu.current) menu.current.open = false }}>
      <summary aria-label={t('后台执行控制')}><DotsThree size={19} /></summary>
      <div role="group" aria-label={t('后台执行控制')}>
        <p>{online ? t('关闭界面不影响执行。停止后台会暂停任务。') : t('启动后台后，已暂停的任务仍由你决定何时继续。')}</p>
        <button type="button" disabled={busy} onClick={() => void action('quit')}><SignOut size={15} />{t('退出界面，任务继续')}</button>
        {online ? <button type="button" disabled={busy} onClick={() => void action('stop')}><Pause size={15} />{t('停止后台执行')}</button> : <button type="button" disabled={busy || state?.stopping} onClick={() => void action('start')}><Play size={15} />{state?.stopping ? t('正在暂停后台任务') : t('启动后台执行')}</button>}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  </div>
}
