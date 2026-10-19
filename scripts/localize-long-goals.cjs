const fs = require('node:fs');
const path = require('node:path');
const additions = {
  '停止': ['Stop', '停止'],
  '时间': ['Time', '時間'],
  '模型': ['Model', '模型'],
  '本轮 token 预算不足，已在请求模型前暂停。请提高本轮预算后继续；本轮用量不会因重启或跨日清零。': ['This round’s token allowance is insufficient. No model request was sent. Increase the round budget to resume; restarting or changing days does not reset this round’s usage.', '本輪 token 預算不足，已在請求模型前暫停。請提高本輪預算後繼續；本輪用量不會因重啟或跨日歸零。'],
  '今日 token 预算不足，已在请求模型前暂停。提高预算后点击继续，或等待下一个预算日。': ['Today’s token allowance is insufficient. No model request was sent. Increase the budget and resume, or wait for the next budget day.', '今日 token 預算不足，已在請求模型前暫停。提高預算後點擊繼續，或等待下一個預算日。'],
  '目标名称（可选）': ['Goal name (optional)', '目標名稱（選填）'],
  '当前轮要求已更新，等待新的验收结果': ['This round’s requirements changed. Waiting for a newly verified result.', '目前輪次要求已更新，等待新的驗收結果'],
  '复核服务暂时不可用，稍后从已验收结果继续核对；未开始新一轮。': ['The review service is temporarily unavailable. Review will retry from the verified result; no new round has started.', '複核服務暫時無法使用，稍後從已驗收結果繼續核對；未開始新一輪。'],
  '长期目标因 token 预算暂停': ['A long-term goal paused because of its token budget', '長期目標因 token 預算暫停'],
  '长期目标需要处理：{p0}': ['A long-term goal needs attention: {p0}', '長期目標需要處理：{p0}'],
  '仅在这些文件变化后运行（可选，每行一个路径）': ['Run when these files change (optional, one path per line)', '僅在這些檔案變更後執行（選填，每行一個路徑）'],
  '只监测已授权目录中的文件。来源没有变化时，检查不调用模型；留空则按间隔持续执行。': ['Only files in authorized folders are monitored. Unchanged sources trigger no model calls. Leave blank to run on the schedule.', '只監測已授權目錄中的檔案。來源沒有變更時，檢查不呼叫模型；留空則按間隔持續執行。'],
  '来源未变化，本次检查未调用模型': ['Sources are unchanged; no model was called for this check.', '來源未變更，本次檢查未呼叫模型'],
  '本轮任务尚未通过结果验收，请先检查关联任务': ['This round has not passed result verification. Check the linked task first.', '本輪任務尚未通過結果驗收，請先檢查關聯任務'],
  '长期目标': ['Long-term goals', '長期目標'],
  '用量与预算': ['Usage and budgets', '用量與預算'],
  '理解、规划、执行、复核、子任务和记忆整理共用一份账本。': ['Understanding, planning, execution, review, subtasks and memory updates share one ledger.', '理解、規劃、執行、複核、子任務和記憶整理共用一份帳本。'],
  '请在桌面程序中查看实际用量和执行长期目标。': ['Use the desktop app to view actual usage and run long-term goals.', '請在桌面程式中查看實際用量和執行長期目標。'],
  '服务已报告': ['Reported by service', '服務已回報'],
  '未知用量预估': ['Unreported usage estimate', '未知用量預估'],
  '进行中预留': ['Reserved for active calls', '進行中預留'],
  '今日调用': ['Calls today', '今日呼叫'],
  '全局每日 token 预算': ['Global daily token budget', '全域每日 token 預算'],
  '发起请求前预留额度，并行任务共同遵守。0 表示不设全局上限。': ['Allowance is reserved before requests. Concurrent tasks share it. Set 0 for no global limit.', '發起請求前預留額度，並行任務共同遵守。0 表示不設全域上限。'],
  '今日预算占用：{p0}': ['Today’s accounted usage: {p0}', '今日預算占用：{p0}'],
  '保存预算': ['Save budget', '儲存預算'],
  '服务未返回用量或请求中断时，按预留量计入预算。预留量是保守估算；实际计费以服务商账单为准。': ['Missing usage and interrupted requests count against the reserved allowance. Reservations are conservative estimates; consult your provider’s invoice for actual charges.', '服務未回傳用量或請求中斷時，按預留量計入預算。預留量是保守估算；實際計費以服務商帳單為準。'],
  '最近模型调用': ['Recent model calls', '最近模型呼叫'],
  '用途': ['Purpose', '用途'],
  '预算占用': ['Accounted allowance', '預算占用'],
  '输入 {p0} · 输出 {p1}': ['Input {p0} · Output {p1}', '輸入 {p0} · 輸出 {p1}'],
  '未报告': ['Not reported', '未回報'],
  '账本启用后，实际发起的模型请求会出现在这里。': ['Model requests made after the ledger was enabled appear here.', '帳本啟用後，實際發起的模型請求會出現在這裡。'],
  '定义想持续达成的结果，助手按实际进展安排每一轮工作。': ['Define an ongoing outcome. The assistant plans each round from actual progress.', '定義想持續達成的結果，助手按實際進展安排每一輪工作。'],
  '新的长期目标': ['New long-term goal', '新的長期目標'],
  '编辑长期目标': ['Edit long-term goal', '編輯長期目標'],
  '想持续达成什么': ['What do you want to keep achieving?', '想持續達成什麼'],
  '用自己的话描述目标、可用资料和希望看到的结果。': ['Describe your goal, available sources and desired results in your own words.', '用自己的話描述目標、可用資料和希望看到的結果。'],
  '如何检查效果（可选）': ['How to check results (optional)', '如何檢查效果（選填）'],
  '约束条件（可选）': ['Constraints (optional)', '約束條件（選填）'],
  '例如：资料范围、需要保留的记录、什么时候找你。': ['For example: source scope, records to retain and when to contact you.', '例如：資料範圍、需要保留的記錄、什麼時候找你。'],
  '最短检查间隔（分钟）': ['Minimum check interval (minutes)', '最短檢查間隔（分鐘）'],
  '最长检查间隔（分钟）': ['Maximum check interval (minutes)', '最長檢查間隔（分鐘）'],
  '目标每日 token 预算': ['Daily tokens for this goal', '目標每日 token 預算'],
  '每轮 token 预算': ['Tokens per round', '每輪 token 預算'],
  '沿用已授权工具；新增权限或无法核对的操作会暂停。电脑需保持开机联网，后台需持续运行。': ['Existing tool permissions apply. New permissions and unverifiable actions pause execution. Keep this computer on, connected and the execution host running.', '沿用已授權工具；新增權限或無法核對的操作會暫停。電腦需保持開機連網，背景程式需持續執行。'],
  '创建并开始': ['Create and start', '建立並開始'],
  '保存为暂停状态': ['Save paused', '儲存為暫停狀態'],
  '正在读取长期目标…': ['Loading long-term goals…', '正在讀取長期目標…'],
  '把一个持续目标交给助手': ['Give the assistant an ongoing goal', '把一個持續目標交給助手'],
  '每轮留下真实结果、用量记录与下一步安排，你随时可以暂停或修改。': ['Each round retains actual results, usage and the next step. Pause or edit whenever needed.', '每輪留下真實結果、用量記錄與下一步安排，你隨時可以暫停或修改。'],
  '定义第一个目标': ['Define your first goal', '定義第一個目標'],
  '长期目标列表': ['Long-term goal list', '長期目標清單'],
  '已执行 {p0} 轮': ['{p0} rounds started', '已執行 {p0} 輪'],
  '修改目标': ['Edit goal', '修改目標'],
  '持续运行': ['Running continuously', '持續執行'],
  '复核本轮': ['Reviewing this round', '複核本輪'],
  '需要处理': ['Needs attention', '需要處理'],
  '预算暂停': ['Paused by budget', '預算暫停'],
  '先检查现状并制定本轮计划': ['Check the current state and plan this round', '先檢查現況並制定本輪計畫'],
  '下次执行': ['Next run', '下次執行'],
  '当前轮处理中': ['Current round in progress', '目前輪次處理中'],
  '等待继续': ['Waiting to resume', '等待繼續'],
  '今日预算占用': ['Today’s accounted usage', '今日預算占用'],
  '查看用量': ['View usage', '查看用量'],
  '查看当前轮任务': ['Open current task', '查看目前輪次任務'],
  '现在检查': ['Check now', '現在檢查'],
  '检查标准与约束': ['Checks and constraints', '檢查標準與約束'],
  '每轮结果与调整': ['Results and adjustments by round', '每輪結果與調整'],
  '第 {p0} 轮': ['Round {p0}', '第 {p0} 輪'],
  '查看执行记录': ['View execution record', '查看執行記錄'],
  '查看本轮结果': ['View this round’s result', '查看本輪結果'],
  '首轮完成并复核后，结果与下一步会留在这里。': ['The first verified result and next step will appear here.', '首輪完成並複核後，結果與下一步會留在這裡。'],
  '执行': ['Execution', '執行'], '理解': ['Understanding', '理解'], '规划': ['Planning', '規劃'], '复核': ['Review', '複核'],
  '记忆整理': ['Memory update', '記憶整理'], '目标复核': ['Goal review', '目標複核'], '连接测试': ['Connection test', '連線測試'],
  '已报告': ['Reported', '已回報'], '未发出': ['Not sent', '未發出'], '请求失败': ['Request failed', '請求失敗'],
  '其他调用': ['Other calls', '其他呼叫'],
  '正在检查本轮结果并安排下一步': ['Checking this round and planning the next step', '正在檢查本輪結果並安排下一步'],
  '本轮复核没有给出有效的下一步，已停止自动安排': ['Review did not provide a valid next step. Automatic scheduling has stopped.', '本輪複核未提供有效的下一步，已停止自動安排'],
  '关联任务记录缺失，已停止自动安排': ['The linked task record is missing. Automatic scheduling has stopped.', '關聯任務記錄遺失，已停止自動安排'],
  '复核期间后台中断，请检查已完成的任务后继续': ['The host stopped during review. Check the completed task before resuming.', '複核期間背景程式中斷，請檢查已完成的任務後繼續'],
  '要求已保存，继续后会先核对已有进度': ['Changes saved. Existing progress will be checked when resumed.', '要求已儲存，繼續後會先核對已有進度'],
  '本轮暂停或结果需要核对，请先检查关联任务': ['This round is paused or needs verification. Check the linked task first.', '本輪暫停或結果需要核對，請先檢查關聯任務'],
  '剩余 token 预算不足，已在请求模型前暂停。可提高预算或等待下一个预算日。': ['The remaining token allowance is insufficient. No model request was sent. Increase the budget or wait for the next budget day.', '剩餘 token 預算不足，已在請求模型前暫停。可提高預算或等待下一個預算日。'],
};
for (const [locale, index] of [['en', 0], ['zh-TW', 1]]) {
  const file = path.join(__dirname, '..', 'electron', 'locales', locale + '.json');
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [key, values] of Object.entries(additions)) catalog[key] = values[index];
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
}
console.log('Updated long-goal and usage translations.');
const ts = require('typescript');
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../electron/locales/en.json'), 'utf8'));
const missing = new Set();
for (const file of ['LongGoalsPage.tsx', 'UsagePanel.tsx']) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && !Object.hasOwn(catalog, node.arguments[0].text)) missing.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (missing.size) { console.error('Missing translations: ' + JSON.stringify([...missing])); process.exitCode = 1; }
