// Watch the parent directory: Steam can atomically replace its bindings file.
const fs=require('node:fs'),path=require('node:path');
const {readBindings}=require('./dota-bindings');
const {validateKeys}=require('./key-validation');
const {ITEM_KEYS}=require('./items');
function bindingUpdate(bindings,config,syncModes=true){
 if(!bindings||bindings.warnings.length)throw Error('Неподдерживаемые бинды Dota; проверь ручной импорт.');
 if(!['quas','wex','exort','invoke','slot1','slot2','voice'].every(k=>bindings.keys[k]))throw Error('Не все основные клавиши найдены.');
 if(ITEM_KEYS.some(k=>config.keys[k]&&!bindings.keys[k]))throw Error('Не найдена ранее назначенная клавиша предмета.');
 const {voice,...imported}=bindings.keys;
 const keys={...config.keys,...imported},voiceChatKey=voice;
 validateKeys(keys,voiceChatKey);
 const slotCastModes={...config.slotCastModes};
 if(syncModes)for(const [k,v] of Object.entries(bindings.slotCastModes))slotCastModes[k]=v;
 return {keys,voiceChatKey,slotCastModes};
}
function watchBindingFile(file,onRead,onError,delay=350){
 let timer=null,closed=false,watcher=null,attempts=0;
 function read(){
   if(closed)return;
   try{const b=readBindings(fs.readFileSync(file,'utf8'));attempts=0;onRead(b);}
   catch(e){if(++attempts<4)timer=setTimeout(read,delay);else{attempts=0;onError(e);}}
 }
 function change(){if(closed)return;clearTimeout(timer);attempts=0;timer=setTimeout(read,delay);}
 watcher=fs.watch(path.dirname(file),(_event,name)=>{if(!name||String(name).toLowerCase()===path.basename(file).toLowerCase())change();});
 watcher.on('error',e=>{close();onError(e);});
 function close(){closed=true;clearTimeout(timer);watcher?.close();}
 change();
 return {close};
}
const BUFFER_SIZE=16384;
function writeBindingUpdate(shared,patch){
 const b=Buffer.from(JSON.stringify(patch),'utf8');
 if(b.length>shared.byteLength-4)throw Error('Binding update too large');
 new Uint8Array(shared,4,b.length).set(b);
 Atomics.store(new Int32Array(shared,0,1),0,b.length);
}
function readBindingUpdate(shared){
 const n=Atomics.load(new Int32Array(shared,0,1),0);
 if(n<1||n>shared.byteLength-4)throw Error('Invalid binding update');
 return JSON.parse(Buffer.from(new Uint8Array(shared,4,n)).toString('utf8'));
}
module.exports={bindingUpdate,watchBindingFile,BUFFER_SIZE,writeBindingUpdate,readBindingUpdate};
