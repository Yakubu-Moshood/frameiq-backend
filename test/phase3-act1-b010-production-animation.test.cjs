'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const production = require('../pipeline-updates/phase3-production-batch.cjs');
const mediaExecution = require('../pipeline-updates/phase3-media-execution.cjs');
const cli = require('../scripts/phase3-production-batch.cjs');

const ROOT = path.resolve(__dirname, '..');
const WELLS = path.join(ROOT, 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const PACKAGE = path.join(WELLS, 'phase3-production-batch-planning-20261006-v1');
const CANDIDATE = path.join(WELLS, 'phase3-consolidated-act5-production-candidate-20261004-v5');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function png(width, height, suffix) {
  const bytes = Buffer.alloc(24 + suffix.length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  Buffer.from(suffix).copy(bytes, 24); return bytes;
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-b010-production-animation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const episodeRoot = path.join(root, 'episode'), workRoot = path.join(episodeRoot, '.review',
    'phase3-production-batch-v1');
  fs.mkdirSync(workRoot, { recursive: true });
  const planning = production.verifyPlanningPackage({ packageDirectory: PACKAGE });
  const jobs = production.buildJobs(planning.plan);
  const failed = jobs.find(job => job.requestKey === production.ACT1_B010_FAILED_REQUEST_KEY);
  const authHash = 'a'.repeat(64);
  const failedReservation = production.appendLedger(workRoot, { recordType: 'SUBMISSION_RESERVED',
    requestKey: failed.requestKey, beatId: failed.beatId, requestType: failed.type, routeId: failed.routeId,
    externalProviderRequest: true, maximumCostUsd: failed.maximumCostUsd, authorizationSha256: authHash,
    packageIndexSha256: production.PACKAGE_INDEX_SHA256, retriesAllowed: 0, fallbackAllowed: false,
    reservedAt: '2026-10-20T10:00:00.000Z' });
  const failedResult = production.appendLedger(workRoot, { recordType: 'SUBMISSION_RESULT',
    requestKey: failed.requestKey, beatId: failed.beatId, requestType: failed.type,
    status: 'FAILED_REQUEST_KEY_CONSUMED', retryCount: 0, fallbackUsed: false, outputSha256: null,
    rawOutputSha256: null, receiptSha256: null, providerRequestId: null, actualChargeUsd: null,
    errorCode: 'Gateway Timeout', recordedAt: '2026-10-20T10:01:00.000Z' });
  const baselineLedgerSha256 = hash(fs.readFileSync(path.join(workRoot, 'request-ledger.jsonl')));
  const failedTerminal = json({ status: 'FAILED_REQUEST_KEY_CONSUMED', requestKey: failed.requestKey });
  const failedDirectory = path.join(workRoot, 'requests', failed.requestKey);
  write(path.join(failedDirectory, 'terminal-result.json'), failedTerminal);
  const replacementTrust = { failedRequestKey: failed.requestKey,
    animationRequestKey: production.ACT1_B010_ANIMATION_REQUEST_KEY, manifestBindingSha256: 'b'.repeat(64),
    batchExposureUsd: 0.5, failure: { ledgerSha256: baselineLedgerSha256, authorizationSha256: authHash,
      reservationEntrySha256: failedReservation.entrySha256, resultEntrySha256: failedResult.entrySha256,
      terminalRecordSha256: hash(failedTerminal) } };
  const replacementKey = production.deriveAct1B010ReplacementKey(failed, replacementTrust);
  const replacement = { ...failed, requestKey: replacementKey };
  const replacementDirectory = path.join(workRoot, 'requests', replacementKey);
  const lineage = { schemaVersion: production.REPLACEMENT_LINEAGE_SCHEMA,
    status: 'FAILED_REQUEST_PRESERVED_REPLACEMENT_AUTHORIZABLE', beatId: 'ACT1_B010',
    failedRequestKey: failed.requestKey, replacementRequestKey: replacementKey,
    animationRequestKey: production.ACT1_B010_ANIMATION_REQUEST_KEY,
    manifestBindingSha256: replacementTrust.manifestBindingSha256,
    packageIndexSha256: production.PACKAGE_INDEX_SHA256, failure: replacementTrust.failure,
    providerRequestId: null, providerResponsePresent: false, outputPresent: false,
    retries: 0, fallback: false, replacementSubmissionsAuthorizedByLineage: 0 };
  write(path.join(replacementDirectory, 'replacement-failure-lineage.v1.json'), json(lineage));
  const sourceReservation = production.appendLedger(workRoot, { recordType: 'SUBMISSION_RESERVED', requestKey: replacementKey,
    beatId: replacement.beatId, requestType: replacement.type, routeId: replacement.routeId,
    externalProviderRequest: true, maximumCostUsd: replacement.maximumCostUsd,
    authorizationSha256: 'c'.repeat(64), packageIndexSha256: production.PACKAGE_INDEX_SHA256,
    retriesAllowed: 0, fallbackAllowed: false, reservedAt: '2026-10-20T10:02:00.000Z' });
  const sourceResult = production.appendLedger(workRoot, { recordType: 'SUBMISSION_RESULT', requestKey: replacementKey,
    beatId: replacement.beatId, requestType: replacement.type, status: 'SUCCEEDED_PENDING_INSPECTION',
    retryCount: 0, fallbackUsed: false, outputSha256: 'd'.repeat(64), rawOutputSha256: 'e'.repeat(64),
    receiptSha256: 'f'.repeat(64), providerRequestId: 'replacement-provider-id', actualChargeUsd: 0.048,
    errorCode: null, recordedAt: '2026-10-20T10:03:00.000Z' });
  const original = png(1360, 768, 'preserved-provider-original');
  const derivative = png(1360, 768, 'approved-deterministic-derivative');
  const receipt = json({ status: 'GENERATED_PENDING_INSPECTION', requestKey: replacementKey });
  const inspection = json({ status: 'INSPECTION_PASS_PENDING_HUMAN_DECISION', requestKey: replacementKey });
  const terminal = json({ schemaVersion: 'phase3-production-request-result/1.0.0',
    status: sourceResult.status, requestKey: replacementKey,
    reservationEntrySha256: sourceReservation.entrySha256, resultEntrySha256: sourceResult.entrySha256,
    outputSha256: sourceResult.outputSha256, rawOutputSha256: sourceResult.rawOutputSha256,
    receiptSha256: sourceResult.receiptSha256, providerRequestId: sourceResult.providerRequestId,
    actualChargeUsd: sourceResult.actualChargeUsd, errorCode: sourceResult.errorCode,
    recordedAt: '2026-10-20T10:03:00.001Z' });
  write(path.join(replacementDirectory, 'raw-provider-output.png'), original);
  write(path.join(replacementDirectory, 'receipt.json'), receipt);
  write(path.join(replacementDirectory, 'inspection.json'), inspection);
  write(path.join(replacementDirectory, 'terminal-result.json'), terminal);
  const recipe = json({ schemaVersion: 'test-recipe/1', operation: 'deterministic-crop' });
  const approval = json({ schemaVersion: 'test-approval/1', approvedBy: 'Yakubu Moshood' });
  const inputFile = path.join(root, 'approved.png'), recipeFile = path.join(root, 'recipe.json');
  const approvalFile = path.join(root, 'approval.json');
  write(inputFile, derivative); write(recipeFile, recipe); write(approvalFile, approval);
  const animationTrust = { approvedDerivativeSha256: hash(derivative), approvedDerivativeBytes: derivative.length,
    width: 1360, height: 768, recipeSha256: hash(recipe), humanApprovalSha256: hash(approval),
    providerOriginalSha256: hash(original), replacementRequestKey: replacementKey,
    sourceReceiptSha256: hash(receipt), sourceInspectionSha256: hash(inspection),
    sourceTerminalResultSha256: sourceResult.entrySha256, sourceTerminalRecordSha256: hash(terminal),
    installationLedgerSha256: hash(fs.readFileSync(path.join(workRoot, 'request-ledger.jsonl'))),
    packageIndexSha256: production.PACKAGE_INDEX_SHA256,
    animationRequestKey: production.ACT1_B010_ANIMATION_REQUEST_KEY };
  let providerCalls = 0;
  const runtimeModule = path.join(root, 'runtime-module.cjs'), runtimeCli = path.join(root, 'runtime-cli.cjs');
  write(runtimeModule, Buffer.from('module-v1')); write(runtimeCli, Buffer.from('cli-v1'));
  const create = extra => production.createProductionBatchWorkflow({ packageDirectory: PACKAGE,
    candidatePackageDirectory: CANDIDATE, artifactRoot: WELLS, episodeRoot, workRoot,
    replacementTrust, act1B010AnimationTrust: animationTrust, modulePath: runtimeModule, cliPath: runtimeCli,
    verifyStage04Fn: () => ({ record: { status: 'PROMOTED' },
      recordSha256: mediaExecution.STAGE04_ACTIVATION_SHA256, promotedPathCount: 147,
      requestLedgerSha256: mediaExecution.REQUEST_LEDGER_SHA256 }),
    provider: { async generateStill() { throw new Error('unexpected still'); },
      async generateAnimation() { providerCalls++; return { url: 'https://fal.media/b010.mp4',
        providerRequestId: 'h3-b010', actualChargeUsd: 0.4, metadata: {} }; } },
    downloader: async () => ({ bytes: Buffer.from('immutable-h3-provider-original'), contentType: 'video/mp4' }),
    ffprobe: file => file.includes('raw-provider-output.mp4')
      ? { container: 'mp4', durationSec: 5, videoStreams: 1, audioStreams: 1,
        video: { codec: 'h264', width: 1344, height: 768, fps: 24, frames: 120 } }
      : { container: 'mp4', durationSec: 2.2, videoStreams: 1, audioStreams: 0,
        video: { codec: 'h264', width: 1344, height: 768, fps: 30, frames: 66 } },
    ffmpeg: (_command, args) => { fs.writeFileSync(args.at(-1), Buffer.from('silent-fitted-b010'));
      return { status: 0 }; }, now: () => '2026-10-21T10:00:00.000Z', ...extra });
  const workflow = create(overrides);
  return { root, workRoot, workflow, create, inputFile, recipeFile, approvalFile, animationTrust,
    derivative, runtimeModule, runtimeCli, providerCalls: () => providerCalls };
}

function install(f) {
  return f.workflow.installAct1B010ApprovedDerivative({ inputFile: f.inputFile,
    recipeFile: f.recipeFile, approvalFile: f.approvalFile });
}
function authorize(f) {
  const record = f.workflow.makeAct1B010AnimationAuthorizationTemplate({ authorizedAt: '2026-10-21T09:59:00.000Z' });
  const file = path.join(f.root, 'animation-authorization.json'); write(file, json(record));
  return { file, sha256: hash(fs.readFileSync(file)), record };
}

test('ACT1_B010 installs the exact approved derivative atomically with immutable original lineage', t => {
  const f = fixture(t), result = install(f);
  assert.notEqual(f.animationTrust.sourceTerminalResultSha256,
    f.animationTrust.sourceTerminalRecordSha256,
    'the historical ledger result hash is not the terminal record byte hash');
  assert.equal(result.status, 'ACT1_B010_APPROVED_DERIVATIVE_INSTALLED');
  assert.equal(result.providerSubmissions, 0);
  assert.equal(result.ledgerWrites, 0);
  assert.equal(result.derivative.sha256, f.animationTrust.approvedDerivativeSha256);
  assert.equal(f.workflow.act1B010AnimationStatus().timing.targetFrames, 66);
  assert.throws(() => install(f), /APPROVED_SOURCE_ALREADY_INSTALLED/);
});

test('ACT1_B010 rejects derivative, recipe, approval, original and lineage tampering', t => {
  for (const target of ['derivative', 'recipe', 'approval']) {
    const f = fixture(t);
    if (target === 'derivative') fs.appendFileSync(f.inputFile, 'x');
    if (target === 'recipe') fs.appendFileSync(f.recipeFile, 'x');
    if (target === 'approval') fs.appendFileSync(f.approvalFile, 'x');
    assert.throws(() => install(f), /ACT1_B010_(?:DERIVATIVE|RECIPE|APPROVAL)_INVALID/);
  }
  const f = fixture(t); install(f);
  const installed = path.join(f.workRoot, 'requests', production.ACT1_B010_ANIMATION_REQUEST_KEY,
    'approved-source-install', 'approved-source.png');
  fs.appendFileSync(installed, 'x');
  assert.throws(() => f.workflow.act1B010AnimationStatus(), /ACT1_B010_DERIVATIVE_INVALID/);
  const original = fixture(t); fs.appendFileSync(path.join(original.workRoot, 'requests',
    original.animationTrust.replacementRequestKey, 'raw-provider-output.png'), 'x');
  assert.throws(() => install(original), /ACT1_B010_PROVIDER_ORIGINAL_INVALID/);
  const terminal = fixture(t); fs.appendFileSync(path.join(terminal.workRoot, 'requests',
    terminal.animationTrust.replacementRequestKey, 'terminal-result.json'), ' ');
  assert.throws(() => install(terminal), /ACT1_B010_SOURCE_TERMINAL_RESULT_INVALID/);
  const lineage = fixture(t); install(lineage);
  const lineageFile = path.join(lineage.workRoot, 'requests', production.ACT1_B010_ANIMATION_REQUEST_KEY,
    'approved-source-install', 'lineage.json');
  const lineageRecord = JSON.parse(fs.readFileSync(lineageFile, 'utf8'));
  lineageRecord.approvedDerivative.bytes += 1; fs.writeFileSync(lineageFile, json(lineageRecord));
  assert.throws(() => lineage.workflow.act1B010AnimationStatus(), /ACT1_B010_SOURCE_LINEAGE_INVALID/);
});

test('ACT1_B010 authorization is exact ANIMATION_ONLY, source-bound and denies every adjacent operation', t => {
  const f = fixture(t); install(f); const auth = authorize(f);
  const preflight = f.workflow.preflightAct1B010Animation({ authorizationFile: auth.file,
    expectedAuthorizationSha256: auth.sha256 });
  assert.equal(preflight.status, 'ACT1_B010_ANIMATION_AUTHORIZED_NOT_EXECUTED');
  assert.equal(auth.record.request.operation, 'ANIMATION_ONLY');
  assert.equal(auth.record.request.beatId, 'ACT1_B010');
  assert.equal(auth.record.request.soleInputSha256, f.animationTrust.approvedDerivativeSha256);
  assert.deepEqual(auth.record.limits, { maximumProviderSubmissions: 1,
    maximumHumanAcceptedExposureUsd: 0.4, providerEnforced: false, retries: 0, fallback: false,
    requestKeyReuse: false });
  assert.equal(Object.values(auth.record.denials).every(Boolean), true);
  const altered = structuredClone(auth.record); altered.request.beatId = 'ACT1_B009'; write(auth.file, json(altered));
  assert.throws(() => f.workflow.preflightAct1B010Animation({ authorizationFile: auth.file,
    expectedAuthorizationSha256: hash(fs.readFileSync(auth.file)) }), /ANIMATION_AUTHORIZATION_INVALID/);
});

test('ACT1_B010 performs one H3 Max request, creates exact silent 66-frame output and blocks duplicates', async t => {
  const f = fixture(t); install(f); const auth = authorize(f);
  const receipt = await f.workflow.generate({ requestKey: production.ACT1_B010_ANIMATION_REQUEST_KEY,
    authorizationFile: auth.file, expectedAuthorizationSha256: auth.sha256 });
  assert.equal(receipt.output.video.frames, 66);
  assert.equal(receipt.output.audioStreams, 0);
  assert.equal(receipt.approvedSourceSha256, f.animationTrust.approvedDerivativeSha256);
  assert.equal(f.providerCalls(), 1);
  const inspection = f.workflow.inspect({ requestKey: production.ACT1_B010_ANIMATION_REQUEST_KEY });
  assert.equal(inspection.status, 'INSPECTION_PASS_PENDING_HUMAN_DECISION');
  await assert.rejects(() => f.workflow.generate({ requestKey: production.ACT1_B010_ANIMATION_REQUEST_KEY,
    authorizationFile: auth.file, expectedAuthorizationSha256: auth.sha256 }), /REQUEST_KEY_ALREADY_CONSUMED/);
  assert.equal(f.providerCalls(), 1);
});

test('ACT1_B010 completed history survives runtime changes and interrupted output recovers offline', async t => {
  const completed = fixture(t); install(completed); const completedAuth = authorize(completed);
  await completed.workflow.generate({ requestKey: production.ACT1_B010_ANIMATION_REQUEST_KEY,
    authorizationFile: completedAuth.file, expectedAuthorizationSha256: completedAuth.sha256 });
  fs.writeFileSync(completed.runtimeModule, 'module-v2'); fs.writeFileSync(completed.runtimeCli, 'cli-v2');
  assert.equal(completed.workflow.preflightAct1B010Animation().status,
    'ACT1_B010_ANIMATION_COMPLETED_HISTORICAL_COMPATIBLE');

  const interrupted = fixture(t); install(interrupted); const auth = authorize(interrupted);
  const requestKey = production.ACT1_B010_ANIMATION_REQUEST_KEY;
  const dir = path.join(interrupted.workRoot, 'requests', requestKey);
  write(path.join(dir, 'animation-execution-authorization.v1.json'), fs.readFileSync(auth.file));
  production.appendLedger(interrupted.workRoot, { recordType: 'SUBMISSION_RESERVED', requestKey,
    beatId: 'ACT1_B010', requestType: 'ANIMATION_CLIP', routeId: 'H3_MAX_I2V_5S_768P',
    externalProviderRequest: true, maximumCostUsd: 0.4, authorizationSha256: auth.sha256,
    packageIndexSha256: production.PACKAGE_INDEX_SHA256, retriesAllowed: 0, fallbackAllowed: false,
    reservedAt: '2026-10-21T10:00:00.000Z' });
  write(path.join(dir, 'provider-response.json'), json({ url: 'https://fal.media/b010.mp4',
    providerRequestId: 'already-reserved-h3', actualChargeUsd: 0.4, metadata: {} }));
  const recovered = await interrupted.workflow.recover({ requestKey });
  assert.equal(recovered.status, 'RECOVERED_PENDING_INSPECTION');
  assert.equal(recovered.providerSubmissionsDuringRecovery, 0);
  assert.equal(interrupted.providerCalls(), 0);
  assert.equal(production.readLedger(interrupted.workRoot).at(-1).status, 'SUCCEEDED_PENDING_INSPECTION');
});

test('ACT1_B010 CLI remains exact-beat scoped for install, status, preflight, generation, inspection and recovery', () => {
  assert.equal(cli.parseArgs(['--act1-b010-animation-status']).mode, 'act1-b010-animation-status');
  assert.equal(cli.parseArgs(['--preflight-act1-b010-animation']).mode, 'preflight-act1-b010-animation');
  assert.equal(cli.parseArgs(['--inspect-act1-b010-animation']).requestKey,
    production.ACT1_B010_ANIMATION_REQUEST_KEY);
  assert.equal(cli.parseArgs(['--recover-act1-b010-animation']).requestKey,
    production.ACT1_B010_ANIMATION_REQUEST_KEY);
  assert.throws(() => cli.parseArgs(['--generate-act1-b010-animation']), /PHASE3_PRODUCTION_BATCH_USAGE/);
  assert.doesNotMatch(cli.help(), /candidate-reconstruct|stage04-modify/u);
});
