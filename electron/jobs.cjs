// Background jobs: work the assistant carries on without a chat window waiting on it.
// A job can start now or at a set time, repeat, ask for approval while you are away, take extra instructions mid-run,
// and survives restarts (a job that was running is marked "interrupted" and can be resumed, never silently replayed).
// This module owns state, scheduling and persistence; the actual agent run is injected (see main.cjs).
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const REPEAT_MS = { hourly: 3600_000, daily: 86_400_000, weekly: 7 * 86_400_000 };
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const MAX_LOG = 200;
const MAX_JOBS = 100;
const MAX_RUNS = 30;
const APPROVAL_TIMEOUT_MS = 30 * 60_000;
const goalTitle = goal => (String(goal).split(/[，。；\n]/).find(part => !/[a-z]:[\\/]/i.test(part) && /生成|写|汇总|统计|整理|分析|调研|提醒|\b(write|create|summarize|analyse|analyze|research|remind)\b/i.test(part)) || String(goal)).trim().slice(0, 60);

function createJobs({ dir, run, notify = () => {}, onChange = () => {}, maxRunning = 2, tickMs = 15_000, now = Date.now, approvalTimeoutMs = APPROVAL_TIMEOUT_MS, autoResumeInterrupted = false }) {
  const file = path.join(dir, 'jobs.json');
  let jobs = [];
  const live = new Map(); // id -> { controller, inbox: string[], approval: {resolve, timer}, stopReason }
  let timer = null, saving = Promise.resolve(), saveTimer = null, persistenceError = '';

  const find = id => jobs.find(item => item.id === id);
  const need = id => { const job = find(id); if (!job) throw new Error('找不到这个后台任务'); return job; };
  const stamp = () => new Date(now()).toISOString();
  const log = (job, kind, text, extra = {}) => { job.log.push({ ts: stamp(), kind, text: String(text).slice(0, 2000), ...extra }); if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG); };
  const emit = job => { job.updatedAt = stamp(); schedulePersist(); onChange(view(job)); };
  // Execution receives an immutable snapshot. All recovery updates use the run API.
  const view = job => structuredClone({ ...job, persistenceError });

  function persistNow() {
    clearTimeout(saveTimer); saveTimer = null;
    const snapshot = JSON.stringify(jobs);
    saving = saving.catch(() => {}).then(async () => {
      try { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file + '.tmp', snapshot, 'utf8'); await fs.rename(file + '.tmp', file); persistenceError = ''; }
      catch (error) { persistenceError = String(error.message); for (const job of jobs) { try { onChange(view(job)); } catch {} } throw error; }
    });
    return saving;
  }
  function schedulePersist() { if (!saveTimer) { saveTimer = setTimeout(() => void persistNow().catch(() => {}), 300); saveTimer.unref?.(); } }

  function archiveRun(job, status) {
    if (!job.runId || job.runHistory.some(item => item.id === job.runId)) return;
    const entry = { id: job.runId, version: job.runVersion, status, startedAt: job.startedAt, finishedAt: job.finishedAt || stamp(),
      result: status === 'done' ? job.result : '', error: job.error, notes: job.notes, plan: structuredClone(job.plan), instructionVersion: job.runInstructionVersion,
      workId: job.workId || null, workRevision: job.workRevision ?? null, artifacts: structuredClone(job.runArtifacts || []), executionStatus: job.executionStatus || '', unresolvedSteps: structuredClone(job.unresolvedSteps || []), currentAction: structuredClone(job.currentAction || null), acceptance: structuredClone(job.acceptance || null) };
    job.runHistory.push(entry);
    if (job.runHistory.length > MAX_RUNS) job.runHistory.splice(0, job.runHistory.length - MAX_RUNS);
    if (status === 'done') job.lastSuccessfulRun = structuredClone(entry);
  }

  async function init() {
    try { jobs = JSON.parse(await fs.readFile(file, 'utf8')); } catch { jobs = []; }
    if (!Array.isArray(jobs)) jobs = [];
    for (const job of jobs) {
      if (job.title === String(job.goal || '').slice(0, 60)) job.title = goalTitle(job.goal);
      job.notes = String(job.notes || '').slice(0, 20000); job.plan = Array.isArray(job.plan) ? job.plan : [];
      job.runHistory = Array.isArray(job.runHistory) ? job.runHistory : []; job.runVersion ||= job.runs || 0;
      job.artifacts = Array.isArray(job.artifacts) ? job.artifacts : []; job.lastSuccessfulRun ||= null;
      job.runArtifacts = Array.isArray(job.runArtifacts) ? job.runArtifacts : []; job.unresolvedSteps = Array.isArray(job.unresolvedSteps) ? job.unresolvedSteps : [];
      job.instructionVersion ||= 0; job.workInstructionVersion ??= null; job.runInstructionVersion ||= 0;
      job.replanRequested ||= false;
      job.approval = null;
      if (ACTIVE.has(job.status)) {
        job.status = job.stopRequested === 'pause' ? 'paused' : job.stopRequested === 'cancel' ? 'cancelled' : 'interrupted';
        job.finishedAt = stamp();
        if (job.currentAction?.status === 'running') job.currentAction = { ...job.currentAction, status: 'unknown', finishedAt: stamp() };
        archiveRun(job, job.status);
        log(job, 'system', job.status === 'paused' ? '重启前已要求暂停，继续保持暂停' : job.status === 'cancelled' ? '重启前已要求取消，继续保持取消' : '应用重启时这个任务正在进行。已停下来，不会自动重放；点“继续”先核对已记录的进度和操作结果。');
        if (autoResumeInterrupted && !job.automation && job.status === 'interrupted' && job.workId && job.plan.length) {
          job.status = 'queued';
          log(job, 'system', '开始恢复检查：重新核对已保存的核心任务与产物，确认后继续；无法核对的操作会停下来。');
        }
      }
    }
    await persistNow();
    timer = setInterval(() => void tick(), tickMs); timer.unref?.();
    await tick();
    pump();
  }

  function create({ title, goal, runAt = null, repeat = null, profile = '', session = '', source = 'user', creationKey = '', automation = null, deferStart = false }) {
    const text = String(goal || '').trim();
    if (text.length < 4) throw new Error('请写清楚要做什么（至少几个字）');
    if (text.length > 6000) throw new Error('任务描述过长');
    if (repeat && !REPEAT_MS[repeat]) throw new Error('重复周期无效');
    const when = runAt ? Number(runAt) : 0;
    if (runAt && (!Number.isFinite(when) || when < 1)) throw new Error('执行时间无效');
    if (creationKey && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(creationKey)) throw new Error('任务创建标识无效');
    if (automation && (!/^[a-f\d-]{36}$/i.test(automation.goalId || '') || !Number.isSafeInteger(automation.revision) || automation.revision < 1)) throw new Error('长期目标执行身份无效');
    const creationContract = createHash('sha256').update(JSON.stringify([title || '', text, when, repeat, profile, session, source, ...(automation ? [automation] : [])])).digest('hex');
    const existing = creationKey && jobs.find(item => item.creationKey === creationKey);
    if (existing) { if (existing.creationContract !== creationContract) throw new Error('同一个创建标识不能用于不同任务'); return view(existing); }
    if (jobs.filter(item => ACTIVE.has(item.status) || item.status === 'scheduled').length >= 30) throw new Error('进行中和待执行的任务已经很多，请先处理一些');
    const job = { id: creationKey || randomUUID(), creationKey, creationContract, title: title ? String(title).trim().slice(0, 60) : goalTitle(text), goal: text, status: deferStart ? 'paused' : when > now() ? 'scheduled' : 'queued', createdAt: stamp(), updatedAt: stamp(), startedAt: null, finishedAt: null,
      runAt: when > now() ? when : null, repeat: repeat || null, profile: String(profile || ''), session: String(session || ''), source, runs: 0, result: '', error: '', approval: null, steps: 0, log: [],
      notes: '', plan: [], workId: null, workRevision: null, runId: null, runVersion: 0, runHistory: [], lastSuccessfulRun: null, artifacts: [], checkpointAt: null,
      instructionVersion: 0, workInstructionVersion: null, runInstructionVersion: 0, runArtifacts: [], executionStatus: '', unresolvedSteps: [], currentAction: null, stopRequested: null, replanRequested: false, automation: automation ? structuredClone(automation) : null };
    log(job, 'system', job.runAt ? '已安排在 ' + new Date(job.runAt).toLocaleString('zh-CN', { hour12: false }) + ' 开始' + (repeat ? '，之后每' + { hourly: '小时', daily: '天', weekly: '周' }[repeat] + '重复' : '') : '已加入队列');
    jobs.unshift(job);
    if (jobs.length > MAX_JOBS) { const drop = jobs.findLastIndex(item => !ACTIVE.has(item.status) && item.status !== 'scheduled'); if (drop >= 0) jobs.splice(drop, 1); }
    emit(job); pump();
    return view(job);
  }

  function pump() {
    while ([...live.keys()].length < maxRunning) {
      const next = [...jobs].reverse().find(item => item.status === 'queued' && !live.has(item.id));
      if (!next) return;
      void start(next);
    }
  }

  async function start(job) {
    const state = { controller: new AbortController(), inbox: [], approval: null, stopReason: '', runId: randomUUID(), instructionVersion: job.instructionVersion };
    state.completed = new Promise(resolve => { state.settled = resolve; });
    live.set(job.id, state);
    job.status = 'running'; job.startedAt = stamp(); job.finishedAt = null; job.error = ''; job.errorCode = ''; job.failure = null; job.retryableFailure = false; job.budgetKind = ''; job.runs++; job.runVersion++; job.runId = state.runId;
    job.runInstructionVersion = state.instructionVersion;
    job.runArtifacts = []; job.executionStatus = ''; job.unresolvedSteps = []; job.acceptance = null;
    job.stopRequested = null;
    log(job, 'system', job.runs > 1 ? '第 ' + job.runs + ' 次开始运行' : '开始运行');
    emit(job);
    const saveCheckpoint = async patch => {
      if (live.get(job.id) !== state || job.runId !== state.runId) throw new Error('这次运行已经结束，不能覆盖新的恢复记录');
      if (!patch || typeof patch !== 'object') throw new Error('恢复记录必须是对象');
      if (patch.plan !== undefined && (!Array.isArray(patch.plan) || patch.plan.length > 20)) throw new Error('恢复计划无效');
      if (patch.workRevision !== undefined && patch.workRevision !== null && (!Number.isSafeInteger(patch.workRevision) || patch.workRevision < 0)) throw new Error('核心任务版本无效');
      if (patch.artifacts !== undefined && !Array.isArray(patch.artifacts)) throw new Error('产物记录无效');
      if (patch.unresolvedSteps !== undefined && !Array.isArray(patch.unresolvedSteps)) throw new Error('未完成操作记录无效');
      if (patch.workInstructionVersion !== undefined && (!Number.isSafeInteger(patch.workInstructionVersion) || patch.workInstructionVersion < 0)) throw new Error('要求版本无效');
      if (patch.replanRequested !== undefined && typeof patch.replanRequested !== 'boolean') throw new Error('重新规划标记无效');
      if (patch.notes !== undefined) job.notes = String(patch.notes || '').slice(0, 20000);
      if (patch.plan !== undefined) { if (!Array.isArray(patch.plan) || patch.plan.length > 20) throw new Error('恢复计划无效'); job.plan = structuredClone(patch.plan); }
      if (patch.workId !== undefined) job.workId = patch.workId ? String(patch.workId) : null;
      if (patch.workRevision !== undefined) { if (patch.workRevision !== null && (!Number.isSafeInteger(patch.workRevision) || patch.workRevision < 0)) throw new Error('核心任务版本无效'); job.workRevision = patch.workRevision; }
      if (patch.workStatus !== undefined) job.workStatus = String(patch.workStatus || '');
      if (patch.workInstructionVersion !== undefined) job.workInstructionVersion = patch.workInstructionVersion;
      if (patch.replanRequested !== undefined) job.replanRequested = patch.replanRequested;
      if (patch.artifacts !== undefined) { job.artifacts = structuredClone(patch.artifacts).slice(0, 100); job.runArtifacts = structuredClone(job.artifacts); }
      if (patch.executionStatus !== undefined) job.executionStatus = String(patch.executionStatus || '').slice(0, 100);
      if (patch.unresolvedSteps !== undefined) job.unresolvedSteps = structuredClone(patch.unresolvedSteps).slice(0, 40);
      job.checkpointAt = stamp(); emit(job);
      await persistNow();
      return view(job);
    };
    const api = {
      signal: state.controller.signal,
      runId: state.runId, runVersion: job.runVersion,
      saveCheckpoint,
      setWork: work => {
        const nextRevision = work?.revision ?? work?.cognition?.revision ?? null;
        const clearsReplan = job.replanRequested && work?.id === job.workId && nextRevision !== null && nextRevision > (job.workRevision ?? -1);
        return saveCheckpoint({ workId: work?.id || null, workRevision: nextRevision,
          workStatus: work?.status || '', workInstructionVersion: state.instructionVersion, ...(clearsReplan ? { replanRequested: false } : {}), ...(Array.isArray(work?.plan || work?.cognition?.plan) ? { plan: work.plan || work.cognition.plan } : {}) });
      },
      poll: () => state.inbox.splice(0),
      progress: step => {
        if (step.phase === 'started' || step.phase === 'running' || step.phase === 'model') {
          job.currentAction = { operation: String(step.operation || ''), label: String(step.label || step.operation || '').slice(0, 300), startedAt: stamp(), status: 'running' }; emit(job);
        } else if (step.phase === 'settled' && step.label) {
          job.steps++; job.currentAction = { ...job.currentAction, operation: String(step.operation || ''), label: String(step.label).slice(0, 300), finishedAt: stamp(), status: step.ok === false ? 'failed' : 'done', ...(step.error ? { error: String(step.error).slice(0, 300) } : {}) };
          log(job, 'step', step.label, { ok: step.ok !== false, ...(step.error ? { error: String(step.error).slice(0, 300) } : {}) }); emit(job);
        }
      },
      note: text => { log(job, 'agent', text); emit(job); },
      ask: request => new Promise(resolve => {
        const approvalId = randomUUID();
        const finish = decision => { clearTimeout(state.approval?.timer); state.approval = null; job.approval = null; if (job.status === 'waiting') job.status = 'running'; log(job, 'system', '你的回复：' + ({ once: '允许这一次', session: '本次任务内允许', always: '永久允许', deny: '拒绝' }[decision] || '拒绝')); emit(job); resolve(decision); };
        const timeout = setTimeout(() => { log(job, 'system', '等了 30 分钟没有收到确认，已按“拒绝”处理'); finish('deny'); }, approvalTimeoutMs); timeout.unref?.();
        state.approval = { resolve: finish, timer: timeout };
        job.status = 'waiting';
        job.approval = { id: approvalId, title: String(request.title || '需要确认').slice(0, 120), lines: (request.lines || []).map(line => String(line).slice(0, 600)).slice(0, 8), risk: request.risk || 'medium', allowSession: request.allowSession !== false, allowAlways: !!request.allowAlways, grantLabel: request.grantLabel || '', ...(request.nodeId ? { nodeId: request.nodeId, nodeLeaseId: request.nodeLeaseId } : {}) };
        log(job, 'system', '等待你确认：' + job.approval.title);
        emit(job);
        notify({ job: view(job), kind: 'approval' });
      }),
    };
    try {
      await persistNow();
      if (state.controller.signal.aborted) throw new Error('任务已停止');
      const outcome = await run(view(job), api);
      if (state.stopReason) throw Object.assign(new Error(state.stopReason), { stopped: true });
      job.executionStatus = String(outcome?.executionStatus || '');
      job.acceptance = { ...(outcome?.requirementsCheck ? { requirementsCheck: structuredClone(outcome.requirementsCheck) } : {}), passed: outcome?.subject?.passed === true, authority: String(outcome?.subject?.authority || ''), checkedAt: stamp(), unmet: Array.isArray(outcome?.subject?.unmet) ? outcome.subject.unmet.slice(0, 20) : [] };
      job.unresolvedSteps = Array.isArray(outcome?.unresolvedSteps) ? structuredClone(outcome.unresolvedSteps).slice(0, 40) : [];
      if (outcome?.ok === false) throw new Error(outcome.error || '任务执行失败');
      if (outcome?.executionStatus === 'incomplete' || job.unresolvedSteps.length) throw new Error('任务仍有未完成或未核对的操作，需要恢复核对');
      if (outcome?.subject?.passed === false) {
        job.error = (outcome.subject.unmet || ['任务结果没有通过核对']).join('；').slice(0, 500);
        job.status = 'unverified'; job.finishedAt = stamp(); log(job, 'agent', String(outcome.text || '').slice(0, 20000));
        notify({ job: view(job), kind: 'failed' });
        return;
      }
      job.result = String(outcome?.text || '').slice(0, 20_000);
      if (Array.isArray(outcome?.artifacts)) { job.artifacts = structuredClone(outcome.artifacts).slice(0, 100); job.runArtifacts = structuredClone(job.artifacts); }
      log(job, 'agent', job.result || '（没有文字结果）');
      job.finishedAt = stamp();
      archiveRun(job, 'done');
      if (job.repeat) { job.runAt = now() + REPEAT_MS[job.repeat]; job.status = 'scheduled'; log(job, 'system', '本次完成，下一次在 ' + new Date(job.runAt).toLocaleString('zh-CN', { hour12: false })); }
      else job.status = 'done';
      notify({ job: view(job), kind: 'done' });
    } catch (error) {
      job.finishedAt = stamp();
      job.errorCode = String(error.code || '').slice(0, 100); job.budgetKind = String(error.budgetKind || ''); job.retryableFailure = require('./router.cjs').isTransient(error);
      job.failure = require('./model-errors.cjs').failureDetails(error);
      if (job.currentAction && ['model', 'subject'].includes(job.currentAction.operation) && !state.stopReason) job.currentAction = { ...job.currentAction, status: 'failed', error: String(error.message).slice(0, 500), finishedAt: stamp() };
      if (Array.isArray(error.unresolvedSteps)) job.unresolvedSteps = structuredClone(error.unresolvedSteps).slice(0, 40);
      if (error.code === 'CORE_ACTION_UNCERTAIN') job.executionStatus = 'result_unknown';
      if (error.code === 'CORE_INPUT_CHANGED') { job.executionStatus = 'input_changed'; job.sourceChanges = structuredClone(error.sourceChanges || []); }
      if (state.stopReason === 'revise') { job.status = 'queued'; log(job, 'system', '已停止旧要求的运行，重新理解新要求并核对已有操作'); }
      else if (state.stopReason === 'pause') { job.status = 'paused'; log(job, 'system', '已暂停'); }
      else if (state.stopReason) { job.status = 'cancelled'; log(job, 'system', state.stopReason === 'cancel' ? '已取消' : state.stopReason); }
      else if (state.controller.signal.aborted) { job.status = 'cancelled'; log(job, 'system', '已停止'); }
      else { job.status = error.code === 'TOKEN_BUDGET_EXCEEDED' ? 'paused' : error.code === 'CORE_INPUT_CHANGED' ? 'unverified' : 'failed'; job.error = String(error.message).slice(0, 500); log(job, 'system', '失败：' + job.error); notify({ job: view(job), kind: 'failed' }); }
    } finally {
      clearTimeout(state.approval?.timer);
      live.delete(job.id);
      job.approval = null;
      if (job.currentAction?.status === 'running') job.currentAction = { ...job.currentAction, status: 'needs_recheck', finishedAt: stamp() };
      archiveRun(job, state.stopReason === 'revise' ? 'superseded' : job.status);
      emit(job);
      await persistNow().catch(() => {});
      pump();
      state.settled();
    }
  }

  function stopLive(id, reason) {
    const state = live.get(id);
    if (!state) return false;
    state.stopReason = reason;
    const job = need(id); job.stopRequested = reason; emit(job);
    void persistNow().catch(() => {});
    state.approval?.resolve('deny');
    state.controller.abort();
    return true;
  }

  async function tick() {
    let changed = false;
    for (const job of jobs) if (job.status === 'scheduled' && job.runAt && job.runAt <= now()) { job.status = 'queued'; job.runAt = null; log(job, 'system', '到时间了，加入队列'); emit(job); changed = true; }
    if (changed) pump();
  }

  return {
    init, create, list: () => jobs.map(view), get: id => { const job = find(id); return job ? view(job) : null; },
    startNow(id) { const job = need(id); if (job.status !== 'scheduled') throw new Error('只有等待中的定时任务可以立即开始'); job.status = 'queued'; job.runAt = null; log(job, 'system', '提前开始'); emit(job); pump(); return view(job); },
    pause(id) { const job = need(id); if (!stopLive(id, 'pause')) { if (job.status === 'queued' || job.status === 'scheduled') { job.status = 'paused'; job.runAt = null; log(job, 'system', '已暂停'); emit(job); } else throw new Error('这个任务现在不能暂停'); } return view(job); },
    resume(id) {
      const job = need(id);
      if (!['paused', 'interrupted', 'failed', 'cancelled', 'unverified'].includes(job.status)) throw new Error('这个任务不需要继续');
      if (job.executionStatus === 'input_changed') { job.replanRequested = true; log(job, 'system', '按最新资料重新规划并核对'); }
      job.status = 'queued'; job.runAt = null; log(job, 'system', '继续'); emit(job); pump(); return view(job);
    },
    cancel(id) { const job = need(id); if (!stopLive(id, 'cancel')) { if (ACTIVE.has(job.status) || ['scheduled', 'paused', 'interrupted'].includes(job.status)) { job.status = 'cancelled'; job.runAt = null; job.finishedAt = stamp(); log(job, 'system', '已取消'); emit(job); } } return view(job); },
    remove(id) { const job = need(id); if (live.has(id)) throw new Error('请先取消正在运行的任务'); jobs = jobs.filter(item => item !== job); schedulePersist(); onChange({ id, removed: true }); },
    // A changed requirement invalidates the old run's acceptance criteria. Stop it
    // before dispatching another step, then reinterpret the same canonical work.
    updateAutomation(id, automation, profile) {
      const job = need(id);
      if (live.has(id) || !job.automation || automation.goalId !== job.automation.goalId) throw new Error('当前任务不能修改长期目标身份');
      job.automation = structuredClone(automation); job.profile = profile; emit(job);
    },
    addInstruction(id, text, { queue = true } = {}) {
      const job = need(id);
      const value = String(text || '').trim().slice(0, 4000);
      if (!value) throw new Error('请输入要补充的内容');
      log(job, 'user', value);
      job.instructionVersion++;
      const state = live.get(id);
      if (state) { log(job, 'system', '要求已更新，正在停止当前运行以重新规划'); stopLive(id, 'revise'); }
      else if (queue && ['done', 'failed', 'cancelled', 'unverified'].includes(job.status)) { job.status = 'queued'; log(job, 'system', '根据你的补充重新开始'); }
      emit(job); pump();
      return view(job);
    },
    resolveApproval(id, decision, approvalId) {
      const state = live.get(id);
      if (!state?.approval) throw new Error('这个任务现在没有待确认的事项');
      if (approvalId !== undefined && need(id).approval?.id !== approvalId) throw new Error('这项确认已经结束或发生变化，请重新查看当前任务');
      state.approval.resolve(['once', 'session', 'always', 'deny'].includes(decision) ? decision : 'deny');
    },
    async pauseAll() {
      const running = [...live.values()].map(state => state.completed);
      for (const job of jobs) {
        if (stopLive(job.id, 'pause')) continue;
        if (job.status === 'queued' || job.status === 'scheduled') { job.status = 'paused'; job.runAt = null; log(job, 'system', '助手停止后台执行，任务已暂停'); emit(job); }
      }
      await Promise.all(running); await persistNow();
    },
    stopAll(reason = '已全部停止') { let count = 0; for (const id of [...live.keys()]) if (stopLive(id, reason)) count++; return count; },
    counts: () => ({ running: live.size, waiting: jobs.filter(item => item.status === 'waiting').length, scheduled: jobs.filter(item => item.status === 'scheduled').length }),
    tick, flush: () => persistNow(), stop() { clearInterval(timer); },
  };
}

module.exports = { createJobs, REPEAT_MS };
