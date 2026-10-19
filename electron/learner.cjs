// After a turn finishes, a second short model call keeps the living user profile up to date and
// captures reusable playbooks. Every change is visible and undoable.
const { validateEndpoint } = require('./policy.cjs');
const serviceLimiter = require('./service-limiter.cjs');

const SYSTEM = `你负责维护一份“用户画像”：一份关于用户的简明档案，助手每次和用户说话前都会读它。你的目标是让助手越来越懂这个人。
读完最近的对话后，判断画像要不要更新，只输出一个 JSON 对象，不要任何解释。

画像固定用这几个小节（没有内容的小节可以省略）：
## 基本情况（称呼、身份、职业、所在地、语言）
## 正在做的事（项目、目标、近期关注）
## 偏好与习惯（喜欢的回答方式、做事习惯、时间规律）
## 常用工具与环境（软件、文件位置、设备、账号类型，不写密码）
## 对助手的要求（希望助手怎么做事、讨厌什么、被纠正过什么）

规则：
1. 只记稳定、以后用得上的信息。一次性的任务内容、临时问题不记。密码、密钥、证件号、银行卡、他人隐私绝不写。
2. 要从用户的反应里读出做事偏好：用户催促、不耐烦、纠正、重复要求、表扬，都说明他希望助手怎么做。例：助手反问后用户说“你直接去做”，说明用户希望助手先动手、少反问。
3. 合理推断可以写，但在后面标“（推测）”；被后来的对话证实就去掉标记，被否定就删掉。
4. 与新信息冲突的旧内容要改掉，不要堆叠。保持精炼，总长度不超过 1200 字，每条一行，以“- ”开头。
5. 没有值得更新的内容时 profile 为 null。

另外：只有当本轮用工具成功完成了多步骤任务、且做法以后可复用时，给出 playbook {"title","trigger","steps":[…]}（通用做法，不含隐私）；否则为 null。

输出格式：{"profile": null 或 "完整的新画像（markdown）", "changes": ["一句话说明改了什么", …], "playbook": null}`;

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

const SECRET = /密码|密钥|口令|token|api[_ -]?key|sk-[a-z0-9]{8,}|身份证号|银行卡号/i;

async function extract({ settings, apiKey, user, assistant, steps = [], profile = '', recent = [], existing = [], signal, fetchImpl = fetch }) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)].filter(Boolean));
  const release = settings.providerId ? await serviceLimiter.acquire(settings.providerId, settings.maxConcurrent, requestSignal) : null;
  let ticket = null, reportedUsage = null, callError = null, dispatched = false;
  try {
  const base = validateEndpoint(settings.endpoint);
  const request = { model: settings.model, stream: false, max_tokens: 6000, messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({
        current_profile: profile || '（空）',
        other_saved_memories: existing.slice(0, 20),
        earlier_turns: recent.slice(-6).map(item => ({ role: item.role, content: String(item.content || '').slice(0, 600) })),
        user_message: String(user).slice(0, 2000),
        assistant_reply: String(assistant).slice(0, 2000),
        tools_used: steps.map(step => (step.ok ? '成功：' : '失败：') + step.label).slice(0, 20),
      }) },
    ] };
  ticket = require('./model-usage.cjs').beginModelCall({ settings, role: 'learner', request });
  request.max_tokens = ticket.maxOutputTokens;
  requestSignal.throwIfAborted();
  dispatched = true;
  const response = await fetchImpl(base.endsWith('/chat/completions') ? base : base + '/chat/completions', {
    method: 'POST', redirect: 'error', signal: requestSignal,
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error('整理画像的请求失败 HTTP ' + response.status);
  const payload = await response.json();
  reportedUsage = payload.usage || null;
  const parsed = parseJson(String(payload.choices?.[0]?.message?.content || ''));
  if (!parsed) return { profile: null, changes: [], playbook: null };
  let next = typeof parsed.profile === 'string' ? parsed.profile.trim() : null;
  // Never let a malformed or secret-bearing rewrite replace the profile.
  if (next && (next.length < 10 || SECRET.test(next) && !SECRET.test(profile))) next = null;
  const changes = (Array.isArray(parsed.changes) ? parsed.changes : []).map(String).filter(Boolean).slice(0, 5);
  const playbook = parsed.playbook && typeof parsed.playbook.title === 'string' && Array.isArray(parsed.playbook.steps) && parsed.playbook.steps.length >= 2 && steps.filter(step => step.ok).length >= 2
    ? { title: parsed.playbook.title, trigger: String(parsed.playbook.trigger || ''), steps: parsed.playbook.steps.map(String) } : null;
  return { profile: next, changes, playbook };
  } catch (error) { callError = error; throw error; }
  finally { try { ticket?.finish({ usage: reportedUsage, error: callError, dispatched }); } finally { release?.(); } }
}

// Returns what was actually saved, so the UI can announce exactly that.
async function learn({ memory, session, ...input }) {
  const { profile, changes, playbook } = await extract({ ...input, profile: memory.getProfile(), existing: memory.listMemories().map(item => item.text) });
  const saved = [];
  if (profile) {
    const result = await memory.setProfile(profile, { source: 'auto', note: changes.join('；') });
    if (result.changed) saved.push({ type: 'profile', id: 'profile-' + Date.now(), text: changes.join('；') || '更新了用户画像' });
  }
  if (playbook) {
    try {
      const { playbook: entry, duplicate } = memory.addPlaybook({ ...playbook, source: 'auto' });
      if (!duplicate) saved.push({ type: 'playbook', id: entry.id, title: entry.title });
    } catch { /* a malformed playbook from the model is simply dropped */ }
  }
  return saved;
}

module.exports = { learn, extract, parseJson };
