const { WebContentsView, session } = require('electron');
const { previewUrl } = require('./preview-policy.cjs');
module.exports = function browserPreview(window) {
  let view, current;
  const send = value => { if (!window.isDestroyed()) window.webContents.send('preview:state', value); };
  function ensure() {
    if (view) return view;
    const isolated = session.fromPartition('memory-preview-' + process.pid);
    isolated.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', event => { event.preventDefault(); send({ error: '网页下载请使用系统浏览器；预览不会自动保存文件。' }); });
    isolated.webRequest.onBeforeRequest((details, cb) => {
      const scheme = new URL(details.url).protocol;
      cb({ cancel: !['http:', 'https:', 'data:', 'blob:'].includes(scheme) });
    });
    view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true } });
    view.webContents.setWindowOpenHandler(({ url }) => { open(url).catch(error => send({ error: error.message })); return { action: 'deny' }; });
    view.webContents.on('will-navigate', (event, url) => { try { previewUrl(url); } catch { event.preventDefault(); } });
    view.webContents.on('did-navigate', (_event, url) => send({ url, loading: false }));
    view.webContents.on('did-fail-load', (_event, code, description) => { if (code !== -3) send({ error: description, loading: false }); });
    window.contentView.addChildView(view);
    return view;
  }
  async function open(url) {
    current = previewUrl(url); const v = ensure(); v.setVisible(true); send({ url: current, loading: true });
    await v.webContents.loadURL(current);
    return { url: current };
  }
  function bounds(value) {
    if (!view) return;
    const [width, height] = window.getContentSize();
    const { x, y, w, h, visible } = value || {};
    if (![x,y,w,h].every(Number.isFinite) || x < 0 || y < 0 || w < 0 || h < 0 || x+w > width+1 || y+h > height+1) throw new Error('预览边界无效');
    view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }); view.setVisible(visible === true);
  }
  return { open, bounds, close: () => { if (view) view.setVisible(false); }, dispose: () => { if (view && !view.webContents.isDestroyed()) view.webContents.close(); } };
};
