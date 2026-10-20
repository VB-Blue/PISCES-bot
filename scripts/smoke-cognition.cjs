// Active learning against the real core, with simulated Instagram data and no model calls:
// an unfamiliar field is recognised and learning comes first; principles are computed from peer
// samples; a controlled trial on "own" posts confirms or refutes them; the context then carries
// what was verified; the way of learning is credited; everything survives a core restart.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { coreRequest } = require('../electron/core-client.cjs');
const memory = require('../electron/memory.cjs');
const { createTools } = require('../electron/tools.cjs');

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
    try { await coreRequest(settings, token, '/api/v1/cognition/state'); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('core not ready: ' + child.log.slice(-3000));
}
async function stop(child) { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } }

// Peer posts: a person in the picture lifts engagement ~80%; colour tone and posting hour do nothing.
function peerPosts(count) {
  let seed = 20261020;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  return Array.from({ length: count }, (_, index) => {
    const person = index % 2 === 0, warm = Math.floor(index / 2) % 2 === 0;
    return { features: { has_person: person, tone: warm ? 'warm' : 'cool', hour: Math.floor(random() * 24) }, value: Number(((person ? 0.045 : 0.025) * (0.8 + 0.4 * random())).toFixed(4)), ref: 'peer-' + index };
  });
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-cognition-real-'));
  const port = await freePort();
  const token = 'cognition-' + randomUUID();
  const settings = { coreUrl: 'http://127.0.0.1:' + port };
  const call = (route, body) => coreRequest(settings, token, route, { body, signal: AbortSignal.timeout(15000) });
  const link = { request: (route, body, { timeoutMs = 8000 } = {}) => coreRequest(settings, token, route, { body, signal: AbortSignal.timeout(timeoutMs) }) };
  const report = {};
  let core = startCore(path.join(root, 'core'), port, token);
  try {
    await ready(core, settings, token);
    await memory.init(path.join(root, 'assistant-memory'), { core: link });
    await memory.sync();
    const tools = createTools({ memory, userDataDir: path.join(root, 'userdata'), getPrefs: () => ({}), host: { path: name => path.join(root, name), openExternal: async () => {} } });
    const ctx = turn => ({ ask: async () => 'once', signal: new AbortController().signal, session: 's', turn, userText: '' });
    const domain = 'Instagram 图片营销';

    // 1. Unfamiliar field: the subject says so and decides to learn first.
    const first = await call('/api/v1/cognition/assess', { task: '帮我维护 Instagram 账号，每天发一条图片帖', domain: { name: domain, keywords: ['instagram', 'ins', '图片营销', '社媒运营'] } });
    assert.equal(first.decision, 'learn_first');
    assert.equal(first.level, 'unknown');
    assert.equal(first.strategy.id, 'peer_study');
    report.firstAssessment = { level: first.level, decision: first.decision, strategy: first.strategy.name, plan: first.plan.steps };

    // 2. The executor studies peers and hands over the samples; the subject computes the principles.
    const observed = await tools.execute('record_observations', { domain, source: '20 个同行账号最近 20 帖', metric: '互动率', records: peerPosts(400) }, ctx('t1'));
    const learned = observed.principles_changed.map(item => item.statement);
    assert.ok(learned.some(text => text.includes('has_person=true') && text.includes('更高')), learned.join('\n'));
    assert.ok(learned.some(text => text.startsWith('「tone=') && text.includes('没有明显影响')), learned.join('\n'));
    assert.ok(!learned.some(text => text.includes('hour') && /更高|更低/.test(text)), learned.join('\n'));
    assert.equal(observed.plan.status, 'succeeded');
    report.induced = learned;

    // A model's idea stays a hypothesis.
    const idea = await tools.execute('propose_principle', { domain, statement: '加很多话题标签能提高曝光', source: 'model' }, ctx('t1'));
    assert.equal(idea.principle.status, 'hypothesis');

    // 3. Next time: peer principles exist but are untested on the owner's account, so it runs a trial.
    const second = await call('/api/v1/cognition/assess', { task: '今天 ins 发什么图' });
    assert.equal(second.decision, 'experiment');
    assert.equal(second.strategy.id, 'small_trial');
    const target = second.principles.find(item => item.statement.includes('has_person'));
    const trial = await tools.execute('start_experiment', { domain, hypothesis: '真人出镜的帖子互动更高', metric: '互动率', principle_id: target.id, arms: ['真人出镜', '纯产品图'], min_per_arm: 5 }, ctx('t2'));
    const own = [[0.051, 0.030], [0.048, 0.028], [0.053, 0.031], [0.047, 0.029], [0.050, 0.027]];
    let last;
    for (const [withPerson, withoutPerson] of own) {
      await tools.execute('record_experiment_result', { experiment_id: trial.experiment.id, arm: '真人出镜', value: withPerson }, ctx('t2'));
      last = await tools.execute('record_experiment_result', { experiment_id: trial.experiment.id, arm: '纯产品图', value: withoutPerson }, ctx('t2'));
    }
    assert.equal(last.conclusion.decisive, true);
    assert.match(last.conclusion.verdict, /在你的实践中成立/);
    report.trial = last.conclusion.verdict;

    // 4. The verified principle now leads the context the core assembles for this field.
    const context = await memory.prepareContext('今天 ins 发什么图', {});
    assert.equal(context.source, 'core');
    assert.match(context.text, /\[已在你的实践中验证\][^\n]*has_person=true/);
    report.context = context.text.split('\n').slice(0, 6);

    // 5. The ways of learning were credited by their results.
    const state = await call('/api/v1/cognition/state');
    const strategies = Object.fromEntries(state.strategies.map(item => [item.id, [item.successes, item.trials]]));
    assert.deepEqual(strategies.peer_study, [1, 1]);
    assert.deepEqual(strategies.small_trial, [1, 1]);
    report.strategies = state.strategies.filter(item => item.trials).map(item => item.name + ' ' + item.successes + '/' + item.trials);
    const level = state.domains.find(item => item.name === domain).level;
    report.levelAfter = level;
    assert.equal(level, 'practiced');

    // 6. All of it survives a restart of the core.
    await stop(core);
    core = startCore(path.join(root, 'core'), port, token);
    await ready(core, settings, token);
    const restored = (await call('/api/v1/cognition/state')).domains.find(item => item.name === domain);
    assert.equal(restored.observations, 400);
    assert.ok(restored.principles.some(item => item.status === 'confirmed' && item.statement.includes('has_person')));
    report.restart = { observations: restored.observations, principles: restored.principles.length };

    const result = { passed: true, binary, isolatedRuntime: root, noModelCalls: true, simulatedData: true, report, at: new Date().toISOString() };
    await fs.mkdir(path.join(__dirname, '../output'), { recursive: true });
    await fs.writeFile(path.join(__dirname, '../output/domain-cognition.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await stop(core);
    await memory.flush();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 200));
