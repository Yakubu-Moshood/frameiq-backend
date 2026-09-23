'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateEditPlan } = require('./edit-plan-validator.cjs');
const { validatePersistedProductionFields } = require('./shot-definitions-production-contract.cjs');

const EPSILON = 0.001;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const ACT_ORDER = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
const BEAT_FIELDS = [
  'sequenceId', 'actKey', 'startWordIndex', 'endWordIndex', 'narrationExcerpt',
  'storyFunction', 'visualIntent', 'visualClass', 'visual', 'motionIntent',
  'rhythmIntent', 'graphics', 'audioDirection', 'evidenceRequirement', 'intentionalStillness',
  'timingExceptionReason', 'postNarrationHoldSec', 'reconstructionMode', 'continuityRefs',
];
const SUPPORTED_ASSET_TYPES = new Set(['evidence_reference', 'graphic_compilation', 'generated_image', 'generated_clip']);
const V3_COLOR_GRADES = new Set(['cold_blue', 'gold_warm', 'deep_shadow', 'red_alert', 'neutral', 'desaturated']);

function planFingerprint(plan) {
  const serialized = JSON.stringify(plan);
  return crypto.createHash('sha256').update(serialized === undefined ? 'undefined' : serialized).digest('hex');
}

function flattenPlan(plan) {
  return (Array.isArray(plan?.sequences) ? plan.sequences : []).flatMap(sequence =>
    (Array.isArray(sequence?.beats) ? sequence.beats : []).map(beat => ({ sequence, beat }))
  );
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateShotDefinitions({ plan, shotDefs } = {}) {
  const errors = [];
  const error = (code, location, message) => errors.push({ code, path: location, message });
  const expected = flattenPlan(plan);
  const expectedById = new Map();
  expected.forEach(({ beat }, index) => {
    if (typeof beat?.beatId === 'string' && !expectedById.has(beat.beatId)) expectedById.set(beat.beatId, { beat, index });
  });

  if (!plan || plan.schemaVersion !== '3.1.0' || plan.channel !== 'EmpireOmitted') {
    error('INVALID_EDIT_PLAN', '/plan', 'A schema 3.1.0 Empire Omitted edit plan is required.');
  }
  if (!shotDefs || typeof shotDefs !== 'object' || Array.isArray(shotDefs)) {
    error('INVALID_SHOT_DEFINITIONS', '/', 'Shot definitions must be an object.');
    return { status: 'FAIL', errors };
  }
  if (shotDefs.mode !== 'empire-omitted-v3') error('INVALID_MODE', '/mode', 'V3 shot definitions must declare their contract mode.');
  if (shotDefs.episodeId !== plan?.episodeId) error('EPISODE_ID_MISMATCH', '/episodeId', 'Shot definitions must belong to the edit-plan episode.');
  if (shotDefs.sourceEditPlanSha256 !== planFingerprint(plan)) error('PLAN_FINGERPRINT_MISMATCH', '/sourceEditPlanSha256', 'Shot definitions were not built from the supplied edit plan.');
  if (!Array.isArray(shotDefs.allShots)) error('MISSING_SHOTS', '/allShots', 'allShots must be an ordered array.');
  else if (shotDefs.allShots.length !== expected.length) error('SHOT_COUNT_MISMATCH', '/allShots', `Expected ${expected.length} shot(s), received ${shotDefs.allShots.length}.`);

  const seen = new Set();
  const shots = Array.isArray(shotDefs.allShots) ? shotDefs.allShots : [];
  shots.forEach((shot, index) => {
    const location = `/allShots/${index}`;
    let source = null;
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
      error('INVALID_SHOT', location, 'Each shot must be an object.');
      return;
    }
    if (typeof shot.beatId !== 'string' || !shot.beatId.trim()) error('MISSING_BEAT_ID', `${location}/beatId`, 'A stable beatId is required.');
    else {
      if (!SAFE_ID.test(shot.beatId)) error('UNSAFE_BEAT_ID', `${location}/beatId`, 'beatId must be a safe filename token.');
      if (seen.has(shot.beatId)) error('DUPLICATE_BEAT_ID', `${location}/beatId`, `Duplicate beatId ${shot.beatId}.`);
      seen.add(shot.beatId);
      source = expectedById.get(shot.beatId) || null;
      if (!source) error('UNKNOWN_BEAT_ID', `${location}/beatId`, `beatId ${shot.beatId} is not present in the edit plan.`);
      else {
        if (shot.beatId !== expected[index]?.beat?.beatId) error('BEAT_ORDER', `${location}/beatId`, 'Shots must follow locked edit-plan beat order.');
        if (shot.shotId !== source.beat.beatId) error('SHOT_ID_MISMATCH', `${location}/shotId`, 'shotId must equal its locked beatId.');
        for (const field of BEAT_FIELDS) {
          if (!sameJson(shot[field], source.beat[field])) error('EDITORIAL_FIELD_MISMATCH', `${location}/${field}`, `${field} must be copied unchanged from the edit plan.`);
        }
        for (const field of ['startSec', 'endSec', 'durationSec']) {
          const actual = shot[field], locked = source.beat[field];
          if (!Number.isFinite(actual) || !Number.isFinite(locked) || Math.abs(actual - locked) > EPSILON) {
            error('TIMING_MISMATCH', `${location}/${field}`, `${field} must match the locked beat timing within ${EPSILON} seconds.`);
          }
        }
        if (shot.visualType !== source.beat.visual?.type) error('VISUAL_TYPE_MISMATCH', `${location}/visualType`, 'visualType must match the locked visual type.');
        const hasGraphics = Array.isArray(source.beat.graphics) && source.beat.graphics.length > 0;
        const expectedAssetType = source.beat.visualClass === 'EVIDENCE'
          ? 'evidence_reference'
          : hasGraphics ? 'graphic_compilation'
            : source.beat.visual?.type === 'CLIP' ? 'generated_clip' : 'generated_image';
        if (!SUPPORTED_ASSET_TYPES.has(shot.assetType)) error('UNSUPPORTED_ASSET_TYPE', `${location}/assetType`, `Unsupported asset type ${String(shot.assetType)}.`);
        else if (shot.assetType !== expectedAssetType) error('ASSET_TYPE_MISMATCH', `${location}/assetType`, `Expected ${expectedAssetType} for this locked visual class and type.`);
        if (!sameJson(shot.overlaySpecification, source.beat.graphics)) error('OVERLAY_MISMATCH', `${location}/overlaySpecification`, 'Overlay specification must preserve locked graphics.');
        if (shot.requiresGraphicCompilation !== hasGraphics) error('GRAPHIC_COMPILATION_MISMATCH', `${location}/requiresGraphicCompilation`, 'Graphic compilation flag must match whether the locked plan has graphics.');
        if (!sameJson(shot.motionTreatment, source.beat.motionIntent)) error('MOTION_MISMATCH', `${location}/motionTreatment`, 'Motion treatment must preserve locked motion intent.');
      }
    }

    if (shot.assetType === 'evidence_reference') {
      if (typeof shot.sourceSearchInstruction !== 'string' || !shot.sourceSearchInstruction.trim()) error('UNRESOLVED_PRODUCTION_INTENT', `${location}/sourceSearchInstruction`, 'EVIDENCE needs a concrete source-search instruction.');
      if (shot.imagePrompt !== null) error('EVIDENCE_IMAGE_PROMPT', `${location}/imagePrompt`, 'EVIDENCE must not be routed to synthetic image generation.');
      if (shot.reconstructionSafeguards !== null) error('UNEXPECTED_RECONSTRUCTION_SAFEGUARDS', `${location}/reconstructionSafeguards`, 'EVIDENCE cannot carry reconstruction instructions.');
    } else if (shot.assetType === 'graphic_compilation') {
      if (shot.imagePrompt !== null) error('GRAPHIC_IMAGE_PROMPT', `${location}/imagePrompt`, 'Plan-native graphics must not be converted into image-generation prompts.');
      if (shot.sourceSearchInstruction !== null) error('UNEXPECTED_SOURCE_SEARCH', `${location}/sourceSearchInstruction`, 'Only EVIDENCE may carry a source-search instruction.');
      if (shot.reconstructionSafeguards !== null && source?.beat?.visualClass !== 'RECONSTRUCTION') error('UNEXPECTED_RECONSTRUCTION_SAFEGUARDS', `${location}/reconstructionSafeguards`, 'Only RECONSTRUCTION may carry reconstruction safeguards.');
      if (source?.beat?.visualClass === 'RECONSTRUCTION' && (typeof shot.reconstructionSafeguards !== 'string' || !shot.reconstructionSafeguards.trim())) error('UNRESOLVED_PRODUCTION_INTENT', `${location}/reconstructionSafeguards`, 'RECONSTRUCTION needs explicit safeguards.');
    } else {
      if (typeof shot.imagePrompt !== 'string' || !shot.imagePrompt.trim()) error('UNRESOLVED_PRODUCTION_INTENT', `${location}/imagePrompt`, 'Generated visuals need a nonblank image prompt.');
      if (shot.sourceSearchInstruction !== null) error('UNEXPECTED_SOURCE_SEARCH', `${location}/sourceSearchInstruction`, 'Only EVIDENCE may carry a source-search instruction.');
      if (source?.beat?.visualClass === 'RECONSTRUCTION'
        && (typeof shot.reconstructionSafeguards !== 'string' || !shot.reconstructionSafeguards.trim())) {
        error('UNRESOLVED_PRODUCTION_INTENT', `${location}/reconstructionSafeguards`, 'RECONSTRUCTION needs explicit safeguards.');
      } else if (source?.beat?.visualClass !== 'RECONSTRUCTION' && shot.reconstructionSafeguards !== null) {
        error('UNEXPECTED_RECONSTRUCTION_SAFEGUARDS', `${location}/reconstructionSafeguards`, 'Only RECONSTRUCTION may carry reconstruction safeguards.');
      }
    }
    const productionContract = validatePersistedProductionFields(shot, { sourceBeat: source?.beat });
    for (const item of productionContract.errors) {
      const code = item.message.startsWith('Unknown canonical shot field') ? 'UNKNOWN_PRODUCTION_FIELD'
        : item.field === 'colorGrade' ? 'INVALID_COLOR_GRADE'
          : item.field === 'assetType' ? 'UNSUPPORTED_ASSET_TYPE'
            : 'INVALID_PRODUCTION_FIELD';
      error(code, `${location}/${item.field}`, item.message);
    }
    if (shot.assetType === 'generated_clip' && (typeof shot.animationPrompt !== 'string' || !shot.animationPrompt.trim())) {
      error('UNRESOLVED_PRODUCTION_INTENT', `${location}/animationPrompt`, 'Generated clips need a nonblank motion prompt.');
    }
    if (shot.assetType !== 'generated_clip' && shot.animationPrompt !== '') error('UNEXPECTED_ANIMATION_PROMPT', `${location}/animationPrompt`, 'Only generated clips may carry an animation prompt.');
  });

  for (const { beat } of expected) {
    if (typeof beat?.beatId === 'string' && !seen.has(beat.beatId)) error('MISSING_BEAT_ID', '/allShots', `No shot exists for locked beat ${beat.beatId}.`);
  }

  const planActs = new Set((plan?.timing?.acts || []).map(act => act.actKey));
  if (!shotDefs.acts || typeof shotDefs.acts !== 'object' || Array.isArray(shotDefs.acts)) {
    error('MISSING_ACT_SHOTS', '/acts', 'Act-indexed shot arrays are required.');
  } else {
    for (const actKey of planActs) {
      const expectedIds = expected.filter(item => item.beat.actKey === actKey).map(item => item.beat.beatId);
      const actualIds = Array.isArray(shotDefs.acts[actKey]) ? shotDefs.acts[actKey].map(shot => shot?.beatId) : null;
      if (!actualIds || !sameJson(actualIds, expectedIds)) error('ACT_SHOTS_MISMATCH', `/acts/${actKey}`, 'Act shot membership and order must match its edit-plan beats exactly.');
    }
    for (const actKey of Object.keys(shotDefs.acts)) {
      if (!planActs.has(actKey)) error('UNKNOWN_ACT', `/acts/${actKey}`, 'Shot definitions contain an act absent from edit-plan timing.');
    }
  }
  if (shotDefs.totalShots !== expected.length) error('SHOT_COUNT_MISMATCH', '/totalShots', `totalShots must equal ${expected.length}.`);
  return { status: errors.length ? 'FAIL' : 'PASS', errors };
}

function loadValidatedV3Plan({ episodeDir, episodeId } = {}) {
  if (!episodeDir) throw new Error('[shot-defs] V3 requires an episode directory.');
  const readJson = (name, label) => {
    const filePath = path.join(episodeDir, name);
    if (!fs.existsSync(filePath)) throw new Error(`[shot-defs] V3 ${label} is missing: ${filePath}`);
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (error) { throw new Error(`[shot-defs] V3 ${label} is invalid JSON: ${error.message}`); }
  };
  const plan = readJson('edit-plan.json', 'edit-plan.json');
  const validationArtifact = readJson('edit-plan-validation.json', 'edit-plan-validation.json');
  const shadowStatus = readJson('edit-plan-shadow-status.json', 'shadow status');
  if (validationArtifact.status !== 'PASS' || shadowStatus.status !== 'complete' || shadowStatus.editPlanStatus !== 'PASS') {
    throw new Error('[shot-defs] V3 requires a completed shadow run and PASS edit-plan validation.');
  }
  if (plan.channel !== 'EmpireOmitted' || shadowStatus.channel !== 'EmpireOmitted') {
    throw new Error('[shot-defs] V3 edit plan must belong to EmpireOmitted.');
  }
  if (episodeId && (plan.episodeId !== episodeId || shadowStatus.episodeId !== episodeId)) {
    throw new Error('[shot-defs] V3 edit plan episode identity does not match the current job.');
  }
  if (typeof shadowStatus.timingCache !== 'string' || !shadowStatus.timingCache.trim()) {
    throw new Error('[shot-defs] V3 shadow status has no VO timing-cache location.');
  }
  const timingRoot = path.resolve(episodeDir, shadowStatus.timingCache);
  const episodeRoot = path.resolve(episodeDir) + path.sep;
  if (!timingRoot.startsWith(episodeRoot)) throw new Error('[shot-defs] V3 timing-cache path escapes the episode directory.');
  const timingPath = path.join(timingRoot, 'word-timestamps.json');
  if (!fs.existsSync(timingPath)) throw new Error(`[shot-defs] V3 timing cache is missing: ${timingPath}`);
  let wordTimestamps;
  try { wordTimestamps = JSON.parse(fs.readFileSync(timingPath, 'utf8')); }
  catch (error) { throw new Error(`[shot-defs] V3 timing cache is invalid JSON: ${error.message}`); }
  const timingValidation = validateEditPlan({ plan, wordTimestamps });
  if (timingValidation.status !== 'PASS') {
    const first = timingValidation.errors[0];
    throw new Error(`[shot-defs] V3 edit plan failed deterministic validation: ${first.code} ${first.path}`);
  }
  return { editPlan: plan, editPlanValidation: validationArtifact, wordTimestamps };
}

module.exports = { validateShotDefinitions, loadValidatedV3Plan, planFingerprint, flattenPlan, SUPPORTED_ASSET_TYPES };
