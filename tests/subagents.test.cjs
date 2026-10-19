const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const memory = require('../electron/memory.cjs');
const { createTools } = require('../electron/tools.cjs');
const { runAssistant } = require('../electron/assistant-worker.cjs');
const { createSubAgents, createMutex } = require('../electron/subagents.cjs');

test('delegate definition reflects task scheduling without promising every delegate runs in parallel', () => {
  const { definition } = require('../electron/subagents.cjs');
  assert.match(definition.function.description, /同一任务可能依次执行/);
  assert.doesNotMatch(definition.function.description, /它们会并行运行/);
});

test('delegate reports incomplete and unknown work with its real trace and evidence, and preserves recovered success', async t => {
  for (const [label, result, expected, status] of [
    ['incomplete work', { text: '未能写入', executionStatus: 'incomplete', unresolvedSteps: [{ operation: 'write_text', status: 'failed', error: 'permission denied' }], trace: [{ tool: 'write_text', ok: false, args: '{}', result: 'denied' }], model: 'fixture', modelCalls: 2 }, false, 'failed'],
    ['unknown work', { text: '写入结果未知', executionStatus: 'incomplete', unresolvedSteps: [{ operation: 'write_text', status: 'unknown', error: 'response lost' }], trace: [{ tool: 'write_text', ok: false, execution_status: 'unknown', result: 'response lost' }] }, false, 'unknown'],
    ['legacy failure trace', { text: '完成的文字声明', trace: [{ tool: 'wait_for', ok: false, execution_status: 'condition_unmet', result: 'not satisfied' }] }, false, 'failed'],
    ['recovered invocation', { text: '已核对', executionStatus: 'settled', unresolvedSteps: [], trace: [{ tool: 'read_text', ok: false }, { tool: 'read_text', ok: true }], work: { id: 'saved-work', receipts: [{ id: 'receipt-1' }] } }, true, 'succeeded'],
  ]) await t.test(label, async () => {
    let released = 0;
    const subagents = createSubAgents({ runAssistant: async () => result, getSettings: () => ({ model: 'fixture' }), getApiKey: () => '', makeTools: () => ({ view: () => ({}), endControl: () => released++ }) });
    const report = await subagents.run({ name: '核对员', task: '核对文档实际状态' }, { ask: async () => 'once', signal: new AbortController().signal });
    assert.equal(report.ok, expected); assert.equal(report.execution_status, status); assert.equal(released, 1);
    assert.equal(report.trace[0].tool, result.trace[0].tool); assert.ok(report.evidence.work_id);
    assert.equal(report.evidence.trace_count, result.trace.length);
    if (!expected) { assert.ok(report.unresolvedSteps.length); assert.equal(report.automatic_retry, false); }
    else assert.deepEqual(report.evidence.receipt_ids, ['receipt-1']);
  });
});

test('a thrown uncertain child action retains identity and evidence and releases control without claiming success', async () => {
  let ended = 0;
  const uncertain = new Error('response lost'); uncertain.code = 'CORE_ACTION_UNCERTAIN'; uncertain.execution_status = 'unknown'; uncertain.trace = [{ tool: 'click', ok: false }];
  const subagents = createSubAgents({ runAssistant: async () => { throw uncertain; }, getSettings: () => ({}), getApiKey: () => '', makeTools: () => ({ view: () => ({}), endControl: () => ended++ }) });
  await assert.rejects(subagents.run({ name: '操作员', task: '检查指定窗口控件' }, { ask: async () => 'once', signal: new AbortController().signal }), error => error === uncertain && error.evidence.agent === '操作员' && !!error.evidence.work_id && error.trace[0].ok === false);
  assert.equal(ended, 1);
});

test('the screen mutex hands the screen to one helper at a time, in order', async () => {
  const mutex = createMutex();
  const order = [];
  const job = async (name, ms) => { const release = await mutex.acquire(); order.push('start ' + name); await new Promise(resolve => setTimeout(resolve, ms)); order.push('end ' + name); release(); };
  await Promise.all([job('a', 60), job('b', 10), job('c', 10)]);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('the main agent delegates to helpers that run in parallel with a restricted toolset, and gets their reports back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subagents-'));
  await memory.init(path.join(dir, 'memory'));
  const docs = path.join(dir, 'docs'); await fs.mkdir(docs);
  await fs.writeFile(path.join(docs, 'a.txt'), '内容甲'); await fs.writeFile(path.join(docs, 'b.txt'), '内容乙');
  const subTools = []; let inflight = 0, maxInflight = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
    const toolNames = (body.tools || []).map(item => item.function.name);
    const toolMessages = body.messages.filter(item => item.role === 'tool');
    const reply = message => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] })); };
    if (toolNames.includes('delegate')) {
      if (!toolMessages.length) return reply({ role: 'assistant', content: '', tool_calls: ['a', 'b'].map((letter, index) => ({ id: 'd' + index, type: 'function', function: { name: 'delegate', arguments: JSON.stringify({ name: '资料员' + letter.toUpperCase(), task: '读取 ' + path.join(docs, letter + '.txt') + ' 并把内容原样汇报', capabilities: ['files'] }) } })) });
      return reply({ role: 'assistant', content: '汇总：' + toolMessages.map(item => JSON.parse(item.content).result).join(' | ') });
    }
    subTools.push(toolNames);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(resolve => setTimeout(resolve, 250));
    inflight--;
    if (!toolMessages.length) { const target = /a\.txt/.test(JSON.stringify(body.messages)) ? 'a.txt' : 'b.txt'; return reply({ role: 'assistant', content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'read_text', arguments: JSON.stringify({ path: path.join(docs, target) }) } }] }); }
    return reply({ role: 'assistant', content: '已读到：' + JSON.parse(toolMessages.at(-1).content).text });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const settings = { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' };
    const build = shared => createTools({ memory, userDataDir: path.join(dir, 'u'), getPrefs: () => ({}), shared, host: { path: name => name === 'documents' ? docs : path.join(dir, name), openExternal: async () => {} } });
    const tools = build({});
    const subagents = createSubAgents({ runAssistant, getSettings: () => settings, getApiKey: () => '', makeTools: () => build(tools.shared) });
    const localTools = { ...tools, names: new Set([...tools.names, 'delegate']), definitions: [...tools.definitions, subagents.definition], has: name => name === 'delegate' || tools.has(name), label: (name, args) => name === 'delegate' ? '子代理：' + args.name : tools.label(name, args), execute: (name, args, ctx) => name === 'delegate' ? subagents.run(args, ctx) : tools.execute(name, args, ctx) };
    const events = [];
    const result = await runAssistant({ settings, apiKey: '', work: { id: 'w', session: 's', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] }, messages: [{ role: 'user', content: '读两个文件' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, localTools,
      askTool: async () => 'once', progress: step => events.push(step), core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : { work: {} } });
    assert.match(result.text, /已读到：内容甲/); assert.match(result.text, /已读到：内容乙/);
    assert.ok(maxInflight >= 2, 'helpers should have run at the same time (max in flight: ' + maxInflight + ')');
    for (const names of subTools) {
      assert.ok(names.includes('read_text'));
      for (const forbidden of ['delegate', 'remember', 'save_playbook', 'run_command', 'observe', 'web_search']) assert.ok(!names.includes(forbidden), 'a files-only helper must not have ' + forbidden);
    }
    assert.ok(events.some(step => step.label === '子代理：资料员A' && step.phase === 'running'));
    assert.ok(events.some(step => /^\[资料员B\] 读取文件/.test(step.label || '')), 'helper steps are reported under the helper\'s name');
    // The audit trail is shared with the main agent.
    assert.ok(tools.audit().some(entry => entry.tool === 'read_text'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('helpers are bounded: per-turn limit, no questions, consent prefixed with the helper name', async () => {
  const asked = [];
  const subagents = createSubAgents({ runAssistant: async options => { await options.askTool({ title: '写入文件', lines: ['x'] }); return { text: '完成' }; }, getSettings: () => ({}), getApiKey: () => '', makeTools: () => ({ view: () => ({}), endControl() {} }), maxPerTurn: 2 });
  const ctx = { turn: 't', ask: async request => { asked.push(request.title); return 'once'; }, signal: new AbortController().signal };
  await assert.rejects(subagents.run({ name: 'x', task: 'ab' }, ctx), /太短/);
  assert.equal((await subagents.run({ name: '整理员', task: '整理这批文件并汇报' }, ctx)).result, '完成');
  assert.deepEqual(asked, ['[整理员] 写入文件']);
  await subagents.run({ name: '二号', task: '另一个子任务说明' }, ctx);
  await assert.rejects(subagents.run({ name: '三号', task: '第三个子任务说明' }, ctx), /达到上限/);
  await assert.rejects(subagents.run({ name: 'x', task: '没有确认通道的子任务' }, { turn: 'u', signal: new AbortController().signal }), /无法向用户确认/);
});
