// The assistant's memory against the real core: first-contact migration, core-assembled context,
// persistence across a core restart, queued changes while the core is down, and the existing assistant routes.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { coreRequest } = require('../electron/core-client.cjs');
const memory = require('../electron/memory.cjs');

const project = process.env.MEMORY_CORE_PROJECT_DIR || 'D:\\记忆体';
const binary = process.env.MEMORY_TEST_CORE_BINARY || path.join(project, 'target/release/autonomous_node.exe');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startCore(root, port, token) {
  const child = spawn(binary, ['--state', path.join(root, 'body_state.json'), '--event-store', path.join(root, 'event_store'),
    '--checkpoint-path', path.join(root, 'checkpoint.json'), '--health-bind', '127.0.0.1:' + port, '--local-only', '--forever', '--cycle-sleep-ms', '1000'], {
    cwd: project, windowsHide: true,
    env: { ...process.env, MEMORY_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_STRICT_OFFLINE: 'true', MEMORY_CHAT_PREFER_ENV: 'true', MEMORY_CHAT_API_MODE: 'local_only',
      MEMORY_CHAT_CONFIG_PATH: '', MEMORY_CHAT_API_KEY: '', OPENAI_API_KEY: '', MEMORY_AUTONOMOUS_LEARNING_ENABLED: 'false', MEMORY_AUTONOMOUS_RESEARCH_ENABLED: 'false',
      AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED: 'false', MEMORY_API_RBAC: 'true', MEMORY_API_OPERATOR_TOKEN: token, MEMORY_API_ADMIN_TOKEN: '', MEMORY_API_VIEWER_TOKEN: '' } });
  child.log = '';
  child.stdout.on('data', data => { child.log = (child.log + data).slice(-20000); });
  child.stderr.on('data', data => { child.log = (child.log + data).slice(-20000); });
  return child;
}
async function ready(child, settings, token) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error('core exited: ' + child.log.slice(-3000));
    try { await coreRequest(settings, token, '/api/v1/memory/state'); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('core not ready: ' + child.log.slice(-3000));
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-core-link-real-'));
  const port = await freePort();
  const token = 'memory-link-' + randomUUID();
  const settings = { coreUrl: 'http://127.0.0.1:' + port };
  const link = { request: (route, body, { timeoutMs = 8000 } = {}) => coreRequest(settings, token, route, { body, signal: AbortSignal.timeout(timeoutMs) }) };
  const memoryDir = path.join(root, 'assistant-memory');
  const checks = {};
  let core = null;
  try {
    // 1. An assistant that has only ever had local memory.
    await memory.init(memoryDir);
    memory.addMemory({ kind: 'preference', text: 'Bybit 广场发帖前先给用户过目', pinned: true });
    memory.addMemory({ kind: 'fact', text: '用户的猫叫豆豆' });
    memory.addPlaybook({ title: 'Bybit 广场发帖', trigger: 'Bybit 发帖', steps: ['打开 Bybit 广场', '粘贴已确认的文案', '发布后截图留证'] });
    await memory.setProfile('## 基本情况\n- 运营 Bybit 账号，每天发帖');
    await memory.recordTurn({ session: 'old', user: '你来给我日常维护 Bybit 发帖', assistant: '好的，我先看看账户' });
    await memory.recordTrajectory({ kind: 'chat', id: 'old-1', user: '发帖', steps: [] });
    memory.saveRequirements([{ text: '每篇帖子不超过 300 字', domain: 'writing' }], { source: 'user' });
    await memory.flush();

    // 2. Core comes up; first contact moves everything in.
    core = startCore(path.join(root, 'core'), port, token);
    await ready(core, settings, token);
    await memory.init(memoryDir, { core: link });
    const status = await memory.sync();
    assert.equal(status.online, true, status.error);
    assert.equal(status.pending, 0);
    const view = await coreRequest(settings, token, '/api/v1/memory/state');
    assert.deepEqual(view.memories.map(item => item.text).sort(), ['Bybit 广场发帖前先给用户过目', '用户的猫叫豆豆'].sort());
    assert.equal(view.playbooks[0].title, 'Bybit 广场发帖');
    assert.match(view.profile, /运营 Bybit 账号/);
    assert.equal(view.stats.turns, 1);
    assert.equal(view.has_requirements, true);
    checks.migration = { memories: view.memories.length, playbooks: view.playbooks.length, turns: view.stats.turns, requirements: view.has_requirements, revision: view.revision };

    // 3. The core assembles the context.
    const context = await memory.prepareContext('今天 Bybit 发帖', { goals: [{ title: '写周报', done: false }], session: 'now' });
    assert.equal(context.source, 'core');
    assert.match(context.text, /Bybit 广场发帖前先给用户过目/);
    assert.match(context.text, /经验手册[\s\S]*Bybit 广场发帖/);
    assert.match(context.text, /写周报/);
    assert.doesNotMatch(context.text, /豆豆/);
    const recall = await memory.searchAsync('豆豆');
    assert.equal(recall.memories[0].text, '用户的猫叫豆豆');
    checks.context = { source: context.source, length: context.text.length, used: context.used.memories.length };

    // 4. Changes made while the core is down are queued and handed over after it restarts.
    await stop(core);
    memory.addMemory({ kind: 'habit', text: '用户习惯晚上九点看数据' });
    await memory.recordTurn({ session: 'now', user: '以后晚上九点给我看数据', assistant: '记住了' });
    const offline = await memory.sync();
    assert.equal(offline.online, false);
    assert.ok(offline.pending >= 2);
    const fallback = await memory.prepareContext('晚上看数据', {});
    assert.equal(fallback.source, 'local');
    core = startCore(path.join(root, 'core'), port, token);
    await ready(core, settings, token);
    const back = await memory.sync();
    assert.equal(back.online, true, back.error);
    assert.equal(back.pending, 0);
    const after = await coreRequest(settings, token, '/api/v1/memory/state');
    assert.ok(after.memories.some(item => item.text === '用户习惯晚上九点看数据'));
    assert.equal(after.stats.turns, 2);
    assert.match(after.profile, /运营 Bybit 账号/);
    checks.restart = { revision: after.revision, memories: after.memories.length, turns: after.stats.turns };

    // 5. Existing assistant routes keep working on the same core, and writes need the operator token.
    const profile = await coreRequest(settings, token, '/api/v1/assistant/profile');
    assert.equal(profile.ok, true);
    await assert.rejects(coreRequest(settings, '', '/api/v1/memory/apply', { body: { ops: [] } }), /401|403/);
    checks.assistantRoutes = { profile: true, unauthenticatedWriteRejected: true };

    const files = await fs.readdir(path.join(root, 'core', 'user_memory'));
    assert.ok(files.includes('state.json') && files.includes('turns.jsonl') && files.includes('requirements.json'));
    const result = { passed: true, binary, isolatedRuntime: root, checks, storedFiles: files.sort(), noPaidRequests: true, at: new Date().toISOString() };
    await fs.mkdir(path.join(__dirname, '../output'), { recursive: true });
    await fs.writeFile(path.join(__dirname, '../output/memory-core-link.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (core) await stop(core);
    await memory.flush();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 200));
