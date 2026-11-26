const {execFile}=require('node:child_process');
let state={running:null,launchFlag:null},at=0,pending=null;
function processStatus(){
 if(Date.now()-at<5000)return Promise.resolve(state);
 if(pending)return pending;
 pending=new Promise(resolve=>{
   const script="$p=Get-CimInstance Win32_Process -Filter \"Name='dota2.exe'\" -ErrorAction Stop; if (-not $p) { 'absent' } elseif ($p.CommandLine -match '(?i)(^|\\s)-gamestateintegration(\\s|$)') { 'flag' } elseif ($p.CommandLine) { 'no-flag' } else { 'unknown' }";
   execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:4000},(err,out)=>{
     const text=String(out||'').trim();
     state=err?{running:null,launchFlag:null}:text==='absent'?{running:false,launchFlag:null}:text==='flag'?{running:true,launchFlag:true}:text==='no-flag'?{running:true,launchFlag:false}:{running:null,launchFlag:null};
     at=Date.now();pending=null;resolve(state);
   });
 });return pending;
}
module.exports={processStatus};
