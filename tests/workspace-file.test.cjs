const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceFile } = require('../electron/workspace-file.cjs');

const snapshot = title => JSON.stringify({ version: 1, sessions: [{ id: 's', title, messages: [] }], traces: [] });
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
const fsp = require('node:fs/promises');

function delayedWrite() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let held = false;
  return { entered, release, asyncFS: { ...fsp, async writeFile(...args) {
    if (!held) { held = true; enter(); await gate; }
    return fsp.writeFile(...args);
  } } };
}

test('conversations written by one run are read back by the next', async () => {
  const dir = dirOf();
  const first = createWorkspaceFile(dir);
  assert.equal(first.load(), null, 'nothing saved yet');
  await first.save(snapshot('第一次'));
  const second = createWorkspaceFile(dir);
  assert.equal(JSON.parse(second.load()).sessions[0].title, '第一次');
});

test('only the newest queued snapshot is written, and a quit flushes it synchronously', async () => {
  const dir = dirOf();
  const files = createWorkspaceFile(dir);
  void files.save(snapshot('A'));
  void files.save(snapshot('B'));
  const last = files.save(snapshot('C'));
  await last;
  assert.equal(JSON.parse(createWorkspaceFile(dir).load()).sessions[0].title, 'C');
  // A write still queued when the app quits must not be lost.
  const quitting = createWorkspaceFile(dir);
  void quitting.save(snapshot('退出前最后一条'));
  quitting.flushSync();
  assert.equal(JSON.parse(createWorkspaceFile(dir).load()).sessions[0].title, '退出前最后一条');
});

test('a corrupted file falls back to the previous good copy', async () => {
  const dir = dirOf();
  const files = createWorkspaceFile(dir);
  await files.save(snapshot('旧的好数据'));
  await files.save(snapshot('较新的好数据'));
  fs.writeFileSync(files.file, '{"version":1,"sessions":[', 'utf8');
  const restored = createWorkspaceFile(dir).load();
  assert.equal(JSON.parse(restored).sessions[0].title, '旧的好数据');
});

test('invalid data never replaces a good file or its backup', async () => {
  const dir = dirOf();
  const files = createWorkspaceFile(dir);
  await files.save(snapshot('好数据'));
  await files.save('not json');
  await files.save(JSON.stringify({ version: 2, sessions: [] }));
  await files.save('{"version":1}');
  assert.equal(JSON.parse(createWorkspaceFile(dir).load()).sessions[0].title, '好数据');
  assert.throws(() => files.writeSync('oops'), /格式无效/);
  // A corrupt current file is not copied over the backup.
  await files.save(snapshot('第二份'));
  fs.writeFileSync(files.file, 'garbage', 'utf8');
  await files.save(snapshot('第三份'));
  assert.equal(JSON.parse(createWorkspaceFile(dir).load()).sessions[0].title, '第三份');
  assert.equal(JSON.parse(fs.readFileSync(files.file + '.bak', 'utf8')).sessions[0].title, '好数据');
});

test('a closing-page sync save remains newer than an in-flight background write and keeps the last good backup', async () => {
  const dir = dirOf(), delayed = delayedWrite();
  createWorkspaceFile(dir).writeSync(snapshot('已保存'));
  const files = createWorkspaceFile(dir, { asyncFS: delayed.asyncFS });
  const writing = files.save(snapshot('较早的后台数据'));
  await delayed.entered;
  files.writeSync(snapshot('页面关闭时的最新数据'));
  delayed.release(); await writing;
  assert.equal(JSON.parse(createWorkspaceFile(dir).load()).sessions[0].title, '页面关闭时的最新数据');
  assert.equal(JSON.parse(fs.readFileSync(files.file + '.bak', 'utf8')).sessions[0].title, '已保存');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['workspace.json', 'workspace.json.bak']);
});

test('quitting flushes a snapshot already being written, even when the pending queue is empty', async () => {
  const dir = dirOf(), delayed = delayedWrite();
  const files = createWorkspaceFile(dir, { asyncFS: delayed.asyncFS });
  const writing = files.save(snapshot('正在保存的最后一条'));
  await delayed.entered;
  files.flushSync();
  assert.equal(JSON.parse(createWorkspaceFile(dir).load()).sessions[0].title, '正在保存的最后一条');
  delayed.release(); await writing;
  assert.equal(JSON.parse(createWorkspaceFile(dir).load()).sessions[0].title, '正在保存的最后一条');
  assert.deepEqual(fs.readdirSync(dir), ['workspace.json']);
});
