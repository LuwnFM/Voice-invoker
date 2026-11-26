const test=require('node:test'),assert=require('node:assert/strict');
const {catalog,exclusions,enabledPhrases}=require('../phrase-preferences');
const {createPhraseParser,recognitionGrammar}=require('../phrase-parser');
test('excluded aliases survive model switches and cannot return automatically',()=>{
 const base={invoker_emp:['эмп','мана пульс']},extra={emp:{ready:['пульс'],pending:['пульс шимарэ']}};
 const all=catalog(base,extra),disabled=exclusions({invoker_emp:['эмп','мана пульс','пульс'],unknown:['x']},all);
 assert.deepEqual(enabledPhrases(all,disabled,extra,true),{invoker_emp:['пульс шимарэ']});
 assert.deepEqual(enabledPhrases(all,disabled,extra,false),{invoker_emp:[]});
 assert.deepEqual(createPhraseParser(enabledPhrases(all,disabled,extra,true).invoker_emp)('эмп'),[]);
 assert.ok(!recognitionGrammar(enabledPhrases(all,disabled,extra,true).invoker_emp).includes('подготовь эмп'));
 assert.deepEqual(enabledPhrases(all,exclusions({invoker_emp:all.invoker_emp},all),extra,true),{invoker_emp:[]});
});
test('individual slot quickcast overrides global mode',()=>{
 const {createVoiceCast,ACTION}=require('../logic');
 const spell=require('../spells')[0],config={keys:{slot1:'D',slot2:'F'},castMode:'click',slotCastModes:{slot2:'quickcast'}};
 const v=createVoiceCast(config,{isGameActive:()=>true,emit(){},quit(){}});
 assert.equal(v.buildSequence(spell,ACTION.SLOT1).length,2);
 assert.equal(v.buildSequence(spell,ACTION.SLOT2).length,1);
});
