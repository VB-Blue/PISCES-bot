const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname,'..'), version = require('../package.json').version;
const output = path.join(root,'output/launcher-20261016'), profile = path.join(process.env.APPDATA,'MemoryDesktopAssistant');
const executable = path.join(root,'release/pisces-ai-v'+version+'/win-unpacked/PISCES AI.exe'), archive = path.join(path.dirname(executable),'resources/app.asar');
const walk = directory => fs.readdirSync(directory,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(directory,item.name)):[path.join(directory,item.name)]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), hashes = {};
assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,version);
for (const file of [...walk(path.join(root,'electron')),...walk(path.join(root,'dist'))]) { const relative=path.relative(root,file), bytes=fs.readFileSync(file); assert.ok(bytes.equals(asar.extractFile(archive,path.normalize(relative))),relative); hashes[relative.replaceAll('\\','/')]=hash(bytes); }
assert.ok(fs.readFileSync(path.join(root,'electron/desktop-lifecycle.ps1')).equals(fs.readFileSync(path.join(path.dirname(executable),'resources/desktop-lifecycle.ps1'))));
const log=fs.readFileSync(path.join(output,'all-tests.log'),'utf8');
const testCounts=Object.fromEntries(['tests','pass','fail','skipped'].map(name=>[name,Number(log.match(new RegExp('ℹ '+name+' (\\d+)'))?.[1])]));
assert.equal(testCounts.tests,313);assert.equal(testCounts.pass,313);assert.equal(testCounts.fail,0);assert.equal(testCounts.skipped,0);
const live=JSON.parse(fs.readFileSync(path.join(output,'live-launcher-result.json'),'utf8'));assert.equal(live.passed,true);assert.equal(live.version,version);assert.equal(live.interfaceVisible,true);assert.equal(live.taskRunsUnchanged,true);assert.equal(live.noModelRequests,true);
const firstBackup=path.join(profile,'startup-backups',fs.readdirSync(path.join(profile,'startup-backups')).sort()[0]);
const original=JSON.parse(fs.readFileSync(path.join(firstBackup,'workspace.json'),'utf8')), current=JSON.parse(fs.readFileSync(path.join(profile,'workspace.json'),'utf8'));
let messages=0;
for(const session of original.sessions){const restored=current.sessions.find(item=>item.id===session.id);assert.ok(restored);if(session.draft)assert.equal(restored.draft,session.draft);for(const message of session.messages||[]){assert.equal(restored.messages.find(item=>item.id===message.id)?.content,message.content);messages++;}}
const originalJobs=JSON.parse(fs.readFileSync(path.join(firstBackup,'jobs/jobs.json'),'utf8')), jobs=JSON.parse(fs.readFileSync(path.join(profile,'jobs/jobs.json'),'utf8'));
for(const old of originalJobs){const restored=jobs.find(item=>item.id===old.id);assert.ok(restored);assert.equal(restored.runs,old.runs);assert.equal(restored.workId,old.workId);assert.equal(restored.status,old.status);}
const result={version,executable,packageMatchesSource:true,testCounts,live,originalV020StatePreserved:true,originalMessages:messages,originalJobs:originalJobs.length,firstBackup,hashes};
fs.writeFileSync(path.join(output,'release-validation.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({version,packageMatchesSource:true,testCounts,realDesktopVerified:true,originalMessages:messages,originalJobs:originalJobs.length,statePreserved:true}));
