const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { translate } = require('./i18n.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (read, label) => { for (let i = 0; i < 500; i++) { const value = await read(); if (value) return value; await pause(100); } throw new Error('浏览器界面验收超时：' + label); };
async function run(window, { appPath }) {
  const output = path.join(appPath, 'ui'), phase = process.env.PISCES_BROWSER_PHASE || 'before', url = process.env.PISCES_BROWSER_FIXTURE;
  await fs.mkdir(output, { recursive: true });
  const evaluate = script => window.webContents.executeJavaScript(script, true);
  const click = text => evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('找不到按钮：'+${JSON.stringify(text)});b.click(); })()`);
  const api = (name, args) => evaluate(`window.memoryDesktop.${name}(${args === undefined ? '' : JSON.stringify(args)})`);
  const shot = async name => { await pause(450); await fs.writeFile(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG()); };
  const navigate = async locale => { await wait(() => evaluate('!!document.querySelector(".presence-home")'), '主界面'); await click(translate(locale, '工具与连接')); await click(translate(locale, '浏览器')); await wait(() => evaluate('!!document.querySelector("[data-browser-workspace]")'), '浏览器工作区'); };
  await wait(() => api('runtimeStatus').then(state => state.ready), '独立后台');
  await navigate(await evaluate('window.memoryDesktop.uiLocale()'));
  if (phase === 'before') {
    await shot('browser-empty');
    await evaluate(`(() => { const input=document.querySelector('input[aria-label="网页地址"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(url)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate('document.querySelector(".browser-address").requestSubmit()');
    await wait(() => evaluate('!!document.querySelector(".browser-canvas img")'), '从界面打开真实网页');
    let state = await api('browserState'); const tabId = state.activeId;
    let page = await api('browserAction', { tabId, action: 'observe' });
    const target = name => ({ tabId, documentId: page.documentId, element: page.elements.find(item => item.name === name).id });
    page = await api('browserAction', { ...target('任务名称'), action: 'fill', text: '界面与后台共同工作' });
    page = await api('browserAction', { ...target('内容摘要'), action: 'fill', text: '浏览器执行、状态记录、下载与接管验证' });
    page = await api('browserAction', { ...target('保存任务'), action: 'click' }); assert.match(page.text, /已保存：界面与后台共同工作/);
    page = await api('browserAction', { ...target('下载执行报告'), action: 'click' });
    await wait(async () => (await api('browserState')).downloads.some(item => item.status === 'completed'), '真实下载');
    await pause(1700); await shot('browser-working');
    await click('下载'); await shot('browser-downloads'); await click('执行记录');
    await evaluate('document.querySelector(".theme-toggle").click()'); await shot('browser-dark'); await evaluate('document.querySelector(".theme-toggle").click()');
    window.setContentSize(800, 900); await pause(500);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, '窄屏不能溢出'); await shot('browser-narrow'); window.setContentSize(1440, 1000);
    for (const locale of ['en', 'zh-TW', 'zh-CN']) {
      await api('saveUiLocale', locale); await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.reload(); }); await navigate(locale);
      await wait(() => evaluate('!!document.querySelector(".browser-canvas img")'), '恢复浏览器现场'); assert.equal(await evaluate('document.querySelector(".browser-workspace h1").textContent'), translate(locale, '浏览器')); await shot('browser-' + locale);
    }
    for (const mode of ['chrome', 'edge']) {
      const external = await api('browserOpen', { url, mode }); assert.equal(external.mode, mode);
      const filled = await api('browserAction', { tabId: external.tabId, documentId: external.documentId, element: external.elements.find(item => item.name === '任务名称').id, action: 'fill', text: 'IPC ' + mode });
      const submitted = await api('browserAction', { tabId: filled.tabId, documentId: filled.documentId, element: filled.elements.find(item => item.name === '保存任务').id, action: 'click' }); assert.ok(submitted.text.includes('已保存：IPC ' + mode));
    }
    await api('saveSettings', { endpoint: process.env.MEMORY_TEST_AI_URL, model: 'browser-fixture', apiKey: 'browser-test-not-real-key', coreUrl: process.env.MEMORY_TEST_CORE_URL, coreToken: process.env.MEMORY_TEST_CORE_TOKEN });
    await evaluate(`window.memoryDesktop.prefs().then(p=>window.memoryDesktop.savePrefs({...p,autoLearn:false,roots:[${JSON.stringify(process.env.PISCES_TEST_TASK_ROOT)}]}))`);
    await evaluate(`(() => {window.browserJobApprovals=window.memoryDesktop.onJob(job=>{if(job.status==='waiting'&&job.approval)window.memoryDesktop.jobAction({id:job.id,action:'approve',decision:job.approval.allowAlways?'always':'once',approvalId:job.approval.id});});})()`);
    const job = await api('createJob', { title: '浏览器真实后台任务', goal: '使用浏览器打开 ' + url + '，填写名称“后台网页任务”，保存记录并从网页回执核对结果。', nextAction: '填写并保存网页记录' });
    await wait(async () => { const values = await api('jobs'); const current = values.find(item => item.id === job.id); if (current?.status === 'failed') throw new Error(current.error || current.summary); return fs.stat(path.join(process.env.PISCES_TEST_TASK_ROOT, 'browser-model-held')).catch(() => false); }, '后台网页任务已提交，保持模型请求等待');
    const runtime = await api('runtimeStatus'); state = await api('browserState');
    await fs.writeFile(path.join(appPath, 'before-state.json'), JSON.stringify(state, null, 2));
    return { browserSmoke: 'passed', phase, hostPid: runtime.pid, tabId, jobId: job.id, uiLanguages: 3, realExternalBrowsers: ['chrome','edge'], visibleDownloads: true, narrowLayout: true };
  }
  const previous = JSON.parse(await fs.readFile(path.join(appPath, 'before-result.json'), 'utf8'));
  let state = await api('browserState'); assert.ok(state.tabs.some(tab => tab.id === previous.tabId));
  const page = await api('browserAction', { tabId: previous.tabId, action: 'observe' });
  if (phase === 'reconnect') assert.match(page.text, /已保存：界面与后台共同工作/);
  else { assert.match(page.text, /fixture_login=browser-qa/); assert.match(page.text, /saved/); }
  state = await api('browserTabs'); await fs.writeFile(path.join(appPath, phase + '-state.json'), JSON.stringify(state, null, 2)); assert.ok(state.connections.filter(item => item.online).length >= 2); assert.ok(state.downloads.some(item => item.status === 'completed'));
  await shot('browser-' + phase);
  return { browserSmoke: 'passed', phase, hostPid: (await api('runtimeStatus')).pid, restoredTabId: previous.tabId, restoredDownloads: true, attachedExternalBrowsers: state.connections.filter(item => item.online).length };
}
module.exports = { run };
