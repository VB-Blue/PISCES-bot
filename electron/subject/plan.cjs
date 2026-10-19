// Plan nodes are projections on the canonical work, not another task owner.
const { createHash } = require('node:crypto');
const { normalizeExecution } = require('./node-execution.cjs');
const STATUSES = new Set(['pending', 'doing', 'done', 'blocked']);
const PLAN_CHECKS = ['file_exists', 'file_contains', 'answer_contains', 'window_shows', 'judgement', 'tool_succeeded'];
function criterionProblem(item) {
  if (!PLAN_CHECKS.includes(item?.check)) return '不支持的验收类型';
  if (['file_exists', 'file_contains', 'tool_succeeded'].includes(item.check) && (typeof item.target !== 'string' || !item.target.trim())) return '验收需要具体的 target';
  if (['file_contains', 'answer_contains', 'window_shows', 'judgement'].includes(item.check) && (typeof item.value !== 'string' || !item.value.trim())) return '验收需要具体的 value';
  if (item.check === 'tool_succeeded' && item.target === 'update_plan') return '计划更新不能当作执行证据';
  return '';
}
const textOf = step => String(step?.text || step?.do || '').trim().slice(0, 300);
const idFor = (text, index) => 'step-' + createHash('sha256').update(text + ':' + index).digest('hex').slice(0, 12);

function normalizePlan(steps, previous = [], { trustedRuntime = false } = {}) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 20) throw new Error('计划需要 1～20 项');
  const nodes = steps.map((step, index) => {
    const text = textOf(step);
    if (!text) throw new Error('每个计划节点都需要具体内容');
    const prior = previous.find(item => (step.id && item.id === step.id) || textOf(item) === text);
    const id = String(step.id || prior?.id || idFor(text, index));
    if (!/^[\w.-]{1,80}$/.test(id)) throw new Error('计划节点 id 无效');
    const expect = String(step.expect ?? prior?.expect ?? '').slice(0, 300);
    const runtime = trustedRuntime ? step : prior;
    return { id, text, do: String(step.do || prior?.do || text).slice(0, 300), expect,
      status: !trustedRuntime && prior?.runtime_status ? prior.status : STATUSES.has(step.status) ? step.status : 'pending',
      ...(!trustedRuntime && prior?.runtime_status && step.status ? { reported_status: step.status } : {}),
      depends_on: Array.isArray(step.depends_on) ? [...new Set(step.depends_on.map(String))] : prior?.depends_on,
      criteria: (Array.isArray(step.criteria) ? step.criteria : prior?.criteria || (expect ? [{ check: 'judgement', value: expect }] : [])).slice(0, 8).map(item => ({ check: String(item?.check || 'judgement').slice(0, 50), ...(item?.target ? { target: String(item.target).slice(0, 300) } : {}), ...(item?.value ? { value: String(item.value).slice(0, 500) } : {}) })),
      outputs: (Array.isArray(step.outputs) ? step.outputs : prior?.outputs || []).slice(0, 8).map(value => String(value).slice(0, 500)),
      ...normalizeExecution(step, prior),
      ...(runtime?.runtime_status ? { runtime_status: runtime.runtime_status } : {}),
      ...(runtime?.verification ? { verification: structuredClone(runtime.verification) } : {}),
      ...(runtime?.attempts ? { attempts: runtime.attempts } : {}),
      ...(runtime?.evidence ? { evidence: structuredClone(runtime.evidence) } : {}),
      ...(runtime?.execution_state ? { execution_state: structuredClone(runtime.execution_state) } : {}),
    };
  });
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length) throw new Error('计划节点 id 不能重复');
  nodes.forEach((node, index) => {
    for (const item of node.criteria) { const problem = criterionProblem(item); if (problem) throw new Error('计划节点' + problem); }
    node.depends_on ||= index ? [nodes[index - 1].id] : [];
    if (node.depends_on.some(id => !ids.has(id) || id === node.id)) throw new Error('计划包含不存在的依赖或自身依赖');
  });
  const visited = new Set(), visiting = new Set();
  function visit(node) {
    if (visiting.has(node.id)) throw new Error('计划依赖不能形成循环');
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    for (const id of node.depends_on) visit(nodes.find(item => item.id === id));
    visiting.delete(node.id); visited.add(node.id);
  }
  nodes.forEach(visit);
  return nodes;
}

module.exports = { normalizePlan, PLAN_CHECKS, criterionProblem };
