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
const original = fs.readFileSync(config,'utf8');
const dataDir=path.join(dir,'user-data');
const migratedConfig=path.join(dataDir,'config.json');
const bindingFile=path.join(dir,'dotakeys_personal.lst');
const bindingFixture=(quas,voice)=>'"KeyBindings" { "Keys" { '+Object.entries({AbilityPrimary1:quas,AbilityPrimary2:'W',AbilityPrimary3:'E',AbilityUltimate:'R',AbilitySecondary1:'D',AbilitySecondary2:'F',ChatVoiceTeam:voice}).map(([action,key])=>'"'+action+'" { "Key" "'+key+'" }').join(' ')+' } }';
fs.writeFileSync(bindingFile,bindingFixture('Q','G'));
const base = 'http://127.0.0.1:3055';
/** @type {NodeJS.ProcessEnv} */
const env = {...process.env, VI_LIFECYCLE_DIR:dir, VI_EXE:exe, VI_DATA_DIR:dataDir, VI_BINDINGS_FILE:bindingFile};
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
    const log=fs.readFileSync(path.join(dataDir,'log.txt'),'utf8');
    return log.includes('Хук клавиатуры установлен')&&current;
  });
}
(async()=>{
  fs.writeFileSync(config,JSON.stringify({...JSON.parse(original),windowTitle:'Voice Invoker lifecycle test only',blockKeys:[],listen:'hold',keys:{quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F'}}));
  assert.deepEqual(pids(),[],'No pre-existing test Electron');
  const args=['-e','require("./scripts/launch").launchBackground(process.argv[1])',packaged?root:path.join(__dirname,'lifecycle-entry.js')];
  const start = () => {
    const child=packaged&&process.env.VI_TEST_START_BAT==='1'
      ?spawnSync('cmd.exe',['/d','/c','start.bat'],{cwd:root,env:{...env,PATH:[path.join(process.env.SystemRoot||'C:\\Windows','System32'),path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0'),process.env.SystemRoot||'C:\\Windows'].join(';')},encoding:'utf8',timeout:45000})
      :spawnSync(launcher,args,{cwd:root,env,encoding:'utf8',timeout:15000});
    assert.equal(child.status,0,child.stderr || String(child.error || ''));
    const pid=Number(/supervisor PID (\d+)/.exec(String(child.stdout))?.[1]);
    assert.ok(pid, child.stdout);
    return pid;
  };
  const supervisor=start();
  console.log('Initial launcher exited, detached supervisor PID',supervisor);
  const first=await ready();
  const legacy=fs.readFileSync(config,'utf8');
  assert.equal(fs.readFileSync(migratedConfig,'utf8'),legacy,'Legacy RC6/RC7 config migration failed');
  console.log('Initial Electron PID',first,'processes',pids());
  const duplicate=start();
  assert.equal(pid(),first);
  await waitFor('duplicate opens settings',()=>fs.existsSync(path.join(dir,'settings-'+first)));
  await waitFor('original-style diagnostic controls rendered',()=>fs.existsSync(path.join(dir,'diagnostics-ui-'+first)));
  console.log('Duplicate launch: existing instance settings and diagnostic controls visible');
  await waitFor('watcher registered',async()=> (await (await fetch(base+'/diagnostics')).json()).bindingWatching);
  fs.writeFileSync(bindingFile+'.tmp',bindingFixture('A','T'));fs.renameSync(bindingFile+'.tmp',bindingFile);
  await waitFor('live binding acknowledgement and persistence',async()=>{const c=await (await fetch(base+'/config')).json();return c.bindingGeneration>0&&c.keys.quas==='A'&&c.voiceChatKey==='T'&&JSON.parse(fs.readFileSync(migratedConfig,'utf8')).keys.quas==='A';});
  assert.equal(pid(),first,'Binding sync must not restart Electron');
  fs.writeFileSync(bindingFile,bindingFixture('A','A'));
  await waitFor('conflicting binding rejected',async()=> (await (await fetch(base+'/diagnostics')).json()).bindingNotice.includes('Конфликт'));
  assert.equal((await (await fetch(base+'/config')).json()).voiceChatKey,'T');
  fs.writeFileSync(bindingFile,bindingFixture('A','T'));
  console.log('PASS: live file replacement, native acknowledgement, persistence and conflicting binding rejection without Electron restart');
  const reportResponse=await fetch(base+'/copy-report',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(reportResponse.status,204);
  // Disabled aliases must disappear from the live grammar after restart.
  const preferences=await (await fetch(base+'/config')).json();
  const disabled={...preferences.disabledPhrases,invoker_emp:preferences.phraseCatalog.invoker_emp};
  const {readModelWords}=require('../model-words');
  const dictionary=readModelWords(path.join(root,'model',require('../model-manifest.json').filename));
  const used=new Set(Object.values(preferences.phraseCatalog).flat().flatMap(p=>String(p).split(' ')).concat(['ураган','буря','прыжок','щит','телепорт','запиши','записать','фолиант','готовь','готовить','подготовить','подготовь']));
  const candidates=[...dictionary].filter(w=>/^[а-яё]{5,}$/u.test(w)&&!used.has(w));
  const aliases=Object.fromEntries(Object.keys(preferences.phraseCatalog).map(id=>[id,id==='invoker_tornado'?['ураган','буря']:[candidates.shift()]]));
  assert.equal(Object.keys(aliases).length,11);assert.ok(Object.values(aliases).flat().every(w=>typeof w==='string'&&dictionary.has(w)));
  const saved=await fetch(base+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({disabledPhrases:disabled,testOnly:true,itemCastModes:{item_force_staff:'click'},customSpellPhrases:aliases,itemPhrases:{item_slot_item1:['прыжок','эмп'],item_slot_neutral:['щит'],item_slot_teleport:['телепорт']}})});
  assert.equal(saved.status,200);
  assert.equal(fs.readFileSync(config,'utf8'),legacy,'Migrating preferences must not overwrite legacy config');
  assert.equal(JSON.parse(fs.readFileSync(migratedConfig,'utf8')).testOnly,true);
  const pending=await (await fetch(base+'/config')).json();assert.deepEqual(pending.itemCastModes,{item_force_staff:'click'});
  const r=await fetch(base+'/restart',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(r.status,204);
  const second=await ready(first);
  await waitFor('old main process gone',()=>!pids().includes(first));
  await waitFor('settings reopen after restart',()=>fs.existsSync(path.join(dir,'settings-'+second)));
  assert.ok(!fs.readFileSync(path.join(dataDir,'log.txt'),'utf8').includes('Скачиваю модель Invoker V2'));
  const grammar=await (await fetch(base+'/grammar')).json();
  assert.ok(preferences.phraseCatalog.invoker_emp.filter(p=>p!=='эмп').every(p=>!grammar.includes(p)));
  assert.ok(grammar.includes('эмп'),'Disabled EMP alias reused for item');
  for(const p of ['прыжок','щит','телепорт','ураган','буря'])assert.ok(grammar.includes(p),'Missing custom phrase '+p);
  assert.ok(preferences.phraseCatalog.invoker_tornado.every(p=>grammar.includes(p)),'Built-in Tornado aliases lost');
  const updated=await (await fetch(base+'/config')).json();
  assert.deepEqual(updated.itemCastModes,{item_force_staff:'click'});
  for(const [id,phrases] of Object.entries(aliases)){assert.deepEqual(updated.customSpellPhrases[id],phrases);assert.ok(phrases.every(p=>grammar.includes(p)),'Custom phrase missing: '+id);}
  console.log('All 11 abilities accept custom phrases from verified V2 and reload after restart');
  const duplicateAlias=await fetch(base+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customSpellPhrases:{invoker_tornado:['прыжок']}})});
  assert.equal(duplicateAlias.status,500,'Spell/item duplicate accepted');
  const conflict=await fetch(base+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({disabledPhrases:{...disabled,invoker_emp:[]}})});
  assert.equal(conflict.status,500,'Re-enabling conflicting alias must be rejected');
  const diag=await (await fetch(base+'/diagnostics')).json();assert.equal(diag.testOnly,true);
  const preview=await fetch(base+'/preview-sun-strike',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(preview.status,204);
  const afterPreview=await (await fetch(base+'/diagnostics')).json();assert.deepEqual(afterPreview.lastTest,diag.lastTest,'Preview must not dispatch voice commands');
  const rejected=await fetch(base+'/voice',{method:'POST',body:JSON.stringify({texts:['торнадо']})});assert.equal(rejected.status,415);
  const foreign=await fetch(base+'/voice',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.invalid'},body:JSON.stringify({texts:['торнадо']})});assert.equal(foreign.status,403);
  const invalid=await fetch(base+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'null'});assert.equal(invalid.status,400);
  const oversized=await fetch(base+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({padding:'x'.repeat(256*1024)})});assert.equal(oversized.status,413);
  const keysConflict=await fetch(base+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys:{item1:'A'}})});assert.equal(keysConflict.status,500);
  const testResult=await fetch(base+'/voice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({texts:['торнадо']})});assert.equal(testResult.status,204);
  const checked=await (await fetch(base+'/diagnostics')).json();assert.deepEqual(checked.lastTest.matched,['торнадо']);
  assert.ok(!fs.readFileSync(path.join(dataDir,'log.txt'),'utf8').includes('"торнадо" ->'));
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
