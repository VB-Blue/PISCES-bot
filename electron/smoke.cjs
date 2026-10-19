const assert = require('node:assert/strict');
const http = require('node:http');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function captureOffscreenFrame(window) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); window.webContents.removeListener('paint', paint); };
    const paint = (_event, _dirtyRect, image) => {
      if (!image || image.isEmpty()) return;
      stop();
      resolve(image.toPNG());
    };
    const timer = setTimeout(() => { stop(); reject(new Error('桌面离屏重绘超时')); }, 5000);
    window.webContents.on('paint', paint);
    window.webContents.invalidate();
  });
}

async function waitFor(window, expression, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('桌面界面等待超时');
}

async function runSmoke(window, { appPath, userData }) {
  await waitFor(window, `document.querySelector('.presence-home') !== null && typeof window.memoryDesktop?.settings === 'function'`);
  const output = path.join(appPath, 'output', 'playwright');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'desktop.png'), await captureOffscreenFrame(window));
  const ownerProfile = { user_id: 'owner-' + randomUUID(), revision: 0, display_name: '', preferences: '', goals: '', boundaries: '', source: 'unconfigured' };
  const works = new Map();
  const seen = [];
  const coreSeen = [];
  const syntheticKey = 'smoke-test-not-a-real-secret';
  const syntheticCoreToken = 'core-token-only-not-a-real-secret';
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/v1/assistant/profile') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, profile: ownerProfile })); return; }
    if (req.url === '/api/v1/assistant/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, profile: ownerProfile, works: [...works.values()], methods: [] })); return; }
    if (req.url === '/api/v1/assistant/request') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString());
      let output = { ok: true };
      if (body.action === 'create_work') { const work = { id: body.id, goal: body.goal, profile_snapshot: ownerProfile, files: [], calls: [], receipts: [], roles: ['executor'], status: 'running' }; works.set(body.id, work); output.work = work; }
      if (body.action === 'reserve_call') { const call = { id: randomUUID(), role: body.role }; works.get(body.work_id).calls.push(call); output.call = call; }
      if (body.action === 'finish') { const work = works.get(body.work_id); work.status = body.status === 'finished' ? 'advice_only' : body.status; work.result = body.result; output.work = work; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(output)); return;
    }
    if (req.url === '/api/v1/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"source":"local-smoke"}'); return; }
    if (req.url === '/api/v1/desktop/control/log?limit=20') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"items":[],"source":"local-smoke"}'); return; }
    if (req.url === '/api/v1/chat') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); coreSeen.push({ body, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, response: { turn_id: body.message === 'receipt-mismatch' ? randomUUID() : body.turn_id,
        session: body.session, user_id: body.user_id, reply: '本地主体已接收当前对话。', reply_mode: 'grounded_local_dialogue',
        decision_subject: 'unified_wisdom_subject', reply_provider: 'local_subject', llm_invoked: false,
        chat_cognitive_summary: { evidence_refs: ['mock-turn:' + body.turn_id] },
        ...(body.desktop ? { desktop_task: { ok: true, execution: 'preview', simulated: true } } : {}) } })); return;
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ body, auth: req.headers.authorization });
    if (body.messages.at(-1)?.content === 'provider-failure') { res.writeHead(503); res.end('test-provider-down'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (body.messages.at(-1)?.content === 'cancel-smoke') { res.write(': waiting\n\n'); req.on('close', () => res.end()); return; }
    const first = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '这是本机' } }] }) + '\n\n';
    // Exercise boundaries inside JSON records, without making any external request.
    res.write(first.slice(0, 18));
    res.write(first.slice(18));
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '模拟服务回复。' }, finish_reason: 'stop' }], usage: { total_tokens: 17 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const run = expression => window.webContents.executeJavaScript(expression);
    const save = value => run(`window.memoryDesktop.saveSettings(${JSON.stringify(value)})`);
    const type = value => run(`(() => { const input = document.querySelector('textarea[aria-label="输入消息"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const publicSettings = await save({ endpoint: base + '/v1', model: 'local-smoke', apiKey: syntheticKey, coreUrl: base, coreToken: syntheticCoreToken });
    assert.equal(publicSettings.hasApiKey, true);
    assert.equal(JSON.stringify(publicSettings).includes(syntheticKey), false);
    assert.equal((await readFile(path.join(userData, 'connection.json'), 'utf8')).includes(syntheticKey), false);
    assert.equal((await run('window.memoryDesktop.coreStatus()')).data.source, 'local-smoke');
    assert.deepEqual((await run('window.memoryDesktop.controlLog()')).data.items, []);
    await window.reload();
    await waitFor(window, `document.querySelector('.app')?.dataset.aiReady === 'true'`);
    await require('./smoke-chat.cjs').openSmokeChat(window);
    await waitFor(window, `document.querySelector('textarea[aria-label="输入消息"]') !== null`);
    await type('本机连接测试');
    await waitFor(window, `!document.querySelector('button[aria-label="发送消息"]').disabled`);
    await run(`document.querySelector('button[aria-label="发送消息"]').click()`);
    await waitFor(window, `document.body.innerText.includes('这是本机模拟服务回复。')`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, 'Bearer ' + syntheticKey);
    assert.equal(seen[0].body.messages.at(-1).content, '本机连接测试');
    assert.equal(JSON.stringify(seen[0].body).includes(syntheticCoreToken), false);

    // The current daily AI path is local-agent based. Validate canonical receipts separately on the core-only path.
    await save({ endpoint: '', model: '', coreUrl: base });
    const beforeCoreOnly = seen.length;
    const coreOnly = await run(`window.memoryDesktop.assistantChat(${JSON.stringify({ id: randomUUID(), session: randomUUID(), messages: [{ role: 'user', content: '读取核心回执' }] })})`);
    assert.equal(coreOnly.source, 'core');
    assert.equal(coreOnly.core.learned, false);
    assert.equal(coreOnly.core.factualVerification, 'unverified');
    assert.equal(seen.length, beforeCoreOnly, '核心读取不应调用模型');
    assert.equal(coreSeen.at(-1).auth, 'Bearer ' + syntheticCoreToken);
    const rejected = await run(`window.memoryDesktop.assistantChat(${JSON.stringify({ id: randomUUID(), session: randomUUID(), messages: [{ role: 'user', content: 'receipt-mismatch' }] })}).then(() => 'unexpected-success', error => error.message)`);
    assert.ok(rejected.includes('不一致'));
    assert.equal(seen.length, beforeCoreOnly);
    const desktop = await run(`window.memoryDesktop.desktopTask(${JSON.stringify({ id: randomUUID(), session: randomUUID(), instruction: '点击文件菜单', execute: false })})`);
    assert.equal(desktop.desktop.execution, 'preview');
    assert.equal(coreSeen.at(-1).body.desktop.execute, false);

    await save({ endpoint: base + '/v1', model: 'local-smoke', coreUrl: 'http://127.0.0.1:9' });
    const fallback = await run(`window.memoryDesktop.assistantChat(${JSON.stringify({ id: randomUUID(), session: randomUUID(), messages: [{ role: 'user', content: '核心离线时仍可对话' }] })})`);
    assert.equal(fallback.source, 'ai');
    assert.equal(fallback.core, null);
    await run(`(() => { window.cancelCheck = window.memoryDesktop.chat({ id: 'cancel-smoke', messages: [{ role: 'user', content: 'cancel-smoke' }] }).then(() => 'unexpected-success', () => 'cancelled'); })()`);
    await new Promise(resolve => setTimeout(resolve, 120));
    await run(`window.memoryDesktop.cancelChat('cancel-smoke')`);
    assert.equal(await run('window.cancelCheck'), 'cancelled');

    await window.reload();
    await waitFor(window, `document.querySelector('.app')?.dataset.aiReady === 'true'`);
    await require('./smoke-chat.cjs').openSmokeChat(window);
    await waitFor(window, `document.querySelector('textarea[aria-label="输入消息"]') !== null`);
    await type('provider-failure');
    await waitFor(window, `!document.querySelector('button[aria-label="发送消息"]').disabled`);
    await run(`document.querySelector('button[aria-label="发送消息"]').click()`);
    await waitFor(window, `document.body.innerText.includes('回复未完成')`, 15000);
    await waitFor(window, `JSON.parse(localStorage.getItem('memory-desktop-workspace-v1'))?.sessions[0].messages.at(-1)?.error === true`);
    const failed = await run(`JSON.parse(localStorage.getItem('memory-desktop-workspace-v1')).sessions[0].messages.at(-1)`);
    assert.equal(failed.error, true);
    assert.equal(failed.core, undefined, '直接 AI 路径不能显示虚构核心回执');
    return { smoke: 'passed', nativeBridge: true, encryptedCredentials: true, mockAIStreaming: true, receiptValidationOnCorePath: true, coreOnlyWithoutProvider: true, desktopPreviewBridge: true, chatCancellation: true, coreOfflineKeepsAIWorking: true, providerFailureRecorded: true, recordedIsNotLearned: true, noPaidRequests: true, screenshot: path.join(output, 'desktop.png') };
  } catch (error) {
    await writeFile(path.join(output, 'native-failure.png'), (await window.webContents.capturePage()).toPNG());
    error.message += ' | 页面: ' + await window.webContents.executeJavaScript('document.body.innerText.slice(0, 1600)');
    error.message += ' | 保存状态: ' + await window.webContents.executeJavaScript(`JSON.stringify(JSON.parse(localStorage.getItem('memory-desktop-workspace-v1'))?.sessions.map(session => ({ title: session.title, messages: session.messages.map(message => ({ role: message.role, error: message.error, tail: message.content.slice(-60) })) })))`);
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
async function runCoreSmoke(window, { appPath }) {
  const coreUrl = process.env.MEMORY_TEST_CORE_URL;
  const coreToken = process.env.MEMORY_TEST_CORE_TOKEN;
  if (!coreUrl || !coreToken) throw new Error('真实核心测试必须提供隔离核心地址与测试令牌');
  await waitFor(window, `typeof window.memoryDesktop?.settings === 'function'`);
  await window.webContents.executeJavaScript(`window.memoryDesktop.saveSettings(${JSON.stringify({ endpoint: '', model: '', coreUrl, coreToken })})`);
  await window.reload();
  await waitFor(window, `document.querySelector('.presence-home') !== null`);
  await window.webContents.executeJavaScript(`(() => { const input = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '你好，我想先查看核心的会话记录。'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(window, `!document.querySelector('button[aria-label="发送消息"]').disabled`);
  await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="发送消息"]').click()`);
  await waitFor(window, `(() => { const state = JSON.parse(localStorage.getItem('memory-desktop-workspace-v1')); return state?.sessions[0].messages.at(-1)?.source === 'core'; })()`, 15000);
  const state = await window.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('memory-desktop-workspace-v1'))`);
  assert.equal(state.sessions[0].messages.at(-1).error, undefined);
  assert.equal(state.sessions[0].messages.at(-1).core.subject, 'unified_wisdom_subject');
  const session = state.sessions[0].id;
  const history = await window.webContents.executeJavaScript(`window.memoryDesktop.coreHistory(${JSON.stringify(session)})`);
  assert.equal(history.items.length, 2);
  assert.equal(history.items.at(-1).content, state.sessions[0].messages.at(-1).content);
  await window.webContents.executeJavaScript(`document.querySelector('.core-receipt').open = true`);
  const output = path.join(appPath, 'output', 'playwright'); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'desktop-real-core.png'), await captureOffscreenFrame(window));
  const assistant = await window.webContents.executeJavaScript('window.memoryDesktop.assistantState()');
  assert.ok(assistant.profile.user_id); assert.deepEqual(assistant.methods, []);
  const saved = await window.webContents.executeJavaScript(`window.memoryDesktop.saveProfile(${JSON.stringify({ ...assistant.profile, display_name: '界面验收用户', preferences: '简洁且给出证据' })})`);
  assert.equal(saved.profile.preferences, '简洁且给出证据');
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.nav-item')).find(button => button.innerText.includes('关于你')).click()`);
  await waitFor(window, `Array.from(document.querySelectorAll('.page-tabs button')).some(button => button.innerText.includes('档案与会话'))`);
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.page-tabs button')).find(button => button.innerText.includes('档案与会话')).click()`);
  await waitFor(window, `document.querySelector('textarea[aria-label="工作习惯与表达偏好"]')?.value === '简洁且给出证据'`);
  await writeFile(path.join(output, 'desktop-profile.png'), await captureOffscreenFrame(window));
  return { smoke: 'real-core-passed', rendererToCanonicalSubject: true, sharedHistory: true, turnId: state.sessions[0].messages.at(-1).core.turnId, noPaidRequests: true, noDesktopActions: true };
}
module.exports = { runSmoke, runCoreSmoke };
