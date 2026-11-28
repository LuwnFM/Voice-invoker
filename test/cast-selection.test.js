const test=require('node:test'),assert=require('node:assert/strict');
const {ACTION,SELECT_HERO_ACTION,createVoiceCast,createClickGuard,vkOf}=require('../logic');
const {encodeCast,decodeCast}=require('../timing-profiles');
const {readBindings}=require('../dota-bindings');
const {ITEM_SLOTS,planItem}=require('../items');
const spells=require('../spells');
test('selection request sends only the configured key, for items and spells',()=>{
 const config={keys:{selectHero:'F1',quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F',item1:'X'},voiceChatKey:'G',castMode:'quickcast'};
 const v=createVoiceCast(config,{isGameActive:()=>true,emit(){},quit(){}});
 for(const spell of [spells[0],ITEM_SLOTS[0]])assert.deepEqual(v.buildSequence(spell,SELECT_HERO_ACTION),[{type:'key',vk:vkOf('F1'),wait:0}]);
 assert.equal(decodeCast(encodeCast(SELECT_HERO_ACTION,'fast',1)).action,SELECT_HERO_ACTION);
 config.keys.selectHero='';assert.throws(()=>v.buildSequence(spells[0],SELECT_HERO_ACTION));
});
test('manual click during targeting cancels auto confirmation but other clicks do not',()=>{
 const g=createClickGuard();g.manualClick();assert.equal(g.interrupted,false);
 g.arm();g.manualClick();assert.equal(g.interrupted,true);g.reset();assert.equal(g.interrupted,false);
 g.arm();assert.equal(g.interrupted,false);
});
test('actual HeroSelect VDF bind and ambiguity in same-key cast modes',()=>{
 const r=readBindings('"KeyBindings" { "Keys" { "HeroSelect" { "Key" "F2" } "AbilitySecondary1" { "Key" "D" "Mode" "1" } "Inventory1" { "Key" "X" "Mode" "0" } "Inventory1QuickCast" { "Key" "X" } } }');
 assert.equal(r.keys.selectHero,'F2');assert.equal(r.slotCastModes.slot1,'quickcast');assert.equal(r.keys.item1,undefined);assert.equal(r.warnings.length,1);
 assert.equal(readBindings('"KeyBindings" { "Keys" { "HeroSelect" { "Key" "" } } }').keys.selectHero,'');
});
test('quickcast on a target never emits a mouse click; regular cast remains supported',()=>{
 const c={keys:{quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F',item1:'X'},voiceChatKey:'G',castMode:'click',slotCastModes:{slot1:'quickcast',item1:'quickcast'}};
 const v=createVoiceCast(c,{isGameActive:()=>true,emit(){},quit(){}});
 assert.equal(v.buildSequence(spells[0],ACTION.SLOT1).some(s=>s.type==='click'),false);
 const gsi={at:100,hero:'npc_dota_hero_invoker',alive:true,items:[{name:'item_rod_of_atos',cooldown:0,can_cast:true}]};
 const action=planItem(ITEM_SLOTS[0],gsi,c,false,101).action;
 assert.equal(v.buildSequence(ITEM_SLOTS[0],action).some(s=>s.type==='click'),false);
 c.slotCastModes.item1='click';const regular=planItem(ITEM_SLOTS[0],gsi,c,false,101).action;
 assert.equal(v.buildSequence(ITEM_SLOTS[0],regular).at(-1).type,'click');
});
