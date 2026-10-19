const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const output = path.join(root, 'output/long-goals-20261015');
const executable = path.join(root, 'release', 'pisces-ai-v' + version, 'win-unpacked', 'PISCES AI.exe');
const archive = path.join(path.dirname(executable), 'resources/app.asar');
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
const runtime = ['main.cjs', 'preload.cjs', 'assistant-worker.cjs', 'learner.cjs', 'jobs.cjs', 'runtime-rpc.cjs', 'router.cjs', 'subject/cognition.cjs', 'model-usage.cjs', 'long-goals.cjs', 'goals-smoke.cjs', 'locales/en.json', 'locales/zh-TW.json'].map(file => 'electron/' + file);
const assets = fs.readdirSync(path.join(root, 'dist/assets')).filter(file => /\.(?:css|js)$/.test(file)).map(file => 'dist/assets/' + file);
const hashes = {};
for (const file of [...runtime, ...assets]) {
  const source = fs.readFileSync(path.join(root, file)), packed = asar.extractFile(archive, path.normalize(file));
  assert.ok(source.equals(packed), '程序包与源码不一致：' + file); hashes[file] = digest(source);
}
const tests = fs.readFileSync(path.join(output, 'all-tests-final.log'), 'utf8');
assert.match(tests, /ℹ fail 0/); assert.match(tests, /ℹ skipped 0/);
const checks = {};
for (const name of ['goals', 'host', 'task', 'parallel']) {
  const result = JSON.parse(fs.readFileSync(path.join(output, 'packaged-' + name, name + '-result.json'), 'utf8'));
  assert.equal(result.passed, true); checks[name] = result;
}
for (const name of ['workspaces', 'concurrency']) {
  const log = fs.readFileSync(path.join(output, 'packaged-' + name + '.log'), 'utf8');
  const line = log.split(/\r?\n/).findLast(item => item.startsWith('{') && (name === 'workspaces' ? item.includes('"workspaceSmoke":"passed"') : item.includes('"ok":true')));
  assert.ok(line, '缺少打包验收结果：' + name); checks[name] = JSON.parse(line);
}
const result = { version, executable, testsPassed: Number(tests.match(/ℹ pass (\d+)/)[1]), packagedChecksPassed: Object.keys(checks), runtimeFiles: runtime.length, compiledAssets: assets.length,
  packageMatchesSource: true, executableSha256: digest(fs.readFileSync(executable)), archiveSha256: digest(fs.readFileSync(archive)), hashes,
  scriptedModels: true, noPaidModelRequests: true, realBusiness24HourSoakTested: false, checks };
fs.writeFileSync(path.join(output, 'release-validation.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ version, testsPassed: result.testsPassed, packagedChecksPassed: result.packagedChecksPassed, packageMatchesSource: true, runtimeFiles: runtime.length, compiledAssets: assets.length }));
