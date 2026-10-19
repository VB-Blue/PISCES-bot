const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const root = path.resolve(__dirname, '..');
const pwsh = path.join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps/pwsh.exe');
(async () => {
  const output = path.join(root, 'output/launcher-20261016'); await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, 'legacy-fixture-'));
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'legacy-startup-fixture', version: '0.0.1', main: 'main.cjs' }));
  await fs.writeFile(path.join(fixture, 'main.cjs'), `const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('fs'),path=require('path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false}});win.on('close',e=>{e.preventDefault();win.hide()});ipcMain.on('save-draft',(e)=>{fs.writeFileSync(path.join(__dirname,'saved-draft'),'draft preserved');e.returnValue=true});await win.loadURL('data:text/html,<script>require("electron").ipcRenderer.sendSync("save-draft")</script>');fs.writeFileSync(path.join(__dirname,'ready'),'yes');});`);
  const executable = path.join(root, 'node_modules/electron/dist/electron.exe'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [fixture], { windowsHide: true, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 150; i++) { try { await fs.stat(path.join(fixture, 'ready')); break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    await fs.stat(path.join(fixture, 'ready'));
    const script = path.join(root, 'electron/desktop-lifecycle.ps1');
    const all = JSON.parse((await run(pwsh, ['-NoLogo','-NoProfile','-File',script,'-Action','Inventory','-WorkspaceRoot',root], { windowsHide: true })).stdout);
    const item = all.find(item => item.pid === child.pid); assert.ok(item); assert.equal(item.visible, false);
    const result = await run(pwsh, ['-NoLogo','-NoProfile','-File',script,'-Action','Close','-WorkspaceRoot',root,'-TargetId',String(item.pid),'-ExpectedExecutable',item.executable,'-ExpectedStartTime',item.started], { windowsHide: true, timeout: 60000 });
    assert.equal(JSON.parse(result.stdout).graceful, true);
    assert.equal(await fs.readFile(path.join(fixture, 'saved-draft'), 'utf8'), 'draft preserved');
    await fs.writeFile(path.join(output, 'legacy-exit-result.json'), JSON.stringify({ passed: true, hiddenLegacyInterfaceClosed: true, durableSavedDraftPreserved: true, forcedTermination: false, fixture }, null, 2));
    console.log(JSON.stringify({ passed: true, hiddenLegacyInterfaceClosed: true, durableSavedDraftPreserved: true, forcedTermination: false }));
  } finally { if (child.exitCode === null) { try { process.kill(child.pid, 0); child.kill(); } catch {} } }
})().catch(error => { console.error(error); process.exitCode = 1; });
