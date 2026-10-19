const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { browserURL, localEndpoint, safeURL, bounded, CDP } = require('../electron/browser-protocol.cjs');
const { createBrowserRuntime } = require('../electron/browser-runtime.cjs');
const { createBrowserTools, definitions } = require('../electron/browser-tools.cjs');
const { createCapabilityView } = require('../electron/capability-registry.cjs');
const { createHash } = require('node:crypto');
const { readBrowserEvidence } = require('../electron/browser-evidence.cjs');
const { createExecutive } = require('../electron/subject/executive.cjs');
test('browser navigation rejects executable schemes and embedded credentials', () => {
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'memory://app/index.html', 'https://user:secret@example.org', 'data:text/html,hi', 'chrome://settings']) assert.throws(() => browserURL(url));
  assert.equal(browserURL('https://example.org/path'), 'https://example.org/path'); assert.equal(browserURL('about:blank'), 'about:blank');
});
test('external browser connection is restricted to explicit loopback ports', () => {
  for (const url of ['https://127.0.0.1:9222', 'http://example.org:9222', 'http://127.0.0.1', 'http://127.0.0.1:9222/path', 'http://user:pw@localhost:9222', 'http://localhost:9222?x=1']) assert.throws(() => localEndpoint(url));
  assert.equal(localEndpoint('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222'); assert.equal(localEndpoint('ws://127.0.0.1:9222/devtools/page/test', true), 'ws://127.0.0.1:9222/devtools/page/test');
});
test('browser activity URLs omit query credentials and fragments', () => { assert.equal(safeURL('https://example.org/report?token=secret#private'), 'https://example.org/report'); });
test('browser protocol timeout and cancellation reject promptly', async () => {
  await assert.rejects(bounded(new Promise(() => {}), { timeout: 20 }), /超时/);
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  await assert.rejects(bounded(new Promise(() => {}), { signal: controller.signal }), /stopped/);
});
test('CDP pending requests are settled on disconnect and responses are correlated', async () => {
  class Socket extends EventTarget { sent = []; send(value) { this.sent.push(JSON.parse(value)); } close() { this.dispatchEvent(new Event('close')); } }
  const socket = new Socket(), client = new CDP(socket), first = client.send('Page.enable');
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: socket.sent[0].id, result: { enabled: true } }) })); assert.deepEqual(await first, { enabled: true });
  const second = client.send('Runtime.enable'); socket.close(); await assert.rejects(second, /断开/); assert.equal(client.pending.size, 0);
});
test('browser tools can be discovered for general webpage tasks', () => {
  const available = definitions.map(item => item.function.name), view = createCapabilityView({ definitions, has: name => available.includes(name), execute() {} }, { request: '运营自定义网站，在浏览器中填写表单并上传附件' });
  assert.ok(view.definitions.some(item => item.function.name === 'browser_open')); assert.ok(view.definitions.some(item => item.function.name === 'browser_fill'));
});
function mockTools(prefs = {}, failConsent = false) {
  const calls = [], requests = [], browser = { getTab: () => ({ id: 'tab', url: 'https://example.org/' }), action: async args => { calls.push(args); return { tabId: 'tab', url: 'https://example.org/', documentId: 'new', screenshot: args.screenshot ? 'image' : undefined }; }, open: async args => { calls.push(args); return { tabId: 'tab', url: args.url }; }, list: async () => ({ tabs: [], downloads: [], connections: [] }) };
  const tools = createBrowserTools({ browser, approve: async (_ctx, request) => { requests.push(request); if (failConsent) throw new Error('用户拒绝'); }, getPrefs: () => prefs, resolvePath: value => value, assertNotSensitive() {}, inRoots: () => true });
  return { tools, calls, requests };
}
test('website consent denial prevents all browser effects', async () => { const { tools, calls } = mockTools({}, true); await assert.rejects(tools.impl.browser_click({ tabId: 'tab', documentId: 'd', element: 1 }, {}), /拒绝/); assert.equal(calls.length, 0); });
test('disabled web or control capabilities prevent browser operations', async () => {
  const web = mockTools({ web: false }); await assert.rejects(web.tools.impl.browser_tabs({}, {}), /联网能力已关闭/);
  const control = mockTools({ control: false }); await assert.rejects(control.tools.impl.browser_click({ tabId: 'tab' }, {}), /网页操作/); assert.equal(control.calls.length, 0);
});
test('browser screenshot is explicitly opt-in and uses the existing image feedback path', async () => {
  const { tools, calls } = mockTools(); const plain = await tools.impl.browser_observe({ tabId: 'tab' }, {}); assert.equal(plain.image, undefined);
  const image = await tools.impl.browser_observe({ tabId: 'tab', screenshot: true }, {}); assert.equal(image.image, 'image'); assert.equal(image.screenshot, undefined); assert.equal(calls.length, 2);
});
test('browser audit labels never include filled text or query tokens', () => { const { tools } = mockTools(); assert.ok(!tools.label('browser_fill', { text: 'secret-value', element: 1 }).includes('secret-value')); assert.ok(!tools.label('browser_open', { url: 'https://example.org/?token=secret-value' }).includes('secret-value')); });
test('browser workspace recovers pending effects without replaying them', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pisces-browser-pending-'));
  await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ schema: 1, activeId: 'tab-1', connections: [], tabs: [{ id: 'tab-1', mode: 'internal', url: 'https://example.org/', pendingOperation: 'op-1' }] }));
  const runtime = createBrowserRuntime({ dir, electron: {} }); await runtime.init();
  assert.equal(runtime.state().tabs[0].uncertain, true); assert.equal(runtime.state().tabs[0].connected, false); assert.equal(runtime.state().tabs[0].recovered, true); await runtime.dispose();
});
test('corrupt browser workspace fails closed instead of erasing task state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pisces-browser-corrupt-')); await fs.writeFile(path.join(dir, 'workspace.json'), 'broken-state');
  const runtime = createBrowserRuntime({ dir, electron: {} }); await assert.rejects(runtime.init()); assert.ok(runtime.state().error); assert.equal(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8'), 'broken-state');
});
test('browser acceptance reads complete hashed receipts beyond preview limits and refuses changed evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pisces-browser-evidence-')), file = path.join(dir, 'receipt.json');
  const bytes = JSON.stringify({ schema: 1, source: 'browser', documentId: 'real-observation', elements: Array(80).fill({ name: 'large page element list' }), text: 'x'.repeat(9000) + ' 已保存：真实回执编号 42' }); await fs.writeFile(file, bytes);
  const pointer = { source: 'browser', receipt_path: file, sha256: createHash('sha256').update(bytes).digest('hex') };
  const executive = createExecutive({ getRoots: () => [] });
  const criteria = [{ check: 'tool_succeeded', target: 'browser_click', value: '真实回执编号 42' }], trace = [{ tool: 'browser_click', ok: true, result: 'a truncated UI preview', browser_evidence: pointer }];
  assert.equal((await executive.checkCriteria(criteria, { trace }))[0].passed, true);
  await fs.writeFile(file, bytes.replace('42', '43')); assert.equal(await readBrowserEvidence(pointer), null); assert.equal((await executive.checkCriteria(criteria, { trace }))[0].passed, false);
});
