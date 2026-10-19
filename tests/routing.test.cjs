const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const providers = require('../electron/providers.cjs');
const router = require('../electron/router.cjs');
const { runAssistant } = require('../electron/assistant-worker.cjs');
const { createSubAgents, buildDefinition } = require('../electron/subagents.cjs');

const deps = { encrypt: value => 'enc:' + value, validateEndpoint: value => { if (!/^https?:\/\//.test(value)) throw new Error('地址无效'); return value; } };
const resolve = store => ({ ...store, profiles: store.profiles.map(item => providers.resolveProfile(item, value => String(value).replace(/^enc:/, ''))) });
const build = (profiles, extra = {}) => providers.buildStore({ profiles, ...extra }, providers.emptyStore(), deps);

test('a single saved endpoint becomes the default profile; keys are never in the public view', () => {
  const store = providers.migrate(null, { endpoint: 'https://a.example/v1', model: 'm1', apiKeyEncrypted: 'enc:TOPSECRET' });
  assert.equal(store.profiles.length, 1);
  assert.equal(store.defaultId, store.profiles[0].id);
  const view = providers.publicView(store);
  assert.equal(view.profiles[0].hasApiKey, true);
  assert.ok(!JSON.stringify(view).includes('TOPSECRET'));
  assert.equal(providers.migrate(null, { endpoint: '', model: '' }).profiles.length, 0);
});

test('saving profiles keeps a blank key, rejects duplicates and bad input, and maps routes onto final ids', () => {
  const first = build([{ id: 'p-aaaaaa', name: 'DeepSeek', endpoint: 'https://d.example/v1', model: 'chat', apiKey: 'SECRET', strengths: ['cheap', 'bogus'] }, { id: 'p-bbbbbb', name: 'GPT', endpoint: 'https://o.example/v1', model: 'g', strengths: ['vision', 'strong'] }],
    { defaultId: 'p-bbbbbb', routes: { researcher: 'p-aaaaaa', coder: 'nope', operator: 'p-bbbbbb' } });
  assert.deepEqual(first.profiles[0].strengths, ['cheap']);
  assert.equal(first.defaultId, 'p-bbbbbb');
  assert.deepEqual(first.routes, { researcher: 'p-aaaaaa', operator: 'p-bbbbbb' });
  // Editing without retyping the key keeps it; clearing removes it.
  const second = providers.buildStore({ profiles: [{ id: 'p-aaaaaa', name: 'DeepSeek', endpoint: 'https://d.example/v1', model: 'chat2' }], defaultId: 'p-aaaaaa' }, first, deps);
  assert.equal(second.profiles[0].apiKeyEncrypted, 'enc:SECRET');
  const third = providers.buildStore({ profiles: [{ id: 'p-aaaaaa', name: 'DeepSeek', endpoint: 'https://d.example/v1', model: 'chat2', clearApiKey: true }] }, second, deps);
  assert.equal(third.profiles[0].apiKeyEncrypted, '');
  assert.throws(() => build([{ name: 'A', endpoint: 'https://x/v1', model: 'm' }, { name: 'a', endpoint: 'https://y/v1', model: 'm' }]), /重复/);
  assert.throws(() => build([{ name: 'A', endpoint: 'ftp://x', model: 'm' }]), /地址无效/);
  assert.throws(() => build([{ name: 'A', endpoint: 'https://x/v1', model: '' }]), /模型/);
  assert.throws(() => build([{ name: '', endpoint: 'https://x/v1', model: 'm' }]), /名称/);
});

const sample = () => resolve(build([
  { id: 'p-default', name: '主力', endpoint: 'https://a/v1', model: 'big', strengths: ['strong'] },
  { id: 'p-cheap', name: '便宜', endpoint: 'https://b/v1', model: 'small', strengths: ['cheap', 'fast'] },
  { id: 'p-eyes', name: '看图', endpoint: 'https://c/v1', model: 'vl', strengths: ['vision'] },
  { id: 'p-solo', name: '独占', endpoint: 'https://d/v1', model: 'x', noFailover: true },
], { defaultId: 'p-default', routes: { coder: 'p-solo' } }));

test('routing precedence: explicit name, then the role setting, then vision, then strength, then default', () => {
  const store = sample();
  assert.equal(router.plan(store, { profile: '便宜', role: 'coder' }).primary.id, 'p-cheap');
  assert.equal(router.plan(store, { role: 'coder' }).primary.id, 'p-solo');
  const screen = router.plan(store, { role: 'operator', capabilities: ['desktop'] });
  assert.equal(screen.primary.id, 'p-eyes');
  assert.ok(screen.fallbacks.every(item => item.strengths.includes('vision')), 'screen work only fails over to services that can see');
  assert.equal(router.plan(store, { prefer: 'fast' }).primary.id, 'p-cheap');
  assert.equal(router.plan(store, {}).primary.id, 'p-default');
  assert.equal(router.plan(store, { prefer: 'long' }).primary.id, 'p-default');
  const unknown = router.plan(store, { profile: '不存在' });
  assert.equal(unknown.primary.id, 'p-default');
  assert.match(unknown.warning, /不存在/);
});

test('failover order skips opted-out services and can be switched off', () => {
  const store = sample();
  const order = router.plan(store, { prefer: 'fast' }).fallbacks.map(item => item.id);
  assert.deepEqual(order, ['p-default', 'p-eyes']);
  assert.deepEqual(router.plan(store, { role: 'coder' }).fallbacks, [], 'an opted-out service never falls over');
  assert.deepEqual(router.plan({ ...store, failover: false }, {}).fallbacks, []);
});

test('only outages, throttling, balance and key problems count as transient', () => {
  for (const text of ['AI 返回 HTTP 429: slow down', 'AI 返回 HTTP 503', 'AI 返回 HTTP 402: 余额不足', 'AI 返回 HTTP 401', 'fetch failed', 'AI 回复未完成', 'AI 返回 HTTP 400: insufficient_quota']) assert.ok(router.isTransient(new Error(text)), text);
  for (const text of ['AI 返回 HTTP 400: bad request', 'AI 返回 HTTP 404', '任务已停止']) assert.ok(!router.isTransient(new Error(text)), text);
  const abort = new Error('x'); abort.name = 'AbortError';
  assert.ok(!router.isTransient(abort));
});

test('the limiter caps concurrent agents per service and releases in order', async () => {
  const limiter = router.createLimiter();
  const log = [];
  const job = async (name, ms) => { const release = await limiter.acquire('s', 2); log.push('start ' + name); await new Promise(resolve => setTimeout(resolve, ms)); log.push('end ' + name); release(); };
  await Promise.all([job('a', 40), job('b', 40), job('c', 5)]);
  assert.deepEqual(log.slice(0, 2), ['start a', 'start b']);
  assert.ok(log.indexOf('start c') > log.indexOf('end a') || log.indexOf('start c') > log.indexOf('end b'));
  assert.equal(limiter.active('s'), 0);
});

function fakeService(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    handler(JSON.parse(Buffer.concat(chunks)), res, req);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port, close: () => { server.closeAllConnections(); return new Promise(done => server.close(done)); } })));
}
const answer = text => (body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] })); };
const workOf = () => ({ id: 'w', session: 's', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] });
const stubCore = async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : { work: {} };

test('a model call moves to the next service when the first one is out of balance, and stays there', async () => {
  const seen = [];
  const dead = await fakeService((body, res) => { seen.push('dead'); res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: '余额不足' } })); });
  const live = await fakeService((body, res, req) => { seen.push('live:' + req.headers.authorization); answer('来自备用服务')(body, res); });
  try {
    const events = [];
    const result = await runAssistant({ settings: { endpoint: dead.url, model: 'a' }, apiKey: 'KEY-A', fallbacks: [{ name: '备用', settings: { endpoint: live.url, model: 'b' }, apiKey: 'KEY-B' }],
      onFailover: info => events.push(info), work: workOf(), messages: [{ role: 'user', content: '你好' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: stubCore });
    assert.equal(result.text, '来自备用服务');
    assert.equal(events.length, 1);
    assert.equal(events[0].to, '备用');
    assert.match(events[0].reason, /402/);
    // The backup got its own key, not the first service's.
    assert.deepEqual(seen, ['dead', 'live:Bearer KEY-B']);
  } finally { await dead.close(); await live.close(); }
});

test('errors that are not outages are not retried elsewhere, and software tasks never leave the authorized service', async () => {
  const bad = await fakeService((body, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad request' } })); });
  let touched = false;
  const other = await fakeService((body, res) => { touched = true; answer('x')(body, res); });
  try {
    const fallbacks = [{ name: '备用', settings: { endpoint: other.url, model: 'b' }, apiKey: '' }];
    await assert.rejects(runAssistant({ settings: { endpoint: bad.url, model: 'a' }, apiKey: '', fallbacks, work: workOf(), messages: [{ role: 'user', content: 'q' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: stubCore }), /HTTP 400/);
    assert.equal(touched, false);
    const down = await fakeService((body, res) => { res.writeHead(503); res.end(); });
    try {
      const scoped = { ...workOf(), desktop_scope: { teacher_destination: down.url + ' | a', surface: { window_title: 't' }, expires_at: '', max_actions: 1 } };
      await assert.rejects(runAssistant({ settings: { endpoint: down.url, model: 'a' }, apiKey: '', fallbacks, work: scoped, messages: [{ role: 'user', content: 'q' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: stubCore }), /HTTP 503/);
      assert.equal(touched, false, 'screen text must not be sent to a service the user did not authorize for this task');
    } finally { await down.close(); }
  } finally { await bad.close(); await other.close(); }
});

test('the planner and verifier can run on their own services', async () => {
  const roles = [];
  const planner = await fakeService((body, res) => { roles.push('planner-service'); answer('计划')(body, res); });
  const main = await fakeService((body, res) => { roles.push('main-service'); answer('最终答案')(body, res); });
  try {
    const result = await runAssistant({ settings: { endpoint: main.url, model: 'm' }, apiKey: '', roleTargets: { planner: [{ name: '规划', settings: { endpoint: planner.url, model: 'p' }, apiKey: '' }], verifier: [{ name: '审阅', settings: { endpoint: planner.url, model: 'p' }, apiKey: '' }] },
      work: { ...workOf(), roles: ['planner', 'executor', 'verifier'] }, messages: [{ role: 'user', content: '做事' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: stubCore });
    assert.deepEqual(roles, ['planner-service', 'main-service', 'planner-service']);
    assert.match(result.text, /最终答案/);
  } finally { await planner.close(); await main.close(); }
});

test('delegated agents are assigned a service by role, report it, and queue per service', async () => {
  const store = sample();
  const calls = [];
  let inflightEyes = 0, maxEyes = 0;
  const fakeRun = async options => {
    calls.push({ model: options.settings.model, key: options.apiKey, fallbacks: options.fallbacks.map(item => item.name) });
    if (options.settings.model === 'vl') { inflightEyes++; maxEyes = Math.max(maxEyes, inflightEyes); await new Promise(resolve => setTimeout(resolve, 30)); inflightEyes--; }
    return { text: '完成' };
  };
  const agents = createSubAgents({ runAssistant: fakeRun, getSettings: () => ({ coreUrl: 'x' }), getApiKey: () => '', makeTools: () => ({ view: () => ({}), endControl() {} }), getStore: () => store, maxParallel: 5, limiter: router.createLimiter() });
  const ctx = { turn: 't1', ask: async () => 'once', signal: new AbortController().signal };
  const researcher = await agents.run({ name: '甲', task: '查一下资料并汇报', role: 'researcher' }, ctx);
  assert.equal(researcher.service, '便宜');
  assert.equal(researcher.assigned_by, '擅长 fast');
  assert.deepEqual(researcher.capabilities, ['web']);
  const coder = await agents.run({ name: '乙', task: '写一个脚本并汇报', role: 'coder' }, ctx);
  assert.equal(coder.service, '独占');
  assert.deepEqual(coder.capabilities, ['files', 'shell']);
  assert.deepEqual(calls[1].fallbacks, []);
  const explicit = await agents.run({ name: '丙', task: '写一份长文档并汇报', profile: '主力', role: 'researcher' }, ctx);
  assert.equal(explicit.service, '主力');
  assert.equal(explicit.assigned_by, '指定');
  // The service named "看图" has maxConcurrent 2: a third operator waits for a free place.
  await Promise.all([1, 2, 3].map(index => agents.run({ name: '操作' + index, task: '操作软件完成第 ' + index + ' 项', role: 'operator', capabilities: ['web'] }, ctx)));
  assert.ok(maxEyes <= 2, 'at most two agents at once on the same service (saw ' + maxEyes + ')');
});

test('the delegate tool lists the services and roles only when there is a choice', () => {
  const single = buildDefinition(resolve(build([{ name: '唯一', endpoint: 'https://a/v1', model: 'm' }])));
  assert.ok(!single.function.parameters.properties.profile);
  assert.ok(single.function.parameters.properties.role);
  const many = buildDefinition(sample());
  assert.deepEqual(many.function.parameters.properties.profile.enum, ['主力', '便宜', '看图', '独占']);
  assert.match(many.function.description, /「便宜」small/);
  assert.match(many.function.description, /擅长:cheap\/fast/);
});
