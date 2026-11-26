const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const manifest = require('./model-manifest.json');

function selectExpandedModel(modelDir, enabled, expected = manifest) {
  const file = path.join(modelDir, expected.filename);
  if (enabled === false) return { file, active: false, reason: 'disabled' };
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expected.size || crypto.createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      return { file, active: false, reason: 'checksum mismatch' };
    }
    return { file, active: true, reason: 'verified V2' };
  } catch (error) {
    return { file, active: false, reason: error.code === 'ENOENT' ? 'missing' : error.message };
  }
}
module.exports = { selectExpandedModel };
