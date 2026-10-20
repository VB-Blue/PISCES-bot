const catalogs = { en: require('./locales/en.json'), 'zh-TW': require('./locales/zh-TW.json') };
const locales = ['zh-CN','en','zh-TW'];
const normalizeLocale = value => locales.includes(value) ? value : 'zh-CN';
function translate(locale, key, parameters = {}) {
  if (typeof key !== 'string') return '';
  const format = catalogs[normalizeLocale(locale)]?.[key] ?? key;
  return format.replace(/\{(\w+)\}/g, (token,name) => parameters[name] === undefined || parameters[name] === null ? token : String(parameters[name]));
}
const systemPrefixes = ['核心返回 HTTP ', '需要你确认：', '失败：', '提醒：', '已撤销：', '文件已更改：', '写入文件：', '生成 Word 文档：', '修改文件：', '读取文件：', '查看目录：', '查找文件：', '查找内容：', '搜索内容：', '搜索资料：', '读取网页：', '执行命令：', '启动：', '打开网址：', '记住：', '回忆：', '保存经验：', '保存软件技能：', '切换服务：', '使用 AI 服务：', '删除：', '改为：', '查看领域认识：', '交给记忆体分析样本：', '记下待检验的规律：', '登记对照实践：', '记录实践结果：', '记忆体判断：'];
function translateSystem(locale, key) {
  if (typeof key !== 'string') return '';
  const prefix = systemPrefixes.find(value => key.startsWith(value));
  return prefix ? translate(locale, prefix + '{p0}', { p0: key.slice(prefix.length) }) : translate(locale, key);
}
module.exports = { translate, translateSystem, systemPrefixes, normalizeLocale, locales, catalogs };
