// Turns what actually worked in a turn into a reusable software skill: no-effect attempts are dropped,
// the steps start from a known window, and the values that change from run to run become {{parameters}}.

const ACTIONS = new Set(['click', 'type', 'keys', 'click_text', 'scroll', 'click_xy', 'drag']);

function compileSkill(log, params = []) {
  // Attempts that visibly did nothing were wrong turns; keep only steps that worked.
  let steps = log.filter(step => step.changed !== false).map(step => ({ ...step }));
  // Only the last of several consecutive "open window" steps matters.
  steps = steps.filter((step, index) => !(step.op === 'open' && steps[index + 1]?.op === 'open'));
  // Start from the last launch/open before the first real action, so replay begins from a known window.
  const firstAction = steps.findIndex(step => ACTIONS.has(step.op));
  if (firstAction < 0) throw new Error('这一轮还没有成功的软件操作，没有可以保存的技能。先用 observe / click / type_text 完成任务，再保存。');
  let start = firstAction;
  while (start > 0 && !['open', 'launch'].includes(steps[start].op)) start--;
  if (!['open', 'launch'].includes(steps[start].op)) throw new Error('录下的操作缺少起点（先 observe 打开目标窗口），无法保存成技能。');
  if (steps[start].op === 'open' && steps[start - 1]?.op === 'launch') start--;
  steps = steps.slice(start);
  // Values the user will vary next time become parameters.
  const used = new Set();
  for (const param of params) {
    const example = String(param.example ?? '');
    if (!param.name || example.length < 1) continue;
    for (const step of steps) for (const key of ['text', 'target']) {
      if (typeof step[key] === 'string' && step[key].includes(example)) { step[key] = step[key].split(example).join('{{' + param.name + '}}'); used.add(param.name); }
    }
  }
  return { steps, unusedParams: params.map(param => param.name).filter(name => name && !used.has(name)) };
}

// One readable line per step, for the model and the UI.
function describeSteps(steps) {
  return steps.map((step, index) => (index + 1) + '. ' + ({
    launch: () => '启动 ' + step.target,
    open: () => '打开窗口「' + step.window + '」',
    click: () => '点击 ' + step.target.type + '「' + step.target.name + '」',
    type: () => '输入「' + String(step.text).slice(0, 40) + '」' + (step.into ? ' 到「' + step.into.name + '」' : '') + (step.submit ? ' 并回车' : ''),
    keys: () => '按键 ' + step.keys,
    click_text: () => '点击文字「' + step.text + '」',
    scroll: () => '滚动 ' + step.amount,
    click_xy: () => '点击窗口内相对位置 (' + step.x.toFixed(2) + ', ' + step.y.toFixed(2) + ')',
    drag: () => '拖动',
    wait: () => '等待「' + (step.text || step.window) + '」' + (step.gone ? '消失' : '出现'),
  }[step.op] || (() => step.op))());
}

module.exports = { compileSkill, describeSteps };
