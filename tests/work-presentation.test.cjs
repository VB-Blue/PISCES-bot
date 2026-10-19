const test = require('node:test');
const assert = require('node:assert/strict');
const projection = import('../src/workPresentation.ts');
const model = import('../src/presenceModel.ts');
const { summarizeObservation } = require('../electron/subject/observation.cjs');
const { normalizeIntent } = require('../electron/subject/cognition.cjs');
const receipt = (operation, data, id = operation) => ({ id, operation, status: 'observed_success', evidence: { source: 'desktop_bridge', turn_id: 'turn-1', revision: 1, observation: JSON.stringify(data) }, error: null });
const entry = (receipts = [], intent = {}, extra = {}) => ({ id: 'core:work-1', title: '已有事情', summary: '', status: '结果已核对', time: '2026-10-05', ongoing: false, work: { id: 'work-1', status: 'checked_by_desktop', result: '', receipts, cognition: { revision: 1, intent, plan: [], verification: {} } }, ...extra });

test('live job allocation wins over an older projection, while a newer core revision can clear the old plan', async () => {
  const { planFor } = await projection;
  const current=entry([],{}, {job:{workId:'work-1',workRevision:1,plan:[{id:'a',text:'Read data',do:'Read data',status:'doing',role:'researcher',execution:{mode:'parallel'},execution_state:{state:'running',service:'configured service'}}]}});
  assert.equal(planFor(current)[0].allocation.service,'configured service');assert.equal(planFor(current)[0].role,'researcher');
  current.work.cognition.revision=2;current.work.cognition.plan=[];assert.deepEqual(planFor(current),[]);
});

test('purpose chooses the workspace, rather than incidental files or unsupported generated markup', async () => {
  const { inferWorkKind } = await projection;
  assert.equal(inferWorkKind(entry([receipt('write_text', {path:'D:\\report.csv'})], {kind:'统计销量', deliverable:'report.csv'})), 'data');
  assert.equal(inferWorkKind(entry([], {kind:'整理文件夹', goal:'整理含有周报的文件夹'})), 'files');
  assert.equal(inferWorkKind(entry([], {presentation:'research', goal:'研究产品并写报告'})), 'research');
  assert.equal(inferWorkKind(entry([], {}, {work: undefined, title:'未知事情', message:{content:'回复已收到'}})), 'general');
  assert.equal(normalizeIntent({type:'task',goal:'写报告',presentation:'<script>evil()</script>',done_criteria:[]}).presentation, null);
  assert.equal(normalizeIntent({type:'task',goal:'分析数据',presentation:'data',done_criteria:[]}).presentation, 'data');
});
test('unknown or failed outcomes cannot become the result stage merely because there is a reply', async () => {
  const { workPhase } = await projection;
  for (const status of ['result_unknown','unverified','failed','interrupted']) { const item = entry(); item.work.status=status; item.work.result='我已经做完了'; assert.equal(workPhase(item), 'review'); }
  assert.equal(workPhase(entry()), 'result');
  assert.equal(workPhase(entry([], {}, {work:undefined,record:{status:'active'}})), 'followup');
  const awaiting=entry();awaiting.work.status='waiting';assert.equal(workPhase(awaiting),'waiting');
});

test('model failure diagnostics never become document copy, including persisted legacy failed core results', async () => {
  const { resultOf, documentsFor, failureOf } = await projection;
  const failed = entry([], { presentation: 'document' }, { job: { status: 'failed', result: '', error: '理解请求失败：无法连接 AI 服务' }, message: { error: true, content: 'fetch failed' } });
  failed.work.status = 'failed'; failed.work.result = 'fetch failed';
  assert.equal(resultOf(failed), ''); assert.deepEqual(documentsFor(failed), []); assert.equal(failureOf(failed), failed.job.error);
  delete failed.job;
  assert.equal(resultOf(failed), ''); assert.equal(failureOf(failed), 'fetch failed');
  failed.job = { status: 'failed', result: '上次已经验收的真实文章', error: '无法连接 AI 服务' };
  assert.equal(resultOf(failed), failed.job.result); assert.equal(documentsFor(failed)[0].title, '上次成功结果');
  failed.work.receipts = [receipt('read_text', { path: 'D:\\samples.md', text: '文件中的实际草稿' })];
  assert.equal(documentsFor(failed)[0].content, '文件中的实际草稿');
  failed.work.status = 'checked_by_desktop'; failed.work.result = '文章里讲述 fetch failed 的原因'; delete failed.job; delete failed.message;
  assert.equal(resultOf(failed), failed.work.result, 'do not filter legitimate content by an error keyword');
});
test('task lifecycle distinguishes pause, recovery, cancellation and completed manual records', async () => {
  const { workPhase } = await projection;
  assert.equal(workPhase(entry([], {}, { record: { status: 'done' }, work: undefined })), 'result');
  assert.equal(workPhase(entry([], {}, { record: { status: 'paused' }, work: undefined })), 'paused');
  for (const [status, phase] of [['paused','paused'],['interrupted','review'],['cancelled','stopped'],['unverified','review'],['waiting','waiting']]) {
    const item = entry([], {}, { job: { status, result: '上次成功结果' } });
    assert.equal(workPhase(item), phase, 'a checked core receipt does not override job ' + status);
  }
});
test('a persisted job retains one stable entry while its core work and session receipts arrive', async () => {
  const { collectWork } = await model;
  const work = entry([receipt('read_text',{path:'D:\\report.md',text:'已核对正文'})]).work;
  const job = { id:'job-1', title:'生成经营报告', goal:'统计销售额并生成经营报告', status:'running', log:[], updatedAt:'2026-10-11', workId:work.id, workRevision:1, session:'session-1' };
  const workspace = { sessions:[{ id:'session-1',title:job.title,updated:job.updatedAt,messages:[{id:'reply-1',role:'assistant',coreWorkId:work.id,steps:[{label:'读取',status:'ok'}]}]}],tasks:[] };
  const first = collectWork(workspace, { works:[] }, [job]);
  assert.deepEqual(first.map(item=>item.id), ['job:job-1']);
  const enriched = collectWork(workspace, { works:[work] }, [job]);
  assert.deepEqual(enriched.map(item=>item.id), ['job:job-1']);
  assert.equal(enriched[0].work.id,work.id);
  assert.equal(enriched[0].work.receipts[0].id,'read_text');
  job.workRevision=2;
  const revised = collectWork(workspace, { works:[work] }, [job]);
  assert.deepEqual(revised.map(item=>item.id), ['job:job-1']);
  assert.equal(revised[0].work,undefined,'old core revisions cannot supply evidence to changed task requirements');
});
test('current action keeps persisted plans and waiting reasons visible without claiming verification', async () => {
  const { currentAction, planFor } = await projection;
  const item = entry([], {}, { work:undefined, job:{status:'running',plan:[{text:'读取销售表',status:'done'},{text:'生成经营报告',status:'doing'}],notes:'不能作为正文'} });
  assert.equal(planFor(item).length,2);assert.equal(currentAction(item),'生成经营报告');
  item.job.status='waiting';item.job.approval={title:'允许写入报告目录'};
  assert.equal(currentAction(item),'允许写入报告目录');
  item.job.status='interrupted';item.job.error='宿主退出，需要检查已写入文件';
  assert.equal(currentAction(item),item.job.error);
});
test('node proof, dependencies and uncertain live actions retain their distinct meanings', async () => {
  const { currentAction, planFor, workPhase } = await projection;
  const item = entry([],{}, {work:undefined,job:{status:'running',plan:[{id:'read',text:'读取资料',status:'done'},{id:'report',text:'生成报告',status:'done',depends_on:['read'],runtime_status:'done',verification:{passed:true}}],currentAction:{operation:'write_text',label:'写入经营报告',status:'running'}}});
  assert.equal(planFor(item)[0].status,'done','a model-reported done does not become verified');
  assert.equal(planFor(item)[1].status,'verified');
  assert.deepEqual(planFor(item)[1].dependencies,['read']);
  assert.equal(currentAction(item),'写入经营报告');
  item.job.currentAction={status:'unknown',error:'文件写入回执缺失，需要核对'};
  assert.equal(workPhase(item),'review');assert.equal(currentAction(item),item.job.currentAction.error);
});
test('workspace headings prefer natural task intent and never promote an input path to the title', async () => {
  const { workTitle } = await projection;
  const item=entry([], {kind:'经营报告'}, {title:'读取 C:\\Users\\Owner\\AppData\\source.csv 并生成报告'});
  assert.equal(workTitle(item),'经营报告');
  item.work.cognition.intent={};
  assert.equal(workTitle(item),'文档与写作');
  item.work.receipts=[receipt('write_text',{path:'D:\\reports\\经营报告.md'})];
  assert.equal(workTitle(item),'经营报告.md');
});
test('receipt detail enriches only the same current core receipt and cannot survive revision or status changes', async () => {
  const { receiptsFor } = await projection;
  const full=receipt('read_text',{path:'D:\\draft.md',text:'x'.repeat(1400)});
  const clipped=structuredClone(full);clipped.evidence.observation=clipped.evidence.observation.slice(0,800);
  const item=entry([clipped],{}, {message:{taskEvidence:{workId:'work-1',revision:1,receipts:[full]}}});
  assert.equal(receiptsFor(item)[0].evidence.observation,full.evidence.observation);
  item.work.cognition.revision=2;assert.equal(receiptsFor(item)[0].evidence.observation,clipped.evidence.observation);
  item.work.cognition.revision=1;full.status='failed';assert.equal(receiptsFor(item)[0].status,'observed_success');
});
test('document comparison needs two actual successful reads of the same file', async () => {
  const { documentsFor } = await projection;
  const item=entry([receipt('read_text',{path:'D:\\draft.md',text:'周五交付'},'before'),receipt('read_text',{path:'D:\\draft.md',text:'周四交付'},'after'),{...receipt('read_text',{path:'D:\\draft.md',text:'虚构正文'},'failed'),status:'failed'}]);
  const document=documentsFor(item)[0];assert.equal(document.content,'周四交付');assert.equal(document.previous,'周五交付');
  assert.equal(documentsFor(entry([],{}, {work:undefined,message:{content:'草稿'}}))[0].source,'助手提交的内容');
});
test('CSV quoting, incomplete previews, and Markdown tables retain real rows without repairing invented cells', async () => {
  const { parseDelimited, markdownTables, numberValue, numericColumns, tablesFor } = await projection;
  assert.deepEqual(parseDelimited('名称,销售额\r\n"华东,一区","1,200"\r\n华南,-20',','),{columns:['名称','销售额'],rows:[['华东,一区','1,200'],['华南','-20']]});
  assert.equal(parseDelimited('名称,数量\nA,2\nB,"未结束',','),null);
  assert.deepEqual(parseDelimited('名称,数量\nA,2\nB,"未结束',',',true).rows,[['A','2']]);
  assert.equal(markdownTables('```txt\n|a|b|\n|---|---|\n|1|2|\n```').length,0);
  assert.deepEqual(markdownTables('|地区|销量|\n|---|---:|\n|华东|20|')[0].rows,[['华东','20']]);
  assert.equal(numberValue('￥1,200'),1200);assert.equal(numberValue('12万元'),null);assert.equal(numberValue('2026-10-05'),null);
  assert.deepEqual(numericColumns({columns:['名字','数量'],rows:[['A','12'],['B','20%']]}),[]);
  const item=entry([receipt('read_text',{path:'D:\\data.csv',text:'名称,数量\nA,2\nB,3\nC,4',_preview_truncated:true})]);
  assert.equal(tablesFor(item)[0].partial,true);assert.deepEqual(tablesFor(item)[0].rows,[['A','2'],['B','3']]);
});
test('sources distinguish search, fetched pages and model citations; failed or unsafe links cannot claim an opened source', async () => {
  const { sourcesFor } = await projection;
  const item=entry([receipt('web_search',{results:[{title:'线索',url:'https://example.com/a'},{title:'坏链接',url:'javascript:alert(1)'}]}),receipt('fetch_url',{title:'原文',url:'https://example.com/a',text:'实际内容'}),{...receipt('fetch_url',{url:'https://example.com/failed'}),status:'failed'}]);
  item.work.result='[回答引用](https://example.com/b)';const sources=sourcesFor(item);
  assert.equal(sources.length,2);assert.equal(sources[0].read,true);assert.equal(sources[1].read,false);assert.equal(sources[1].from,'回答中的引用');
});
test('file view does not turn a requested path into an observed file and retains a real write followed by read-back', async () => {
  const { filesFor } = await projection;
  assert.deepEqual(filesFor(entry([], {deliverable:'D:\\missing.txt'})),[]);
  const files=filesFor(entry([receipt('write_text',{path:'D:\\a.txt',bytes:20}),receipt('read_text',{path:'D:\\a.txt',text:'实际内容',size:20})]));
  assert.equal(files.length,1);assert.equal(files[0].action,'已写入 · 已读取');assert.equal(files[0].content,'实际内容');
});
test('large observations remain valid bounded JSON with explicit truncation and without secret/image data', () => {
  const value={ok:true,path:'D:\\large.csv',text:'名称,数量\n'.repeat(1000),token:'private-secret',images:['raw-image'],results:Array.from({length:100},(_,i)=>({title:'题目'.repeat(200),url:'https://example.com/'+i}))};
  const serialized=summarizeObservation(value);assert.ok(serialized.length<=3500);const parsed=JSON.parse(serialized);assert.equal(parsed._preview_truncated,true);assert.equal(parsed.path,value.path);assert.equal(parsed.token,'[omitted]');assert.equal(parsed.images,'[omitted]');assert.ok(!serialized.includes('private-secret'));
});
