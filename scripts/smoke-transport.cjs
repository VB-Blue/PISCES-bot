// Real packaged UI + independent host + native core. All model traffic is a local fault-injection fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { coreRequest } = require('../electron/core-client.cjs');
const { connectRuntime } = require('../electron/runtime-rpc.cjs');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const output = process.env.MEMORY_SMOKE_OUTPUT_DIR || path.join(root, 'output/transport-20261016/packaged');
const executable = process.env.MEMORY_TEST_DESKTOP_EXE || path.join(root, 'release/pisces-ai-v' + version + '/win-unpacked/PISCES AI.exe');
const coreBinary = process.env.MEMORY_TEST_CORE_BINARY || 'D:\\记忆体\\target\\release\\task-workspaces-v1\\autonomous_node.exe';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = (res, content = '', calls) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }], usage: { total_tokens: 60 } })); };
(async () => {
  await fs.mkdir(output, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(output, 'case-')), files = path.join(sandbox, 'files'), profile = path.join(sandbox, 'profile'), coreDir = path.join(sandbox, 'core'); await fs.mkdir(files); await fs.mkdir(coreDir);
  const article = path.join(files, '待确认样片.md'), text = '# 三篇样片\n\n第一篇：说明事实与来源。\n\n第二篇：解释具体案例与条件。\n\n第三篇：讨论适用范围。\n\n等待用户确认。';
  const portFinder = net.createServer(); await new Promise(resolve => portFinder.listen(0, '127.0.0.1', resolve)); const port = portFinder.address().port; await new Promise(resolve => portFinder.close(resolve));
  const token = 'isolated-transport-core-not-real', coreSettings = { coreUrl: 'http://127.0.0.1:' + port };
  let phase = 'down', requests = 0, dropped = 0, environmentReads = 0, writes = 0, child, core, log = '', coreLog = '';
  const model = http.createServer(async (req, res) => {
    if (req.url === '/recover') { phase = 'live'; res.end('ok'); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); requests++;
      const system = body.messages[0].content;
      if (system.includes('理解模块')) return reply(res, JSON.stringify({ type: 'task', goal: '给测试站写三篇样片供确认', kind: '写文章', presentation: 'document', deliverable: article, done_criteria: [{ check: 'file_contains', target: article, value: '三篇样片' }], steps: 'few', assumptions: [], work_relation: { kind: 'new' }, user_updates: [] }));
      if (system.includes('规划模块')) return reply(res, JSON.stringify({ steps: [
        { id: 'research', do: '使用 get_environment 读取环境资料', role: 'researcher', depends_on: [], inputs: [], outputs: [], criteria: [{ check: 'tool_succeeded', target: 'get_environment' }], execution: { mode: 'parallel', tools: ['get_environment'] } },
        { id: 'draft', do: '写三篇样片到 ' + article, role: 'writer', depends_on: ['research'], outputs: [article], criteria: [{ check: 'file_contains', target: article, value: '三篇样片' }], execution: { mode: 'serial' } },
      ] }));
      if (system.includes('核对模块')) return reply(res, JSON.stringify({ passed: true, unmet: [], reason: '实际工具与文件证据满足标准' }));
      const research = system.includes('当前只执行节点 research：');
      if (research && body.messages.at(-1).role === 'tool') {
        if (phase === 'down') { dropped++; res.destroy(); return; }
        return reply(res, '实际环境资料已读取，交给写作步骤。');
      }
      if (research) { environmentReads++; return reply(res, '', [{ id: 'read-' + requests, type: 'function', function: { name: 'get_environment', arguments: '{}' } }]); }
      if (body.messages.at(-1).role === 'tool') {
        const previousCall = body.messages.filter(item => item.tool_calls?.length).at(-1)?.tool_calls[0]?.function?.name;
        if (previousCall === 'write_text') return reply(res, '', [{ id: 'readback-' + requests, type: 'function', function: { name: 'read_text', arguments: JSON.stringify({ path: article }) } }]);
        return reply(res, '三篇样片已保存并读回，等待确认。');
      }
      writes++; return reply(res, '', [{ id: 'write-' + requests, type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: article, content: text }) } }]);
    } catch (error) { res.writeHead(500); res.end(error.stack); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  try {
    core = spawn(coreBinary, ['--state', path.join(coreDir, 'body_state.json'), '--event-store', path.join(coreDir, 'events'), '--checkpoint-path', path.join(coreDir, 'checkpoint.json'), '--checkpoint-every-cycles', '1', '--health-bind', '127.0.0.1:' + port, '--cycle-sleep-ms', '100', '--local-only', '--forever'], { windowsHide: true, cwd: path.dirname(coreBinary), env: { ...process.env, MEMORY_API_RBAC: 'true', MEMORY_API_OPERATOR_TOKEN: token, MEMORY_API_ADMIN_TOKEN: '', MEMORY_API_VIEWER_TOKEN: '', MEMORY_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_STRICT_OFFLINE: 'true', MEMORY_CHAT_PREFER_ENV: 'true', MEMORY_CHAT_API_MODE: 'local_only', MEMORY_CHAT_API_KEY: '', MEMORY_CHAT_BEARER_TOKEN: '', OPENAI_API_KEY: '', MEMORY_CHAT_ENDPOINT_URL: '', MEMORY_CHAT_BASE_URL: '', MEMORY_CHAT_CONFIG_PATH: '', MEMORY_AUTONOMOUS_LEARNING_ENABLED: 'false', MEMORY_AUTONOMOUS_RESEARCH_ENABLED: 'false', AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED: 'false' } });
    core.on('error', error => { coreLog += error.message; }); core.stdout.on('data', chunk => coreLog += chunk); core.stderr.on('data', chunk => coreLog += chunk);
    let ready = false; for (let i = 0; i < 300; i++) { if (core.exitCode !== null) throw new Error(coreLog); try { ready = (await coreRequest(coreSettings, token, '/api/v1/assistant/state')).continuity?.schema === 1; } catch {} if (ready) break; await pause(100); } assert.ok(ready, coreLog);
    const config = path.join(sandbox, 'config.json'); await fs.writeFile(config, JSON.stringify({ settings: { ...coreSettings, coreToken: token, endpoint: 'http://127.0.0.1:' + model.address().port, model: 'transport-fixture' }, files, article, text, control: 'http://127.0.0.1:' + model.address().port + '/recover' }));
    // Point initial renderer polling at the isolated core before any settings IPC runs.
    await fs.mkdir(profile, { recursive: true }); await fs.writeFile(path.join(profile, 'connection.json'), JSON.stringify({ ...coreSettings, endpoint: 'http://127.0.0.1:' + model.address().port, model: 'transport-fixture' }));
    const env = { ...process.env, PISCES_TEST_USER_DATA: profile, PISCES_TRANSPORT_CONFIG: config, MEMORY_SMOKE_OUTPUT_DIR: output }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, ['--transport-smoke'], { cwd: root, windowsHide: true, env }); child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
    const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('打包验收超时：' + log.slice(-5000))); }, 180000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
    assert.equal(code, 0, log.slice(-6000)); assert.ok(log.includes('"transportSmoke":"passed"'), log.slice(-6000));
    const ui = JSON.parse(await fs.readFile(path.join(output, 'transport-ui-result.json'), 'utf8'));
    const state = await coreRequest(coreSettings, token, '/api/v1/assistant/state'), work = state.works.find(item => item.id === ui.workId);
    assert.ok(work.cognition.verification.result.passed); assert.equal(work.cognition.verification.result.checks.filter(item => item.check === 'requirement').length, 2);
    assert.equal(dropped, 3); assert.equal(environmentReads, 2); assert.equal(writes, 1);
    const result = { ...ui, executable, realRustCore: true, modelRequests: requests, dropped, environmentReads, writes, scriptedModel: true, noPaidModelRequests: true };
    await fs.writeFile(path.join(output, 'transport-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: true, realRustCore: true, hostRestarted: ui.hostRestarted, dropped, environmentReads, writes, noErrorDocument: true }));
  } finally {
    let client; try { client = await connectRuntime(profile, 1000); await client.call('runtime:stop'); } catch {} finally { client?.close(); }
    if (child?.exitCode === null) child.kill(); if (core?.exitCode === null) core.kill();
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await fs.writeFile(path.join(output, 'ui.log'), log); await fs.writeFile(path.join(output, 'core.log'), coreLog);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
