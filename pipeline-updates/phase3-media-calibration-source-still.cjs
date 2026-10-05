'use strict';

// One-request ACT1_B009 source-still lane. All creative inputs come from the
// indexed v5 candidate; this module has no animation or production write path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mediaExecution = require('./phase3-media-execution.cjs');
const routes = require('./phase3-media-calibration-bundle.cjs');

const RUN_ID = 'phase3-media-execution-v5-20261004-01';
const BEAT_ID = 'ACT1_B009';
const OPERATION = 'GENERATE_ANIMATION_SOURCE_STILL';
const REQUEST_KEY = 'f10feb2552874270ce4af7705e5648e4beede07faedfa2a72072ba6633afdd02';
const RECONCILIATION_SHA256 = 'b93dd0f59f74197d7e7e9f7e4be0ef3360890dfdca8550f90101443dddc15207';
const B006_APPROVAL_SHA256 = 'd00ce391df1822468eb7fe2d07f85fc6404c483e1a79105c9e50aaa875c1dcd1';
const B006_HISTORICAL_RECEIPT_SHA256 = '730f1df08b948727c4c7950f8e0a70d51935d8ff69fdd72e5f7f3fce376175fd';
const B006_IMAGE_SHA256 = '5315292eecda643f19472224474cb011c70b4e7a3e104899ca6542b21ef1fe36';
const B006_AUTHORIZATION_SHA256 = 'b08ebd11da1018aafa388bf54e173655938453e50fc10bece4091a40c87abcc3';
const B006_LEDGER_SHA256 = 'f4ef26ce9b91d7976aecaa0e0a84014ae6d59a9726ce59f391ba8f63d1f417c1';
const B006_RECEIPT_STATUS_CANONICAL = 'CALIBRATION_STILL_GENERATED_PENDING_HUMAN_REVIEW';
const B006_RECEIPT_STATUS_HISTORICAL = 'GENERATED_PENDING_HUMAN_REVIEW';
const B006_BYTES = 1445712;
const ROUTE_BUNDLE_SHA256 = '6981bda36cd4e9dda4da5b701fb23b2f705e1fd5bb04fcca30157160bac85b42';
const AUTH_SCHEMA = 'phase3-media-calibration-source-still-authorization/1.0.0';
const LEDGER_SCHEMA = 'phase3-media-calibration-source-still-ledger/1.0.0';
const FILES = mediaExecution.CALIBRATION_SOURCE_STILL_FILES;
const CLASSIFICATION = 'NON_PRODUCTION_DISPOSABLE_CALIBRATION';
const OWNERSHIP = 'UNRESOLVED_ACCEPTED_FOR_NONPRODUCTION_CALIBRATION_ONLY';
const MAX_EXPOSURE_USD = 0.60;
const EXPECTED_CHARGE_USD = 0.024;
const MAX_BYTES = 32 * 1024 * 1024;
const SOURCE_STILL_APPROVAL_SHA256 = '8b2c41cff79bac73a89e22d80a953517091acaa98bc110d6447da06e835b548c';
const SOURCE_STILL_APPROVAL_PATH = path.resolve(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
  'phase3-act1-b009-source-still-human-approval-20261005.v2.json');

function fail(ok, code) { if (!ok) throw new Error(code); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function exactKeys(value, keys, code) {
  fail(value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), code);
}
function pngInfo(bytes) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fail(Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.subarray(0, 8).equals(sig)
    && bytes.toString('ascii', 12, 16) === 'IHDR', 'PHASE3_B009_OUTPUT_NOT_PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  fail(width > 0 && height > 0, 'PHASE3_B009_PNG_DIMENSIONS_INVALID');
  return { format: 'PNG', mimeType: 'image/png', width, height };
}
function b006ReceiptStatusAccepted(status, receiptSha256) {
  return status === B006_RECEIPT_STATUS_CANONICAL
    || (status === B006_RECEIPT_STATUS_HISTORICAL
      && receiptSha256 === B006_HISTORICAL_RECEIPT_SHA256);
}
function verifyB006CompletedState({ approvalSha256, authorizationSha256, imageSha256, imageBytes,
  receiptSha256, receiptRecord, ledgerSha256, ledgerRecords } = {}) {
  const reservation = Array.isArray(ledgerRecords) ? ledgerRecords[0] : null;
  const terminal = Array.isArray(ledgerRecords) ? ledgerRecords[1] : null;
  return approvalSha256 === B006_APPROVAL_SHA256
    && authorizationSha256 === B006_AUTHORIZATION_SHA256
    && imageSha256 === B006_IMAGE_SHA256 && imageBytes === B006_BYTES
    && receiptSha256 === B006_HISTORICAL_RECEIPT_SHA256
    && ledgerSha256 === B006_LEDGER_SHA256
    && b006ReceiptStatusAccepted(receiptRecord?.status, receiptSha256)
    && receiptRecord?.schemaVersion === mediaExecution.CALIBRATION_RECEIPT_SCHEMA
    && receiptRecord?.runId === RUN_ID && receiptRecord?.beatId === 'ACT1_B006'
    && receiptRecord?.operation === 'GENERATE_STILL'
    && receiptRecord?.requestKey === mediaExecution.CALIBRATION_REQUEST_KEY
    && receiptRecord?.authorizationSha256 === B006_AUTHORIZATION_SHA256
    && receiptRecord?.assetClass === 'NON_PRODUCTION_DISPOSABLE_CALIBRATION'
    && receiptRecord?.output?.path === mediaExecution.CALIBRATION_FILES.output
    && receiptRecord?.output?.format === 'PNG'
    && receiptRecord?.output?.width === 1360 && receiptRecord?.output?.height === 768
    && receiptRecord?.output?.sha256 === B006_IMAGE_SHA256
    && receiptRecord?.output?.bytes === B006_BYTES
    && Array.isArray(ledgerRecords) && ledgerRecords.length === 2
    && reservation?.schemaVersion === mediaExecution.CALIBRATION_LEDGER_SCHEMA
    && reservation?.recordType === 'SUBMISSION_RESERVED' && reservation?.sequence === 1
    && reservation?.runId === RUN_ID && reservation?.beatId === 'ACT1_B006'
    && reservation?.operation === 'GENERATE_STILL'
    && reservation?.requestKey === mediaExecution.CALIBRATION_REQUEST_KEY
    && reservation?.retryAllowed === false && reservation?.fallbackAllowed === false
    && terminal?.schemaVersion === mediaExecution.CALIBRATION_LEDGER_SCHEMA
    && terminal?.recordType === 'SUBMISSION_RESULT' && terminal?.status === 'SUCCEEDED'
    && terminal?.requestKey === mediaExecution.CALIBRATION_REQUEST_KEY;
}

function verifyCompletedSourceStillStateInternal({ runDir, approvalPath = SOURCE_STILL_APPROVAL_PATH,
  fsImpl = fs, expected = null } = {}) {
  const trust = expected || {
    runId: RUN_ID, beatId: BEAT_ID, operation: OPERATION, requestKey: REQUEST_KEY,
    approvalSha256: SOURCE_STILL_APPROVAL_SHA256,
    authorizationSha256: '0b3b6ca57f7a8895a97bc5a67501704cbbf74a437c7053d99b0882499b5a3599',
    receiptSha256: '95b75386224f14b213750667cd4715705e28428f5d868d545cfe7c0036294285',
    ledgerSha256: 'f59d219075a2e94476f94b74dd444517980599ad50be499e6c682838ee6c7823',
    outputSha256: '0a9c9311c20da7dc774b1695f9abe2ea56f648fc0eb2450a8c7f0c4130b9ffdc',
    outputBytes: 1324401, width: 1360, height: 768,
    stagedIndexSha256: routes.TRUST.stagedIndexSha256,
    candidateIndexSha256: routes.TRUST.candidateIndexSha256,
    outerIndexSha256: routes.TRUST.outerIndexSha256,
    routeBundleSha256: ROUTE_BUNDLE_SHA256,
    routeResolutionApprovalSha256: routes.ROUTE_APPROVAL_SHA256,
    reconciliationSha256: RECONCILIATION_SHA256,
    stage04ActivationRecordSha256: 'f60d360c0179c87329d4e6d8be7b39d09da7ccc9d6c2351645fa2d8a4062923d',
    stage04LedgerBaselineSha256: mediaExecution.REQUEST_LEDGER_SHA256,
    assetClass: CLASSIFICATION,
  };
  const failState = code => { throw new Error(code); };
  if (typeof runDir !== 'string' || !fsImpl.existsSync(runDir)) failState('PHASE3_B009_COMPLETED_RUN_MISSING');
  const runStat = fsImpl.lstatSync(runDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) failState('PHASE3_B009_COMPLETED_RUN_INVALID');
  const beatDir = path.join(runDir, trust.beatId);
  const beatStat = fsImpl.lstatSync(beatDir);
  if (!beatStat.isDirectory() || beatStat.isSymbolicLink()) failState('PHASE3_B009_COMPLETED_BEAT_DIRECTORY_INVALID');
  const expectedNames = ['authorization', 'ledger', 'output', 'receipt', 'result'].map(key =>
    path.posix.basename(FILES[key])).sort();
  const animationAuthorizationPaths = [
    'ACT1_B009/animation-execution-authorization.v1.json',
    'ACT1_B009/animation-execution-authorization.v2.json',
  ];
  const verifiedAnimationFiles = animationAuthorizationPaths.some(relative =>
    fsImpl.existsSync(path.join(runDir, ...relative.split('/'))))
    ? require('./phase3-media-calibration-animation.cjs').verifyStagedRunFiles({ runDir, fsImpl }) : [];
  const actualNames = fsImpl.readdirSync(beatDir).sort();
  const completeExpectedNames = [...expectedNames, ...verifiedAnimationFiles.map(relative => path.posix.basename(relative))].sort();
  if (canonicalJson(actualNames) !== canonicalJson(completeExpectedNames)) failState('PHASE3_B009_COMPLETED_FILE_SET_INVALID');
  for (const name of actualNames) {
    const stat = fsImpl.lstatSync(path.join(beatDir, name));
    if (!stat.isFile() || stat.isSymbolicLink()) failState('PHASE3_B009_COMPLETED_FILE_TYPE_INVALID');
  }
  const read = key => fsImpl.readFileSync(path.join(beatDir, path.posix.basename(FILES[key])));
  const approvalStat = fsImpl.lstatSync(approvalPath), approvalBytes = fsImpl.readFileSync(approvalPath);
  if (!approvalStat.isFile() || approvalStat.isSymbolicLink() || sha(approvalBytes) !== trust.approvalSha256)
    failState('PHASE3_B009_COMPLETED_APPROVAL_HASH_MISMATCH');
  const approval = JSON.parse(approvalBytes.toString('utf8'));
  const binding = approval.bindings || {};
  if (approval.schemaVersion !== 'phase3-act1-b009-source-still-human-approval/1.0.0'
    || approval.status !== 'APPROVED_FOR_ANIMATION_CALIBRATION_INPUT_ONLY'
    || approval.approvedBy !== 'Yakubu Moshood' || approval.runId !== trust.runId
    || approval.beatId !== trust.beatId || approval.operation !== trust.operation
    || approval.requestKey !== trust.requestKey || binding.sourceStillAuthorizationSha256 !== trust.authorizationSha256
    || binding.sourceStillReceiptSha256 !== trust.receiptSha256 || binding.sourceStillLedgerSha256 !== trust.ledgerSha256
    || binding.sourceStillSha256 !== trust.outputSha256 || binding.sourceStillBytes !== trust.outputBytes
    || binding.sourceStillFormat !== 'PNG' || binding.sourceStillWidth !== trust.width
    || binding.sourceStillHeight !== trust.height || binding.sourceStillAssetClass !== trust.assetClass
    || binding.sourceStillProductionReadiness !== 'REJECTED'
    || binding.stagedIndexSha256 !== trust.stagedIndexSha256
    || binding.candidateIndexSha256 !== trust.candidateIndexSha256
    || binding.outerIndexSha256 !== trust.outerIndexSha256
    || binding.routeBundleSha256 !== trust.routeBundleSha256
    || binding.routeResolutionApprovalSha256 !== trust.routeResolutionApprovalSha256
    || binding.requestKeyReconciliationSha256 !== trust.reconciliationSha256
    || binding.stage04ActivationRecordSha256 !== trust.stage04ActivationRecordSha256
    || binding.stage04LedgerBaselineSha256 !== trust.stage04LedgerBaselineSha256
    || approval.inspection?.persistedInspectionArtifact !== 'NONE'
    || approval.inspection?.inspectionArtifactSha256 !== null
    || approval.inspection?.observedStatus !== 'INSPECTED_PENDING_HUMAN_REVIEW'
    || approval.inspection?.humanDecision !== approval.status
    || approval.inspection?.originalMediaByteVerification !== 'PASS'
    || approval.restrictions?.animationExecutionAuthorized !== false
    || approval.restrictions?.providerRequestsAuthorized !== 0
    || approval.restrictions?.productionUse !== false || approval.restrictions?.rendering !== false
    || approval.restrictions?.promotion !== false || approval.restrictions?.candidateReconstruction !== false
    || approval.restrictions?.stage04Modification !== false || approval.restrictions?.episodeRootWrites !== false
    || approval.restrictions?.retry !== false || approval.restrictions?.fallback !== false
    || approval.restrictions?.additionalStillRequest !== false || approval.restrictions?.otherBeats !== false)
    failState('PHASE3_B009_COMPLETED_APPROVAL_BINDING_INVALID');

  const authorizationBytes = read('authorization'), receiptBytes = read('receipt'), resultBytes = read('result');
  const outputBytes = read('output'), ledgerBytes = read('ledger');
  if (sha(authorizationBytes) !== trust.authorizationSha256 || sha(receiptBytes) !== trust.receiptSha256
    || sha(ledgerBytes) !== trust.ledgerSha256 || sha(outputBytes) !== trust.outputSha256
    || outputBytes.length !== trust.outputBytes) failState('PHASE3_B009_COMPLETED_HASH_MISMATCH');
  const authorization = JSON.parse(authorizationBytes.toString('utf8'));
  const historicalRuntimeHashes = {
    moduleSha256: binding.deployedSourceStillWorkflowSha256,
    executionModuleSha256: binding.deployedMediaExecutionModuleSha256,
    cliSha256: binding.deployedCliSha256,
  };
  if (![historicalRuntimeHashes.moduleSha256, historicalRuntimeHashes.executionModuleSha256,
    historicalRuntimeHashes.cliSha256].every(value => /^[a-f0-9]{64}$/u.test(value || ''))
    || authorization.bindings?.deployedSourceStillWorkflowSha256 !== historicalRuntimeHashes.moduleSha256
    || authorization.bindings?.deployedMediaExecutionModuleSha256 !== historicalRuntimeHashes.executionModuleSha256
    || authorization.bindings?.deployedCliSha256 !== historicalRuntimeHashes.cliSha256)
    failState('PHASE3_B009_COMPLETED_HISTORICAL_RUNTIME_BINDING_INVALID');
  validateAuth(authorization, historicalRuntimeHashes);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const result = JSON.parse(resultBytes.toString('utf8'));
  if (!resultBytes.equals(Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8')))
    failState('PHASE3_B009_COMPLETED_RESULT_BINDING_INVALID');
  const verifySelfBound = (record, field, code) => {
    const body = { ...record }, supplied = body[field]; delete body[field];
    if (supplied !== sha(Buffer.from(canonicalJson(body), 'utf8'))) failState(code);
  };
  verifySelfBound(receipt, 'receiptBindingSha256', 'PHASE3_B009_COMPLETED_RECEIPT_BINDING_INVALID');
  verifySelfBound(result, 'resultBindingSha256', 'PHASE3_B009_COMPLETED_RESULT_BINDING_INVALID');
  if (receipt.schemaVersion !== 'phase3-media-calibration-source-still-receipt/1.0.0'
    || receipt.status !== 'GENERATED_PENDING_HUMAN_REVIEW' || receipt.runId !== trust.runId
    || receipt.beatId !== trust.beatId || receipt.operation !== trust.operation || receipt.requestKey !== trust.requestKey
    || receipt.authorizationSha256 !== trust.authorizationSha256 || receipt.assetClass !== trust.assetClass
    || receipt.ownershipDisposition !== OWNERSHIP || receipt.provider?.name !== 'fal.ai'
    || typeof receipt.completedAt !== 'string' || !Number.isFinite(Date.parse(receipt.completedAt))
    || new Date(receipt.completedAt).toISOString() !== receipt.completedAt
    || receipt.output?.path !== FILES.output || receipt.output?.bytes !== trust.outputBytes
    || receipt.output?.sha256 !== trust.outputSha256 || receipt.output?.format !== 'PNG'
    || receipt.output?.width !== trust.width || receipt.output?.height !== trust.height
    || receipt.bindings?.stagedIndexSha256 !== trust.stagedIndexSha256
    || receipt.bindings?.candidateIndexSha256 !== trust.candidateIndexSha256
    || receipt.bindings?.outerIndexSha256 !== trust.outerIndexSha256
    || receipt.bindings?.routeResolutionApprovalSha256 !== trust.routeResolutionApprovalSha256
    || receipt.bindings?.requestKeyReconciliationSha256 !== trust.reconciliationSha256
    || receipt.retries !== 0 || receipt.fallback !== false || receipt.productionUse !== false
    || receipt.rendering !== false || receipt.promotion !== false || receipt.episodeRootWrites !== false)
    failState('PHASE3_B009_COMPLETED_RECEIPT_BINDING_INVALID');
  const records = mediaExecution.readCalibrationLedger(path.join(beatDir, path.posix.basename(FILES.ledger)), fsImpl);
  if (records.length !== 2) failState('PHASE3_B009_COMPLETED_LEDGER_INVALID');
  const [reservation, terminal] = records;
  if (reservation.recordType !== 'SUBMISSION_RESERVED' || reservation.sequence !== 1
    || reservation.runId !== trust.runId || reservation.beatId !== trust.beatId
    || reservation.operation !== trust.operation || reservation.endpoint !== routes.FLUX3_ENDPOINT
    || reservation.requestKey !== trust.requestKey
    || reservation.authorizationSha256 !== trust.authorizationSha256 || reservation.retryAllowed !== false
    || reservation.fallbackAllowed !== false || terminal.recordType !== 'SUBMISSION_RESULT'
    || terminal.requestKey !== trust.requestKey || terminal.status !== 'SUCCEEDED'
    || terminal.retryCount !== 0 || terminal.fallbackUsed !== false || terminal.outputSha256 !== trust.outputSha256
    || terminal.receiptSha256 !== trust.receiptSha256 || result.status !== 'SUCCEEDED'
    || terminal.providerRequestId !== receipt.provider.requestId || terminal.actualChargeUsd !== receipt.provider.actualChargeUsd
    || receipt.reservationEntrySha256 !== reservation.entrySha256
    || result.runId !== trust.runId || result.beatId !== trust.beatId || result.requestKey !== trust.requestKey
    || result.authorizationSha256 !== trust.authorizationSha256 || result.receiptSha256 !== trust.receiptSha256
    || result.reservationEntrySha256 !== reservation.entrySha256 || result.resultEntrySha256 !== terminal.entrySha256
    || result.output?.sha256 !== trust.outputSha256 || result.ledgerSha256 !== trust.ledgerSha256
    || result.providerRequestId !== receipt.provider.requestId || result.actualChargeUsd !== receipt.provider.actualChargeUsd
    || result.assetClass !== trust.assetClass)
    failState('PHASE3_B009_COMPLETED_LEDGER_INVALID');
  const image = pngInfo(outputBytes);
  if (image.width !== trust.width || image.height !== trust.height || fsImpl.existsSync(path.join(beatDir, path.posix.basename(FILES.lock))))
    failState('PHASE3_B009_COMPLETED_OUTPUT_INVALID');
  const allowedRunFiles = Object.values(FILES).filter(relative => ['authorization', 'ledger', 'output', 'receipt', 'result'].some(key => FILES[key] === relative)).sort();
  return { schemaVersion: 'phase3-act1-b009-completed-source-still-verification/1.0.0',
    status: 'COMPLETED_SOURCE_STILL_APPROVED_FOR_ANIMATION_INPUT_ONLY', runId: trust.runId,
    beatId: trust.beatId, requestKey: trust.requestKey, authorizationSha256: trust.authorizationSha256,
    receiptSha256: trust.receiptSha256, ledgerSha256: trust.ledgerSha256, outputSha256: trust.outputSha256,
    approvalSha256: trust.approvalSha256, historicalRuntimeHashes, allowedRunFiles };
}
function verifyCompletedSourceStillState(options = {}) {
  return verifyCompletedSourceStillStateInternal({ ...options, expected: null });
}
function verifyCompletedSourceStillStateForTest(options = {}) {
  return verifyCompletedSourceStillStateInternal(options);
}
function atomicExclusive(file, bytes, fsImpl = fs) {
  fail(!fsImpl.existsSync(file), 'PHASE3_B009_OUTPUT_ALREADY_EXISTS');
  const temp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fsImpl.writeFileSync(temp, bytes, { flag: 'wx' });
    const fd = fsImpl.openSync(temp, 'r+');
    try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
    fsImpl.renameSync(temp, file);
  } catch (error) {
    try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch (_) {}
    throw error;
  }
}
function makeAuthTemplate({ moduleSha256, executionModuleSha256, cliSha256, authorizedAt } = {}) {
  fail(/^[a-f0-9]{64}$/u.test(moduleSha256 || '')
    && /^[a-f0-9]{64}$/u.test(executionModuleSha256 || '')
    && /^[a-f0-9]{64}$/u.test(cliSha256 || ''),
    'PHASE3_B009_RUNTIME_HASHES_REQUIRED');
  fail(typeof authorizedAt === 'string' && Number.isFinite(Date.parse(authorizedAt))
    && new Date(authorizedAt).toISOString() === authorizedAt, 'PHASE3_B009_AUTHORIZED_AT_INVALID');
  const request = {
    runId: RUN_ID, stagedIndexSha256: routes.TRUST.stagedIndexSha256,
    candidateIndexSha256: routes.TRUST.candidateIndexSha256, outerIndexSha256: routes.TRUST.outerIndexSha256,
    routeResolutionApprovalSha256: routes.ROUTE_APPROVAL_SHA256,
    requestKeyReconciliationSha256: RECONCILIATION_SHA256, routeBundleSha256: ROUTE_BUNDLE_SHA256,
    b006HumanApprovalSha256: B006_APPROVAL_SHA256,
    stage04ActivationRecordSha256: 'f60d360c0179c87329d4e6d8be7b39d09da7ccc9d6c2351645fa2d8a4062923d',
    stage04LedgerBaselineSha256: mediaExecution.REQUEST_LEDGER_SHA256,
    deployedSourceStillWorkflowSha256: moduleSha256,
    deployedMediaExecutionModuleSha256: executionModuleSha256, deployedCliSha256: cliSha256,
    beatId: BEAT_ID, operation: OPERATION, endpoint: routes.FLUX3_ENDPOINT, requestKey: REQUEST_KEY,
    positivePromptSha256: routes.PROMPT_HASHES.ACT1_B009.imagePrompt,
    negativeInstructionsSha256: routes.PROMPT_HASHES.ACT1_B009.negativePrompt,
    serializedPromptSha256: 'f00a4f9bbc2b9ce77976d0bf0bd0aa6a61f2bd34a2684660ff48048948c506a7',
  };
  return {
    schemaVersion: AUTH_SCHEMA, status: 'AUTHORIZED_FOR_SINGLE_NONPRODUCTION_CALIBRATION_SOURCE_STILL',
    approvedBy: 'Yakubu Moshood', authorizedAt,
    bindings: { ...request },
    request: { endpoint: routes.FLUX3_ENDPOINT, resolution: '1k', aspectRatio: '16:9',
      outputFormat: 'png', numberOfImages: 1, promptExpansionEnabled: false,
      maximumProviderSubmissions: 1, retries: 0, fallback: false,
      expectedPublishedChargeUsd: EXPECTED_CHARGE_USD, maximumHumanAcceptedExposureUsd: MAX_EXPOSURE_USD,
      exposureProviderEnforced: false },
    classification: { assetClass: CLASSIFICATION, ownershipDisposition: OWNERSHIP,
      productionReadiness: 'REJECTED', productionUse: false },
    denials: { act1B005: true, act1B006: true, act1B009Animation: true, allOtherBeats: true,
      allOtherOperations: true, productionUse: true, rendering: true, promotion: true,
      candidateReconstruction: true, stage04Modification: true, episodeRootWrites: true },
  };
}
function validateAuth(record, { moduleSha256, executionModuleSha256, cliSha256 } = {}) {
  const expected = makeAuthTemplate({ moduleSha256, executionModuleSha256, cliSha256,
    authorizedAt: record?.authorizedAt });
  fail(canonicalJson(record) === canonicalJson(expected), 'PHASE3_B009_AUTHORIZATION_BINDING_INVALID');
  return true;
}
function createB009SourceStillWorkflow({ stagedRunner, reviewRoot, episodeRoot, b006ApprovalPath,
  approvalPath = SOURCE_STILL_APPROVAL_PATH,
  reconciliationPath = path.resolve(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
    'phase3-act1-b009-request-key-reconciliation-20261005.v1.json'),
  routeBundlePath = path.resolve(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
    'phase3-media-execution-calibration-route-bundle-20261004.v1.json'),
  modulePath = __filename, cliPath = path.resolve(__dirname, '..', 'scripts', 'phase3-media-execution.cjs'),
  executionModulePath = path.resolve(__dirname, 'phase3-media-execution.cjs'),
  fsImpl = fs, provider = mediaExecution.createFalCalibrationProvider(), verifyB006StateFn = null,
  completedStateVerifier = null, downloader = mediaExecution.downloadCalibrationImage,
  now = () => new Date().toISOString(), testHooks = {} } = {}) {
  const runDir = path.resolve(reviewRoot, RUN_ID);
  const beatDir = path.resolve(runDir, BEAT_ID);
  const within = target => path.resolve(target).startsWith(`${beatDir}${path.sep}`);
  const file = key => { const target = path.resolve(runDir, ...FILES[key].split('/'));
    fail(within(target), 'PHASE3_B009_PATH_ESCAPE'); return target; };
  function assertBindings() {
    fail(path.resolve(episodeRoot) && stagedRunner && typeof stagedRunner.preflight === 'function',
      'PHASE3_B009_STAGED_RUNNER_REQUIRED');
    const staged = stagedRunner.preflight({ runId: RUN_ID, includeSourceStillCalibration: true });
    fail(staged.runId === RUN_ID && staged.stagedIndexSha256 === routes.TRUST.stagedIndexSha256
      && staged.stage04?.status === 'PROMOTED' && staged.stage04.promotedPathCount === 147
      && staged.stage04.promotedPathsMatch === true
      && staged.requestLedgerSha256 === mediaExecution.REQUEST_LEDGER_SHA256,
    `PHASE3_B009_STAGED_BINDING_INVALID:${JSON.stringify({ runId: staged.runId,
      run: staged.runId === RUN_ID, index: staged.stagedIndexSha256 === routes.TRUST.stagedIndexSha256,
      stage04: staged.stage04, ledger: staged.requestLedgerSha256 === mediaExecution.REQUEST_LEDGER_SHA256 })}`);
    const approvalStat = fsImpl.lstatSync(b006ApprovalPath);
    const approvalBytes = fsImpl.readFileSync(b006ApprovalPath);
    fail(approvalStat.isFile() && !approvalStat.isSymbolicLink() && sha(approvalBytes) === B006_APPROVAL_SHA256,
      'PHASE3_B009_B006_APPROVAL_HASH_MISMATCH');
    const approval = JSON.parse(approvalBytes.toString('utf8'));
    fail(approval.status === 'APPROVED_FOR_CALIBRATION_VALIDATION_ONLY'
      && approval.runId === RUN_ID && approval.beatId === 'ACT1_B006'
      && approval.requestKey === mediaExecution.CALIBRATION_REQUEST_KEY
      && approval.bindings?.stagedIndexSha256 === routes.TRUST.stagedIndexSha256
      && approval.bindings?.candidateIndexSha256 === routes.TRUST.candidateIndexSha256
      && approval.bindings?.outerIndexSha256 === routes.TRUST.outerIndexSha256
      && approval.bindings?.routeResolutionApprovalSha256 === routes.ROUTE_APPROVAL_SHA256
      && approval.bindings?.stage04ActivationRecordSha256 === 'f60d360c0179c87329d4e6d8be7b39d09da7ccc9d6c2351645fa2d8a4062923d'
      && approval.bindings?.stage04LedgerBaselineSha256 === mediaExecution.REQUEST_LEDGER_SHA256
      && approval.bindings?.executionAuthorizationSha256 === 'b08ebd11da1018aafa388bf54e173655938453e50fc10bece4091a40c87abcc3'
      && approval.output?.sha256 === '5315292eecda643f19472224474cb011c70b4e7a3e104899ca6542b21ef1fe36'
      && approval.output?.bytes === 1445712 && approval.output?.format === 'PNG'
      && approval.output?.width === 1360 && approval.output?.height === 768
      && approval.output?.runRelativePath === mediaExecution.CALIBRATION_FILES.output
      && approval.bindings?.generationReceiptSha256 === '730f1df08b948727c4c7950f8e0a70d51935d8ff69fdd72e5f7f3fce376175fd'
      && approval.bindings?.calibrationLedgerSha256 === 'f4ef26ce9b91d7976aecaa0e0a84014ae6d59a9726ce59f391ba8f63d1f417c1'
      && approval.inspection?.persistedRunnerInspectionArtifact === null
      && approval.inspection?.inspectionArtifactSha256 === null
      && approval.inspection?.inspectionStatusObserved === 'INSPECTED_PENDING_HUMAN_REVIEW'
      && approval.inspection?.originalMediaByteVerification === 'PASS'
      && approval.restrictions?.productionUse === false && approval.restrictions?.act1B009Authority === false,
    'PHASE3_B009_B006_APPROVAL_BINDING_INVALID');
    if (verifyB006StateFn) fail(verifyB006StateFn(approval) === true, 'PHASE3_B009_B006_STATE_INVALID');
    else {
      const b006RunDir = path.resolve(reviewRoot, RUN_ID);
      const b006File = key => path.join(b006RunDir, ...mediaExecution.CALIBRATION_FILES[key].split('/'));
      const b006Authorization = fsImpl.readFileSync(b006File('authorization'));
      const b006Output = fsImpl.readFileSync(b006File('output'));
      const b006Receipt = fsImpl.readFileSync(b006File('receipt'));
      const b006Ledger = fsImpl.readFileSync(b006File('ledger'));
      fail(sha(b006Authorization) === approval.bindings.executionAuthorizationSha256
        && sha(b006Output) === approval.output.sha256 && b006Output.length === approval.output.bytes
        && sha(b006Receipt) === approval.bindings.generationReceiptSha256
        && sha(b006Ledger) === approval.bindings.calibrationLedgerSha256
        && mediaExecution.pngInfo(b006Output).format === 'PNG', 'PHASE3_B009_B006_LIVE_BINDING_CHANGED');
      const b006LedgerRecords = mediaExecution.readCalibrationLedger(b006File('ledger'), fsImpl);
      const b006ReceiptRecord = JSON.parse(b006Receipt.toString('utf8'));
      fail(verifyB006CompletedState({ approvalSha256: sha(approvalBytes),
        authorizationSha256: sha(b006Authorization), imageSha256: sha(b006Output), imageBytes: b006Output.length,
        receiptSha256: sha(b006Receipt), receiptRecord: b006ReceiptRecord,
        ledgerSha256: sha(b006Ledger), ledgerRecords: b006LedgerRecords }),
      'PHASE3_B009_B006_COMPLETED_STATE_INVALID');
    }
    routes.nextAuthorizationStep({ approvedOutputs: ['ACT1_B006/GENERATE_STILL'], submissions: 1,
      requestKeys: [mediaExecution.CALIBRATION_REQUEST_KEY], beatId: BEAT_ID, operation: OPERATION });
    const reconciliationStat = fsImpl.lstatSync(reconciliationPath);
    const reconciliationBytes = fsImpl.readFileSync(reconciliationPath);
    fail(reconciliationStat.isFile() && !reconciliationStat.isSymbolicLink()
      && sha(reconciliationBytes) === RECONCILIATION_SHA256, 'PHASE3_B009_REQUEST_RECONCILIATION_HASH_MISMATCH');
    const reconciliation = JSON.parse(reconciliationBytes.toString('utf8'));
    fail(reconciliation.status === 'RECONCILED_PLANNING_BINDING_ONLY'
      && reconciliation.authoritativeRequestKey === REQUEST_KEY
      && reconciliation.staleRequestKey === '81416755ae3844e846336f755352b84699dbeec88415093f7f283e4b3b378d0f'
      && reconciliation.bindings.candidateIndexSha256 === routes.TRUST.candidateIndexSha256
      && reconciliation.bindings.routeResolutionApprovalSha256 === routes.ROUTE_APPROVAL_SHA256
      && reconciliation.bindings.routeBundleSha256 === ROUTE_BUNDLE_SHA256
      && reconciliation.derivation.reproducedRequestKey === REQUEST_KEY
      && reconciliation.unchanged?.promptBytes === true && reconciliation.unchanged?.endpoint === true
      && reconciliation.unchanged?.creativeInstructions === true && reconciliation.unchanged?.priceAssumptions === true
      && reconciliation.unchanged?.providerExecutionAuthorityGranted === false
      && reconciliation.unchanged?.providerRequestsAuthorized === 0,
    'PHASE3_B009_REQUEST_RECONCILIATION_INVALID');
    const bundleStat = fsImpl.lstatSync(routeBundlePath), bundleBytes = fsImpl.readFileSync(routeBundlePath);
    fail(bundleStat.isFile() && !bundleStat.isSymbolicLink() && sha(bundleBytes) === ROUTE_BUNDLE_SHA256,
      'PHASE3_B009_ROUTE_BUNDLE_CHANGED');
    fail(bundleBytes.toString('utf8').includes(reconciliation.staleRequestKey),
      'PHASE3_B009_STALE_ROUTE_KEY_BINDING_INVALID');
    const request = staged.calibrationRoutePlan?.requests?.find(item => item.beatId === BEAT_ID
      && item.operation === OPERATION);
    const derivedRequestKey = request && routes.deterministicRequestKey({ runId: RUN_ID, beatId: BEAT_ID,
      operation: OPERATION, endpoint: request.endpoint, parameters: request.parameters,
      positivePrompt: request.positivePrompt, prompt: request.submittedPrompt,
      negativePrompt: request.negativeInstructions, sourceSha256: null,
      stagedIndexSha256: routes.TRUST.stagedIndexSha256 });
    const canonicalInput = reconciliation.derivation?.canonicalInput;
    fail(request?.requestKey === REQUEST_KEY && request.endpoint === routes.FLUX3_ENDPOINT
      && derivedRequestKey === REQUEST_KEY
      && request.positivePromptSha256 === routes.PROMPT_HASHES.ACT1_B009.imagePrompt
      && request.negativeInstructionsSha256 === routes.PROMPT_HASHES.ACT1_B009.negativePrompt
      && request.submittedPromptSha256 === reconciliation.derivation.recomputedSerializedPromptSha256
      && request.serializationDelimiter === routes.FLUX_NEGATIVE_PROMPT_DELIMITER
      && canonicalJson(request.parameters) === canonicalJson({ resolution: '1k', aspect_ratio: '16:9',
        output_format: 'png', enable_prompt_expansion: false }) && request.exactlyOneImage === true
      && reconciliation.derivation?.schemaVersion === 'phase3-calibration-request-key/2.0.0'
      && canonicalInput?.runId === RUN_ID && canonicalInput?.beatId === BEAT_ID
      && canonicalInput?.operation === OPERATION && canonicalInput?.modelId === routes.FLUX3_ENDPOINT
      && canonicalInput?.endpoint === routes.FLUX3_ENDPOINT
      && canonicalInput?.positivePrompt === request.positivePrompt
      && canonicalInput?.negativeInstructions === request.negativeInstructions
      && canonicalInput?.submittedPrompt === request.submittedPrompt
      && canonicalInput?.serializationDelimiter === request.serializationDelimiter
      && canonicalJson(canonicalInput?.parameters) === canonicalJson(request.parameters)
      && canonicalInput?.sourceSha256 === null
      && canonicalInput?.stagedIndexSha256 === routes.TRUST.stagedIndexSha256
      && reconciliation.derivation?.recomputedPositivePromptSha256 === request.positivePromptSha256
      && reconciliation.derivation?.recomputedNegativeInstructionsSha256 === request.negativeInstructionsSha256
      && reconciliation.derivation?.recomputedSerializedPromptSha256 === request.submittedPromptSha256
      && reconciliation.derivation?.reproducedRequestKey === derivedRequestKey,
    'PHASE3_B009_ROUTE_REQUEST_BINDING_INVALID');
    return { staged, request, approvalSha256: sha(approvalBytes), reconciliationSha256: sha(reconciliationBytes) };
  }
  function files() {
    if (!fsImpl.existsSync(beatDir)) return [];
    const st = fsImpl.lstatSync(beatDir);
    fail(st.isDirectory() && !st.isSymbolicLink(), 'PHASE3_B009_DIRECTORY_INVALID');
    const allowed = new Set(Object.values(FILES).map(value => value.slice(`${BEAT_ID}/`.length)));
    const animationAuthorizationPaths = [
      'ACT1_B009/animation-execution-authorization.v1.json',
      'ACT1_B009/animation-execution-authorization.v2.json',
    ];
    if (animationAuthorizationPaths.some(relative => fsImpl.existsSync(path.join(runDir, ...relative.split('/'))))) {
      const animationWorkflow = require('./phase3-media-calibration-animation.cjs');
      const verifiedAnimationFiles = animationWorkflow.verifyStagedRunFiles({ runDir, fsImpl });
      for (const relative of verifiedAnimationFiles) allowed.add(path.posix.basename(relative));
    }
    const actual = fsImpl.readdirSync(beatDir).sort();
    for (const name of actual) {
      fail(allowed.has(name), `PHASE3_B009_UNKNOWN_FILE:${name}`);
      const st = fsImpl.lstatSync(path.join(beatDir, name));
      fail(st.isFile() && !st.isSymbolicLink(), `PHASE3_B009_FILE_TYPE_INVALID:${name}`);
    }
    return actual;
  }
  function loadLedger() {
    const p = file('ledger');
    return mediaExecution.readCalibrationLedger(p, fsImpl);
  }
  function runtimeHashes() {
    const moduleStat = fsImpl.lstatSync(modulePath), executionModuleStat = fsImpl.lstatSync(executionModulePath),
      cliStat = fsImpl.lstatSync(cliPath);
    fail(moduleStat.isFile() && !moduleStat.isSymbolicLink()
      && executionModuleStat.isFile() && !executionModuleStat.isSymbolicLink()
      && cliStat.isFile() && !cliStat.isSymbolicLink(),
      'PHASE3_B009_RUNTIME_FILE_INVALID');
    return { moduleSha256: sha(fsImpl.readFileSync(modulePath)),
      executionModuleSha256: sha(fsImpl.readFileSync(executionModulePath)),
      cliSha256: sha(fsImpl.readFileSync(cliPath)) };
  }
  function validateAuthorization(expectedSha256) {
    fail(/^[a-f0-9]{64}$/u.test(expectedSha256 || ''), 'PHASE3_B009_EXPECTED_AUTHORIZATION_HASH_REQUIRED');
    const p = file('authorization'), st = fsImpl.lstatSync(p), bytes = fsImpl.readFileSync(p);
    fail(st.isFile() && !st.isSymbolicLink() && sha(bytes) === expectedSha256,
      'PHASE3_B009_AUTHORIZATION_HASH_MISMATCH');
    const record = JSON.parse(bytes.toString('utf8'));
    validateAuth(record, runtimeHashes());
    return { record, bytes, sha256: sha(bytes) };
  }
  function status({ expectedAuthorizationSha256 = null } = {}) {
    const bound = assertBindings();
    const actual = files();
    const present = key => actual.includes(path.posix.basename(FILES[key]));
    const ledger = present('ledger') ? loadLedger() : [];
    const validReservation = item => item?.schemaVersion === LEDGER_SCHEMA && item.recordType === 'SUBMISSION_RESERVED'
      && item.sequence === 1 && item.runId === RUN_ID && item.beatId === BEAT_ID
      && item.operation === OPERATION && item.requestKey === REQUEST_KEY
      && item.retryAllowed === false && item.fallbackAllowed === false;
    fail(ledger.length === 0 || (ledger.length === 1 && validReservation(ledger[0])) || (ledger.length === 2
      && validReservation(ledger[0])
      && ledger[1].schemaVersion === LEDGER_SCHEMA && ledger[1].recordType === 'SUBMISSION_RESULT'
      && ledger[1].requestKey === REQUEST_KEY && ['SUCCEEDED', 'FAILED'].includes(ledger[1].status)
      && ledger[1].retryCount === 0 && ledger[1].fallbackUsed === false), 'PHASE3_B009_LEDGER_INVALID');
    const reservation = ledger.find(item => item.recordType === 'SUBMISSION_RESERVED') || null;
    const terminal = ledger.find(item => item.recordType === 'SUBMISSION_RESULT') || null;
    let authHash = null, authorized = false, authError = null;
    if (present('authorization')) {
      authHash = sha(fsImpl.readFileSync(file('authorization')));
      try { validateAuthorization(expectedAuthorizationSha256 || authHash); authorized = true; }
      catch (error) { authError = String(error.message); }
    }
    const lock = present('lock'), output = present('output'), receipt = present('receipt'), result = present('result');
    if (terminal?.status === 'SUCCEEDED' && output && receipt && result
      && fsImpl.existsSync(approvalPath)
      && (completedStateVerifier || sha(fsImpl.readFileSync(file('output'))) === '0a9c9311c20da7dc774b1695f9abe2ea56f648fc0eb2450a8c7f0c4130b9ffdc')) {
      const completed = (completedStateVerifier || verifyCompletedSourceStillState)({ runDir, approvalPath, fsImpl });
      return { schemaVersion: 'phase3-act1-b009-source-still-status/1.0.0',
        status: 'APPROVED_FOR_ANIMATION_CALIBRATION_INPUT_ONLY', generationStatus: 'GENERATED_PENDING_HUMAN_REVIEW',
        runId: RUN_ID, beatId: BEAT_ID, operation: OPERATION, requestKey: REQUEST_KEY,
        requestReconciliationSha256: bound.reconciliationSha256,
        authorization: { present: true, sha256: completed.authorizationSha256, valid: true,
          validationMode: 'HISTORICAL_COMPLETED_REQUEST', executionAuthority: false },
        reservationState: 'RESERVED', resultState: 'SUCCEEDED', requestKeyConsumed: true,
        lockPresent: false, output: { present: true, bytes: completed.outputBytes,
          sha256: completed.outputSha256 }, receipt: { present: true, sha256: completed.receiptSha256 },
        approval: { present: true, sha256: completed.approvalSha256, decision: 'APPROVED_FOR_ANIMATION_CALIBRATION_INPUT_ONLY' },
        failureReceiptPresent: false, failureReceipt: null, providerRequests: 1, retries: 0, fallback: false,
        assetClass: CLASSIFICATION, productionReadiness: 'REJECTED', humanApprovalRequiredBeforeAnimation: false,
        animationAuthorized: false, productionUse: false, rendering: false, promotion: false,
        episodeRootWrites: false, historicalRuntimeHashes: completed.historicalRuntimeHashes };
    }
    let failureRecord = null;
    if (present('failure')) {
      const failurePath = file('failure'), failureStat = fsImpl.lstatSync(failurePath);
      const failureBytes = fsImpl.readFileSync(failurePath);
      fail(failureStat.isFile() && !failureStat.isSymbolicLink(), 'PHASE3_B009_FAILURE_RECEIPT_INVALID');
      failureRecord = JSON.parse(failureBytes.toString('utf8'));
      fail(failureBytes.equals(Buffer.from(`${JSON.stringify(failureRecord, null, 2)}\n`)),
        'PHASE3_B009_FAILURE_RECEIPT_INVALID');
      const failureBinding = failureRecord.failureBindingSha256;
      const failureBody = { ...failureRecord }; delete failureBody.failureBindingSha256;
      const beforeReservation = failureRecord.failureStage === 'BEFORE_RESERVATION';
      const afterReservation = failureRecord.failureStage === 'AFTER_RESERVATION';
      const recordedAt = failureRecord.recordedAt;
      fail(failureRecord.schemaVersion === 'phase3-media-calibration-source-still-failure/1.0.0'
        && failureBinding === sha(Buffer.from(canonicalJson(failureBody), 'utf8'))
        && failureRecord.status === 'FAILED' && failureRecord.runId === RUN_ID && failureRecord.beatId === BEAT_ID
        && failureRecord.requestKey === REQUEST_KEY && failureRecord.assetClass === CLASSIFICATION
        && failureRecord.retryAllowed === false && failureRecord.fallbackAllowed === false
        && typeof failureRecord.errorCode === 'string' && failureRecord.errorCode.length > 0
        && typeof recordedAt === 'string' && Number.isFinite(Date.parse(recordedAt))
        && new Date(recordedAt).toISOString() === recordedAt
        && ((beforeReservation && failureRecord.reservationCount === 0 && failureRecord.providerRequestCount === 0
          && ledger.length === 0 && !output && !receipt && !result)
          || (afterReservation && failureRecord.reservationCount === 1
            && [0, 1].includes(failureRecord.providerRequestCount)
            && ledger.length === 2 && terminal?.status === 'FAILED')),
      'PHASE3_B009_FAILURE_RECEIPT_INVALID');
    }
    if (ledger.length === 0) fail(!output && !receipt && !result,
      'PHASE3_B009_ORPHAN_MEDIA_OR_RESULT');
    if (ledger.length === 1) fail(!terminal && !output && !receipt && !result && !failureRecord,
      'PHASE3_B009_RESERVED_FILE_SET_INVALID');
    if (terminal?.status === 'SUCCEEDED') fail(output && receipt && result && !failureRecord && !lock,
      'PHASE3_B009_SUCCESS_FILE_SET_INVALID');
    if (terminal?.status === 'FAILED') fail(Boolean(failureRecord)
      && failureRecord.failureStage === 'AFTER_RESERVATION' && !result && !lock,
    'PHASE3_B009_FAILED_FILE_SET_INVALID');
    const noAttempt = !present('ledger') && !reservation && !terminal && !output && !receipt && !result && !lock
      && !present('failure');
    let status = 'EXECUTION_READY_UNAUTHORIZED';
    if (lock) status = 'EXECUTION_LOCKED_NOT_READY';
    if (authorized && noAttempt) status = 'EXECUTION_AUTHORIZED_SAFE_TO_INVOKE';
    if (reservation && !terminal) status = 'REQUEST_RESERVED_NOT_RETRYABLE';
    if (terminal?.status === 'SUCCEEDED' && output && receipt) status = 'GENERATED_PENDING_HUMAN_REVIEW';
    if (terminal?.status === 'FAILED') status = 'FAILED_REQUEST_KEY_PERMANENTLY_CONSUMED';
    if (failureRecord?.failureStage === 'BEFORE_RESERVATION') status = 'FAILED_BEFORE_RESERVATION_NOT_RETRYABLE';
    const outputBytes = output ? fsImpl.readFileSync(file('output')) : null;
    const receiptBytes = receipt ? fsImpl.readFileSync(file('receipt')) : null;
    return { schemaVersion: 'phase3-act1-b009-source-still-status/1.0.0', status, runId: RUN_ID,
      beatId: BEAT_ID, operation: OPERATION, requestKey: REQUEST_KEY,
      requestReconciliationSha256: bound.reconciliationSha256, authorization: { present: present('authorization'),
        sha256: authHash, valid: authorized, error: authError }, reservationState: reservation ? 'RESERVED' : 'ABSENT',
      resultState: terminal?.status || 'ABSENT', requestKeyConsumed: Boolean(reservation),
      lockPresent: lock, output: { present: output, bytes: outputBytes?.length || null,
        sha256: outputBytes ? sha(outputBytes) : null }, receipt: { present: receipt,
      sha256: receiptBytes ? sha(receiptBytes) : null }, failureReceiptPresent: present('failure'),
      failureReceipt: failureRecord ? { failureStage: failureRecord.failureStage,
        providerRequestCount: failureRecord.providerRequestCount } : null,
      providerRequests: reservation ? 1 : 0, retries: 0, fallback: false,
      assetClass: CLASSIFICATION, productionReadiness: 'REJECTED',
      humanApprovalRequiredBeforeAnimation: true, animationAuthorized: false,
      productionUse: false, rendering: false, promotion: false, episodeRootWrites: false };
  }
  function preflight() {
    const current = status();
    if (current.status === 'APPROVED_FOR_ANIMATION_CALIBRATION_INPUT_ONLY')
      return { schemaVersion: 'phase3-act1-b009-source-still-preflight/1.0.0',
        status: 'COMPLETED_APPROVED_NOT_AUTHORIZED_FOR_PRODUCTION', runId: RUN_ID, beatId: BEAT_ID,
        operation: OPERATION, requestKey: REQUEST_KEY, sourceStillRequest: current,
        authorizationRequired: false, animationExecutionAuthority: false, providerRequests: 0,
        episodeRootWrites: 0, assetClass: CLASSIFICATION, productionReadiness: 'REJECTED' };
    fail((!current.authorization.present || current.authorization.valid)
      && ['EXECUTION_READY_UNAUTHORIZED', 'EXECUTION_AUTHORIZED_SAFE_TO_INVOKE'].includes(current.status),
      'PHASE3_B009_NOT_READY');
    return { schemaVersion: 'phase3-act1-b009-source-still-preflight/1.0.0',
      status: current.status === 'EXECUTION_READY_UNAUTHORIZED'
        ? 'EXECUTION_READY_UNAUTHORIZED' : 'EXECUTION_AUTHORIZED_NOT_EXECUTED',
      runId: RUN_ID, beatId: BEAT_ID, operation: OPERATION,
      requestKey: REQUEST_KEY, sourceStillRequest: current, endpoint: routes.FLUX3_ENDPOINT,
      requestParameters: { resolution: '1k', aspectRatio: '16:9', outputFormat: 'PNG',
        promptExpansionEnabled: false, numberOfImages: 1 },
      authorizationRequired: true, maximumProviderSubmissions: 1, retries: 0, fallback: false,
      humanApprovalRequiredBeforeAnimation: true, providerRequests: 0, episodeRootWrites: 0 };
  }
  function append(filePath, value) {
    return mediaExecution.appendCalibrationLedgerRecord(filePath, value, fsImpl);
  }
  function lock() {
    const p = file('lock');
    let fd, created = false;
    try {
      fd = fsImpl.openSync(p, 'wx', 0o600); created = true;
      fsImpl.writeSync(fd, `${process.pid}\n`); fsImpl.fsyncSync(fd);
    } catch (error) {
      if (created) { try { fsImpl.unlinkSync(p); } catch (_) {} }
      if (error?.code === 'EEXIST') throw new Error('PHASE3_B009_LOCK_EXISTS');
      throw error;
    } finally { if (fd !== undefined) fsImpl.closeSync(fd); }
    return p;
  }
  function selfBound(schemaVersion, body, field) {
    return { schemaVersion, ...body, [field]: sha(Buffer.from(canonicalJson({ schemaVersion, ...body }), 'utf8')) };
  }
  async function generate({ expectedAuthorizationSha256 } = {}) {
    assertBindings();
    fail(/^[a-f0-9]{64}$/u.test(expectedAuthorizationSha256 || ''), 'PHASE3_B009_EXPECTED_AUTHORIZATION_HASH_REQUIRED');
    fail(fsImpl.existsSync(beatDir), 'PHASE3_B009_AUTH_DIRECTORY_MISSING');
    const existing = files();
    fail(existing.length === 1 && existing[0] === path.posix.basename(FILES.authorization),
      'PHASE3_B009_RUN_ALREADY_USED');
    validateAuthorization(expectedAuthorizationSha256);
    const lockPath = lock();
    let reservation = null, providerRequestId = null, actualChargeUsd = null, providerInvoked = false;
    try {
      const bound = assertBindings();
      const authorization = validateAuthorization(expectedAuthorizationSha256);
      const currentFiles = files();
      fail(canonicalJson(currentFiles) === canonicalJson([path.posix.basename(FILES.authorization),
        path.posix.basename(FILES.lock)].sort()), 'PHASE3_B009_RUN_FILE_SET_INVALID');
      fail(loadLedger().length === 0, 'PHASE3_B009_REQUEST_ALREADY_CONSUMED');
      if (typeof testHooks.beforeReservation === 'function') await testHooks.beforeReservation();
      reservation = append(file('ledger'), { schemaVersion: LEDGER_SCHEMA, recordType: 'SUBMISSION_RESERVED',
        sequence: 1, runId: RUN_ID, beatId: BEAT_ID, operation: OPERATION, endpoint: routes.FLUX3_ENDPOINT,
        requestKey: REQUEST_KEY, authorizationSha256: authorization.sha256,
        stagedIndexSha256: routes.TRUST.stagedIndexSha256, candidateIndexSha256: routes.TRUST.candidateIndexSha256,
        outerIndexSha256: routes.TRUST.outerIndexSha256, routeResolutionApprovalSha256: routes.ROUTE_APPROVAL_SHA256,
        requestKeyReconciliationSha256: RECONCILIATION_SHA256, parameters: { resolution: '1k', aspect_ratio: '16:9',
          output_format: 'png', num_images: 1, enable_prompt_expansion: false },
        retryAllowed: false, fallbackAllowed: false, assetClass: CLASSIFICATION, reservedAt: now() });
      if (typeof testHooks.afterReservation === 'function') await testHooks.afterReservation({ reservation });
      const request = bound.staged.calibrationRoutePlan.requests.find(item => item.beatId === BEAT_ID
        && item.operation === OPERATION);
      providerInvoked = true;
      const response = await provider.generateStill({ endpoint: routes.FLUX3_ENDPOINT, input: {
        prompt: request.submittedPrompt, resolution: '1k', aspect_ratio: '16:9', output_format: 'png',
        num_images: 1, enable_prompt_expansion: false }, retries: 0, fallback: false });
      fail(response?.imageCount === 1 && typeof response.url === 'string' && response.url.length > 0,
        'PHASE3_B009_PROVIDER_RESPONSE_INVALID');
      providerRequestId = typeof response.providerRequestId === 'string' ? response.providerRequestId : null;
      actualChargeUsd = Number.isFinite(response.actualChargeUsd) ? response.actualChargeUsd : null;
      fail(actualChargeUsd === null || (actualChargeUsd >= 0 && actualChargeUsd <= MAX_EXPOSURE_USD),
        'PHASE3_B009_ACTUAL_CHARGE_EXCEEDS_ACCEPTED_EXPOSURE');
      const downloaded = await downloader(response.url, { runDir, beatId: BEAT_ID, requestKey: REQUEST_KEY });
      const bytes = Buffer.from(downloaded?.bytes || []), contentType = String(downloaded?.contentType || '')
        .split(';')[0].toLowerCase();
      fail(bytes.length > 0 && bytes.length <= MAX_BYTES && (!contentType || contentType === 'image/png'),
        'PHASE3_B009_DOWNLOAD_INVALID');
      const media = pngInfo(bytes), outputSha256 = sha(bytes);
      atomicExclusive(file('output'), bytes, fsImpl);
      const receipt = selfBound('phase3-media-calibration-source-still-receipt/1.0.0', {
        status: 'GENERATED_PENDING_HUMAN_REVIEW', runId: RUN_ID, beatId: BEAT_ID, operation: OPERATION,
        requestKey: REQUEST_KEY, assetClass: CLASSIFICATION, ownershipDisposition: OWNERSHIP,
        authorizationSha256: authorization.sha256, reservationEntrySha256: reservation.entrySha256,
        provider: { name: 'fal.ai', requestId: providerRequestId, actualChargeUsd,
          metadata: response.rawProviderResponseMetadata || null },
        output: { path: FILES.output, bytes: bytes.length, sha256: outputSha256, ...media },
        bindings: { stagedIndexSha256: routes.TRUST.stagedIndexSha256,
          candidateIndexSha256: routes.TRUST.candidateIndexSha256, outerIndexSha256: routes.TRUST.outerIndexSha256,
          routeResolutionApprovalSha256: routes.ROUTE_APPROVAL_SHA256,
          requestKeyReconciliationSha256: RECONCILIATION_SHA256 },
        retries: 0, fallback: false, productionUse: false, rendering: false, promotion: false,
        episodeRootWrites: false, completedAt: now() }, 'receiptBindingSha256');
      atomicExclusive(file('receipt'), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), fsImpl);
      const resultRecord = append(file('ledger'), { schemaVersion: LEDGER_SCHEMA, recordType: 'SUBMISSION_RESULT',
        requestKey: REQUEST_KEY, status: 'SUCCEEDED', retryCount: 0, fallbackUsed: false,
        providerRequestId, actualChargeUsd, outputSha256,
        receiptSha256: sha(fsImpl.readFileSync(file('receipt'))), errorCode: null, recordedAt: now() });
      const terminal = selfBound('phase3-media-calibration-source-still-result/1.0.0', {
        status: 'SUCCEEDED', runId: RUN_ID, beatId: BEAT_ID, requestKey: REQUEST_KEY,
        authorizationSha256: authorization.sha256, reservationEntrySha256: reservation.entrySha256,
        resultEntrySha256: resultRecord.entrySha256, ledgerSha256: sha(fsImpl.readFileSync(file('ledger'))),
        output: receipt.output, receiptSha256: sha(fsImpl.readFileSync(file('receipt'))),
        providerRequestId, actualChargeUsd, assetClass: CLASSIFICATION }, 'resultBindingSha256');
      atomicExclusive(file('result'), Buffer.from(`${JSON.stringify(terminal, null, 2)}\n`), fsImpl);
      return { status: 'GENERATED_PENDING_HUMAN_REVIEW', runId: RUN_ID, beatId: BEAT_ID,
        requestKey: REQUEST_KEY, output: receipt.output, providerRequestId, actualChargeUsd,
        providerRequests: 1, retries: 0, fallback: false };
    } catch (error) {
      const failedAfterReservation = Boolean(reservation);
      if (reservation) {
        try { append(file('ledger'), { schemaVersion: LEDGER_SCHEMA, recordType: 'SUBMISSION_RESULT',
          requestKey: REQUEST_KEY, status: 'FAILED', retryCount: 0, fallbackUsed: false,
          providerRequestId, actualChargeUsd,
          outputSha256: fsImpl.existsSync(file('output')) ? sha(fsImpl.readFileSync(file('output'))) : null,
          receiptSha256: fsImpl.existsSync(file('receipt')) ? sha(fsImpl.readFileSync(file('receipt'))) : null,
          errorCode: String(error.message).split(':')[0], recordedAt: now() }); } catch (_) {}
      }
      try {
        const failureRecord = selfBound('phase3-media-calibration-source-still-failure/1.0.0', {
        status: 'FAILED',
        runId: RUN_ID, beatId: BEAT_ID, requestKey: REQUEST_KEY,
        failureStage: failedAfterReservation ? 'AFTER_RESERVATION' : 'BEFORE_RESERVATION',
        reservationCount: failedAfterReservation ? 1 : 0, providerRequestCount: providerInvoked ? 1 : 0,
        errorCode: String(error.message).split(':')[0], recordedAt: now(), assetClass: CLASSIFICATION,
        retryAllowed: false, fallbackAllowed: false }, 'failureBindingSha256');
        atomicExclusive(file('failure'), Buffer.from(`${JSON.stringify(failureRecord, null, 2)}\n`), fsImpl);
      } catch (_) {}
      throw error;
    } finally { try { if (fsImpl.existsSync(lockPath)) fsImpl.unlinkSync(lockPath); } catch (_) {} }
  }
  function inspect() {
    const current = status();
    const humanApproved = current.status === 'APPROVED_FOR_ANIMATION_CALIBRATION_INPUT_ONLY';
    fail(['GENERATED_PENDING_HUMAN_REVIEW', 'APPROVED_FOR_ANIMATION_CALIBRATION_INPUT_ONLY'].includes(current.status)
      && !current.lockPresent,
      'PHASE3_B009_SUCCESSFUL_OUTPUT_REQUIRED');
    const outputBytes = fsImpl.readFileSync(file('output')), outputInfo = pngInfo(outputBytes);
    const receiptBytes = fsImpl.readFileSync(file('receipt')), receipt = JSON.parse(receiptBytes.toString('utf8'));
    const resultBytes = fsImpl.readFileSync(file('result')), result = JSON.parse(resultBytes.toString('utf8'));
    const verifyBinding = (record, field, code) => {
      const base = { ...record }; const supplied = base[field]; delete base[field];
      fail(supplied === sha(Buffer.from(canonicalJson(base), 'utf8')), code);
    };
    verifyBinding(receipt, 'receiptBindingSha256', 'PHASE3_B009_RECEIPT_BINDING_INVALID');
    verifyBinding(result, 'resultBindingSha256', 'PHASE3_B009_RESULT_BINDING_INVALID');
    const ledger = loadLedger();
    fail(ledger.length === 2 && ledger[0].recordType === 'SUBMISSION_RESERVED'
      && ledger[1].recordType === 'SUBMISSION_RESULT' && ledger[0].requestKey === REQUEST_KEY
      && ledger[0].runId === RUN_ID && ledger[0].beatId === BEAT_ID && ledger[0].operation === OPERATION
      && ledger[0].authorizationSha256 === receipt.authorizationSha256
      && ledger[1].requestKey === REQUEST_KEY && ledger[1].status === 'SUCCEEDED'
      && ledger[1].outputSha256 === sha(outputBytes)
      && receipt.output?.bytes === outputBytes.length && receipt.output?.sha256 === sha(outputBytes)
      && receipt.status === 'GENERATED_PENDING_HUMAN_REVIEW' && receipt.runId === RUN_ID
      && receipt.beatId === BEAT_ID && receipt.operation === OPERATION && receipt.requestKey === REQUEST_KEY
      && receipt.assetClass === CLASSIFICATION && receipt.productionUse === false
      && receipt.bindings?.stagedIndexSha256 === routes.TRUST.stagedIndexSha256
      && receipt.bindings?.requestKeyReconciliationSha256 === RECONCILIATION_SHA256
      && result.status === 'SUCCEEDED' && result.runId === RUN_ID && result.beatId === BEAT_ID
      && result.requestKey === REQUEST_KEY && result.assetClass === CLASSIFICATION
      && result.receiptSha256 === sha(receiptBytes) && result.output?.sha256 === sha(outputBytes)
      && result.ledgerSha256 === sha(fsImpl.readFileSync(file('ledger'))),
    'PHASE3_B009_OUTPUT_BINDING_INVALID');
    return { schemaVersion: 'phase3-act1-b009-source-still-inspection/1.0.0',
      status: 'INSPECTED_PENDING_HUMAN_REVIEW', runId: RUN_ID, beatId: BEAT_ID, requestKey: REQUEST_KEY,
      output: { path: FILES.output, bytes: outputBytes.length, sha256: sha(outputBytes), ...outputInfo },
      receiptSha256: sha(receiptBytes), ledgerSha256: sha(fsImpl.readFileSync(file('ledger'))),
      approved: humanApproved, requiresHumanApprovalBeforeAnimation: !humanApproved, assetClass: CLASSIFICATION,
      productionReadiness: 'REJECTED', providerRequests: 0, episodeRootWrites: 0 };
  }
  function verifyCompletedState() {
    assertBindings();
    return (completedStateVerifier || verifyCompletedSourceStillState)({ runDir, approvalPath, fsImpl });
  }
  return { status, preflight, generate, inspect, assertBindings, verifyCompletedState, makeAuthTemplate,
    validateAuthorization: (record, hashes) => validateAuth(record, hashes), constants: { RUN_ID, BEAT_ID, OPERATION,
      REQUEST_KEY, FILES, RECONCILIATION_SHA256, B006_APPROVAL_SHA256, ROUTE_BUNDLE_SHA256 } };
}

module.exports = { RUN_ID, BEAT_ID, OPERATION, REQUEST_KEY, RECONCILIATION_SHA256, B006_APPROVAL_SHA256,
  ROUTE_BUNDLE_SHA256, AUTH_SCHEMA, LEDGER_SCHEMA, FILES, CLASSIFICATION, OWNERSHIP, MAX_EXPOSURE_USD,
  EXPECTED_CHARGE_USD, sha, canonicalJson, makeAuthTemplate, validateAuth,
  b006ReceiptStatusAccepted, verifyB006CompletedState, verifyCompletedSourceStillState,
  verifyCompletedSourceStillStateForTest, createB009SourceStillWorkflow };
