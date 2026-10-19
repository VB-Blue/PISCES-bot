// Basic photo editing without any external software: the pipeline runs on a canvas in a hidden, sandboxed window.
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif' };

function normalizeOps(list) {
  if (!Array.isArray(list) || !list.length || list.length > 12) throw new Error('operations 需要 1～12 个操作');
  const num = (value, min, max, fallback, name) => {
    const n = Number(value ?? fallback);
    if (!Number.isFinite(n)) throw new Error(name + ' 必须是数字');
    return Math.min(max, Math.max(min, n));
  };
  return list.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('操作格式无效');
    switch (raw.op) {
      case 'rotate': return { op: 'rotate', degrees: num(raw.degrees, -180, 180, 0, 'degrees'), fill: raw.fill !== false };
      case 'crop': {
        const left = num(raw.left, 0, 0.95, 0, 'left'), top = num(raw.top, 0, 0.95, 0, 'top');
        return { op: 'crop', left, top, width: Math.min(1 - left, num(raw.width, 0.02, 1, 1, 'width')), height: Math.min(1 - top, num(raw.height, 0.02, 1, 1, 'height')) };
      }
      case 'resize': return { op: 'resize', max_side: Math.round(num(raw.max_side, 16, 8000, 2048, 'max_side')) };
      case 'flip': if (!['horizontal', 'vertical'].includes(raw.direction)) throw new Error('flip 的 direction 必须是 horizontal 或 vertical'); return { op: 'flip', direction: raw.direction };
      case 'adjust': return { op: 'adjust', brightness: num(raw.brightness, 0, 3, 1, 'brightness'), contrast: num(raw.contrast, 0, 3, 1, 'contrast'), saturate: num(raw.saturate, 0, 3, 1, 'saturate'),
        grayscale: num(raw.grayscale, 0, 1, 0, 'grayscale'), sepia: num(raw.sepia, 0, 1, 0, 'sepia'), blur: num(raw.blur, 0, 20, 0, 'blur'), hue_rotate: num(raw.hue_rotate, -180, 180, 0, 'hue_rotate') };
      default: throw new Error('不支持的操作：' + raw.op);
    }
  });
}

function describeOps(ops) {
  return ops.map(item => ({ rotate: '旋转 ' + item.degrees + '°' + (item.fill ? '（自动裁掉空角）' : ''), crop: '裁剪', resize: '缩放到长边 ' + item.max_side + 'px', flip: item.direction === 'horizontal' ? '水平翻转' : '垂直翻转',
    adjust: '调色（亮度 ' + item.brightness + '，对比度 ' + item.contrast + '，饱和度 ' + item.saturate + '）' })[item.op]).join('；');
}

// Runs inside the hidden page. Plain function so it can be serialized.
async function pageScript({ dataUrl, ops, format }) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  let canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  const next = (width, height, draw) => {
    const made = document.createElement('canvas');
    made.width = Math.max(1, Math.round(width)); made.height = Math.max(1, Math.round(height));
    draw(made.getContext('2d'), made);
    canvas = made;
  };
  // Largest axis-aligned rectangle that fits inside a w x h rectangle rotated by angle a.
  const inscribed = (w, h, angle) => {
    let a = Math.abs(angle) % Math.PI; if (a > Math.PI / 2) a = Math.PI - a;
    if (a < 1e-6) return [w, h];
    const sin = Math.sin(a), cos = Math.cos(a), long = Math.max(w, h), short = Math.min(w, h);
    if (short <= 2 * sin * cos * long || Math.abs(sin - cos) < 1e-9) { const x = 0.5 * short; return w >= h ? [x / sin, x / cos] : [x / cos, x / sin]; }
    const cos2 = cos * cos - sin * sin;
    return [(w * cos - h * sin) / cos2, (h * cos - w * sin) / cos2];
  };
  for (const step of ops) {
    const source = canvas, w = source.width, h = source.height;
    if (step.op === 'rotate') {
      const a = step.degrees * Math.PI / 180, cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
      next(w * cos + h * sin, w * sin + h * cos, (c, n) => { c.fillStyle = '#ffffff'; c.fillRect(0, 0, n.width, n.height); c.translate(n.width / 2, n.height / 2); c.rotate(a); c.drawImage(source, -w / 2, -h / 2); });
      if (step.fill && Math.abs(step.degrees) > 0.01) {
        const rotated = canvas, [rw, rh] = inscribed(w, h, a);
        next(rw, rh, c => c.drawImage(rotated, (rotated.width - rw) / 2, (rotated.height - rh) / 2, rw, rh, 0, 0, Math.max(1, Math.round(rw)), Math.max(1, Math.round(rh))));
      }
    } else if (step.op === 'crop') {
      const sx = step.left * w, sy = step.top * h, sw = step.width * w, sh = step.height * h;
      next(sw, sh, c => c.drawImage(source, sx, sy, sw, sh, 0, 0, Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh))));
    } else if (step.op === 'resize') {
      const scale = step.max_side / Math.max(w, h);
      next(w * scale, h * scale, (c, n) => { c.imageSmoothingQuality = 'high'; c.drawImage(source, 0, 0, n.width, n.height); });
    } else if (step.op === 'flip') {
      next(w, h, (c, n) => { if (step.direction === 'horizontal') { c.translate(n.width, 0); c.scale(-1, 1); } else { c.translate(0, n.height); c.scale(1, -1); } c.drawImage(source, 0, 0); });
    } else if (step.op === 'adjust') {
      next(w, h, c => { c.filter = 'brightness(' + step.brightness + ') contrast(' + step.contrast + ') saturate(' + step.saturate + ') grayscale(' + step.grayscale + ') sepia(' + step.sepia + ') blur(' + step.blur + 'px) hue-rotate(' + step.hue_rotate + 'deg)'; c.drawImage(source, 0, 0); });
    }
  }
  const url = canvas.toDataURL(format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92);
  return { base64: url.slice(url.indexOf(',') + 1), width: canvas.width, height: canvas.height };
}

async function runInWindow(BrowserWindow, bytes, mime, ops, format) {
  if (bytes.length > 25_000_000) throw new Error('图片超过 25 MB');
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const timer = setTimeout(() => { if (!win.isDestroyed()) win.destroy(); }, 60000);
  try {
    await win.loadURL('about:blank');
    const dataUrl = 'data:' + mime + ';base64,' + bytes.toString('base64');
    const result = await win.webContents.executeJavaScript('(' + pageScript.toString() + ')(' + JSON.stringify({ dataUrl, ops, format }) + ')');
    return { buffer: Buffer.from(result.base64, 'base64'), width: result.width, height: result.height };
  } catch (error) {
    throw new Error('图片处理失败：' + String(error.message).replace(/^Error invoking.*?: /, '').slice(0, 200));
  } finally { clearTimeout(timer); if (!win.isDestroyed()) win.destroy(); }
}

module.exports = { normalizeOps, describeOps, runInWindow, MIME };
