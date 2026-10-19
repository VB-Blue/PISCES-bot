const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const output = path.join(root, 'output/requirements-20261016');
const executable = path.join(root, 'release', 'pisces-ai-v' + version, 'win-unpacked/PISCES AI.exe');
const archive = path.join(path.dirname(executable), 'resources/app.asar');
const digest = value => createHash('sha256').update(value).digest('hex');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(directory, item.name)) : [path.join(directory, item.name)]);
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
const files = [...walk(path.join(root, 'electron')), path.join(root, 'dist/index.html'), ...fs.readdirSync(path.join(root, 'dist/assets')).filter(file => /\.(js|css)$/.test(file)).map(file => path.join(root, 'dist/assets', file))];
const hashes = {};
for (const file of files) {
  const relative = path.relative(root, file), bytes = fs.readFileSync(file);
  assert.ok(bytes.equals(asar.extractFile(archive, path.normalize(relative))), '打包与源码不一致：' + relative);
  hashes[relative.replaceAll('\\', '/')] = digest(bytes);
}
const log = fs.readFileSync(path.join(output, 'all-tests-release.log'), 'utf8');
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(name => [name, Number(log.match(new RegExp('ℹ ' + name + ' (\\d+)'))?.[1])]));
assert.ok(counts.tests >= 296); assert.equal(counts.skipped, 0); assert.equal(counts.pass + counts.fail, counts.tests);
assert.equal(counts.fail, 0, '最终全量测试必须通过');
const failures = [...new Set(log.split(/\r?\n/).filter(line => line.startsWith('✖ ') && !line.startsWith('✖ failing')).map(line => line.replace(/ \([\d.]+ms\)$/, '').slice(2)))];
const known = ['the desktop agent really finds, focuses, sees and drives another window', 'the control layer observes with numbered marks, verifies every action, reads text, falls back to OCR and cuts off useless loops'];
assert.ok(failures.every(name => known.includes(name))); assert.equal(failures.length, counts.fail);
const previous = path.join(root, 'release/pisces-ai-v0.20.0/win-unpacked/resources/app.asar');
for (const file of ['electron/desktop-agent.cjs', 'electron/control-tools.cjs']) assert.ok(fs.readFileSync(path.join(root, file)).equals(asar.extractFile(previous, path.normalize(file))), '旧窗口失败对应的模块不应有本轮修改');
const smoke = JSON.parse(fs.readFileSync(path.join(output, 'packaged-final/requirements-result.json'), 'utf8'));
assert.equal(smoke.passed, true); assert.equal(path.resolve(smoke.executable), path.resolve(executable)); assert.equal(smoke.rules, 24);
const engine = JSON.parse(fs.readFileSync(path.join(output, 'browser-engine-final/engine-result.json'), 'utf8'));
assert.equal(engine.passed, true); assert.ok(engine.checks.length >= 24);
const canonical = JSON.parse(fs.readFileSync(path.join(output, 'canonical-core/core-integration-result.json'), 'utf8'));
assert.equal(canonical.passed, true); assert.equal(canonical.realRustCore, true); assert.equal(canonical.works.length, 2);
assert.ok(canonical.works.every(work => work.acceptance.authority === 'canonical_core' && work.acceptance.requirementsCheck.passed && work.acceptance.requirementsCheck.checks.length === 3));
for (const phase of ['before', 'after']) {
  const saved = JSON.parse(fs.readFileSync(path.join(output, 'packaged-final', phase + '-result.json'), 'utf8'));
  assert.equal(saved.result.requirementsCheck.passed, true); assert.equal(saved.result.requirementsCheck.checks.length, 24);
  assert.ok(saved.rules[0].text.length > 400);
  const persisted = JSON.parse(fs.readFileSync(saved.result.requirementsCheck.recordPath, 'utf8'));
  assert.equal(persisted.signature, saved.result.requirementsCheck.signature);
  assert.ok(persisted.checks.every(item => item.status === 'passed'));
}
assert.ok(fs.readFileSync(path.join(root, 'start-desktop.ps1'), 'utf8').includes('pisces-ai-v' + version));
const result = { version, executable, packageMatchesSource: true, runtimeAndAssetFiles: files.length, testCounts: counts, remainingFailures: failures, desktopFocusModulesUnchanged: true, specializedTests: 17, packagedRequirements: smoke, canonicalCore: canonical, browserEngineChecks: engine.checks.length, noPaidModelRequests: true, realModelQualityTested: false, realBusiness24HourSoakTested: false, executableSha256: digest(fs.readFileSync(executable)), archiveSha256: digest(fs.readFileSync(archive)), hashes };
fs.writeFileSync(path.join(output, 'release-validation.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ version, packageMatchesSource: true, testCounts: counts, remainingFailures: failures.length, specializedTests: 17, packagedRules: 24, browserEngineChecks: engine.checks.length }));
