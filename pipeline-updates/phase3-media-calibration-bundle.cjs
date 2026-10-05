'use strict';

// Hash-bound, planning-only routes for the approved three-shot calibration.
// This module deliberately exposes no provider client or submission capability.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TRUST = Object.freeze({ runId: 'phase3-media-execution-v5-20261004-01',
  stagedIndexSha256: '2b9c5f4c65b18d229a7ad158889ec6753811454a410b0b808b6785b8057c92ad',
  outerIndexSha256: 'c50dd2d054c430f0daf5748de9a6d3e5c946cef1e8b4fbe57a4f986f6a48dac4',
  candidateIndexSha256: 'a1981dd4c57a5c10c83fd2e3739d0630006e93e628a72cef3d574d07ef83b4cf',
  censusRecordSha256: 'bcdcd8bd29987aba1519d4ee9b958ae1662f93df81e5c1a057e2b721dde8a63b' });
const FLUX3_ENDPOINT = 'blackforestlabs/flux-3/text-to-image';
const H3_MAX_ENDPOINT = 'minimax/h3-max/image-to-video';
const FLUX3 = Object.freeze({ resolution: '1k', aspect_ratio: '16:9', output_format: 'png', enable_prompt_expansion: false });
const H3_MAX = Object.freeze({ duration: 5, resolution: '768P', prompt_expansion_mode: 'disabled', enable_safety_checker: true });
const FLUX_NEGATIVE_PROMPT_DELIMITER = '\n\nSTRICT EXCLUSIONS — DO NOT INCLUDE:\n';
const MAX_ACCEPTED_EXPOSURE_USD = 0.60;
const OWNERSHIP_DISPOSITION = 'UNRESOLVED_ACCEPTED_FOR_NONPRODUCTION_CALIBRATION_ONLY';
const ROUTE_APPROVAL_SHA256 = 'bfa8c0d00c8dbb81d4516a663b1ce3c5ef22cd199fed4f95a545468bc3676b14';
const ROUTE_APPROVAL_PATH = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
  'phase3-media-execution-calibration-route-resolution-approval-20261005.v1.json');
const OFFICIAL = Object.freeze({ retrievedAt: '2026-10-05',
  flux3Page: 'https://fal.ai/models/blackforestlabs/flux-3/text-to-image',
  flux3Api: 'https://fal.ai/models/blackforestlabs/flux-3/text-to-image/api',
  h3Page: 'https://fal.ai/models/minimax/h3-max/image-to-video',
  h3Api: 'https://fal.ai/models/minimax/h3-max/image-to-video/api',
  terms: 'https://fal.ai/legal/terms-of-service',
  priceFindings: { flux3CurrentUsdPer1kPngImage: 0.024, flux3AfterPromotionUsdPerImage: 0.048,
    flux3PromotionEnds: '2026-10-08', h3DisplayedUsdPer768pSecond: 0.02,
    h3DisplayedPromotionEnded: '2026-09-14', h3ConservativePostPromotionUsdPerSecond: 0.08 } });
const BEATS = Object.freeze(['ACT1_B005', 'ACT1_B006', 'ACT1_B009']);
const PROMPT_HASHES = Object.freeze({
  ACT1_B006: Object.freeze({ imagePrompt: 'e1fb18bd4d777cba0f77b47adaacd0da9900251308206985b40d8579e30ef646',
    negativePrompt: '7b426ad5e100c1f34075846fb63c1125aa4eda272cdd99ac8de9a5470bf24c42' }),
  ACT1_B009: Object.freeze({ imagePrompt: '5bd66158c9e8823ebfd25233d86cf2f24a0c3af0ce12bde0669a32599251cacf',
    negativePrompt: '1e07c7c0150f5f29cb5b20bee765e3e8056a4928013cd35771ecefabb078bae9',
    animationPrompt: '5b76ea425eb891f077866a2bd1fd40b44b1bc3e4d1b0ae3d392dc151b8d1348d' }),
});

function fail(ok, code) { if (!ok) throw new Error(code); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
function readRouteApproval({ file = ROUTE_APPROVAL_PATH, fsImpl = fs } = {}) {
  fail(fsImpl.existsSync(file), 'CALIBRATION_ROUTE_APPROVAL_MISSING');
  const stat = fsImpl.lstatSync(file), bytes = fsImpl.readFileSync(file);
  fail(stat.isFile() && !stat.isSymbolicLink() && sha(bytes) === ROUTE_APPROVAL_SHA256,
    'CALIBRATION_ROUTE_APPROVAL_HASH_MISMATCH');
  const record = JSON.parse(bytes.toString('utf8'));
  fail(record.status === 'APPROVED_FOR_CALIBRATION_ROUTE_IMPLEMENTATION_ONLY'
    && record.providerExecutionAuthorized === false && record.providerRequestsAuthorized === 0
    && record.bindings?.stagedRunId === TRUST.runId
    && record.bindings?.stagedIndexSha256 === TRUST.stagedIndexSha256
    && record.bindings?.originalRoutePlanSha256 === '6981bda36cd4e9dda4da5b701fb23b2f705e1fd5bb04fcca30157160bac85b42'
    && JSON.stringify(record.permittedBeatIds) === JSON.stringify(BEATS)
    && record.routeResolutions?.still?.endpoint === FLUX3_ENDPOINT
    && record.routeResolutions?.still?.parameters?.resolution === FLUX3.resolution
    && record.routeResolutions?.still?.parameters?.aspect_ratio === FLUX3.aspect_ratio
    && record.routeResolutions?.still?.parameters?.output_format === FLUX3.output_format
    && record.routeResolutions?.still?.parameters?.enable_prompt_expansion === false
    && record.routeResolutions?.still?.serialization?.delimiter === FLUX_NEGATIVE_PROMPT_DELIMITER
    && record.routeResolutions?.animation?.endpoint === H3_MAX_ENDPOINT
    && record.routeResolutions?.animation?.parameters?.resolution === H3_MAX.resolution
    && record.routeResolutions?.animation?.parameters?.duration === H3_MAX.duration
    && record.routeResolutions?.animation?.parameters?.prompt_expansion_mode === 'disabled'
    && record.routeResolutions?.animation?.parameters?.target_audio_url === 'MUST_NOT_BE_SENT'
    && record.routeResolutions?.animation?.derivative?.frames === 114
    && record.sequence?.length === 3
    && record.ownership?.disposition === OWNERSHIP_DISPOSITION
    && record.exposure?.humanAcceptedMaximumUsd === MAX_ACCEPTED_EXPOSURE_USD
    && record.exposure?.providerEnforced === false,
  'CALIBRATION_ROUTE_APPROVAL_BINDING_INVALID');
  return { record, bytes, sha256: sha(bytes), path: file };
}
function serializedFluxPrompt(beatId, positivePrompt, negativePrompt, delimiter = FLUX_NEGATIVE_PROMPT_DELIMITER) {
  fail(['ACT1_B006', 'ACT1_B009'].includes(beatId), 'CALIBRATION_FLUX_BEAT_FORBIDDEN');
  fail(delimiter === FLUX_NEGATIVE_PROMPT_DELIMITER, 'CALIBRATION_FLUX_DELIMITER_MISMATCH');
  fail(sha(Buffer.from(positivePrompt || '', 'utf8')) === PROMPT_HASHES[beatId]?.imagePrompt,
    `CALIBRATION_PROMPT_HASH_MISMATCH:${beatId}`);
  fail(sha(Buffer.from(negativePrompt || '', 'utf8')) === PROMPT_HASHES[beatId]?.negativePrompt,
    `CALIBRATION_NEGATIVE_PROMPT_HASH_MISMATCH:${beatId}`);
  return `${positivePrompt}${delimiter}${negativePrompt}`;
}
function deterministicRequestKey({ runId = TRUST.runId, beatId, operation, endpoint, parameters, prompt,
  positivePrompt, negativePrompt, sourceSha256 = null, stagedIndexSha256 = TRUST.stagedIndexSha256 } = {}) {
  fail(runId === TRUST.runId && BEATS.includes(beatId), 'CALIBRATION_SCOPE_MISMATCH');
  fail(typeof operation === 'string' && typeof endpoint === 'string' && typeof prompt === 'string',
    'CALIBRATION_REQUEST_BINDING_INCOMPLETE');
  const stillOps = ['GENERATE_STILL', 'GENERATE_ANIMATION_SOURCE_STILL'];
  const expectedEndpoint = stillOps.includes(operation) && ['ACT1_B006', 'ACT1_B009'].includes(beatId)
    ? FLUX3_ENDPOINT : operation === 'GENERATE_ANIMATION' && beatId === 'ACT1_B009' ? H3_MAX_ENDPOINT : null;
  fail(expectedEndpoint !== null && endpoint === expectedEndpoint, 'CALIBRATION_ENDPOINT_OR_OPERATION_FORBIDDEN');
  if (stillOps.includes(operation)) {
    fail(JSON.stringify(canonical(parameters)) === JSON.stringify(canonical(FLUX3)), 'CALIBRATION_STILL_PARAMETERS_MISMATCH');
    const expectedPrompt = serializedFluxPrompt(beatId, positivePrompt, negativePrompt);
    fail(prompt === expectedPrompt && sha(Buffer.from(negativePrompt, 'utf8')) === PROMPT_HASHES[beatId].negativePrompt,
      'CALIBRATION_SERIALIZED_PROMPT_MISMATCH');
  }
  if (operation === 'GENERATE_ANIMATION') {
    const { image_url: imageUrl, ...fixed } = parameters || {};
    fail(JSON.stringify(canonical(fixed)) === JSON.stringify(canonical(H3_MAX))
      && typeof imageUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(imageUrl)
      && sourceSha256 !== null && !Object.prototype.hasOwnProperty.call(parameters || {}, 'target_audio_url'),
    'CALIBRATION_ANIMATION_PARAMETERS_OR_SOURCE_MISMATCH');
    fail(sha(Buffer.from(prompt, 'utf8')) === PROMPT_HASHES.ACT1_B009.animationPrompt
      && sha(Buffer.from(negativePrompt || '', 'utf8')) === PROMPT_HASHES.ACT1_B009.negativePrompt,
    'CALIBRATION_ANIMATION_PROMPT_MISMATCH');
  }
  if (sourceSha256 !== null) fail(/^[a-f0-9]{64}$/u.test(sourceSha256), 'CALIBRATION_SOURCE_HASH_INVALID');
  const body = canonical({ schemaVersion: 'phase3-calibration-request-key/2.0.0', runId, beatId, operation,
    modelId: endpoint, endpoint, parameters, positivePrompt, prompt, negativePrompt, sourceSha256, stagedIndexSha256 });
  return sha(Buffer.from(JSON.stringify(body), 'utf8'));
}
function makeRoutePlan({ candidate, runId = TRUST.runId, stagedIndexSha256 = TRUST.stagedIndexSha256,
  approval = null } = {}) {
  fail(candidate && typeof candidate === 'object', 'CALIBRATION_CANDIDATE_REQUIRED');
  fail(runId === TRUST.runId, 'CALIBRATION_RUN_ID_MISMATCH');
  fail(stagedIndexSha256 === TRUST.stagedIndexSha256, 'CALIBRATION_STAGED_INDEX_MISMATCH');
  const production = candidate.productionManifest, shots = candidate.shotDefinitions?.allShots;
  const beats = candidate.editPlan?.sequences?.flatMap(item => item.beats || []);
  fail(Array.isArray(production?.shots) && Array.isArray(shots) && Array.isArray(beats),
    'CALIBRATION_CANDIDATE_CONTEXT_INCOMPLETE');
  const find = id => {
    const p = production.shots.find(item => item.shotId === id), s = shots.find(item => item.beatId === id),
      b = beats.find(item => item.beatId === id);
    fail(p && s && b, `CALIBRATION_BEAT_BINDING_MISSING:${id}`); return { production: p, shot: s, beat: b };
  };
  const controlled = find('ACT1_B005'), b006 = find('ACT1_B006'), b009 = find('ACT1_B009');
  fail(controlled.production.productionMethod === 'CONTROLLED_STILL' && controlled.production.assetType === 'controlled_image',
    'CALIBRATION_B005_METHOD_MISMATCH');
  const controlledSource = candidate.controlledStillSources?.ACT1_B005 || null;
  const controlledConflict = controlled.shot.visual?.type !== 'CLIP' || controlled.shot.visual?.motionType !== 'dolly_back';
  fail(b006.production.productionMethod === 'GENERATED_STILL' && b009.production.productionMethod === 'ESSENTIAL_ANIMATION',
    'CALIBRATION_METHOD_MISMATCH');
  for (const [id, row] of [['ACT1_B006', b006], ['ACT1_B009', b009]]) {
    fail(typeof row.shot.imagePrompt === 'string' && typeof row.shot.negativePrompt === 'string',
      `CALIBRATION_PROMPT_BINDING_MISSING:${id}`);
    fail(sha(Buffer.from(row.shot.imagePrompt, 'utf8')) === PROMPT_HASHES[id].imagePrompt
      && sha(Buffer.from(row.shot.negativePrompt, 'utf8')) === PROMPT_HASHES[id].negativePrompt,
    `CALIBRATION_PROMPT_HASH_MISMATCH:${id}`);
  }
  fail(sha(Buffer.from(b009.shot.animationPrompt || '', 'utf8')) === PROMPT_HASHES.ACT1_B009.animationPrompt,
    'CALIBRATION_ANIMATION_PROMPT_HASH_MISMATCH:ACT1_B009');
  fail(Number(b009.beat.durationSec) === 3.8000011444091797 && Math.round(Number(b009.beat.durationSec) * 30) === 114,
    'CALIBRATION_B009_FRAME_COUNT_MISMATCH');
  const stillRequest = (id, operation, row) => {
    const positivePrompt = row.shot.imagePrompt, negativeInstructions = row.shot.negativePrompt;
    const submittedPrompt = serializedFluxPrompt(id, positivePrompt, negativeInstructions);
    const requestKey = deterministicRequestKey({ beatId: id, operation, endpoint: FLUX3_ENDPOINT,
      parameters: { ...FLUX3 }, positivePrompt, prompt: submittedPrompt, negativePrompt: negativeInstructions, stagedIndexSha256 });
    return { beatId: id, operation, endpoint: FLUX3_ENDPOINT, model: 'FLUX 3 Image', parameters: { ...FLUX3 },
      prompt: submittedPrompt, negativePrompt: negativeInstructions,
      positivePrompt, positivePromptSha256: sha(Buffer.from(positivePrompt, 'utf8')),
      negativeInstructions, negativeInstructionsSha256: sha(Buffer.from(negativeInstructions, 'utf8')),
      submittedPrompt, submittedPromptSha256: sha(Buffer.from(submittedPrompt, 'utf8')),
      serializationDelimiter: FLUX_NEGATIVE_PROMPT_DELIMITER, exactlyOneImage: true,
      requestKey, executionStatus: 'PLANNED_ONLY_REQUIRES_SEPARATE_SINGLE_REQUEST_AUTHORIZATION' };
  };
  const b006Still = stillRequest('ACT1_B006', 'GENERATE_STILL', b006);
  const b009Still = stillRequest('ACT1_B009', 'GENERATE_ANIMATION_SOURCE_STILL', b009);
  const provisionalAnimationKey = sha(Buffer.from(JSON.stringify(canonical({
    schemaVersion: 'phase3-calibration-provisional-animation-key/1.0.0', runId, stagedIndexSha256,
    beatId: 'ACT1_B009', operation: 'GENERATE_ANIMATION', endpoint: H3_MAX_ENDPOINT, parameters: H3_MAX,
    prompt: b009.shot.animationPrompt, negativePrompt: b009.shot.negativePrompt,
    sourceStillSha256: 'PENDING_SOURCE_STILL_CREATION_AND_HUMAN_APPROVAL' })), 'utf8'));
  const animation = { beatId: 'ACT1_B009', operation: 'GENERATE_ANIMATION', endpoint: H3_MAX_ENDPOINT,
    model: 'H3 Max Image to Video', parameters: { ...H3_MAX }, canvasAspectRatio: '16:9 inherited from verified source image',
    prompt: b009.shot.animationPrompt, negativePrompt: b009.shot.negativePrompt,
    sourceStill: { beatId: 'ACT1_B009', sha256: null, requiresHashVerifiedHumanApprovedOutput: true },
    requestKey: null, provisionalPlanningRequestKey: provisionalAnimationKey,
    requestKeyDerivation: 'final deterministic key binds the approved source-still SHA-256 and cannot be used until that still exists and is approved',
    rawOutput: { preserveUnchanged: true, inspectAllStreams: true, classification: 'NON_PRODUCTION_DISPOSABLE_CALIBRATION_EVIDENCE',
      productionReady: false },
    derivative: { fps: 30, frames: 114, durationSec: 3.8, videoOnly: true, stripEveryAudioStream: true,
      preserveRawSeparately: true, ffmpegArgs: ['-i', '<raw-provider-output>', '-map', '0:v:0', '-an', '-vf', 'fps=30',
        '-frames:v', '114', '-fps_mode', 'cfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '<fitted-output>'],
      postcondition: 'FFprobe must report exactly one video stream and zero audio streams' },
    executionStatus: 'PLANNED_ONLY_REQUIRES_APPROVED_SOURCE_STILL_AND_SEPARATE_SINGLE_REQUEST_AUTHORIZATION' };
  const blockers = [];
  const approvalOkay = approval?.sha256 === ROUTE_APPROVAL_SHA256
    && approval.record?.bindings?.stagedIndexSha256 === stagedIndexSha256
    && approval.record?.providerExecutionAuthorized === false;
  if (!approvalOkay) blockers.push({ code: 'ROUTE_RESOLUTION_APPROVAL_MISSING_OR_INVALID' });
  if (!controlledSource || controlledConflict) blockers.push({ code: 'ACT1_B005_DEFERRED_DOES_NOT_BLOCK_CALIBRATION',
    detail: 'B005 remains CONTROLLED_STILL and its candidate CLIP/dolly_back fields remain unchanged; no eligible bound source/recipe is present. Defer only B005.' });
  const estimatedCurrent = 2 * OFFICIAL.priceFindings.flux3CurrentUsdPer1kPngImage + 5 * 0.08;
  const estimatedAfterFluxPromotion = 2 * OFFICIAL.priceFindings.flux3AfterPromotionUsdPerImage + 5 * 0.08;
  const estimatedHigh = 2 * OFFICIAL.priceFindings.flux3AfterPromotionUsdPerImage + 5.7 * 0.08;
  assertExposureWithinHumanCeiling(estimatedHigh);
  return { schemaVersion: 'phase3-calibration-route-plan/2.0.0', status: 'PLANNING_ONLY_EXECUTION_UNAUTHORIZED',
    trust: { ...TRUST, stagedIndexSha256 }, permittedBeatIds: BEATS,
    controlledStill: { beatId: 'ACT1_B005', productionMethod: 'CONTROLLED_STILL', providerAllowed: false,
      shotFieldsPreserved: { visualType: controlled.shot.visual?.type || null,
        motionType: controlled.shot.visual?.motionType || null },
      boundSource: controlledSource, status: !controlledSource || controlledConflict ? 'DEFERRED' : 'SOURCE_REQUIRES_SEPARATE_APPROVAL',
      doesNotBlockCalibrationBeats: ['ACT1_B006', 'ACT1_B009'] },
    requests: [b006Still, b009Still, animation],
    sequentialAuthorization: [
      { order: 1, beatId: 'ACT1_B006', operation: 'GENERATE_STILL', nextRequiresHumanApproval: true },
      { order: 2, beatId: 'ACT1_B009', operation: 'GENERATE_ANIMATION_SOURCE_STILL', requiresPriorApproval: 'ACT1_B006 still', nextRequiresHumanApproval: true },
      { order: 3, beatId: 'ACT1_B009', operation: 'GENERATE_ANIMATION', requiresPriorApproval: 'ACT1_B009 source still', finalRequestKeyProvisionalUntilSourceHash: true },
    ],
    animationTiming: { beatId: 'ACT1_B009', sourceDurationSec: b009.beat.durationSec, fps: 30, frameCount: 114,
      fittedDurationSec: 3.8, requestedProviderDurationSec: 5 },
    pricing: { retrievedAt: OFFICIAL.retrievedAt, flux3PerImageUsd: OFFICIAL.priceFindings.flux3CurrentUsdPer1kPngImage,
      flux3AfterPromotionUsd: OFFICIAL.priceFindings.flux3AfterPromotionUsdPerImage,
      h3ListedPromotionalRateUsdPerSecond: 0.02, h3PromotionEnded: '2026-09-14',
      h3ConservativeCurrentRateUsdPer768pSecond: 0.08, h3RequestedSeconds: 5,
      estimates: { currentFluxPromotionAndFiveSecondH3: Number(estimatedCurrent.toFixed(3)),
        afterFluxPromotionAndFiveSecondH3: Number(estimatedAfterFluxPromotion.toFixed(3)),
        conservativeAfterFluxPromotionWithDocumentedPossibleFivePointSevenSecondOutput: Number(estimatedHigh.toFixed(3)) },
      humanAcceptedMaximumExposureUsd: MAX_ACCEPTED_EXPOSURE_USD, providerEnforcedCap: false },
    ownership: { disposition: OWNERSHIP_DISPOSITION, productionUse: false, promotion: false, rendering: false,
      episodeRootWrites: false, noRightsConclusionFromCommercialUseLabel: true },
    routeApproval: { status: approvalOkay ? approval.record.status : 'MISSING_OR_INVALID', sha256: approval?.sha256 || null,
      providerExecutionAuthorized: false, providerRequestsAuthorized: 0 },
    nextAuthorization: nextAuthorizationStep({ approvedOutputs: [], submissions: 0, requestKeys: [] }),
    officialDocumentation: OFFICIAL,
    hardExecutionBlockers: blockers,
    constraints: { maximumProviderSubmissions: 3, retries: 0, fallbackModels: [], duplicateRequestKeys: false,
      executionAuthorization: null, outputClassification: 'NON_PRODUCTION_DISPOSABLE_CALIBRATION',
      productionReadiness: 'REJECTED', humanReviewRequiredAfterEachOutput: true,
      productionUse: false, promotion: false, rendering: false, episodeRootWrites: false,
      providerRequestsAuthorized: 0, acceptedExposureCeilingUsd: MAX_ACCEPTED_EXPOSURE_USD,
      acceptedExposureIsProviderEnforced: false } };
}
function validateH3DerivativeMetadata(metadata = {}) {
  fail(metadata.videoStreamCount === 1 && metadata.audioStreamCount === 0, 'CALIBRATION_DERIVATIVE_MUST_BE_VIDEO_ONLY');
  fail(metadata.fps === 30 && metadata.frameCount === 114, 'CALIBRATION_DERIVATIVE_FRAME_CONTRACT_MISMATCH');
  return true;
}
function nextAuthorizationStep({ approvedOutputs = [], submissions = 0, requestKeys = [], retries = 0,
  fallbackUsed = false, beatId, operation } = {}) {
  fail(Number.isInteger(submissions) && submissions >= 0 && submissions <= 3,
    'CALIBRATION_SUBMISSION_LIMIT_EXCEEDED');
  fail(retries === 0 && fallbackUsed === false, 'CALIBRATION_RETRY_OR_FALLBACK_FORBIDDEN');
  fail(new Set(requestKeys).size === requestKeys.length, 'CALIBRATION_DUPLICATE_REQUEST_KEY');
  fail(new Set(approvedOutputs).size === approvedOutputs.length && approvedOutputs.every(item =>
    ['ACT1_B006/GENERATE_STILL', 'ACT1_B009/GENERATE_ANIMATION_SOURCE_STILL', 'ACT1_B009/GENERATE_ANIMATION'].includes(item)),
  'CALIBRATION_APPROVAL_STATE_INVALID');
  const sequence = ['ACT1_B006/GENERATE_STILL', 'ACT1_B009/GENERATE_ANIMATION_SOURCE_STILL',
    'ACT1_B009/GENERATE_ANIMATION'];
  const next = sequence.find(item => !approvedOutputs.includes(item)) || null;
  fail(submissions === approvedOutputs.length, submissions > approvedOutputs.length
    ? 'CALIBRATION_UNAPPROVED_SUBMISSION_EXISTS' : 'CALIBRATION_SUBMISSION_COUNT_MISMATCH');
  if (beatId !== undefined || operation !== undefined)
    fail(next === `${beatId}/${operation}`, 'CALIBRATION_SEQUENCE_ORDER_VIOLATION');
  return { next, maximumSubmissions: 3, remainingSubmissions: 3 - submissions,
    requiresHumanApprovalOfEachPriorOutput: true, requestKeyReuseAllowed: false, retries: 0, fallback: false };
}
function assertCalibrationOutputNotProduction({ classification, productionUse = false } = {}) {
  fail(classification === 'NON_PRODUCTION_DISPOSABLE_CALIBRATION' && productionUse === false,
    'CALIBRATION_OUTPUT_PRODUCTION_USE_FORBIDDEN');
  return true;
}
function assertExposureWithinHumanCeiling(estimatedUsd) {
  fail(Number.isFinite(estimatedUsd) && estimatedUsd >= 0 && estimatedUsd <= MAX_ACCEPTED_EXPOSURE_USD,
    'CALIBRATION_ACCEPTED_EXPOSURE_EXCEEDED');
  return true;
}
function deriveApprovedAnimationRequestKey({ sourceStillBytes, sourceStillSha256, sourceStillApproved,
  prompt, negativePrompt, stagedIndexSha256 = TRUST.stagedIndexSha256 } = {}) {
  fail(sourceStillApproved === true && Buffer.isBuffer(sourceStillBytes)
    && sha(sourceStillBytes) === sourceStillSha256, 'CALIBRATION_ANIMATION_SOURCE_NOT_APPROVED_OR_HASHED');
  const imageUrl = `data:image/png;base64,${sourceStillBytes.toString('base64')}`;
  return deterministicRequestKey({ beatId: 'ACT1_B009', operation: 'GENERATE_ANIMATION',
    endpoint: H3_MAX_ENDPOINT, parameters: { ...H3_MAX, image_url: imageUrl }, prompt, negativePrompt,
    sourceSha256: sourceStillSha256, stagedIndexSha256 });
}
function buildH3DerivativeFfmpegArgs(inputPath, outputPath) {
  fail(typeof inputPath === 'string' && typeof outputPath === 'string', 'CALIBRATION_DERIVATIVE_PATH_REQUIRED');
  return ['-i', inputPath, '-map', '0:v:0', '-an', '-vf', 'fps=30', '-frames:v', '114', '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath];
}

module.exports = { TRUST, FLUX3_ENDPOINT, H3_MAX_ENDPOINT, FLUX3, H3_MAX, FLUX_NEGATIVE_PROMPT_DELIMITER,
  ROUTE_APPROVAL_SHA256, ROUTE_APPROVAL_PATH, MAX_ACCEPTED_EXPOSURE_USD, OWNERSHIP_DISPOSITION, OFFICIAL,
  BEATS, PROMPT_HASHES, sha, canonical, readRouteApproval, serializedFluxPrompt, deterministicRequestKey,
  makeRoutePlan, validateH3DerivativeMetadata, buildH3DerivativeFfmpegArgs, nextAuthorizationStep,
  assertCalibrationOutputNotProduction, assertExposureWithinHumanCeiling, deriveApprovedAnimationRequestKey };
