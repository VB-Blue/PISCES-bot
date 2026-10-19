const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const inside = (file, root) => { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };

async function snapshotHandle(file, handle, prefix = Buffer.alloc(0), before = null) {
  before ||= await handle.stat();
  const actual = await fs.realpath(file);
  if (before.size > MAX_HASH_BYTES) return { schema: 1, path: path.resolve(file), realPath: actual, size: before.size, complete: false };
  const hash = createHash('sha256'); hash.update(prefix);
  let position = prefix.length;
  const buffer = Buffer.alloc(64 * 1024);
  while (position < before.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  const after = await handle.stat();
  if (position !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Object.assign(new Error('读取期间文件发生变化，请重新观察：' + file), { code: 'FILE_CHANGED_DURING_READ' });
  return { schema: 1, path: path.resolve(file), realPath: actual, size: after.size, sha256: hash.digest('hex'), complete: true };
}
async function snapshotFile(file, roots) {
  if (!path.isAbsolute(file) || !roots.some(root => inside(file, root))) throw new Error('文件已不在任务可读取的目录内：' + file);
  const actual = await fs.realpath(file), realRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => path.resolve(root))));
  if (!realRoots.some(root => inside(actual, root))) throw new Error('文件实际位置超出已授权目录：' + file);
  const handle = await fs.open(file, 'r');
  try { if (!(await handle.stat()).isFile()) throw new Error('来源不再是文件'); return await snapshotHandle(file, handle); }
  finally { await handle.close(); }
}
async function compareFiles(states, roots) {
  const changed = [];
  for (const previous of states || []) {
    try {
      const current = await snapshotFile(previous.path, roots);
      if (previous.complete !== true || current.complete !== true) changed.push({ path: previous.path, reason: '文件过大，无法完整核对内容，请重新规划并检查来源', before: previous.sha256 || null, after: current.sha256 || null });
      else if (previous.sha256 !== current.sha256 || previous.size !== current.size || previous.realPath !== current.realPath) changed.push({ path: previous.path, reason: '文件内容或实际位置发生变化', before: previous.sha256, after: current.sha256 });
    } catch (error) { changed.push({ path: previous.path, reason: error.message }); }
  }
  return changed;
}
module.exports = { snapshotHandle, snapshotFile, compareFiles, MAX_HASH_BYTES };
