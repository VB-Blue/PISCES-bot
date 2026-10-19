const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMcp } = require('../electron/mcp.cjs');
async function until(check) { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('fixture did not reach expected state'); }
async function fixture(run, callTimeoutMs = 1000) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-evidence-')); const audit = [];
  const mcp = createMcp({ dir, encrypt: value => value, decrypt: value => value, platform: 'linux', callTimeoutMs, audit: entry => audit.push(entry) });
  const id = 'fixture-connector';
  try {
    await mcp.init(); await mcp.save([{ id, name: '本地测试', command: process.execPath, args: [path.join(__dirname, 'fixtures', 'structured-mcp.cjs')], access: 'auto' }]);
    await until(() => mcp.list()[0].status === 'ready');
    const name = tool => mcp._toolName({ id, name: '本地测试' }, tool);
    await run({ mcp, name, dir, id, audit });
  } finally { mcp.shutdown(); }
}

test('MCP preserves structured payloads, resource links, embedded text and usable image artifacts with a full receipt', () => fixture(async ({ mcp, name }) => {
  const result = await mcp.execute(name('rich_result'), {});
  assert.equal(result.ok, true); assert.equal(result.structuredContent.report.rows[0].value, 7);
  assert.match(result.result, /嵌入资源正文/);
  assert.equal(result.content.find(part => part.type === 'resource_link').uri, 'https://example.com/report/7');
  const media = result.artifacts[0]; assert.equal(media.mimeType, 'image/png');
  assert.equal((await fs.readFile(media.path)).readUInt32BE(0), 0x89504e47);
  assert.match(result.image, /^data:image\/png;base64,/);
  assert.ok(!JSON.stringify(result.content).includes('iVBOR'), 'binary content is saved and attached without duplicating it into tool text');
  const receipt = JSON.parse(await fs.readFile(result.evidence.receipt_path, 'utf8'));
  assert.equal(receipt.reply.structuredContent.report.rows[0].checked, true);
  assert.equal(receipt.reply.content.find(part => part.type === 'image').data.length > 20, true);
}));

test('MCP structured failure remains failed and isError preserves its source evidence', () => fixture(async ({ mcp, name, audit }) => {
  const result = await mcp.execute(name('unsatisfied'), {});
  assert.equal(result.ok, false); assert.equal(result.execution_status, 'condition_unmet'); assert.equal(audit.at(-1).ok, false);
  let failure;
  await assert.rejects(mcp.execute(name('error_content'), {}), error => { failure = error; return error.code === 'MCP_TOOL_FAILED' && error.execution_status === 'failed'; });
  const receipt = JSON.parse(await fs.readFile(failure.evidence.receipt_path, 'utf8'));
  assert.equal(receipt.reply.structuredContent.reason, 'validation failed');
}));

test('a timed-out remote write stays unknown, blocks new writes, allows reconciliation reads and retains the late acknowledgement', () => fixture(async ({ mcp, name, id }) => {
  let failure;
  await assert.rejects(mcp.execute(name('write_late'), { delay: 750 }), error => { failure = error; return error.code === 'CORE_ACTION_UNCERTAIN' && error.execution_status === 'unknown' && error.automatic_retry === false; });
  assert.ok(failure.evidence.request_id); assert.equal(mcp.list()[0].pendingWrites.length, 1);
  await assert.rejects(mcp.execute(name('write_late'), { delay: 0 }), error => error.code === 'CORE_ACTION_UNCERTAIN');
  assert.equal((await mcp.execute(name('read_state'), {})).structuredContent.writes, 1, 'the write really happened despite timeout; it must not be replayed');
  await until(() => mcp.list()[0].pendingWrites.length === 0 && mcp.evidence(id).some(entry => entry.late));
  const late = mcp.evidence(id).find(entry => entry.late); assert.equal(late.request_id, failure.evidence.request_id);
  assert.equal(JSON.parse(await fs.readFile(late.receipt_path, 'utf8')).reply.structuredContent.writes, 1);
  const next = await mcp.execute(name('write_late'), { delay: 0 }); assert.equal(next.structuredContent.writes, 2);
}, 200));

test('aborting a remote write reports unknown while aborting before dispatch sends nothing', () => fixture(async ({ mcp, name }) => {
  const pre = new AbortController(); pre.abort();
  await assert.rejects(mcp.execute(name('write_late'), { delay: 100 }, { signal: pre.signal }), error => error.execution_status === 'not_started');
  assert.equal((await mcp.execute(name('read_state'), {})).structuredContent.writes, 0);
  const running = new AbortController(); const result = mcp.execute(name('write_late'), { delay: 200 }, { signal: running.signal });
  for (let i=0;i<50;i++) { if((await mcp.execute(name('read_state'),{})).structuredContent.writes===1)break;await new Promise(resolve=>setTimeout(resolve,5)); }
  running.abort();
  await assert.rejects(result, error => error.code === 'CORE_ACTION_UNCERTAIN' && error.execution_status === 'unknown');
  assert.equal((await mcp.execute(name('read_state'), {})).structuredContent.writes, 1);
  await until(() => mcp.list()[0].pendingWrites.length === 0);
}));

test('an unresolved remote write remains quarantined across an application restart', () => fixture(async ({ mcp, name, dir, id }) => {
  await assert.rejects(mcp.execute(name('write_late'), { delay: 1000 }), error => error.code === 'CORE_ACTION_UNCERTAIN');
  const saved=JSON.parse(await fs.readFile(path.join(dir,'pending-writes.json'),'utf8'));
  assert.equal(saved.length,1);assert.equal(saved[0].tool,'write_late');
  mcp.shutdown();
  const reopened=createMcp({dir,encrypt:value=>value,decrypt:value=>value,platform:'linux'});
  try{
    await reopened.init();await until(()=>reopened.list()[0]?.status==='ready');
    assert.equal(reopened.list()[0].pendingWrites[0].recovered,true);
    await assert.rejects(reopened.execute(name('write_late'),{delay:0}),error=>error.code==='CORE_ACTION_UNCERTAIN');
    assert.equal((await reopened.execute(name('read_state'),{})).structuredContent.writes,0,'the restarted server must receive no second write');
    assert.equal(reopened.list()[0].id,id);
  }finally{reopened.shutdown();}
},200));

test('a remote write with a protocol error or malformed reply remains unknown instead of fabricated success', async t => {
  for (const tool of ['write_rpc_error', 'invalid_write']) await t.test(tool, () => fixture(async ({ mcp, name }) => {
    await assert.rejects(mcp.execute(name(tool), {}), error => error.code === 'CORE_ACTION_UNCERTAIN' && error.execution_status === 'unknown');
    assert.equal(mcp.list()[0].pendingWrites.length, 1);
    assert.equal((await mcp.execute(name('read_state'), {})).structuredContent.writes, 1);
    await assert.rejects(mcp.execute(name('write_late'), { delay: 0 }), error => error.code === 'CORE_ACTION_UNCERTAIN');
  }));
});
