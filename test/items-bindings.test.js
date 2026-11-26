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
