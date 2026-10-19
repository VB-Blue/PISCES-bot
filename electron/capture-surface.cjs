// Capture the current offscreen frame, rather than a stale Chromium surface.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function captureSurface(window) {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await pause(180);
  if (!window.webContents.isOffscreen()) return (await window.webContents.capturePage()).toPNG();
  return new Promise((resolve, reject) => {
    const paint = (_event, _rectangle, image) => {
      if (image.isEmpty()) return;
      clearTimeout(timer);
      window.webContents.removeListener('paint', paint);
      resolve(image.toPNG());
    };
    const timer = setTimeout(() => { window.webContents.removeListener('paint', paint); reject(new Error('截图重绘超时')); }, 5000);
    window.webContents.on('paint', paint);
    window.webContents.invalidate();
  });
}
module.exports = { captureSurface };
