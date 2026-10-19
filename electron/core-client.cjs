const { validateEndpoint } = require('./policy.cjs');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const userId = 'desktop-owner';

function validateTurn(value, identity = userId) {
  if (!value || !uuid.test(value.id) || !uuid.test(value.session)) throw new Error('核心对话标识无效');
  if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 32000) throw new Error('核心消息为空或超过 32000 字符');
  if (value.desktop && (typeof value.desktop.instruction !== 'string' || !value.desktop.instruction.trim() || value.desktop.instruction.length > 4000 || typeof value.desktop.execute !== 'boolean')) throw new Error('桌面任务格式无效');
  if (typeof identity !== 'string' || !identity.trim() || identity.length > 256) throw new Error('主体用户身份无效');
  return { turn_id: value.id, session: value.session, user_id: identity, message: value.message,
    ...(value.desktop ? { desktop: { instruction: value.desktop.instruction, execute: value.desktop.execute } } : {}) };
}

async function coreRequest(settings, token, route, { body, signal } = {}) {
  const base = validateEndpoint(settings.coreUrl, { localOnly: true });
  const response = await fetch(base + route, {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: signal || AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    // The core explains rejections as {"ok":false,"error":"<code>"}; keep the code so failures are diagnosable.
    let reason = '';
    try { reason = String(JSON.parse((await response.text()).slice(0, 4000)).error || '').slice(0, 300); } catch { /* Body is optional. */ }
    throw new Error('核心返回 HTTP ' + response.status + (response.status === 401 || response.status === 403 ? '，请检查核心访问令牌' : '') + (reason ? '（' + reason + '）' : ''));
  }
  // Core responses include bounded histories; never buffer an unbounded response.
  let text = '';
  // Legacy production health includes a large snapshot. It is reduced in the
  // main process before crossing IPC; chat/history keep the tighter bound.
  const limit = route === '/api/v1/health' ? 16_000_000 : 4_000_000;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > limit) throw new Error('核心响应超过大小限制');
  }
  text += decoder.decode();
  const data = JSON.parse(text);
  if (data.ok === false) throw new Error('核心未接受请求：' + String(data.error || 'unknown'));
  return data;
}

function readReceipt(payload, input) {
  const turn = payload?.response;
  if (!payload?.ok || !turn || turn.turn_id !== input.id || turn.session !== input.session || turn.user_id !== (input.user_id || userId) || typeof turn.reply !== 'string') throw new Error('核心回执与当前对话不一致，未调用 AI');
  if (turn.decision_subject !== 'unified_wisdom_subject' || turn.reply_mode !== 'grounded_local_dialogue') throw new Error('核心没有返回本地主体回执，未调用 AI');
  return { turnId: turn.turn_id, session: turn.session, subject: turn.decision_subject, provider: turn.reply_provider,
    reply: turn.reply, mode: turn.reply_mode, evidence: turn.chat_cognitive_summary || null,
    // A receipt proves reception and provenance; it does not verify every factual assertion.
    factualVerification: 'unverified', learned: false,
    desktop: turn.desktop_task || null };
}

function aiContext(receipt) {
  // Do not serialize the subject's full memory, health snapshot, or unrelated sessions to a provider.
  return JSON.stringify({ kind: 'local_core_receipt', turn_id: receipt.turnId,
    local_reply: receipt.reply.slice(0, 8000), evidence: JSON.stringify(receipt.evidence).slice(0, 12000),
    factual_verification: 'unverified', tool_execution: 'none', learned_method: false });
}
module.exports = { coreRequest, validateTurn, readReceipt, aiContext, userId, uuid };
