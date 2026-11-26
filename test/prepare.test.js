const test = require('node:test');
const assert = require('node:assert/strict');
const { PREPARE_PREFIXES, createPhraseParser, decodeVoiceCommand, recognitionGrammar, createRecognitionGate } = require('../phrase-parser');
const { createVoiceCast, ACTION } = require('../logic');
const { NORMAL } = require('../timing-profiles');
const spells = require('../spells');
const phrases = ['торнадо','метеор','сан страйк','катаклизм','моржи'];
test('exactly six accepted preparation prefixes, ordinary commands unchanged',()=>{
  assert.deepEqual(PREPARE_PREFIXES,['запиши в фолиант','записать в фолиант','подготовить','подготовь','готовь','готовить']);
  const parse=createPhraseParser(phrases);
  for(const prefix of PREPARE_PREFIXES)for(const phrase of phrases) {
    assert.deepEqual(parse(prefix+' '+phrase),['подготовить '+phrase]);
    assert.deepEqual(decodeVoiceCommand(prefix+' '+phrase),{phrase,prepareOnly:true});
    assert.ok(recognitionGrammar(phrases).includes(prefix+' '+phrase));
  }
  assert.deepEqual(parse('торнадо метеор'),['торнадо','метеор']);
  assert.deepEqual(parse('подготовь торнадо метеор'),['подготовить торнадо','подготовить метеор']);
  assert.deepEqual(parse('запиши в торнадо'),[]);
  assert.deepEqual(parse('записать в фолиант'),[]);
  for(const prefix of ['запомнить','собери','в фолиант']) assert.equal(decodeVoiceCommand(prefix+' торнадо').prepareOnly,false);
});
test('preparation cue blocks provisional casts and survives a changed partial hypothesis',()=>{
  const gate=createRecognitionGate(createPhraseParser(phrases));
  assert.deepEqual(gate.read('запиши в',false),[]);
  assert.deepEqual(gate.read('торнадо',false),[]);
  assert.deepEqual(gate.read('торнадо',true),[]);
  assert.deepEqual(gate.read('запиши в фолиант торнадо',false),[]);
  assert.deepEqual(gate.read('запиши в фолиант торнадо',true),['подготовить торнадо']);
  gate.reset();assert.deepEqual(gate.read('метеор',false),['метеор']);
});
test('PREPARE sequence never presses a slot, clicks or Alt, for all spells and profiles',()=>{
  const config={keys:{quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F'},voiceChatKey:'G',listen:'hold',castMode:'click',...NORMAL};
  const voice=createVoiceCast(config,{isGameActive:()=>true,emit(){},quit(){}});
  for(const spell of spells)for(const profile of ['normal','fast','turbo']){
    const steps=voice.buildSequence(spell,ACTION.PREPARE,profile);
    assert.equal(steps.length,4);
    assert.equal(steps.at(-1).vk,82);
    assert.ok(steps.every(s=>s.type==='key'&&[81,87,69,82].includes(s.vk)));
  }
});

// Extract the same default phrases consumed by configurePhrases, not a hand-maintained sample.
test('all 143 default phrases remain casts and all 858 prefixed variants prepare',()=>{
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname,'..','main.js'),'utf8');
  const section = source.match(/  phrases: \{[\s\S]*?\n  \},\n  \/\/ Для отладки/)[0];
  const extra = require('../extra-phrases.json');
  const all = [...section.matchAll(/invoker_(\w+):\s*\[([\s\S]*?)\],/g)].flatMap(m=>[
    ...[...m[2].replace(/\/\/[^\n]*/g,'').matchAll(/'([^']+)'/g)].map(x=>x[1]),
    ...extra[m[1]].ready,...extra[m[1]].pending
  ]);
  assert.equal(all.length,143);
  assert.equal(new Set(all).size,143);
  const parse=createPhraseParser(all);
  const grammar=new Set(recognitionGrammar(all));
  for(const phrase of all){
    assert.deepEqual(parse(phrase),[phrase]);
    for(const prefix of PREPARE_PREFIXES){
      assert.ok(grammar.has(prefix+' '+phrase));
      assert.deepEqual(parse(prefix+' '+phrase),['подготовить '+phrase]);
    }
  }
  for(const prefix of PREPARE_PREFIXES){
    assert.deepEqual(parse(prefix),[]);
    const gate=createRecognitionGate(parse);
    assert.deepEqual(gate.read(prefix,false),[]);
    assert.deepEqual(gate.read('торнадо',false),[]);
    assert.deepEqual(gate.read(prefix+' торнадо',true),['подготовить торнадо']);
    gate.reset();assert.deepEqual(gate.read('когти торнаруса',false),['когти торнаруса']);
  }
});
