// Real native WPF fixture + real canonical core + deterministic local teacher.
// The fixture's own event handlers independently record actual GUI changes.
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const {coreRequest}=require('../electron/core-client.cjs');
const {runAssistant}=require('../electron/assistant-worker.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'memory-native-control-'));
  const fixtureRoot=path.join(os.tmpdir(),'MemoryAssistantNativeFixture');await fs.mkdir(fixtureRoot,{recursive:true});
  await fs.copyFile(path.join(__dirname,'../tests/fixtures/AssistantControlFixture.cs'),path.join(fixtureRoot,'Fixture.cs'));
  const framework='C:/Windows/Microsoft.NET/Framework64/v4.0.30319';
  const compile=spawnSync(path.join(framework,'csc.exe'),['/nologo','/target:winexe','/out:AssistantControlFixture.exe',...['PresentationFramework','PresentationCore','WindowsBase'].map(n=>'/reference:'+path.join(framework,'WPF',n+'.dll')),'/reference:'+path.join(framework,'System.Xaml.dll'),'Fixture.cs'],{cwd:fixtureRoot,windowsHide:true});
  if(compile.status!==0)throw new Error('fixture compile: '+compile.stdout+' '+compile.stderr);
  const finder=net.createServer();await new Promise(r=>finder.listen(0,'127.0.0.1',r));const port=finder.address().port;await new Promise(r=>finder.close(r));
  const token='native-test-'+randomUUID(),settings={coreUrl:'http://127.0.0.1:'+port};
  const binary=process.env.MEMORY_TEST_CORE_BINARY||'D:/记忆体/target/release/autonomous_node.exe';
  const child=spawn(binary,['--state',path.join(root,'body_state.json'),'--event-store',path.join(root,'event_store'),'--checkpoint-path',path.join(root,'checkpoint.json'),'--health-bind','127.0.0.1:'+port,'--local-only','--forever','--cycle-sleep-ms','50'],{cwd:'D:/记忆体',windowsHide:true,env:{...process.env,MEMORY_LOCAL_ONLY:'true',AUTONOMOUS_NODE_STRICT_OFFLINE:'true',MEMORY_CHAT_PREFER_ENV:'true',MEMORY_CHAT_API_MODE:'local_only',MEMORY_CHAT_CONFIG_PATH:'',MEMORY_CHAT_API_KEY:'',OPENAI_API_KEY:'',MEMORY_AUTONOMOUS_LEARNING_ENABLED:'false',MEMORY_AUTONOMOUS_RESEARCH_ENABLED:'false',AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED:'false',MEMORY_API_RBAC:'true',MEMORY_API_OPERATOR_TOKEN:token,MEMORY_API_ADMIN_TOKEN:'',MEMORY_API_VIEWER_TOKEN:''}});
  let log='',fixture,server;
  child.stdout.on('data',d=>log=(log+d).slice(-16000));child.stderr.on('data',d=>log=(log+d).slice(-16000));
  const api=body=>coreRequest(settings,token,'/api/v1/assistant/request',{body,signal:AbortSignal.timeout(90000)});
  try {
    let ready=false;for(let i=0;i<120;i++){try{await api({action:'profile'});ready=true;break;}catch{await delay(1000);}}
    assert.ok(ready,log);
    await assert.rejects(api({action:'settle_desktop',work_id:randomUUID(),request_id:randomUUID(),output:{verified:true},verified:true,error:null}),/400/);
    fixture=spawn(path.join(fixtureRoot,'AssistantControlFixture.exe'),[path.join(root,'gui-state.txt')],{cwd:fixtureRoot,windowsHide:true});
    fixture.on('error',e=>{throw e});await delay(1800);
    await fs.writeFile(path.join(root,'fixture-ready.json'),JSON.stringify({root,pid:fixture.pid,coreUrl:settings.coreUrl}));
    console.log(JSON.stringify({fixtureReady:true,root,pid:fixture.pid}));
    if(process.argv.includes('--gate')){for(let i=0;i<120;i++){try{await fs.access(path.join(root,'continue'));break;}catch{await delay(500);}}}
    const selected=await api({action:'select_desktop'});assert.equal(selected.target.process.toLowerCase(),'assistantcontrolfixture');
    const id=randomUUID();
    await assert.rejects(api({action:'create_work',id:randomUUID(),session:randomUUID(),goal:'unauthorized',files:[],multi_agent:false,desktop_target:selected.target.id,desktop_consent:false,teacher_destination:'local-test'}),/409/);
    let calls=0,failedFeedback=false,actualFeedback=false;
    server=http.createServer(async(req,res)=>{
      try {
        const parts=[];for await(const b of req)parts.push(b);const body=JSON.parse(Buffer.concat(parts));calls++;
        assert.ok(body.tools.some(t => t.function.name === 'desktop_action'));assert.equal(body.parallel_tool_calls,false);
        const prior=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
        const last=prior.at(-1)?.output;
        let tool;
        if([1,3,5].includes(calls)){
          if(calls===3){failedFeedback=prior.at(-1)?.receipt?.status==='failed';assert.ok(failedFeedback);assert.match(JSON.stringify(prior.at(-1)),/missing_or_ambiguous/);}
          if(calls===5){assert.equal(last.verified,true);actualFeedback=JSON.stringify(last.after).includes('AI 学习 real UI：空格 & 标点');assert.ok(actualFeedback);}
          tool={name:'observe_desktop',arguments:'{}'};
        }else if([2,4,6].includes(calls)){
          assert.ok(last.snapshot_id);const input=last.elements.find(e=>e.label==='Test Input');const button=last.elements.find(e=>e.label==='Mark Done');assert.ok(input&&button,JSON.stringify(last));
          const proposal={snapshot_id:last.snapshot_id,operation:calls===6?'click':'type_text',element_id:calls===2?'fabricated-element':calls===4?input.id:button.id,
            ...(calls!==6?{text:'AI 学习 real UI：空格 & 标点'}:{}),expect:{kind:'state_fact_contains',key:calls===6?'uia.text.statefield':'uia.text.inputfield',value:calls===6?'Completed: AI 学习 real UI：空格 & 标点':'AI 学习 real UI：空格 & 标点'}};
          tool={name:'desktop_action',arguments:JSON.stringify(proposal)};
        }
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:tool?{role:'assistant',content:'',tool_calls:[{id:'native-'+calls,type:'function',function:tool}]}:{role:'assistant',content:'根据真实回执，已输入文本并点击测试按钮；其他能力尚未验证。'}}],usage:{total_tokens:20}}));
      }catch(error){res.writeHead(500);res.end(String(error.stack));}
    });await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const teacher='http://127.0.0.1:'+server.address().port;
    const {work}=await api({action:'create_work',id,session:randomUUID(),goal:'在专用测试窗口输入示例文本并点击 Mark Done',files:[],multi_agent:false,desktop_target:selected.target.id,desktop_consent:true,teacher_destination:teacher+' | deterministic-native-teacher'});
    const result=await runAssistant({settings:{...settings,endpoint:teacher,model:'deterministic-native-teacher'},apiKey:'',core:api,work,messages:[{role:'user',content:work.goal}],signal:AbortSignal.timeout(180000),emit:()=>{},progress:s=>console.log(JSON.stringify({operation:s.operation,phase:s.phase,status:s.receipt?.status,error:s.receipt?.error}))});
    const actual=await fs.readFile(path.join(root,'gui-state.txt'),'utf8');assert.equal(actual,'AI 学习 real UI：空格 & 标点\nCompleted: AI 学习 real UI：空格 & 标点');
    assert.equal(result.work.status,'actions_verified');assert.equal(calls,7);assert.ok(failedFeedback&&actualFeedback);
    assert.equal(result.work.receipts.filter(r=>r.operation==='desktop_action'&&r.status==='verified').length,2);
    const state=await api({action:'state'});assert.equal(state.works.length,1);
    const owner=JSON.parse(await fs.readFile(path.join(root,'unified_subject_aggregate_owner.json'),'utf8'));
    const routines=owner.canonical_subject.computer_use_routines.routines;assert.ok(routines.length >= 1, 'verified semantic click must reach canonical procedural memory');
    const report={passed:true,isolatedRuntime:root,binary,binary_sha256:require('node:crypto').createHash('sha256').update(await fs.readFile(binary)).digest('hex'),softwareMethodCandidates:routines.length,paidModelCalls:0,simulatedTeacherCalls:calls,realNativeInput:true,independentGuiEventLog:actual,realFailureFeedback:true,realPostStateFeedback:true,scopeConsentEnforced:true,forgedSettlementRejected:true,workStatus:result.work.status,receipts:result.work.receipts.map(r=>({operation:r.operation,status:r.status,error:r.error}))};
    await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(__dirname,'../桌面控制真实验收.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    if(process.argv.includes('--gate'))await delay(45000);
  } finally {
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    if(fixture&&!fixture.killed)fixture.kill();if(!child.killed)child.kill();
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1});
