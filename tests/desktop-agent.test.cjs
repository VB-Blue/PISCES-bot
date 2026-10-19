const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopAgent } = require('../electron/desktop-agent.cjs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const started = Date.now();
  for (;;) { const value = await check(); if (value) return value; if (Date.now() - started > timeout) throw new Error('等待超时：' + label); await wait(150); }
}
const readState = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };

// An in-memory helper exercises the production channel without touching the user's desktop.
function fakeNativeHost() {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter(); child.pid = children.length + 100;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.writes = [];
    child.reply = (request, result = {}) => child.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
    child.stdin = new EventEmitter(); child.stdin.write = (line, callback) => {
      const request = JSON.parse(line); child.writes.push(request);
      if (request.cmd === 'ping') queueMicrotask(() => child.reply(request, { pong: true }));
      callback?.(); return true;
    }; child.stdin.end = () => {};
    child.kill = () => { child.killed = true; return true; };
    children.push(child); return child;
  };
  return { children, spawnProcess };
}

test('native channel retains timed-out actions and blocks both queued and new input until the late reply', async () => {
  const host = fakeNativeHost(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-channel-'));
  const agent = new DesktopAgent({ dir, spawnProcess: host.spawnProcess });
  try {
    await agent.start();
    const child = host.children[0];
    const first = agent.call('drag', { x: 1, x2: 2 }, { timeout: 20 });
    const firstCheck = assert.rejects(first, error => error.code === 'CORE_ACTION_UNCERTAIN' && error.execution_status === 'unknown');
    await new Promise(resolve => setImmediate(resolve));
    const queued = agent.call('keys', { keys: 'enter' });
    const queuedCheck = assert.rejects(queued, error => error.execution_status === 'not_started' && error.code === 'DESKTOP_CHANNEL_QUARANTINED');
    await Promise.all([firstCheck, queuedCheck]);
    assert.deepEqual(child.writes.map(request => request.cmd), ['ping', 'drag']);
    assert.equal(agent.pending.size, 1, 'timeout keeps the native operation tracked');
    await assert.rejects(agent.call('click', { x: 3 }), error => error.code === 'CORE_ACTION_UNCERTAIN');
    child.reply(child.writes[1], { dragged: true });
    assert.equal(agent.pending.size, 0);
    const next = agent.call('foreground');
    await new Promise(resolve => setImmediate(resolve));
    child.reply(child.writes.at(-1), { title: 'fixture' });
    assert.deepEqual(await next, { title: 'fixture' });
    assert.deepEqual(child.writes.map(request => request.cmd), ['ping', 'drag', 'foreground']);
  } finally { agent.stop(); host.children.at(-1)?.emit('exit', 0); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native channel cancellation is quarantined until helper exit, not merely kill requested', async () => {
  const host = fakeNativeHost(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-abort-'));
  const agent = new DesktopAgent({ dir, spawnProcess: host.spawnProcess });
  try {
    await agent.start(); const old = host.children[0]; const controller = new AbortController();
    const action = agent.call('keys', { keys: 'ctrl+s' }, { signal: controller.signal });
    const checked = assert.rejects(action, error => error.code === 'CORE_ACTION_UNCERTAIN' && error.execution_status === 'unknown');
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await checked;
    agent.stop(); assert.equal(old.killed, true); assert.equal(agent.child, old);
    await assert.rejects(agent.call('keys', { keys: 'enter' }), error => error.code === 'CORE_ACTION_UNCERTAIN');
    assert.equal(host.children.length, 1, 'a kill request cannot create a second input channel');
    old.emit('exit', 0);
    await agent.start(); assert.equal(host.children.length, 2);
    const current = host.children[1]; const next = agent.call('foreground');
    await new Promise(resolve => setImmediate(resolve));
    old.reply(old.writes[1], { pressed: true });
    assert.equal(agent.pending.size, 1, 'an old helper reply cannot settle the new helper request');
    current.reply(current.writes.at(-1), { title: 'new fixture' });
    assert.equal((await next).title, 'new fixture');
  } finally { agent.stop(); host.children.at(-1)?.emit('exit', 0); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native startup is shared and regular calls are serialized without queued cancellation reaching the helper', async () => {
  const host = fakeNativeHost(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-start-'));
  const agent = new DesktopAgent({ dir, spawnProcess: host.spawnProcess });
  try {
    await Promise.all([agent.start(), agent.start()]); assert.equal(host.children.length, 1);
    const child = host.children[0]; const first = agent.call('windows');
    await new Promise(resolve => setImmediate(resolve));
    const controller = new AbortController(); const second = agent.call('click', {}, { signal: controller.signal });
    const checked = assert.rejects(second, error => error.execution_status === 'not_started');
    await new Promise(resolve => setImmediate(resolve)); controller.abort(); await checked;
    assert.deepEqual(child.writes.map(request => request.cmd), ['ping', 'windows']);
    child.reply(child.writes[1], { windows: [] }); await first;
    assert.equal(agent.pending.size, 0); assert.equal(agent.queue.length, 0);
  } finally { agent.stop(); host.children.at(-1)?.emit('exit', 0); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native startup stopped during preparation cannot later create an input channel', async () => {
  const host = fakeNativeHost(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-start-stop-'));
  const agent = new DesktopAgent({ dir, spawnProcess: host.spawnProcess });
  try {
    const starting = agent.start(); agent.stop();
    await assert.rejects(starting, error => error.execution_status === 'not_started');
    assert.equal(host.children.length, 0);
    await agent.start(); assert.equal(host.children.length, 1);
  } finally { agent.stop(); host.children.at(-1)?.emit('exit', 0); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native transport pipe failures leave actions unknown and isolate the channel until actual exit', async () => {
  const host = fakeNativeHost(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pipe-'));
  const agent = new DesktopAgent({ dir, spawnProcess: host.spawnProcess });
  try {
    await agent.start(); const child = host.children[0];
    const input = agent.call('keys', { keys: 'enter' });
    const checked = assert.rejects(input, error => error.execution_status === 'unknown' && error.code === 'CORE_ACTION_UNCERTAIN');
    await new Promise(resolve => setImmediate(resolve));
    child.stdin.emit('error', new Error('broken pipe')); await checked;
    assert.equal(child.killed, true); assert.equal(agent.child, child);
    await assert.rejects(agent.call('click'), error => error.code === 'CORE_ACTION_UNCERTAIN');
    assert.deepEqual(child.writes.map(item => item.cmd), ['ping', 'keys']);
    child.emit('exit', 1); assert.equal(agent.pending.size, 0);
  } finally { agent.stop(); if (agent.child) agent.child.emit('exit', 0); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a new helper refuses to overlap a native command still owned by another process', { skip: process.platform !== 'win32', timeout: 35000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-native-owner-'));
  const marker = path.join(dir, 'held.txt'), holderFile = path.join(dir, 'holder.ps1');
  fs.writeFileSync(holderFile, "$mutex=New-Object System.Threading.Mutex($false,('Local\\PISCES.AI.DesktopInput.'+[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value))\n$mutex.WaitOne()|Out-Null\n[IO.File]::WriteAllText($args[0],'held')\ntry{[Console]::In.ReadLine()|Out-Null}finally{$mutex.ReleaseMutex();$mutex.Dispose()}\n");
  const holder = spawn(path.join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps/pwsh.exe'), ['-NoLogo', '-NoProfile', '-File', holderFile, marker], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  const agent = new DesktopAgent({ dir });
  try {
    await until(() => fs.existsSync(marker), 'named mutex acquired');
    await assert.rejects(agent.call('ping'), error => error.execution_status === 'not_started' && error.code === 'DESKTOP_INPUT_BUSY');
    holder.stdin.end('\n'); await new Promise(resolve => holder.once('exit', resolve));
    assert.ok(await agent.call('ping'), 'the next deliberate request may start after the previous owner releases input');
  } finally { agent.stop(); if (holder.exitCode === null) holder.kill(); }
});

test('the desktop agent really finds, focuses, sees and drives another window', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const title = 'ControlFixture-' + process.pid;
  const stateFile = path.join(dir, 'state.json');
  const fixture = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures', 'control-fixture.ps1'), '-Title', title, '-StateFile', stateFile], { windowsHide: false, stdio: 'ignore' });
  const agent = new DesktopAgent({ dir });
  try {
    const found = await until(async () => (await agent.call('windows')).windows.find(item => item.title === title), '找到测试窗口', 30000);
    assert.equal(found.process.toLowerCase(), 'powershell');

    const focused = await agent.call('focus', { window: title });
    assert.equal(focused.focused, true);
    assert.equal((await agent.call('foreground')).title, title);

    const shot = await agent.call('screenshot', { window: title, maxWidth: 800 });
    assert.match(shot.image, /^data:image\/jpeg;base64,/);
    assert.ok(shot.width > 100 && shot.width <= 800 && shot.scale <= 1);
    assert.ok(shot.image.length > 3000, 'the screenshot has real content');

    const tree = (await agent.call('inspect', { window: title, limit: 60 })).elements;
    const button = tree.find(item => item.name === 'Go' && /Button/.test(item.type));
    const edit = tree.find(item => /Edit/.test(item.type));
    assert.ok(button && edit, '应在控件树里看到按钮和输入框：' + JSON.stringify(tree.map(item => [item.type, item.name])));

    await agent.call('invoke', { id: button.id });
    await until(() => readState(stateFile)?.clicks === 1, 'UIA 点击生效');

    await agent.call('click', { x: edit.x + edit.width / 2, y: edit.y + edit.height / 2, button: 'left', count: 1 });
    for (const key of ['a', 'b', 'c']) await agent.call('keys', { keys: key });
    await until(() => readState(stateFile)?.text === 'abc', '键盘输入生效');
    await agent.call('keys', { keys: 'ctrl+a' }); await agent.call('keys', { keys: 'backspace' });
    await until(() => readState(stateFile)?.text === '', '组合键生效');

    await agent.call('setvalue', { id: edit.id, text: '你好 World' });
    await until(() => readState(stateFile)?.text === '你好 World', '直接设置控件内容（含中文）');

    await agent.call('click', { x: button.x + button.width / 2, y: button.y + button.height / 2, button: 'left', count: 1 });
    await until(() => readState(stateFile)?.clicks === 2, '坐标点击生效');

    await assert.rejects(agent.call('focus', { window: '不存在的窗口-' + Date.now() }), /没有找到窗口/);
    await assert.rejects(agent.call('keys', { keys: 'ctrl+不存在' }), /不认识的按键/);
  } finally { agent.stop(); fixture.kill(); }
});

test('the control layer observes with numbered marks, verifies every action, reads text, falls back to OCR and cuts off useless loops', { skip: process.platform !== 'win32', timeout: 180000 }, async () => {
  const { spawnSync } = require('node:child_process');
  const memory = require('../electron/memory.cjs');
  const { createTools } = require('../electron/tools.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
  await memory.init(path.join(dir, 'memory'));
  const title = 'ControlTools-' + process.pid;
  const stateFile = path.join(dir, 'state.json');
  const fixture = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures', 'control-fixture.ps1'), '-Title', title, '-StateFile', stateFile], { windowsHide: false, stdio: 'ignore' });
  const agent = new DesktopAgent({ dir: path.join(dir, 'agent') });
  const clipboard = { readText: () => spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).stdout.replace(/\r?\n$/, ''), writeText: text => spawnSync('clip', { input: text }) };
  const events = [];
  const make = blocked => createTools({ memory, userDataDir: path.join(dir, 'u'), getPrefs: () => ({}), controlBlocked: blocked, host: { path: () => dir, openExternal: async () => {}, desktop: agent, clipboard, controlStarted: () => events.push('started') } });
  const asked = [];
  const ctx = decision => ({ signal: new AbortController().signal, turn: 't1', ask: async request => { asked.push(request); return decision; } });
  const idOf = (result, type, name) => Number(result.elements.find(line => line.includes(' ' + type + ' ') && line.includes('「' + name))?.split(' ')[0]);
  try {
    await until(async () => (await agent.call('windows')).windows.find(item => item.title === title), '测试窗口出现', 30000);
    // Policy first: this fixture runs inside PowerShell, which is off limits by default, and nothing happens before consent.
    await assert.rejects(make(undefined).execute('observe', { window: title }, ctx('once')), /不能控制这个窗口/);
    assert.equal(asked.length, 0);
    const tools = make(new Set());
    await assert.rejects(tools.execute('click', { id: 1 }, ctx('once')), /先 observe/);
    await assert.rejects(tools.execute('observe', { window: title }, ctx('deny')), /用户拒绝/);
    assert.deepEqual(events, []);

    // Observe: marked screenshot + element list, with the consent prompt describing the risk.
    const seen = await tools.execute('observe', { window: title }, ctx('once'));
    assert.match(seen.image, /^data:image\/jpeg;base64,/);
    assert.deepEqual(events, ['started']);
    assert.equal(asked.at(-1).risk, 'high'); assert.equal(asked.at(-1).allowAlways, true);
    const go = idOf(seen, 'Button', 'Go'), edit = idOf(seen, 'Edit', ''), check = idOf(seen, 'CheckBox', 'Enable'), beta = idOf(seen, 'ListItem', 'Beta');
    assert.ok(go && edit && check && beta, '应识别出按钮、输入框、复选框、列表项：' + JSON.stringify(seen.elements));
    await assert.rejects(tools.execute('click', { id: 999 }, ctx('once')), /不存在或已过期/);
    await assert.rejects(tools.execute('click', { x: 99999, y: 5 }, ctx('once')), /超出最近一次观察/);

    // Typing into a field by its number; the result already carries the new observation.
    const typed = await tools.execute('type_text', { text: 'Hello42', into: edit }, ctx('once'));
    await until(() => readState(stateFile)?.text === 'Hello42', '按编号输入文字');
    assert.equal(typed.changed, true); assert.match(typed.image, /^data:image/);

    // A list item and a checkbox, each verified by the app's own state and by "changed".
    const picked = await tools.execute('click', { id: idOf(typed, 'ListItem', 'Beta') }, ctx('once'));
    await until(() => readState(stateFile)?.selected === 'Beta item', '选中列表项');
    assert.equal(picked.changed, true);
    await tools.execute('click', { id: idOf(picked, 'CheckBox', 'Enable') }, ctx('once'));
    await until(() => readState(stateFile)?.checked === true, '勾选复选框');

    // Reading content as text, and waiting for conditions instead of sleeping.
    const read = await tools.execute('read_window_text', {}, ctx('once'));
    assert.ok(read.lines.some(line => line.includes('Alpha item')) && read.lines.some(line => line.includes('Gamma item')));
    assert.equal((await tools.execute('wait_for', { text: 'Gamma', timeout_sec: 5 }, ctx('once'))).satisfied, true);
    assert.equal((await tools.execute('wait_for', { text: 'NoSuchTextAnywhere', timeout_sec: 1 }, ctx('once'))).satisfied, false);

    // OCR fallback: finds and clicks text without any control being exposed.
    const found = await tools.execute('find_text', { text: 'Alpha' }, ctx('once'));
    assert.ok(found.found >= 1, 'OCR 应能找到 Alpha：' + JSON.stringify(found));
    await tools.execute('click_text', { text: 'Alpha' }, ctx('once'));
    await until(() => readState(stateFile)?.selected === 'Alpha item', '通过 OCR 文字点击');

    // Zoom, plan, forbidden keys.
    const zoomed = await tools.execute('zoom', { x: 0, y: 0, width: 200, height: 100 }, ctx('once'));
    assert.match(zoomed.image, /^data:image\/jpeg;base64,/);
    const plans = [];
    await tools.execute('update_plan', { steps: [{ text: '读列表', status: 'done' }, { text: '归档', status: 'doing' }, { text: '', status: 'x' }] }, { ...ctx('once'), onPlan: plan => plans.push(plan) });
    assert.deepEqual(plans[0].map(({ text, status }) => ({ text, status })), [{ text: '读列表', status: 'done' }, { text: '归档', status: 'doing' }]);
    await assert.rejects(tools.execute('press_keys', { keys: 'win+r' }, ctx('once')), /不允许这个按键组合/);
    await assert.rejects(tools.execute('press_keys', { keys: 'alt+f4' }, ctx('once')), /不允许这个按键组合/);

    // The loop breaker: pressing something that changes nothing is refused after two tries.
    let refused = null, executed = 0;
    for (let attempt = 0; attempt < 5 && !refused; attempt++) {
      try { const again = await tools.execute('press_keys', { keys: 'f9' }, ctx('once')); executed++; assert.equal(again.changed, false); if (again.changed === false) assert.match(again.hint, /没有可见变化/); }
      catch (error) { refused = error; }
    }
    assert.ok(refused && /连续 2 次没有任何界面变化/.test(refused.message), '无效操作应被代码拦下：' + refused?.message);
    assert.equal(executed, 2);
  } finally { agent.stop(); fixture.kill(); }
});
