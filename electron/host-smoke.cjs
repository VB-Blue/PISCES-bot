const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
async function run(window, { appPath }) {
  const evaluate = code => window.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (read, label) => { for (let i = 0; i < 400; i++) { const value = await read(); if (value) return value; await pause(100); } throw new Error('独立宿主验收超时：' + label); };
  const root = process.env.PISCES_TEST_TASK_ROOT, phase = process.env.PISCES_TEST_TASK_PHASE;
  const output = path.join(appPath, 'output', 'host-runtime'); await fs.mkdir(output, { recursive: true });
  const shot = async name => fs.writeFile(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG());
  await wait(() => evaluate('!!window.memoryDesktop?.runtimeStatus'), '界面接口');
  await evaluate(`window.memoryDesktop.saveSettings(${JSON.stringify({ endpoint: process.env.MEMORY_TEST_AI_URL, model: 'isolated-host-model', apiKey: 'host-test-not-real-secret', coreUrl: process.env.MEMORY_TEST_CORE_URL, coreToken: process.env.MEMORY_TEST_CORE_TOKEN })})`);
  await evaluate(`window.memoryDesktop.prefs().then(p=>window.memoryDesktop.savePrefs({...p,roots:[${JSON.stringify(root)}],autoLearn:false}))`);
  const subscribe = await evaluate(`(() => {window.hostApprovalStop=window.memoryDesktop.onJob(job=>{if(job.goal.includes('第一份')&&job.status==='waiting'&&job.approval)window.memoryDesktop.jobAction({id:job.id,action:'approve',decision:'once',approvalId:job.approval.id});});return true;})()`);
  assert.equal(subscribe, true);
  let status = await evaluate('window.memoryDesktop.runtimeStatus()'); assert.equal(status.mode, 'independent'); assert.notEqual(status.pid, process.pid);
  if (phase === 'before') {
    await wait(() => evaluate('!!document.querySelector(".new-work-form textarea")'), '任务表单');
    await evaluate(`(() => {const box=document.querySelector('.new-work-form textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,${JSON.stringify('读取 ' + root + ' 中销售数据.csv，生成第一份销售周报，按销量统计并保存。')});box.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate('document.querySelector(".new-work-form button[type=submit]").click()');
    const first = await wait(async () => { const jobs=await evaluate('window.memoryDesktop.jobs()'); return jobs.find(job=>job.goal.includes('第一份')&&job.plan.find(node=>node.id==='write-report'&&node.runtime_status==='doing')) && await fs.stat(path.join(root,'gate-first')).catch(()=>null) ? jobs.find(job=>job.goal.includes('第一份')) : null; }, '已写入报告后保持模型请求');
    assert.match(await fs.readFile(path.join(root, '周报.md'), 'utf8'), /销量合计：35/);
    const second = await evaluate(`window.memoryDesktop.createJob(${JSON.stringify({ title: '第二份报告等待确认', goal: '保存第二份报告，需要确认后才能写入。', runAt: Date.now()+2500 })})`);
    await fs.writeFile(path.join(root,'host-test-ids.json'), JSON.stringify({ first:first.id, workId:first.workId, second:second.id, hostPid:status.pid }));
    await shot('before-ui-exit'); await fs.writeFile(path.join(output,'before.json'),JSON.stringify({status,first,second},null,2));
  } else {
    const ids=JSON.parse(await fs.readFile(path.join(root,'host-test-ids.json'),'utf8'));
    await evaluate(`(()=>{[...document.querySelectorAll('nav button')].find(b=>b.textContent.trim()==='一起在做')?.click();})()`);
    await wait(()=>evaluate('!!document.querySelector(".scene-list-row")'),'工作列表');
    if (phase==='controls') {
      const scheduled = await evaluate(`window.memoryDesktop.createJob(${JSON.stringify({ title: '停止后台保持暂停', goal: '保存第三份报告，停止后台后保持暂停。', runAt: Date.now()+60000 })})`);
      await wait(() => evaluate('!!document.querySelector(".runtime-menu")'), '后台控制入口');
      await evaluate('document.querySelector(".runtime-menu").open=true'); await shot('runtime-controls-light');
      await evaluate(`document.querySelector('.theme-toggle').click()`); await wait(() => evaluate('document.documentElement.dataset.theme==="dark"'), '深色控制'); await shot('runtime-controls-dark');
      window.setSize(1000, 700); await pause(300); await shot('runtime-controls-narrow');
      assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'), true, '后台菜单不能造成横向溢出');
      await evaluate(`(()=>{[...document.querySelectorAll('.runtime-menu button')].find(b=>b.textContent.trim()==='停止后台执行').click();})()`);
      await wait(async () => { const value = await evaluate('window.memoryDesktop.runtimeStatus()'); return value.stopped && !value.online; }, '后台已经退出');
      await wait(() => evaluate('document.querySelector(".runtime-status")?.textContent.includes("后台执行已停止")'), '界面显示真实停止状态');
      const saved=JSON.parse(await fs.readFile(path.join(process.env.PISCES_TEST_USER_DATA,'jobs','jobs.json'),'utf8')).find(j=>j.id===scheduled.id); assert.equal(saved.status,'paused');
      assert.equal(await evaluate('window.memoryDesktop.jobs().then(()=>false,()=>true)'),true,'停止后不能靠读取状态偷偷重启');
      await evaluate('document.querySelector(".runtime-menu").open=true'); await shot('runtime-stopped');
      await evaluate(`(()=>{[...document.querySelectorAll('.runtime-menu button')].find(b=>b.textContent.trim()==='启动后台执行').click();})()`);
      status=await wait(async()=>{const value=await evaluate('window.memoryDesktop.runtimeStatus()');return value.online&&value.ready?value:null;},'重新启动后台');
      assert.equal((await evaluate('window.memoryDesktop.jobs()')).find(j=>j.id===scheduled.id).status,'paused','主动暂停的任务不能在后台重启后自动开始');
      await wait(() => evaluate('document.querySelector(".runtime-status")?.textContent.includes("后台执行在线")'), '显示重新连接'); await shot('runtime-restarted');
      await fs.writeFile(path.join(output,'controls.json'),JSON.stringify({status,pausedJob:scheduled.id},null,2));
    } else if (phase==='after') {
      assert.equal(status.pid,ids.hostPid,'重开界面必须连接原执行者');
      const second=await wait(async()=>{const j=(await evaluate('window.memoryDesktop.jobs()')).find(j=>j.id===ids.second);return j?.status==='waiting'?j:null;},'离开后产生的确认');
      assert.equal(await fs.stat(path.join(root,'第二份.md')).then(()=>true,()=>false),false);
      await evaluate(`document.querySelector(${JSON.stringify('[data-work-id="job:'+ids.second+'"]')})?.click()`);
      await wait(()=>evaluate('!!document.querySelector(".work-run-summary .job-approval")'),'任务内确认'); await shot('approval-after-reopen');
      const stale=await evaluate(`window.memoryDesktop.jobAction(${JSON.stringify({id:ids.second,action:'approve',decision:'once',approvalId:'expired-approval'})}).then(()=>false,()=>true)`); assert.equal(stale,true);
      await evaluate(`(()=>{[...document.querySelectorAll('.work-run-summary .job-approval button')].find(b=>b.textContent.trim()==='允许这一次').click();})()`);
      await wait(async()=>{const j=(await evaluate('window.memoryDesktop.jobs()')).find(j=>j.id===ids.second);return j?.status==='done';},'确认后交付');
      assert.match(await fs.readFile(path.join(root,'第二份.md'),'utf8'),/确认后写入/);
      await evaluate(`window.memoryDesktop.instructJob(${JSON.stringify({id:ids.first,text:'继续第一份报告，执行资料变化恢复验证；保持销量口径。'})})`);
      await wait(async()=>{const j=(await evaluate('window.memoryDesktop.jobs()')).find(j=>j.id===ids.first);return j?.plan.find(n=>n.id==='readback'&&n.runtime_status==='doing'&&n.evidence?.read_proofs?.length)&&await fs.stat(path.join(root,'gate-source')).catch(()=>null);},'保存真实读回证明后保持请求');
      await shot('before-host-interruption');
    } else {
      assert.notEqual(status.pid,ids.hostPid,'执行者被终止后应创建新的单一宿主');
      const changed=await wait(async()=>{const j=(await evaluate('window.memoryDesktop.jobs()')).find(j=>j.id===ids.first);return j?.status==='unverified'&&j.executionStatus==='input_changed'?j:null;},'内容变化使旧结果失效');
      assert.equal(changed.workId,ids.workId); assert.ok(changed.plan.every(n=>n.verification?.passed!==true)); assert.ok(changed.lastSuccessfulRun);
      assert.match(await fs.readFile(path.join(root,'周报.md'),'utf8'),/销量合计：35/,'重新规划前不能伪装成新结果');
      await evaluate(`document.querySelector(${JSON.stringify('[data-work-id="job:'+ids.first+'"]')})?.click()`);
      await wait(()=>evaluate('!!document.querySelector(".work-task-controls")'),'恢复控制'); await shot('changed-source-review');
      await evaluate(`(()=>{[...document.querySelectorAll('.work-task-controls button')].find(b=>b.textContent.includes('检查进度并继续')).click();})()`);
      const done=await wait(async()=>{const j=(await evaluate('window.memoryDesktop.jobs()')).find(j=>j.id===ids.first);return j?.status==='done'?j:null;},'按最新资料重新规划完成');
      assert.equal(done.workId,ids.workId); assert.match(await fs.readFile(path.join(root,'周报.md'),'utf8'),/销量合计：40/);
      await wait(()=>evaluate('document.querySelector(".task-document-paper")?.textContent.includes("销量合计：40")'),'新正文'); await shot('new-source-delivery');
      await fs.writeFile(path.join(output,'recovered.json'),JSON.stringify({status,job:done},null,2));
    }
  }
  await evaluate('(()=>{window.hostApprovalStop?.();return true;})()');
  return {hostSmoke:'passed',phase,hostPid:status.pid,uiPid:process.pid,isolatedProfile:true,noPaidRequests:true};
}
module.exports={run};
