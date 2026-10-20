import { t } from './i18n'
import { useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { mediaUrl } from './ChatExtras'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'

// A picture or video on this computer, written as a path in the reply, is shown through the app's own media address.
const MEDIA_PREFIX = 'memory://app/__media?', LOCAL_VIDEO = /\.(mp4|webm|m4v|mov)$/i
const LOCAL_MEDIA = /^(?:file:\/\/\/?)?([a-z]:[\\/].*\.(?:png|jpe?g|webp|gif|bmp|mp4|webm|m4v|mov))$/i
function transformUrl(url: string, key: string) {
  if (url.startsWith(MEDIA_PREFIX)) return url
  let decoded = url
  try { decoded = decodeURIComponent(url) } catch { /* keep as written */ }
  const local = key === 'src' ? LOCAL_MEDIA.exec(decoded) : null
  return local ? mediaUrl(local[1].replace(/\//g, '\\')) : defaultUrlTransform(url)
}
import 'highlight.js/styles/github.css'
import type { Preview } from './PreviewPane'
export function extractPreview(content: string): Preview | null {
  const fence = /```(html|svg)\s*\n([\s\S]*?)```/gi
  let match, last: Preview | null = null
  while ((match = fence.exec(content))) last = { kind:'html', title:match[1].toLowerCase()==='svg' ? '图形预览' : '页面预览', content:match[2] }
  if (last) return last
  if (/^\s*(<!doctype\s+html|<html\b|<svg\b)/i.test(content)) return { kind:'html', title:'生成内容预览', content }
  return null
}
function plain(node: ReactNode): string {
  if (typeof node==='string' || typeof node==='number') return String(node)
  if (Array.isArray(node)) return node.map(plain).join('')
  if (node && typeof node==='object' && 'props' in node) return plain((node as { props:{ children?:ReactNode } }).props.children)
  return ''
}
function Copy({ code }: { code:string }) {
  const [copied,setCopied]=useState(false)
  return <button className="code-copy-btn" onClick={async()=>{ await navigator.clipboard.writeText(code); setCopied(true); setTimeout(()=>setCopied(false),1500) }}>{copied?t("已复制"):t("复制")}</button>
}
export function MessageRenderer({ content,onPreview }: { content:string; onPreview:(value:Preview)=>void }) {
  const preview=extractPreview(content)
  if (/^\s*(<!doctype\s+html|<html\b|<svg\b)/i.test(content) && preview) return <button className="artifact-link" onClick={()=>onPreview(preview)}>{t("查看生成的图形或页面 ↗")}</button>
  return <div className="markdown-body"><ReactMarkdown urlTransform={transformUrl} remarkPlugins={[remarkGfm,remarkMath]} rehypePlugins={[rehypeKatex,rehypeHighlight]} components={{
    a({ href,children }) { return <a href={href} onClick={event=>{event.preventDefault();if(href && /^https?:\/\//i.test(href))onPreview({kind:'url',title:'浏览网页',content:href})}}>{children}</a> },
    pre({ children }) { const code=plain(children).replace(/\n$/,''); return <div className="code-block-wrap"><div className="code-block-header"><span>{t("代码")}</span><Copy code={code}/></div><pre>{children}</pre>{preview && code.trim()===preview.content.trim() && <button className="preview-toggle" onClick={()=>onPreview(preview)}>{t("在侧栏查看效果 ↗")}</button>}</div> },
    table({ children }) { return <div className="table-wrap"><table>{children}</table></div> },
    img({ src,alt }) { if(src&&src.startsWith(MEDIA_PREFIX)&&LOCAL_VIDEO.test(decodeURIComponent(src)))return <video className="inline-video" src={src} controls preload="metadata"/>; if(!src || !/^(https?:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(src)&&!src.startsWith(MEDIA_PREFIX))return <span>{alt||t("图片地址不受支持")}</span>; return <button className="image-preview-link" onClick={()=>onPreview({kind:'image',title:alt||'图片',content:src})}><img src={src} alt={alt||t("图片")} loading="lazy"/></button> },
  }}>{content}</ReactMarkdown></div>
}
