const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {hasFlag,savedLaunchOptions,discoverDota,chooseAccount,supportReport}=require('../diagnostics');
test('launch flag is checked separately from running game and exact token only',()=>{
 assert.ok(hasFlag('-windowed -gamestateintegration -noborder'));assert.ok(!hasFlag('-gamestateintegration2'));
 const v=flag=>'"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "570" { "LaunchOptions" "'+flag+'" } } } } } }';
 assert.equal(savedLaunchOptions(v('-gamestateintegration')),true);assert.equal(savedLaunchOptions(v('-windowed')),false);assert.equal(savedLaunchOptions('"other" {}'),null);
});
test('read-only diagnostics discover game even without GSI install record; do not guess account',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vi-diag-'));
 try{
  const steam=path.join(dir,'Steam'),game=path.join(steam,'steamapps','common','dota 2 beta'),bin=path.join(game,'game','bin','win64');
  fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,'dota2.exe'),'');
  assert.equal(discoverDota(steam,null),game);assert.equal(discoverDota(null,path.join(bin,'dota2.exe')),game);
  fs.mkdirSync(path.join(steam,'userdata','12'),{recursive:true});fs.mkdirSync(path.join(steam,'userdata','34'),{recursive:true});
  assert.equal(chooseAccount(steam,null),null);assert.equal(chooseAccount(steam,'0x22'),'34');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('support report excludes sensitive fields, transcripts and raw logs',()=>{
 const report=supportReport({version:'1.1.0',hero:'npc_dota_hero_invoker',slots:['invoker_tornado'],local:{gsiPath:'PRIVATE_PATH',voiceMessage:'PRIVATE_MIC'},lastTest:{transcript:'PRIVATE_SPEECH'},authToken:'PRIVATE_TOKEN',logs:['PRIVATE_LOG'],customSpellPhrases:['PRIVATE_PHRASE']});
 assert.ok(report.includes('invoker_tornado'));assert.ok(!report.includes('PRIVATE_'));
});
