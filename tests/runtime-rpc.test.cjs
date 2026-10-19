const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { createRuntimeServer, connectRuntime, RuntimeClient, addressFor, descriptorPath } = require('../electron/runtime-rpc.cjs');
const directory = () => fs.mkdtemp(path.join(os.tmpdir(), 'pisces-runtime-rpc-'));

test('one profile has one execution owner, and reconnects to its typed local RPC without exposing its token', async () => {
  const dir = await directory();
  const host = await createRuntimeServer({ dir, version: 'test', dispatch: (name, _event, args) => ({ name, args }) });
  host.ready(); let client;
  try {
    client = await connectRuntime(dir, 1500, { role: 'ui' });
    const state = await client.call('runtime:status');
    assert.equal(state.uiClients, 1); assert.equal(state.pid, process.pid); assert.equal(state.token, undefined);
    assert.deepEqual(await client.call('prefs:get', [{ flag: false }]), { name: 'prefs:get', args: [{ flag: false }] });
    await assert.rejects(createRuntimeServer({ dir, version: 'second', dispatch: () => null }), error => error.code === 'EADDRINUSE');
    assert.equal(JSON.parse(await fs.readFile(descriptorPath(dir), 'utf8')).version, 'test');
  } finally { client?.close(); await host.close(); }
});

test('an unauthenticated pipe caller cannot invoke a task operation', async () => {
  const dir = await directory(); let writes = 0;
  const host = await createRuntimeServer({ dir, version: 'test', dispatch: () => { writes++; } }); host.ready();
  const socket = net.createConnection(addressFor(dir));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const client = new RuntimeClient(socket, 'incorrect-token');
  try { await assert.rejects(client.call('jobs:create', [{}]), error => error.code === 'RUNTIME_UNAUTHORIZED'); assert.equal(writes, 0); }
  finally { client.close(); await host.close(); }
});

test('losing a write acknowledgement is unknown, and the same request cannot create another task', async () => {
  const dir = await directory(); let release, started, executions = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const host = await createRuntimeServer({ dir, version: 'test', dispatch: async () => { executions++; started(); await gate; return { id: 'persisted-task' }; } }); host.ready();
  const first = await connectRuntime(dir); let second;
  try {
    const id = randomUUID(), args = [{ goal: 'write and verify a report' }];
    const pending = first.call('jobs:create', args, { id });
    const rejected = assert.rejects(pending, error => error.code === 'CORE_ACTION_UNCERTAIN' && error.execution_status === 'unknown' && error.automatic_retry === false);
    await began; first.close(); await rejected;
    release(); second = await connectRuntime(dir);
    assert.deepEqual(await second.call('jobs:create', args, { id }), { id: 'persisted-task' }); assert.equal(executions, 1);
    await assert.rejects(second.call('jobs:create', [{ goal: 'different task' }], { id }), error => error.code === 'RUNTIME_REQUEST_CONFLICT');
  } finally { release(); first.close(); second?.close(); await host.close(); }
});

test('startup cannot dispatch jobs until the single owner finishes loading its stores', async () => {
  const dir = await directory(); let writes = 0;
  const host = await createRuntimeServer({ dir, version: 'test', dispatch: () => { writes++; return true; } });
  const client = await connectRuntime(dir);
  try {
    assert.equal((await client.call('runtime:status')).ready, false);
    await assert.rejects(client.call('jobs:create', [{}]), error => error.code === 'RUNTIME_NOT_READY' && error.execution_status === 'not_started'); assert.equal(writes, 0);
    host.ready(); assert.equal(await client.call('jobs:create', [{}]), true);
  } finally { client.close(); await host.close(); }
});

test('a new UI cannot silently use or replace an execution owner from another version', async () => {
  const dir = await directory(); let launches = 0;
  const host = await createRuntimeServer({ dir, version: 'old-version', dispatch: () => true }); host.ready();
  try {
    await assert.rejects(require('../electron/runtime-rpc.cjs').ensureRuntime({ dir, version: 'new-version', launch: async () => { launches++; } }), error => error.code === 'RUNTIME_VERSION_MISMATCH');
    assert.equal(launches, 0); assert.equal(host.state().ready, true);
  } finally { await host.close(); }
});
