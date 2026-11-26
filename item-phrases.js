const {ITEM_SLOTS}=require('./items');
const {PREPARE_PREFIXES}=require('./phrase-parser');
const normalize=p=>String(p).trim().toLowerCase().replace(/\s+/g,' ');
const cues=new Set([...PREPARE_PREFIXES.map(p=>p.split(' ')[0]),'фолиант']);
function validateItemPhrases(raw,words,spellCatalog,{strict=true}={}){
 const result={},used=new Set(Object.values(spellCatalog).flat().map(normalize)),errors=[];
 for(const slot of ITEM_SLOTS){
   result[slot.id]=[];
   const list=raw?.[slot.id];
   if(list===undefined)continue;
   if(!Array.isArray(list)||list.length>100){errors.push(slot.name+': максимум 100 фраз');continue;}
   for(const value of list){
     if(typeof value!=='string'){errors.push(slot.name+': неверная фраза');continue;}
     const p=normalize(value);if(!p)continue;
     if(result[slot.id].includes(p))continue;
     const tokens=p.split(' ');
     const unknown=tokens.filter(w=>!words?.has(w));
     if(p.length>120||tokens.length>12||tokens.some(w=>cues.has(w))||unknown.length||used.has(p)){
       errors.push(slot.name+': «'+p.slice(0,120)+'» — '+(unknown.length?'нет в словаре: '+unknown.join(', '):used.has(p)?'фраза уже назначена':'недопустимая фраза'));
       continue;
     }
     used.add(p);result[slot.id].push(p);
   }
 }
 if(strict&&errors.length)throw Error(errors.join('; ').slice(0,1200));
 return {phrases:result,errors};
}
module.exports={validateItemPhrases};
