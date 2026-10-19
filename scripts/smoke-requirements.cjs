const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { connectRuntime } = require('../electron/runtime-rpc.cjs');
const root = path.resolve(__dirname, '..');
const output = process.env.MEMORY_SMOKE_OUTPUT_DIR || path.join(root, 'output/requirements-20261016/development');
const executable = process.env.MEMORY_TEST_DESKTOP_EXE || path.join(root, 'node_modules/electron/dist/electron.exe');
(async () => {
  await fs.mkdir(output, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(output, 'case-')), profile = path.join(sandbox, 'profile'), files = path.join(sandbox, 'files'); await fs.mkdir(files);
  const article = path.join(files, '网站文章.md');
  const original = '每篇文章必须包含具体案例，并解释适用条件。\n' + '案例要解释清楚因果关系，采用自然的中文表达。\n'.repeat(65) + '本条规范末尾也必须完整读取。';
  const extraRules = [...Array.from({ length: 22 }, (_, index) => ({ text: '文章规范 ' + index + '：必须包含具体案例及其适用条件。', domain: 'writing' })), { text: '文章必须包含“末尾案例”', domain: 'writing', check: { type: 'contains', value: '末尾案例' } }];
  const bodyText = '# 网站文章\n\n具体案例：甲根据条件乙采取行动丙，因此得到结果丁。\n\n' + '适用条件：保留事实与推理的联系。\n'.repeat(300) + '\n末尾案例';
  let requests = 0, completeContexts = 0;
  const model = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const request = JSON.parse(Buffer.concat(chunks)); requests++;
      const system = request.messages[0].content;
      let content = '', calls;
      if (system.includes('理解模块')) content = JSON.stringify({ type: 'task', goal: '写网站文章', kind: '写文章', presentation: 'document', deliverable: article, done_criteria: [{ check: 'file_contains', target: article, value: '末尾案例' }], apps: [], params: {}, steps: 'one', ask: null, assumptions: [] });
      else if (system.includes('长期写作要求的逐条核对模块')) { const input = JSON.parse(request.messages[1].content); assert.equal(input.document.text, bodyText); content = JSON.stringify({ id: input.rule.id, revision: input.rule.revision, status: 'passed', reason: '实际正文含案例并说明条件', evidence: '具体案例：甲根据条件乙采取行动丙' }); }
      else if (system.includes('核对模块')) content = JSON.stringify({ passed: true, unmet: [], reason: '实际文件符合要求' });
      else {
        assert.ok(system.includes(JSON.stringify(original)), '完整长期规范没有进入执行提示');
        for (const item of extraRules) assert.ok(system.includes(item.text));
        completeContexts++;
        if (request.messages.at(-1).role === 'tool') content = '文章已保存，已读回核对。';
        else calls = [{ id: 'write-' + requests, type: 'function', function: { name: 'write_text', arguments: JSON.stringify({ path: article, content: bodyText, overwrite: true }) } }];
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }], usage: { total_tokens: 100 } }));
    } catch (cause) { res.writeHead(500); res.end(cause.stack); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const config = path.join(sandbox, 'config.json'); await fs.writeFile(config, JSON.stringify({ endpoint: 'http://127.0.0.1:' + model.address().port, files, article, original, extraRules }));
  try {
    for (const phase of ['before', 'after']) {
      const env = { ...process.env, PISCES_TEST_USER_DATA: profile, PISCES_TEST_TASK_PHASE: phase, PISCES_REQUIREMENTS_CONFIG: config, MEMORY_SMOKE_OUTPUT_DIR: output }; delete env.ELECTRON_RUN_AS_NODE;
      const args = executable.toLowerCase().endsWith('electron.exe') ? ['.', '--requirements-smoke'] : ['--requirements-smoke'];
      const child = spawn(executable, args, { cwd: root, windowsHide: true, env }); let log = '';
      child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
      const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('界面验收超时：' + log.slice(-5000))); }, 120000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
      await fs.writeFile(path.join(output, phase + '-console.log'), log); assert.equal(code, 0, log.slice(-6000)); assert.ok(log.includes('"requirementsSmoke":"passed"'), log.slice(-6000));
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const before = JSON.parse(await fs.readFile(path.join(output, 'before-result.json'), 'utf8')), after = JSON.parse(await fs.readFile(path.join(output, 'after-result.json'), 'utf8'));
    assert.deepEqual(after.rules, before.rules); assert.notEqual(after.status.pid, before.status.pid);
    const result = { passed: true, executable, profile, persistedAcrossHostRestart: true, freshChatUsesEveryRule: true, fullOriginalFromUI: true, backgroundJobChecked: true, longArtifactReadInFull: true, rules: after.rules.length, requests, completeContexts, scriptedModel: true, noPaidRequests: true };
    await fs.writeFile(path.join(output, 'requirements-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally {
    let runtime;
    try { runtime = await connectRuntime(profile, 1000); await runtime.call('runtime:stop'); } catch {} finally { runtime?.close(); }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  }
})().catch(cause => { console.error(cause); process.exitCode = 1; });
