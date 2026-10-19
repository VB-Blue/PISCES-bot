const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { mkdtemp, rm } = require('node:fs/promises');
const scheduler = require('../electron/scheduler.cjs');

test('scheduler creates, lists, cancels and triggers proactive reminders', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'scheduler-test-'));
  try {
    const fired = [];
    await scheduler.initScheduler(tmpDir, () => null, (reminder) => {
      fired.push(reminder);
    });

    const initial = scheduler.listReminders();
    assert.deepEqual(initial, []);

    // 1. Create a reminder in 1 second
    const r1 = scheduler.createReminder({
      title: '喝水提醒',
      content: '该喝一杯温开水了',
      delaySeconds: 1,
      session: 'sess-test-1',
    });
    assert.equal(r1.title, '喝水提醒');
    assert.equal(r1.content, '该喝一杯温开水了');
    assert.equal(r1.status, 'pending');
    assert.equal(r1.session, 'sess-test-1');

    // 2. Create another reminder in 1000 seconds then cancel it
    const r2 = scheduler.createReminder({
      title: '稍后会议',
      content: '15分钟后开会',
      delaySeconds: 1000,
    });
    assert.equal(r2.status, 'pending');
    const cancelled = scheduler.cancelReminder(r2.id);
    assert.equal(cancelled, true);

    const list = scheduler.listReminders();
    assert.equal(list.length, 2);
    assert.equal(list.find(r => r.id === r2.id)?.status, 'cancelled');

    // 3. Wait for r1 to trigger
    for (let i = 0; i < 30; i++) {
      if (fired.length > 0) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(fired.length, 1);
    assert.equal(fired[0].id, r1.id);
    assert.equal(fired[0].status, 'fired');
  } finally {
    scheduler.stopScheduler();
    await new Promise(resolve => setTimeout(resolve, 50));
    await rm(tmpDir, { recursive: true, force: true });
  }
});
