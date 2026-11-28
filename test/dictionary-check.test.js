const test=require('node:test'),assert=require('node:assert/strict');
const {checkDictionary}=require('../model-words');
test('dictionary check normalizes case and spacing, validates every unique word',()=>{
 const words=new Set(['буря','ураган','щит']);
 assert.deepEqual(checkDictionary(words,['  БУРЯ ураган ','буря щит неизвестно']),{ready:true,words:[{word:'буря',available:true},{word:'ураган',available:true},{word:'щит',available:true},{word:'неизвестно',available:false}]});
 assert.deepEqual(checkDictionary(null,['буря']),{ready:false,words:[{word:'буря',available:null}]});
 assert.deepEqual(checkDictionary(words,[]),{ready:true,words:[]});
 assert.throws(()=>checkDictionary(words,['x'.repeat(121)]));
 assert.throws(()=>checkDictionary(words,Array(101).fill('щит')));
 assert.throws(()=>checkDictionary(words,[null]));
});
