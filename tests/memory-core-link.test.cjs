const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const memory = require('../electron/memory.cjs');

// A stand-in for the core's /memory routes: all-or-nothing batches, idempotent operation ids, a revision per batch.
function fakeCore() {
  const db = { revision: 0, profile: '', memories: [], playbooks: [], skills: [], turns: [], trajectories: [], requirements: null, applied: new Set() };
  const calls = [];
  let online = true;
  const collection = { memory_put: 'memories', playbook_put: 'playbooks', skill_put: 'skills', memory_delete: 'memories', playbook_delete: 'playbooks', skill_delete: 'skills' };
  function applyOne(op) {
    if (op.op === 'requirements_put') db.requirements = op.state;
    else if (op.op.endsWith('_put')) { const list = db[collection[op.op]]; const index = list.findIndex(item => item.id === op.item.id); if (index >= 0) list[index] = op.item; else list.unshift(op.item); }
    else if (op.op.endsWith('_delete')) db[collection[op.op]] = db[collection[op.op]].filter(item => item.id !== op.id);
    else if (op.op === 'profile_set') db.profile = op.text;
    else if (op.op === 'turn') db.turns.push(op.entry);
    else if (op.op === 'trajectory') db.trajectories.push(op.entry);
  }
  async function request(route, body) {
    calls.push({ route, body });
    if (!online) throw new Error('fetch failed');
    if (route === '/api/v1/memory/state') return { ok: true, revision: db.revision, profile: db.profile, memories: structuredClone(db.memories), playbooks: structuredClone(db.playbooks), skills: structuredClone(db.skills), has_requirements: !!db.requirements, stats: { turns: db.turns.length } };
    if (route === '/api/v1/memory/apply') {
      for (const op of body.ops) if (op.op === 'memory_put' && !op.item.text) throw new Error('核心返回 HTTP 409（invalid operation ' + op.id + ': memory text is empty）');
      let applied = 0;
      for (const op of body.ops) { if (db.applied.has(op.id)) continue; applyOne(op); db.applied.add(op.id); applied++; }
      if (applied) db.revision++;
      return { ok: true, revision: db.revision, applied };
    }
    if (route === '/api/v1/memory/context') return { ok: true, revision: db.revision, text: '核心组装：' + body.query, used: { memories: db.memories.slice(0, 1).map(item => ({ id: item.id, text: item.text, kind: item.kind })), playbooks: [], skills: [] } };
    if (route === '/api/v1/memory/search') return { ok: true, memories: db.memories.filter(item => item.text.includes(body.query)), playbooks: [], skills: [], history: [] };
    if (route === '/api/v1/memory/history') return { ok: true, history: db.turns.filter(turn => turn.user.includes(body.query)) };
    if (route === '/api/v1/memory/requirements') return { ok: true, requirements: db.requirements };
    throw new Error('unknown route ' + route);
  }
  return { db, calls, request, setOnline: value => { online = value; } };
}

async function profileDir() {
  return path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'memory-core-link-')), 'memory');
}
const readOutbox = async dir => (await fs.readFile(path.join(dir, 'core-outbox.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));

test('existing local memory moves into the core on first contact, then the core is the source', async () => {
  const dir = await profileDir();
  await memory.init(dir);
  memory.addMemory({ kind: 'preference', text: 'Bybit 发帖先给用户过目', pinned: true });
  memory.addPlaybook({ title: 'Bybit 广场发帖', trigger: '发帖', steps: ['打开广场', '填写内容'] });
  await memory.setProfile('## 基本情况\n- 运营 Bybit 账号');
  await memory.recordTurn({ session: 's0', user: '你来给我日常维护发帖', assistant: '好的' });
  await memory.recordTrajectory({ kind: 'chat', user: '发帖' });
  await memory.flush();

  const core = fakeCore();
  await memory.init(dir, { core });
  const status = await memory.sync();
  assert.equal(status.online, true);
  assert.equal(status.migrated, true);
  assert.equal(status.pending, 0);
  assert.equal(core.db.memories[0].text, 'Bybit 发帖先给用户过目');
  assert.equal(core.db.playbooks[0].title, 'Bybit 广场发帖');
  assert.match(core.db.profile, /运营 Bybit 账号/);
  assert.equal(core.db.turns.length, 1);
  assert.equal(core.db.trajectories.length, 1);
  assert.deepEqual(await readOutbox(dir), []);

  // A restart does not import again, and an edit made in the core reaches the local view.
  core.db.memories.unshift({ id: 'from-core', kind: 'fact', text: '核心里新增的记忆', pinned: false, hits: 0 });
  core.db.revision++;
  await memory.init(dir, { core });
  await memory.sync();
  assert.equal(core.db.memories.filter(item => item.text === 'Bybit 发帖先给用户过目').length, 1);
  assert.ok(memory.listMemories().some(item => item.id === 'from-core'));
});

test('changes queue while the core is offline and reach it in order once it is back', async () => {
  const dir = await profileDir();
  const core = fakeCore();
  core.setOnline(false);
  await memory.init(dir, { core });
  const { memory: saved } = memory.addMemory({ kind: 'fact', text: '用户在新加坡' });
  memory.updateMemory(saved.id, { text: '用户住在新加坡' });
  await memory.recordTurn({ session: 's1', user: '记住我住在新加坡', assistant: '记住了' });
  await memory.flush();
  assert.equal((await readOutbox(dir)).length, 3);
  const local = await memory.prepareContext('新加坡', {});
  assert.equal(local.source, 'local');
  assert.match(local.text, /用户住在新加坡/);
  assert.equal(memory.stats().core.online, false);

  core.setOnline(true);
  const status = await memory.sync();
  assert.equal(status.pending, 0);
  assert.deepEqual(core.db.memories.map(item => item.text), ['用户住在新加坡']);
  assert.equal(core.db.turns[0].user, '记住我住在新加坡');
});

test('the core assembles the context and answers recall, with requirement memories excluded', async () => {
  const dir = await profileDir();
  const core = fakeCore();
  await memory.init(dir, { core });
  memory.addMemory({ kind: 'preference', text: '发帖语气轻松一些' });
  const context = await memory.prepareContext('今天发帖', { goals: [{ title: '写周报', done: false }], session: 'now' });
  assert.equal(context.source, 'core');
  assert.equal(context.text, '核心组装：今天发帖');
  assert.equal(context.used.memories[0].text, '发帖语气轻松一些');
  const call = core.calls.find(item => item.route === '/api/v1/memory/context');
  assert.deepEqual(call.body.goals, [{ title: '写周报', done: false }]);
  assert.ok(Array.isArray(call.body.exclude_memory_ids));
  // The memory added just before was pushed before the core was asked.
  assert.ok(core.calls.findIndex(item => item.route === '/api/v1/memory/apply') < core.calls.indexOf(call));
  assert.equal((await memory.searchAsync('语气')).memories[0].text, '发帖语气轻松一些');
});

test('a change the core rejects is set aside without blocking the rest', async () => {
  const dir = await profileDir();
  const core = fakeCore();
  await memory.init(dir, { core });
  await memory.sync();
  const first = memory.addMemory({ kind: 'fact', text: '第一条' }).memory;
  first.text = '';
  memory.updateMemory(first.id, { pinned: true }); // ships the now-invalid item
  memory.addMemory({ kind: 'fact', text: '第二条' });
  const status = await memory.sync();
  assert.equal(status.pending, 0);
  assert.ok(core.db.memories.some(item => item.text === '第二条'));
  const rejected = (await fs.readFile(path.join(dir, 'core-rejected.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].error, /memory text is empty/);
});

test('long-term requirements are handed to the core and restored from it', async () => {
  const dir = await profileDir();
  const core = fakeCore();
  await memory.init(dir, { core });
  memory.saveRequirements([{ text: '每篇文章不少于 800 字', domain: 'writing' }], { source: 'user' });
  await memory.sync();
  assert.equal(core.db.requirements.rules[0].text, '每篇文章不少于 800 字');

  await fs.rm(path.join(dir, 'requirements.json'));
  await memory.init(dir, { core });
  core.db.revision++; // make the next sync adopt the core's view
  await memory.sync();
  assert.equal(memory.listRequirements()[0].text, '每篇文章不少于 800 字');
});

test('without a core link memory behaves exactly as a local store', async () => {
  const dir = await profileDir();
  await memory.init(dir);
  memory.addMemory({ kind: 'fact', text: '本地记忆' });
  await memory.recordTrajectory({ kind: 'chat', user: '本地' });
  await memory.flush();
  assert.equal(memory.stats().core.linked, false);
  assert.equal((await memory.prepareContext('本地记忆')).source, 'local');
  assert.deepEqual(await readOutbox(dir), []);
  const files = await fs.readdir(path.join(dir, 'trajectories'));
  assert.equal(files.length, 1);
});
