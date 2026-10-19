// One durable ledger for model transports. Stores metadata, never request bodies or service credentials.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const context = new AsyncLocalStorage();
let installed = null;
const limit = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const clean = value => String(value || '').slice(0, 180);
function normalizeUsage(value) {
  const inputTokens = integer(value?.prompt_tokens ?? value?.input_tokens);
  const outputTokens = integer(value?.completion_tokens ?? value?.output_tokens);
  const reported = integer(value?.total_tokens), sum = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  const totalTokens = reported === null ? sum : sum === null ? reported : Math.max(reported, sum);
  return { inputTokens, outputTokens, totalTokens,
    cachedTokens: integer(value?.prompt_tokens_details?.cached_tokens ?? value?.input_tokens_details?.cached_tokens),
    reasoningTokens: integer(value?.completion_tokens_details?.reasoning_tokens ?? value?.output_tokens_details?.reasoning_tokens) };
}

function createUsageLedger({ dir, now = Date.now, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, onChange = () => {} }) {
  const file = path.join(dir, 'model-usage.jsonl');
  const calls = new Map();
  let policy = { dailyTokenLimit: 0, timeZone };
  let persistenceError = '', readFailure = false;
  const dayAt = time => new Intl.DateTimeFormat('en-CA', { timeZone: policy.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
  function apply(event) {
    if (event.type === 'policy') {
      if (!limit(event.policy?.dailyTokenLimit) || typeof event.policy?.timeZone !== 'string') throw new Error('用量策略记录无效');
      new Intl.DateTimeFormat('en-CA', { timeZone: event.policy.timeZone }).format();
      policy = event.policy;
    }
    else if (event.type === 'begin') {
      const call = event.call;
      if (!call || typeof call.id !== 'string' || calls.has(call.id) || typeof call.scopeId !== 'string' || typeof call.runId !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(call.day) || !Number.isSafeInteger(call.reservedTokens) || call.reservedTokens < 0 || call.status !== 'running') throw new Error('模型调用记录无效');
      calls.set(call.id, call);
    }
    else if (event.type === 'settle') {
      const call = calls.get(event.id);
      if (!call) throw new Error('用量记录缺少对应的模型调用');
      if (!event.patch || !['unknown', 'done', 'failed', 'not_sent'].includes(event.patch.status) || !Number.isSafeInteger(event.patch.chargedTokens) || event.patch.chargedTokens < 0) throw new Error('模型结算记录无效');
      Object.assign(call, event.patch);
    } else throw new Error('用量记录类型无效');
  }
  function commit(event) {
    if (readFailure) throw Object.assign(new Error(persistenceError), { code: 'USAGE_PERSISTENCE_FAILED' });
    let descriptor;
    try {
      fs.mkdirSync(dir, { recursive: true });
      descriptor = fs.openSync(file, 'a', 0o600);
      fs.writeSync(descriptor, JSON.stringify(event) + '\n');
      fs.fsyncSync(descriptor);
      apply(event);
      persistenceError = '';
    } catch (error) {
      readFailure = true;
      persistenceError = '用量账本无法保存，已停止发起模型请求';
      throw Object.assign(new Error(persistenceError), { code: 'USAGE_PERSISTENCE_FAILED', cause: error });
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    try { onChange(); } catch {}
  }
  function totals(filter) {
    const result = { calls: 0, reportedTokens: 0, estimatedTokens: 0, reservedTokens: 0, unknownCalls: 0, inputTokens: 0, outputTokens: 0 };
    for (const call of calls.values()) {
      if (!filter(call)) continue;
      result.calls++;
      if (call.status === 'running') result.reservedTokens += call.reservedTokens;
      else if (call.totalTokens !== null) result.reportedTokens += call.totalTokens;
      else { result.estimatedTokens += call.chargedTokens; result.unknownCalls++; }
      result.inputTokens += call.inputTokens || 0; result.outputTokens += call.outputTokens || 0;
    }
    result.accountedTokens = result.reportedTokens + result.estimatedTokens + result.reservedTokens;
    return result;
  }
  function summary(scopeId = '') {
    const day = dayAt(now());
    const today = totals(call => call.day === day && (!scopeId || call.scopeId === scopeId));
    return { day, timeZone: policy.timeZone, policy: { ...policy }, scopeId, ...today, persistenceError,
      records: [...calls.values()].filter(call => !scopeId || call.scopeId === scopeId).slice(-80).reverse().map(call => ({ ...call })) };
  }
  function init() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      // A torn final append is ambiguous. Fail closed rather than discarding a possible charge.
      if (raw && !raw.endsWith('\n')) throw new Error('用量账本末尾不完整');
      for (const line of raw.split('\n')) if (line) apply(JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') { readFailure = true; persistenceError = '用量账本无法读取，模型调用保持停止'; throw Object.assign(new Error(persistenceError), { code: 'USAGE_PERSISTENCE_FAILED', cause: error }); }
    }
    for (const call of calls.values()) if (call.status === 'running') {
      commit({ type: 'settle', id: call.id, patch: { status: 'unknown', finishedAt: new Date(now()).toISOString(), chargedTokens: call.reservedTokens, recovered: true } });
    }
    return summary();
  }
  function setPolicy(value) {
    if (!value || !limit(value.dailyTokenLimit)) throw new Error('每日 token 预算无效');
    const zone = value.timeZone ?? policy.timeZone;
    new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format();
    // Day boundaries are part of the accounting contract; changing them would bypass today's budget.
    if (zone !== policy.timeZone && calls.size) throw new Error('已有用量记录时不能更改预算时区');
    commit({ type: 'policy', policy: { dailyTokenLimit: value.dailyTokenLimit, timeZone: zone } });
    return summary();
  }
  function begin({ settings, role, request, scope = {} }) {
    if (persistenceError) throw Object.assign(new Error(persistenceError), { code: 'USAGE_PERSISTENCE_FAILED' });
    const day = dayAt(now()), scopeId = clean(scope.scopeId || 'system'), runId = clean(scope.runId || randomUUID());
    const outputKey = Object.hasOwn(request, 'max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens';
    const requestedOutput = request[outputKey];
    if (!Number.isSafeInteger(requestedOutput) || requestedOutput < 1) throw new Error('模型输出额度无效');
    // A conservative byte-based reservation, not a tokenizer or a provider invoice.
    const inputEstimate = Buffer.byteLength(JSON.stringify(request), 'utf8') + 256 + (request.messages?.length || 0) * 32;
    const budgets = [
      { kind: 'daily', cap: policy.dailyTokenLimit, used: totals(call => call.day === day).accountedTokens },
      { kind: 'goal_daily', cap: scope.dailyTokenLimit || 0, used: totals(call => call.day === day && call.scopeId === scopeId).accountedTokens },
      { kind: 'round', cap: scope.runTokenLimit || 0, used: totals(call => call.runId === runId && call.scopeId === scopeId).accountedTokens },
    ];
    for (const budget of budgets) if (!limit(budget.cap)) throw new Error('任务 token 预算无效');
    const tightest = budgets.filter(budget => budget.cap > 0).sort((a, b) => (a.cap - a.used) - (b.cap - b.used))[0];
    const maxOutputTokens = Math.min(requestedOutput, tightest ? Math.floor(tightest.cap - tightest.used - inputEstimate) : requestedOutput);
    if (maxOutputTokens < Math.min(64, requestedOutput)) {
      const kind = tightest?.kind || 'round';
      const message = kind === 'round' ? '本轮 token 预算不足，已在请求模型前暂停。请提高本轮预算后继续；本轮用量不会因重启或跨日清零。' : '今日 token 预算不足，已在请求模型前暂停。提高预算后点击继续，或等待下一个预算日。';
      throw Object.assign(new Error(message), { code: 'TOKEN_BUDGET_EXCEEDED', budgetKind: kind, execution_status: 'not_started' });
    }
    const id = randomUUID();
    const record = { id, scopeId, scopeLabel: clean(scope.scopeLabel), runId, attemptId: clean(scope.attemptId), day, role: clean(role), model: clean(settings.model), providerId: clean(settings.providerId),
      startedAt: new Date(now()).toISOString(), finishedAt: null, status: 'running', inputEstimate, maxOutputTokens,
      reservedTokens: inputEstimate + maxOutputTokens, chargedTokens: 0, inputTokens: null, outputTokens: null, totalTokens: null, cachedTokens: null, reasoningTokens: null };
    commit({ type: 'begin', call: record });
    let settled = false;
    return { maxOutputTokens, finish({ usage = null, error = null, dispatched = true } = {}) {
      if (settled) return;
      const normalized = normalizeUsage(usage);
      const patch = { ...normalized, finishedAt: new Date(now()).toISOString(),
        status: !dispatched ? 'not_sent' : error ? 'failed' : normalized.totalTokens === null ? 'unknown' : 'done',
        chargedTokens: !dispatched ? 0 : normalized.totalTokens ?? record.reservedTokens,
        ...(error ? { errorCode: clean(error.code || (error.httpStatus ? 'HTTP_' + error.httpStatus : 'MODEL_CALL_FAILED')), ...require('./model-errors.cjs').failureDetails(error) } : {}) };
      if (!dispatched) patch.totalTokens = 0;
      commit({ type: 'settle', id, patch }); settled = true;
    } };
  }
  return { init, begin, summary, setPolicy, day: () => dayAt(now()), file };
}
function installUsageLedger(ledger) { installed = ledger; }
function withUsage(scope, fn) { return context.run({ ...context.getStore(), ...scope }, fn); }
function beginModelCall(input) {
  const scope = context.getStore() || {};
  const ledger = scope.ledger || installed;
  return ledger ? ledger.begin({ ...input, scope }) : { maxOutputTokens: input.request.max_completion_tokens ?? input.request.max_tokens, finish() {} };
}
function assertBackgroundTaskAllowed() {
  if (context.getStore()?.longGoalId) throw Object.assign(new Error('长期目标内请使用当前任务或委派分工，不能创建脱离目标预算的新后台任务'), { code: 'GOAL_SCOPE_VIOLATION' });
}
module.exports = { createUsageLedger, installUsageLedger, withUsage, beginModelCall, normalizeUsage, assertBackgroundTaskAllowed };
