'use strict';

// Planning-only calibration route binding for the immutable v5 candidate.
// This module deliberately has no provider client or submission capability.
const crypto = require('node:crypto');

const TRUST = Object.freeze({
  runId: 'phase3-media-execution-v5-20261004-01',
  stagedIndexSha256: '2b9c5f4c65b18d229a7ad158889ec6753811454a410b0b808b6785b8057c92ad',
  outerIndexSha256: 'c50dd2d054c430f0daf5748de9a6d3e5c946cef1e8b4fbe57a4f986f6a48dac4',
  candidateIndexSha256: 'a1981dd4c57a5c10c83fd2e3739d0630006e93e628a72cef3d574d07ef83b4cf',
  censusRecordSha256: 'bcdcd8bd29987aba1519d4ee9b958ae1662f93df81e5c1a057e2b721dde8a63b',
});
const FLUX3_ENDPOINT = 'blackforestlabs/flux-3/text-to-image';
const H3_MAX_ENDPOINT = 'minimax/h3-max/image-to-video';
const FLUX3 = Object.freeze({ resolution: '1k', aspect_ratio: '16:9', output_format: 'png', enable_prompt_expansion: false });
const H3_MAX = Object.freeze({ duration: 5, resolution: '768P', prompt_expansion_mode: 'disabled', enable_safety_checker: true });
const OFFICIAL = Object.freeze({ retrievedAt: '2026-10-04',
  flux3Page: 'https://fal.ai/models/blackforestlabs/flux-3/text-to-image',
  flux3Api: 'https://fal.ai/models/blackforestlabs/flux-3/text-to-image/api',
  h3Page: 'https://fal.ai/models/minimax/h3-max/image-to-video',
  h3Api: 'https://fal.ai/models/minimax/h3-max/image-to-video/api',
  terms: 'https://fal.ai/legal/terms-of-service' });
const BEATS = Object.freeze(['ACT1_B005', 'ACT1_B006', 'ACT1_B009']);
const PROMPT_HASHES = Object.freeze({
  ACT1_B006: Object.freeze({ imagePrompt: 'e1fb18bd4d777cba0f77b47adaacd0da9900251308206985b40d8579e30ef646',
    negativePrompt: '7b426ad5e100c1f34075846fb63c1125aa4eda272cdd99ac8de9a5470bf24c42' }),
  ACT1_B009: Object.freeze({ imagePrompt: '5bd66158c9e8823ebfd25233d86cf2f24a0c3af0ce12bde0669a32599251cacf',
    negativePrompt: '1e07c7c0150f5f29cb5b20bee765e3e8056a4928013cd35771ecefabb078bae9',
    animationPrompt: '5b76ea425eb891f077866a2bd1fd40b44b1bc3e4d1b0ae3d392dc151b8d1348d' }),
});

function fail(condition, code) { if (!condition) throw new Error(code); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
function deterministicRequestKey({ runId = TRUST.runId, beatId, operation, endpoint, parameters,
  prompt, negativePrompt, sourceSha256 = null, stagedIndexSha256 = TRUST.stagedIndexSha256 } = {}) {
  fail(runId === TRUST.runId && BEATS.includes(beatId), 'CALIBRATION_SCOPE_MISMATCH');
  fail(typeof operation === 'string' && typeof endpoint === 'string' && typeof prompt === 'string',
    'CALIBRATION_REQUEST_BINDING_INCOMPLETE');
  const expectedEndpoint = operation === 'GENERATE_STILL' && ['ACT1_B006', 'ACT1_B009'].includes(beatId)
    ? FLUX3_ENDPOINT : operation === 'GENERATE_ANIMATION' && beatId === 'ACT1_B009'
      ? H3_MAX_ENDPOINT : null;
  fail(expectedEndpoint !== null && endpoint === expectedEndpoint, 'CALIBRATION_ENDPOINT_OR_OPERATION_FORBIDDEN');
  if (operation === 'GENERATE_STILL') fail(JSON.stringify(canonical(parameters)) === JSON.stringify(canonical(FLUX3)),
    'CALIBRATION_STILL_PARAMETERS_MISMATCH');
  if (operation === 'GENERATE_ANIMATION') {
    const { image_url: imageUrl, ...fixed } = parameters || {};
    const exactFixed = H3_MAX;
    fail(JSON.stringify(canonical(fixed)) === JSON.stringify(canonical(exactFixed))
      && typeof imageUrl === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(imageUrl)
      && sourceSha256 !== null, 'CALIBRATION_ANIMATION_PARAMETERS_OR_SOURCE_MISMATCH');
  }
  if (sourceSha256 !== null) fail(/^[a-f0-9]{64}$/u.test(sourceSha256), 'CALIBRATION_SOURCE_HASH_INVALID');
  const body = canonical({ schemaVersion: 'phase3-calibration-request-key/1.0.0', runId, beatId, operation,
    modelId: endpoint, endpoint, parameters, prompt, negativePrompt, sourceSha256, stagedIndexSha256 });
  return sha(Buffer.from(JSON.stringify(body), 'utf8'));
}
function makeRoutePlan({ candidate, runId = TRUST.runId, stagedIndexSha256 = TRUST.stagedIndexSha256 } = {}) {
  fail(candidate && typeof candidate === 'object', 'CALIBRATION_CANDIDATE_REQUIRED');
  fail(runId === TRUST.runId, 'CALIBRATION_RUN_ID_MISMATCH');
  fail(stagedIndexSha256 === TRUST.stagedIndexSha256, 'CALIBRATION_STAGED_INDEX_MISMATCH');
  const production = candidate.productionManifest;
  const shots = candidate.shotDefinitions?.allShots;
  const beats = candidate.editPlan?.sequences?.flatMap(item => item.beats || []);
  fail(Array.isArray(production?.shots) && Array.isArray(shots) && Array.isArray(beats),
    'CALIBRATION_CANDIDATE_CONTEXT_INCOMPLETE');
  const find = id => {
    const p = production.shots.find(item => item.shotId === id);
    const s = shots.find(item => item.beatId === id);
    const b = beats.find(item => item.beatId === id);
    fail(p && s && b, `CALIBRATION_BEAT_BINDING_MISSING:${id}`);
    return { production: p, shot: s, beat: b };
  };
  const controlled = find('ACT1_B005');
  fail(controlled.production.productionMethod === 'CONTROLLED_STILL'
    && controlled.production.assetType === 'controlled_image', 'CALIBRATION_B005_METHOD_MISMATCH');
  const controlledIntentConflict = controlled.shot.visual?.type !== 'STILL'
    || controlled.shot.visual?.motionType !== 'static_locked';
  const controlledSource = candidate.controlledStillSources?.ACT1_B005 || null;
  const b006 = find('ACT1_B006'), b009 = find('ACT1_B009');
  fail(b006.production.productionMethod === 'GENERATED_STILL' && b009.production.productionMethod === 'ESSENTIAL_ANIMATION',
    'CALIBRATION_METHOD_MISMATCH');
  for (const [id, row] of [['ACT1_B006', b006], ['ACT1_B009', b009]])
    fail(typeof row.shot.imagePrompt === 'string' && row.shot.imagePrompt.length > 0
      && typeof row.shot.negativePrompt === 'string', `CALIBRATION_PROMPT_BINDING_MISSING:${id}`);
  for (const [id, row] of [['ACT1_B006', b006], ['ACT1_B009', b009]]) {
    fail(sha(Buffer.from(row.shot.imagePrompt, 'utf8')) === PROMPT_HASHES[id].imagePrompt
      && sha(Buffer.from(row.shot.negativePrompt, 'utf8')) === PROMPT_HASHES[id].negativePrompt,
    `CALIBRATION_PROMPT_HASH_MISMATCH:${id}`);
  }
  fail(sha(Buffer.from(b009.shot.animationPrompt || '', 'utf8')) === PROMPT_HASHES.ACT1_B009.animationPrompt,
    'CALIBRATION_ANIMATION_PROMPT_HASH_MISMATCH:ACT1_B009');
  fail(Number(b009.beat.durationSec) === 3.8000011444091797,
    'CALIBRATION_B009_DURATION_MISMATCH');
  const frames = Math.round(Number(b009.beat.durationSec) * 30);
  fail(frames === 114, 'CALIBRATION_B009_FRAME_COUNT_MISMATCH');

  const stillRequest = (id, row) => ({ beatId: id, operation: 'GENERATE_STILL', endpoint: FLUX3_ENDPOINT,
    model: 'FLUX 3 Image', parameters: { ...FLUX3 }, outputPostconditions: { exactlyOneImage: true },
    prompt: row.shot.imagePrompt, negativePrompt: row.shot.negativePrompt,
    requestKey: deterministicRequestKey({ beatId: id, operation: 'GENERATE_STILL', endpoint: FLUX3_ENDPOINT,
      parameters: { ...FLUX3 }, prompt: row.shot.imagePrompt,
      negativePrompt: row.shot.negativePrompt, stagedIndexSha256 }),
    executionStatus: 'BLOCKED_FLUX3_SCHEMA_HAS_NO_NEGATIVE_PROMPT_FIELD' });
  const b006Still = stillRequest('ACT1_B006', b006);
  const b009Still = stillRequest('ACT1_B009', b009);
  const animation = { beatId: 'ACT1_B009', operation: 'GENERATE_ANIMATION', endpoint: H3_MAX_ENDPOINT,
    model: 'H3 Max Image to Video', parameters: { ...H3_MAX },
    canvasAspectRatio: { value: '16:9', source: 'verified source-image canvas; API schema has no aspect_ratio input' },
    prompt: b009.shot.animationPrompt, negativePrompt: b009.shot.negativePrompt,
    sourceStill: { expectedBeatId: 'ACT1_B009', sha256: null, requiredBeforeKeyDerivation: true },
    requestKey: null,
    requestKeyDerivation: 'SHA256(canonical request binding including the verified ACT1_B009 source-still SHA-256)',
    executionStatus: 'BLOCKED_H3_MAX_SCHEMA_DOES_NOT_EXPOSE_AUDIO_DISABLE_PARAMETER',
    rawOutputMustBePreserved: true, derivative: { fps: 30, frames, durationSec: frames / 30,
      operation: 'deterministic trim or hold only after source output metadata review' } };
  const blockers = [];
  if (!controlledSource) blockers.push({ code: 'ACT1_B005_CONTROLLED_SOURCE_UNBOUND',
    detail: 'No exact approved local source path/hash or deterministic construction recipe is present in the indexed candidate.' });
  if (controlledIntentConflict) blockers.push({ code: 'ACT1_B005_CONTROLLED_STILL_VISUAL_CONFLICT',
    detail: `Production manifest requires CONTROLLED_STILL but the indexed shot definition specifies ${controlled.shot.visual?.type || 'no visual type'} with ${controlled.shot.visual?.motionType || 'no motion type'}.` });
  blockers.push({ code: 'FLUX3_NEGATIVE_PROMPT_UNSUPPORTED',
    detail: 'Official FLUX 3 text-to-image input schema has no negative_prompt field; do not omit or rewrite the approved negative prompt.' });
  blockers.push({ code: 'H3_MAX_AUDIO_CANNOT_BE_DISABLED',
    detail: 'Official H3 Max image-to-video schema has no audio-disable input; fal describes audio as generated with video. No-audio output is not guaranteed.' });
  return { schemaVersion: 'phase3-calibration-route-plan/1.0.0', status: 'PLANNING_ONLY_EXECUTION_BLOCKED',
    trust: { ...TRUST, stagedIndexSha256 }, permittedBeatIds: BEATS,
    controlledStill: { beatId: 'ACT1_B005', productionMethod: 'CONTROLLED_STILL', providerAllowed: false,
      sourceRequirement: 'must be a candidate-index-bound approved local source or explicit deterministic construction contract',
      boundSource: controlledSource, shotDefinition: { visualType: controlled.shot.visual?.type || null,
        motionType: controlled.shot.visual?.motionType || null },
      status: controlledSource && !controlledIntentConflict ? 'SOURCE_REQUIRES_VERIFICATION' : 'BLOCKED_CONTRACT_OR_SOURCE' },
    requests: [b006Still, b009Still, animation],
    animationTiming: { beatId: 'ACT1_B009', sourceDurationSec: b009.beat.durationSec, fps: 30,
      frameCount: frames, fittedDurationSec: frames / 30, rawDuration: 'inspect provider output; preserve unchanged' },
    pricing: { retrievedAt: OFFICIAL.retrievedAt, stillUsdPerImageCurrent: 0.024,
      stillUsdPerImageAfterPromo: 0.048, stillPromotionEnds: '2026-10-08',
      h3UsdPerSecondAt768p: 0.08, h3RequestedSeconds: 5, h3BaseEstimateUsd: 0.40,
      h3DocumentedPossibleOutputOvershootSeconds: 0.7, h3OvershootEstimateUsd: 0.456,
      calibrationBaseEstimateUsd: 0.448, calibrationModeledHighEstimateUsdAfterFluxPromo: 0.552,
      providerEnforcedCap: false, acceptedExposureCeilingUsd: null,
      note: 'No provider-enforced cap or human-accepted ceiling is created by this planning record.' },
    rightsAndOwnership: { commercialUseLabelPresentOnModelPages: true,
      outputOwnership: 'UNRESOLVED', noRightsConclusionFromCommercialUseLabel: true,
      termsObservation: 'Terms retain customer ownership of Customer Input but do not explicitly assign Output Content ownership in the reviewed provisions; no rights conclusion inferred.',
      termsUrl: OFFICIAL.terms },
    officialDocumentation: OFFICIAL,
    hardExecutionBlockers: blockers,
    constraints: { maximumCallsForCalibration: 3, retries: 0, fallback: null, executionAuthorization: null,
      outputClassification: 'NON_PRODUCTION_DISPOSABLE_PILOT', humanReviewRequired: true,
      productionReadiness: 'REJECTED_UNTIL_SEPARATE_HUMAN_APPROVAL', promotion: false, rendering: false,
      episodeRootWrites: false, providerRequestsAuthorized: 0 } };
}

module.exports = { TRUST, FLUX3_ENDPOINT, H3_MAX_ENDPOINT, FLUX3, H3_MAX, OFFICIAL, BEATS, PROMPT_HASHES, sha, canonical,
  deterministicRequestKey, makeRoutePlan };
