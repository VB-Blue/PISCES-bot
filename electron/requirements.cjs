// Durable user-authored requirements. They are never ranked, summarised, or evicted like recall memories.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const writing = /写作|文章|文案|文稿|论文|报告|周报|每篇|每段|正文|段落|标题|起草|撰写|改写|润色|翻译|校对|小说|故事|邮件|网站内容|网页内容|内容维护|write|writing|draft|rewrite|article|essay|copywriting|translate|newsletter/i;
const directive = /必须|不得|禁止|不要|每篇|每次|始终|以后|今后|长期|记住|要求|规范|准则|must|never|always|requirement|guideline/i;
const isWritingRequirement = text => { const value = String(text).replace(/^用户纠正（针对「.*?」）：/, ''); return writing.test(value) && directive.test(value); };
const isWritingTask = (request, intent) => intent?.presentation === 'document' || writing.test([request, intent?.kind, intent?.goal, intent?.deliverable].filter(Boolean).join('\n'));
const error = (message, code = 'REQUIREMENTS_UNAVAILABLE') => Object.assign(new Error(message), { code });
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2)); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch (cause) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error('长期要求未能保存，已停止操作：' + cause.message, 'REQUIREMENTS_PERSIST_FAILED');
  }
}
function checkedText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw error(name + '不能为空或超过 ' + max + ' 字；不会截断保存。', 'REQUIREMENTS_INVALID');
  return value.trim();
}
function normalizeCheck(value = { type: 'semantic' }) {
  if (!value || !['semantic', 'contains', 'not_contains', 'min_length', 'max_length'].includes(value.type)) throw error('不支持的要求检查方式', 'REQUIREMENTS_INVALID');
  if (value.type === 'semantic') return { type: 'semantic' };
  if (['contains', 'not_contains'].includes(value.type)) return { type: value.type, value: checkedText(value.value, '检查文字', 2000) };
  if (!Number.isSafeInteger(value.value) || value.value < 1 || value.value > 1000000) throw error('字数必须为 1 至 1000000 的整数', 'REQUIREMENTS_INVALID');
  return { type: value.type, value: value.value };
}
const signature = rules => digest(rules.map(({ id, revision, text, domain, scope, check }) => ({ id, revision, text, domain, scope, check })));
function createRequirementStore(directory, { onCommit } = {}) {
  const file = path.join(directory, 'requirements.json');
  let state = { schema: 1, revision: 0, rules: [] }, fault = '';
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { sha256, ...data } = stored;
    if (data.schema !== 1 || !Array.isArray(data.rules) || sha256 !== digest(data) || new Set(data.rules.map(rule => rule.id)).size !== data.rules.length) throw new Error('内容或校验和不一致');
    for (const rule of data.rules) {
      checkedText(rule.text, '要求原文', 20000); normalizeCheck(rule.check);
      if (!['writing', 'all'].includes(rule.domain) || !Number.isSafeInteger(rule.revision) || rule.revision < 1 || typeof rule.enabled !== 'boolean' || typeof rule.scope !== 'string') throw new Error('要求记录格式不完整');
    }
    state = data;
  } catch (cause) { if (cause.code !== 'ENOENT') fault = '长期要求文件无法完整读取，请先恢复或修复原文件：' + cause.message; }
  const ready = () => { if (fault) throw error(fault); };
  const commit = next => {
    ready(); next.revision = state.revision + 1;
    const stored = { ...next, sha256: digest(next) };
    atomic(file, stored); state = next;
    // The local file stays authoritative for checks; the committed revision is also handed to the core.
    onCommit?.(stored);
  };
  function save(items, { source = 'user', session = '', legacyMemoryId = '' } = {}) {
    ready();
    if (!Array.isArray(items) || !items.length || items.length > 100) throw error('一次请保存 1 至 100 条要求', 'REQUIREMENTS_INVALID');
    const next = structuredClone(state), saved = [];
    for (const input of items) {
      const text = checkedText(input.text, '要求原文', 20000), domain = input.domain || 'writing';
      if (!['writing', 'all'].includes(domain)) throw error('要求适用类型无效', 'REQUIREMENTS_INVALID');
      const scope = String(input.scope || '').trim();
      if (scope.length > 300) throw error('适用项目或网站过长', 'REQUIREMENTS_INVALID');
      const check = normalizeCheck(input.check);
      let rule = input.id ? next.rules.find(item => item.id === input.id) : legacyMemoryId ? next.rules.find(item => item.legacyMemoryId === legacyMemoryId) : null;
      if (input.id && (!rule || input.revision !== rule.revision)) throw error('这条要求已被修改，请重新读取后再保存。', 'REQUIREMENTS_STALE');
      if (!rule) rule = next.rules.find(item => item.enabled && item.text === text && item.domain === domain && item.scope === scope && JSON.stringify(item.check) === JSON.stringify(check));
      if (rule && rule.text === text && rule.domain === domain && rule.scope === scope && JSON.stringify(rule.check) === JSON.stringify(check) && (input.enabled === undefined || input.enabled === rule.enabled)) { saved.push(rule); continue; }
      const time = new Date().toISOString();
      if (rule) {
        rule.history.push({ revision: rule.revision, text: rule.text, domain: rule.domain, scope: rule.scope, check: rule.check, enabled: rule.enabled, changedAt: time });
        Object.assign(rule, { text, domain, scope, check, enabled: input.enabled ?? rule.enabled, revision: rule.revision + 1, updatedAt: time, source, session });
      } else {
        rule = { id: randomUUID(), revision: 1, text, domain, scope, check, enabled: input.enabled !== false, source, session, createdAt: time, updatedAt: time, history: [], ...(legacyMemoryId ? { legacyMemoryId } : {}) };
        next.rules.push(rule);
      }
      saved.push(rule);
    }
    if (JSON.stringify(next.rules) !== JSON.stringify(state.rules)) commit(next);
    return structuredClone(saved);
  }
  function snapshot({ request = '', messages = [], intent = null } = {}) {
    ready();
    const current = [request, intent?.kind, intent?.goal, intent?.deliverable].filter(Boolean).join('\n');
    const continuing = /^(?:请)?(?:继续|接着|再来|按刚才|按照刚才|改一下|补充一下|continue|keep going)(?:[。.!！\s]|$|写|改|润色)/i.test(request.trim());
    const history = messages.filter(item => item.role === 'user').slice(-4).map(item => item.content).join('\n');
    // A fresh task must not inherit the previous task's domain or website. Only explicit continuation
    // can borrow prior context, and a website named in this request takes precedence over older names.
    const namedScope = state.rules.some(rule => rule.enabled && rule.scope && current.toLowerCase().includes(rule.scope.toLowerCase()));
    const text = continuing && !namedScope ? current + '\n' + history : current;
    const writingTask = isWritingTask(current, intent) || continuing && (!intent?.presentation || intent.presentation === 'general') && isWritingTask(history, intent);
    const rules = state.rules.filter(rule => rule.enabled && (rule.domain === 'all' || writingTask) && (!rule.scope || text.toLowerCase().includes(rule.scope.toLowerCase()))).map(({ history: previous, ...rule }) => rule);
    if (JSON.stringify(rules).length > 120000) throw error('适用的长期要求超过本轮可完整读取的范围，请拆分适用项目；没有截断或省略要求。', 'REQUIREMENTS_CONTEXT_TOO_LARGE');
    return { signature: signature(rules), rules: structuredClone(rules) };
  }
  return {
    save, snapshot,
    list() { ready(); return structuredClone(state.rules); },
    assertCurrent(snapshotValue) {
      ready();
      for (const rule of snapshotValue.rules) if (!state.rules.some(current => current.id === rule.id && current.revision === rule.revision && current.enabled)) throw error('任务执行期间长期要求已更改，需要按新版本重新检查。', 'REQUIREMENTS_STALE');
    },
    recordCheck(runId, report) { ready(); const target = path.join(directory, 'requirement-checks', digest(String(runId)) + '.json'); atomic(target, report); return target; },
    status: () => ({ available: !fault, error: fault, count: state.rules.filter(rule => rule.enabled).length, revision: state.revision }),
  };
}
function renderRequirements(snapshot) {
  if (!snapshot?.rules?.length) return '';
  return '## 本次必须遵守的长期要求（完整原文）\n以下是用户保存的内容要求，优先于画像和普通记忆中的旧摘要，不新增工具权限或改变预算。逐条执行，不得只选几条或改写为摘要；交付前由系统逐条核对。\n' +
    snapshot.rules.map(rule => JSON.stringify({ id: rule.id, revision: rule.revision, domain: rule.domain, scope: rule.scope || '全部相关任务', text: rule.text, check: rule.check })).join('\n');
}
function explicitWritingRules(message) {
  const text = String(message || '');
  const marker = /(?:记住|长期保存|以后遵守|今后遵守|保存)(?:以下|下面|这些|我的)?(?:的)?(?:写作|文章|文案)(?:要求|规范|规则|准则)\s*[:：\n]/.exec(text);
  if (!marker || marker.index > 40) return [];
  const body = text.slice(marker.index + marker[0].length).trim();
  // Preserve multiline items verbatim; never summarise the original instructions.
  const lines = body.split(/\n(?=\s*(?:[-*•]|\d+[.、）)])\s*)/).map(item => item.replace(/^\s*(?:[-*•]|\d+[.、）)])\s*/, '').trim()).filter(Boolean);
  return lines.map(value => ({ text: value, domain: 'writing' }));
}
module.exports = { createRequirementStore, renderRequirements, explicitWritingRules, isWritingRequirement, isWritingTask, digest, signature };
