const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const memory = require('../electron/memory.cjs');
const store = require('../electron/subject/store.cjs');
const { createExecutive } = require('../electron/subject/executive.cjs');
const { runAssistant } = require('../electron/assistant-worker.cjs');
const { createTools } = require('../electron/tools.cjs');

const json = (res, message, usage = { prompt_tokens: 100, completion_tokens: 50 }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage })); };
const kindOf = body => {
  const system = String(body.messages[0].content);
  return system.includes('理解模块') ? 'understand' : system.includes('规划模块') ? 'plan' : system.includes('核对模块') ? 'verify' : 'executor';
};

// A scripted model: answers the subject's narrow questions, and plays the executor with a scripted list of turns.
async function scriptedModel({ intent, executorTurns, planSteps = null }) {
  const calls = [];
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
    const kind = kindOf(body); calls.push({ kind, body });
    if (kind === 'understand') return json(res, { role: 'assistant', content: JSON.stringify(intent) });
    if (kind === 'plan') return json(res, { role: 'assistant', content: JSON.stringify({ steps: planSteps || [{ do: '写入文件', expect: '桌面出现文件' }, { do: '读回核对', expect: '内容正确' }] }) });
    if (kind === 'verify') return json(res, { role: 'assistant', content: JSON.stringify({ passed: true, unmet: [], reason: 'ok' }) });
    const next = executorTurns[Math.min(turn++, executorTurns.length - 1)];
    return json(res, typeof next === 'function' ? next(body) : next);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, server, target: { settings: { endpoint: 'http://127.0.0.1:' + server.address().port, model: 'm' }, apiKey: '' } };
}

async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subject-'));
  for (const name of ['Desktop', 'Documents', 'Downloads']) await fs.mkdir(path.join(dir, name));
  await memory.init(path.join(dir, 'memory'));
  await store.init(path.join(dir, 'memory'));
  const tools = createTools({ memory, userDataDir: path.join(dir, 'u'), getPrefs: () => ({}), host: { path: name => ({ desktop: path.join(dir, 'Desktop'), documents: path.join(dir, 'Documents'), downloads: path.join(dir, 'Downloads') })[name] || dir } });
  const executive = createExecutive({ store, memory, runAssistant, getRoots: () => tools.roots(), similarity: memory.similarity });
  return { dir, tools, executive };
}
const agentFor = (target, tools, request) => ({ ...target, primaryName: 'test', core: async body => body.action === 'reserve_call' ? { call: { id: 'c' } } : { work: {} }, work: { id: 'w', session: 's', goal: request, profile_snapshot: {}, files: [], roles: ['executor'], profile_revision: 0 },
  messages: [{ role: 'user', content: request }], signal: new AbortController().signal, emit: () => {}, receipt: null, coreTools: false, maxTurns: 20, localTools: tools, askTool: async () => 'once', userText: request, persona: { name: 'PISCES AI' }, userProfile: '' });
const writeCall = (file, content) => ({ role: 'assistant', content: '', tool_calls: [{ id: 'w' + Math.random().toString(36).slice(2, 6), type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: file, content }) } }] });

const reportIntent = dir => ({ type: 'task', goal: '在桌面写一份周报', kind: '写周报', deliverable: '桌面上的 周报.txt', done_criteria: [{ check: 'file_contains', target: '周报.txt', value: '本周完成' }], apps: [], params: {}, steps: 'few', ask: null, assumptions: [] });

test('resuming a failed web research node rereads sources with a new lease before releasing the draft step', async () => {
  const { tools } = await workspace();
  const intent = { ...reportIntent(), goal: '先查资料再写样片', done_criteria: [{ check: 'answer_contains', value: '三篇样片' }] };
  const task = store.createTask({ request: '继续样片', intent });
  const oldLease = require('node:crypto').randomUUID();
  task.plan = [
    { id: 'research', text: '查资料', do: '查资料', role: 'researcher', status: 'blocked', runtime_status: 'needs_recheck', depends_on: [], outputs: [], execution: { mode: 'parallel', tools: ['web_search'] }, execution_state: { lease_id: oldLease, effects: [] }, criteria: [{ check: 'tool_succeeded', target: 'web_search' }], evidence: { error: 'fetch failed', unresolvedSteps: [] } },
    { id: 'draft', text: '写样片', do: '写样片', role: 'writer', depends_on: ['research'], status: 'pending', criteria: intent.done_criteria },
  ];
  const model = await scriptedModel({ intent, executorTurns: [] }); let count = 0;
  const executive = createExecutive({ store: { ...store, createTask: () => task }, memory, getRoots: () => tools.roots(), similarity: memory.similarity,
    runAssistant: async () => {
      count++;
      if (count === 1) { assert.notEqual(task.plan[0].execution_state.lease_id, oldLease); assert.equal(task.plan[0].evidence.recovery.kind, 'read_only_web_resume'); return { text: '新读取的资料', trace: [{ tool: 'web_search', ok: true, args: '{}', result: '实际搜索结果' }] }; }
      assert.equal(task.plan[0].verification.passed, true); return { text: '三篇样片', trace: [] };
    } });
  try {
    const result = await executive.handle({ target: model.target, request: '继续样片', background: true, messages: [{ role: 'user', content: '继续样片' }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, '继续样片') });
    assert.equal(count, 2); assert.equal(result.subject.passed, true); assert.equal(task.plan[0].verification.passed, true); assert.equal(model.calls.filter(item => item.kind === 'plan').length, 0);
  } finally { model.server.closeAllConnections(); model.server.close(); }
});

test('verification cannot accept a similarly named file or the same basename in a different folder', async () => {
  const {dir,executive}=await workspace();
  await fs.writeFile(path.join(dir,'Desktop','fake-report.txt'),'本周完成');
  await fs.writeFile(path.join(dir,'Documents','report.txt'),'本周完成');
  const checks=await executive.checkCriteria([{check:'file_contains',target:path.join(dir,'Desktop','report.txt'),value:'本周完成'}],{answer:'我说完成了',since:Date.now()-1000});
  assert.equal(checks[0].passed,false);
});

test('an absolute authorized artifact is verified directly even after the general scan limit is full', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subject-absolute-'));
  const clutter = path.join(dir, 'clutter'), outputs = path.join(dir, 'outputs');
  await fs.mkdir(clutter); await fs.mkdir(outputs);
  await Promise.all(Array.from({ length: 420 }, (_value, index) => fs.writeFile(path.join(clutter, index + '.txt'), 'unrelated')));
  const expected = path.join(outputs, 'verified.txt'); await fs.writeFile(expected, 'real report content');
  const executive = createExecutive({ store: {}, memory: {}, runAssistant: async () => {}, getRoots: () => [clutter, outputs] });
  const checks = await executive.checkCriteria([{ check: 'file_contains', target: expected, value: 'real report content' }], { answer: '', since: 0 });
  assert.equal(checks[0].passed, true);
  const denied = createExecutive({ store: {}, memory: {}, runAssistant: async () => {}, getRoots: () => [clutter] });
  assert.equal((await denied.checkCriteria([{ check: 'file_contains', target: expected, value: 'real report content' }], { answer: '', since: 0 }))[0].passed, false);
});

test('tool criteria require the matching successful receipt from this node', async () => {
  const executive = createExecutive({ store: {}, memory: {}, runAssistant: async () => {} });
  const criterion = [{ check: 'tool_succeeded', target: 'read_text', value: 'source content' }];
  assert.equal((await executive.checkCriteria(criterion, { answer: 'I read source content', since: 0, trace: [] }))[0].passed, false);
  assert.equal((await executive.checkCriteria(criterion, { answer: '', since: 0, trace: [{ tool: 'read_text', ok: false, result: 'source content' }] }))[0].passed, false);
  assert.equal((await executive.checkCriteria(criterion, { answer: '', since: 0, trace: [{ tool: 'read_text', ok: true, result: 'source content' }] }))[0].passed, true);
});
test('a changed amount, filename or negation cannot reuse the old request parameters', async () => {
  await workspace();
  store.recordExperience({request:'把这周的销售额统计到周报里，保存到桌面的报表.txt',intent:{params:{metric:'sales'}},passed:true});
  assert.equal(store.similarSuccess('把这周的销量统计到周报里，保存到桌面的报表.txt'),null);
});

test('the subject owns a task: understands it, plans, hands execution out, and verifies the result itself', async () => {
  const { dir, tools, executive } = await workspace();
  const file = path.join(dir, 'Desktop', '周报.txt');
  const model = await scriptedModel({ intent: reportIntent(dir), executorTurns: [writeCall(file, '本周完成：支付接口'), { role: 'assistant', content: '周报写好了，在桌面。' }] });
  try {
    const request = '帮我写这周的周报放桌面';
    const result = await executive.handle({ target: model.target, request, messages: [{ role: 'user', content: request }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, request) });
    assert.equal(result.subject.passed, true);
    assert.equal(result.subject.route, 'plan');
    assert.match(result.text, /✅ PISCES AI已核对/);
    assert.deepEqual(model.calls.map(call => call.kind).filter(kind => kind !== 'executor'), ['understand', 'plan'], 'a file it can read is checked by the subject itself, without asking a model');
    assert.match(model.calls.find(call => call.kind === 'executor').body.messages[0].content, /PISCES AI交给你的任务[\s\S]*完成标准/);
    assert.equal(store.autonomy().passed, 1);
  } finally { model.server.close(); }
});

test('a claimed "done" that the evidence does not support is caught, replanned and retried', async () => {
  const { dir, tools, executive } = await workspace();
  const file = path.join(dir, 'Desktop', '周报.txt');
  const model = await scriptedModel({ intent: reportIntent(dir), executorTurns: [
    { role: 'assistant', content: '周报已经写好了！' },
    writeCall(file, '本周完成：退款修复'),
    { role: 'assistant', content: '这次真的写好了。' },
  ] });
  try {
    const request = '帮我写这周的周报放桌面';
    const result = await executive.handle({ target: model.target, request, messages: [{ role: 'user', content: request }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, request) });
    assert.equal(result.subject.passed, true);
    assert.equal(model.calls.filter(call => call.kind === 'plan').length, 2, 'replanned after the failed check');
    const retry = model.calls.filter(call => call.kind === 'executor').at(-1).body.messages[0].content;
    assert.match(retry, /上一次没有完成/);
  } finally { model.server.close(); }
});

test('a request it has already done successfully is understood locally, and a learned skill runs with zero model calls', async () => {
  const { dir, tools, executive } = await workspace();
  const file = path.join(dir, 'Desktop', '清单.txt');
  const intent = { type: 'task', goal: '用记事本写清单存到桌面', kind: '记事本记东西', deliverable: '桌面 清单.txt', done_criteria: [{ check: 'file_exists', target: '清单.txt' }], apps: ['记事本'], params: { content: '牛奶' }, steps: 'few', ask: null, assumptions: [] };
  memory.addSkill({ title: '用记事本写清单存到桌面', trigger: '记事本记东西', app: 'notepad', params: [{ name: 'content', example: '牛奶' }], steps: [{ op: 'open', window: '记事本' }, { op: 'type', text: '{{content}}', into: null, changed: true }] });
  // Stand-in for the control layer: running the skill produces the file.
  const ran = [];
  const stubTools = { ...tools, execute: async (name, args, ctx) => { if (name === 'run_skill') { ran.push(args); await fs.writeFile(file, args.params.content); return { ok: true }; } return tools.execute(name, args, ctx); } };
  const model = await scriptedModel({ intent, executorTurns: [{ role: 'assistant', content: '不应该用到执行者' }] });
  try {
    const request = '用记事本写个清单：牛奶，存桌面';
    const first = await executive.handle({ target: model.target, request, messages: [{ role: 'user', content: request }], tools: stubTools, signal: new AbortController().signal, agent: agentFor(model.target, stubTools, request) });
    assert.equal(first.subject.route, 'skill');
    assert.equal(first.subject.passed, true);
    assert.deepEqual(model.calls.map(call => call.kind), ['understand'], 'only the understanding needed the model');
    await fs.rm(file);
    const before = model.calls.length;
    const again = await executive.handle({ target: model.target, request, messages: [{ role: 'user', content: request }], tools: stubTools, signal: new AbortController().signal, agent: agentFor(model.target, stubTools, request) });
    assert.equal(again.subject.passed, true);
    assert.equal(again.subject.localUnderstanding, true);
    assert.equal(model.calls.length, before, 'the second time: understood locally, executed locally, verified locally — no model call at all');
    assert.equal(ran.length, 2);
    assert.equal(store.autonomy().handledLocally, 1, 'the first skill run still used a model to understand the request');
  } finally { model.server.close(); }
});

test('small talk skips the task machinery, and an unusable understanding falls back to a plain answer', async () => {
  const { tools, executive } = await workspace();
  const model = await scriptedModel({ intent: { nonsense: true }, executorTurns: [{ role: 'assistant', content: '你好呀' }] });
  try {
    const hi = await executive.handle({ target: model.target, request: '你好', messages: [{ role: 'user', content: '你好' }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, '你好') });
    assert.equal(hi.subject.route, 'chat');
    assert.equal(model.calls.filter(call => call.kind === 'understand').length, 0);
    const odd = await executive.handle({ target: model.target, request: '帮我想想这个周末怎么安排比较好', messages: [{ role: 'user', content: '帮我想想这个周末怎么安排比较好' }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, 'x') });
    assert.equal(odd.subject.route, 'fallback');
    assert.equal(odd.text, '你好呀');
  } finally { model.server.close(); }
});

test('the understanding sees what the user attached, so "fix this photo" never turns into "please upload it"', async () => {
  const { tools, executive } = await workspace();
  const model = await scriptedModel({ intent: { type: 'chat', goal: '修图', kind: '修图', done_criteria: [], apps: [], params: {}, steps: 'one', ask: null, assumptions: [] }, executorTurns: [{ role: 'assistant', content: '好的' }] });
  try {
    const request = '这张照片拍歪了，帮我修一下';
    await executive.handle({ target: model.target, request, attachments: '用户本轮附带的文件（本机路径）：\n- 街景.jpg：D:\Pictures\街景.jpg', messages: [{ role: 'user', content: request }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, request) });
    assert.match(model.calls.find(call => call.kind === 'understand').body.messages[1].content, /街景\.jpg/);
  } finally { model.server.close(); }
});

test('explicit tasks execute ready nodes in dependency order and persist verification before supplying an output', async () => {
  const { dir, tools } = await workspace();
  const draft = path.join(dir, 'Desktop', 'draft.txt'), report = path.join(dir, 'Desktop', 'report.txt');
  const planSteps = [
    { id: 'draft', do: 'write draft', depends_on: [], criteria: [{ check: 'file_contains', target: draft, value: 'source data' }], outputs: [draft] },
    { id: 'report', do: 'write final report', depends_on: ['draft'], criteria: [{ check: 'file_contains', target: report, value: 'verified summary' }], outputs: [report] },
  ];
  const model = await scriptedModel({ intent: { ...reportIntent(dir), done_criteria: [{ check: 'file_contains', target: report, value: 'verified summary' }] }, planSteps, executorTurns: [] });
  const executions = [], published = [];
  const executive = createExecutive({ store, memory, getRoots: () => tools.roots(), similarity: memory.similarity, runAssistant: async options => {
    const task = store.listTasks()[0];
    const active = task.plan.find(node => node.runtime_status === 'doing');
    executions.push(active.id);
    if (active.id === 'draft') { await fs.writeFile(draft, 'source data'); return { text: 'draft saved', trace: [{ tool: 'write_text', ok: true, result: draft }] }; }
    assert.equal(task.plan.find(node => node.id === 'draft').verification.passed, true);
    assert.match(options.memoryContext, /已验收的前置产物[\s\S]*source data|已验收的前置产物[\s\S]*draft\.txt/);
    assert.equal(await fs.readFile(draft, 'utf8'), 'source data');
    await fs.writeFile(report, 'verified summary'); return { text: 'final report saved', trace: [{ tool: 'write_text', ok: true, result: report }] };
  } });
  try {
    const request = 'build a report from a draft';
    const result = await executive.handle({ target: model.target, request, forceTask: true, messages: [{ role: 'user', content: request }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, request), onPlan: async plan => published.push(structuredClone(plan)) });
    assert.deepEqual(executions, ['draft', 'report']);
    assert.equal(result.subject.route, 'plan_nodes');
    assert.equal(result.subject.passed, true);
    assert.ok(published.some(plan => plan[0].verification?.passed === true && plan[1].runtime_status === 'pending'));
    assert.ok(store.listTasks()[0].plan.every(node => node.status === 'done' && node.verification.passed));
  } finally { model.server.close(); }
});

test('unsupported node completion claims never release dependent nodes', async () => {
  const { tools } = await workspace(); const executed = [];
  const model = await scriptedModel({ intent: { ...reportIntent(), done_criteria: [{ check: 'answer_contains', value: 'finished' }] }, planSteps: [
    { id: 'source', do: 'read original source', depends_on: [], criteria: [{ check: 'judgement', value: 'source was actually read' }] },
    { id: 'summary', do: 'summarize source', depends_on: ['source'], criteria: [{ check: 'answer_contains', value: 'finished' }] },
  ], executorTurns: [] });
  const executive = createExecutive({ store, memory, runAssistant: async () => { executed.push(store.listTasks()[0].plan.find(node => node.runtime_status === 'doing').id); return { text: 'finished; trust me', trace: [] }; }, getRoots: () => tools.roots(), similarity: memory.similarity });
  try {
    const request = 'read and summarize the source';
    const result = await executive.handle({ target: model.target, request, background: true, messages: [{ role: 'user', content: request }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, request) });
    assert.deepEqual(executed, ['source', 'source']);
    assert.equal(result.subject.passed, false);
    assert.equal(store.listTasks()[0].plan[0].runtime_status, 'blocked');
    assert.equal(store.listTasks()[0].plan[1].verification.passed, false);
    assert.match(result.text, /没有真实工具观察或文件证据/);
  } finally { model.server.close(); }
});

test('recovery rereads a persisted output before reusing a verified node', async () => {
  const { dir, tools } = await workspace();
  const draft = path.join(dir, 'Desktop', 'existing.txt'), report = path.join(dir, 'Desktop', 'restored-report.txt');
  await fs.writeFile(draft, 'valid input');
  const intent = { ...reportIntent(), done_criteria: [{ check: 'file_contains', target: report, value: 'restored output' }] };
  const task = store.createTask({ request: 'continue report', intent });
  task.plan = [
    { id: 'source', text: 'existing source', do: 'read source', status: 'done', runtime_status: 'done', depends_on: [], outputs: [draft], criteria: [{ check: 'file_contains', target: draft, value: 'valid input' }], verification: { passed: true }, evidence: { answer: 'input ready', file_inputs: [], file_outputs: [await require('../electron/file-state.cjs').snapshotFile(draft, tools.roots())] } },
    { id: 'report', text: 'write report', do: 'write report', status: 'pending', runtime_status: 'pending', depends_on: ['source'], outputs: [report], criteria: [{ check: 'file_contains', target: report, value: 'restored output' }] },
  ];
  const model = await scriptedModel({ intent, executorTurns: [] }); const executed = [];
  const resumeStore = { ...store, createTask: async () => task };
  const executive = createExecutive({ store: resumeStore, memory, runAssistant: async () => {
    const active = task.plan.find(node => node.runtime_status === 'doing'); executed.push(active.id);
    assert.equal(task.plan[0].verification.revalidated, true);
    await fs.writeFile(report, 'restored output'); return { text: 'restored report ready', trace: [{ tool: 'write_text', ok: true, result: report }] };
  }, getRoots: () => tools.roots(), similarity: memory.similarity });
  try {
    const request = 'continue report';
    const result = await executive.handle({ target: model.target, request, background: true, messages: [{ role: 'user', content: request }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, request) });
    assert.deepEqual(executed, ['report']);
    assert.equal(result.subject.passed, true);
    assert.equal(model.calls.filter(call => call.kind === 'plan').length, 0);
  } finally { model.server.close(); }
});

test('explicit tasks cannot silently fall back to a chat answer without task understanding', async () => {
  const { tools, executive } = await workspace();
  const model = await scriptedModel({ intent: { type: 'chat', goal: '聊聊', done_criteria: [], steps: 'one' }, executorTurns: [{ role: 'assistant', content: '我来解释一下' }] });
  try {
    await assert.rejects(executive.handle({ target: model.target, request: 'make the report', forceTask: true, messages: [{ role: 'user', content: 'make the report' }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, 'make the report') }), /type 必须为 task/);
    assert.equal(model.calls.filter(call => call.kind === 'executor').length, 0);
  } finally { model.server.close(); }
});

test('a changed input invalidates a still-existing output and its dependents before any executor action', async () => {
  const { dir, tools } = await workspace();
  const input=path.join(dir,'Desktop','source.txt'),output=path.join(dir,'Desktop','report.txt');
  await fs.writeFile(input,'old input');await fs.writeFile(output,'valid report');
  const state=await require('../electron/file-state.cjs').snapshotFile(input,tools.roots()),stat=await fs.stat(input);
  const intent={...reportIntent(),done_criteria:[{check:'file_contains',target:output,value:'valid report'}]};
  const task=store.createTask({request:'continue report from input',intent});
  task.plan=[{id:'read',text:'Read source',do:'Read source',status:'done',runtime_status:'done',depends_on:[],outputs:[output],criteria:[{check:'file_contains',target:output,value:'valid report'}],verification:{passed:true},evidence:{file_inputs:[state]}},{id:'finish',text:'Finish report',do:'Finish report',status:'pending',runtime_status:'pending',depends_on:['read'],outputs:[],criteria:[{check:'answer_contains',value:'finished'}]}];
  await fs.writeFile(input,'new input');await fs.utimes(input,stat.atime,stat.mtime);
  const model=await scriptedModel({intent,executorTurns:[]});let executions=0;
  const executive=createExecutive({store:{...store,createTask:async()=>task},memory,runAssistant:async()=>{executions++;return{text:'finished'};},getRoots:()=>tools.roots(),similarity:memory.similarity});
  try{
    await assert.rejects(executive.handle({target:model.target,request:'continue report from input',background:true,messages:[{role:'user',content:'continue report from input'}],tools,signal:new AbortController().signal,agent:agentFor(model.target,tools,'continue report from input')}),error=>error.code==='CORE_INPUT_CHANGED');
    assert.equal(executions,0);assert.ok(task.plan.every(node=>node.runtime_status==='blocked'&&node.verification.passed===false));assert.equal(await fs.readFile(output,'utf8'),'valid report');
  }finally{model.server.close();}
});

test('an unknown persisted node with no current proof stops recovery instead of replaying its action', async () => {
  const { tools } = await workspace();
  const intent = { ...reportIntent(), done_criteria: [{ check: 'answer_contains', value: 'sent' }] };
  const task = store.createTask({ request: 'continue sending', intent });
  task.plan = [{ id: 'send', text: 'Send report', do: 'send report', status: 'blocked', runtime_status: 'unknown', depends_on: [], outputs: [], criteria: [{ check: 'judgement', value: 'report was sent exactly once' }], evidence: { unresolvedSteps: [{ operation: 'send_report', status: 'unknown' }] }, verification: { passed: false } }];
  const model = await scriptedModel({ intent, executorTurns: [] }); let executions = 0;
  const executive = createExecutive({ store: { ...store, createTask: () => task }, memory, runAssistant: async () => { executions++; return { text: 'sent', trace: [] }; }, getRoots: () => tools.roots(), similarity: memory.similarity });
  try {
    await assert.rejects(executive.handle({ target: model.target, request: 'continue sending', background: true, messages: [{ role: 'user', content: 'continue sending' }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, 'continue sending') }), error => error.code === 'CORE_ACTION_UNCERTAIN');
    assert.equal(executions, 0); assert.equal(task.plan[0].runtime_status, 'unknown');
    assert.equal(model.calls.filter(call => call.kind === 'plan').length, 0);
  } finally { model.server.close(); }
});

test('a persisted answer claim cannot reconcile an unknown physical action', async () => {
  const { tools } = await workspace();
  const intent = { ...reportIntent(), done_criteria: [{ check: 'answer_contains', value: 'sent' }] };
  const task = store.createTask({ request: 'continue sending', intent });
  task.plan = [{ id: 'send', text: 'Send report', do: 'send report', status: 'blocked', runtime_status: 'unknown', depends_on: [], outputs: [], criteria: [{ check: 'answer_contains', value: 'sent' }], evidence: { answer: 'sent' }, verification: { passed: false } }];
  const model = await scriptedModel({ intent, executorTurns: [] }); let executions = 0;
  const executive = createExecutive({ store: { ...store, createTask: () => task }, memory, runAssistant: async () => { executions++; return { text: 'sent', trace: [] }; }, getRoots: () => tools.roots(), similarity: memory.similarity });
  try {
    await assert.rejects(executive.handle({ target: model.target, request: 'continue sending', background: true, messages: [{ role: 'user', content: 'continue sending' }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, 'continue sending') }), error => error.code === 'CORE_ACTION_UNCERTAIN');
    assert.equal(executions, 0); assert.equal(task.plan[0].runtime_status, 'unknown');
  } finally { model.server.close(); }
});

test('legacy file steps without source fingerprints require replanning before executor actions', async () => {
  const { dir, tools } = await workspace(), report = path.join(dir, 'Desktop', 'legacy-report.txt');
  await fs.writeFile(report, 'valid old report');
  const intent = { ...reportIntent(), done_criteria: [{ check: 'file_contains', target: report, value: 'valid old report' }] };
  const task = store.createTask({ request: 'continue legacy report', intent });
  task.plan = [{ id: 'legacy', text: 'Old file step', do: 'Read and write report', status: 'done', runtime_status: 'done', depends_on: [], outputs: [report], criteria: intent.done_criteria, verification: { passed: true }, evidence: { answer: 'valid old report' } }];
  const model = await scriptedModel({ intent, executorTurns: [] }); let executions = 0;
  const executive = createExecutive({ store: { ...store, createTask: () => task }, memory, runAssistant: async () => { executions++; return { text: 'claimed fresh', trace: [] }; }, getRoots: () => tools.roots(), similarity: memory.similarity });
  try {
    await assert.rejects(executive.handle({ target: model.target, request: 'continue legacy report', background: true, messages: [{ role: 'user', content: 'continue legacy report' }], tools, signal: new AbortController().signal, agent: agentFor(model.target, tools, 'continue legacy report') }), error => error.code === 'CORE_INPUT_CHANGED' && error.sourceChanges.some(item => item.reason.includes('没有文件来源指纹')));
    assert.equal(executions, 0); assert.equal(await fs.readFile(report, 'utf8'), 'valid old report'); assert.equal(task.plan[0].verification.passed, false);
  } finally { model.server.close(); }
});

test('a typed read-only checkpoint resumes with a fresh identity and rereads its unchanged source', async () => {
  const {dir,tools}=await workspace(), source=path.join(dir,'Desktop','source.txt');await fs.writeFile(source,'stable source');
  const fileState=await require('../electron/file-state.cjs').snapshotFile(source,tools.roots()),oldLease=require('node:crypto').randomUUID();
  const intent={...reportIntent(),done_criteria:[{check:'tool_succeeded',target:'read_text',value:'stable source'}]};
  const task=store.createTask({request:'continue source check',intent});
  task.plan=[{id:'read',text:'Read source',do:'Read source',depends_on:[],status:'doing',runtime_status:'doing',role:'researcher',inputs:[source],outputs:[],execution:{mode:'parallel',tools:['read_text']},criteria:intent.done_criteria,execution_state:{lease_id:oldLease,effects:[]},evidence:{read_proofs:[{receiptId:require('node:crypto').randomUUID(),status:'verified',nodeId:'read',nodeLeaseId:oldLease,file_state:fileState,matches:[]}]}}];
  const model=await scriptedModel({intent,executorTurns:[]});let count=0;
  const executive=createExecutive({store:{...store,createTask:()=>task},memory,getRoots:()=>tools.roots(),similarity:memory.similarity,runAssistant:async()=>{count++;assert.notEqual(task.plan[0].execution_state.lease_id,oldLease);return {text:'checked',trace:[{tool:'read_text',ok:true,args:JSON.stringify({path:source}),result:await fs.readFile(source,'utf8'),file_state:fileState}]};}});
  try{const result=await executive.handle({target:model.target,request:'continue source check',background:true,messages:[{role:'user',content:'continue source check'}],tools,signal:new AbortController().signal,agent:agentFor(model.target,tools,'continue source check')});assert.equal(result.subject.passed,true);assert.equal(count,1);assert.equal(task.plan[0].evidence.recovery.kind,'read_only_resume');}finally{model.server.close();}
});

test('a dispatched write cannot use read-only recovery to replay an uncertain effect', async () => {
  const {dir,tools}=await workspace(), source=path.join(dir,'Desktop','source.txt'), output=path.join(dir,'Desktop','missing-output.txt');await fs.writeFile(source,'stable');
  const fileState=await require('../electron/file-state.cjs').snapshotFile(source,tools.roots()),oldLease=require('node:crypto').randomUUID(),intent={...reportIntent(),done_criteria:[{check:'file_exists',target:output}]};
  const task=store.createTask({request:'continue uncertain write',intent});
  task.plan=[{id:'write',text:'Write result',do:'Write result',depends_on:[],status:'doing',runtime_status:'doing',inputs:[source],outputs:[output],execution:{mode:'parallel',tools:['read_text','write_text']},criteria:intent.done_criteria,execution_state:{lease_id:oldLease,effects:[{operation:'write_text',path:output}]},evidence:{read_proofs:[{receiptId:require('node:crypto').randomUUID(),status:'verified',nodeId:'write',nodeLeaseId:oldLease,file_state:fileState,matches:[]}]}}];
  const model=await scriptedModel({intent,executorTurns:[]});let count=0;
  const executive=createExecutive({store:{...store,createTask:()=>task},memory,getRoots:()=>tools.roots(),similarity:memory.similarity,runAssistant:async()=>{count++;return{text:'claimed done',trace:[]};}});
  try{await assert.rejects(executive.handle({target:model.target,request:'continue uncertain write',background:true,messages:[{role:'user',content:'continue uncertain write'}],tools,signal:new AbortController().signal,agent:agentFor(model.target,tools,'continue uncertain write')}),error=>error.code==='CORE_ACTION_UNCERTAIN');assert.equal(count,0);}finally{model.server.close();}
});
