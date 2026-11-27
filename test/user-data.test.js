const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {dataDirectory,initializeUserData}=require('../user-data');
test('RC6/RC7 migration keeps all bytes, unknown keys and old data without overwriting newer AppData',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vi-data-'));
 try{
  const old=path.join(root,'legacy'),appdata=path.join(root,'roaming'),env={APPDATA:appdata};
  fs.mkdirSync(old);const source=path.join(old,'config.json'),bytes=Buffer.from('\uFEFF{"voiceChatKey":"MOUSE4","unknown":"фраза"}');
  fs.writeFileSync(source,bytes);
  const target=initializeUserData(old,env);
  assert.equal(target,path.join(appdata,'VoiceInvoker'));
  const config=path.join(target,'config.json');assert.deepEqual(fs.readFileSync(config),bytes);
  fs.writeFileSync(config,'{"updated":true}');initializeUserData(old,env);
  assert.equal(fs.readFileSync(config,'utf8'),'{"updated":true}');assert.deepEqual(fs.readFileSync(source),bytes);
  assert.equal(dataDirectory({VI_DATA_DIR:root,APPDATA:appdata}),root);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('damaged legacy settings are preserved for explicit diagnostics, not silently replaced',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vi-data-broken-'));
 try{
  fs.writeFileSync(path.join(root,'config.json'),'{bad');
  const target=initializeUserData(root,{VI_DATA_DIR:path.join(root,'new')});
  assert.equal(fs.readFileSync(path.join(target,'config.json'),'utf8'),'{bad');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
