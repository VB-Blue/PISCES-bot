// Adapter to the existing Rust aggregate owner. No second authoritative task file.
const { createHash, randomUUID } = require('node:crypto');
const { similarity } = require('../memory.cjs');
const { normalizePlan } = require('./plan.cjs');
const { classifyToolOutcome } = require('../tool-outcome.cjs');
const READONLY = new Set(['web_search', 'news_search', 'fetch_url', 'read_text', 'list_dir', 'find_files', 'search_text', 'recall', 'get_environment']);

// The core currently leases operations at work level. Writes (including delegates)
// must wait for other work operations; independent reads can retain concurrency.
function operationQueue() {
  const pending = [];
  let readers = 0, writer = false;
  function pump() {
    if (writer || !pending.length || (readers && !pending[0].readonly)) return;
    do {
      const next = pending.shift();
      if (next.readonly) readers++; else writer = true;
      next.resolve(() => { if (next.readonly) readers--; else writer = false; pump(); });
    } while (!writer && pending[0]?.readonly);
  }
  return readonly => new Promise(resolve => { pending.push({ readonly, resolve }); pump(); });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function stableId(kind, value) {
  if (uuid.test(String(value))) return String(value);
  const hash = createHash('sha256').update(kind + ':' + String(value)).digest('hex');
  return hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-4' + hash.slice(13, 16) + '-a' + hash.slice(17, 20) + '-' + hash.slice(20, 32);
}
const { summarizeObservation: clipped } = require('./observation.cjs');
const toTask = work => ({ id: work.id, request: work.cognition.request, session: work.session, intent: work.cognition.intent,
  status: work.status, route: work.cognition.route, plan: work.cognition.plan, revision: work.cognition.revision,
  verification: work.cognition.verification?.result || null, createdAt: work.created_at });

async function openCanonicalRun({ request, getState, id, session, message, signal, onReceipt, onWork, linkedWorkId = null, reviseWork = false }) {
  let state;
  try { state = await getState(); } catch (error) { if (/HTTP 404/.test(error.message)) error.code = 'CORE_CONTINUITY_UNSUPPORTED'; throw error; }
  if (state.continuity?.schema !== 1) {
    const error = new Error('核心尚不支持持续任务协议，本次沿用现有助手路径');
    error.code = 'CORE_CONTINUITY_UNSUPPORTED';
    throw error;
  }
  const eventId = stableId('turn', id), sessionId = stableId('session', session || id);
  const send = input => request({ action: 'continuity', request: input });
  let context;
  try { context = await send({ kind: 'begin', id: eventId, session: sessionId, message: String(message).slice(0, 32000) }); }
  catch (error) { const failure = new Error('核心请求是否已接收尚未确认，请重新连接后核对：' + error.message); failure.code = 'CORE_AUTHORITY_LOST'; throw failure; }
  if (context.event?.id !== eventId || context.event?.session !== sessionId || context.schema !== 1) throw new Error('核心持续状态回执与当前请求不一致');
  if (context.event.status !== 'running') throw new Error('这条请求已处理或被中断，请用新的请求接续');
  if (linkedWorkId && ![...(context.works || []), ...(state.works || [])].some(item => item.id === linkedWorkId && item.cognition)) {
    await send({ kind: 'end', event_id: eventId, status: 'failed', result: '关联的核心任务不存在，不能另建任务替代恢复' }).catch(() => {});
    throw new Error('关联的核心任务不存在，不能另建任务替代恢复');
  }
  let work = null;
  let authorityFailure = null;
  const acquireOperation = operationQueue();
  async function accepted(next) {
    work = next;
    if (work) {
      context.works = [...(context.works || []).filter(item => item.id !== work.id), work];
      await onWork?.(structuredClone(work));
    }
  }
  const store = {
    contextFor() {
      // Share only relevant work, not the owner's entire unrelated history.
      const works = (context.works || []).map(item => ({ item, score: similarity(message, item.goal) + (item.session === sessionId ? 0.35 : 0) }))
        .sort((a, b) => b.score - a.score).slice(0, 4).map(({ item }) => item);
      return { canonical_profile: context.profile, persistent_user_understanding: context.facts,
        persistent_work: works, source_note: 'canonical_profile 是用户明确保存的档案；用户认识候选保留原话但尚未确认。用户当前要求优先。续做或更改已有事情时关联 persistent_work 中的 id，不另建同一件事。未知操作结果必须先检查，不能直接重复。' };
    },
    async acceptUnderstanding(intent) {
      if (linkedWorkId && intent.type !== 'task') throw new Error('恢复已有任务需要可执行的任务理解，不能作为闲聊结束');
      const associated = linkedWorkId ? { ...intent, work_relation: { kind: reviseWork || intent.work_relation?.kind === 'revise' ? 'revise' : 'continue', work_id: linkedWorkId } } : intent;
      const response = await send({ kind: 'interpret', event_id: eventId, intent: associated });
      context = response.context;
      await accepted(response.work);
    },
    async createTask() {
      if (!work?.cognition) throw new Error('核心尚未接受任务理解');
      return toTask(work);
    },
    refreshTask(task) { Object.assign(task, toTask(work)); return task; },
    async updateTask(task, patch) {
      const normalized = { ...patch, ...(patch.plan ? { plan: normalizePlan(patch.plan, work?.cognition?.plan || [], { trustedRuntime: true }) } : {}) };
      let response;
      try { response = await send({ kind: 'update', event_id: eventId, work_id: task.id, expected_revision: task.revision, patch: normalized }); }
      catch (error) { const failure = new Error('核心未能提交任务更新：' + error.message); failure.code = 'CORE_AUTHORITY_LOST'; authorityFailure = failure; throw failure; }
      await accepted(response.work);
      Object.assign(task, toTask(work));
      return task;
    },
    similarSuccess: () => null, // Cached wording is not independent semantic understanding.
    routeStats: () => ({}),
    recordExperience: async () => null, // Outcome lives on the canonical work; no desktop authority is created.
  };
  const modelCore = async body => {
    if (body.action === 'reserve_call') return send({ kind: 'call_begin', event_id: eventId, role: body.role || 'executor', model: body.model || '' });
    if (body.action === 'settle_call') return send({ kind: 'call_end', event_id: eventId, call_id: body.call_id, status: body.status, total_tokens: body.total_tokens ?? null, note: body.note || '' });
    // A worker may be used twice while the executive verifies and repairs. Only the outer turn settles the task.
    if (['finish', 'reject_proposal'].includes(body.action)) return { work: {}, receipt: { status: 'not_executed' } };
    throw new Error('日常执行器未授权这个核心操作：' + body.action);
  };
  const targetHooks = {
    beforeCall: (role, model) => modelCore({ action: 'reserve_call', role, model: model || '' }).then(value => value.call.id),
    afterCall: (id, status, usage, note) => modelCore({ action: 'settle_call', call_id: id, status, total_tokens: usage?.total_tokens ?? null, note: String(note || '').slice(0, 300) }),
  };
  const wrapTools = tools => ({ ...tools,
    scheduling: 'canonical_work_serial_delegation',
    get definitions() { return tools.definitions?.map(item => item.function?.name === 'delegate' ? { ...item, function: { ...item.function, description: item.function.description + '\n当前核心以主任务为单位签发操作许可：同一主任务的委派依次执行，独立只读工具可并行。' } } : item); },
    execute: async (name, args, ctx = {}) => {
    // Conversations may use tools without a task interpretation (e.g. remember a preference).
    // They still keep the existing host permission path; no fictional task is created.
    if (!work) return tools.execute(name, args, ctx);
    const release = await acquireOperation(READONLY.has(name));
    try {
    if (authorityFailure) throw authorityFailure;
    if (signal?.aborted || ctx.signal?.aborted) throw new Error('任务已停止');
    const observation = result => clipped(ctx.nodeId ? { ...result, node_execution: { node_id: ctx.nodeId, lease_id: ctx.nodeLeaseId } } : result);
    if (name === 'delegate') await ctx.progress?.({ phase: 'started', operation: 'delegate', label: '依次委派：' + String(args?.name || '子任务').slice(0, 50), scheduling: 'serial', workId: work.id });
    if (name === 'update_plan') {
      let plan = normalizePlan(args.steps, work.cognition.plan);
      if (work.cognition.plan.some(node => node.runtime_status)) {
        if (plan.length !== work.cognition.plan.length || work.cognition.plan.some(node => !plan.some(item => item.id === node.id))) throw new Error('正在按节点执行的计划只能报告进度；新增或删除节点需要由主任务重新规划');
        plan = plan.map(node => ({ ...node, ...work.cognition.plan.find(item => item.id === node.id), reported_status: node.reported_status || node.status }));
      }
      const display = ctx.onPlan;
      args = { ...args, steps: plan };
      ctx = { ...ctx, onPlan: async proposed => {
        const task = toTask(work);
        const normalized = normalizePlan(proposed, work.cognition.plan);
        const plan = normalized.map(node => {
          const existing = work.cognition.plan.find(item => item.id === node.id);
          return existing?.runtime_status ? { ...node, ...existing, reported_status: node.reported_status || node.status } : node;
        });
        await store.updateTask(task, { plan });
        await display?.(structuredClone(task.plan));
        return task.plan;
      } };
    }
    const requestId = randomUUID();
    try {
      await send({ kind: 'step_begin', event_id: eventId, work_id: work.id, expected_revision: work.cognition.revision,
        request_id: requestId, operation: name, fingerprint: createHash('sha256').update(JSON.stringify(args)).digest('hex') });
    } catch (error) { const failure = new Error('核心未允许继续这一步：' + error.message); failure.code = 'CORE_AUTHORITY_LOST'; authorityFailure = failure; throw failure; }
    let result;
    try { result = await tools.execute(name, args, ctx); }
    catch (error) {
      const unknown = error.code === 'CORE_ACTION_UNCERTAIN' || !!signal?.aborted || /reconciliation|result.unknown|结果.*核对|input (completed|returned)/i.test(error.message);
      try { await send({ kind: 'step_end', event_id: eventId, work_id: work.id, request_id: requestId, ok: false, unknown,
        observation: observation({ ok: false, error: error.message, execution_status: unknown ? 'unknown' : error.execution_status || 'failed', evidence: error.evidence, unresolvedSteps: error.unresolvedSteps, trace: error.trace }) }); }
      catch (settlementError) {
        const failure = new Error('操作异常后核心未能保存回执，需要恢复核对：' + settlementError.message); failure.code = 'CORE_ACTION_UNCERTAIN';
        failure.evidence = error.evidence; failure.unresolvedSteps = error.unresolvedSteps || [{ operation: name, requestId, status: 'unknown', evidence: error.evidence }];
        authorityFailure = failure; throw failure;
      }
      if (unknown) authorityFailure = error;
      throw error;
    }
    const outcome = classifyToolOutcome(result, name);
    // If acknowledgement fails after an action, stop. Never switch to a local stub and repeat the action.
    try {
      const settled = await send({ kind: 'step_end', event_id: eventId, work_id: work.id, request_id: requestId,
        ok: outcome.ok, unknown: outcome.status === 'unknown', observation: observation(result) });
      if (settled.receipt) {
        work.receipts ||= []; work.receipts.push(settled.receipt);
        if ((name === 'read_text' && result?.file_state) || (ctx.nodeId && (['write_text','write_document','edit_text'].includes(name) || name.startsWith('browser_')))) result = { ...result, receipt: settled.receipt };
        try { onReceipt?.({ phase: 'observed', operation: name, workId: work.id, revision: work.cognition.revision, receipt: settled.receipt }); } catch { /* Display delivery does not revoke an already persisted observation. */ }
      }
    } catch (error) { const failure = new Error('操作已返回，但核心未能保存结果，需要核对后续做：' + error.message); failure.code = 'CORE_ACTION_UNCERTAIN'; authorityFailure = failure; throw failure; }
    if (outcome.status === 'unknown') {
      const failure = new Error(outcome.error); failure.code = 'CORE_ACTION_UNCERTAIN';
      failure.unresolvedSteps = [{ operation: name, requestId, status: 'unknown', error: outcome.error }];
      authorityFailure = failure; throw failure;
    }
    return result;
    } finally { release(); }
  } });
  return { store, modelCore, targetHooks, wrapTools, get work() { return work; },
    observeOperation: (name, args, act) => wrapTools({ execute: act }).execute(name, args, {}),
    async end(status, result) { const response = await send({ kind: 'end', event_id: eventId, status, result: String(result || '').slice(0, 8000) }); await accepted(response.work); return response; },
  };
}
module.exports = { openCanonicalRun, stableId };
