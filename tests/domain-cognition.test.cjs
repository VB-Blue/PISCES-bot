const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { runAssistant } = require('../electron/assistant-worker.cjs');
const { createExecutive } = require('../electron/subject/executive.cjs');
const { normalizeIntent } = require('../electron/subject/cognition.cjs');
const { buildSystemPrompt } = require('../electron/brain.cjs');
const { definitions } = require('../electron/tools.cjs');

async function server(handler) {
  const instance = http.createServer(async (req, res) => { const chunks = []; for await (const part of req) chunks.push(part); handler(JSON.parse(Buffer.concat(chunks)), res, req); });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { endpoint: 'http://127.0.0.1:' + instance.address().port, close: () => { instance.closeAllConnections(); return new Promise(resolve => instance.close(resolve)); } };
}
function answer(res, content) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { total_tokens: 10 } })); }

const intent = { type: 'task', goal: '每天维护 Instagram 账号并发一条图片帖', kind: '社媒运营', deliverable: '回答', done_criteria: [{ check: 'answer_contains', value: '已发布' }], apps: [], steps: 'one',
  domain: { name: 'Instagram 图片营销', keywords: ['instagram', 'ins', '图片营销'] } };
const assessment = { ok: true, domain: { id: 'd1', name: 'Instagram 图片营销' }, level: 'unknown', situation: 'new_domain', decision: 'learn_first',
  reason: '对「Instagram 图片营销」的了解不够（还不了解：没有规律，也没有样本），先学再做', gaps: [],
  strategy: { id: 'peer_study', name: '研究同行', trials: 0, successes: 0 },
  plan: { id: 'p1', strategy_id: 'peer_study', steps: ['找出 10 个同类做得好的对象', '用 record_observations 把样本交给记忆体'] }, principles: [], refuted: [], running_experiments: [] };

test('understanding names the field; the core, not the model, decides what that means', () => {
  const normalized = normalizeIntent({ ...intent, domain: { name: ' Instagram 图片营销 ', keywords: ['instagram', '', 'ins'] } });
  assert.deepEqual(normalized.domain, { name: 'Instagram 图片营销', keywords: ['instagram', 'ins'] });
  assert.equal(normalizeIntent({ ...intent, domain: null }).domain, null);
  const prompt = buildSystemPrompt({ toolNames: new Set(['remember', 'record_observations']) });
  assert.match(prompt, /规律由记忆体从数据里算出来/);
  const names = definitions.map(item => item.function.name);
  for (const name of ['domain_knowledge', 'record_observations', 'propose_principle', 'start_experiment', 'record_experiment_result']) assert.ok(names.includes(name), name);
});

test('an unfamiliar field makes learning part of the job: brief, budget and done criteria follow the core', async () => {
  const briefs = [], coreCalls = [];
  const model = await server((body, res) => {
    const system = body.messages.find(item => item.role === 'system')?.content || '';
    if (/理解模块/.test(system)) return answer(res, JSON.stringify(intent));
    briefs.push(JSON.stringify(body.messages));
    answer(res, '已发布一条图片帖。');
  });
  const settings = { endpoint: model.endpoint, model: 'm' };
  const records = { similarSuccess: () => null, acceptUnderstanding: async () => {}, createTask: async () => ({ id: 'task-1' }), updateTask: async (task, patch) => Object.assign(task, patch), recordExperience: async () => {} };
  const memory = { listSkills: () => [], listMemories: () => [], getProfile: () => '', buildContext: () => ({ text: '' }),
    coreCall: async (route, body) => { coreCalls.push({ route, body }); return route.endsWith('/assess') ? assessment : { ok: true }; } };
  const executive = createExecutive({ store: records, memory, runAssistant, similarity: () => 0 });
  const agent = { settings, apiKey: 'K', core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : {}, coreTools: false, work: { id: 'w', goal: 'x', files: [], roles: ['executor'], profile_snapshot: {} }, messages: [{ role: 'user', content: '帮我维护 ins 账号' }], maxTurns: 4 };
  const steps = [];
  try {
    const result = await executive.handle({ target: { settings, apiKey: 'K' }, request: '帮我维护 ins 账号', messages: agent.messages, tools: { names: new Set(), definitions: [] }, signal: new AbortController().signal, agent, progress: step => steps.push(step.label) });
    const assess = coreCalls.find(call => call.route === '/api/v1/cognition/assess');
    assert.deepEqual(assess.body.domain, intent.domain);
    assert.ok(steps.some(label => /^记忆体判断：.*先学再做（研究同行）/.test(label)), steps.join('\n'));
    assert.match(briefs[0], /记忆体的认知判断/);
    assert.match(briefs[0], /先完成学习计划/);
    assert.match(briefs[0], /record_observations/);
    // The executor answered without learning anything, so the job is not done.
    assert.equal(result.subject.passed, false);
    assert.ok(result.subject.unmet.some(item => /record_observations/.test(item)), result.subject.unmet.join('；'));
    const practice = coreCalls.find(call => call.route === '/api/v1/cognition/practice');
    assert.deepEqual(practice.body, { request_id: 'practice:task-1', domain: 'd1', passed: false });
  } finally { await model.close(); }
});
