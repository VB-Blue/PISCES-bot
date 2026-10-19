// PISCES AI主体: owns each piece of work from request to verified result. It decides what to do; the LLM is one of its
// tools (to parse a request, propose a plan, act in an unfamiliar interface, judge what code cannot check).
// What it learns — which route works for which kind of task, which software skills exist — moves recurring work
// from "ask the model" to "do it locally".
const fs = require('node:fs/promises');
const path = require('node:path');
const cognition = require('./cognition.cjs');
const { normalizePlan } = require('./plan.cjs');
const { extractDocument } = require('../attachments.cjs');
const { snapshotFile, compareFiles } = require('../file-state.cjs');
const { executeNodeGraph, scopeNodeTools, canResumeWebRead } = require('./node-execution.cjs');
const { evidencePointer, readBrowserEvidence } = require('../browser-evidence.cjs');

const ACTION_WORDS = /打开|整理|写|做|生成|修|改|发|下载|保存|查|搜|找|删|创建|安装|运行|帮我|给我|把|算|翻译|总结|汇总|列|画|设置|提醒|安排|处理|上传|导出|转换|录|拍|剪|编辑/;
const CONTROL_TOOLS = new Set(['observe', 'click', 'type_text', 'press_keys', 'scroll', 'drag', 'click_text']);
const usable = skill => !((skill.failures || 0) >= 3 && (skill.failures || 0) > (skill.successes || 0) * 2);
const normalize = text => String(text || '').toLowerCase().replace(/\s+/g, '');

function createExecutive({ store, memory, runAssistant, getRoots = () => [], similarity }) {
  // ---- what the subject knows before asking anyone ----
  // The core assembles related memories when it is linked; a plain memory object assembles them locally.
  const relatedMemories = async request => (memory.prepareContext ? await memory.prepareContext(request, {}) : memory.buildContext(request, {})).text.slice(0, 4000);
  async function contextFor({ request, messages, tools, attachments = '', sourceChanges = [], intent = null }) {
    const skills = memory.listSkills().filter(usable).slice(0, 30).map(item => ({ id: item.id, title: item.title, kind: item.trigger, app: item.app, params: item.params.map(param => param.name) }));
    return {
      now: new Date().toLocaleString('zh-CN', { hour12: false, weekday: 'long' }),
      user_profile: memory.getProfile() || '（还不了解）',
      related_memories: await relatedMemories(request),
      long_term_requirements: memory.requirementSnapshot?.({ request, messages, intent }).rules || [],
      requirement_scopes: memory.listRequirements?.().filter(item => item.enabled && item.scope).map(item => ({ id: item.id, domain: item.domain, scope: item.scope })) || [],
      recent_conversation: messages.slice(-7, -1).map(item => ({ role: item.role, content: String(item.content || '').slice(0, 500) })),
      saved_software_skills: skills,
      folders: tools.roots ? { authorized: getRoots() } : undefined,
      attachments_this_turn: attachments || '无',
      note: '如果有对得上的软件技能，params 请使用技能的参数名。用户附带了文件或图片时，“这张图/这个文件”指的就是它们，直接用给出的路径。',
      ...(store.contextFor?.() || {}),
      ...(sourceChanges.length ? { observed_source_changes: sourceChanges } : {}),
    };
  }

  function pickSkill(intent) {
    let best = null, score = 0;
    for (const skill of memory.listSkills().filter(usable)) {
      let value = Math.max(similarity(intent.kind + ' ' + intent.goal, skill.title + ' ' + skill.trigger), similarity(intent.kind, skill.trigger || skill.title));
      if (skill.app && intent.apps.some(app => normalize(skill.app).includes(normalize(app)) || normalize(app).includes(normalize(skill.app)))) value += 0.2;
      if (value > score) { score = value; best = skill; }
    }
    if (!best || score < 0.45) return null;
    // Every parameter must come from this request; replaying last time's values would do the wrong job.
    if (best.params.some(param => intent.params[param.name] === undefined)) return null;
    return best;
  }

  // ---- checks the subject can do itself, without trusting anyone's report ----
  async function recentFiles(since) {
    const found = [];
    let visited = 0;
    async function walk(dir, depth) {
      if (depth > 3 || found.length > 400 || visited > 20000) return;
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (++visited > 20000) return;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else { try { const info = await fs.stat(full); if (info.mtimeMs >= since - 2000) found.push(full); } catch {} }
      }
    }
    for (const root of getRoots()) await walk(root, 0);
    return found;
  }
  // Word and PDF files are checked by their body text, not their zipped or binary bytes.
  async function readText(file) {
    if (/\.(docx|pdf)$/i.test(file)) return (await extractDocument(path.basename(file), await fs.readFile(file))).text;
    return fs.readFile(file, 'utf8');
  }
  async function checkCriteria(criteria, { answer, since, trace = [] }) {
    const results = [];
    let files = null;
    for (const item of criteria) {
      if (item.check === 'tool_succeeded') {
        let receipt;
        for (const entry of trace) {
          if (entry.ok !== true || entry.tool !== item.target || entry.tool === 'update_plan') continue;
          const browser = entry.browser_evidence ? await readBrowserEvidence(entry.browser_evidence) : null;
          if (entry.browser_evidence && !browser) continue;
          if (!item.value || normalize(browser ? JSON.stringify(browser) : entry.result).includes(normalize(item.value))) { receipt = entry; break; }
        }
        results.push({ ...item, passed: !!receipt, how: receipt ? '本节点的实际工具回执已通过核对' : '没有找到本节点的成功工具回执' }); continue;
      }
      if (item.check === 'answer_contains') { results.push({ ...item, passed: normalize(answer).includes(normalize(item.value)), how: '核对回答内容' }); continue; }
      if (item.check === 'file_exists' || item.check === 'file_contains') {
        const targetPath = String(item.target || '');
        const name = path.basename(targetPath).toLowerCase();
        let matches = [];
        if (path.isAbsolute(targetPath)) {
          const inside = (file, root) => { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
          const authorized = getRoots().filter(root => inside(targetPath, root));
          if (authorized.length) {
            try {
              const realFile = await fs.realpath(targetPath);
              const realRoots = await Promise.all(authorized.map(root => fs.realpath(root).catch(() => path.resolve(root))));
              const info = await fs.stat(realFile);
              if (realRoots.some(root => inside(realFile, root)) && info.isFile() && info.mtimeMs >= since - 2000) matches = [path.resolve(targetPath)];
            } catch { /* A missing or inaccessible expected file fails verification. */ }
          }
        } else {
          files ||= await recentFiles(since);
          matches = files.filter(file => targetPath && path.basename(file).toLowerCase() === name);
        }
        if (item.check === 'file_exists') { results.push({ ...item, passed: matches.length > 0, how: matches.length ? '找到新文件：' + matches[0] : '本次任务期间没有出现这个文件', file: matches[0] }); continue; }
        let hit = null;
        for (const file of matches) { try { const text = await readText(file); if (normalize(text).includes(normalize(item.value))) { hit = file; break; } } catch {} }
        // Binary documents (docx, images) cannot be read here; leave them to judgement rather than failing them.
        if (!hit && matches.some(file => !/\.(txt|md|csv|json|html?|xml|log|docx|pdf)$/i.test(file))) { results.push({ ...item, passed: null, how: '文件不是纯文本，需要判断', file: matches[0] }); continue; }
        results.push({ ...item, passed: !!hit, how: hit ? '文件里有这段内容：' + hit : matches.length ? '文件里没有找到“' + item.value + '”' : '没有找到对应的新文件', file: hit || matches[0] });
        continue;
      }
      results.push({ ...item, passed: null, how: '需要判断' });
    }
    return results;
  }
  async function verify({ target, intent, answer, trace, since, signal, counter, reviewRequirements = null }) {
    const checks = await checkCriteria(intent.done_criteria, { answer, since, trace });
    const open = checks.filter(item => item.passed === null);
    let judged = null;
    if (open.length) {
      const files = [];
      for (const item of checks) if (item.file) { try { files.push({ path: item.file, head: (await readText(item.file)).slice(0, 2000) }); } catch {} }
      counter.calls++;
      judged = await cognition.verify({ target, criteria: open, evidence: { goal: intent.goal, final_answer: String(answer).slice(0, 4000), tool_calls: trace.slice(-40).map(item => ({ tool: item.tool, ok: item.ok, args: String(item.args).slice(0, 200), result: String(item.result).slice(0, 200) })), files }, signal }).catch(error => ({ passed: false, unmet: open.map(item => item.value || item.check), reason: '无法判断：' + error.message }));
      for (const item of open) item.passed = judged.passed && !judged.unmet.some(text => String(text).includes(item.value || item.check));
    }
    const requirements = await reviewRequirements?.({ intent, answer, trace });
    if (requirements) checks.push(...requirements.checks.map(item => ({ check: 'requirement', id: item.id, revision: item.revision, value: item.text.slice(0, 200), passed: item.status === 'passed', how: item.reason, source: item.source })));
    const unmet = checks.filter(item => !item.passed);
    return { passed: unmet.length === 0, checks, unmet: unmet.map(item => describeCriterion(item) + (item.how ? '（' + item.how + '）' : '')), judged, requirements };
  }
  const describeCriterion = item => ({ file_exists: '存在文件 ' + item.target, file_contains: (item.target || '文件') + ' 里有“' + item.value + '”', answer_contains: '回答里有“' + item.value + '”', window_shows: (item.target || '窗口') + ' 显示“' + item.value + '”', tool_succeeded: '已执行 ' + item.target + (item.value ? ' 并返回“' + item.value + '”' : ''), judgement: item.value, requirement: '长期要求：' + item.value })[item.check] || item.check;

  // ---- one piece of work, start to finish ----
  async function handle({ target, request, session = '', messages, tools, signal, agent, progress = () => {}, onPlan = null, background = false, attachments = '', forceTask = false }) {
    const started = Date.now();
    const counter = { calls: 0 };
    const contextSignature = JSON.stringify({ profile: memory.getProfile(), explicit: memory.listMemories().filter(item => item.source === 'user' || item.source === 'feedback').map(item => [item.id, item.text]), requirements: memory.listRequirements?.().map(item => [item.id, item.revision, item.enabled]) || [] });
    const say = label => progress({ phase: 'settled', operation: 'subject', label, ok: true });
    const runAgent = async (extra, plain = false, maxTurns = agent.maxTurns, overrides = {}) => {
      const durable = store.contextFor?.();
      const result = await runAssistant({ ...agent, maxTurns, requirementContext: agent.resolveRequirements?.(intent) ?? agent.requirementContext, memoryContext: [agent.memoryContext, durable ? '核心保存的当前上下文（认识候选不是已确认事实）：' + JSON.stringify(durable) : '', extra].filter(Boolean).join('\n\n'), background, ...(plain ? {} : { onPlan: plan => onPlan?.(plan) }), ...overrides });
      counter.calls += result.modelCalls || 0;
      return result;
    };

    // 1. Understand — locally if this exact kind of request already succeeded before, otherwise ask the model.
    let intent = null, localUnderstanding = false;
    forceTask ||= background;
    const looksLikeChat = !forceTask && /^(你好|嗨|hi|hello|早上好|晚上好|谢谢|好的|收到)[.!！?？。]*$/i.test(request.trim());
    const candidate = looksLikeChat || attachments || agent.replanRequested ? null : store.similarSuccess(request);
    const known = candidate?.experience.contextSignature === contextSignature ? candidate : null;
    if (looksLikeChat) intent = { type: 'chat', goal: request, kind: '聊天', done_criteria: [], apps: [], params: {}, steps: 'one', ask: null, assumptions: [] };
    else if (known) { intent = { ...known.experience.intent }; localUnderstanding = true; say('认出这件事：以前做成过「' + intent.goal.slice(0, 40) + '」'); }
    else {
      try { counter.calls++; intent = (await cognition.understand({ target, request, context: await contextFor({ request, messages, tools, attachments, sourceChanges: agent.sourceChanges }), signal, forceTask })).intent; }
      catch (error) {
        if (signal?.aborted || forceTask) throw error;
        // Without a usable understanding the subject still answers, as a plain conversation.
        const result = await runAgent('', true);
        return { ...result, subject: { route: 'fallback', reason: error.message, modelCalls: counter.calls } };
      }
    }

    await store.acceptUnderstanding?.(intent);
    if (agent.resolveRequirements) agent.requirementContext = agent.resolveRequirements(intent);
    if (agent.routeTask) {
      Object.assign(agent, await agent.routeTask(intent));
      Object.assign(target, { settings: agent.settings, apiKey: agent.apiKey });
    }
    if (intent.ask) {
      await store.recordExperience({ request, kind: intent.kind, intent, route: 'ask', passed: null, modelCalls: counter.calls, localUnderstanding });
      return { text: intent.ask, trace: [], usage: null, modelCalls: counter.calls, subject: { route: 'ask', intent, passed: false, unmet: ['需要补充：' + intent.ask] } };
    }
    if (intent.type === 'chat') {
      const result = await runAgent('', true);
      return { ...result, modelCalls: counter.calls, subject: { route: 'chat', intent, localUnderstanding } };
    }

    // 2. A task: the subject owns it.
    const task = await store.createTask({ request, session, intent });
    say('任务：' + intent.goal.slice(0, 60) + '（完成标准 ' + intent.done_criteria.length + ' 条）');
    // The subject sets the executor's budget from the size of the job, so it delivers instead of researching forever.
    const budget = { one: 15, few: 35, many: 70 }[intent.steps] || 35;
    const brief = () => '## PISCES AI交给你的任务\n目标：' + intent.goal + '\n交付物：' + intent.deliverable + '\n完成标准：\n' + intent.done_criteria.map(item => '- ' + describeCriterion(item)).join('\n') + (intent.assumptions.length ? '\n已做的假设：' + intent.assumptions.join('；') : '') + (Object.keys(intent.params).length ? '\n具体值：' + JSON.stringify(intent.params) : '') + '\n预算：这件事最多约 ' + budget + ' 轮工具调用。素材够用就开始产出交付物，先交付一个完整可用的版本，再用剩余预算补充；不要无止境地搜索或反复核实同一件事。\n你是执行者：直接动手完成，用 update_plan 跟进计划；完成后简要说明做了什么、结果在哪。PISCES AI会按完成标准核对你的结果。';

    const nodeMode = forceTask && intent.steps !== 'one';
    const nodeCriteria = node => {
      const criteria = node.criteria?.length ? structuredClone(node.criteria) : [{ check: 'judgement', value: node.expect || node.do }];
      for (const output of node.outputs || []) if ((path.isAbsolute(output) || /\.(md|txt|docx|pdf|csv|xlsx|pptx|json|html?|svg|png)$/i.test(output)) && !criteria.some(item => item.target === output && ['file_exists', 'file_contains'].includes(item.check))) criteria.push({ check: 'file_exists', target: output });
      return criteria;
    };
    let nodePublications = Promise.resolve();
    const publishNodes = nodes => {
      const snapshot = structuredClone(nodes);
      nodePublications = nodePublications.then(async () => {
        await store.updateTask(task, { plan: snapshot });
        await onPlan?.(structuredClone(task.plan));
      });
      return nodePublications;
    };
    async function executeNodes() {
      let nodes = normalizePlan(task.plan, [], { trustedRuntime: true });
      const invalid = new Set();
      const sourceChanges = [];
      const reconcileReadChecks = async (node, checks) => {
        for (const check of checks) if (check.check === 'tool_succeeded' && check.target === 'read_text') {
          for (const proof of node.evidence?.read_proofs || []) {
            if (!/^[a-f\d-]{36}$/i.test(proof.receiptId || '') || !['observed_success', 'verified'].includes(proof.status) || !Array.isArray(proof.matches) || !proof.matches.some(item => item.target === check.target && (item.value || '') === (check.value || ''))) continue;
            if (!(await compareFiles([proof.file_state], getRoots())).length) { check.passed = true; check.how = '已保存的实际读取回执与当前文件内容指纹一致'; break; }
          }
        }
        return checks;
      };
      const reconcileBrowserChecks = async (node, checks) => {
        for (const check of checks) if (check.check === 'tool_succeeded' && check.target?.startsWith('browser_')) {
          for (const proof of node.evidence?.browser_proofs || []) {
            if (proof.tool !== check.target || proof.nodeId !== node.id || !/^[a-f\d-]{36}$/i.test(proof.receiptId || '') || !['observed_success', 'verified'].includes(proof.status)) continue;
            const observed = await readBrowserEvidence(proof.browser_evidence);
            if (observed && (!check.value || normalize(JSON.stringify(observed)).includes(normalize(check.value)))) { check.passed = true; check.how = '已保存的实际网页回执与完整内容校验一致'; break; }
          }
        }
        return checks;
      };
      // A persisted completion is reusable only after this run independently reads it back.
      for (const node of nodes) {
        if (['unknown', 'needs_recheck', 'doing'].includes(node.runtime_status)) {
          const prior = node.execution_state, proofs = node.evidence?.read_proofs || [];
          if (canResumeWebRead(node, nodes)) {
            node.status = 'pending'; node.runtime_status = 'pending';
            node.verification = { passed: false, reason: '上次分工仅包含只读查询，恢复后重新读取最新资料' };
            node.evidence = { ...node.evidence, recovery: { kind: 'read_only_web_resume', priorLeaseId: prior.lease_id } };
            continue;
          }
          const onlyRead = node.execution?.mode === 'parallel' && Array.isArray(prior?.effects) && !prior.effects.length && proofs.length && proofs.every(proof => proof.nodeId === node.id && proof.nodeLeaseId === prior.lease_id && /^[a-f\d-]{36}$/i.test(proof.receiptId || '') && ['observed_success','verified'].includes(proof.status));
          if (onlyRead) {
            const changes = await compareFiles(proofs.map(proof => proof.file_state), getRoots());
            if (changes.length) { sourceChanges.push(...changes); invalid.add(node.id); }
            node.status = 'pending'; node.runtime_status = 'pending'; node.verification = { passed: false, reason: '上次只执行了读取，当前来源已核对，使用新的执行身份接续' };
            node.evidence = { ...node.evidence, recovery: { kind: 'read_only_resume', priorLeaseId: prior.lease_id } };
            continue;
          }
          const criteria = nodeCriteria(node);
          const checks = await reconcileReadChecks(node, await checkCriteria(criteria, { answer: node.evidence?.answer || '', since: 0 }));
          const unsafeUnknown = node.evidence?.unresolvedSteps?.some(item => !['read_text', 'write_text', 'write_document'].includes(item.operation));
          const recoverable = !unsafeUnknown && checks.length > 0 && checks.every(item => item.passed === true) && checks.some(item => ['file_exists', 'file_contains'].includes(item.check) || (item.target === 'read_text' && item.how === '已保存的实际读取回执与当前文件内容指纹一致'));
          if (!recoverable) {
            node.status = 'blocked'; node.runtime_status = 'unknown';
            node.verification = { passed: false, reason: '上次运行结果未知，当前证据不足，禁止自动重放' };
            await publishNodes(nodes);
            const error = new Error(node.text + '：上次操作结果未知，必须先观察核对，不能自动重做');
            error.code = 'CORE_ACTION_UNCERTAIN'; error.unresolvedSteps = node.evidence?.unresolvedSteps || [{ operation: node.id, status: 'unknown' }]; throw error;
          }
          node.runtime_status = 'done'; node.status = 'done';
          node.verification = { passed: true, checkedAt: new Date().toISOString(), checks, revalidated: true, recoveredUnknown: true };
        }
        if (node.verification?.passed && node.runtime_status === 'done') {
          const changedFiles = await compareFiles([...(node.evidence?.file_inputs || []), ...(node.evidence?.file_outputs || [])], getRoots());
          const fileStep = nodeCriteria(node).some(item => ['file_exists', 'file_contains'].includes(item.check) || (item.check === 'tool_succeeded' && ['read_text', 'write_text', 'write_document'].includes(item.target))) || node.evidence?.tool_receipts?.some(item => ['read_text', 'write_text', 'write_document'].includes(item.tool));
          if (fileStep && !Array.isArray(node.evidence?.file_inputs) && !Array.isArray(node.evidence?.file_outputs)) changedFiles.push({ path: nodeCriteria(node).find(item => item.target && item.check.startsWith('file_'))?.target || node.text, reason: '历史步骤没有文件来源指纹，需要按最新资料重新规划' });
          if (changedFiles.length) { sourceChanges.push(...changedFiles); invalid.add(node.id); }
          const checks = await reconcileBrowserChecks(node, await reconcileReadChecks(node, await checkCriteria(nodeCriteria(node), { answer: node.evidence?.answer || '', since: 0 })));
          const reusable = checks.length > 0 && checks.every(item => item.passed === true);
          node.verification = { ...node.verification, passed: reusable, checkedAt: new Date().toISOString(), checks, revalidated: reusable };
          if (!reusable) invalid.add(node.id);
        }
      }
      let changed;
      do {
        changed = false;
        for (const node of nodes) if (!invalid.has(node.id) && node.depends_on.some(id => invalid.has(id))) { invalid.add(node.id); changed = true; }
      } while (changed);
      if (sourceChanges.length) {
        for (const node of nodes) if (invalid.has(node.id)) {
          node.status = 'blocked'; node.runtime_status = 'blocked';
          node.verification = { passed: false, reason: '来源或产物内容发生变化，原节点与下游结果不能直接复用', changedFiles: sourceChanges };
        }
        await publishNodes(nodes);
        const error = new Error('来源或产物需要重新核对，相关步骤和下游结果已失效。请按最新资料重新规划：' + [...new Set(sourceChanges.map(item => item.path))].join('；'));
        error.code = 'CORE_INPUT_CHANGED'; error.sourceChanges = sourceChanges; throw error;
      }
      for (const node of nodes) {
        if (invalid.has(node.id) || node.verification?.passed !== true) { node.status = 'pending'; node.runtime_status = 'pending'; node.verification = { passed: false, reason: invalid.has(node.id) ? '恢复时没有通过重新核对，关联后续步骤需要重做' : '等待主任务验收' }; }
        else { node.status = 'done'; node.runtime_status = 'done'; }
      }
      await publishNodes(nodes);
      const executed = await executeNodeGraph({ nodes, revision: task.revision ?? 0, signal, maxParallel: agent.nodeParallelism ?? 2,
        persist: publishNodes, current: () => task.plan, currentRevision: () => task.revision ?? 0,
        run: async (node, lease) => {
        const selected = await agent.forNode?.(node) || {};
        const chosen = { ...agent, ...selected };
        await lease.update({ service: chosen.primaryName || '', model: chosen.settings?.model || '' });
        const observedInputs = [];
        const readProofs = [];
        const writeProofs = [];
        const browserProofs = [...(node.evidence?.browser_proofs || [])];
        const capture = async event => {
          lease.assertActive();
          if (event.ok && event.operation.startsWith('browser_')) {
            const pointer = evidencePointer(event.result);
            if (pointer) {
              browserProofs.push({ tool: event.operation, browser_evidence: pointer, receiptId: event.receipt?.id || '', status: event.receipt?.status || '', nodeId: node.id, nodeLeaseId: lease.id });
              node.evidence = { ...node.evidence, browser_proofs: structuredClone(browserProofs.slice(-40)) }; await publishNodes(nodes); lease.assertActive();
            }
          }
          if (event.ok && ['write_text','write_document','edit_text'].includes(event.operation)) {
            let written = null; try { written = await snapshotFile(event.args.path, getRoots()); } catch {}
            writeProofs.push({ receiptId: event.receipt?.id || '', status: event.receipt?.status || '', path: event.args.path, file_state: written, nodeId: node.id, nodeLeaseId: lease.id });
            node.evidence = { ...node.evidence, write_proofs: structuredClone(writeProofs), file_outputs: writeProofs.map(proof => proof.file_state).filter(Boolean) }; await publishNodes(nodes);
          }
          if (event.ok !== true || event.operation !== 'read_text' || !event.file_state) return;
          observedInputs.push(structuredClone(event.file_state));
          if (event.receipt?.id) readProofs.push({ receiptId: event.receipt.id, status: event.receipt.status, nodeId: node.id, nodeLeaseId: lease.id, file_state: structuredClone(event.file_state), matches: nodeCriteria(node).filter(item => item.check === 'tool_succeeded' && item.target === 'read_text' && (!item.value || normalize(event.result.text || '').includes(normalize(item.value)))) });
          node.evidence = { ...node.evidence, file_inputs: structuredClone(observedInputs), read_proofs: structuredClone(readProofs) };
          await publishNodes(nodes); lease.assertActive();
        };
        const inputs = nodes.filter(item => node.depends_on.includes(item.id)).map(item => ({ id: item.id, outputs: item.outputs, evidence: item.evidence }));
        const criteria = nodeCriteria(node), nodeStarted = Date.now();
        say('执行步骤：' + node.text);
          const nodeBrief = brief() + '\n\n当前只执行节点 ' + node.id + '：' + node.do + '\n当前分工：' + node.role + '\n该节点验收：' + JSON.stringify(criteria) + '\n允许的来源：' + JSON.stringify(node.inputs || []) + '\n预期产物：' + JSON.stringify(node.outputs) + '\n已验收的前置产物：' + JSON.stringify(inputs).slice(0, 12000) + '\n不要替其他节点执行动作或自行宣布整个任务完成；先核对已有文件和软件状态，避免重放已生效的操作。';
          const nodeCore = body => chosen.core(body.action === 'reserve_call' && body.role === 'executor' ? { ...body, role: node.role || 'executor' } : body);
          const scoped = scopeNodeTools(chosen.localTools, node, nodes, lease);
          const nodeResult = await runAgent(nodeBrief, false, Math.max(6, Math.floor(budget / Math.max(nodes.length, 1))), {
            ...selected, core: nodeCore, signal: lease.signal, localTools: scoped, onToolResult: capture, modelProgress: true,
            memoryContext: [agent.memoryContext, nodeBrief].filter(Boolean).join('\n\n'),
            messages: [{ role: 'user', content: nodeBrief }], userText: node.do, pollInput: null, notes: node.execution_state?.notes || '',
            onCompact: summary => lease.update({ notes: String(summary).slice(0, 20000) }),
            progress: event => { const pending = (async () => {
              lease.assertActive();
              if (['started', 'running', 'model', 'settled'].includes(event.phase)) await lease.update({ current_action: { operation: event.operation || '', label: String(event.label || event.operation || '').slice(0, 300), status: event.phase !== 'settled' ? 'running' : event.ok === false ? 'failed' : 'done' } });
              progress({ ...event, nodeId: node.id, nodeLeaseId: lease.id });
            })(); pending.catch(() => {}); return pending; },
          });
          lease.assertActive();
          const nodeTrace = (nodeResult.trace || []).map(item => ({ ...item, nodeId: node.id, nodeLeaseId: lease.id }));
          const fileChecks = await checkCriteria(criteria.filter(item => ['file_exists', 'file_contains'].includes(item.check)), { answer: nodeResult.text, trace: nodeTrace, since: nodeStarted });
          const outputPaths = [...new Set(fileChecks.filter(item => item.file).map(item => item.file).concat((node.outputs || []).filter(file => path.isAbsolute(file))))];
          const fileOutputs = [];
          for (const file of outputPaths) { try { fileOutputs.push(await snapshotFile(file, getRoots())); } catch { /* absent or inaccessible outputs cannot become a snapshot */ } }
          let checked;
          if (nodeResult.executionStatus === 'incomplete' || nodeResult.unresolvedSteps?.length) checked = { passed: false, checks: [], unmet: ['当前节点仍有未完成的工具操作'] };
          else checked = await verify({ target, intent: { ...intent, done_criteria: criteria }, answer: nodeResult.text, trace: nodeTrace, since: nodeStarted, signal: lease.signal, counter });
          if (node.execution?.mode === 'parallel' && node.execution.tools.some(name => ['write_text','write_document','edit_text'].includes(name)) && node.outputs.some(file => !writeProofs.some(proof => proof.path === file && /^[a-f\d-]{36}$/i.test(proof.receiptId) && ['observed_success','verified'].includes(proof.status)))) checked = { ...checked, passed: false, unmet: [...checked.unmet, '当前分工缺少对应产物的实际写入回执'] };
          const fileInputs = nodeTrace.filter(item => item.ok && item.tool === 'read_text' && item.file_state).map(item => item.file_state);
          const changedInputs = await compareFiles([...fileInputs, ...fileOutputs], getRoots());
          if (changedInputs.length) {
            const error = new Error('执行期间来源发生变化，当前结果需要重新规划和核对'); error.code = 'CORE_INPUT_CHANGED'; error.sourceChanges = changedInputs; throw error;
          }
          // A semantic judgement cannot turn an unsupported executor claim into completion.
          if (checked.passed && criteria.some(item => ['judgement', 'window_shows'].includes(item.check)) && !nodeTrace.some(item => item.ok && item.tool !== 'update_plan') && !checked.checks.some(item => ['file_exists', 'file_contains'].includes(item.check) && item.passed)) checked = { ...checked, passed: false, unmet: ['节点没有真实工具观察或文件证据，不能只凭执行者声称完成'] };
          store.refreshTask?.(task);
          lease.assertActive();
          const committed = task.plan.find(item => item.id === node.id);
          if (committed.do !== node.do || JSON.stringify(nodeCriteria(committed)) !== JSON.stringify(criteria)) throw new Error('执行中的节点验收契约已经改变，旧结果不能提交为新节点完成');
          return { result: { ...nodeResult, trace: nodeTrace }, verification: { ...checked, checkedAt: new Date().toISOString(), criteria, revalidated: false },
            evidence: { ...node.evidence, answer: String(nodeResult.text || '').slice(0, 4000), tool_receipts: nodeTrace.slice(-30).map(item => ({ tool: item.tool, ok: item.ok, result: String(item.result || '').slice(0, 600), ...(item.browser_evidence ? { browser_evidence: item.browser_evidence } : {}) })), files: checked.checks.filter(item => item.file).map(item => item.file), file_inputs: fileInputs, file_outputs: fileOutputs, read_proofs: readProofs, write_proofs: writeProofs, browser_proofs: browserProofs.slice(-40) } };
        },
      });
      return { ...executed, reused: nodes.some(node => node.verification?.revalidated) };
    }

    let route = '', result = null, trace = [], skillUsed = null, outcome = null, failure = null, steps = [];
    // 3. Prefer a saved software skill: replayed locally, step by step, with no model call.
    const skill = pickSkill(intent);
    if (skill) {
      route = 'skill'; skillUsed = skill;
      say('用已学会的软件技能「' + skill.title + '」在本地执行');
      try {
        const ran = await tools.execute('run_skill', { id: skill.id, params: Object.fromEntries(skill.params.map(param => [param.name, intent.params[param.name]])) }, { signal, ask: agent.askTool, session, turn: task.id, userText: request, progress, actor: agent.actor });
        trace.push({ tool: 'run_skill', args: JSON.stringify({ id: skill.id }), ok: ran.ok, result: JSON.stringify({ ok: ran.ok, stuck_at: ran.stuck_at, error: ran.error }).slice(0, 400) });
        result = { text: ran.ok ? '已用软件技能「' + skill.title + '」完成。' : '', trace: [] };
        if (!ran.ok) failure = '软件技能「' + skill.title + '」' + ran.stuck_at + '：' + ran.error;
      } catch (error) { if (signal?.aborted || ['CORE_ACTION_UNCERTAIN', 'CORE_AUTHORITY_LOST', 'CHECKPOINT_PERSIST_FAILED'].includes(error.code)) throw error; failure = '软件技能「' + skill.title + '」无法运行：' + error.message; }
      if (!failure) {
        outcome = await verify({ target, intent, answer: result.text, trace, since: started, signal, counter, reviewRequirements: agent.checkRequirements });
        if (!outcome.passed) failure = '技能执行完了，但没有达到：' + outcome.unmet.join('；');
      }
      if (failure) say('技能没能完成，改用规划执行：' + failure.slice(0, 80));
    }

    // 4. Otherwise (or when the skill fell short): plan if needed, hand execution to the LLM executor, verify, retry once.
    for (let attempt = 0; (!outcome || !outcome.passed) && attempt < 2; attempt++) {
      if (signal?.aborted) throw new Error('任务已停止');
      route = route === 'skill' ? 'skill+plan' : intent.steps === 'one' && !failure ? 'direct' : 'plan';
      if (route !== 'direct' && !(nodeMode && attempt === 0 && task.plan?.length)) {
        try {
          counter.calls++;
          steps = normalizePlan((await cognition.plan({ target, intent, context: { ...(await contextFor({ request, messages, tools, attachments, intent })), what_has_worked_for_this_kind: store.routeStats(intent.kind) }, failure, signal })).steps, task.plan);
        } catch (error) { if (signal?.aborted || nodeMode || ['CORE_ACTION_UNCERTAIN', 'CORE_AUTHORITY_LOST', 'CHECKPOINT_PERSIST_FAILED'].includes(error.code)) throw error; steps = []; }
        if (steps.length) {
          // Execution may degrade when the planner is unavailable. Losing task authority may not.
          await store.updateTask(task, { plan: steps });
          await onPlan?.(task.plan);
          say((attempt ? '重新规划' : '制定计划') + '：' + steps.length + ' 步');
        }
      }
      const planText = steps.length ? '\n计划（PISCES AI审核过，可按实际情况微调）：\n' + steps.map((step, index) => (index + 1) + '. ' + step.do + (step.expect ? '（完成后应看到：' + step.expect + '）' : '')).join('\n') : '';
      if (nodeMode && task.plan?.length) {
        route = 'plan_nodes';
        const executed = await executeNodes(); result = executed.result; trace.push(...executed.trace);
        outcome = executed.failure ? { passed: false, checks: [], unmet: [executed.failure] } : await verify({ target, intent, answer: result.text, trace, since: executed.reused ? 0 : started, signal, counter, reviewRequirements: agent.checkRequirements });
      } else {
        result = await runAgent(brief() + planText + (failure ? '\n\n上一次没有完成：' + failure + '\n请针对这个问题换方法，先检查现状，不要重复已经完成的部分。' : ''), false, budget);
        trace = [...trace, ...(result.trace || [])];
        outcome = result.executionStatus === 'incomplete' || result.unresolvedSteps?.length
          ? { passed: false, checks: [], unmet: ['执行器仍有未完成或未核对的工具操作'] }
          : await verify({ target, intent, answer: result.text, trace, since: started, signal, counter, reviewRequirements: agent.checkRequirements });
      }
      say('核对完成标准：' + (outcome.passed ? '全部满足' : '还差 ' + outcome.unmet.length + ' 条'));
      if (!outcome.passed) failure = outcome.unmet.join('；');
      if (!outcome.passed && trace.some(item => item.ok && /^browser_(click|fill|type|select|press|upload|drag)$/.test(item.tool))) {
        failure = '网页操作已执行，但完成标准尚未通过。已保留完整回执并停止自动重做，请核对实际网页结果：' + failure;
        outcome.unmet = [failure]; break;
      }
      if (outcome.requirements && !outcome.requirements.passed && trace.some(item => item.ok && /^(mcp_|run_command$|run_skill$|delegate$|type_text$|press_keys$|uia_set_value$|uia_invoke$|click$|click_text$|drag$)/.test(item.tool))) {
        failure = '外部操作已执行，但长期要求未全部通过。已停止自动重复操作，请核对实际结果：' + failure;
        outcome.unmet = [failure]; break;
      }
    }

    // 5. Learn: what worked for this kind of task, and the software procedure itself.
    const usedControl = trace.some(item => CONTROL_TOOLS.has(item.tool) && item.ok);
    let learnedSkill = null;
    if (outcome.passed && usedControl && route !== 'skill' && !trace.some(item => item.tool === 'save_skill')) {
      try {
        const saved = await tools.execute('save_skill', { title: intent.goal.slice(0, 60), trigger: intent.kind, params: Object.entries(intent.params).map(([name, example]) => ({ name, example })) }, { signal, session, turn: task.id, onLearned: agent.onLearned });
        learnedSkill = { id: saved.id, steps: saved.steps.length };
        say('学会了一个软件技能：' + intent.goal.slice(0, 40));
      } catch (error) { if (['CORE_ACTION_UNCERTAIN', 'CORE_AUTHORITY_LOST', 'CHECKPOINT_PERSIST_FAILED'].includes(error.code)) throw error; /* nothing reusable was recorded this time */ }
    }
    await store.updateTask(task, { status: outcome.passed ? 'done' : 'unverified', route, verification: { passed: outcome.passed, unmet: outcome.unmet, checks: outcome.checks, modelJudgement: outcome.judged || null, ...(outcome.requirements ? { requirements: { recordPath: outcome.requirements.recordPath, signature: outcome.requirements.signature, passed: outcome.requirements.passed } } : {}) }, result: String(result?.text || '').slice(0, 8000) });
    await store.recordExperience({ request, kind: intent.kind, intent, route, passed: outcome.passed, unmet: outcome.unmet, skillId: skillUsed?.id || learnedSkill?.id || null, modelCalls: counter.calls, localUnderstanding, contextSignature, durationMs: Date.now() - started });

    const report = outcome.passed
      ? '\n\n---\n✅ PISCES AI已核对：' + intent.done_criteria.map(describeCriterion).join('；')
      : '\n\n---\n⚠️ PISCES AI核对后发现还没完成：' + outcome.unmet.join('；')
      + (intent.assumptions.length ? '\n我是这样理解的：' + intent.assumptions.join('；') + '。不对的话告诉我，我改。' : '');
    return { ...result, text: String(result?.text || '') + report, trace, modelCalls: counter.calls, ...(outcome.requirements ? { requirementsCheck: outcome.requirements } : {}), subject: { route, intent, passed: outcome.passed, unmet: outcome.unmet, localUnderstanding, skill: skillUsed?.title || null, learnedSkill, taskId: task.id } };
  }

  return { handle, pickSkill, checkCriteria, contextFor };
}

module.exports = { createExecutive };
