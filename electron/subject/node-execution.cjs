// Node execution belongs to the canonical plan. The single host holds bounded execution identities;
// canonical work permissions still settle every action and serialize writes and approvals.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const PARALLEL_TOOLS = new Set(['read_text', 'list_dir', 'find_files', 'search_text', 'get_environment', 'web_search', 'news_search', 'fetch_url', 'write_text', 'write_document', 'edit_text']);
const WRITES = new Set(['write_text', 'write_document', 'edit_text']);
const FILE_READS = new Set(['read_text', 'list_dir', 'find_files', 'search_text']);
const ROLES = new Set(['executor', 'researcher', 'coder', 'operator', 'writer', 'reviewer']);
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (file, root) => { const relative = path.relative(canonical(root), canonical(file)); return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };
const overlap = (left, right) => inside(left, right) || inside(right, left);
const expired = () => Object.assign(new Error('这次节点执行已结束或要求已改变，不能提交迟到结果'), { code: 'NODE_EXECUTION_EXPIRED', execution_status: 'not_started' });

function normalizeExecution(step, prior = {}) {
  const role = step.role ?? prior.role ?? 'executor';
  if (!ROLES.has(role)) throw new Error('节点分工角色无效');
  const inputs = (step.inputs ?? prior.inputs ?? []);
  if (!Array.isArray(inputs) || inputs.length > 16 || inputs.some(value => typeof value !== 'string' || value.length > 500)) throw new Error('节点来源需要明确的路径列表');
  const raw = step.execution ?? prior.execution ?? { mode: 'serial' };
  if (!['serial', 'parallel'].includes(raw?.mode)) throw new Error('节点执行方式无效');
  const execution = { mode: raw.mode };
  if (raw.mode === 'parallel') {
    if (!Array.isArray(raw.tools) || !raw.tools.length || raw.tools.length > 12 || raw.tools.some(tool => !PARALLEL_TOOLS.has(tool))) throw new Error('并行节点只允许明确列出的资料与文件工具；软件、命令、连接器和委派步骤保持独占执行');
    if (inputs.some(value => !path.isAbsolute(value))) throw new Error('并行节点来源需要绝对路径');
    const outputs = step.outputs ?? prior.outputs ?? [];
    if (raw.tools.some(tool => WRITES.has(tool)) && (!outputs.length || outputs.some(value => !path.isAbsolute(value)))) throw new Error('并行写入需要明确的绝对产物路径');
    execution.tools = [...new Set(raw.tools)];
  }
  return { role, inputs: [...new Set(inputs)], execution };
}
const contract = node => createHash('sha256').update(JSON.stringify([node.id, node.do, node.criteria, node.depends_on, node.outputs, node.role, node.inputs, node.execution])).digest('hex');

async function actualPath(file) {
  const absolute = path.resolve(file);
  try { return canonical(await fs.realpath(absolute)); }
  catch { const parent = path.dirname(absolute); if (parent === absolute) return canonical(absolute); return path.join(await actualPath(parent), path.basename(absolute)); }
}
async function claimsFor(node, nodes) {
  if (node.execution?.mode !== 'parallel') return { exclusive: true, reads: [], writes: [] };
  const sources = [...(node.inputs || []), ...(node.outputs || []), ...node.depends_on.flatMap(id => nodes.find(item => item.id === id)?.outputs || [])];
  const writes = node.execution.tools.some(tool => WRITES.has(tool)) ? node.outputs : [];
  return { exclusive: false, reads: await Promise.all(sources.filter(path.isAbsolute).map(actualPath)), writes: await Promise.all(writes.map(actualPath)) };
}
function conflicting(left, right) {
  return left.exclusive || right.exclusive || left.writes.some(file => [...right.reads, ...right.writes].some(other => overlap(file, other))) || right.writes.some(file => left.reads.some(other => overlap(file, other)));
}

function scopeNodeTools(tools, node, nodes, lease) {
  const parallel = node.execution?.mode === 'parallel';
  const allowed = parallel ? new Set(node.execution.tools) : null;
  const reject = message => Object.assign(new Error(message), { code: 'NODE_SCOPE_VIOLATION', execution_status: 'not_started' });
  return { ...tools,
    get names() { return parallel ? new Set([...tools.names].filter(name => allowed.has(name))) : tools.names; },
    get definitions() { return parallel ? tools.definitions.filter(item => allowed.has(item.function?.name)) : tools.definitions; },
    has: name => (!parallel || allowed.has(name)) && tools.has(name),
    execute: async (name, args, ctx = {}) => {
      lease.assertActive();
      if (parallel) {
        if (!allowed.has(name)) throw reject('当前分工没有 ' + name + ' 的执行权限');
        if (WRITES.has(name) || FILE_READS.has(name)) {
          if (typeof args?.path !== 'string' || !path.isAbsolute(args.path)) throw reject('并行文件步骤必须使用契约中的绝对路径');
          const selected = await actualPath(args.path);
          const declared = WRITES.has(name) ? lease.claims.writes : lease.claims.reads;
          if (!(WRITES.has(name) ? declared.some(file => file === selected) : declared.some(file => inside(selected, file)))) throw reject('这个文件超出当前节点的来源或产物范围：' + args.path);
        }
      }
      lease.assertActive();
      if (WRITES.has(name)) await lease.dispatch(name, args.path);
      return tools.execute(name, args, { ...ctx, signal: lease.signal, nodeId: node.id, nodeLeaseId: lease.id, ...(ctx.ask ? { ask: request => { lease.assertActive(); return ctx.ask({ ...request, nodeId: node.id, nodeLeaseId: lease.id }); } } : {}) });
    },
  };
}

async function executeNodeGraph({ nodes, revision, signal, maxParallel = 2, persist, run, current = () => nodes, currentRevision = () => revision }) {
  const controller = new AbortController(), runId = randomUUID();
  const abort = () => controller.abort(signal.reason || new Error('任务已停止'));
  const active = new Map(), started = new Set(), results = new Map();
  const claims = new Map(await Promise.all(nodes.map(async node => [node.id, await claimsFor(node, nodes)])));
  for (const node of nodes.filter(item => item.execution?.mode === 'parallel')) for (const check of node.criteria || []) if (['file_exists','file_contains'].includes(check.check)) {
    if (!path.isAbsolute(check.target) || !claims.get(node.id).reads.some(file => inside(path.resolve(check.target), file))) {
      const actual = path.isAbsolute(check.target) ? await actualPath(check.target) : '';
      if (!actual || !claims.get(node.id).reads.some(file => inside(actual, file))) throw Object.assign(new Error('节点验收文件超出来源与产物范围：' + check.target), { code: 'NODE_SCOPE_VIOLATION', execution_status: 'not_started' });
    }
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (claims.get(nodes[i].id).writes.some(file => claims.get(nodes[j].id).writes.some(other => overlap(file, other)))) throw Object.assign(new Error('分工产物互相覆盖，需要使用不同路径或改为串行步骤：' + nodes[i].text + ' / ' + nodes[j].text), { code: 'NODE_OUTPUT_CONFLICT', execution_status: 'not_started' });
  }
  const limit = Math.max(1, Math.min(3, maxParallel));
  let fatal = null, failure = null, publishing = Promise.resolve();
  const publish = () => { const snapshot = structuredClone(nodes); publishing = publishing.then(() => persist(snapshot)); return publishing; };
  async function start(node) {
    const id = randomUUID(), fingerprint = contract(node);
    const state = { lease_id: id, run_id: runId, owner_pid: process.pid, revision, state: 'running', effects: [], started_at: new Date().toISOString(), role: node.role || 'executor' };
    node.status = 'doing'; node.runtime_status = 'doing'; node.attempts = (node.attempts || 0) + 1; node.execution_state = state;
    const lease = { id, signal: controller.signal, claims: claims.get(node.id),
      assertActive() {
        const held = active.get(node.id), saved = current().find(item => item.id === node.id);
        if (controller.signal.aborted || state.state !== 'running' || currentRevision() !== revision || held?.id !== id || saved?.execution_state?.lease_id !== id || contract(saved) !== fingerprint) throw expired();
      },
      async update(patch) { lease.assertActive(); Object.assign(state, structuredClone(patch)); await publish(); lease.assertActive(); },
      async dispatch(operation, file) { lease.assertActive(); state.effects.push({ operation, path: file, started_at: new Date().toISOString() }); state.effects = state.effects.slice(-40); await publish(); lease.assertActive(); },
    };
    const held = { id, claims: claims.get(node.id), promise: null }; active.set(node.id, held); started.add(node.id);
    held.promise = (async () => {
      try {
        await publish(); lease.assertActive();
        const outcome = await run(node, lease);
        lease.assertActive();
        Object.assign(node, { status: outcome.verification.passed ? 'done' : 'blocked', runtime_status: outcome.verification.passed ? 'done' : 'blocked', verification: outcome.verification, evidence: outcome.evidence });
        Object.assign(state, { state: 'settled', finished_at: new Date().toISOString() });
        results.set(node.id, outcome);
        if (!outcome.verification.passed) failure ||= node.text + '：' + outcome.verification.unmet.join('；');
        await publish();
      } catch (error) {
        if (!fatal && !controller.signal.aborted) { fatal = error; controller.abort(error); }
        Object.assign(node, { status: 'blocked', runtime_status: error.code === 'CORE_ACTION_UNCERTAIN' ? 'unknown' : controller.signal.aborted ? 'needs_recheck' : 'blocked', verification: { passed: false, reason: error.message, checkedAt: new Date().toISOString() }, evidence: { ...node.evidence, error: error.message, unresolvedSteps: error.unresolvedSteps || [] } });
        Object.assign(state, { state: 'needs_recheck', finished_at: new Date().toISOString(), ...(state.current_action?.operation === 'model' ? { current_action: { ...state.current_action, status: 'failed', error: error.message } } : {}) });
        await publish().catch(() => {});
      } finally { active.delete(node.id); }
    })();
  }
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  try {
    while (nodes.some(node => node.verification?.passed !== true)) {
      if (!fatal && !failure && !controller.signal.aborted) {
        let waitingChanged = false;
        for (const node of nodes.filter(item => item.verification?.passed !== true && !started.has(item.id))) {
          const dependencies = node.depends_on.filter(id => nodes.find(item => item.id === id)?.verification?.passed !== true);
          const occupied = [...active.values()].some(item => conflicting(claims.get(node.id), item.claims));
          const waitingFor = dependencies.length ? 'dependencies' : occupied ? 'resource' : active.size >= limit ? 'capacity' : 'ready';
          if (node.execution_state?.waiting_for !== waitingFor) { node.execution_state = { state: 'waiting', role: node.role || 'executor', waiting_for: waitingFor }; waitingChanged = true; }
        }
        if (waitingChanged) await publish();
        const ready = nodes.filter(node => node.verification?.passed !== true && !started.has(node.id) && node.depends_on.every(id => nodes.find(item => item.id === id)?.verification?.passed === true));
        for (const node of ready) {
          if (fatal || failure || controller.signal.aborted || active.size >= limit) break;
          const occupied = [...active.values()].find(item => conflicting(claims.get(node.id), item.claims));
          if (occupied) continue;
          await start(node);
        }
      }
      if (!active.size) break;
      await Promise.race([...active.values()].map(item => item.promise));
    }
    await Promise.all([...active.values()].map(item => item.promise)); await publishing;
    if (fatal) throw fatal;
    if (controller.signal.aborted) throw signal?.reason || expired();
    const ordered = nodes.map(node => results.get(node.id)).filter(Boolean), last = ordered.at(-1)?.result || { text: '', trace: [] };
    return { result: { ...last, text: nodes.map(node => results.get(node.id)?.result.text || node.evidence?.answer || '').filter(Boolean).join('\n\n') }, trace: ordered.flatMap(item => item.result.trace || []), failure: failure || (nodes.some(node => node.verification?.passed !== true) ? '没有依赖已核对的可执行节点，需要重新规划' : null) };
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled([...active.values()].map(item => item.promise));
    throw error;
  } finally { controller.abort(); signal?.removeEventListener('abort', abort); }
}

// Web research can be read again after a transport failure. Never use this exception to replay a write or a downstream action.
function canResumeWebRead(node, nodes) {
  const remoteReads = new Set(['web_search', 'news_search', 'fetch_url', 'get_environment']);
  if (node.execution?.mode !== 'parallel' || !node.execution.tools?.length || !node.execution.tools.every(tool => remoteReads.has(tool))
    || !Array.isArray(node.execution_state?.effects) || node.execution_state.effects.length || node.outputs?.length
    || node.evidence?.unresolvedSteps?.some(item => !remoteReads.has(item.operation))) return false;
  const affected = new Set([node.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of nodes) if (!affected.has(candidate.id) && candidate.depends_on?.some(id => affected.has(id))) { affected.add(candidate.id); changed = true; }
  }
  return !nodes.some(candidate => candidate.id !== node.id && affected.has(candidate.id) && (candidate.attempts > 0 || candidate.verification?.passed || candidate.execution_state?.effects?.length || ['doing', 'unknown', 'needs_recheck', 'done'].includes(candidate.runtime_status)));
}
module.exports = { normalizeExecution, scopeNodeTools, executeNodeGraph, claimsFor, conflicting, contract, canResumeWebRead };
