// Picture and video generation through the user's own generation services. Each service is configured as
// kind "image" or "video" with the request format it speaks. Images use the widely copied OpenAI images
// endpoint. Videos are long-running jobs: submit, poll until finished, then download the file.
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const IMAGE_LIMIT = 50 * 1024 * 1024;
const VIDEO_LIMIT = 500 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

const base = endpoint => String(endpoint || '').replace(/\/+$/, '');
const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

async function request(fetchImpl, url, { apiKey, method = 'GET', body, signal, raw = false }) {
  const response = await fetchImpl(url, {
    method, signal, redirect: 'follow',
    headers: { ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    let detail = '';
    try { const text = await response.text(); detail = (() => { try { const data = JSON.parse(text); return data.error?.message || data.message || data.base_resp?.status_msg || text; } catch { return text; } })(); } catch {}
    throw fail('生成服务返回 HTTP ' + response.status + (detail ? '：' + String(detail).slice(0, 300) : ''), { httpStatus: response.status });
  }
  if (raw) return response;
  return response.json();
}

async function download(fetchImpl, url, { apiKey, signal, limit, authorize = false }) {
  const response = await request(fetchImpl, url, { apiKey: authorize ? apiKey : '', signal, raw: true });
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw fail('生成的文件超过 ' + Math.round(limit / 1048576) + ' MB，未下载');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw fail('生成的文件超过 ' + Math.round(limit / 1048576) + ' MB，未下载');
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(chunks), type: String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
}

// A local picture handed to a service as a data URL (first frame of a video).
async function dataUrl(file) {
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ['.jpg', '.jpeg'].includes(ext) ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : '';
  if (!type) throw fail('首帧图片只支持 png、jpg、webp');
  const bytes = await readFile(file);
  if (bytes.length > 10 * 1024 * 1024) throw fail('首帧图片不能超过 10 MB');
  return 'data:' + type + ';base64,' + bytes.toString('base64');
}

// ---- pictures ----
async function generateImage({ service, prompt, size, count = 1, signal, fetchImpl = fetch }) {
  const body = { model: service.settings.model, prompt, n: Math.max(1, Math.min(4, Number(count) || 1)), ...(size ? { size } : {}) };
  const data = await request(fetchImpl, base(service.settings.endpoint) + '/images/generations', { apiKey: service.apiKey, method: 'POST', body, signal });
  const items = Array.isArray(data?.data) ? data.data : [];
  if (!items.length) throw fail('生成服务没有返回图片');
  const images = [];
  for (const item of items) {
    if (typeof item?.b64_json === 'string') images.push({ bytes: Buffer.from(item.b64_json, 'base64'), ext: '.png' });
    else if (typeof item?.url === 'string' && /^https?:\/\//.test(item.url)) {
      const file = await download(fetchImpl, item.url, { signal, limit: IMAGE_LIMIT });
      const named = path.extname(new URL(item.url).pathname).toLowerCase();
      images.push({ bytes: file.bytes, ext: IMAGE_TYPES[file.type] || (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(named) ? named : '.png') });
    }
  }
  if (!images.length) throw fail('生成服务返回的图片无法读取');
  return { images, revisedPrompt: items.find(item => item?.revised_prompt)?.revised_prompt || '' };
}

// ---- videos: one adapter per request format ----
const VIDEO = {
  // OpenAI videos API: POST /videos, GET /videos/{id}, GET /videos/{id}/content.
  openai: {
    async submit({ service, prompt, duration, size, firstFrame, signal, fetchImpl }) {
      if (firstFrame) throw fail('这个服务的请求格式暂不支持首帧图片');
      const data = await request(fetchImpl, base(service.settings.endpoint) + '/videos', { apiKey: service.apiKey, method: 'POST', signal,
        body: { model: service.settings.model, prompt, ...(duration ? { seconds: String(duration) } : {}), ...(size ? { size } : {}) } });
      if (!data?.id) throw fail('生成服务没有返回任务编号');
      return data.id;
    },
    async check({ service, id, signal, fetchImpl }) {
      const data = await request(fetchImpl, base(service.settings.endpoint) + '/videos/' + encodeURIComponent(id), { apiKey: service.apiKey, signal });
      if (data.status === 'completed') return { done: true, file: { url: base(service.settings.endpoint) + '/videos/' + encodeURIComponent(id) + '/content', authorize: true } };
      if (data.status === 'failed' || data.status === 'cancelled') return { failed: data.error?.message || data.status };
      return { status: data.status, progress: data.progress };
    },
  },
  // Volcengine Ark content generation tasks (Seedance and similar).
  ark: {
    async submit({ service, prompt, duration, size, firstFrame, signal, fetchImpl }) {
      const options = [duration ? '--duration ' + duration : '', size ? '--resolution ' + size : ''].filter(Boolean).join(' ');
      const content = [{ type: 'text', text: prompt + (options ? ' ' + options : '') }, ...(firstFrame ? [{ type: 'image_url', image_url: { url: await dataUrl(firstFrame) } }] : [])];
      const data = await request(fetchImpl, base(service.settings.endpoint) + '/contents/generations/tasks', { apiKey: service.apiKey, method: 'POST', signal, body: { model: service.settings.model, content } });
      if (!data?.id) throw fail('生成服务没有返回任务编号');
      return data.id;
    },
    async check({ service, id, signal, fetchImpl }) {
      const data = await request(fetchImpl, base(service.settings.endpoint) + '/contents/generations/tasks/' + encodeURIComponent(id), { apiKey: service.apiKey, signal });
      if (data.status === 'succeeded') return data.content?.video_url ? { done: true, file: { url: data.content.video_url } } : { failed: '任务完成但没有视频地址' };
      if (['failed', 'cancelled', 'expired'].includes(data.status)) return { failed: data.error?.message || data.status };
      return { status: data.status };
    },
  },
  // SiliconFlow: POST /video/submit, POST /video/status.
  siliconflow: {
    async submit({ service, prompt, size, firstFrame, signal, fetchImpl }) {
      const data = await request(fetchImpl, base(service.settings.endpoint) + '/video/submit', { apiKey: service.apiKey, method: 'POST', signal,
        body: { model: service.settings.model, prompt, ...(size ? { image_size: size } : {}), ...(firstFrame ? { image: await dataUrl(firstFrame) } : {}) } });
      if (!data?.requestId) throw fail('生成服务没有返回任务编号');
      return data.requestId;
    },
    async check({ service, id, signal, fetchImpl }) {
      const data = await request(fetchImpl, base(service.settings.endpoint) + '/video/status', { apiKey: service.apiKey, method: 'POST', signal, body: { requestId: id } });
      if (data.status === 'Succeed') { const url = data.results?.videos?.[0]?.url; return url ? { done: true, file: { url } } : { failed: '任务完成但没有视频地址' }; }
      if (data.status === 'Failed') return { failed: data.reason || 'Failed' };
      return { status: data.status };
    },
  },
  // MiniMax: POST /video_generation, GET /query/video_generation, GET /files/retrieve.
  minimax: {
    async submit({ service, prompt, duration, size, firstFrame, signal, fetchImpl }) {
      const data = await request(fetchImpl, base(service.settings.endpoint) + '/video_generation', { apiKey: service.apiKey, method: 'POST', signal,
        body: { model: service.settings.model, prompt, ...(duration ? { duration: Number(duration) } : {}), ...(size ? { resolution: size } : {}), ...(firstFrame ? { first_frame_image: await dataUrl(firstFrame) } : {}) } });
      if (!data?.task_id) throw fail('生成服务没有返回任务编号' + (data?.base_resp?.status_msg ? '：' + data.base_resp.status_msg : ''));
      return data.task_id;
    },
    async check({ service, id, signal, fetchImpl }) {
      const root = base(service.settings.endpoint);
      const data = await request(fetchImpl, root + '/query/video_generation?task_id=' + encodeURIComponent(id), { apiKey: service.apiKey, signal });
      if (data.status === 'Success') {
        const file = await request(fetchImpl, root + '/files/retrieve?file_id=' + encodeURIComponent(data.file_id), { apiKey: service.apiKey, signal });
        return file.file?.download_url ? { done: true, file: { url: file.file.download_url } } : { failed: '任务完成但没有下载地址' };
      }
      if (data.status === 'Fail') return { failed: data.base_resp?.status_msg || 'Fail' };
      return { status: data.status };
    },
  },
};

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || fail('任务已停止')); }, { once: true });
});

async function generateVideo({ service, prompt, duration, size, firstFrame, signal, onStatus = () => {}, fetchImpl = fetch, pollMs = 5000, timeoutMs = 20 * 60_000 }) {
  const adapter = VIDEO[service.protocol] || VIDEO.openai;
  const id = await adapter.submit({ service, prompt, duration, size, firstFrame, signal, fetchImpl });
  onStatus({ id, status: 'submitted' });
  const started = Date.now();
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() - started > timeoutMs) throw fail('视频生成超过 ' + Math.round(timeoutMs / 60000) + ' 分钟仍未完成，任务编号 ' + id + '，可稍后在服务商后台查看', { taskId: id });
    await pause(pollMs, signal);
    const state = await adapter.check({ service, id, signal, fetchImpl });
    if (state.failed) throw fail('视频生成失败：' + String(state.failed).slice(0, 300), { taskId: id });
    if (state.done) {
      const file = await download(fetchImpl, state.file.url, { apiKey: service.apiKey, authorize: !!state.file.authorize, signal, limit: VIDEO_LIMIT });
      return { id, bytes: file.bytes, ext: file.type === 'video/webm' ? '.webm' : '.mp4' };
    }
    onStatus({ id, status: state.status || 'running', progress: state.progress });
  }
}

module.exports = { generateImage, generateVideo, VIDEO_PROTOCOLS: Object.keys(VIDEO) };
