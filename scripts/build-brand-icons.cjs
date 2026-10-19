// Render the supplied vector mark with Electron, the same renderer used by the app.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const dir = path.resolve(__dirname, '..', 'public');
  const source = await fs.readFile(path.join(dir, 'logo.svg'), 'utf8');
  const circles = source.match(/<circle\b[^>]*\/>/g).join('\n');
  const mark = color => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="32 32 176 176" width="512" height="512" fill="${color}">${circles}</svg>`;
  const window = new BrowserWindow({ width: 512, height: 512, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,<html></html>');
  const render = async sourceSvg => {
    const imageUrl = 'data:image/svg+xml;base64,' + Buffer.from(sourceSvg).toString('base64');
    const png = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(imageUrl)}; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    return nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
  };
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const writeIco = async (filename, raster) => {
    const frames = sizes.map(size => raster.resize({ width: size, height: size, quality: 'best' }).toPNG());
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16;
      header[entry] = size === 256 ? 0 : size;
      header[entry + 1] = header[entry];
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(frames[index].length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += frames[index].length;
    });
    await fs.writeFile(path.join(dir, filename), Buffer.concat([header, ...frames]));
  };
  // Keep the application/window icon unchanged; the taskbar has its own assets.
  const appRaster = await render(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="512" height="512"><rect width="240" height="240" rx="52" fill="#161616"/><g fill="#fff">${circles}</g></svg>`);
  await fs.writeFile(path.join(dir, 'icon.png'), appRaster.toPNG());
  await writeIco('icon.ico', appRaster);
  const rasters = {};
  for (const [suffix, color] of [['', '#161616'], ['-dark', '#fff']]) {
    const raster = await render(mark(color));
    const pixels = raster.toBitmap();
    let visible = 0, transparent = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 240) visible++;
      if (pixels[index] === 0) transparent++;
    }
    if (visible < 1000 || transparent < pixels.length / 8 || pixels[3] !== 0) throw new Error('The fingerprint must have visible dots and a transparent background');
    rasters[suffix || 'light'] = raster;
    await fs.writeFile(path.join(dir, `fingerprint-transparent${suffix}.png`), raster.toPNG());
    await fs.writeFile(path.join(dir, `tray${suffix}.png`), raster.resize({ width: 32, height: 32, quality: 'best' }).toPNG());
    await writeIco(`fingerprint-transparent${suffix}.ico`, raster);
  }
  // Render a compact visual check of both themes and the actual app/tray assets.
  const preview = await window.webContents.executeJavaScript(`(async () => {
    const load = async url => { const image = new Image(); image.src = url; await image.decode(); return image; };
    const canvas = document.createElement('canvas'); canvas.width = 840; canvas.height = 220;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fafafa'; ctx.fillRect(0, 0, 420, 220);
    ctx.fillStyle = '#282c28'; ctx.fillRect(420, 0, 420, 220);
    const mark = color => 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="32 32 176 176" fill="' + color + '">' + ${JSON.stringify(circles)} + '</svg>');
    ctx.drawImage(await load(${JSON.stringify('data:image/png;base64,' + rasters.light.toPNG().toString('base64'))}), 40, 30, 120, 120);
    ctx.drawImage(await load(mark('#161616')), 205, 78, 20, 20);
    ctx.drawImage(await load(mark('#161616')), 258, 72, 32, 32);
    ctx.drawImage(await load(mark('#161616')), 332, 64, 48, 48);
    ctx.drawImage(await load(${JSON.stringify('data:image/png;base64,' + rasters['-dark'].toPNG().toString('base64'))}), 460, 30, 120, 120);
    ctx.drawImage(await load(mark('#ffffff')), 625, 78, 20, 20);
    ctx.drawImage(await load(mark('#ffffff')), 678, 72, 32, 32);
    ctx.drawImage(await load(mark('#ffffff')), 752, 64, 48, 48);
    ctx.font = '14px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
    for (const [text, x, color] of [['Light', 100, '#161616'], ['20 / 32 / 48 px', 285, '#161616'], ['Dark', 520, '#ffffff'], ['20 / 32 / 48 px', 705, '#ffffff']]) { ctx.fillStyle = color; ctx.fillText(text, x, 190); }
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  await fs.mkdir(path.resolve(dir, '..', 'output', 'brand-fingerprint'), { recursive: true });
  await fs.writeFile(path.resolve(dir, '..', 'output', 'brand-fingerprint', 'preview.png'), Buffer.from(preview, 'base64'));
  console.log('PISCES AI transparent icons generated (light/dark PNG, tray PNG, multi-size ICO).');
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
