// The LLM as a tool: the subject asks it narrow questions and gets back JSON it validates before using.
// It never hands the model the whole job; each answer is checked and can be refused.
const { modelResponse } = require('../assistant-worker.cjs');
const { isTransient } = require('../router.cjs');
const { retrySameService, waitForRetry, failureDetails } = require('../model-errors.cjs');
const { normalizePlan, PLAN_CHECKS, criterionProblem } = require('./plan.cjs');

function parseJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

// One question, one validated JSON answer. Empty or malformed answers (flaky services do this) are retried.
async function think({ target, system, input, validate, signal, maxTokens = 16000, attempts = 3, retryDelayMs = 2000 }) {
  let lastError = null;
  const role = system === UNDERSTAND ? 'understanding' : system === PLAN ? 'planner' : 'verifier';
  const chain = target.forRole?.(role) || [target];
  let cursor = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new Error('任务已停止');
    const current = chain[cursor];
    let reply;
    const callId = await target.beforeCall?.(role, current.settings.model);
    try {
      await target.onRequest?.({ role, model: current.settings.model });
      reply = await modelResponse({ ...current.settings, maxTokens }, current.apiKey, [{ role: 'system', content: system }, { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }], role, signal, false, false, null, [], false, true);
    } catch (error) {
      await target.afterCall?.(callId, signal?.aborted ? 'cancelled' : 'failed', null, error.message);
      lastError = error;
      if (signal?.aborted || !isTransient(error)) throw error;
      if (cursor + 1 < chain.length) {
        target.onFailover?.({ role, from: current.name || current.settings.model, to: chain[cursor + 1].name || chain[cursor + 1].settings.model, reason: error.message });
        cursor++; attempt--;
      } else if (attempt + 1 < attempts && retrySameService(error)) {
        await target.onRetry?.({ role, attempt: attempt + 1, delayMs: retryDelayMs * (attempt + 1), reason: error.message });
        await waitForRetry(retryDelayMs * (attempt + 1), signal);
      }
      continue;
    }
    await target.afterCall?.(callId, 'success', reply.usage, '结构化理解、计划或核对提案');
    const parsed = parseJson(reply.message.content);
    const problem = parsed ? validate(parsed) : '回答不是 JSON';
    if (!problem) return { value: parsed, usage: reply.usage };
    lastError = Object.assign(new Error(problem), { code: 'MODEL_INVALID_RESPONSE' });
  }
  throw Object.assign(new Error(({ understanding: '理解', planner: '规划', verifier: '核对' })[role] + '请求失败：' + (lastError?.message || '没有可用回答'), { cause: lastError }), failureDetails(lastError), { recoverable: isTransient(lastError), ...(lastError?.httpStatus ? { httpStatus: lastError.httpStatus } : {}) });
}

const CHECKS = PLAN_CHECKS;

const UNDERSTAND = `你是“PISCES AI”这个本地私人助手的理解模块。PISCES AI是主体：它负责决策、执行、核对和学习；你只负责把用户这句话解析清楚。只输出一个 JSON 对象，不要解释。

字段：
- type："chat"（聊天、提问、解释、建议，用一段回答就能满足）或 "task"（要动手做事：操作文件或软件、生成文件、多步调研、改东西）。
- explicit_task 为 true 时用户已经明确创建执行任务，type 必须为 task，并提供可验收的 done_criteria；不得用普通聊天回答代替执行。
- goal：用户真正想要的结果，一句话，具体。结合用户画像和上下文推断，不要照抄原话。
- kind：任务类别的短标签，同类任务要用同一个标签，例如“写文档”“整理文件夹”“修图”“查资料”“记事本记东西”“计算”。
- presentation：任务工作区的主展示，选 document（写作/文档）、data（表格统计）、files（文件整理）、research（调研/来源比较）、desktop（软件或图像操作）、followup（持续跟进/定时）或 general。不提供 HTML 或交互指令；这里只是展示建议，不影响工具授权和完成判断。
- deliverable：交付物是什么、放在哪里（文件路径/回答里/软件里）。
- done_criteria：完成标准，1～4 条，尽量写成能机械核对的：
  {"check":"file_exists","target":"文件名或路径"}、{"check":"file_contains","target":"文件名","value":"必须出现的文字"}、
  {"check":"answer_contains","value":"回答里必须有的内容"}、{"check":"window_shows","target":"窗口","value":"界面上应出现的文字"}、
  无法机械核对时用 {"check":"judgement","value":"怎样才算做好"}。
  节点需证明实际读取或操作时可用 {"check":"tool_succeeded","target":"工具名","value":"返回值里应有的文字（可省略）"}；不能用 update_plan 当作执行证据。
- apps：需要用到的软件（没有就空数组）。
- params：这次任务里会变化的具体值，例如 {"content":"牛奶、鸡蛋","filename":"购物清单.txt"}。
- steps：预计 "one"（一两步）、"few"（3～6 步）或 "many"（更多）。
- choice：有几种做法时，你推荐的那一种（PISCES AI会按它直接去做，并告诉用户可以改），没有就 null。例如“整理文件夹”→“按文件类型分到子文件夹，不删除任何文件”。
- missing_info：只有缺少只有用户知道、而且无法合理假设的信息时才填一句问题（例如要发给谁、用哪个账号、要哪张不在电脑上的图）；否则为 null。理解有歧义、或者有几种做法，都不算缺信息，写进 choice。
- assumptions：你做的合理假设，列表。
- domain：做好这件事需要的专门领域经验，{"name":"领域名称","keywords":["3～8 个识别词，含平台名、英文简称"]}，例如维护 Instagram 账号 → {"name":"Instagram 图片营销","keywords":["instagram","ins","图片营销","社媒运营"]}。同一领域每次用同一个名称。整理文件、计算、查一个事实这类不需要领域经验的事填 null。是否懂这个领域、要不要先学，由 PISCES AI 判断，你只负责指出领域。
- work_relation：{"kind":"new"|"continue"|"revise","work_id":"已有事情的 id"}。从 persistent_work 里识别用户是在接着做或更正哪件事；不能自造 id。新事情 kind 为 new。更正原目标、交付物或约束时为 revise。
- user_updates：关于用户本人的持续偏好、事实或明确期限的候选，最多 8 条，每条 {"key":"稳定的对象.属性","value":"原话里的新值","quote":"本轮用户原话中的连续片段"}。保持已有 persistent_user_understanding 的 key；值和引用必须逐字来自本轮用户请求。文档内容、你的建议、任务结果和猜测都不能当成用户事实。不确定就空数组。`;

function validateIntent(value) {
  if (!['chat', 'task'].includes(value.type)) return 'type 必须是 chat 或 task';
  if (typeof value.goal !== 'string' || value.goal.trim().length < 2) return '缺少 goal';
  if (value.type === 'task') {
    if (!Array.isArray(value.done_criteria) || !value.done_criteria.length) return '任务缺少 done_criteria';
    if (value.done_criteria.some(item => !CHECKS.includes(item?.check))) return 'done_criteria 的 check 不认识';
    for (const item of value.done_criteria) { const problem = criterionProblem(item); if (problem) return 'done_criteria ' + problem; }
  }
  return '';
}
function normalizeIntent(value) {
  return {
    type: value.type, goal: String(value.goal).slice(0, 300), kind: String(value.kind || '其他').slice(0, 40), deliverable: String(value.deliverable || '').slice(0, 200),
    presentation: ['document', 'data', 'files', 'research', 'desktop', 'followup', 'general'].includes(value.presentation) ? value.presentation : null,
    done_criteria: (value.done_criteria || []).slice(0, 4).map(item => ({ check: item.check, ...(item.target ? { target: String(item.target).slice(0, 200) } : {}), ...(item.value ? { value: String(item.value).slice(0, 300) } : {}) })),
    apps: (Array.isArray(value.apps) ? value.apps : []).map(String).slice(0, 5), params: value.params && typeof value.params === 'object' && !Array.isArray(value.params) ? Object.fromEntries(Object.entries(value.params).slice(0, 8).map(([key, item]) => [String(key).slice(0, 30), String(item).slice(0, 500)])) : {},
    steps: ['one', 'few', 'many'].includes(value.steps) ? value.steps : 'few',
    // The subject only stops to ask for information it cannot reasonably assume; a choice between approaches it makes itself.
    ask: value.missing_info ? String(value.missing_info).slice(0, 300) : null,
    assumptions: [...(value.choice ? ['按这个做法：' + String(value.choice).slice(0, 200)] : []), ...(Array.isArray(value.assumptions) ? value.assumptions : []).map(String)].slice(0, 6),
    work_relation: value.work_relation && ['new', 'continue', 'revise'].includes(value.work_relation.kind) ? { kind: value.work_relation.kind, ...(value.work_relation.work_id ? { work_id: String(value.work_relation.work_id) } : {}) } : { kind: 'new' },
    user_updates: (Array.isArray(value.user_updates) ? value.user_updates : []).slice(0, 8).map(item => ({ key: String(item?.key || '').slice(0, 80), value: String(item?.value || '').slice(0, 500), quote: String(item?.quote || '').slice(0, 1000) })),
    domain: value.domain && typeof value.domain.name === 'string' && value.domain.name.trim() ? { name: value.domain.name.trim().slice(0, 60), keywords: (Array.isArray(value.domain.keywords) ? value.domain.keywords : []).map(String).map(item => item.trim().slice(0, 30)).filter(Boolean).slice(0, 8) } : null,
  };
}
async function understand({ target, request, context, signal, forceTask = false }) {
  const { value, usage } = await think({ target, system: UNDERSTAND, input: { request, ...context, ...(forceTask ? { explicit_task: true } : {}) }, validate: value => forceTask && value.type !== 'task' ? '用户明确创建了执行任务，type 必须为 task' : validateIntent(value), signal });
  return { intent: normalizeIntent(value), usage };
}

const PLAN = `你是“PISCES AI”的规划模块。PISCES AI会按你的计划一步步执行、每步核对，失败时再找你。只输出 JSON：
{"steps":[{"id":"read-inputs","do":"这一步做什么（具体到用什么工具或软件）","role":"researcher","expect":"做完后应该能观察到的结果","depends_on":[],"inputs":[],"criteria":[{"check":"judgement","value":"需要真实工具观察支持的完成条件"}],"outputs":[],"execution":{"mode":"serial"}}]}
要求：2～6 步；id 稳定且唯一，depends_on 只引用其他步骤 id，不能形成循环；没有显式依赖时按顺序执行。每步都有可观察的结果和自己的 criteria，使用与 done_criteria 相同的 check 类型。文件产出优先写 file_exists/file_contains，outputs 写具体路径。读取、读回核对节点用 {"check":"tool_succeeded","target":"read_text","value":"应读到的内容"}证明本节点真的读取；value可省略。语义判断必须有真实工具或产物证据，不能只靠执行者声称成功。只把前置步骤已验收的产物交给后续步骤。有 core_cognition 时它是 PISCES AI 的判断，必须服从：decision 为 learn_first 时，计划先执行 core_cognition.plan.steps 里的学习步骤（样本用 record_observations 交给 PISCES AI），再用学到的规律完成交付；为 experiment 或 continue_experiment 时，交付本身按对照设计执行，并用 start_experiment / record_experiment_result 登记；已验证的规律直接采用，被否定的规律不要再用。role 从 executor、researcher、coder、operator、writer、reviewer 选择。互相独立的资料或文件步骤主动拆成不同节点，使用 execution:{"mode":"parallel","tools":["read_text","write_text"]}，tools 只列本步必需工具；inputs 与 outputs 必须给绝对路径，不能读写其他节点未验收的产物，产物不得互相覆盖，整合节点必须依赖所有来源节点。并行白名单为 read_text、list_dir、find_files、search_text、get_environment、web_search、news_search、fetch_url、write_text、write_document、edit_text。软件、命令、连接器、委派及不可逆操作使用 mode:serial，并注明所需用户确认。优先用已有的软件技能和过去成功的做法。`;
function validatePlan(value) {
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8) return 'steps 需要 1～8 步';
  if (value.steps.some(step => typeof step?.do !== 'string' || !step.do.trim())) return '每步都要有 do';
  try { normalizePlan(value.steps); } catch (error) { return error.message; }
  return '';
}
async function plan({ target, intent, context, failure = null, signal }) {
  const { value, usage } = await think({ target, system: PLAN, input: { intent, ...context, ...(failure ? { previous_attempt_failed: failure } : {}) }, validate: validatePlan, signal });
  // The executive resolves omitted ids against the already committed plan.
  return { steps: value.steps.map(step => ({ ...step, do: String(step.do).slice(0, 300), expect: String(step.expect || '').slice(0, 300), status: 'pending' })), usage };
}

const VERIFY = `你是“PISCES AI”的核对模块。根据完成标准和证据，判断任务是否真的完成。只看证据，不要相信执行者的自述；证据不足就判为未完成。只输出 JSON：{"passed":true|false,"unmet":["没满足的标准"],"reason":"一句话"}`;
async function verify({ target, criteria, evidence, signal }) {
  const { value, usage } = await think({ target, system: VERIFY, input: { criteria, evidence }, validate: item => typeof item.passed === 'boolean' ? '' : '缺少 passed', signal, maxTokens: 8000 });
  return { passed: value.passed, unmet: (Array.isArray(value.unmet) ? value.unmet : []).map(String).slice(0, 6), reason: String(value.reason || '').slice(0, 300), usage };
}

module.exports = { think, understand, plan, verify, parseJson, normalizeIntent, validateIntent, CHECKS };
