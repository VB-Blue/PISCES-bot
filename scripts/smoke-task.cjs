// Real Electron IPC + canonical core + filesystem. Scripted local model verifies the runtime, not model intelligence.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { coreRequest } = require('../electron/core-client.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const desktop = path.resolve(__dirname, '..');
const project = process.env.MEMORY_CORE_PROJECT || 'D:\\记忆体';
const binary = process.env.MEMORY_TEST_CORE_BINARY || path.join(project, 'target', 'debug', 'autonomous_node.exe');
const output = process.env.MEMORY_SMOKE_OUTPUT_DIR || path.join(desktop, 'output', 'assistant-runtime-20261011', 'acceptance');
const desktopExecutable = process.env.MEMORY_TEST_DESKTOP_EXE || null;
const reply = (res, content, calls) => { if(res.destroyed)return;res.writeHead(200, {'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content,...(calls?{tool_calls:calls}:{})}}],usage:{total_tokens:80}})); };
const call = (name,args) => ({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'pisces-task-runtime-'));
  const files = path.join(root,'files');await fs.mkdir(files);
  const sourceNames=['项目说明.txt','客户要求.txt','风险记录.txt','销售数据.csv'];
  const sourceText=['本周完成资料整理和销售汇总。','提交日期：周四。客户要求数字可核对。','风险：存在退款，报告需注明统计口径。','地区,销量,销售额\n华东,12,1200\n华南,8,800\n华东,5,750\n华北,10,900\n'];
  for(let i=0;i<sourceNames.length;i++)await fs.writeFile(path.join(files,sourceNames[i]),sourceText[i]);
  const basis=path.join(files,'汇总依据.json'),report=path.join(files,'周报.md');
  const portFinder=net.createServer();await new Promise(r=>portFinder.listen(0,'127.0.0.1',r));const port=portFinder.address().port;await new Promise(r=>portFinder.close(r));
  const token='isolated-'+randomUUID(),settings={coreUrl:'http://127.0.0.1:'+port};
  let owner,ownerLog='',phase='before',active='',requests=0,holdReached=false;
  const getText = body => body.messages.map(item=>typeof item.content==='string'?item.content:JSON.stringify(item.content)).join('\n');
  const model=http.createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));requests++;
      const system=body.messages[0].content;
      if(system.includes('理解模块')){
        const input=JSON.parse(body.messages[1].content);active=input.request;
        assert.equal(input.explicit_task,true,'持久任务必须强制任务理解');
        const amount=active.includes('销售额');
        return reply(res,JSON.stringify({type:'task',goal:active,kind:'写文档',presentation:'document',deliverable:report,done_criteria:[{check:'file_contains',target:report,value:'提交日期：周四'},{check:'file_contains',target:report,value:amount?'销售额合计：3650':'销量合计：35'}],apps:[],params:{},steps:'few',missing_info:null,assumptions:[],work_relation:{kind:'new'},user_updates:[]}));
      }
      if(system.includes('规划模块'))return reply(res,JSON.stringify({steps:[
        {id:'read-inputs',do:'读取三份说明和销售CSV，生成汇总依据JSON',expect:'四份来源和数字已写入依据',depends_on:[],criteria:[{check:'file_contains',target:basis,value:'"quantity":35'}],outputs:[basis]},
        {id:'write-report',do:'读取已验收汇总依据，按本轮要求写周四周报',expect:'周报保存并符合本轮统计口径',depends_on:['read-inputs'],criteria:[{check:'file_contains',target:report,value:active.includes('销售额')?'销售额合计：3650':'销量合计：35'}],outputs:[report]},
        {id:'readback',do:'重新读回周报并核对日期和数字',expect:'实际文件已重新读取核对',depends_on:['write-report'],criteria:[{check:'tool_succeeded',target:'read_text',value:'提交日期：周四'}],outputs:[]}
      ]}));
      if(system.includes('核对模块'))return reply(res,JSON.stringify({passed:false,unmet:['测试要求机械文件证据'],reason:'不凭模型自述通过'}));
      const text=getText(body), toolMessages=body.messages.filter(item=>item.role==='tool');
      const initialCalls=body.messages.filter(item=>item.role==='assistant'&&item.tool_calls).flatMap(item=>item.tool_calls);
      const invoked=name=>initialCalls.some(item=>item.function.name===name);
      if(text.includes('当前只执行节点 read-inputs')){
        if(!invoked('read_text'))return reply(res,'',sourceNames.map(name=>call('read_text',{path:path.join(files,name)})));
        if(!invoked('write_text')){
          assert.equal(toolMessages.filter(item=>JSON.parse(item.content).ok).length,4,'四份来源必须真的读取');
          return reply(res,'',[call('write_text',{path:basis,content:JSON.stringify({sources:sourceNames,quantity:35,revenue:3650,regions:{华东:{quantity:17,revenue:1950},华南:{quantity:8,revenue:800},华北:{quantity:10,revenue:900}},due:'周四',risk:'存在退款，注明统计口径'}),overwrite:true})]);
        }
        return reply(res,'四份资料已读取，汇总依据已保存。');
      }
      if(text.includes('当前只执行节点 write-report')){
        if(!invoked('read_text'))return reply(res,'',[call('read_text',{path:basis})]);
        if(!invoked('write_text')){
          if(phase==='before'&&active.includes('重启恢复验证')){holdReached=true;await fs.writeFile(path.join(files,'task-model-held'),'actual model request is waiting');await pause(30000);}
          const amount=active.includes('销售额');
          const content='# 项目周报\n\n提交日期：周四\n\n'+(amount?'销售额合计：3650\n\n|地区|销售额|\n|---|---:|\n|华东|1950|\n|华南|800|\n|华北|900|':'销量合计：35')+'\n\n风险：存在退款，统计按原始销售表口径。\n';
          return reply(res,'',[call('write_text',{path:report,content,overwrite:true})]);
        }
        return reply(res,'周报已保存，数字来自已验收依据。');
      }
      if(text.includes('当前只执行节点 readback')){
        if(!invoked('read_text'))return reply(res,'',[call('read_text',{path:report})]);
        return reply(res,'读回检查通过：周四期限和本轮数字已确认。');
      }
      throw new Error('脚本模型收到非预期阶段：'+system.slice(0,70));
    } catch(error) { if(!res.destroyed){res.writeHead(500);res.end(error.stack);} }
  });
  await new Promise(r=>model.listen(0,'127.0.0.1',r));
  async function start(){
    owner=spawn(binary,['--state',path.join(root,'body_state.json'),'--event-store',path.join(root,'events'),'--checkpoint-path',path.join(root,'checkpoint.json'),'--health-bind','127.0.0.1:'+port,'--local-only','--forever','--cycle-sleep-ms','1000'],{cwd:project,windowsHide:true,env:{...process.env,MEMORY_LOCAL_ONLY:'true',AUTONOMOUS_NODE_STRICT_OFFLINE:'true',MEMORY_CHAT_PREFER_ENV:'true',MEMORY_CHAT_API_MODE:'local_only',MEMORY_CHAT_CONFIG_PATH:'',MEMORY_CHAT_API_KEY:'',OPENAI_API_KEY:'',MEMORY_AUTONOMOUS_LEARNING_ENABLED:'false',MEMORY_AUTONOMOUS_RESEARCH_ENABLED:'false',AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED:'false',MEMORY_API_RBAC:'true',MEMORY_API_OPERATOR_TOKEN:token,MEMORY_API_ADMIN_TOKEN:'',MEMORY_API_VIEWER_TOKEN:''}});
    owner.stdout.on('data',d=>ownerLog=(ownerLog+d).slice(-50000));owner.stderr.on('data',d=>ownerLog=(ownerLog+d).slice(-50000));
    for(let i=0;i<100;i++){if(owner.exitCode!==null)throw new Error(ownerLog.slice(-2000));try{if((await coreRequest(settings,token,'/api/v1/assistant/state')).continuity?.schema===1)return;}catch{}await pause(150);}throw new Error('核心启动超时');
  }
  async function stop(){if(owner?.exitCode===null){const exited=new Promise(r=>owner.once('exit',r));owner.kill();await exited;}}
  async function launch(next){phase=next;const child=spawn(desktopExecutable || path.join(desktop,'node_modules/electron/dist/electron.exe'),desktopExecutable ? ['--task-smoke'] : ['.','--task-smoke'],{cwd:desktop,windowsHide:true,env:{...process.env,PISCES_TEST_USER_DATA:path.join(root,'profile'),PISCES_TEST_TASK_ROOT:files,PISCES_TEST_TASK_PHASE:phase,MEMORY_TEST_CORE_URL:settings.coreUrl,MEMORY_TEST_CORE_TOKEN:token,MEMORY_TEST_AI_URL:'http://127.0.0.1:'+model.address().port+'/v1',MEMORY_SMOKE_OUTPUT_DIR:output}});let logs='';child.stdout.on('data',d=>logs=(logs+d).slice(-30000));child.stderr.on('data',d=>logs=(logs+d).slice(-30000));const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error(logs.slice(-7000)));},90000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,phase+'-console.log'),logs);assert.equal(code,0,logs.slice(-7000));assert.match(logs,/"taskSmoke":"passed"/);}
  try {
    await start();await launch('before');assert.equal(holdReached,true);await stop();await start();await launch('after');
    const state=await coreRequest(settings,token,'/api/v1/assistant/state');assert.equal(state.works.filter(w=>w.cognition).length,1,'追加与恢复不得新建核心事情');
    const work=state.works.find(w=>w.cognition);assert.equal(work.status,'checked_by_desktop');assert.ok(work.cognition.plan.every(n=>n.verification?.passed&&n.runtime_status==='done'));
    const final=await fs.readFile(report,'utf8');assert.match(final,/销售额合计：3650/);assert.match(final,/华东\|1950/);assert.doesNotMatch(final,/销量合计：35/);
    const result={passed:true,realCanonicalCore:true,realElectronIPC:true,persistentTaskCreatedFromUI:true,nodeDependenciesVerified:true,actualFilesReadAndChecked:true,revisionUsesSameWork:true,interruptedRunRecovered:true,automaticStartupRecovery:true,scriptedLocalModel:true,noPaidRequests:true,requests,workId:work.id,isolatedRuntime:root,desktopExecutable,coreBinary:binary};await fs.writeFile(path.join(output,'task-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  } finally {await stop();model.closeAllConnections();await new Promise(r=>model.close(r));await fs.writeFile(path.join(root,'core.log'),ownerLog);}
})().catch(error=>{console.error(error);process.exitCode=1;});
