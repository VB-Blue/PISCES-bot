const fs = require('node:fs'), path = require('node:path');
const entries = [
  ['执行者','Executor','執行者'],['资料员','Researcher','資料員'],['程序员','Coder','程式員'],['操作员','Operator','操作員'],['写作员','Writer','寫作員'],['复核员','Reviewer','複核員'],
  ['等待前置验收','Waiting for verified prerequisites','等待前置驗收'],['等待文件或执行资源','Waiting for files or execution resources','等待檔案或執行資源'],['等待执行容量','Waiting for execution capacity','等待執行容量'],['等待服务响应','Waiting for the service response','等待服務回應'],
  ['{p0} 项分工进行中','{p0} assignments in progress','{p0} 項分工進行中'],['执行分工','Assignments','執行分工'],
];
for (const [locale, column] of [['en',1],['zh-TW',2]]) {
  const file = path.join(__dirname,'../electron/locales',locale+'.json'), catalog = JSON.parse(fs.readFileSync(file,'utf8'));
  for (const row of entries) catalog[row[0]] = row[column];
  fs.writeFileSync(file, JSON.stringify(catalog,null,2)+'\n');
}
