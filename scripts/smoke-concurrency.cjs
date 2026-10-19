const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const executable = process.env.MEMORY_TEST_DESKTOP_EXE || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(executable, process.env.MEMORY_TEST_DESKTOP_EXE ? ['--concurrency-smoke'] : ['.', '--concurrency-smoke'], { cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, MEMORY_SMOKE_OUTPUT_DIR: process.env.MEMORY_SMOKE_OUTPUT_DIR || root } });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
