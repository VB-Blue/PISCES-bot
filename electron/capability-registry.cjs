// Task-local discovery over already-authorized adapters. Loading a definition never grants permission.
const DISCOVER = { type: 'function', function: { name: 'discover_tools', description: '按当前任务发现并加载可用工具。找不到合适工具时先调用；返回真实可用能力、参数和权限说明。不会授予新权限，也不会执行操作。', parameters: { type: 'object', properties: {
  query: { type: 'string', description: '需要完成的具体操作，例如“操作已打开的窗口”“读取连接器资料”' },
  group: { type: 'string', enum: ['files', 'web', 'desktop', 'shell', 'memory', 'connectors', 'media'] },
  names: { type: 'array', items: { type: 'string' }, maxItems: 12, description: '已知工具名时可精确加载' },
  limit: { type: 'integer', minimum: 1, maximum: 24 },
}, additionalProperties: false } } };

const groups = {
  files: /文件|目录|文档|表格|报告|数据|读写|统计|file|folder|document|report|spreadsheet|csv|data/i,
  web: /网页|浏览器|新闻|调研|研究|来源|搜索|联网|web|browser|news|research|search|source/i,
  desktop: /软件|窗口|应用|控件|鼠标|键盘|截图|屏幕|桌面|记事本|word|excel|photoshop|window|desktop|screen|click|uia/i,
  shell: /命令|终端|脚本|编译|测试|代码|开发|shell|command|code|script|build|test/i,
  memory: /记住|记忆|偏好|经验|方法|技能|memory|remember|recall|skill/i,
  connectors: /连接器|插件|账户|邮件|日历|连接|connector|plugin|slack|notion|outlook|calendar|mcp/i,
  media: /图片|图像|配图|插图|海报|封面|画一|画个|生成图|视频|短视频|动画|抖音|tiktok|小红书|ins|instagram|image|picture|photo|poster|illustration|video|clip|animation/i,
};
function groupFor(name, view) {
  if (name.startsWith('mcp_')) return 'connectors';
  if (name === 'generate_image' || name === 'generate_video') return 'media';
  if (/^(find_app|launch_app|open_url|list_windows|uia_|observe|screenshot|click|type_text|press_keys|scroll|drag|find_text|click_text|read_window_text|wait_for|zoom|inspect_window)/.test(name)) return 'desktop';
  if (name === 'run_command') return 'shell';
  if (/^(remember|recall|save_requirements|save_skill|run_skill|save_playbook|domain_knowledge|record_observations|propose_principle|start_experiment|record_experiment_result)/.test(name)) return 'memory';
  if (/^(web_search|news_search|fetch_url|browser_)/.test(name)) return 'web';
  return view.groupOf?.(name) === 'control' ? 'desktop' : view.groupOf?.(name) === 'commands' ? 'shell' : 'files';
}

function createCapabilityView(view, { request = '' } = {}) {
  // Reporting observations and trial results to the core is part of every task, so these are always at hand.
  const loaded = new Set(['get_environment', 'recall', 'remember', 'save_requirements', 'update_plan', 'delegate', 'background_task', 'domain_knowledge', 'record_observations', 'propose_principle', 'start_experiment', 'record_experiment_result']);
  const definitions = () => (view.definitions || []).filter(item => item?.function?.name !== 'discover_tools' && view.has(item.function.name));
  function selectTask(intent) {
    const text = typeof intent === 'string' ? intent : [intent?.goal, intent?.kind, intent?.deliverable, intent?.presentation, ...(intent?.apps || [])].filter(Boolean).join(' ');
    const wanted = Object.keys(groups).filter(group => groups[group].test(text));
    // Ordinary file/research work stays immediately usable; unusual capabilities can be discovered on demand.
    if (!wanted.length) wanted.push('files', 'web');
    if (wanted.includes('desktop')) wanted.push('files');
    const browserBasics = new Set(['browser_tabs', 'browser_open', 'browser_observe']);
    if (/操作|填写|填表|表单|上传|发布|运营|登录|点击|自动化|form|fill|upload|publish|login|click|automat/i.test(text)) for (const name of ['browser_click', 'browser_fill', 'browser_wait']) browserBasics.add(name);
    for (const def of definitions()) if (wanted.includes(groupFor(def.function.name, view)) && (!def.function.name.startsWith('browser_') || browserBasics.has(def.function.name))) loaded.add(def.function.name);
  }
  selectTask(request);
  return {
    ...view,
    get names() { return new Set([...definitions().map(item => item.function.name), 'discover_tools']); },
    get definitions() { return [DISCOVER, ...definitions().filter(item => loaded.has(item.function.name))]; },
    has: name => name === 'discover_tools' || view.has(name),
    selectTask,
    label: (name, args) => name === 'discover_tools' ? '发现可用工具：' + String(args?.query || args?.group || '').slice(0, 60) : view.label(name, args),
    async execute(name, args, ctx) {
      if (name !== 'discover_tools') return view.execute(name, args, ctx);
      const query = String(args?.query || '').trim().slice(0, 300).toLowerCase();
      const exact = new Set((Array.isArray(args?.names) ? args.names : []).filter(item => typeof item === 'string').slice(0, 12));
      const wanted = args?.group && Object.hasOwn(groups, args.group) ? [args.group] : Object.keys(groups).filter(group => groups[group].test(query));
      const words = query.match(/[a-z][a-z0-9_-]{1,}/g) || [];
      const rank = item => {
        const tool = item.function;
        if (exact.has(tool.name)) return 100;
        const family = groupFor(tool.name, view);
        const haystack = (tool.name + ' ' + tool.description).toLowerCase();
        return (wanted.includes(family) ? 10 : 0) + (query && haystack.includes(query) ? 8 : 0) + words.filter(word => haystack.includes(word)).length * 2;
      };
      const ranked = definitions().map(item => ({ item, score: rank(item) })).filter(row => !query && !exact.size && !args?.group || row.score > 0)
        .sort((a, b) => b.score - a.score || a.item.function.name.localeCompare(b.item.function.name));
      const found = ranked.slice(0, Math.max(1, Math.min(24, Number(args?.limit) || 12))).map(row => row.item);
      for (const def of found) loaded.add(def.function.name);
      return { ok: true, tools: found.map(item => ({ name: item.function.name, group: groupFor(item.function.name, view), description: item.function.description, parameters: item.function.parameters })),
        unavailable: [...exact].filter(item => !definitions().some(def => def.function.name === item)),
        note: found.length ? '这些工具已加载到下一轮可用工具中，执行仍遵守原授权。' : '当前没有匹配的可用工具。可以换关键词；未连接能力需要明确说明缺口。' };
    },
  };
}
module.exports = { createCapabilityView, groupFor };
