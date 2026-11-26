const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validZip, findCached } = require('../scripts/ensure-runtime');
test('runtime cache accepts only matching SHA-256', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-cache-'));
  try {
    fs.mkdirSync(path.join(dir, 'a'));fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'a', 'electron.zip'), 'invalid');
    fs.writeFileSync(path.join(dir, 'b', 'electron.zip'), 'valid');
    const hash = crypto.createHash('sha256').update('valid').digest('hex');
    assert.equal(validZip(path.join(dir,'a','electron.zip'),hash),false);
    assert.equal(findCached(dir,'electron.zip',hash),path.join(dir,'b','electron.zip'));
    assert.equal(findCached(dir,'electron.zip','0'.repeat(64)),null);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
