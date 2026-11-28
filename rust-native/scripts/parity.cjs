// Differential recording: execute real 1.1.1 JS functions and compare with Rust.
// No mocks of their return values, no Electron, no WinAPI calls.
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const {createPhraseParser,createRecognitionGate,PREPARE_PREFIXES}=require(path.join(root,'phrase-parser'));
const {createVoiceCast,vkOf}=require(path.join(root,'logic'));
const {getTiming}=require(path.join(root,'timing-profiles'));
const {readBindings}=require(path.join(root,'dota-bindings'));
const {catalog}=require(path.join(root,'phrase-preferences'));
const spells=require(path.join(root,'spells'));
const extra=require(path.join(root,'extra-phrases.json'));
const src=fs.readFileSync(path.join(root,'main.js'),'utf8');
const section=src.slice(src.indexOf('  phrases: {'),src.indexOf('  // Для отладки'));
const base={};
for(const m of section.matchAll(/(invoker_\w+):\s*\[([\s\S]*?)\]/g))base[m[1]]=[...m[2].replace(/\/\/[^\n]*/g,'').matchAll(/'([^']*)'/g)].map(x=>x[1]);
const phrases=catalog(base,extra);const grammar=Object.values(phrases).flat();
assert.equal(grammar.length,143);
const rustCatalog=require('../data/spells.json');
assert.deepEqual(Object.fromEntries(rustCatalog.map(s=>[s.id,s.phrases])),phrases);
const cases=[],expected=[];
function add(c,fn){cases.push(c);try{expected.push({ok:true,value:fn()});}catch{expected.push({ok:false});}}
const parse=createPhraseParser(grammar);
for(const phrase of grammar){
    for(const text of [phrase,phrase.toUpperCase(),'  '+phrase+'  ','[unk] '+phrase,...PREPARE_PREFIXES.map(p=>p+' '+phrase)]){
        add({op:'parse',grammar,text},()=>parse(text));
    }
}
for(const text of ['запиши торнадо','готовь торнадо метеор','торнадо метеор','[unk]','', 'запиши в фолиант торнадо готовь эмп','фолиант эмп'])add({op:'parse',grammar,text},()=>parse(text));
for(const hypotheses of [[['готовь торнадо',false],['торнадо',true]],[['готовь',false],['готовь торнадо',true]],[['торнадо',false],['торнадо метеор',true]]]){
    add({op:'gate',grammar,hypotheses},()=>{const g=createRecognitionGate(parse);return hypotheses.map(([s,f])=>g.read(s,f));});
}
for(const key of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',...Array.from({length:24},(_,i)=>'F'+(i+1)),...Array.from({length:10},(_,i)=>'NUM'+i),'MOUSE3','MOUSE4','MOUSE5','NUM+','NUM-','NUM*','NUM/','NUM.','UP','DOWN','LEFT','RIGHT','TAB','SPACE','CAPSLOCK','BACKSPACE','INSERT','DELETE','HOME','END','PAGEUP','PAGEDOWN','`','-','=','[',']','\\',';',"'",',','.','/','bad','',' f1 '])add({op:'key',key},()=>vkOf(key));
const defaultConfig={keys:{quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F'},voiceChatKey:'G',castMode:'click',timingProfile:'normal',listen:'hold'};
for(const config of [defaultConfig,{...defaultConfig,castMode:'quickcast'},{...defaultConfig,slotCastModes:{slot2:'quickcast'},keyDelayMs:15,fastTiming:{clickDelayMs:7},turboTiming:{altDelayMs:0}},{...defaultConfig,keys:{...defaultConfig.keys,quas:'MOUSE4'}}]){
    for(const profile of ['normal','fast','turbo']){
        add({op:'timing',config,profile},()=>getTiming(config,profile));
        for(const spell of spells)for(const action of [1,2,3,4]){
            add({op:'sequence',config,id:spell.id,action,profile},()=>createVoiceCast(config,{isGameActive:()=>true,emit(){},quit(){}}).buildSequence(spell,action,profile));
        }
    }
}
for(const text of [
    '"KeyBindings" { "Keys" { "AbilityPrimary1" { "Key" "a" } "AbilitySecondary1Quickcast" { "Key" "d" } "Inventory1" { "Key" "kp_1" "Mode" "0" } } }',
    '"KeyBindings" { "UseHeroBindings" "1" "Keys" { "AbilityPrimary1" { "Key" "Q" "Modifier" "alt" } } }',
    '"KeyBindings" { "Keys" { "ChatVoiceTeam" { "Key" "key_cyrillic_be" } } }',
    '"KeyBindings" { "Keys" { "AbilityPrimary2" { "Key" "uparrow" } } }',
    '"a" {',
]){
    add({op:'bindings',text},()=>{const {keys,slotCastModes,warnings}=readBindings(text);return {keys,slotCastModes,warningCount:warnings.length};});
}
const exe=path.join(__dirname,'../target/release',process.platform==='win32'?'voice-invoker-native.exe':'voice-invoker-native');
const result=spawnSync(exe,['parity-jsonl'],{input:cases.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',maxBuffer:32*1024*1024,timeout:60000});
if(result.error||result.status!==0)throw Error(String(result.error||result.stderr));
const actual=result.stdout.trim().split(/\r?\n/).map(x=>JSON.parse(x));
assert.equal(actual.length,cases.length);
for(let i=0;i<cases.length;i++){try{assert.deepEqual(actual[i],expected[i]);}catch(e){throw Error('Case '+i+' '+JSON.stringify({...cases[i],grammar:undefined})+'\n'+e.message);}}
console.log('PASS: '+cases.length+' differential cases against actual 1.1.1 JS (catalog, parser, gate, virtual keys, timing, sequences, VDF)');
