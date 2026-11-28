// Read-only Steam/Dota configuration importer. Never edits Steam files.
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {vkOf}=require('./logic');
function parseVdf(text){
 const tokens=String(text).replace(/^\uFEFF/,'').match(/"(?:\\.|[^"\\])*"|[{}]|\/\/[^\r\n]*|[^\s{}"]+/g)||[];
 let i=0;
 function value(t){return t?.startsWith('"')?t.slice(1,-1).replace(/\\(["\\])/g,'$1'):t;}
 function next(){while(tokens[i]?.startsWith('//'))i++;return tokens[i++];}
 function block(nested=false){const out=Object.create(null);for(;;){const k=next();if(k===undefined){if(nested)throw Error('Unclosed VDF block');return out;}if(k==='}'){if(!nested)throw Error('Unexpected VDF brace');return out;}const v=next();if(v===undefined||v==='}')throw Error('Missing VDF value');out[value(k).toLowerCase()]=v==='{'?block(true):value(v);}}
 return block();
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
 return {keys,slotCastModes,warnings};
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
 return readBindings(fs.readFileSync(path.join(root,active,suffix),'utf8'));
}
module.exports={parseVdf,readBindings,importBindings};
