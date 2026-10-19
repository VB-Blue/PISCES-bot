// Checkpoints: before the assistant changes a file, the previous content is kept so any change can be undone.
// A rollback refuses to clobber work done since: it only proceeds if the file is still exactly what the assistant left.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_RECORDS = 300;
const MAX_SNAPSHOT_BYTES = 20_000_000;
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function createCheckpoints(dir) {
  const indexFile = path.join(dir, 'index.json');
  let records = null;
  let writing = Promise.resolve();

  async function load() {
    if (records) return records;
    try { records = JSON.parse(await fs.readFile(indexFile, 'utf8')); } catch { records = []; }
    return records;
  }
  const save = () => { writing = writing.then(async () => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(indexFile + '.tmp', JSON.stringify(records), 'utf8'); await fs.rename(indexFile + '.tmp', indexFile); }).catch(() => {}); return writing; };

  // Call BEFORE writing `target`. Returns a handle: call done() after the write so the final hash is recorded.
  async function begin({ target, action, by = '', summary = '' }) {
    await load();
    const id = crypto.randomUUID();
    let before = null;
    try {
      const info = await fs.stat(target);
      if (info.isFile()) {
        if (info.size > MAX_SNAPSHOT_BYTES) throw new Error('文件过大（超过 20 MB），无法保留还原点：' + target);
        before = await fs.readFile(target);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, id + '.bak'), before); }
    const record = { id, path: target, action, by, summary, ts: new Date().toISOString(), existed: !!before, beforeHash: before ? sha(before) : null, afterHash: null, status: 'active' };
    return {
      id,
      async done() {
        try { record.afterHash = sha(await fs.readFile(target)); } catch { record.afterHash = null; }
        records.unshift(record);
        // Drop the oldest snapshots so the store stays bounded.
        for (const old of records.splice(MAX_RECORDS)) await fs.rm(path.join(dir, old.id + '.bak'), { force: true });
        await save();
        return record;
      },
      async abandon() { await fs.rm(path.join(dir, id + '.bak'), { force: true }); },
    };
  }

  async function list() { return (await load()).map(({ id, path: file, action, by, summary, ts, existed, status }) => ({ id, path: file, action, by, summary, ts, existed, status })); }

  async function revert(id) {
    await load();
    const record = records.find(item => item.id === id);
    if (!record) throw new Error('找不到这条改动记录');
    if (record.status !== 'active') throw new Error('这条改动已经撤销过了');
    let current = null;
    try { current = await fs.readFile(record.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const currentHash = current ? sha(current) : null;
    if (currentHash !== record.afterHash) throw new Error('文件在这次改动之后又被修改过，为避免覆盖你的内容，没有撤销：' + record.path);
    if (record.existed) await fs.writeFile(record.path, await fs.readFile(path.join(dir, record.id + '.bak')));
    else await fs.rm(record.path, { force: true });
    record.status = 'reverted';
    await save();
    return { id, path: record.path, restored: record.existed ? '已恢复为改动前的内容' : '已删除这次新建的文件' };
  }

  return { begin, list, revert, flush: () => writing };
}

module.exports = { createCheckpoints };
