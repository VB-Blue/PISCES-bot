const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createCredentialVault,PREFIX}=require('../electron/credential-vault.cjs');
test('account-protected credentials survive immediate owner replacement and reject modified ciphertext', {skip:process.platform!=='win32',timeout:20000}, async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'credential-owner-'));
  await fs.writeFile(path.join(dir,'settings.json'),JSON.stringify({legacy:'opaque legacy credential'}));
  await fs.writeFile(path.join(dir,'connection.json'),JSON.stringify({coreTokenEncrypted:'opaque legacy core token'}));
  const legacyDecrypt=value=>'old:'+value;
  const first=await createCredentialVault(dir,{legacyDecrypt}),encrypted=first.encrypt('synthetic-test-secret');assert.ok(encrypted.startsWith(PREFIX));
  const record=await fs.readFile(path.join(dir,'credential-key.json'),'utf8');assert.ok(!record.includes('synthetic-test-secret'));
  const second=await createCredentialVault(dir,{legacyDecrypt});assert.equal(second.decrypt(encrypted),'synthetic-test-secret');assert.equal(second.decrypt('legacy-cipher'),'old:legacy-cipher');
  const bytes=Buffer.from(encrypted.slice(PREFIX.length),'base64');bytes[bytes.length-1]^=1;assert.throws(()=>second.decrypt(PREFIX+bytes.toString('base64')));
  assert.equal(await fs.readFile(path.join(dir,'credential-migration-backup','settings.json'),'utf8'),await fs.readFile(path.join(dir,'settings.json'),'utf8'));
  assert.equal(await fs.readFile(path.join(dir,'credential-migration-backup','connection.json'),'utf8'),await fs.readFile(path.join(dir,'connection.json'),'utf8'));
});
test('a damaged credential owner file fails closed and is never replaced', {skip:process.platform!=='win32'}, async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'credential-damaged-')),file=path.join(dir,'credential-key.json');await fs.writeFile(file,'broken');
  await assert.rejects(createCredentialVault(dir),/未覆盖记录/);assert.equal(await fs.readFile(file,'utf8'),'broken');
});
