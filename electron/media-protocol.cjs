// Pictures and videos shown in the conversation are served as memory://app/__media?path=<file>.
// Only picture and video files inside the allowed folders are served; the real path is checked, so links
// and junctions cannot reach elsewhere. Range requests pass through, so videos can seek.
const path = require('node:path');
const { realpath } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4', '.mov': 'video/quicktime' };

const inside = (root, target) => { const relative = path.relative(root, target); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };

// roots(): folders that may be shown; fetchFile(url, init): the file loader (Electron's net.fetch).
function createMediaHandler({ roots, fetchFile }) {
  return async function serveMedia(request) {
    const file = new URL(request.url).searchParams.get('path') || '';
    if (!path.isAbsolute(file) || !MEDIA_TYPES[path.extname(file).toLowerCase()]) return new Response('Not found', { status: 404 });
    const real = await realpath(file).catch(() => '');
    const type = MEDIA_TYPES[path.extname(real).toLowerCase()];
    if (!real || !type) return new Response('Not found', { status: 404 });
    const allowed = await Promise.all((roots() || []).filter(Boolean).map(root => realpath(root).catch(() => path.resolve(root))));
    if (!allowed.some(root => inside(root, real))) return new Response('Forbidden', { status: 403 });
    const response = await fetchFile(pathToFileURL(real).toString(), { headers: request.headers });
    const headers = new Headers(response.headers);
    headers.set('Content-Type', type);
    return new Response(response.body, { status: response.status, headers });
  };
}

module.exports = { createMediaHandler, MEDIA_TYPES };
