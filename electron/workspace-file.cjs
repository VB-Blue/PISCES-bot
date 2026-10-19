// The conversation list lives in a file owned by the main process, not in the page's localStorage:
// localStorage has a quota, flushes lazily, and is lost if the process is killed. This file is written atomically,
// keeps the previous good copy as a backup, and is read back (falling back to the backup) at startup.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_BYTES = 40_000_000;

function createWorkspaceFile(dir, { asyncFS = fsp } = {}) {
  const file = path.join(dir, 'workspace.json');
  const backup = file + '.bak';
  let pending = null;
  let latest = null;
  let revision = 0;
  let committed = 0;
  let chain = Promise.resolve();

  const valid = text => {
    if (typeof text !== 'string' || !text.startsWith('{') || Buffer.byteLength(text) > MAX_BYTES) return false;
    try { const value = JSON.parse(text); return value && value.version === 1 && Array.isArray(value.sessions); } catch { return false; }
  };

  // The most recent readable copy: the file, else the backup, else null (caller may migrate older storage).
  function load() {
    for (const candidate of [file, backup]) {
      try { const text = fs.readFileSync(candidate, 'utf8'); if (valid(text)) return text; } catch { /* missing or unreadable: try the next */ }
    }
    return null;
  }

  const temporary = (next, mode) => file + '.' + process.pid + '.' + next.revision + '.' + mode + '.tmp';
  function commit(next, temp, backupTemp) {
    // Both renames run on the main thread. A closing-page sync save cannot interleave between
    // this revision check and the commit, or be overwritten later by an older async rename.
    if (next.revision !== revision || next.revision <= committed) return false;
    if (backupTemp) fs.renameSync(backupTemp, backup);
    fs.renameSync(temp, file);
    committed = next.revision;
    if (latest?.revision === committed) latest = null;
    return true;
  }

  function writeSnapshotSync(next) {
    const temp = temporary(next, 'sync'), backupTemp = temporary(next, 'sync-backup');
    try {
      fs.mkdirSync(dir, { recursive: true });
      let previous;
      try { const current = fs.readFileSync(file, 'utf8'); if (valid(current)) previous = current; } catch { /* first write */ }
      if (previous !== undefined) fs.writeFileSync(backupTemp, previous, 'utf8');
      fs.writeFileSync(temp, next.text, 'utf8');
      commit(next, temp, previous !== undefined ? backupTemp : null);
    } finally {
      for (const candidate of [temp, backupTemp]) { try { fs.unlinkSync(candidate); } catch { /* committed or not created */ } }
    }
  }

  function writeSync(text) {
    if (!valid(text)) throw new Error('对话数据格式无效，未保存');
    const next = { text, revision: ++revision };
    latest = next; pending = null;
    writeSnapshotSync(next);
  }

  // Coalesced background write: only the newest pending snapshot is written.
  function save(text) {
    if (!valid(text)) return chain;
    latest = pending = { text, revision: ++revision };
    chain = chain.then(async () => {
      const next = pending; pending = null;
      if (next == null || next.revision <= committed) return;
      const temp = temporary(next, 'async'), backupTemp = temporary(next, 'async-backup');
      try {
        await asyncFS.mkdir(dir, { recursive: true });
        let previous;
        try { const current = await asyncFS.readFile(file, 'utf8'); if (valid(current)) previous = current; } catch { /* first write */ }
        if (previous !== undefined) await asyncFS.writeFile(backupTemp, previous, 'utf8');
        await asyncFS.writeFile(temp, next.text, 'utf8');
        commit(next, temp, previous !== undefined ? backupTemp : null);
      } catch (error) { console.warn('对话记录写入失败：' + error.message); }
      finally {
        for (const candidate of [temp, backupTemp]) await asyncFS.unlink(candidate).catch(() => {});
      }
    });
    return chain;
  }

  // Write anything still queued, synchronously (used while quitting, when async work may not get to finish).
  function flushSync() {
    // latest includes a snapshot already taken by an async writer, with pending now empty.
    if (latest == null || latest.revision <= committed) return;
    const next = latest; pending = null;
    try { writeSnapshotSync(next); } catch (error) { console.warn('对话记录写入失败：' + error.message); }
  }

  return { load, save, writeSync, flushSync, whenIdle: () => chain, file };
}

module.exports = { createWorkspaceFile, MAX_BYTES };
