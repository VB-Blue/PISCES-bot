const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { translate } = require('./i18n.cjs');
async function run(window, { appPath }) {
  const evaluate = code => window.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (read, label) => { for (let i = 0; i < 500; i++) { const value = await read(); if (value) return value; await pause(100); } throw new Error('长期目标验收超时：' + label); };
  const files = process.env.PISCES_TEST_TASK_ROOT, phase = process.env.PISCES_TEST_TASK_PHASE;
  const output = path.join(appPath, 'ui'); await fs.mkdir(output, { recursive: true });
  const shot = async name => { await pause(450); await fs.writeFile(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG()); };
  const click = text => evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('找不到按钮 '+${JSON.stringify(text)});button.click();})()`);
  await wait(() => evaluate('!!window.memoryDesktop?.longGoals'), '界面接口');
  if (phase === 'before') {
    await evaluate(`window.memoryDesktop.saveSettings(${JSON.stringify({ endpoint: process.env.MEMORY_TEST_AI_URL, model: 'goal-fixture', apiKey: 'goal-test-not-real-secret', coreUrl: process.env.MEMORY_TEST_CORE_URL, coreToken: process.env.MEMORY_TEST_CORE_TOKEN })})`);
    await evaluate(`window.memoryDesktop.prefs().then(p=>window.memoryDesktop.savePrefs({...p,roots:[${JSON.stringify(files)}],autoLearn:false}))`);
    await evaluate(`(() => {window.goalApprovalStop=window.memoryDesktop.onJob(job=>{if(job.automation&&job.status==='waiting'&&job.approval)window.memoryDesktop.jobAction({id:job.id,action:'approve',decision:job.approval.allowAlways?'always':'once',approvalId:job.approval.id});});})()`);
    await click('一起在做'); await click('长期目标'); await click('新的长期目标');
    await wait(() => evaluate('!!document.querySelector(".long-goal-editor")'), '自定义目标表单');
    const objective = '持续核对 ' + path.join(files, '指标.csv') + ' 的数据，维护 ' + path.join(files, '经营摘要.md') + '，保留来源与核对结果。';
    await evaluate(`(() => {const box=document.querySelector('.long-goal-editor input[type=text]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(box,'自定义持续目标');box.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate(`(() => {const values=${JSON.stringify([objective, '摘要中的指标合计必须来自实际读取并回读核对。', '只操作本次已授权目录。', path.join(files, '指标.csv')])};document.querySelectorAll('.long-goal-editor textarea').forEach((box,index)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,values[index]);box.dispatchEvent(new Event('input',{bubbles:true}));});const numbers=[5,15,500000,250000];document.querySelectorAll('.long-goal-editor input[type=number]').forEach((box,index)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(box,numbers[index]);box.dispatchEvent(new Event('input',{bubbles:true}));});})()`);
    await shot('custom-goal-form'); await click('创建并开始');
    const goal = await wait(async () => { const values = await evaluate('window.memoryDesktop.longGoals()'); return values[0]?.jobId && await fs.stat(path.join(files, 'held-goal')).catch(() => null) ? values[0] : null; }, '真实写入后保持后台请求');
    await shot('running-goal');
    const runtime = await evaluate('window.memoryDesktop.runtimeStatus()');
    return { goalsSmoke: 'passed', phase, goalId: goal.id, hostPid: runtime.pid };
  }
  const goals = await evaluate('window.memoryDesktop.longGoals()');
  assert.equal(goals.length, 1); assert.equal(goals[0].status, 'paused'); assert.equal(goals[0].history.length, 2);
  await click('一起在做'); await click('长期目标');
  await wait(() => evaluate('!!document.querySelector(".long-goal-detail")'), '长期目标现场');
  await shot('goal-results');
  await evaluate('document.querySelector(".theme-toggle").click()');
  await wait(() => evaluate('document.documentElement.dataset.theme === "dark"'), '深色目标现场'); await shot('goals-dark');
  await evaluate('document.querySelector(".theme-toggle").click()');
  await click('修改目标');
  await wait(() => evaluate('!!document.querySelector(".long-goal-editor")'), '修改目标表单');
  await click('保存为暂停状态');
  const updated = await evaluate('window.memoryDesktop.longGoals()'); assert.equal(updated[0].status, 'paused'); assert.equal(updated[0].revision, 2);
  await click('工具与连接'); await click('用量与预算');
  await wait(() => evaluate('!!document.querySelector(".usage-table tbody tr")'), '实际用量记录');
  await shot('usage-light');
  await evaluate('document.querySelector(".theme-toggle").click()'); await shot('usage-dark');
  await evaluate('document.querySelector(".theme-toggle").click()');
  const usage = await evaluate('window.memoryDesktop.usageSummary()'); assert.ok(usage.reportedTokens > 0); assert.equal(usage.unknownCalls, 0);
  window.setSize(980, 760); await pause(120); await shot('usage-narrow');
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth+2`), '窄屏不能出现整页横向溢出');
  for (const locale of ['en', 'zh-TW']) {
    await evaluate(`window.memoryDesktop.saveUiLocale(${JSON.stringify(locale)})`);
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.reload(); });
    await wait(() => evaluate('!!document.querySelector(".presence-home")'), '语言切换后恢复界面');
    await click(translate(locale, '一起在做')); await click(translate(locale, '长期目标'));
    await wait(() => evaluate('!!document.querySelector(".long-goal-detail")'), '本地化目标现场');
    await shot('goals-' + locale);
    assert.match(await evaluate('document.querySelector(".long-goals-page h1").textContent'), new RegExp(translate(locale, '长期目标')));
  }
  const runtime = await evaluate('window.memoryDesktop.runtimeStatus()');
  return { goalsSmoke: 'passed', phase, goalId: goals[0].id, hostPid: runtime.pid, uiLanguages: 3, history: 2, usageRows: usage.records.length };
}
module.exports = { run };
