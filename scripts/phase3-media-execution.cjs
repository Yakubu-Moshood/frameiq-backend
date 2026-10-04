'use strict';

const path = require('node:path');
const activation = require('./phase2.3b-p-activate.cjs');
const mediaExecution = require('../pipeline-updates/phase3-media-execution.cjs');

const PACKAGE_DIRECTORY = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
  'phase3-consolidated-act5-production-candidate-20261004-v5');
const ARTIFACT_ROOT = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const REVIEW_ROOT = path.join(activation.ROOT, '.review', 'phase3-media-execution');
const RUNNER = mediaExecution.createMediaExecution({ packageDirectory: PACKAGE_DIRECTORY,
  episodeRoot: activation.ROOT, reviewRoot: REVIEW_ROOT, activationRunner: activation,
  b009ApprovalPath: path.join(ARTIFACT_ROOT, 'phase3-act5-b009-human-approval-20261004.v1.json'),
  b016ApprovalPath: path.join(ARTIFACT_ROOT, 'phase3-act5-b016-human-approval-20261004.v1.json') });

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  if (args.length !== 3 || !['--stage-v5', '--preflight'].includes(args[0]) || args[1] !== '--run-id') {
    throw new Error('PHASE3_MEDIA_EXECUTION_USAGE: node /app/scripts/phase3-media-execution.cjs --stage-v5|--preflight --run-id <phase3-media-execution-v5-...>');
  }
  if (!mediaExecution.RUN_RE.test(args[2])) throw new Error('PHASE3_MEDIA_EXECUTION_RUN_ID_INVALID');
  return { mode: args[0] === '--stage-v5' ? 'stage' : 'preflight', runId: args[2] };
}
function main(args = process.argv.slice(2), runner = RUNNER) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write('Usage: node /app/scripts/phase3-media-execution.cjs --stage-v5|--preflight --run-id <phase3-media-execution-v5-...>\n');
    return null;
  }
  const result = options.mode === 'stage' ? runner.stage(options) : runner.preflight(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`PHASE3_MEDIA_EXECUTION_FAILED:${error.message}\n`); process.exitCode = 1; }
}

module.exports = { PACKAGE_DIRECTORY, ARTIFACT_ROOT, REVIEW_ROOT, parseArgs, main };
