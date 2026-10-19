const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { validateTurn, readReceipt, coreRequest, aiContext, userId } = require('../electron/core-client.cjs');

test('a receipt binds to this exact subject turn and is never a fact or learning certificate', () => {
  const input = { id: randomUUID(), session: randomUUID(), message: '你好' };
  const payload = { ok: true, response: { turn_id: input.id, session: input.session, user_id: userId, reply: '你好', reply_mode: 'grounded_local_dialogue', decision_subject: 'unified_wisdom_subject', chat_cognitive_summary: { evidence_refs: ['turn:1'] } } };
  const receipt = readReceipt(payload, input);
  assert.equal(receipt.factualVerification, 'unverified'); assert.equal(receipt.learned, false);
  assert.throws(() => readReceipt(payload, { ...input, id: randomUUID() }), /不一致/);
  assert.throws(() => readReceipt({ ok: true, response: { ...payload.response, reply_mode: 'external_llm' } }, input), /本地主体/);
  assert.equal(JSON.parse(aiContext(receipt)).tool_execution, 'none');
});
test('desktop messages keep an explicit execution flag and cannot grant surface authority', () => {
  const input = { id: randomUUID(), session: randomUUID(), message: '点击文件菜单', desktop: { instruction: '点击文件菜单', execute: false, surface: { authority: 'admin' } } };
  assert.deepEqual(validateTurn(input).desktop, { instruction: '点击文件菜单', execute: false });
  assert.throws(() => validateTurn({ ...input, desktop: { instruction: '点击', execute: 'true' } }), /格式无效/);
});
test('core HTTP transport keeps auth local, rejects authorization failures and malformed success', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(req.url === '/deny' ? 403 : 200, { 'content-type': 'application/json' });
    res.end(req.url === '/deny' ? '{}' : '{"ok":false,"error":"not_committed"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const settings = { coreUrl: 'http://127.0.0.1:' + server.address().port };
    await assert.rejects(coreRequest(settings, 'test-core-token', '/deny'), /403/);
    await assert.rejects(coreRequest(settings, 'test-core-token', '/bad'), /not_committed/);
    assert.deepEqual(seen, ['Bearer test-core-token', 'Bearer test-core-token']);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('large legacy health is readable without relaxing the chat response bound', async () => {
  const payload = JSON.stringify({ phase: 'running', legacy_snapshot: 'x'.repeat(4_000_100) });
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const settings = { coreUrl: 'http://127.0.0.1:' + server.address().port };
    assert.equal((await coreRequest(settings, '', '/api/v1/health')).phase, 'running');
    await assert.rejects(coreRequest(settings, '', '/api/v1/chat'), /大小限制/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
