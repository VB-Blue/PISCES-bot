const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createJobs } = require('../electron/jobs.cjs');

test('startup automatically checks an interrupted canonical task while keeping deliberate pauses and cancellations stopped', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jobs-auto-recovery-'));
  const seed=status=>({id:status,title:status,goal:'continue the saved report',status,createdAt:new Date().toISOString(),runs:1,log:[],steps:1,runId:'old-'+status,workId:'canonical-'+status,plan:[{id:'read',do:'Read back saved file',status:'doing',runtime_status:'doing'}],result:'',notes:'saved progress'});
  await fs.writeFile(path.join(dir,'jobs.json'),JSON.stringify(['running','paused','cancelled'].map(seed)));
  const started=[];
  const jobs=createJobs({dir,autoResumeInterrupted:true,run:async snapshot=>{started.push(snapshot.id);return {text:'checked and recovered',subject:{passed:true}};}});
  try{
    await jobs.init();const completed=await waitFor(jobs,'running','done');
    assert.deepEqual(started,['running']);assert.equal(completed.workId,'canonical-running');
    assert.equal(completed.runHistory[0].status,'interrupted');
    assert.equal(jobs.get('paused').status,'paused');assert.equal(jobs.get('cancelled').status,'cancelled');
  }finally{jobs.stop();jobs.stopAll();}
});

async function waitFor(jobs, id, status) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (jobs.get(id)?.status === status) return jobs.get(id);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for ' + status);
}

test('checkpoint API persists the source job, isolates snapshots and survives an interrupted restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-checkpoint-'));
  let api, saved;
  const gate = new Promise(resolve => { saved = resolve; });
  const jobs = createJobs({ dir, run: async (snapshot, run) => {
    api = run;
    snapshot.notes = 'snapshot mutation must never be persisted';
    await run.saveCheckpoint({ notes: 'read file; next: verify output', artifacts: [{ id: 'draft', path: 'draft.txt' }] });
    await run.setWork({ id: 'canonical-work', cognition: { revision: 4, plan: [{ id: 'read', text: 'Read file', status: 'done', depends_on: [] }] }, status: 'running' });
    saved();
    await new Promise((resolve, reject) => run.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  let restarted;
  try {
    await jobs.init();
    const job = jobs.create({ goal: 'read and verify report' });
    await gate;
    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'jobs.json'), 'utf8'))[0];
    assert.equal(persisted.notes, 'read file; next: verify output');
    assert.equal(persisted.workId, 'canonical-work');
    assert.equal(persisted.workRevision, 4);
    assert.equal(persisted.plan[0].id, 'read');
    const exposed = jobs.get(job.id); exposed.plan[0].status = 'blocked';
    assert.equal(jobs.get(job.id).plan[0].status, 'done');
    jobs.stop();
    restarted = createJobs({ dir, run: async () => assert.fail('recovery must not replay without reconciliation') });
    await restarted.init();
    const recovered = restarted.get(job.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.notes, persisted.notes);
    assert.equal(recovered.workId, 'canonical-work');
    assert.equal(recovered.runHistory.at(-1).status, 'interrupted');
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'jobs.json'), 'utf8'))[0].status, 'interrupted');
    jobs.cancel(job.id);
    await waitFor(jobs, job.id, 'cancelled');
    await assert.rejects(api.saveCheckpoint({ notes: 'late obsolete callback' }), /已经结束/);
  } finally { jobs.stop(); restarted?.stop(); jobs.stopAll(); }
});

test('repeating runs retain the successful output when a later run fails or fails verification', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-history-'));
  let clock = 1000, calls = 0;
  const jobs = createJobs({ dir, now: () => clock, run: async () => {
    if (++calls === 1) return { text: 'verified first report', artifacts: [{ path: 'first-report.txt' }] };
    if (calls === 2) throw new Error('network unavailable');
    return { text: 'executor claims success', subject: { passed: false, unmet: ['report has no totals'] } };
  } });
  try {
    await jobs.init();
    const job = jobs.create({ goal: 'generate daily report', repeat: 'hourly' });
    await waitFor(jobs, job.id, 'scheduled');
    assert.equal(jobs.get(job.id).lastSuccessfulRun.result, 'verified first report');
    clock += 3600001; await jobs.tick();
    const failed = await waitFor(jobs, job.id, 'failed');
    assert.equal(failed.result, 'verified first report');
    assert.equal(failed.lastSuccessfulRun.artifacts[0].path, 'first-report.txt');
    assert.deepEqual(failed.runHistory.map(item => item.status), ['done', 'failed']);
    jobs.resume(job.id);
    const unverified = await waitFor(jobs, job.id, 'unverified');
    assert.equal(unverified.result, 'verified first report');
    assert.equal(unverified.lastSuccessfulRun.version, 1);
    assert.equal(unverified.runVersion, 3);
    assert.equal(unverified.runHistory.at(-1).status, 'unverified');
  } finally { jobs.stop(); jobs.stopAll(); }
});

test('pause and resume preserve checkpoint and reject an earlier run callback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-resume-'));
  let oldApi, secondSnapshot;
  const jobs = createJobs({ dir, run: async (snapshot, api) => {
    if (snapshot.runs === 1) {
      oldApi = api; await api.saveCheckpoint({ notes: 'draft persisted', plan: [{ id: 'write', text: 'Write draft', status: 'done' }] });
    } else secondSnapshot = snapshot;
    await new Promise((resolve, reject) => {
      if (api.signal.aborted) return reject(new Error('aborted'));
      api.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } });
  try {
    await jobs.init(); const job = jobs.create({ goal: 'write and review draft' });
    while (!oldApi || !jobs.get(job.id).checkpointAt) await new Promise(resolve => setTimeout(resolve, 10));
    jobs.pause(job.id); await waitFor(jobs, job.id, 'paused'); jobs.resume(job.id);
    while (!secondSnapshot) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(secondSnapshot.notes, 'draft persisted');
    assert.equal(secondSnapshot.plan[0].id, 'write');
    assert.notEqual(secondSnapshot.runId, oldApi.runId);
    await assert.rejects(oldApi.saveCheckpoint({ notes: 'stale overwrite' }), /已经结束/);
    assert.equal(jobs.get(job.id).notes, 'draft persisted');
    jobs.cancel(job.id); await waitFor(jobs, job.id, 'cancelled');
    assert.deepEqual(jobs.get(job.id).runHistory.map(item => item.status), ['paused', 'cancelled']);
  } finally { jobs.stop(); jobs.stopAll(); }
});

test('a failed checkpoint write rejects instead of acknowledging durable recovery', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-save-failure-'));
  let gateRelease, error;
  const gate = new Promise(resolve => { gateRelease = resolve; });
  const jobs = createJobs({ dir, run: async (_snapshot, api) => {
    await fs.mkdir(path.join(dir, 'jobs.json.tmp'));
    try { await api.saveCheckpoint({ notes: 'not durable' }); } catch (caught) { error = caught; }
    gateRelease();
    throw error;
  } });
  try {
    await jobs.init(); const job = jobs.create({ goal: 'record interrupted work' }); await gate;
    assert.ok(error, 'failed persistence must be visible to the executor');
    assert.ok((await waitFor(jobs, job.id, 'failed')).persistenceError);
    assert.equal(jobs.get(job.id).lastSuccessfulRun, null);
  } finally { jobs.stop(); jobs.stopAll(); }
});

test('new requirements cancel the old run and persist a new instruction version on the same work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-revise-')); let ready, observed;
  const gate = new Promise(resolve => { ready = resolve; });
  const jobs = createJobs({ dir, run: async (snapshot, api) => {
    if (snapshot.runs === 1) {
      await api.setWork({ id: 'same-work', revision: 1, plan: [{ id: 'old', text: 'Old requirement', status: 'doing' }] });
      api.progress({ phase: 'started', operation: 'write_text', label: 'Writing initial report' }); ready();
      await new Promise((resolve, reject) => api.signal.addEventListener('abort', () => reject(new Error('aborted old requirement')), { once: true }));
    }
    observed = snapshot;
    await api.setWork({ id: 'same-work', revision: 2, plan: [{ id: 'new', text: 'New requirement', status: 'done' }] });
    return { text: 'report for new requirement' };
  } });
  try {
    await jobs.init(); const job = jobs.create({ goal: 'produce a weekly report' }); await gate;
    jobs.addInstruction(job.id, 'include the quarterly total');
    const done = await waitFor(jobs, job.id, 'done');
    assert.equal(observed.workId, 'same-work');
    assert.equal(observed.workInstructionVersion, 0);
    assert.equal(observed.instructionVersion, 1);
    assert.equal(done.workId, 'same-work'); assert.equal(done.workRevision, 2);
    assert.equal(done.workInstructionVersion, 1);
    assert.deepEqual(done.runHistory.map(item => item.status), ['superseded', 'done']);
    assert.equal(done.runHistory[0].currentAction.status, 'needs_recheck');
    assert.equal(done.result, 'report for new requirement');
    await jobs.flush();
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'jobs.json'), 'utf8'))[0].instructionVersion, 1);
  } finally { jobs.stop(); jobs.stopAll(); }
});

test('unfinished execution preserves unresolved actions and cannot become a successful run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-unresolved-'));
  const jobs = createJobs({ dir, run: async () => ({ text: 'claimed done', executionStatus: 'incomplete', unresolvedSteps: [{ operation: 'send', status: 'not_executed' }] }) });
  try {
    await jobs.init(); const job = jobs.create({ goal: 'write and send the report' });
    const failed = await waitFor(jobs, job.id, 'failed');
    assert.equal(failed.lastSuccessfulRun, null);
    assert.equal(failed.result, '');
    assert.equal(failed.executionStatus, 'incomplete');
    assert.equal(failed.unresolvedSteps[0].status, 'not_executed');
    assert.equal(failed.runHistory[0].unresolvedSteps[0].operation, 'send');
  } finally { jobs.stop(); jobs.stopAll(); }
});

test('a task creation identity survives owner restart and cannot be reused for different work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-create-once-'));
  const input = { goal: 'save one scheduled report', runAt: Date.now() + 60000, creationKey: require('node:crypto').randomUUID() };
  const jobs = createJobs({ dir, run: async () => assert.fail('scheduled task cannot start yet') });
  let restarted;
  try {
    await jobs.init(); const first = jobs.create(input); await jobs.flush(); jobs.stop();
    restarted = createJobs({ dir, run: async () => assert.fail('scheduled task cannot start yet') }); await restarted.init();
    assert.equal(restarted.create(input).id, first.id); assert.equal(restarted.list().length, 1);
    assert.throws(() => restarted.create({ ...input, goal: 'write a different report' }), /不同任务/);
  } finally { jobs.stop(); restarted?.stop(); }
});

test('a stale approval cannot authorize the next action of the same task', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-approval-identity-'));
  const decisions = [];
  const jobs = createJobs({ dir, run: async (_snapshot, api) => {
    decisions.push(await api.ask({ title: 'first write' })); decisions.push(await api.ask({ title: 'second write' })); return { text: 'confirmed writes' };
  } });
  try {
    await jobs.init(); const created = jobs.create({ goal: 'write two reviewed files' });
    const first = await waitFor(jobs, created.id, 'waiting'); jobs.resolveApproval(created.id, 'once', first.approval.id);
    for (let i = 0; i < 300 && jobs.get(created.id).approval?.title !== 'second write'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const second = jobs.get(created.id); assert.equal(second.approval?.title, 'second write');
    assert.throws(() => jobs.resolveApproval(created.id, 'once', first.approval.id), /发生变化/);
    assert.equal(jobs.get(created.id).status, 'waiting'); assert.deepEqual(decisions, ['once']);
    jobs.resolveApproval(created.id, 'deny', second.approval.id); await waitFor(jobs, created.id, 'done'); assert.deepEqual(decisions, ['once', 'deny']);
  } finally { jobs.stop(); jobs.stopAll(); }
});

test('stopping the owner pauses running, queued and scheduled work durably without starting queued jobs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-owner-stop-')), started = [];
  let ready; const active = new Promise(resolve => { ready = resolve; });
  const jobs = createJobs({ dir, maxRunning: 1, run: async (snapshot, api) => {
    started.push(snapshot.id); await api.setWork({ id: 'saved-work', revision: 1, plan: [{ id: 'read', text: 'read first', status: 'doing' }] });
    await new Promise((resolve, reject) => { if (api.signal.aborted) return reject(new Error('stopped')); api.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); ready(); });
  } });
  let restarted;
  try {
    await jobs.init(); const first = jobs.create({ goal: 'read a long report' });
    await active;
    const queued = jobs.create({ goal: 'write a queued report' }), scheduled = jobs.create({ goal: 'write a scheduled report', runAt: Date.now() + 60000 });
    jobs.stop(); await jobs.pauseAll(); assert.deepEqual(started, [first.id]);
    assert.ok([first, queued, scheduled].every(job => jobs.get(job.id).status === 'paused'));
    restarted = createJobs({ dir, autoResumeInterrupted: true, run: async () => assert.fail('deliberate pauses must survive owner restart') }); await restarted.init();
    assert.ok(restarted.list().every(job => job.status === 'paused')); assert.equal(restarted.get(first.id).workId, 'saved-work');
  } finally { jobs.stop(); jobs.stopAll(); restarted?.stop(); }
});

test('source changes request a fresh revision while preserving the last successful output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-input-replan-')); let resumed;
  const jobs = createJobs({ dir, run: async (snapshot, api) => {
    if (snapshot.runs === 1) { await api.setWork({ id: 'same-work', revision: 1, plan: [{ id: 'read', text: 'Read source' }] }); return { text: 'old verified report' }; }
    if (snapshot.runs === 2) throw Object.assign(new Error('source changed'), { code: 'CORE_INPUT_CHANGED', sourceChanges: [{ path: 'source.csv', reason: 'hash changed' }] });
    resumed = snapshot; await api.setWork({ id: 'same-work', revision: 1 }); assert.equal(jobs.get(snapshot.id).replanRequested, true);
    await api.setWork({ id: 'same-work', revision: 2, plan: [{ id: 'read', text: 'Read new source' }] }); return { text: 'fresh verified report' };
  } });
  try {
    await jobs.init(); const created = jobs.create({ goal: 'produce and verify report' }); await waitFor(jobs, created.id, 'done');
    jobs.addInstruction(created.id, 'continue with the current source'); const changed = await waitFor(jobs, created.id, 'unverified'); assert.equal(changed.executionStatus, 'input_changed'); assert.equal(changed.result, 'old verified report');
    jobs.resume(created.id); const done = await waitFor(jobs, created.id, 'done'); assert.equal(resumed.replanRequested, true); assert.equal(resumed.sourceChanges[0].path, 'source.csv');
    assert.equal(done.workId, 'same-work'); assert.equal(done.workRevision, 2); assert.equal(done.replanRequested, false); assert.equal(done.result, 'fresh verified report');
  } finally { jobs.stop(); jobs.stopAll(); }
});
