// Keep the same console and wait for the actual Electron process on restart.
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const RESTART = 75;
function launch(entry = root, reopen = false) {
  const env = { ...process.env, VI_SUPERVISED: '1', VI_REOPEN_SETTINGS: reopen ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  const child = spawn(require('electron'), [entry], { cwd: root, env, stdio: 'inherit' });
  child.once('error', e => { console.error('Electron launch failed:', e.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    if (code === RESTART) { console.log('Voice Invoker: перезапуск завершён, запускаю новый экземпляр...'); launch(entry, true); }
    else process.exitCode = code === 0 && !signal ? 0 : (code || 1);
  });
}
if (require.main === module) launch();

module.exports = { launch };
