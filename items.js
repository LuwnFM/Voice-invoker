// Voice commands target an inventory slot, not a particular item name.
const {vkOf,ACTION}=require('./logic');
const ITEM_KEYS=Object.freeze([...Array.from({length:6},(_,i)=>'item'+(i+1)),'neutral','teleport']);
const ITEM_SLOTS=Object.freeze(ITEM_KEYS.map((key,i)=>Object.freeze({id:'item_slot_'+key,name:i<6?'Предмет '+(i+1):key==='neutral'?'Нейтральный предмет':'Телепорт',itemSlot:i+1,key})));
function readInventory(items){
  if(!items||typeof items!=='object')return null;
  return [...Array.from({length:6},(_,i)=>items['slot'+i]||null),items.neutral0||null,items.teleport0||null];
}
function validateItemCastModes(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Некорректные режимы предметов');
 const entries=Object.entries(value);
 if(entries.length>200)throw Error('Слишком много индивидуальных режимов предметов');
 for(const [name,mode] of entries)if(!/^item_[a-z0-9_]{1,100}$/.test(name)||!['click','quickcast'].includes(mode))throw Error('Некорректный предмет или режим каста: '+name);
 return Object.fromEntries(entries);
}
function planItem(spell,gsi,config,prepareOnly=false,now=Date.now()){
  const refuse=reason=>({refuse:spell.name+': '+reason});
  if(prepareOnly)return refuse('предмет нельзя подготовить');
  if(!gsi||now-gsi.at>=5000||gsi.hero!=='npc_dota_hero_invoker'||gsi.alive!==true)return refuse('нет свежих данных живого Инвокера');
  if(!Array.isArray(gsi.items))return refuse('нет данных инвентаря');
  const item=gsi.items[spell.itemSlot-1];
  if(!item||!item.name||item.name==='empty'||item.name==='item_empty')return refuse('слот пуст');
  if(!Number.isFinite(item.cooldown)||item.cooldown>0||item.can_cast!==true)return refuse('предмет недоступен или на перезарядке');
  if(item.passive===true)return refuse('пассивный предмет');
  if(!vkOf(config.keys?.[spell.key]))return refuse('не назначена клавиша');
  // No extra click unless explicitly requested. Items may be instant or no-target.
  const mode=config.itemCastModes?.[item.name]||config.slotCastModes?.[spell.key]||'quickcast';
  return {itemSlot:spell.itemSlot,action:mode==='click'?ACTION.SLOT1:ACTION.SLOT2};
}
module.exports={ITEM_KEYS,ITEM_SLOTS,readInventory,planItem,validateItemCastModes};
