// Provider registry: several AI services ("profiles") instead of a single endpoint/model pair.
// Pure functions (encryption is injected) so the logic is testable without Electron.
const { randomUUID } = require('node:crypto');

const STRENGTHS = ['strong', 'fast', 'cheap', 'vision', 'code', 'long'];
// Agent roles that can be pinned to a particular profile.
const ROLES = ['researcher', 'coder', 'operator', 'writer', 'reviewer', 'planner', 'verifier', 'learner'];
const MAX_PROFILES = 20;
// What a service does: answers and runs tasks (chat), or generates pictures or videos for the generation tools.
const KINDS = ['chat', 'image', 'video'];
// Request formats the generation tools speak. Images use the widely copied OpenAI images endpoint.
const PROTOCOLS = { chat: ['openai'], image: ['openai'], video: ['openai', 'ark', 'siliconflow', 'minimax'] };
const kindOf = profile => KINDS.includes(profile?.kind) ? profile.kind : 'chat';
const isChat = profile => kindOf(profile) === 'chat';

const emptyStore = () => ({ profiles: [], defaultId: '', routes: {}, failover: true });

// Build the store from persisted JSON, or from the legacy single endpoint/model/key.
function migrate(raw, legacy) {
  if (raw && Array.isArray(raw.profiles)) {
    const store = { ...emptyStore(), ...raw, profiles: raw.profiles.filter(item => item && item.id && item.endpoint && item.model) };
    if (!store.profiles.some(item => item.id === store.defaultId && isChat(item))) store.defaultId = store.profiles.find(isChat)?.id || '';
    store.routes = cleanRoutes(store.routes, store.profiles);
    return store;
  }
  const store = emptyStore();
  if (legacy && legacy.endpoint && legacy.model) {
    const profile = { id: randomUUID(), name: '默认', endpoint: legacy.endpoint, model: legacy.model, apiKeyEncrypted: legacy.apiKeyEncrypted || '', strengths: [], note: '', maxConcurrent: 2, noFailover: false };
    store.profiles.push(profile);
    store.defaultId = profile.id;
  }
  return store;
}

function cleanRoutes(routes, profiles) {
  const out = {};
  for (const role of ROLES) if (routes && typeof routes[role] === 'string' && profiles.some(item => item.id === routes[role] && isChat(item))) out[role] = routes[role];
  return out;
}

// Validate user input into a stored profile. `existing` supplies the encrypted key when the form leaves the key blank.
function buildProfile(input, existing, { encrypt, validateEndpoint }) {
  if (!input || typeof input !== 'object') throw new Error('服务配置格式无效');
  const name = String(input.name || '').trim().slice(0, 40);
  if (!name) throw new Error('每个 AI 服务都需要一个名称');
  const endpoint = validateEndpoint(input.endpoint);
  const model = String(input.model || '').trim().slice(0, 200);
  if (!model) throw new Error('「' + name + '」还需要填写模型名称');
  const apiKeyEncrypted = input.clearApiKey ? '' : (input.apiKey ? encrypt(String(input.apiKey)) : (existing?.apiKeyEncrypted || ''));
  const strengths = (Array.isArray(input.strengths) ? input.strengths : []).filter(item => STRENGTHS.includes(item)).filter((item, index, all) => all.indexOf(item) === index);
  const maxConcurrent = Number.isInteger(input.maxConcurrent) ? Math.max(1, Math.min(8, input.maxConcurrent)) : 2;
  const kind = kindOf(input);
  const protocol = PROTOCOLS[kind].includes(input.protocol) ? input.protocol : PROTOCOLS[kind][0];
  return { kind, protocol, id: existing?.id || (typeof input.id === 'string' && /^[\w-]{6,64}$/.test(input.id) ? input.id : randomUUID()), name, endpoint, model, apiKeyEncrypted, strengths, note: String(input.note || '').trim().slice(0, 200), maxConcurrent, noFailover: input.noFailover === true };
}

function buildStore(input, previous, deps) {
  if (!input || !Array.isArray(input.profiles)) throw new Error('服务列表格式无效');
  if (input.profiles.length > MAX_PROFILES) throw new Error('最多保存 ' + MAX_PROFILES + ' 个 AI 服务');
  const profiles = input.profiles.map(item => buildProfile(item, previous.profiles.find(old => old.id === item?.id), deps));
  const names = new Set();
  for (const profile of profiles) {
    const key = profile.name.toLowerCase();
    if (names.has(key)) throw new Error('服务名称重复：' + profile.name + '（子代理按名称选择服务）');
    names.add(key);
  }
  // The default answers conversations, so it is always a chat service.
  const defaultId = profiles.some(item => item.id === input.defaultId && isChat(item)) ? input.defaultId : (profiles.find(isChat)?.id || '');
  // The form refers to profiles by the id it was given; new rows get fresh ids, so map form ids onto the final ones.
  const idOf = formId => profiles[input.profiles.findIndex(item => item?.id === formId)]?.id;
  const routes = {};
  for (const role of ROLES) { const target = idOf(input.routes?.[role]); if (target && isChat(profiles.find(item => item.id === target))) routes[role] = target; }
  const mapped = idOf(input.defaultId);
  const fixedDefault = mapped && isChat(profiles.find(item => item.id === mapped)) ? mapped : defaultId;
  return { profiles, defaultId: fixedDefault, routes, failover: input.failover !== false };
}

const publicProfile = profile => ({ kind: kindOf(profile), protocol: profile.protocol || 'openai', id: profile.id, name: profile.name, endpoint: profile.endpoint, model: profile.model, hasApiKey: !!profile.apiKeyEncrypted, strengths: profile.strengths || [], note: profile.note || '', maxConcurrent: profile.maxConcurrent || 2, noFailover: !!profile.noFailover });
const publicView = store => ({ profiles: store.profiles.map(publicProfile), defaultId: store.defaultId, routes: store.routes, failover: store.failover });

// A profile ready to call: decrypted key, plain settings. Never leaves the main process.
const resolveProfile = (profile, decrypt) => profile && ({ kind: kindOf(profile), protocol: profile.protocol || 'openai', id: profile.id, name: profile.name, settings: { endpoint: profile.endpoint, model: profile.model, providerId: profile.id, maxConcurrent: profile.maxConcurrent || 2 }, apiKey: decrypt(profile.apiKeyEncrypted), strengths: profile.strengths || [], note: profile.note || '', maxConcurrent: profile.maxConcurrent || 2, noFailover: !!profile.noFailover });

module.exports = { STRENGTHS, ROLES, KINDS, PROTOCOLS, kindOf, isChat, MAX_PROFILES, emptyStore, migrate, buildStore, buildProfile, publicView, publicProfile, resolveProfile };
