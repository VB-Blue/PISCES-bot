const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
async function run(window, { appPath }) {
  const root = process.env.PISCES_TEST_TASK_ROOT, phase = process.env.PISCES_TEST_TASK_PHASE;
  const output = path.join(appPath, 'output', 'parallel'); await fs.mkdir(output, { recursive: true });
  const evaluate = code => window.webContents.executeJavaScript(code), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (read, label) => { for (let i=0;i<600;i++) { const value=await read(); if(value)return value; await pause(100); } throw Error('并行验收超时：'+label); };
  const shot = async name => fs.writeFile(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());
  const api = (name, value) => evaluate('window.memoryDesktop.'+name+'('+(value===undefined?'':JSON.stringify(value))+')');
  await wait(()=>evaluate('!!window.memoryDesktop?.runtimeStatus'),'界面接口');
  if (phase==='before') {
    await api('saveSettings',{endpoint:process.env.MEMORY_TEST_AI_URL,model:'facts',apiKey:'parallel-test-key',coreUrl:process.env.MEMORY_TEST_CORE_URL,coreToken:process.env.MEMORY_TEST_CORE_TOKEN});
    const prefs=await api('prefs');await api('savePrefs',{...prefs,roots:[root],autoLearn:false});
    await api('saveProviders',{defaultId:'facts',failover:false,routes:{coder:'calc',researcher:'facts',writer:'report',reviewer:'report'},profiles:[
      {id:'calc',name:'数据计算',endpoint:process.env.MEMORY_TEST_AI_URL,model:'calc',apiKey:'parallel-test-key',strengths:['code'],maxConcurrent:2},
      {id:'facts',name:'资料整理',endpoint:process.env.MEMORY_TEST_AI_URL,model:'facts',apiKey:'parallel-test-key',strengths:['fast'],maxConcurrent:2},
      {id:'report',name:'报告与复核',endpoint:process.env.MEMORY_TEST_AI_URL,model:'report',apiKey:'parallel-test-key',strengths:['strong'],maxConcurrent:2},
    ]});
    await wait(()=>evaluate('!!document.querySelector(".new-work-form textarea")'),'任务创建');
    const goal='读取 '+root+' 中的 sales.csv 和 stock.csv，分别计算销售与库存合计，生成双资料销售周报并保存 combined.md。';
    await evaluate(`(()=>{const box=document.querySelector('.new-work-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,${JSON.stringify(goal)});box.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.new-work-form button[type=submit]').click();})()`);
  }
  const ids=phase==='after'?JSON.parse(await fs.readFile(path.join(root,'ids.json'),'utf8')):null;
  const job=await wait(async()=>{const jobs=await api('jobs');return jobs.find(job=>(!ids||job.id===ids.jobId)&&job.plan?.filter(node=>['sales','stock'].includes(node.id)&&node.runtime_status==='doing'&&node.evidence?.read_proofs?.length).length===2)&&await fs.stat(path.join(root,phase==='before'?'both-1':'both-2')).catch(()=>null)?jobs.find(job=>(!ids||job.id===ids.jobId)&&job.plan?.filter(node=>node.runtime_status==='doing').length===2):null;},'两个独立来源正在处理');
  const state=await api('runtimeStatus');
  const leases=job.plan.filter(node=>['sales','stock'].includes(node.id)).map(node=>node.execution_state.lease_id);
  assert.equal(new Set(leases).size,2);assert.equal(job.plan.find(node=>node.id==='compose').runtime_status,'pending');
  assert.equal(await fs.stat(path.join(root,'sales.json')).then(()=>true,()=>false),false);assert.equal(await fs.stat(path.join(root,'stock.json')).then(()=>true,()=>false),false);
  await evaluate(`(()=>{[...document.querySelectorAll('nav button')].find(button=>button.textContent.trim()==='一起在做').click();})()`);
  await wait(()=>evaluate('!!document.querySelector(".scene-list-row")'),'工作列表');
  await evaluate(`document.querySelector(${JSON.stringify('[data-work-id="job:'+job.id+'"]')})?.click()`);
  await wait(()=>evaluate('document.querySelectorAll(".work-node-allocation").length>=2&&document.querySelector(".work-run-summary")?.textContent.includes("执行分工")'),'实际分工显示');
  await wait(()=>evaluate('!document.querySelector(".work-connection-state")'),'实际执行时连接状态更新');
  await shot(phase==='before'?'parallel-light':'parallel-recovered');
  if (phase==='before') {
    await evaluate('document.querySelector(".theme-toggle").click()'); await pause(200); await shot('parallel-dark'); window.setSize(1000,700);await pause(200);await shot('parallel-narrow');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true);
    await fs.writeFile(path.join(root,'ids.json'),JSON.stringify({jobId:job.id,workId:job.workId,hostPid:state.pid,leases}));
  } else {
    assert.notEqual(state.pid,ids.hostPid);assert.equal(job.workId,ids.workId);assert.ok(leases.every(id=>!ids.leases.includes(id)));
    assert.ok(job.plan.filter(node=>['sales','stock'].includes(node.id)).every(node=>node.evidence.recovery?.kind==='read_only_resume'));
    await evaluate(`(()=>{window.stopParallelApprovals=window.memoryDesktop.onJob(job=>{if(job.id===${JSON.stringify(job.id)}&&job.status==='waiting'&&job.approval)window.memoryDesktop.jobAction({id:job.id,action:'approve',decision:'once',approvalId:job.approval.id});});return true;})()`);
    await api('instructJob',{id:job.id,text:'按翻倍口径重新计算销售和库存合计，继续同一份报告。'});
    const done=await wait(async()=>{const jobs=await api('jobs');return jobs.find(item=>item.id===job.id&&item.status==='done');},'新要求完成');
    assert.equal(done.workId,ids.workId);assert.ok(done.workRevision>job.workRevision);assert.ok(done.plan.every(node=>node.verification?.passed));
    assert.ok(done.plan.filter(node=>['sales','stock'].includes(node.id)).every(node=>!leases.includes(node.execution_state.lease_id)&&!ids.leases.includes(node.execution_state.lease_id)));
    assert.match(await fs.readFile(path.join(root,'combined.md'),'utf8'),/销售合计：70[\s\S]*库存合计：40/);
    await wait(()=>evaluate('document.querySelector(".task-document-paper")?.textContent.includes("销售合计：70")'),'交付正文');await shot('parallel-delivery');
    await evaluate(`(()=>{[...document.querySelectorAll('.work-run-plan button')].find(button=>button.textContent.includes('查看完整计划')).click();})()`);await pause(100);await shot('parallel-inspector');
    await fs.writeFile(path.join(output,'completed.json'),JSON.stringify(done,null,2));
    await evaluate('(()=>{window.stopParallelApprovals();return true;})()');
  }
  return {parallelSmoke:'passed',phase,hostPid:state.pid,jobId:job.id,workId:job.workId,leases,noPaidRequests:true};
}
module.exports={run};
