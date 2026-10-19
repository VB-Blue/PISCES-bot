// Preserve the declared runtime and identity; never start a second subject.
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { coreRequest } = require('../electron/core-client.cjs');
const { startCanonicalCore } = require('../electron/core-runtime.cjs');
const pwsh = 'C:\\Users\\Willam\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const project = 'D:\\记忆体';
const settings = { coreUrl: 'http://127.0.0.1:18789' };
const filter = "Name = 'autonomous_node.exe' OR Name = 'autonomous_assistant_node.exe'";
const inventory = async () => JSON.parse((await execFile(pwsh, ['-NoLogo', '-NoProfile', '-Command', `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter ${quote(filter)} | ForEach-Object { @{ pid=$_.ProcessId; path=$_.ExecutablePath; command=$_.CommandLine; started=$_.CreationDate.Ticks.ToString() } })`], { windowsHide: true })).stdout);

(async () => {
  const declaration = JSON.parse((await fs.readFile(path.join(project, 'runtime_mainline.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const runtime = path.resolve(project, declaration.canonical_runtime_root);
  const relative = path.relative(project, runtime);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime outside project');
  const lockPath = path.join(runtime, '.assistant-upgrade.lock');
  const lock = await fs.open(lockPath, 'wx');
  let previousPid = null, backup = null;
  try {
    try { const ready = await coreRequest(settings, '', '/api/v1/assistant/profile'); if (ready.ok && process.env.MEMORY_UPGRADE_CORE_FORCE !== '1') { console.log(JSON.stringify({ reused: true, subject_id: ready.subject_id })); return; } } catch (error) { if (/401|403/.test(error.message)) throw error; }
    const staged = process.env.MEMORY_UPGRADE_CORE_BINARY ? path.resolve(process.env.MEMORY_UPGRADE_CORE_BINARY) : null;
    if (staged) {
      const report = JSON.parse(await fs.readFile(path.join(__dirname, '../桌面控制真实验收.json'), 'utf8'));
      const hash = require('node:crypto').createHash('sha256').update(await fs.readFile(staged)).digest('hex');
      if (!report.passed || report.binary_sha256 !== hash) throw new Error('Staged binary must match the independently tested desktop report');
    }
    const processes = await inventory();
    if (processes.length !== 1) throw new Error('Upgrade requires exactly one existing canonical process');
    const old = processes[0];
    const normalizedCommand = old.command.replace(/\\+/g, '\\').toLowerCase();
    if (!normalizedCommand.includes(path.join(runtime, 'body_state.json').toLowerCase()) || !old.command.includes('127.0.0.1:18789')) throw new Error('Existing process is not the declared canonical runtime');
    const ownerPath = path.join(runtime, 'unified_subject_aggregate_owner.json');
    const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    if (owner.assistant?.works?.some(w => w.status === 'running')) throw new Error('Active assistant work must settle before upgrade');
    const workflows = Object.values(owner.canonical_subject.desktop_workflows || {});
    const bindings = Object.values(owner.canonical_subject.software_control.execution_bindings || {});
    if (workflows.some(w => !['completed','aborted'].includes(String(w.graph?.status).toLowerCase())) || bindings.some(b => !b.settled_at) || owner.assistant?.works?.some(w => w.status === 'result_unknown')) throw new Error('Unsettled desktop work requires reconciliation before upgrade');
    const beforeStat = await fs.stat(ownerPath);
    if (Date.now() - beforeStat.mtimeMs < 3000) throw new Error('Canonical owner was just modified; retry when idle');
    backup = path.join(runtime, 'assistant_upgrade_backups', new Date().toISOString().replace(/[:.]/g, '-'));
    await fs.mkdir(backup, { recursive: true });
    for (const file of ['unified_subject_aggregate_owner.json', 'body_state.json', 'checkpoint.json']) await fs.copyFile(path.join(runtime, file), path.join(backup, file));
    const verified = await inventory();
    if (verified.length !== 1 || verified[0].pid !== old.pid || verified[0].started !== old.started || (await fs.stat(ownerPath)).mtimeMs !== beforeStat.mtimeMs) throw new Error('Process/owner changed during backup; upgrade cancelled');
    const command = `$ErrorActionPreference='Stop'; $existingNode=Get-CimInstance Win32_Process -Filter 'ProcessId = ${old.pid}'; if (-not $existingNode -or $existingNode.CreationDate.Ticks.ToString() -ne ${quote(old.started)} -or $existingNode.ExecutablePath -ne ${quote(old.path)}) { throw 'Core process changed' }; Stop-Process -Id ${old.pid} -ErrorAction Stop`;
    await execFile(pwsh, ['-NoLogo', '-NoProfile', '-Command', command], { windowsHide: true });
    previousPid = old.pid;
    if (staged) {
      const executable = path.join(project, 'target/release/autonomous_node.exe');
      await fs.copyFile(executable, path.join(backup, 'autonomous_node.exe'));
      for (let attempt = 0; ; attempt++) {
        try { await fs.copyFile(staged, executable); break; } catch (error) { if (attempt >= 20) throw error; await new Promise(r => setTimeout(r, 300)); }
      }
    }
    await startCanonicalCore(project, settings.coreUrl);
    let ready;
    for (let i = 0; i < 240; i++) {
      try { ready = await coreRequest(settings, '', '/api/v1/assistant/profile'); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('New core started but has not become ready; runtime and backup preserved');
    if (ready.subject_id !== owner.subject_id) throw new Error('Subject identity changed');
    const afterOwner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    if (afterOwner.canonical_cycle_id < owner.canonical_cycle_id) throw new Error('Canonical sequence regressed');
    const report = { passed: true, runtime, backup, previousPid, currentProcesses: (await inventory()).map(p => ({ pid: p.pid, path: p.path })), subject_id: ready.subject_id, preservedCanonicalCycle: owner.canonical_cycle_id, backgroundPaidLearning: false, noTestExperienceImported: true };
    await fs.mkdir(path.join(__dirname, '../output'), { recursive: true }); await fs.writeFile(path.join(__dirname, '../output/assistant-mainline-upgrade.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { await lock.close(); await fs.unlink(lockPath); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
