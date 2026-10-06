'use strict';

const path = require('node:path');
const closure = require('../pipeline-updates/phase3-calibration-closure.cjs');

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  if (args.length !== 2 || args[0] !== '--review-directory' || !args[1])
    throw new Error('PHASE3_CALIBRATION_CLOSE_USAGE');
  return { reviewDirectory: path.resolve(args[1]) };
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write('Usage: node scripts/phase3-calibration-close.cjs --review-directory <ACT1_B009 local review directory>\n');
    return null;
  }
  const result = closure.buildClosure(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`PHASE3_CALIBRATION_CLOSE_FAILED:${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, main };
