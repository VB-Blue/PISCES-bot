// User-defined objectives share the ordinary, permission-checked task executor.
// The clock does no model work. A completed, verified round is reviewed before the next one.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { isTransient } = require('./router.cjs');

const LIVE = new Set(['queued', 'running', 'waiting']);
const terminal = new Set(['done', 'failed', 'unverified', 'paused', 'interrupted', 'cancelled']);
function configuration(value) {
  const objective = String(value?.objective || '').trim();
  const criteria = String(value?.criteria || '').trim();
  if (objective.length < 4 || objective.length > 6000) throw new Error('请填写 4 至 6000 字的长期目标');
  if (criteria.length > 2000 || String(value?.constraints || '').length > 3000) throw new Error('目标约束或检查标准过长');
  const number = (key, fallback, min, max) => {
    const candidate = value[key] ?? fallback;
    if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) throw new Error('目标的执行间隔或 token 预算无效');
    return candidate;
  };
  const minIntervalMinutes = number('minIntervalMinutes', 60, 5, 10080);
  const maxIntervalMinutes = number('maxIntervalMinutes', 360, minIntervalMinutes, 43200);
  const dailyTokenLimit = number('dailyTokenLimit', 200000, 1024, 1000000000);
  const runTokenLimit = number('runTokenLimit', 80000, 1024, dailyTokenLimit);
  const watchPaths = value.watchPaths ?? [];
  if (!Array.isArray(watchPaths) || watchPaths.length > 16 || watchPaths.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096)) throw new Error('变化来源必须是已授权目录中的完整文件路径');
  const result = { objective, criteria, constraints: String(value.constraints || '').trim(),
    title: String(value.title || objective.split(/[。\n]/)[0]).trim().slice(0, 90),
    profile: String(value.profile || '').slice(0, 100), watchPaths: [...new Set(watchPaths)], minIntervalMinutes, maxIntervalMinutes, dailyTokenLimit, runTokenLimit };
  if (ownerContract(result).length > 4800) throw new Error('目标、检查标准、约束和监测路径合计过长，请精简后保存；不会截断你的约束。');
  return result;
}
function ownerContract(goal) {
  return '长期目标：' + goal.objective + '\n检查标准：' + (goal.criteria || '根据目标制定可核对的标准，使用真实来源和实际操作回执检查结果。') +
    '\n约束：' + (goal.constraints || '沿用现有工具权限；缺少资料、连接或授权时明确说明。') +
    (goal.watchPaths?.length ? '\n本轮检查的资料路径：\n' + goal.watchPaths.join('\n') : '');
}
function cycleRequest(goal) {
  const base = ownerContract(goal) + '\n本轮重点：' + (goal.nextAction || '先检查现状，再确定并完成本轮最有价值的工作。').slice(0, 700) +
    '\n这是持续目标的一轮执行；只汇报本轮实际完成的结果，保留来源、产物和未完成事项。不要创建另一个重复任务或修改运行预算。';
  const heading = '\n前几轮的结果（只作背景，本轮仍需核对现状）：\n';
  const available = 6000 - base.length - heading.length;
  return base + (goal.history.length && available > 0 ? heading + goal.history.slice(-3).map(item => item.summary).join('\n').slice(-available) : '');
}

function createLongGoals({ dir, jobs, review, usage, probe = null, notify = () => {}, onChange = () => {}, now = Date.now, tickMs = 15000 }) {
  const file = path.join(dir, 'long-goals.json');
  let goals = [], timer = null, stopping = false, persistenceError = '';
  const reviews = new Map(), flights = new Map();
  const get = id => goals.find(goal => goal.id === id);
  const view = goal => structuredClone({ ...goal, usage: usage.summary(goal.id), persistenceError });
  function persist() {
    const temporary = file + '.tmp';
    let descriptor;
    try {
      fs.mkdirSync(dir, { recursive: true });
      descriptor = fs.openSync(temporary, 'w', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ schema: 1, goals })); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file); persistenceError = '';
    } catch (error) { persistenceError = '长期目标无法保存，已停止安排新任务'; throw Object.assign(new Error(persistenceError), { code: 'GOAL_PERSISTENCE_FAILED', cause: error }); }
  }
  function changed(goal) { goal.updatedAt = new Date(now()).toISOString(); persist(); try { onChange(view(goal)); } catch {} }
  function announce(goal, kind) { try { notify({ goal: view(goal), kind }); } catch {} }
  function archive(goal, job, next) {
    if (!/^[a-f\d-]{36}$/i.test(goal.id) || !/^[a-f\d-]{36}$/i.test(job.runId)) throw new Error('目标归档身份无效');
    const archiveDir = path.join(dir, 'history', goal.id), target = path.join(archiveDir, job.runId + '.json');
    if (fs.existsSync(target)) {
      const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (previous.job.id !== job.id || previous.goal.revision !== goal.revision) throw new Error('已有归档与本轮身份不一致');
      return;
    }
    fs.mkdirSync(archiveDir, { recursive: true });
    const temporary = target + '.tmp', descriptor = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify({ goal: { ...configuration(goal), id: goal.id, revision: goal.revision }, job, review: next })); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
  }
  const contract = goal => ({ goalId: goal.id, revision: goal.revision, dailyTokenLimit: goal.dailyTokenLimit, runTokenLimit: goal.runTokenLimit });
  async function attach(goal) {
    if (!goal.pending) {
      goal.pending = { id: randomUUID(), request: cycleRequest(goal), sourceFingerprint: goal.observedFingerprint || null };
      changed(goal); // Persist the creation identity before submitting a task.
    }
    const intent = goal.pending, generation = goal.generation;
    const job = jobs.create({ title: goal.title + ' · ' + (goal.cycle + 1), goal: intent.request,
      profile: goal.profile, source: 'long_goal', creationKey: intent.id, automation: contract(goal), deferStart: true });
    await jobs.flush();
    if (goal.pending?.id !== intent.id) throw new Error('长期目标的任务登记身份已改变');
    goal.jobId = job.id; goal.roundSourceFingerprint = intent.sourceFingerprint; goal.pending = null; goal.cycle++; goal.nextRunAt = null; goal.handledRun = ''; goal.forceRun = false; changed(goal);
    if (!stopping && goal.status === 'active' && goal.generation === generation) { jobs.resume(job.id); await jobs.flush(); }
  }
  async function completed(goal, job) {
    if (job.acceptance?.passed !== true || job.runInstructionVersion !== job.instructionVersion) {
      goal.status = 'attention'; goal.notice = '本轮任务尚未通过结果验收，请先检查关联任务'; goal.nextRunAt = null; changed(goal); announce(goal, 'attention'); return;
    }
    const generation = goal.generation;
    goal.status = 'reviewing'; goal.notice = '正在检查本轮结果并安排下一步'; changed(goal);
    let next;
    const controller = new AbortController(); reviews.set(goal.id, controller);
    try { next = await review(view(goal), job, controller.signal); }
    catch (error) {
      if (goal.generation !== generation || goal.status !== 'reviewing') return;
      if (error.code !== 'TOKEN_BUDGET_EXCEEDED' && isTransient(error) && (goal.reviewFailures || 0) < 3) {
        goal.reviewFailures = (goal.reviewFailures || 0) + 1; goal.status = 'active';
        goal.reviewRetryAt = now() + Math.min(goal.maxIntervalMinutes, goal.minIntervalMinutes * 2 ** (goal.reviewFailures - 1)) * 60000;
        goal.nextRunAt = goal.reviewRetryAt; goal.notice = '复核服务暂时不可用，稍后从已验收结果继续核对；未开始新一轮。'; changed(goal); return;
      }
      goal.status = error.code === 'TOKEN_BUDGET_EXCEEDED' ? 'budget' : 'attention';
      goal.budgetDay = usage.day(); goal.budgetKind = error.budgetKind || ''; goal.notice = String(error.message).slice(0, 700); changed(goal); announce(goal, goal.status); return;
    } finally { if (reviews.get(goal.id) === controller) reviews.delete(goal.id); }
    if (stopping || goal.generation !== generation || goal.status !== 'reviewing') return;
    const currentJob = jobs.get(job.id);
    if (!currentJob || currentJob.runId !== job.runId || currentJob.instructionVersion !== job.instructionVersion || currentJob.status !== 'done') {
      goal.status = 'active'; goal.notice = '当前轮要求已更新，等待新的验收结果'; goal.reviewRetryAt = null; changed(goal); return;
    }
    if (!next || typeof next.nextAction !== 'string' || !next.nextAction.trim() || typeof next.summary !== 'string' || !['continue', 'needs_input'].includes(next.state)) {
      goal.status = 'attention'; goal.notice = '本轮复核没有给出有效的下一步，已停止自动安排'; changed(goal); announce(goal, 'attention'); return;
    }
    const delay = Number.isFinite(next.delayMinutes) ? Math.round(next.delayMinutes) : goal.minIntervalMinutes;
    archive(goal, job, next);
    goal.history.push({ id: job.runId, cycle: goal.cycle, jobId: job.id, time: job.finishedAt, summary: next.summary.slice(0, 1800), result: job.result.slice(0, 3500) });
    goal.history = goal.history.slice(-30); goal.lastResult = job.result.slice(0, 4000); goal.lastRunAt = job.finishedAt;
    goal.nextAction = next.nextAction.trim().slice(0, 1800); goal.failureCount = 0;
    goal.reviewFailures = 0; goal.reviewRetryAt = null;
    goal.sourceFingerprint = goal.roundSourceFingerprint || null;
    goal.jobId = null; goal.handledRun = '';
    goal.status = next.state === 'needs_input' ? 'attention' : 'active';
    goal.notice = next.state === 'needs_input' ? goal.nextAction : '';
    goal.nextRunAt = goal.status === 'active' ? now() + Math.max(goal.minIntervalMinutes, Math.min(goal.maxIntervalMinutes, delay)) * 60000 : null;
    changed(goal); if (goal.status === 'attention') announce(goal, 'attention');
  }
  async function advance(goal) {
    if (goal.status === 'budget') {
      if (goal.budgetKind === 'round' || goal.budgetDay === usage.day()) return;
      goal.status = 'active'; goal.notice = ''; goal.nextRunAt = now(); changed(goal);
    }
    if (goal.status !== 'active') return;
    if (!goal.jobId) {
      if (goal.nextRunAt !== null && goal.nextRunAt <= now()) {
        if (goal.watchPaths?.length && !goal.pending) {
          if (!probe) throw new Error('文件变化检查尚未接通');
          const generation = goal.generation, fingerprint = await probe(goal.watchPaths);
          if (stopping || goal.status !== 'active' || goal.generation !== generation) return;
          goal.observedFingerprint = fingerprint; goal.lastCheckedAt = new Date(now()).toISOString();
          if (!goal.forceRun && goal.sourceFingerprint === fingerprint) {
            goal.unchangedChecks = (goal.unchangedChecks || 0) + 1;
            goal.nextRunAt = now() + goal.minIntervalMinutes * 60000; goal.notice = '来源未变化，本次检查未调用模型'; changed(goal); return;
          }
        }
        await attach(goal);
      }
      return;
    }
    const job = jobs.get(goal.jobId);
    if (!job) { goal.status = 'attention'; goal.notice = '关联任务记录缺失，已停止自动安排'; changed(goal); announce(goal, 'attention'); return; }
    if (LIVE.has(job.status)) return;
    if (job.status === 'paused' && job.runs === 0) { jobs.resume(job.id); await jobs.flush(); return; }
    if (job.status === 'interrupted' && job.workId && job.plan?.length && !job.unresolvedSteps?.length && job.executionStatus !== 'result_unknown') {
      jobs.resume(job.id); await jobs.flush(); return;
    }
    if (job.status === 'done') { if (!goal.reviewRetryAt || goal.reviewRetryAt <= now()) await completed(goal, job); return; }
    if (!terminal.has(job.status)) return;
    const handled = job.runId + ':' + job.status;
    if (goal.handledRun === handled) {
      if (goal.nextRunAt && goal.nextRunAt <= now()) { jobs.resume(job.id); await jobs.flush(); goal.handledRun = ''; goal.nextRunAt = null; changed(goal); }
      return;
    }
    goal.handledRun = handled;
    if (job.errorCode === 'TOKEN_BUDGET_EXCEEDED') {
      goal.status = 'budget'; goal.budgetDay = usage.day(); goal.budgetKind = job.budgetKind || 'round'; goal.notice = job.error; goal.nextRunAt = null;
    } else if (job.status === 'failed' && job.workId && !job.unresolvedSteps?.length && job.executionStatus !== 'result_unknown' && (job.retryableFailure === true || isTransient(new Error(job.error))) && goal.failureCount < 3) {
      goal.failureCount++; goal.nextRunAt = now() + Math.min(goal.maxIntervalMinutes, goal.minIntervalMinutes * 2 ** (goal.failureCount - 1)) * 60000;
      goal.notice = '服务暂时不可用，稍后从原任务核对恢复；已记录失败次数：' + goal.failureCount;
    } else { goal.status = 'attention'; goal.notice = job.error || '本轮暂停或结果需要核对，请先检查关联任务'; goal.nextRunAt = null; }
    changed(goal); if (goal.status !== 'active') announce(goal, goal.status);
  }
  async function tick() {
    if (stopping || persistenceError) return;
    const pending = goals.map(goal => {
      if (flights.has(goal.id)) return flights.get(goal.id);
      const work = Promise.resolve().then(() => { if (!stopping && !persistenceError) return advance(goal); }).catch(error => {
        if (error.code === 'GOAL_PERSISTENCE_FAILED') { persistenceError ||= error.message; try { onChange({ error: persistenceError }); } catch {} return; }
        goal.status = 'attention'; goal.notice = String(error.message).slice(0, 700); goal.nextRunAt = null;
        changed(goal); announce(goal, 'attention');
      }).finally(() => flights.delete(goal.id));
      flights.set(goal.id, work); return work;
    });
    await Promise.allSettled(pending);
  }
  async function init() {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.schema !== 1 || !Array.isArray(state.goals)) throw new Error('长期目标记录格式无效');
      goals = state.goals;
      if (goals.length > 100 || new Set(goals.map(goal => goal.id)).size !== goals.length) throw new Error('长期目标记录身份无效');
      for (const goal of goals) {
        Object.assign(goal, configuration(goal));
        if (!/^[a-f\d-]{36}$/i.test(goal.id)) throw new Error('长期目标记录身份无效');
        if (goal.pending && !goal.jobId) {
          const job = jobs.get(goal.pending.id);
          if (job) {
            if (job.automation?.goalId !== goal.id || job.automation.revision !== goal.revision) throw new Error('待执行任务与目标身份不一致');
            goal.jobId = job.id; goal.roundSourceFingerprint = goal.pending.sourceFingerprint || null; goal.pending = null; goal.cycle++; goal.nextRunAt = null;
          }
        }
        if (goal.status === 'reviewing') { goal.status = 'attention'; goal.notice = '复核期间后台中断，请检查已完成的任务后继续'; goal.generation++; }
      }
    } catch (error) { if (error.code !== 'ENOENT') { persistenceError = '长期目标记录无法读取，已停止自动执行'; throw Object.assign(new Error(persistenceError), { code: 'GOAL_PERSISTENCE_FAILED', cause: error }); } }
    persist(); timer = setInterval(() => void tick(), tickMs); timer.unref?.(); await tick();
  }
  function save(value, { creationKey = '' } = {}) {
    if (persistenceError) throw new Error(persistenceError);
    const config = configuration(value);
    creationKey = value.creationKey || creationKey;
    if (creationKey && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(creationKey)) throw new Error('目标创建标识无效');
    const creationContract = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    if (!value.id && creationKey) {
      const previous = goals.find(item => item.creationKey === creationKey);
      if (previous) {
        if (previous.creationContract !== creationContract) throw Object.assign(new Error('这个目标已创建；要求发生变化，请从目标列表进入修改。'), { code: 'GOAL_CREATION_CONFLICT' });
        return view(previous);
      }
    }
    let goal = value.id ? get(value.id) : null;
    if (value.id && !goal) throw new Error('找不到这个长期目标');
    if (goal) {
      if (value.revision !== goal.revision) throw new Error('目标已更新，请重新读取后修改');
      if (!['paused', 'attention', 'budget', 'stopped'].includes(goal.status)) throw new Error('请先暂停目标，再修改要求或预算');
      if (goal.pending && jobs.get(goal.pending.id)) throw new Error('正在登记当前轮任务，请稍后再保存');
      const job = goal.jobId && jobs.get(goal.jobId);
      if (job && LIVE.has(job.status)) throw new Error('正在停止当前动作，请稍后再保存');
      Object.assign(goal, config); goal.revision++; goal.generation++; goal.nextAction = '';
      if (job && job.status !== 'done') {
        jobs.updateAutomation(job.id, contract(goal), goal.profile);
        jobs.addInstruction(job.id, '长期目标已修改，以本次目标、约束和检查标准为准：\n' + cycleRequest(goal), { queue: false });
      }
      if (job?.status === 'done') {
        if (!goal.history.some(item => item.id === job.runId)) goal.history.push({ id: job.runId, cycle: goal.cycle, jobId: job.id, time: job.finishedAt, summary: '目标修改前已完成的任务，后续执行需重新核对现状。', result: job.result.slice(0, 3500) });
        goal.history = goal.history.slice(-30); goal.jobId = null;
      }
      goal.status = 'paused'; goal.notice = '要求已保存，继续后会先核对已有进度'; goal.nextAction = ''; goal.pending = null; goal.sourceFingerprint = null;
    } else {
      if (goals.length >= 100) throw new Error('长期目标已达上限，请先整理已有目标');
      goal = { ...config, id: randomUUID(), creationKey, creationContract, revision: 1, generation: 1, status: 'active', cycle: 0, jobId: null, pending: null,
        createdAt: new Date(now()).toISOString(), nextRunAt: now(), nextAction: '', lastResult: '', lastRunAt: null, history: [], failureCount: 0, notice: '', handledRun: '' };
      goals.unshift(goal);
    }
    changed(goal); void tick(); return view(goal);
  }
  async function action(id, action) {
    if (persistenceError) throw new Error(persistenceError);
    const goal = get(id); if (!goal) throw new Error('找不到这个长期目标');
    if (!['pause', 'resume', 'stop', 'run'].includes(action)) throw new Error('长期目标操作无效');
    const job = goal.jobId && jobs.get(goal.jobId);
    if (action === 'pause' || action === 'stop') {
      goal.generation++; goal.status = action === 'stop' ? 'stopped' : 'paused'; goal.nextRunAt = null; goal.notice = ''; changed(goal);
      reviews.get(goal.id)?.abort();
      if (job && LIVE.has(job.status)) { jobs.pause(job.id); await jobs.flush(); }
    } else {
      if (goal.status === 'reviewing' || job && LIVE.has(job.status)) throw new Error('当前轮仍在处理，请等待或先暂停');
      goal.generation++; goal.status = 'active'; goal.notice = ''; goal.failureCount = 0; goal.reviewFailures = 0; goal.reviewRetryAt = null; goal.handledRun = ''; goal.nextRunAt = now(); goal.forceRun = action === 'run'; changed(goal);
      if (job && job.status !== 'done') { jobs.resume(job.id); await jobs.flush(); goal.nextRunAt = null; changed(goal); }
      const prior = flights.get(goal.id);
      if (prior) void prior.then(() => tick()).catch(() => {});
      else void tick();
    }
    return view(goal);
  }
  function admit(job) {
    const owner = job.automation && get(job.automation.goalId);
    if (stopping || persistenceError || !owner || !['active', 'reviewing'].includes(owner.status) || owner.jobId !== job.id || owner.revision !== job.automation.revision) {
      throw Object.assign(new Error('长期目标已暂停、已停止或要求已改变，本轮未获准开始。请从长期目标现场继续。'), { code: 'GOAL_NOT_ACTIVE', execution_status: 'not_started' });
    }
    if (owner.status === 'reviewing') {
      owner.generation++; owner.status = 'active'; owner.notice = '当前轮要求已更新，等待新的验收结果'; owner.reviewRetryAt = null;
      reviews.get(owner.id)?.abort(); changed(owner);
    }
    return true;
  }
  return { init, tick, save, action, admit, get: id => { const goal = get(id); return goal ? view(goal) : null; }, list: () => { if (persistenceError) throw new Error(persistenceError); return goals.map(view); },
    async pauseAll() { if (!persistenceError) await Promise.all(goals.filter(goal => ['active', 'reviewing', 'budget'].includes(goal.status)).map(goal => action(goal.id, 'pause'))); },
    async stop() { stopping = true; clearInterval(timer); for (const controller of reviews.values()) controller.abort(); await Promise.allSettled([...flights.values()]); if (!persistenceError) persist(); }, file };
}
module.exports = { createLongGoals, configuration, cycleRequest };
