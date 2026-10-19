const path = require('node:path');

// Only persisted successful receipts may supply task file actions. No paths from assistant prose.
function resolveWorkFile(work, receiptId, file, { artifactRoot = '' } = {}) {
  if (!work || typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('交付文件标识无效');
  const receipt = (work.receipts || []).find(item => item.id === receiptId && ['observed_success', 'verified'].includes(item.status));
  if (!receipt) throw new Error('这个文件没有已保存的成功操作证据');
  let observed = receipt.evidence?.observation;
  if (typeof observed === 'string') { try { observed = JSON.parse(observed); } catch { throw new Error('文件操作证据不完整，请重新读取'); } }
  const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!observed || observed.ok === false) throw new Error('这条操作没有提供可打开的文件');
  if (receipt.operation.startsWith('mcp_') && observed.evidence?.source === 'mcp' && path.isAbsolute(artifactRoot)) {
    const inside = value => { const relative = path.relative(artifactRoot, value); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
    const artifact = (observed.artifacts || []).find(item => typeof item.path === 'string' && path.isAbsolute(item.path) && key(item.path) === key(file));
    if (artifact && inside(artifact.path) && typeof observed.evidence.receipt_path === 'string' && inside(observed.evidence.receipt_path)) return artifact.path;
    throw new Error('连接器产物路径与已保存的回执不一致');
  }
  if (!['write_text', 'write_document', 'edit_text', 'edit_image', 'read_text'].includes(receipt.operation)) throw new Error('这条操作没有提供可打开的文件');
  const recorded = observed.path;
  if (typeof recorded !== 'string' || !path.isAbsolute(recorded) || key(recorded) !== key(file)) throw new Error('文件路径与核心操作证据不一致');
  return recorded;
}
module.exports = { resolveWorkFile };
