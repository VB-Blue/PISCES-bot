const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Notification } = require('electron');

let reminders = [];
let storagePath = '';
let checkTimer = null;
let onFiredCallback = null;
let getWindow = () => null;
let notificationText = key => key;
let onOpenCallback = null;
let saving = Promise.resolve();

async function initScheduler(userDataDir, windowGetter, onFired, translate = key => key, onOpen = null) {
  storagePath = path.join(userDataDir, 'reminders.json');
  getWindow = windowGetter;
  onFiredCallback = onFired;
  notificationText = translate;
  onOpenCallback = onOpen;
  try {
    const raw = await readFile(storagePath, 'utf8');
    reminders = JSON.parse(raw);
    if (!Array.isArray(reminders)) reminders = [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('未能读取提醒记录，使用空列表');
    reminders = [];
  }

  if (checkTimer) clearInterval(checkTimer);
  checkTimer = setInterval(checkPendingReminders, 1000);
}

function persist() {
  if (!storagePath) return Promise.resolve();
  const file = storagePath, snapshot = JSON.stringify(reminders, null, 2);
  saving = saving.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    await writeFile(temp, snapshot, 'utf8');
    await require('node:fs/promises').rename(temp, file);
  });
  return saving.catch(error => { console.error('保存提醒失败:', error.message); });
}

const REPEAT_MS = { daily: 24 * 3600 * 1000, weekly: 7 * 24 * 3600 * 1000 };

function createReminder({ title = '主动提醒', content, delaySeconds, targetTime, session = '', repeat = '' }) {
  if (!content || typeof content !== 'string') throw new Error('提醒内容不能为空');
  let triggerTimestamp = 0;
  if (typeof delaySeconds === 'number' && delaySeconds > 0) {
    triggerTimestamp = Date.now() + Math.round(delaySeconds * 1000);
  } else if (targetTime) {
    const parsed = new Date(targetTime).getTime();
    if (isNaN(parsed) || parsed <= Date.now()) throw new Error('目标时间必须是未来的有效时间');
    triggerTimestamp = parsed;
  } else {
    throw new Error('必须指定 delaySeconds（延迟秒数）或 targetTime（未来绝对时间）');
  }

  const reminder = {
    id: randomUUID(),
    title: String(title).slice(0, 100),
    content: String(content).slice(0, 500),
    triggerAt: triggerTimestamp,
    targetDateStr: new Date(triggerTimestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    createdAt: new Date().toISOString(),
    session: String(session || ''),
    status: 'pending',
    ...(REPEAT_MS[repeat] ? { repeat } : {}),
  };

  reminders.push(reminder);
  persist().catch(() => {});
  return reminder;
}

function listReminders() {
  return reminders.slice(-100);
}

function deleteReminder(id) {
  const before = reminders.length;
  reminders = reminders.filter(r => r.id !== id);
  if (reminders.length === before) return false;
  persist().catch(() => {});
  return true;
}

function cancelReminder(id) {
  const index = reminders.findIndex(r => r.id === id);
  if (index !== -1) {
    reminders[index].status = 'cancelled';
    persist().catch(() => {});
    return true;
  }
  return false;
}

function checkPendingReminders() {
  const now = Date.now();
  let updated = false;

  for (const reminder of reminders) {
    if (reminder.status === 'pending' && reminder.triggerAt <= now) {
      // A reminder that came due while the app was closed is announced as missed rather than silently late.
      reminder.late = now - reminder.triggerAt > 90_000;
      reminder.firedAt = new Date().toISOString();
      if (REPEAT_MS[reminder.repeat]) {
        while (reminder.triggerAt <= now) reminder.triggerAt += REPEAT_MS[reminder.repeat];
        reminder.targetDateStr = new Date(reminder.triggerAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      } else reminder.status = 'fired';
      updated = true;
      triggerNotification(reminder);
    }
  }

  if (updated) {
    persist().catch(() => {});
  }
}

function triggerNotification(reminder) {
  try {
    const electron = require('electron');
    const Notification = electron?.Notification;
    if (Notification && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
      const notification = new Notification({
        title: '🔔 ' + (reminder.title || notificationText('PISCES AI主动提醒')),
        body: (reminder.late ? notificationText('（错过的提醒）') : '') + reminder.content,
        urgency: 'critical',
      });
      notification.on('click', () => {
        if (onOpenCallback) { onOpenCallback(reminder); return; }
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
          win.webContents.send('reminder:clicked', reminder);
        }
      });
      notification.show();
    }
  } catch (error) {
    console.warn('系统通知触发失败:', error.message);
  }

  if (typeof onFiredCallback === 'function') {
    onFiredCallback(reminder);
  }
}

function stopScheduler() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

module.exports = {
  initScheduler,
  createReminder,
  listReminders,
  cancelReminder,
  deleteReminder,
  stopScheduler,
  flush: () => saving,
};
