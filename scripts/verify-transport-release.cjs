const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const output = path.join(root, 'output/transport-20261016'), executable = path.join(root, 'release/pisces-ai-v' + version + '/win-unpacked/PISCES AI.exe');
const archive = path.join(path.dirname(executable), 'resources/app.asar');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(directory, item.name)) : [path.join(directory, item.name)]);
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, version);
const hashes = {};
for (const file of [...walk(path.join(root, 'electron')), ...walk(path.join(root, 'dist'))]) {
  const relative = path.relative(root, file), source = fs.readFileSync(file);
  assert.ok(source.equals(asar.extractFile(archive, path.normalize(relative))), '包与源码不一致：' + relative);
  hashes[relative.replaceAll('\\', '/')] = digest(source);
}
const log = fs.readFileSync(path.join(output, 'all-tests.log'), 'utf8');
const testCounts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(name => [name, Number(log.match(new RegExp('ℹ ' + name + ' (\\d+)'))?.[1])]));
assert.equal(testCounts.tests, 305); assert.equal(testCounts.pass, 305); assert.equal(testCounts.fail, 0); assert.equal(testCounts.skipped, 0);
const transport = JSON.parse(fs.readFileSync(path.join(output, 'packaged/transport-result.json'), 'utf8'));
assert.equal(transport.passed, true); assert.equal(transport.realRustCore, true); assert.equal(transport.hostRestarted, true); assert.equal(transport.noErrorDocument, true); assert.equal(transport.dropped, 3); assert.equal(transport.environmentReads, 2); assert.equal(transport.writes, 1); assert.equal(transport.requirements.passed, true);
const requirements = JSON.parse(fs.readFileSync(path.join(output, 'requirements/requirements-result.json'), 'utf8'));
assert.equal(requirements.passed, true); assert.equal(requirements.rules, 24); assert.equal(requirements.persistedAcrossHostRestart, true); assert.equal(requirements.freshChatUsesEveryRule, true);
assert.equal(path.resolve(transport.executable), executable); assert.equal(path.resolve(requirements.executable), executable);
assert.ok(fs.readFileSync(path.join(root, 'start-desktop.ps1'), 'utf8').includes('pisces-ai-v' + version));
const result = { version, executable, packageMatchesSource: true, testCounts, transport, requirements, executableSha256: digest(fs.readFileSync(executable)), archiveSha256: digest(fs.readFileSync(archive)), hashes, realBybitTaskReplayed: false, realBybitPublished: false };
fs.writeFileSync(path.join(output, 'release-validation.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ version, packageMatchesSource: true, testCounts, nativeCoreRecovery: true, memoryRules: requirements.rules, sourceFiles: Object.keys(hashes).length }));
