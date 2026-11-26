const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {allowedHost,allowedOrigin,jsonContentType,readJson,MAX_BODY_BYTES}=require('../local-http');
const {validateKeys}=require('../key-validation');
test('local HTTP checks host, origin and JSON media type',()=>{
 assert.ok(allowedHost('127.0.0.1:3055',3055));assert.ok(allowedHost('localhost:3055',3055));assert.ok(!allowedHost('remote.invalid:3055',3055));assert.ok(!allowedHost('localhost:3056',3055));
 assert.ok(allowedOrigin(undefined,3055));assert.ok(allowedOrigin('http://localhost:3055',3055));assert.ok(!allowedOrigin('https://remote.invalid',3055));assert.ok(!allowedOrigin('null',3055));
 assert.ok(jsonContentType('application/json; charset=utf-8'));assert.ok(!jsonContentType('text/plain'));
});
test('bounded JSON reader rejects malformed and oversized body',async()=>{
 const input=x=>Readable.from([Buffer.from(x)]);
 assert.deepEqual(await readJson(input('{"x":1}')),{x:1});
 for(const v of ['null','[]','{'])await assert.rejects(readJson(input(v)),e=>e instanceof Error && 'statusCode' in e && e.statusCode===400);
 await assert.rejects(readJson(input('x'.repeat(MAX_BODY_BYTES+1))),e=>e instanceof Error && 'statusCode' in e && e.statusCode===413);
});
test('key conflicts rejected server-side including item slots',()=>{
 validateKeys({quas:'Q',item1:'X',item2:''},'G');
 assert.throws(()=>validateKeys({quas:'Q',item1:'q'},'G'));
 assert.throws(()=>validateKeys({quas:'Q',neutral:'G'},'G'));
 assert.throws(()=>validateKeys({quas:'unknown'},'G'));
});
