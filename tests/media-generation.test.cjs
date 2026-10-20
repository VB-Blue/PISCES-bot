const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const media = require('../electron/media-generation.cjs');
const providers = require('../electron/providers.cjs');
const router = require('../electron/router.cjs');
const memory = require('../electron/memory.cjs');
const { createTools } = require('../electron/tools.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');

async function server(handler) {
  const seen = [];
  const instance = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization || '' });
    handler(req, res, body, seen);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + instance.address().port;
  return { root, seen, close: () => { instance.closeAllConnections(); return new Promise(resolve => instance.close(resolve)); } };
}
const json = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const bytes = (res, type, value) => { res.writeHead(200, { 'content-type': type, 'content-length': value.length }); res.end(value); };
const service = (root, protocol = 'openai', kind = 'video') => ({ id: 'svc', name: 'gen', kind, protocol, apiKey: 'KEY', settings: { endpoint: root + '/v1', model: 'm' } });

test('images come back either inline or as a link, and are read as files', async () => {
  const fake = await server((req, res, body, seen) => {
    if (req.url === '/v1/images/generations') return json(res, { data: [{ b64_json: PNG.toString('base64'), revised_prompt: '一只猫' }, { url: fakeRoot + '/files/b.png' }] });
    if (req.url === '/files/b.png') return bytes(res, 'image/png', PNG);
    res.writeHead(404); res.end();
  });
  const fakeRoot = fake.root;
  try {
    const result = await media.generateImage({ service: service(fake.root, 'openai', 'image'), prompt: '猫', size: '1024x1024', count: 2 });
    assert.equal(result.images.length, 2);
    assert.ok(result.images.every(image => image.bytes.equals(PNG) && image.ext === '.png'));
    assert.equal(result.revisedPrompt, '一只猫');
    assert.deepEqual(fake.seen[0].body, { model: 'm', prompt: '猫', n: 2, size: '1024x1024' });
    assert.equal(fake.seen[0].auth, 'Bearer KEY');
    assert.equal(fake.seen[1].auth, '', 'a download link from the service is fetched without the key');
  } finally { await fake.close(); }
});

test('each video request format is submitted, polled until done, and downloaded', async () => {
  const cases = {
    openai: (req, res, state) => {
      if (req.method === 'POST' && req.url === '/v1/videos') return json(res, { id: 'v1', status: 'queued' });
      if (req.url === '/v1/videos/v1') return json(res, state.polls++ ? { id: 'v1', status: 'completed' } : { id: 'v1', status: 'in_progress', progress: 40 });
      if (req.url === '/v1/videos/v1/content') return bytes(res, 'video/mp4', MP4);
    },
    ark: (req, res, state, root) => {
      if (req.method === 'POST' && req.url === '/v1/contents/generations/tasks') return json(res, { id: 'cgt-1' });
      if (req.url === '/v1/contents/generations/tasks/cgt-1') return json(res, state.polls++ ? { status: 'succeeded', content: { video_url: root + '/out.mp4' } } : { status: 'running' });
      if (req.url === '/out.mp4') return bytes(res, 'video/mp4', MP4);
    },
    siliconflow: (req, res, state, root) => {
      if (req.url === '/v1/video/submit') return json(res, { requestId: 'r-1' });
      if (req.url === '/v1/video/status') return json(res, state.polls++ ? { status: 'Succeed', results: { videos: [{ url: root + '/out.mp4' }] } } : { status: 'InProgress' });
      if (req.url === '/out.mp4') return bytes(res, 'video/mp4', MP4);
    },
    minimax: (req, res, state, root) => {
      if (req.url === '/v1/video_generation') return json(res, { task_id: 't-1', base_resp: { status_code: 0 } });
      if (req.url.startsWith('/v1/query/video_generation?task_id=t-1')) return json(res, state.polls++ ? { status: 'Success', file_id: 'f-1' } : { status: 'Processing' });
      if (req.url.startsWith('/v1/files/retrieve?file_id=f-1')) return json(res, { file: { download_url: root + '/out.mp4' } });
      if (req.url === '/out.mp4') return bytes(res, 'video/mp4', MP4);
    },
  };
  for (const [protocol, handle] of Object.entries(cases)) {
    const state = { polls: 0 };
    let root = '';
    const fake = await server((req, res) => { if (handle(req, res, state, root) === undefined && !res.writableEnded) { res.writeHead(404); res.end(); } });
    root = fake.root;
    const statuses = [];
    try {
      const video = await media.generateVideo({ service: service(fake.root, protocol), prompt: '日出', duration: 5, size: '720p', pollMs: 5, onStatus: value => statuses.push(value.status) });
      assert.ok(video.bytes.equals(MP4), protocol);
      assert.equal(video.ext, '.mp4');
      assert.ok(statuses[0] === 'submitted' && statuses.length >= 2, protocol + ': ' + statuses.join(','));
    } finally { await fake.close(); }
  }
});

test('a failed or stalled video job ends with a clear reason and its task id', async () => {
  const fake = await server((req, res) => {
    if (req.method === 'POST') return json(res, { id: 'v9' });
    return json(res, { id: 'v9', status: req.url.includes('v9') && fake.mode === 'fail' ? 'failed' : 'in_progress', error: { message: '内容不合规' } });
  });
  try {
    fake.mode = 'fail';
    await assert.rejects(media.generateVideo({ service: service(fake.root), prompt: 'x', pollMs: 5 }), error => /视频生成失败：内容不合规/.test(error.message) && error.taskId === 'v9');
    fake.mode = 'slow';
    await assert.rejects(media.generateVideo({ service: service(fake.root), prompt: 'x', pollMs: 5, timeoutMs: 40 }), /仍未完成，任务编号 v9/);
    const stop = new AbortController(); setTimeout(() => stop.abort(), 30);
    await assert.rejects(media.generateVideo({ service: service(fake.root), prompt: 'x', pollMs: 5, signal: stop.signal }));
  } finally { await fake.close(); }
});

test('generation services are a kind of their own: never the default, never in conversation routing', () => {
  const deps = { encrypt: value => value, validateEndpoint: value => value };
  const store = providers.buildStore({ profiles: [
    { id: 'gen-image-1', name: '画图', endpoint: 'https://a/v1', model: 'gpt-image-1', kind: 'image' },
    { id: 'gen-video-1', name: '视频', endpoint: 'https://b/v1', model: 'sora-2', kind: 'video', protocol: 'minimax' },
    { id: 'chat-main-1', name: '对话', endpoint: 'https://c/v1', model: 'deepseek-chat' },
  ], defaultId: 'gen-image-1', routes: { writer: 'gen-video-1' } }, providers.emptyStore(), deps);
  assert.equal(store.defaultId, 'chat-main-1');
  assert.deepEqual(store.routes, {});
  assert.equal(store.profiles[1].protocol, 'minimax');
  assert.equal(providers.buildStore({ profiles: [{ id: 'img-only-1', name: 'x', endpoint: 'https://a/v1', model: 'm', kind: 'image', protocol: 'ark' }] }, providers.emptyStore(), deps).profiles[0].protocol, 'openai', 'images speak only the OpenAI format');
  const resolved = { ...store, profiles: store.profiles.map(item => providers.resolveProfile(item, value => value)) };
  const plan = router.plan(resolved, { profile: '画图' });
  assert.equal(plan.primary.id, 'chat-main-1', 'a generation service cannot be picked to answer');
  assert.deepEqual(plan.fallbacks, []);
});

test('the tools generate into the pictures and videos folders after asking, and report the files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pisces-media-'));
  await memory.init(path.join(dir, 'memory'));
  let fake;
  fake = await server((req, res) => {
    if (req.url === '/v1/images/generations') return json(res, { data: [{ b64_json: PNG.toString('base64') }] });
    if (req.method === 'POST' && req.url === '/v1/videos') return json(res, { id: 'v1' });
    if (req.url === '/v1/videos/v1') return json(res, { status: 'completed' });
    if (req.url === '/v1/videos/v1/content') return bytes(res, 'video/mp4', MP4);
    res.writeHead(404); res.end();
  });
  const services = [service(fake.root, 'openai', 'image'), { ...service(fake.root, 'openai', 'video'), id: 'svc2', name: 'video' }];
  const asked = [], steps = [];
  const tools = createTools({ memory, userDataDir: path.join(dir, 'userdata'), getPrefs: () => ({}), host: { path: name => path.join(dir, name), openExternal: async () => {}, generationServices: () => services } });
  const ctx = { ask: async request => { asked.push(request.title); return 'once'; }, signal: new AbortController().signal, session: 's', turn: 't', progress: step => steps.push(step.label) };
  try {
    const image = await tools.execute('generate_image', { prompt: '海边的灯塔', size: '1024x1024' }, ctx);
    assert.equal(image.files.length, 1);
    assert.ok(image.files[0].startsWith(path.join(dir, 'pictures', 'PISCES AI')));
    assert.ok((await fs.readFile(image.files[0])).equals(PNG));
    const video = await tools.execute('generate_video', { prompt: '灯塔的日出', duration: 5 }, ctx);
    assert.ok(video.files[0].startsWith(path.join(dir, 'videos', 'PISCES AI')) && video.files[0].endsWith('.mp4'));
    assert.deepEqual(asked, ['用图片生成服务生成图片', '用视频生成服务生成视频']);
    await assert.rejects(tools.execute('generate_image', { prompt: '猫', service: '不存在' }, ctx), /没有名为「不存在」的图片生成服务/);
    const none = createTools({ memory, userDataDir: path.join(dir, 'userdata'), getPrefs: () => ({}), host: { path: name => path.join(dir, name), openExternal: async () => {}, generationServices: () => [] } });
    await assert.rejects(none.execute('generate_video', { prompt: '猫' }, ctx), /还没有配置视频生成服务/);
  } finally { await fake.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
