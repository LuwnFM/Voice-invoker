const test=require('node:test'),assert=require('node:assert/strict');
const {readBindings}=require('../dota-bindings');
const {planItem,ITEM_SLOTS,readInventory}=require('../items');
const {createVoiceCast,ACTION}=require('../logic');
const {validateItemPhrases}=require('../item-phrases');
const {wordsFromGraph}=require('../model-words');
test('read-only importer supports active slots, neutral and teleport',()=>{
 const r=readBindings('"KeyBindings" { "Keys" { "AbilityPrimary1" { "Key" "Q" } "AbilitySecondary2" { "Key" "F" "Mode" "1" } "Inventory2" { "Key" "KP_2" "Mode" "0" } "Inventory3" { "Key" "C" "Modifier" "Alt" } "InventoryNeutralQuickCast" { "Key" "T" "Mode" "2" } "InventoryTP" { "Key" "Y" "Mode" "0" } } }');
 assert.deepEqual(r.keys,{quas:'Q',slot2:'F',item2:'NUM2',neutral:'T',teleport:'Y'});
 assert.deepEqual(r.slotCastModes,{slot2:'quickcast',item2:'click',neutral:'quickcast',teleport:'click'});
 assert.equal(r.warnings.length,1);
});
test('all eight item slots require fresh GSI, ready item and key; no preparation',()=>{
 const item={name:'item_example',cooldown:0,can_cast:true};
 const inv=readInventory({...Object.fromEntries(Array.from({length:6},(_,i)=>['slot'+i,item])),slot6:{name:'backpack'},neutral0:item,teleport0:item});
 assert.equal(inv.length,8);assert.ok(inv.every(x=>x===item));
 for(const spell of ITEM_SLOTS){
   const config={keys:{[spell.key]:'X'},castMode:'click'},gsi={at:100,hero:'npc_dota_hero_invoker',alive:true,items:inv};
   assert.deepEqual(planItem(spell,gsi,config,false,101),{itemSlot:spell.itemSlot,action:ACTION.SLOT2});
   assert.ok(planItem(spell,gsi,config,true,101).refuse);
   assert.ok(planItem(spell,gsi,config,false,6000).refuse);
   assert.ok(planItem(spell,{...gsi,items:[]},config,false,101).refuse);
   assert.ok(planItem(spell,{...gsi,items:inv.map(x=>({...x,cooldown:1}))},config,false,101).refuse);
   assert.ok(planItem(spell,gsi,{keys:{}},false,101).refuse);
   const v=createVoiceCast(config,{isGameActive:()=>true,emit(){},quit(){}});
   assert.deepEqual(v.buildSequence(spell,ACTION.SLOT2),[{type:'key',vk:88,wait:0}]);
   assert.equal(v.buildSequence(spell,ACTION.SLOT1).at(-1).type,'click');
 }
});
test('custom phrases validate real dictionary tokens, empty lists disable, duplicate commands rejected',()=>{
 const [a,b]=ITEM_SLOTS,dict=new Set(['прыжок','вперёд','торнадо','готовь']);
 const raw={[a.id]:[' Прыжок ','прыжок вперёд','прыжок']};
 const valid=validateItemPhrases(raw,dict,{invoker_tornado:['торнадо']}).phrases;
 assert.deepEqual(valid[a.id],['прыжок','прыжок вперёд']);assert.deepEqual(valid[b.id],[]);
 for(const invalid of [{[a.id]:['неизвестно']},{[a.id]:['торнадо']},{[a.id]:['готовь прыжок']},{[a.id]:['прыжок'],[b.id]:['прыжок']}])assert.throws(()=>validateItemPhrases(invalid,dict,{invoker_tornado:['торнадо']}));
 assert.deepEqual(validateItemPhrases(raw,null,{}, {strict:false}).phrases[a.id],[]);
});
test('FST word table parser reads symbols and rejects truncated tables',()=>{
 const i32=n=>{const b=Buffer.alloc(4);b.writeInt32LE(n);return b;},i64=n=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(n));return b;},str=s=>Buffer.concat([i32(Buffer.byteLength(s)),Buffer.from(s)]);
 const bytes=Buffer.concat([Buffer.from([0x74,0xfb,0xb2,0x7e]),str('words.txt'),i64(2),i64(2),str('<eps>'),i64(0),str('прыжок'),i64(1)]);
 assert.deepEqual([...wordsFromGraph(bytes)],['прыжок']);assert.throws(()=>wordsFromGraph(bytes.subarray(0,-2)));
});

test('disabled spell alias may be reused by an item; re-enabling it conflicts',()=>{
 const {enabledPhrases}=require('../phrase-preferences');
 const all={invoker_emp:['эмп','импульс']},dict=new Set(['эмп','импульс']);
 const raw={[ITEM_SLOTS[0].id]:['эмп']};
 const allowed=enabledPhrases(all,{invoker_emp:['эмп']},{},true);
 assert.deepEqual(validateItemPhrases(raw,dict,allowed).phrases[ITEM_SLOTS[0].id],['эмп']);
 assert.throws(()=>validateItemPhrases(raw,dict,enabledPhrases(all,{}, {},true)));
});

test('item-name mode follows the item between slots; slot fallback is preserved',()=>{
 const {validateItemCastModes}=require('../items');
 const item={name:'item_force_staff',cooldown:0,can_cast:true};
 const config={keys:{item1:'X',item2:'Y'},slotCastModes:{item1:'quickcast',item2:'click'},itemCastModes:validateItemCastModes({item_force_staff:'click'})};
 const gsi={at:100,hero:'npc_dota_hero_invoker',alive:true,items:[item,item]};
 for(const spell of ITEM_SLOTS.slice(0,2))assert.equal(planItem(spell,gsi,config,false,101).action,ACTION.SLOT1);
 config.itemCastModes={item_force_staff:'quickcast'};assert.equal(planItem(ITEM_SLOTS[1],gsi,config,false,101).action,ACTION.SLOT2);
 config.itemCastModes={};assert.equal(planItem(ITEM_SLOTS[1],gsi,config,false,101).action,ACTION.SLOT1);
 for(const invalid of [{__proto__:null,item_force_staff:'other'},{not_item:'click'},[]])assert.throws(()=>validateItemCastModes(invalid));
});
test('binding changes detect keys or cast modes, not property order',()=>{
 const {bindingSignature}=require('../diagnostics');
 const a={keys:{quas:'Q',wex:'W'},slotCastModes:{slot1:'click'},warnings:[]};
 assert.equal(bindingSignature(a),bindingSignature({...a,keys:{wex:'W',quas:'Q'}}));
 assert.notEqual(bindingSignature(a),bindingSignature({...a,slotCastModes:{slot1:'quickcast'}}));
 assert.notEqual(bindingSignature(a),bindingSignature({...a,keys:{quas:'A',wex:'W'}}));
 assert.equal(bindingSignature(null),null);
});

test('VDF supports literal backslash, comments and quoted braces',()=>{
 const {parseVdf}=require('../dota-bindings');
 const raw='"KeyBindings" { // comment\n "Keys" { "HeroSelect" { "Key" "F1" } "AbilitySecondary1" { "Key" "D" "Mode" "1" } "Unused" { "Key" "'+String.fromCharCode(92)+'" } "Other" "}" [$WIN32] } "Items" { "item_rod_of_atos" { "Mode" "1" } } }';
 const data=readBindings(raw);assert.equal(data.keys.selectHero,'F1');assert.equal(data.slotCastModes.slot1,'quickcast');assert.equal(data.itemCastModes.item_rod_of_atos,'quickcast');
 assert.equal(parseVdf(raw).keybindings.keys.unused.key,String.fromCharCode(92));assert.throws(()=>parseVdf('"KeyBindings" { "Keys"'));
});
test('named items follow inventory and refuse absent or stale data',()=>{
 const item={name:'item_rod_of_atos',cooldown:0,can_cast:true},s={name:'Atos',itemName:item.name};
 const c={keys:{item1:'X',item2:'Y'},slotCastModes:{item1:'quickcast',item2:'quickcast'},itemCastModes:{[item.name]:'click'},syncQuickcast:true,syncedItemCastModes:{[item.name]:'quickcast'}};
 const g={at:100,hero:'npc_dota_hero_invoker',alive:true,items:[null,item]};
 assert.deepEqual(planItem(s,g,c,false,101),{itemSlot:2,action:ACTION.SLOT2});
 assert.equal(planItem(s,{...g,items:[item,null]},c,false,101).itemSlot,1);
 assert.ok(planItem(s,{...g,items:[]},c,false,101).refuse);assert.ok(planItem(s,g,c,false,6000).refuse);
});

test('VDF reader handles UTF8 BOM and both UTF16 byte orders',()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const {readVdfFile}=require('../dota-bindings');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vi-vdf-'));
 try{
   const file=path.join(dir,'fixture.lst'),sample='KeyBindings { Keys { HeroSelect { Key F1 } AbilitySecondary1 { Key D Mode 1 } } }';
   for(const bytes of [Buffer.concat([Buffer.from([239,187,191]),Buffer.from(sample)]),Buffer.concat([Buffer.from([255,254]),Buffer.from(sample,'utf16le')]),Buffer.concat([Buffer.from([254,255]),Buffer.from(sample,'utf16le').swap16()])]){
     fs.writeFileSync(file,bytes);assert.equal(readBindings(readVdfFile(file)).keys.selectHero,'F1');assert.equal(readBindings(readVdfFile(file)).slotCastModes.slot1,'quickcast');
   }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('real Dota LOL and ARROW layout shapes survive account switches',()=>{
 const {bindingUpdate}=require('../binding-sync');
 const consoleKey='Console { Key "'+String.fromCharCode(92)+'" }';
 const make=(quick,voice)=>{
   const primary=['AbilityPrimary1','AbilityPrimary2','AbilityPrimary3','AbilityUltimate','AbilitySecondary1','AbilitySecondary2'];
   const actions=[...primary,...Array.from({length:6},(_,i)=>'Inventory'+(i+1)),'InventoryNeutral','InventoryTP'];
   const keys=quick?['Q','W','E','R','D','F','1','2','3','4','5','6','V','U']:['Q','W','E','R','V','F','A','S','D','Z','X','C','B','T'];
   const lines=actions.map((action,i)=>{
     if(quick&&action!=='InventoryTP')return action+' { Mode 2 } '+action+'QuickCast { Key '+keys[i]+' Mode 2 }';
     return action+' { Key '+keys[i]+' Mode '+(quick?'2':action==='InventoryNeutral'?'-1':'0')+' }';
   });
   return 'KeyBindings { UseHeroBindings 0 Keys { '+consoleKey+' '+lines.join(' ')+' HeroSelect { Key '+(quick?'SPACE':'F1')+' } ChatVoiceTeam { '+(voice?'Key '+voice:'')+' Mode 0 } } Items { item_rod_of_atos { Mode 2 } } }';
 };
 const a=readBindings(make(true,'TAB')),b=readBindings(make(true,'')),c=readBindings(make(false,'G'));
 assert.equal(a.keys.selectHero,'SPACE');assert.equal(a.keys.voice,'TAB');
 assert.equal(a.slotCastModes.neutral,'quickcast');assert.equal(a.itemCastModes.item_rod_of_atos,'quickcast');
 assert.equal(b.keys.voice,undefined);
 const original={keys:{},voiceChatKey:'G',slotCastModes:{neutral:'click'}};
 const first=bindingUpdate(a,original),second=bindingUpdate(b,{...original,...first});
 assert.equal(second.voiceChatKey,'TAB');assert.equal(second.keys.slot1,'D');
 const third=bindingUpdate(c,{...original,...second});
 assert.equal(third.keys.slot1,'V');assert.equal(third.keys.item3,'D');assert.equal(third.keys.selectHero,'F1');assert.equal(third.voiceChatKey,'G');
 assert.equal(third.slotCastModes.slot1,'click');assert.equal(third.slotCastModes.item1,'click');assert.equal(third.slotCastModes.neutral,undefined);
 const gsi={at:100,hero:'npc_dota_hero_invoker',alive:true,items:[null,null,null,null,null,null,{name:'item_example',cooldown:0,can_cast:true}]};
 assert.equal(planItem(ITEM_SLOTS[6],gsi,third,false,101).action,ACTION.SLOT2);
 assert.equal(bindingUpdate(c,{...original,...second},false).slotCastModes.neutral,'quickcast');
});
