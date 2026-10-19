const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function run(window, { appPath, userData }) {
  const execute = code => window.webContents.executeJavaScript(code);
  for (let count = 0; !(await execute('!!window.memoryDesktop')) && count < 60; count++) await new Promise(resolve => setTimeout(resolve, 100));
  const root = process.env.MEMORY_TEST_CONTINUITY_ROOT;
  await execute(`window.memoryDesktop.saveSettings(${JSON.stringify({ endpoint: process.env.MEMORY_TEST_AI_URL, model: 'isolated-continuity-model', coreUrl: process.env.MEMORY_TEST_CORE_URL, coreToken: process.env.MEMORY_TEST_CORE_TOKEN })})`);
  await execute(`window.memoryDesktop.prefs().then(value => window.memoryDesktop.savePrefs({...value, roots:[${JSON.stringify(root)}], autoLearn:false}))`);
  await execute(`(() => { window.memoryDesktop.onDesktopApproval(() => setTimeout(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim()==='允许这一次')?.click(),100)); })()`);
  await execute(`(() => { window.persistedTaskObservations = []; window.memoryDesktop.onToolReceipt(step => { if (step.phase === 'observed') window.persistedTaskObservations.push(step); }); })()`);
  const ask = message => execute(`window.memoryDesktop.assistantChat(${JSON.stringify({ id: randomUUID(), session: randomUUID(), messages: [{ role: 'user', content: message }] })})`);
  const file = path.join(root, 'report.txt');
  if (process.env.MEMORY_TEST_CONTINUITY_PHASE === 'before') {
    const first = await ask('写周报到 report.txt，周五提交。以后回答简短。');
    assert.equal(first.subject.authority, 'canonical_core'); assert.equal(first.subject.passed, true);
    assert.match(await fs.readFile(file, 'utf8'), /周五/);
    const next = await ask('周报改成周四提交，接着同一份文件做。');
    assert.equal(next.work.id, first.work.id); assert.equal(next.work.cognition.revision, 2);
    assert.match(await fs.readFile(file, 'utf8'), /周四/); assert.doesNotMatch(await fs.readFile(file, 'utf8'), /周五/);
    await ask('以后改成详细回答。');
    const state = await execute('window.memoryDesktop.assistantState()');
    assert.equal(state.works.filter(work => work.cognition).length, 1);
    const fact = state.continuity.facts.find(item => item.key === 'reply.length');
    assert.equal(fact.value, '详细');assert.equal(fact.previous_values.at(-1).value, '简短');assert.equal(fact.status, 'candidate');
    await execute(`window.memoryDesktop.editUserFact(${JSON.stringify({ key: fact.key, revision: fact.revision, value: fact.value })})`);
    await fs.writeFile(path.join(root, 'first-work-id.txt'), first.work.id);
  } else {
    const expected = await fs.readFile(path.join(root, 'first-work-id.txt'), 'utf8');
    // Continue through the actual workbench, including restoration without a local session cache.
    await execute(`(() => { [...document.querySelectorAll('nav button')].find(item => item.textContent.trim()==='一起在做')?.click(); })()`);
    for (let count = 0; !(await execute('document.querySelector(".work-inline-composer textarea") !== null')) && count < 60; count++) await new Promise(resolve=>setTimeout(resolve,100));
    await execute('window.dispatchEvent(new Event("focus"))');
    for (let count = 0; !(await execute('[...document.querySelectorAll(".scene-list-row")].some(item => item.textContent.includes("写周报，周四提交"))')) && count < 120; count++) await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(await execute('(() => { const task=[...document.querySelectorAll(".scene-list-row")].find(item=>item.textContent.includes("写周报，周四提交")); task?.click(); return !!task; })()'), '必须等待隔离核心的任务载入后再选择，不能使用初始默认连接的任务');
    await execute(`(() => { const input=document.querySelector('.work-inline-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'继续刚才的周报，保留周四期限，再加上销售额。'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await execute(`document.querySelector('button[aria-label="发送任务要求"]').click()`);
    for (let count = 0; !(await execute(`document.querySelector('button[aria-label="停止当前任务"]') !== null`)) && count < 60; count++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(await execute(`document.querySelector('button[aria-label="停止当前任务"]') !== null`), '工作区必须显示正在执行和停止入口');
    assert.ok(await execute('document.querySelector(".app").dataset.view === "work"'), '任务执行期间保留工作现场');
    await execute(`(() => { const input=document.querySelector('.work-inline-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'留给下一步的草稿'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    for (let count=0;count<150;count++){const current=await execute('window.memoryDesktop.assistantState()');if(current.works.find(work=>work.id===expected)?.cognition?.revision===3 && current.works.find(work=>work.id===expected)?.status==='checked_by_desktop')break;await new Promise(resolve=>setTimeout(resolve,100));}
    const current = await execute('window.memoryDesktop.assistantState()');
    assert.equal(current.works[0].id,expected);assert.equal(current.works[0].cognition.revision,3);assert.equal(current.works[0].status,'checked_by_desktop');
    assert.ok(await execute('document.querySelector(".app").dataset.view === "work"'), '提交完成后不跳回聊天');
    assert.equal(await execute('document.querySelector(".work-inline-composer textarea").value'),'留给下一步的草稿','完成回调不得清除后来编辑的要求');
    assert.match(await fs.readFile(file, 'utf8'), /周四[\s\S]*销售额/);
    const reply = await ask('我的回复长度偏好是什么？');assert.match(reply.text, /详细/);
    const state = await execute('window.memoryDesktop.assistantState()');
    assert.equal(state.continuity.facts.find(item => item.key === 'reply.length').status, 'confirmed');
    assert.equal(state.works.filter(work => work.cognition).length, 1);
    assert.ok(state.works[0].receipts.some(item => item.status === 'observed_success'));
    assert.equal(state.methods.length, 0, 'a model-assisted text task does not fabricate a learned independent method');
  }
  // The desktop fallback file stays empty of authoritative tasks on this path.
  assert.ok(await execute('window.persistedTaskObservations.length >= 2'), '实际操作在结束整轮前必须送达桌面');
  assert.ok(await execute('window.persistedTaskObservations.every(step => step.workId && step.revision && step.receipt.status === "observed_success")'), '只展示核心已保存的观察');
  const latest = await execute('window.persistedTaskObservations.at(-1)');
  const inspected = await execute(`window.memoryDesktop.workDetail(${JSON.stringify(latest.workId)})`);
  assert.equal(inspected.id, latest.workId);
  assert.equal(inspected.cognition.revision, latest.revision);
  assert.equal(inspected.receipts.at(-1).evidence.observation, latest.receipt.evidence.observation);
  assert.equal(JSON.parse(inspected.receipts.at(-1).evidence.observation).ok, true);
  const fallback = JSON.parse(await fs.readFile(path.join(userData, 'memory', 'subject.json'), 'utf8').catch(() => '{"tasks":[]}'));
  assert.equal(fallback.tasks.length, 0);
  await execute(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim()==='关于你'); button?.click(); })()`);
  await execute(`window.memoryDesktop.assistantState()`);
  await execute(`window.dispatchEvent(new Event('focus'))`);
  for (let count = 0; !(await execute('document.querySelectorAll(".core-fact-row").length > 0')) && count < 50; count++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(await execute('document.querySelectorAll(".core-fact-row").length > 0'), '关于你必须显示真实核心认识');
  const output = path.join(appPath, 'output', 'continuity');await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, process.env.MEMORY_TEST_CONTINUITY_PHASE + '.png'), (await window.webContents.capturePage()).toPNG());
  return { continuitySmoke: 'passed', phase: process.env.MEMORY_TEST_CONTINUITY_PHASE, realCore: true, inlineContinuation: process.env.MEMORY_TEST_CONTINUITY_PHASE === 'after', actualFileChecked: true, noPaidRequests: true };
}
module.exports = { run };
