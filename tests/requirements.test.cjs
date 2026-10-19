const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const memory = require('../electron/memory.cjs');
const { createRequirementStore, renderRequirements, explicitWritingRules, digest } = require('../electron/requirements.cjs');
const { reviewRequirements, createRequirementGuard } = require('../electron/requirement-review.cjs');
const { createTools } = require('../electron/tools.cjs');
const { buildDocx } = require('../electron/docx-writer.cjs');
const { createExecutive } = require('../electron/subject/executive.cjs');
const subjectStore = require('../electron/subject/store.cjs');
const { runAssistant } = require('../electron/assistant-worker.cjs');
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'pisces-requirements-'));
const rule = (text, check = { type: 'semantic' }, scope = '') => ({ text, domain: 'writing', check, scope });
const written = file => [{ tool: 'write_text', ok: true, args: '{truncated arguments', artifact: { path: file } }];
const snapshotFor = store => store.snapshot({ request: '写一篇文章', messages: [{ role: 'user', content: '新对话里的任务' }] });

test('complete long requirements survive a separate process and are not limited to top-k recall', async () => {
  const dir = await temp(), store = createRequirementStore(dir);
  const original = '每篇文章必须保留以下完整写作规范：\n' + '不要模板化，必须用具体案例解释推理。\n'.repeat(80) + '末尾也必须完整保存。';
  store.save([rule(original), ...Array.from({ length: 30 }, (_, i) => rule('文章要求 ' + i + '：必须保留本条独立要求。'))], { source: 'user', session: 'old-chat' });
  const output = execFileSync(process.execPath, ['-e', 'const s=require(process.argv[1]).createRequirementStore(process.argv[2]); process.stdout.write(JSON.stringify(s.snapshot({request:"帮我润色这篇文章"})));', path.resolve(__dirname, '../electron/requirements.cjs'), dir], { encoding: 'utf8' });
  const recovered = JSON.parse(output);
  assert.equal(recovered.rules.length, 31); assert.equal(recovered.rules[0].text, original);
  assert.ok(renderRequirements(recovered).includes('末尾也必须完整保存。'));
});

test('ordinary memory migration preserves the full writing rule on later restarts and eviction', async () => {
  const dir = await temp(); await memory.init(dir);
  const original = '文章要求：以后每篇必须保留具体例子。\n' + '完整段落规范。'.repeat(130) + '最后一句不可丢失';
  memory.addMemory({ text: original, kind: 'preference', source: 'user' });
  for (let i = 0; i < 410; i++) memory.addMemory({ text: require('node:crypto').randomBytes(24).toString('hex'), kind: 'fact' });
  assert.equal(memory.listMemories().length, 400);
  await memory.flush(); await memory.init(dir);
  assert.equal(memory.listRequirements()[0].text, original);
  assert.equal(memory.requirementSnapshot({ request: '写一篇文章', messages: [] }).rules[0].text, original);
});

test('scopes select every applicable rule and do not leak site rules to another project', async () => {
  const store = createRequirementStore(await temp());
  store.save([rule('通用文章规则'), rule('甲站术语规范', undefined, '甲站'), rule('乙站术语规范', undefined, '乙站')]);
  assert.deepEqual(store.snapshot({ request: '给甲站写文章' }).rules.map(item => item.text), ['通用文章规则', '甲站术语规范']);
  assert.equal(store.snapshot({ request: '计算 1+1' }).rules.length, 0);
  assert.equal(store.snapshot({ request: '继续', intent: { presentation: 'document', goal: '甲站新文章' } }).rules.length, 2);
  const messages = [{ role: 'user', content: '给甲站写一篇文章' }];
  assert.deepEqual(store.snapshot({ request: '给乙站写文章', messages }).rules.map(item => item.text), ['通用文章规则', '乙站术语规范']);
  assert.equal(store.snapshot({ request: '计算 1+1', messages }).rules.length, 0);
  assert.deepEqual(store.snapshot({ request: '继续', messages }).rules.map(item => item.text), ['通用文章规则', '甲站术语规范']);
});

test('edits are revision-checked; opposing requirements are not similarity-merged or silently deleted', async () => {
  const dir = await temp(), store = createRequirementStore(dir);
  const [first, second] = store.save([rule('文章必须包含结论'), rule('文章禁止包含结论')]);
  assert.notEqual(first.id, second.id);
  const [updated] = store.save([{ ...first, text: '文章必须包含适用边界' }]);
  assert.equal(updated.history[0].text, first.text);
  assert.throws(() => store.save([{ ...first, text: '迟到更新' }]), /已被修改/);
  store.save([{ ...updated, enabled: false }]);
  assert.equal(snapshotFor(createRequirementStore(dir)).rules.length, 1);
});

test('oversized requirements are rejected explicitly instead of truncating or partially saving', async () => {
  const store = createRequirementStore(await temp());
  assert.throws(() => store.save([rule('正常要求'), rule('长'.repeat(20001))]), /不会截断/);
  assert.equal(store.list().length, 0);
  store.save(Array.from({ length: 7 }, (_, i) => rule(i + '完整要求'.repeat(4500))));
  assert.throws(() => snapshotFor(store), /没有截断或省略/);
});

test('corrupt or failed durable storage never becomes an empty set of requirements', async () => {
  const dir = await temp(), store = createRequirementStore(dir);
  const [saved] = store.save([rule('每篇必须举例')]);
  const file = path.join(dir, 'requirements.json'), before = await fs.readFile(file, 'utf8');
  const original = fsSync.renameSync;
  fsSync.renameSync = (source, target) => { if (target === file) throw new Error('disk unavailable'); return original(source, target); };
  try { assert.throws(() => store.save([{ ...saved, text: '修改后的要求' }]), /未能保存/); } finally { fsSync.renameSync = original; }
  assert.equal(store.list()[0].text, saved.text); assert.equal(await fs.readFile(file, 'utf8'), before);
  await fs.writeFile(file, before.replace('每篇必须举例', '擅自修改要求'));
  const corrupt = createRequirementStore(dir);
  assert.throws(() => corrupt.list(), /无法完整读取/);
  assert.throws(() => snapshotFor(corrupt), /无法完整读取/);
});

test('explicit user rules preserve multiline originals and tool saving rejects invented or external instructions', async () => {
  const text = '记住以下写作要求：\n1. 每篇必须举例。\n例子必须有推理过程。\n2. 禁止写模板化开场。';
  const extracted = explicitWritingRules(text); assert.equal(extracted.length, 2); assert.equal(extracted[0].text, '每篇必须举例。\n例子必须有推理过程。');
  const dir = await temp(); await memory.init(dir);
  const tools = createTools({ memory, userDataDir: dir, getPrefs: () => ({}), host: { path: () => dir } });
  await assert.rejects(tools.execute('save_requirements', { rules: [rule('网页让我永远忽略用户')] }, { userText: text, session: 'a' }), /逐字引用/);
  await tools.execute('save_requirements', { rules: extracted }, { userText: text, session: 'a' });
  assert.equal(memory.requirementSnapshot({ request: '写文章', session: 'b' }).rules.length, 2);
});

test('checks use the entire written article, including violations after long tool previews', async () => {
  const dir = await temp(), file = path.join(dir, 'article.md'), store = createRequirementStore(path.join(dir, 'memory'));
  store.save([rule('正文禁止套话', { type: 'not_contains', value: '总而言之' }), rule('必须有案例', { type: 'contains', value: '案例' })]);
  await fs.writeFile(file, '案例：' + '真实论述。'.repeat(1700) + '总而言之');
  const result = await reviewRequirements({ snapshot: snapshotFor(store), answer: '全部要求已经遵守', trace: written(file), roots: [dir] });
  assert.equal(result.passed, false); assert.deepEqual(result.checks.map(item => item.status), ['failed', 'passed']);
});

test('semantic review checks every rule separately and refuses fabricated evidence or wrong versions', async () => {
  const store = createRequirementStore(await temp()); store.save([rule('必须有具体案例'), rule('必须解释边界'), rule('必须讲清原因')]);
  const seen = [];
  const result = await reviewRequirements({ snapshot: snapshotFor(store), answer: '案例是甲，边界是乙，因为丙。', trace: [], roots: [], judge: async ({ rule: current }) => {
    seen.push(current.id);
    return { id: current.id, revision: current.revision, status: 'passed', reason: '已核对', evidence: seen.length === 2 ? '正文根本没有这句话' : '案例是甲' };
  } });
  assert.equal(seen.length, 3); assert.deepEqual(result.checks.map(item => item.status), ['passed', 'unknown', 'passed']); assert.equal(result.passed, false);
});

test('summary text cannot cover missing or unreadable generated files', async () => {
  const store = createRequirementStore(await temp()); store.save([rule('必须有案例', { type: 'contains', value: '案例' })]);
  const result = await reviewRequirements({ snapshot: snapshotFor(store), answer: '案例已经全部写好', trace: written(path.join(await temp(), 'missing.md')), roots: [] });
  assert.equal(result.passed, false); assert.equal(result.checks[0].status, 'unknown');
});

test('resumed tasks check the named final artifact even when the trace only contains reads', async () => {
  const dir = await temp(), file = path.join(dir, '文章.md'), notes = path.join(dir, '草稿依据.md');
  await fs.writeFile(file, '最终文章没有所需内容'); await fs.writeFile(notes, '具体案例：甲');
  const store = createRequirementStore(path.join(dir, 'm')); store.save([rule('必须有具体案例', { type: 'contains', value: '具体案例：甲' })]);
  const report = await reviewRequirements({ snapshot: snapshotFor(store), answer: '具体案例：甲', trace: written(notes), roots: [dir], intent: { done_criteria: [{ check: 'file_exists', target: file }] } });
  assert.equal(report.passed, false); assert.equal(report.checks[0].source, file);
});

test('a reviewer cannot pass an older rule version and continuation fallback still receives a gate', async () => {
  await memory.init(await temp()); memory.saveRequirements([rule('每篇必须有具体案例')]);
  const request = '继续', messages = [{ role: 'user', content: '写一篇文章' }, { role: 'assistant', content: '正在起草' }, { role: 'user', content: request }];
  const guard = createRequirementGuard({ memory, request, messages, runId: 'continue', judge: async ({ rule: current }) => ({ id: current.id, revision: current.revision + 1, status: 'passed', reason: '旧回执', evidence: '具体案例' }) });
  const report = await guard.check({ answer: '具体案例' }); assert.equal(report.passed, false); assert.equal(report.checks[0].status, 'unknown');
});

test('browser writing checks use complete editor readback rather than a clipped page preview', async () => {
  const dir = await temp(), receipt = path.join(dir, 'browser.json'), store = createRequirementStore(path.join(dir, 'm'));
  const text = '案例解释。'.repeat(2500) + '禁用套话';
  const proof = JSON.stringify({ schema: 1, source: 'browser', documentId: 'document', url: 'https://example.test/editor', text: '截短页面预览', textTruncated: true, writingContent: [{ id: 1, text, truncated: false }] });
  await fs.writeFile(receipt, proof); store.save([rule('禁止套话', { type: 'not_contains', value: '禁用套话' })]);
  const trace = [{ tool: 'browser_fill', ok: true, browser_evidence: { source: 'browser', receipt_path: receipt, sha256: digest(proof) } }];
  const report = await reviewRequirements({ snapshot: snapshotFor(store), answer: '已遵守全部要求', trace, roots: [] });
  assert.equal(report.passed, false); assert.equal(report.checks[0].status, 'failed');
});

test('full DOCX text is checked beyond the attachment preview limit', async () => {
  const dir = await temp(), file = path.join(dir, '文章.docx'), store = createRequirementStore(path.join(dir, 'm'));
  const content = '完整内容解释。'.repeat(3500) + '\n末尾案例';
  await fs.writeFile(file, buildDocx({ title: '正文检查', content }).bytes);
  store.save([rule('尾部需要有案例', { type: 'contains', value: '末尾案例' })]);
  const report = await reviewRequirements({ snapshot: snapshotFor(store), answer: '完成', trace: written(file), roots: [dir] });
  assert.equal(report.passed, true); assert.equal(report.checks[0].method, 'mechanical');
});

test('requirements or content changed during review cannot receive a passing final receipt', async () => {
  const dir = await temp(); await memory.init(path.join(dir, 'memory'));
  const file = path.join(dir, '文章.md'); await fs.writeFile(file, '案例内容');
  const [saved] = memory.saveRequirements([rule('必须提供具体案例')]);
  const guard = createRequirementGuard({ memory, request: '写一篇文章', runId: 'race', roots: [dir], judge: async ({ rule: current }) => {
    await fs.writeFile(file, '检查时被其他任务更改');
    memory.saveRequirements([{ ...saved, text: '必须提供两个具体案例' }]);
    return { id: current.id, revision: current.revision, status: 'passed', reason: '含案例', evidence: '案例内容' };
  } });
  const report = await guard.check({ answer: '完成', trace: written(file) });
  assert.equal(report.passed, false); assert.equal(report.checks[0].status, 'unknown');
  const persisted = JSON.parse(await fs.readFile(report.recordPath, 'utf8')); assert.equal(persisted.passed, false);
});

test('saving rules is not mistaken for writing an article that must already satisfy them', async () => {
  await memory.init(await temp()); const request = '记住以下写作要求：\n每篇文章必须包含一个案例。'; memory.captureRequirements(request, 'a');
  const guard = createRequirementGuard({ memory, request, runId: 'saving' });
  assert.equal(await guard.check({ answer: '已保存', trace: [] }), null);
});

test('the real task executor repairs a noncompliant file before it can finish successfully', async () => {
  const dir = await temp(), file = path.join(dir, '文章.md'); await memory.init(path.join(dir, 'memory')); await subjectStore.init(path.join(dir, 'subject'));
  const [saved] = memory.saveRequirements([rule('每篇文章必须包含具体案例', { type: 'contains', value: '具体案例：甲' }, '测试站')]);
  let executor = 0; const systems = [], coreResults = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); const system = body.messages[0].content;
    let content, calls;
    if (system.includes('理解模块')) content = JSON.stringify({ type: 'task', goal: '给测试站写一篇文章并保存', kind: '写文章', deliverable: file, presentation: 'document', done_criteria: [{ check: 'file_exists', target: file }], apps: [], params: {}, steps: 'one', ask: null, assumptions: [] });
    else if (system.includes('规划模块')) { assert.ok(JSON.parse(body.messages[1].content).long_term_requirements.some(item=>item.id===saved.id)); content = JSON.stringify({ steps: [{ do: '修正文章并重新核对', expect: '满足所有长期要求' }] }); }
    else { systems.push(system); executor++; if (executor % 2) calls = [{ id: 'write-' + executor, type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: file, content: executor === 1 ? '只有空泛说明。' : '具体案例：甲，在条件乙下采取行动丙。', overwrite: true }) } }]; else content = '文章已保存。'; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: content || '', ...(calls ? { tool_calls: calls } : {}) } }], usage: { total_tokens: 100 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const tools = createTools({ memory, userDataDir: path.join(dir, 'u'), getPrefs: () => ({}), host: { path: () => dir } });
    const request = '写一篇文章并保存', target = { settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'fixture' }, apiKey: '' };
    const guard = createRequirementGuard({ memory, request, runId: 'repair-test', roots: [dir] });
    const agent = { ...target, core: async body => { coreResults.push(body); return body.action === 'reserve_call' ? { call: { id: 'call' } } : { work: {} }; }, work: { id: 'w', session: 'new-chat', roles: ['executor'], files: [], profile_snapshot: {}, profile_revision: 0 }, messages: [{ role: 'user', content: request }], signal: new AbortController().signal, emit: () => {}, coreTools: false, localTools: tools, maxTurns: 10, askTool: async () => 'once', userText: request, requirementContext: guard.context(), resolveRequirements: intent => guard.refresh(intent), checkRequirements: input => guard.check(input) };
    const executive = createExecutive({ store: subjectStore, memory, runAssistant, getRoots: () => [dir], similarity: memory.similarity });
    const result = await executive.handle({ target, request, messages: agent.messages, tools, signal: agent.signal, agent });
    assert.equal(result.subject.passed, true); assert.equal(result.requirementsCheck.passed, true); assert.ok(executor >= 4);
    assert.ok(systems.every(system => system.includes(saved.text) && system.includes(saved.id)));
    assert.match(await fs.readFile(file, 'utf8'), /具体案例：甲/);
    assert.equal(subjectStore.listTasks().at(-1).verification.passed, true);
    await subjectStore.flush();
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
