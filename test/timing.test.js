const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceCast, ACTION, vkOf } = require('../logic');
const { NORMAL, FAST, TURBO, MAX_CAST_ID, getTiming, encodeCast, decodeCast } = require('../timing-profiles');
const spells = require('../spells');
const config = { keys: { quas:'Q', wex:'W', exort:'E', invoke:'R', slot1:'D', slot2:'F' }, voiceChatKey:'G', listen:'hold', castMode:'click', blockKeys:['invoke'], ...NORMAL };
const build = (cfg = config, emit = () => {}) => createVoiceCast(cfg, { isGameActive: () => true, emit, quit() {} });
const waits = steps => steps.reduce((n,s) => n+s.wait,0);
test('profiles preserve input order and all eleven combinations', () => {
  const v = build();
  for (const spell of spells) for (const action of Object.values(ACTION)) {
    const normal = v.buildSequence(spell,action,'normal'), fast = v.buildSequence(spell,action,'fast');
    assert.deepEqual(fast.map(({wait,...s})=>s), normal.map(({wait,...s})=>s));
    const turbo = v.buildSequence(spell,action,'turbo');
    assert.deepEqual(turbo.map(({wait,...s})=>s), normal.map(({wait,...s})=>s));
    assert.ok(waits(turbo) <= waits(fast));
    assert.ok(waits(fast) <= waits(normal));
  }
  const spell=spells.find(s=>s.name==='Cold Snap');
  assert.equal(waits(v.buildSequence(spell,ACTION.INVOKE,'normal')),255);
  assert.equal(waits(v.buildSequence(spell,ACTION.INVOKE,'fast')),180);
  assert.equal(waits(v.buildSequence(spell,ACTION.PREPARE,'fast')),60);
  assert.equal(waits(v.buildSequence(spell,ACTION.INVOKE,'turbo')),140);
  assert.equal(waits(v.buildSequence(spell,ACTION.PREPARE,'turbo')),30);
  const quick = build({...config,castMode:'quickcast'});
  assert.equal(waits(quick.buildSequence(spell,ACTION.INVOKE,'turbo')),120);
  const cat=spells.find(s=>s.name==='Cataclysm');
  assert.deepEqual(v.buildSequence(cat,ACTION.SLOT1,'fast').map(s=>s.type),['down','key','up']);
  assert.equal(waits(v.buildSequence(cat,ACTION.SLOT1,'fast')),40);
  assert.equal(waits(v.buildSequence(cat,ACTION.SLOT1,'turbo')),40);
});
test('hotkeys select and enable profiles; existing sequence and explicit snapshot stay unchanged', () => {
  const events=[],v=build(config,m=>events.push(m));
  const spell=spells[0], old=v.buildSequence(spell,ACTION.INVOKE);
  v.handleKey(0x11,true);v.handleKey(0x10,true);
  assert.equal(v.handleKey(vkOf('F11'),true),true);
  assert.equal(v.state.timingProfile,'fast');
  assert.equal(v.handleKey(vkOf('F11'),true),true);
  assert.equal(events.filter(e=>e.event==='profile').length,1);
  assert.equal(v.handleKey(vkOf('F11'),false),true);
  assert.equal(waits(old),255);
  assert.equal(waits(v.buildSequence(spell,ACTION.INVOKE)),180);
  assert.equal(waits(v.buildSequence(spell,ACTION.INVOKE,'normal')),255);
  assert.equal(v.handleKey(vkOf('F12'),true),true);
  assert.equal(v.state.timingProfile,'turbo');
  assert.equal(v.handleKey(vkOf('F12'),false),true);
  assert.equal(waits(v.buildSequence(spell,ACTION.INVOKE)),140);
  v.handleKey(vkOf('F7'),true);v.handleKey(vkOf('F7'),false);
  assert.equal(v.state.enabled,false);
  v.handleKey(vkOf('F10'),true);v.handleKey(vkOf('F10'),false);
  assert.equal(v.state.enabled,true);assert.equal(v.state.timingProfile,'normal');
});
test('custom normal delays and profile request protocol', () => {
  assert.equal(getTiming({...config,keyDelayMs:12},'normal').keyDelayMs,12);
  assert.equal(getTiming({...config,keyDelayMs:12},'fast').keyDelayMs,12);
  assert.equal(getTiming({...config,fastTiming:{keyDelayMs:5}},'fast').keyDelayMs,5);
  for (const id of [1,42,MAX_CAST_ID]) for(const action of Object.values(ACTION)) for(const profile of ['normal','fast','turbo']) {
    assert.deepEqual(decodeCast(encodeCast(action,profile,id)),{id,action,profile});
  }
  assert.throws(()=>decodeCast(0));
  assert.throws(()=>decodeCast(32+24+1));
  assert.throws(()=>encodeCast(1,'turbo',MAX_CAST_ID+1));
  assert.equal(getTiming(config,'turbo').castDelayMs,90);
  assert.equal(getTiming({...config,keyDelayMs:8},'turbo').keyDelayMs,8);
});
