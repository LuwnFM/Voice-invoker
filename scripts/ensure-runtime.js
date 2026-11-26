// Windows bootstrap: verify installed binaries, repair Electron from the locked
// package checksum, and never approve arbitrary lifecycle scripts.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const lock = require('../package-lock.json');
const electronDir = path.join(root, 'node_modules', 'electron');
const exe = path.join(electronDir, 'dist', 'electron.exe');
const run = (file, args, options = {}) => {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(file + ' exited ' + result.status);
};
function validZip(file, expected) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === expected.toLowerCase(); }
  catch { return false; }
}
function findCached(cache, name, expected) {
  try {
    for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(cache, entry.name, name);
      if (validZip(file, expected)) return file;
    }
  } catch {}
  return null;
}
function repairElectron() {
  const version = lock.packages['node_modules/electron'].version;
  const name = 'electron-v' + version + '-win32-x64.zip';
  const checksums = JSON.parse(fs.readFileSync(path.join(electronDir, 'checksums.json'), 'utf8'));
  const expected = checksums[name];
  if (!/^[a-f0-9]{64}$/i.test(expected || '')) throw new Error('Missing locked Electron checksum');
  const cache = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'electron', 'Cache');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-invoker-electron-'));
  try {
    let zip = findCached(cache, name, expected);
    if (!zip) {
      zip = path.join(temp, name);
      run('curl.exe', ['--fail', '--location', '--retry', '2', '--connect-timeout', '20', '--max-time', '600', '--output', zip, 'https://github.com/electron/electron/releases/download/v' + version + '/' + name]);
    }
    if (!validZip(zip, expected)) throw new Error('Electron ZIP SHA-256 mismatch');
    console.log('Electron ZIP SHA-256 OK; extracting...');
    const stage = path.join(temp, 'dist');
    fs.mkdirSync(stage);
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(tar)) run(tar, ['-xf', zip, '-C', stage]);
    else run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:VI_ZIP, $env:VI_DIST)'], { env: { ...process.env, VI_ZIP: zip, VI_DIST: stage } });
    if (!fs.existsSync(path.join(stage, 'electron.exe'))) throw new Error('Electron executable missing after extraction');
    fs.rmSync(path.join(electronDir, 'dist'), { recursive: true, force: true });
    fs.cpSync(stage, path.join(electronDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function verify() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  run(exe, ['-e', 'require("koffi").load("user32.dll");require.resolve("vosk-browser/dist/vosk.js");console.log("Electron/Koffi/Vosk runtime OK",process.versions.electron)'], { env });
}
function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 Node.js required');
  const env = { ...process.env };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  const required = ['electron', 'koffi', 'vosk-browser'];
  const installed = () => required.every(name => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version === lock.packages['node_modules/' + name].version; }
    catch { return false; }
  });
  const npm = args => run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm', ...args], { env });
  if (!installed()) npm(['ci', '--include=dev']);
  if (!fs.existsSync(exe) || !fs.existsSync(path.join(electronDir, 'path.txt'))) repairElectron();
  try { verify(); }
  catch {
    console.log('Runtime check failed; reinstalling locked dependencies once...');
    npm(['ci', '--include=dev']);
    if (!fs.existsSync(exe) || !fs.existsSync(path.join(electronDir, 'path.txt'))) repairElectron();
    verify();
  }
}
if (require.main === module) {
  try { main(); } catch (e) { console.error('Runtime setup failed:', e.message); process.exitCode = 1; }
}
module.exports = { validZip, findCached };
