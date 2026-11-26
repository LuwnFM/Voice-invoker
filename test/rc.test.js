const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createPhraseParser } = require('../phrase-parser');
const { selectExpandedModel } = require('../model-selection');
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
