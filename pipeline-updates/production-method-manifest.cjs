'use strict';

const fs = require('fs');
const crypto = require('crypto');

const MANIFEST_VERSION = '1.0.0';
const PRODUCTION_METHODS = Object.freeze([
  'ESSENTIAL_ANIMATION',
  'CONTROLLED_STILL',
  'GENERATED_STILL',
  'EVIDENCE_REFERENCE',
  'GRAPHIC_COMPILATION',
]);
const BASE_IMAGE_METHODS = new Set(['ESSENTIAL_ANIMATION', 'CONTROLLED_STILL', 'GENERATED_STILL']);
const ANIMATION_METHODS = new Set(['ESSENTIAL_ANIMATION']);
const PENDING_CODES = new Set(['EVIDENCE_SOURCE_PENDING', 'GRAPHIC_COMPILATION_PENDING']);
const METHOD_BY_ASSET_TYPE = Object.freeze({
  evidence_reference: new Set(['EVIDENCE_REFERENCE']),
  graphic_compilation: new Set(['GRAPHIC_COMPILATION']),
  generated_image: new Set(['GENERATED_STILL']),
  generated_clip: new Set(['ESSENTIAL_ANIMATION', 'CONTROLLED_STILL']),
  controlled_image: new Set(['CONTROLLED_STILL']),
});
const REQUIRED_ENTRY_FIELDS = new Set([
  'shotId', 'actKey', 'sequenceId', 'visualClass', 'assetType', 'productionMethod', 'status',
  'blockerCodes', 'sourceStatus', 'graphicStatus', 'primaryGraphicAsset', 'overlayGraphicRequirement',
  'graphicObjectCount', 'graphicObjects', 'sourceRequirement',
]);
const REQUIRED_TOP_LEVEL_FIELDS = new Set([
  'manifestVersion', 'mode', 'episodeId', 'candidateSha256', 'sourceEditPlanSha256',
  'totalShots', 'sequenceCount', 'methodCounts', 'graphicSummary', 'baseImageCount',
  'animationCallCount', 'shots',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateProductionMethodManifest({ manifest, shotDefs, candidateSha256 }) {
  const errors = [];
  const fail = (code, detail) => errors.push({ code, detail });
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'FAIL', errors: [{ code: 'MANIFEST_INVALID', detail: 'Manifest must be an object.' }] };
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) fail('MANIFEST_VERSION', `Expected ${MANIFEST_VERSION}.`);
  if (manifest.mode !== 'empire-omitted-v3') fail('MANIFEST_MODE', 'Manifest mode must be empire-omitted-v3.');
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(manifest, field)) fail('MANIFEST_FIELD_MISSING', `Required manifest field ${field} is missing.`);
  }
  for (const field of Object.keys(manifest)) {
    if (!REQUIRED_TOP_LEVEL_FIELDS.has(field)) fail('MANIFEST_FIELD_UNKNOWN', `Unknown manifest field ${field}.`);
  }
  if (!shotDefs || shotDefs.mode !== 'empire-omitted-v3' || !Array.isArray(shotDefs.allShots)) {
    fail('SHOT_DEFINITIONS_INVALID', 'V3 shot definitions with allShots are required.');
  }
  if (candidateSha256 && manifest.candidateSha256 !== candidateSha256) {
    fail('CANDIDATE_HASH_MISMATCH', 'Manifest does not identify the current shot-definitions bytes.');
  }
  if (shotDefs && manifest.episodeId !== shotDefs.episodeId) {
    fail('EPISODE_ID_MISMATCH', 'Manifest episodeId does not match shot definitions.');
  }
  if (shotDefs && manifest.sourceEditPlanSha256 !== shotDefs.sourceEditPlanSha256) {
    fail('SOURCE_PLAN_HASH_MISMATCH', 'Manifest source edit-plan hash does not match shot definitions.');
  }
  const shots = Array.isArray(shotDefs?.allShots) ? shotDefs.allShots : [];
  const entries = Array.isArray(manifest.shots) ? manifest.shots : [];
  if (!Array.isArray(manifest.shots)) fail('MANIFEST_SHOTS_INVALID', 'Manifest shots must be an array.');
  const expectedIds = shots.map(shot => shot.shotId);
  const seenExpected = new Set();
  for (const id of expectedIds) {
    if (!id || seenExpected.has(id)) fail('SHOT_DEFINITIONS_DUPLICATE_ID', `Shot definitions contain duplicate or empty shotId ${id || '(empty)'}.`);
    seenExpected.add(id);
  }
  if (entries.length !== expectedIds.length) fail('SHOT_COUNT_MISMATCH', `Expected ${expectedIds.length} manifest entries; received ${entries.length}.`);
  const expectedById = new Map(shots.map(shot => [shot.shotId, shot]));
  const seenEntries = new Set();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('MANIFEST_ENTRY_INVALID', `Entry ${index} must be an object.`);
      continue;
    }
    for (const field of REQUIRED_ENTRY_FIELDS) if (!Object.prototype.hasOwnProperty.call(entry, field)) fail('ENTRY_FIELD_MISSING', `Entry ${index} is missing ${field}.`);
    for (const field of Object.keys(entry)) if (!REQUIRED_ENTRY_FIELDS.has(field)) fail('ENTRY_FIELD_UNKNOWN', `Entry ${index} has unknown field ${field}.`);
    const id = entry.shotId;
    if (!id || seenEntries.has(id)) fail('MANIFEST_DUPLICATE_ID', `Manifest contains duplicate or empty shotId ${id || '(empty)'}.`);
    seenEntries.add(id);
    if (!expectedById.has(id)) fail('MANIFEST_UNKNOWN_ID', `Manifest contains unknown shotId ${id}.`);
    if (expectedIds[index] !== id) fail('MANIFEST_ORDER_MISMATCH', `Entry ${index} must be ${expectedIds[index] || '(no shot)'}, received ${id || '(empty)'}.`);
    const source = expectedById.get(id);
    if (!source) continue;
    if (!PRODUCTION_METHODS.includes(entry.productionMethod)) {
      fail('PRODUCTION_METHOD_INVALID', `${id}: unsupported production method ${entry.productionMethod}.`);
    } else if (source && !METHOD_BY_ASSET_TYPE[source.assetType]?.has(entry.productionMethod)) {
      fail('PRODUCTION_METHOD_ASSET_MISMATCH', `${id}: ${entry.productionMethod} is incompatible with ${source.assetType}.`);
    }
    if (entry.actKey !== source.actKey) fail('ACT_KEY_MISMATCH', `${id}: manifest actKey must match shot definitions.`);
    if (entry.sequenceId !== source.sequenceId) fail('SEQUENCE_ID_MISMATCH', `${id}: manifest sequenceId must match shot definitions.`);
    if (!['EVIDENCE', 'RECONSTRUCTION', 'EDITORIAL_ILLUSTRATION'].includes(source.visualClass)) fail('VISUAL_CLASS_INVALID', `${id}: unsupported source visualClass ${source.visualClass}.`);
    if (entry.assetType !== source.assetType) fail('ASSET_TYPE_MISMATCH', `${id}: manifest assetType must match shot definitions.`);
    if (entry.visualClass !== source.visualClass) fail('VISUAL_CLASS_MISMATCH', `${id}: manifest visualClass must match shot definitions.`);
    if (source.visualClass === 'EVIDENCE' && entry.productionMethod !== 'EVIDENCE_REFERENCE') fail('SYNTHETIC_EVIDENCE_ROUTE', `${id}: EVIDENCE-class shots must use EVIDENCE_REFERENCE.`);
    if (entry.productionMethod === 'EVIDENCE_REFERENCE' && source.visualClass !== 'EVIDENCE') fail('EVIDENCE_CLASS_MISMATCH', `${id}: EVIDENCE_REFERENCE requires visualClass EVIDENCE.`);
    if (source.assetType === 'graphic_compilation' && entry.productionMethod !== 'GRAPHIC_COMPILATION') fail('SYNTHETIC_GRAPHIC_ROUTE', `${id}: graphic_compilation shots must use GRAPHIC_COMPILATION.`);
    const graphicObjects = Array.isArray(source.graphics) ? source.graphics : [];
    const primaryGraphicAsset = entry.productionMethod === 'GRAPHIC_COMPILATION';
    const overlayGraphicRequirement = graphicObjects.length > 0 && !primaryGraphicAsset;
    if (entry.primaryGraphicAsset !== primaryGraphicAsset) fail('PRIMARY_GRAPHIC_MISMATCH', `${id}: primaryGraphicAsset must reflect its primary production method.`);
    if (entry.overlayGraphicRequirement !== overlayGraphicRequirement) fail('OVERLAY_GRAPHIC_MISMATCH', `${id}: overlayGraphicRequirement does not match plan graphics.`);
    if (entry.graphicObjectCount !== graphicObjects.length) fail('GRAPHIC_COUNT_MISMATCH', `${id}: graphicObjectCount must be ${graphicObjects.length}.`);
    if (!sameJson(entry.graphicObjects, graphicObjects)) fail('GRAPHIC_OBJECT_MISMATCH', `${id}: manifest graphics must exactly match shot definitions.`);
    const expectedSourceRequirement = entry.productionMethod === 'EVIDENCE_REFERENCE'
      ? { evidenceRequirement: source.evidenceRequirement, sourceSearchInstruction: source.sourceSearchInstruction }
      : null;
    if (!sameJson(entry.sourceRequirement, expectedSourceRequirement)) fail('SOURCE_REQUIREMENT_MISMATCH', `${id}: source requirements must exactly match evidence fields in shot definitions.`);
    if (!['APPROVED', 'BLOCKED'].includes(entry.status)) fail('ENTRY_STATUS_INVALID', `${id}: status must be APPROVED or BLOCKED.`);
    const sourceRequired = entry.productionMethod === 'EVIDENCE_REFERENCE';
    const graphicRequired = entry.productionMethod === 'GRAPHIC_COMPILATION' || graphicObjects.length > 0;
    const sourceStates = sourceRequired ? ['PENDING', 'VERIFIED'] : ['NOT_REQUIRED'];
    const graphicStates = graphicRequired ? ['PENDING', 'COMPLETE'] : ['NOT_REQUIRED'];
    if (!sourceStates.includes(entry.sourceStatus)) fail('SOURCE_STATUS_INVALID', `${id}: sourceStatus is inconsistent with its production method.`);
    if (!graphicStates.includes(entry.graphicStatus)) fail('GRAPHIC_STATUS_INVALID', `${id}: graphicStatus is inconsistent with its requirements.`);
    const blockers = Array.isArray(entry.blockerCodes) ? entry.blockerCodes : [];
    if (!Array.isArray(entry.blockerCodes)) fail('BLOCKER_CODES_INVALID', `${id}: blockerCodes must be an array.`);
    for (const code of blockers) if (!PENDING_CODES.has(code)) fail('BLOCKER_CODE_INVALID', `${id}: unsupported blocker ${code}.`);
    if (entry.status === 'APPROVED' && blockers.length) fail('APPROVED_WITH_BLOCKERS', `${id}: approved entries cannot retain blockers.`);
    if (entry.status === 'BLOCKED' && !blockers.length) fail('BLOCKED_WITHOUT_REASON', `${id}: blocked entries require a pending blocker code.`);
    const expectedBlockers = [];
    if (sourceRequired && entry.sourceStatus === 'PENDING') expectedBlockers.push('EVIDENCE_SOURCE_PENDING');
    if (graphicRequired && entry.graphicStatus === 'PENDING') expectedBlockers.push('GRAPHIC_COMPILATION_PENDING');
    if (!sameJson([...blockers].sort(), expectedBlockers.sort())) fail('BLOCKER_STATE_MISMATCH', `${id}: blockerCodes do not match production requirements.`);
    const requiredStatus = expectedBlockers.length ? 'BLOCKED' : 'APPROVED';
    if (entry.status !== requiredStatus) fail('ENTRY_STATUS_MISMATCH', `${id}: status must be ${requiredStatus}.`);
  }
  if (manifest.totalShots !== shots.length || (shotDefs?.totalShots != null && shotDefs.totalShots !== shots.length)) fail('TOTAL_SHOTS_MISMATCH', `totalShots must be ${shots.length} in both manifest and shot definitions.`);
  if (manifest.sequenceCount !== new Set(shots.map(shot => shot.sequenceId)).size) fail('SEQUENCE_COUNT_MISMATCH', 'sequenceCount must match shot definitions.');
  const actualMethodCounts = Object.fromEntries(PRODUCTION_METHODS.map(method => [method, entries.filter(entry => entry?.productionMethod === method).length]));
  if (!sameJson(manifest.methodCounts, actualMethodCounts)) fail('METHOD_COUNTS_MISMATCH', 'methodCounts do not match manifest entries.');
  const actualGraphicSummary = {
    primaryGraphicAssetShots: entries.filter(entry => entry?.productionMethod === 'GRAPHIC_COMPILATION').length,
    overlayGraphicShots: entries.filter(entry => entry?.overlayGraphicRequirement === true).length,
    graphicBearingBeats: entries.filter(entry => entry?.graphicObjectCount > 0).length,
    graphicObjectCount: entries.reduce((sum, entry) => sum + (Number.isInteger(entry?.graphicObjectCount) ? entry.graphicObjectCount : 0), 0),
    multiObjectBeatCount: entries.filter(entry => entry?.graphicObjectCount > 1).length,
  };
  if (!sameJson(manifest.graphicSummary, actualGraphicSummary)) fail('GRAPHIC_SUMMARY_MISMATCH', 'graphicSummary does not match manifest entries.');
  if (manifest.baseImageCount !== entries.filter(entry => BASE_IMAGE_METHODS.has(entry?.productionMethod)).length) fail('BASE_IMAGE_COUNT_MISMATCH', 'baseImageCount does not match entries.');
  if (manifest.animationCallCount !== entries.filter(entry => ANIMATION_METHODS.has(entry?.productionMethod)).length) fail('ANIMATION_COUNT_MISMATCH', 'animationCallCount does not match entries.');
  return errors.length ? { status: 'FAIL', errors } : { status: 'PASS', errors: [] };
}

function loadProductionMethodManifest({ manifestPath, shotDefsPath, shotDefs = null }) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error('[production-manifest] Required V3 production manifest is missing.');
  }
  if (!shotDefsPath || !fs.existsSync(shotDefsPath)) {
    throw new Error('[production-manifest] Current V3 shot-definitions file is missing.');
  }
  const bytes = fs.readFileSync(shotDefsPath);
  const definitions = shotDefs || JSON.parse(bytes.toString('utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const report = validateProductionMethodManifest({ manifest, shotDefs: definitions, candidateSha256: sha256(bytes) });
  if (report.status !== 'PASS') {
    const first = report.errors[0];
    throw new Error(`[production-manifest] ${first.code}: ${first.detail}`);
  }
  return manifest;
}

function baseImageShotIds(manifest) {
  // CONTROLLED_STILL normally supplies the approved base frame for a later
  // animation. A corrected controlled_image is already that final, reviewed
  // raster input and must never enter a synthetic image-provider queue.
  return manifest.shots.filter(entry => BASE_IMAGE_METHODS.has(entry.productionMethod)
    && !(entry.productionMethod === 'CONTROLLED_STILL' && entry.assetType === 'controlled_image'))
    .map(entry => entry.shotId);
}

function essentialAnimationShotIds(manifest) {
  return manifest.shots.filter(entry => ANIMATION_METHODS.has(entry.productionMethod)).map(entry => entry.shotId);
}

function selectShotsByIds(shotDefs, ids) {
  const byId = new Map(shotDefs.allShots.map(shot => [shot.shotId, shot]));
  return ids.map(id => byId.get(id));
}

function validateImagePromptBatch(prompts, manifest) {
  if (!Array.isArray(prompts)) throw new Error('[production-manifest] Image prompts must be an array.');
  const allowedOrder = baseImageShotIds(manifest);
  const allowed = new Set(allowedOrder);
  const entriesById = new Map(manifest.shots.map(entry => [entry.shotId, entry]));
  const seen = new Set();
  let lastIndex = -1;
  for (const item of prompts) {
    const id = item?.shotId;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('[production-manifest] Each image prompt must be an object.');
    if (typeof item.prompt !== 'string' || !item.prompt.trim()) throw new Error(`[production-manifest] Image prompt text is missing for ${id || '(missing shotId)'}.`);
    if (typeof item.negativePrompt !== 'string') throw new Error(`[production-manifest] negativePrompt must be a string for ${id || '(missing shotId)'}.`);
    if (!allowed.has(id)) throw new Error(`[production-manifest] Refusing synthetic image route for ${id || '(missing shotId)'}.`);
    const entry = entriesById.get(id);
    if (item.assetType !== entry.assetType) throw new Error(`[production-manifest] Image prompt assetType mismatch for ${id}.`);
    if (entry.productionMethod === 'CONTROLLED_STILL' && entry.assetType === 'controlled_image') {
      throw new Error(`[production-manifest] Refusing provider generation for controlled raster ${id}.`);
    }
    if (item.requiresGraphicCompilation === true || item.assetType === 'evidence_reference' || item.assetType === 'graphic_compilation') throw new Error(`[production-manifest] Refusing synthetic image route for protected asset ${id}.`);
    if (item.filename !== `${id}.png`) throw new Error(`[production-manifest] Unsafe or mismatched output filename for ${id}.`);
    if (seen.has(id)) throw new Error(`[production-manifest] Duplicate image prompt shotId ${id}.`);
    const index = allowedOrder.indexOf(id);
    if (index <= lastIndex) throw new Error('[production-manifest] Image prompt shot IDs are reordered.');
    seen.add(id);
    lastIndex = index;
  }
  return true;
}

function assertManifestReadyForRender(manifest) {
  const blocked = manifest.shots.filter(entry => entry.status !== 'APPROVED');
  if (blocked.length) {
    const first = blocked[0];
    throw new Error(`[production-manifest] Rendering blocked by ${blocked.length} pending production method(s); first ${first.shotId}: ${first.blockerCodes.join(', ')}.`);
  }
}

function resolveProductionAssetLocation(method) {
  const locations = {
    ESSENTIAL_ANIMATION: { directory: 'clips', extensions: ['.mp4'] },
    CONTROLLED_STILL: { directory: 'stills', extensions: ['.png', '.jpg'] },
    GENERATED_STILL: { directory: 'stills', extensions: ['.png', '.jpg'] },
    EVIDENCE_REFERENCE: { directory: 'evidence', extensions: ['.mp4', '.png', '.jpg'] },
    GRAPHIC_COMPILATION: { directory: 'graphics', extensions: ['.mp4', '.png', '.jpg', '.svg'] },
  };
  return locations[method] || null;
}

function validateControlledStillRasterAsset(filePath, { fsImpl = fs } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('CONTROLLED_STILL_ASSET_PATH_REQUIRED');
  const stat = fsImpl.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 24) throw new Error('CONTROLLED_STILL_ASSET_NOT_REGULAR_FILE');
  const extension = require('node:path').extname(filePath).toLowerCase();
  const bytes = fsImpl.readFileSync(filePath);
  let png = false, jpeg = false, width = null, height = null;
  if (extension === '.png' && bytes.length >= 57
      && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
      && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let offset = 8, sawData = false, sawEnd = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) break;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT' && length > 0) sawData = true;
      offset += length + 12;
      if (type === 'IEND') { sawEnd = length === 0 && offset === bytes.length; break; }
    }
    png = width > 0 && height > 0 && sawData && sawEnd;
  }
  if (extension === '.jpg' && bytes.length >= 16 && bytes[0] === 0xff && bytes[1] === 0xd8
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    let offset = 2;
    while (offset + 4 < bytes.length - 2) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if ([0xd8,0x01,0xd0,0xd1,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7].includes(marker)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
    jpeg = Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;
  }
  if (!png && !jpeg) throw new Error('CONTROLLED_STILL_ASSET_MUST_BE_VALID_RASTER');
  return { status: 'PASS', format: png ? 'png' : 'jpeg', width, height, bytes: stat.size, sha256: sha256(bytes) };
}

module.exports = {
  MANIFEST_VERSION,
  PRODUCTION_METHODS,
  BASE_IMAGE_METHODS,
  ANIMATION_METHODS,
  sha256,
  validateProductionMethodManifest,
  loadProductionMethodManifest,
  baseImageShotIds,
  essentialAnimationShotIds,
  selectShotsByIds,
  validateImagePromptBatch,
  assertManifestReadyForRender,
  resolveProductionAssetLocation,
  validateControlledStillRasterAsset,
};
