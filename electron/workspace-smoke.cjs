// Renderer/IPC acceptance fixtures. Isolated profile, actual fixture files, no model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { summarizeObservation } = require('./subject/observation.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(window, { appPath, userData, workspaceFile }) {
  const output = path.join(appPath, 'output', 'workspaces'); await fs.mkdir(output, { recursive: true });
  const files = path.join(userData, 'workspace-fixtures'); await fs.mkdir(files);
  const when = new Date().toISOString(), docPath = path.join(files, '项目周报.md'), csvPath = path.join(files, '销售数据.csv');
  const oldDraft = '# 项目周报\n\n提交日期：周五\n\n## 当前工作\n\n已完成数据汇总，等待金额与排名核对。';
  await fs.writeFile(docPath, oldDraft); const before = await fs.readFile(docPath, 'utf8');
  const draft = '# 项目周报\n\n提交日期：周四\n\n## 本周进展\n\n完成销售数据汇总，按销售额核对排名。\n\n## 下一步\n\n补齐异常记录，交付结果。\n\n' + '已完成的工作都有对应的文件和记录，未核对的内容继续保留。\n\n'.repeat(25) + '结尾标记：已校对';
  await fs.writeFile(docPath, draft); const after = await fs.readFile(docPath, 'utf8');
  await fs.writeFile(csvPath, '地区,销售额,订单数\n华东,128000,86\n华南,96500,64\n华北,81300,52\n西南,62700,43\n其他,-8200,0\n');
  const csv = await fs.readFile(csvPath, 'utf8');
  const receipt = (operation, data, revision = 1) => ({ id: randomUUID(), operation, file_id: null, status: 'observed_success', evidence: { source: 'desktop_bridge', turn_id: 'isolated-fixture', revision, observation: summarizeObservation({ ok: true, ...data }) }, error: null });
  const make = (id, goal, presentation, result, receipts, status = 'checked_by_desktop') => ({ id, session: 'session-' + id, goal, status, profile_revision: 0, created_at: when, roles: [], calls: [], receipts, result, replay_of: null, cognition: { revision: presentation === 'document' ? 2 : 1, updated_at: when, request: goal, turns: [], intent: { type: 'task', goal, presentation, done_criteria: [{ check: 'judgement', value: '结果符合本轮任务要求' }] }, plan: [], verification: {}, active_turn: null } });
  const doc = make(randomUUID(), '项目周报 · 已按周四期限修改', 'document', '周报已按新期限更新，正文留在文件中。', [receipt('read_text', { path: docPath, text: before, size: Buffer.byteLength(before) }), receipt('write_text', { path: docPath, bytes: Buffer.byteLength(after) }, 2), receipt('read_text', { path: docPath, text: after, size: Buffer.byteLength(after) }, 2)]);
  doc.cognition.intent.done_criteria = [{check:'file_contains',target:docPath,value:'提交日期：周四'}];
  doc.cognition.verification = {result:{passed:after.includes('提交日期：周四'),checks:[{passed:after.includes('提交日期：周四'),how:'文件读回包含当前提交日期'}]}};
  const data = make(randomUUID(), '销售分析 · 核对销售额与订单数', 'data', '统计口径：按地区展示原表的销售额与订单数，其他地区包含退款。', [receipt('read_text', { path: csvPath, text: csv, size: Buffer.byteLength(csv) })], 'running');
  const directoryRows = (await fs.readdir(files, { withFileTypes: true })).map(item => ({ name: item.name, type: item.isDirectory() ? 'dir' : 'file' }));
  const organization = make(randomUUID(), '文件整理 · 工作资料目录', 'files', '先查看现有文件。已读回周报和数据，不删除原文件。', [receipt('list_dir', { path: files, entries: directoryRows, count: directoryRows.length }), receipt('read_text', { path: docPath, text: after }), receipt('read_text', { path: csvPath, text: csv })]);
  const research = make(randomUUID(), '资料研究 · 方案比较与来源', 'research', '## 当前结论\n\n两份资料对适用场景有不同侧重，需要根据现有环境选择。\n\n|方案|适用情况|\n|---|---|\n|方案 A|已有工具可以直接使用|\n|方案 B|需要额外配置|\n\n未读取的搜索线索仍需确认。', [receipt('web_search', {results:[{url:'https://example.com/guide-a',title:'方案 A：已有环境中的使用方式',snippet:'隔离验收来源样例，用于测试来源状态展示。'},{url:'https://example.com/guide-b',title:'方案 B：安装与配置',snippet:'这是搜索线索，尚无原文读取回执。'}]}),receipt('fetch_url', {url:'https://example.com/guide-a',title:'方案 A：已有环境中的使用方式',text:'隔离来源样例的原文内容。'})]);
  const desktop = make(randomUUID(), '软件操作 · 记事本里的购物清单', 'desktop', '窗口观察保留在这里。尚未声明内容已经保存。', [receipt('list_windows',{windows:[{title:'购物清单.txt - 记事本',process:'notepad.exe'}]}),receipt('inspect_window',{window:'购物清单.txt - 记事本',title:'购物清单.txt - 记事本',process:'notepad.exe'})], 'unverified');
  const works = [data, doc, organization, research, desktop];
  const state = { ok: true, subject_id: 'isolated-workspace-fixture', profile: { user_id: 'isolated-owner', revision:0,display_name:'',preferences:'',goals:'',boundaries:'',updated_at:when,source:'unconfigured' }, works: works.map(work => ({ ...work, receipts: work.receipts.map(item => ({...item,evidence:{...item.evidence,observation:item.evidence.observation.slice(0,800)}})) })), methods: [], continuity:{schema:1,facts:[],events:[]}, limits:{model_calls:250,tool_steps:400,file_bytes:500000} };
  let detailReads = 0, failNextDetail = null, offline = false;
  const fixtureServer = http.createServer(async (req, res) => {
    if (offline) { res.writeHead(503); res.end('isolated connection failure'); return; }
    if (req.method === 'POST' && req.url.endsWith('/assistant/request')) {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks));
        const work = request.action === 'work_detail' && works.find(item => item.id === request.work_id);
        if (work) {
          detailReads++;
          if (failNextDetail === work.id) { failNextDetail = null; res.writeHead(503); res.end('isolated detail failure'); return; }
          res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true,work:{...work,status:state.works.find(item=>item.id===work.id).status}})); return;
        }
      } catch {}
      res.writeHead(405); res.end('read-only fixture'); return;
    }
    if(req.method !== 'GET'){res.writeHead(405);res.end('read-only fixture');return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.url.includes('/assistant/state') ? state : {ok:true}));
  });
  await new Promise(resolve => fixtureServer.listen(0,'127.0.0.1',resolve));
  const execute = async code => { try { return await window.webContents.executeJavaScript(code) } catch(error) { throw new Error(error.message + ' | 执行片段：' + code.slice(0, 220)) } };
  const errors = []; window.webContents.on('console-message', details => { if(details.level==='error')errors.push(details.message); });
  const wait = async (expression, label) => { for(let count=0;count<90;count++){if(await execute(expression))return;await pause(100);}throw new Error('工作区未就绪：'+label); };
  const click = async label => { assert.equal(await execute(`(() => {const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim().includes(${JSON.stringify(label)}));if(!button)return false;button.click();return true})()`),true,label); };
  const shot = async name => {
    const { captureSurface } = require('./capture-surface.cjs');
    await fs.writeFile(path.join(output,name+'.png'), await captureSurface(window));
    if (process.env.PISCES_SURFACE_AUDIT !== '1') return;
    const current = await execute('document.documentElement.dataset.theme');
    await fs.writeFile(path.join(output,name+'-'+current+'.png'), await captureSurface(window));
    await execute('document.querySelector(".theme-toggle").click()');
    await wait('document.documentElement.dataset.theme !== '+JSON.stringify(current), '主题切换');
    const alternate = await execute('document.documentElement.dataset.theme');
    await fs.writeFile(path.join(output,name+'-'+alternate+'.png'), await captureSurface(window));
    const metrics = await execute(`(() => {
      const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}; };
      const style=getComputedStyle(document.documentElement);
      return {theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,composer:rect('.presence-home .composer'),dock:rect('.work-inline-composer'),tokens:Object.fromEntries(['--text','--muted','--faint','--bg','--surface','--accent','--primary'].map(token=>[token,style.getPropertyValue(token).trim()]))};
    })()`);
    assert.ok(metrics.scrollWidth <= metrics.width, '桌面内容没有横向溢出');
    if (metrics.composer) assert.ok(metrics.composer.bottom <= metrics.height, '主题切换后首页输入区仍可见');
    if (metrics.dock) assert.ok(metrics.dock.bottom <= metrics.height, '主题切换后任务输入区仍可见');
    await fs.writeFile(path.join(output,name+'-surface.json'), JSON.stringify(metrics,null,2));
    if (name === 'home-overview') {
      const protocol = window.webContents.debugger;
      protocol.attach('1.3');
      try {
        await protocol.sendCommand('DOM.enable'); await protocol.sendCommand('CSS.enable');
        const { root } = await protocol.sendCommand('DOM.getDocument');
        const typography = [];
        for (const selector of ['.presence-intro h1','.presence-intro p','.presence-work-row b','.presence-work-row p','.nav-item.active']) {
          const { nodeId } = await protocol.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector});
          const fonts = await protocol.sendCommand('CSS.getPlatformFontsForNode',{nodeId});
          const styles = await execute('(() => { const style=getComputedStyle(document.querySelector('+JSON.stringify(selector)+')); return {family:style.fontFamily,weight:style.fontWeight,size:style.fontSize}; })()');
          typography.push({selector,styles,...fonts});
        }
        await fs.writeFile(path.join(output,'typography.json'),JSON.stringify(typography,null,2));
      } finally { protocol.detach(); }
    }
    await execute('document.querySelector(".theme-toggle").click()');
    await wait('document.documentElement.dataset.theme === '+JSON.stringify(current), '恢复主题');
  };
  const choose = async (title, kind, name = kind) => { await click(title);await wait(`document.querySelector('.task-workspace')?.dataset.kind===${JSON.stringify(kind)}`,title);await shot(name); };
  try {
    await wait('typeof window.memoryDesktop?.saveWorkspaceSync === "function"','IPC');
    await execute(`window.memoryDesktop.saveSettings(${JSON.stringify({coreUrl:'http://127.0.0.1:'+fixtureServer.address().port})})`);
    const workspace={version:1,appearanceVersion:2,theme:'dark',sessions:works.map(work=>({id:work.session,title:work.goal,mode:'core',updated:when,messages:[{id:'user-'+work.id,role:'user',content:work.goal},{id:'reply-'+work.id,role:'assistant',content:work.result,coreWorkId:work.id,taskEvidence:{workId:work.id,revision:work.cognition.revision,receipts:work.receipts}}]})),tasks:[{id:'followup-fixture',title:'持续跟进 · 补齐异常记录',notes:'需要补齐异常数据，完成后继续核对周报。',status:'active',createdAt:when,updatedAt:when}],traces:[],goals:[],observe:true,approval:'pending',memoryHidden:[]};
    // A reopened task must recover its full saved observations even without a message cache.
    delete workspace.sessions.find(session => session.id === doc.session).messages[1].taskEvidence;
    // Finish the old page's beforeunload save before installing fixtures through the real file owner.
    const appUrl = window.webContents.getURL(); await window.loadURL('about:blank'); await workspaceFile.whenIdle(); workspaceFile.writeSync(JSON.stringify(workspace));
    await window.loadURL(appUrl); await wait('document.querySelector(".presence-home") !== null','首页');
    await wait('[...document.querySelectorAll(".presence-work-row")].some(item=>item.textContent.includes("销售分析"))','首页真实任务载入');
    await shot('home-overview');
    assert.ok(await execute('document.querySelector(".presence-home .new-work-form").getBoundingClientRect().bottom <= innerHeight'), '首页输入区留在首屏');
    const originalSize = window.getSize(); window.setSize(1024,820); await shot('home-narrow');
    assert.ok(await execute('document.querySelector(".presence-home .new-work-form").getBoundingClientRect().bottom <= innerHeight'), '小窗口首页输入区仍可操作');
    window.setSize(...originalSize);
    await execute('document.querySelector(".home-overview button").click()');
    await wait('document.querySelectorAll(".scene-list-row").length === 1','首页需处理数量跳到对应筛选');
    assert.ok(await execute('document.querySelector("[data-section-navigation]") !== null && document.querySelector(".presence-view-header") === null'),'子导航收进侧栏，工作区不重复大标题');
    await click('全部');
    await wait('[...document.querySelectorAll(".scene-list-row")].some(item=>item.textContent.includes("销售分析"))','核心任务载入'); await click('销售分析 ·');
    await wait('document.querySelector(".task-workspace")?.dataset.kind === "data"','数据工作区');
    assert.equal(await execute('document.querySelector(".task-workspace").dataset.phase'),'executing');
    assert.equal(await execute('document.querySelectorAll(".task-data-grid tbody tr").length'),5);
    assert.equal(await execute('document.querySelector(".task-chart-row b").textContent'),'128000');
    await execute(`(() => {const select=document.querySelector('select[aria-label="图表数值"]');select.value='2';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait('document.querySelector(".task-chart-row b")?.textContent === "86"','切换指标');
    await execute(`(() => {const select=document.querySelector('select[aria-label="图表数值"]');select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait('document.querySelector(".task-chart-track .negative") !== null','返回销售额');
    await execute('document.querySelectorAll(".task-data-grid th button")[1].click()');
    await wait('document.querySelector(".task-data-grid tbody tr td:nth-child(2)")?.textContent==="-8200"','真实数值排序');
    await click('恢复原表顺序');
    assert.ok(await execute('document.querySelector(".task-chart-track .negative") !== null'));
    await execute(`(() => {const input=document.querySelector('input[aria-label="筛选当前表格"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'华东');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait('document.querySelectorAll(".task-data-grid tbody tr").length===1','筛选数据');
    await execute(`(() => {const input=document.querySelector('input[aria-label="筛选当前表格"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    state.works[0].status='checked_by_desktop';await execute('window.dispatchEvent(new Event("focus"))');
    await wait('document.querySelector(".task-workspace")?.dataset.phase === "result"','阶段随核心更新');await shot('data');
    failNextDetail = doc.id; await choose('项目周报 ·','document');
    await wait('document.querySelector(".work-load-state.error") !== null','详情失败必须可见且可恢复');
    assert.ok(await execute('document.querySelector(".work-detail-heading").textContent.includes("项目周报")'), '详情失败仍保留任务');
    await shot('detail-retry'); await click('重新读取');
    await wait('document.querySelector(".task-document-paper")?.textContent.includes("结尾标记：已校对")','重新打开任务读取完整已保存正文');
    assert.ok(detailReads >= 2, '详情通过任务接口读取，不能依赖消息缓存');
    await execute(`(() => {const input=document.querySelector('textarea[aria-label="补充当前任务要求"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'补充一条尚未发送的要求');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await choose('销售分析 ·','data','data-draft-isolation');
    assert.equal(await execute('document.querySelector(".work-inline-composer textarea").value'),'');
    await choose('项目周报 ·','document');
    assert.equal(await execute('document.querySelector(".work-inline-composer textarea").value'),'补充一条尚未发送的要求');
    await execute('document.querySelector(".work-canvas").scrollTop=2000');await pause(100);
    assert.ok(await execute('document.querySelector(".work-compose-dock").getBoundingClientRect().bottom<=innerHeight+1'),'正文滚动不应带走输入区');
    await execute('document.querySelector(".work-canvas").scrollTop=0');
    await execute('document.querySelector(".work-detail-actions button[aria-expanded]").click()');await wait('document.querySelector(".work-inspector") !== null','执行详情侧栏');await shot('document-inspector');
    assert.ok(await execute('document.querySelector(".inspector-criteria .verification-check") !== null'), '侧栏必须保留真实核对依据');
    await execute('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await wait('document.querySelector(".work-inspector") === null','Escape 关闭任务详情');
    assert.ok(await execute('document.activeElement === document.querySelector(".work-detail-actions button[aria-expanded]")'), '关闭详情返回触发按钮');
    await click('查看修改对比');await wait('document.querySelector(".task-document-comparison") !== null','修改对比');assert.ok(await execute('document.querySelector(".task-document-comparison").textContent.includes("周五")'));await shot('document-comparison');
    await choose('文件整理 ·','files');assert.ok(await execute('document.querySelectorAll(".task-file-row").length>=2'));
    await click('查看内容');await wait('document.querySelector(".preview-pane iframe") !== null','文件内容预览');await execute(`document.querySelector('button[aria-label="关闭预览"]').click()`);
    await choose('资料研究 ·','research');assert.equal(await execute('document.querySelectorAll(".task-source-row").length'),2);
    await execute(`(() => {const select=document.querySelector('select[aria-label="筛选资料来源"]');select.value='read';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait('document.querySelectorAll(".task-source-row").length===1','原文来源筛选');
    await choose('软件操作 ·','desktop');assert.equal(await execute('document.querySelector(".task-workspace").dataset.phase'),'review');assert.ok(await execute('document.querySelector(".task-window-observations").textContent.includes("记事本")'));
    await choose('持续跟进 ·','followup');assert.equal(await execute('document.querySelector(".task-workspace").dataset.phase'),'followup');
    await execute(`(() => {const select=document.querySelector('select[aria-label="任务展示方式"]');select.value='general';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait('document.querySelector(".task-workspace")?.dataset.kind === "general"','手动更换展示');
    await execute(`(() => {const select=document.querySelector('select[aria-label="任务展示方式"]');select.value='auto';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait('document.querySelector(".task-workspace")?.dataset.kind === "followup"','恢复自动展示');
    await click('需处理');await wait('document.querySelectorAll(".scene-list-row").length===1','待处理筛选');
    await click('全部');
    const arrowSelection = await execute('(() => {const rows=[...document.querySelectorAll(".scene-list-row")]; rows[0].focus(); rows[0].dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})); return rows[1].textContent;})()');
    await wait('document.activeElement?.getAttribute("aria-selected") === "true"','方向键切换任务');
    assert.equal(await execute('document.activeElement.textContent'), arrowSelection);
    await execute(`(() => {const input=document.querySelector('input[aria-label="搜索当前工作"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'不存在的任务');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait('document.querySelector(".work-list-empty") !== null','搜索空状态');await click('清除筛选');
    await choose('项目周报 ·','document');
    await window.webContents.reload();await wait('document.querySelector(".presence-home") !== null','重新打开界面');await click('一起在做');await wait('document.querySelector(".work-inline-composer textarea")?.value === "补充一条尚未发送的要求"','任务草稿重启恢复');
    window.setSize(1024,820);await choose('销售分析 ·','data','data-narrow');await pause(150);assert.ok(await execute('document.querySelector(".task-workspace").getBoundingClientRect().right <= innerWidth + 1'),'窄窗口不得把工作区挤出屏幕');
    await click('调整口径');await wait(`document.querySelector('textarea[aria-label="补充当前任务要求"]')?.value.includes('调整分析口径')`,'续做要求留在工作现场');
    assert.ok(await execute('document.querySelector(".work-inline-composer") !== null && document.querySelector(".app").dataset.view === "work"'));
    const keptDraft = await execute('document.querySelector(".work-inline-composer textarea").value');
    offline = true; await execute('window.dispatchEvent(new Event("focus"))'); await wait('document.querySelector(".work-connection-state") !== null','断线状态可见');
    assert.equal(await execute('document.querySelector(".work-inline-composer textarea").value'),keptDraft,'断线保留草稿');
    await window.webContents.reload(); await wait('document.querySelector(".presence-home") !== null','离线重新打开');
    await click('一起在做'); await wait('document.querySelector(".work-connection-state") !== null','离线读取失败结束加载');
    await wait('document.querySelector(".work-inline-composer textarea") !== null','离线仍可查看本地工作记录');
    assert.equal(await execute('document.querySelector(".work-inline-composer textarea").value'),keptDraft,'离线重开也必须恢复当前任务草稿');
    offline = false; await click('重连'); await wait('document.querySelector(".work-connection-state") === null','恢复核心连接');
    // Locale changes use the real UI and IPC; saved task content must remain untouched.
    window.setSize(...originalSize);
    const prefsBefore = await execute('window.memoryDesktop.prefs()');
    const savedBefore = JSON.parse(await execute('window.memoryDesktop.loadWorkspace()')).sessions;
    const switchLanguage = async value => {
      if (!await execute('document.querySelector(".settings-modal") !== null')) await execute('document.querySelector(".presence-sidebar-footer button[aria-label]").click()');
      await wait('document.querySelector(".settings-modal") !== null','language settings');
      await execute('document.querySelector("#settings-nav-general").click()');
      await wait('document.querySelector(".language-preference select") !== null','language selector');
      await execute('(() => { const select=document.querySelector(".language-preference select");select.value='+JSON.stringify(value)+';select.dispatchEvent(new Event("change",{bubbles:true}));})()');
      await wait('document.documentElement.lang === '+JSON.stringify(value)+' && document.querySelector(".language-preference select")?.disabled === false','language applied and saved');
      assert.equal(await execute('window.memoryDesktop.uiLocale()'),value,'locale saved by the desktop owner');
      assert.equal(JSON.parse(await fs.readFile(path.join(userData,'prefs.json'),'utf8')).uiLocale,value,'locale saved to disk for the next process');
    };
    await switchLanguage('en'); await shot('language-en-settings');
    assert.ok(await execute('document.querySelector(".settings-body").textContent.includes("Interface language")'),'English settings');
    assert.equal(await execute('/[\\u3400-\\u9fff]/.test((() => {const body=document.querySelector(".settings-body").cloneNode(true);body.querySelector(".language-preference select")?.remove();return body.textContent;})())'),false,'General settings has no untranslated Chinese UI text');
    assert.ok(await execute('document.querySelector(".capability-row .wide-input").previousElementSibling.getBoundingClientRect().width > 260'),'English setting descriptions retain room');
    for(const tab of ['persona','ai','abilities','core']) {
      await execute('document.querySelector("#settings-nav-'+tab+'").click()'); await shot('language-en-settings-'+tab);
      assert.equal(await execute('/[\\u3400-\\u9fff]/.test(document.querySelector(".settings-body").textContent)'),false,'English '+tab+' settings has no untranslated UI text');
    }
    await execute('Promise.all([window.memoryDesktop.saveUiLocale("en"), window.memoryDesktop.prefs().then(prefs=>window.memoryDesktop.savePrefs(prefs))])');
    assert.equal(JSON.parse(await fs.readFile(path.join(userData,'prefs.json'),'utf8')).uiLocale,'en','saving other preferences never overwrites the interface language');
    await execute('document.querySelector("button[aria-label=\\"Close settings\\"]").click()');
    await execute('document.querySelector(".presence-sidebar nav button").click()'); await shot('language-en-home');
    assert.ok(await execute('document.querySelector(".presence-intro h1").textContent.includes("attention")'),'English home');
    await execute('document.querySelector(".sidebar-search").click()');
    await wait('document.querySelector(".palette-input input") !== null','English command palette');
    await execute('(() => {const input=document.querySelector(".palette-input input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"settings");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
    await wait('[...document.querySelectorAll(".palette [role=option]")].some(item=>/settings/i.test(item.textContent))','search translated commands');
    await shot('language-en-palette'); await execute('document.querySelector(".palette-input input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await window.webContents.reload();
    await wait('document.querySelector(".presence-home") !== null && document.documentElement.lang === "en"','English restored after reload');
    await execute('document.querySelectorAll(".presence-sidebar nav button")[1].click()'); await click('销售分析 ·');
    await wait('document.querySelector(".task-workspace")?.dataset.kind === "data"','English data task'); await shot('language-en-data');
    assert.equal(await execute('document.querySelectorAll(".task-data-grid tbody tr").length'),5,'original table rows retained');
    assert.equal(await execute('/[\\u3400-\\u9fff]/.test([...document.querySelectorAll(".work-filters,.work-group-label,.work-phase-badge")].map(item=>item.textContent).join(" "))'),false,'task filters, groups, and state are translated');
    window.setSize(1024,820); await shot('language-en-narrow');
    assert.ok(await execute('document.querySelector(".work-compose-dock").getBoundingClientRect().right <= innerWidth'),'English task input fits');
    window.setSize(...originalSize);
    await switchLanguage('zh-TW'); await shot('language-tw-settings');
    await execute('document.querySelector(".settings-modal .modal-header .icon-button").click()');
    await execute('document.querySelector(".presence-sidebar nav button").click()'); await shot('language-tw-home');
    assert.ok(await execute('document.querySelector(".presence-sidebar").textContent.includes("工具與連接")'),'Traditional Chinese navigation');
    assert.equal((await fs.readFile(docPath,'utf8')),after,'language switching never rewrites document content');
    assert.deepEqual(JSON.parse(await execute('window.memoryDesktop.loadWorkspace()')).sessions,savedBefore,'language switching never translates saved messages');
    const prefsAfter = await execute('window.memoryDesktop.prefs()'); delete prefsBefore.uiLocale; delete prefsAfter.uiLocale;
    assert.deepEqual(prefsAfter,prefsBefore,'language does not change permissions or assistant preferences');
    assert.equal(await execute('window.memoryDesktop.saveUiLocale("unsupported").then(()=>false,()=>true)'),true,'unsupported locale rejected');
    assert.equal(await execute('window.memoryDesktop.uiLocale()'),'zh-TW');
    await switchLanguage('zh-CN'); await execute('document.querySelector(".settings-modal .modal-header .icon-button").click()');
    assert.deepEqual(errors,[]);
    return {workspaceSmoke:'passed',languages:['zh-CN','en','zh-TW'],localePersisted:true,originalContentPreserved:true,forms:['document','data','files','research','desktop','followup'],homeOverview:true,contextualNavigation:true,stageChange:true,manualOverride:true,filePreview:true,chartMeasureSwitch:true,negativeValues:true,numericSorting:true,taskFilters:true,inspector:true,keyboardNavigation:true,detailRetry:true,reconnect:true,offlineReopen:true,independentScroll:true,draftIsolation:true,draftAfterRestart:true,inlineTaskComposer:true,isolatedProfile:true,actualFixtureFiles:true,readOnlyFixtureCore:true,modelRequests:0,noPaidRequests:true,screenshots:output};
  } catch(error){await shot('failure').catch(()=>{});throw error;}finally{fixtureServer.closeAllConnections();await new Promise(resolve=>fixtureServer.close(resolve));}
}
module.exports={run};
