const {vkOf}=require('./logic');
function validateKeys(keys,voiceChatKey){
 const seen=new Map();
 for(const [name,key] of [...Object.entries(keys||{}),['voiceChatKey',voiceChatKey]]){
  if(key===''||key===undefined)continue;
  const vk=vkOf(key);
  if(!vk)throw Error('Некорректная клавиша: '+name);
  if(seen.has(vk))throw Error('Конфликт клавиш: '+seen.get(vk)+' / '+name);
  seen.set(vk,name);
 }
}
module.exports={validateKeys};
