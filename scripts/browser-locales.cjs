const fs = require('node:fs');
const path = require('node:path');
const rows = {
  '浏览器': ['Browser', '瀏覽器'],
  '人工接管': ['Manual control', '人工接管'], '悬停网页': ['Hover on page', '懸停網頁'], '拖动网页': ['Drag on page', '拖動網頁'],
  '跟随当前任务': ['Follow active task', '跟隨目前任務'],
  '人工接管中，助手已暂停此页的自动操作。': ['You have control. The assistant has paused automation on this page.', '人工接管中，助手已暫停此頁的自動操作。'], '交还助手': ['Return control', '交還助手'],
  '输入': ['Type', '輸入'], '后退': ['Back', '上一頁'], '前进': ['Forward', '下一頁'], '处理中…': ['Working…', '處理中…'], '下载': ['Downloads', '下載'], '连接': ['Connect', '連接'], '确认': ['Confirm', '確認'],
  '让助手在网页中工作，随时查看进度或接管。登录状态会保留。': ['Let the assistant work on the web. Follow its progress or take over at any time. Sign-ins are saved.', '讓助手在網頁中工作，隨時查看進度或接管。登入狀態會保留。'],
  '新标签页': ['New tab', '新分頁'], '内置': ['Built-in', '內建'], '外部': ['External', '外部'],
  '内置浏览器': ['Built-in browser', '內建瀏覽器'], '浏览器类型': ['Browser type', '瀏覽器類型'],
  '请在桌面程序中使用浏览器': ['Open the desktop app to use the browser', '請在桌面程式中使用瀏覽器'],
  '浏览器由独立后台运行，关闭主界面后仍可继续任务。': ['The browser runs in the background, so tasks can continue after the main window closes.', '瀏覽器由獨立背景程序執行，關閉主視窗後仍可繼續任務。'],
  '登录档案已保存到本机': ['Sign-in profiles are stored locally', '登入設定檔已儲存到本機'],
  '连接已有浏览器': ['Connect an existing browser', '連接現有瀏覽器'],
  '连接已开启本机调试端口的 Chrome 或 Edge。日常浏览器也可通过桌面控制操作。': ['Connect Chrome or Edge with a local debugging port. Regular browser windows also support desktop control.', '連接已開啟本機偵錯連接埠的 Chrome 或 Edge。日常瀏覽器也可透過桌面控制操作。'],
  '本机连接地址': ['Local connection address', '本機連接位址'], '网页标签': ['Browser tabs', '網頁分頁'],
  '关闭网页': ['Close tab', '關閉網頁'], '网页地址': ['Web address', '網頁位址'],
  '输入网址，开始浏览': ['Enter a website address', '輸入網址，開始瀏覽'], '前往': ['Go', '前往'],
  '打开窗口接管': ['Open window to take over', '開啟視窗接管'], '刷新网页': ['Reload page', '重新載入網頁'],
  '重新观察': ['Observe again', '重新觀察'], '我已核对结果': ['I have checked the result', '我已核對結果'],
  '网页对话框': ['Website dialog', '網頁對話框'], '当前真实网页': ['Live browser page', '目前實際網頁'],
  '正在连接真实网页…': ['Connecting to the live page…', '正在連接實際網頁…'],
  '把网页工作交给助手': ['Give web work to your assistant', '把網頁工作交給助手'],
  '打开网站后，可以直接让助手查资料、填写表单、上传文件并核对结果。': ['Open a website, then ask the assistant to research, fill in forms, upload files, and check the results.', '開啟網站後，可以直接讓助手查資料、填寫表單、上傳檔案並核對結果。'],
  '内置与外部浏览器': ['Built-in and external browsers', '內建與外部瀏覽器'], '独立后台执行': ['Runs in the background', '獨立背景執行'],
  '下载与操作可追踪': ['Track actions and downloads', '下載與操作可追蹤'], '向网页输入文字': ['Type into the website', '向網頁輸入文字'],
  '先点击网页输入框，再在此输入文字': ['Click a website field, then enter text here', '先點選網頁輸入框，再在此輸入文字'],
  '回车': ['Enter', 'Enter'], '向下滚动': ['Scroll down', '向下捲動'], '执行记录': ['Activity', '執行記錄'], '页面内容': ['Page text', '頁面內容'],
  '助手和你的网页操作会出现在这里。': ['Your actions and the assistant’s web activity appear here.', '助手和你的網頁操作會顯示在這裡。'],
  '已执行并回读': ['Executed and checked', '已執行並讀回'], '结果待核对': ['Result needs checking', '結果待核對'],
  '下载完成': ['Download complete', '下載完成'], '下载中': ['Downloading', '下載中'], '下载中断': ['Download interrupted', '下載中斷'],
  '在文件夹中显示': ['Show in folder', '在資料夾中顯示'],
  '内置和专用浏览器的下载会保存在本机，并显示实际状态。': ['Downloads from built-in and dedicated browsers are saved locally with their actual status.', '內建和專用瀏覽器的下載會儲存在本機，並顯示實際狀態。'],
  '读取当前页面': ['Read current page', '讀取目前頁面'], '可操作元素：{p0}': ['Interactive elements: {p0}', '可操作元素：{p0}'],
  '正在执行并核对结果': ['Working and checking the result', '正在執行並核對結果'],
  '点击网页可操作，登录时可打开窗口接管': ['Click the page to interact. Open its window to sign in.', '點選網頁可操作，登入時可開啟視窗接管'],
  '选择浏览器并输入网址即可开始': ['Choose a browser and enter a website to start', '選擇瀏覽器並輸入網址即可開始'],
  '关闭主界面后，后台任务仍可继续': ['Background tasks continue after the main window closes', '關閉主視窗後，背景任務仍可繼續'],
  '上次操作结果不确定，请重新观察并核对。': ['The previous action has an uncertain result. Observe and check it before continuing.', '上次操作結果不確定，請重新觀察並核對。'],
  '打开网页': ['Open website', '開啟網頁'], '导航网页': ['Navigate page', '瀏覽網頁'], '点击网页': ['Click page element', '點選網頁'],
  '填写表单': ['Fill in form', '填寫表單'], '选择选项': ['Select an option', '選擇選項'], '网页按键': ['Press a key', '網頁按鍵'],
  '滚动网页': ['Scroll page', '捲動網頁'], '上传文件': ['Upload file', '上傳檔案'], '下载文件': ['Download file', '下載檔案'],
  '处理网页对话框': ['Handle website dialog', '處理網頁對話框'], '核对上次操作结果': ['Verify previous result', '核對上次操作結果'],
};
for (const [index, locale] of ['en', 'zh-TW'].entries()) {
  const file = path.join(__dirname, '../electron/locales', locale + '.json');
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [key, values] of Object.entries(rows)) catalog[key] = values[index];
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
}
console.log(JSON.stringify({ browserTranslations: Object.keys(rows).length, locales: ['en', 'zh-TW'] }));
