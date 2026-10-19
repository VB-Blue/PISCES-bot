const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openCanonicalRun } = require('../electron/subject/canonical-run.cjs');

test('losing canonical begin acknowledgement cannot authorize a fallback task execution',async()=>{
  await assert.rejects(openCanonicalRun({request:async()=>{throw new TypeError('connection lost after begin');},getState:async()=>({continuity:{schema:1},works:[]}),id:'begin-loss',session:'saved-session',message:'continue the report'}),error=>error.code==='CORE_AUTHORITY_LOST');
});
const { runAssistant } = require('../electron/assistant-worker.cjs');
const { createControlTools } = require('../electron/control-tools.cjs');
const { normalizePlan } = require('../electron/subject/plan.cjs');

async function canonicalFixture({ onWork, failUpdate = false } = {}) {
  const id = randomUUID(), session = randomUUID();
  const work = { id, session, status: 'running', cognition: { revision: 1, request: 'create report', intent: {}, plan: [] }, receipts: [] };
  const calls = [], active = [];
  const canonical = await openCanonicalRun({ id, session, message: 'create report', onWork, getState: async () => ({ continuity: { schema: 1 } }), request: async body => {
    const r = body.request; calls.push(r);
    if (r.kind === 'begin') return { schema: 1, event: { id, session, status: 'running' }, profile: {}, facts: [], works: [] };
    if (r.kind === 'interpret') return { work: structuredClone(work), context: { profile: {}, facts: [], works: [] } };
    if (r.kind === 'update') {
      if (failUpdate) throw new Error('revision conflict');
      Object.assign(work.cognition, r.patch); return { work: structuredClone(work) };
    }
    if (r.kind === 'step_begin') {
      if (r.operation !== 'read_text' && active.length) throw new Error('work_operation_in_flight_or_unknown');
      if (active.some(item => item.operation !== 'read_text')) throw new Error('work_operation_in_flight_or_unknown');
      active.push({ id: r.request_id, operation: r.operation });
    }
    if (r.kind === 'step_end') { active.splice(active.findIndex(item => item.id === r.request_id), 1); return { receipt: { id: r.request_id, status: r.ok ? 'observed_success' : 'failed' } }; }
    return { ok: true };
  } });
  await canonical.store.acceptUnderstanding({ type: 'task' });
  return { canonical, work, calls };
}

test('an old core is recognized before submitting a user event', async () => {
  let sent=0;
  await assert.rejects(openCanonicalRun({ getState:async()=>({works:[]}), request:async()=>{sent++;} }), error=>error.code==='CORE_CONTINUITY_UNSUPPORTED');
  assert.equal(sent,0);
});
test('a mismatched event receipt cannot become task authority', async () => {
  await assert.rejects(openCanonicalRun({ id:randomUUID(),session:randomUUID(),message:'写文件',getState:async()=>({continuity:{schema:1}}),request:async()=>({schema:1,event:{id:randomUUID(),session:randomUUID(),status:'running'}}) }),/回执与当前请求不一致/);
});
test('losing the acknowledgement after a real write stops the executor before it can repeat', async () => {
  const id=randomUUID(),session=randomUUID();const dir=await fs.mkdtemp(path.join(os.tmpdir(),'continuity-ack-'));const file=path.join(dir,'result.txt');
  let writes=0,requests=0;const observations=[];
  const work={id,session,goal:'写文件',profile_snapshot:{},profile_revision:0,files:[],roles:['executor'],cognition:{revision:1,request:'写文件',intent:{},plan:[],route:''},receipts:[]};
  const canonical=await openCanonicalRun({id,session,message:'写文件',onReceipt:value=>observations.push(value),getState:async()=>({continuity:{schema:1}}),request:async body=>{
    const r=body.request;
    if(r.kind==='begin')return {schema:1,event:{id,session,status:'running'},profile:{},facts:[],works:[]};
    if(r.kind==='interpret')return {work,context:{profile:{},facts:[],works:[]}};
    if(r.kind==='call_begin')return {call:{id:randomUUID()}};
    if(r.kind==='step_end')throw new Error('acknowledgement lost');
    return {ok:true};
  }});
  await canonical.store.acceptUnderstanding({type:'task'});
  const server=http.createServer(async(req,res)=>{for await(const _part of req){}requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'write',type:'function',function:{name:'write_text',arguments:JSON.stringify({path:file,content:'真实写入'})}}]}}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const tools=canonical.wrapTools({names:new Set(['write_text']),definitions:[{type:'function',function:{name:'write_text',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}}}}}],has:name=>name==='write_text',label:()=> '写文件',execute:async()=>{writes++;await fs.writeFile(file,'真实写入');return {ok:true};}});
  try {
    await assert.rejects(runAssistant({settings:{endpoint:'http://127.0.0.1:'+server.address().port,model:'isolated'},apiKey:'',core:canonical.modelCore,strictCallAccounting:true,coreTools:false,work,messages:[{role:'user',content:'写文件'}],signal:new AbortController().signal,localTools:tools,maxTurns:5}),error=>error.code==='CORE_ACTION_UNCERTAIN');
    assert.equal(writes,1);assert.equal(requests,1);assert.equal(await fs.readFile(file,'utf8'),'真实写入');assert.equal(observations.length,0,'an unacknowledged action cannot stream as a persisted observation');
  } finally {server.close();}
});

test('persisted observations stream once, and a failed display callback cannot cause an action retry', async () => {
  const id=randomUUID(),session=randomUUID();let events=0,acknowledged=false;
  const work={id,session,cognition:{revision:1,request:'读取表格',intent:{},plan:[]},receipts:[]};
  const canonical=await openCanonicalRun({id,session,message:'读取表格',getState:async()=>({continuity:{schema:1}}),onReceipt:value=>{assert.equal(acknowledged,true);assert.equal(value.phase,'observed');assert.equal(value.workId,id);events++;throw new Error('display closed');},request:async body=>{
    const r=body.request;if(r.kind==='begin')return {schema:1,event:{id,session,status:'running'},profile:{},facts:[],works:[]};if(r.kind==='interpret')return {work,context:{profile:{},facts:[],works:[]}};if(r.kind==='step_end'){acknowledged=true;return {receipt:{id:r.request_id,operation:'read_text',status:'observed_success',evidence:{observation:r.observation}}};}return {ok:true};
  }});
  await canonical.store.acceptUnderstanding({type:'task'});let calls=0;
  const result=await canonical.wrapTools({execute:async()=>{calls++;return {ok:true,text:'地区,销量\n华东,20'};}}).execute('read_text',{},{});
  assert.equal(result.text,'地区,销量\n华东,20');assert.equal(events,1);assert.equal(calls,1);
});

test('update_plan submits normalized nodes before displaying the plan and awaits its callback', async () => {
  const order = [];
  const { canonical, work } = await canonicalFixture({ onWork: async next => { if (next.cognition.plan.length) order.push('persisted'); } });
  const control = createControlTools({ host: {}, approve: async () => {} });
  const tools = canonical.wrapTools({ execute: (name, args, ctx) => control.impl[name](args, ctx) });
  const result = await tools.execute('update_plan', { steps: [{ id: 'read', text: 'Read inputs', status: 'done', depends_on: [] }, { id: 'write', text: 'Write report', status: 'doing', depends_on: ['read'], expect: 'a complete report', outputs: ['report.md'] }] }, { onPlan: async plan => {
    assert.deepEqual(work.cognition.plan, plan);
    await new Promise(resolve => setTimeout(resolve, 10)); order.push('displayed');
  } });
  assert.deepEqual(order, ['persisted', 'displayed']);
  assert.equal(result.plan[1].id, 'write');
  assert.deepEqual(result.plan[1].criteria, [{ check: 'judgement', value: 'a complete report' }]);
  assert.deepEqual(result.plan[1].outputs, ['report.md']);
  const update = await tools.execute('update_plan', { steps: [{ id: 'read', text: 'Read inputs', status: 'done', depends_on: [] }, { id: 'write', text: 'Write report', status: 'done' }] }, {});
  assert.deepEqual(update.plan[1].depends_on, ['read']);
  assert.deepEqual(update.plan[1].outputs, ['report.md']);
});

test('rejected plan persistence is never displayed and stops subsequent actions', async () => {
  const { canonical } = await canonicalFixture({ failUpdate: true });
  let displayed = 0, writes = 0;
  const control = createControlTools({ host: {}, approve: async () => {} });
  const tools = canonical.wrapTools({ execute: async (name, args, ctx) => name === 'update_plan' ? control.impl.update_plan(args, ctx) : (++writes, { ok: true }) });
  await assert.rejects(tools.execute('update_plan', { steps: [{ text: 'Write report', status: 'pending' }] }, { onPlan: () => displayed++ }), error => error.code === 'CORE_AUTHORITY_LOST');
  await assert.rejects(tools.execute('write_text', {}, {}), error => error.code === 'CORE_AUTHORITY_LOST');
  assert.equal(displayed, 0); assert.equal(writes, 0);
});

test('same-work delegates and writes queue without core conflicts while independent reads can run together', async () => {
  const { canonical, calls } = await canonicalFixture();
  const order = [];
  let readers = 0, maxReaders = 0;
  const tools = canonical.wrapTools({ execute: async (name, args) => {
    order.push('start:' + args.name);
    if (name === 'read_text') { readers++; maxReaders = Math.max(maxReaders, readers); }
    await new Promise(resolve => setTimeout(resolve, 10));
    if (name === 'read_text') readers--;
    order.push('end:' + args.name); return { ok: true };
  } });
  await Promise.all([
    tools.execute('delegate', { name: 'research' }, {}),
    tools.execute('delegate', { name: 'writer' }, {}),
    tools.execute('write_text', { name: 'main-write' }, {}),
    tools.execute('read_text', { name: 'input-a' }, {}),
    tools.execute('read_text', { name: 'input-b' }, {}),
  ]);
  assert.deepEqual(order.slice(0, 6), ['start:research', 'end:research', 'start:writer', 'end:writer', 'start:main-write', 'end:main-write']);
  assert.equal(maxReaders, 2);
  assert.equal(calls.filter(item => item.kind === 'step_begin').length, 5);
});

test('a queued delegate cannot run after the preceding action lost acknowledgement', async () => {
  const id = randomUUID(), session = randomUUID(); let dispatched = 0;
  const work = { id, session, cognition: { revision: 1, request: '', intent: {}, plan: [] } };
  const canonical = await openCanonicalRun({ id, session, message: 'create report', getState: async () => ({ continuity: { schema: 1 } }), request: async body => {
    if (body.request.kind === 'begin') return { schema: 1, event: { id, session, status: 'running' }, profile: {}, facts: [], works: [] };
    if (body.request.kind === 'interpret') return { work, context: { profile: {}, facts: [], works: [] } };
    if (body.request.kind === 'step_end') throw new Error('ack lost');
    return { ok: true };
  } });
  await canonical.store.acceptUnderstanding({ type: 'task' });
  const tools = canonical.wrapTools({ execute: async () => { dispatched++; return { ok: true }; } });
  const results = await Promise.allSettled([tools.execute('delegate', {}, {}), tools.execute('delegate', {}, {})]);
  assert.equal(dispatched, 1);
  assert.ok(results.every(item => item.status === 'rejected' && item.reason.code === 'CORE_ACTION_UNCERTAIN'));
});

test('canonical wrapper retains dynamic tool definitions', async () => {
  const { canonical } = await canonicalFixture(); let definitions = [];
  const wrapped = canonical.wrapTools({ get definitions() { return definitions; }, execute: async () => ({ ok: true }) });
  assert.equal(wrapped.definitions.length, 0);
  definitions = [{ type: 'function', function: { name: 'read_text' } }];
  assert.equal(wrapped.definitions.length, 1);
});

test('plan contract rejects cycles, preserves stable ids and validates explicit dependencies', () => {
  const first = normalizePlan([{ do: 'Read source', expect: 'source loaded' }, { do: 'Write result', expect: 'output saved' }]);
  const reordered = normalizePlan([{ text: first[1].text, status: 'doing', depends_on: [] }, { text: first[0].text, status: 'done', depends_on: [] }], first);
  assert.equal(reordered[0].id, first[1].id);
  assert.deepEqual(first[1].depends_on, [first[0].id]);
  assert.throws(() => normalizePlan([{ id: 'a', text: 'A', depends_on: ['b'] }, { id: 'b', text: 'B', depends_on: ['a'] }]), /循环/);
  assert.throws(() => normalizePlan([{ id: 'a', text: 'A', depends_on: ['missing'] }]), /不存在/);
});

test('linked work recovery overrides a model proposal to create a second work', async () => {
  const id = randomUUID(), session = randomUUID(), linkedWorkId = randomUUID(); let interpretation;
  const work = { id: linkedWorkId, session, cognition: { revision: 3, request: 'report', plan: [] } };
  const canonical = await openCanonicalRun({ id, session, linkedWorkId, message: 'continue report', getState: async () => ({ continuity: { schema: 1 }, works: [work] }), request: async body => {
    if (body.request.kind === 'begin') return { schema: 1, event: { id, session, status: 'running' }, profile: {}, facts: [], works: [work] };
    interpretation = body.request.intent; return { work, context: { profile: {}, facts: [], works: [work] } };
  } });
  await canonical.store.acceptUnderstanding({ type: 'task', work_relation: { kind: 'new' } });
  assert.deepEqual(interpretation.work_relation, { kind: 'continue', work_id: linkedWorkId });
  await assert.rejects(canonical.store.acceptUnderstanding({ type: 'chat' }), /恢复已有任务/);
});

test('structured tool failures and unknown execution status remain failures in core receipts', async () => {
  const { canonical, calls } = await canonicalFixture();
  const values = [{ ok: true, satisfied: false }, { ok: true, execution_status: 'not_executed' }, { ok: true, execution_status: 'unknown' }];
  const tools = canonical.wrapTools({ execute: async () => values.shift() });
  await tools.execute('wait_for', {}, {});
  await tools.execute('send', {}, {});
  await assert.rejects(tools.execute('click', {}, {}), error => error.code === 'CORE_ACTION_UNCERTAIN');
  const settled = calls.filter(item => item.kind === 'step_end');
  assert.deepEqual(settled.map(item => item.ok), [false, false, false]);
  assert.deepEqual(settled.map(item => item.unknown), [false, false, true]);
});

test('executor progress cannot forge node verification or change an active acceptance contract', async () => {
  const { canonical } = await canonicalFixture();
  const task = await canonical.store.createTask();
  await canonical.store.updateTask(task, { plan: [{ id: 'write', text: 'Write actual report', do: 'write report', status: 'doing', runtime_status: 'doing', criteria: [{ check: 'file_contains', target: 'report.txt', value: 'required totals' }], outputs: ['report.txt'], verification: { passed: false } }] });
  const control = createControlTools({ host: {}, approve: async () => {} });
  const tools = canonical.wrapTools({ execute: (name, args, ctx) => control.impl[name](args, ctx) });
  const result = await tools.execute('update_plan', { steps: [{ id: 'write', text: 'Skip report', status: 'done', criteria: [{ check: 'answer_contains', value: 'done' }], verification: { passed: true } }] }, {});
  assert.equal(result.plan[0].verification.passed, false);
  assert.equal(result.plan[0].runtime_status, 'doing');
  assert.equal(result.plan[0].text, 'Write actual report');
  assert.equal(result.plan[0].criteria[0].check, 'file_contains');
  assert.equal(result.plan[0].criteria[0].value, 'required totals');
});
