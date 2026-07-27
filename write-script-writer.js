const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, 'pipeline-updates', 'surface-script-writer.cjs');
const destination = '/data/pipeline/surface-script-writer.cjs';

fs.copyFileSync(source, destination);
console.log('surface-script-writer.cjs written from pipeline-updates source');
