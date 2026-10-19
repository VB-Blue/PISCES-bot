// Keep transport diagnostics useful without persisting URLs, credentials or request bodies.
const { setTimeout: delay } = require('node:timers/promises');
const MODEL_TRANSPORT_CODES = new Set(['MODEL_CONNECTION_FAILED', 'MODEL_REQUEST_TIMEOUT', 'MODEL_STREAM_INTERRUPTED']);
const NETWORK_CODE = /^(?:E(?:CONN[A-Z_]*|NET[A-Z_]*|HOST[A-Z_]*|PIPE|AI_AGAIN|NOTFOUND|TIMEDOUT)|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_[A-Z_]+)$/;
function causeCode(error, seen = new Set()) {
  if (!error || seen.has(error)) return '';
  seen.add(error);
  if (NETWORK_CODE.test(String(error.code || ''))) return String(error.code);
  return causeCode(error.cause, seen) || (Array.isArray(error.errors) ? error.errors.map(item => causeCode(item, seen)).find(Boolean) : '') || '';
}
function normalizeModelError(error, { endpoint, phase = 'connect', signal, callerSignal } = {}) {
  if ((callerSignal?.aborted && callerSignal.reason?.name !== 'TimeoutError') || MODEL_TRANSPORT_CODES.has(error?.code)) return error;
  const code = causeCode(error);
  const timeout = error?.name === 'TimeoutError' || (signal?.aborted && signal.reason?.name === 'TimeoutError') || /TIME(?:D?OUT)|TIMEDOUT/.test(code);
  const interrupted = /AI 回复未完成/.test(String(error?.message));
  if (!timeout && !interrupted && !code && !/^(?:fetch failed|terminated)$/i.test(String(error?.message))) return error;
  let endpointHost = '';
  try { endpointHost = new URL(endpoint).hostname; } catch {}
  const kind = timeout ? 'MODEL_REQUEST_TIMEOUT' : interrupted || phase === 'response' ? 'MODEL_STREAM_INTERRUPTED' : 'MODEL_CONNECTION_FAILED';
  const label = timeout ? 'AI 服务请求超时' : kind === 'MODEL_STREAM_INTERRUPTED' ? 'AI 服务回复中断' : '无法连接 AI 服务';
  return Object.assign(new Error(label + (code || endpointHost ? '（' + [code, endpointHost].filter(Boolean).join(' · ') + '）' : '') + '，请稍后重试。', { cause: error }), {
    name: timeout ? 'TimeoutError' : 'Error', code: kind, causeCode: code, endpointHost, phase, recoverable: true,
  });
}
function retrySameService(error) {
  if (!error || error.name === 'AbortError' || error.automatic_retry === false) return false;
  return MODEL_TRANSPORT_CODES.has(error.code) || error.name === 'TypeError' || error.name === 'TimeoutError'
    || !!causeCode(error) || /HTTP (?:408|425|429|5\d\d)|AI 回复未完成/.test(String(error.message));
}
async function waitForRetry(ms, signal) { await delay(Math.max(0, ms), undefined, { signal }); }
function failureDetails(error) {
  return Object.fromEntries(['code', 'causeCode', 'endpointHost', 'phase'].filter(key => typeof error?.[key] === 'string' && error[key]).map(key => [key, error[key].slice(0, 180)]));
}
module.exports = { MODEL_TRANSPORT_CODES, normalizeModelError, retrySameService, waitForRetry, causeCode, failureDetails };
