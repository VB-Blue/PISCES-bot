// Work allocation: which AI service handles which agent, what happens when one fails, and how many agents may
// hit the same service at once. Pure logic over already-resolved profiles (see providers.cjs).

// Role templates the main agent can pick from when it delegates. Each gives sensible defaults for tools and model type.
const AGENT_ROLES = {
  researcher: { label: '资料员', capabilities: ['web'], prefer: 'fast', hint: '联网查资料、核实事实、对比信息' },
  coder: { label: '程序员', capabilities: ['files', 'shell'], prefer: 'code', hint: '写/改代码、跑命令、处理文件' },
  operator: { label: '操作员', capabilities: ['desktop'], prefer: 'vision', hint: '看着屏幕操作软件（需要支持图片的模型）' },
  writer: { label: '写作员', capabilities: ['files', 'web'], prefer: 'strong', hint: '起草、改写、整理较长的文字' },
  reviewer: { label: '复核员', capabilities: ['files', 'web'], prefer: 'strong', hint: '独立核对其他代理的结论，指出错误和遗漏' },
};

// Errors worth retrying on a different service: the service is down, throttled, out of balance, or rejects the key.
function isTransient(error) {
  if (!error || error.name === 'AbortError') return false;
  if (['TOKEN_BUDGET_EXCEEDED', 'USAGE_PERSISTENCE_FAILED', 'GOAL_PERSISTENCE_FAILED'].includes(error.code)) return false;
  if (require('./model-errors.cjs').MODEL_TRANSPORT_CODES.has(error.code) || require('./model-errors.cjs').causeCode(error)) return true;
  const text = String(error.message || '');
  if (/HTTP (402|408|429|5\d\d)/.test(text)) return true;
  if (/HTTP (401|403)/.test(text)) return true;
  if (/quota|balance|insufficient|rate.?limit|余额|额度|限流|overloaded/i.test(text)) return true;
  if (error.name === 'TypeError' || error.name === 'TimeoutError') return true;
  return /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|terminated|AI 回复未完成|AI 响应格式不兼容/i.test(text);
}

const byName = (profiles, name) => {
  const wanted = String(name || '').trim().toLowerCase();
  return wanted ? profiles.find(item => item.id === name || item.name.toLowerCase() === wanted) : undefined;
};

// Pick the primary service for one agent and an ordered list of fallbacks.
//   store: { profiles (resolved), defaultId, routes, failover }
//   request: { profile?, role?, prefer?, capabilities? }
// Precedence: explicit profile name > the user's route for the role > needs vision > preferred strength > default.
function plan(store, request = {}) {
  const profiles = store.profiles || [];
  if (!profiles.length) return null;
  const def = profiles.find(item => item.id === store.defaultId) || profiles[0];
  const needsVision = (request.capabilities || []).some(item => item === 'desktop' || item === 'vision');
  const has = (profile, tag) => profile.strengths.includes(tag);
  let primary, reason, warning = '';
  const explicit = byName(profiles, request.profile);
  if (request.profile && !explicit) warning = '没有名为「' + request.profile + '」的服务，已自动分配';
  const routed = request.role && store.routes?.[request.role] ? profiles.find(item => item.id === store.routes[request.role]) : undefined;
  if (explicit) { primary = explicit; reason = '指定'; }
  else if (routed) { primary = routed; reason = '角色设定'; }
  else if (needsVision && profiles.some(item => has(item, 'vision'))) { primary = has(def, 'vision') ? def : profiles.find(item => has(item, 'vision')); reason = '需要看屏幕'; }
  else if (request.prefer && profiles.some(item => has(item, request.prefer))) { primary = has(def, request.prefer) ? def : profiles.find(item => has(item, request.prefer)); reason = '擅长 ' + request.prefer; }
  else { primary = def; reason = '默认'; }
  let fallbacks = [];
  if (store.failover !== false && !primary.noFailover) {
    fallbacks = profiles.filter(item => item.id !== primary.id && !item.noFailover && (!needsVision || has(item, 'vision')));
    // Closest match first: services sharing the preferred strength, then the default, then the rest in list order.
    const score = item => (request.prefer && has(item, request.prefer) ? 2 : 0) + (item.id === def.id ? 1 : 0);
    fallbacks = fallbacks.map((item, index) => ({ item, index })).sort((a, b) => score(b.item) - score(a.item) || a.index - b.index).map(entry => entry.item);
  }
  return { primary, fallbacks, reason, warning };
}

// Per-service concurrency cap, so a burst of agents does not trip one provider's rate limit.
function createLimiter() {
  const state = new Map();
  return {
    async acquire(id, max = 2, signal) {
      signal?.throwIfAborted();
      max = Math.max(1, Math.min(8, Number(max) || 2));
      const slot = state.get(id) || { active: 0, waiting: [] };
      state.set(id, slot);
      if (slot.active >= max) await new Promise((resolve, reject) => {
        const entry = { resolve, max, abort: () => {
          const index = slot.waiting.indexOf(entry);
          if (index >= 0) slot.waiting.splice(index, 1);
          signal?.removeEventListener('abort', entry.abort);
          reject(signal.reason || new Error('任务已停止'));
        } };
        slot.waiting.push(entry);
        signal?.addEventListener('abort', entry.abort, { once: true });
        entry.resolve = () => { signal?.removeEventListener('abort', entry.abort); resolve(); };
      });
      else slot.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        slot.active--;
        while (slot.waiting.length && slot.active < slot.waiting[0].max) { slot.active++; slot.waiting.shift().resolve(); }
      };
    },
    active: id => state.get(id)?.active || 0,
    waiting: id => state.get(id)?.waiting.length || 0,
  };
}

// Initial allocation works without an extra model call. The subject can refine it with its validated intent.
function taskRequest({ text = '', messages = [], images = false, intent = null } = {}) {
  let content = intent ? [intent.kind, intent.goal, intent.deliverable].filter(Boolean).join(' ') : String(text);
  if (!intent && /^(继续|接着|再|按刚才|continue|keep going|also|add\b)/i.test(content.trim())) {
    content += ' ' + messages.filter(item => item.role === 'user').slice(-3, -1).map(item => String(item.content).slice(0, 1200)).join(' ');
  }
  const capabilities = images ? ['vision'] : [];
  if (images || intent?.presentation === 'desktop' || /截图|看图|识图|照片|修图|操作软件|点击|屏幕|screenshot|image|photo|screen|click|photoshop/i.test(content)) return { role: 'operator', prefer: 'vision', capabilities: ['vision'] };
  if (/代码|编程|脚本|程序|调试|报错|修复.*bug|接口|code|coding|script|debug|bug|typescript|python|javascript|sql\b|api\b/i.test(content)) return { role: 'coder', prefer: 'code', capabilities };
  if (/核对|审阅|审核|复核|评审|校验|review|verify|audit|check\b/i.test(content)) return { role: 'reviewer', prefer: 'strong', capabilities };
  if (intent?.presentation === 'document' || /写作|写.{0,6}(文章|报告|论文|周报|邮件|文档|文案|故事)|起草|改写|润色|翻译|write|draft|rewrite|translate|essay|report/i.test(content)) return { role: 'writer', prefer: 'strong', capabilities };
  if (intent?.presentation === 'research' || /调研|资料|搜索|搜一下|查.{0,5}(资料|新闻|信息)|新闻|研究|对比|research|search|news|compare/i.test(content)) return { role: 'researcher', prefer: 'fast', capabilities };
  if (/推理|分析|数学|证明|reason|analysis|analy[sz]e|math|proof/i.test(content)) return { prefer: 'strong', capabilities };
  if (content.length > 16000) return { prefer: 'long', capabilities };
  return { capabilities };
}

function targets(store, settings, request = {}) {
  const routing = plan(store, request);
  const asTarget = item => ({ name: item.name, settings: { ...settings, ...item.settings }, apiKey: item.apiKey });
  const main = routing?.primary || null;
  const roleTargets = {};
  for (const role of ['planner', 'verifier']) {
    const rolePlan = plan(store, { role, prefer: 'strong', capabilities: request.capabilities });
    if (rolePlan) roleTargets[role] = [asTarget(rolePlan.primary), ...rolePlan.fallbacks.map(asTarget)];
  }
  return { main, mainSettings: main ? asTarget(main).settings : { ...settings, endpoint: '', model: '' }, apiKey: main?.apiKey || '',
    fallbacks: routing?.fallbacks.map(asTarget) || [], roleTargets, reason: routing?.reason || '默认', warning: routing?.warning || '',
    service: main ? { id: main.id, name: main.name, model: main.settings.model, reason: routing.reason } : null };
}

// Text for the delegate tool so the main model can allocate work knowingly.
function describeProfiles(store) {
  const profiles = store.profiles || [];
  if (profiles.length < 2) return '';
  return profiles.map(item => '「' + item.name + '」' + item.settings.model + (item.id === store.defaultId ? '（默认）' : '') + (item.strengths.length ? ' 擅长:' + item.strengths.join('/') : '') + (item.note ? ' ' + item.note : '')).join('；');
}

module.exports = { AGENT_ROLES, isTransient, plan, taskRequest, targets, createLimiter, describeProfiles, byName };
