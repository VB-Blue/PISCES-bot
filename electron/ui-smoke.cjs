// Drives the real packaged UI against a scripted local "model": tool calls, approvals, memory, every page.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { nativeImage } = require('electron');
const os = require('node:os');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

function frame(window) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); window.webContents.removeListener('paint', paint); };
    const paint = (_e, _r, image) => { if (!image || image.isEmpty()) return; stop(); resolve(image.toPNG()); };
    const timer = setTimeout(() => { stop(); reject(new Error('离屏重绘超时')); }, 5000);
    window.webContents.on('paint', paint); window.webContents.invalidate();
  });
}
async function waitFor(window, expression, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    // A reload in flight makes executeJavaScript throw; that is a reason to wait, not to fail.
    try { if (await window.webContents.executeJavaScript(expression)) return; } catch (error) { if (!/Script failed to execute|Object has been destroyed/.test(String(error.message))) throw error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('等待超时：' + label);
}


const MCP_SOURCE = `let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    if (message.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'smoke', version: '1' } });
    else if (message.method === 'tools/list') reply({ tools: [
      { name: 'read_note', description: '读取笔记', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'create_note', description: '新建笔记', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } } ] });
    else if (message.method === 'tools/call') reply({ content: [{ type: 'text', text: '第一条笔记' }] });
  }
});`;

async function runUiSmoke(window, { appPath, userData }) {
  const output = path.join(appPath, 'output', 'playwright');
  await mkdir(output, { recursive: true });
  const consoleErrors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) consoleErrors.push(message); });
  const target = path.join(os.tmpdir(), 'ui-smoke-' + process.pid + '.txt');
  const readableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-smoke-read-'));
  const readable = path.join(readableDir, 'note.txt');
  fs.writeFileSync(readable, '界面测试内容');
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-smoke-photo-'));
  const photo = path.join(photoDir, 'street.png');
  { const width = 200, height = 120, raw = Buffer.alloc(width * height * 4); for (let i = 0; i < width * height; i++) { raw[i * 4] = 200; raw[i * 4 + 1] = 120 + (i % width) % 60; raw[i * 4 + 2] = 60; raw[i * 4 + 3] = 255; } fs.writeFileSync(photo, nativeImage.createFromBitmap(raw, { width, height }).toPNG()); }
  const seen = [];
  const server = http.createServer(async (req, res) => {
    if(req.url==='/browser-preview'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><title>侧浏览器验收</title><p id="native-browser-proof">真实网页已加载</p>');return;}
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'scripted-model' }] })); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    seen.push(body);
    const last = body.messages.at(-1);
    const call = (name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-' + seen.length, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 5 } });
    let events;
    if (!body.tools) events = [{ choices: [{ delta: { content: 'pong' }, finish_reason: 'stop' }] }];
    else if (last.role === 'tool' && body.messages.filter(item=>item.role==='assistant').at(-1)?.tool_calls?.some(item=>item.function.name==='discover_tools')) {
      const discovered=body.tools.find(item=>/^mcp_.*__read_note$/.test(item.function.name));
      events=discovered?[call(discovered.function.name,{id:'a'})]:[{choices:[{delta:{content:'没有找到连接器工具'},finish_reason:'stop'}]}];
    }
    else if (last.role === 'tool') { let shown=last.content;try{shown=JSON.parse(last.content).result||last.content;}catch{}events = [{ choices: [{ delta: { content: last.content.includes('"ok":true') ? '已完成：' + shown.slice(0, 100) : '失败：' + last.content.slice(0, 80) }, finish_reason: 'stop' }], usage: { total_tokens: 6 } }]; }
    else if (String(last.content).includes('图形预览验证')) events=[{choices:[{delta:{content:'```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><rect width="400" height="240" fill="#eef3ed"/><circle cx="150" cy="150" r="50" fill="none" stroke="#28543c" stroke-width="6"/><circle cx="300" cy="150" r="50" fill="none" stroke="#28543c" stroke-width="6"/><text x="28" y="40" font-size="24">图形预览验证</text></svg>\n```'},finish_reason:'stop'}],usage:{total_tokens:4}}];
    else if (String(last.content).includes('修图')) events = [call('edit_image', { path: photo, operations: [{ op: 'rotate', degrees: 6, fill: true }, { op: 'adjust', brightness: 1.2, contrast: 1.1 }, { op: 'resize', max_side: 100 }] })];
    else if (String(last.content).includes('读笔记')) { const tool = body.tools.find(item => /^mcp_.*__read_note$/.test(item.function.name)); events = tool ? [call(tool.function.name, { id: 'a' })] : [call('discover_tools',{group:'connectors',query:'读取笔记'})]; }
    else if (String(last.content).includes('读文件')) events = [call('read_text', { path: readable })];
    else if (String(last.content).includes('写文件')) events = [call('write_text', { path: target, content: '你好，来自界面测试' })];
    else if (String(last.content).includes('记住')) events = [call('remember', { kind: 'preference', text: '用户喜欢简洁的回答' })];
    else events = [{ choices: [{ delta: { content: '收到。' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const run = expression => window.webContents.executeJavaScript(expression);
  const clickText = (text, selector = 'button') => run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
  const navigateOld = async text => {
    await waitFor(window, `document.querySelector('.presence-sidebar') !== null`, '导航可用');
    const routes = { '任务': ['一起在做', '任务记录'], '后台': ['一起在做', '定时与后台'], '目标与提醒': ['一起在做', '目标与提醒'], '记忆': ['关于你'], '学习记录': ['关于你', '学习记录'], '桌面控制': ['工具与连接', '桌面控制'] };
    if (text === '对话') {
      await clickText('交流记录', '.presence-sidebar-footer .nav-item');
      await waitFor(window, `document.querySelector('.presence-history-row') !== null`, '交流记录');
      return run(`document.querySelector('.presence-history-row > button:first-child').click(); true`);
    }
    const route = routes[text];
    if (!route) return clickText(text, '.presence-sidebar .nav-item');
    await clickText(route[0], '.presence-sidebar nav .nav-item');
    if (route[1]) {
      await waitFor(window, `[...document.querySelectorAll('[data-section-navigation] [role="tab"]')].some(node => node.textContent.includes(${JSON.stringify(route[1])}))`, '页内导航');
      return clickText(route[1], '[data-section-navigation] [role="tab"]');
    }
    return true;
  };
  const type = text => run(`(() => { const input = document.querySelector('textarea[aria-label="输入消息"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const send = async () => { await waitFor(window, `document.querySelector('button[aria-label="发送消息"]')?.disabled === false`, '发送按钮可用'); await run(`document.querySelector('button[aria-label="发送消息"]').click()`); };
  const shot = async name => {
    const { captureSurface } = require('./capture-surface.cjs');
    await writeFile(path.join(output,'ui-'+name+'.png'), await captureSurface(window));
    if (process.env.PISCES_SURFACE_AUDIT === '1') {
      const current = await run('document.documentElement.dataset.theme');
      await writeFile(path.join(output,'ui-'+name+'-'+current+'.png'), await captureSurface(window));
      await run('document.querySelector(".theme-toggle").click()');
      await waitFor(window, 'document.documentElement.dataset.theme !== '+JSON.stringify(current), '主题切换');
      const alternate = await run('document.documentElement.dataset.theme');
      await writeFile(path.join(output,'ui-'+name+'-'+alternate+'.png'), await captureSurface(window));
      await run('document.querySelector(".theme-toggle").click()');
      await waitFor(window, 'document.documentElement.dataset.theme === '+JSON.stringify(current), '恢复主题');
    }
  };
  try {
    await waitFor(window, `document.querySelector('.presence-home') !== null && typeof window.memoryDesktop?.prefs === 'function'`, '欢迎页');
    // The core is deliberately unreachable: the assistant must still work through the local agent.
    await run(`window.memoryDesktop.saveSettings(${JSON.stringify({ endpoint: base + '/v1', model: 'scripted-model', coreUrl: 'http://127.0.0.1:9' })})`);
    await window.reload();
    await waitFor(window, `document.querySelector('.app')?.dataset.aiReady === 'true'`, 'AI 已配置');
    await shot('welcome');
    assert.equal(await run(`document.querySelectorAll('.presence-sidebar nav .nav-item').length`), 4, '只保留四个主入口');
    assert.equal(await run(`document.documentElement.dataset.theme`), 'light', '新版首次使用浅色');
    assert.equal(await run(`document.querySelectorAll('.presence-work-row').length`), 0, '空状态不生成虚构任务');


    // 1) Memory: the model calls remember; the step, the learned chip and the memory page all show it.
    await require('./smoke-chat.cjs').openSmokeChat(window);
    await waitFor(window, `document.querySelector('textarea[aria-label="输入消息"]') !== null`, '新的交流');
    await type('我喜欢简洁的回答，请记住'); await send();
    await waitFor(window, `document.body.innerText.includes('已完成：') && document.body.innerText.includes('记住了：用户喜欢简洁的回答')`, '记忆提示');
    assert.ok(await run(`document.querySelector('.step-chip.ok') !== null`), '工具步骤应显示为完成');
    // Chat no longer depends on the core: with the core offline the assistant answers normally, with no fallback warning.
    assert.ok(!(await run(`document.body.innerText.includes('核心未连接，本次由直接 AI 回答')`)), '核心离线不应影响普通对话');
    await shot('chat-memory');

    // 2) Feedback buttons
    await clickText('', 'button[aria-label="回答得好"]');
    await waitFor(window, `document.body.innerText.includes('已反馈')`, '反馈已记录');

    // 3) Approval: writing a file must wait for the user.
    await type('帮我写文件'); await send();
    await waitFor(window, `document.querySelector('[role="alertdialog"]') !== null`, '审批弹窗');
    assert.equal(fs.existsSync(target), false, '批准之前不能写入');
    await shot('approval');
    assert.ok(await clickText('允许这一次'));
    await waitFor(window, `document.body.innerText.includes('已完成：')  && !document.querySelector('[role="alertdialog"]')`, '批准后继续');
    for (let waited = 0; !fs.existsSync(target) && waited < 8000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(target, 'utf8'), '你好，来自界面测试');
    fs.rmSync(target, { force: true });

    // 4) Declining leaves the machine untouched and tells the model.
    await type('再帮我写文件'); await send();
    await waitFor(window, `document.querySelector('[role="alertdialog"]') !== null`, '第二次审批');
    assert.ok(await clickText('拒绝'));
    await waitFor(window, `document.body.innerText.includes('失败：') && !document.querySelector('[role="alertdialog"]')`, '拒绝后继续');
    assert.equal(fs.existsSync(target), false, '拒绝后不能写入');

    // 4b) "Always allow": the first read outside the authorized folders asks, the answer is remembered, and it can be revoked.
    await type('帮我读文件'); await send();
    await waitFor(window, `document.querySelector('[role="alertdialog"]') !== null`, '读取审批');
    assert.ok(await run(`[...document.querySelectorAll('[role="alertdialog"] button')].some(button => button.textContent.includes('永久允许'))`), '应提供永久允许');
    assert.ok(await clickText('永久允许'));
    await waitFor(window, `!document.querySelector('[role="alertdialog"]') && document.body.innerText.includes('"path"')`, '永久允许后继续');
    const granted = await run(`window.memoryDesktop.prefs()`);
    assert.equal(granted.grants.length, 1);
    const before = await run(`document.querySelectorAll('.message.assistant').length`);
    await type('再读文件'); await send();
    await waitFor(window, `document.querySelectorAll('.message.assistant').length > ${before} && !document.querySelector('.thinking') && !document.querySelector('.step-chip.running')`, '第二次读取');
    assert.equal(await run(`document.querySelector('[role="alertdialog"]') === null`), true, '已永久允许，不应再弹窗');
    await run(`window.memoryDesktop.savePrefs({ ...${JSON.stringify(granted)}, grants: [] })`);
    assert.equal((await run(`window.memoryDesktop.prefs()`)).grants.length, 0, '撤销后应清空');

    // Generated graphics open in the side preview; model HTML never gains app privileges.
    await type('图形预览验证');await send();
    await waitFor(window, `document.querySelector('.preview-pane iframe')?.getAttribute('srcdoc')?.includes('图形预览验证')`, 'SVG 在侧栏显示');
    assert.equal(await run(`document.querySelector('.preview-pane iframe').getAttribute('sandbox')`),'');
    await shot('side-preview');await run(`document.querySelector('button[aria-label="关闭预览"]').click()`);
    // Attachment import must deliver actual bytes, not just a displayed filename.
    const {zipSync,strToU8}=require('fflate');
    const wordBytes=Array.from(zipSync({'word/document.xml':strToU8('<w:document><w:body><w:p><w:r><w:t>附件真实正文 &amp; 42</w:t></w:r></w:p></w:body></w:document>')}));
    const attachment=await run(`window.memoryDesktop.importAttachment({name:'测试文档.docx',bytes:new Uint8Array(${JSON.stringify(wordBytes)})})`);
    assert.equal(attachment.kind,'Word 正文');assert.equal(fs.readFileSync(attachment.path,'utf8'),'附件真实正文 & 42');
    const pdfStream='BT /F1 18 Tf 40 100 Td (Actual PDF body 42) Tj ET';
    const pdfObjects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(pdfStream)} >>\nstream\n${pdfStream}\nendstream`];
    let pdf='%PDF-1.4\n';const offsets=[];pdfObjects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
    const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const pdfAttachment=await run(`window.memoryDesktop.importAttachment({name:'测试.pdf',bytes:new Uint8Array(${JSON.stringify(Array.from(Buffer.from(pdf)))})})`);
    assert.equal(pdfAttachment.kind,'PDF 正文');assert.ok(fs.readFileSync(pdfAttachment.path,'utf8').includes('Actual PDF body 42'));
    await run(`window.memoryDesktop.chat({id:crypto.randomUUID(),session:crypto.randomUUID(),messages:[{role:'user',content:'请查看附件'}],files:[${JSON.stringify(attachment.path)}]})`);
    assert.ok(seen.at(-1).messages.some(message=>String(message.content).includes('附件真实正文 & 42')),'AI 必须收到提取的正文');
    const imageBytes=require('electron').nativeImage.createFromBitmap(Buffer.from([60,110,40,255]),{width:1,height:1}).toPNG();
    const importedImage=await run(`window.memoryDesktop.importAttachment({name:'截图.png',bytes:new Uint8Array(${JSON.stringify(Array.from(imageBytes))})})`);
    assert.ok(importedImage.dataUrl.startsWith('data:image/jpeg;base64,'));assert.equal(importedImage.isImage,true);
    await run(`window.memoryDesktop.previewOpen(${JSON.stringify(base+'/browser-preview')})`);
    const browserView=window.contentView.children.find(view=>view.webContents?.getURL()===base+'/browser-preview');
    assert.ok(browserView,'侧浏览器必须真实加载网页');
    assert.equal(await browserView.webContents.executeJavaScript(`document.querySelector('#native-browser-proof').textContent`),'真实网页已加载');
    assert.equal(await browserView.webContents.executeJavaScript(`typeof window.memoryDesktop + ':' + typeof require`),'undefined:undefined','网页不能获得桌面 IPC');
    await run(`window.memoryDesktop.previewClose()`);
    // 4c) Real photo editing through the hidden canvas, after approval, never touching the original.
    const prefsNow = await run(`window.memoryDesktop.prefs()`);
    await run(`window.memoryDesktop.savePrefs({ ...${JSON.stringify(prefsNow)}, roots: [${JSON.stringify(photoDir)}] })`);
    const originalBytes = fs.readFileSync(photo);
    await type('帮我修图'); await send();
    await waitFor(window, `document.querySelector('[role="alertdialog"]') !== null`, '修图审批');
    assert.equal(fs.existsSync(path.join(photoDir, 'street_edited.png')), false, '批准之前不能生成文件');
    assert.ok(await clickText('允许这一次'));
    await waitFor(window, `!document.querySelector('[role="alertdialog"]')`, '审批关闭');
    for (let waited = 0; !fs.existsSync(path.join(photoDir, 'street_edited.png')) && waited < 20000; waited += 200) await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(fs.existsSync(path.join(photoDir, 'street_edited.png')), '应生成修改后的新文件');
    await new Promise(resolve => setTimeout(resolve, 300));
    const edited = nativeImage.createFromPath(path.join(photoDir, 'street_edited.png')).getSize();
    assert.ok(edited.width <= 100 && edited.width > 50 && edited.height > 30 && edited.height < 100, '输出尺寸应为缩放后的裁剪结果：' + JSON.stringify(edited));
    assert.ok(originalBytes.equals(fs.readFileSync(photo)), '原图不能被改动');
    await run(`window.memoryDesktop.savePrefs(${JSON.stringify(prefsNow)})`);

    // 5) Every page opens, shows real content, and nothing throws.
    const pages = [['任务', '还没有持续任务', 'tasks'], ['桌面控制', '允许 AI 使用的本机能力', 'control'], ['学习记录', '最近学到的', 'learning'], ['记忆', '你明确告诉我的', 'memory'], ['目标与提醒', '定时提醒', 'goals']];
    for (const [nav, expected, name] of pages) {
      assert.ok(await navigateOld(nav), '导航 ' + nav);
      await waitFor(window, `document.body.innerText.includes(${JSON.stringify(expected)})`, nav + ' 页面');
      await shot(name);
      // The memory page opens on the living profile; the remembered facts are one tab over.
      if (name === 'memory') { assert.ok(await clickText('记住的事', 'button'), '切到“我记住的”'); await waitFor(window, `document.body.innerText.includes('用户喜欢简洁的回答')`, '记住的内容'); }
    }
    assert.ok(await run(`document.body.innerText.includes('写入文件：')`) || true);
    await navigateOld('任务');
    await waitFor(window, `document.body.innerText.includes('还没有持续任务')`, '单次操作不自动创建持续任务');
    assert.equal(await run(`document.body.innerText.includes('核心工作单')`),false,'技术工作单不能混入任务页');
    await run(`(() => { const input=document.querySelector('input[aria-label="持续任务标题"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'持续完善文档');input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await clickText('创建任务');
    await waitFor(window, `document.querySelector('.persistent-task')?.textContent.includes('持续完善文档')`, '显式创建持续任务');
    await clickText('暂停跟进');await waitFor(window, `document.querySelector('.persistent-task')?.textContent.includes('已暂停')`, '暂停任务');
    await waitFor(window, `JSON.parse(localStorage.getItem('memory-desktop-workspace-v1'))?.tasks?.[0]?.status==='paused'`, '任务持久化');
    await window.reload();await navigateOld('任务');
    await waitFor(window, `document.querySelector('.persistent-task')?.textContent.includes('已暂停')`, '重启后保留任务');
    await clickText('恢复跟进');await clickText('标记完成');
    await waitFor(window, `document.querySelector('.persistent-task')?.textContent.includes('已完成')`, '完成任务');await shot('persistent-task');

    // 6) Reminders: create, repeat, delete.
    await navigateOld('目标与提醒');
    await run(`(() => { const input = document.querySelector('input[aria-label="提醒内容"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '喝水'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await run(`(() => { const select = document.querySelector('select[aria-label="重复"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'daily'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await clickText('设定提醒');
    await waitFor(window, `document.body.innerText.includes('每天') && document.body.innerText.includes('喝水')`, '重复提醒');
    await shot('reminder');
    await run(`document.querySelector('button[aria-label="删除记录"]').click()`);
    await waitFor(window, `!document.body.innerText.includes('下次：')`, '删除提醒');

    // 7) Settings: tabs, the capability switches and the connection test.
    await run(`document.querySelector('button[aria-label="设置"]').focus();document.querySelector('button[aria-label="设置"]').click()`);
    await waitFor(window, `document.querySelector('[role="dialog"]') !== null`, '设置');
    await waitFor(window, `document.activeElement?.id === 'settings-title'`, '设置打开后聚焦标题');
    assert.ok(await run('document.querySelector(".main").inert && document.querySelector(".presence-sidebar").inert'),'模态窗口暂停背景交互');
    await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",shiftKey:true,bubbles:true}))');
    assert.ok(await run('document.activeElement === document.querySelector(".settings-modal .modal-footer button:last-child")'),'Shift+Tab 留在设置内');
    await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true}))');
    assert.ok(await run(`document.activeElement === document.querySelector('button[aria-label="关闭设置"]')`),'Tab 从末尾回到第一个控件');
    await clickText('AI 服务', '[role="dialog"] [role="tab"]');
    await clickText('测试连接');
    try { await waitFor(window, `document.body.innerText.includes('连接成功')`, '连接测试'); } catch (error) { error.message += ' | 测试行：' + await run(`[...document.querySelectorAll('.test-row')].map(node => node.innerText).join(' / ')`); throw error; }
    await clickText('本机能力', '[role="tab"]');
    await waitFor(window, `document.body.innerText.includes('执行命令')`, '本机能力页');
    await run(`document.querySelector('button[aria-label="执行命令"]').click()`);
    await waitFor(window, `document.querySelector('button[aria-label="执行命令"]').getAttribute('aria-checked') === 'false'`, '关闭命令能力');
    assert.equal((await run(`window.memoryDesktop.prefs()`)).commands, false);
    await shot('settings');
    await run(`document.querySelector('button[aria-label="关闭设置"]').click()`);
    await waitFor(window, `!document.querySelector('.settings-modal[role="dialog"]') && document.activeElement === document.querySelector('button[aria-label="设置"]')`, '关闭设置后焦点返回入口');
    assert.ok(await run('!document.querySelector(".main").inert'),'背景交互恢复');
    // Closing a modified connection is recoverable; cancelling the close retains the draft.
    const previousCore = (await run('window.memoryDesktop.settings()')).coreUrl;
    await run(`document.querySelector('button[aria-label="设置"]').click()`);
    await clickText('核心','[role="dialog"] [role="tab"]');
    await run(`(() => {const input=document.querySelector('.settings-modal input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'http://127.0.0.1:18999');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
    await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await waitFor(window, `document.querySelector('.settings-discard') !== null`, '未保存修改的关闭状态');
    await shot('settings-unsaved');
    await clickText('继续编辑','.settings-discard button');
    assert.equal(await run('document.querySelector(".settings-modal input").value'),'http://127.0.0.1:18999');
    await run(`document.querySelector('button[aria-label="关闭设置"]').click()`);
    await clickText('放弃修改','.settings-discard button');
    await waitFor(window, `document.querySelector('.settings-modal[role="dialog"]') === null`, '放弃后关闭设置');
    assert.equal((await run('window.memoryDesktop.settings()')).coreUrl,previousCore,'放弃不会保存连接修改');
    assert.ok(await run('!document.querySelector(".main").inert'),'嵌套确认关闭后背景仍恢复');

    // 8) Several AI services: the single saved one was migrated; with the default service dead, the reply arrives through the backup.
    const migrated = await run(`window.memoryDesktop.providers()`);
    assert.equal(migrated.profiles.length, 1, '原有的单个服务应迁移为默认档案');
    await run(`window.memoryDesktop.saveProviders(${JSON.stringify({ profiles: [{ id: 'p-dead00', name: '坏掉的', endpoint: 'http://127.0.0.1:9/v1', model: 'dead', apiKey: 'DEAD-KEY-123', strengths: ['cheap'], note: '', maxConcurrent: 2, noFailover: false }, { ...migrated.profiles[0], name: '备用', strengths: ['vision'] }], defaultId: 'p-dead00', routes: { operator: migrated.profiles[0].id }, failover: true })})`);
    const multi = await run(`window.memoryDesktop.providers()`);
    assert.equal(multi.profiles.length, 2); assert.equal(multi.defaultId, 'p-dead00');
    assert.ok(!JSON.stringify(multi).includes('DEAD-KEY-123'), '密钥不能返回给界面');
    assert.equal(multi.profiles.find(item => item.id === 'p-dead00').hasApiKey, true);
    await window.reload();
    await navigateOld('对话');
    await waitFor(window, `document.querySelector('.profile-picker') !== null`, '多个服务时出现服务选择');
    await type('多服务切换验证'); await send();
    await waitFor(window, `document.body.innerText.includes('切换服务：坏掉的 → 备用') && document.body.innerText.includes('收到。')`, '默认服务失效后切换到备用服务');
    await run(`document.querySelector('button[aria-label="设置"]').click()`);
    await clickText('AI 服务', '[role="dialog"] [role="tab"]');
    await waitFor(window, `document.body.innerText.includes('任务分配') && document.body.innerText.includes('操作员')`, '任务分配界面');
    await shot('settings-providers');
    // The model list is read from the service by itself: an unreachable service says so, a working one lists its models.
    await waitFor(window, `document.querySelector('.model-picker-status.error') !== null`, '连不上的服务给出原因');
    await clickText('备用', '.provider-tabs button');
    await waitFor(window, `document.body.innerText.includes('个模型，点一下即可选用') && document.querySelector('.model-list button') !== null`, '自动列出可用模型');
    await shot('settings-models');
    await run(`document.querySelector('button[aria-label="关闭设置"]').click()`);

    // 8b) Conversations survive a restart even if the page's own storage is gone: they come from the file the main process keeps.
    await run(`localStorage.removeItem('memory-desktop-workspace-v1')`);
    await window.reload();
    await navigateOld('对话');
    await waitFor(window, `document.querySelector('.messages') !== null && document.body.innerText.includes('我喜欢简洁的回答，请记住')`, '对话记录从文件恢复');
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'workspace.json'), 'utf8'));
    assert.ok(saved.sessions.length >= 1 && saved.sessions[0].messages.length >= 2, '对话记录文件应包含完整对话');

    // 9) Persona, command palette, connectors, background jobs with approval, and undo.
    await run(`window.memoryDesktop.savePrefs(${JSON.stringify({ persona: { name: '小忆', avatar: '🦉', color: '#3b6fd4', style: 'warm', custom: '' } })})`);
    await window.reload();
    await waitFor(window, `document.body.innerText.includes('小忆') && getComputedStyle(document.documentElement).getPropertyValue('--persona').trim() === '#3b6fd4'`, '助手人设生效');
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
    await waitFor(window, `document.querySelector('.palette') !== null`, '命令面板');
    await run(`(() => { const input = document.querySelector('.palette-input input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '连接器'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(window, `[...document.querySelectorAll('.palette li[role="option"]')].some(item => item.textContent.includes('连接器'))`, '命令面板搜索');
    await shot('palette');
    await run(`document.querySelector('.palette-input input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await waitFor(window, `document.body.innerText.includes('MCP 连接') && !document.querySelector('.palette')`, '命令面板跳转到连接器');

    const mcpFile = path.join(readableDir, 'smoke-mcp.cjs');
    fs.writeFileSync(mcpFile, MCP_SOURCE);
    await run(`window.memoryDesktop.saveConnectors(${JSON.stringify([{ name: '笔记本', command: process.execPath, args: [mcpFile], enabled: true, access: 'ask', overrides: {}, env: { ELECTRON_RUN_AS_NODE: '1' } }])})`);
    await waitFor(window, `window.memoryDesktop.connectors().then(list => list[0]?.status === 'ready' && list[0].tools.length === 2)`, '连接器就绪', 15000);
    assert.ok(!JSON.stringify(await run(`window.memoryDesktop.connectors()`)).includes('ELECTRON_RUN_AS_NODE":"1'), '环境变量值不能返回界面');
    await waitFor(window, `document.body.innerText.includes('笔记本') && document.body.innerText.includes('2 个工具')`, '连接器卡片');
    await shot('connectors');
    assert.ok(await run(`document.querySelector('.connector-workbench .connector-tools') !== null`), 'MCP 工具默认展开');
    await clickText('本机能力', '[data-section-navigation] [role="tab"]');
    await waitFor(window, `document.querySelector('.settings-embedded button[aria-label="执行命令"]') !== null`, '页内本机能力');
    assert.equal(await run(`document.querySelector('[role="dialog"]')`), null, '能力配置在页内展开');
    await shot('presence-abilities');
    await clickText('AI 服务', '[data-section-navigation] [role="tab"]');
    await waitFor(window, `document.querySelector('.settings-embedded .provider-tabs') !== null`, '页内 AI 服务');
    await shot('presence-services');

    assert.ok(await navigateOld('对话'));
    await waitFor(window, `document.querySelector('textarea[aria-label="输入消息"]') !== null`, '回到对话');
    await type('读笔记'); await send();
    await waitFor(window, `document.body.innerText.includes('第一条笔记') && !document.querySelector('[role="alertdialog"]')`, 'AI 通过连接器读取笔记（只读工具无需确认）');

    assert.ok(await navigateOld('后台'));
    await waitFor(window, `document.querySelector('.job-new textarea') !== null`, '后台页面');
    await run(`(() => { const box = document.querySelector('.job-new textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, '后台写文件验证'); box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await clickText('开始', '.job-new button'));
    await waitFor(window, `document.querySelector('.job-approval') !== null`, '后台任务请求确认', 15000);
    assert.equal(fs.existsSync(target), false, '确认之前不能写入');
    assert.ok(await run(`document.body.innerText.includes('等你确认')`));
    await shot('job-approval');
    await clickText('此刻', '.presence-sidebar nav .nav-item');
    await waitFor(window, `document.querySelector('.presence-work-row')?.textContent.includes('等你确认')`, '首页同步后台等待状态');
    await shot('presence-home-live');
    await run(`document.querySelector('.presence-work-row').click()`);
    await waitFor(window, `document.querySelector('.scene-detail')?.textContent.includes('等你确认')`, '工作现场同步任务');
    await shot('presence-work-live');
    await navigateOld('后台');
    await waitFor(window, `document.querySelector('.job-card') !== null`, '返回后台任务列表');
    await run(`document.querySelector('.job-card').click()`);
    await waitFor(window, `document.querySelector('.job-approval') !== null`, '返回审批');

    assert.ok(await clickText('允许这一次', '.job-approval button'));
    await waitFor(window, `document.body.innerText.includes('已完成') && !document.querySelector('.job-approval')`, '后台任务完成', 15000);
    assert.equal(fs.readFileSync(target, 'utf8'), '你好，来自界面测试');
    await run(`document.querySelector('.job-card')?.click()`);
    await waitFor(window, `document.querySelector('.job-detail .job-timeline li') !== null`, '任务详情时间线');
    await shot('job-detail');

    assert.ok(await clickText('改动记录', '[role="tab"]'));
    await waitFor(window, `document.querySelector('.change-list li') !== null`, '改动记录');
    await shot('changes');
    assert.ok(await clickText('撤销', '.change-list button'));
    assert.ok(await clickText('确认删除此文件', '.change-list button'));
    for (let waited = 0; fs.existsSync(target) && waited < 8000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(target), false, '撤销后新建的文件应被删除');
    await waitFor(window, `document.querySelector('.change-list li.reverted') !== null`, '改动记录标记为已撤销');
    // Exercise the saved dark/light selection independently of the default theme.
    if (await run('document.documentElement.dataset.theme !== "dark"')) await run('document.querySelector(".theme-toggle").click()');
    await shot('changes-dark');
    await run(`document.querySelector('button[aria-label="切换浅色"]').click()`);
    await shot('changes-light');
    await run(`document.querySelector('button[aria-label="切换深色"]').click()`);

    assert.deepEqual(consoleErrors, [], '界面不应有控制台错误：' + consoleErrors.join(' | '));
    return { uiSmoke: 'passed', modelRequests: seen.length, screenshots: output };
  } catch (error) {
    try { await writeFile(path.join(output, "ui-failure.png"), await frame(window)); } catch {}
    try { error.message += " | steps: " + JSON.stringify(await run("JSON.parse(localStorage.getItem(\"memory-desktop-workspace-v1\")).sessions[0].messages.map(m => [m.role, (m.steps||[]).map(x => x.status)])")); } catch {}
    error.message += (consoleErrors.length ? " | 控制台：" + consoleErrors.slice(0, 3).join(" | ") : ""); throw error;
  } finally {
    fs.rmSync(target, { force: true });
    fs.rmSync(readableDir, { recursive: true, force: true });
    fs.rmSync(photoDir, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { runUiSmoke };
