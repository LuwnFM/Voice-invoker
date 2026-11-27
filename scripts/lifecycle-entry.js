// Test adapter: exercise the application's normal quit and window lifecycle.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
require('../main');
if (app.hasSingleInstanceLock()) {
  const dir = process.env.VI_LIFECYCLE_DIR;
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  let checking=false;
  const timer = setInterval(() => {
    const settings=BrowserWindow.getAllWindows().find(w=>w.isVisible()&&w.getTitle().includes('настройки'));
    if(settings){
      fs.writeFileSync(path.join(dir,'settings-'+process.pid),'visible');
      const marker=path.join(dir,'diagnostics-ui-'+process.pid);
      if(!checking&&!fs.existsSync(marker)){
        checking=true;
        settings.webContents.executeJavaScript("document.querySelectorAll('#diagnostics .diag-row').length >= 7 && !!document.querySelector('#diagSummary') && !!document.querySelector('#copyReport') && !!document.querySelector('#pickDota') && !!document.querySelector('#previewSun') && document.querySelector('.brand-header img')?.naturalWidth > 0").then(ok=>{if(ok)fs.writeFileSync(marker,'ready');}).catch(()=>{}).finally(()=>{checking=false;});
      }
    }
    if (fs.existsSync(path.join(dir, 'quit-'+process.pid))) {
      clearInterval(timer);
      app.quit();
    }
  }, 100);
}
