// Sub-agents: the main agent hands independent sub-tasks to helpers that have their own context and a restricted
// toolset. Several can run at once (one model turn may start many), but the screen is single: only one helper
// may drive software at a time. Helpers cannot spawn helpers, change memory, or ask the user questions.
//
// Allocation: each helper is given a role template (tools + preferred kind of model), and the router decides which
// configured AI service runs it: an explicit service name, the user's per-role setting, a vision-capable service for
// screen work, a service strong at what the task needs, or the default. If that service fails the helper moves to the next.
const { randomUUID } = require('node:crypto');
const { AGENT_ROLES, plan: planRoute, createLimiter, describeProfiles } = require('./router.cjs');
const { STRENGTHS } = require('./providers.cjs');
const { classifyToolOutcome } = require('./tool-outcome.cjs');

const GROUP_TOOLS = {
  web: ['web_search', 'news_search', 'fetch_url', 'get_environment', 'recall', ...require('./browser-tools.cjs').names],
  files: ['list_dir', 'find_files', 'search_text', 'read_text', 'write_text', 'write_document', 'edit_text', 'edit_image', 'get_environment'],
  desktop: ['find_app', 'launch_app', 'open_url', 'list_windows', 'observe', 'click', 'type_text', 'press_keys', 'scroll', 'drag', 'find_text', 'click_text', 'read_window_text', 'wait_for', 'zoom', 'update_plan', 'inspect_window', ...require('./browser-tools.cjs').names],
  shell: ['run_command', 'get_environment', 'read_text', 'list_dir'],
  connectors: ['@connectors'],
};

function buildDefinition(store) {
  const profiles = store?.profiles || [];
  const roleText = Object.entries(AGENT_ROLES).map(([key, role]) => key + '=' + role.label + '（' + role.hint + '）').join('；');
  const properties = {
    name: { type: 'string', description: '子代理的名字，例如“资料员”“邮件整理员”' },
    task: { type: 'string', description: '要完成的子任务，以及需要交回的结果形式' },
    context: { type: 'string', description: '子代理需要知道的背景（用户偏好、已知信息、文件路径等）' },
    role: { type: 'string', enum: Object.keys(AGENT_ROLES), description: '角色模板，决定默认工具和适合的模型类型：' + roleText + '。不填则按 capabilities。' },
    capabilities: { type: 'array', items: { type: 'string', enum: ['web', 'files', 'desktop', 'shell', 'connectors'] }, description: 'web 联网；files 读写文件与修图；desktop 启动并控制软件（同一时间只有一个能操作屏幕）；shell 执行命令；connectors 使用已连接的外部服务（GitHub、Notion 等）。填写后覆盖角色模板的默认值；都不填默认 web+files' },
  };
  if (profiles.length > 1) {
    properties.profile = { type: 'string', enum: profiles.map(item => item.name), description: '指定由哪个 AI 服务来做。不填则系统按角色和任务自动分配。' };
    properties.prefer = { type: 'string', enum: STRENGTHS, description: '没有指定服务时，偏向擅长这一项的服务：strong 强推理；fast 速度快；cheap 便宜；vision 看图；code 写代码；long 长文本' };
  }
  const services = describeProfiles(store || {});
  return { type: 'function', function: { name: 'delegate', description: '把一个明确的子任务交给子代理去做。子代理有自己的上下文和工具，返回结果、执行状态与实际证据。适合：查资料、读和整理一批文件、让操作员执行软件步骤、独立复核结论。核心按当前任务的权限与调度方式执行委派，同一任务可能依次执行；独立只读查询可以并行。子代理看不到本对话，task 必须自包含、写清楚要交付什么。简单的事自己做，不要为了用而用。' + (services ? '\n可用的 AI 服务：' + services + '。查资料、整理这类轻活交给快而便宜的，推理、写作、复核交给强的，看屏幕必须交给支持图片的。' : ''), parameters: { type: 'object', properties, required: ['name', 'task'], additionalProperties: false } } };
}
const definition = buildDefinition(null);

const localCore = async body => body.action === 'reserve_call' ? { call: { id: 'sub-' + randomUUID() } } : { work: {} };

// A FIFO mutex for the screen.
function createMutex(onRelease = () => {}) {
  let tail = Promise.resolve();
  return { acquire(signal) {
    signal?.throwIfAborted();
    let unlock;
    const next = new Promise(resolve => { unlock = resolve; });
    const previous = tail; tail = previous.then(() => next);
    return new Promise((resolve, reject) => {
      const abort = () => { signal?.removeEventListener('abort', abort); void previous.then(unlock); reject(signal.reason || new Error('任务已停止')); };
      signal?.addEventListener('abort', abort, { once: true });
      void previous.then(() => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) { unlock(); return; }
        let released = false;
        resolve(() => { if (released) return; released = true; try { onRelease(); } finally { unlock(); } });
      });
    });
  } };
}

// getStore() -> { profiles: resolved profiles, defaultId, routes, failover } | null. Without it (or without profiles)
// helpers use getSettings()/getApiKey(), the single-service behaviour.
function createSubAgents({ runAssistant, getSettings, getApiKey, makeTools, guiLock = createMutex(), maxParallel = 3, maxPerTurn = 8, maxTurns = 30, getStore = null, getModelOverride = null, limiter = createLimiter() }) {
  let active = 0;
  const waiting = [];
  const perTurn = new Map();
  const takeSlot = async () => { if (active < maxParallel) { active++; return; } await new Promise(resolve => waiting.push(resolve)); };
  const freeSlot = () => { const next = waiting.shift(); if (next) next(); else active--; };
  const currentStore = () => { const store = getStore?.(); return store && store.profiles?.length ? store : null; };

  async function run(args, ctx) {
    const name = String(args?.name || '子代理').trim().slice(0, 30) || '子代理';
    const task = String(args?.task || '').trim();
    if (task.length < 4) throw new Error('task 太短：请写清楚子任务和要交付的结果');
    if (task.length > 8000) throw new Error('task 过长');
    if (typeof ctx.ask !== 'function') throw new Error('当前环境无法向用户确认，子代理已取消');
    const turn = ctx.turn || 'default';
    const used = (perTurn.get(turn) || 0) + 1;
    if (used > maxPerTurn) throw new Error('本轮已启动 ' + maxPerTurn + ' 个子代理，达到上限。请先汇总已有结果。');
    perTurn.set(turn, used);
    const template = AGENT_ROLES[args?.role];
    const requested = Array.isArray(args?.capabilities) ? args.capabilities.filter(item => GROUP_TOOLS[item]) : [];
    const capabilities = requested.length ? [...new Set(requested)] : (template ? template.capabilities : ['web', 'files']);
    const allowed = [...new Set(capabilities.flatMap(item => GROUP_TOOLS[item]))];
    const prefer = STRENGTHS.includes(args?.prefer) ? args.prefer : template?.prefer;

    // Choose the AI service for this helper.
    const store = currentStore();
    let routing = null, settings, apiKey, serviceName = '', fallbacks = [];
    if (store) {
      routing = planRoute(store, { profile: args?.profile, role: args?.role, prefer, capabilities });
      settings = { ...getSettings(), ...routing.primary.settings };
      apiKey = routing.primary.apiKey;
      serviceName = routing.primary.name;
      fallbacks = routing.fallbacks.map(item => ({ name: item.name, settings: item.settings, apiKey: item.apiKey }));
      const override = routing.reason === '默认' ? getModelOverride?.() : '';
      if (override) settings = { ...settings, model: override };
    } else { settings = getSettings(); apiKey = getApiKey(); }
    const tag = store && store.profiles.length > 1 ? name + '·' + serviceName : name;
    const failovers = [];

    // Hold a place on that service first so agents queued behind a busy service do not block agents bound for others.
    const releaseService = routing ? await limiter.acquire(routing.primary.id, routing.primary.maxConcurrent, ctx.signal) : null;
    let releaseScreen = null, slotTaken = false;
    let sub;
    const workId = randomUUID();
    try {
      if (ctx.signal?.aborted) throw new Error('任务已停止');
      await takeSlot(); slotTaken = true;
      if (ctx.signal?.aborted) throw new Error('任务已停止');
      sub = makeTools();
      if (capabilities.includes('desktop')) releaseScreen = await guiLock.acquire(ctx.signal);
      const prefix = '[' + name + '] ';
      const prompt = '你是子代理「' + name + '」' + (template ? '（' + template.label + '）' : '') + '，由主代理委派，只完成下面这个子任务。你看不到主代理和用户的对话，也不能向用户提问：信息不足就按最合理的假设去做并在汇报里说明。不要超出任务范围，不要做不可撤销的操作。完成后用简洁的文字汇报：做了什么、得到的结果（需要的数据要原样给出）、哪些没做到及原因。\n\n子任务：' + task + (args?.context ? '\n\n背景：' + String(args.context).slice(0, 6000) : '');
      const result = await runAssistant({
        settings, apiKey, core: localCore, fallbacks, primaryName: serviceName,
        onFailover: info => { failovers.push(info.from + ' → ' + info.to); ctx.progress?.({ phase: 'settled', operation: 'failover', label: prefix + '切换服务：' + info.from + ' → ' + info.to, ok: true }); },
        work: { id: workId, session: ctx.session || '', goal: task, profile_snapshot: {}, files: [], roles: ['executor'], profile_revision: 0 },
        messages: [{ role: 'user', content: prompt }], signal: ctx.signal, emit: () => {}, receipt: null, coreTools: false, maxTurns,
        localTools: sub.view(allowed), userText: task, requirementContext: ctx.requirementContext || '',
        askTool: request => ctx.ask({ ...request, title: '[' + tag + '] ' + request.title }),
        progress: step => ctx.progress?.({ ...step, label: step.label ? prefix + step.label : step.label }),
      });
      const actualTrace = Array.isArray(result.trace) ? result.trace : [];
      const unresolved = Array.isArray(result.unresolvedSteps) ? result.unresolvedSteps : !result.executionStatus ? actualTrace.filter(step => step.ok === false).map(step => ({ ...step, operation: step.operation || step.tool, status: step.execution_status || 'failed' })) : [];
      const unknown = unresolved.some(step => ['unknown', 'result_unknown'].includes(step.status || step.execution_status));
      const state = unknown ? 'unknown' : result.executionStatus === 'settled' ? 'succeeded' : result.executionStatus || (unresolved.length ? 'incomplete' : undefined);
      const outcome = classifyToolOutcome({ ...result, execution_status: state, ...(unresolved.length ? { ok: false } : {}) }, 'delegate');
      const clip = (value, size) => String(typeof value === 'string' ? value : JSON.stringify(value ?? null)).slice(0, size);
      const trace = actualTrace.slice(-8).map(step => ({ ...step, args: clip(step.args, 300), result: clip(step.result, 700) }));
      const unresolvedSteps = unresolved.slice(-8).map(step => ({ ...step, args: clip(step.args, 300), error: clip(step.error, 400) }));
      return { ok: outcome.ok, execution_status: outcome.status, ...(outcome.error ? { error: outcome.error, recoverable: true, automatic_retry: false } : {}), agent: name, ...(args?.role ? { role: args.role } : {}), capabilities,
        ...(routing ? { service: result.service?.name || serviceName, model: result.model || settings.model, assigned_by: routing.reason } : {}), ...(routing?.warning ? { warning: routing.warning } : {}), ...(failovers.length ? { failovers } : {}), result: String(result.text || '').slice(0, 6000),
        unresolvedSteps, trace, evidence: { work_id: result.work?.id || workId, model: result.model || settings.model, model_calls: result.modelCalls ?? null, receipt_ids: (result.work?.receipts || []).slice(-20).map(receipt => receipt.id).filter(Boolean), trace_count: actualTrace.length, trace_truncated: actualTrace.length > trace.length } };
    } catch (error) {
      error.agent = name; error.evidence = { ...(error.evidence || {}), agent: name, work_id: workId };
      throw error;
    } finally {
      try { sub?.endControl(); } catch {}
      releaseScreen?.();
      if (slotTaken) freeSlot();
      releaseService?.();
    }
  }
  return { definition, getDefinition: () => buildDefinition(currentStore()), run, GROUP_TOOLS };
}

module.exports = { createSubAgents, createMutex, GROUP_TOOLS, definition, buildDefinition };
