// Real UI exit, separate Electron execution owner, real canonical core and real file changes.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const net=require('node:net');
const {coreRequest}=require('../electron/core-client.cjs');
const rootProject=path.resolve(__dirname,'..');
const exe=process.env.MEMORY_TEST_DESKTOP_EXE||path.join(rootProject,'node_modules/electron/dist/electron.exe');
const argsFor=flags=>process.env.MEMORY_TEST_DESKTOP_EXE?flags:[rootProject,...flags];
const output=process.env.MEMORY_SMOKE_OUTPUT_DIR||path.join(rootProject,'output/assistant-host-20261012/acceptance');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reply=(res,content,calls)=>{if(res.destroyed)return;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content,...(calls?{tool_calls:calls}:{})}}],usage:{total_tokens:40}}));};
const call=(name,args)=>({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
const wait=async(read,label)=>{for(let i=0;i<500;i++){const result=await read();if(result)return result;await pause(100);}throw Error('独立宿主验收等待超时：'+label);};

(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pisces-host-runtime-')),files=path.join(root,'files'),profile=path.join(root,'profile');await fs.mkdir(files);await fs.mkdir(output,{recursive:true});
  const csv=path.join(files,'销售数据.csv'),basis=path.join(files,'汇总依据.json'),report=path.join(files,'周报.md'),second=path.join(files,'第二份.md');
  await fs.writeFile(csv,'地区,销量\n华东,12\n华南,8\n华东,5\n华北,10\n');
  const coreBinary=process.env.MEMORY_TEST_CORE_BINARY||'D:\\记忆体\\target\\release\\task-workspaces-v1\\autonomous_node.exe';
  const portFinder=net.createServer();await new Promise(r=>portFinder.listen(0,'127.0.0.1',r));const port=portFinder.address().port;await new Promise(r=>portFinder.close(r));
  const token='host-test-'+randomUUID(),settings={coreUrl:'http://127.0.0.1:'+port};
  let requests=0,releaseFirst,firstGate=false,sourceGate=false,core,observer,observerLogs='',hostPid=0;
  const firstWait=new Promise(resolve=>{releaseFirst=resolve;});
  const countCsv=text=>text.trim().split(/\r?\n/).slice(1).reduce((sum,line)=>sum+Number(line.split(',')[1]),0);
  const model=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests++;
      assert.equal(req.headers.authorization,'Bearer host-test-not-real-secret','独立宿主应读取本机加密保存的服务密钥');
      const system=body.messages[0].content;
      if(system.includes('理解模块')){
        const input=JSON.parse(body.messages[1].content),isSecond=input.request.includes('第二份'),quantity=countCsv(await fs.readFile(csv,'utf8'));
        return reply(res,JSON.stringify({type:'task',goal:input.request,kind:'写文档',presentation:'document',deliverable:isSecond?second:report,done_criteria:[{check:'file_contains',target:isSecond?second:report,value:isSecond?'确认后写入':'销量合计：'+quantity}],apps:[],params:{quantity,second:isSecond},steps:'few',missing_info:null,assumptions:[],work_relation:{kind:'new'},user_updates:[]}));
      }
      if(system.includes('规划模块')){
        const input=JSON.parse(body.messages[1].content),quantity=input.intent.params.quantity;
        return reply(res,JSON.stringify({steps:input.intent.params.second===true||input.intent.params.second==='true'?[{id:'second-report',do:'保存需要用户确认的第二份报告',expect:'取得确认后保存文件',depends_on:[],criteria:[{check:'file_contains',target:second,value:'确认后写入'}],outputs:[second]}]:[
          {id:'read-inputs',do:'读取销售CSV并保存汇总依据JSON',expect:'数字来自实际读取的资料',depends_on:[],criteria:[{check:'file_contains',target:basis,value:'"quantity":'+quantity}],outputs:[basis]},
          {id:'write-report',do:'读取已核对依据并保存销售周报',expect:'销量合计正确',depends_on:['read-inputs'],criteria:[{check:'file_contains',target:report,value:'销量合计：'+quantity}],outputs:[report]},
          {id:'readback',do:'实际读取周报核对内容',expect:'交付内容已读回',depends_on:['write-report'],criteria:[{check:'tool_succeeded',target:'read_text',value:'销量合计：'+quantity}],outputs:[]}
        ]}));
      }
      if(system.includes('核对模块'))return reply(res,JSON.stringify({passed:false,unmet:['必须有机械文件证据'],reason:'本验收不凭模型自述通过'}));
      const text=body.messages.map(item=>typeof item.content==='string'?item.content:JSON.stringify(item.content)).join('\n');
      const node=[...text.matchAll(/当前只执行节点 ([\w-]+)：/g)].at(-1)?.[1];
      const toolCalls=body.messages.filter(m=>m.role==='assistant'&&m.tool_calls).flatMap(m=>m.tool_calls),invoked=name=>toolCalls.some(t=>t.function.name===name);
      const tools=body.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return{};}});
      if(node==='read-inputs'){
        if(!invoked('read_text'))return reply(res,'',[call('read_text',{path:csv})]);
        if(!invoked('write_text')){const quantity=countCsv(tools.find(t=>t.path===csv).text);return reply(res,'',[call('write_text',{path:basis,content:JSON.stringify({quantity,source:csv}),overwrite:true})]);}
        return reply(res,'实际销售资料已读取并汇总。');
      }
      if(node==='write-report'){
        if(!invoked('read_text'))return reply(res,'',[call('read_text',{path:basis})]);
        if(!invoked('write_text')){const data=JSON.parse(tools.find(t=>t.path===basis).text);return reply(res,'',[call('write_text',{path:report,content:'# 销售周报\n\n销量合计：'+data.quantity+'\n\n来源：销售数据.csv\n',overwrite:true})]);}
        if(!firstGate){firstGate=true;await fs.writeFile(path.join(files,'gate-first'),'held');await firstWait;}
        return reply(res,'销售周报已保存。');
      }
      if(node==='readback'){
        if(!invoked('read_text'))return reply(res,'',[call('read_text',{path:report})]);
        if(text.includes('资料变化恢复验证')&&countCsv(await fs.readFile(csv,'utf8'))===35&&!sourceGate){sourceGate=true;await fs.writeFile(path.join(files,'gate-source'),'held');await new Promise(resolve=>res.once('close',resolve));return;}
        return reply(res,'交付文件已经实际读回。');
      }
      if(node==='second-report'){
        if(!invoked('write_text'))return reply(res,'',[call('write_text',{path:second,content:'# 第二份报告\n\n确认后写入\n',overwrite:true})]);
        return reply(res,'取得确认后已保存第二份报告。');
      }
      throw Error('未预期的脚本模型阶段：'+system.slice(0,100));
    }catch(error){if(!res.destroyed){res.writeHead(500);res.end(error.stack);}}
  });await new Promise(r=>model.listen(0,'127.0.0.1',r));
  const env={...process.env,PISCES_TEST_USER_DATA:profile,PISCES_TEST_TASK_ROOT:files,MEMORY_TEST_CORE_URL:settings.coreUrl,MEMORY_TEST_CORE_TOKEN:token,MEMORY_TEST_AI_URL:'http://127.0.0.1:'+model.address().port+'/v1',MEMORY_SMOKE_OUTPUT_DIR:output};
  const runUI=async phase=>{
    const child=spawn(exe,argsFor(['--host-smoke']),{cwd:rootProject,windowsHide:true,env:{...env,PISCES_TEST_TASK_PHASE:phase}});let log='';
    child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error(log.slice(-7000)));},90000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
    await fs.writeFile(path.join(output,phase+'-console.log'),log);assert.equal(code,0,log.slice(-7000));assert.match(log,/"hostSmoke":"passed"/);
    return JSON.parse(log.split(/\r?\n/).find(line=>line.includes('"hostSmoke":"passed"')));
  };
  const startObserver=async()=>{observer=await require('../electron/runtime-rpc.cjs').connectRuntime(profile);};
  const query=(name,args=[])=>observer.call(name,args);
  const stopObserver=async()=>{observer?.close();observer=null;};
  try{
    const coreRoot=path.join(root,'core');await fs.mkdir(coreRoot);
    core=spawn(coreBinary,['--state',path.join(coreRoot,'body_state.json'),'--event-store',path.join(coreRoot,'event_store'),'--checkpoint-path',path.join(coreRoot,'checkpoint.json'),'--checkpoint-every-cycles','1','--health-bind','127.0.0.1:'+port,'--cycle-sleep-ms','100','--local-only','--forever'],{cwd:'D:\\记忆体',windowsHide:true,env:{...process.env,MEMORY_API_RBAC:'true',MEMORY_API_OPERATOR_TOKEN:token,MEMORY_API_ADMIN_TOKEN:'',MEMORY_API_VIEWER_TOKEN:'',MEMORY_LOCAL_ONLY:'true',AUTONOMOUS_NODE_LOCAL_ONLY:'true',AUTONOMOUS_NODE_STRICT_OFFLINE:'true',MEMORY_CHAT_PREFER_ENV:'true',MEMORY_CHAT_API_MODE:'local_only',MEMORY_CHAT_API_KEY:'',MEMORY_CHAT_BEARER_TOKEN:'',OPENAI_API_KEY:'',MEMORY_CHAT_ENDPOINT_URL:'',MEMORY_CHAT_BASE_URL:'',MEMORY_CHAT_CONFIG_PATH:'',MEMORY_AUTONOMOUS_LEARNING_ENABLED:'false',MEMORY_AUTONOMOUS_RESEARCH_ENABLED:'false',AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED:'false'}});
    let coreLog='';core.stdout.on('data',d=>coreLog+=d);core.stderr.on('data',d=>coreLog+=d);
    await wait(async()=>{if(core.exitCode!==null)throw Error(coreLog);try{return(await coreRequest(settings,token,'/api/v1/assistant/state')).continuity?.schema===1;}catch{return false;}},'核心就绪');
    const before=await runUI('before');hostPid=before.hostPid;const requestsAtUIExit=requests;
    await startObserver();assert.equal((await query('runtime:status')).uiClients,0,'界面进程必须真的退出');assert.equal((await query('runtime:status')).pid,hostPid);
    releaseFirst();const ids=JSON.parse(await fs.readFile(path.join(files,'host-test-ids.json'),'utf8'));
    await wait(async()=>{const jobs=await query('jobs:list');return jobs.find(j=>j.id===ids.first)?.status==='done'&&jobs.find(j=>j.id===ids.second)?.status==='waiting';},'没有界面时交付第一份并等待第二份确认');
    assert.ok(requests>requestsAtUIExit);assert.match(await fs.readFile(report,'utf8'),/销量合计：35/);assert.equal(await fs.stat(second).then(()=>true,()=>false),false);
    await fs.writeFile(path.join(output,'ui-absent-jobs.json'),JSON.stringify(await query('jobs:list'),null,2));
    await runUI('after');assert.equal((await query('runtime:status')).uiClients,0);assert.equal((await query('runtime:status')).pid,hostPid);
    const prior=await fs.stat(csv);await fs.writeFile(csv,(await fs.readFile(csv,'utf8')).replace('华东,12','华东,17'));await fs.utimes(csv,prior.atime,prior.mtime);assert.equal((await fs.stat(csv)).size,prior.size);assert.ok(Math.abs((await fs.stat(csv)).mtimeMs-prior.mtimeMs)<2);
    process.kill(hostPid);await wait(()=>fs.readFile(path.join(profile,'jobs/jobs.json'),'utf8').then(text=>JSON.parse(text).some(j=>j.id===ids.first&&j.plan.some(n=>n.id==='readback'&&n.evidence?.read_proofs?.length))), '真实读取证明已持久化');
    await stopObserver();const recovered=await runUI('recovery');hostPid=recovered.hostPid;await startObserver();
    const controlled=await runUI('controls'); await stopObserver(); assert.notEqual(controlled.hostPid,hostPid); hostPid=controlled.hostPid; await startObserver();
    const result={passed:true,realCanonicalCore:true,realElectronIPC:true,uiProcessExited:true,workContinuesWithoutUI:true,sameOwnerAfterReopen:true,scheduledTaskStartsWithoutUI:true,approvalWaitsWithoutUI:true,staleApprovalRejected:true,sameWorkAfterHostCrash:true,changedSourceInvalidatesDependents:true,sameSizeAndMtimeChangeDetected:true,userReplanProducesFreshResult:true,explicitStopPersistsPauses:true,restartKeepsPausedTasksStopped:true,lightDarkNarrowControls:true,encryptedServiceCredentials:true,protectedLocalConnection:true,scriptedModel:true,noPaidRequests:true,requests,coreBinary,desktopExecutable:process.env.MEMORY_TEST_DESKTOP_EXE||null,isolatedRuntime:root,finalHostPid:hostPid};
    await query('runtime:stop');await wait(async()=>{try{process.kill(hostPid,0);return false;}catch{return true;}},'显式停止后台');hostPid=0;
    result.explicitHostExit=true; await fs.writeFile(path.join(output,'host-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
    await fs.writeFile(path.join(root,'core.log'),coreLog);
  }finally{
    if(!hostPid){try{const record=JSON.parse(await fs.readFile(path.join(profile,'runtime-host.json'),'utf8'));if(record.address===require('../electron/runtime-rpc.cjs').addressFor(profile))hostPid=record.pid;}catch{}}
    releaseFirst();if(hostPid){try{process.kill(hostPid);}catch{}}
    await stopObserver();if(core?.exitCode===null){const exited=new Promise(r=>core.once('exit',r));core.kill();await exited;}
    model.closeAllConnections();await new Promise(r=>model.close(r));await fs.writeFile(path.join(output,'probe.log'),observerLogs);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
