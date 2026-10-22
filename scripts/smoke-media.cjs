// Run with Electron: pictures and videos on this computer show in a real Chromium page through the app's
// media address, videos can seek, and files outside the allowed folders or of other types are refused.
const { app, BrowserWindow, protocol, net } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaHandler } = require('../electron/media-protocol.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'memory', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; object-src 'none'";
const media = file => 'memory://app/__media?path=' + encodeURIComponent(file);

app.whenReady().then(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pisces-media-display-'));
  const allowed = path.join(root, 'Pictures'), outside = path.join(root, 'Elsewhere');
  fs.mkdirSync(allowed); fs.mkdirSync(outside);
  const picture = path.join(allowed, '生成 图片.png'), video = path.join(allowed, '日出 视频.mp4'), hidden = path.join(outside, 'secret.png'), text = path.join(allowed, 'note.txt');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-frames:v', '1', picture]);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', video]);
  fs.copyFileSync(picture, hidden); fs.writeFileSync(text, 'not media');
  const serveMedia = createMediaHandler({ roots: () => [allowed], fetchFile: (url, init) => net.fetch(url, init) });
  const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><img id="picture" src="${media(picture)}"><video id="video" src="${media(video)}" preload="auto" muted></video><img id="hidden" src="${media(hidden)}">`;
  protocol.handle('memory', request => new URL(request.url).pathname === '/__media' ? serveMedia(request) : new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  let result;
  try {
    await window.loadURL('memory://app/index.html');
    result = await window.webContents.executeJavaScript(`(async () => {
      const wait = (test, label) => new Promise((resolve, reject) => { const started = Date.now(); const tick = () => { if (test()) resolve(); else if (Date.now() - started > 10000) reject(new Error(label)); else setTimeout(tick, 50); }; tick(); });
      const picture = document.getElementById('picture'), video = document.getElementById('video'), hidden = document.getElementById('hidden');
      await wait(() => picture.complete && hidden.complete, 'pictures did not settle');
      await wait(() => video.readyState >= 1 || video.error, 'video metadata did not load');
      const duration = video.duration;
      video.currentTime = 2;
      await new Promise(resolve => { video.addEventListener('seeked', resolve, { once: true }); setTimeout(resolve, 5000); });
      const status = async file => (await fetch('memory://app/__media?path=' + encodeURIComponent(file))).status;
      return { pictureWidth: picture.naturalWidth, hiddenWidth: hidden.naturalWidth, videoError: video.error ? video.error.code : 0, duration, seekedTo: video.currentTime,
        outsideStatus: await status(${JSON.stringify(hidden)}), textStatus: await status(${JSON.stringify(text)}), missingStatus: await status(${JSON.stringify(path.join(allowed, 'missing.png'))}) };
    })()`);
    const checks = {
      pictureShown: result.pictureWidth === 320,
      outsidePictureRefused: result.hiddenWidth === 0 && result.outsideStatus === 403,
      videoPlays: result.videoError === 0 && Math.abs(result.duration - 3) < 0.2,
      videoSeeks: Math.abs(result.seekedTo - 2) < 0.1,
      otherTypesRefused: result.textStatus === 404 && result.missingStatus === 404,
    };
    const passed = Object.values(checks).every(Boolean);
    const report = { passed, checks, observed: result, at: new Date().toISOString() };
    fs.mkdirSync(path.join(__dirname, '../output'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '../output/media-display.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(passed ? 0 : 1);
  } catch (error) { console.error(error.stack || error.message); app.exit(1); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
