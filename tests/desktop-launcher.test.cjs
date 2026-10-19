const test = require('node:test');
const assert = require('node:assert/strict');
const { transition } = require('../electron/desktop-launcher.cjs');
function fixture(extra = {}) {
  const events = [];
  const args = { version: 'new', executable: 'D:/app/new/PISCES AI.exe', inspect: async () => [{ pid: 10, executable: 'D:/app/old/PISCES AI.exe' }], readHost: async () => ({ pid: 11, version: 'old' }), stopHost: async () => events.push('stop-and-flush-host'), snapshot: async () => { events.push('snapshot'); return 'saved-state'; }, closeUI: async () => events.push('close-old-ui'), startUI: async () => events.push('start-ui'), ready: async () => true, ...extra };
  return { events, args };
}
test('one launch saves the stopped legacy state, closes its orphan UI and opens the new desktop in order', async () => {
  const { events, args } = fixture({ readHost: async () => null }); const result = await transition(args);
  assert.deepEqual(events, ['snapshot','close-old-ui','start-ui']); assert.equal(result.ready, true); assert.deepEqual(result.closedInterfaces, [10]); assert.equal(result.backup, 'saved-state');
});
test('an existing old execution host must finish its durable stop before any interface is closed', async () => {
  const { events, args } = fixture(); await transition(args); assert.deepEqual(events, ['stop-and-flush-host','snapshot','close-old-ui','start-ui']);
});
test('opening an already current desktop never closes its interface or stops its execution host', async () => {
  const { events, args } = fixture({ inspect: async () => [{ pid: 10, executable: 'd:/app/new/PISCES AI.exe' }], readHost: async () => ({ version: 'new' }) });
  const result = await transition(args); assert.deepEqual(events, ['start-ui']); assert.equal(result.backup, null);
});
test('a failed durable stop, snapshot, or graceful close cannot start a competing desktop', async t => {
  for (const operation of ['stopHost','snapshot','closeUI']) await t.test(operation, async () => {
    const { events, args } = fixture({ [operation]: async () => { throw new Error(operation + ' failed'); } });
    await assert.rejects(transition(args), new RegExp(operation + ' failed')); assert.ok(!events.includes('start-ui'));
  });
});
test('a spawned process without a ready host and visible desktop is not reported as a successful launch', async () => {
  const { args } = fixture({ ready: async () => false, timeoutMs: 1 }); await assert.rejects(transition(args), /启动未能就绪/);
});
