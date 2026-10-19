const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { spawn, execFile } = require('node:child_process');
const { connectRuntime, addressFor } = require('./runtime-rpc.cjs');
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function transition({ version, executable, inspect, readHost, stopHost, snapshot, closeUI, startUI, ready, timeoutMs = 45000 }) {
  const interfaces = await inspect();
  const old = interfaces.filter(item => path.resolve(item.executable).toLowerCase() !== path.resolve(executable).toLowerCase());
  const host = await readHost();
  if (host && host.version !== version) await stopHost(host);
  let backup = null;
  if (old.length) {
    backup = await snapshot();
    for (const item of old) await closeUI(item);
  }
  await startUI();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ready()) return { version, automaticHandoff: true, closedInterfaces: old.map(item => item.pid), backup, ready: true };
    await pause(200);
  }
  throw new Error('应用启动未能就绪；详细记录已保存在本机启动日志中');
}
async function run({ app, root, profile, executable, version }) {
  root = path.resolve(root);
  const journal = path.join(profile, 'desktop-launcher.log');
  await fs.mkdir(profile, { recursive: true });
  const lock = net.createServer();
  try { await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen(addressFor(path.join(profile, 'desktop-launcher')), resolve); }); }
  catch (error) { if (error.code === 'EADDRINUSE') return { alreadyStarting: true }; throw error; }
  const log = async event => fs.appendFile(journal, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  const pwsh = path.join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps/pwsh.exe');
  const script = app.isPackaged ? path.join(process.resourcesPath, 'desktop-lifecycle.ps1') : path.join(__dirname, 'desktop-lifecycle.ps1');
  const invoke = async (action, args = []) => {
    const result = await execute(pwsh, ['-NoLogo', '-NoProfile', '-File', script, '-Action', action, '-WorkspaceRoot', root, '-ExcludeId', String(process.pid), ...args], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout.trim());
  };
  const readHost = async () => { let client; try { client = await connectRuntime(profile, 1200); return await client.call('runtime:status'); } catch (error) { if (['ENOENT','ECONNREFUSED','ECONNRESET','EPIPE','RUNTIME_OFFLINE','RUNTIME_TIMEOUT'].includes(error.code)) return null; throw error; } finally { client?.close(); } };
  const snapshot = async () => {
    // Legacy UIs have no upgrade RPC. Let their continuous workspace save drain before taking the recovery copy.
    let previous = '', stable = 0;
    for (let attempt = 0; attempt < 20 && stable < 3; attempt++) {
      let signature = ''; try { signature = createHash('sha256').update(await fs.readFile(path.join(profile, 'workspace.json'))).digest('hex'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      stable = signature === previous ? stable + 1 : 0; previous = signature; await pause(150);
    }
    if (stable < 3) throw new Error('对话仍在保存，未退出旧界面；请稍后重新启动');
    const directory = path.join(profile, 'startup-backups', Date.now() + '-' + randomUUID()); await fs.mkdir(directory, { recursive: true });
    const files = [];
    for (const relative of ['workspace.json','workspace.json.bak','jobs/jobs.json','memory/requirements.json']) {
      try { const bytes = await fs.readFile(path.join(profile, relative)); const destination = path.join(directory, relative); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes); files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ files }, null, 2)); return directory;
  };
  try {
    await log({ event: 'start', version });
    const result = await transition({ version, executable, inspect: () => invoke('Inventory'), readHost, snapshot,
      stopHost: async host => {
        let client; try { client = await connectRuntime(profile); await client.call('runtime:stop'); } finally { client?.close(); }
        for (let i = 0; i < 150; i++) { const current = await readHost(); if (!current || current.pid !== host.pid) return; await pause(100); }
        throw new Error('旧后台尚未完成保存与暂停，启动交接已停止');
      },
      closeUI: async item => {
        await log({ event: 'close-old-interface', pid: item.pid, executable: item.executable });
        const release = /pisces-ai-v(\d+)\.(\d+)\.(\d+)/i.exec(item.executable);
        if (release && (Number(release[1]) > 0 || Number(release[2]) > 21 || Number(release[2]) === 21 && Number(release[3]) >= 3)) {
          const child = spawn(item.executable, ['--desktop-ui', '--prepare-upgrade'], { windowsHide: true, detached: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref();
          for (let i = 0; i < 25; i++) { if (!(await invoke('Inventory')).some(current => current.pid === item.pid && current.started === item.started)) return; await pause(100); }
        }
        await invoke('Close', ['-TargetId', String(item.pid), '-ExpectedExecutable', item.executable, '-ExpectedStartTime', item.started]);
      },
      startUI: async () => {
        const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(executable, [...(app.isPackaged ? [] : [app.getAppPath()]), '--desktop-ui'], { cwd: app.isPackaged ? path.dirname(executable) : root, detached: true, windowsHide: false, stdio: 'ignore', env });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      },
      ready: async () => {
        const current = await readHost();
        if (!current?.ready || current.stopping || current.version !== version) return false;
        const interfaces = await invoke('Inventory'); return interfaces.some(item => item.executable.toLowerCase() === executable.toLowerCase() && item.visible);
      },
    });
    await log({ event: 'ready', ...result });
    await fs.writeFile(path.join(profile, 'last-desktop-start.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) { await log({ event: 'failed', error: error.message }); throw error; }
  finally { await new Promise(resolve => lock.close(resolve)); }
}
module.exports = { run, transition };
