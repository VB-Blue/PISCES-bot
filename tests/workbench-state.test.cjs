const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/workbenchState.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace("'./workPresentation.ts'", JSON.stringify(pathToFileURL(path.join(__dirname, '../src/workPresentation.ts')).href));
const state = import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const entry = (id, status, title = id) => ({ id, title, summary:'', time:'2026-10-05', ongoing:status==='running', work:{status,receipts:[],result:'',cognition:{intent:{}}} });

test('work filters retain failed and uncertain tasks and do not infer completion from a reply', async () => {
  const { filterWork, groupedWork } = await state;
  const items = [entry('ongoing','running'),entry('unknown','result_unknown'),entry('failed','failed'),entry('done','checked_by_desktop'),entry('waiting','waiting')];
  assert.deepEqual(filterWork(items,'attention','').map(item=>item.id),['unknown','failed','waiting']);
  assert.deepEqual(filterWork(items,'finished','').map(item=>item.id),['done']);
  assert.deepEqual(filterWork(items,'active','ONGO').map(item=>item.id),['ongoing']);
  assert.equal(filterWork(items,'all','missing').length,0);
  assert.equal(groupedWork(items).flatMap(group=>group.items).length,items.length);
});
test('paused and interrupted work stay findable and only terminal cancellation joins ended tasks', async () => {
  const { filterWork, groupedWork } = await state;
  const items=[entry('paused','paused'),entry('recovery','interrupted'),entry('cancelled','cancelled'),entry('verify','unverified')];
  assert.deepEqual(filterWork(items,'attention','').map(item=>item.id),['recovery','verify']);
  assert.deepEqual(filterWork(items,'finished','').map(item=>item.id),['cancelled']);
  assert.deepEqual(groupedWork(items).find(group=>group.label==='已暂停').items.map(item=>item.id),['paused']);
  assert.equal(groupedWork(items).flatMap(group=>group.items).length,items.length);
});
test('task drafts and view preferences are bounded, independently keyed, and round-trip without canonical task data', async () => {
  const { normalizeWorkbench } = await state;
  const value = {drafts:{a:'周报',b:'数据'},views:{a:'document',b:'data',c:'<script>bad()</script>'},selected:'a',inspector:true,canonicalWork:{status:'finished'}};
  const restored=normalizeWorkbench(JSON.parse(JSON.stringify(normalizeWorkbench(value))));
  assert.equal(restored.drafts.a,'周报');assert.equal(restored.drafts.b,'数据');assert.equal(restored.views.c,undefined);assert.equal(restored.canonicalWork,undefined);
  const oversized=normalizeWorkbench({drafts:Object.fromEntries(Array.from({length:110},(_,i)=>['task'+i,'x'.repeat(16001)]))});
  assert.equal(Object.keys(oversized.drafts).length,100);assert.equal(Object.values(oversized.drafts)[0].length,16000);
});
test('document changes preserve exact before and after text, repeated lines, CRLF, and an explicit large-file boundary', async () => {
  const { documentDiff } = await state;
  const before='标题\r\n周五\r\n重复\r\n重复',after='标题\n周四\n重复\n新增\n重复';
  const diff=documentDiff(before,after);
  assert.equal(diff.lines.filter(line=>line.before!==undefined).map(line=>line.before).join('\n'),before.replace(/\r\n/g,'\n'));
  assert.equal(diff.lines.filter(line=>line.after!==undefined).map(line=>line.after).join('\n'),after);
  assert.ok(diff.lines.some(line=>line.change==='removed'&&line.before==='周五'));
  assert.ok(diff.lines.some(line=>line.change==='added'&&line.after==='周四'));
  assert.equal(documentDiff('a\n'.repeat(400),'b\n'.repeat(400)).partial,true);
});
