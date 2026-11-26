const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SPELLS = require('../spells');
const { ACTION } = require('../logic');
const { NORMAL, getTiming, normalizeProfile, encodeCast, decodeCast } = require('../timing-profiles');

function harness(withGsi = false) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('const queue = [];');
  const end = source.indexOf('// ---------- HTTP + SSE', start);
  assert.ok(start >= 0 && end > start);
  let now=1000;
  const requests=[], timers=new Map(), events=[];
  let timerId=0;
  const ctx=vm.createContext({
    SPELLS, ACTION, getTiming, normalizeProfile, encodeCast, WM_APP_CAST:0x8006,
    config:{...NORMAL,slotWaitMs:1500,timingProfile:'normal'},
    last:{state:{enabled:true,timingProfile:'normal'}},
    gsi:withGsi?{at:now,slots:[],abilities:{}}:null,
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
  h.ctx.gsi={at:1050,slots:[SPELLS[0].id],abilities:{}};
  h.api.checkSlot();assert.equal(h.requests.length,1);
  h.ack(req);assert.equal(h.requests.length,2);
  assert.equal(h.requests[1].action,ACTION.SLOT1);
  assert.equal(h.requests[1].profile,'normal');
});
test('failed sequence or disabled mode drops queued actions',()=>{
  const h=harness();h.api.castByPhrase('a');h.api.castByPhrase('b');h.ack(h.requests[0],false);
  h.advance(1000);h.api.pump();assert.equal(h.requests.length,1);
  const g=harness(true);g.api.castByPhrase('a');g.ctx.last.state.enabled=false;g.api.discardWaiting();g.ack(g.requests[0]);
  g.ctx.gsi={at:1100,slots:[SPELLS[0].id],abilities:{}};g.api.checkSlot();assert.equal(g.requests.length,1);
});
test('lost completion fails closed until original request responds',()=>{
  const h=harness();h.api.castByPhrase('a');
  const watchdog=[...h.timers.values()][0];watchdog.fn();
  h.api.castByPhrase('b');assert.equal(h.requests.length,1);
  h.ack(h.requests[0]);assert.equal(h.api.getActive(),null);
});
