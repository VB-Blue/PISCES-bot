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
const project = process.env.MEMORY_CORE_PROJECT || 'D:\\记忆体';
const binary = process.env.MEMORY_TEST_CORE_BINARY || path.join(project, 'target', 'debug', 'autonomous_node.exe');
const desktop = path.resolve(__dirname, '..');
const evidenceRoot = process.env.MEMORY_CONTINUITY_OUTPUT_ROOT || path.join(desktop,'output','localization-continuity');
const json = (res, content, tool_calls) => {res.writeHead(200, {'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content, ...(tool_calls?{tool_calls}:{})}}],usage:{total_tokens:80}}));};
const tool = (name,args) => [{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}];

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-continuity-'));
  const files = path.join(root, 'files');await fs.mkdir(files);
  const portFinder = net.createServer();await new Promise(resolve=>portFinder.listen(0,'127.0.0.1',resolve));const port=portFinder.address().port;await new Promise(resolve=>portFinder.close(resolve));
  const token='isolated-'+randomUUID(), settings={coreUrl:'http://127.0.0.1:'+port};
  let owner, ownerLog='', active='', stage=0, requests=0, resumedFromCore=false, preferenceFromCore=false;
  const model = http.createServer(async (req,res)=>{
    try {
      const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts));requests++;
      const system=body.messages[0].content;
      if(system.includes('理解模块')) {
        const input=JSON.parse(body.messages[1].content);active=input.request;stage=0;
        const existing=(input.persistent_work||[]).find(work=>work.goal.includes('周报'));
        const isTask=active.includes('周报');const revision=active.includes('周四')&&!active.includes('继续');const continuation=active.includes('继续');
        if(continuation)resumedFromCore=!!existing;
        const updates=active.includes('简短')?[{key:'reply.length',value:'简短',quote:'以后回答简短'}]:active.includes('改成详细')?[{key:'reply.length',value:'详细',quote:'以后改成详细回答'}]:[];
        return json(res,JSON.stringify({type:isTask?'task':'chat',goal:isTask?'写周报，'+(active.includes('周四')?'周四':'周五')+'提交':'回答偏好',kind:'写周报',deliverable:path.join(files,'report.txt'),done_criteria:isTask?[{check:'file_contains',target:path.join(files,'report.txt'),value:continuation?'销售额':revision?'周四':'周五'}]:[],apps:[],params:{},steps:'one',missing_info:null,assumptions:[],work_relation:existing?{kind:revision?'revise':'continue',work_id:existing.id}:{kind:'new'},user_updates:updates}));
      }
      if(system.includes('核对模块'))return json(res,JSON.stringify({passed:false,unmet:['未提供机械结果'],reason:'测试不允许凭模型自述完成'}));
      if(!active.includes('周报')) {
        if(active.includes('偏好是什么')) {preferenceFromCore=system.includes('详细')&&system.includes('confirmed');return json(res,preferenceFromCore?'你确认的偏好是详细回答。':'我不知道。');}
        return json(res,'已保留你的要求。');
      }
      const continuation=active.includes('继续'), content='周报：'+(active.includes('周四')?'周四':'周五')+'提交'+(continuation?'\n补充：销售额':'');
      if(stage++===0){if(continuation)await pause(400);return json(res,'',tool('write_text',{path:path.join(files,'report.txt'),content,overwrite:true}));}
      if(stage===2)return json(res,'',tool('read_text',{path:path.join(files,'report.txt')}));
      return json(res,'已写入并读回周报。');
    }catch(error){res.writeHead(500);res.end(error.message);}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  async function start() {
    owner=spawn(binary,['--state',path.join(root,'body_state.json'),'--event-store',path.join(root,'event_store'),'--checkpoint-path',path.join(root,'checkpoint.json'),'--health-bind','127.0.0.1:'+port,'--local-only','--forever','--cycle-sleep-ms','1000'],{cwd:project,windowsHide:true,env:{...process.env,MEMORY_LOCAL_ONLY:'true',AUTONOMOUS_NODE_STRICT_OFFLINE:'true',MEMORY_CHAT_PREFER_ENV:'true',MEMORY_CHAT_API_MODE:'local_only',MEMORY_CHAT_CONFIG_PATH:'',MEMORY_CHAT_API_KEY:'',OPENAI_API_KEY:'',MEMORY_AUTONOMOUS_LEARNING_ENABLED:'false',MEMORY_AUTONOMOUS_RESEARCH_ENABLED:'false',AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED:'false',MEMORY_API_RBAC:'true',MEMORY_API_OPERATOR_TOKEN:token,MEMORY_API_ADMIN_TOKEN:'',MEMORY_API_VIEWER_TOKEN:''}});
    owner.stdout.on('data',data=>{ownerLog=(ownerLog+data).slice(-50000);});owner.stderr.on('data',data=>{ownerLog=(ownerLog+data).slice(-50000);});
    for(let count=0;count<100;count++){if(owner.exitCode!==null)throw new Error('测试核心退出：'+ownerLog.slice(-2000));try{const state=await coreRequest(settings,token,'/api/v1/assistant/state');if(state.continuity?.schema===1)return;}catch{}await pause(150);}
    throw new Error('持续任务核心未就绪：'+ownerLog.slice(-2000));
  }
  async function stop(){if(owner&&owner.exitCode===null){const exit=new Promise(resolve=>owner.once('exit',resolve));owner.kill();await exit;}}
  async function check(phase) {
    const exe=process.env.MEMORY_TEST_DESKTOP_EXE||path.join(desktop,'node_modules','electron','dist','electron.exe');
    const child=spawn(exe,process.env.MEMORY_TEST_DESKTOP_EXE?['--continuity-smoke']:['.','--continuity-smoke'],{cwd:desktop,windowsHide:true,env:{...process.env,MEMORY_TEST_CONTINUITY_PHASE:phase,MEMORY_TEST_CONTINUITY_ROOT:files,MEMORY_TEST_CORE_URL:settings.coreUrl,MEMORY_TEST_CORE_TOKEN:token,MEMORY_TEST_AI_URL:'http://127.0.0.1:'+model.address().port+'/v1',MEMORY_SMOKE_OUTPUT_DIR:evidenceRoot}});
    let output='';child.stdout.on('data',data=>{output=(output+data).slice(-40000);});child.stderr.on('data',data=>{output=(output+data).slice(-40000);});
    const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(new Error('界面连续性验收超时：'+output.slice(-4000)));},60000);child.on('error',error=>{clearTimeout(timeout);reject(error);});child.on('exit',code=>{clearTimeout(timeout);resolve(code);});});
    assert.equal(code,0,output.slice(-6000));assert.ok(output.includes('"continuitySmoke":"passed"'),output.slice(-3000));
  }
  try {
    await start();await check('before');await stop();await start();await check('after');
    assert.equal(resumedFromCore,true);assert.equal(preferenceFromCore,true);
    const result={passed:true,realCanonicalOwner:true,realDesktopIPC:true,crossSessionCorrection:true,sameWorkAfterRestart:true,confirmedPreferenceAfterRestart:true,actualFileVerified:true,workDetail:true,observedReceiptPush:true,inlineTaskContinuation:true,draftEditsPreserved:true,binary,desktopExecutable:process.env.MEMORY_TEST_DESKTOP_EXE||null,requests,noPaidRequests:true,isolatedRuntime:root};
    await fs.mkdir(evidenceRoot,{recursive:true});await fs.writeFile(path.join(evidenceRoot,'continuity-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await stop();await new Promise(resolve=>model.close(resolve));await fs.writeFile(path.join(root,'test-console.log'),ownerLog);}
})().catch(error=>{console.error(error);process.exitCode=1;});
