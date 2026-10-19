const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
function evidencePointer(result) {
  const value = result?.evidence;
  return value?.source === 'browser' && typeof value.receipt_path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 || '') ? { source: 'browser', receipt_path: value.receipt_path, sha256: value.sha256 } : null;
}
async function readBrowserEvidence(pointer) {
  if (pointer?.source !== 'browser' || typeof pointer.receipt_path !== 'string' || !/^[a-f0-9]{64}$/.test(pointer.sha256 || '')) return null;
  try {
    const info = await fs.stat(pointer.receipt_path); if (!info.isFile() || info.size > 1024 * 1024) return null;
    const bytes = await fs.readFile(pointer.receipt_path); if (createHash('sha256').update(bytes).digest('hex') !== pointer.sha256) return null;
    const value = JSON.parse(bytes); if (value.schema !== 1 || value.source !== 'browser' || typeof value.text !== 'string' || typeof value.documentId !== 'string') return null;
    return value;
  } catch { return null; }
}
module.exports = { evidencePointer, readBrowserEvidence };
