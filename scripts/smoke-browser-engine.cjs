const { spawn } = require('node:child_process');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const child = spawn(path.join(project, 'node_modules/electron/dist/electron.exe'), [path.join(project, 'electron/browser-engine-smoke.cjs')], { cwd: project, stdio: 'inherit', windowsHide: true, env: process.env });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
