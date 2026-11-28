// Read-only Steam/Dota configuration importer. Never edits Steam files.
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {vkOf}=require('./logic');
// Support both escaped KeyValues and literal-backslash Dota key names.
function parseDialect(text,escapes){
 const source=String(text).replace(/^\uFEFF/,'').replace(/\0+$/,'');let i=0;
 const fail=reason=>{throw Error(reason+' (строка '+(source.slice(0,i).split('\n').length)+')');};
 function next(){
   for(;;){while(i<source.length&&/\s/.test(source[i]))i++;if(source.slice(i,i+2)==='//'){while(i<source.length&&source[i]!=='\n')i++;continue;}break;}
   if(i>=source.length)return null;
   const ch=source[i++];
   if(ch==='{'||ch==='}')return {kind:ch,value:ch};
   if(ch==='"'){
     let value='';
     while(i<source.length){const c=source[i++];if(c==='"')return {kind:'word',value};if(c==='\r'||c==='\n')fail('Unclosed VDF string');if(c==='\\'&&escapes&&['"','\\'].includes(source[i]))value+=source[i++];else value+=c;}
     fail('Unclosed VDF string');
   }
   let value=ch;while(i<source.length&&!/[\s{}"]/.test(source[i]))value+=source[i++];
   return {kind:'word',value};
 }
 function block(nested=false,depth=0){
   if(depth>128)fail('VDF nesting limit');
   const out=Object.create(null);
   for(;;){
     const key=next();
     if(!key){if(nested)fail('Unclosed VDF block');return out;}
     if(key.kind==='}'){if(!nested)fail('Unexpected VDF brace');return out;}
     if(key.kind!=='word')fail('Invalid VDF key');
     if(/^\[!?\$[a-z0-9_]+\]$/i.test(key.value))continue;
     const val=next();if(!val||val.kind==='}')fail('Missing VDF value');
     out[key.value.toLowerCase()]=val.kind==='{'?block(true,depth+1):val.value;
   }
 }
 return block();
}
function parseVdf(text){
 try{return parseDialect(text,true);}catch(first){
   try{return parseDialect(text,false);}catch{throw first;}
 }
}
function readVdfFile(file){
 const bytes=fs.readFileSync(file);
 if(bytes[0]===0xff&&bytes[1]===0xfe)return bytes.subarray(2).toString('utf16le');
 if(bytes[0]===0xfe&&bytes[1]===0xff)return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
 return bytes.toString('utf8');
}
const actions={quas:'abilityprimary1',wex:'abilityprimary2',exort:'abilityprimary3',invoke:'abilityultimate',slot1:'abilitysecondary1',slot2:'abilitysecondary2',voice:'chatvoiceteam',selectHero:'heroselect',neutral:'inventoryneutral',teleport:'inventorytp',...Object.fromEntries(Array.from({length:6},(_,i)=>['item'+(i+1),'inventory'+(i+1)]))};
const aliases={uparrow:'UP',downarrow:'DOWN',leftarrow:'LEFT',rightarrow:'RIGHT',kp_multiply:'NUM*',kp_plus:'NUM+',kp_minus:'NUM-',kp_del:'NUM.',kp_slash:'NUM/',semicolon:';',key_cyrillic_be:',',key_cyrillic_yu:'.',key_cyrillic_e:"'",key_cyrillic_zhe:';',key_cyrillic_ha:'[',key_cyrillic_hard_sign:']',key_cyrillic_yo:'`'};
function readBindings(text){
 const root=parseVdf(text).keybindings;if(!root?.keys)throw Error('Нет раздела KeyBindings/Keys');
 const keys={},slotCastModes={},warnings=[];
 if(root.useherobindings==='1')warnings.push('Индивидуальные бинды героев не поддерживаются; общие клавиши требуют проверки.');
 for(const [name,action] of Object.entries(actions)){
   const normal=root.keys[action],quick=root.keys[action+'quickcast'];
   const node=normal?.key?normal:quick?.key?quick:null;
   if(!node){if(name==='selectHero'&&normal)keys[name]='';continue;}
   if(normal?.key&&quick?.key&&String(normal.key).toLowerCase()===String(quick.key).toLowerCase()){
     warnings.push(action+': одна клавиша для обычного и быстрого каста; проверь режим вручную');continue;
   }
   const raw=String(node.key||'').toLowerCase(),key=aliases[raw]||(/^kp_\d$/.test(raw)?'NUM'+raw.at(-1):raw.toUpperCase());
   if((node.modifier&&node.modifier.toLowerCase()!=='none')||!vkOf(key)){warnings.push(action+': неподдерживаемая клавиша или модификатор');continue;}
   keys[name]=key;
   if(/^(slot|item)/.test(name)||['neutral','teleport'].includes(name)) {
     if(node===quick||node.mode==='2'||node.mode==='1')slotCastModes[name]='quickcast';
     else if(node.mode==='0')slotCastModes[name]='click';
   }
 }
 const itemCastModes={};
 for(const [name,node] of Object.entries(root.items||{})){
   if(/^item_[a-z0-9_]{1,100}$/.test(name)&&node&&typeof node==='object'){
     if(node.mode==='0')itemCastModes[name]='click';
     else if(node.mode==='1'||node.mode==='2')itemCastModes[name]='quickcast';
   }
 }
 return {keys,slotCastModes,warnings,itemCastModes};
}
function registry(key,name){
 try{const out=execFileSync('reg.exe',['query',key,'/v',name],{encoding:'utf8',windowsHide:true,timeout:3000});return out.split(/\r?\n/).find(l=>l.trim().toLowerCase().startsWith(name.toLowerCase()+' '))?.trim().split(/\s+REG_\w+\s+/i)[1];}catch{return undefined;}
}
function steamRoot(){
 const candidates=[registry('HKCU\\Software\\Valve\\Steam','SteamPath'),registry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam','InstallPath'),path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Steam')];
 return candidates.find(p=>p&&fs.existsSync(path.join(p,'steam.exe')));
}
function importBindings(){
 const steam=steamRoot();if(!steam)throw Error('Steam не найден');
 const root=path.join(steam,'userdata'),suffix=path.join('570','remote','cfg','dotakeys_personal.lst');
 const users=fs.readdirSync(root).filter(id=>/^\d+$/.test(id)&&fs.existsSync(path.join(root,id,suffix)));
 let active=registry('HKCU\\Software\\Valve\\Steam\\ActiveProcess','ActiveUser');
 if(active)try{active=String(BigInt(active));}catch{active=null;}
 if(!users.includes(active)) {
   if(users.length===1)active=users[0];else throw Error('Несколько аккаунтов Steam: войди в нужный аккаунт и повтори импорт');
 }
 return readBindings(readVdfFile(path.join(root,active,suffix)));
}
module.exports={parseVdf,readVdfFile,readBindings,importBindings};
