// Genuine multi-node overlap, restart and revision fencing through the packaged or development host.
// Local scripted services provide model messages; all file operations and canonical receipts are real.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {coreRequest}=require('../electron/core-client.cjs'),{connectRuntime,addressFor}=require('../electron/runtime-rpc.cjs');
const project=path.resolve(__dirname,'..'),exe=process.env.MEMORY_TEST_DESKTOP_EXE||path.join(project,'node_modules/electron/dist/electron.exe');
const binary=process.env.MEMORY_TEST_CORE_BINARY||'D:\\记忆体\\target\\release\\task-workspaces-v1\\autonomous_node.exe';
const output=process.env.MEMORY_SMOKE_OUTPUT_DIR||path.join(project,'output/task-orchestration-20261014/acceptance');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(read,label)=>{for(let i=0;i<600;i++){const value=await read();if(value)return value;await pause(100);}throw Error('并行宿主等待超时：'+label);};
const reply=(res,content,calls)=>{if(res.destroyed)return;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content,...(calls?{tool_calls:calls}:{})}}],usage:{total_tokens:40}}));};
const call=(name,args)=>({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
(async()=>{
  const isolated=await fs.mkdtemp(path.join(os.tmpdir(),'pisces-node-flow-')),files=path.join(isolated,'files'),profile=path.join(isolated,'profile'),coreDir=path.join(isolated,'core');
  await Promise.all([fs.mkdir(files),fs.mkdir(coreDir),fs.mkdir(output,{recursive:true})]);
  const sales=path.join(files,'sales.csv'),stock=path.join(files,'stock.csv'),a=path.join(files,'sales.json'),b=path.join(files,'stock.json'),report=path.join(files,'combined.md');
  await fs.writeFile(sales,'region,count\nEast,12\nSouth,8\nNorth,15\n');await fs.writeFile(stock,'region,count\nEast,5\nSouth,6\nNorth,9\n');
  const portServer=net.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  const token='parallel-'+randomUUID(),settings={coreUrl:'http://127.0.0.1:'+port};
  let generation=1,core,observer,hostPid=0,requests=0;const held=[],groups=new Map(),models=[],io=[],coreLogs=[];
  const model=http.createServer(async(req,res)=>{try{
    assert.equal(req.headers.authorization,'Bearer parallel-test-key');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks)),system=String(body.messages[0].content),text=body.messages.map(item=>String(item.content||'')).join('\n');requests++;
    if(system.includes('理解模块')){
      const input=JSON.parse(body.messages[1].content),factor=input.request.includes('翻倍')?2:1;
      return reply(res,JSON.stringify({type:'task',goal:input.request,kind:'销售报告',deliverable:report,done_criteria:[{check:'file_contains',target:report,value:'销售合计：'+35*factor},{check:'file_contains',target:report,value:'库存合计：'+20*factor}],apps:[],params:{factor},steps:'many',ask:null,assumptions:[]}));
    }
    if(system.includes('规划模块'))return reply(res,JSON.stringify({steps:[
      {id:'sales',do:'读取 sales.csv 计算销售合计并写入 sales.json',role:'coder',depends_on:[],inputs:[sales],outputs:[a],execution:{mode:'parallel',tools:['read_text','write_text']},criteria:[{check:'file_contains',target:a,value:'"total"'}]},
      {id:'stock',do:'读取 stock.csv 计算库存合计并写入 stock.json',role:'researcher',depends_on:[],inputs:[stock],outputs:[b],execution:{mode:'parallel',tools:['read_text','write_text']},criteria:[{check:'file_contains',target:b,value:'"total"'}]},
      {id:'compose',do:'读取两个已核对的 JSON 合计并生成 Markdown 销售周报',role:'writer',depends_on:['sales','stock'],inputs:[],outputs:[report],execution:{mode:'parallel',tools:['read_text','write_text']},criteria:[{check:'file_contains',target:report,value:'销售合计：'}]},
      {id:'review',do:'实际读回报告并核对销售和库存合计',role:'reviewer',depends_on:['compose'],inputs:[report],outputs:[],execution:{mode:'parallel',tools:['read_text']},criteria:[{check:'tool_succeeded',target:'read_text',value:'库存合计：'}]},
    ]}));
    if(system.includes('核对模块'))return reply(res,JSON.stringify({passed:true,unmet:[],reason:'scripted judgement; mechanical checks remain authoritative'}));
    const id=text.match(/当前只执行节点 ([\w-]+)：/)?.[1];if(!id)throw Error('No scoped node in executor context');
    const factor=/"factor"\s*:\s*"?2"?/.test(text)?2:1;
    models.push({id,model:body.model,factor,generation});
    const results=body.messages.filter(item=>item.role==='tool').map(item=>{try{return JSON.parse(item.content);}catch{return{};}});
    const read=file=>results.find(item=>item.path===file&&typeof item.text==='string');
    if(['sales','stock'].includes(id)){
      const source=id==='sales'?sales:stock,target=id==='sales'?a:b;
      if(!read(source))return reply(res,'',[call('read_text',{path:source})]);
      assert.ok(!results.some(item=>item.path===(id==='sales'?stock:sales)),'worker contexts cannot inherit sibling source reads');
      const total=read(source).text.trim().split(/\r?\n/).slice(1).reduce((sum,line)=>sum+Number(line.split(',')[1]),0)*factor;
      if(!results.some(item=>item.path===target)){
        if(factor===1){const group=generation;groups.set(group,new Set([...(groups.get(group)||[]),id]));if(groups.get(group).size===2)await fs.writeFile(path.join(files,'both-'+group),'two actual HTTP requests held concurrently');await new Promise(resolve=>held.push({res,resolve,group,id}));}
        io.push({id,factor,path:target,generation});return reply(res,'',[call('write_text',{path:target,content:JSON.stringify({source:path.basename(source),total,factor}),overwrite:true})]);
      }
      return reply(res,path.basename(target)+' 已保存并交回核对。');
    }
    if(id==='compose'){
      if(!read(a)||!read(b))return reply(res,'',[call('read_text',{path:a}),call('read_text',{path:b})]);
      assert.ok(await fs.stat(a)&&await fs.stat(b));const values=[JSON.parse(read(a).text),JSON.parse(read(b).text)];
      if(!results.some(item=>item.path===report)){io.push({id,factor,path:report,generation});return reply(res,'',[call('write_text',{path:report,content:'# 双资料销售周报\n\n销售合计：'+values[0].total+'\n\n库存合计：'+values[1].total+'\n',overwrite:true})]);}
      return reply(res,'两个已核对来源已整合为销售周报。');
    }
    if(id==='review'){if(!read(report))return reply(res,'',[call('read_text',{path:report})]);return reply(res,read(report).text);}
    throw Error('Unexpected node '+id);
  }catch(error){if(!res.destroyed){res.writeHead(500);res.end(error.stack);}}});
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const env={...process.env,PISCES_TEST_USER_DATA:profile,PISCES_TEST_TASK_ROOT:files,MEMORY_TEST_CORE_URL:settings.coreUrl,MEMORY_TEST_CORE_TOKEN:token,MEMORY_TEST_AI_URL:'http://127.0.0.1:'+model.address().port+'/v1',MEMORY_SMOKE_OUTPUT_DIR:output};
  async function runUI(phase){
    const args=process.env.MEMORY_TEST_DESKTOP_EXE?['--parallel-smoke']:[project,'--parallel-smoke'];
    const child=spawn(exe,args,{cwd:project,windowsHide:true,env:{...env,PISCES_TEST_TASK_PHASE:phase}});let log='';child.stdout.on('data',bytes=>log+=bytes);child.stderr.on('data',bytes=>log+=bytes);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error(log.slice(-8000)));},100000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
    await fs.writeFile(path.join(output,phase+'-console.log'),log);assert.equal(code,0,log.slice(-8000));return JSON.parse(log.split(/\r?\n/).find(line=>line.includes('"parallelSmoke":"passed"')));
  }
  const stopObserver=()=>{observer?.close();observer=null;};
  try{
    core=spawn(binary,['--state',path.join(coreDir,'body_state.json'),'--event-store',path.join(coreDir,'event_store'),'--checkpoint-path',path.join(coreDir,'checkpoint.json'),'--checkpoint-every-cycles','1','--health-bind','127.0.0.1:'+port,'--cycle-sleep-ms','100','--local-only','--forever'],{cwd:'D:\\记忆体',windowsHide:true,env:{...process.env,MEMORY_API_RBAC:'true',MEMORY_API_OPERATOR_TOKEN:token,MEMORY_API_ADMIN_TOKEN:'',MEMORY_API_VIEWER_TOKEN:'',MEMORY_LOCAL_ONLY:'true',AUTONOMOUS_NODE_LOCAL_ONLY:'true',AUTONOMOUS_NODE_STRICT_OFFLINE:'true',MEMORY_CHAT_PREFER_ENV:'true',MEMORY_CHAT_API_MODE:'local_only',MEMORY_CHAT_API_KEY:'',MEMORY_CHAT_BEARER_TOKEN:'',OPENAI_API_KEY:'',MEMORY_CHAT_ENDPOINT_URL:'',MEMORY_CHAT_BASE_URL:'',MEMORY_CHAT_CONFIG_PATH:'',MEMORY_AUTONOMOUS_LEARNING_ENABLED:'false',MEMORY_AUTONOMOUS_RESEARCH_ENABLED:'false',AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED:'false'}});
    core.stdout.on('data',bytes=>coreLogs.push(String(bytes)));core.stderr.on('data',bytes=>coreLogs.push(String(bytes)));
    await wait(async()=>{if(core.exitCode!==null)throw Error(coreLogs.join(''));try{return(await coreRequest(settings,token,'/api/v1/assistant/state')).continuity?.schema===1;}catch{return false;}},'核心启动');
    const before=await runUI('before');hostPid=before.hostPid;observer=await connectRuntime(profile);
    assert.equal((await observer.call('runtime:status')).uiClients,0);assert.equal(groups.get(1).size,2);assert.equal(io.length,0);
    await fs.writeFile(path.join(output,'before-crash.json'),JSON.stringify(await observer.call('jobs:list'),null,2));
    process.kill(hostPid);stopObserver();await wait(()=>{try{process.kill(hostPid,0);return false;}catch{return true;}},'独立宿主已经退出');hostPid=0;generation=2;
    const after=await runUI('after');hostPid=after.hostPid;observer=await connectRuntime(profile);
    for(const gate of held)gate.resolve();await pause(200);
    const jobs=await observer.call('jobs:list'),done=jobs.find(job=>job.id===before.jobId);
    assert.equal(done.status,'done');assert.equal(done.workId,before.workId);assert.ok(done.plan.every(node=>node.verification?.passed));
    assert.deepEqual(io.filter(item=>item.factor===2).map(item=>item.id).sort(),['compose','sales','stock']);
    assert.match(await fs.readFile(report,'utf8'),/销售合计：70[\s\S]*库存合计：40/);assert.equal(JSON.parse(await fs.readFile(a,'utf8')).total,70);assert.equal(JSON.parse(await fs.readFile(b,'utf8')).total,40);
    assert.ok(models.some(item=>item.id==='sales'&&item.model==='calc'));assert.ok(models.some(item=>item.id==='stock'&&item.model==='facts'));assert.ok(models.some(item=>item.id==='compose'&&item.model==='report'));
    const detail=await observer.call('core:work-detail',[done.workId]);
    assert.ok(JSON.stringify(detail.receipts).includes(done.plan.find(node=>node.id==='sales').execution_state.lease_id),'实际核心回执必须绑定当前节点执行身份');
    const oldLeases=[...before.leases,...after.leases];
    assert.ok(!detail.receipts.some(receipt=>['write_text','write_document','edit_text'].includes(receipt.operation)&&oldLeases.some(id=>JSON.stringify(receipt).includes(id))),'旧执行身份不能产生写入回执');
    await fs.writeFile(path.join(output,'model-routing.json'),JSON.stringify({models,io},null,2));await fs.writeFile(path.join(output,'final-jobs.json'),JSON.stringify(jobs,null,2));if(detail)await fs.writeFile(path.join(output,'canonical-work.json'),JSON.stringify(detail,null,2));
    await observer.call('runtime:stop');await wait(()=>{try{process.kill(hostPid,0);return false;}catch{return true;}},'后台停止');hostPid=0;
    const result={passed:true,realCanonicalCore:true,realElectronIPC:true,actualIndependentModelRequestsOverlap:true,independentContexts:true,roleServicesSelected:true,joinWaitsForVerifiedParents:true,uiExitedDuringParallelExecution:true,parallelReadOnlyRecoveryAfterHostCrash:true,sameWorkAcrossRestartAndRevision:true,oldExecutionIdentitiesFenced:true,revisedReportUsesActualInputs:true,lightDarkNarrowUI:true,scriptedModels:true,noPaidRequests:true,requests,coreBinary:binary,desktopExecutable:process.env.MEMORY_TEST_DESKTOP_EXE||null,isolatedRuntime:isolated};
    await fs.writeFile(path.join(output,'parallel-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{
    await fs.writeFile(path.join(output,'model-routing.json'),JSON.stringify({models,io},null,2));
    for(const gate of held)gate.resolve();
    if(!hostPid){try{const record=JSON.parse(await fs.readFile(path.join(profile,'runtime-host.json'),'utf8'));if(record.address===addressFor(profile))hostPid=record.pid;}catch{}}
    if(hostPid){try{process.kill(hostPid);}catch{}}stopObserver();
    if(core?.exitCode===null){const exited=new Promise(resolve=>core.once('exit',resolve));core.kill();await exited;}
    model.closeAllConnections();await new Promise(resolve=>model.close(resolve));await fs.writeFile(path.join(output,'core.log'),coreLogs.join(''));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
