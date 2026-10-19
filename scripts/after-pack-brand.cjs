const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Embed the brand icon even when executable signing is disabled.
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const executable = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  const icon = path.join(context.packager.projectDir, 'public', 'icon.ico');
  const editor = require.resolve('electron-winstaller/vendor/rcedit.exe');
  await promisify(execFile)(editor, [executable, '--set-icon', icon], { windowsHide: true });
  console.log('  • PISCES fingerprint icon embedded in Windows executable');
};
