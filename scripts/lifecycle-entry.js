// Test adapter: exercise the application's normal quit and window lifecycle.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
require('../main');
if (app.hasSingleInstanceLock()) {
  const dir = process.env.VI_LIFECYCLE_DIR;
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  let checking=false,checkingDictionary=false;
  const timer = setInterval(() => {
    const settings=BrowserWindow.getAllWindows().find(w=>w.isVisible()&&w.getTitle().includes('настройки'));
    if(settings){
      fs.writeFileSync(path.join(dir,'settings-'+process.pid),'visible');
      const marker=path.join(dir,'diagnostics-ui-'+process.pid);
      if(!checking&&!fs.existsSync(marker)){
        checking=true;
        settings.webContents.executeJavaScript("document.querySelectorAll('#diagnostics .diag-row').length >= 7 && !!document.querySelector('#diagSummary') && !!document.querySelector('#copyReport') && !!document.querySelector('#pickDota') && !!document.querySelector('#previewSun') && document.querySelector('.brand-header img')?.naturalWidth > 0").then(ok=>{if(ok)fs.writeFileSync(marker,'ready');}).catch(()=>{}).finally(()=>{checking=false;});
      }
      const dictionaryMarker=path.join(dir,'dictionary-ui-'+process.pid);
      if(!checkingDictionary&&!fs.existsSync(dictionaryMarker)){
        checkingDictionary=true;
        settings.webContents.executeJavaScript(`(async()=>{
          const spell=document.querySelector('#phrases input[placeholder="Новая фраза"]');
          const item=document.querySelector('[data-item-phrase]');
          if(!spell||!item)return false;
          const spellFeedback=spell.closest('details').querySelector('[data-dictionary]');
          const itemFeedback=item.closest('details').querySelector('[data-dictionary]');
          const add=spell.parentElement.querySelector('button');
          const original=item.value;
          const type=(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
          const until=async predicate=>{for(let i=0;i<60;i++){if(predicate())return true;await new Promise(r=>setTimeout(r,100));}return false;};
          try{
            type(spell,'ураган');type(item,'буря');
            if(!await until(()=>spellFeedback.classList.contains('good')&&itemFeedback.classList.contains('good')&&!add.disabled))return false;
            type(spell,'несуществующеесловоxyz');type(item,'буря\\nнесуществующеесловоxyz');
            return await until(()=>spellFeedback.classList.contains('bad')&&itemFeedback.classList.contains('bad')&&add.disabled);
          }finally{type(spell,'');type(item,original);}
        })()`).then(ok=>{if(ok)fs.writeFileSync(dictionaryMarker,'ready');}).catch(()=>{}).finally(()=>{checkingDictionary=false;});
      }
    }
    if (fs.existsSync(path.join(dir, 'quit-'+process.pid))) {
      clearInterval(timer);
      app.quit();
    }
  }, 100);
}
