const fs=require('node:fs'),path=require('node:path');
const entries=[
['退出界面后，后台任务仍会继续；需要确认时保持等待。','Tasks continue after you exit the interface. Approvals remain pending until you return.','退出介面後，背景任務仍會繼續；需要確認時保持等待。'],
['后台未连接，任务不会从这个界面派发。','Background execution is disconnected. This interface will not dispatch tasks.','背景未連線，任務不會從這個介面派發。'],
['后台执行在线','Background execution online','背景執行在線'],
['后台执行已停止','Background execution stopped','背景執行已停止'],
['正在暂停后台任务','Pausing background tasks','正在暫停背景任務'],
['正在连接后台','Connecting to background execution','正在連線背景'],
['后台连接中断','Background connection lost','背景連線中斷'],
['后台执行控制','Background execution controls','背景執行控制'],
['关闭界面不影响执行。停止后台会暂停任务。','Closing the interface keeps tasks running. Stopping background execution pauses tasks.','關閉介面不影響執行。停止背景會暫停任務。'],
['启动后台后，已暂停的任务仍由你决定何时继续。','Starting background execution keeps paused tasks paused until you resume them.','啟動背景後，已暫停的任務仍由你決定何時繼續。'],
['退出界面，任务继续','Exit interface and keep tasks running','退出介面，任務繼續'],
['停止后台执行','Stop background execution','停止背景執行'],
['启动后台执行','Start background execution','啟動背景執行'],
['停止后台并退出','Stop background execution and quit','停止背景並退出'],
];
for(const [locale,column]of[['en',1],['zh-TW',2]]){const file=path.join(__dirname,'../electron/locales',locale+'.json'),catalog=JSON.parse(fs.readFileSync(file,'utf8'));for(const entry of entries)catalog[entry[0]]=entry[column];fs.writeFileSync(file,JSON.stringify(catalog,null,2)+'\n');}
