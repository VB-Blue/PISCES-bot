const { EventEmitter } = require('node:events');

function browserURL(value) {
  if (value === 'about:blank') return value;
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('浏览器仅支持不含账号密码的 HTTP / HTTPS 网址');
  return url.href;
}
function localEndpoint(value, websocket = false) {
  const url = new URL(String(value || ''));
  if (!(websocket ? ['ws:'] : ['http:']).includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash) throw new Error('浏览器连接必须使用本机调试端口，例如 http://127.0.0.1:9222');
  if (!websocket && url.pathname !== '/') throw new Error('请填写浏览器调试端口的根地址');
  return url.href.replace(/\/$/, '');
}
const safeURL = value => { try { const u = new URL(value); return u.protocol === 'about:' ? 'about:blank' : u.origin + u.pathname; } catch { return ''; } };
function abortError(signal) { return signal?.reason instanceof Error ? signal.reason : new Error('浏览器操作已停止'); }
function bounded(promise, { signal, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const abort = () => finish(reject, abortError(signal));
    const timer = setTimeout(() => { const error = new Error('浏览器响应超时，请重新观察页面后确认结果'); error.code = 'BROWSER_TIMEOUT'; finish(reject, error); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
async function jsonEndpoint(endpoint, route, method = 'GET', signal) {
  const base = localEndpoint(endpoint);
  const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)].filter(Boolean)) });
  if (!response.ok) throw new Error('浏览器连接失败：HTTP ' + response.status);
  const body = await response.text();
  if (body.length > 4 * 1024 * 1024) throw new Error('浏览器连接返回内容过大');
  return JSON.parse(body);
}
class CDP extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.pending = new Map(); this.next = 0; this.closed = false;
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id) {
          const call = this.pending.get(message.id); if (!call) return;
          this.pending.delete(message.id);
          if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result || {});
        } else this.emit('event', message.method, message.params || {});
      } catch {}
    });
    const close = () => { if (this.closed) return; this.closed = true; for (const call of this.pending.values()) call.reject(new Error('浏览器连接已断开，请重新连接并观察')); this.pending.clear(); this.emit('disconnect'); };
    socket.addEventListener('close', close); socket.addEventListener('error', close);
  }
  static async connect(url, signal) {
    const target = localEndpoint(url, true), socket = new WebSocket(target);
    try { await bounded(new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('无法连接浏览器调试端口')), { once: true }); }), { signal, timeout: 8000 }); }
    catch (error) { socket.close(); throw error; }
    return new CDP(socket);
  }
  async send(method, params = {}, options = {}) {
    options.signal?.throwIfAborted(); if (this.closed) throw new Error('浏览器连接已断开，请重新连接并观察');
    const id = ++this.next;
    try {
      return await bounded(new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) { this.pending.delete(id); reject(error); } }), options);
    } finally { this.pending.delete(id); }
  }
  close() { this.socket.close(); }
}
module.exports = { CDP, bounded, jsonEndpoint, browserURL, localEndpoint, safeURL };
