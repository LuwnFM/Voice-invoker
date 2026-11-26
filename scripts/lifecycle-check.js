const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packaged=process.env.VI_PACKAGED==='1';
const exe=packaged?path.resolve(root,'..','..','VoiceInvoker.exe'):path.join(root,'node_modules','electron','dist','electron.exe');
const launcher=packaged?exe:process.execPath;
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'vi-lifecycle-'));
const config = path.join(root,'config.json');
const original = fs.readFileSync(config);
const base = 'http://127.0.0.1:3055';
const env = {...process.env, VI_LIFECYCLE_DIR:dir, VI_EXE:exe};
if(packaged)env.ELECTRON_RUN_AS_NODE='1';else delete env.ELECTRON_RUN_AS_NODE;
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
function pids() {
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='" + path.basename(exe) + "'\" | Where-Object { $_.ExecutablePath -eq $env:VI_EXE } | ForEach-Object { $_.ProcessId }";
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{env,encoding:'utf8'}).trim().split(/\s+/).filter(Boolean).map(Number);
}
async function waitFor(label, fn, ms=60000) {
  const start=Date.now();
  while(Date.now()-start<ms){
    try {const value=await fn();if(value)return value;}catch{}
    await pause(500);
  }
  throw Error('Timeout: '+label+'; Electron PIDs: '+pids().join(','));
}
function pid(){return Number(fs.readFileSync(path.join(dir,'pid'),'utf8'));}
async function ready(previous=0) {
  return waitFor('new application and native hook ready',async()=>{
    const current=pid();
    if(!current||current===previous||!pids().includes(current))return false;
    const r=await fetch(base+'/config',{signal:AbortSignal.timeout(2000)});
    if(!r.ok)return false;
    const log=fs.readFileSync(path.join(root,'log.txt'),'utf8');
    return log.includes('Хук клавиатуры установлен')&&current;
  });
}
(async()=>{
  fs.writeFileSync(config,JSON.stringify({...JSON.parse(original),windowTitle:'Voice Invoker lifecycle test only',blockKeys:[],listen:'hold',keys:{quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F'}}));
  assert.deepEqual(pids(),[],'No pre-existing test Electron');
  const args=['-e','require("./scripts/launch").launchBackground(process.argv[1])',packaged?root:path.join(__dirname,'lifecycle-entry.js')];
  const start = () => {
    const child=spawnSync(launcher,args,{cwd:root,env,encoding:'utf8',timeout:15000});
    assert.equal(child.status,0,child.stderr || String(child.error || ''));
    const pid=Number(/supervisor PID (\d+)/.exec(child.stdout)?.[1]);
    assert.ok(pid, child.stdout);
    return pid;
  };
  const supervisor=start();
  console.log('Initial launcher exited, detached supervisor PID',supervisor);
  const first=await ready();
  console.log('Initial Electron PID',first,'processes',pids());
  const duplicate=start();
  assert.equal(pid(),first);
  await waitFor('duplicate opens settings',()=>fs.existsSync(path.join(dir,'settings-'+first)));
  console.log('Duplicate launch: existing instance settings visible');
  // Disabled aliases must disappear from the live grammar after restart.
  const preferences=await (await fetch(base+'/config')).json();
  const disabled={...preferences.disabledPhrases,invoker_emp:preferences.phraseCatalog.invoker_emp};
  const saved=await fetch(base+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({disabledPhrases:disabled,testOnly:true,itemPhrases:{item_slot_item1:['прыжок'],item_slot_neutral:['щит'],item_slot_teleport:['телепорт']}})});
  assert.equal(saved.status,200);
  const r=await fetch(base+'/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(r.status,204);
  const second=await ready(first);
  await waitFor('old main process gone',()=>!pids().includes(first));
  await waitFor('settings reopen after restart',()=>fs.existsSync(path.join(dir,'settings-'+second)));
  assert.ok(!fs.readFileSync(path.join(root,'log.txt'),'utf8').includes('Скачиваю модель Invoker V2'));
  const grammar=await (await fetch(base+'/grammar')).json();
  assert.ok(preferences.phraseCatalog.invoker_emp.every(p=>!grammar.includes(p)));
  for(const p of ['прыжок','щит','телепорт'])assert.ok(grammar.includes(p),'Missing custom phrase '+p);
  const diag=await (await fetch(base+'/diagnostics')).json();assert.equal(diag.testOnly,true);
  const testResult=await fetch(base+'/voice',{method:'POST',body:JSON.stringify({texts:['торнадо']})});assert.equal(testResult.status,204);
  const checked=await (await fetch(base+'/diagnostics')).json();assert.deepEqual(checked.lastTest.matched,['торнадо']);
  assert.ok(!fs.readFileSync(path.join(root,'log.txt'),'utf8').includes('"торнадо" ->'));
  console.log('Disabled aliases persisted, test mode records match without dispatch');
  console.log('Restarted Electron PID',second,'processes',pids());
  fs.writeFileSync(path.join(dir,'quit-'+second),'quit');
  await waitFor('all Electron processes gone',()=>pids().length===0);
  const running = id => { try { process.kill(id,0); return true; } catch(e) { if(e.code==='ESRCH') return false; throw e; } };
  await waitFor('both background supervisors exited',()=>!running(supervisor)&&!running(duplicate));
  const dist=packaged?exe:path.dirname(exe),moved=dist+'.lifecycle-check';
  // Windows can release executable mapping / antivirus handles shortly after the
  // last process exits. Require a real rename, within a bounded grace period.
  const releasedAt=Date.now();
  await waitFor('runtime directory released',()=>{
    try { fs.renameSync(dist,moved); return true; }
    catch (e) { if (['EPERM','EBUSY','EACCES'].includes(e.code)) return false; throw e; }
  },15000);
  fs.renameSync(moved,dist);
  console.log('Runtime files released after',Date.now()-releasedAt,'ms');
  console.log('PASS: launcher exited, duplicate blocked, settings visible, detached supervised restart, cached model, normal quit, zero Electron processes and supervisors, runtime directory rename');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  for(const id of pids()) {try{execFileSync('taskkill.exe',['/PID',String(id),'/T','/F'],{stdio:'ignore'});}catch{}}
  fs.writeFileSync(config,original);
  fs.rmSync(dir,{recursive:true,force:true});
});
