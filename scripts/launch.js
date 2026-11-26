// Supervise the actual Electron process, optionally independently of the console.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const RESTART = 75;
function launch(entry = root, reopen = false) {
  const env = { ...process.env, VI_SUPERVISED: '1', VI_REOPEN_SETTINGS: reopen ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  const executable = process.env.VI_PACKAGED==='1' ? process.execPath : require('electron');
  const child = spawn(executable, [entry], { cwd: root, env, stdio: 'inherit' });
  child.once('error', e => { console.error('Electron launch failed:', e.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    if (code === RESTART) { console.log('Voice Invoker: перезапуск завершён, запускаю новый экземпляр...'); launch(entry, true); }
    else process.exitCode = code === 0 && !signal ? 0 : (code || 1);
  });
}
// Detached supervisor has no inherited console or pipe handles. Its diagnostic
// output survives closing the original terminal. It exits when Electron exits.
function launchBackground(entry = root) {
  const fd = fs.openSync(path.join(root, 'launcher.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, ['-e', 'require("./scripts/launch").launch(process.argv[1])', entry], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    });
  } finally { fs.closeSync(fd); }
  child.once('error', e => { console.error('Background launch failed:', e.message); process.exitCode = 1; });
  child.once('spawn', () => {
    console.log('Voice Invoker background supervisor PID ' + child.pid);
    child.unref();
  });
}
if (require.main === module) {
  try {
    if (process.argv.includes('--background')) launchBackground();
    else launch();
  } catch (e) { console.error('Launch failed:', e.message); process.exitCode = 1; }
}
module.exports = { launch, launchBackground };
