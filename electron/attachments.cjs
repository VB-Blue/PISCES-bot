const path=require('node:path');
const {unzipSync,strFromU8}=require('fflate');
const MAX_FILE=20_000_000, MAX_TEXT=48000;
function boundedText(text, limit = MAX_TEXT) {
  const bytes=Buffer.from(text,'utf8');
  if(bytes.length<=limit)return {text,truncated:false};
  let end=limit;while((bytes[end]&0xc0)===0x80)end--;
  return {text:bytes.subarray(0,end).toString('utf8'),truncated:true};
}
function unxml(text) {return text.replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');}
async function extractDocument(name,bytes,{maxTextBytes=MAX_TEXT,maxPages=40}={}) {
  if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);
  if(bytes.length>MAX_FILE)throw new Error('单个附件最多 20 MB');
  const ext=path.extname(name).toLowerCase();
  if(ext==='.docx') {
    const entries=unzipSync(bytes,{filter:e=>e.name==='word/document.xml'&&e.originalSize<2_000_000});
    if(!entries['word/document.xml'])throw new Error('DOCX 正文缺失或解压后过大');
    const xml=strFromU8(entries['word/document.xml']);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('不支持含外部实体的文档');
    const paragraphs=[...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(p=>[...p[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(t=>unxml(t[1])).join('')).join('\n');
    return {...boundedText(paragraphs,maxTextBytes),kind:'Word 正文'};
  }
  if(ext==='.pdf') {
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true});
    const timer=setTimeout(()=>task.destroy(),20000);let document;
    try {
      document=await task.promise;let text='';let pages=0;let processed=0;
      for(;pages<Math.min(document.numPages,maxPages);pages++) {
        const page=await document.getPage(pages+1);const content=await page.getTextContent();
        text+='\n[第 '+(pages+1)+' 页]\n'+content.items.map(t=>'str' in t?t.str+(t.hasEOL?'\n':' '):'').join('');
        processed=pages+1;
        if(Buffer.byteLength(text)>maxTextBytes)break;
      }
      if(!text.replace(/\[第 \d+ 页\]/g,'').trim())throw new Error('此 PDF 没有可提取正文，可能是扫描件；请上传页面图片');
      const result=boundedText(text,maxTextBytes);return {...result,truncated:result.truncated||processed<document.numPages,kind:'PDF 正文'};
    }finally{clearTimeout(timer);await task.destroy();}
  }
  if(!['.txt','.md','.json','.csv','.rs','.py','.js','.ts','.tsx','.html','.css','.xml','.yaml','.yml','.log','.toml'].includes(ext))throw new Error('该文件格式暂不支持；可上传图片、PDF、DOCX 或文本文件');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(text.includes('\0'))throw new Error('文件包含二进制数据，不能按文本读取');
  return {...boundedText(text),kind:'文本'};
}
module.exports={extractDocument,boundedText,MAX_FILE};
