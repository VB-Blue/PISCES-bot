const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { normalizePlan } = require('../electron/subject/plan.cjs');
const { executeNodeGraph, scopeNodeTools, claimsFor } = require('../electron/subject/node-execution.cjs');
const gate = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: value => release(value) }; };
const outcome = (text, passed = true) => ({ result: { text, trace: [] }, verification: { passed, checks: [], unmet: passed ? [] : ['missing proof'] }, evidence: { answer: text } });
const parallel = (id, dependencies = [], extra = {}) => ({ id, do: id, depends_on: dependencies, criteria: [{ check: 'answer_contains', value: id }], inputs: [], outputs: [], execution: { mode: 'parallel', tools: ['get_environment'] }, ...extra });
function persistedGraph(steps) {
  const nodes = normalizePlan(steps); let saved = structuredClone(nodes); const history = [];
  return { nodes, history, current: () => saved, persist: async snapshot => { saved = structuredClone(snapshot); history.push(saved); } };
}

test('independent branches overlap, persist their own identities, and only verified parents release the join', async () => {
  const graph = persistedGraph([parallel('a'), parallel('b'), parallel('join', ['a', 'b'])]);
  const both = gate(), release = gate(); let count = 0; const identities = new Set();
  const pending = executeNodeGraph({ ...graph, revision: 3, signal: new AbortController().signal, run: async (node, lease) => {
    lease.assertActive(); identities.add(lease.id);
    assert.equal(graph.current().find(item => item.id === node.id).execution_state.lease_id, lease.id);
    if (node.id !== 'join') { if (++count === 2) both.release(); await release.promise; }
    else assert.ok(graph.current().slice(0, 2).every(item => item.verification?.passed));
    return outcome(node.id);
  } });
  await both.promise; assert.ok(graph.current().slice(0, 2).every(item => item.runtime_status === 'doing')); release.release();
  const result = await pending; assert.equal(identities.size, 3); assert.equal(result.result.text, 'a\n\nb\n\njoin'); assert.equal(result.failure, null);
  assert.ok(graph.history.some(plan => plan[0].verification?.passed && plan[1].verification?.passed && plan[2].status === 'pending'));
});

test('serial nodes keep native, remote and unknown effects exclusive', async () => {
  const graph = persistedGraph([{ id: 'native', do: 'native', depends_on: [] }, parallel('reader')]);
  const began = gate(), release = gate(); const started = [];
  const pending = executeNodeGraph({ ...graph, revision: 1, run: async node => { started.push(node.id); if (node.id === 'native') { began.release(); await release.promise; } return outcome(node.id); } });
  await began.promise; assert.deepEqual(started, ['native']); release.release(); await pending; assert.deepEqual(started, ['native', 'reader']);
  assert.throws(() => normalizePlan([parallel('unsafe', [], { execution: { mode: 'parallel', tools: ['run_command'] } })]), /独占/);
  assert.throws(() => normalizePlan([parallel('unsafe', [], { execution: { mode: 'parallel', tools: ['delegate'] } })]), /独占/);
});

test('file readers and writers sharing an actual path cannot overlap, including junction aliases', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-resource-')), real = path.join(dir, 'real'), alias = path.join(dir, 'alias');
  await fs.mkdir(real); await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const shared = path.join(real, 'source.txt'); await fs.writeFile(shared, 'old');
  const graph = persistedGraph([parallel('read', [], { inputs: [shared], execution: { mode: 'parallel', tools: ['read_text'] } }), parallel('write', [], { outputs: [path.join(alias, 'source.txt')], execution: { mode: 'parallel', tools: ['write_text'] } })]);
  const began = gate(), release = gate(); const started = [];
  const pending = executeNodeGraph({ ...graph, revision: 1, run: async node => { started.push(node.id); if (node.id === 'read') { began.release(); await release.promise; } return outcome(node.id); } });
  await began.promise; assert.deepEqual(started, ['read']); release.release(); await pending; assert.deepEqual(started, ['read', 'write']);
});

test('scope checks reject undeclared output writes and sealed identities before any action', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-scope-')), file = path.join(dir, 'report.txt');
  const nodes = normalizePlan([parallel('writer', [], { outputs: [file], execution: { mode: 'parallel', tools: ['write_text'] } })]);
  let active = true, calls = 0;
  const lease = { id: 'lease', claims: await claimsFor(nodes[0], nodes), dispatch: async () => {}, assertActive() { if (!active) throw new Error('expired'); } };
  const scoped = scopeNodeTools({ names: new Set(['write_text', 'run_command']), definitions: [], has: () => true, execute: async () => { calls++; } }, nodes[0], nodes, lease);
  await assert.rejects(scoped.execute('write_text', { path: path.join(dir, 'other.txt') }), error => error.code === 'NODE_SCOPE_VIOLATION');
  await assert.rejects(scoped.execute('run_command', {}), error => error.code === 'NODE_SCOPE_VIOLATION'); assert.equal(calls, 0);
  await scoped.execute('write_text', { path: file }); assert.equal(calls, 1); active = false;
  await assert.rejects(scoped.execute('write_text', { path: file }), /expired/); assert.equal(calls, 1);
});

test('a revision change fences a delayed result and leaves dependents unstarted', async () => {
  const graph = persistedGraph([parallel('a'), parallel('join', ['a'])]), began = gate(), release = gate(); let revision = 1, savedLease;
  const pending = executeNodeGraph({ ...graph, revision: 1, currentRevision: () => revision, run: async (_node, lease) => { savedLease = lease; began.release(); await release.promise; return outcome('late result'); } });
  const rejected = assert.rejects(pending, error => error.code === 'NODE_EXECUTION_EXPIRED');
  await began.promise; revision = 2; release.release(); await rejected;
  assert.equal(graph.current()[0].verification.passed, false); assert.equal(graph.current()[1].runtime_status, undefined);
  assert.throws(() => savedLease.assertActive(), /已经|已结束/);
});

test('failed persistence cannot dispatch a worker and ambiguous writers cannot overwrite each other', async () => {
  const graph = persistedGraph([parallel('a')]); let calls = 0;
  await assert.rejects(executeNodeGraph({ ...graph, revision: 1, persist: async () => { throw new Error('disk unavailable'); }, run: async () => { calls++; return outcome('a'); } }), /disk unavailable/); assert.equal(calls, 0);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-output-owner-')), file = path.join(dir, 'report.txt');
  const writers = persistedGraph(['a','b'].map(id => parallel(id, [], { outputs: [file], execution: { mode: 'parallel', tools: ['write_text'] } })));
  await assert.rejects(executeNodeGraph({ ...writers, revision: 1, run: async () => { calls++; return outcome('bad'); } }), error => error.code === 'NODE_OUTPUT_CONFLICT'); assert.equal(calls, 0);
});

test('one failed branch keeps an independently verified sibling and cannot release their join', async () => {
  const graph = persistedGraph([parallel('a'), parallel('b'), parallel('join', ['a', 'b'])]), both = gate(), release = gate(); let count = 0;
  const result = executeNodeGraph({ ...graph, revision: 1, run: async node => { assert.notEqual(node.id, 'join'); if (++count === 2) both.release(); await release.promise; return outcome(node.id, node.id !== 'a'); } });
  await both.promise; release.release(); const completed = await result;
  assert.match(completed.failure, /a/); assert.equal(graph.current()[1].verification.passed, true); assert.equal(graph.current()[2].runtime_status, undefined);
});

test('parent cancellation fences pending workers before a delayed action and drains them before returning', async () => {
  const graph = persistedGraph([parallel('a'), parallel('join', ['a'])]), controller = new AbortController(), began = gate(), release = gate(); let actions = 0, ended = false;
  const pending = executeNodeGraph({ ...graph, revision: 1, signal: controller.signal, run: async (_node, lease) => { began.release(); await release.promise; try { lease.assertActive(); actions++; return outcome('a'); } finally { ended = true; } } });
  const rejected = assert.rejects(pending); await began.promise; controller.abort(new Error('user stopped')); assert.equal(ended, false); release.release(); await rejected;
  assert.equal(actions, 0); assert.equal(ended, true); assert.notEqual(graph.current()[0].verification?.passed, true);
});

test('parallel verification cannot borrow an unrelated file as proof', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'node-foreign-proof-')), foreign = path.join(dir,'foreign.txt'); await fs.writeFile(foreign,'already exists');
  const graph = persistedGraph([parallel('a', [], { criteria: [{check:'file_exists',target:foreign}] })]); let actions=0;
  await assert.rejects(executeNodeGraph({...graph,revision:1,run:async()=>{actions++;return outcome('a');}}),error=>error.code==='NODE_SCOPE_VIOLATION');assert.equal(actions,0);
});
