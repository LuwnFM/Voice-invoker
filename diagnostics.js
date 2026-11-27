// Read-only diagnostics: inspect the running process and the saved Steam settings
// separately. Never edit Steam, close the game or apply input.
const {execFile}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const {parseVdf,readBindings}=require('./dota-bindings');
const flag=/ (?:-gamestateintegration)(?=\s|$)/i;
const hasFlag=value=>flag.test(' '+String(value||'').trim());
function chooseAccount(steam,active){
 const root=path.join(steam,'userdata');
 const ids=fs.readdirSync(root).filter(id=>/^\d+$/.test(id)&&id!=='0');
 if(active!==undefined&&active!==null)try{const id=String(BigInt(active));if(ids.includes(id))return id;}catch{}
 // Do not guess if multiple accounts are present. MostRecent is a saved
 // preference and not proof of the active account.
 return ids.length===1?ids[0]:null;
}
function savedLaunchOptions(text){
 const store=parseVdf(text).userlocalconfigstore;
 const apps=store?.software?.valve?.steam?.apps;
 if(!apps||typeof apps!=='object')return null;
 return hasFlag(apps['570']?.launchoptions);
}
function discoverDota(steam,exe){
 const valid=dir=>dir&&fs.existsSync(path.join(dir,'game','bin','win64','dota2.exe'));
 if(exe){const dir=path.resolve(path.dirname(exe),'..','..','..');if(valid(dir))return dir;}
 if(!steam)return null;
 const libs=[steam];
 try{
  const v=parseVdf(fs.readFileSync(path.join(steam,'steamapps','libraryfolders.vdf'),'utf8')).libraryfolders;
  for(const entry of Object.values(v||{}))if(entry&&typeof entry==='object'&&entry.path)libs.push(entry.path);
 }catch{}
 for(const lib of libs){
  const apps=path.join(lib,'steamapps');
  try{const install=parseVdf(fs.readFileSync(path.join(apps,'appmanifest_570.acf'),'utf8')).appstate?.installdir;
   if(install&&valid(path.join(apps,'common',install)))return path.join(apps,'common',install);
  }catch{}
  const standard=path.join(apps,'common','dota 2 beta');if(valid(standard))return standard;
 }
 return null;
}
function inspectSteam(steam,active){
 if(!steam)return {savedLaunchFlag:null,bindings:null,bindingsIssue:'steam-not-found'};
 try{
  const id=chooseAccount(steam,active);
  if(!id)return {savedLaunchFlag:null,bindings:null,bindingsIssue:'account-unknown'};
  const root=path.join(steam,'userdata',id);
  let savedLaunchFlag=null;
  try{savedLaunchFlag=savedLaunchOptions(fs.readFileSync(path.join(root,'config','localconfig.vdf'),'utf8'));}catch{}
  try{
   const bindings=readBindings(fs.readFileSync(path.join(root,'570','remote','cfg','dotakeys_personal.lst'),'utf8'));
   return {savedLaunchFlag,bindings,bindingsIssue:null};
  }catch{return {savedLaunchFlag,bindings:null,bindingsIssue:'bindings-unreadable'};}
 }catch{return {savedLaunchFlag:null,bindings:null,bindingsIssue:'account-unknown'};}
}
let state={running:null,launchFlag:null,steamRunning:null,steamPath:null,dotaPath:null,savedLaunchFlag:null,bindings:null,bindingsIssue:null},at=0,pending=null;
function processStatus(){
 if(Date.now()-at<5000)return Promise.resolve(state);
 if(pending)return pending;
 pending=new Promise(resolve=>{
   const script="$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter \"Name='dota2.exe'\" | Select-Object -First 1; $s=Get-Process steam -ErrorAction SilentlyContinue; $root=(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath; if(-not $root){$root=(Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -ErrorAction SilentlyContinue).InstallPath}; if(-not $root){$root=Join-Path ${env:ProgramFiles(x86)} 'Steam'}; $active=(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam\\ActiveProcess' -ErrorAction SilentlyContinue).ActiveUser; [pscustomobject]@{running=[bool]$p;commandLine=$p.CommandLine;exe=$p.ExecutablePath;steamRunning=[bool]$s;steamPath=$root;active=$active}|ConvertTo-Json -Compress";
   execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:4000},(err,out)=>{
     try{
       if(err)throw err;
       const data=JSON.parse(String(out||'').trim());
       const steam=data.steamPath&&fs.existsSync(path.join(data.steamPath,'steam.exe'))?data.steamPath:null;
       state={running:data.running,launchFlag:data.running&&data.commandLine?hasFlag(data.commandLine):null,steamRunning:data.steamRunning,steamPath:steam,dotaPath:discoverDota(steam,data.exe),...inspectSteam(steam,data.active)};
     }catch{state={running:null,launchFlag:null,steamRunning:null,steamPath:null,dotaPath:null,savedLaunchFlag:null,bindings:null,bindingsIssue:'process-unavailable'};}
     at=Date.now();pending=null;resolve(state);
   });
 });return pending;
}
function bindingSignature(bindings){
 if(!bindings||!Object.keys(bindings.keys||{}).length)return null;
 const ordered=value=>Object.entries(value||{}).sort(([a],[b])=>a.localeCompare(b));
 return JSON.stringify([ordered(bindings.keys),ordered(bindings.slotCastModes),[...(bindings.warnings||[])].sort()]);
}
function supportReport(d){
 // Explicit allowlist. Never copy raw log lines, local paths, microphone labels,
 // Steam account IDs, authentication tokens or user-defined phrases/transcripts.
 const {version,electron,os,running,steamRunning,savedLaunchFlag,launchFlag,dotaFound,gsiInstalled,gsiConfigMatches,itemsConfigured,gsiAgeMs,gsiRejected,hero,alive,slots,abilities,items,bindingMatches,bindingsChanged,bindingsIssue,bindingWarningsCount,voiceReady,voiceFailed,hookReady,hookFailed,enabled,modelVerified,modelAvailable,modelDictionaryReady,configInvalid,configBackup,experimentalActive,profile,port,serverReady,testOnly,activePhrases,repairFailed,lastCastStatus,effectiveSettings}=d;
 return ['Voice Invoke — отчёт для поддержки',new Date().toISOString(),'== Диагностика ==',JSON.stringify({version,electron,os,running,steamRunning,savedLaunchFlag,launchFlag,dotaFound,gsiInstalled,gsiConfigMatches,itemsConfigured,gsiAgeMs,gsiRejected,hero,alive,slots,abilities,items,bindingMatches,bindingsChanged,bindingsIssue,bindingWarningsCount,voiceReady,voiceFailed,hookReady,hookFailed,enabled,modelVerified,modelAvailable,modelDictionaryReady,configInvalid,configBackup,experimentalActive,profile,port,serverReady,testOnly,activePhrases,repairFailed,lastCastStatus,effectiveSettings},null,2)].join('\n');
}
module.exports={processStatus,hasFlag,savedLaunchOptions,discoverDota,chooseAccount,inspectSteam,supportReport,bindingSignature};
