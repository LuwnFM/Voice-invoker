const test=require('node:test'),assert=require('node:assert/strict');
const SPELLS=require('../spells');
const {resolveCommands}=require('../custom-commands');
const {mergeCatalog}=require('../phrase-preferences');
const {createPhraseParser,recognitionGrammar,PREPARE_PREFIXES}=require('../phrase-parser');
const words=new Set(['ураган','буря','торнадо','эмп','щит','готовь']);
const base={invoker_tornado:['торнадо'],invoker_emp:['эмп']};
const extra={};
test('custom aliases are additive, selectable, and work with every preparation prefix',()=>{
 const pref={customSpellPhrases:{invoker_tornado:[' Ураган ','буря']},disabledPhrases:{invoker_tornado:['буря']}};
 const r=resolveCommands(base,extra,pref,words,true);
 assert.deepEqual(r.active.invoker_tornado,['торнадо','ураган']);
 assert.deepEqual(r.customSpellPhrases.invoker_tornado,['ураган','буря']);
 assert.deepEqual(r.disabledPhrases.invoker_tornado,['буря']);
 const grammar=Object.values(r.active).flat(),parse=createPhraseParser(grammar);
 assert.deepEqual(parse('ураган'),['ураган']);assert.deepEqual(parse('буря'),[]);
 for(const prefix of PREPARE_PREFIXES){assert.ok(recognitionGrammar(grammar).includes(prefix+' ураган'));assert.deepEqual(parse(prefix+' ураган'),['подготовить ураган']);}
 const disabled=resolveCommands(base,extra,{...pref,disabledPhrases:{invoker_tornado:['торнадо','ураган','буря']}},words,true);
 assert.deepEqual(disabled.active.invoker_tornado,[]);
 assert.deepEqual(mergeCatalog(base,{invoker_tornado:['ураган']}),{invoker_tornado:['торнадо','ураган'],invoker_emp:['эмп']});
});
test('all eleven abilities accept dictionary words without losing built-ins',()=>{
 const catalog=Object.fromEntries(SPELLS.map(s=>[s.id,['base_'+s.id]]));
 const custom=Object.fromEntries(SPELLS.map((s,i)=>[s.id,['word'+i]]));
 const dict=new Set(Object.values(custom).flat());
 const r=resolveCommands(catalog,{}, {customSpellPhrases:custom},dict,true);
 for(const s of SPELLS)assert.deepEqual(r.active[s.id],[...catalog[s.id],...custom[s.id]]);
});
test('reject unknown words, preparation cues and active spell/item conflicts',()=>{
 for(const customSpellPhrases of [{invoker_tornado:['неизвестно']},{invoker_tornado:['готовь ураган']},{invoker_tornado:['эмп']},{invoker_tornado:['ураган'],invoker_emp:['ураган']}])assert.throws(()=>resolveCommands(base,extra,{customSpellPhrases},words,true));
 assert.throws(()=>resolveCommands(base,extra,{customSpellPhrases:{invoker_tornado:['щит']},itemPhrases:{item_slot_item1:['щит']}},words,true));
 const prefs={customSpellPhrases:{invoker_tornado:['ураган']},disabledPhrases:{invoker_tornado:['ураган']},itemPhrases:{item_slot_item1:['ураган']}};
 assert.deepEqual(resolveCommands(base,extra,prefs,words,true).active.item_slot_item1,['ураган']);
 assert.throws(()=>resolveCommands(base,extra,{...prefs,disabledPhrases:{}},words,true));
 const fallback=resolveCommands(base,extra,{customSpellPhrases:{invoker_tornado:['ураган']}},new Set(),false,{strict:false});
 assert.deepEqual(fallback.active.invoker_tornado,['торнадо']);assert.ok(fallback.errors.length);
});
