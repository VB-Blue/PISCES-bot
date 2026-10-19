const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { connectRuntime } = require('../electron/runtime-rpc.cjs');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const output = process.env.MEMORY_SMOKE_OUTPUT_DIR || path.join(root, 'output/startup-20261016/packaged');
const executable = process.env.MEMORY_TEST_DESKTOP_EXE || path.join(root, 'release/pisces-ai-v' + version + '/win-unpacked/PISCES AI.exe');
(async () => {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(output, 'profile-'));
  await fs.writeFile(path.join(profile, 'connection.json'), JSON.stringify({ coreUrl: 'http://127.0.0.1:9', endpoint: '', model: '' }));
  const env = { ...process.env, PISCES_TEST_USER_DATA: profile, MEMORY_SMOKE_OUTPUT_DIR: output }; delete env.ELECTRON_RUN_AS_NODE;
  const args = executable.toLowerCase().endsWith('electron.exe') ? ['.', '--lifecycle-smoke'] : ['--lifecycle-smoke'];
  let log = '', child;
  try {
    child = spawn(executable, args, { cwd: root, windowsHide: true, env });
    child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
    const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('后台启动验收超时：' + log.slice(-6000))); }, 150000); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', value => { clearTimeout(timer); resolve(value); }); });
    assert.equal(code, 0, log.slice(-6000)); assert.ok(log.includes('"lifecycleSmoke":"passed"'), log.slice(-6000));
    console.log(JSON.stringify({ ...JSON.parse(await fs.readFile(path.join(output, 'lifecycle-result.json'), 'utf8')), executable, profile }));
  } finally {
    let client; try { client = await connectRuntime(profile, 1000); await client.call('runtime:stop'); } catch {} finally { client?.close(); }
    if (child?.exitCode === null) child.kill();
    await fs.writeFile(path.join(output, 'ui.log'), log);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
