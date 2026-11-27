const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

// Write beside the destination, then replace it atomically. A failed write must
// never truncate the last valid configuration or leave an incomplete JSON file.
function saveJsonAtomic(file, value) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  const temp = file + '.' + randomUUID() + '.tmp';
  let created = false;
  try {
    const fd = fs.openSync(temp, 'wx');
    created = true;
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } finally {
    if (created) fs.rmSync(temp, { force: true });
  }
}
module.exports = { saveJsonAtomic };
