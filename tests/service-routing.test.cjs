const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const providers = require('../electron/providers.cjs');
const router = require('../electron/router.cjs');
const { createUsageLedger } = require('../electron/model-usage.cjs');

const deps = { encrypt: value => 'enc:' + value, validateEndpoint: value => value };
const resolve = store => ({ ...store, profiles: store.profiles.map(item => providers.resolveProfile(item, value => String(value).replace(/^enc:/, ''))) });
// The user's real setup: two flash models, neither tagged.
const untagged = (extra = {}) => ({ ...resolve(providers.buildStore({ profiles: [
  { id: 'p-deepseek', name: '默认', endpoint: 'https://a/v1', model: 'deepseek-v4-flash-0731' },
  { id: 'p-minimax', name: 'max', endpoint: 'https://b/v1', model: 'minimax/minimax-m3.1-flash' },
], defaultId: 'p-deepseek' }, providers.emptyStore(), deps)), ...extra });

test('untagged services are recognised from their model names and work is spread by fit', () => {
  assert.deepEqual(router.inferStrengths('deepseek-v4-flash-0731').sort(), ['cheap', 'code', 'fast']);
  assert.deepEqual(router.inferStrengths('minimax/minimax-m3.1-flash').sort(), ['cheap', 'fast', 'long']);
  assert.ok(!router.inferStrengths('minimax-m3').includes('strong'), '"max" inside "minimax" is not "max"');
  assert.ok(router.inferStrengths('qwen-vl-max').includes('vision'));
  assert.ok(router.inferStrengths('llama3', 'http://127.0.0.1:11434/v1').includes('cheap'));
  const store = untagged();
  const long = router.plan(store, router.taskRequest({ text: 'x'.repeat(17000) }));
  assert.equal(long.primary.id, 'p-minimax');
  assert.match(long.reason, /擅长 long（按模型名识别）/);
  assert.equal(router.plan(store, router.taskRequest({ text: '帮我修复这段 python 代码的报错' })).primary.id, 'p-deepseek');
  assert.equal(router.plan(store, {}).primary.id, 'p-deepseek', 'with nothing to choose by, the default stays first');
  // A tag the user sets always wins over the name.
  const tagged = resolve(providers.buildStore({ profiles: [
    { id: 'svc-a1', name: 'A', endpoint: 'https://a/v1', model: 'deepseek-v4-flash', strengths: ['strong'] },
    { id: 'svc-b1', name: 'B', endpoint: 'https://b/v1', model: 'kimi-k2' },
  ], defaultId: 'svc-a1' }, providers.emptyStore(), deps));
  assert.equal(router.plan(tagged, { prefer: 'code' }).primary.id, 'svc-a1', 'a tagged service is not re-read as "code"; B is not code either, so the default wins');
  assert.equal(router.plan(tagged, { prefer: 'long' }).primary.id, 'svc-b1');
});

test('a failing service is rested, a busy default spills over, and an explicit choice is always honoured', () => {
  const now = Date.now();
  const resting = untagged({ health: { 'p-deepseek': { calls: 6, ok: 3, consecutiveFailures: 3, coolingUntil: now + 5 * 60_000, medianMs: 2000 } } });
  const chosen = router.plan(resting, {});
  assert.equal(chosen.primary.id, 'p-minimax');
  assert.match(chosen.reason, /默认服务最近连续失败，暂时避开/);
  assert.deepEqual(chosen.fallbacks.map(item => item.id), ['p-deepseek'], 'a rested service is still a last resort');
  const expired = untagged({ health: { 'p-deepseek': { calls: 10, ok: 8, consecutiveFailures: 2, coolingUntil: now - 1000 } } });
  assert.equal(router.plan(expired, {}).primary.id, 'p-deepseek', 'once the rest is over a mostly reliable default is tried again');
  const unreliable = untagged({ health: { 'p-deepseek': { calls: 10, ok: 4, consecutiveFailures: 0, coolingUntil: 0 } } });
  assert.equal(router.plan(unreliable, {}).primary.id, 'p-minimax', 'a default that fails often loses to another service');
  const busy = untagged({ load: id => ({ active: id === 'p-deepseek' ? 2 : 0, waiting: 0 }) });
  const spilled = router.plan(busy, {});
  assert.equal(spilled.primary.id, 'p-minimax');
  assert.match(spilled.reason, /默认服务正忙，分流到这里/);
  assert.equal(router.plan(resting, { profile: '默认' }).primary.id, 'p-deepseek', 'the user\'s own pick is never overridden');
  assert.equal(router.plan(resting, { profile: '默认' }).reason, '指定');
  // Speed counts when speed is what the task needs.
  const timed = untagged({ health: { 'p-deepseek': { calls: 20, ok: 20, consecutiveFailures: 0, coolingUntil: 0, medianMs: 9000 }, 'p-minimax': { calls: 20, ok: 20, consecutiveFailures: 0, coolingUntil: 0, medianMs: 1500 } } });
  assert.equal(router.plan(timed, { prefer: 'fast' }).primary.id, 'p-minimax');
});

test('the usage ledger reports each service\'s recent reliability, speed and rest period', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pisces-health-'));
  let clock = Date.parse('2026-10-20T08:00:00Z');
  const ledger = createUsageLedger({ dir, timeZone: 'UTC', now: () => clock }); ledger.init();
  const call = (providerId, ok, ms = 1000, code) => {
    const handle = ledger.begin({ settings: { model: 'm', providerId }, role: 'executor', request: { max_tokens: 100, messages: [] } });
    clock += ms;
    handle.finish(ok ? { usage: { total_tokens: 10 } } : { error: Object.assign(new Error('x'), code ? { httpStatus: code } : {}) });
  };
  call('a', true, 2000); call('a', true, 4000); call('a', false); call('a', false);
  call('b', true, 1000); call('b', false, 500, 401);
  const health = ledger.serviceHealth();
  assert.deepEqual([health.a.calls, health.a.ok, health.a.consecutiveFailures], [4, 2, 2]);
  assert.equal(health.a.medianMs, 4000);
  assert.ok(health.a.coolingUntil > clock && health.a.coolingUntil <= clock + 10 * 60_000, 'two failures in a row rest it for about ten minutes');
  assert.equal(health.b.lastErrorCode, 'HTTP_401');
  assert.ok(health.b.coolingUntil > clock + 20 * 60_000, 'a rejected key rests it longer');
  call('a', true, 1000);
  assert.equal(ledger.serviceHealth().a.consecutiveFailures, 0, 'one success ends the run of failures');
  fs.rmSync(dir, { recursive: true, force: true });
});
