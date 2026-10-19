// Local-only MCP fixture: supplies real typed payloads and simulates writes whose acknowledgements arrive late.
const readline = require('node:readline');
let writes = 0;
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWXsAAAAASUVORK5CYII=';
const readTools = ['rich_result', 'unsatisfied', 'read_state', 'error_content'];
const names = [...readTools, 'write_late', 'write_rpc_error', 'invalid_write'];
const tools = names.map(name => ({ name, inputSchema: { type: 'object', properties: {} }, ...(readTools.includes(name) ? { annotations: { readOnlyHint: true } } : {}) }));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} } });
  if (request.method === 'tools/list') return reply({ tools });
  const { name, arguments: args } = request.params;
  if (name === 'rich_result') return reply({ structuredContent: { report: { title: '实际报告', rows: [{ value: 7, checked: true }] } }, content: [{ type: 'text', text: '真实文字' }, { type: 'resource', resource: { uri: 'test://report', mimeType: 'text/plain', text: '嵌入资源正文' } }, { type: 'resource_link', uri: 'https://example.com/report/7', name: 'report', title: '报告链接', mimeType: 'text/html' }, { type: 'image', mimeType: 'image/png', data: pixel }] });
  if (name === 'unsatisfied') return reply({ content: [{ type: 'text', text: '未达到预期状态' }], structuredContent: { ok: true, satisfied: false } });
  if (name === 'read_state') return reply({ content: [{ type: 'text', text: String(writes) }], structuredContent: { writes } });
  if (name === 'error_content') return reply({ isError: true, content: [{ type: 'text', text: '实际错误证据' }], structuredContent: { ok: false, reason: 'validation failed' } });
  if (name === 'write_rpc_error') { writes++; return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'reply failed after write' } }) + '\n'); }
  if (name === 'invalid_write') { writes++; return reply(null); }
  if (name === 'write_late') { writes++; const count = writes; return setTimeout(() => reply({ content: [{ type: 'text', text: '已写入 ' + count }], structuredContent: { writes: count, ok: true } }), args?.delay ?? 150); }
});
