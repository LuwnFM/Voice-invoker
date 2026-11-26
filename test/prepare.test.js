const test = require('node:test');
const assert = require('node:assert/strict');
const { PREPARE_PREFIXES, createPhraseParser, decodeVoiceCommand, recognitionGrammar, createRecognitionGate } = require('../phrase-parser');
const { createVoiceCast, ACTION } = require('../logic');
const { NORMAL } = require('../timing-profiles');
const spells = require('../spells');
const phrases = ['торнадо','метеор','сан страйк','катаклизм','моржи'];
test('exactly four accepted preparation prefixes, ordinary commands unchanged',()=>{
  assert.deepEqual(PREPARE_PREFIXES,['запиши в фолиант','записать в фолиант','подготовить','подготовь']);
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
