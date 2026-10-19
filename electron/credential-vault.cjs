// Persist the account-protected master key before acknowledging any encrypted credential.
// Headless Chromium can die before flushing its newly generated key, so new secrets use direct Windows DPAPI.
const fs = require('node:fs/promises'), path = require('node:path');
const { randomBytes, randomUUID, createCipheriv, createDecipheriv } = require('node:crypto');
const { spawn } = require('node:child_process');
const { protectTokenFile } = require('./runtime-rpc.cjs');
const PREFIX = 'pisces-vault-v1:';
const SCRIPT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security.Cryptography.ProtectedData; $inputRecord=[Console]::In.ReadToEnd()|ConvertFrom-Json; $bytes=[Convert]::FromBase64String($inputRecord.value); $entropy=[Text.Encoding]::UTF8.GetBytes('PISCES AI credentials v1'); if ($inputRecord.mode -eq 'protect') { $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) } else { $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }; [Console]::Out.Write([Convert]::ToBase64String($result))";
async function protectedData(mode, value) {
  const child = spawn(path.join(process.env.LOCALAPPDATA,'Microsoft/WindowsApps/pwsh.exe'), ['-NoLogo','-NoProfile','-NonInteractive','-Command',SCRIPT], { windowsHide:true, stdio:['pipe','pipe','pipe'] });
  let output='', error=''; child.stdout.on('data',data=>output+=data); child.stderr.on('data',data=>error=(error+data).slice(-500));
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('本机密钥保护超时'));},15000);
    child.once('error',caught=>{clearTimeout(timer);reject(caught);});
    child.once('exit',code=>{clearTimeout(timer);if(code!==0||!/^[\w+/=]+$/.test(output.trim()))reject(new Error('本机密钥保护失败：'+error.slice(0,200)));else resolve(Buffer.from(output.trim(),'base64'));});
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify({mode,value:Buffer.from(value).toString('base64')}));
  });
}
async function createCredentialVault(dir, { legacyDecrypt, legacyEncrypt } = {}) {
  if (process.platform !== 'win32') return { encrypt:legacyEncrypt, decrypt:legacyDecrypt };
  const file=path.join(dir,'credential-key.json'); let key;
  try {
    const record=JSON.parse(await fs.readFile(file,'utf8'));
    if(record.schema!==1||typeof record.protectedKey!=='string')throw new Error('本机密钥记录损坏');
    key=await protectedData('unprotect',Buffer.from(record.protectedKey,'base64'));
    if(key.length!==32)throw new Error('本机密钥长度不正确');
  } catch(error) {
    if(error.code!=='ENOENT')throw new Error('无法读取现有服务密钥，未覆盖记录：'+error.message);
    await fs.mkdir(dir,{recursive:true});key=randomBytes(32);
    const protectedKey=await protectedData('protect',key), temporary=file+'.'+randomUUID()+'.tmp';
    await fs.writeFile(temporary,'',{flag:'wx',mode:0o600});await protectTokenFile(temporary);
    const handle=await fs.open(temporary,'w');
    try { await handle.writeFile(JSON.stringify({schema:1,protectedKey:protectedKey.toString('base64')}));await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary,file);
    // Preserve the encrypted legacy connection files for rollback; never rewrite their secrets automatically.
    const backup=path.join(dir,'credential-migration-backup');await fs.mkdir(backup,{recursive:true});
    for(const name of ['connection.json','settings.json','providers.json','Local State']) { try { await fs.copyFile(path.join(dir,name),path.join(backup,name),require('node:fs').constants.COPYFILE_EXCL); } catch(error) { if(!['ENOENT','EEXIST'].includes(error.code))throw error; } }
  }
  return {
    encrypt(value) {
      if(!value)return '';const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(PREFIX));
      const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
      return PREFIX+Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64');
    },
    decrypt(value) {
      if(!value)return '';if(!value.startsWith(PREFIX))return legacyDecrypt(value);
      const data=Buffer.from(value.slice(PREFIX.length),'base64');if(data.length<28)throw new Error('服务密钥密文损坏');
      const cipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));cipher.setAAD(Buffer.from(PREFIX));cipher.setAuthTag(data.subarray(12,28));
      return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');
    },
  };
}
module.exports={createCredentialVault,PREFIX};
