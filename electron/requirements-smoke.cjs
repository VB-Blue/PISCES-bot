const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
async function run(window, { appPath, userData }) {
  const config = JSON.parse(await fs.readFile(process.env.PISCES_REQUIREMENTS_CONFIG, 'utf8'));
  const phase = process.env.PISCES_TEST_TASK_PHASE;
  const evaluate = code => window.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (read, label) => { for (let attempt = 0; attempt < 400; attempt++) { const value = await read(); if (value) return value; await pause(100); } throw new Error('要求验收超时：' + label); };
  const click = text => evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('找不到按钮 '+${JSON.stringify(text)});button.click();})()`);
  await wait(() => evaluate('!!window.memoryDesktop?.memory?.requirements'), '界面接口');
  await evaluate(`window.memoryDesktop.saveSettings(${JSON.stringify({ endpoint: config.endpoint, model: 'requirements-fixture', coreUrl: 'http://127.0.0.1:9' })})`);
  await evaluate(`window.memoryDesktop.savePrefs({ roots: [${JSON.stringify(config.files)}], autoLearn: false, delegate: false })`);
  await evaluate("void window.memoryDesktop.onDesktopApproval(value => { if(value.approvalId) window.memoryDesktop.resolveDesktopApproval({approvalId:value.approvalId,decision:'once'}); })");
  await click('关于你'); await click('记住的事');
  await wait(() => evaluate('!!document.querySelector(".requirement-editor textarea")'), '长期要求编辑器');
  if (phase === 'before') {
    await evaluate(`(() => {const box=document.querySelector('.requirement-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,${JSON.stringify(config.original)});box.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate("document.querySelector('.requirement-editor button[type=submit], .requirement-editor .button.primary').click()");
    await wait(() => evaluate('window.memoryDesktop.memory.requirements().then(items=>items.length===1)'), '界面保存完整规范');
    await evaluate(`window.memoryDesktop.memory.saveRequirements(${JSON.stringify(config.extraRules)})`);
    await click('刷新');
  }
  const rules = await evaluate('window.memoryDesktop.memory.requirements()');
  assert.equal(rules.length, config.extraRules.length + 1); assert.equal(rules[0].text, config.original);
  await wait(() => evaluate('document.querySelectorAll(".requirement-card").length'), '已保存要求');
  await pause(250);
  await fs.writeFile(path.join(appPath, phase + '-requirements.png'), (await window.webContents.capturePage()).toPNG());
  const result = await evaluate(`window.memoryDesktop.chat(${JSON.stringify({ id: 'requirements-' + phase + '-' + Date.now(), session: 'unrelated-chat-' + phase, messages: [{ role: 'user', content: '给网站写一篇文章，并保存到 ' + config.article }] })})`);
  assert.equal(result.requirementsCheck?.passed, true); assert.equal(result.requirementsCheck.checks.length, rules.length);
  assert.ok(result.requirementsCheck.checks.every(item => item.status === 'passed'));
  assert.match(await fs.readFile(config.article, 'utf8'), /末尾案例/);
  if (phase === 'after') {
    const job = await evaluate(`window.memoryDesktop.createJob(${JSON.stringify({ title: '写作要求后台验收', goal: '给网站写一篇文章，并保存到 ' + config.article })})`);
    const done = await wait(async () => {
      const current = (await evaluate('window.memoryDesktop.jobs()')).find(item => item.id === job.id);
      if (current?.status === 'waiting' && current.approval) await evaluate(`window.memoryDesktop.jobAction(${JSON.stringify({ id: current.id, action: 'approve', decision: 'once', approvalId: current.approval.id })})`);
      if (['failed', 'unverified'].includes(current?.status)) throw new Error(current.error);
      return current?.status === 'done' ? current : null;
    }, '后台任务逐条核对');
    assert.equal(done.acceptance?.requirementsCheck?.passed, true);
    assert.equal(done.acceptance.requirementsCheck.checks.length, rules.length);
    await click('一起在做');
    await wait(() => evaluate('!!document.querySelector(".requirement-checks")'), '工作现场逐条检查记录');
    await evaluate('document.querySelector(".requirement-checks").open=true');
    await pause(250); await fs.writeFile(path.join(appPath, 'after-checks.png'), (await window.webContents.capturePage()).toPNG());
  }
  const status = await evaluate('window.memoryDesktop.runtimeStatus()');
  await fs.writeFile(path.join(appPath, phase + '-result.json'), JSON.stringify({ passed: true, phase, rules, result, status, userData }, null, 2));
  await evaluate('window.memoryDesktop.stopRuntime()');
  return { requirementsSmoke: 'passed', phase, ruleCount: rules.length, hostPid: status.pid, persistedRecord: result.requirementsCheck.recordPath };
}
module.exports = { run };
