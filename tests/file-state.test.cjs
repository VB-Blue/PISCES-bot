const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {snapshotHandle,snapshotFile,compareFiles}=require('../electron/file-state.cjs');
const directory=()=>fs.mkdtemp(path.join(os.tmpdir(),'file-state-'));

test('a file content change is detected even when its size and timestamp are preserved',async()=>{
  const dir=await directory(),file=path.join(dir,'source.csv');await fs.writeFile(file,'count\n12\n');
  const before=await snapshotFile(file,[dir]),info=await fs.stat(file);
  await fs.writeFile(file,'count\n17\n');await fs.utimes(file,info.atime,info.mtime);
  assert.equal((await fs.stat(file)).size,info.size);
  const changed=await compareFiles([before],[dir]);assert.equal(changed.length,1);assert.notEqual(changed[0].before,changed[0].after);
});
test('the content fingerprint includes the bytes returned to the reader and all remaining file bytes',async()=>{
  const dir=await directory(),file=path.join(dir,'source.txt'),content='real prefix\n'+'remaining source\n'.repeat(10000);await fs.writeFile(file,content);
  const handle=await fs.open(file,'r');
  try{const prefix=Buffer.alloc(12);await handle.read(prefix,0,prefix.length,0);const state=await snapshotHandle(file,handle,prefix);assert.equal(state.sha256,createHash('sha256').update(content).digest('hex'));assert.equal(state.complete,true);}finally{await handle.close();}
});
test('a missing file or revoked directory cannot be treated as a reusable source',async()=>{
  const dir=await directory(),file=path.join(dir,'source.txt');await fs.writeFile(file,'source');const state=await snapshotFile(file,[dir]);
  assert.equal((await compareFiles([state],[])).length,1);await fs.unlink(file);assert.equal((await compareFiles([state],[dir])).length,1);
});
test('file verification follows real paths and refuses a junction escaping authorized roots',async()=>{
  const dir=await directory(),allowed=path.join(dir,'allowed'),outside=path.join(dir,'outside');await fs.mkdir(allowed);await fs.mkdir(outside);await fs.writeFile(path.join(outside,'source.txt'),'outside data');
  await fs.symlink(outside,path.join(allowed,'link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(snapshotFile(path.join(allowed,'link/source.txt'),[allowed]),/实际位置超出/);
});
