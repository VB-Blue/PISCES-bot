const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const memory = require('../electron/memory.cjs');
const { createTools } = require('../electron/tools.cjs');
const { createCheckpoints } = require('../electron/checkpoints.cjs');
const { createMcp } = require('../electron/mcp.cjs');
const { createJobs } = require('../electron/jobs.cjs');

const tmp = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix));
const allow = { ask: async () => 'once' };

async function toolsIn(dir, extra = {}) {
  await memory.init(path.join(dir, 'memory'));
  const docs = path.join(dir, 'docs'); await fs.mkdir(docs, { recursive: true });
  const checkpoints = createCheckpoints(path.join(dir, 'checkpoints'));
  const tools = createTools({ memory, userDataDir: path.join(dir, 'u'), getPrefs: () => ({}), host: { path: name => name === 'documents' ? docs : path.join(dir, name), openExternal: async () => {}, checkpoints, ...extra } });
  return { tools, docs, checkpoints };
}

test('every file change keeps a restore point, and rollback refuses to overwrite later work', async () => {
  const dir = await tmp('cp-');
  const { tools, docs, checkpoints } = await toolsIn(dir);
  const file = path.join(docs, 'note.txt');
  await tools.execute('write_text', { path: file, content: '第一版' }, allow);
  await tools.execute('write_text', { path: file, content: '第二版', overwrite: true }, allow);
  const entries = await checkpoints.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'overwrite');
  // Undo the overwrite: back to v1.
  await checkpoints.revert(entries[0].id);
  assert.equal(await fs.readFile(file, 'utf8'), '第一版');
  await assert.rejects(checkpoints.revert(entries[0].id), /撤销过/);
  // Undo the creation: the file goes away.
  await checkpoints.revert(entries[1].id);
  await assert.rejects(fs.stat(file));
  // If the user changed the file afterwards, rollback refuses.
  await tools.execute('write_text', { path: file, content: 'AI 写的' }, allow);
  const created = (await checkpoints.list()).find(item => item.status === 'active');
  await fs.writeFile(file, '用户后来自己改的');
  await assert.rejects(checkpoints.revert(created.id), /又被修改过/);
  assert.equal(await fs.readFile(file, 'utf8'), '用户后来自己改的');
});

test('edit_text replaces exactly one place, explains ambiguity, asks first, and can be undone', async () => {
  const dir = await tmp('edit-');
  const { tools, docs, checkpoints } = await toolsIn(dir);
  const file = path.join(docs, 'code.js');
  await fs.writeFile(file, 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n');
  await assert.rejects(tools.execute('edit_text', { path: file, old_text: '不存在', new_text: 'x' }, allow), /找不到/);
  await assert.rejects(tools.execute('edit_text', { path: file, old_text: '= 1;', new_text: '= 9;' }, allow), /出现了 2 次/);
  const asked = [];
  await tools.execute('edit_text', { path: file, old_text: 'const b = 2;', new_text: 'const b = 3;' }, { ask: async request => { asked.push(request.title); return 'once'; } });
  assert.deepEqual(asked, ['修改文件（可撤销）']);
  assert.equal(await fs.readFile(file, 'utf8'), 'const a = 1;\nconst b = 3;\nconst a2 = 1;\n');
  await tools.execute('edit_text', { path: file, old_text: '= 1;', new_text: '= 7;', replace_all: true }, allow);
  assert.match(await fs.readFile(file, 'utf8'), /a = 7;[\s\S]*a2 = 7;/);
  await assert.rejects(tools.execute('edit_text', { path: file, old_text: 'const b = 3;', new_text: 'const b = 4;' }, { ask: async () => 'deny' }), /拒绝/);
  const [latest, first] = await checkpoints.list();
  await checkpoints.revert(latest.id);
  await checkpoints.revert(first.id);
  assert.equal(await fs.readFile(file, 'utf8'), 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n');
  await assert.rejects(tools.execute('edit_text', { path: path.join(docs, 'x.exe'), old_text: 'a', new_text: 'b' }, allow), /不能修改可执行/);
});

test('search_text finds lines by content, honors extensions and skips junk folders', async () => {
  const dir = await tmp('search-');
  const { tools, docs } = await toolsIn(dir);
  await fs.mkdir(path.join(docs, 'src')); await fs.mkdir(path.join(docs, 'node_modules'));
  await fs.writeFile(path.join(docs, 'src', 'a.py'), 'print("hello")\n# TODO: 修复登录\n');
  await fs.writeFile(path.join(docs, 'notes.md'), '今天要 TODO 登录页\n');
  await fs.writeFile(path.join(docs, 'node_modules', 'x.js'), 'TODO 不该出现\n');
  const all = await tools.execute('search_text', { query: 'todo', path: docs }, allow);
  assert.equal(all.matches.length, 2);
  assert.ok(all.matches.some(line => /a\.py:2:/.test(line)));
  assert.ok(!all.matches.some(line => /node_modules/.test(line)));
  const onlyPy = await tools.execute('search_text', { query: 'TODO', path: docs, extensions: ['.py'] }, allow);
  assert.equal(onlyPy.matches.length, 1);
  const re = await tools.execute('search_text', { query: 'TODO.{1,4}登录', regex: true, path: docs }, allow);
  assert.equal(re.matches.length, 2);
  await assert.rejects(tools.execute('search_text', { query: '(', regex: true, path: docs }, allow), /正则/);
});

const fakeServer = path.join(__dirname, 'fixtures', 'fake-mcp.cjs');
const passthrough = { encrypt: value => 'enc:' + value, decrypt: value => String(value).replace(/^enc:/, '') };
async function waitFor(check, label) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('超时：' + label); }

test('connectors: tools are discovered, and the permission level decides what the model can do', async () => {
  const dir = await tmp('mcp-');
  const mcp = createMcp({ dir, ...passthrough, platform: 'linux' });
  await mcp.init();
  const id = 'conn-00001';
  await mcp.save([{ id, name: '笔记本', command: process.execPath, args: [fakeServer], access: 'read', env: { SECRET_TOKEN: 'abc123' } }]);
  await waitFor(() => mcp.list()[0].status === 'ready', '连接器就绪');
  const view = mcp.list()[0];
  assert.deepEqual(view.envKeys, ['SECRET_TOKEN']);
  assert.ok(!JSON.stringify(view).includes('abc123'), '环境变量的值不能返回界面');
  assert.deepEqual(view.tools.map(tool => [tool.name, tool.kind, tool.policy]), [['read_note', 'read', 'allow'], ['create_note', 'write', 'deny'], ['delete_note', 'destructive', 'deny'], ['broken', 'read', 'allow']]);
  // "Read only": the model is only offered the read tools, and cannot reach write tools even by guessing the name.
  const offered = mcp.definitions().map(item => item.function.name);
  assert.equal(offered.length, 2);
  const readName = mcp._toolName({ name: '笔记本', id }, 'read_note');
  assert.ok(offered.includes(readName));
  assert.match((await mcp.execute(readName, { id: 'a' }, {})).result, /第一条笔记/);
  await assert.rejects(mcp.execute(mcp._toolName({ name: '笔记本', id }, 'create_note'), { id: 'b', text: 'x' }, allow), /不可用/);
  await assert.rejects(mcp.execute(mcp._toolName({ name: '笔记本', id }, 'broken'), {}, {}), /服务端出错了/);

  // "Ask": reads are automatic, writes ask first (and a refusal means nothing happens).
  await mcp.save([{ id, name: '笔记本', command: process.execPath, args: [fakeServer], access: 'ask' }]);
  await waitFor(() => mcp.list()[0].status === 'ready' && mcp.list()[0].tools.length === 4, '重新连接');
  const create = mcp._toolName({ name: '笔记本', id }, 'create_note');
  const prompts = [];
  await assert.rejects(mcp.execute(create, { id: 'b', text: 'x' }, { ask: async request => { prompts.push(request); return 'deny'; } }), /拒绝/);
  assert.equal(prompts[0].risk, 'medium');
  assert.match(prompts[0].title, /笔记本/);
  assert.match((await mcp.execute(mcp._toolName({ name: '笔记本', id }, 'read_note'), { id: 'b' }, {})).result, /没有这条笔记/);
  await mcp.execute(create, { id: 'b', text: '第二条' }, { ask: async () => 'session' });
  // A session grant covers repeat calls without asking again.
  assert.match((await mcp.execute(create, { id: 'c', text: '第三条' }, {})).result, /已创建 c/);
  const del = mcp._toolName({ name: '笔记本', id }, 'delete_note');
  const deletePrompt = [];
  await mcp.execute(del, { id: 'b' }, { ask: async request => { deletePrompt.push(request); return 'once'; } });
  assert.equal(deletePrompt[0].risk, 'high');

  // "Auto": writes run without asking, but destructive tools still ask, and per-tool overrides win.
  await mcp.save([{ id, name: '笔记本', command: process.execPath, args: [fakeServer], access: 'auto', overrides: { delete_note: 'deny' } }]);
  await waitFor(() => mcp.list()[0].status === 'ready' && mcp.list()[0].tools.length === 4, '再次连接');
  assert.match((await mcp.execute(create, { id: 'd', text: '自动' }, {})).result, /已创建 d/);
  assert.ok(!mcp.definitions().some(item => item.function.name === del), '被禁用的工具不再提供给模型');
  mcp.shutdown();
});

test('connectors: a command that cannot start is reported, not fatal', async () => {
  const dir = await tmp('mcp-bad-');
  const mcp = createMcp({ dir, ...passthrough, platform: 'linux' });
  await mcp.init();
  await mcp.save([{ name: '坏的', command: 'definitely-not-a-real-command-xyz', args: [] }]);
  await waitFor(() => mcp.list()[0].status === 'error', '报告启动失败');
  assert.ok(mcp.list()[0].error.length > 0);
  assert.equal(mcp.definitions().length, 0);
  await assert.rejects(mcp.save([{ name: 'a', command: 'x' }, { name: 'A', command: 'y' }]), /重复/);
  await assert.rejects(mcp.save([{ name: 'a', command: '' }]), /命令/);
  mcp.shutdown();
});

test('background jobs: run, ask for approval while you are away, take extra instructions, and survive a restart', async () => {
  const dir = await tmp('jobs-');
  const events = [];
  const gate = { release: null };
  const jobs = createJobs({ dir, tickMs: 20, notify: item => events.push(item.kind), run: async (job, api) => {
    api.progress({ phase: 'settled', label: '读取文件', ok: true });
    if (/需要确认/.test(job.goal)) { const decision = await api.ask({ title: '写入文件', lines: ['x'], risk: 'medium' }); if (decision === 'deny') throw new Error('用户拒绝'); }
    if (/等待指令/.test(job.goal)) {
      if (job.runs === 1) await new Promise((resolve, reject) => { gate.release = resolve; api.signal.addEventListener('abort', () => reject(new Error('requirements changed')), { once: true }); });
      return { text: '收到补充：' + job.log.filter(item => item.kind === 'user').map(item => item.text).join('|') };
    }
    if (/一直运行/.test(job.goal)) await new Promise((resolve, reject) => api.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    return { text: '完成：' + job.goal };
  } });
  await jobs.init();
  const wait = async (id, status) => { for (let i = 0; i < 400; i++) { if (jobs.get(id).status === status) return jobs.get(id); await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('等待状态 ' + status + ' 超时，当前 ' + jobs.get(id).status); };

  const plain = jobs.create({ goal: '整理下载文件夹' });
  const finished = await wait(plain.id, 'done');
  assert.equal(finished.result, '完成：整理下载文件夹');
  assert.equal(finished.steps, 1);
  assert.ok(events.includes('done'));

  // Approval: the job waits, the user answers later.
  const needs = jobs.create({ goal: '需要确认的写入任务' });
  const waiting = await wait(needs.id, 'waiting');
  assert.equal(waiting.approval.title, '写入文件');
  assert.ok(events.includes('approval'));
  jobs.resolveApproval(needs.id, 'once');
  await wait(needs.id, 'done');
  const denied = jobs.create({ goal: '需要确认的另一个任务' });
  await wait(denied.id, 'waiting');
  jobs.resolveApproval(denied.id, 'deny');
  assert.equal((await wait(denied.id, 'failed')).error, '用户拒绝');

  // Extra instructions stop the old run and are reinterpreted by a new run.
  const talking = jobs.create({ goal: '等待指令的任务' });
  await wait(talking.id, 'running');
  jobs.addInstruction(talking.id, '顺便也看看 B 文件夹');
  gate.release?.();
  assert.equal((await wait(talking.id, 'done')).result, '收到补充：顺便也看看 B 文件夹');
  assert.equal(jobs.get(talking.id).runs, 2);
  assert.equal(jobs.get(talking.id).runHistory[0].status, 'superseded');

  // Pause/cancel/resume.
  const long = jobs.create({ goal: '一直运行的任务' });
  await wait(long.id, 'running');
  jobs.pause(long.id);
  await wait(long.id, 'paused');
  jobs.resume(long.id);
  await wait(long.id, 'running');
  jobs.cancel(long.id);
  await wait(long.id, 'cancelled');

  // A job that was running when the app quit is interrupted on restart, never replayed.
  const stuck = jobs.create({ goal: '一直运行的任务（重启前）' });
  await wait(stuck.id, 'running');
  await jobs.flush();
  jobs.stop();
  const again = createJobs({ dir, tickMs: 1000, run: async () => { throw new Error('不应该被自动重放'); } });
  await again.init();
  assert.equal(again.get(stuck.id).status, 'interrupted');
  assert.match(again.get(stuck.id).log.at(-1).text, /不会自动重放/);
  again.stop();
  jobs.stopAll();
});

test('background jobs: scheduled and repeating jobs wait for their time, respect the concurrency cap', async () => {
  const dir = await tmp('jobs-sched-');
  let clock = 1_000_000;
  const started = [];
  let running = 0, maxRunning = 0;
  const jobs = createJobs({ dir, now: () => clock, tickMs: 10_000, maxRunning: 2, run: async job => { started.push(job.title); running++; maxRunning = Math.max(maxRunning, running); await new Promise(resolve => setTimeout(resolve, 40)); running--; return { text: 'ok' }; } });
  await jobs.init();
  const daily = jobs.create({ title: '每日简报', goal: '汇总今天的新闻', runAt: clock + 60_000, repeat: 'daily' });
  assert.equal(daily.status, 'scheduled');
  await jobs.tick();
  assert.equal(started.length, 0);
  clock += 61_000;
  await jobs.tick();
  for (let i = 0; i < 200 && jobs.get(daily.id).status !== 'scheduled'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const after = jobs.get(daily.id);
  assert.equal(after.status, 'scheduled', '重复任务完成后重新排期');
  assert.equal(after.runs, 1);
  assert.equal(after.runAt, clock + 86_400_000);
  for (const name of ['甲', '乙', '丙', '丁']) jobs.create({ title: name, goal: '并发测试任务 ' + name });
  for (let i = 0; i < 400 && started.length < 5; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(maxRunning <= 2, '同时最多运行 2 个后台任务（实际 ' + maxRunning + '）');
  assert.throws(() => jobs.create({ goal: 'ab' }), /写清楚/);
  assert.throws(() => jobs.create({ goal: '合法的目标', repeat: 'yearly' }), /重复周期/);
  jobs.stop();
});
