const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src/presenceModel.ts');
const when = '2026-10-04T00:00:00+08:00';
const session = { id: 's-1', title: '已有交流', updated: when, mode: 'core', messages: [{ id: 'u-1', role: 'user', content: '你好' }, { id: 'a-1', role: 'assistant', content: '你好' }] };
const workspace = { version: 1, sessions: [session], traces: [], observe: true, theme: 'light', goals: [], approval: 'pending', memoryHidden: [] };

test('ordinary conversation and an empty workspace do not imply performed work', async () => {
  const { collectWork, collectEvents } = await model;
  assert.deepEqual(collectWork(workspace, null, []), []);
  assert.deepEqual(collectEvents([], []), []);
});

test('an explicit follow-up record stays distinct from a computer execution', async () => {
  const { collectWork, entrySteps } = await model;
  const record = { id: 'r-1', title: '持续完善文档', notes: '保存安排', status: 'active', createdAt: when, updatedAt: when };
  const [entry] = collectWork({ ...workspace, tasks: [record] }, null, []);
  assert.equal(entry.record, record);
  assert.equal(entry.status, '持续跟进');
  assert.equal(entry.work, undefined);
  assert.equal(entry.job, undefined);
  assert.deepEqual(entrySteps(entry), []);
});

test('scheduled work is shown as arranged and not represented as currently executing', async () => {
  const { collectWork } = await model;
  const [entry] = collectWork(workspace, null, [{ id: 'j-1', title: '明天汇总', goal: '汇总资料', status: 'scheduled', updatedAt: when, log: [], session: 'job:j-1' }]);
  assert.equal(entry.ongoing, false);
  assert.equal(entry.status, '已安排');
});

test('a core receipt and the linked dialogue produce one observed work entry', async () => {
  const { collectWork, entrySteps } = await model;
  const work = { id: 'w-1', session: 's-1', goal: '核对资料', status: 'actions_verified', created_at: when, calls: [], receipts: [{ id: 'receipt-1', operation: 'read_file', status: 'failed', evidence: {}, error: '文件已删除' }] };
  const entryWorkspace = { ...workspace, sessions: [{ ...session, messages: [{ ...session.messages[1], steps: [{ label: '读取资料', status: 'failed' }], core: { turnId: 'w-1' } }] }] };
  const entries = collectWork(entryWorkspace, { works: [work] }, []);
  assert.equal(entries.length, 1);
  assert.notEqual(entries[0].status, '已完成');
  assert.equal(entrySteps(entries[0])[0].status, 'failed');
  assert.equal(entrySteps(entries[0])[0].error, '文件已删除');
});

test('live dialogue progress is retained when the core is unavailable', async () => {
  const { collectWork } = await model;
  const [entry] = collectWork(workspace, null, [], 's-1');
  assert.equal(entry.ongoing, true);
  assert.equal(entry.status, '进行中');
  assert.equal(entry.sessionId, 's-1');
});

test('a saved task keeps its draft key while the core is disconnected without claiming a verified result', async () => {
  const { collectWork } = await model;
  const cached = { ...session, messages: [{ ...session.messages[1], coreWorkId:'saved-work', taskEvidence:{workId:'saved-work',revision:1,receipts:[{operation:'read_text',status:'observed_success'}]} }] };
  const [entry] = collectWork({ ...workspace, sessions:[cached] }, null, []);
  assert.equal(entry.id, 'core:saved-work');
  assert.equal(entry.status, '回复已收到');
  assert.equal(entry.work, undefined);
});

test('cross-session cached copies of one task produce one offline entry and preserve the running session', async () => {
  const { collectWork } = await model;
  const message = { ...session.messages[1],coreWorkId:'saved-work',steps:[{label:'读取资料',status:'ok'}] };
  const older = { ...session,id:'older',updated:'2026-10-04T00:00:00Z',messages:[message] };
  const newer = { ...session,id:'newer',updated:'2026-10-05T00:00:00Z',messages:[message] };
  const cached = { ...workspace,sessions:[older,newer] };
  assert.equal(collectWork(cached,null,[]).length,1);
  assert.equal(collectWork(cached,null,[])[0].sessionId,'newer');
  assert.equal(collectWork(cached,null,[],'older')[0].sessionId,'older');
});

test('appearance migration preserves conversation, goals and follow-ups, then respects the selected theme', async () => {
  const { loadWorkspace } = await import('../src/store.ts');
  const original = { ...workspace, tasks: [{ id: 'record-1', title: '已有安排', status: 'paused' }], goals: [{ id: 'goal-1', title: '已有目标', done: false }] };
  let stored = JSON.stringify(original);
  global.window = {};
  global.localStorage = { getItem: () => stored };
  try {
    const migrated = loadWorkspace();
    assert.equal(migrated.theme, 'light');
    assert.equal(migrated.appearanceVersion, 3);
    assert.deepEqual(migrated.sessions, original.sessions);
    assert.deepEqual(migrated.tasks, original.tasks);
    assert.deepEqual(migrated.goals, original.goals);
    stored = JSON.stringify({ ...migrated, appearanceVersion: 2, theme: 'dark' });
    assert.equal(loadWorkspace().theme, 'dark');
  } finally { delete global.window; delete global.localStorage; }
});
