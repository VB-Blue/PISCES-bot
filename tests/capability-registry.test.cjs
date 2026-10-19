const test = require('node:test');
const assert = require('node:assert/strict');
const { createCapabilityView } = require('../electron/capability-registry.cjs');
const def = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });

test('task discovery loads a needed capability without executing it or changing grants', async () => {
  let calls = 0;
  let available = ['read_text', 'write_document', 'uia_invoke', 'run_command', 'mcp_mail__read'];
  const view = createCapabilityView({ get definitions() { return available.map(def); }, has: name => available.includes(name), label: name => name, execute: async name => { calls++; return { ok: true, name }; } }, { request: '整理目录里的资料生成报告' });
  assert.ok(view.definitions.some(item => item.function.name === 'write_document'));
  assert.ok(!view.definitions.some(item => item.function.name === 'run_command'));
  const discovery = await view.execute('discover_tools', { group: 'connectors', names: ['mcp_mail__read', 'nonexistent'] }, {});
  assert.equal(calls, 0);
  assert.deepEqual(discovery.unavailable, ['nonexistent']);
  assert.ok(view.definitions.some(item => item.function.name === 'mcp_mail__read'));
  await view.execute('mcp_mail__read', {}, {});
  assert.equal(calls, 1);
  available = available.filter(name => name !== 'mcp_mail__read');
  assert.ok(!view.definitions.some(item => item.function.name === 'mcp_mail__read'), 'disconnect removes even previously loaded capabilities');
});

test('an understood desktop goal selects actual control tools and retains file tools', () => {
  const available = ['get_environment', 'read_text', 'uia_invoke', 'inspect_window'];
  const view = createCapabilityView({ definitions: available.map(def), has: name => available.includes(name), label: name => name, execute() {} }, { request: '你好' });
  view.selectTask({ presentation: 'desktop', goal: '编辑记事本并保存' });
  assert.ok(view.definitions.some(item => item.function.name === 'uia_invoke'));
  assert.ok(view.definitions.some(item => item.function.name === 'read_text'));
});
