const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const memory = require('../electron/memory.cjs');
const { createTools } = require('../electron/tools.cjs');
const { compileSkill } = require('../electron/skills.cjs');

// A simulated Notepad: a text area, a "保存" button that opens a save dialog, a "帮助" button that does nothing.
// Element numbers change on every observation, like the real control layer, so replay must find controls by identity.
function fakeNotepad({ withConfirm = true } = {}) {
  const app = { doc: '', dialog: false, filename: '', saved: {}, round: 0 };
  let elements = new Map();
  const hash = () => JSON.stringify([app.doc, app.dialog, app.filename, app.saved]);
  const window = { hwnd: 7, process: 'notepad', title: '无标题 - 记事本', x: 0, y: 0, width: 800, height: 600 };
  const desktop = {
    async call(command, args = {}) {
      switch (command) {
        case 'focus': return { window, focused: true };
        case 'foreground': return { hwnd: 7, process: 'notepad', title: window.title };
        case 'windows': return { windows: [{ ...window, foreground: true, minimized: false }] };
        case 'hash': return { hash: hash() };
        case 'settle': return { changed: args.before === hash() ? 0 : 0.02 };
        case 'observe': {
          app.round++;
          const base = app.round * 10;
          const list = [
            { type: 'Button', name: '帮助', aid: 'Help' },
            { type: 'Document', name: '文本编辑器', aid: 'RichEditBox', value: app.doc },
            { type: 'Button', name: '保存', aid: 'Save' },
            ...(app.dialog ? [{ type: 'Edit', name: '文件名:', aid: 'FileNameControl', value: app.filename }, ...(withConfirm ? [{ type: 'Button', name: '确定', aid: '1' }] : [])] : []),
          ].map((item, index) => ({ ...item, id: base + (list => list)(index) + 1, enabled: true, x: 10, y: 10 + index * 30, w: 100, h: 24, sx: 10, sy: 10 + index * 30, sw: 100, sh: 24 }));
          elements = new Map(list.map(item => [item.id, item]));
          return { originX: 0, originY: 0, scale: 1, width: 800, height: 600, image: 'data:image/png;base64,AA', window: { title: window.title, process: 'notepad' }, elements: list };
        }
        case 'invoke': {
          const element = elements.get(args.id);
          if (element.name === '保存') app.dialog = true;
          if (element.name === '确定') { app.saved[app.filename] = app.doc; app.dialog = false; app.filename = ''; }
          return { invoked: true };
        }
        case 'setvalue': {
          const element = elements.get(args.id);
          if (element.aid === 'RichEditBox') app.doc = args.text;
          if (element.aid === 'FileNameControl') app.filename = args.text;
          return { ok: true };
        }
        case 'keys': return { ok: true };
        default: throw new Error('fake desktop: ' + command);
      }
    },
  };
  return { app, desktop };
}

async function setup(fake) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'));
  await memory.init(path.join(dir, 'memory'));
  const tools = createTools({ memory, userDataDir: path.join(dir, 'u'), getPrefs: () => ({}), host: { path: () => dir, desktop: fake.desktop, clipboard: { readText: () => '', writeText: () => {} }, controlStarted: () => {} } });
  const learned = [];
  const ctx = { signal: new AbortController().signal, ask: async () => 'session', turn: 't1', onLearned: item => learned.push(item) };
  return { dir, tools, ctx, learned };
}
const idOf = (observation, name) => Number(observation.elements.find(line => line.includes('「' + name + '」')).split(' ')[0]);

test('a software task that worked is saved as a skill and replayed later with new values, without the model', async () => {
  const first = fakeNotepad();
  const { tools, ctx, learned } = await setup(first);
  // The model does the task by hand once, including one useless click.
  let view = await tools.execute('observe', { window: '记事本' }, ctx);
  view = await tools.execute('click', { id: idOf(view, '帮助') }, ctx);
  assert.equal(view.changed, false);
  view = await tools.execute('type_text', { text: '购物清单：牛奶', into: idOf(view, '文本编辑器') }, ctx);
  view = await tools.execute('click', { id: idOf(view, '保存') }, ctx);
  view = await tools.execute('type_text', { text: 'list.txt', into: idOf(view, '文件名:') }, ctx);
  await tools.execute('click', { id: idOf(view, '确定') }, ctx);
  assert.equal(first.app.saved['list.txt'], '购物清单：牛奶');

  const saved = await tools.execute('save_skill', { title: '记事本写一段文字并保存', trigger: '用记事本记东西并存成文件', params: [{ name: 'content', description: '要写的内容', example: '购物清单：牛奶' }, { name: 'filename', description: '文件名', example: 'list.txt' }] }, ctx);
  assert.equal(saved.saved, true);
  assert.equal(saved.steps.length, 5, 'open + type + save + filename + confirm; the no-effect click is dropped');
  assert.ok(!saved.steps.some(line => line.includes('帮助')));
  assert.equal(learned.at(-1).type, 'skill');
  const skill = memory.getSkill(saved.id);
  assert.match(JSON.stringify(skill.steps), /\{\{content\}\}/);
  assert.match(JSON.stringify(skill.steps), /\{\{filename\}\}/);
  assert.match(memory.buildContext('用记事本记一下待办').text, /可以直接运行的软件技能[\s\S]*记事本写一段文字并保存/);

  // Next time: a fresh app, renumbered controls, different values, zero model calls.
  const second = fakeNotepad();
  const again = await setup(second);
  const { skill: copy } = memory.addSkill(skill);
  const run = await again.tools.execute('run_skill', { id: copy.id, params: { content: '待办：交周报', filename: 'todo.txt' } }, again.ctx);
  assert.equal(run.ok, true, run.error);
  assert.equal(second.app.saved['todo.txt'], '待办：交周报');
  assert.equal(memory.getSkill(copy.id).successes, 1);
});

test('when the interface no longer matches, replay stops at that step and hands over with the current screen', async () => {
  const { app, desktop } = fakeNotepad({ withConfirm: false });
  const { tools, ctx } = await setup({ app, desktop });
  const steps = [
    { op: 'open', window: '记事本', process: 'notepad' },
    { op: 'type', text: '{{content}}', into: { type: 'Document', name: '文本编辑器', aid: 'RichEditBox' }, submit: false, append: false, changed: true },
    { op: 'click', target: { type: 'Button', name: '保存', aid: 'Save' }, button: 'left', double: false, changed: true },
    { op: 'click', target: { type: 'Button', name: '确定', aid: '1' }, button: 'left', double: false, changed: true },
  ];
  const { skill } = memory.addSkill({ title: '保存文字', app: 'notepad', params: [{ name: 'content', example: 'x' }], steps });
  const run = await tools.execute('run_skill', { id: skill.id, params: { content: '你好' } }, ctx);
  assert.equal(run.ok, false);
  assert.equal(run.completed, 3);
  assert.match(run.stuck_at, /第 4\/4 步.*确定/);
  assert.ok(run.elements?.length, 'the current screen comes back so the model can continue by hand');
  assert.equal(app.doc, '你好', 'the steps before the mismatch did run');
  assert.equal(memory.getSkill(skill.id).failures, 1);
});

test('skills without a working action, or with a missing parameter, are refused clearly', async () => {
  assert.throws(() => compileSkill([{ op: 'open', window: 'x' }]), /没有成功的软件操作/);
  assert.throws(() => compileSkill([{ op: 'click', target: { type: 'Button', name: 'a' }, changed: true }]), /缺少起点/);
  const { tools, ctx } = await setup(fakeNotepad());
  const { skill } = memory.addSkill({ title: '需要参数', app: 'notepad', params: [], steps: [{ op: 'open', window: '记事本' }, { op: 'type', text: '{{who}}', into: null, changed: true }] });
  await assert.rejects(tools.execute('run_skill', { id: skill.id }, ctx), /缺少技能参数：who/);
});

test('a skill that keeps failing stops being offered', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'));
  await memory.init(path.join(dir, 'memory'));
  const { skill } = memory.addSkill({ title: 'Outlook 归档推广邮件', trigger: '整理邮件', app: 'outlook', steps: [{ op: 'open', window: 'Outlook' }, { op: 'keys', keys: 'backspace', changed: true }] });
  assert.match(memory.buildContext('帮我整理邮件').text, /Outlook 归档推广邮件/);
  for (let i = 0; i < 3; i++) memory.recordSkillRun(skill.id, false, '找不到控件');
  assert.doesNotMatch(memory.buildContext('帮我整理邮件').text, /Outlook 归档推广邮件/);
});
