const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createPhraseParser } = require('../phrase-parser');
const { selectExpandedModel, prepareExpandedModel } = require('../model-selection');
const extra = require('../extra-phrases.json');

test('RC model selection: verified, disabled, missing, invalid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoker-test-'));
  try {
    const bytes = Buffer.from('fixture');
    const manifest = { filename: 'model.tar.gz', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    assert.equal(selectExpandedModel(dir, undefined, manifest).reason, 'missing');
    fs.writeFileSync(path.join(dir, manifest.filename), bytes);
    assert.equal(selectExpandedModel(dir, undefined, manifest).active, true);
    assert.equal(selectExpandedModel(dir, false, manifest).active, false);
    fs.writeFileSync(path.join(dir, manifest.filename), Buffer.from('corrupt'));
    assert.equal(selectExpandedModel(dir, true, manifest).reason, 'checksum mismatch');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('approved aliases and exclusions', () => {
  const all = Object.values(extra).flatMap(x => [...x.ready, ...x.pending]);
  assert.equal(all.length, 62);
  for (const p of ['сан', 'ката', 'катак', 'баф', 'бафф', 'волна']) assert.ok(!all.includes(p));
  const parse = createPhraseParser([...all, 'сан страйк', 'ката клизм', 'моржи']);
  for (const p of ['сан', 'ката', 'катак']) assert.deepEqual(parse(p), []);
  for (const p of ['сан саныч', 'сан страйк', 'ката клизм', 'катаклизм', 'взрыв жопы', 'моржи']) assert.deepEqual(parse(p), [p]);
  assert.deepEqual(parse('сан саныч моржи катаклизм'), ['сан саныч', 'моржи', 'катаклизм']);
});

test('download V2, verify it, and reuse the local copy without network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoker-download-'));
  const bytes = Buffer.from('verified model fixture');
  const expected = { filename: 'model.tar.gz', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), downloadUrl: 'https://example.invalid/model' };
  let requests = 0;
  const fetchImpl = async (url) => {
    requests++;
    assert.equal(url, expected.downloadUrl);
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
  };
  try {
    assert.equal((await prepareExpandedModel(dir, false, { expected, fetchImpl })).reason, 'disabled');
    assert.equal(requests, 0);
    assert.equal((await prepareExpandedModel(dir, undefined, { expected, fetchImpl })).active, true);
    assert.deepEqual(fs.readFileSync(path.join(dir, expected.filename)), bytes);
    assert.equal((await prepareExpandedModel(dir, undefined, { expected, fetchImpl })).active, true);
    assert.equal(requests, 1);
    assert.deepEqual(fs.readdirSync(dir), [expected.filename]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reject HTML, HTTP errors, oversized, wrong hash and interrupted downloads; preserve existing file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoker-download-bad-'));
  const bytes = Buffer.from('expected');
  const expected = { filename: 'model.tar.gz', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), downloadUrl: 'https://example.invalid/model' };
  const file = path.join(dir, expected.filename);
  fs.writeFileSync(file, 'old');
  try {
    for (const fetchImpl of [
      async () => new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }),
      async () => new Response(null, { status: 403 }),
      async () => new Response(Buffer.alloc(40), { headers: { 'content-type': 'application/octet-stream' } }),
      async () => new Response(Buffer.from('badbytes'), { headers: { 'content-type': 'application/octet-stream' } }),
      async () => new Response(Buffer.from('short'), { headers: { 'content-type': 'application/octet-stream' } }),
      async () => { throw new Error('offline'); },
    ]) {
      assert.equal((await prepareExpandedModel(dir, undefined, { expected, fetchImpl })).active, false);
      assert.equal(fs.readFileSync(file, 'utf8'), 'old');
      assert.deepEqual(fs.readdirSync(dir), [expected.filename]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
