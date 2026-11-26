const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SPELLS = require('../spells');
const { ACTION, createVoiceCast, vkOf } = require('../logic');
const { decodeVoiceCommand } = require('../phrase-parser');
const { NORMAL, getTiming, normalizeProfile, encodeCast, decodeCast, MAX_CAST_ID } = require('../timing-profiles');

function harness(withGsi = false, realPlan = false) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf(realPlan ? 'function plan(' : 'const queue = [];');
  const end = source.indexOf('// ---------- HTTP + SSE', start);
  assert.ok(start >= 0 && end > start);
  let now=1000;
  const requests=[], timers=new Map(), events=[];
  let timerId=0;
  const ctx=vm.createContext({
    SPELLS, ACTION, decodeVoiceCommand, getTiming, normalizeProfile, encodeCast, MAX_CAST_ID, WM_APP_CAST:0x8006,
    config:{...NORMAL,slotWaitMs:1500,timingProfile:'normal'},
    last:{state:{enabled:true,voiceReady:true,timingProfile:'normal'}},
    gsi:withGsi?{at:now,hero:'npc_dota_hero_invoker',alive:true,slots:[],abilities:{}}:null,
    gsiWarned:false,
    predicted:null, prediction:()=>ctx.predicted,
    phraseToSpell:{a:SPELLS[0].id,b:SPELLS[1].id},
    plan:()=>({action:ACTION.INVOKE}),
    toHook:(message,spell,encoded)=>{requests.push({spell,...decodeCast(encoded)});return true;},
    log(){}, broadcast:m=>events.push(m),
    screen:{getPrimaryDisplay:()=>({bounds:{width:100,height:100}}),getCursorScreenPoint:()=>({x:0,y:0})},
    Date:{now:()=>now},
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},
    clearTimeout:id=>timers.delete(id)
  });
  vm.runInContext(source.slice(start,end)+'\nthis.api={castByPhrase,handleCastComplete,checkSlot,pump,discardWaiting,getActive:()=>activeCast,getAwaiting:()=>awaitingSlot};',ctx);
  return {ctx,requests,events,timers,api:ctx.api,advance:ms=>{now+=ms;},ack:(request,ok=true)=>ctx.api.handleCastComplete({...request,ok,elapsedMs:1})};
}
test('queue waits for actual acknowledgement, ignores wrong IDs and observes chain gap',()=>{
  const h=harness();
  h.api.castByPhrase('a'); h.api.castByPhrase('b');
  assert.equal(h.requests.length,1);
  h.advance(1000);h.api.pump();
  assert.equal(h.requests.length,1);
  h.api.handleCastComplete({id:999,ok:true});assert.equal(h.requests.length,1);
  h.ctx.last.state.timingProfile='fast';
  h.ack(h.requests[0]);
  assert.equal(h.requests.length,1);
  h.advance(40);h.api.pump();
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].profile,'fast');
});
test('split Invoke preserves original profile despite hotkey switch and waits for worker',()=>{
  const h=harness(true);
  h.api.castByPhrase('a');
  const req=h.requests[0];assert.equal(req.action,ACTION.PREPARE);
  h.ctx.last.state.timingProfile='fast';
  h.advance(50);
  h.ctx.gsi={at:1050,hero:'npc_dota_hero_invoker',alive:true,slots:[SPELLS[0].id],abilities:{}};
  h.api.checkSlot();assert.equal(h.requests.length,1);
  h.ack(req);assert.equal(h.requests.length,2);
  assert.equal(h.requests[1].action,ACTION.SLOT1);
  assert.equal(h.requests[1].profile,'normal');
});
test('failed sequence or disabled mode drops queued actions',()=>{
  const h=harness();h.api.castByPhrase('a');h.api.castByPhrase('b');h.ack(h.requests[0],false);
  h.advance(1000);h.api.pump();assert.equal(h.requests.length,1);
  const g=harness(true);g.api.castByPhrase('a');g.ctx.last.state.enabled=false;g.api.discardWaiting();g.ack(g.requests[0]);
  g.ctx.gsi={at:1100,hero:'npc_dota_hero_invoker',alive:true,slots:[SPELLS[0].id],abilities:{}};g.api.checkSlot();assert.equal(g.requests.length,1);
});
test('lost completion fails closed until original request responds',()=>{
  const h=harness();h.api.castByPhrase('a');
  const watchdog=[...h.timers.values()][0];watchdog.fn();
  h.api.castByPhrase('b');assert.equal(h.requests.length,1);
  h.ack(h.requests[0]);assert.equal(h.api.getActive(),null);
});

test('turbo snapshot persists across GSI, then next command uses newly selected profile',()=>{
  const h=harness(true);
  h.ctx.last.state.timingProfile='turbo';
  h.api.castByPhrase('a');h.api.castByPhrase('b');
  const req=h.requests[0];assert.equal(req.profile,'turbo');
  h.ctx.last.state.timingProfile='normal';
  h.advance(50);h.ctx.gsi={at:1050,hero:'npc_dota_hero_invoker',alive:true,slots:[SPELLS[0].id],abilities:{}};
  h.ack(req);assert.equal(h.requests[1].profile,'turbo');
  h.ack(h.requests[1]);h.advance(9);h.api.pump();assert.equal(h.requests.length,2);
  h.advance(1);h.api.pump();assert.equal(h.requests.length,3);assert.equal(h.requests[2].profile,'normal');
});

test('prepare prefix sends only PREPARE, waits for GSI and never presses slot',()=>{
  const h=harness(true,true);h.api.castByPhrase('подготовить a');
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].action,ACTION.PREPARE);
  h.ack(h.requests[0]);h.advance(50);
  h.ctx.gsi={at:1050,hero:'npc_dota_hero_invoker',alive:true,slots:[SPELLS[0].id],abilities:{[SPELLS[0].id]:{cooldown:5}}};
  h.api.checkSlot();assert.equal(h.requests.length,1);assert.equal(h.events.at(-1).event,'prepared');
  h.api.castByPhrase('a');h.advance(40);h.api.pump();assert.equal(h.requests.length,1);assert.equal(h.events.at(-1).event,'refuse');
});
test('existing slot is not reinvoked and no-GSI prepare is unconfirmed',()=>{
  const h=harness(true,true);h.ctx.gsi.slots=[SPELLS[0].id];h.ctx.gsi.abilities[SPELLS[0].id]={cooldown:8,can_cast:false};h.api.castByPhrase('подготовь a');
  assert.equal(h.requests.length,0);assert.equal(h.events.at(-1).event,'prepared');
  const g=harness(false,true);g.api.castByPhrase('запиши в фолиант b');assert.equal(g.requests[0].action,ACTION.PREPARE);g.ack(g.requests[0]);assert.equal(g.requests.length,1);assert.equal(g.events.at(-1).event,'prepare-unconfirmed');
});

test('voice preparation is integrated into every existing timing profile',()=>{
  for(const profile of ['normal','fast','turbo']){
    const h=harness(true,true);h.ctx.last.state.timingProfile=profile;
    h.api.castByPhrase('готовь a');
    assert.equal(h.requests.length,1);assert.equal(h.requests[0].action,ACTION.PREPARE);assert.equal(h.requests[0].profile,profile);
    h.ack(h.requests[0]);h.advance(50);
    h.ctx.gsi={at:1050,hero:'npc_dota_hero_invoker',alive:true,slots:[SPELLS[0].id],abilities:{}};
    h.api.checkSlot();assert.equal(h.requests.length,1);assert.equal(h.events.at(-1).event,'prepared');
  }
});

test('after Invoke, changed hero state or disabled ability prevents slot input',()=>{
 for(const changed of [{alive:false},{hero:'npc_dota_hero_axe'},{abilities:{[SPELLS[0].id]:{cooldown:0,can_cast:false}}}]){
  const h=harness(true,true);h.api.castByPhrase('a');h.ack(h.requests[0]);h.advance(50);
  h.ctx.gsi={at:1050,hero:'npc_dota_hero_invoker',alive:true,slots:[SPELLS[0].id],abilities:{},...changed};
  h.api.checkSlot();assert.equal(h.requests.length,1);assert.equal(h.events.at(-1).event,'refuse');
 }
});

test('microphone loss drops queued casts',()=>{const h=harness();h.api.castByPhrase('a');h.api.castByPhrase('b');h.ctx.last.state.voiceReady=false;h.ack(h.requests[0]);h.advance(1000);h.api.pump();assert.equal(h.requests.length,1);h.api.castByPhrase('b');assert.equal(h.requests.length,1);});

// Real PTT state changes wired into the queue harness: unlisten must not cancel.
test('hold-to-talk release and re-press preserve a queued combo in every profile',()=>{
 for(const profile of ['normal','fast','turbo']){
  const h=harness();
  const voice=createVoiceCast({keys:{quas:'Q',wex:'W',exort:'E',invoke:'R',slot1:'D',slot2:'F'},voiceChatKey:'G',listen:'hold',timingProfile:profile},{isGameActive:()=>true,emit:message=>{h.ctx.last=message;if(!message.state.enabled||!message.state.voiceReady)h.api.discardWaiting();},quit(){}});
  voice.setVoiceReady(true);
  voice.handleKey(vkOf('G'),true);h.api.castByPhrase('a');assert.equal(h.requests.length,1);
  voice.handleKey(vkOf('G'),false);assert.equal(voice.state.listening,false);assert.equal(voice.state.enabled,true);
  voice.handleKey(vkOf('G'),true);h.api.castByPhrase('b');voice.handleKey(vkOf('G'),false);
  assert.equal(h.requests.length,1);h.ack(h.requests[0]);h.advance(100);h.api.pump();
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].profile,profile);assert.equal(voice.state.listening,false);
 }
});
