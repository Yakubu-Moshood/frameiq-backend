'use strict';

const path = require('node:path');
const activation = require('./phase2.3b-p-activate.cjs');
const production = require('../pipeline-updates/phase3-production-batch.cjs');

const ARTIFACT_ROOT = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const PACKAGE_DIRECTORY = path.join(ARTIFACT_ROOT, 'phase3-production-batch-planning-20261006-v1');
const CANDIDATE_PACKAGE_DIRECTORY = path.join(ARTIFACT_ROOT,
  'phase3-consolidated-act5-production-candidate-20261004-v5');
const WORK_ROOT = path.join(activation.ROOT, '.review', 'phase3-production-batch-v1');
const WORKFLOW = production.createProductionBatchWorkflow({ packageDirectory: PACKAGE_DIRECTORY,
  candidatePackageDirectory: CANDIDATE_PACKAGE_DIRECTORY, artifactRoot: ARTIFACT_ROOT,
  episodeRoot: activation.ROOT, workRoot: WORK_ROOT, activationRunner: activation });

function pairs(args, allowed) {
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || typeof value !== 'string' || value.startsWith('--') || values[key] !== undefined)
      throw new Error('PHASE3_PRODUCTION_BATCH_USAGE');
    values[key] = value;
  }
  return values;
}
function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { mode: 'help' };
  if (args[0] === '--status' && args.length === 1) return { mode: 'status' };
  if (args[0] === '--preflight' && (args.length === 1 || (args.length === 2 && args[1] === '--first-batch')))
    return { mode: 'preflight', firstBatchOnly: args.length === 2 };
  if (args[0] === '--prepare-replacement' && args.length === 3 && args[1] === '--failed-request-key'
    && args[2] === production.ACT1_B010_FAILED_REQUEST_KEY)
    return { mode: 'prepare-replacement' };
  if (args[0] === '--create-replacement-authorization') {
    const values = pairs(args, new Set(['--failed-request-key', '--authorized-at']));
    if (args.length !== 5 || values['--failed-request-key'] !== production.ACT1_B010_FAILED_REQUEST_KEY
      || typeof values['--authorized-at'] !== 'string') throw new Error('PHASE3_PRODUCTION_BATCH_USAGE');
    return { mode: 'create-replacement-authorization', authorizedAt: values['--authorized-at'] };
  }
  if (args[0] === '--preflight-replacement') {
    const values = pairs(args, new Set(['--failed-request-key', '--authorization-file',
      '--expected-authorization-sha256']));
    if (![3, 7].includes(args.length) || values['--failed-request-key'] !== production.ACT1_B010_FAILED_REQUEST_KEY
      || (args.length === 7 && (!values['--authorization-file']
        || !/^[a-f0-9]{64}$/u.test(values['--expected-authorization-sha256'] || ''))))
      throw new Error('PHASE3_PRODUCTION_BATCH_USAGE');
    return { mode: 'preflight-replacement', authorizationFile: values['--authorization-file'] || null,
      expectedAuthorizationSha256: values['--expected-authorization-sha256'] || null };
  }
  if (['--generate', '--ingest-controlled-still'].includes(args[0])) {
    const ingest = args[0] === '--ingest-controlled-still';
    const values = pairs(args, new Set(['--request-key', '--authorization-file',
      '--expected-authorization-sha256', ...(ingest ? ['--input-file'] : [])]));
    const expected = ingest ? 9 : 7;
    if (args.length !== expected || !/^[a-f0-9]{64}$/u.test(values['--request-key'] || '')
      || !/^[a-f0-9]{64}$/u.test(values['--expected-authorization-sha256'] || '')
      || !values['--authorization-file'] || (ingest && !values['--input-file']))
      throw new Error('PHASE3_PRODUCTION_BATCH_USAGE');
    return { mode: ingest ? 'ingest' : 'generate', requestKey: values['--request-key'],
      authorizationFile: values['--authorization-file'],
      expectedAuthorizationSha256: values['--expected-authorization-sha256'],
      inputFile: values['--input-file'] || null };
  }
  if (['--inspect', '--recover'].includes(args[0])) {
    const values = pairs(args, new Set(['--request-key']));
    if (args.length !== 3 || !/^[a-f0-9]{64}$/u.test(values['--request-key'] || ''))
      throw new Error('PHASE3_PRODUCTION_BATCH_USAGE');
    return { mode: args[0].slice(2), requestKey: values['--request-key'] };
  }
  if (['--approve', '--reject'].includes(args[0])) {
    const values = pairs(args, new Set(['--request-key', '--decision-file', '--expected-decision-sha256']));
    if (args.length !== 7 || !/^[a-f0-9]{64}$/u.test(values['--request-key'] || '')
      || !/^[a-f0-9]{64}$/u.test(values['--expected-decision-sha256'] || '') || !values['--decision-file'])
      throw new Error('PHASE3_PRODUCTION_BATCH_USAGE');
    return { mode: args[0].slice(2), requestKey: values['--request-key'],
      decisionFile: values['--decision-file'], expectedDecisionSha256: values['--expected-decision-sha256'] };
  }
  throw new Error('PHASE3_PRODUCTION_BATCH_USAGE');
}
function help() {
  return 'Usage:\n'
    + '  node /app/scripts/phase3-production-batch.cjs --status\n'
    + '  node /app/scripts/phase3-production-batch.cjs --preflight [--first-batch]\n'
    + '  node /app/scripts/phase3-production-batch.cjs --prepare-replacement --failed-request-key <sha256>\n'
    + '  node /app/scripts/phase3-production-batch.cjs --create-replacement-authorization --failed-request-key <sha256> --authorized-at <ISO-UTC>\n'
    + '  node /app/scripts/phase3-production-batch.cjs --preflight-replacement --failed-request-key <sha256> [--authorization-file <path> --expected-authorization-sha256 <sha256>]\n'
    + '  node /app/scripts/phase3-production-batch.cjs --generate --request-key <sha256> --authorization-file <path> --expected-authorization-sha256 <sha256>\n'
    + '  node /app/scripts/phase3-production-batch.cjs --ingest-controlled-still --request-key <sha256> --input-file <png> --authorization-file <path> --expected-authorization-sha256 <sha256>\n'
    + '  node /app/scripts/phase3-production-batch.cjs --inspect|--recover --request-key <sha256>\n'
    + '  node /app/scripts/phase3-production-batch.cjs --approve|--reject --request-key <sha256> --decision-file <path> --expected-decision-sha256 <sha256>\n';
}
async function main(args = process.argv.slice(2), workflow = WORKFLOW) {
  const options = parseArgs(args);
  if (options.mode === 'help') { process.stdout.write(help()); return null; }
  let result;
  if (options.mode === 'status') result = workflow.status();
  else if (options.mode === 'preflight') result = workflow.preflight(options);
  else if (options.mode === 'prepare-replacement') result = workflow.prepareReplacement();
  else if (options.mode === 'create-replacement-authorization')
    result = workflow.createReplacementAuthorization(options);
  else if (options.mode === 'preflight-replacement') result = workflow.preflightReplacement(options);
  else if (options.mode === 'generate') result = await workflow.generate(options);
  else if (options.mode === 'ingest') result = workflow.ingestControlled(options);
  else if (options.mode === 'inspect') result = workflow.inspect(options);
  else if (options.mode === 'recover') result = await workflow.recover(options);
  else if (options.mode === 'approve') result = workflow.approve(options);
  else result = workflow.reject(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`PHASE3_PRODUCTION_BATCH_FAILED:${error.message}\n`); process.exitCode = 1;
});

module.exports = { ARTIFACT_ROOT, PACKAGE_DIRECTORY, CANDIDATE_PACKAGE_DIRECTORY, WORK_ROOT,
  WORKFLOW, parseArgs, help, main };
