// The control layer for any Windows software. The model never has to guess whether an action worked:
// every action waits for the UI to settle, reports whether anything visibly changed, follows new dialogs,
// and returns a fresh screenshot with numbered marks on every interactive element (set-of-marks), plus a
// text-based fallback (OCR) for software that draws its own interface. Loops that achieve nothing are cut off in code.
const BLOCKED_PROCESSES = new Set(['1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'powershell', 'pwsh', 'cmd', 'windowsterminal', 'wt', 'conhost', 'openconsole', 'regedit', 'mmc', 'secpol', 'consent', 'logonui', 'winlogon', 'lockapp', '记忆体', 'memory-desktop-assistant', 'pisces ai', 'pisces-ai']);
const BLOCKED_TITLE = /用户账户控制|User Account Control|Windows 安全中心|Windows Security|凭据|Credential/i;
const MAX_ACTIONS = 150;
const TEXT_ENTRY = new Set(['Edit', 'Document', 'ComboBox', 'Spinner']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tool = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const normalize = text => String(text || '').toLowerCase().replace(/\s+/g, '');
const { normalizePlan } = require('./subject/plan.cjs');

const definitions = [
  tool('list_windows', '列出当前打开的窗口（标题、程序、位置、是否在前台）。', {}),
  tool('observe', '看一个软件窗口：先把它切到前台（第一次会请用户允许控制该软件），返回带编号标记的截图和元素清单。图上每个可操作的控件都画了框和编号，之后用 click({id}) 直接点编号，不用估坐标。所有操作类工具执行后都会自动返回新的观察，一般不需要重复调用。', { window: { type: 'string', description: '窗口标题或程序名里的关键字，例如 Photoshop、记事本、Outlook；省略则看当前正在控制的窗口' } }),
  tool('click', '点击。优先用 id（来自最近一次观察里的编号），自绘界面没有编号时用 x、y（以最近一张截图左上角为原点的像素）。执行后自动返回新的观察和“界面是否变化”。', { id: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' } }),
  tool('type_text', '输入文字（支持中文）。into 填输入框的编号则先聚焦并替换其内容；不填则输入到当前光标处。submit=true 时输入后按回车。', { text: { type: 'string' }, into: { type: 'integer' }, submit: { type: 'boolean' }, append: { type: 'boolean', description: 'true 时不清空原有内容' } }, ['text']),
  tool('press_keys', '按快捷键或按键，例如 ctrl+s、enter、ctrl+shift+n、f5、tab、escape。不允许 Win 键组合和 alt+f4。', { keys: { type: 'string' } }, ['keys']),
  tool('scroll', '滚动鼠标滚轮：amount 正数向上、负数向下。可指定 id 或坐标，默认窗口中央。', { amount: { type: 'integer' }, id: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' } }, ['amount']),
  tool('drag', '按住左键从一点拖到另一点（截图坐标）。用于滑块、框选、画选区、拖放文件。', { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, ['x1', 'y1', 'x2', 'y2']),
  tool('find_text', '用 OCR 在窗口里找某段文字的位置，适合没有控件编号的自绘界面（Photoshop 的菜单、面板、对话框文字）。返回匹配位置，之后可用 click_text 或 click 的坐标。', { text: { type: 'string' } }, ['text']),
  tool('click_text', '用 OCR 找到屏幕上的某段文字并点击它。nth 指第几个匹配（默认第 1 个）。', { text: { type: 'string' }, nth: { type: 'integer' }, double: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, ['text']),
  tool('read_window_text', '读出窗口里的文字内容（按控件树的阅读顺序，含文档正文、列表项、标签）。要读邮件主题、文件列表、网页正文、设置项时用它，比看图可靠。', { window: { type: 'string' }, max_chars: { type: 'integer' } }),
  tool('wait_for', '等待某个条件再继续，避免盲等：窗口里出现某段文字（text），或某个窗口出现（window），gone=true 表示等它消失。最长 60 秒。', { text: { type: 'string' }, window: { type: 'string' }, gone: { type: 'boolean' }, timeout_sec: { type: 'integer' } }),
  tool('zoom', '放大查看最近一次观察里的某个区域（原始分辨率），读小字、看细节。坐标同截图。不能用放大图的坐标点击。', { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, ['x', 'y', 'width', 'height']),
  tool('update_plan', '为复杂任务维护计划清单：每完成一步更新 pending/doing/done/blocked，保留已有节点 id。可指定 depends_on 依赖、criteria 验收标准和 outputs 预期产物；省略依赖按顺序执行。状态只是执行者报告，主任务仍会独立验收。', { steps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, expect: { type: 'string' }, status: { type: 'string', enum: ['pending', 'doing', 'done', 'blocked'] }, depends_on: { type: 'array', items: { type: 'string' } }, criteria: { type: 'array', items: { type: 'object', properties: { check: { type: 'string' }, target: { type: 'string' }, value: { type: 'string' } }, required: ['check'] } }, outputs: { type: 'array', items: { type: 'string' } } }, required: ['text', 'status'] } } }, ['steps']),
  tool('inspect_window', '读取窗口的原始控件树（类型、名称、值、位置）。需要比 observe 更完整的结构、或按文字过滤时用。', { window: { type: 'string' }, limit: { type: 'integer' }, contains: { type: 'string' } }, ['window']),
];
const names = definitions.map(item => item.function.name);

function createControlTools({ host, approve, controlBlocked = BLOCKED_PROCESSES }) {
  // log: what actually worked in this turn, in a form that survives renumbering (element type/name/automation id),
  // so a successful run can be saved as a skill and replayed later without the model.
  const control = { target: null, shot: null, marks: new Map(), started: false, recent: [], log: [] };
  const describe = element => ({ type: element.type, name: String(element.name || '').slice(0, 120), ...(element.aid ? { aid: String(element.aid).slice(0, 120) } : {}) });
  const note = step => { control.log.push(step); if (control.log.length > 200) control.log.shift(); };
  const counts = new Map();

  // ---- bookkeeping ----
  function countAction(ctx, passive = false) {
    if (!host.desktop) throw new Error('当前环境不支持控制其他软件');
    if (ctx.signal?.aborted) throw new Error('任务已停止');
    const turn = ctx.turn || 'default';
    const used = (counts.get(turn) || 0) + (passive ? 0 : 1);
    if (used > MAX_ACTIONS) throw new Error('本轮操作次数已达上限（' + MAX_ACTIONS + '），请向用户汇报进度，让用户决定是否继续。');
    counts.set(turn, used);
  }
  // Code-level brakes: a loop that changes nothing is refused instead of being left to the model's judgement.
  function guard(signature) {
    const tail = control.recent;
    const last2 = tail.slice(-2);
    if (last2.length === 2 && last2.every(item => item.signature === signature && item.noEffect)) throw new Error('同一个操作已连续 2 次没有任何界面变化，再做没有意义。请换一种方法：换一个元素、用快捷键、find_text / click_text、滚动后再找，或者向用户说明卡在哪里。');
    let streak = 0;
    for (let index = tail.length - 1; index >= 0 && tail[index].noEffect; index--) streak++;
    if (streak >= 6) throw new Error('连续 6 次操作都没有产生界面变化。请停下来，向用户说明现状和你的判断，询问怎么继续。');
  }
  const record = (signature, noEffect) => { control.recent.push({ signature, noEffect }); if (control.recent.length > 30) control.recent.shift(); };

  // ---- target selection and consent ----
  async function authorize(ctx, query) {
    if (!host.desktop) throw new Error('当前环境不支持控制其他软件');
    const found = await host.desktop.call('focus', { window: String(query || '') }, { signal: ctx.signal });
    const info = { ...found.window, focused: found.focused };
    const process = String(info.process || '').toLowerCase();
    if (controlBlocked.has(process) || BLOCKED_TITLE.test(info.title)) throw new Error('出于安全考虑，AI 不能控制这个窗口（密码管理器、终端、系统安全、本程序自身）：' + info.title + '。需要命令请用 run_command。');
    await approve(ctx, { key: 'control:' + process, title: '让 AI 控制「' + (info.title || process).slice(0, 40) + '」', lines: [info.title + '（' + process + '）', 'AI 会看到这个窗口的截图，并代替你点击、拖动、输入文字、按快捷键。', '操作期间本程序会最小化；按 Ctrl+Alt+Q 或点“停止”随时中止。'], risk: 'high', label: '软件控制 ' + process });
    if (!control.started) { control.started = true; host.controlStarted?.(); }
    control.target = { hwnd: info.hwnd, process, title: info.title };
    control.marks = new Map();
    return info;
  }
  async function ensureForeground(ctx) {
    if (!control.target) throw new Error('还没有选定要控制的窗口，请先 observe({window})');
    const front = await host.desktop.call('foreground', {}, { signal: ctx.signal });
    if (front.hwnd === control.target.hwnd) return;
    const back = await host.desktop.call('focus', { hwnd: control.target.hwnd }, { signal: ctx.signal });
    if (!back.focused) throw new Error('目标窗口「' + control.target.title + '」不在前台，且无法自动切回。请让用户点一下该窗口，或重新 observe({window})。');
  }

  // ---- observation ----
  async function observeNow(ctx) {
    const target = control.target;
    if (!target) throw new Error('还没有选定要控制的窗口，请先 observe({window})');
    const out = await host.desktop.call('observe', { hwnd: target.hwnd, maxWidth: 1280, maxMarks: 90 }, { signal: ctx.signal, timeout: 45000 });
    control.shot = { originX: out.originX, originY: out.originY, scale: out.scale, width: out.width, height: out.height };
    control.marks = new Map(out.elements.map(item => [item.id, item]));
    control.target = { ...target, title: out.window.title || target.title };
    return out;
  }
  const summarize = element => element.id + ' ' + element.type + (element.name ? ' 「' + String(element.name).slice(0, 60) + '」' : '') + (element.value ? ' = ' + String(element.value).slice(0, 60) : '') + (element.state ? ' [' + element.state + ']' : '') + (element.enabled === false ? ' (禁用)' : '') + ' @(' + element.x + ',' + element.y + ',' + element.w + '×' + element.h + ')';
  function observation(out, extra = {}) {
    const shown = out.elements.slice(0, 80);
    return { ...extra, window: { title: out.window.title, process: out.window.process }, image: out.image, image_size: out.width + '×' + out.height,
      elements: shown.map(summarize), ...(out.elements.length > shown.length ? { more_elements: out.elements.length - shown.length } : {}),
      legend: '图上带编号的框就是 elements 里的同号控件；没有框的区域（画布、自绘界面）用 x、y 或 find_text/click_text。' };
  }

  // One action = wait for focus, remember how the screen looked, act, wait for the UI to settle, report what changed.
  async function act(ctx, signature, summary, perform, step = null) {
    countAction(ctx);
    guard(signature);
    await ensureForeground(ctx);
    const target = control.target;
    const before = await host.desktop.call('hash', { hwnd: target.hwnd }, { signal: ctx.signal }).catch(() => null);
    await perform();
    const settle = await host.desktop.call('settle', { hwnd: target.hwnd, before: before?.hash, timeoutMs: 3500 }, { signal: ctx.signal, timeout: 20000 }).catch(() => null);
    // A dialog or popup of the same program takes over: follow it, otherwise the next step would act on the wrong window.
    let switched = null;
    const front = await host.desktop.call('foreground', {}, { signal: ctx.signal }).catch(() => null);
    if (front && front.hwnd !== target.hwnd && String(front.process).toLowerCase() === target.process) { control.target = { ...target, hwnd: front.hwnd, title: front.title }; switched = front.title; }
    let out;
    try { out = await observeNow(ctx); }
    catch (error) { record(signature, false); if (step) note({ ...step, changed: null }); return { did: summary, changed: null, note: '操作已执行，但之后无法再观察目标窗口（可能已关闭、最小化或被其他窗口完全遮住）：' + error.message + '。用 list_windows 看现状，再 observe({window}) 重新开始。' }; }
    const changed = switched ? true : (settle && typeof settle.changed === 'number' ? settle.changed >= 0.0004 : null);
    record(signature, changed === false);
    if (step) note({ ...step, changed });
    return observation(out, { did: summary, changed, ...(switched ? { window_switched_to: switched, note: '操作打开了新窗口/对话框，之后的操作会作用在它上面；要回到原窗口用 observe({window})。' } : {}),
      ...(changed === false ? { hint: '界面没有可见变化：操作可能没生效（焦点不对、被弹窗挡住、点错了对象、还在加载）。先看图判断原因，不要重复同样的操作。' } : {}) });
  }

  const pointFromShot = (x, y) => {
    const shot = control.shot;
    if (!shot) throw new Error('请先 observe 目标窗口');
    const px = Number(x), py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px > shot.width + 2 || py > shot.height + 2) throw new Error('坐标超出最近一次观察的范围（' + shot.width + '×' + shot.height + '）');
    return { x: Math.round(shot.originX + px / shot.scale), y: Math.round(shot.originY + py / shot.scale) };
  };
  function mark(id) {
    const found = control.marks.get(Number(id));
    if (!found) throw new Error('元素编号 ' + id + ' 不存在或已过期。每次操作后编号都会刷新，请用最新一次观察里的编号。');
    return found;
  }
  const center = element => ({ x: Math.round(element.sx + element.sw / 2), y: Math.round(element.sy + element.sh / 2) });
  async function paste(ctx, text) {
    const previous = host.clipboard?.readText?.() ?? '';
    host.clipboard.writeText(text);
    try { await host.desktop.call('keys', { keys: 'ctrl+v' }, { signal: ctx.signal }); await sleep(300); } finally { host.clipboard.writeText(previous); }
  }
  const FORBIDDEN_KEYS = spec => /(^|\+)(win|windows|meta|cmd|super)(\+|$)/.test(spec) || spec === 'alt+f4' || /ctrl\+alt\+(del|delete)/.test(spec) || spec === 'ctrl+shift+esc';

  async function ocrMatches(ctx, text) {
    if (!control.shot) await observeNow(ctx);
    const { lines } = await host.desktop.call('ocr', { hwnd: control.target.hwnd }, { signal: ctx.signal, timeout: 40000 });
    const wanted = normalize(text);
    if (!wanted) throw new Error('要找的文字为空');
    const hits = [];
    for (const line of lines) {
      const whole = normalize(line.text);
      const wordHits = (line.words || []).filter(word => normalize(word.text).includes(wanted));
      if (wordHits.length) for (const word of wordHits) hits.push({ text: word.text, box: word });
      else if (whole.includes(wanted)) hits.push({ text: line.text, box: line });
    }
    const shot = control.shot;
    return hits.map(hit => ({ text: hit.text, x: Math.round((hit.box.x - shot.originX) * shot.scale), y: Math.round((hit.box.y - shot.originY) * shot.scale), w: Math.round(hit.box.w * shot.scale), h: Math.round(hit.box.h * shot.scale), screen: { x: Math.round(hit.box.x + hit.box.w / 2), y: Math.round(hit.box.y + hit.box.h / 2) } }));
  }

  const impl = {
    async list_windows(_args, ctx) {
      const { windows } = await host.desktop.call('windows', {}, { signal: ctx.signal });
      return { windows: windows.filter(item => !controlBlocked.has(String(item.process).toLowerCase()) && !BLOCKED_TITLE.test(item.title)).map(item => ({ title: item.title, process: item.process, x: item.x, y: item.y, width: item.width, height: item.height, foreground: item.foreground, minimized: item.minimized })) };
    },
    async observe({ window: query }, ctx) {
      countAction(ctx, true);
      if (query) await authorize(ctx, query); else await ensureForeground(ctx);
      const out = await observeNow(ctx);
      if (query) note({ op: 'open', window: String(query), process: control.target.process });
      return observation(out, { note: '之后的点击、输入、按键都会自动返回新的观察，不用重复调用 observe。' });
    },
    async screenshot({ window: query }, ctx) { return impl.observe({ window: query }, ctx); },
    async focus_window({ window: query }, ctx) { return impl.observe({ window: query }, ctx); },
    async click({ id, x, y, button = 'left', double = false }, ctx) {
      if (id === undefined && (x === undefined || y === undefined)) throw new Error('需要 id，或 x 和 y');
      const signature = 'click:' + JSON.stringify({ id, x, y, button, double });
      const known = value => value !== undefined && control.marks.has(Number(value));
      const step = id !== undefined ? (known(id) ? { op: 'click', target: describe(mark(id)), button, double } : null) : control.shot ? { op: 'click_xy', x: Number(x) / control.shot.width, y: Number(y) / control.shot.height, button, double } : null;
      return act(ctx, signature, id !== undefined ? '点击元素 ' + id : '点击 (' + Math.round(x) + ', ' + Math.round(y) + ')', async () => {
        if (id !== undefined) {
          const element = mark(id);
          if (element.enabled === false) throw new Error('元素 ' + id + ' 是禁用状态，点不了。');
          if (button === 'left' && !double && !TEXT_ENTRY.has(element.type)) { await host.desktop.call('invoke', { id: element.id }, { signal: ctx.signal }); return; }
          const point = center(element);
          await host.desktop.call('click', { x: point.x, y: point.y, button, count: double ? 2 : 1 }, { signal: ctx.signal });
        } else {
          const point = pointFromShot(x, y);
          await host.desktop.call('click', { x: point.x, y: point.y, button, count: double ? 2 : 1 }, { signal: ctx.signal });
        }
      }, step);
    },
    async type_text({ text, into, submit = false, append = false }, ctx) {
      const value = String(text ?? '');
      if (!value || value.length > 5000) throw new Error('文字为空或超过 5000 字');
      const step = into === undefined || control.marks.has(Number(into)) ? { op: 'type', text: value, into: into !== undefined ? describe(mark(into)) : null, submit: !!submit, append: !!append } : null;
      return act(ctx, 'type:' + JSON.stringify({ value: value.slice(0, 80), into, submit }), '输入 ' + value.length + ' 个字符' + (into !== undefined ? '到元素 ' + into : ''), async () => {
        if (into !== undefined) {
          const element = mark(into);
          let done = false;
          if (!append && TEXT_ENTRY.has(element.type)) { try { await host.desktop.call('setvalue', { id: element.id, text: value }, { signal: ctx.signal }); done = true; } catch { done = false; } }
          if (!done) {
            const point = center(element);
            await host.desktop.call('click', { x: point.x, y: point.y, button: 'left', count: 1 }, { signal: ctx.signal });
            if (!append) await host.desktop.call('keys', { keys: 'ctrl+a' }, { signal: ctx.signal });
            await paste(ctx, value);
          }
        } else await paste(ctx, value);
        if (submit) { await sleep(120); await host.desktop.call('keys', { keys: 'enter' }, { signal: ctx.signal }); }
      }, step);
    },
    async press_keys({ keys }, ctx) {
      const spec = String(keys || '').toLowerCase().replace(/\s+/g, '');
      if (!spec) throw new Error('keys 为空');
      if (FORBIDDEN_KEYS(spec)) throw new Error('出于安全考虑，不允许这个按键组合：' + keys);
      return act(ctx, 'keys:' + spec, '按键 ' + spec, () => host.desktop.call('keys', { keys: spec }, { signal: ctx.signal }), { op: 'keys', keys: spec });
    },
    async scroll({ amount, id, x, y }, ctx) {
      const clicks = Math.max(-30, Math.min(30, Math.round(Number(amount) || 0)));
      if (!clicks) throw new Error('amount 不能为 0');
      const step = id === undefined || control.marks.has(Number(id)) ? { op: 'scroll', amount: clicks, target: id !== undefined ? describe(mark(id)) : null } : null;
      return act(ctx, 'scroll:' + JSON.stringify({ clicks, id, x, y }), '滚动 ' + clicks, async () => {
        let point;
        if (id !== undefined) point = center(mark(id));
        else if (x !== undefined && y !== undefined) point = pointFromShot(x, y);
        else point = pointFromShot(control.shot.width / 2, control.shot.height / 2);
        await host.desktop.call('scroll', { x: point.x, y: point.y, amount: clicks }, { signal: ctx.signal });
      }, step);
    },
    async drag({ x1, y1, x2, y2 }, ctx) {
      const step = control.shot ? { op: 'drag', from: [Number(x1) / control.shot.width, Number(y1) / control.shot.height], to: [Number(x2) / control.shot.width, Number(y2) / control.shot.height] } : null;
      return act(ctx, 'drag:' + JSON.stringify([x1, y1, x2, y2]), '拖动', async () => {
        const from = pointFromShot(x1, y1), to = pointFromShot(x2, y2);
        await host.desktop.call('drag', { x: from.x, y: from.y, x2: to.x, y2: to.y }, { signal: ctx.signal, timeout: 30000 });
      }, step);
    },
    async find_text({ text }, ctx) {
      countAction(ctx, true);
      await ensureForeground(ctx);
      const matches = await ocrMatches(ctx, text);
      return { query: text, found: matches.length, matches: matches.slice(0, 12).map((item, index) => ({ nth: index + 1, text: item.text, x: item.x + Math.round(item.w / 2), y: item.y + Math.round(item.h / 2), box: [item.x, item.y, item.w, item.h] })), note: matches.length ? 'x、y 是匹配处的中心，可直接用于 click；或用 click_text。' : '没有识别到这段文字。可能被遮挡、太小或在画布里；先 zoom 看清，或换个关键词。' };
    },
    async click_text({ text, nth = 1, double = false, button = 'left' }, ctx) {
      countAction(ctx, true);
      await ensureForeground(ctx);
      const matches = await ocrMatches(ctx, text);
      const match = matches[Math.max(1, Math.round(Number(nth) || 1)) - 1];
      if (!match) throw new Error('屏幕上没有识别到“' + text + '”（共 ' + matches.length + ' 处匹配）。先 observe / zoom 看清界面，或换个关键词。');
      return act(ctx, 'click_text:' + JSON.stringify({ text, nth, double, button }), '点击文字「' + String(match.text).slice(0, 30) + '」', () => host.desktop.call('click', { x: match.screen.x, y: match.screen.y, button, count: double ? 2 : 1 }, { signal: ctx.signal }), { op: 'click_text', text: String(text), nth: Math.max(1, Math.round(Number(nth) || 1)), double: !!double, button });
    },
    async read_window_text({ window: query, max_chars }, ctx) {
      countAction(ctx, true);
      if (query) await authorize(ctx, query); else await ensureForeground(ctx);
      const limit = Math.max(500, Math.min(30000, Math.round(Number(max_chars) || 8000)));
      const { lines } = await host.desktop.call('readtext', { hwnd: control.target.hwnd, maxChars: limit }, { signal: ctx.signal, timeout: 45000 });
      return { window: control.target.title, lines, note: lines.length ? '按控件树的阅读顺序列出；列表里的每一项是一行。' : '这个窗口没有暴露可读文字（自绘界面）：改用 observe 看图，或 find_text（OCR）。' };
    },
    async wait_for({ text, window: query, gone = false, timeout_sec = 15 }, ctx) {
      if (!text && !query) throw new Error('需要 text 或 window');
      countAction(ctx, true);
      const deadline = Date.now() + Math.max(1, Math.min(60, Math.round(Number(timeout_sec) || 15))) * 1000;
      const started = Date.now();
      let hit = false;
      do {
        if (ctx.signal?.aborted) throw new Error('任务已停止');
        let present;
        if (query) { const { windows } = await host.desktop.call('windows', {}, { signal: ctx.signal }); present = windows.some(item => (item.title + ' ' + item.process).toLowerCase().includes(String(query).toLowerCase())); }
        else { if (!control.target) throw new Error('等待文字需要先 observe 目标窗口'); const result = await host.desktop.call('hastext', { hwnd: control.target.hwnd, text }, { signal: ctx.signal, timeout: 30000 }).catch(() => ({ found: false })); present = !!result.found; }
        hit = gone ? !present : present;
        if (!hit) await sleep(700);
      } while (!hit && Date.now() < deadline);
      const waited = Date.now() - started;
      if (hit) note({ op: 'wait', ...(text ? { text: String(text) } : {}), ...(query ? { window: String(query) } : {}), gone: !!gone, timeout_sec: Math.max(10, Math.ceil(waited / 1000) * 3), changed: true });
      if (!hit) return { satisfied: false, waited_ms: waited, note: '超时仍未满足条件。可能还在加载、出现了意外弹窗，或文字不同；observe 看看实际界面。' };
      if (control.target && !query) return observation(await observeNow(ctx), { satisfied: true, waited_ms: waited });
      return { satisfied: true, waited_ms: waited, note: query && !gone ? '窗口已出现；用 observe({window}) 开始控制它。' : undefined };
    },
    async zoom({ x, y, width, height }, ctx) {
      countAction(ctx, true);
      const shot = control.shot;
      if (!shot || !control.target) throw new Error('请先 observe 目标窗口');
      const nums = [x, y, width, height].map(Number);
      if (nums.some(value => !Number.isFinite(value)) || nums[2] < 8 || nums[3] < 8) throw new Error('区域无效');
      await ensureForeground(ctx);
      const left = Math.max(0, nums[0]), top = Math.max(0, nums[1]);
      const rect = { x: Math.round(shot.originX + left / shot.scale), y: Math.round(shot.originY + top / shot.scale), width: Math.round(Math.min(nums[2], shot.width - left) / shot.scale), height: Math.round(Math.min(nums[3], shot.height - top) / shot.scale) };
      const out = await host.desktop.call('region', { ...rect, maxWidth: 1100 }, { signal: ctx.signal, timeout: 30000 });
      return { image: out.image, image_size: out.width + '×' + out.height, note: '这是放大的局部图，不能用它的坐标点击；点击用最近一次观察的坐标或编号。' };
    },
    async update_plan({ steps }, ctx) {
      if (!Array.isArray(steps) || !steps.length || steps.length > 12) throw new Error('steps 需要 1～12 项');
      const plan = normalizePlan(steps.filter(item => String(item?.text || item?.do || '').trim()));
      const committed = await ctx.onPlan?.(plan);
      return { plan: Array.isArray(committed) ? committed : plan };
    },
    async inspect_window({ window: query, limit, contains }, ctx) {
      countAction(ctx, true);
      const info = await authorize(ctx, query);
      const { elements } = await host.desktop.call('inspect', { hwnd: info.hwnd, limit: Math.max(20, Math.min(500, Math.round(Number(limit) || 160))) }, { signal: ctx.signal, timeout: 45000 });
      const needle = String(contains || '').toLowerCase();
      return { window: { title: info.title, process: info.process }, count: elements.length,
        elements: elements.filter(item => !needle || String(item.name).toLowerCase().includes(needle) || String(item.value || '').toLowerCase().includes(needle)).filter(item => needle || item.name || item.value || /Button|Edit|MenuItem|ListItem|TabItem|CheckBox|ComboBox|Hyperlink|Document/.test(item.type)).map(item => ({ id: item.id, type: item.type, name: String(item.name).slice(0, 200), value: item.value ? String(item.value).slice(0, 200) : undefined, enabled: item.enabled, x: item.x, y: item.y, width: item.width, height: item.height })),
        note: '控件很少或没有名称说明这是自绘界面，请改用 observe 看图，或 find_text（OCR）。' };
    },
  };

  // ---- skills: replay a recorded procedure locally, verifying each step; stop and report where it got stuck ----
  function findMark(desc) {
    if (!desc) return null;
    const same = [...control.marks.values()].filter(item => item.type === desc.type);
    return (desc.aid && same.find(item => item.aid === desc.aid && item.name === desc.name))
      || (desc.name && same.find(item => item.name === desc.name))
      || (desc.aid && same.find(item => item.aid === desc.aid))
      || (desc.name && desc.name.length >= 2 && same.find(item => normalize(item.name).includes(normalize(desc.name))))
      || null;
  }
  async function locate(desc, ctx) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const found = findMark(desc);
      if (found) return found;
      await sleep(attempt ? 1000 : 400);
      await observeNow(ctx);
    }
    throw new Error('界面上找不到 ' + desc.type + '「' + desc.name + '」');
  }
  const stepText = step => ({ launch: '启动 ' + step.target, open: '打开窗口 ' + step.window, click: '点击 ' + (step.target?.name || step.target?.type), click_xy: '点击坐标', type: '输入文字', keys: '按键 ' + step.keys, click_text: '点击文字 ' + step.text, scroll: '滚动', drag: '拖动', wait: '等待 ' + (step.text || step.window) })[step.op] || step.op;

  async function replay(steps, params, ctx, { launch } = {}) {
    const fill = text => String(text ?? '').replace(/\{\{(\w+)\}\}/g, (whole, key) => params[key] !== undefined ? String(params[key]) : whole);
    const missing = [...new Set(JSON.stringify(steps).match(/\{\{(\w+)\}\}/g) || [])].map(item => item.slice(2, -2)).filter(key => params[key] === undefined);
    if (missing.length) throw new Error('缺少技能参数：' + missing.join('、'));
    let last = null;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      try {
        if (step.op === 'launch') { if (!launch) throw new Error('当前环境不能启动软件'); await launch(fill(step.target), ctx); await sleep(1200); continue; }
        if (step.op === 'open') {
          const deadline = Date.now() + 20000;
          for (;;) { try { last = await impl.observe({ window: step.window }, ctx); break; } catch (error) { if (Date.now() > deadline || /安全|拒绝/.test(error.message)) throw error; await sleep(1000); } }
          continue;
        }
        if (step.op === 'click') last = await impl.click({ id: (await locate(step.target, ctx)).id, button: step.button, double: step.double }, ctx);
        else if (step.op === 'type') last = await impl.type_text({ text: fill(step.text), into: step.into ? (await locate(step.into, ctx)).id : undefined, submit: step.submit, append: step.append }, ctx);
        else if (step.op === 'keys') last = await impl.press_keys({ keys: step.keys }, ctx);
        else if (step.op === 'click_text') last = await impl.click_text({ text: fill(step.text), nth: step.nth, double: step.double, button: step.button }, ctx);
        else if (step.op === 'scroll') last = await impl.scroll({ amount: step.amount, id: step.target ? (await locate(step.target, ctx)).id : undefined }, ctx);
        else if (step.op === 'click_xy') last = await impl.click({ x: step.x * control.shot.width, y: step.y * control.shot.height, button: step.button, double: step.double }, ctx);
        else if (step.op === 'drag') last = await impl.drag({ x1: step.from[0] * control.shot.width, y1: step.from[1] * control.shot.height, x2: step.to[0] * control.shot.width, y2: step.to[1] * control.shot.height }, ctx);
        else if (step.op === 'wait') { const result = await impl.wait_for({ text: step.text ? fill(step.text) : undefined, window: step.window, gone: step.gone, timeout_sec: step.timeout_sec }, ctx); if (result.satisfied === false) throw new Error('等待超时：' + (step.text || step.window)); if (result.image) last = result; }
        else throw new Error('未知的技能步骤：' + step.op);
        if (step.changed === true && last?.changed === false) throw new Error('操作后界面没有变化，和录制时不一样');
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        return { ok: false, completed: index, total: steps.length, stuck_at: '第 ' + (index + 1) + '/' + steps.length + ' 步：' + stepText(step), error: String(error.message), ...(last || {}), note: '技能在这一步卡住了，前面的步骤已经执行。请看当前界面，从这里接着手动完成；如果界面和录制时不同，完成后可以用 save_skill 重新保存。' };
      }
    }
    return { ok: true, completed: steps.length, total: steps.length, ...(last || {}), note: '技能全部步骤已执行并逐步核对过界面变化。请看最终界面确认结果，再向用户汇报。' };
  }

  const label = (name, args = {}) => {
    const short = value => String(value ?? '').slice(0, 40);
    return ({ list_windows: '查看打开的窗口', observe: '观察：' + short(args.window || '当前窗口'), screenshot: '观察：' + short(args.window), focus_window: '切换到：' + short(args.window),
      click: args.id !== undefined ? '点击元素 ' + args.id + (args.double ? '（双击）' : '') : '点击 (' + Math.round(args.x) + ', ' + Math.round(args.y) + ')' + (args.double ? '（双击）' : ''),
      type_text: '输入：' + short(args.text), press_keys: '按键：' + short(args.keys), scroll: '滚动 ' + (args.amount ?? ''), drag: '拖动', find_text: '找文字：' + short(args.text), click_text: '点击文字：' + short(args.text),
      read_window_text: '读取窗口文字', wait_for: '等待：' + short(args.text || args.window), zoom: '放大查看', inspect_window: '读取控件：' + short(args.window),
      update_plan: '更新计划（' + (Array.isArray(args.steps) ? args.steps.filter(item => item.status === 'done').length + '/' + args.steps.length : '') + '）' })[name];
  };

  return { definitions, impl, names, label, replay, note, takeLog: () => control.log.slice(), endControl: () => { control.started = false; control.target = null; control.shot = null; control.marks = new Map(); control.recent = []; control.log = []; counts.clear(); }, internals: { control, guard, record, findMark } };
}

module.exports = { createControlTools, BLOCKED_PROCESSES, definitions, names };
