import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, ArrowClockwise, ArrowSquareOut, CheckCircle, Clock, DownloadSimple, Globe, Plus, Plug, WarningCircle, X } from '@phosphor-icons/react'
import { t, systemText } from './i18n'
import { cleanError, Empty, IconButton, PageHeader } from './ui'
import './browser.css'

export type BrowserTab = { id: string; mode: string; title: string; url: string; connected: boolean; loading: boolean; error: string; uncertain: boolean; recovered: boolean; manualControl?: boolean; connectionId?: string; dialog?: { type: string; message: string } | null }
export type BrowserObservation = { tabId: string; documentId: string; title: string; url: string; text: string; elements: { id: number; name: string; tag: string; type: string; value?: string; sensitive?: boolean }[]; viewport: { width: number; height: number }; uncertain?: boolean }
export type BrowserState = { ready: boolean; activeId: string; tabs: BrowserTab[]; connections: { id: string; mode: string; endpoint: string; online: boolean; owned: boolean; error: string }[]; downloads: { id: string; name: string; status: string; received: number; total?: number; path: string }[]; activity: { id: string; operationId?: string; action: string; phase: string; at: string; tabId?: string; url?: string; error?: string; name?: string }[]; error: string }
const empty: BrowserState = { ready: false, activeId: '', tabs: [], connections: [], downloads: [], activity: [], error: '' }
const actionNames: Record<string, string> = { open: '打开网页', navigate: '导航网页', click: '点击网页', fill: '填写表单', select: '选择选项', press: '网页按键', scroll: '滚动网页', upload: '上传文件', download: '下载文件', reload: '刷新网页', back: '后退', forward: '前进', close: '关闭网页', pointer: '点击网页', text: '输入文字', dialog: '处理网页对话框', resolve: '核对上次操作结果' }
Object.assign(actionNames, { show: '人工接管', resume: '交还助手', hover: '悬停网页', drag: '拖动网页' })
export function BrowserPage() {
  const api = window.memoryDesktop
  const [state, setState] = useState<BrowserState>(empty)
  const [selected, setSelected] = useState('')
  const [url, setUrl] = useState('')
  const [mode, setMode] = useState('internal')
  const [frame, setFrame] = useState<{ tabId: string; image: string; documentId: string; viewport: { width: number; height: number } } | null>(null)
  const [observation, setObservation] = useState<BrowserObservation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:9222')
  const [details, setDetails] = useState<'activity' | 'downloads' | 'page'>('activity')
  const [follow, setFollow] = useState(true)
  const followRef = useRef(true)
  const frameBusy = useRef(false), busyRef = useRef(false), selectedRef = useRef(''), mounted = useRef(true)
  const canvas = useRef<HTMLDivElement>(null)
  const tab = state.tabs.find(item => item.id === selected)
  useEffect(() => { mounted.current = true; if (!api) return; const off = api.onBrowserUpdate(value => { if (mounted.current) { setState(value); if (followRef.current && value.activeId && value.activeId !== selectedRef.current) { selectedRef.current = value.activeId; setSelected(value.activeId) } } }); api.browserState().then(value => { if (mounted.current) { setState(value); setSelected(value.activeId) } }).catch(e => setError(cleanError(e))); return () => { mounted.current = false; off() } }, [api])
  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { if (tab) setUrl(tab.url === 'about:blank' ? '' : tab.url) }, [tab?.id, tab?.url])
  useEffect(() => { if (selected && !state.tabs.some(item => item.id === selected)) { setSelected(state.activeId); setFrame(null); setObservation(null) } }, [state.tabs, state.activeId, selected])
  const refreshFrame = useCallback(async (id: string) => {
    if (!api || !id || frameBusy.current) return
    frameBusy.current = true
    try { const next = await api.browserFrame(id); if (mounted.current && selectedRef.current === id) setFrame(next) } catch (e) { if (mounted.current && selectedRef.current === id) setError(cleanError(e)) } finally { frameBusy.current = false }
  }, [api])
  useEffect(() => {
    setFrame(null); setObservation(null); if (!api || !selected) return
    let alive = true
    api.browserSnapshot(selected).then(value => { if (alive) { setObservation(value); void refreshFrame(selected) } }).catch(e => { if (alive) setError(cleanError(e)) })
    const timer = setInterval(() => { if (!document.hidden && !busyRef.current) void refreshFrame(selected) }, 1500)
    return () => { alive = false; clearInterval(timer) }
  }, [api, selected, refreshFrame])
  useEffect(() => {
    if (!api || !selected || tab?.mode !== 'internal' || !canvas.current) return
    let timer: ReturnType<typeof setTimeout>
    const update = () => { clearTimeout(timer); timer = setTimeout(() => { if (!canvas.current || selectedRef.current !== selected) return; const rect = canvas.current.getBoundingClientRect(); void api.browserViewport(selected, { width: rect.width, height: Math.max(380, innerHeight - rect.top - 115) }).then(() => refreshFrame(selected)).catch(e => setError(cleanError(e))) }, 180) }
    const observer = new ResizeObserver(update); observer.observe(canvas.current); window.addEventListener('resize', update); update()
    return () => { clearTimeout(timer); observer.disconnect(); window.removeEventListener('resize', update) }
  }, [api, selected, tab?.mode, refreshFrame])
  const run = async (fn: () => Promise<unknown>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    try { const result = await fn() as BrowserObservation | undefined; if (!mounted.current) return; if (result?.documentId) setObservation(result); const latest = await api!.browserState(); setState(latest); if (result?.tabId && selectedRef.current !== result.tabId) { selectedRef.current = result.tabId; setSelected(result.tabId) } else if (selectedRef.current) await refreshFrame(selectedRef.current) } catch (e) { if (mounted.current) setError(cleanError(e)) } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  const act = (action: string, values: Record<string, unknown> = {}) => run(() => api!.browserAction({ tabId: selected, documentId: frame?.documentId || observation?.documentId, action, ...values }))
  useEffect(() => {
    const element = canvas.current
    if (!element || !frame) return
    const wheel = (event: WheelEvent) => { if (!(event.target instanceof HTMLImageElement)) return; event.preventDefault(); if (busyRef.current) return; const rect = event.target.getBoundingClientRect(); void act('scroll', { amount: event.deltaY, x: (event.clientX - rect.left) * frame.viewport.width / rect.width, y: (event.clientY - rect.top) * frame.viewport.height / rect.height }) }
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel)
  }, [selected, frame])
  const open = (event: FormEvent) => { event.preventDefault(); const address = /^https?:\/\//i.test(url) ? url : 'https://' + url; if (!url.trim()) return; void run(() => selected ? api!.browserAction({ tabId: selected, action: 'navigate', url: address }) : api!.browserOpen({ url: address, mode })) }
  const activity = state.activity.filter(item => item.phase !== 'started' || !state.activity.some(other => other.operationId === item.operationId && other.phase !== 'started')).slice(0, 35)
  return <section className="browser-workspace" data-browser-workspace>
    <PageHeader eyebrow="" title="浏览器" description="让助手在网页中工作，随时查看进度或接管。登录状态会保留。" action={<button className="button" disabled={busy || !api} onClick={() => { followRef.current = false; setFollow(false); selectedRef.current = ''; setSelected(''); setFrame(null); setObservation(null); setUrl('') }}><Plus size={16}/>{t('新标签页')}</button>} />
    {!api ? <Empty icon={Globe} title="请在桌面程序中使用浏览器" text="浏览器由独立后台运行，关闭主界面后仍可继续任务。" /> : <>
      <div className="browser-connections"><span className="browser-profile"><span className={'status-dot ' + (state.ready ? 'ready' : '')}/>{t('登录档案已保存到本机')}</span><button className="browser-follow" aria-pressed={follow} onClick={() => { const next = !follow; followRef.current = next; setFollow(next); if (next && state.activeId) setSelected(state.activeId) }}><span className={'status-dot ' + (follow ? 'ready' : '')}/>{t('跟随当前任务')}</button><details><summary><Plug size={14}/>{t('连接已有浏览器')}</summary><form onSubmit={event => { event.preventDefault(); void run(() => api.browserConnect({ endpoint })) }}><p>{t('连接已开启本机调试端口的 Chrome 或 Edge。日常浏览器也可通过桌面控制操作。')}</p><label>{t('本机连接地址')}<input aria-label={t('本机连接地址')} value={endpoint} onChange={e => setEndpoint(e.target.value)} /></label><button className="button" disabled={busy}>{t('连接')}</button></form></details></div>
      <div className="browser-shell">
        <div className="browser-tabs" role="tablist" aria-label={t('网页标签')}>
          {state.tabs.map(item => <div className={'browser-tab ' + (selected === item.id ? 'active' : '')} key={item.id}><button role="tab" aria-selected={selected === item.id} onClick={() => { if (!busy) { followRef.current = false; setFollow(false); setSelected(item.id) } }} title={item.title + '\n' + item.url}><Globe size={14}/><span>{item.title || t('新标签页')}</span><small>{item.mode === 'internal' ? t('内置') : item.mode === 'chrome' ? 'Chrome' : item.mode === 'edge' ? 'Edge' : t('外部')}</small></button><button aria-label={t('关闭网页')} disabled={busy} onClick={() => void run(() => api.browserAction({ tabId: item.id, action: 'close' }))}><X size={12}/></button></div>)}
          {!selected && <span className="browser-new-tab"><Plus size={13}/>{t('新标签页')}</span>}
        </div>
        <form className="browser-address" onSubmit={open}>
          <IconButton label="后退" disabled={busy || !selected} onClick={() => void act('back')}><ArrowLeft size={16}/></IconButton><IconButton label="前进" disabled={busy || !selected} onClick={() => void act('forward')}><ArrowRight size={16}/></IconButton><IconButton label="刷新网页" disabled={busy || !selected} onClick={() => void act('reload')}><ArrowClockwise size={16}/></IconButton>
          {!selected && <select aria-label={t('浏览器类型')} value={mode} onChange={event => setMode(event.target.value)}><option value="internal">{t('内置浏览器')}</option><option value="chrome">Chrome</option><option value="edge">Edge</option></select>}
          <label className="browser-url"><Globe size={15}/><input aria-label={t('网页地址')} placeholder={t('输入网址，开始浏览')} value={url} onChange={event => setUrl(event.target.value)} disabled={busy}/></label><button className="button" disabled={busy || !url.trim()}>{t(busy ? '处理中…' : '前往')}</button>
          <IconButton label="打开窗口接管" disabled={busy || !selected} onClick={() => void act('show')}><ArrowSquareOut size={17}/></IconButton>
        </form>
        {(error || state.error || tab?.uncertain) && <div className="browser-error" role="alert"><WarningCircle size={17}/><span>{systemText(error || state.error || '上次操作结果不确定，请重新观察并核对。')}</span>{selected && <button onClick={() => void act('observe')} disabled={busy}>{t('重新观察')}</button>}{tab?.uncertain && <button onClick={() => void act('resolve')} disabled={busy}>{t('我已核对结果')}</button>}</div>}
        {tab?.dialog && <div className="browser-error" role="dialog" aria-label={t('网页对话框')}><Globe size={17}/><span>{tab.dialog.message}</span><button onClick={() => void act('dialog', { accept: false })} disabled={busy}>{t('取消')}</button><button onClick={() => void act('dialog', { accept: true })} disabled={busy}>{t('确认')}</button></div>}
        {tab?.manualControl && <div className="browser-error"><Globe size={17}/><span>{t('人工接管中，助手已暂停此页的自动操作。')}</span><button onClick={() => void act('resume')} disabled={busy}>{t('交还助手')}</button></div>}
        <div className="browser-body">
          <div className="browser-canvas" ref={canvas}>
            {frame && frame.tabId === selected ? <img className={busy ? 'working' : ''} src={frame.image} alt={t('当前真实网页')} draggable={false} tabIndex={0} onClick={event => { if (busy) return; const bounds = event.currentTarget.getBoundingClientRect(); void act('pointer', { x: (event.clientX - bounds.left) * frame.viewport.width / bounds.width, y: (event.clientY - bounds.top) * frame.viewport.height / bounds.height }) }} onKeyDown={event => { if (['ArrowDown','ArrowUp','PageDown','PageUp','Tab','Enter','Escape','Backspace'].includes(event.key)) { event.preventDefault(); if (!busy) void act('press', { key: event.key }) } }} /> : selected ? <div className="browser-loading"><Globe size={28}/><p>{t('正在连接真实网页…')}</p></div> : <div className="browser-start"><Globe size={40} weight="light"/><h2>{t('把网页工作交给助手')}</h2><p>{t('打开网站后，可以直接让助手查资料、填写表单、上传文件并核对结果。')}</p><div><span><CheckCircle size={15}/>{t('内置与外部浏览器')}</span><span><Clock size={15}/>{t('独立后台执行')}</span><span><DownloadSimple size={15}/>{t('下载与操作可追踪')}</span></div></div>}
            {selected && <form className="browser-input" onSubmit={event => { event.preventDefault(); if (text) { void act('text', { text }); setText('') } }}><input aria-label={t('向网页输入文字')} placeholder={t('先点击网页输入框，再在此输入文字')} value={text} onChange={event => setText(event.target.value)} disabled={busy}/><button className="button" disabled={busy || !text}>{t('输入')}</button><button type="button" className="button" disabled={busy} onClick={() => void act('press', { key: 'Enter' })}>{t('回车')}</button><button type="button" className="button" disabled={busy} onClick={() => void act('scroll', { amount: 600 })}>{t('向下滚动')}</button></form>}
          </div>
          <aside className="browser-inspector"><div className="browser-inspector-tabs">{(['activity','downloads','page'] as const).map(id => <button key={id} className={details === id ? 'active' : ''} onClick={() => setDetails(id)}>{t(id === 'activity' ? '执行记录' : id === 'downloads' ? '下载' : '页面内容')}</button>)}</div>
            {details === 'activity' && <div className="browser-activity">{activity.length ? activity.map(item => <div key={item.id} className={'browser-event ' + item.phase}>{item.phase === 'done' ? <CheckCircle size={15}/> : item.phase === 'started' ? <Clock size={15}/> : <WarningCircle size={15}/>}<div><b>{t(actionNames[item.action] || item.action)}</b><small>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {t(item.phase === 'done' ? '已执行并回读' : item.phase === 'started' ? '执行中' : item.phase === 'unknown' ? '结果待核对' : '未完成')}</small>{(item.url || item.error) && <p>{systemText(item.error || item.url || '')}</p>}</div></div>) : <p className="browser-side-empty">{t('助手和你的网页操作会出现在这里。')}</p>}</div>}
            {details === 'downloads' && <div className="browser-downloads">{state.downloads.length ? state.downloads.map(item => <div key={item.id}><DownloadSimple size={17}/><div><b>{item.name}</b><small>{t(item.status === 'completed' ? '下载完成' : item.status === 'progressing' || item.status === 'inProgress' ? '下载中' : '下载中断')}</small>{item.status === 'completed' && <button onClick={() => void run(() => api.browserRevealDownload(item.id))}>{t('在文件夹中显示')}</button>}</div></div>) : <p className="browser-side-empty">{t('内置和专用浏览器的下载会保存在本机，并显示实际状态。')}</p>}</div>}
            {details === 'page' && <div className="browser-page-text"><button className="button" disabled={busy || !selected} onClick={() => void act('observe')}>{t('读取当前页面')}</button>{observation?.tabId === selected && <><h3>{observation.title}</h3><p>{observation.text}</p><small>{t('可操作元素：{p0}', { p0: observation.elements.length })}</small></>}</div>}
          </aside>
        </div>
        <footer className="browser-footer"><span className={'status-dot ' + (selected && tab?.connected ? 'ready' : '')}/><span>{t(busy ? '正在执行并核对结果' : selected ? '点击网页可操作，登录时可打开窗口接管' : '选择浏览器并输入网址即可开始')}</span><span>{t('关闭主界面后，后台任务仍可继续')}</span></footer>
      </div>
    </>}
  </section>
}
