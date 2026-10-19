// Runs the ordinary project entry on the owner's desktop and checks preservation without replaying any task.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const run = require('node:util').promisify(require('node:child_process').execFile);
const { connectRuntime } = require('../electron/runtime-rpc.cjs');
const root = path.resolve(__dirname, '..'), profile = path.join(process.env.APPDATA, 'MemoryDesktopAssistant');
const version = require('../package.json').version, pwsh = path.join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps/pwsh.exe');
const output = path.join(root, 'output/launcher-20261016');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(relative) { return JSON.parse(await fs.readFile(path.join(profile, relative), 'utf8')); }
async function inventory() { return JSON.parse((await run(pwsh, ['-NoLogo','-NoProfile','-File',path.join(root,'electron/desktop-lifecycle.ps1'),'-Action','Inventory','-WorkspaceRoot',root], { windowsHide: true })).stdout); }
async function host() { let client; try { client = await connectRuntime(profile, 1000); return await client.call('runtime:status'); } catch (error) { if (['ENOENT','ECONNRESET','ECONNREFUSED','EPIPE','RUNTIME_OFFLINE'].includes(error.code)) return null; throw error; } finally { client?.close(); } }
async function launch() { await run(pwsh, ['-NoLogo','-NoProfile','-File',path.join(root,'start-desktop.ps1')], { windowsHide: true, timeout: 90000 }); return json('last-desktop-start.json'); }
(async () => {
  await fs.mkdir(output, { recursive: true });
  const before = { workspace: await json('workspace.json'), jobs: await json('jobs/jobs.json'), interfaces: await inventory(), usage: hash(await fs.readFile(path.join(profile,'usage/model-usage.jsonl'))) };
  const migrated = await launch(); assert.equal(migrated.version, version); assert.equal(migrated.ready, true);
  const firstInterfaces = await inventory(), firstHost = await host();
  assert.equal(firstInterfaces.length, 1); assert.equal(firstInterfaces[0].visible, true); assert.equal(firstHost.version, version); assert.equal(firstHost.ready, true);
  for (const item of before.interfaces.filter(item => item.executable !== firstInterfaces[0].executable)) assert.ok(migrated.closedInterfaces.includes(item.pid));
  const reused = await launch(), reusedInterfaces = await inventory(), reusedHost = await host();
  assert.equal(reused.ready, true); assert.equal(reusedInterfaces.length, 1); assert.equal(reusedInterfaces[0].pid, firstInterfaces[0].pid); assert.equal(reusedHost.pid, firstHost.pid);
  const client = await connectRuntime(profile); try { await client.call('runtime:stop'); } finally { client.close(); }
  for (let i = 0; i < 150 && await host(); i++) await pause(100);
  assert.equal(await host(), null);
  const resumed = await launch(), finalInterfaces = await inventory(), finalHost = await host();
  assert.equal(resumed.ready, true); assert.equal(finalInterfaces.length, 1); assert.equal(finalInterfaces[0].pid, firstInterfaces[0].pid); assert.notEqual(finalHost.pid, firstHost.pid); assert.equal(finalHost.version, version); assert.equal(finalHost.ready, true);
  const after = { workspace: await json('workspace.json'), jobs: await json('jobs/jobs.json') };
  for (const session of before.workspace.sessions) {
    const restored = after.workspace.sessions.find(item => item.id === session.id); assert.ok(restored, '原对话丢失');
    if (session.draft) assert.equal(restored.draft, session.draft, '原草稿变化');
    for (const message of session.messages || []) assert.equal(restored.messages.find(item => item.id === message.id)?.content, message.content, '原消息变化');
  }
  for (const original of before.jobs) { const current = after.jobs.find(item => item.id === original.id); assert.ok(current); assert.equal(current.runs, original.runs, '启动不得重跑任务'); assert.equal(current.workId, original.workId); assert.equal(current.status, original.status); }
  assert.equal(hash(await fs.readFile(path.join(profile,'usage/model-usage.jsonl'))), before.usage, '启动不得发起模型生成请求');
  const result = { passed: true, version, realOwnerProfile: true, automaticMigration: migrated, repeatedOpenReusedInterfaceAndHost: true, stoppedBackgroundRestartedByNormalEntry: true, interfaceVisible: true, uiPid: finalInterfaces[0].pid, hostPid: finalHost.pid, allOriginalSessionsPreserved: true, allOriginalMessagesPreserved: true, taskRunsUnchanged: true, noModelRequests: true, jobStates: after.jobs.map(item => ({ id: item.id, status: item.status, runs: item.runs, workId: item.workId })) };
  await fs.writeFile(path.join(output,'live-launcher-result.json'), JSON.stringify(result,null,2));
  console.log(JSON.stringify({ passed: true, version, uiPid: result.uiPid, hostPid: result.hostPid, oldInterfaceClosed: migrated.closedInterfaces, singleVisibleInterface: true, stoppedBackgroundRestarted: true, taskRunsUnchanged: true, noModelRequests: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
