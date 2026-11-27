const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('capture loss aborts active recognizer and pending finals without submitting a cast',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','overlay.html'),'utf8');
 const start=source.indexOf('  function abortRecognition()'),end=source.indexOf('  function stopCapture(',start);
 assert.ok(start>=0&&end>start);
 let removed=0,reset=0,cleared=0;
 const ctx=vm.createContext({listening:true,rec:{remove(){removed++;}},flushing:[{}],flushTimer:1,preroll:[1,2],prerollSamples:2,resetUtterance(){reset++;},clearTimeout(){cleared++;}});
 vm.runInContext(source.slice(start,end)+'\nabortRecognition();',ctx);
 assert.equal(ctx.listening,false);assert.equal(ctx.rec,null);assert.equal(ctx.flushing.length,0);assert.equal(ctx.flushTimer,null);assert.equal(ctx.preroll.length,0);assert.equal(ctx.prerollSamples,0);assert.equal(removed,1);assert.equal(reset,1);assert.equal(cleared,1);
});
