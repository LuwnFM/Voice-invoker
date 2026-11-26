// Test adapter: exercise the application's normal quit and window lifecycle.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
require('../main');
if (app.hasSingleInstanceLock()) {
  const dir = process.env.VI_LIFECYCLE_DIR;
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  const timer = setInterval(() => {
    if (BrowserWindow.getAllWindows().some(w => w.isVisible() && w.getTitle().includes('настройки'))) {
      fs.writeFileSync(path.join(dir, 'settings-'+process.pid), 'visible');
    }
    if (fs.existsSync(path.join(dir, 'quit-'+process.pid))) {
      clearInterval(timer);
      app.quit();
    }
  }, 100);
}
