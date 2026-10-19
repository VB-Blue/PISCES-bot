const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { coreRequest, validateTurn, readReceipt, userId } = require('../electron/core-client.cjs');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-core-connection-'));
  const portFinder = net.createServer();
  await new Promise(resolve => portFinder.listen(0, '127.0.0.1', resolve));
  const port = portFinder.address().port;
  await new Promise(resolve => portFinder.close(resolve));
  const token = 'isolated-core-test-' + randomUUID();
  const settings = { coreUrl: 'http://127.0.0.1:' + port };
  const project = process.env.MEMORY_CORE_PROJECT_DIR || 'D:\\记忆体';
  const child = spawn(process.env.MEMORY_TEST_CORE_BINARY || path.join(project, 'target/release/autonomous_node.exe'), [
    '--state', path.join(root, 'body_state.json'), '--event-store', path.join(root, 'event_store'),
    '--checkpoint-path', path.join(root, 'checkpoint.json'), '--health-bind', '127.0.0.1:' + port,
    '--local-only', '--forever', '--cycle-sleep-ms', '1000'], {
    cwd: project, windowsHide: true,
    env: { ...process.env, MEMORY_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_STRICT_OFFLINE: 'true', MEMORY_CHAT_PREFER_ENV: 'true',
      MEMORY_CHAT_API_MODE: 'local_only', MEMORY_CHAT_CONFIG_PATH: '', MEMORY_CHAT_API_KEY: '', OPENAI_API_KEY: '',
      MEMORY_AUTONOMOUS_LEARNING_ENABLED: 'false', MEMORY_AUTONOMOUS_RESEARCH_ENABLED: 'false', AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED: 'false',
      MEMORY_API_RBAC: 'true', MEMORY_API_OPERATOR_TOKEN: token, MEMORY_API_ADMIN_TOKEN: '', MEMORY_API_VIEWER_TOKEN: '' },
  });
  let log = '';
  child.stdout.on('data', data => { log = (log + data.toString()).slice(-30000); });
  child.stderr.on('data', data => { log = (log + data.toString()).slice(-30000); });
  child.on('error', error => { log += error.message; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error('测试核心退出：' + log.slice(-3000));
      try { await coreRequest(settings, token, '/api/v1/health'); ready = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(ready, true, '真实核心未就绪：' + log.slice(-3000));
    await assert.rejects(coreRequest(settings, '', '/api/v1/health'), /401/);
    const session = randomUUID();
    const receipts = [];
    for (const message of ['你好', '我想先查看现有方法，再决定怎样整理文件。']) {
      const input = { id: randomUUID(), session, message };
      const payload = await coreRequest(settings, token, '/api/v1/chat', { body: validateTurn(input), signal: AbortSignal.timeout(20000) });
      assert.equal(payload.response.llm_invoked, false);
      const receipt = readReceipt(payload, input);
      assert.ok(receipt.reply.length); assert.equal(receipt.desktop, null); receipts.push(receipt.turnId);
    }
    const history = await coreRequest(settings, token, '/api/v1/chat/history?user_id=' + userId + '&session=' + session + '&limit=100');
    assert.equal(history.items.length, 4);
    const sessions = await coreRequest(settings, token, '/api/v1/chat/sessions?user_id=' + userId + '&limit=40');
    assert.ok(sessions.items.some(item => item.session === session));
    const learning = await coreRequest(settings, token, '/api/v1/expert/operator/state');
    assert.equal(learning.ok, true);
    assert.equal(learning.pending_trace_ingestions.length, 0);
    const desktopExecutable = process.env.MEMORY_TEST_DESKTOP_EXE || path.join(__dirname, '../node_modules/electron/dist/electron.exe');
    const desktopArgs = process.env.MEMORY_TEST_DESKTOP_EXE ? ['--core-smoke'] : ['.', '--core-smoke'];
    const desktop = spawn(desktopExecutable, desktopArgs, { cwd: path.resolve(__dirname, '..'), windowsHide: true, env: { ...process.env, MEMORY_TEST_CORE_URL: settings.coreUrl, MEMORY_TEST_CORE_TOKEN: token, MEMORY_SMOKE_OUTPUT_DIR: path.resolve(__dirname, '../output/real-core') } });
    let desktopOutput = ''; desktop.stdout.on('data', data => { desktopOutput += data; }); desktop.stderr.on('data', data => { desktopOutput += data; });
    const desktopCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { desktop.kill(); reject(new Error('桌面到真实核心测试超时')); }, 30000);
      desktop.on('error', error => { clearTimeout(timer); reject(error); });
      desktop.on('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(desktopCode, 0, desktopOutput);
    assert.ok(desktopOutput.includes('real-core-passed'), desktopOutput);
    const result = { passed: true, binary: 'autonomous_node.exe', desktopExecutable, rendererToCanonicalSubject: true, isolatedRuntime: root, canonicalTurnIds: receipts, sharedHistoryMessages: 4, editableProfile: true, authorizationEnforced: true, noPaidRequests: true, noDesktopActions: true, ordinaryChatNotSubmittedAsOperator: true };
    await fs.mkdir(path.join(__dirname, '../output'), { recursive: true });
    await fs.writeFile(path.join(__dirname, '../output/core-connection.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    child.kill();
    await fs.writeFile(path.join(root, 'test-console.log'), log);
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
