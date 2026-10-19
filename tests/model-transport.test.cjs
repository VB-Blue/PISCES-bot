const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { modelResponse, runAssistant } = require('../electron/assistant-worker.cjs');
const { think } = require('../electron/subject/cognition.cjs');
const { isTransient } = require('../electron/router.cjs');
const { normalizeModelError, retrySameService, waitForRetry } = require('../electron/model-errors.cjs');
const { createUsageLedger, withUsage } = require('../electron/model-usage.cjs');
const { createJobs } = require('../electron/jobs.cjs');

async function model(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    handler(body, res, requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'transport-fixture' }, requests };
}
function answer(res, content, calls) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }], usage: { total_tokens: 20 } })); }
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pisces-transport-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('network diagnostics keep the nested cause without leaking secrets, and do not relabel website/API HTTP errors', () => {
  const original = new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('https://user:secret@example.com/?token=secret'), { code: 'ECONNRESET' })]) });
  const error = normalizeModelError(original, { endpoint: 'https://user:secret@example.com/v1?api_key=secret' });
  assert.equal(error.code, 'MODEL_CONNECTION_FAILED'); assert.equal(error.causeCode, 'ECONNRESET'); assert.equal(error.endpointHost, 'example.com');
  assert.ok(isTransient(error)); assert.ok(retrySameService(error)); assert.doesNotMatch(error.message + JSON.stringify(error), /secret|api_key/);
  const pageError = new Error('读取网页失败：HTTP 403'); assert.equal(normalizeModelError(pageError), pageError);
  const providerError = Object.assign(new Error('AI 返回 HTTP 401'), { httpStatus: 401 }); assert.equal(normalizeModelError(providerError), providerError); assert.equal(retrySameService(providerError), false);
  assert.equal(isTransient(Object.assign(error, { code: 'TOKEN_BUDGET_EXCEEDED' })), false);
});

test('web-read recovery is limited to read-only scopes with no executed dependent action', () => {
  const { canResumeWebRead } = require('../electron/subject/node-execution.cjs');
  const node = { id: 'research', execution: { mode: 'parallel', tools: ['web_search', 'fetch_url'] }, execution_state: { effects: [] }, outputs: [], evidence: { unresolvedSteps: [] } };
  const dependent = { id: 'draft', depends_on: ['research'], runtime_status: 'pending' };
  assert.equal(canResumeWebRead(node, [node, dependent]), true);
  for (const patch of [{ execution: { mode: 'serial', tools: ['fetch_url'] } }, { execution: { mode: 'parallel', tools: ['fetch_url', 'write_text'] } }, { execution_state: { effects: [{ operation: 'write_text' }] } }, { execution_state: {} }, { outputs: ['D:\\article.md'] }, { evidence: { unresolvedSteps: [{ operation: 'browser_click' }] } }]) assert.equal(canResumeWebRead({ ...node, ...patch }, [node, dependent]), false);
  assert.equal(canResumeWebRead(node, [node, { ...dependent, attempts: 1 }]), false);
  assert.equal(canResumeWebRead(node, [node, dependent, { id: 'publish', depends_on: ['draft'], verification: { passed: true } }]), false);
});

test('understanding retries with backoff, retains a useful error code and settles every failed call', async t => {
  const { settings, requests } = await model(t, (_body, res) => res.destroy());
  const dir = await directory(t), ledger = createUsageLedger({ dir }); ledger.init();
  const retries = [], receipts = [];
  await assert.rejects(withUsage({ ledger }, () => think({ target: { settings, apiKey: 'SECRET-KEY', afterCall: (...args) => receipts.push(args), onRetry: event => retries.push(event) }, system: 'JSON', input: 'check', validate: () => '', attempts: 3, retryDelayMs: 15 })), error => {
    assert.equal(error.code, 'MODEL_CONNECTION_FAILED'); assert.equal(error.causeCode, 'UND_ERR_SOCKET'); assert.equal(error.recoverable, true); assert.ok(isTransient(error)); assert.match(error.message, /请求失败.*无法连接 AI 服务/); return true;
  });
  assert.equal(requests.length, 3); assert.deepEqual(retries.map(item => item.delayMs), [15, 30]); assert.equal(receipts.length, 3); assert.ok(receipts.every(item => item[1] === 'failed'));
  const records = (await fs.readFile(path.join(dir, 'model-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const failures = records.filter(item => item.type === 'settle').map(item => item.patch);
  assert.equal(failures.length, 3); assert.ok(failures.every(item => item.errorCode === 'MODEL_CONNECTION_FAILED' && item.causeCode === 'UND_ERR_SOCKET' && item.endpointHost === '127.0.0.1'));
  assert.doesNotMatch(JSON.stringify(records), /SECRET-KEY|Authorization/);
});

test('understanding recovers from a disconnect but abort during backoff never dispatches another request', async t => {
  const { settings, requests } = await model(t, (_body, res, count) => count === 1 ? res.destroy() : answer(res, '{"ok":true}'));
  const result = await think({ target: { settings, apiKey: '' }, system: 'JSON', input: 'check', validate: value => value.ok ? '' : 'missing ok', retryDelayMs: 1 });
  assert.equal(result.value.ok, true); assert.equal(requests.length, 2);
  const down = await model(t, (_body, res) => res.destroy());
  const controller = new AbortController();
  await assert.rejects(think({ target: { settings: down.settings, onRetry: () => controller.abort() }, system: 'JSON', input: 'check', validate: () => '', signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(down.requests.length, 1);
});

test('request timeouts and incomplete response streams remain transport failures', async t => {
  const pending = await model(t, () => {});
  await assert.rejects(modelResponse({ ...pending.settings, requestTimeoutMs: 30 }, '', [{ role: 'user', content: 'hello' }], 'understanding'), error => error.code === 'MODEL_REQUEST_TIMEOUT' && error.phase === 'connect');
  await assert.rejects(modelResponse(pending.settings, '', [{ role: 'user', content: 'hello' }], 'understanding', AbortSignal.timeout(30)), error => error.code === 'MODEL_REQUEST_TIMEOUT');
  const cut = await model(t, (_body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); });
  await assert.rejects(modelResponse(cut.settings, '', [{ role: 'user', content: 'hello' }], 'executor'), error => error.code === 'MODEL_STREAM_INTERRUPTED' && error.phase === 'response' && isTransient(error));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(waitForRetry(6000, controller.signal), error => error.name === 'AbortError');
});

test('retrying a model request after a completed write never repeats the tool operation', async t => {
  const dir = await directory(t), file = path.join(dir, 'samples.md');
  const { settings, requests } = await model(t, (_body, res, count) => {
    if (count === 1) answer(res, '', [{ id: 'write-once', type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: file, text: '三篇待确认样片' }) } }]);
    else if (count <= 3) res.destroy();
    else answer(res, '样片已经保存，等待用户确认。');
  });
  let writes = 0;
  const name = 'write_text', localTools = { names: new Set([name]), has: item => item === name, label: () => '写入样片', definitions: [{ type: 'function', function: { name, description: 'write', parameters: { type: 'object', properties: {} } } }], execute: async (_name, args) => { writes++; await fs.writeFile(file, args.text); return { ok: true, path: file }; } };
  const result = await runAssistant({ settings, apiKey: '', core: async body => body.action === 'reserve_call' ? { call: { id: 'call-' + requests.length } } : {}, coreTools: false, work: { id: 'fixture', goal: '写样片', profile_snapshot: {}, files: [], roles: ['executor'] }, messages: [{ role: 'user', content: '写样片' }], signal: new AbortController().signal, localTools, retryDelayMs: 1 });
  assert.equal(writes, 1); assert.equal(requests.length, 4); assert.equal(await fs.readFile(file, 'utf8'), '三篇待确认样片'); assert.equal(result.trace.length, 1);
  for (const request of requests.slice(1)) assert.equal(request.messages.filter(item => item.role === 'tool').length, 1);
});

test('failed jobs persist transport metadata and resume the same work after a process restart', async t => {
  const dir = await directory(t);
  const { settings } = await model(t, (_body, res) => res.destroy());
  const jobs = createJobs({ dir, run: async (_snapshot, api) => { await api.saveCheckpoint({ workId: 'same-canonical-work', notes: '已保存搜索结果，尚未生成样片' }); api.progress({ phase: 'model', operation: 'model', label: '等待 AI 服务响应' }); return modelResponse(settings, '', [{ role: 'user', content: 'check' }], 'understanding'); } });
  const wait = async (store, id, status) => { for (let i = 0; i < 300; i++) { const job = store.get(id); if (job.status === status) return job; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('job did not reach ' + status); };
  await jobs.init(); const created = jobs.create({ goal: '先写三篇样片供确认' }); const failed = await wait(jobs, created.id, 'failed'); await jobs.flush(); jobs.stop();
  assert.equal(failed.result, ''); assert.equal(failed.errorCode, 'MODEL_CONNECTION_FAILED'); assert.equal(failed.retryableFailure, true); assert.equal(failed.failure.causeCode, 'UND_ERR_SOCKET'); assert.equal(failed.currentAction.status, 'failed');
  let snapshot;
  const reopened = createJobs({ dir, run: async previous => { snapshot = previous; return { text: '三篇真实样片，等待确认', subject: { passed: true } }; } });
  t.after(() => { jobs.stop(); reopened.stop(); });
  await reopened.init(); assert.equal(reopened.get(created.id).status, 'failed'); assert.equal(snapshot, undefined, 'no automatic task replay on restart');
  reopened.resume(created.id); const done = await wait(reopened, created.id, 'done'); await reopened.flush();
  assert.equal(snapshot.workId, 'same-canonical-work'); assert.equal(snapshot.notes, failed.notes); assert.equal(done.failure, null); assert.equal(done.retryableFailure, false); assert.equal(done.id, failed.id);
});
