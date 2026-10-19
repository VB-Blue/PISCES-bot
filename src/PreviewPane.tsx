import { t } from './i18n'
import { useEffect,useRef,useState } from 'react'
import { X,ArrowClockwise,DownloadSimple } from '@phosphor-icons/react'
export type Preview={kind:'html'|'url'|'image'|'document';title:string;content:string;artifact?:{workId:string;receiptId:string;format:string}}
export function artifactPreview(workId:string,receipt:{id:string;evidence:Record<string,unknown>}):Preview {
  const e=receipt.evidence, format=String(e.format)
  const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  return {kind:format==='docx'?'document':'html',title:String(e.title||'生成内容'),content:format==='docx'?'<h1>'+escape(String(e.title))+'</h1><pre>'+escape(String(e.preview_content||''))+'</pre>':String(e.preview_content||''),...(format==='docx'?{artifact:{workId,receiptId:receipt.id,format}}:{})}
}
export function safePreviewDocument(content:string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; base-uri 'none'"><style>body{margin:24px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,'Segoe UI',Helvetica,'Apple Color Emoji',Arial,sans-serif,'Segoe UI Emoji','Segoe UI Symbol';font-size:16px;color:#202428;line-height:1.5}svg{max-width:100%;height:auto}img{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${content}</body></html>`
}
export function PreviewPane({value,close,hidden=false}:{value:Preview;close:()=>void;hidden?:boolean}) {
  const body=useRef<HTMLDivElement>(null)
  const [status,setStatus]=useState('')
  useEffect(()=>{
    setStatus('')
    if(value.kind!=='url'||!window.memoryDesktop)return
    const api=window.memoryDesktop
    const off=api.onPreviewState(event=>setStatus(event.error||(event.loading?'正在加载网页…':event.url||'')))
    const element=body.current!
    const update=()=>{const r=element.getBoundingClientRect();api.previewBounds({x:r.x,y:r.y,w:r.width,h:r.height,visible:!hidden}).catch(error=>setStatus(String(error)))}
    const observer=new ResizeObserver(update);observer.observe(element)
    api.previewOpen(value.content).then(update).catch(error=>setStatus(String(error)))
    window.addEventListener('resize',update)
    return()=>{off();observer.disconnect();window.removeEventListener('resize',update);api.previewClose()}
  },[value,hidden])
  const download=()=>{const blob=new Blob([value.content],{type:'text/html;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=value.title+'.html';a.click();URL.revokeObjectURL(url)}
  return <aside className="preview-pane"><header><div><b>{value.title}</b><small>{value.kind==='url'?value.content:value.kind==='document'?t("实际生成的文件内容"):t("图形与页面")}</small></div><button aria-label={t("关闭预览")} onClick={close}><X size={18}/></button></header><div className="preview-toolbar">{value.artifact && <button onClick={async()=>{try{const r=await window.memoryDesktop?.openArtifact(value.artifact!);setStatus(r?.note||'已请求打开')}catch(error){setStatus(String(error))}}}>{t("在 Word 打开")}</button>}{['html','document'].includes(value.kind)&&<button onClick={download}><DownloadSimple size={15}/>{t("导出页面")}</button>}{value.kind==='url'&&<button onClick={()=>window.memoryDesktop?.previewOpen(value.content)}><ArrowClockwise size={15}/>{t("刷新")}</button>}</div>{status&&<div className="preview-status" role="status">{status}</div>}<div className="preview-content" ref={body}>{value.kind==='image'?<img src={value.content} alt={value.title}/>:value.kind==='url'?!window.memoryDesktop&&<p>{t("网页侧浏览器需要桌面程序。")}</p>:<iframe title={value.title} sandbox="" srcDoc={safePreviewDocument(value.content)}/>}</div></aside>
}
