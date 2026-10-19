const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { coreRequest } = require('../electron/core-client.cjs');
const { connectRuntime, addressFor } = require('../electron/runtime-rpc.cjs');
const { createFixture } = require('./browser-fixture.cjs');
const { CDP, jsonEndpoint } = require('../electron/browser-protocol.cjs');
const project = path.resolve(__dirname, '..'), executable = process.env.MEMORY_TEST_DESKTOP_EXE || path.join(project, 'node_modules/electron/dist/electron.exe');
const output = process.env.MEMORY_SMOKE_OUTPUT_DIR || path.join(project, 'output/browser-20261015/development');
const coreBinary = process.env.MEMORY_TEST_CORE_BINARY || 'D:\\记忆体\\target\\release\\task-workspaces-v1\\autonomous_node.exe';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (read, label) => { for (let i = 0; i < 600; i++) { const value = await read(); if (value) return value; await pause(100); } throw new Error('浏览器集成验收超时：' + label); };
const call = (name, args) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (res, content, calls) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 } })); };
(async () => {
  await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'isolated-')), profile = path.join(root, 'profile'), files = path.join(root, 'files'); await fs.mkdir(files); const fixture = await createFixture();
  let core, coreLog = '', observer, hostPid = 0, requests = 0, release, negative = false, activeTitle = '后台网页任务';
  const gate = new Promise(resolve => { release = resolve; });
  const model = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); requests++;
      const system = body.messages[0].content;
      if (system.includes('理解模块')) { negative = JSON.parse(body.messages[1].content).request.includes('未验收'); activeTitle = negative ? '未验收网页任务' : '后台网页任务'; return reply(res, JSON.stringify({ type: 'task', goal: '使用浏览器填写并保存' + activeTitle + '，从实际网页回执核对结果。', kind: '网页表单', presentation: 'general', deliverable: '实际网页记录与回执', done_criteria: [{ check: 'tool_succeeded', target: 'browser_click', value: negative ? '不存在的完成回执' : '已保存：后台网页任务' }], apps: [], params: {}, steps: 'few', missing_info: null, assumptions: [], work_relation: { kind: 'new' }, user_updates: [] })); }
      if (system.includes('规划模块')) return reply(res, JSON.stringify({ steps: [{ id: 'web-submit', do: '使用浏览器打开 ' + fixture.url + '，填写任务名称并保存，从网页中读取实际成功回执', expect: '页面显示已保存：' + activeTitle, depends_on: [], criteria: [{ check: 'tool_succeeded', target: 'browser_click', value: negative ? '不存在的完成回执' : '已保存：后台网页任务' }], outputs: [] }] }));
      if (system.includes('核对模块')) return reply(res, JSON.stringify({ passed: false, unmet: ['只接受实际工具回执'], reason: '模型不能自行声称验收通过' }));
      const prior = body.messages.filter(item => item.role === 'assistant').flatMap(item => item.tool_calls || []), invoked = name => prior.some(item => item.function.name === name);
      const results = body.messages.filter(item => item.role === 'tool').map(item => { try { return JSON.parse(item.content); } catch { return {}; } });
      const latest = [...results].reverse().find(item => item.tabId && item.documentId);
      if (!invoked('browser_open')) return reply(res, '', [call('browser_open', { url: fixture.url })]);
      if (!invoked('browser_fill')) { assert.ok(latest?.elements); return reply(res, '', [call('browser_fill', { tabId: latest.tabId, documentId: latest.documentId, element: latest.elements.find(item => item.name === '任务名称').id, text: activeTitle })]); }
      if (!invoked('browser_click')) return reply(res, '', [call('browser_click', { tabId: latest.tabId, documentId: latest.documentId, element: latest.elements.find(item => item.name === '保存任务').id })]);
      assert.ok(latest.text.includes('已保存：' + activeTitle)); await fs.writeFile(path.join(files, 'browser-model-held'), 'actual browser POST has completed'); await gate;
      return reply(res, '已保存后台网页任务，已从真实页面读回并核对成功回执。');
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(error.stack); } }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); const finder = net.createServer(); await new Promise(resolve => finder.listen(0, '127.0.0.1', resolve)); const port = finder.address().port; await new Promise(resolve => finder.close(resolve));
  const token = 'browser-fixture-' + randomUUID(), settings = { coreUrl: 'http://127.0.0.1:' + port };
  const env = { ...process.env, PISCES_TEST_USER_DATA: profile, PISCES_TEST_TASK_ROOT: files, PISCES_BROWSER_FIXTURE: fixture.url, PISCES_BROWSER_HEADLESS: '1', MEMORY_TEST_CORE_URL: settings.coreUrl, MEMORY_TEST_CORE_TOKEN: token, MEMORY_TEST_AI_URL: 'http://127.0.0.1:' + model.address().port + '/v1', MEMORY_SMOKE_OUTPUT_DIR: output };
  const runUI = async phase => {
    const child = spawn(executable, process.env.MEMORY_TEST_DESKTOP_EXE ? ['--browser-smoke'] : [project, '--browser-smoke'], { cwd: project, env: { ...env, PISCES_BROWSER_PHASE: phase }, windowsHide: true }); let log = '';
    child.stdout.on('data', value => log += value); child.stderr.on('data', value => log += value);
    const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error(log.slice(-9000))); }, 100000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
    await fs.writeFile(path.join(output, phase + '-console.log'), log); assert.equal(code, 0, log.slice(-9000));
    const line = log.split(/\r?\n/).find(line => line.includes('"browserSmoke":"passed"')); assert.ok(line, log.slice(-9000)); const result = JSON.parse(line); await fs.writeFile(path.join(output, phase + '-result.json'), JSON.stringify(result, null, 2)); return result;
  };
  try {
    const coreRoot = path.join(root, 'core'); await fs.mkdir(coreRoot);
    core = spawn(coreBinary, ['--state', path.join(coreRoot, 'body_state.json'), '--event-store', path.join(coreRoot, 'event_store'), '--checkpoint-path', path.join(coreRoot, 'checkpoint.json'), '--checkpoint-every-cycles', '1', '--health-bind', '127.0.0.1:' + port, '--cycle-sleep-ms', '100', '--local-only', '--forever'], { cwd: path.dirname(path.dirname(path.dirname(path.dirname(coreBinary)))), windowsHide: true, env: { ...process.env, MEMORY_API_RBAC: 'true', MEMORY_API_OPERATOR_TOKEN: token, MEMORY_API_ADMIN_TOKEN: '', MEMORY_API_VIEWER_TOKEN: '', MEMORY_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_STRICT_OFFLINE: 'true', MEMORY_CHAT_PREFER_ENV: 'true', MEMORY_CHAT_API_MODE: 'local_only', MEMORY_CHAT_API_KEY: '', MEMORY_CHAT_BEARER_TOKEN: '', OPENAI_API_KEY: '', MEMORY_CHAT_ENDPOINT_URL: '', MEMORY_CHAT_BASE_URL: '', MEMORY_CHAT_CONFIG_PATH: '', MEMORY_AUTONOMOUS_LEARNING_ENABLED: 'false', MEMORY_AUTONOMOUS_RESEARCH_ENABLED: 'false', AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED: 'false' } });
    core.stdout.on('data', chunk => coreLog += chunk); core.stderr.on('data', chunk => coreLog += chunk);
    await wait(async () => { if (core.exitCode !== null) throw new Error(coreLog); try { return (await coreRequest(settings, token, '/api/v1/assistant/state')).continuity?.schema === 1; } catch { return false; } }, '核心就绪');
    const first = await runUI('before'); hostPid = first.hostPid; observer = await connectRuntime(profile);
    assert.equal((await observer.call('runtime:status')).uiClients, 0); release();
    const job = await wait(async () => { const job = (await observer.call('jobs:list')).find(item => item.id === first.jobId); if (job.status === 'failed') throw new Error(JSON.stringify(job)); return job.status === 'done' ? job : null; }, '退出界面后任务完成');
    assert.equal(job.acceptance?.passed, true); assert.equal(fixture.submissions.filter(item => item.title === '后台网页任务').length, 1);
    assert.ok((await observer.call('browser:state')).activity.some(item => item.action === 'click' && item.phase === 'done' && item.workId));
    await fs.writeFile(path.join(output, 'completed-browser-job.json'), JSON.stringify(job, null, 2));
    const unverified = await observer.call('jobs:create', [{ title: '未验收网页任务', goal: '使用浏览器打开 ' + fixture.url + '，填写并保存未验收网页任务；测试故意设置不能满足的回执标准。', nextAction: '核对网页操作' }]);
    const incomplete = await wait(async () => { const value = (await observer.call('jobs:list')).find(item => item.id === unverified.id); if (value.status === 'failed') throw new Error(JSON.stringify(value)); return value.status === 'unverified' ? value : null; }, '已执行但未通过验收时停止自动重做');
    assert.equal(fixture.submissions.filter(item => item.title === '未验收网页任务').length, 1); assert.match(incomplete.error, /停止自动重做/); await fs.writeFile(path.join(output, 'unverified-browser-job.json'), JSON.stringify(incomplete, null, 2));
    const reconnect = await runUI('reconnect'); assert.equal(reconnect.hostPid, hostPid);
    await observer.call('browser:action', [{ tabId: first.tabId, action: 'navigate', url: fixture.url + '/second' }]);
    const priorSubmissions = fixture.submissions.length; const crashedPid = hostPid; process.kill(hostPid); observer.close(); observer = null;
    await wait(() => { try { process.kill(crashedPid, 0); return false; } catch { return true; } }, '模拟独立后台崩溃'); hostPid = 0;
    const restored = await runUI('restart'); hostPid = restored.hostPid; assert.notEqual(hostPid, crashedPid); observer = await connectRuntime(profile);
    assert.equal(fixture.submissions.length, priorSubmissions, '恢复不得自动重放网页提交');
    assert.equal((await observer.call('jobs:list')).find(item => item.id === first.jobId).status, 'done');
    const usage = await observer.call('usage:summary'); assert.equal(usage.reportedTokens, requests * 100);
    const result = { passed: true, version: require('../package.json').version, realCanonicalCore: true, realElectronIPC: true, realExternalBrowsers: ['chrome','edge'], customBrowserJobVerified: true, completedBrowserEffectsNotReplayedOnFailedAcceptance: true, continuesAfterUIExit: true, sameHostOnUIReconnect: true, cookieAndLocalStorageSurviveHostCrash: true, externalBrowsersReconnectAfterHostCrash: true, noDuplicateSubmissions: true, downloadsSurviveRestart: true, uiLanguages: 3, narrowLayout: true, scriptedModel: true, noPaidRequests: true, modelCalls: requests, profile, executable };
    await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    await observer.call('runtime:stop'); observer.close(); observer = null; await wait(() => { try { process.kill(hostPid, 0); return false; } catch { return true; } }, '停止验收后台'); hostPid = 0;
  } finally {
    release(); if (!hostPid) { try { const record = JSON.parse(await fs.readFile(path.join(profile, 'runtime-host.json'), 'utf8')); if (record.address === addressFor(profile)) hostPid = record.pid; } catch {} }
    if (hostPid) { try { observer ||= await connectRuntime(profile); await observer.call('runtime:stop'); await wait(() => { try { process.kill(hostPid, 0); return false; } catch { return true; } }, '清理验收后台'); } catch { try { process.kill(hostPid); } catch {} } }
    observer?.close();
    try { const state = JSON.parse(await fs.readFile(path.join(profile, 'browser/workspace.json'), 'utf8')); for (const connection of state.connections.filter(item => item.owned)) { try { const pages = await jsonEndpoint(connection.endpoint, '/json/list'); if (pages.some(page => page.type === 'page' && page.url !== 'about:blank' && !page.url.startsWith(fixture.url))) continue; const version = await jsonEndpoint(connection.endpoint, '/json/version'); const client = await CDP.connect(version.webSocketDebuggerUrl); await client.send('Browser.close', {}, { timeout: 1500 }).catch(() => {}); client.close(); } catch {} } } catch {}
    if (core) { core.kill(); await new Promise(resolve => { if (core.exitCode !== null) resolve(); else core.once('exit', resolve); }); }
    fixture.server.close(); model.closeAllConnections(); model.close(); await fs.writeFile(path.join(output, 'canonical-core.log'), coreLog);
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
