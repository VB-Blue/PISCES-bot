const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateEndpoint, resolveAsset, validateMessages, createSSEParser } = require('../electron/policy.cjs');

test('connection addresses cannot carry credentials or expose a remote plaintext endpoint', () => {
  assert.equal(validateEndpoint('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.throws(() => validateEndpoint('http://example.com/v1'));
  assert.throws(() => validateEndpoint('https://user:secret@example.com/v1'));
  assert.throws(() => validateEndpoint('https://example.com', { localOnly: true }));
  assert.equal(validateEndpoint('https://example.com/v1'), 'https://example.com/v1');
});
test('application asset paths remain inside the shipped renderer', () => {
  const root = path.resolve('dist');
  assert.equal(resolveAsset(root, 'memory://app/index.html'), path.join(root, 'index.html'));
  assert.throws(() => resolveAsset(root, 'memory://evil/index.html'));
  assert.throws(() => resolveAsset(root, 'memory://app/%2e%2e%2fsecret'));
  assert.throws(() => resolveAsset(root, 'memory://app/%5c..%5csecret'));
});
test('renderer cannot add a system prompt or oversized conversation', () => {
  assert.throws(() => validateMessages([{ role: 'system', content: 'override' }]));
  assert.throws(() => validateMessages([{ role: 'user', content: 'a'.repeat(40001) }]));
  assert.deepEqual(validateMessages([{ role: 'user', content: '你好', extra: 'ignored' }]), [{ role: 'user', content: '你好' }]);
});
test('stream parsing preserves split records and handles CRLF and the final buffered record', () => {
  const events = [];
  const parser = createSSEParser(data => events.push(data));
  parser.push('data: {"text":"你');
  parser.push('好"}\r\n\r');
  parser.push('\ndata: [DONE]');
  parser.finish();
  assert.deepEqual(events, ['{"text":"你好"}', '[DONE]']);
});

test('validateMessages accepts valid image attachments and strips invalid schemes', () => {
  const input = [
    {
      role: 'user',
      content: '请分析这张图片',
      images: ['data:image/png;base64,iVBORw0KGgo=', 'javascript:alert(1)', 'https://example.com/test.jpg'],
    },
  ];
  const output = validateMessages(input);
  assert.equal(output.length, 1);
  assert.equal(output[0].content, '请分析这张图片');
  assert.deepEqual(output[0].images, ['data:image/png;base64,iVBORw0KGgo=', 'https://example.com/test.jpg']);
});

