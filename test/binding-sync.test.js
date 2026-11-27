const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {bindingUpdate,watchBindingFile,BUFFER_SIZE,writeBindingUpdate,readBindingUpdate}=require('../binding-sync');
const {createVoiceCast,ACTION,vkOf}=require('../logic');
const base={keys:{quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F'},voiceChatKey:'G',listen:'hold',castMode:'click',blockKeys:['invoke']};
const input={keys:{...base.keys,quas:'A',voice:'T'},slotCastModes:{slot1:'quickcast'},warnings:[]};
test('validated live binding update preserves mode when mode sync off and rejects conflicts',()=>{
 const patch=bindingUpdate(input,base);assert.equal(patch.keys.quas,'A');assert.equal(patch.voiceChatKey,'T');assert.equal(patch.slotCastModes.slot1,'quickcast');
 assert.deepEqual(bindingUpdate(input,base,false).slotCastModes,{});
 assert.throws(()=>bindingUpdate({...input,keys:{...input.keys,voice:'A'}},base));
 assert.throws(()=>bindingUpdate({...input,warnings:['unsupported']},base));
 const shared=new SharedArrayBuffer(BUFFER_SIZE);writeBindingUpdate(shared,patch);assert.deepEqual(readBindingUpdate(shared),patch);
});
test('hook uses new keys and retains toggle and profile state',()=>{
 const voice=createVoiceCast({...base},{isGameActive:()=>true,emit(){},quit(){}});
 voice.toggle();voice.updateBindings(bindingUpdate(input,base));assert.equal(voice.state.enabled,false);assert.equal(voice.state.talkKey,'T');
 voice.toggle();voice.setVoiceReady(true);
 const spell={combo:'QQQ',target:false};
 assert.equal(voice.buildSequence(spell,ACTION.PREPARE)[0].vk,vkOf('A'));
 voice.handleKey(vkOf('G'),true);assert.equal(voice.state.listening,false);
 voice.handleKey(vkOf('T'),true);assert.equal(voice.state.listening,true);
});
test('watcher reads atomic file replacement and closes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vi-watch-'));const file=path.join(dir,'dotakeys_personal.lst');
 const v=k=>'"KeyBindings" { "Keys" { "AbilityPrimary1" { "Key" "'+k+'" } } }';
 fs.writeFileSync(file,v('Q'));let watcher,timer;
 try{await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('watch timeout')),5000);
  watcher=watchBindingFile(file,b=>{if(b.keys.quas==='Q'){fs.writeFileSync(file+'.tmp',v('A'));fs.renameSync(file+'.tmp',file);}else if(b.keys.quas==='A')resolve();},reject,30);
 });}finally{clearTimeout(timer);watcher?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
