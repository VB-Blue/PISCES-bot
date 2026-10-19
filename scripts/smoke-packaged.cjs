const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const executable = path.join(root, 'release', `pisces-ai-v${version}`, 'win-unpacked', 'PISCES AI.exe');
if (!fs.existsSync(executable)) throw new Error('未找到当前版本 PISCES AI 安装包，请先运行 npm run pack:core。');
const child = spawn(executable, [process.argv.includes('--ui-smoke') ? '--ui-smoke' : '--smoke'], {
  cwd: root,
  env: { ...process.env, MEMORY_SMOKE_OUTPUT_DIR: process.env.MEMORY_SMOKE_OUTPUT_DIR || path.join(root, 'output', 'localization-packaged') },
  windowsHide: true,
  stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
