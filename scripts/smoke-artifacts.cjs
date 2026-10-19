const {spawn}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {randomUUID,createHash}=require('node:crypto');const assert=require('node:assert/strict');
const {coreRequest}=require('../electron/core-client.cjs');const {extractDocument}=require('../electron/attachments.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'memory-real-artifacts-'));const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const token='test-'+randomUUID(),binary=process.env.MEMORY_TEST_CORE_BINARY||'D:/记忆体/target/release/autonomous_node.exe';
  const child=spawn(binary,['--state',path.join(root,'body_state.json'),'--event-store',path.join(root,'event_store'),'--checkpoint-path',path.join(root,'checkpoint.json'),'--health-bind','127.0.0.1:'+port,'--local-only','--forever','--cycle-sleep-ms','50'],{cwd:'D:/记忆体',windowsHide:true,env:{...process.env,MEMORY_LOCAL_ONLY:'true',AUTONOMOUS_NODE_STRICT_OFFLINE:'true',MEMORY_CHAT_API_MODE:'local_only',MEMORY_CHAT_CONFIG_PATH:'',MEMORY_CHAT_API_KEY:'',OPENAI_API_KEY:'',MEMORY_AUTONOMOUS_LEARNING_ENABLED:'false',MEMORY_AUTONOMOUS_RESEARCH_ENABLED:'false',AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED:'false',MEMORY_API_RBAC:'true',MEMORY_API_OPERATOR_TOKEN:token,MEMORY_API_ADMIN_TOKEN:'',MEMORY_API_VIEWER_TOKEN:''}});
  let logs='';child.stdout.on('data',d=>logs=(logs+d).slice(-8000));child.stderr.on('data',d=>logs=(logs+d).slice(-8000));
  const api=body=>coreRequest({coreUrl:'http://127.0.0.1:'+port},token,'/api/v1/assistant/request',{body,signal:AbortSignal.timeout(60000)});
  try{
    let ready=false;for(let i=0;i<100;i++){try{await api({action:'profile'});ready=true;break;}catch{await delay(500);}}assert.ok(ready,logs);
    const workId=randomUUID();await api({action:'create_work',id:workId,session:randomUUID(),goal:'创建并打开 Word 验收文档，再绘制 SVG 图形',files:[],multi_agent:false});
    const call=async()=>{const p=await api({action:'reserve_call',work_id:workId,role:'executor',model:'local-fixture'});await api({action:'settle_call',work_id:workId,call_id:p.call.id,status:'success',total_tokens:0,note:'deterministic proposal; no model service invoked'});return p.call.id;};
    await assert.rejects(api({action:'create_artifact',work_id:workId,call_id:randomUUID(),request_id:randomUUID(),format:'docx',title:'未授权',content:'x'}),/409/);
    const requestId=randomUUID(),body={action:'create_artifact',work_id:workId,call_id:await call(),request_id:requestId,format:'docx',title:'助手文档能力验收',content:'此文档用于验证真实文件生成和 Word 打开能力。\n# 验证内容\n中文、空格和标点 & < > 应当完整保存。\n这不是模型声称完成，而是核心写入后读取校验的文件。'};
    const created=await api(body);assert.equal(created.receipt.status,'verified');const bytes=await fs.readFile(created.output.path);assert.equal(createHash('sha256').update(bytes).digest('hex'),created.output.sha256);
    const extracted=await extractDocument('验证.docx',bytes);assert.ok(extracted.text.includes('中文、空格和标点 & < >'));await assert.rejects(api(body),/409/);
    const svg=await api({action:'create_artifact',work_id:workId,call_id:await call(),request_id:randomUUID(),format:'svg',title:'图形验收',content:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 280"><rect width="480" height="280" fill="#f5f8f4"/><circle cx="145" cy="190" r="48" fill="none" stroke="#263d32" stroke-width="7"/><circle cx="335" cy="190" r="48" fill="none" stroke="#263d32" stroke-width="7"/><path d="M145 190L235 190L192 110L145 190L278 120L335 190" fill="none" stroke="#263d32" stroke-width="7"/><ellipse cx="244" cy="95" rx="48" ry="36" fill="#86ae77"/><circle cx="299" cy="81" r="23" fill="#86ae77"/><circle cx="306" cy="75" r="3"/><path d="M249 121L235 169M274 118L286 134" stroke="#86ae77" stroke-width="13" stroke-linecap="round"/></svg>'});assert.equal(svg.receipt.status,'verified');
    let opened=null;if(process.argv.includes('--word'))opened=await api({action:'open_artifact',work_id:workId,call_id:await call(),receipt_id:created.receipt.id});
    await api({action:'finish',work_id:workId,status:'finished',result:'实际文件已经写入并独立读取验证。'});
    const report={passed:true,root,docx:created.output.path,svg:svg.output.path,docxReadback:true,docxExtracted:true,untrustedCallRejected:true,duplicateWriteBlocked:true,modelCalls:0,word:opened?.output||null};await fs.writeFile(path.join(__dirname,'../产物真实验收.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{child.kill();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
