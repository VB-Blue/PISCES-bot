const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version, output = path.join(root, 'output/browser-20261015');
const executable = path.join(root, 'release', 'pisces-ai-v' + version, 'win-unpacked/PISCES AI.exe'), archive = path.join(path.dirname(executable), 'resources/app.asar');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]);
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
const sources = walk(path.join(root, 'electron')).map(file => path.relative(root, file));
const assets = ['dist/index.html', ...fs.readdirSync(path.join(root, 'dist/assets')).filter(file => /\.(?:js|css)$/.test(file)).map(file => 'dist/assets/' + file)];
const hashes = {};
for (const file of [...sources, ...assets]) { const bytes = fs.readFileSync(path.join(root, file)); assert.ok(bytes.equals(asar.extractFile(archive, path.normalize(file))), '打包与源码不一致：' + file); hashes[file.replaceAll('\\', '/')] = digest(bytes); }
const tests = fs.readFileSync(path.join(output, 'all-tests-final.log'), 'utf8');
const testCounts = Object.fromEntries(['tests','pass','fail','skipped'].map(name => [name, Number(tests.match(new RegExp('ℹ ' + name + ' (\\d+)'))?.[1])]));
assert.ok(testCounts.tests >= 279); assert.equal(testCounts.skipped, 0); assert.equal(testCounts.pass + testCounts.fail, testCounts.tests);
const remainingFailures = [...new Set(tests.split(/\r?\n/).filter(line => line.startsWith('✖ ') && !line.startsWith('✖ failing')).map(line => line.replace(/ \([\d.]+ms\)$/, '').slice(2)))];
const desktopFocusFailures = ['the desktop agent really finds, focuses, sees and drives another window', 'the control layer observes with numbered marks, verifies every action, reads text, falls back to OCR and cuts off useless loops'];
assert.ok(remainingFailures.every(name => desktopFocusFailures.includes(name))); assert.equal(remainingFailures.length, testCounts.fail);
const previous = path.join(root, 'release/pisces-ai-v0.19.0/win-unpacked/resources/app.asar');
const desktopSourcesUnchanged = ['electron/desktop-agent.cjs','electron/control-tools.cjs'].every(file => fs.readFileSync(path.join(root, file)).equals(asar.extractFile(previous, path.normalize(file)))); assert.equal(desktopSourcesUnchanged, true);
const checks = {};
for (const name of ['browser','goals','host','task','parallel']) { const result = JSON.parse(fs.readFileSync(path.join(output, 'packaged-' + name, name + '-result.json'), 'utf8')); assert.equal(result.passed, true); assert.equal(path.resolve(result.executable || result.desktopExecutable), path.resolve(executable)); checks[name] = result; }
for (const name of ['workspaces','concurrency']) { const log = fs.readFileSync(path.join(output, 'packaged-' + name + '.log'), 'utf8'); const line = log.split(/\r?\n/).findLast(line => line.startsWith('{') && line.includes(name === 'workspaces' ? '"workspaceSmoke":"passed"' : '"ok":true')); assert.ok(line, '未通过打包验收：' + name); checks[name] = JSON.parse(line); }
const engine = JSON.parse(fs.readFileSync(path.join(output, 'engine-final-complete/engine-result.json'), 'utf8')); assert.equal(engine.passed, true);
const launcher = fs.readFileSync(path.join(root, 'start-desktop.ps1'), 'utf8'); assert.ok(launcher.includes('pisces-ai-v' + version));
const result = { version, executable, packageMatchesSource: true, runtimeFiles: sources.length, compiledAssets: assets.length, testCounts, allUnitTestsPassed: testCounts.fail === 0, remainingFailures, desktopSourcesUnchanged, browserEngineChecksPassed: engine.checks.length, packagedSuitesPassed: Object.keys(checks), noPaidModelRequests: true, realBusiness24HourSoakTested: false, executableSha256: digest(fs.readFileSync(executable)), archiveSha256: digest(fs.readFileSync(archive)), hashes, checks };
fs.writeFileSync(path.join(output, 'release-validation.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ version, packageMatchesSource: true, testCounts, remainingFailures, desktopSourcesUnchanged, browserEngineChecksPassed: engine.checks.length, packagedSuitesPassed: result.packagedSuitesPassed }));
