const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function run(window,{appPath,userData}){
  const execute=code=>window.webContents.executeJavaScript(code);
  const wait=async(fn,label)=>{for(let i=0;i<300;i++){const value=await fn();if(value)return value;await pause(100);}throw new Error('任务验收等待超时：'+label+' | '+JSON.stringify(await execute('window.memoryDesktop.jobs()')));};
  await wait(()=>execute('!!window.memoryDesktop'),'IPC');
  const root=process.env.PISCES_TEST_TASK_ROOT,phase=process.env.PISCES_TEST_TASK_PHASE;
  await execute(`window.memoryDesktop.saveSettings(${JSON.stringify({endpoint:process.env.MEMORY_TEST_AI_URL,model:'isolated-task-model',coreUrl:process.env.MEMORY_TEST_CORE_URL,coreToken:process.env.MEMORY_TEST_CORE_TOKEN})})`);
  await execute(`window.memoryDesktop.prefs().then(value=>window.memoryDesktop.savePrefs({...value,roots:[${JSON.stringify(root)}],autoLearn:false}))`);
  // Approval fixtures grant only individual writes under this isolated temp directory.
  await execute(`(() => {window.memoryDesktop.onJob(job=>{if(job.status==='waiting'&&job.approval)window.memoryDesktop.jobAction({id:job.id,action:'approve',decision:'once',approvalId:job.approval.id});});})()`);
  const setInput=async(selector,text)=>execute(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw Error('missing input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const output=path.join(appPath,'output','task-runtime');await fs.mkdir(output,{recursive:true});
  const shot=async name=>fs.writeFile(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());
  const deliveryVisible=async value=>wait(()=>execute(`(() => {
    if(document.querySelector('.work-load-state.loading'))return false;
    const canvas=document.querySelector('.work-canvas');
    const proof=[...document.querySelectorAll('.task-document-paper .markdown-body p')].find(item=>item.textContent.includes(${JSON.stringify(value)}));
    if(!canvas||!proof)return false;
    const viewport=canvas.getBoundingClientRect(),bounds=proof.getBoundingClientRect();
    return bounds.top>=viewport.top&&bounds.bottom<=viewport.bottom;
  })()`),'交付正文的关键数字在首屏可见');
  let job;
  if(phase==='before'){
    await wait(()=>execute('!!document.querySelector(".new-work-form textarea")'),'创建表单');
    await setInput('.new-work-form textarea','读取 '+root+' 中三份说明和销售数据.csv，写一份周四提交的周报，按销量统计，保留来源和风险。');
    await execute('document.querySelector(".new-work-form button[type=submit]").click()');
    job=await wait(async()=>{const jobs=await execute('window.memoryDesktop.jobs()');return jobs[0]?.status==='done'?jobs[0]:null;},'第一轮完成');
    assert.equal(await execute('document.querySelector(".app").dataset.view'),'work');assert.ok(job.workId);assert.equal(job.plan.length,3);assert.ok(job.plan.every(n=>n.verification?.passed));
    assert.match(await fs.readFile(path.join(root,'周报.md'),'utf8'),/销量合计：35/);await deliveryVisible('销量合计：35');await shot('first-delivery');
    await execute(`window.memoryDesktop.instructJob(${JSON.stringify({id:job.id,text:'改为销售额统计，并加入按地区的销售额；继续同一份周报。'})})`);
    job=await wait(async()=>{const j=(await execute('window.memoryDesktop.jobs()'))[0];return j?.status==='done'&&j.runs===2?j:null;},'修改要求验收');
    assert.equal(job.runHistory.filter(r=>r.status==='done').length,2);await deliveryVisible('销售额合计：3650');await shot('revised-delivery');
    await fs.writeFile(path.join(root,'test-job.json'),JSON.stringify({id:job.id,workId:job.workId,basisWrites:job.runs}));
    await execute(`window.memoryDesktop.instructJob(${JSON.stringify({id:job.id,text:'执行重启恢复验证，再核对原始资料和地区销售额，保留同一任务。'})})`);
    job=await wait(async()=>{const j=(await execute('window.memoryDesktop.jobs()'))[0];return j?.runs===3&&j.plan.some(n=>n.id==='read-inputs'&&n.verification?.passed)&&j.plan.some(n=>n.id==='write-report'&&n.runtime_status==='doing')?j:null;},'执行中保存检查点');
    // Confirm the real pending request reached its interruption gate before closing the interface.
    await wait(()=>fs.stat(path.join(root,'task-model-held')).then(()=>true,()=>false),'真实模型请求已经等待中断');await shot('interrupted-checkpoint');
    assert.equal(job.status,'running');assert.ok(job.checkpointAt);
  }else{
    const expected=JSON.parse(await fs.readFile(path.join(root,'test-job.json'),'utf8'));
    job=(await execute('window.memoryDesktop.jobs()')).find(j=>j.id===expected.id);assert.ok(['queued','running','done'].includes(job.status));assert.equal(job.workId,expected.workId);
    await execute(`(()=>{[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()==='一起在做')?.click();})()`);
    await wait(()=>execute('!!document.querySelector(".scene-list-row")'),'任务载入');
    await execute(`(()=>{document.querySelector('.scene-list-row')?.click();})()`);
    await shot('restart-review');
    job=await wait(async()=>{const j=(await execute('window.memoryDesktop.jobs()')).find(j=>j.id===expected.id);return j?.status==='done'?j:null;},'检查后恢复完成');
    assert.equal(job.workId,expected.workId);assert.equal(job.runs,4);assert.ok(job.plan.find(n=>n.id==='read-inputs').verification.revalidated,'已验证前置节点应重新读取后复用');assert.equal(await execute('document.querySelector(".app").dataset.view'),'work');
    assert.ok(job.log.some(item=>item.text.startsWith('开始恢复检查：')),'应用重启自主检查恢复，不依赖人工resume调用');
    await deliveryVisible('销售额合计：3650');await shot('recovered-delivery');
    const core=await execute(`window.memoryDesktop.workDetail(${JSON.stringify(job.workId)})`);assert.ok(core.receipts.filter(r=>r.operation==='read_text'&&r.status==='observed_success').length>=8);
    // Path text alone cannot authorize opening another file.
    const receipt=core.receipts.find(r=>r.operation==='write_text'&&r.status==='observed_success');
    const rejected=await execute(`window.memoryDesktop.openWorkFile(${JSON.stringify({workId:job.workId,receiptId:receipt.id,path:path.join(root,'other.md')})}).then(()=>false,()=>true)`);assert.equal(rejected,true);
  }
  await fs.writeFile(path.join(output,phase+'-job.json'),JSON.stringify(job,null,2));
  return {taskSmoke:'passed',phase,realIPC:true,scriptedModel:true,noPaidRequests:true};
}
module.exports={run};
