const path = require('node:path');
const { prepareExpandedModel } = require('../model-selection');
(async () => {
  const result = await prepareExpandedModel(path.resolve(process.argv[2] || 'model'), true, { log: console.log });
  if (!result.active) throw new Error(result.reason);
  console.log('Verified:', result.file);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
