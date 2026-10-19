const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { coreRequest } = require('../electron/core-client.cjs');
const { connectRuntime } = require('../electron/runtime-rpc.cjs');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const output = path.join(root, 'output/requirements-20261016/canonical-core');
const executable = process.env.MEMORY_TEST_DESKTOP_EXE || path.join(root, 'release/pisces-ai-v' + version + '/win-unpacked/PISCES AI.exe');
const coreBinary = process.env.MEMORY_TEST_CORE_BINARY || 'D:\\记忆体\\target\\release\\task-workspaces-v1\\autonomous_node.exe';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (read, label) => { for (let i = 0; i < 500; i++) { const value = await read(); if (value) return value; await pause(100); } throw new Error('真实核心要求验收超时：' + label); };
(async () => {
  await fs.mkdir(output, { recursive: true }); const sandbox = await fs.mkdtemp(path.join(output, 'case-'));
  const profile = path.join(sandbox, 'profile'), files = path.join(sandbox, 'files'), coreDir = path.join(sandbox, 'core'); await fs.mkdir(files); await fs.mkdir(coreDir);
  const article = path.join(files, '文章.md'), text = '# 实际文章\n\n具体案例：甲根据条件乙采取行动丙，因此得到结果丁。\n' + '适用条件与边界。\n'.repeat(300) + '\n末尾案例';
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const settings = { coreUrl: 'http://127.0.0.1:' + port }, token = 'isolated-requirements-core-test-not-real';
  let requests = 0, core, host, client, coreLog = '', hostLog = '';
  const model = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); requests++;
      const system = body.messages[0].content; let content = '', tool_calls;
      if (system.includes('理解模块')) content = JSON.stringify({ type: 'task', goal: '给测试站写一篇文章', kind: '写文章', presentation: 'document', deliverable: article, done_criteria: [{ check: 'file_contains', target: article, value: '末尾案例' }], apps: [], params: {}, steps: 'one', assumptions: [], work_relation: { kind: 'new' }, user_updates: [] });
      else if (system.includes('长期写作要求的逐条核对模块')) { const input = JSON.parse(body.messages[1].content); assert.equal(input.document.text, text); content = JSON.stringify({ id: input.rule.id, revision: input.rule.revision, status: 'passed', reason: '完整正文提供案例并解释条件', evidence: '具体案例：甲根据条件乙采取行动丙' }); }
      else { assert.ok(system.includes('本次必须遵守的长期要求')); if (body.messages.at(-1).role === 'tool') content = '实际文章已经写入并读回。'; else tool_calls = [{ id: 'write-' + requests, type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: article, content: text, overwrite: true }) } }]; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) } }], usage: { total_tokens: 100 } }));
    } catch (cause) { res.writeHead(500); res.end(cause.stack); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  async function startHost() {
    const env = { ...process.env, PISCES_TEST_USER_DATA: profile, PISCES_TEST_TASK_ROOT: files, PISCES_BROWSER_HEADLESS: '1' }; delete env.ELECTRON_RUN_AS_NODE;
    host = spawn(executable, ['--task-host', '--isolated-runtime'], { cwd: root, windowsHide: true, env });
    host.stdout.on('data', chunk => hostLog += chunk); host.stderr.on('data', chunk => hostLog += chunk);
    client = await wait(async () => { if (host.exitCode !== null) throw new Error(hostLog); try { return await connectRuntime(profile, 1000); } catch { return null; } }, '独立后台');
    await wait(async () => (await client.call('runtime:status')).ready, '后台初始化完成');
  }
  async function stopHost() {
    if (client) { try { await client.call('runtime:stop'); } finally { client.close(); client = null; } }
    if (host) await wait(() => host.exitCode !== null, '后台退出');
  }
  try {
    core = spawn(coreBinary, ['--state', path.join(coreDir, 'body_state.json'), '--event-store', path.join(coreDir, 'event_store'), '--checkpoint-path', path.join(coreDir, 'checkpoint.json'), '--checkpoint-every-cycles', '1', '--health-bind', '127.0.0.1:' + port, '--cycle-sleep-ms', '100', '--local-only', '--forever'], { cwd: path.dirname(path.dirname(path.dirname(path.dirname(coreBinary)))), windowsHide: true, env: { ...process.env, MEMORY_API_RBAC: 'true', MEMORY_API_OPERATOR_TOKEN: token, MEMORY_API_ADMIN_TOKEN: '', MEMORY_API_VIEWER_TOKEN: '', MEMORY_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_STRICT_OFFLINE: 'true', MEMORY_CHAT_PREFER_ENV: 'true', MEMORY_CHAT_API_MODE: 'local_only', MEMORY_CHAT_API_KEY: '', MEMORY_CHAT_BEARER_TOKEN: '', OPENAI_API_KEY: '', MEMORY_CHAT_ENDPOINT_URL: '', MEMORY_CHAT_BASE_URL: '', MEMORY_CHAT_CONFIG_PATH: '', MEMORY_AUTONOMOUS_LEARNING_ENABLED: 'false', MEMORY_AUTONOMOUS_RESEARCH_ENABLED: 'false', AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED: 'false' } });
    core.stdout.on('data', chunk => coreLog += chunk); core.stderr.on('data', chunk => coreLog += chunk);
    await wait(async () => { if (core.exitCode !== null) throw new Error(coreLog); try { return (await coreRequest(settings, token, '/api/v1/assistant/state')).continuity?.schema === 1; } catch { return false; } }, '真实 Rust 核心');
    await startHost();
    await client.call('settings:save', [{ ...settings, coreToken: token, endpoint: 'http://127.0.0.1:' + model.address().port, model: 'canonical-requirements-fixture' }]);
    await client.call('prefs:save', [{ roots: [files], autoLearn: false, delegate: false }]);
    const rules = await client.call('requirements:save', [{ rules: [
      { text: '每篇文章必须包含具体案例并说明条件。', domain: 'writing', scope: '测试站' },
      { text: '正文必须包含“末尾案例”。', domain: 'writing', scope: '测试站', check: { type: 'contains', value: '末尾案例' } },
      { text: '正文禁止出现“禁用套话”。', domain: 'writing', scope: '测试站', check: { type: 'not_contains', value: '禁用套话' } },
    ] }]);
    const works = [];
    for (const round of [1, 2]) {
      if (round === 2) { await stopHost(); await startHost(); assert.deepEqual(await client.call('requirements:list'), rules); }
      const job = await client.call('jobs:create', [{ title: '核心写作要求 ' + round, goal: '给测试站写一篇文章，并保存到 ' + article }]);
      const done = await wait(async () => {
        const current = (await client.call('jobs:list')).find(item => item.id === job.id);
        if (current?.status === 'waiting' && current.approval) await client.call('jobs:action', [{ id: current.id, action: 'approve', decision: 'once', approvalId: current.approval.id }]);
        if (['failed', 'unverified'].includes(current?.status)) throw new Error(JSON.stringify(current));
        return current?.status === 'done' ? current : null;
      }, '核心验收第 ' + round + ' 轮');
      assert.equal(done.acceptance.authority, 'canonical_core'); assert.equal(done.acceptance.requirementsCheck.passed, true); assert.equal(done.acceptance.requirementsCheck.checks.length, 3);
      const state = await coreRequest(settings, token, '/api/v1/assistant/state'), work = state.works.find(item => item.id === done.workId);
      assert.ok(work); assert.equal(work.cognition.verification.result.passed, true); assert.equal(work.cognition.verification.result.requirements.passed, true);
      assert.equal(work.cognition.verification.result.checks.filter(item => item.check === 'requirement').length, 3);
      works.push({ workId: work.id, status: work.status, acceptance: done.acceptance });
    }
    assert.notEqual(works[0].workId, works[1].workId);
    const result = { passed: true, executable, realRustCore: true, canonicalAcceptanceIncludesEveryRequirement: true, preservedAcrossHostRestart: true, distinctConversationWorks: true, scriptedModel: true, noPaidRequests: true, requests, profile, works };
    await fs.writeFile(path.join(output, 'core-integration-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: true, realRustCore: true, rounds: 2, requirements: 3, requests }));
  } finally {
    try { await stopHost(); } catch { client?.close(); if (host?.exitCode === null) host.kill(); }
    if (core?.exitCode === null) core.kill();
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await fs.writeFile(path.join(output, 'core.log'), coreLog); await fs.writeFile(path.join(output, 'host.log'), hostLog);
  }
})().catch(cause => { console.error(cause); process.exitCode = 1; });
