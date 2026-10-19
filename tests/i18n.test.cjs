const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const {translate,translateSystem,systemPrefixes,normalizeLocale,catalogs,locales}=require('../electron/i18n.cjs');
const placeholders=value=>[...value.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
test('Every language has the same complete catalog and interpolation parameters',()=>{
  assert.deepEqual(locales,['zh-CN','en','zh-TW']);
  assert.ok(Object.keys(catalogs.en).length>900);
  assert.deepEqual(Object.keys(catalogs.en).sort(),Object.keys(catalogs['zh-TW']).sort());
  for(const catalog of Object.values(catalogs))for(const [key,value]of Object.entries(catalog)){
    assert.equal(typeof value,'string');assert.ok(value.length,key);assert.deepEqual(placeholders(value),placeholders(key),key);
  }
});
test('Operation captions translate without changing paths, commands, or user text',()=>{
  for(const prefix of systemPrefixes)for(const catalog of Object.values(catalogs))assert.ok(Object.hasOwn(catalog,prefix+'{p0}'),prefix);
  assert.equal(translateSystem('en','写入文件：D:\\文档\\周报.md'),'Write file: D:\\文档\\周报.md');
  assert.equal(translateSystem('zh-TW','改为：用户原文 {p0}'),'改為：用户原文 {p0}');
});
test('Every literal rendered translation has an English and Traditional Chinese entry',()=>{
  const root=path.resolve(__dirname,'..');let checked=0;
  const files=fs.readdirSync(path.join(root,'src')).filter(name=>/\.tsx?$/.test(name)).map(name=>path.join(root,'src',name));files.push(path.join(root,'electron/main.cjs'));
  for(const file of files){const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    const visit=node=>{if(ts.isCallExpression(node)&&['t','tr'].includes(node.expression.getText(source))&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0])){
      const key=node.arguments[0].text;checked++;for(const [language,catalog]of Object.entries(catalogs))assert.ok(Object.hasOwn(catalog,key),language+' missing '+key+' in '+path.basename(file));
    }ts.forEachChild(node,visit);};visit(source);
  }assert.ok(checked>800);
});
test('Language normalization and unknown content preserve the original',()=>{
  assert.equal(normalizeLocale('unsupported'),'zh-CN');assert.equal(normalizeLocale(null),'zh-CN');
  const original='用户原文：销售分析，D:\\文档\\周报.md，MCP 服务 A';
  for(const locale of locales)assert.equal(translate(locale,original),original);
  assert.equal(translate('en','有 {p0} 件事情需要你。',{p0:2}),'Needs your attention: 2.');
  assert.equal(translate('en','核心地址: {p0}',{p0:'http://127.0.0.1:18789'}),'Core URL: http://127.0.0.1:18789');
});
