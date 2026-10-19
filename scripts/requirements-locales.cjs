const fs = require('node:fs');
const path = require('node:path');
const entries = {
  '长期要求': ['Standing requirements', '長期要求'],
  '长期要求逐条检查': ['Requirement checklist', '長期要求逐條檢查'],
  '全部通过': ['All passed', '全部通過'],
  '尚未通过': ['Not yet passed', '尚未通過'],
  '通过': ['Passed', '通過'], '未通过': ['Failed', '未通過'], '无法核实': ['Unverified', '無法核實'],
  '按完整正文复核': ['Review the complete content', '按完整正文覆核'],
  '必须包含文字': ['Required text', '必須包含文字'], '禁止出现文字': ['Forbidden text', '禁止出現文字'],
  '最少非空白字符数': ['Minimum non-whitespace characters', '最少非空白字元數'], '最多非空白字符数': ['Maximum non-whitespace characters', '最多非空白字元數'],
  '相关任务会完整读取所有适用要求，并在交付前逐条检查。换对话或重启后继续保留。': ['Related tasks load every applicable requirement in full and check each one before delivery. Requirements persist across chats and restarts.', '相關任務會完整讀取所有適用要求，並在交付前逐條檢查。換對話或重新啟動後繼續保留。'],
  '要求原文': ['Original requirement', '要求原文'],
  '查看完整原文': ['Read the complete original', '檢視完整原文'],
  '字': ['characters', '字'],
  '每条要求单独保存；可以包含多段原文。': ['Save each requirement separately. Multiple paragraphs are supported.', '每條要求單獨儲存；可以包含多段原文。'],
  '适用类型': ['Applies to', '適用類型'], '写作与内容任务': ['Writing and content tasks', '寫作與內容任務'], '所有任务': ['All tasks', '所有任務'],
  '适用项目或网站': ['Project or website', '適用專案或網站'],
  '留空表示所有相关任务；填写时按任务中的名称匹配': ['Leave blank for all related tasks; otherwise match this name in the task', '留空表示所有相關任務；填寫時按任務中的名稱比對'],
  '检查方式': ['Check method', '檢查方式'], '检查值': ['Check value', '檢查值'], '保存修改': ['Save changes', '儲存修改'], '保存要求': ['Save requirement', '儲存要求'],
  '长期要求已完整保存': ['The complete requirement has been saved', '長期要求已完整儲存'],
  '已启用': ['Enabled', '已啟用'], '已停用': ['Disabled', '已停用'], '停用': ['Disable', '停用'], '启用': ['Enable', '啟用'], '查看历史版本': ['View revision history', '檢視歷史版本'],
  '还没有长期要求。可以在这里保存，也可以在对话中说“记住以下写作要求：”并逐条列出。': ['No standing requirements yet. Save one here, or say “Remember these writing requirements:” in a chat and list them.', '還沒有長期要求。可以在這裡儲存，也可以在對話中說「記住以下寫作要求：」並逐條列出。'],
};
for (const [locale, index] of [['en', 0], ['zh-TW', 1]]) {
  const file = path.join(__dirname, '../electron/locales', locale + '.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [key, values] of Object.entries(entries)) if (!data[key]) data[key] = values[index];
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
