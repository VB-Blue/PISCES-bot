const path = require('node:path');
const fs = require('node:fs/promises');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const pwsh = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe');
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
let starting;

async function startCanonicalCore(projectRoot, coreUrl) {
  if (coreUrl !== 'http://127.0.0.1:18789') throw new Error('自动启动使用 127.0.0.1:18789；自定义地址请连接已运行的核心');
  if (starting) return starting;
  starting = launch(projectRoot).finally(() => { starting = null; });
  return starting;
}

async function launch(projectRoot) {
  projectRoot = path.resolve(projectRoot);
  const declaration = JSON.parse((await fs.readFile(path.join(projectRoot, 'runtime_mainline.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const runtime = path.resolve(projectRoot, declaration.canonical_runtime_root);
  const relative = path.relative(projectRoot, runtime);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('主线运行目录必须位于核心工程内');
  const candidates = ['task-workspaces-v1/autonomous_node.exe', 'continuity-v1/autonomous_node.exe', 'autonomous_node.exe'].map(file => path.join(projectRoot, 'target', 'release', file));
  let binary;
  for (const candidate of candidates) { if (await fs.access(candidate).then(() => true).catch(() => false)) { binary = candidate; break; } }
  if (!binary) throw new Error('未找到已构建的核心程序');
  await fs.access(binary);
  // Never restart another owner or select a different runtime when a core already exists.
  const inventory = await execFile(pwsh, ['-NoLogo', '-NoProfile', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name = 'autonomous_node.exe' OR Name = 'autonomous_assistant_node.exe'\" | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"], { windowsHide: true });
  if (inventory.stdout.trim() && inventory.stdout.trim() !== '[]') throw new Error('已有核心进程运行；请连接其地址，未启动第二个核心');
  await fs.mkdir(runtime, { recursive: true });
  const lockPath = path.join(runtime, '.desktop-start.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('另一个桌面入口正在启动核心；请稍后检查连接'); throw error; }
  try {
    const logs = path.join(runtime, 'logs');
    await fs.mkdir(logs, { recursive: true });
    const args = ['--state', path.join(runtime, 'body_state.json'), '--event-store', path.join(runtime, 'event_store'),
      '--checkpoint-path', path.join(runtime, 'checkpoint.json'), '--checkpoint-every-cycles', '1',
      '--health-bind', '127.0.0.1:18789', '--log-json', '--log-json-path', path.join(logs, 'autonomous_node.jsonl'),
      '--anomaly-audit-path', path.join(logs, 'anomaly_audit.jsonl'), '--cycle-sleep-ms', '1000', '--local-only', '--forever'];
    const command = "$ErrorActionPreference='Stop'; if (Get-CimInstance Win32_Process -Filter \"Name = 'autonomous_node.exe' OR Name = 'autonomous_assistant_node.exe'\") { throw '核心已运行，取消启动' }; if (Get-NetTCPConnection -State Listen -LocalPort 18789 -ErrorAction SilentlyContinue) { throw '核心端口已占用，取消启动' }; $nodeProcess = Start-Process -FilePath " + psQuote(binary) + ' -ArgumentList @(' + args.map(arg => psQuote('"' + arg + '"')).join(',') + ') -WorkingDirectory ' + psQuote(projectRoot) + ' -WindowStyle Hidden -RedirectStandardOutput ' + psQuote(path.join(logs, 'desktop-node.stdout.log')) + ' -RedirectStandardError ' + psQuote(path.join(logs, 'desktop-node.stderr.log')) + ' -PassThru; $nodeProcess.Id';
    await execFile(pwsh, ['-NoLogo', '-NoProfile', '-Command', command], { cwd: projectRoot, windowsHide: true, timeout: 30000, maxBuffer: 100000,
      env: { ...process.env, MEMORY_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_LOCAL_ONLY: 'true', AUTONOMOUS_NODE_STRICT_OFFLINE: 'true',
        MEMORY_CHAT_PREFER_ENV: 'true', MEMORY_CHAT_API_MODE: 'local_only', MEMORY_CHAT_API_KEY: '', MEMORY_CHAT_BEARER_TOKEN: '', OPENAI_API_KEY: '',
        MEMORY_CHAT_ENDPOINT_URL: '', MEMORY_CHAT_BASE_URL: '', MEMORY_CHAT_CONFIG_PATH: '', MEMORY_AUTONOMOUS_LEARNING_ENABLED: 'false', MEMORY_AUTONOMOUS_RESEARCH_ENABLED: 'false', AUTONOMOUS_NODE_OBJECTIVE_AUTO_REPLAN_ENABLED: 'false' } });
    return { started: true, runtime, backgroundResearch: false };
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
module.exports = { startCanonicalCore };
