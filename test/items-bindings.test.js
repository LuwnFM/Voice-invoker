const test=require('node:test'),assert=require('node:assert/strict');
const {readBindings}=require('../dota-bindings');
const {planBlink,ITEM_SLOTS}=require('../items');
const {createVoiceCast,ACTION}=require('../logic');
test('read-only Dota bind importer honors slot modes and rejects modifiers',()=>{
 const r=readBindings('"KeyBindings" { "Keys" { "AbilityPrimary1" { "Key" "Q" } "AbilitySecondary2" { "Key" "F" "Mode" "1" } "Inventory2" { "Key" "KP_2" "Mode" "0" } "Inventory3" { "Key" "C" "Modifier" "Alt" } } "Items" {"item_blink" {"Mode" "0"}} }');
 assert.deepEqual(r.keys,{quas:'Q',slot2:'F',item2:'NUM2'});
 assert.deepEqual(r.slotCastModes,{slot2:'quickcast',item2:'click'});
 assert.equal(r.itemCastModes.item_blink,'click');assert.equal(r.warnings.length,1);
});
test('Blink requires fresh inventory, live hero, active slot, key and ready item',()=>{
 const config={keys:{item2:'X'},castMode:'quickcast'},gsi={at:100,hero:'npc_dota_hero_invoker',alive:true,items:[null,{name:'item_arcane_blink',cooldown:0,can_cast:true}]};
 assert.deepEqual(planBlink(gsi,config,false,101),{itemSlot:2,action:2});
 assert.ok(planBlink(gsi,config,true,101).refuse);
 assert.ok(planBlink(gsi,config,false,6000).refuse);
 assert.ok(planBlink({...gsi,items:[null,null,null,null,null,null,gsi.items[1]]},config,false,101).refuse);
 assert.ok(planBlink({...gsi,items:[null,{...gsi.items[1],cooldown:1}]},config,false,101).refuse);
 assert.ok(planBlink(gsi,{keys:{}},false,101).refuse);
 const v=createVoiceCast(config,{isGameActive:()=>true,emit(){},quit(){}});
 assert.deepEqual(v.buildSequence(ITEM_SLOTS[1],ACTION.SLOT2),[{type:'key',vk:88,wait:0}]);
 assert.equal(v.buildSequence(ITEM_SLOTS[1],ACTION.SLOT1).at(-1).type,'click');
});
