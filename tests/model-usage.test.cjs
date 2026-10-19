const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createUsageLedger, withUsage, normalizeUsage, assertBackgroundTaskAllowed } = require('../electron/model-usage.cjs');
const { modelResponse } = require('../electron/assistant-worker.cjs');
const { extract } = require('../electron/learner.cjs');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisces-usage-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('pisces-usage-')); fs.rmSync(dir, { recursive: true, force: true }); });
  const ledger = createUsageLedger({ dir, timeZone: 'UTC', ...options }); ledger.init();
  return { ledger, dir };
}
const request = { model: 'test-model', max_tokens: 1000, messages: [{ role: 'user', content: 'private document content' }] };
const begin = ledger => ledger.begin({ settings: { model: 'test-model' }, role: 'executor', request, scope: { scopeId: 'goal-a', runId: 'round-a' } });

test('all pending calls reserve the shared daily allowance before dispatch', t => {
  const { ledger } = fixture(t); ledger.setPolicy({ dailyTokenLimit: 2000 });
  const one = begin(ledger), two = begin(ledger);
  assert.ok(two.maxOutputTokens < one.maxOutputTokens);
  assert.ok(ledger.summary().reservedTokens <= 2000);
  assert.throws(() => begin(ledger), { code: 'TOKEN_BUDGET_EXCEEDED' });
  one.finish({ usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 } });
  const three = begin(ledger); assert.ok(three.maxOutputTokens > 0);
  assert.ok(ledger.summary().accountedTokens <= 2000);
});

test('restart retains unreported and interrupted charges, without charging twice', t => {
  const { ledger, dir } = fixture(t); ledger.setPolicy({ dailyTokenLimit: 1500 });
  begin(ledger);
  const restarted = createUsageLedger({ dir, timeZone: 'UTC' }); restarted.init();
  assert.equal(restarted.summary().reservedTokens, 0);
  assert.equal(restarted.summary().unknownCalls, 1);
  assert.ok(restarted.summary().estimatedTokens > 1000);
  assert.throws(() => begin(restarted), { code: 'TOKEN_BUDGET_EXCEEDED' });
  const again = createUsageLedger({ dir, timeZone: 'UTC' }); again.init();
  assert.equal(again.summary().accountedTokens, restarted.summary().accountedTokens);
});

test('known usage replaces a reservation; missing usage is explicit and retained', t => {
  const { ledger } = fixture(t);
  const one = begin(ledger); one.finish({ usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
  const two = begin(ledger); two.finish();
  const result = ledger.summary('goal-a');
  assert.equal(result.reportedTokens, 50); assert.equal(result.unknownCalls, 1);
  assert.ok(result.estimatedTokens > 1000); assert.equal(result.reservedTokens, 0);
  one.finish({ usage: { total_tokens: 9999 } });
  assert.equal(ledger.summary().reportedTokens, 50);
  const raw = fs.readFileSync(ledger.file, 'utf8');
  assert.ok(!raw.includes('private document content'));
});

test('a torn ledger fails closed and cannot be bypassed by saving a new policy', t => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'model-usage.jsonl'), '{"type":"begin"');
  const ledger = createUsageLedger({ dir, timeZone: 'UTC' });
  assert.throws(() => ledger.init(), { code: 'USAGE_PERSISTENCE_FAILED' });
  assert.throws(() => ledger.setPolicy({ dailyTokenLimit: 0 }), { code: 'USAGE_PERSISTENCE_FAILED' });
  assert.throws(() => begin(ledger), { code: 'USAGE_PERSISTENCE_FAILED' });
});

test('a ledger write failure remains blocked after storage recovers, until a clean reload', t => {
  const { dir, ledger } = fixture(t);
  fs.mkdirSync(ledger.file);
  assert.throws(() => begin(ledger), { code: 'USAGE_PERSISTENCE_FAILED' });
  assert.equal(path.dirname(ledger.file), dir); fs.rmdirSync(ledger.file);
  assert.throws(() => ledger.setPolicy({ dailyTokenLimit: 0 }), { code: 'USAGE_PERSISTENCE_FAILED' });
  assert.throws(() => begin(ledger), { code: 'USAGE_PERSISTENCE_FAILED' });
  const reloaded = createUsageLedger({ dir, timeZone: 'UTC' }); reloaded.init();
  begin(reloaded).finish({ usage: { total_tokens: 20 } }); assert.equal(reloaded.summary().reportedTokens, 20);
});

test('daily reset follows the recorded time zone; round allowances remain enforced', t => {
  let current = Date.parse('2026-10-14T23:59:00Z');
  const { ledger } = fixture(t, { now: () => current }); ledger.setPolicy({ dailyTokenLimit: 1500 });
  begin(ledger).finish({ usage: { total_tokens: 1400 } });
  assert.throws(() => begin(ledger), { code: 'TOKEN_BUDGET_EXCEEDED' });
  current += 120000; assert.equal(ledger.summary().accountedTokens, 0);
  assert.throws(() => ledger.begin({ settings: {}, role: 'planner', request, scope: { scopeId: 'goal-a', runId: 'round-a', runTokenLimit: 1500 } }), error => error.code === 'TOKEN_BUDGET_EXCEEDED' && error.budgetKind === 'round');
  assert.throws(() => ledger.setPolicy({ dailyTokenLimit: 1000, timeZone: 'Asia/Singapore' }), /时区/);
});

test('input/output details and reasoning are not double counted', () => {
  const result = normalizeUsage({ input_tokens: 100, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 }, input_tokens_details: { cached_tokens: 40 } });
  assert.equal(result.totalTokens, 130); assert.equal(result.reasoningTokens, 20); assert.equal(result.cachedTokens, 40);
  assert.equal(normalizeUsage({}).totalTokens, null);
});

test('a goal and its delegated contexts cannot escape into an unbudgeted background task', async () => {
  assertBackgroundTaskAllowed();
  await withUsage({ longGoalId: 'owner-goal' }, async () => {
    await Promise.resolve();
    assert.throws(() => assertBackgroundTaskAllowed(), { code: 'GOAL_SCOPE_VIOLATION' });
    withUsage({ scopeLabel: 'delegated work' }, () => assert.throws(() => assertBackgroundTaskAllowed(), { code: 'GOAL_SCOPE_VIOLATION' }));
  });
  assertBackgroundTaskAllowed();
});

test('executor, cognition and automatic learning use the same durable ledger', async t => {
  const { ledger } = fixture(t); let requests = 0;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      requests++; const body = JSON.parse(raw);
      const message = { role: 'assistant', content: body.stream ? '完成' : '{"profile":null,"changes":[],"playbook":null}' };
      if (body.stream) {
        assert.equal(body.stream_options.include_usage, true);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: 'stop' }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) + '\n\ndata: [DONE]\n\n');
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 15 } })); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const settings = { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'fixture', maxTokens: 256 };
  await withUsage({ ledger, scopeId: 'goal-b', runId: 'cycle-b', dailyTokenLimit: 100000, runTokenLimit: 50000 }, async () => {
    for (const role of ['executor', 'understanding']) await modelResponse(settings, '', [{ role: 'user', content: 'check' }], role, undefined, false, false, null, [], false, true);
    await extract({ settings, apiKey: '', user: '记住我偏好简洁', assistant: '已记录', steps: [] });
  });
  assert.equal(requests, 3); assert.equal(ledger.summary().reportedTokens, 35);
  assert.deepEqual(new Set(ledger.summary().records.map(record => record.role)), new Set(['executor', 'understanding', 'learner']));
  ledger.setPolicy({ dailyTokenLimit: 36 });
  await assert.rejects(() => withUsage({ ledger }, () => modelResponse(settings, '', [{ role: 'user', content: 'blocked' }], 'executor', undefined, false, false, null, [], false, true)), { code: 'TOKEN_BUDGET_EXCEEDED' });
  assert.equal(requests, 3, 'an exhausted allowance must stop the HTTP request');
});

test('a stalled model request times out, releases its slot and retains unknown usage', async t => {
  const { ledger } = fixture(t); let received = 0;
  const server = http.createServer((_req, _res) => { received++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const settings = { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'stalled', maxTokens: 100, providerId: 'stalled-fixture', maxConcurrent: 1, requestTimeoutMs: 1000 };
  await assert.rejects(() => withUsage({ ledger, scopeId: 'timeout-check', runId: 'round-timeout' }, () => modelResponse(settings, '', [{ role: 'user', content: 'hello' }], 'executor', undefined, false, false, null, [], false, true)), error => error.name === 'TimeoutError');
  assert.equal(received, 1); assert.equal(ledger.summary().unknownCalls, 1); assert.equal(ledger.summary().reservedTokens, 0); assert.ok(ledger.summary().estimatedTokens > 100);
  const release = await require('../electron/service-limiter.cjs').acquire('stalled-fixture', 1, AbortSignal.timeout(500)); release();
});
