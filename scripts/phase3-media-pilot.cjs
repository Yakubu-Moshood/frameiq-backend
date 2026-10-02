'use strict';

const pilot = require('../pipeline-updates/phase3-media-pilot.cjs');

async function main(argv) {
  try {
    const result = await pilot.cli(argv);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Error surfaces are codes only; credential material and provider response
    // bodies are intentionally never printed.
    process.stderr.write(`${String(error.message || error).split(':')[0]}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
