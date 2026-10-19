const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeObservation } = require('../electron/subject/observation.cjs');
const outputPath = 'C:\\Users\\Fixture User\\AppData\\Roaming\\PISCES AI\\connectors\\results\\fixture\\0123456789abcdef0123456789abcdef.png';
const receiptPath = outputPath.replace(/\.png$/, '.json');

test('large observations retain exact receipt and artifact paths while clipping prose and omitting binary images', () => {
  const result = { ok: true, execution_status: 'succeeded', result: '真实正文'.repeat(4000), image: 'data:image/png;base64,' + 'x'.repeat(10000), artifacts: [{ path: outputPath, mimeType: 'image/png', kind: 'image' }], evidence: { source: 'mcp', request_id: 'client:17', connector_id: 'fixture', receipt_path: receiptPath }, structuredContent: { rows: Array.from({ length: 80 }, (_, index) => ({ id: index, text: '数据'.repeat(300) })) } };
  const encoded = summarizeObservation(result);
  assert.ok(encoded.length <= 3500);
  const observed = JSON.parse(encoded);
  assert.equal(observed.evidence.receipt_path, receiptPath); assert.equal(observed.evidence.request_id, 'client:17');
  assert.equal(observed.artifacts[0].path, outputPath);
  assert.ok(!encoded.includes('base64'));
});

test('oversized connector observations fall back to source evidence rather than discarding the only traceable receipt', () => {
  const result = { ok: false, execution_status: 'unknown', evidence: { source: 'mcp', request_id: 'client:18', connector_id: 'fixture', receipt_path: receiptPath }, artifacts: Array.from({ length: 16 }, (_, index) => ({ path: outputPath + index, mimeType: 'image/png' })) };
  for (let index = 0; index < 40; index++) result['field_' + index] = Array.from({ length: 30 }, () => 'material'.repeat(1000));
  const encoded = summarizeObservation(result, 900); const observed = JSON.parse(encoded);
  assert.ok(encoded.length <= 900); assert.equal(observed.ok, false); assert.equal(observed.execution_status, 'unknown');
  assert.equal(observed.evidence.receipt_path, receiptPath); assert.equal(observed.evidence.request_id, 'client:18');
  assert.equal(observed._preview_truncated, true);
  assert.ok(!observed.artifacts?.some(item => item.path.length < outputPath.length));
});

test('single file receipts keep their complete path under a small preview budget', () => {
  const result = { ok: true, path: outputPath, text: '长文件内容'.repeat(1000) };
  const observed = JSON.parse(summarizeObservation(result, 350));
  assert.equal(observed.path, outputPath); assert.equal(observed.ok, true);
});
