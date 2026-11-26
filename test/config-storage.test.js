const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveJsonAtomic } = require('../config-storage');
test('atomic settings save replaces valid JSON and keeps Unicode and unknown fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-config-'));
  try {
    const file = path.join(dir, 'config.json');
    saveJsonAtomic(file, { old: true });
    const data = { microphone: 'Микрофон', custom: { unknown: 42 } };
    saveJsonAtomic(file, data);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), data);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('failed serialization preserves existing preferences; failed rename cleans temporary file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-config-'));
  try {
    const file = path.join(dir, 'config.json');
    saveJsonAtomic(file, { keep: true });
    const before = fs.readFileSync(file, 'utf8');
    const circular = { self: null };
    circular.self = circular;
    assert.throws(() => saveJsonAtomic(file, circular));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const blocked = path.join(dir, 'blocked');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'keep'), 'safe');
    assert.throws(() => saveJsonAtomic(blocked, { overwrite: true }));
    assert.equal(fs.readFileSync(path.join(blocked, 'keep'), 'utf8'), 'safe');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['blocked', 'config.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
