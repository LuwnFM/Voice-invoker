const BLINK_NAMES = ['item_blink','item_overwhelming_blink','item_swift_blink','item_arcane_blink'];
const ITEM_COMMAND={id:'item_blink',name:'Blink Dagger'};
const ITEM_SLOTS=Object.freeze(Array.from({length:6},(_,i)=>Object.freeze({...ITEM_COMMAND,itemSlot:i+1})));
function planBlink(gsi, config, prepareOnly=false, now=Date.now()) {
  const refuse=reason=>({refuse:'Blink Dagger: '+reason});
  if(prepareOnly)return refuse('предмет нельзя подготовить');
  if(!gsi||now-gsi.at>=5000||gsi.hero!=='npc_dota_hero_invoker'||!gsi.alive)return refuse('нет свежих данных живого Инвокера');
  if(!Array.isArray(gsi.items))return refuse('нет данных инвентаря');
  const matches=gsi.items.slice(0,6).map((item,i)=>({item,i})).filter(({item})=>BLINK_NAMES.includes(item?.name));
  const usable=matches.find(({item,i})=>Number.isFinite(item.cooldown)&&item.cooldown<=0&&item.can_cast===true&&config.keys?.['item'+(i+1)]);
  if(!usable)return refuse(matches.length?'перезарядка, нельзя применить или не назначена клавиша':'нет предмета в основных слотах');
  const {item,i}=usable,slot='item'+(i+1);
  const slotMode=config.slotCastModes?.[slot]||config.itemCastMode||config.castMode;
  const click=slotMode!=='quickcast'||config.itemCastModes?.[item.name]==='click';
  return {itemSlot:i+1,action:click?1:2};
}
module.exports={BLINK_NAMES,ITEM_COMMAND,ITEM_SLOTS,planBlink};
