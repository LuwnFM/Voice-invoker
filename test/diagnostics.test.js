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

test('unique MostRecent is fallback only; active registry identity wins',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vi-login-'));
 try{
   const {BINDING_SUFFIX}=require('../dota-bindings');
   const file=path.join(dir,'userdata','12',BINDING_SUFFIX);
   fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'KeyBindings { Keys {} }');
   fs.mkdirSync(path.join(dir,'userdata','34'),{recursive:true});
   const cfg=path.join(dir,'config');fs.mkdirSync(cfg);
   const vdf=path.join(cfg,'loginusers.vdf');
   const s='users { "76561197960265740" { MostRecent 1 } "76561197960265762" { MostRecent 0 } }';
   fs.writeFileSync(vdf,Buffer.concat([Buffer.from([255,254]),Buffer.from(s,'utf16le')]));
   assert.equal(chooseAccount(dir,null),'12');assert.equal(chooseAccount(dir,'0x0'),'12');
   assert.equal(chooseAccount(dir,'0x22'),'34');assert.equal(chooseAccount(dir,'99'),null);
   fs.writeFileSync(vdf,s.replace('MostRecent 0','MostRecent 1'));assert.equal(chooseAccount(dir,null),null);
   fs.writeFileSync(vdf,s);fs.rmSync(file);assert.equal(chooseAccount(dir,null),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
