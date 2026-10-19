const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { coreRequest } = require('../electron/core-client.cjs');
const { connectRuntime, addressFor } = require('../electron/runtime-rpc.cjs');
const project = path.resolve(__dirname, '..');
const output = process.env.MEMORY_SMOKE_OUTPUT_DIR || path.join(project, 'output/long-goals-20261015/development');
const executable = process.env.MEMORY_TEST_DESKTOP_EXE || path.join(project, 'node_modules/electron/dist/electron.exe');
const coreBinary = process.env.MEMORY_TEST_CORE_BINARY || 'D:\\记忆体\\target\\release\\task-workspaces-v1\\autonomous_node.exe';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (read, label) => { for (let i = 0; i < 800; i++) { const value = await read(); if (value) return value; await pause(100); } throw new Error('目标验收超时：' + label); };
const call = (name, args) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (res, content, calls) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 } })); };

(async () => {
  await fs.mkdir(output, { recursive: true }); const root = await fs.mkdtemp(path.join(output, 'case-'));
  const profile = path.join(root, 'profile'), files = path.join(root, 'files'); await fs.mkdir(files); await fs.mkdir(profile);
  const csv = path.join(files, '指标.csv'), basis = path.join(files, '依据.json'), report = path.join(files, '经营摘要.md');
  await fs.writeFile(csv, 'item,total\nA,20\nB,15\n'); await fs.writeFile(basis, '{}'); await fs.writeFile(report, '# 初始内容');
  const sum = text => text.trim().split(/\r?\n/).slice(1).reduce((total, line) => total + Number(line.split(',')[1]), 0);
  let requests = 0, core, observer, hostPid = 0, release, held = false, coreLog = '';
  const gate = new Promise(resolve => release = resolve);
  const model = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); requests++;
      assert.equal(req.headers.authorization, 'Bearer goal-test-not-real-secret');
      const system = body.messages[0].content, total = sum(await fs.readFile(csv, 'utf8'));
      if (system.includes('复核长期目标')) return reply(res, JSON.stringify({ state: 'continue', summary: '本轮已实际读回摘要，指标合计为 ' + total, nextAction: '检查指标来源的新变化，再维护摘要并回读核对。', delayMinutes: 5 }));
      if (system.includes('理解模块')) {
        const input = JSON.parse(body.messages[1].content);
        return reply(res, JSON.stringify({ type: 'task', goal: input.request, kind: '数据统计', presentation: 'data', deliverable: report, done_criteria: [{ check: 'file_contains', target: report, value: '指标合计：' + total }], apps: [], params: { total }, steps: 'few', missing_info: null, assumptions: [], work_relation: { kind: 'new' }, user_updates: [] }));
      }
      if (system.includes('规划模块')) return reply(res, JSON.stringify({ steps: [
        { id: 'collect', do: '实际读取指标 CSV，保存汇总依据 JSON', expect: '依据来自真实读取的数据', depends_on: [], criteria: [{ check: 'file_contains', target: basis, value: '"total":' + total }], outputs: [basis] },
        { id: 'publish', do: '读取已核对依据，维护经营摘要', expect: '摘要中的合计正确', depends_on: ['collect'], criteria: [{ check: 'file_contains', target: report, value: '指标合计：' + total }], outputs: [report] },
        { id: 'readback', do: '实际读回摘要核对内容', expect: '交付已读回', depends_on: ['publish'], criteria: [{ check: 'tool_succeeded', target: 'read_text', value: '指标合计：' + total }], outputs: [] },
      ] }));
      if (system.includes('核对模块')) return reply(res, JSON.stringify({ passed: false, unmet: ['本测试要求机械文件证据'], reason: '不能凭模型自述验收' }));
      const text = body.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
      const node = [...text.matchAll(/当前只执行节点 ([\w-]+)：/g)].at(-1)?.[1];
      const calls = body.messages.filter(message => message.role === 'assistant' && message.tool_calls).flatMap(message => message.tool_calls);
      const invoked = name => calls.some(item => item.function.name === name);
      const results = body.messages.filter(message => message.role === 'tool').map(message => { try { return JSON.parse(message.content); } catch { return {}; } });
      if (node === 'collect') {
        if (!invoked('read_text')) return reply(res, '', [call('read_text', { path: csv })]);
        if (!invoked('write_text')) return reply(res, '', [call('write_text', { path: basis, content: JSON.stringify({ total: sum(results.find(item => item.path === csv).text), source: csv }), overwrite: true })]);
        return reply(res, '已读取资料并保存汇总依据。');
      }
      if (node === 'publish') {
        if (!invoked('read_text')) return reply(res, '', [call('read_text', { path: basis })]);
        if (!invoked('write_text')) return reply(res, '', [call('write_text', { path: report, content: '# 经营摘要\n\n指标合计：' + JSON.parse(results.find(item => item.path === basis).text).total + '\n来源：指标.csv\n', overwrite: true })]);
        if (!held) { held = true; await fs.writeFile(path.join(files, 'held-goal'), 'held'); await gate; }
        return reply(res, '摘要已按实际数据维护。');
      }
      if (node === 'readback') { if (!invoked('read_text')) return reply(res, '', [call('read_text', { path: report })]); return reply(res, '摘要已实际读回核对。'); }
      throw new Error('未预期的模型阶段：' + system.slice(0, 100));
    } catch (error) { if (!res.destroyed) { res.writeHead(500); res.end(String(error.stack)); } }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const portFinder = net.createServer(); await new Promise(resolve => portFinder.listen(0, '127.0.0.1', resolve)); const port = portFinder.address().port; await new Promise(resolve => portFinder.close(resolve));
  const token = 'goals-test-' + randomUUID(), settings = { coreUrl: 'http://127.0.0.1:' + port };
  const env = { ...process.env, PISCES_TEST_USER_DATA: profile, PISCES_TEST_TASK_ROOT: files, MEMORY_TEST_CORE_URL: settings.coreUrl, MEMORY_TEST_CORE_TOKEN: token, MEMORY_TEST_AI_URL: 'http://127.0.0.1:' + model.address().port + '/v1', MEMORY_SMOKE_OUTPUT_DIR: output };
  const runUI = async phase => {
    const flags = ['--goals-smoke']; const child = spawn(executable, process.env.MEMORY_TEST_DESKTOP_EXE ? flags : [project, ...flags], { cwd: project, env: { ...env, PISCES_TEST_TASK_PHASE: phase }, windowsHide: true });
    let log = ''; child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
    const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error(log.slice(-8000))); }, 100000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
    await fs.writeFile(path.join(output, phase + '-console.log'), log); assert.equal(code, 0, log.slice(-8000));
    const result = JSON.parse(log.split(/\r?\n/).find(line => line.includes('"goalsSmoke":"passed"'))); return result;
  };
  try {
    const coreRoot = path.join(root, 'core'); await fs.mkdir(coreRoot);
    core = spawn(coreBinary, ['--state', path.join(coreRoot, 'body_state.json'), '--event-store', path.join(coreRoot, 'event_store'), '--checkpoint-path', path.join(coreRoot, 'checkpoint.json'), '--checkpoint-every-cycles', '1', '--health-bind', '127.0.0.1:' + port, '--cycle-sleep-ms', '100', '--local-only', '--forever'], { cwd: path.dirname(path.dirname(path.dirname(path.dirname(coreBinary)))), windowsHide: true, env: { ...process.env, MEMORY_API_RBAC: 'true', MEMORY_API_OPERATOR_TOKEN: token, MEMORY_API_ADMIN_TOKEN: '', MEMORY_API_VIEWER_TOKEN: '', MEMORY_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_STRICT_OFFLINE: 'true', MEMORY_CHAT_PREFER_ENV: 'true', MEMORY_CHAT_API_MODE: 'local_only', MEMORY_CHAT_API_KEY: '', MEMORY_CHAT_BEARER_TOKEN: '', OPENAI_API_KEY: '', MEMORY_CHAT_ENDPOINT_URL: '', MEMORY_CHAT_BASE_URL: '', MEMORY_CHAT_CONFIG_PATH: '', MEMORY_AUTONOMOUS_LEARNING_ENABLED: 'false', MEMORY_AUTONOMOUS_RESEARCH_ENABLED: 'false', AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED: 'false' } });
    core.stdout.on('data', chunk => coreLog += chunk); core.stderr.on('data', chunk => coreLog += chunk);
    await wait(async () => { if (core.exitCode !== null) throw new Error(coreLog); try { return (await coreRequest(settings, token, '/api/v1/assistant/state')).continuity?.schema === 1; } catch { return false; } }, '核心就绪');
    const first = await runUI('before'); hostPid = first.hostPid; observer = await connectRuntime(profile);
    assert.equal((await observer.call('runtime:status')).uiClients, 0); release();
    const firstDone = await wait(async () => { const goal = (await observer.call('goals:list'))[0]; return goal.history.length === 1 ? goal : null; }, '退出界面后首轮复核并安排下一轮');
    assert.match(await fs.readFile(report, 'utf8'), /指标合计：35/);
    const idleRequests = requests; await pause(650); assert.equal(requests, idleRequests, '空闲等待不能持续调用模型');
    await fs.writeFile(csv, 'item,total\nA,30\nB,20\n');
    await observer.call('goals:action', [{ id: first.goalId, action: 'run' }]);
    const secondDone = await wait(async () => {
      for (const job of await observer.call('jobs:list')) if (job.status === 'waiting' && job.approval) await observer.call('jobs:action', [{ id: job.id, action: 'approve', decision: 'once', approvalId: job.approval.id }]);
      const goal = (await observer.call('goals:list'))[0]; return goal.history.length === 2 ? goal : null;
    }, '变更来源后第二轮完成');
    assert.match(await fs.readFile(report, 'utf8'), /指标合计：50/);
    const usage = await observer.call('usage:summary'); assert.equal(usage.unknownCalls, 0); assert.equal(usage.reportedTokens, requests * 100); assert.ok(usage.records.some(record => record.role === 'goal_review'));
    const completedIds = new Set((await observer.call('jobs:list')).filter(job => job.status === 'done').map(job => job.id));
    assert.ok(usage.records.every(record => completedIds.has(record.runId)), '执行与复核必须使用稳定的本轮任务身份计入预算');
    const beforeBudget = requests; await observer.call('usage:policy', [{ dailyTokenLimit: usage.accountedTokens + 1 }]);
    await observer.call('goals:action', [{ id: first.goalId, action: 'run' }]);
    await wait(async () => (await observer.call('goals:list'))[0].status === 'budget', '预算耗尽后停止');
    assert.equal(requests, beforeBudget, '预算不足时不得发起模型请求'); assert.match(await fs.readFile(report, 'utf8'), /指标合计：50/);
    await fs.writeFile(path.join(output, 'before-stop.json'), JSON.stringify({ firstDone, secondDone, usage }, null, 2));
    await observer.call('runtime:stop'); observer.close(); observer = null;
    await wait(() => { try { process.kill(hostPid, 0); return false; } catch { return true; } }, '主动停止后台'); hostPid = 0;
    const after = await runUI('after'); hostPid = after.hostPid; observer = await connectRuntime(profile);
    assert.equal(requests, beforeBudget, '重开界面后暂停目标不能自动执行');
    await observer.call('runtime:stop'); observer.close(); observer = null;
    await wait(() => { try { process.kill(hostPid, 0); return false; } catch { return true; } }, '验收后台退出'); hostPid = 0;
    const result = { passed: true, realCanonicalCore: true, realElectronIPC: true, customGoalFromUI: true, continuesAfterUIExit: true, twoVerifiedRounds: true, changedSourceReflectedInOutput: true, allCallsAccounted: true, budgetBlocksBeforeHTTP: true, explicitStopSurvivesRestart: true, uiLanguages: after.uiLanguages, narrowLayout: true, requests, scriptedModel: true, noPaidRequests: true, profile, executable };
    await fs.writeFile(path.join(output, 'goals-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally {
    release();
    if (!hostPid) { try { const record = JSON.parse(await fs.readFile(path.join(profile, 'runtime-host.json'), 'utf8')); if (record.address === addressFor(profile)) hostPid = record.pid; } catch {} }
    if (hostPid) { try { process.kill(hostPid); } catch {} } observer?.close();
    if (core?.exitCode === null) { const exited = new Promise(resolve => core.once('exit', resolve)); core.kill(); await exited; }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await fs.writeFile(path.join(output, 'core.log'), coreLog);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
