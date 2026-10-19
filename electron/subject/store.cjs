// The subject's own durable state: every task it has taken on, what happened, and which ways of doing each
// kind of task have actually worked. This is what lets it decide by itself next time instead of asking a model.
const { readFile, writeFile, rename, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { similarity } = require('../memory.cjs');

const LIMITS = { tasks: 300, experiences: 2000 };
let file = '';
let state = { tasks: [], experiences: [] };
let saveTimer = null;

async function init(dir) {
  await mkdir(dir, { recursive: true });
  file = path.join(dir, 'subject.json');
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    state = { tasks: Array.isArray(value.tasks) ? value.tasks : [], experiences: Array.isArray(value.experiences) ? value.experiences : [] };
  } catch { state = { tasks: [], experiences: [] }; }
  // A task that was running when the app stopped is not silently resumed or replayed.
  for (const task of state.tasks) if (task.status === 'running') { task.status = 'interrupted'; task.updatedAt = new Date().toISOString(); }
}
function scheduleSave() {
  if (!file) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, 300);
}
async function flush() {
  if (!file) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { await writeFile(file + '.tmp', JSON.stringify(state, null, 1), 'utf8'); await rename(file + '.tmp', file); } catch (error) { console.error('保存主体状态失败:', error.message); }
}

function createTask({ request, session = '', intent }) {
  const task = { id: randomUUID(), request: String(request).slice(0, 2000), session, intent, status: 'running', route: '', plan: [], log: [], verification: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.tasks.unshift(task);
  state.tasks = state.tasks.slice(0, LIMITS.tasks);
  scheduleSave();
  return task;
}
function updateTask(task, patch) {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  scheduleSave();
  return task;
}
function logTask(task, text) {
  task.log.push({ ts: new Date().toISOString(), text: String(text).slice(0, 500) });
  if (task.log.length > 80) task.log.shift();
  scheduleSave();
}
const listTasks = () => state.tasks.slice();

// One record per finished task: what kind it was, how it was done, whether it verifiably succeeded, what it cost.
function recordExperience(entry) {
  const record = { id: randomUUID(), ts: new Date().toISOString(), ...entry };
  state.experiences.unshift(record);
  state.experiences = state.experiences.slice(0, LIMITS.experiences);
  scheduleSave();
  return record;
}

// For a kind of task: how often each route verifiably succeeded. The subject prefers what has worked for this user.
function routeStats(kind) {
  const stats = {};
  for (const item of state.experiences) {
    if (!kind || item.kind !== kind) continue;
    const entry = stats[item.route] ||= { tries: 0, passed: 0 };
    entry.tries++;
    if (item.passed) entry.passed++;
  }
  return stats;
}

// "I have done exactly this before": a near-identical request that verifiably succeeded can reuse its understanding.
function similarSuccess(request, threshold = 0.9) {
  let best = null, score = 0;
  for (const item of state.experiences) {
    if (!item.passed || !item.intent) continue;
    // Similar wording can change a filename, amount, negation or deadline. Never reuse old parameters on that basis.
    if (String(request).trim() !== String(item.request).trim()) continue;
    const value = similarity(request, item.request);
    if (value > score) { score = value; best = item; }
  }
  return score >= threshold && String(request).length >= 4 ? { experience: best, score } : null;
}

// How much of the work the subject handled by itself (no model call to understand or execute).
function autonomy(last = 50) {
  const recent = state.experiences.slice(0, last);
  const local = item => item.passed === true && item.modelCalls === 0;
  return { tasks: recent.length, passed: recent.filter(item => item.passed).length, localUnderstanding: recent.filter(item => item.localUnderstanding).length, skillRuns: recent.filter(item => item.route === 'skill').length, modelCalls: recent.reduce((sum, item) => sum + (item.modelCalls || 0), 0), handledLocally: recent.filter(local).length };
}

module.exports = { init, flush, createTask, updateTask, logTask, listTasks, recordExperience, routeStats, similarSuccess, autonomy };
