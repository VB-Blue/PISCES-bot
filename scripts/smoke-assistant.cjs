const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { coreRequest } = require('../electron/core-client.cjs');
const { runAssistant } = require('../electron/assistant-worker.cjs');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-assistant-learning-'));
  const finder = net.createServer(); await new Promise(resolve => finder.listen(0, '127.0.0.1', resolve));
  const port = finder.address().port; await new Promise(resolve => finder.close(resolve));
  const token = 'assistant-test-' + randomUUID();
  const settings = { coreUrl: 'http://127.0.0.1:' + port };
  const project = 'D:\\记忆体';
  const binary = process.env.MEMORY_TEST_CORE_BINARY || path.join(project, 'target/release/autonomous_node.exe');
  const child = spawn(binary, ['--state', path.join(root, 'body_state.json'), '--event-store', path.join(root, 'event_store'), '--checkpoint-path', path.join(root, 'checkpoint.json'), '--health-bind', '127.0.0.1:' + port, '--local-only', '--forever', '--cycle-sleep-ms', '50'], {
    cwd: project, windowsHide: true, env: { ...process.env, MEMORY_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_STRICT_OFFLINE: 'true', MEMORY_CHAT_PREFER_ENV: 'true', MEMORY_CHAT_API_MODE: 'local_only', MEMORY_CHAT_CONFIG_PATH: '', MEMORY_CHAT_API_KEY: '', OPENAI_API_KEY: '', MEMORY_AUTONOMOUS_LEARNING_ENABLED: 'false', MEMORY_AUTONOMOUS_RESEARCH_ENABLED: 'false', AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED: 'false', MEMORY_API_RBAC: 'true', MEMORY_API_OPERATOR_TOKEN: token, MEMORY_API_ADMIN_TOKEN: '', MEMORY_API_VIEWER_TOKEN: '' },
  });
  let log = '', paidCalls = 0, executorCalls = 0;
  child.stdout.on('data', data => { log = (log + data).slice(-20000); }); child.stderr.on('data', data => { log = (log + data).slice(-20000); });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); paidCalls++;
    assert.ok(!JSON.stringify(body).includes(token), 'core credentials must never reach a provider');
    assert.ok(body.messages[0].content.includes('简短回答'));
    let message = { role: 'assistant', content: '规划读取文本并校验清单。' };
    if (body.messages[0].content.includes('当前角色：executor')) {
      executorCalls++;
      const name = executorCalls === 2 ? 'read_file' : 'write_inventory';
      if (executorCalls === 2) assert.ok(body.messages.at(-1).content.includes('read_all_files_first'), 'real failure must reach the next model call');
      message = executorCalls <= 3 ? { role: 'assistant', content: '', tool_calls: [{ id: 'call-' + executorCalls, type: 'function', function: { name, arguments: name === 'read_file' ? '{"file_id":"file_0"}' : '{}' } }] } : { role: 'assistant', content: '清单已经生成；请查看核心文件校验回执。' };
    }
    if (body.messages[0].content.includes('当前角色：verifier')) { assert.equal(body.tools, undefined); assert.ok(body.messages.at(-1).content.includes('host_readback_and_input_hashes')); message.content = '文件字节与清单经核心校验，其他自然语言事实未验证。'; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { total_tokens: 19 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = body => coreRequest(settings, token, '/api/v1/assistant/request', { body, signal: AbortSignal.timeout(30000) });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error(log); try { await coreRequest(settings, token, '/api/v1/assistant/profile'); ready = true; break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(ready, log);
    await assert.rejects(coreRequest(settings, '', '/api/v1/assistant/profile'), /401/);
    const { profile } = await coreRequest(settings, token, '/api/v1/assistant/profile');
    const saved = await api({ action: 'save_profile', expected_revision: profile.revision, display_name: '验收用户', preferences: '简短回答', goals: '真实可检查的文件任务', boundaries: '只处理本轮选中的文件' });
    assert.equal(saved.profile.user_id, profile.user_id);
    await assert.rejects(api({ action: 'save_profile', expected_revision: profile.revision, display_name: 'stale', preferences: '', goals: '', boundaries: '' }), /409/);
    const input = path.join(root, 'teacher-input.txt'); await fs.writeFile(input, 'teacher source\n');
    const id = randomUUID();
    const { work } = await api({ action: 'create_work', id, session: randomUUID(), goal: '生成已选文件清单与校验', files: [input], multi_agent: true });
    const result = await runAssistant({ settings: { ...settings, endpoint: 'http://127.0.0.1:' + server.address().port, model: 'local-test-teacher' }, apiKey: '', core: api, work, messages: [{ role: 'user', content: work.goal }], signal: new AbortController().signal, emit: () => {} });
    assert.equal(result.work.status, 'verified'); assert.equal(result.work.receipts[0].status, 'failed'); assert.equal(result.work.receipts[0].error, 'read_all_files_first');
    assert.equal(result.work.calls.length, 6); assert.equal(result.usage.total_tokens, 114);
    let state = await coreRequest(settings, token, '/api/v1/assistant/state'); assert.equal(state.methods.length, 1); assert.equal(state.methods[0].status, 'candidate');
    const methodId = state.methods[0].id; const frozenCalls = paidCalls;
    const independentIds = [];
    for (const contents of [['new input B\n'], ['new input C\n', 'another file D\n']]) {
      const files = [];
      for (const content of contents) { const file = path.join(root, 'new-' + randomUUID() + '.txt'); await fs.writeFile(file, content); files.push(file); }
      const id = randomUUID(); await api({ action: 'create_work', id, session: randomUUID(), goal: '生成新文件清单和校验', files, multi_agent: false });
      const replay = await api({ action: 'replay', work_id: id, method_id: methodId });
      assert.equal(replay.work.status, 'verified'); assert.equal(replay.work.calls.length, 0); independentIds.push(id);
      const receipt = replay.work.receipts.at(-1); const artifact = JSON.parse(await fs.readFile(receipt.evidence.path, 'utf8'));
      assert.equal(artifact.entries.length, contents.length);
      contents.forEach((content, index) => { assert.equal(artifact.entries[index].bytes, Buffer.byteLength(content)); assert.equal(artifact.entries[index].sha256, require('node:crypto').createHash('sha256').update(content).digest('hex')); });
    }
    state = await coreRequest(settings, token, '/api/v1/assistant/state'); assert.equal(paidCalls, frozenCalls); assert.equal(state.methods[0].status, 'verified'); assert.equal(state.methods[0].independent_inputs.length, 3); assert.equal(state.methods[0].replay_sources.length, 2);
    const unknown = randomUUID(); await api({ action: 'create_work', id: unknown, session: randomUUID(), goal: '生成清单', files: [input], multi_agent: false });
    await assert.rejects(api({ action: 'replay', work_id: unknown, method_id: randomUUID() }), /409/);
    // Verify ownership durability, not merely a desktop-local learning count.
    const owner = JSON.parse(await fs.readFile(path.join(root, 'unified_subject_aggregate_owner.json'), 'utf8'));
    assert.equal(owner.assistant.profile.preferences, '简短回答'); assert.equal(owner.assistant.methods[0].status, 'verified'); assert.ok(owner.canonical_subject);
    const report = { passed: true, isolatedRuntime: root, binary, localTeacherCalls: paidCalls, externalPaidCalls: 0, profileBoundToSubject: true, roleSeparation: true, realFailure: 'read_all_files_first', correctedByTeacher: true, persistedExecutableMethod: methodId, independentReplayWorks: independentIds, independentModelCalls: 0, inputGroups: 3, domain: 'selected_utf8_file_inventory_sha256', generalIntelligenceProven: false };
    await fs.mkdir(path.join(__dirname, '../output'), { recursive: true }); await fs.writeFile(path.join(__dirname, '../output/assistant-learning.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.writeFile(path.join(root, 'test-console.log'), log); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
