const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { runAssistant } = require('../electron/assistant-worker.cjs');
const { buildSystemPrompt } = require('../electron/brain.cjs');

const localCore = async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : { work: {} };

test('the brain prompt puts the user profile in front of the model and tells it to act on the likeliest reading', () => {
  const prompt = buildSystemPrompt({ persona: { name: '小记', styleText: '简洁' }, profile: '- 称呼：阿文\n- 希望助手直接动手', context: '- [fact] 常用 Outlook', toolNames: new Set(['remember', 'observe', 'delegate']) });
  assert.match(prompt, /「小记」/);
  assert.match(prompt, /称呼：阿文/);
  assert.match(prompt, /常用 Outlook/);
  assert.match(prompt, /按最可能的意思直接开始做/);
  assert.match(prompt, /操作电脑软件/);
  assert.match(prompt, /子代理/);
  assert.doesNotMatch(prompt, /后台模式/);
  assert.match(buildSystemPrompt({ background: true }), /后台模式/);
  assert.match(buildSystemPrompt({}), /还没有积累/);
});

test('on the local path the model gets the brain prompt, not the core work-order dump', async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: 'x' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: localCore,
      localTools: { names: new Set(['read_text']), definitions: [], has: () => false, label: () => '', execute: async () => ({}) }, userProfile: '- 用户是摄影师', persona: { name: 'PISCES AI' } });
    const system = bodies[0].messages[0].content;
    assert.match(system, /用户是摄影师/);
    assert.doesNotMatch(system, /认知主体调配/);
    assert.doesNotMatch(system, /任务上下文：/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a long task folds its older work into a written record and keeps going', async () => {
  const bodies = [];
  let executorTurns = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); bodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (String(body.messages.at(-1).content).startsWith('把下面这段工作过程压缩')) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '- 已读完第 1～5 页，关键数字 42' } }] })); return; }
    executorTurns++;
    res.end(JSON.stringify({ choices: [{ message: executorTurns < 12 ? { role: 'assistant', content: '', tool_calls: [{ id: 't' + executorTurns, type: 'function', function: { name: 'read_text', arguments: JSON.stringify({ path: 'p' + executorTurns }) } }] } : { role: 'assistant', content: '完成，数字是 42' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const records = [];
  try {
    const localTools = { names: new Set(['read_text']), definitions: [], has: name => name === 'read_text', label: () => '读', execute: async () => ({ ok: true, text: '内容'.repeat(400) }) };
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '读完所有页' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: localCore, localTools, maxTurns: 30, compactAt: 6000, onCompact: summary => records.push(summary) });
    assert.equal(result.text, '完成，数字是 42');
    assert.ok(records.length >= 1, 'the older work was compacted at least once');
    const last = bodies.filter(body => !String(body.messages.at(-1).content).startsWith('把下面这段工作过程压缩')).at(-1).messages;
    assert.ok(last.some(message => String(message.content).includes('关键数字 42')), 'the written record stays in context');
    assert.equal(last[1].content, '读完所有页', 'the original request is never compacted away');
    // Every tool result still follows its call: the API rejects orphaned tool messages.
    for (let index = 0; index < last.length; index++) if (last[index].role === 'tool') assert.ok(['assistant', 'tool'].includes(last[index - 1].role));
    assert.equal(result.trace.length, 11, 'every tool step is traced for later learning');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('read-only lookups proposed together run concurrently and parallel calls are allowed', async () => {
  const bodies = [];
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks)));
    turn++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: turn === 1 ? { role: 'assistant', content: '', tool_calls: ['a', 'b', 'c'].map(q => ({ id: 'q' + q, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: q }) } })) } : { role: 'assistant', content: '好了' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let live = 0, peak = 0;
  try {
    const localTools = { names: new Set(['web_search']), definitions: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }], has: name => name === 'web_search', label: () => '搜',
      execute: async (_name, args) => { live++; peak = Math.max(peak, live); await new Promise(resolve => setTimeout(resolve, 50)); live--; return { ok: true, query: args.query }; } };
    await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '查三件事' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: localCore, localTools });
    assert.equal(peak, 3);
    assert.equal(bodies[0].parallel_tool_calls, true);
    assert.deepEqual(bodies[1].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content).query), ['a', 'b', 'c'], 'results stay in the order the model asked');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a read-only lookup proposed next to a non-read-only step (update_plan) is not started early', async () => {
  // The core refuses any step while a non-read-only one is in flight (HTTP 409), so this batch must run one at a time.
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    turn++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: turn === 1 ? { role: 'assistant', content: '', tool_calls: [
      { id: 'p', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: '确认环境', status: 'doing' }] }) } },
      { id: 'e', type: 'function', function: { name: 'get_environment', arguments: '{}' } },
    ] } : { role: 'assistant', content: '好了' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let live = 0, peak = 0;
  const order = [];
  try {
    const names = new Set(['update_plan', 'get_environment']);
    const localTools = { names, definitions: [], has: name => names.has(name), label: () => '',
      execute: async name => { live++; peak = Math.max(peak, live); order.push(name); await new Promise(resolve => setTimeout(resolve, 30)); live--; return { ok: true }; } };
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '写论文' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: localCore, localTools });
    assert.equal(result.text, '好了');
    assert.equal(peak, 1);
    assert.deepEqual(order, ['update_plan', 'get_environment'], 'steps run in the order the model asked');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a full context window (empty reply, almost no output tokens) is compacted and retried instead of blamed on thinking', async () => {
  const bodies = [];
  let executorTurns = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); bodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (String(body.messages.at(-1).content).startsWith('把下面这段工作过程压缩')) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '- 已查 6 个来源' } }] })); return; }
    executorTurns++;
    if (executorTurns <= 6) { res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't' + executorTurns, type: 'function', function: { name: 'web_search', arguments: '{"query":"q' + executorTurns + '"}' } }] } }] })); return; }
    // The provider's window is "full" while the raw search results are still in context.
    const full = JSON.stringify(body.messages).split('原始结果').length - 1 > 2;
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: full ? '' : '对比表在此' }, finish_reason: full ? 'length' : 'stop' }], usage: { prompt_tokens: full ? 190000 : 5000, completion_tokens: full ? 1 : 20, total_tokens: 100 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const localTools = { names: new Set(['web_search']), definitions: [], has: name => name === 'web_search', label: () => '搜', execute: async () => ({ ok: true, text: '原始结果' + '字'.repeat(300) }) };
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '调研并列表' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : { work: {} }, localTools, compactAt: 1e9 });
    assert.equal(result.text, '对比表在此');
    assert.ok(bodies.some(body => String(body.messages.at(-1).content).startsWith('把下面这段工作过程压缩')), 'the overflow triggered a compaction');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a gateway timeout from the only service is retried instead of failing the turn', async () => {
  let hits = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    hits++;
    if (hits === 1) { res.writeHead(524, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '区块链是…' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '介绍一下区块链' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: localCore, retryDelayMs: 1 });
    assert.equal(result.text, '区块链是…');
    assert.equal(hits, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a streamed reply may carry more than eight parallel tool calls', async () => {
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    turn++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (turn === 1) {
      const events = Array.from({ length: 12 }, (_, index) => ({ choices: [{ delta: { tool_calls: [{ index, id: 'c' + index, function: { name: 'web_search', arguments: '{"query":"q' + index + '"}' } }] } }] }));
      events.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.end(events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n');
    } else res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '查完了' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let ran = 0;
  try {
    const localTools = { names: new Set(['web_search']), definitions: [], has: name => name === 'web_search', label: () => '搜', execute: async () => { ran++; return { ok: true }; } };
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '查 12 件事' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: localCore, localTools });
    assert.equal(result.text, '查完了');
    assert.equal(ran, 12);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('an empty one-token reply on a normal-sized prompt is a flaky service: retried as is, not compacted or blamed on thinking', async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); bodies.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'application/json' });
    const broken = bodies.length <= 2;
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: broken ? '' : '量子计算是…' }, finish_reason: broken ? 'length' : 'stop' }], usage: { prompt_tokens: 5933, completion_tokens: broken ? 1 : 300 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const steps = [];
  try {
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '介绍一下量子计算' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: localCore,
      localTools: { names: new Set(['read_text']), definitions: [], has: () => false, label: () => '', execute: async () => ({}) }, progress: step => steps.push(step.label) });
    assert.equal(result.text, '量子计算是…');
    assert.equal(bodies.length, 3);
    assert.ok(bodies.every(body => body.max_tokens === bodies[0].max_tokens), 'no budget change for a service glitch');
    assert.ok(steps.some(label => /空回复，自动重试/.test(label)));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('a long document already written is not re-sent in full with every later model call', async () => {
  const essay = '果蝇是经典的模式生物。'.repeat(400);
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    bodies.push(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: bodies.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'd', type: 'function', function: { name: 'write_document', arguments: JSON.stringify({ path: 'a.docx', title: '果蝇', content: essay }) } }] }
      : { role: 'assistant', content: '写好了' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const names = new Set(['write_document']);
    const localTools = { names, definitions: [], has: name => names.has(name), label: () => '', execute: async () => ({ ok: true, characters: essay.length }) };
    const result = await runAssistant({ settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '', work: { id: 'w', goal: 'g', profile_snapshot: {}, files: [], roles: ['executor'] },
      messages: [{ role: 'user', content: '写论文' }], signal: new AbortController().signal, emit: () => {}, coreTools: false, core: localCore, localTools });
    assert.equal(result.text, '写好了');
    assert.ok(bodies[0].length < essay.length, 'the first call carries no essay');
    const call = JSON.parse(bodies[1]).messages.find(message => message.tool_calls)?.tool_calls[0];
    const args = JSON.parse(call.function.arguments);
    assert.equal(args.path, 'a.docx'); assert.equal(args.title, '果蝇');
    assert.ok(args.content.length < 300 && args.content.includes('共 ' + essay.length + ' 字'), args.content);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
