'use strict';

// Offline-only Phase 3 calibration closure and production-batch planner.
// This module never calls providers, writes episode media, renders, promotes,
// or creates production execution authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATUS = 'PRODUCTION_BATCH_READY_EXECUTION_UNAUTHORIZED';
const ASSET_CLASS = 'NON_PRODUCTION_DISPOSABLE_CALIBRATION';
const APPROVED_AT = '2026-10-06T19:39:32.318Z';
const ARTIFACT_ROOT = path.resolve(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const CANDIDATE_ROOT = path.join(ARTIFACT_ROOT, 'phase3-consolidated-act5-production-candidate-20261004-v5');
const REVIEW_ROOT = path.join(ARTIFACT_ROOT, 'phase3-media-completion-review-20261002-v5');
const CENSUS_PATH = path.join(ARTIFACT_ROOT, 'phase3-v5-media-census-reconciliation-20261004.v1.json');
const OUTPUT_ROOT = path.join(ARTIFACT_ROOT, 'phase3-production-batch-planning-20261006-v1');

const EVIDENCE = Object.freeze({
  'ACT1_B009-raw-provider.mp4': { bytes: 6951973, sha256: '976a45b4230d20638a260d8fc41306951ff308b077a174531257a7534e468c79' },
  'ACT1_B009-fitted-30fps-114f.mp4': { bytes: 922979, sha256: '5cfc0c6a5b66efe617ac6b4afbb552b255e3897b7bad5071e65ab74af78ae890' },
  'ACT1_B009-fitted-contact-sheet-6frame.png': { bytes: 1226485, sha256: 'b022a6d30eded8d00ed268f93a72c97c6aeafa6035372e16487754bb01be0724' },
  'animation-generation-receipt.v1.json': { bytes: 4754, sha256: '1df0f50866fb1f788c297c72c96601c21bfe5354e1c2bb103612caeace998f76' },
  'animation-generation-result.v1.json': { bytes: 1184, sha256: '8ac4fa94b13d789052543bf5d292810b9acfa68b7cfe852cbfaa1a855127a7b8' },
  'animation-request-ledger.jsonl': { bytes: 1770, sha256: '05512a29fe190df56d4bd1ff18b25472585dfa463d847dac1c499a7b5f8ba0cc' },
});
const SOURCE_BINDINGS = Object.freeze({
  recoveryCommit: '57e5796ce5b6a77d36b3f75373e78effdb2f94d4',
  recoveryDeployment: '7b62db25-d4f2-4cd3-8531-3f8c2edf2949',
  animationRequestKey: '946a3ac047028bf95badf61753f46e340bb27d8a3931c9f675ba210e1d9de3c3',
  sourceStillSha256: '0a9c9311c20da7dc774b1695f9abe2ea56f648fc0eb2450a8c7f0c4130b9ffdc',
  b006ApprovalSha256: 'd00ce391df1822468eb7fe2d07f85fc6404c483e1a79105c9e50aaa875c1dcd1',
  b009SourceStillApprovalSha256: '8b2c41cff79bac73a89e22d80a953517091acaa98bc110d6447da06e835b548c',
  candidateIndexSha256: 'a1981dd4c57a5c10c83fd2e3739d0630006e93e628a72cef3d574d07ef83b4cf',
  outerPackageIndexSha256: 'c50dd2d054c430f0daf5748de9a6d3e5c946cef1e8b4fbe57a4f986f6a48dac4',
  censusSha256: 'bcdcd8bd29987aba1519d4ee9b958ae1662f93df81e5c1a057e2b721dde8a63b',
});

function fail(ok, code) { if (!ok) throw new Error(code); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function hashObject(value) { return sha(Buffer.from(canonicalJson(value), 'utf8')); }
function pretty(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function fileBinding(file) {
  const bytes = fs.readFileSync(file);
  return { path: path.basename(file), bytes: bytes.length, sha256: sha(bytes) };
}
function verifySelfBinding(record, field, code) {
  const body = { ...record }; const binding = body[field]; delete body[field];
  fail(binding === hashObject(body), code);
}
function bindRecord(body, field) { return { ...body, [field]: hashObject(body) }; }
function assertExactKeys(object, expected, code) {
  fail(canonicalJson(Object.keys(object).sort()) === canonicalJson([...expected].sort()), code);
}

function verifyCalibrationEvidence(reviewDirectory) {
  const actual = fs.readdirSync(reviewDirectory).sort();
  assertExactKeys(Object.fromEntries(actual.map(name => [name, true])), Object.keys(EVIDENCE), 'PHASE3_CALIBRATION_REVIEW_FILE_SET_INVALID');
  const files = {};
  for (const [name, expected] of Object.entries(EVIDENCE)) {
    const file = path.join(reviewDirectory, name), stat = fs.lstatSync(file), bytes = fs.readFileSync(file);
    fail(stat.isFile() && !stat.isSymbolicLink() && bytes.length === expected.bytes && sha(bytes) === expected.sha256,
      `PHASE3_CALIBRATION_EVIDENCE_MISMATCH:${name}`);
    files[name] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  const receipt = readJson(path.join(reviewDirectory, 'animation-generation-receipt.v1.json'));
  const result = readJson(path.join(reviewDirectory, 'animation-generation-result.v1.json'));
  const ledger = fs.readFileSync(path.join(reviewDirectory, 'animation-request-ledger.jsonl'), 'utf8')
    .split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  verifySelfBinding(receipt, 'receiptBindingSha256', 'PHASE3_CALIBRATION_RECEIPT_SELF_BINDING_INVALID');
  verifySelfBinding(result, 'resultBindingSha256', 'PHASE3_CALIBRATION_RESULT_SELF_BINDING_INVALID');
  fail(receipt.status === 'ANIMATION_GENERATED_PENDING_HUMAN_REVIEW'
    && receipt.requestKey === SOURCE_BINDINGS.animationRequestKey
    && receipt.sourceStillSha256 === SOURCE_BINDINGS.sourceStillSha256
    && receipt.rawOutput?.sha256 === EVIDENCE['ACT1_B009-raw-provider.mp4'].sha256
    && receipt.rawOutput?.bytes === EVIDENCE['ACT1_B009-raw-provider.mp4'].bytes
    && receipt.derivative?.sha256 === EVIDENCE['ACT1_B009-fitted-30fps-114f.mp4'].sha256
    && receipt.derivative?.bytes === EVIDENCE['ACT1_B009-fitted-30fps-114f.mp4'].bytes
    && receipt.derivative?.video?.codec === 'h264' && receipt.derivative?.video?.width === 1344
    && receipt.derivative?.video?.height === 768 && receipt.derivative?.video?.fps === 30
    && receipt.derivative?.video?.frameCount === 114 && receipt.derivative?.durationSeconds === 3.8
    && receipt.derivative?.audioStreamCount === 0 && receipt.assetClass === ASSET_CLASS
    && receipt.productionReadiness === 'REJECTED' && receipt.retries === 0 && receipt.fallback === false,
  'PHASE3_CALIBRATION_RECEIPT_BINDINGS_INVALID');
  fail(result.status === 'SUCCEEDED' && result.requestKey === SOURCE_BINDINGS.animationRequestKey
    && result.receiptSha256 === EVIDENCE['animation-generation-receipt.v1.json'].sha256
    && result.ledgerSha256 === EVIDENCE['animation-request-ledger.jsonl'].sha256
    && result.rawOutputSha256 === EVIDENCE['ACT1_B009-raw-provider.mp4'].sha256
    && result.derivativeSha256 === EVIDENCE['ACT1_B009-fitted-30fps-114f.mp4'].sha256
    && result.assetClass === ASSET_CLASS && result.productionReadiness === 'REJECTED'
    && result.providerSubmissionCount === 1 && result.retries === 0 && result.fallbacks === 0,
  'PHASE3_CALIBRATION_RESULT_BINDINGS_INVALID');
  fail(ledger.length === 2 && ledger[0].recordType === 'SUBMISSION_RESERVED' && ledger[0].sequence === 1
    && ledger[1].recordType === 'SUBMISSION_RESULT' && ledger[1].sequence === 2 && ledger[1].status === 'SUCCEEDED'
    && ledger.every(row => row.requestKey === SOURCE_BINDINGS.animationRequestKey)
    && ledger[1].providerSubmissionCount === 1 && ledger[1].retryCount === 0 && ledger[1].retries === 0
    && ledger[1].fallbackUsed === false && ledger[1].fallbacks === 0,
  'PHASE3_CALIBRATION_LEDGER_INVALID');
  for (const row of ledger) {
    const body = { ...row }; const entry = body.entrySha256; delete body.entrySha256;
    fail(entry === hashObject(body), 'PHASE3_CALIBRATION_LEDGER_ENTRY_BINDING_INVALID');
  }
  fail(result.reservationEntrySha256 === ledger[0].entrySha256
    && result.resultEntrySha256 === ledger[1].entrySha256, 'PHASE3_CALIBRATION_LEDGER_RESULT_MISMATCH');
  return { files, receipt, result, ledger, providerSubmissions: 1, retries: 0, fallbacks: 0 };
}

function makeApproval({ approvedAt = APPROVED_AT } = {}) {
  const body = {
    schemaVersion: 'phase3-act1-b009-animation-human-validation-approval/1.0.0',
    status: 'APPROVED_FOR_CALIBRATION_VALIDATION_ONLY', approvedBy: 'Yakubu Moshood', approvedAt,
    approvalRef: 'user-approval-act1-b009-recovered-fitted-animation-2026-10-06',
    decision: 'The recovered ACT1_B009 fitted animation is approved for calibration validation only.',
    bindings: { ...SOURCE_BINDINGS,
      rawVideo: EVIDENCE['ACT1_B009-raw-provider.mp4'], fittedDerivative: EVIDENCE['ACT1_B009-fitted-30fps-114f.mp4'],
      successReceiptSha256: EVIDENCE['animation-generation-receipt.v1.json'].sha256,
      terminalResultSha256: EVIDENCE['animation-generation-result.v1.json'].sha256,
      finalAnimationLedgerSha256: EVIDENCE['animation-request-ledger.jsonl'].sha256,
    },
    fittedOutputContract: { container: 'MP4', codec: 'h264', width: 1344, height: 768, fps: 30,
      frames: 114, durationSeconds: 3.8, audioStreams: 0 },
    classification: { assetClass: ASSET_CLASS, productionReadiness: 'REJECTED', productionUse: false },
    restrictions: { providerRequestsAuthorized: 0, retriesAuthorized: 0, fallbacksAuthorized: 0,
      renderingAuthorized: false, promotionAuthorized: false, candidateReconstructionAuthorized: false,
      stage04ModificationAuthorized: false, episodeRootWritesAuthorized: false, productionExecutionAuthorized: false },
  };
  return bindRecord(body, 'approvalBindingSha256');
}

function makeFinalization(approvalSha256) {
  return bindRecord({
    schemaVersion: 'phase3-calibration-finalization/1.0.0', status: 'CALIBRATION_ASSET_FINALIZED_PRODUCTION_REJECTED',
    finalizedAt: APPROVED_AT, finalizationMethod: 'HASH_BOUND_OFFLINE_RECORD_ONLY',
    bindings: { humanValidationApprovalSha256: approvalSha256,
      successReceiptSha256: EVIDENCE['animation-generation-receipt.v1.json'].sha256,
      terminalResultSha256: EVIDENCE['animation-generation-result.v1.json'].sha256,
      finalAnimationLedgerSha256: EVIDENCE['animation-request-ledger.jsonl'].sha256,
      rawVideoSha256: EVIDENCE['ACT1_B009-raw-provider.mp4'].sha256,
      fittedDerivativeSha256: EVIDENCE['ACT1_B009-fitted-30fps-114f.mp4'].sha256 },
    outcome: { beatId: 'ACT1_B009', calibrationValidation: 'APPROVED', assetClass: ASSET_CLASS,
      productionReadiness: 'REJECTED', providerSubmissions: 1, retries: 0, fallbacks: 0 },
    effects: { providerRequests: 0, mediaWrites: 0, productionPathWrites: 0, renderRuns: 0,
      promotions: 0, candidateReconstruction: false, stage04Modification: false },
  }, 'finalizationBindingSha256');
}

function makeVerdict(approvalSha256, finalizationSha256) {
  return bindRecord({
    schemaVersion: 'phase3-consolidated-calibration-verdict/1.0.0', status: 'CALIBRATION_LANE_CLOSED',
    recordedAt: APPROVED_AT,
    bindings: { act1B006ApprovalSha256: SOURCE_BINDINGS.b006ApprovalSha256,
      act1B009SourceStillApprovalSha256: SOURCE_BINDINGS.b009SourceStillApprovalSha256,
      act1B009AnimationApprovalSha256: approvalSha256, act1B009FinalizationSha256: finalizationSha256 },
    verdicts: [
      { asset: 'ACT1_B006_STILL', calibration: 'APPROVED', production: 'REJECTED', assetClass: ASSET_CLASS },
      { asset: 'ACT1_B009_SOURCE_STILL', calibration: 'APPROVED', production: 'REJECTED', assetClass: ASSET_CLASS },
      { asset: 'ACT1_B009_ANIMATION', calibration: 'APPROVED', production: 'REJECTED', assetClass: ASSET_CLASS },
      { asset: 'ACT1_B005', calibration: 'DEFERRED', production: 'REJECTED', assetClass: ASSET_CLASS },
    ],
    closure: { additionalCalibrationRequestsAuthorized: 0, productionExecutionAuthorized: false,
      renderingAuthorized: false, promotionAuthorized: false, stage04ModificationAuthorized: false,
      calibrationAssetsMayEnterProductionPaths: false },
  }, 'verdictBindingSha256');
}

function promptBinding(text) { return sha(Buffer.from(text || '', 'utf8')); }
function requestKey(body) { return hashObject({ schemaVersion: 'phase3-production-batch-request-key/1.0.0', ...body }); }
function loadPlanningSources() {
  const files = {
    shotDefinitions: path.join(CANDIDATE_ROOT, 'candidate', 'shot-definitions.json'),
    productionManifest: path.join(CANDIDATE_ROOT, 'candidate', 'production-manifest.json'),
    candidateIndex: path.join(CANDIDATE_ROOT, 'candidate', 'candidate-package-sha256.json'),
    dependencyGraph: path.join(REVIEW_ROOT, 'phase3-media-dependency-graph.v5.json'),
    clipFitPolicy: path.join(REVIEW_ROOT, 'phase3-media-clip-fit-policy.v1.json'),
    reviewPackageIndex: path.join(REVIEW_ROOT, 'phase3-media-package-index.v5.json'),
    census: CENSUS_PATH,
  };
  const bindings = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fileBinding(file)]));
  fail(bindings.candidateIndex.sha256 === SOURCE_BINDINGS.candidateIndexSha256
    && bindings.census.sha256 === SOURCE_BINDINGS.censusSha256, 'PHASE3_PRODUCTION_SOURCE_INDEX_MISMATCH');
  const candidateIndex = readJson(files.candidateIndex), reviewIndex = readJson(files.reviewPackageIndex);
  const indexedCandidate = new Map(candidateIndex.files.map(item => [item.path, item]));
  const indexedReview = new Map(reviewIndex.files.map(item => [item.path, item]));
  fail(indexedCandidate.get('shot-definitions.json')?.sha256 === bindings.shotDefinitions.sha256
    && indexedCandidate.get('production-manifest.json')?.sha256 === bindings.productionManifest.sha256
    && indexedReview.get('phase3-media-dependency-graph.v5.json')?.sha256 === bindings.dependencyGraph.sha256
    && indexedReview.get('phase3-media-clip-fit-policy.v1.json')?.sha256 === bindings.clipFitPolicy.sha256,
  'PHASE3_PRODUCTION_INDEXED_SOURCE_BINDING_MISMATCH');
  return { files, bindings, shotDefinitions: readJson(files.shotDefinitions),
    manifest: readJson(files.productionManifest), graph: readJson(files.dependencyGraph),
    clipFit: readJson(files.clipFitPolicy), census: readJson(files.census) };
}

function makeRoutes() {
  return {
    schemaVersion: 'phase3-production-batch-route-bindings/1.0.0', status: STATUS,
    routes: {
      LOCAL_CONTROLLED_STILL: { provider: 'LOCAL_HUMAN_CONTROLLED', externalProviderRequest: false,
        input: 'approved controlled-still construction brief', outputContractId: 'CONTROLLED_STILL_PNG_1920X1080' },
      FLUX3_STILL_1K_16X9: { provider: 'fal.ai', model: 'FLUX 3 Image', endpoint: 'blackforestlabs/flux-3/text-to-image',
        parameters: { resolution: '1k', aspect_ratio: '16:9', output_format: 'png', enable_prompt_expansion: false,
          num_images: 1 }, promptExpansion: false, negativePromptHandling: 'HASH_BOUND_REVIEW_CONSTRAINT_NOT_SENT_AS_UNSUPPORTED_FIELD',
        outputContractId: 'FLUX3_PNG_1360X768' },
      H3_MAX_I2V_5S_768P: { provider: 'fal.ai', model: 'H3 Max Image to Video', endpoint: 'minimax/h3-max/image-to-video',
        parameters: { duration: 5, resolution: '768P', prompt_expansion_mode: 'disabled', enable_safety_checker: true },
        target_audio_url: 'NOT_SENT', negativePromptHandling: 'HASH_BOUND_REVIEW_CONSTRAINT_NOT_SENT_AS_UNSUPPORTED_FIELD',
        rawOutputContractId: 'H3_RAW_IMMUTABLE', fittedOutputContractId: 'H3_FITTED_30FPS_SILENT' },
    },
    authority: { routeSelectionApprovedForPlanning: true, productionExecutionAuthorized: false,
      providerRequestsAuthorized: 0, authorizationArtifact: null },
  };
}

function makeContracts() {
  return {
    schemaVersion: 'phase3-production-batch-output-contracts/1.0.0', status: STATUS,
    contracts: {
      CONTROLLED_STILL_PNG_1920X1080: { finalOrIntermediate: 'FINAL', format: 'PNG', mimeType: 'image/png',
        width: 1920, height: 1080, aspectRatio: '16:9', alphaAllowed: false, generatedTextAllowed: false },
      FLUX3_PNG_1360X768: { finalOrIntermediate: 'PER_JOB', format: 'PNG', mimeType: 'image/png', width: 1360,
        height: 768, aspectRatio: '16:9', imageCount: 1, generatedTextAllowed: false },
      H3_RAW_IMMUTABLE: { finalOrIntermediate: 'INTERMEDIATE', preserveBytesUnchanged: true, container: 'MP4',
        requiredVideoStreams: 1, maximumAudioStreams: 1, probeRequired: true, productionUse: false },
      H3_FITTED_30FPS_SILENT: { finalOrIntermediate: 'FINAL', container: 'MP4', codec: 'h264', width: 1344,
        height: 768, fps: 30, audioStreams: 0, frameCount: 'PER_BEAT_TARGET_FRAMES',
        fitting: 'NORMALIZE_TO_30FPS_THEN_EXACT_FRAME_TRIM_OR_APPROVED_FINAL_FRAME_HOLD' },
    },
  };
}

function makeGates() {
  return {
    schemaVersion: 'phase3-production-batch-review-gates-and-retry-policy/1.0.0', status: STATUS,
    globalGates: ['PACKAGE_INDEX_HASH_PASS', 'CANDIDATE_BINDINGS_PASS', 'DETACHED_PRODUCTION_EXECUTION_AUTHORIZATION_REQUIRED',
      'AGGREGATE_EXPOSURE_CEILING_APPROVAL_REQUIRED', 'NO_CALIBRATION_ASSET_REUSE'],
    perAssetGates: {
      controlledStill: ['TECHNICAL_PNG_CONTRACT_PASS', 'HUMAN_VISUAL_APPROVAL'],
      generatedStill: ['DURABLE_REQUEST_RESERVATION', 'EXACT_REQUEST_KEY_MATCH', 'TECHNICAL_PNG_CONTRACT_PASS',
        'NEGATIVE_INSTRUCTION_VISUAL_REVIEW', 'HUMAN_VISUAL_APPROVAL'],
      animationSourceStill: ['DURABLE_REQUEST_RESERVATION', 'EXACT_REQUEST_KEY_MATCH', 'TECHNICAL_PNG_CONTRACT_PASS',
        'NEGATIVE_INSTRUCTION_VISUAL_REVIEW', 'HUMAN_SOURCE_STILL_APPROVAL_BEFORE_ANIMATION'],
      animationClip: ['APPROVED_SOURCE_STILL_HASH_REQUIRED', 'SEPARATE_ANIMATION_AUTHORIZATION_REQUIRED',
        'DURABLE_REQUEST_RESERVATION', 'RAW_OUTPUT_IMMUTABLY_PRESERVED', 'RAW_MEDIA_PROBE_PASS',
        'FITTED_OUTPUT_CONTRACT_PASS', 'HUMAN_MOTION_APPROVAL'],
    },
    retryPolicy: { automaticRetries: 0, providerSdkRetries: 0, fallbackModels: [], duplicateRequestKeysRejected: true,
      failedReservedKeyDisposition: 'CONSUMED_TERMINAL', retryRequires: ['NEW_HUMAN_APPROVAL', 'NEW_REQUEST_KEY',
        'RENEWED_COST_EXPOSURE_ACCOUNTING'], batchFailureMode: 'STOP_AFFECTED_DEPENDENCY_CHAIN' },
  };
}

function buildPlan(sources, verdictSha256) {
  const shots = new Map(sources.shotDefinitions.allShots.map(shot => [shot.beatId, shot]));
  const clipByBeat = new Map(sources.clipFit.entries.map(entry => [entry.beatId, entry]));
  const nodes = type => sources.graph.nodes.filter(node => node.type === type).sort((a, b) => a.beatId.localeCompare(b.beatId));
  const common = { candidateIndexSha256: SOURCE_BINDINGS.candidateIndexSha256, verdictSha256 };
  const controlledStills = nodes('CONTROLLED_STILL_OUTPUT').map(node => {
    const shot = shots.get(node.beatId); fail(shot?.imagePrompt, `PHASE3_PRODUCTION_PROMPT_MISSING:${node.beatId}`);
    const binding = { ...common, beatId: node.beatId, kind: 'CONTROLLED_STILL', routeId: 'LOCAL_CONTROLLED_STILL',
      promptSha256: promptBinding(shot.imagePrompt), negativePromptSha256: promptBinding(shot.negativePrompt),
      outputContractId: 'CONTROLLED_STILL_PNG_1920X1080' };
    return { beatId: node.beatId, requestKey: requestKey(binding), externalProviderRequests: 0,
      prompt: shot.imagePrompt, promptSha256: binding.promptSha256, negativePrompt: shot.negativePrompt,
      negativePromptSha256: binding.negativePromptSha256, routeId: binding.routeId,
      outputContractId: binding.outputContractId, outputPath: `planned/final/controlled-stills/${node.beatId}.png`,
      reviewGate: 'CONTROLLED_STILL_FINAL_REVIEW', executionAuthorized: false };
  });
  const stillJob = (node, kind, outputPath) => {
    const shot = shots.get(node.beatId); fail(shot?.imagePrompt, `PHASE3_PRODUCTION_PROMPT_MISSING:${node.beatId}`);
    const binding = { ...common, beatId: node.beatId, kind, routeId: 'FLUX3_STILL_1K_16X9',
      promptSha256: promptBinding(shot.imagePrompt), negativePromptSha256: promptBinding(shot.negativePrompt),
      outputContractId: 'FLUX3_PNG_1360X768' };
    return { beatId: node.beatId, requestKey: requestKey(binding), externalProviderRequests: 1,
      prompt: shot.imagePrompt, promptSha256: binding.promptSha256, negativePrompt: shot.negativePrompt,
      negativePromptSha256: binding.negativePromptSha256, routeId: binding.routeId,
      outputContractId: binding.outputContractId, outputPath, reviewGate: kind === 'ANIMATION_SOURCE_STILL'
        ? 'SOURCE_STILL_HUMAN_APPROVAL_BEFORE_ANIMATION' : 'GENERATED_STILL_FINAL_REVIEW', executionAuthorized: false };
  };
  const generatedStills = nodes('GENERATED_STILL_OUTPUT').map(node => stillJob(node, 'GENERATED_STILL',
    `planned/final/generated-stills/${node.beatId}.png`));
  const animationSourceStills = nodes('ANIMATION_BASE_STILL').map(node => stillJob(node, 'ANIMATION_SOURCE_STILL',
    `planned/intermediate/animation-source-stills/${node.beatId}.png`));
  const sourceByBeat = new Map(animationSourceStills.map(job => [job.beatId, job]));
  const animationClips = nodes('ESSENTIAL_ANIMATION_CLIP').map(node => {
    const shot = shots.get(node.beatId), fit = clipByBeat.get(node.beatId), dependency = sourceByBeat.get(node.beatId);
    fail(shot?.animationPrompt && fit && dependency, `PHASE3_PRODUCTION_ANIMATION_PLAN_MISSING:${node.beatId}`);
    const promptSha256 = promptBinding(shot.animationPrompt), negativePromptSha256 = promptBinding(shot.negativePrompt);
    fail(promptSha256 === fit.promptSha256, `PHASE3_PRODUCTION_ANIMATION_PROMPT_HASH_MISMATCH:${node.beatId}`);
    const binding = { ...common, beatId: node.beatId, kind: 'ANIMATION_CLIP', routeId: 'H3_MAX_I2V_5S_768P',
      promptSha256, negativePromptSha256, sourceStillRequestKey: dependency.requestKey,
      outputContractId: 'H3_FITTED_30FPS_SILENT', targetFrames: fit.timelineFramePlan.targetFrames };
    return { beatId: node.beatId, requestKey: requestKey(binding), externalProviderRequests: 1,
      sourceStillRequestKey: dependency.requestKey, sourceStillSha256: 'REQUIRED_AFTER_APPROVED_SOURCE_STILL_MATERIALIZES',
      prompt: shot.animationPrompt, promptSha256, negativePrompt: shot.negativePrompt, negativePromptSha256,
      routeId: binding.routeId, rawOutputContractId: 'H3_RAW_IMMUTABLE', outputContractId: binding.outputContractId,
      targetFrames: fit.timelineFramePlan.targetFrames, frameAccurateDurationSec: fit.timelineFramePlan.frameAccurateDurationSec,
      trimFrames: fit.timelineFramePlan.trimFrames, holdFrames: fit.timelineFramePlan.holdFrames,
      rawOutputPath: `planned/intermediate/animation-raw/${node.beatId}.mp4`,
      outputPath: `planned/final/animation-clips/${node.beatId}.mp4`, reviewGate: 'ANIMATION_FINAL_HUMAN_REVIEW',
      executionAuthorized: false };
  });
  const counts = { controlledStills: controlledStills.length, generatedStills: generatedStills.length,
    animationClips: animationClips.length, intermediateAnimationSourceStills: animationSourceStills.length,
    finalOutputs: controlledStills.length + generatedStills.length + animationClips.length,
    totalPlannedAssetsIncludingIntermediates: controlledStills.length + generatedStills.length
      + animationClips.length + animationSourceStills.length,
    externalProviderSubmissions: generatedStills.length + animationSourceStills.length + animationClips.length };
  fail(canonicalJson(counts) === canonicalJson({ controlledStills: 34, generatedStills: 8, animationClips: 23,
    intermediateAnimationSourceStills: 23, finalOutputs: 65, totalPlannedAssetsIncludingIntermediates: 88,
    externalProviderSubmissions: 54 }), 'PHASE3_PRODUCTION_BATCH_COUNTS_INVALID');
  const keys = [...controlledStills, ...generatedStills, ...animationSourceStills, ...animationClips].map(job => job.requestKey);
  fail(new Set(keys).size === 88, 'PHASE3_PRODUCTION_REQUEST_KEY_COLLISION');
  return { schemaVersion: 'phase3-production-batch-plan/1.0.0', status: STATUS,
    bindings: { ...SOURCE_BINDINGS, consolidatedCalibrationVerdictSha256: verdictSha256,
      shotDefinitionsSha256: sources.bindings.shotDefinitions.sha256,
      productionManifestSha256: sources.bindings.productionManifest.sha256,
      dependencyGraphSha256: sources.bindings.dependencyGraph.sha256,
      clipFitPolicySha256: sources.bindings.clipFitPolicy.sha256 },
    counts, controlledStills, generatedStills, animationSourceStills, animationClips,
    authority: { productionExecutionAuthorization: null, providerRequestsAuthorized: 0,
      mediaGenerationAuthorized: false, renderingAuthorized: false, promotionAuthorized: false },
  };
}

function makeCost() {
  return {
    schemaVersion: 'phase3-production-batch-cost-and-exposure/1.0.0', status: STATUS,
    pricingBasis: { retrievedAt: '2026-10-04', source: 'committed calibration route bundle',
      flux3OneKPromotionalPerImageUsdThrough2026_10_08: 0.024, flux3OneKRegularPerImageUsd: 0.048,
      h3Max768pPerOutputSecondUsd: 0.08, h3RequestedSecondsPerClip: 5 },
    quantities: { controlledLocalStills: 34, providerStills: 31, animationClips: 23,
      animationBillableSeconds: 115, providerSubmissions: 54, automaticRetries: 0 },
    estimateUsd: { promotionalStillSubtotal: 0.744, regularStillSubtotal: 1.488,
      animationSubtotal: 9.2, promotionalTotal: 9.944, regularTotal: 10.688 },
    proposedHumanExposureCeilingUsd: 12.0, providerEnforced: false,
    ceilingStatus: 'PROPOSED_NOT_APPROVED', executionAuthorizationCreated: false,
    exclusions: ['retries', 'fallbacks', 'reference stills outside the requested 34/8/23/23 package'],
  };
}

function makeReadme(hashes) {
  return `# Phase 3 production-batch planning package\n\nStatus: **${STATUS}**\n\nThis package plans exactly 34 controlled stills, 8 generated final stills, 23 final animation clips, and 23 intermediate animation source stills. It contains no media, provider execution authorization, render authority, promotion authority, Stage04 change, or production-path write.\n\nCalibration assets remain ${ASSET_CLASS} and production-rejected. ACT1_B005 remains deferred in the closed calibration lane; its production controlled-still task is planning-only.\n\nEstimated provider cost is USD 9.944 at the committed promotional still price or USD 10.688 at the regular still price. The proposed, unapproved maximum human exposure is USD 12.00. Automatic retries and fallback routes are zero.\n\nApproval SHA-256: \`${hashes.approval}\`\n\nFinalization SHA-256: \`${hashes.finalization}\`\n\nConsolidated verdict SHA-256: \`${hashes.verdict}\`\n`;
}

function writeExclusive(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { path: path.basename(file), bytes: bytes.length, sha256: sha(bytes) };
}

function buildClosure({ reviewDirectory, outputRoot = OUTPUT_ROOT, approvedAt = APPROVED_AT } = {}) {
  fail(typeof reviewDirectory === 'string', 'PHASE3_CALIBRATION_REVIEW_DIRECTORY_REQUIRED');
  verifyCalibrationEvidence(path.resolve(reviewDirectory));
  fail(!fs.existsSync(outputRoot), 'PHASE3_CALIBRATION_CLOSURE_OUTPUT_ALREADY_EXISTS');
  const approval = makeApproval({ approvedAt });
  const approvalPath = path.join(ARTIFACT_ROOT, 'phase3-act1-b009-animation-human-validation-approval-20261006.v1.json');
  const finalizationPath = path.join(outputRoot, 'calibration-finalization.v1.json');
  const verdictPath = path.join(outputRoot, 'consolidated-calibration-verdict.v1.json');
  fail(!fs.existsSync(approvalPath), 'PHASE3_CALIBRATION_APPROVAL_ALREADY_EXISTS');
  const approvalBinding = writeExclusive(approvalPath, pretty(approval));
  try {
    const finalization = makeFinalization(approvalBinding.sha256);
    const finalizationBinding = writeExclusive(finalizationPath, pretty(finalization));
    const verdict = makeVerdict(approvalBinding.sha256, finalizationBinding.sha256);
    const verdictBinding = writeExclusive(verdictPath, pretty(verdict));
    const sources = loadPlanningSources(), routes = makeRoutes(), contracts = makeContracts(), gates = makeGates();
    const plan = buildPlan(sources, verdictBinding.sha256), cost = makeCost();
    const records = [];
    for (const [name, value] of [['production-batch-plan.v1.json', plan], ['route-bindings.v1.json', routes],
      ['output-contracts.v1.json', contracts], ['review-gates-and-retry-policy.v1.json', gates],
      ['cost-and-exposure.v1.json', cost]]) records.push(writeExclusive(path.join(outputRoot, name), pretty(value)));
    const readme = Buffer.from(makeReadme({ approval: approvalBinding.sha256, finalization: finalizationBinding.sha256,
      verdict: verdictBinding.sha256 }), 'utf8');
    records.push(writeExclusive(path.join(outputRoot, 'README.md'), readme));
    records.push({ path: 'calibration-finalization.v1.json', ...fileBinding(finalizationPath) });
    records.push({ path: 'consolidated-calibration-verdict.v1.json', ...fileBinding(verdictPath) });
    const indexBody = { schemaVersion: 'phase3-production-batch-planning-package-index/1.0.0', status: STATUS,
      packageId: path.basename(outputRoot), createdAt: approvedAt, files: records.sort((a, b) => a.path.localeCompare(b.path)),
      bindings: { humanValidationApprovalSha256: approvalBinding.sha256,
        finalizationSha256: finalizationBinding.sha256, consolidatedVerdictSha256: verdictBinding.sha256 },
      counts: plan.counts, estimatedCostUsd: cost.estimateUsd, proposedHumanExposureCeilingUsd: 12,
      productionExecutionAuthorization: null };
    const index = bindRecord(indexBody, 'indexBindingSha256');
    const indexBinding = writeExclusive(path.join(outputRoot, 'package-index.v1.json'), pretty(index));
    return { status: STATUS, approval: approvalBinding, finalization: finalizationBinding, verdict: verdictBinding,
      packageIndex: indexBinding, counts: plan.counts, cost: cost.estimateUsd, proposedHumanExposureCeilingUsd: 12 };
  } catch (error) {
    throw error;
  }
}

module.exports = { STATUS, ASSET_CLASS, APPROVED_AT, ARTIFACT_ROOT, CANDIDATE_ROOT, REVIEW_ROOT, CENSUS_PATH,
  OUTPUT_ROOT, EVIDENCE, SOURCE_BINDINGS, sha, canonical, canonicalJson, hashObject, verifyCalibrationEvidence,
  makeApproval, makeFinalization, makeVerdict, makeRoutes, makeContracts, makeGates, loadPlanningSources,
  buildPlan, makeCost, buildClosure };
