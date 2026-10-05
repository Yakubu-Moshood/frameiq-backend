'use strict';

const path = require('node:path');
const activation = require('./phase2.3b-p-activate.cjs');
const mediaExecution = require('../pipeline-updates/phase3-media-execution.cjs');
const b009SourceStill = require('../pipeline-updates/phase3-media-calibration-source-still.cjs');
const b009Animation = require('../pipeline-updates/phase3-media-calibration-animation.cjs');

const PACKAGE_DIRECTORY = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
  'phase3-consolidated-act5-production-candidate-20261004-v5');
const ARTIFACT_ROOT = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const REVIEW_ROOT = path.join(activation.ROOT, '.review', 'phase3-media-execution');
const RUNNER = mediaExecution.createMediaExecution({ packageDirectory: PACKAGE_DIRECTORY,
  episodeRoot: activation.ROOT, reviewRoot: REVIEW_ROOT, activationRunner: activation,
  b009ApprovalPath: path.join(ARTIFACT_ROOT, 'phase3-act5-b009-human-approval-20261004.v1.json'),
  b016ApprovalPath: path.join(ARTIFACT_ROOT, 'phase3-act5-b016-human-approval-20261004.v1.json') });
const B009_SOURCE_STILL = b009SourceStill.createB009SourceStillWorkflow({ stagedRunner: RUNNER,
  episodeRoot: activation.ROOT, reviewRoot: REVIEW_ROOT,
  b006ApprovalPath: path.join(ARTIFACT_ROOT, 'phase3-act1-b006-calibration-human-approval-20261005.v1.json') });
const B009_ANIMATION = b009Animation.createB009AnimationWorkflow({ sourceStillWorkflow: B009_SOURCE_STILL,
  episodeRoot: activation.ROOT, reviewRoot: REVIEW_ROOT,
  approvalPath: b009Animation.SOURCE_STILL_APPROVAL_PATH });
RUNNER.setCalibrationAnimationRunFilesVerifier(({ runDir, fsImpl }) =>
  B009_ANIMATION.verifyStagedRunFiles({ runDir, fsImpl }));

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  if (args.length === 3 && ['--stage-v5', '--preflight'].includes(args[0]) && args[1] === '--run-id') {
    if (!mediaExecution.RUN_RE.test(args[2])) throw new Error('PHASE3_MEDIA_EXECUTION_RUN_ID_INVALID');
    return { mode: args[0] === '--stage-v5' ? 'stage' : 'preflight', runId: args[2] };
  }
  const modes = ['--generate-calibration-still', '--calibration-status', '--inspect-calibration-still',
    '--calibration-source-still-status', '--preflight-calibration-source-still',
    '--generate-calibration-source-still', '--inspect-calibration-source-still',
    '--calibration-animation-status', '--preflight-calibration-animation',
    '--generate-calibration-animation', '--inspect-calibration-animation']
    .filter(flag => args.includes(flag));
  if (modes.length !== 1 || args[0] !== modes[0]) throw new Error('PHASE3_MEDIA_EXECUTION_USAGE');
  const allowed = new Set([modes[0], '--phase3-run-id', '--beat-id',
    ...(['--generate-calibration-still', '--generate-calibration-source-still', '--generate-calibration-animation'].includes(modes[0])
      ? ['--expected-execution-authorization-sha256'] : [])]);
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!allowed.has(flag) || typeof value !== 'string' || value.startsWith('--') || values[flag] !== undefined)
      throw new Error('PHASE3_MEDIA_EXECUTION_USAGE');
    values[flag] = value;
  }
  if (values['--phase3-run-id'] !== mediaExecution.CALIBRATION_RUN_ID)
    throw new Error('PHASE3_CALIBRATION_RUN_FORBIDDEN');
  const isB009 = modes[0].includes('source-still');
  if (values['--beat-id'] !== (modes[0].includes('animation') || isB009 ? b009SourceStill.BEAT_ID : mediaExecution.CALIBRATION_BEAT_ID))
    throw new Error('PHASE3_CALIBRATION_BEAT_FORBIDDEN');
  if (['--generate-calibration-still', '--generate-calibration-source-still', '--generate-calibration-animation'].includes(modes[0])
    && !/^[a-f0-9]{64}$/u.test(values['--expected-execution-authorization-sha256'] || ''))
    throw new Error('PHASE3_CALIBRATION_EXPECTED_AUTHORIZATION_HASH_REQUIRED');
  const expectedLength = ['--generate-calibration-still', '--generate-calibration-source-still', '--generate-calibration-animation'].includes(modes[0]) ? 7 : 5;
  if (args.length !== expectedLength) throw new Error('PHASE3_MEDIA_EXECUTION_USAGE');
  return { mode: modes[0].slice(2), runId: values['--phase3-run-id'], beatId: values['--beat-id'],
    expectedAuthorizationSha256: values['--expected-execution-authorization-sha256'] || null };
}
async function main(args = process.argv.slice(2), runner = RUNNER, sourceStillWorkflow = B009_SOURCE_STILL) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write('Usage:\n'
      + '  node /app/scripts/phase3-media-execution.cjs --stage-v5|--preflight --run-id <phase3-media-execution-v5-...>\n'
      + '  node /app/scripts/phase3-media-execution.cjs --generate-calibration-still --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B006 --expected-execution-authorization-sha256 <sha256>\n'
      + '  node /app/scripts/phase3-media-execution.cjs --calibration-status --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B006\n'
      + '  node /app/scripts/phase3-media-execution.cjs --inspect-calibration-still --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B006\n'
      + '  node /app/scripts/phase3-media-execution.cjs --calibration-source-still-status --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B009\n'
      + '  node /app/scripts/phase3-media-execution.cjs --preflight-calibration-source-still --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B009\n'
      + '  node /app/scripts/phase3-media-execution.cjs --generate-calibration-source-still --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B009 --expected-execution-authorization-sha256 <sha256>\n'
      + '  node /app/scripts/phase3-media-execution.cjs --inspect-calibration-source-still --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B009\n'
      + '  node /app/scripts/phase3-media-execution.cjs --calibration-animation-status --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B009\n'
      + '  node /app/scripts/phase3-media-execution.cjs --preflight-calibration-animation --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B009\n'
      + '  node /app/scripts/phase3-media-execution.cjs --generate-calibration-animation --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B009 --expected-execution-authorization-sha256 <sha256>\n'
      + '  node /app/scripts/phase3-media-execution.cjs --inspect-calibration-animation --phase3-run-id phase3-media-execution-v5-20261004-01 --beat-id ACT1_B009\n');
    return null;
  }
  let result;
  if (options.mode === 'stage') result = runner.stage(options);
  else if (options.mode === 'preflight') {
    const completedSourceStillVerification = options.runId === b009SourceStill.RUN_ID
      ? sourceStillWorkflow.verifyCompletedState() : null;
    result = runner.preflight({ ...options, completedSourceStillVerification });
  }
  else if (options.mode === 'generate-calibration-still') result = await runner.generateCalibrationStill(options);
  else if (options.mode === 'calibration-source-still-status') result = B009_SOURCE_STILL.status();
  else if (options.mode === 'preflight-calibration-source-still') result = B009_SOURCE_STILL.preflight();
  else if (options.mode === 'generate-calibration-source-still')
    result = await B009_SOURCE_STILL.generate({ expectedAuthorizationSha256: options.expectedAuthorizationSha256 });
  else if (options.mode === 'inspect-calibration-source-still') result = B009_SOURCE_STILL.inspect();
  else if (options.mode === 'calibration-animation-status') result = B009_ANIMATION.status();
  else if (options.mode === 'preflight-calibration-animation') result = B009_ANIMATION.preflight();
  else if (options.mode === 'generate-calibration-animation')
    result = await B009_ANIMATION.generate({ expectedAuthorizationSha256: options.expectedAuthorizationSha256 });
  else if (options.mode === 'inspect-calibration-animation') result = B009_ANIMATION.inspect();
  else if (options.mode === 'calibration-status') result = runner.calibrationStatus(options);
  else result = runner.inspectCalibrationStill(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => { process.stderr.write(`PHASE3_MEDIA_EXECUTION_FAILED:${error.message}\n`); process.exitCode = 1; });
}

module.exports = { PACKAGE_DIRECTORY, ARTIFACT_ROOT, REVIEW_ROOT, parseArgs, main, B009_SOURCE_STILL, B009_ANIMATION };
