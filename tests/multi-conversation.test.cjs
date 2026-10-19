const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createConversationRuns } = require('../electron/conversation-runs.cjs');
const { taskRequest, targets, createLimiter } = require('../electron/router.cjs');
const { modelResponse, runAssistant } = require('../electron/assistant-worker.cjs');
const cognition = require('../electron/subject/cognition.cjs');
const { createMutex } = require('../electron/subagents.cjs');
const { createExecutive } = require('../electron/subject/executive.cjs');
const { extract: extractLearning } = require('../electron/learner.cjs');

const until = async condition => { const end = Date.now() + 3000; while (!condition()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
async function server(handler) {
  const instance = http.createServer(async (req, res) => { const chunks = []; for await (const part of req) chunks.push(part); handler(JSON.parse(Buffer.concat(chunks)), res, req); });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { endpoint: 'http://127.0.0.1:' + instance.address().port, close: () => { instance.closeAllConnections(); return new Promise(resolve => instance.close(resolve)); } };
}
function answer(res, content) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { total_tokens: 10 } })); }

test('conversations run independently, reject duplicate turns, and stop only their own request', () => {
  const live = createConversationRuns();
  const a = live.begin('turn-a', 'chat-a'), b = live.begin('turn-b', 'chat-b');
  assert.equal(live.requests.size, 2);
  assert.throws(() => live.begin('turn-c', 'chat-a'), /这段对话/);
  assert.throws(() => live.begin('turn-b', 'chat-c'), /请求标识/);
  live.requests.get('turn-a').abort();
  assert.equal(a.controller.signal.aborted, true); assert.equal(b.controller.signal.aborted, false);
  a.finish(); assert.equal(live.busy('chat-a'), false); assert.equal(live.busy('chat-b'), true);
  const next = live.begin('turn-c', 'chat-a');
  a.finish(); assert.equal(live.busy('chat-a'), true, 'an old completion cannot erase the new turn');
  b.finish(); next.finish(); assert.equal(live.requests.size, 0);
});

test('automatic allocation covers chat tasks, continuation, images, user role routes and explicit services', () => {
  const profile = (id, strengths) => ({ id, name: id, settings: { endpoint: 'https://example.test/v1', model: id, providerId: id, maxConcurrent: 1 }, apiKey: id + '-key', strengths });
  const store = { profiles: [profile('main', ['strong']), profile('code', ['code']), profile('eyes', ['vision']), profile('fast', ['fast']), profile('long', ['long'])], defaultId: 'main', routes: {}, failover: true };
  const choose = task => targets(store, {}, taskRequest(task));
  assert.equal(choose({ text: '写一个 Python 脚本' }).main.id, 'code');
  assert.equal(choose({ text: '查资料和最新新闻' }).main.id, 'fast');
  assert.equal(choose({ text: '写一份周报' }).main.id, 'main');
  assert.equal(choose({ text: '这个是什么？', images: true }).main.id, 'eyes');
  assert.ok(choose({ images: true }).fallbacks.every(item => item.settings.providerId === 'eyes'));
  assert.equal(choose({ text: '继续，加一个参数', messages: [{ role: 'user', content: '写一个 Python 脚本' }, { role: 'assistant', content: '...' }, { role: 'user', content: '继续，加一个参数' }] }).main.id, 'code');
  assert.equal(choose({ text: '帮我处理这个', intent: { presentation: 'research', goal: '检索资料' } }).main.id, 'fast');
  assert.equal(targets({ ...store, routes: { coder: 'long' } }, {}, taskRequest({ text: '写代码' })).main.id, 'long');
  assert.equal(targets(store, {}, { ...taskRequest({ text: '写代码' }), profile: 'main' }).main.id, 'main');
  const current = targets(store, {}, taskRequest({ text: '写代码' }));
  assert.equal(current.mainSettings.providerId, 'code'); assert.equal(current.mainSettings.maxConcurrent, 1); assert.equal(current.apiKey, 'code-key');
  assert.equal(current.roleTargets.planner[0].name, 'main');
  assert.equal(choose({ text: '你好' }).main.id, 'main');
});

test('an API queue is cancellable and cancellation releases its place without affecting another API', async () => {
  const limiter = createLimiter(), controller = new AbortController();
  const release = await limiter.acquire('api-a', 1);
  const queued = limiter.acquire('api-a', 1, controller.signal);
  assert.equal(limiter.waiting('api-a'), 1);
  const other = await limiter.acquire('api-b', 1); other();
  controller.abort(); await assert.rejects(queued, error => error.name === 'AbortError');
  assert.equal(limiter.waiting('api-a'), 0); assert.equal(limiter.active('api-a'), 1);
  release(); release(); assert.equal(limiter.active('api-a'), 0);
});

test('chat workers, cognition and learning share the API cap while a different API can progress', async () => {
  const seen = [], pending = [];
  const service = await server((body, res) => { seen.push(body.model); pending.push({ model: body.model, res }); });
  const signal = new AbortController().signal;
  const settings = { endpoint: service.endpoint, model: 'shared', providerId: 'integration-shared', maxConcurrent: 1 };
  const work = { id: 'w', session: 's', goal: 'hi', profile_snapshot: {}, files: [], roles: ['executor'] };
  try {
    const chat = runAssistant({ settings, apiKey: '', core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : {}, work, messages: [{ role: 'user', content: 'hi' }], signal, coreTools: false });
    await until(() => seen.length === 1);
    const thinking = cognition.think({ target: { settings, apiKey: '' }, system: 'Return JSON', input: 'check', validate: value => value.ok ? '' : 'bad', signal });
    await until(() => require('../electron/service-limiter.cjs').waiting('integration-shared') === 1);
    const learning = extractLearning({ settings, apiKey: '', user: '偏好简短', assistant: '好的', signal });
    const independent = modelResponse({ ...settings, model: 'independent', providerId: 'integration-independent' }, '', [{ role: 'user', content: 'hello' }], 'executor', signal);
    await until(() => seen.includes('independent'));
    assert.deepEqual(seen, ['shared', 'independent']);
    answer(pending.find(item => item.model === 'independent').res, 'hello'); await independent;
    answer(pending[0].res, 'done'); await chat;
    await until(() => seen.length === 3);
    answer(pending[2].res, '{"ok":true}'); assert.equal((await thinking).value.ok, true);
    await until(() => seen.length === 4);
    answer(pending[3].res, '{"profile":null,"changes":[],"playbook":null}'); assert.equal((await learning).profile, null);
  } finally { await service.close(); }
});

test('cognitive planning uses the configured role service and its own key, then fails over', async () => {
  const seen = [], receipts = [];
  const down = await server((body, res, req) => { seen.push(req.headers.authorization); res.writeHead(402); res.end('{}'); });
  const live = await server((body, res, req) => { seen.push(req.headers.authorization); answer(res, '{"steps":[{"do":"核对输入","expect":"找到输入"}]}'); });
  const chain = [{ name: 'down', settings: { endpoint: down.endpoint, model: 'p1' }, apiKey: 'KEY-P1' }, { name: 'live', settings: { endpoint: live.endpoint, model: 'p2' }, apiKey: 'KEY-P2' }];
  try {
    const result = await cognition.plan({ target: { settings: { endpoint: 'https://unused.test', model: 'unused' }, apiKey: 'WRONG', forRole: role => { assert.equal(role, 'planner'); return chain; }, beforeCall: async (role, model) => { receipts.push([role, model]); return model; }, afterCall: async (id, status) => receipts.push([id, status]) }, intent: { goal: '核对' }, context: {}, signal: new AbortController().signal });
    assert.equal(result.steps.length, 1); assert.deepEqual(seen, ['Bearer KEY-P1', 'Bearer KEY-P2']);
    assert.deepEqual(receipts, [['planner', 'p1'], ['p1', 'failed'], ['planner', 'p2'], ['p2', 'success']]);
  } finally { await down.close(); await live.close(); }
});

test('screen ownership is exclusive and a cancelled waiter cannot release the current owner', async () => {
  let releases = 0; const mutex = createMutex(() => releases++), controller = new AbortController();
  const first = await mutex.acquire(); const waiting = mutex.acquire(controller.signal);
  controller.abort(); await assert.rejects(waiting, error => error.name === 'AbortError');
  assert.equal(releases, 0); first(); first(); assert.equal(releases, 1);
  const next = await mutex.acquire(); assert.equal(releases, 1); next(); assert.equal(releases, 2);
});

test('validated understanding refines an ambiguous task onto the coding API before execution', async () => {
  const seen = [];
  const intent = { type: 'task', goal: '编写 Python 代码', kind: '编程', deliverable: '回答', done_criteria: [{ check: 'answer_contains', value: 'print' }], apps: [], steps: 'one' };
  const primary = await server((body, res) => { seen.push(body.model); answer(res, JSON.stringify(intent)); });
  const coder = await server((body, res, req) => { seen.push(body.model); assert.equal(req.headers.authorization, 'Bearer CODE-KEY'); answer(res, 'print("hello")'); });
  const settings = { endpoint: primary.endpoint, model: 'understanding' };
  const records = { similarSuccess: () => null, acceptUnderstanding: async () => {}, createTask: async () => ({ id: 'task' }), updateTask: async (task, patch) => Object.assign(task, patch), recordExperience: async () => {} };
  const memory = { listSkills: () => [], listMemories: () => [], getProfile: () => '', buildContext: () => ({ text: '' }) };
  const executive = createExecutive({ store: records, memory, runAssistant, similarity: () => 0 });
  const agent = { settings, apiKey: 'MAIN-KEY', core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : {}, coreTools: false, work: { id: 'w', goal: '帮我做一下', files: [], roles: ['executor'], profile_snapshot: {} }, messages: [{ role: 'user', content: '帮我做一下' }], maxTurns: 4,
    routeTask: normalized => { assert.equal(normalized.kind, '编程'); return { settings: { endpoint: coder.endpoint, model: 'coding' }, apiKey: 'CODE-KEY' }; } };
  try {
    const result = await executive.handle({ target: { settings, apiKey: 'MAIN-KEY' }, request: '帮我做一下', messages: agent.messages, tools: { names: new Set(), definitions: [] }, signal: new AbortController().signal, agent });
    assert.deepEqual(seen, ['understanding', 'coding']); assert.equal(result.subject.passed, true); assert.equal(result.model, 'coding');
  } finally { await primary.close(); await coder.close(); }
});
