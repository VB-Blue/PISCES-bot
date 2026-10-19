// User-inspectable memory: facts and preferences about the user, reusable playbooks learned from
// successful work, and a searchable log of past turns. When linked, the core (D:\记忆体) owns all of it:
// every change goes to the core as an ordered operation, and the core assembles the memory context.
// The files in the profile directory are then a read cache plus an outbox of changes the core has not
// accepted yet, so memory keeps working while the core starts or is offline.
const { readFile, writeFile, mkdir, rename, appendFile, readdir, unlink } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequirementStore, isWritingRequirement, explicitWritingRules } = require('./requirements.cjs');

const KINDS = ['preference', 'fact', 'habit', 'goal', 'lesson'];
const LIMITS = { memories: 400, playbooks: 80, skills: 200, history: 3000, text: 400, steps: 12 };
let dir = '';
let state = { memories: [], playbooks: [], skills: [] };
let history = [];
let saveTimer = null;
let requirements = null;
// The living user profile: one readable document about who the user is, injected into every turn.
let profile = '';
const PROFILE_LIMIT = 4000;

// ---- link to the core ----
let core = null; // { request(route, body, { timeoutMs }) }
let link = { migrated: false };
let outbox = [];
let outboxWrites = Promise.resolve();
let syncing = null;
let syncSoon = null;
let syncTimer = null;
let batchLimit = 200;
let coreState = { online: false, revision: -1, error: '', at: '' };
const BATCH_BYTES = 1_000_000;
const SYNC_EVERY_MS = 30_000;

function tokens(text) {
  const out = new Set();
  const lower = String(text || '').toLowerCase();
  for (const word of lower.match(/[a-z0-9_]{2,}/g) || []) out.add(word);
  for (const run of lower.match(/[一-鿿]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let index = 0; index < run.length - 1; index++) out.add(run.slice(index, index + 2));
  }
  return out;
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared;
}
const similarity = (a, b) => { const x = tokens(a), y = tokens(b); const shared = overlap(x, y); return shared / Math.max(1, Math.min(x.size, y.size)); };

async function init(directory, { core: coreLink = null } = {}) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  clearTimeout(syncSoon); clearInterval(syncTimer); syncSoon = null; syncTimer = null;
  dir = directory;
  core = coreLink && typeof coreLink.request === 'function' ? coreLink : null;
  outbox = []; link = { migrated: false }; batchLimit = 200;
  coreState = { online: false, revision: -1, error: '', at: '' };
  await mkdir(dir, { recursive: true });
  try {
    const value = JSON.parse(await readFile(path.join(dir, 'memory.json'), 'utf8'));
    state = { memories: Array.isArray(value.memories) ? value.memories : [], playbooks: Array.isArray(value.playbooks) ? value.playbooks : [], skills: Array.isArray(value.skills) ? value.skills : [] };
  } catch (error) { if (error.code !== 'ENOENT') console.warn('记忆文件未读取，使用空记忆'); state = { memories: [], playbooks: [], skills: [] }; }
  try {
    history = (await readFile(path.join(dir, 'history.jsonl'), 'utf8')).split('\n').filter(Boolean).slice(-LIMITS.history).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { history = []; }
  try { profile = (await readFile(path.join(dir, 'profile.md'), 'utf8')).trim(); } catch { profile = ''; }
  if (core) {
    try { link = { migrated: false, ...JSON.parse(await readFile(path.join(dir, 'core-link.json'), 'utf8')) }; } catch {}
    try { outbox = (await readFile(outboxFile(), 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(entry => entry?.id && entry.op); } catch {}
  }
  requirements = openRequirements();
  if (requirements.status().available) {
    const imported = new Set(requirements.list().map(item => item.legacyMemoryId).filter(Boolean));
    for (const item of state.memories) if (!imported.has(item.id) && isWritingRequirement(item.text)) requirements.save([{ text: item.text, domain: 'writing' }], { source: item.source, session: item.session, legacyMemoryId: item.id });
  }
  if (core) {
    syncTimer = setInterval(() => { void sync(); }, SYNC_EVERY_MS);
    syncTimer.unref?.();
    // Give the host a moment to load its connection settings before the first contact.
    scheduleSync(1500);
  }
}
// Long-term requirements stay checked against the local file; each committed revision is also kept by the core.
const openRequirements = () => createRequirementStore(dir, { onCommit: stored => emit({ op: 'requirements_put', state: stored }) });

const outboxFile = () => path.join(dir, 'core-outbox.jsonl');
function emit(op) {
  if (!core || !dir) return;
  // Snapshot now: later edits to the same item are their own operations.
  const entry = { id: randomUUID(), ...structuredClone(op) };
  outbox.push(entry);
  outboxWrites = outboxWrites.then(() => appendFile(outboxFile(), JSON.stringify(entry) + '\n', 'utf8')).catch(error => console.error('保存待同步记忆失败:', error.message));
  scheduleSync();
}
function scheduleSync(delay = 200) {
  if (!core) return;
  clearTimeout(syncSoon);
  syncSoon = setTimeout(() => { syncSoon = null; void sync(); }, delay);
  syncSoon.unref?.();
}
// The outbox file is rewritten from the in-memory queue when the write runs, after any append queued before it.
function rewriteOutbox() {
  outboxWrites = outboxWrites.then(async () => {
    const target = outboxFile();
    await writeFile(target + '.tmp', outbox.map(entry => JSON.stringify(entry) + '\n').join(''), 'utf8');
    await rename(target + '.tmp', target);
  }).catch(error => console.error('更新待同步记忆失败:', error.message));
  return outboxWrites;
}
function nextBatch() {
  const batch = [];
  let bytes = 0;
  for (const entry of outbox) {
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (batch.length && (batch.length >= batchLimit || bytes + size > BATCH_BYTES)) break;
    batch.push(entry); bytes += size;
  }
  return batch;
}
const rejectedByCore = message => /HTTP 409/.test(message) && /invalid|empty|exceeds|needs|must|too large|is full|no profile change|no user text/.test(message);
async function pushOutbox() {
  while (outbox.length) {
    const batch = nextBatch();
    let result;
    try { result = await core.request('/api/v1/memory/apply', { ops: batch }, { timeoutMs: 20000 }); }
    catch (error) {
      if (!rejectedByCore(String(error.message))) throw error;
      // Find the rejected change one at a time; set it aside with the reason rather than block everything behind it.
      if (batch.length > 1) { batchLimit = 1; continue; }
      outbox.shift();
      await appendFile(path.join(dir, 'core-rejected.jsonl'), JSON.stringify({ ts: new Date().toISOString(), error: String(error.message).slice(0, 500), entry: batch[0] }) + '\n', 'utf8').catch(() => {});
      await rewriteOutbox();
      continue;
    }
    outbox.splice(0, batch.length);
    batchLimit = 200;
    coreState.revision = result.revision;
    await rewriteOutbox();
  }
}

// First contact: hand the core everything it does not already hold, ahead of any queued change.
async function linkFirstTime() {
  const view = await core.request('/api/v1/memory/state');
  const known = key => new Set((Array.isArray(view[key]) ? view[key] : []).map(item => item.id));
  const ops = [];
  for (const [key, op] of [['memories', 'memory_put'], ['playbooks', 'playbook_put'], ['skills', 'skill_put']]) {
    const present = known(key);
    // Oldest first, so the core ends up with the newest entry in front, as here.
    for (const item of [...state[key]].reverse()) if (!present.has(item.id)) ops.push({ op, item });
  }
  if (profile && !view.profile) ops.push({ op: 'profile_set', text: profile, source: 'import', note: '从助手本地记忆迁入核心' });
  if (!view.stats?.turns) for (const entry of history) if (entry?.user) ops.push({ op: 'turn', entry });
  if (!view.revision) {
    let files = [];
    try { files = (await readdir(path.join(dir, 'trajectories'))).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort(); } catch {}
    for (const name of files) {
      const lines = (await readFile(path.join(dir, 'trajectories', name), 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) { try { const entry = JSON.parse(line); if (entry && typeof entry === 'object' && !Array.isArray(entry)) ops.push({ op: 'trajectory', entry }); } catch {} }
    }
  }
  if (!view.has_requirements && requirements?.status().available && requirements.status().revision > 0) {
    try { ops.push({ op: 'requirements_put', state: JSON.parse(await readFile(path.join(dir, 'requirements.json'), 'utf8')) }); } catch {}
  }
  outbox.unshift(...ops.map(op => ({ id: randomUUID(), ...op })));
  await rewriteOutbox();
  link = { migrated: true, at: new Date().toISOString(), imported: ops.length };
  await writeFile(path.join(dir, 'core-link.json'), JSON.stringify(link, null, 2), 'utf8');
}

// Take the core's state as the local view. Only done with nothing queued, so no local change is overwritten.
async function adopt(view) {
  const list = value => Array.isArray(value) ? value : [];
  state = { memories: list(view.memories), playbooks: list(view.playbooks), skills: list(view.skills) };
  coreState.revision = view.revision;
  scheduleSave();
  if (typeof view.profile === 'string' && view.profile !== profile) {
    profile = view.profile;
    const target = path.join(dir, 'profile.md');
    await writeFile(target + '.tmp', profile + '\n', 'utf8');
    await rename(target + '.tmp', target);
  }
  // A lost local requirements file is restored from the core's copy, but only if it verifies.
  if (view.has_requirements && requirements?.status().available && requirements.status().revision === 0) {
    const { requirements: stored } = await core.request('/api/v1/memory/requirements');
    if (stored?.rules?.length) {
      const file = path.join(dir, 'requirements.json');
      await writeFile(file, JSON.stringify(stored, null, 2), 'utf8');
      const restored = openRequirements();
      if (restored.status().available) requirements = restored;
      else { await rename(file, file + '.rejected'); }
    }
  }
}

function sync() {
  if (!core) return Promise.resolve(linkStatus());
  if (!syncing) syncing = (async () => {
    try {
      if (!link.migrated) await linkFirstTime();
      await pushOutbox();
      const view = await core.request('/api/v1/memory/state');
      if (!outbox.length && view.revision !== coreState.revision) await adopt(view);
      coreState = { ...coreState, online: true, error: '', at: new Date().toISOString() };
    } catch (error) {
      coreState = { ...coreState, online: false, error: String(error?.message || error).slice(0, 300), at: new Date().toISOString() };
    } finally { syncing = null; }
    return linkStatus();
  })();
  return syncing;
}
const linkStatus = () => ({ linked: !!core, online: coreState.online, revision: coreState.revision, pending: outbox.length, migrated: !!link.migrated, error: coreState.error, at: coreState.at });
// Push queued changes before reading through the core, so what was just learned is part of the answer.
async function throughCore(route, body, timeoutMs) {
  if (!core) return null;
  try {
    if (syncing) await syncing;
    if (!link.migrated || outbox.length || !coreState.online) await sync();
    if (!coreState.online || outbox.length) return null;
    return await core.request(route, body, { timeoutMs });
  } catch (error) {
    coreState = { ...coreState, online: false, error: String(error?.message || error).slice(0, 300), at: new Date().toISOString() };
    return null;
  }
}

function scheduleSave() {
  if (!dir) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, 300);
}
async function flush() {
  if (!dir) return;
  await outboxWrites;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const target = path.join(dir, 'memory.json');
  try {
    await writeFile(target + '.tmp', JSON.stringify(state, null, 2), 'utf8');
    await rename(target + '.tmp', target);
  } catch (error) { console.error('保存记忆失败:', error.message); }
}

const clean = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.text);

function addMemory({ kind = 'fact', text, pinned = false, source = 'user', session = '' }) {
  const value = clean(text);
  if (value.length < 2) throw new Error('记忆内容太短');
  const type = KINDS.includes(kind) ? kind : 'fact';
  const durableWriting = isWritingRequirement(String(text).replace(/^用户纠正（针对「.*?」）：/, ''));
  const existing = state.memories.find(item => item.text === value || !durableWriting && similarity(item.text, value) >= 0.85);
  if (existing) {
    if (durableWriting) requirements?.save([{ text: String(text), domain: 'writing' }], { source, session, legacyMemoryId: existing.id });
    existing.updatedAt = new Date().toISOString();
    if (pinned) existing.pinned = true;
    scheduleSave();
    emit({ op: 'memory_put', item: existing });
    return { memory: existing, duplicate: true };
  }
  const memory = { id: randomUUID(), kind: type, text: value, pinned: !!pinned, source, session: String(session || ''), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hits: 0 };
  if (durableWriting) requirements?.save([{ text: String(text), domain: 'writing' }], { source, session, legacyMemoryId: memory.id });
  state.memories.unshift(memory);
  // Keep the oldest unpinned, never-used memories out first when the store grows.
  while (state.memories.length > LIMITS.memories) {
    const index = state.memories.map((item, i) => ({ item, i })).reverse().find(entry => !entry.item.pinned && entry.item.hits === 0)?.i ?? state.memories.length - 1;
    const [evicted] = state.memories.splice(index, 1);
    emit({ op: 'memory_delete', id: evicted.id });
  }
  scheduleSave();
  emit({ op: 'memory_put', item: memory });
  return { memory, duplicate: false };
}
function updateMemory(id, patch) {
  const memory = state.memories.find(item => item.id === id);
  if (!memory) throw new Error('记忆不存在');
  if (patch.text !== undefined) { const value = clean(patch.text); if (value.length < 2) throw new Error('记忆内容太短');
    const linked = requirements?.list().find(item => item.legacyMemoryId === id);
    if (linked || isWritingRequirement(patch.text)) requirements?.save([{ ...(linked ? { id: linked.id, revision: linked.revision } : {}), text: String(patch.text), domain: 'writing', ...(linked ? { enabled: linked.enabled, scope: linked.scope, check: linked.check } : {}) }], { source: 'user', legacyMemoryId: id });
    memory.text = value; }
  if (patch.kind && KINDS.includes(patch.kind)) memory.kind = patch.kind;
  if (patch.pinned !== undefined) memory.pinned = !!patch.pinned;
  memory.updatedAt = new Date().toISOString();
  scheduleSave();
  emit({ op: 'memory_put', item: memory });
  return memory;
}
function deleteMemory(id) {
  const linked = requirements?.list().find(item => item.legacyMemoryId === id && item.enabled);
  if (linked) requirements.save([{ ...linked, enabled: false }], { source: 'user' });
  const before = state.memories.length;
  state.memories = state.memories.filter(item => item.id !== id);
  scheduleSave();
  emit({ op: 'memory_delete', id });
  return state.memories.length < before;
}

function normalizeSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map(step => clean(step)).filter(Boolean).slice(0, LIMITS.steps);
}
function addPlaybook({ title, trigger = '', steps, source = 'ai' }) {
  const name = clean(title).slice(0, 80);
  const list = normalizeSteps(steps);
  if (name.length < 2 || !list.length) throw new Error('经验需要标题和至少一个步骤');
  const existing = state.playbooks.find(item => item.title === name || similarity(item.title + item.trigger, name + trigger) >= 0.8);
  if (existing) {
    existing.steps = list; existing.trigger = clean(trigger) || existing.trigger; existing.updatedAt = new Date().toISOString();
    scheduleSave();
    emit({ op: 'playbook_put', item: existing });
    return { playbook: existing, duplicate: true };
  }
  const playbook = { id: randomUUID(), title: name, trigger: clean(trigger), steps: list, source, score: 0, uses: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.playbooks.unshift(playbook);
  for (const evicted of state.playbooks.slice(LIMITS.playbooks)) emit({ op: 'playbook_delete', id: evicted.id });
  state.playbooks = state.playbooks.slice(0, LIMITS.playbooks);
  scheduleSave();
  emit({ op: 'playbook_put', item: playbook });
  return { playbook, duplicate: false };
}
function updatePlaybook(id, patch) {
  const playbook = state.playbooks.find(item => item.id === id);
  if (!playbook) throw new Error('经验不存在');
  if (patch.title !== undefined) playbook.title = clean(patch.title).slice(0, 80) || playbook.title;
  if (patch.trigger !== undefined) playbook.trigger = clean(patch.trigger);
  if (patch.steps !== undefined) { const steps = normalizeSteps(patch.steps); if (steps.length) playbook.steps = steps; }
  playbook.updatedAt = new Date().toISOString();
  scheduleSave();
  emit({ op: 'playbook_put', item: playbook });
  return playbook;
}
function deletePlaybook(id) {
  const before = state.playbooks.length;
  state.playbooks = state.playbooks.filter(item => item.id !== id);
  scheduleSave();
  emit({ op: 'playbook_delete', id });
  return state.playbooks.length < before;
}

function getProfile() { return profile; }
// Every change keeps the previous text in profile-history.jsonl, so any update (by the user or the learner) can be undone.
async function setProfile(text, { source = 'user', note = '' } = {}) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, PROFILE_LIMIT);
  if (value === profile) return { profile, changed: false };
  const previous = profile;
  profile = value;
  if (dir) {
    const target = path.join(dir, 'profile.md');
    await writeFile(target + '.tmp', value + '\n', 'utf8');
    await rename(target + '.tmp', target);
    await appendFile(path.join(dir, 'profile-history.jsonl'), JSON.stringify({ ts: new Date().toISOString(), source, note: String(note).slice(0, 500), previous }) + '\n', 'utf8');
  }
  emit({ op: 'profile_set', text: value, source, note: String(note).slice(0, 500) });
  return { profile, changed: true, previous };
}
async function undoProfile() {
  if (!dir) throw new Error('记忆目录未初始化');
  const file = path.join(dir, 'profile-history.jsonl');
  let lines = [];
  try { lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean); } catch {}
  const last = lines.pop();
  if (!last) throw new Error('没有可以撤销的画像修改');
  const { previous = '' } = JSON.parse(last);
  profile = String(previous);
  const target = path.join(dir, 'profile.md');
  await writeFile(target + '.tmp', profile + '\n', 'utf8');
  await rename(target + '.tmp', target);
  await writeFile(file, lines.map(line => line + '\n').join(''), 'utf8');
  emit({ op: 'profile_undo' });
  return { profile };
}

// Full record of each piece of work (request, context, every tool call and result, answer, later feedback).
// This is the raw experience the local brain will learn from; it stays on this machine.
async function recordTrajectory(entry) {
  if (!dir) return;
  if (core) { emit({ op: 'trajectory', entry: { ts: new Date().toISOString(), ...entry } }); return; }
  const month = new Date().toISOString().slice(0, 7);
  try {
    await mkdir(path.join(dir, 'trajectories'), { recursive: true });
    await appendFile(path.join(dir, 'trajectories', month + '.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (error) { console.error('保存经验轨迹失败:', error.message); }
}

async function recordTurn({ session, user, assistant }) {
  if (!dir || !user) return;
  const entry = { ts: new Date().toISOString(), session: String(session || ''), user: String(user).slice(0, 2000), assistant: String(assistant || '').slice(0, 2000) };
  history.push(entry);
  if (history.length > LIMITS.history) history = history.slice(-LIMITS.history);
  emit({ op: 'turn', entry });
  try { await appendFile(path.join(dir, 'history.jsonl'), JSON.stringify(entry) + '\n', 'utf8'); } catch (error) { console.error('保存对话索引失败:', error.message); }
}

function searchHistory(query, k = 5, excludeSession = '') {
  const wanted = tokens(query);
  if (!wanted.size) return [];
  return history
    .map(entry => ({ entry, score: overlap(wanted, tokens(entry.user + ' ' + entry.assistant)) / Math.sqrt(wanted.size) }))
    .filter(item => item.score >= 1.2 && item.entry.session !== excludeSession)
    .sort((a, b) => b.score - a.score || (a.entry.ts < b.entry.ts ? 1 : -1))
    .slice(0, k).map(item => item.entry);
}

function rank(items, query, text) {
  const wanted = tokens(query);
  return items.map(item => {
    const shared = overlap(wanted, tokens(text(item)));
    const score = shared / Math.sqrt(Math.max(1, wanted.size)) + (item.pinned ? 0.6 : 0) + Math.min(0.4, (item.hits || item.uses || 0) * 0.04) + (item.score || 0) * 0.1;
    return { item, shared, score };
  });
}

function search(query, { k = 6 } = {}) {
  const memories = rank(state.memories, query, item => item.text).filter(entry => entry.shared >= 1).sort((a, b) => b.score - a.score).slice(0, k).map(entry => entry.item);
  const playbooks = rank(state.playbooks, query, item => item.title + ' ' + item.trigger + ' ' + item.steps.join(' ')).filter(entry => entry.shared >= Math.min(2, tokens(query).size) && entry.shared >= 1 && entry.item.score > -2).sort((a, b) => b.score - a.score).slice(0, 3).map(entry => entry.item);
  const skills = rank(state.skills.filter(usableSkill), query, item => item.title + ' ' + item.trigger + ' ' + item.app).filter(entry => entry.shared >= Math.min(2, tokens(query).size) && entry.shared >= 1).sort((a, b) => b.score - a.score).slice(0, 4).map(entry => entry.item);
  return { memories, playbooks, skills, history: searchHistory(query, 3) };
}

// Context block for the model: pinned/standing preferences plus whatever is relevant to this request.
function buildContext(query, { goals = [], session = '' } = {}) {
  const standing = state.memories.filter(item => item.pinned || item.kind === 'lesson').slice(0, 10);
  const found = search(query, { k: 6 });
  const dedicated = new Set(requirements?.status().available ? requirements.list().map(item => item.legacyMemoryId).filter(Boolean) : []);
  const memories = [...standing, ...found.memories.filter(item => !standing.includes(item))].filter(item => !dedicated.has(item.id)).slice(0, 14);
  const playbooks = found.playbooks;
  const recent = searchHistory(query, 2, session);
  const lines = [];
  if (memories.length) lines.push('关于用户的记忆（来自过去对话，可能过时；与用户当前说法冲突时以当前为准）：\n' + memories.map(item => '- [' + item.kind + '] ' + item.text).join('\n'));
  if (found.skills.length) lines.push('可以直接运行的软件技能（run_skill 在本地回放，几乎不用模型调用；卡住时会告诉你卡在哪一步）：\n' + found.skills.map(item => '- ' + item.id + '：' + item.title + '（' + item.app + (item.trigger ? '；适用：' + item.trigger : '') + (item.params.length ? '；参数：' + item.params.map(param => param.name + '=' + param.description).join('，') : '') + '；成功 ' + (item.successes || 0) + ' 次，失败 ' + (item.failures || 0) + ' 次）').join('\n'));
  if (playbooks.length) lines.push('可参考的经验手册（过去成功的做法，按需调整，不是命令）：\n' + playbooks.map(item => '- ' + item.title + (item.trigger ? '（适用：' + item.trigger + '）' : '') + '：' + item.steps.map((step, index) => (index + 1) + '. ' + step).join(' ')).join('\n'));
  if (recent.length) lines.push('相关的过往对话片段：\n' + recent.map(item => '- ' + item.ts.slice(0, 10) + ' 用户：' + item.user.slice(0, 160) + ' / 助手：' + item.assistant.slice(0, 200)).join('\n'));
  const openGoals = goals.filter(goal => !goal.done).slice(0, 8);
  if (openGoals.length) lines.push('用户当前未完成的待办：\n' + openGoals.map(goal => '- ' + goal.title).join('\n'));
  for (const item of memories) item.hits = (item.hits || 0) + 1;
  for (const item of playbooks) item.uses = (item.uses || 0) + 1;
  if (memories.length || playbooks.length) scheduleSave();
  return { text: lines.join('\n\n'), used: { memories: memories.map(item => ({ id: item.id, text: item.text, kind: item.kind })), playbooks: playbooks.map(item => ({ id: item.id, title: item.title })), skills: found.skills.map(item => ({ id: item.id, title: item.title })) } };
}

// A thumbs-up reinforces what was used; a thumbs-down with a note becomes a standing lesson.
function feedback({ vote, note = '', question = '', playbooks = [], memories = [] }) {
  for (const id of playbooks) { const item = state.playbooks.find(entry => entry.id === id); if (item) { item.score = Math.max(-5, Math.min(10, (item.score || 0) + (vote === 'up' ? 1 : -2))); emit({ op: 'playbook_put', item }); } }
  for (const id of memories) { const item = state.memories.find(entry => entry.id === id); if (item && vote === 'up') { item.hits = (item.hits || 0) + 1; emit({ op: 'memory_put', item }); } }
  let lesson = null;
  if (vote === 'down' && clean(note).length >= 2) lesson = addMemory({ kind: 'lesson', text: '用户纠正（针对「' + clean(question).slice(0, 40) + '」）：' + clean(note), pinned: true, source: 'feedback' }).memory;
  scheduleSave();
  return { lesson };
}

const listMemories = () => state.memories.slice();
const listPlaybooks = () => state.playbooks.slice();

// Software skills: verified, parameterised UI procedures recorded from successful work and replayed locally
// without the model. Their track record decides whether they are offered again.
function addSkill({ title, trigger = '', app = '', params = [], steps, source = 'ai' }) {
  const name = clean(title).slice(0, 80);
  if (name.length < 2 || !Array.isArray(steps) || !steps.length) throw new Error('技能需要标题和步骤');
  const cleanParams = (Array.isArray(params) ? params : []).slice(0, 8).map(item => ({ name: String(item?.name || '').replace(/[^\w]/g, '').slice(0, 30), description: clean(item?.description).slice(0, 120), example: String(item?.example ?? '').slice(0, 200) })).filter(item => item.name);
  const existing = state.skills.find(item => item.title === name && item.app === app);
  const skill = { id: existing?.id || randomUUID(), title: name, trigger: clean(trigger), app: String(app || '').slice(0, 60), params: cleanParams, steps: steps.slice(0, 60), source, uses: existing?.uses || 0, successes: existing?.successes || 0, failures: 0, lastError: '', createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (existing) state.skills[state.skills.indexOf(existing)] = skill; else state.skills.unshift(skill);
  for (const evicted of state.skills.slice(LIMITS.skills)) emit({ op: 'skill_delete', id: evicted.id });
  state.skills = state.skills.slice(0, LIMITS.skills);
  scheduleSave();
  emit({ op: 'skill_put', item: skill });
  return { skill, replaced: !!existing };
}
const listSkills = () => state.skills.slice();
const getSkill = id => state.skills.find(item => item.id === id) || null;
function deleteSkill(id) {
  const before = state.skills.length;
  state.skills = state.skills.filter(item => item.id !== id);
  scheduleSave();
  emit({ op: 'skill_delete', id });
  return state.skills.length < before;
}
function recordSkillRun(id, ok, error = '') {
  const skill = getSkill(id);
  if (!skill) return null;
  skill.uses = (skill.uses || 0) + 1;
  if (ok) { skill.successes = (skill.successes || 0) + 1; skill.lastError = ''; } else { skill.failures = (skill.failures || 0) + 1; skill.lastError = String(error).slice(0, 300); }
  skill.lastUsed = new Date().toISOString();
  scheduleSave();
  emit({ op: 'skill_put', item: skill });
  return skill;
}
// A skill that keeps failing without ever succeeding is no longer offered.
const usableSkill = item => !((item.failures || 0) >= 3 && (item.failures || 0) > (item.successes || 0) * 2);
const stats = () => ({ memories: state.memories.length, playbooks: state.playbooks.length, skills: state.skills.length, turns: history.length, pinned: state.memories.filter(item => item.pinned).length, lessons: state.memories.filter(item => item.kind === 'lesson').length, core: linkStatus() });
function historySearch(query, k = 20) { return searchHistory(query, k); }

// Core-first readers. Each falls back to the local cache when the core is not reachable.
async function prepareContext(query, { goals = [], session = '' } = {}) {
  const exclude = requirements?.status().available ? requirements.list().map(item => item.legacyMemoryId).filter(Boolean) : [];
  const result = await throughCore('/api/v1/memory/context', { query: String(query || ''), goals: goals.map(goal => ({ title: String(goal.title || ''), done: !!goal.done })), session: String(session || ''), exclude_memory_ids: exclude }, 4000);
  if (!result || typeof result.text !== 'string') return { ...buildContext(query, { goals, session }), source: 'local' };
  // The core counted these uses; mirror the counts so the cache matches.
  for (const used of result.used?.memories || []) { const item = state.memories.find(entry => entry.id === used.id); if (item) item.hits = (item.hits || 0) + 1; }
  for (const used of result.used?.playbooks || []) { const item = state.playbooks.find(entry => entry.id === used.id); if (item) item.uses = (item.uses || 0) + 1; }
  if (Number.isSafeInteger(result.revision)) coreState.revision = result.revision;
  scheduleSave();
  const used = result.used || {};
  return { text: result.text, used: { memories: used.memories || [], playbooks: used.playbooks || [], skills: used.skills || [] }, source: 'core' };
}
async function searchAsync(query, { k = 6 } = {}) {
  const result = await throughCore('/api/v1/memory/search', { query: String(query || ''), k }, 4000);
  return result && Array.isArray(result.memories) ? { memories: result.memories, playbooks: result.playbooks || [], skills: result.skills || [], history: result.history || [] } : search(query, { k });
}
async function historySearchAsync(query, k = 20) {
  const result = await throughCore('/api/v1/memory/history', { query: String(query || ''), k }, 4000);
  return Array.isArray(result?.history) ? result.history : searchHistory(query, k);
}

const requirementStore = () => { if (!requirements) throw new Error('长期要求存储尚未初始化'); return requirements; };
const listRequirements = () => requirementStore().list();
const saveRequirements = (items, meta) => requirementStore().save(items, meta);
const requirementSnapshot = input => requirementStore().snapshot(input);
const assertRequirementsCurrent = snapshot => requirementStore().assertCurrent(snapshot);
const recordRequirementCheck = (runId, report) => requirementStore().recordCheck(runId, report);
function captureRequirements(message, session = '') {
  const items = explicitWritingRules(message);
  return items.length ? saveRequirements(items, { source: 'user', session }) : [];
}

module.exports = { init, flush, sync, linkStatus, prepareContext, searchAsync, historySearchAsync, addSkill, listSkills, getSkill, deleteSkill, recordSkillRun, getProfile, setProfile, undoProfile, recordTrajectory, addMemory, updateMemory, deleteMemory, addPlaybook, updatePlaybook, deletePlaybook, recordTurn, search, buildContext, feedback, listMemories, listPlaybooks, stats, historySearch, tokens, similarity, KINDS, listRequirements, saveRequirements, requirementSnapshot, assertRequirementsCurrent, recordRequirementCheck, captureRequirements };
