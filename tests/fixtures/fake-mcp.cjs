// A tiny MCP server over stdio for tests: one read tool, one write tool, one destructive tool, one that errors.
const notes = new Map([['a', '第一条笔记']]);
const tools = [
  { name: 'read_note', description: '读取笔记', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } },
  { name: 'create_note', description: '新建笔记', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
  { name: 'delete_note', description: '删除笔记', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { destructiveHint: true } },
  { name: 'broken', description: '总是报错', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    if (message.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
    else if (message.method === 'tools/list') reply({ tools });
    else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      if (name === 'read_note') reply({ content: [{ type: 'text', text: notes.get(args.id) ?? '没有这条笔记' }] });
      else if (name === 'create_note') { notes.set(args.id, args.text); reply({ content: [{ type: 'text', text: '已创建 ' + args.id }] }); }
      else if (name === 'delete_note') { notes.delete(args.id); reply({ content: [{ type: 'text', text: '已删除 ' + args.id }] }); }
      else reply({ isError: true, content: [{ type: 'text', text: '服务端出错了' }] });
    } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } }) + '\n');
  }
});
