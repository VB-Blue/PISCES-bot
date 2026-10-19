// Real-task evaluation set. Each task is something a real user would ask, with what "done well" means.
// Turns marked newSession start a fresh conversation, so only memory/profile can carry information across.
const fs = require('node:fs');
const path = require('node:path');

const list = dir => { try { return fs.readdirSync(dir, { recursive: true }).map(String); } catch { return []; } };
const newFiles = (box, before) => list(box.root).filter(item => !before.has(item) && !item.startsWith('memory') && !item.startsWith('userdata'));
const readSome = file => { try { return fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { return ''; } };

module.exports = [
  {
    id: 'news-digest',
    title: '联网汇总科技新闻并存成文档',
    turns: [{ text: '联网汇总一下昨天的科技新闻，整理成一份文档放桌面' }],
    rubric: '应主动搜索并阅读多个新闻来源，内容是昨天（相对当前日期）的科技新闻，至少 5 条，每条有一句话概要和来源链接；把文档写到桌面；不应反问用户要什么新闻。',
    check: (box, before) => {
      const docs = newFiles(box, before).filter(item => item.startsWith('Desktop') && /\.(md|txt|docx|html)$/i.test(item));
      return { ok: docs.length > 0, note: docs.length ? '桌面新文件：' + docs.join('，') : '桌面没有新文档' };
    },
  },
  {
    id: 'fix-photo',
    title: '修一张歪掉的照片',
    turns: [{ text: '这张照片拍歪了，帮我修一下', image: 'tilted' }],
    rubric: '应看图判断出画面倾斜，直接用 edit_image 拉正（逆时针/顺时针约 7 度）并另存新文件，原图不动；告诉用户新文件位置。不应先反问“想怎么修”。',
    check: (box, before) => {
      const images = newFiles(box, before).filter(item => /\.(png|jpe?g)$/i.test(item));
      return { ok: images.length > 0, note: images.length ? '新图片：' + images.join('，') : '没有生成新图片' };
    },
  },
  {
    id: 'tidy-downloads',
    title: '模糊指令：整理下载文件夹',
    turns: [{ text: '帮我整理一下下载文件夹' }],
    rubric: '指令模糊。好的做法：先看下载文件夹里有什么，按类型/用途分好类，直接完成可撤销的整理（建子文件夹、移动文件），不删除任何文件，最后说明怎么分的。只列出方案再问“要不要这样做”算部分完成；什么都不看就反问算失败。',
    check: box => {
      const top = fs.readdirSync(path.join(box.root, 'Downloads'), { withFileTypes: true });
      const folders = top.filter(item => item.isDirectory()).length;
      const total = list(path.join(box.root, 'Downloads')).filter(item => /\.[a-z0-9]+$/i.test(item)).length;
      return { ok: folders >= 2 && total >= 14, note: '子文件夹 ' + folders + ' 个，文件总数 ' + total + '（原有 14 个，不应减少）' };
    },
  },
  {
    id: 'weekly-report',
    title: '根据工作笔记写周报',
    turns: [{ text: '帮我写这周的周报' }],
    rubric: '应自己去找素材：在文档/桌面里找到“工作笔记”文件夹，读完三天的笔记，写出结构清楚的周报（本周完成、进行中、问题、下周计划），内容来自笔记里的真实事项（如支付接口、退款 bug、季度评审）。直接写在回答里或保存成文件都可以。不应先问“周报写什么”。',
    check: (box, before, answers) => {
      const docs = newFiles(box, before).filter(item => /\.(md|txt|docx)$/i.test(item));
      const text = docs.map(item => readSome(path.join(box.root, item))).join('\n') + (answers.at(-1) || '');
      const hits = ['支付', '退款', '评审'].filter(word => text.includes(word)).length;
      return { ok: hits >= 2, note: (docs.length ? '文件：' + docs.join('，') : '写在回答里') + '；命中笔记事项 ' + hits + '/3' };
    },
  },
  {
    id: 'csv-top5',
    title: '分析表格：销量前五',
    turns: [{ text: '文档里那个销售数据，哪 5 个产品卖得最好？给我做个表' }],
    rubric: '应找到 文档/销售数据.csv，同一产品多行要加总，给出正确的前五名表格。“卖得最好”可以理解为按销量（数量）或按销售额（数量×单价），两种都可以，但必须说明按哪种口径；同时给出两种排名更好。数字必须正确。',
    check: (box, before, answers) => {
      const byRevenue = ['无线耳机 Pro', '智能手表 S3', '机械键盘 K8', '便携投影仪', '降噪耳罩 X'];
      const byUnits = ['数据线', '手机壳', '无线耳机 Pro', '机械键盘 K8', '智能手表 S3'];
      // Any one table (a run of "|" lines) must list one of the two correct top fives in order.
      const tables = (answers.at(-1) || '').split(/\n(?!\s*\|)/).filter(block => block.includes('|'));
      const inOrder = expected => tables.some(block => { const positions = expected.map(name => block.indexOf(name)); return positions.every(index => index >= 0) && positions.every((index, i) => i === 0 || index > positions[i - 1]); });
      const revenue = inOrder(byRevenue), units = inOrder(byUnits);
      return { ok: revenue || units, note: revenue && units ? '两种口径的前五名都正确' : revenue ? '按销售额的前五名正确' : units ? '按销量的前五名正确' : '没有一张表给出正确的前五名' };
    },
  },
  {
    id: 'know-the-user',
    title: '懂用户：跨对话记住身份并据此回答',
    turns: [
      { text: '我是做电商摄影的，主要拍服装平铺和模特图，平时用 PS 和 Lightroom' },
      { text: '最近有什么好用的 AI 修图工具推荐吗？', newSession: true },
    ],
    rubric: '第二轮是新对话，助手只能靠记忆知道用户身份。好的回答应针对服装电商摄影（抠图换背景、批量调色、模特修饰、平铺图去褶皱等），优先提到能和 PS/Lightroom 配合的工具，并联网核实是最新的。泛泛列 AI 修图工具算部分完成。',
    check: (box, before, answers, ctx) => {
      const profile = ctx.profile();
      const remembered = /电商|服装/.test(profile) || ctx.memories().some(item => /电商|服装/.test(item.text));
      const tailored = /服装|电商|平铺|模特/.test(answers.at(-1) || '');
      return { ok: remembered && tailored, note: '画像/记忆记下身份：' + (remembered ? '是' : '否') + '；第二轮回答针对电商服装：' + (tailored ? '是' : '否') };
    },
  },
  {
    id: 'follow-up',
    title: '接着上一步改：表格加一列',
    turns: [
      { text: '调研一下现在国内主流的 AI 编程助手，列个对比表' },
      { text: '加上价格那一列' },
    ],
    rubric: '第一轮应联网调研并给出对比表（至少 4 个产品）。第二轮应在同一张表的基础上加“价格”列（价格需联网核实，查不到要注明），而不是重新开始或只单独列价格。',
    check: (box, before, answers) => {
      const last = answers.at(-1) || '';
      const table = /\|.*\|/.test(last) && /价格|定价|费用/.test(last);
      return { ok: table, note: table ? '第二轮给出了带价格列的表格' : '第二轮没有带价格列的表格' };
    },
  },
  {
    id: 'learns-correction',
    title: '记住纠正：以后回答要短',
    turns: [
      { text: '介绍一下量子计算' },
      { text: '太长了，以后这种介绍三句话以内就行' },
      { text: '介绍一下区块链', newSession: true },
    ],
    rubric: '第二轮应立刻改短并记住这个偏好（remember 或画像）。第三轮是新对话，应自动用三句话以内介绍区块链。',
    check: (box, before, answers) => {
      const last = (answers.at(-1) || '').replace(/\s+/g, '');
      const sentences = last.split(/[。！？!?]/).filter(item => item.length > 2).length;
      return { ok: sentences <= 4 && last.length <= 260, note: '第三轮 ' + last.length + ' 字，约 ' + sentences + ' 句' };
    },
  },
  // ---- Software tasks: the assistant opens and drives real Windows apps. Run with --desktop, with nobody using the PC. ----
  {
    id: 'notepad-then-skill',
    desktop: true,
    title: '用记事本完成任务，第二次靠技能复用',
    turns: [
      { text: '用记事本写一个购物清单：牛奶、鸡蛋、面包，保存到桌面，文件名叫 购物清单.txt' },
      { text: '再用记事本写一个待办清单：交周报、买菜，保存到桌面，文件名叫 待办.txt', newSession: true },
    ],
    rubric: '第一轮应自己打开记事本、写入内容、通过“另存为”保存到桌面（指定的文件名），不要让用户去开软件；完成后最好用 save_skill 保存成技能。第二轮是新对话，应发现并使用已保存的技能（run_skill）完成，模型调用次数明显少于第一轮；技能卡住时接着手动完成也可以。',
    check: (box, before, answers, ctx) => {
      const read = name => { try { return fs.readFileSync(path.join(box.root, 'Desktop', name), 'utf8'); } catch { return ''; } };
      const first = /牛奶/.test(read('购物清单.txt')) && /面包/.test(read('购物清单.txt'));
      const second = /交周报/.test(read('待办.txt'));
      const reused = (ctx.turnTools?.[1] || []).includes('run_skill');
      const calls = ctx.turnCalls || [];
      return { ok: first && second, note: '购物清单：' + (first ? '✓' : '✗') + '；待办：' + (second ? '✓' : '✗') + '；第二轮用了技能：' + (reused ? '是' : '否') + '；模型调用 ' + calls.join(' → ') };
    },
  },
  {
    id: 'calculator',
    desktop: true,
    title: '用计算器算数',
    turns: [{ text: '用电脑上的计算器帮我算一下 1234 × 5678 等于多少' }],
    rubric: '应自己打开 Windows 计算器，按键或点击输入算式，读出计算器显示的结果（7006652）告诉用户。只心算或用命令算出结果、没有操作计算器，算部分完成。',
    check: (box, before, answers, ctx) => {
      const used = (ctx.turnTools?.[0] || []).some(name => ['observe', 'click', 'press_keys', 'type_text', 'run_skill'].includes(name));
      const right = /7[,，]?006[,，]?652/.test(answers.at(-1) || '');
      return { ok: used && right, note: '操作了计算器：' + (used ? '是' : '否') + '；结果正确：' + (right ? '是' : '否') };
    },
  },
];
