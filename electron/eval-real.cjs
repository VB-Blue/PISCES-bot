// Real-task evaluation: runs the actual assistant (same prompt, tools, memory and learner as the app)
// against the user's configured model, inside an isolated sandbox, and grades each task.
// Usage: npx electron electron/eval-real.cjs [task-id ...]
// Nothing touches the user's real memory, files or desktop: files live in output/eval/<run>/, software control is off.
const { app, BrowserWindow, safeStorage, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { runAssistant } = require('./assistant-worker.cjs');
const memory = require('./memory.cjs');
const { createTools } = require('./tools.cjs');
const { learn } = require('./learner.cjs');
const imageEdit = require('./image-edit.cjs');
const { DesktopAgent } = require('./desktop-agent.cjs');
const controlNames = require('./control-tools.cjs').names;
// --desktop: run the software tasks, which drive real apps on this screen (only Notepad and Calculator are allowed).
const desktopMode = process.argv.includes('--desktop');
const DESKTOP_APPS = /记事本|notepad|计算器|calculator|calc/i;
const tasks = require('../evals/tasks.cjs');
const subjectStore = require('./subject/store.cjs');
const { createExecutive } = require('./subject/executive.cjs');
// --loop: evaluate the old single LLM loop instead of the subject, for comparison.
const loopMode = process.argv.includes('--loop');

app.disableHardwareAcceleration();
// Hidden helper windows (photo fixture, image editing) come and go; closing them must not end the run.
app.on('window-all-closed', () => {});
const realUserData = path.join(app.getPath('appData'), 'MemoryDesktopAssistant');
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outRoot = path.join(__dirname, '..', 'output', 'eval', runId);
app.setPath('userData', path.join(outRoot, '_electron'));
// safeStorage on Windows keys off the profile's "Local State"; a copy lets this isolated profile read the saved API key.
fs.mkdirSync(path.join(outRoot, '_electron'), { recursive: true });
try { fs.copyFileSync(path.join(realUserData, 'Local State'), path.join(outRoot, '_electron', 'Local State')); } catch {}
// The copy is only needed while the run is going; it never stays behind in the output folder.
const forgetKeyCopy = () => { try { fs.rmSync(path.join(outRoot, '_electron', 'Local State'), { force: true }); } catch {} };
process.on('exit', forgetKeyCopy);

// Tools that cannot touch the user's desktop or real folders.
const ALLOWED = ['get_environment', 'web_search', 'news_search', 'fetch_url', 'list_dir', 'find_files', 'edit_image', 'read_text', 'write_text', 'write_document', 'edit_text', 'search_text', 'run_command', 'remember', 'recall', 'save_playbook', 'update_plan'];

function provider() {
  const store = JSON.parse(fs.readFileSync(path.join(realUserData, 'providers.json'), 'utf8'));
  const main = store.profiles.find(item => item.id === store.defaultId) || store.profiles[0];
  if (!main) throw new Error('没有配置 AI 服务');
  const prefs = (() => { try { return JSON.parse(fs.readFileSync(path.join(realUserData, 'prefs.json'), 'utf8')); } catch { return {}; } })();
  return { settings: { endpoint: main.endpoint, model: main.model, maxTokens: prefs.maxTokens && prefs.maxTokens !== 8192 ? prefs.maxTokens : 32000 }, apiKey: main.apiKeyEncrypted ? safeStorage.decryptString(Buffer.from(main.apiKeyEncrypted, 'base64')) : '' };
}

async function tiltedPhoto(file) {
  const win = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;overflow:hidden;background:#cfe3f3"><div style="position:absolute;inset:-80px;transform:rotate(7deg);background:linear-gradient(#9cc9ef 0 52%,#6f8f5a 52% 100%)">
    <div style="position:absolute;left:28%;top:22%;width:120px;height:300px;background:#b6a48c;border:4px solid #7d6d58"></div><div style="position:absolute;left:46%;top:30%;width:200px;height:240px;background:#d9cbb3;border:4px solid #8f7f66"></div>
    <div style="position:absolute;left:70%;top:15%;width:90px;height:370px;background:#a7b4bf;border:4px solid #6b7782"></div><div style="position:absolute;left:0;right:0;top:52%;height:6px;background:#555"></div></div></body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(resolve => setTimeout(resolve, 400));
  const image = await win.webContents.capturePage();
  fs.writeFileSync(file, image.toJPEG(88));
  win.destroy();
}

async function sandbox(dir) {
  const box = { root: dir };
  for (const name of ['Desktop', 'Documents', 'Downloads', 'Pictures']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  const downloads = ['发票_2026-09.pdf', '合同扫描.pdf', 'IMG_2031.jpg', 'IMG_2032.jpg', 'screenshot_0915.png', '季度报表.xlsx', '客户名单.xlsx', 'setup_wechat.exe', 'VSCodeUserSetup.exe', '会议纪要.docx', '简历_最终版.docx', 'music_demo.mp3', 'archive_photos.zip', 'readme.txt'];
  for (const name of downloads) fs.writeFileSync(path.join(dir, 'Downloads', name), name.endsWith('.txt') ? '说明文件' : 'placeholder:' + name);
  const notes = path.join(dir, 'Documents', '工作笔记');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, '周一.md'), '# 周一\n- 和后端对齐支付接口字段，确定用新版签名\n- 修复订单列表分页 bug（已上线）\n- 下午产品评审：会员页改版，需要出两版设计\n');
  fs.writeFileSync(path.join(notes, '周三.md'), '# 周三\n- 支付接口联调完成 70%，回调验签还有问题\n- 用户反馈退款状态不同步，定位到消息队列重复消费，修复中\n- 面试一位前端候选人，倾向录用\n');
  fs.writeFileSync(path.join(notes, '周五.md'), '# 周五\n- 退款 bug 已修复并补了单测\n- 季度评审材料完成初稿，下周一交给主管\n- 风险：支付回调验签依赖第三方文档，可能延期到下周三\n');
  const rows = [['日期', '产品', '数量', '单价']];
  const sales = { '无线耳机 Pro': [[120, 499], [95, 499], [80, 469]], '智能手表 S3': [[60, 1299], [45, 1299]], '机械键盘 K8': [[150, 399], [70, 399]], '便携投影仪': [[25, 2199], [10, 2099]], '降噪耳罩 X': [[40, 899], [22, 899]], '手机壳': [[600, 39]], '数据线': [[900, 19]], '蓝牙音箱 Mini': [[80, 199]] };
  let day = 1;
  for (const [name, list] of Object.entries(sales)) for (const [qty, price] of list) rows.push(['2026-09-' + String(day++).padStart(2, '0'), name, qty, price]);
  fs.writeFileSync(path.join(dir, 'Documents', '销售数据.csv'), '﻿' + rows.map(row => row.join(',')).join('\n'));
  box.tilted = path.join(dir, 'Pictures', '街景_IMG_0412.jpg');
  await tiltedPhoto(box.tilted);
  return box;
}

// Commands may only touch the sandbox: no deletion, no paths outside it, nothing the app's own deny-list blocks.
const safeCommand = (command, root, deny) => {
  if (deny.some(pattern => pattern.test(command)) || /\$env:|~[\\/]|\.\.[\\/]|\b(Remove-Item|rm|del|erase|rd|rmdir)\b/i.test(command)) return false;
  const paths = command.match(/[a-z]:\\[^"'\s;|]*/gi) || [];
  return paths.every(item => item.toLowerCase().startsWith(root.toLowerCase()));
};

async function judge(target, task, transcript, check, profile, files, attempt = 0) {
  const response = await fetch(target.settings.endpoint.replace(/\/$/, '') + (target.settings.endpoint.endsWith('/chat/completions') ? '' : '/chat/completions'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + target.apiKey },
    body: JSON.stringify({ model: target.settings.model, stream: false, max_tokens: 24000, messages: [
      { role: 'system', content: '你是严格的评审，评估一个个人桌面助手完成真实任务的质量。只输出 JSON：{"score":0-10,"pass":true|false,"asked_instead_of_doing":true|false,"strengths":["…"],"problems":["…"]}。score≥7 且满足评分标准的核心要求才算 pass。' },
      { role: 'user', content: JSON.stringify({ task: task.title, rubric: task.rubric, today: new Date().toLocaleDateString('zh-CN'), automatic_check: check, transcript, user_profile_after: profile, files_created: files }).slice(0, 60000) },
    ] }),
  });
  const payload = await response.json();
  const text = String(payload.choices?.[0]?.message?.content || '');
  try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch {
    if (attempt < 4) return judge(target, task, transcript, check, profile, files, attempt + 1);
    return { score: 0, pass: false, problems: ['评审输出无法解析：' + text.slice(0, 200)] };
  }
}

async function runTask(target, task) {
  const dir = path.join(outRoot, task.id);
  const box = await sandbox(dir);
  await memory.init(path.join(dir, 'memory'));
  await subjectStore.init(path.join(dir, 'memory'));
  const executive = createExecutive({ store: subjectStore, memory, runAssistant, getRoots: () => [dir], similarity: memory.similarity });
  const before = new Set(fs.readdirSync(dir, { recursive: true }).map(String));
  const host = { path: name => ({ desktop: path.join(dir, 'Desktop'), documents: path.join(dir, 'Documents'), downloads: path.join(dir, 'Downloads'), home: dir, pictures: path.join(dir, 'Pictures') })[name] || dir,
    openExternal: async () => {}, editImage: (bytes, mime, ops, format) => imageEdit.runInWindow(BrowserWindow, bytes, mime, ops, format), checkpoints: null };
  if (task.desktop) Object.assign(host, { desktop: new DesktopAgent({ dir: path.join(dir, 'agent') }), clipboard: { readText: () => clipboard.readText(), writeText: text => clipboard.writeText(text) }, controlStarted: () => {} });
  const tools = createTools({ memory, userDataDir: path.join(dir, 'userdata'), host, getPrefs: () => ({ web: true, files: true, commands: true, apps: !!task.desktop, control: !!task.desktop, roots: [dir] }) });
  const allowed = task.desktop ? [...ALLOWED, ...controlNames, 'launch_app', 'find_app', 'run_skill', 'save_skill'] : ALLOWED;
  const view = tools.view([...new Set(allowed)].filter(name => tools.has(name)));
  const approvals = [];
  const ask = async request => {
    const lines = (request.lines || []).join(' ');
    const ok = /执行 PowerShell/.test(request.title) ? safeCommand(String(request.lines?.[0] || ''), dir, tools.internals.COMMAND_DENY)
      : /控制|启动/.test(request.title) ? DESKTOP_APPS.test(request.title + ' ' + lines)
      : !/[a-z]:\\/i.test(lines) || lines.toLowerCase().includes(dir.toLowerCase());
    approvals.push({ title: request.title, decision: ok ? 'once' : 'deny' });
    return ok ? 'once' : 'deny';
  };
  let messages = [];
  const transcript = [];
  const answers = [];
  const started = Date.now();
  let calls = 0, tokens = 0;
  const turnCalls = [], turnTools = [];
  for (const turn of task.turns) {
    if (turn.newSession) messages = [];
    const images = turn.image ? ['data:image/jpeg;base64,' + fs.readFileSync(box.tilted).toString('base64')] : undefined;
    const attachNote = turn.image ? '用户本轮附带的文件（本机路径）：\n- ' + path.basename(box.tilted) + '：' + box.tilted : '';
    messages.push({ role: 'user', content: turn.text + (turn.image ? '\n\n[包含图片附件: ' + path.basename(box.tilted) + ']' : ''), ...(images ? { images } : {}) });
    const context = memory.buildContext(turn.text, { session: task.id });
    const callsBefore = calls;
    const steps = [];
    let result;
    try {
      const agent = { ...target, primaryName: 'eval', core: async body => body.action === 'reserve_call' ? { call: { id: 'c' + (++calls) } } : { work: {} },
        work: { id: task.id + '-' + transcript.length, session: task.id, goal: turn.text, profile_snapshot: {}, files: [], roles: ['executor'], profile_revision: 0 },
        messages: messages.map(({ role, content, images: pics }) => ({ role, content, ...(pics ? { images: pics } : {}) })), signal: AbortSignal.timeout(1800000), emit: () => {}, receipt: null, coreTools: false, maxTurns: 100,
        localTools: view, askTool: ask, memoryContext: [context.text, attachNote].filter(Boolean).join('\n\n'), userText: turn.text,
        persona: { name: 'PISCES AI' }, userProfile: memory.getProfile(), progress: step => { if (step.phase === 'settled' && step.label) steps.push((step.ok === false ? '✗' : '✓') + step.label); } };
      result = loopMode ? await runAssistant(agent) : await executive.handle({ target, request: turn.text, attachments: attachNote, session: task.id, messages: agent.messages, tools: view, signal: agent.signal, agent, progress: agent.progress });
    } catch (error) { result = { text: '【运行失败】' + error.message, trace: [] }; }
    tokens += result.usage?.total_tokens || 0;
    turnCalls.push(result.modelCalls ?? (calls - callsBefore));
    turnTools.push((result.trace || []).map(item => item.tool));
    delete messages.at(-1).images;
    messages.push({ role: 'assistant', content: result.text + (steps.length ? '\n\n〔这一轮实际执行的操作：' + steps.join('；').slice(0, 1500) + '〕' : '') });
    answers.push(result.text);
    // The grader sees the real tool calls (arguments and result excerpts), not just the short UI labels.
    transcript.push({ user: turn.text, new_session: !!turn.newSession, subject: result.subject ? { route: result.subject.route, passed: result.subject.passed, local: result.subject.localUnderstanding, unmet: result.subject.unmet } : null, steps, tool_calls: (result.trace || []).map(item => ({ tool: item.tool, ok: item.ok, args: String(item.args).slice(0, 300), result: String(item.result).slice(0, 300) })), answer: result.text.slice(0, 6000) });
    // The same post-turn learner the app runs.
    try { await learn({ memory, session: task.id, ...target, user: turn.text, assistant: result.text, steps: steps.map(label => ({ label, ok: label.startsWith('✓') })), recent: messages.slice(0, -2) }); } catch (error) { transcript.at(-1).learn_error = error.message; }
  }
  const crashed = answers.find(text => text.startsWith('【运行失败】'));
  const check = crashed ? { ok: false, note: crashed.slice(0, 120) } : task.check(box, before, answers, { profile: () => memory.getProfile(), memories: () => memory.listMemories(), turnCalls, turnTools });
  const created = fs.readdirSync(dir, { recursive: true }).map(String).filter(item => !before.has(item) && !/^(memory|userdata)/.test(item));
  const files = created.filter(item => /\.(md|txt|html|csv)$/i.test(item)).slice(0, 5).map(item => ({ path: item, head: fs.readFileSync(path.join(dir, item), 'utf8').slice(0, 1500) }));
  const graded = [...files, ...created.filter(item => !/\.(md|txt|html|csv)$/i.test(item)).map(item => ({ path: item }))];
  const verdict = await judge(target, task, transcript, check, memory.getProfile(), graded);
  await memory.flush();
  await subjectStore.flush();
  try { host.desktop?.stop(); } catch {}
  return { id: task.id, title: task.title, seconds: Math.round((Date.now() - started) / 1000), modelCalls: calls, turnCalls, tokens, approvals, check, verdict, transcript, profile: memory.getProfile(), files: graded };
}

function report(results, model) {
  const passed = results.filter(item => item.verdict.pass && item.check.ok).length;
  const lines = ['# 真实任务评测 ' + runId, '', '模型：' + model + '　执行方式：' + (loopMode ? '旧的 LLM 主循环' : 'PISCES AI主体') + '　通过：**' + passed + ' / ' + results.length + '**（自动检查与评审都通过才算）', '',
    '| 任务 | 自动检查 | 评审分 | 反问代替动手 | 用时 | 模型调用 |', '|---|---|---|---|---|---|',
    ...results.map(item => `| ${item.title} | ${item.check.ok ? '✓' : '✗'} ${item.check.note} | ${item.verdict.score ?? '-'} ${item.verdict.pass ? '✓' : '✗'} | ${item.verdict.asked_instead_of_doing ? '是' : '否'} | ${item.seconds}s | ${item.modelCalls}${item.turnCalls?.length > 1 ? '（每轮 ' + item.turnCalls.join(' → ') + '）' : ''} |`), ''];
  for (const item of results) {
    lines.push('## ' + item.title, '', '**问题：** ' + (item.verdict.problems || []).join('；'), '', '**做得好：** ' + (item.verdict.strengths || []).join('；'), '');
    for (const turn of item.transcript) lines.push('> 用户' + (turn.new_session ? '（新对话）' : '') + '：' + turn.user, '', '操作：' + (turn.steps.join(' → ') || '无'), '', turn.answer.slice(0, 1500), '');
    if (item.profile) lines.push('**评测后的用户画像：**', '', '```', item.profile, '```', '');
  }
  return { passed, markdown: lines.join('\n') };
}

// Only one run at a time: two runs in parallel double the cost and fight over the desktop.
const lockFile = path.join(__dirname, '..', 'output', 'eval', '.running');
function takeLock() {
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); return false; } catch {} }
  } catch {}
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));
  process.on('exit', () => { try { if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.rmSync(lockFile, { force: true }); } catch {} });
  return true;
}

app.whenReady().then(async () => {
  let code = 0;
  if (!takeLock()) { console.error('已有一个评测正在运行（' + lockFile + '），这次不启动。'); app.exit(1); return; }
  try {
    fs.mkdirSync(outRoot, { recursive: true });
    const target = provider();
    const rejudge = process.argv.indexOf('--rejudge');
    if (rejudge > 0) {
      const dir = path.resolve(process.argv[rejudge + 1]);
      const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
      // Task ids after the directory are re-checked and re-graded even if they already have a verdict (e.g. after a rubric fix).
      const forced = process.argv.slice(rejudge + 2).filter(arg => !arg.startsWith('-'));
      for (const item of results) {
        const force = forced.includes(item.id);
        if (!force && item.verdict.score && !String(item.verdict.problems || '').includes('无法解析')) continue;
        const task = tasks.find(entry => entry.id === item.id);
        if (force && !String(item.check.note).startsWith('【运行失败】')) item.check = task.check({ root: path.join(dir, item.id) }, new Set(fs.readdirSync(path.join(dir, item.id), { recursive: true }).map(String)), item.transcript.map(turn => turn.answer), { profile: () => item.profile || '', memories: () => [] });
        const files = item.files || fs.readdirSync(path.join(dir, item.id), { recursive: true }).map(String).filter(name => /^(Desktop|Documents|Downloads|Pictures)/.test(name) && /\.(md|txt|html)$/i.test(name) && !/工作笔记|readme/.test(name)).map(name => ({ path: name, head: fs.readFileSync(path.join(dir, item.id, name), 'utf8').slice(0, 1500) }));
        item.verdict = await judge(target, task, item.transcript, item.check, item.profile, files);
        console.log('重新评审', item.id, item.verdict.score, item.verdict.pass ? '通过' : '未通过');
      }
      fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2));
      const { passed, markdown } = report(results, target.settings.model);
      fs.writeFileSync(path.join(dir, 'report.md'), markdown);
      console.log('通过 ' + passed + ' / ' + results.length);
      forgetKeyCopy();
      app.exit(0);
      return;
    }
    const wanted = process.argv.slice(2).filter(arg => !arg.startsWith('-') && !arg.endsWith('.cjs'));
    const chosen = wanted.length ? tasks.filter(task => wanted.includes(task.id)) : tasks.filter(task => !!task.desktop === desktopMode);
    const results = [];
    for (const task of chosen) {
      process.stdout.write('▶ ' + task.title + ' … ');
      const result = await runTask(target, task);
      results.push(result);
      console.log((result.check.ok && result.verdict.pass ? '通过' : '未通过') + '（评审 ' + result.verdict.score + '，' + result.seconds + 's）');
      fs.writeFileSync(path.join(outRoot, 'results.json'), JSON.stringify(results, null, 2));
      // Out of balance or quota: every further task would fail the same way, so stop instead of producing noise.
      if (/HTTP (402|429)/.test(result.check.note) && /余额|套餐|额度|quota|balance|insufficient/i.test(result.check.note)) { console.log('AI 服务的余额或套餐额度用完了，评测提前停止。'); break; }
    }
    const { passed, markdown } = report(results, target.settings.model);
    fs.writeFileSync(path.join(outRoot, 'report.md'), markdown);
    console.log('\n通过 ' + passed + ' / ' + results.length + '　报告：' + path.join(outRoot, 'report.md'));
  } catch (error) { console.error('评测失败：', error); code = 1; }
  forgetKeyCopy();
  app.exit(code);
});
