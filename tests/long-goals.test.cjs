const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createJobs } = require('../electron/jobs.cjs');
const { createLongGoals } = require('../electron/long-goals.cjs');
const { createUsageLedger } = require('../electron/model-usage.cjs');
const wait = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('fixture timed out'); };
const input = { objective: '持续检查用户定义的资料并生成可靠的经营摘要', criteria: '必须保留实际资料来源和产物', constraints: '只使用已经授权的工具', minIntervalMinutes: 5, maxIntervalMinutes: 15, dailyTokenLimit: 100000, runTokenLimit: 40000 };
async function setup(t, { run = async () => ({ text: '真实结果', subject: { passed: true } }), review = async () => ({ state: 'continue', summary: '已核对本轮结果', nextAction: '检查最新资料的变化，补充摘要', delayMinutes: 10 }), probe = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pisces-goals-')); let current = Date.parse('2026-10-15T00:00:00Z');
  const now = () => current, usage = createUsageLedger({ dir: path.join(dir, 'usage'), now, timeZone: 'UTC' }); usage.init();
  const jobs = createJobs({ dir: path.join(dir, 'jobs'), run, now, tickMs: 100000 }); await jobs.init();
  const make = () => createLongGoals({ dir: path.join(dir, 'goals'), jobs, usage, review, probe, now, tickMs: 100000 });
  let goals = make(); await goals.init();
  t.after(async () => { await goals.stop(); await jobs.pauseAll(); jobs.stop(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('pisces-goals-')); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, jobs, get goals() { return goals; }, advance: ms => current += ms, async restart() { await goals.stop(); goals = make(); await goals.init(); } };
}

test('a custom objective executes, reviews actual results, and schedules the next round', async t => {
  const f = await setup(t); const goal = f.goals.save(input);
  await wait(() => f.goals.get(goal.id).jobId && f.jobs.get(f.goals.get(goal.id).jobId)?.status === 'done');
  await wait(async () => { await f.goals.tick(); return f.goals.get(goal.id).history.length === 1; }); let state = f.goals.get(goal.id);
  assert.equal(state.history.length, 1); assert.equal(state.cycle, 1); assert.equal(state.status, 'active');
  assert.match(state.nextAction, /最新资料/); assert.equal(state.jobId, null);
  await f.goals.tick(); assert.equal(f.jobs.list().length, 1, 'idle ticks do not create another cycle');
  f.advance(11 * 60000); await f.goals.tick();
  await wait(() => f.jobs.list().length === 2);
  assert.match(f.jobs.list()[0].goal, /前几轮的结果/); assert.equal(f.jobs.list()[0].automation.goalId, goal.id);
});

test('pausing survives restart; editing a paused goal does not silently execute it', async t => {
  const f = await setup(t); const goal = f.goals.save(input);
  await wait(() => f.goals.get(goal.id).jobId); await f.goals.action(goal.id, 'pause');
  await f.restart(); assert.equal(f.goals.get(goal.id).status, 'paused');
  const prior = f.goals.get(goal.id); const count = f.jobs.list().length;
  const edited = f.goals.save({ ...prior, objective: '由用户重新定义的任意长期目标与工作范围' });
  f.advance(24 * 3600000); await f.goals.tick();
  assert.equal(f.goals.get(goal.id).status, 'paused'); assert.equal(f.jobs.list().length, count);
  assert.equal(edited.revision, prior.revision + 1);
});

test('late review results cannot restart a paused goal', async t => {
  let releaseReview, started = false;
  const f = await setup(t, { review: async () => { started = true; return new Promise(resolve => releaseReview = resolve); } });
  const goal = f.goals.save(input);
  await wait(() => f.goals.get(goal.id).jobId && f.jobs.get(f.goals.get(goal.id).jobId)?.status === 'done');
  await wait(() => { void f.goals.tick(); return started; }); await f.goals.action(goal.id, 'pause');
  releaseReview({ state: 'continue', summary: '迟到的结果', nextAction: '继续执行', delayMinutes: 5 }); await f.goals.tick();
  const state = f.goals.get(goal.id); assert.equal(state.status, 'paused'); assert.equal(state.history.length, 0);
  f.advance(24 * 3600000); await f.goals.tick(); assert.equal(f.jobs.list().length, 1);
});

test('unknown effects require attention and are not retried as a new cycle', async t => {
  const f = await setup(t, { run: async () => { throw Object.assign(new Error('远程写入结果未知'), { code: 'CORE_ACTION_UNCERTAIN' }); } });
  const goal = f.goals.save(input);
  await wait(() => f.goals.get(goal.id).jobId && f.jobs.get(f.goals.get(goal.id).jobId)?.status === 'failed');
  await wait(async () => { await f.goals.tick(); return f.goals.get(goal.id).status === 'attention'; });
  f.advance(7 * 86400000); await f.goals.tick(); assert.equal(f.jobs.list().length, 1);
});

test('round budget exhaustion pauses the goal and never retries merely because a day passed', async t => {
  const f = await setup(t, { run: async () => { throw Object.assign(new Error('本轮预算不足'), { code: 'TOKEN_BUDGET_EXCEEDED', budgetKind: 'round' }); } });
  const goal = f.goals.save(input);
  await wait(() => f.goals.get(goal.id).jobId && f.jobs.get(f.goals.get(goal.id).jobId)?.errorCode === 'TOKEN_BUDGET_EXCEEDED');
  await wait(async () => { await f.goals.tick(); return f.goals.get(goal.id).status === 'budget'; });
  f.advance(2 * 86400000); await f.goals.tick(); assert.equal(f.goals.get(goal.id).status, 'budget');
  assert.equal(f.jobs.list()[0].runs, 1);
});

test('review cadence is bounded by the user, and missing connections stop further rounds', async t => {
  const f = await setup(t, { review: async () => ({ state: 'needs_input', summary: '已有结果，但缺少授权连接', nextAction: '请连接用户选择的数据源', delayMinutes: 1 }) });
  const goal = f.goals.save(input);
  await wait(() => f.goals.get(goal.id).jobId && f.jobs.get(f.goals.get(goal.id).jobId)?.status === 'done');
  await wait(async () => { await f.goals.tick(); return f.goals.get(goal.id).status === 'attention'; }); assert.equal(f.goals.get(goal.id).nextRunAt, null);
  assert.match(f.goals.get(goal.id).notice, /连接/);
});

test('unchanged sources skip model work, while a real change starts another round', async t => {
  let fingerprint = 'original', probes = 0, rounds = 0, reviews = 0;
  const f = await setup(t, { probe: async () => { probes++; return fingerprint; }, run: async () => { rounds++; return { text: '实际检查结果', subject: { passed: true } }; },
    review: async () => { reviews++; return { state: 'continue', summary: '本轮已核对', nextAction: '核对新的变化', delayMinutes: 5 }; } });
  const goal = f.goals.save({ ...input, watchPaths: [path.join(f.dir, 'source.txt')] });
  await wait(async () => { await f.goals.tick(); return f.goals.get(goal.id).history.length === 1; });
  f.advance(6 * 60000); await f.goals.tick();
  assert.equal(rounds, 1); assert.equal(reviews, 1); assert.equal(f.jobs.list().length, 1); assert.equal(probes, 2);
  fingerprint = 'changed'; f.advance(6 * 60000); await f.goals.tick();
  await wait(() => rounds === 2); assert.equal(f.jobs.list().length, 2);
});

test('a slow review cannot prevent another custom goal from starting', async t => {
  let release, entered = false;
  const f = await setup(t, { review: async () => { entered = true; return new Promise(resolve => release = resolve); } });
  const first = f.goals.save(input);
  await wait(() => { void f.goals.tick(); return entered; });
  const second = f.goals.save({ ...input, objective: '另一个完全不同的持续目标，应独立开始执行' });
  await wait(() => f.goals.get(second.id).jobId);
  assert.notEqual(f.goals.get(first.id).jobId, f.goals.get(second.id).jobId);
  await f.goals.action(first.id, 'pause');
  release({ state: 'continue', summary: '旧复核', nextAction: '下一步', delayMinutes: 5 });
  await f.goals.action(second.id, 'pause'); await f.goals.tick();
});

test('a paused goal cannot dispatch a cycle after a late source probe', async t => {
  let release, entered = false;
  const f = await setup(t, { probe: async () => { entered = true; return new Promise(resolve => release = resolve); } });
  const goal = f.goals.save({ ...input, watchPaths: [path.join(f.dir, 'source.txt')] });
  await wait(() => entered); await f.goals.action(goal.id, 'pause'); release('fingerprint'); await f.goals.tick();
  assert.equal(f.jobs.list().length, 0); assert.equal(f.goals.get(goal.id).status, 'paused');
});

test('a new budget day resumes the original unfinished task instead of duplicating it', async t => {
  let attempts = 0;
  const f = await setup(t, { run: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('今日预算不足'), { code: 'TOKEN_BUDGET_EXCEEDED', budgetKind: 'goal_daily' }); return { text: '原任务完成', subject: { passed: true } }; } });
  const goal = f.goals.save(input);
  await wait(async () => { await f.goals.tick(); return f.goals.get(goal.id).status === 'budget'; });
  const jobId = f.goals.get(goal.id).jobId; f.advance(86400000); await f.goals.tick();
  await wait(() => f.jobs.get(jobId).status === 'done');
  assert.equal(f.jobs.list().length, 1); assert.equal(f.jobs.get(jobId).runs, 2);
});

test('editing after a completed task does not certify old results against new criteria', async t => {
  const f = await setup(t); const goal = f.goals.save(input);
  await wait(() => f.goals.get(goal.id).jobId && f.jobs.get(f.goals.get(goal.id).jobId)?.status === 'done');
  await f.goals.action(goal.id, 'pause');
  const current = f.goals.get(goal.id);
  f.goals.save({ ...current, criteria: '全新的检查标准，必须重新检查' });
  assert.equal(f.goals.get(goal.id).jobId, null);
  await f.goals.action(goal.id, 'resume'); await wait(() => f.jobs.list().length === 2);
  assert.match(f.jobs.list()[0].goal, /全新的检查标准/); assert.equal(f.jobs.list()[0].automation.revision, 2);
});

test('a completion message without actual acceptance cannot start the next round', async t => {
  let reviewed = false;
  const f = await setup(t, { run: async () => ({ text: '我说已经做完了' }), review: async () => { reviewed = true; return {}; } });
  const goal = f.goals.save(input);
  await wait(async () => { await f.goals.tick(); return f.goals.get(goal.id).status === 'attention'; });
  assert.equal(reviewed, false); assert.equal(f.goals.get(goal.id).history.length, 0); assert.equal(f.jobs.list().length, 1);
});

test('temporary review failures back off without executing the work again', async t => {
  let reviews = 0;
  const f = await setup(t, { review: async () => { reviews++; if (reviews === 1) throw new Error('AI 返回 HTTP 503'); return { state: 'continue', summary: '已核对结果', nextAction: '继续检查变化', delayMinutes: 5 }; } });
  const goal = f.goals.save(input);
  await wait(async () => { await f.goals.tick(); return f.goals.get(goal.id).reviewFailures === 1; });
  for (let i = 0; i < 5; i++) await f.goals.tick(); assert.equal(reviews, 1); assert.equal(f.jobs.list()[0].runs, 1);
  f.advance(6 * 60000); await f.goals.tick(); assert.equal(reviews, 2); assert.equal(f.goals.get(goal.id).history.length, 1); assert.equal(f.jobs.list().length, 1);
});

test('long objectives cannot silently truncate owner constraints', () => {
  const { configuration, cycleRequest } = require('../electron/long-goals.cjs');
  assert.throws(() => configuration({ ...input, objective: '长'.repeat(4700), constraints: '必须保留的约束'.repeat(40) }), /不会截断/);
  const config = configuration({ ...input, objective: '目标'.repeat(1300), constraints: '完整保留用户的全部约束条件。'.repeat(70) });
  const request = cycleRequest({ ...config, nextAction: '下一步'.repeat(1000), history: [{ summary: '历史结果'.repeat(2000) }] });
  assert.ok(request.length <= 6000); assert.ok(request.includes(config.constraints)); assert.ok(request.includes(config.objective));
});

test('retrying a creation after reconnect does not duplicate an ongoing goal', async t => {
  const f = await setup(t), creationKey = require('node:crypto').randomUUID();
  const one = f.goals.save({ ...input, creationKey });
  await wait(() => f.goals.get(one.id).jobId); await f.goals.action(one.id, 'pause'); await f.restart();
  const retry = f.goals.save({ ...input, creationKey }); assert.equal(retry.id, one.id); assert.equal(f.goals.list().length, 1);
  assert.throws(() => f.goals.save({ ...input, creationKey, objective: '同一创建请求不能偷偷换成另一个持续目标' }), { code: 'GOAL_CREATION_CONFLICT' });
  assert.equal(f.jobs.list().length, 1);
});

test('execution admission respects goal pause and contract revision', async t => {
  const f = await setup(t); const goal = f.goals.save(input);
  await wait(() => f.goals.get(goal.id).jobId); const job = f.jobs.get(f.goals.get(goal.id).jobId);
  assert.equal(f.goals.admit(job), true);
  assert.throws(() => f.goals.admit({ ...job, automation: { ...job.automation, revision: 999 } }), { code: 'GOAL_NOT_ACTIVE' });
  await f.goals.action(goal.id, 'pause'); assert.throws(() => f.goals.admit(job), { code: 'GOAL_NOT_ACTIVE' });
});

test('changed task requirements invalidate a review even when the goal itself is unchanged', async t => {
  let release, entered = false;
  const f = await setup(t, { review: async () => { entered = true; return new Promise(resolve => release = resolve); } });
  const goal = f.goals.save(input);
  await wait(() => { void f.goals.tick(); return entered; });
  const jobId = f.goals.get(goal.id).jobId;
  f.jobs.addInstruction(jobId, '用户修改了当前轮的验收要求', { queue: false });
  release({ state: 'continue', summary: '按旧要求完成', nextAction: '错误的下一步', delayMinutes: 5 }); await f.goals.tick();
  assert.equal(f.goals.get(goal.id).history.length, 0); assert.equal(f.goals.get(goal.id).jobId, jobId);
});

test('job recovery waits for the long-term owner to admit an interrupted automation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pisces-owner-recovery-'));
  let runs = 0; const jobId = require('node:crypto').randomUUID(), goalId = require('node:crypto').randomUUID();
  await fs.writeFile(path.join(dir, 'jobs.json'), JSON.stringify([{ id: jobId, title: '先检查目标是否暂停', goal: '恢复一个长期目标的当前轮', status: 'running', runs: 1, runId: require('node:crypto').randomUUID(), workId: require('node:crypto').randomUUID(), plan: [{ id: 'work', text: '恢复检查' }], log: [], automation: { goalId, revision: 1, dailyTokenLimit: 100000, runTokenLimit: 40000 } }]));
  const jobs = createJobs({ dir, run: async () => { runs++; return { text: '不应自动运行' }; }, autoResumeInterrupted: true });
  t.after(async () => { await jobs.pauseAll(); jobs.stop(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true }); });
  await jobs.init(); assert.equal(runs, 0); assert.equal(jobs.get(jobId).status, 'interrupted');
});
