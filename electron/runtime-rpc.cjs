// One execution owner per profile. The UI connects over a local pipe; disconnecting it does not stop jobs.
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { EventEmitter } = require('node:events');

const PROTOCOL = 1;
const MAX_FRAME = 32 * 1024 * 1024;
const descriptorPath = dir => path.join(dir, 'runtime-host.json');
const addressFor = dir => process.platform === 'win32'
  ? '\\\\.\\pipe\\pisces-runtime-' + createHash('sha256').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 32)
  : path.join(path.resolve(dir), 'runtime-host.sock');
const knownReads = new Set(['settings:get', 'jobs:list', 'checkpoints:list', 'connectors:list', 'providers:get', 'core:status', 'core:sessions', 'core:history', 'core:assistant-state', 'core:work-detail', 'core:learning-state', 'core:control-log', 'reminder:list', 'memory:list', 'profile:get', 'skill:list', 'history:search', 'tools:audit', 'prefs:get', 'subject:state', 'ai:models', 'runtime:status']);
const isRead = name => knownReads.has(name) || ['usage:summary', 'goals:list', 'browser:state', 'browser:list', 'browser:frame', 'browser:snapshot'].includes(name);
let currentSid;
async function protectTokenFile(file) {
  if (process.platform !== 'win32') { await fs.chmod(file, 0o600); return; }
  const run = require('node:util').promisify(require('node:child_process').execFile);
  currentSid ||= run(path.join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps/pwsh.exe'), ['-NoLogo', '-NoProfile', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true }).then(result => {
    const sid = result.stdout.trim(); if (!/^S-\d-(?:\d+-)+\d+$/.test(sid)) throw new Error('不能确定本机连接凭证的所有者'); return sid;
  });
  await run(path.join(process.env.SystemRoot, 'System32/icacls.exe'), [file, '/inheritance:r', '/grant:r', '*' + await currentSid + ':(F)'], { windowsHide: true });
}
function failure(message, code, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
function errorView(error) {
  const result = { message: String(error?.message || error), code: error?.code || 'RUNTIME_FAILED' };
  for (const key of ['execution_status', 'recoverable', 'automatic_retry', 'trace', 'unresolvedSteps', 'evidence', 'causeCode', 'endpointHost', 'phase']) if (error?.[key] !== undefined) result[key] = error[key];
  return result;
}
function receive(socket, onMessage) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_FRAME * 2) return socket.destroy();
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) return socket.destroy();
      try { onMessage(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) socket.destroy();
  });
}
function send(socket, value) {
  if (socket.destroyed || socket.writableLength > MAX_FRAME * 2) return false;
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > MAX_FRAME) throw failure('后台消息过大', 'RUNTIME_FRAME_TOO_LARGE');
  socket.write(line); return true;
}

async function createRuntimeServer({ dir, version, dispatch, status = () => ({}), disconnected = () => {} }) {
  const address = addressFor(dir), token = randomBytes(32).toString('hex');
  const clients = new Set(), requests = new Map();
  let ready = false, stopping = false;
  const startedAt = new Date().toISOString();
  const state = () => ({ online: true, ready, stopping, protocol: PROTOCOL, pid: process.pid, version, startedAt, clients: clients.size, uiClients: [...clients].filter(client => client.role === 'ui').length, ...status() });
  const server = net.createServer(socket => {
    const client = { socket, ownedRequests: new Set(), authenticated: false,
      sender: { isDestroyed: () => socket.destroyed, send: (channel, value) => send(socket, { event: channel, value }) } };
    receive(socket, message => {
      void (async () => {
        const supplied = Buffer.from(String(message?.token || ''));
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(socket, { id: message?.id, error: errorView(failure('后台连接身份不匹配', 'RUNTIME_UNAUTHORIZED')) }); return socket.end(); }
        client.authenticated = true; client.role = message.role === 'ui' ? 'ui' : 'observer'; clients.add(client);
        if (!/^[\w-]{1,80}$/.test(message.id || '') || typeof message.name !== 'string' || !Array.isArray(message.args)) throw failure('后台请求格式无效', 'RUNTIME_BAD_REQUEST');
        if (message.name === 'runtime:status') { send(socket, { id: message.id, result: state() }); return; }
        if (!ready || stopping) throw failure(stopping ? '后台执行正在停止' : '后台执行正在准备', 'RUNTIME_NOT_READY', { execution_status: 'not_started', automatic_retry: false });
        const fingerprint = createHash('sha256').update(JSON.stringify([message.name, message.args])).digest('hex');
        let entry = requests.get(message.id);
        if (entry && entry.fingerprint !== fingerprint) throw failure('后台请求标识被重复用于不同操作', 'RUNTIME_REQUEST_CONFLICT');
        if (!entry) {
          const event = { sender: client.sender, runtimeRequestId: message.id, runtimeClient: client };
          entry = { fingerprint, finished: false, promise: Promise.resolve().then(() => dispatch(message.name, event, message.args)).then(result => ({ result: result === undefined ? null : result }), error => ({ error: errorView(error) })).finally(() => { entry.finished = true; }) };
          requests.set(message.id, entry);
          if (requests.size > 500) { const first = [...requests].find(([id, item]) => id !== message.id && item.finished)?.[0]; if (first) requests.delete(first); }
        }
        send(socket, { id: message.id, ...await entry.promise });
      })().catch(error => { try { send(socket, { id: message?.id, error: errorView(error) }); } catch { socket.destroy(); } });
    });
    socket.on('error', () => {});
    socket.on('close', () => { clients.delete(client); disconnected(client); });
  });
  await fs.mkdir(dir, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, () => { server.off('error', reject); resolve(); }); });
  const record = { address, accessToken: token, pid: process.pid, protocol: PROTOCOL, version, startedAt };
  const temporary = descriptorPath(dir) + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, '', { mode: 0o600, flag: 'wx' }); await protectTokenFile(temporary); await fs.writeFile(temporary, JSON.stringify(record)); await fs.rename(temporary, descriptorPath(dir)); }
  catch (error) { server.close(); throw error; }
  return { state, ready: () => { ready = true; }, stopping: () => { stopping = true; },
    broadcast: (channel, value) => { for (const client of clients) { try { client.sender.send(channel, value); } catch { client.socket.destroy(); } } },
    async close() {
      stopping = true;
      for (const client of clients) client.socket.destroy();
      await new Promise(resolve => server.close(resolve));
      try { const current = JSON.parse(await fs.readFile(descriptorPath(dir), 'utf8')); if (current.accessToken === token) await fs.unlink(descriptorPath(dir)); } catch {}
    } };
}

class RuntimeClient extends EventEmitter {
  constructor(socket, token, role = 'observer') {
    super(); this.socket = socket; this.token = token; this.role = role; this.pending = new Map(); this.online = true;
    receive(socket, message => {
      if (typeof message.event === 'string') { this.emit('event', message.event, message.value); return; }
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error)); else entry.resolve(message.result);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.online = false;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(failure(entry.mutation ? '与后台的连接中断，操作结果待核对，请先检查任务记录' : '与后台的连接中断', entry.mutation ? 'CORE_ACTION_UNCERTAIN' : 'RUNTIME_OFFLINE', { execution_status: entry.mutation ? 'unknown' : 'not_started', automatic_retry: false, evidence: { source: 'runtime', request_id: id, operation: entry.name } }));
      }
      this.pending.clear(); this.emit('offline');
    });
  }
  call(name, args = [], { id = randomUUID(), timeoutMs = 30000, mutation = !isRead(name) } = {}) {
    if (!this.online || this.socket.destroyed) return Promise.reject(failure('后台执行未连接', 'RUNTIME_OFFLINE', { execution_status: 'not_started' }));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, mutation, name };
      if (timeoutMs) entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure(mutation ? '后台操作尚未返回，结果待核对，请先检查任务记录' : '后台读取超时', mutation ? 'CORE_ACTION_UNCERTAIN' : 'RUNTIME_TIMEOUT', { execution_status: mutation ? 'unknown' : 'not_started', automatic_retry: false, evidence: { source: 'runtime', request_id: id, operation: name } }));
      }, timeoutMs);
      this.pending.set(id, entry);
      try { if (!send(this.socket, { id, token: this.token, role: this.role, name, args })) throw failure('后台连接已关闭', 'RUNTIME_OFFLINE'); }
      catch (error) { this.pending.delete(id); clearTimeout(entry.timer); reject(error); }
    });
  }
  close() { this.socket.destroy(); }
}
async function connectRuntime(dir, timeoutMs = 1500, { role = 'observer' } = {}) {
  const record = JSON.parse(await fs.readFile(descriptorPath(dir), 'utf8'));
  const token = record.accessToken;
  if (record.protocol !== PROTOCOL || record.address !== addressFor(dir) || typeof token !== 'string' || token.length !== 64) throw failure('后台连接记录无效或协议不兼容', 'RUNTIME_PROTOCOL_MISMATCH');
  const socket = net.createConnection(record.address);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(failure('后台连接超时', 'RUNTIME_TIMEOUT')); }, timeoutMs);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
  });
  const client = new RuntimeClient(socket, token, role);
  try { await client.call('runtime:status', [], { timeoutMs }); return client; } catch (error) { client.close(); throw error; }
}
async function ensureRuntime({ dir, launch, version, timeoutMs = 30000 }) {
  let launched = false, lastError;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let client;
    try {
      client = await connectRuntime(dir, 1500, { role: 'ui' });
      const current = await client.call('runtime:status');
      if (version && current.version !== version) { client.close(); throw failure('后台仍运行 ' + current.version + ' 版本，请从托盘停止后台后再启动 ' + version + ' 版本', 'RUNTIME_VERSION_MISMATCH'); }
      if (current.ready && !current.stopping) return client;
      client.close();
    } catch (error) {
      lastError = error;
      if (['RUNTIME_PROTOCOL_MISMATCH', 'RUNTIME_VERSION_MISMATCH'].includes(error.code)) throw error;
      if (!launched) { launched = true; await launch(); }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw failure('后台执行未能就绪：' + (lastError?.message || '初始化超时'), 'RUNTIME_OFFLINE');
}
module.exports = { createRuntimeServer, connectRuntime, ensureRuntime, RuntimeClient, addressFor, descriptorPath, isRead, protectTokenFile, PROTOCOL };
