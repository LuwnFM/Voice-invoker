const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const manifest = require('./model-manifest.json');

function verifyBytes(bytes, expected) {
  return bytes.length === expected.size && crypto.createHash('sha256').update(bytes).digest('hex') === expected.sha256;
}

/** @param {string} modelDir @param {boolean|undefined} enabled @param {{filename:string,size:number,sha256:string}} [expected] */
function selectExpandedModel(modelDir, enabled, expected = manifest) {
  const file = path.join(modelDir, expected.filename);
  if (enabled === false) return { file, active: false, reason: 'disabled' };
  try {
    const bytes = fs.readFileSync(file);
    if (!verifyBytes(bytes, expected)) {
      return { file, active: false, reason: 'checksum mismatch' };
    }
    return { file, active: true, reason: 'verified V2' };
  } catch (error) {
    return { file, active: false, reason: error.code === 'ENOENT' ? 'missing' : error.message };
  }
}
// Download only once, and never replace a local archive with unverified bytes.
/** @param {string} modelDir @param {boolean|undefined} enabled @param {{expected?:{filename:string,size:number,sha256:string,downloadUrl:string},fetchImpl?:typeof fetch,log?:(...messages:string[])=>void}} [options] */
async function prepareExpandedModel(modelDir, enabled, { expected = manifest, fetchImpl = globalThis.fetch, log = (...messages) => {} } = {}) {
  const current = selectExpandedModel(modelDir, enabled, expected);
  if (current.active || enabled === false) return current;
  let tmp;
  try {
    fs.mkdirSync(modelDir, { recursive: true });
    log('Скачиваю модель Invoker V2 (~46 МБ)...');
    const response = await fetchImpl(expected.downloadUrl, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (/text\/html|application\/json/i.test(response.headers.get('content-type') || '')) {
      throw new Error('Google Drive returned a web page, not the model; check public download access');
    }
    if (!response.body) throw new Error('Empty download');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > expected.size) {
        throw new Error('Model size exceeds manifest');
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks, length);
    if (!verifyBytes(bytes, expected)) throw new Error('Model SHA-256 or size mismatch');
    tmp = current.file + '.' + crypto.randomUUID() + '.part';
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    fs.renameSync(tmp, current.file);
    log('Invoker V2 скачана и проверена (SHA-256 OK)');
    return { file: current.file, active: true, reason: 'verified V2' };
  } catch (error) {
    return { file: current.file, active: false, reason: 'download failed: ' + error.message };
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}
module.exports = { selectExpandedModel, prepareExpandedModel };
