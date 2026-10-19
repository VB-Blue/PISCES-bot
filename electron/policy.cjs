const path = require('node:path');

function validateEndpoint(value, { localOnly = false } = {}) {
  const url = new URL(String(value));
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error('地址不能包含凭据、查询参数或片段');
  if (localOnly && !local) throw new Error('核心地址只允许本机地址');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('远程地址需要 HTTPS，本机服务可使用 HTTP');
  return url.toString().replace(/\/+$/, '');
}

function resolveAsset(root, requestUrl) {
  const url = new URL(requestUrl);
  if (url.protocol !== 'memory:' || url.hostname !== 'app') throw new Error('非法应用来源');
  const decoded = decodeURIComponent(url.pathname);
  if (decoded.includes('\\') || decoded.includes('\0')) throw new Error('非法资源路径');
  const target = path.resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('资源路径越界');
  return target;
}

function validateMessages(input) {
  if (!Array.isArray(input) || !input.length || input.length > 60) throw new Error('对话长度无效');
  return input.map(item => {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 40000) throw new Error('对话格式无效');
    const msg = { role: item.role, content: item.content };
    if (Array.isArray(item.images)) {
      msg.images = item.images.slice(0, 5).filter(img => typeof img === 'string' && (img.startsWith('data:image/') || img.startsWith('http://') || img.startsWith('https://')));
    }
    return msg;
  });
}

// SSE records can be split at arbitrary byte boundaries. The caller decodes UTF-8 incrementally.
function createSSEParser(consume) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const record = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) consume(data);
      }
    },
    finish() {
      if (buffer.trim()) this.push('\n\n');
    },
  };
}

module.exports = { validateEndpoint, resolveAsset, validateMessages, createSSEParser };
