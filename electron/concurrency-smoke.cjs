// Real renderer + IPC + model transport, using isolated profiles and local scripted services.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function run(window, { appPath, userData }) {
  const execute = async source => { try { return await window.webContents.executeJavaScript(source); } catch (error) { throw new Error(error.message + '\nRenderer check: ' + source.slice(0, 300)); } };
  const wait = async (check, label, timeout = 12000) => {
    const end = Date.now() + timeout;
    while (!(await check())) { if (Date.now() > end) throw new Error('等待超时：' + label); await new Promise(resolve => setTimeout(resolve, 40)); }
  };
  const seen = [], held = new Map(), aborted = new Set();
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'pisces-concurrency-actions-'));
  const service = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"general"},{"id":"code"},{"id":"research"},{"id":"vision"}]}'); return; }
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts));
    const lastUser = [...body.messages].reverse().find(item => item.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
    const marker = /任务[A-Z]|审批[12]/.exec(text)?.[0];
    seen.push({ marker, model: body.model, key: req.headers.authorization });
    if (marker?.startsWith('审批')) {
      const file = path.join(sandbox, marker + '.txt');
      const message = body.messages.some(item => item.role === 'tool') ? { role: 'assistant', content: marker + '结束' } : {
        role: 'assistant', content: '', tool_calls: [{ id: marker, type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: file, content: marker }) } }] };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { total_tokens: 12 } })); return;
    }
    if (!marker) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '本地测试回复' }, finish_reason: 'stop' }] })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: marker + '片段；' } }] }) + '\n\n');
    held.set(marker, res); res.on('close', () => { if (!res.writableEnded) aborted.add(marker); });
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + service.address().port;
  const finish = marker => { const res = held.get(marker); assert.ok(res, marker + '必须开始'); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: marker + '完成' }, finish_reason: 'stop' }], usage: { total_tokens: 24 } }) + '\n\ndata: [DONE]\n\n'); };
  const ui = expression => wait(() => execute(expression), expression);
  const click = selector => execute(`(() => { const button=document.querySelector(${JSON.stringify(selector)}); if(!button)throw new Error('Missing button'); button.click(); })()`);
  const fill = text => execute(`(() => { const input=document.querySelector('textarea[aria-label="输入消息"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const newChat = async () => { await require('./smoke-chat.cjs').openSmokeChat(window); await ui('!!document.querySelector("textarea[aria-label=输入消息]") && !document.querySelector("textarea[aria-label=输入消息]").disabled'); };
  const send = async text => { await fill(text); await click('button[aria-label="发送消息"]'); };
  const history = () => click('.presence-sidebar-footer > button:first-child');
  const openHistory = async title => { await history(); await ui(`Array.from(document.querySelectorAll('.presence-history-row')).some(item=>item.textContent.includes(${JSON.stringify(title)}))`); await execute(`Array.from(document.querySelectorAll('.presence-history-row')).find(item=>item.textContent.includes(${JSON.stringify(title)})).querySelector('button').click()`); };
  const workspace = () => execute('(() => { window.dispatchEvent(new Event("beforeunload")); return JSON.parse(window.memoryDesktop.loadWorkspace()); })()');
  const saveScreenshot = async name => {
    await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise(resolve => setTimeout(resolve, 250));
    const png = await new Promise((resolve, reject) => {
      const paint = (_event, _rectangle, image) => { if (image.isEmpty()) return; clearTimeout(timer); window.webContents.removeListener('paint', paint); resolve(image.toPNG()); };
      const timer = setTimeout(() => { window.webContents.removeListener('paint', paint); reject(new Error('截图重绘超时')); }, 5000);
      window.webContents.on('paint', paint); window.webContents.invalidate();
    });
    await fs.mkdir(path.join(appPath, 'output', 'playwright'), { recursive: true });
    await fs.writeFile(path.join(appPath, 'output', 'playwright', name + '.png'), png);
  };
  let passed = 0;
  const check = (condition, message) => { assert.ok(condition, message); passed++; };
  try {
    const profiles = [
      { id: 'smoke-main', name: '主力 API', model: 'general', strengths: ['strong'], maxConcurrent: 2 },
      { id: 'smoke-code', name: '代码 API', model: 'code', strengths: ['code'], maxConcurrent: 1 },
      { id: 'smoke-research', name: '资料 API', model: 'research', strengths: ['fast'], maxConcurrent: 2 },
      { id: 'smoke-vision', name: '看图 API', model: 'vision', strengths: ['vision'], maxConcurrent: 1 },
    ].map(item => ({ ...item, endpoint, apiKey: item.model + '-TEST-KEY' }));
    await execute(`window.memoryDesktop.saveProviders(${JSON.stringify({ profiles, defaultId: 'smoke-main', routes: {}, failover: true })})`);
    await execute(`window.memoryDesktop.savePrefs({subject:false,autoLearn:false,delegate:false,roots:[${JSON.stringify(sandbox)}]})`);
    await window.webContents.reload(); await ui('document.querySelector(".app")?.dataset.aiReady === "true"');
    await newChat(); await send('任务A 写一段 Python 代码'); await wait(() => held.has('任务A'), 'A开始');
    await newChat(); await send('任务B 搜索新闻资料'); await wait(() => held.has('任务B'), 'B开始');
    await ui('document.querySelector(".app").dataset.runningCount === "2"');
    check(seen.find(item => item.marker === '任务A').model === 'code' && seen.find(item => item.marker === '任务B').model === 'research', '两个对话按能力分配到不同 API');
    await newChat(); await fill('草稿C：下次继续');
    await execute('(() => {const picker=document.querySelector(".profile-picker");picker.value="smoke-code";picker.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await openHistory('任务A'); await ui('document.querySelector("textarea[aria-label=输入消息]").disabled');
    check(await execute('document.querySelector(".messages").textContent.includes("任务A片段") && !document.querySelector(".messages").textContent.includes("任务B片段")'), '切回运行中的对话，流式回复没有串线');
    await openHistory('新对话');
    check(await execute('document.querySelector("textarea[aria-label=输入消息]").value === "草稿C：下次继续" && document.querySelector(".profile-picker").value === "smoke-code"'), '每段对话保留自己的草稿和服务选择');
    await execute('Array.from(document.querySelectorAll("nav button")).find(item=>item.textContent.trim()==="一起在做").click()');
    await ui('document.querySelectorAll(".scene-list-row").length >= 2');
    await execute('Array.from(document.querySelectorAll(".scene-list-row")).find(item=>item.textContent.includes("任务A")).click()');
    await click('button[aria-label="停止当前任务"]');
    await ui('document.querySelector(".app").dataset.runningCount === "1"');
    await wait(() => aborted.has('任务A'), 'A已取消');
    check(!aborted.has('任务B'), '在工作区单独停止 A，不中止 B');
    await saveScreenshot('multi-conversation-work');
    finish('任务B'); await ui('document.querySelector(".app").dataset.runningCount === "0"');
    let saved = await workspace();
    check(saved.sessions.find(item => item.title.startsWith('任务B')).messages.at(-1).content === '任务B片段；任务B完成', '后台完成的回复保存到正确的对话');
    check(saved.sessions.find(item => item.draft?.startsWith('草稿C')).profile === 'smoke-code', '草稿与指定 API 可以保存到磁盘');

    await newChat(); await send('任务D 写 Python 脚本'); await wait(() => held.has('任务D'), 'D开始');
    await newChat(); await send('任务E 编写代码'); await ui('document.querySelector(".app").dataset.runningCount === "2"');
    const job = await execute('window.memoryDesktop.createJob({goal:"任务F 搜索新闻资料"})');
    await wait(() => held.has('任务F'), '后台任务F开始');
    check(!held.has('任务E') && seen.find(item => item.marker === '任务F').model === 'research', '同 API 达到额度时排队，另一个 API 的后台任务继续');
    await click('button[aria-label="停止回复"]'); await ui('document.querySelector(".app").dataset.runningCount === "1"');
    finish('任务D'); finish('任务F'); await ui('document.querySelector(".app").dataset.runningCount === "0"');
    await wait(async () => (await execute('window.memoryDesktop.jobs()')).find(item => item.id === job.id)?.status === 'done', '后台任务完成');
    check(!seen.some(item => item.marker === '任务E'), '排队中的对话取消后不再调用 API');

    await newChat(); await execute('(() => {const picker=document.querySelector(".profile-picker");picker.value="smoke-code";picker.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await send('任务X 搜索新闻资料'); await wait(() => held.has('任务X'), '手动服务任务开始');
    check(seen.find(item => item.marker === '任务X').model === 'code', '手动选择优先于自动分配');
    finish('任务X'); await ui('document.querySelector(".app").dataset.runningCount === "0"');
    saved = await workspace(); check(saved.sessions.find(item => item.title.startsWith('任务X')).messages.at(-1).service.id === 'smoke-code', '回复记录实际使用的 API');

    const approvals = [1, 2].map(index => ({ id: randomUUID(), session: randomUUID(), messages: [{ role: 'user', content: '审批' + index + ' 搜索资料并写测试文件' }] }));
    await execute(`(() => { window.approvalCalls = ${JSON.stringify(approvals)}.map(args => window.memoryDesktop.chat(args).then(result=>({ok:true,result})).catch(error=>({ok:false,error:String(error)}))); return true; })()`);
    await wait(() => seen.filter(item => item.marker?.startsWith('审批')).length >= 2, '两个审批请求到达');
    await ui('!!document.querySelector(".auth-modal")');
    const first = await execute('document.querySelector(".auth-modal").textContent.includes("审批1.txt") ? "审批1" : "审批2"');
    await saveScreenshot('multi-conversation-approval');
    await click('.auth-modal .button.primary');
    const second = first === '审批1' ? '审批2' : '审批1';
    await ui(`document.querySelector('.auth-modal')?.textContent.includes(${JSON.stringify(second + '.txt')})`);
    check(true, '第一个审批结束后，第二个审批仍可处理');
    await click('.auth-modal .button.primary'); await execute('Promise.all(window.approvalCalls)');
    check(await fs.readFile(path.join(sandbox, '审批1.txt'), 'utf8') === '审批1' && await fs.readFile(path.join(sandbox, '审批2.txt'), 'utf8') === '审批2', '并发审批分别执行各自的文件操作');

    await ui('!document.querySelector(".auth-modal")');
    await history(); await ui('!!document.querySelector(".presence-history")'); await saveScreenshot('multi-conversation-history');
    await window.webContents.reload(); await ui('!!document.querySelector(".app")');
    await openHistory('新对话');
    check(await execute('document.querySelector("textarea[aria-label=输入消息]").value === "草稿C：下次继续"'), '重新载入后草稿仍然保留');
    const report = { ok: true, checks: passed, profiles: profiles.map(item => ({ name: item.name, model: item.model, maxConcurrent: item.maxConcurrent })), calls: seen.map(({ marker, model }) => ({ marker, model })), screenshots: ['multi-conversation-work.png', 'multi-conversation-approval.png', 'multi-conversation-history.png'], paidCalls: 0 };
    await fs.mkdir(path.join(appPath, 'output'), { recursive: true }); await fs.writeFile(path.join(appPath, 'output', 'multi-conversation-smoke.json'), JSON.stringify(report, null, 2));
    return report;
  } catch (error) { await saveScreenshot('multi-conversation-failed').catch(() => {}); throw error; }
  finally { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
}
module.exports = { run };
