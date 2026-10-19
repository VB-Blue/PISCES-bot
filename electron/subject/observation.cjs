// A bounded, valid JSON projection of a host result. The executor still receives the full result.
function summarizeObservation(value, limit = 3500) {
  // File paths and request IDs are evidence pointers, not prose previews. Cutting
  // a Windows path to 60 characters makes the original receipt impossible to find.
  const evidenceKeys = ['source', 'connector_id', 'connector', 'tool', 'request_id', 'receipt_path', 'sha256', 'work_id', 'late'];
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const evidence = {};
  for (const key of evidenceKeys) if (typeof source.evidence?.[key] === 'string' || typeof source.evidence?.[key] === 'boolean') evidence[key] = source.evidence[key];
  const artifacts = (Array.isArray(source.artifacts) ? source.artifacts : []).filter(item => item && typeof item.path === 'string').slice(0, 8).map(item => ({ path: item.path, ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}), ...(typeof item.kind === 'string' ? { kind: item.kind } : {}) }));
  const anchors = {
    ...(typeof source.path === 'string' ? { path: source.path } : {}),
    ...(Object.keys(evidence).length ? { evidence } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  };
  for (const stringLimit of [1800, 800, 240, 60]) {
    let partial = false;
    const visit = (item, depth) => {
      if (typeof item === 'string') { if (item.length > stringLimit) partial = true; return item.slice(0, stringLimit); }
      if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
      if (depth > 5) { partial = true; return '[preview omitted]'; }
      if (Array.isArray(item)) { if (item.length > 16) partial = true; return item.slice(0, 16).map(child => visit(child, depth + 1)); }
      if (item && typeof item === 'object') {
        const result = {}; const entries = Object.entries(item); if (entries.length > 30) partial = true;
        for (const [key, child] of entries.slice(0, 30)) {
          if (/^(image|images|apiKey|password|token|authorization)$/i.test(key)) { result[key] = '[omitted]'; continue; }
          result[key] = visit(child, depth + 1);
        }
        return result;
      }
      return null;
    };
    const output = visit(value, 0);
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      if (anchors.path) output.path = anchors.path;
      if (anchors.evidence) output.evidence = { ...(output.evidence && typeof output.evidence === 'object' ? output.evidence : {}), ...anchors.evidence };
      if (anchors.artifacts) output.artifacts = anchors.artifacts;
    }
    if (partial && output && typeof output === 'object' && !Array.isArray(output)) output._preview_truncated = true;
    const encoded = JSON.stringify(output);
    if (encoded.length <= limit) return encoded;
  }
  const minimal = { _preview_truncated: true, ...(typeof source.ok === 'boolean' ? { ok: source.ok } : {}), ...(typeof source.execution_status === 'string' ? { execution_status: source.execution_status } : {}), ...(typeof source.satisfied === 'boolean' ? { satisfied: source.satisfied } : {}), ...anchors };
  for (const keep of [8, 4, 2, 1, 0]) {
    const output = { ...minimal, ...(artifacts.length ? { artifacts: artifacts.slice(0, keep), ...(keep < artifacts.length ? { _artifact_preview_omitted: artifacts.length - keep } : {}) } : {}) };
    const encoded = JSON.stringify(output);
    if (encoded.length <= limit) return encoded;
  }
  // Preserve the full connector receipt path even when the artifact list itself cannot fit.
  const pointer = { _preview_truncated: true, ...(anchors.evidence ? { evidence: anchors.evidence } : {}), ...(typeof source.ok === 'boolean' ? { ok: source.ok } : {}), ...(typeof source.execution_status === 'string' ? { execution_status: source.execution_status } : {}) };
  if (JSON.stringify(pointer).length <= limit) return JSON.stringify(pointer);
  return JSON.stringify({ _preview_truncated: true, _evidence_pointer_omitted: true, note: '观察过大，证据指针也超出保存上限；需要重新读取完整回执。' });
}
module.exports = { summarizeObservation };
