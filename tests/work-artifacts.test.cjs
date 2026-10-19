const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveWorkFile } = require('../electron/work-artifacts.cjs');
const file = path.resolve('result.md');
const work = status => ({ receipts: [{ id: 'receipt', status, operation: 'write_text', evidence: { observation: JSON.stringify({ ok: true, path: file }) } }] });

test('connector media is bound to a persisted receipt and the host artifact directory',()=>{
  const artifactRoot=path.resolve('connector-results'),media=path.join(artifactRoot,'receipt','plot.png');
  const receipt={id:'mcp-receipt',status:'observed_success',operation:'mcp_fixture__make_chart',evidence:{observation:JSON.stringify({ok:true,evidence:{source:'mcp',receipt_path:path.join(artifactRoot,'receipt','original.json')},artifacts:[{path:media,mimeType:'image/png'}]})}};
  const value={receipts:[receipt]};
  assert.equal(resolveWorkFile(value,'mcp-receipt',media,{artifactRoot}),media);
  assert.throws(()=>resolveWorkFile(value,'mcp-receipt',path.resolve('other.png'),{artifactRoot}),/不一致/);
  assert.throws(()=>resolveWorkFile(value,'mcp-receipt',media,{artifactRoot:path.resolve('different-root')}),/不一致/);
});
test('task file actions require the exact persisted successful receipt and path', () => {
  assert.equal(resolveWorkFile(work('observed_success'), 'receipt', file), file);
  assert.throws(() => resolveWorkFile(work('result_unknown'), 'receipt', file), /成功操作证据/);
  assert.throws(() => resolveWorkFile(work('observed_success'), 'receipt', path.resolve('different.md')), /不一致/);
  assert.throws(() => resolveWorkFile(work('observed_success'), 'missing', file), /成功操作证据/);
});
