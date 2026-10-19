// The home composer creates persistent tasks. Chat regression fixtures enter through chat history.
async function openSmokeChat(window) {
  await window.webContents.executeJavaScript(`(() => {const button=[...document.querySelectorAll('.presence-sidebar-footer button')].find(item=>item.textContent.trim()==='交流记录');if(!button)throw Error('missing chat history');button.click();})()`);
  for(let i=0;i<60;i++){
    const created=await window.webContents.executeJavaScript(`(() => {const button=[...document.querySelectorAll('.presence-history button')].find(item=>item.textContent.trim()==='新的交流');if(!button)return false;button.click();return true;})()`);
    if(created)return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('新的交流入口未就绪');
}
module.exports={openSmokeChat};
