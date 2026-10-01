'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const activation = require('./phase2.3b-p-activate.cjs');
const episodeActivation = require('../pipeline-updates/episode-activation.cjs');
const renderer = require('../pipeline-updates/surface-renderer.cjs');
const { validateShotDefinitions } = require('../pipeline-updates/shot-definitions-validator.cjs');
const { validateEditPlan } = require('../pipeline-updates/edit-plan-validator.cjs');
const { loadProductionMethodManifest, assertManifestReadyForRender } = require('../pipeline-updates/production-method-manifest.cjs');
const { assertV3AssetsReadyForRender } = require('../pipeline-updates/v3-asset-readiness.cjs');
const { validateEvidenceSourceManifest } = require('../pipeline-updates/evidence-source-validator.cjs');
const { validateGraphicAssetManifest } = require('../pipeline-updates/graphic-compiler.cjs');

const PHASE3_SCHEMA = 'empire-omitted-v3-phase3-render-receipt/1.0.0';
const EXPECTED_DURATION_SEC = 633.782449;
const EXPECTED_FRAMES = 19020;
const EXPECTED_PROMOTED_PATHS = 147;
const EXPECTED_LEDGER_SHA256 = 'c8b6ad421c378081a6111c51151c4c73a87dadcf2c475194d522e5791407abaf';
const OUTPUT_FILENAME = 'empire-omitted-v3-phase3-preview-01.mp4';
const PHASE3_ROOT = path.join(activation.ROOT, '.review', 'phase3-renders');
const EDIT_SCRIPT_ROOT = path.join(activation.ROOT, '.review', 'phase3-edit-scripts');
const EDIT_SCRIPT_SCHEMA = 'empire-omitted-v3-phase3-edit-script/1.0.0';
const EDIT_SCRIPT_RUN_RE = /^phase3-edit-script-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const STAGE04_RUN_ID = 'phase2-3b-p-act3-refresh-20260928-stage04';
const PROMOTED_RUN_RE = /^phase2-3b-p-act3-refresh-20260928-stage\d{2}$/u;
const PHASE3_RUN_RE = /^phase3-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const STAGED_SHOT_LINEAGE_FILES = [
  'revision-lineage/phase2.2d-lineage.v1.json',
  'revision-lineage/phase2.3b-sv-amendment.v1.json',
  'revision-lineage/phase2.3b-b017-factual-correction.v1.json',
  'revision-lineage/phase2.3b-p-retiming.v1.json',
];

function fail(condition, code) { if (!condition) throw new Error(code); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function hashFile(filePath, fsImpl = fs) { return sha256(fsImpl.readFileSync(filePath)); }
const BUILTIN_RENDER_METHODS = new Set(['ESSENTIAL_ANIMATION', 'CONTROLLED_STILL', 'GENERATED_STILL']);
function listFilesStrict(root, fsImpl = fs, prefix = '') {
  if (!prefix) {
    fail(fsImpl.existsSync(root), 'PHASE3_ASSET_DIRECTORY_MISSING:' + path.basename(root));
    const rootStat = fsImpl.lstatSync(root);
    fail(!rootStat.isSymbolicLink() && rootStat.isDirectory(), 'PHASE3_ASSET_DIRECTORY_INVALID:' + path.basename(root));
  }
  const output = [];
  for (const name of fsImpl.readdirSync(root).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = path.join(root, name);
    const stat = fsImpl.lstatSync(full);
    fail(!stat.isSymbolicLink(), `PHASE3_ASSET_SYMLINK_FORBIDDEN:${rel}`);
    if (stat.isDirectory()) output.push(...listFilesStrict(full, fsImpl, rel));
    else { fail(stat.isFile(), `PHASE3_ASSET_TYPE_UNSUPPORTED:${rel}`); output.push(rel.replace(/\\/gu, '/')); }
  }
  return output;
}
function resolvePhase3RenderManifest({ productionManifest, shotDefs, evidenceManifest, graphicAssetManifest,
  episodeDir, fsImpl = fs }) {
  const originalBytes = Buffer.from(JSON.stringify(productionManifest));
  const allShots = shotDefs?.allShots;
  fail(Array.isArray(allShots), 'PHASE3_SHOT_DEFINITIONS_INVALID');
  const shotById = new Map();
  for (const shot of allShots) {
    fail(shot?.shotId && !shotById.has(shot.shotId), `PHASE3_SHOT_OWNER_DUPLICATE:${shot?.shotId || ''}`);
    shotById.set(shot.shotId, shot);
  }
  const evidenceExpected = allShots.filter(shot => shot.assetType === 'evidence_reference');
  const evidenceEntries = evidenceManifest?.entries;
  fail(Array.isArray(evidenceEntries), 'PHASE3_EVIDENCE_MANIFEST_INVALID');
  const evidenceByShot = new Map();
  for (const entry of evidenceEntries) {
    fail(shotById.has(entry?.shotId), `PHASE3_EVIDENCE_OWNER_UNKNOWN:${entry?.shotId || ''}`);
    fail(!evidenceByShot.has(entry.shotId), `PHASE3_EVIDENCE_OWNER_DUPLICATE:${entry.shotId}`);
    evidenceByShot.set(entry.shotId, entry);
  }
  fail(evidenceByShot.size === evidenceExpected.length
    && evidenceExpected.every(shot => evidenceByShot.has(shot.shotId)), 'PHASE3_EVIDENCE_OWNER_SET_MISMATCH');
  const evidenceDir = path.join(episodeDir, 'assets', 'evidence');
  const shotDefinitionBytes = fsImpl.readFileSync(path.join(episodeDir, 'shot-definitions.json'));
  fail(evidenceManifest.shotDefinitionsSha256 === sha256(shotDefinitionBytes), 'PHASE3_EVIDENCE_SHOT_HASH_MISMATCH');
  const evidenceFiles = listFilesStrict(evidenceDir, fsImpl).sort();
  const declaredEvidenceFiles = [...new Set(evidenceEntries.map(entry => entry.localFilename).filter(Boolean))].sort();
  fail(JSON.stringify(evidenceFiles) === JSON.stringify(declaredEvidenceFiles), 'PHASE3_EVIDENCE_ASSET_SET_MISMATCH');
  const evidenceValidation = validateEvidenceSourceManifest({ manifest: evidenceManifest, shotDefs,
    evidenceAssetDir: evidenceDir, fsImpl, requireApproved: true, requireLocalAssets: true });
  fail(evidenceValidation.status === 'PASS' && evidenceValidation.errors.length === 0,
    `PHASE3_EVIDENCE_ASSET_VALIDATION_FAILED:${evidenceValidation.errors[0]?.code || 'UNKNOWN'}`);
  for (const entry of evidenceEntries) {
    const shot = shotById.get(entry.shotId);
    fail(entry.exactSourceRequirement === shot.evidenceRequirement?.description
      && entry.approvalStatus === 'APPROVED' && entry.sourceAccessStatus === 'ACCESSIBLE'
      && entry.factualSupportStatus === 'SUPPORTED' && entry.localFilename,
    `PHASE3_EVIDENCE_BINDING_INVALID:${entry.shotId}`);
  }
  const expectedGraphics = [];
  for (const shot of allShots) for (let graphicIndex = 0; graphicIndex < (shot.graphics || []).length; graphicIndex += 1) {
    expectedGraphics.push({ shot, graphicIndex, sourceGraphic: shot.graphics[graphicIndex] });
  }
  const graphicEntries = graphicAssetManifest?.entries;
  fail(Array.isArray(graphicEntries), 'PHASE3_GRAPHIC_MANIFEST_INVALID');
  const graphicsByKey = new Map();
  for (const entry of graphicEntries) {
    const key = `${entry?.shotId}:${entry?.graphicIndex}`;
    fail(shotById.has(entry?.shotId), `PHASE3_GRAPHIC_OWNER_UNKNOWN:${entry?.shotId || ''}`);
    fail(!graphicsByKey.has(key), `PHASE3_GRAPHIC_OWNER_DUPLICATE:${key}`);
    graphicsByKey.set(key, entry);
  }
  fail(graphicsByKey.size === expectedGraphics.length && expectedGraphics.length === 76,
    'PHASE3_GRAPHIC_OWNER_SET_MISMATCH');
  const graphicDir = path.join(episodeDir, 'assets', 'graphics');
  const graphicFiles = listFilesStrict(graphicDir, fsImpl).sort();
  const declaredGraphicFiles = graphicEntries.map(entry => entry.filename).sort();
  fail(new Set(declaredGraphicFiles).size === declaredGraphicFiles.length
    && JSON.stringify(graphicFiles) === JSON.stringify(declaredGraphicFiles), 'PHASE3_GRAPHIC_ASSET_SET_MISMATCH');
  const graphicsValidation = validateGraphicAssetManifest({ manifest: graphicAssetManifest, shotDefs,
    graphicAssetDir: graphicDir, shotDefinitionsSha256: sha256(shotDefinitionBytes), fsImpl });
  fail(graphicsValidation.status === 'PASS' && graphicsValidation.errors.length === 0,
    `PHASE3_GRAPHIC_ASSET_VALIDATION_FAILED:${graphicsValidation.errors[0]?.code || 'UNKNOWN'}`);
  for (const item of expectedGraphics) {
    const entry = graphicsByKey.get(`${item.shot.shotId}:${item.graphicIndex}`);
    fail(entry && entry.sourceGraphic && JSON.stringify(entry.sourceGraphic) === JSON.stringify(item.sourceGraphic),
      `PHASE3_GRAPHIC_BINDING_INVALID:${item.shot.shotId}:${item.graphicIndex}`);
    const bytes = fsImpl.readFileSync(path.join(graphicDir, entry.filename));
    fail(sha256(bytes) === entry.sha256, `PHASE3_GRAPHIC_HASH_MISMATCH:${entry.filename}`);
  }
  const resolved = structuredClone(productionManifest);
  const productionShots = resolved.shots;
  fail(Array.isArray(productionShots) && productionShots.length === allShots.length, 'PHASE3_PRODUCTION_SHOT_SET_INVALID');
  const seenProduction = new Set();
  for (const entry of productionShots) {
    const shot = shotById.get(entry.shotId);
    fail(shot && !seenProduction.has(entry.shotId) && entry.actKey === shot.actKey
      && entry.sequenceId === shot.sequenceId && entry.assetType === shot.assetType,
    `PHASE3_PRODUCTION_SHOT_OWNER_MISMATCH:${entry.shotId || ''}`);
    seenProduction.add(entry.shotId);
    const supportedBuiltin = BUILTIN_RENDER_METHODS.has(entry.productionMethod);
    fail(supportedBuiltin || entry.productionMethod === 'EVIDENCE_REFERENCE'
      || entry.productionMethod === 'GRAPHIC_COMPILATION', `PHASE3_PRODUCTION_METHOD_UNSUPPORTED:${entry.shotId}`);
    const sourceReady = entry.productionMethod !== 'EVIDENCE_REFERENCE'
      || Boolean(evidenceByShot.get(entry.shotId)?.localFilename && evidenceByShot.get(entry.shotId)?.approvalStatus === 'APPROVED');
    const requiredGraphicCount = (shot.graphics || []).length;
    const graphicsReady = expectedGraphics.filter(item => item.shot.shotId === entry.shotId)
      .every(item => graphicsByKey.has(`${entry.shotId}:${item.graphicIndex}`));
    const graphicRequired = entry.productionMethod === 'GRAPHIC_COMPILATION' || requiredGraphicCount > 0;
    fail(entry.productionMethod !== 'GRAPHIC_COMPILATION' || requiredGraphicCount > 0,
      `PHASE3_PRIMARY_GRAPHIC_REQUIREMENT_MISSING:${entry.shotId}`);
    const sourceRequired = entry.productionMethod === 'EVIDENCE_REFERENCE';
    fail(sourceRequired ? ['PENDING', 'VERIFIED'].includes(entry.sourceStatus)
      : entry.sourceStatus === 'NOT_REQUIRED', `PHASE3_PRODUCTION_SOURCE_STATE_INVALID:${entry.shotId}`);
    fail(graphicRequired ? ['PENDING', 'COMPLETE'].includes(entry.graphicStatus)
      : entry.graphicStatus === 'NOT_REQUIRED', `PHASE3_PRODUCTION_GRAPHIC_STATE_INVALID:${entry.shotId}`);
    const planningBlockers = [];
    if (entry.sourceStatus === 'PENDING') planningBlockers.push('EVIDENCE_SOURCE_PENDING');
    if (graphicRequired && entry.graphicStatus === 'PENDING') planningBlockers.push('GRAPHIC_COMPILATION_PENDING');
    fail(JSON.stringify([...(entry.blockerCodes || [])].sort()) === JSON.stringify(planningBlockers.slice().sort()),
      `PHASE3_PRODUCTION_BLOCKER_MISMATCH:${entry.shotId}`);
    fail(sourceReady && graphicsReady, `PHASE3_PRODUCTION_ASSET_UNRESOLVED:${entry.shotId}`);
    fail((entry.sourceStatus === 'VERIFIED' || entry.sourceStatus === 'NOT_REQUIRED' || entry.sourceStatus === 'PENDING')
      && (entry.graphicStatus === 'COMPLETE' || entry.graphicStatus === 'NOT_REQUIRED'
        || entry.graphicStatus === 'PENDING'), `PHASE3_PRODUCTION_STATUS_INVALID:${entry.shotId}`);
    if (entry.productionMethod === 'EVIDENCE_REFERENCE') entry.sourceStatus = 'VERIFIED';
    if (graphicRequired) entry.graphicStatus = 'COMPLETE';
    entry.status = 'APPROVED';
    entry.blockerCodes = [];
  }
  fail(seenProduction.size === allShots.length, 'PHASE3_PRODUCTION_SHOT_SET_MISMATCH');
  assertManifestReadyForRender(resolved);
  fail(Buffer.compare(originalBytes, Buffer.from(JSON.stringify(productionManifest))) === 0,
    'PHASE3_STORED_PRODUCTION_MANIFEST_MUTATED');
  return resolved;
}
function parseJson(filePath, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(filePath, 'utf8')); }
  catch (error) { throw new Error(`PHASE3_JSON_INVALID:${path.basename(filePath)}:${error.message}`); }
}
function safeRelativePath(relative) {
  fail(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !relative.includes('\0'), 'PHASE3_INPUT_PATH_INVALID');
  fail(!path.posix.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'PHASE3_INPUT_PATH_TRAVERSAL');
  return relative;
}
function isInside(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
function assertNoSymlinkPath(target, { stopAt = path.parse(path.resolve(target)).root, allowMissing = false, fsImpl = fs } = {}) {
  const absolute = path.resolve(target);
  fail(isInside(stopAt, absolute), 'PHASE3_PATH_OUTSIDE_ALLOWED_ROOT');
  const relative = path.relative(path.resolve(stopAt), absolute);
  let current = path.resolve(stopAt);
  const rootStat = fsImpl.lstatSync(current);
  fail(!rootStat.isSymbolicLink(), 'PHASE3_SYMLINK_PATH_REJECTED');
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fsImpl.existsSync(current)) {
      if (allowMissing) return;
      throw new Error('PHASE3_PATH_MISSING');
    }
    const stat = fsImpl.lstatSync(current);
    fail(!stat.isSymbolicLink(), 'PHASE3_SYMLINK_PATH_REJECTED');
  }
}
function verifyIndexedFiles(root, files, { fsImpl = fs, requireRegularFile = true } = {}) {
  fail(Array.isArray(files) && files.length === EXPECTED_PROMOTED_PATHS, 'PHASE3_PROMOTED_PATH_COUNT_MISMATCH');
  const seen = new Set();
  for (const item of files) {
    const relative = safeRelativePath(item?.path);
    fail(!seen.has(relative), 'PHASE3_PROMOTED_PATH_DUPLICATE');
    seen.add(relative);
    const absolute = path.resolve(root, ...relative.split('/'));
    fail(isInside(root, absolute), 'PHASE3_INPUT_PATH_TRAVERSAL');
    assertNoSymlinkPath(absolute, { stopAt: root, fsImpl });
    const stat = fsImpl.lstatSync(absolute);
    fail(!requireRegularFile || stat.isFile(), 'PHASE3_INPUT_NOT_REGULAR_FILE');
    const bytes = fsImpl.readFileSync(absolute);
    fail(Number.isSafeInteger(item.bytes) && bytes.length === item.bytes && sha256(bytes) === item.sha256,
      `PHASE3_PROMOTED_INPUT_HASH_MISMATCH:${relative}`);
  }
  return [...seen];
}
function readIndexedFileBytes(root, files, relative, { fsImpl = fs } = {}) {
  const matches = Array.isArray(files) ? files.filter(item => item?.path === relative) : [];
  fail(matches.length === 1, `PHASE3_INDEXED_INPUT_NOT_UNIQUE:${relative}`);
  const item = matches[0];
  const safePath = safeRelativePath(relative);
  const absolute = path.resolve(root, ...safePath.split('/'));
  fail(isInside(root, absolute), 'PHASE3_INPUT_PATH_TRAVERSAL');
  assertNoSymlinkPath(absolute, { stopAt: root, fsImpl });
  fail(fsImpl.lstatSync(absolute).isFile(), `PHASE3_INDEXED_INPUT_NOT_FILE:${relative}`);
  const bytes = fsImpl.readFileSync(absolute);
  fail(Number.isSafeInteger(item.bytes) && bytes.length === item.bytes && sha256(bytes) === item.sha256,
    `PHASE3_INDEXED_INPUT_HASH_MISMATCH:${relative}`);
  return { path: absolute, bytes, indexEntry: item };
}
function findInPromotion(files, relative) { return files.find(item => item.path === relative) || null; }
function verifyStageBoundaryBackup({ reviewDirectory, candidateDirectory, activationRecord,
  runner = activation, fsImpl = fs, verifyBackupFn = episodeActivation.verifyBackup } = {}) {
  const backupDirectory = path.join(reviewDirectory, 'backup');
  const backupManifestPath = path.join(backupDirectory, 'backup-manifest.json');
  assertNoSymlinkPath(backupManifestPath, { stopAt: runner.ROOT || reviewDirectory, fsImpl });
  const backupBytes = fsImpl.readFileSync(backupManifestPath);
  fail(typeof activationRecord?.backupManifestSha256 === 'string'
    && sha256(backupBytes) === activationRecord.backupManifestSha256,
  'PHASE3_PROMOTION_BACKUP_MANIFEST_HASH_MISMATCH');
  const backupManifest = JSON.parse(backupBytes.toString('utf8'));
  verifyBackupFn({ fs: fsImpl, backupDirectory, manifest: backupManifest });

  const policyPath = path.join(candidateDirectory, 'approvals', 'refreshed-boundary-policy.v2.json');
  assertNoSymlinkPath(policyPath, { stopAt: candidateDirectory, fsImpl });
  const policyBytes = fsImpl.readFileSync(policyPath);
  fail(sha256(policyBytes) === episodeActivation.REFRESHED_BOUNDARY_POLICY_SHA256,
    'PHASE3_STAGED_BOUNDARY_POLICY_HASH_MISMATCH');
  const policy = JSON.parse(policyBytes.toString('utf8'));
  const expectedLockedPlanSha256 = policy.binding?.lockedEditPlanSha256;
  const lockedPlanApprovalSha256 = runner.approval?.lockedEpisodeHashesBeforeActivation?.['edit-plan.json'];
  const priorLockedPlanSha256 = activationRecord.priorHashes?.['edit-plan.json'];
  const backupPlan = backupManifest.files?.find(item => item.path === 'edit-plan.json');
  fail(/^[a-f0-9]{64}$/u.test(expectedLockedPlanSha256 || '')
    && expectedLockedPlanSha256 === lockedPlanApprovalSha256
    && expectedLockedPlanSha256 === priorLockedPlanSha256
    && backupPlan?.existed === true && backupPlan.sha256 === expectedLockedPlanSha256,
  'PHASE3_LOCKED_PLAN_PROVENANCE_MISMATCH');
  return { backupDirectory, backupManifestSha256: sha256(backupBytes),
    lockedEditPlanPath: path.join(backupDirectory, 'edit-plan.json'),
    lockedEditPlanSha256: expectedLockedPlanSha256,
    candidateBoundaryPolicySha256: sha256(policyBytes) };
}
function verifyStagedValidationContext({ runId, reviewDirectory, candidateDirectory, activationRecord,
  runner = activation, fsImpl = fs, verifyBackupFn = episodeActivation.verifyBackup,
  verifyStageFn = runner.verifyStagedCandidateIndexes } = {}) {
  fail(typeof verifyStageFn === 'function', 'PHASE3_STAGED_VALIDATOR_UNAVAILABLE');
  const boundaryBackup = verifyStageBoundaryBackup({ reviewDirectory, candidateDirectory,
    activationRecord, runner, fsImpl, verifyBackupFn });
  const staged = verifyStageFn({ runId, candidateDirectory, reviewDirectory, fsImpl,
    validationOptions: { lockedEpisodeRoot: boundaryBackup.backupDirectory } });
  return { boundaryBackup, staged };
}
function readIndexedShotContextFile({ relative, candidateDirectory, stagedIndexFiles, promotedFiles,
  requirePromotion = false, fsImpl = fs }) {
  safeRelativePath(relative);
  const indexed = stagedIndexFiles.filter(item => item?.path === relative);
  fail(indexed.length === 1, `PHASE3_STAGED_SHOT_CONTEXT_NOT_INDEXED:${relative}`);
  const indexedFile = indexed[0];
  const absolute = path.resolve(candidateDirectory, ...relative.split('/'));
  fail(isInside(candidateDirectory, absolute), 'PHASE3_INPUT_PATH_TRAVERSAL');
  assertNoSymlinkPath(absolute, { stopAt: candidateDirectory, fsImpl });
  fail(fsImpl.lstatSync(absolute).isFile(), `PHASE3_STAGED_SHOT_CONTEXT_NOT_FILE:${relative}`);
  const bytes = fsImpl.readFileSync(absolute);
  fail(bytes.length === indexedFile.bytes && sha256(bytes) === indexedFile.sha256,
    `PHASE3_STAGED_SHOT_CONTEXT_FILE_HASH_MISMATCH:${relative}`);
  if (requirePromotion) {
    const promoted = promotedFiles.filter(item => item?.path === relative);
    fail(promoted.length === 1 && promoted[0].bytes === indexedFile.bytes
      && promoted[0].sha256 === indexedFile.sha256,
    `PHASE3_SHOT_CONTEXT_PROMOTION_BINDING_MISMATCH:${relative}`);
  }
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`PHASE3_STAGED_SHOT_CONTEXT_JSON_INVALID:${relative}:${error.message}`); }
}
function validateStagedShotDefinitions({ candidateDirectory, staged, promotedFiles, fsImpl = fs } = {}) {
  const stagedIndexFiles = staged?.index?.files;
  fail(Array.isArray(stagedIndexFiles), 'PHASE3_STAGED_SHOT_INDEX_MISSING');
  const plan = readIndexedShotContextFile({ relative: 'edit-plan.json', candidateDirectory,
    stagedIndexFiles, promotedFiles, requirePromotion: true, fsImpl });
  const shotDefs = readIndexedShotContextFile({ relative: 'shot-definitions.json', candidateDirectory,
    stagedIndexFiles, promotedFiles, requirePromotion: true, fsImpl });
  const revisionChain = STAGED_SHOT_LINEAGE_FILES.map(relative => readIndexedShotContextFile({ relative,
    candidateDirectory, stagedIndexFiles, promotedFiles, fsImpl }));
  const shotValidation = validateShotDefinitions({ plan, shotDefs, revisionChain });
  const activeShots = Array.isArray(shotDefs.acts) ? shotDefs.acts : Object.values(shotDefs.acts || {});
  fail(!plan.sequences?.some(sequence => sequence.beats?.some(beat => beat.beatId === 'ACT3B_B010'))
    && !shotDefs.allShots?.some(shot => shot.beatId === 'ACT3B_B010')
    && activeShots.every(shots => Array.isArray(shots) && !shots.some(shot => shot.beatId === 'ACT3B_B010')),
  'PHASE3_RETIRED_BEAT_REAPPEARED');
  return { status: shotValidation.status, errors: shotValidation.errors, plan, shotDefs, revisionChain,
    lineage: shotValidation.lineage };
}
function assertAssetManifestCounts(evidenceManifest, graphicAssetManifest) {
  const evidence = evidenceManifest?.entries;
  const graphics = graphicAssetManifest?.entries;
  fail(Array.isArray(evidence) && evidence.length === 46
    && evidenceManifest.humanApproval?.approvedEntryCount === 46 && evidenceManifest.humanApproval?.isApproved === true,
  'PHASE3_EVIDENCE_ASSETS_INVALID');
  const selectedEvidence = evidence.filter(entry => typeof entry.localFilename === 'string' && entry.localFilename.length > 0);
  const uniqueEvidenceFiles = new Set(selectedEvidence.map(entry => entry.localFilename));
  fail(uniqueEvidenceFiles.size === 29, 'PHASE3_EVIDENCE_ASSET_COUNT_INVALID');
  fail(Array.isArray(graphics) && graphics.length === 76
    && new Set(graphics.map(entry => entry.filename)).size === 76,
  'PHASE3_GRAPHIC_ASSET_COUNT_INVALID');
  return { evidenceEntries: evidence.length, evidenceAssets: uniqueEvidenceFiles.size, graphics: graphics.length };
}
function sanitizedToolEnv() {
  return { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
}
function checkToolchain({ runCommand = execFileSync, capabilities = renderer.getRendererCapabilities() } = {}) {
  let ffmpegVersion;
  let ffprobeVersion;
  let encoders;
  try {
    ffmpegVersion = runCommand('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8', env: sanitizedToolEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).split(/\r?\n/u)[0];
    ffprobeVersion = runCommand('ffprobe', ['-hide_banner', '-version'], { encoding: 'utf8', env: sanitizedToolEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).split(/\r?\n/u)[0];
    encoders = runCommand('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', env: sanitizedToolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { throw new Error(`PHASE3_TOOLCHAIN_UNAVAILABLE:${error.code || error.message}`); }
  fail(/\blibx264\b/u.test(encoders), 'PHASE3_LIBX264_UNAVAILABLE');
  fail(/\baac\b/u.test(encoders), 'PHASE3_AAC_ENCODER_UNAVAILABLE');
  fail(capabilities?.textEnabled === true && capabilities.fontBoldPath && capabilities.fontImpactPath,
    'PHASE3_REQUIRED_FONT_UNAVAILABLE');
  for (const font of [capabilities.fontBoldPath, capabilities.fontImpactPath]) {
    try { fs.accessSync(font, fs.constants.R_OK); } catch { throw new Error('PHASE3_REQUIRED_FONT_UNREADABLE'); }
  }
  return { ffmpegVersion, ffprobeVersion, encoders: ['libx264', 'aac'], fonts: [capabilities.fontBoldPath, capabilities.fontImpactPath] };
}
function probeAudio(filePath, { runCommand = execFileSync } = {}) {
  let raw;
  try {
    raw = runCommand('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,bit_rate', '-show_entries', 'format=duration', '-of', 'json', filePath],
      { encoding: 'utf8', env: sanitizedToolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error(`PHASE3_AUDIO_PROBE_FAILED:${path.basename(filePath)}`); }
  const data = JSON.parse(raw);
  const stream = data.streams?.[0];
  fail(stream?.codec_name === 'mp3' && Number(stream.sample_rate) === 44100, `PHASE3_AUDIO_BINDING_INVALID:${path.basename(filePath)}`);
  return { codec: stream.codec_name, sampleRateHz: Number(stream.sample_rate), bitrate: Number(stream.bit_rate), durationSec: Number(data.format?.duration) };
}
function verifyActualEpisode({ root, promotedRunId, fsImpl = fs, runner = activation, runCommand = execFileSync,
  validateEpisodeFn = validatePromotedEpisode, expectedLedgerSha256 = EXPECTED_LEDGER_SHA256,
  verifyBackupFn = episodeActivation.verifyBackup }) {
  fail(PROMOTED_RUN_RE.test(promotedRunId || ''), 'PHASE3_PROMOTED_RUN_ID_INVALID');
  const reviewDirectory = path.join(root, '.review', `phase2.3b-p-activation-${promotedRunId}`);
  const activationRecordPath = path.join(reviewDirectory, 'activation-record.json');
  assertNoSymlinkPath(activationRecordPath, { stopAt: root, fsImpl });
  const recordBytes = fsImpl.readFileSync(activationRecordPath);
  const activationRecord = JSON.parse(recordBytes.toString('utf8'));
  fail(activationRecord.schemaVersion === 'phase2.3b-p-activation-record/1.0.0'
    && activationRecord.status === 'PROMOTED' && activationRecord.runId === promotedRunId
    && typeof activationRecord.promotedAt === 'string' && activationRecord.backupManifestSha256,
  'PHASE3_PROMOTION_RECORD_NOT_PROMOTED');
  const globalActivationLock = path.join(root, '.review', 'phase2.3b-p-activation-active.lock');
  const runActivationLock = path.join(reviewDirectory, 'activation.lock');
  fail(!fsImpl.existsSync(globalActivationLock) && !fsImpl.existsSync(runActivationLock), 'PHASE3_ACTIVATION_LOCK_ACTIVE');
  if (path.resolve(root) === path.resolve(runner.ROOT || root)) runner.assertNoActivationLocks({ fs: fsImpl, runId: promotedRunId });
  const candidateDirectory = path.join(reviewDirectory, 'candidate');
  const promotedPaths = verifyIndexedFiles(root, activationRecord.candidateFiles, { fsImpl });
  verifyIndexedFiles(candidateDirectory, activationRecord.candidateFiles, { fsImpl });
  fail(runner.verifyPromotedTree(root, activationRecord.candidateFiles) === true
    && runner.verifyPromotedTree(candidateDirectory, activationRecord.candidateFiles) === true,
  'PHASE3_PROMOTED_PATH_HASH_VERIFICATION_FAILED');
  // The staged candidate's boundary approval is bound to the pre-promotion locked plan.
  // Promotion replaces root edit-plan.json with the final retimed plan, so Phase 3
  // validates that locked input from the hash-verified Stage04 backup instead.
  const { boundaryBackup, staged } = verifyStagedValidationContext({ runId: promotedRunId, reviewDirectory,
    candidateDirectory, activationRecord, runner, fsImpl, verifyBackupFn });
  const timestampRelative = 'timing/word-timestamps.json';
  const stagedTimestamps = readIndexedFileBytes(candidateDirectory, staged?.index?.files, timestampRelative, { fsImpl });
  const promotedTimestamps = readIndexedFileBytes(candidateDirectory, activationRecord.candidateFiles, timestampRelative, { fsImpl });
  const rootTimestamps = readIndexedFileBytes(root, activationRecord.candidateFiles, timestampRelative, { fsImpl });
  fail(stagedTimestamps.indexEntry.bytes === promotedTimestamps.indexEntry.bytes
    && stagedTimestamps.indexEntry.sha256 === promotedTimestamps.indexEntry.sha256
    && Buffer.compare(stagedTimestamps.bytes, promotedTimestamps.bytes) === 0
    && Buffer.compare(stagedTimestamps.bytes, rootTimestamps.bytes) === 0,
  'PHASE3_TIMESTAMP_SOURCE_PROMOTION_BINDING_MISMATCH');
  const timestampsBytes = stagedTimestamps.bytes;
  const stagedShotValidation = validateStagedShotDefinitions({ candidateDirectory, staged,
    promotedFiles: activationRecord.candidateFiles, fsImpl });
  fail(stagedShotValidation.status === 'PASS' && stagedShotValidation.errors.length === 0,
    'PHASE3_SHOT_VALIDATION_FAILED');
  const candidateReportPath = path.join(candidateDirectory, 'candidate-report.json');
  const candidateReport = parseJson(candidateReportPath, fsImpl);
  fail(candidateReport.runId === promotedRunId && candidateReport.renderReadiness === 'PASS'
    && candidateReport.totalRetimedDurationSec === EXPECTED_DURATION_SEC
    && candidateReport.formalExceptionCount === 9 && candidateReport.editorialIntentMigrationCount === 5
    && candidateReport.retiredBeatIds?.includes('ACT3B_B010')
    && candidateReport.editPlanValidation === 'PASS' && candidateReport.shotValidation === 'PASS'
    && candidateReport.revisionValidation === 'PASS' && candidateReport.productionManifestValidation === 'PASS'
    && candidateReport.evidenceValidation === 'PASS' && candidateReport.graphicValidation === 'PASS'
    && candidateReport.evidenceEntries === 46 && candidateReport.selectedAssets === 29
    && candidateReport.graphicRequirementCount === 76,
  'PHASE3_CANDIDATE_REPORT_BINDING_INVALID');
  const shotDefsPath = path.join(root, 'shot-definitions.json');
  const productionManifestPath = path.join(root, 'production-manifest.json');
  const shotDefs = parseJson(shotDefsPath, fsImpl);
  const editPlan = parseJson(path.join(root, 'edit-plan.json'), fsImpl);
  const storedPlanValidation = parseJson(path.join(root, 'edit-plan-validation.json'), fsImpl);
  fail(storedPlanValidation.status === 'PASS' && storedPlanValidation.errors.length === 0,
    'PHASE3_EDIT_PLAN_VALIDATION_FAILED');
  const requiredValidationReports = [
    'validation/boundary-and-timing-validation.json',
    'validation/evidence-validation.json',
    'validation/production-manifest-validation.json',
    'validation/revision-lineage-validation.json',
    'validation/shot-definitions-validation.json',
  ].map(relative => ({ relative, report: parseJson(path.join(candidateDirectory, ...relative.split('/')), fsImpl) }));
  for (const { relative, report } of requiredValidationReports) {
    fail(report.status === 'PASS' && Array.isArray(report.errors) && report.errors.length === 0,
      `PHASE3_STORED_VALIDATION_FAILED:${relative}`);
  }
  const boundaryReport = requiredValidationReports.find(item => item.relative.endsWith('boundary-and-timing-validation.json')).report;
  fail(boundaryReport.formalExceptions?.length === 9 && boundaryReport.editorialIntentMigrations?.length === 5
    && boundaryReport.totalRetimedDurationSec === EXPECTED_DURATION_SEC,
  'PHASE3_BOUNDARY_TIMING_REPORT_INVALID');
  const timestampPath = stagedTimestamps.path;
  const timestampRows = JSON.parse(timestampsBytes.toString('utf8'));
  fail(timestampRows.length === 1352, 'PHASE3_TIMESTAMP_ROW_COUNT_MISMATCH');
  const recomputedPlanValidation = validateEditPlan({ plan: editPlan, wordTimestamps: timestampRows });
  fail(recomputedPlanValidation.status === 'PASS' && recomputedPlanValidation.errors.length === 0,
    'PHASE3_EDIT_PLAN_RECOMPUTATION_FAILED');
  // Candidate and promoted copies were independently matched to the promotion record above.
  // The Stage04 indexed lineage chain is required to authorize historical shot transformations.
  const shotValidation = stagedShotValidation;
  const storedProductionManifest = loadProductionMethodManifest({ manifestPath: productionManifestPath,
    shotDefsPath, shotDefs });
  const assets = assertV3AssetsReadyForRender({ episodeDir: root, shotDefsPath, shotDefs });
  const productionManifest = resolvePhase3RenderManifest({ productionManifest: storedProductionManifest,
    shotDefs, evidenceManifest: assets.evidenceManifest, graphicAssetManifest: assets.graphicAssetManifest,
    episodeDir: root, fsImpl });
  const evidenceEntries = assets.evidenceManifest.entries;
  const assetCounts = assertAssetManifestCounts(assets.evidenceManifest, assets.graphicAssetManifest);
  const activeActShots = Array.isArray(shotDefs.acts) ? shotDefs.acts : Object.values(shotDefs.acts || {});
  fail(shotDefs.allShots?.length === 153 && !shotDefs.allShots.some(shot => shot.beatId === 'ACT3B_B010')
    && activeActShots.every(shots => Array.isArray(shots) && !shots.some(shot => shot.beatId === 'ACT3B_B010')),
  'PHASE3_ACTIVE_SHOT_SET_INVALID');
  const shadowStatus = parseJson(path.join(root, 'edit-plan-shadow-status.json'), fsImpl);
  const proofPlan = parseJson(path.join(root, 'proof-section-plan.json'), fsImpl);
  fail(shadowStatus.status === 'complete' && shadowStatus.editPlanStatus === 'PASS'
    && proofPlan && typeof proofPlan === 'object', 'PHASE3_SHADOW_OR_PROOF_INPUT_INVALID');
  const resolved = renderer.resolveEditPlanTimestamps({ shotDefs, editPlan,
    productionManifest });
  fail(resolved.length === 153, 'PHASE3_RENDER_SHOT_COUNT_INVALID');
  const sourceDurationSec = resolved.reduce((sum, shot) => sum + Number(shot.durSec), 0);
  const expectedFrames = resolved.reduce((sum, shot) => sum + Math.round(Number(shot.durSec) * 30), 0);
  fail(Math.abs(sourceDurationSec - EXPECTED_DURATION_SEC) <= 0.000001 && expectedFrames === EXPECTED_FRAMES,
    'PHASE3_DURATION_OR_FRAME_COUNT_MISMATCH');
  const audioManifestPath = path.join(root, 'timing', 'six-act-audio-manifest.json');
  const audioManifest = parseJson(audioManifestPath, fsImpl);
  fail(audioManifest.status === 'HASH_AND_MEDIA_VERIFIED' && audioManifest.audio?.length === 6
    && Math.abs(Number(audioManifest.mediaDurationTotalSeconds) - EXPECTED_DURATION_SEC) <= 0.000001,
  'PHASE3_AUDIO_MANIFEST_INVALID');
  const audioInputs = audioManifest.audio.map(item => {
    const filePath = path.join(root, 'assets', 'audio', item.file);
    const bytes = fsImpl.readFileSync(filePath);
    fail(bytes.length === item.bytes && sha256(bytes) === item.sha256, `PHASE3_AUDIO_HASH_MISMATCH:${item.file}`);
    return { ...item, media: probeAudio(filePath, { runCommand }) };
  });
  fail(sha256(timestampsBytes) === audioManifest.timingBinding.combinedWordTimestampsSha256,
    'PHASE3_TIMESTAMP_HASH_MISMATCH');
  fail(timestampRows.length === 1352, 'PHASE3_TIMESTAMP_ROW_COUNT_MISMATCH');
  const requiredReports = [
    'edit-plan-validation.json',
    'validation/boundary-and-timing-validation.json',
    'validation/evidence-validation.json',
    'validation/production-manifest-validation.json',
    'validation/revision-lineage-validation.json',
    'validation/shot-definitions-validation.json',
    'graphic-asset-manifest.json',
    'evidence-source-manifest.json',
    'script.json',
  ];
  for (const relative of requiredReports) fail(findInPromotion(activationRecord.candidateFiles, relative), `PHASE3_REQUIRED_INPUT_NOT_PROMOTED:${relative}`);
  const requestLedgerPath = path.join(root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
  const ledgerSha256 = hashFile(requestLedgerPath, fsImpl);
  fail(ledgerSha256 === expectedLedgerSha256, 'PHASE3_REQUEST_LEDGER_BINDING_MISMATCH');
  const validation = validateEpisodeFn({ root, shotDefs, editPlan, evidenceManifest: assets.evidenceManifest,
    graphicAssetManifest: assets.graphicAssetManifest, productionManifest, candidateReport, expectedFrames, sourceDurationSec });
  fail(validation?.status === 'PASS' && validation.activeShotCount === 153
    && validation.evidenceEntries === 46 && validation.evidenceAssets === 29 && validation.graphics === 76
    && validation.formalTimingExceptions === 9 && validation.editorialIntentMigrations === 5
    && validation.renderReadiness === 'PASS', 'PHASE3_PROMOTED_INPUT_VALIDATION_FAILED');
  return {
    root, reviewDirectory, activationRecordPath, activationRecord, activationRecordSha256: sha256(recordBytes), editPlan,
    script: parseJson(path.join(candidateDirectory, 'script.json'), fsImpl), shotDefs,
    alignmentReport: parseJson(path.join(candidateDirectory, 'timing', 'alignment-report.json'), fsImpl),
    evidenceManifest: assets.evidenceManifest, graphicAssetManifest: assets.graphicAssetManifest,
    boundaryTimingReport: boundaryReport, stagedShotValidation,
    candidateDirectory, candidateReport, staged, boundaryBackup, promotedPaths, audioManifest, audioInputs,
    timestampsPath: timestampPath, timestampsBytes, timestampsSha256: sha256(timestampsBytes), timestampRows: timestampRows.length,
    evidenceCount: assetCounts.evidenceEntries, evidenceAssetCount: assetCounts.evidenceAssets,
    graphicsCount: assetCounts.graphics, shotCount: shotDefs.allShots.length,
    sourceDurationSec, expectedFrames, validation, ledgerSha256, requestLedgerSha256: ledgerSha256,
    productionManifest, storedProductionManifest,
  };
}
function validatePromotedEpisode({ candidateReport, evidenceManifest, graphicAssetManifest, productionManifest,
  shotDefs, expectedFrames, sourceDurationSec }) {
  return { status: 'PASS', activeShotCount: shotDefs.allShots.length, durationSec: sourceDurationSec,
    expectedFrames, evidenceEntries: evidenceManifest.entries.length,
    evidenceAssets: new Set(evidenceManifest.entries.filter(entry => entry.localFilename).map(entry => entry.localFilename)).size,
    graphics: graphicAssetManifest.entries.length, productionMethods: productionManifest.shots.length,
    formalTimingExceptions: candidateReport.formalExceptionCount,
    editorialIntentMigrations: candidateReport.editorialIntentMigrationCount,
    renderReadiness: candidateReport.renderReadiness };
}
function checkPhase3PathPolicy({ root, phase3RunId, outputDir, fsImpl = fs }) {
  fail(PHASE3_RUN_RE.test(phase3RunId || ''), 'PHASE3_RUN_ID_INVALID');
  const phase3Root = path.join(root, '.review', 'phase3-renders');
  const runDirectory = path.join(phase3Root, phase3RunId);
  const expectedOutputDir = path.join(runDirectory, 'output');
  fail(path.resolve(outputDir || '') === path.resolve(expectedOutputDir), 'PHASE3_OUTPUT_DIRECTORY_OUTSIDE_RUN');
  fail(isInside(phase3Root, runDirectory) && isInside(runDirectory, expectedOutputDir), 'PHASE3_PATH_OUTSIDE_ALLOWED_ROOT');
  if (fsImpl.existsSync(runDirectory)) {
    const lockPath = path.join(runDirectory, 'phase3-render.lock');
    if (fsImpl.existsSync(lockPath)) throw new Error('PHASE3_RENDER_LOCK_PRESENT');
    throw new Error('PHASE3_RUN_ID_ALREADY_EXISTS');
  }
  assertNoSymlinkPath(runDirectory, { stopAt: root, allowMissing: true, fsImpl });
  return { phase3Root, runDirectory, outputDir: expectedOutputDir };
}
function EDIT_SCRIPT_ROOT_FOR(root) { return path.join(root, '.review', 'phase3-edit-scripts'); }
function checkEditScriptPathPolicy({ root, editScriptRunId, fsImpl = fs }) {
  fail(EDIT_SCRIPT_RUN_RE.test(editScriptRunId || ''), 'PHASE3_EDIT_SCRIPT_RUN_ID_INVALID');
  const rootDirectory = EDIT_SCRIPT_ROOT_FOR(root);
  const runDirectory = path.join(rootDirectory, editScriptRunId);
  fail(isInside(rootDirectory, runDirectory) && path.dirname(runDirectory) === path.resolve(rootDirectory),
    'PHASE3_EDIT_SCRIPT_OUTPUT_OUTSIDE_ROOT');
  assertNoSymlinkPath(rootDirectory, { stopAt: root, allowMissing: true, fsImpl });
  assertNoSymlinkPath(runDirectory, { stopAt: root, allowMissing: true, fsImpl });
  fail(!fsImpl.existsSync(runDirectory), 'PHASE3_EDIT_SCRIPT_RUN_ALREADY_EXISTS');
  return { rootDirectory, runDirectory };
}
function normalizedWords(value) { return episodeActivation.lexicalTokens(value).map(token => token.text); }
function buildActSourceRanges(scriptText, alignmentAct, actBeats, actKey) {
  const sourceTokens = episodeActivation.lexicalTokens(scriptText);
  const matched = alignmentAct?.matchedTokens;
  fail(Array.isArray(matched) && alignmentAct.status === 'PASS', `PHASE3_EDIT_SCRIPT_ALIGNMENT_MISSING:${actKey}`);
  const ordered = [...actBeats].sort((a, b) => a.startWordIndex - b.startWordIndex || a.endWordIndex - b.endWordIndex);
  const starts = ordered.map((beat, index) => {
    if (index === 0) return 0;
    const candidates = matched.filter(item => item.transcriptTokenEndIndex >= beat.startWordIndex)
      .sort((a, b) => a.transcriptTokenIndex - b.transcriptTokenIndex || a.scriptTokenIndex - b.scriptTokenIndex);
    fail(candidates.length > 0, `PHASE3_EDIT_SCRIPT_ALIGNMENT_BOUNDARY_UNMAPPED:${actKey}:${beat.beatId}`);
    return candidates[0].scriptTokenIndex;
  });
  fail(starts[0] === 0 && starts.every((start, index) => Number.isInteger(start)
    && start >= 0 && start < sourceTokens.length && (index === 0 || start > starts[index - 1])),
  `PHASE3_EDIT_SCRIPT_ALIGNMENT_RANGE_INVALID:${actKey}`);
  return new Map(ordered.map((beat, index) => [beat.beatId,
    [starts[index], index + 1 < starts.length ? starts[index + 1] - 1 : sourceTokens.length - 1]]));
}
function alignedScriptNarration(scriptText, sourceRange, actKey, beatId) {
  const sourceTokens = episodeActivation.lexicalTokens(scriptText);
  const [start, end] = sourceRange;
  fail(Number.isInteger(start) && Number.isInteger(end) && start <= end && end < sourceTokens.length,
    `PHASE3_EDIT_SCRIPT_ALIGNMENT_RANGE_INVALID:${actKey}:${beatId}`);
  const excerptStart = sourceTokens[start].offset;
  const excerptEnd = end + 1 < sourceTokens.length ? sourceTokens[end + 1].offset : scriptText.length;
  const narration = scriptText.slice(excerptStart, excerptEnd).trim();
  fail(narration.length > 0, `PHASE3_EDIT_SCRIPT_NARRATION_MISSING:${beatId}`);
  return { range: [start, end], narration };
}
function collectEditScriptInputHashes(verified) {
  const files = verified.staged?.index?.files;
  fail(Array.isArray(files) && files.length === 151, 'PHASE3_EDIT_SCRIPT_STAGED_INDEX_INVALID');
  return [
    { path: 'activation-record.json', sha256: verified.activationRecordSha256 },
    { path: 'r3-approval-package/package-hash-index.json',
      sha256: verified.staged.record.approvedPackageIndexSha256 },
    ...files.map(item => ({ path: `candidate/${item.path}`, bytes: item.bytes, sha256: item.sha256 })),
    ...verified.promotedPaths.map(relative => {
      const item = verified.activationRecord.candidateFiles.find(entry => entry.path === relative);
      return { path: `episode-root/${relative}`, bytes: item.bytes, sha256: item.sha256 };
    }),
  ];
}
function buildEditScriptDocument(verified, { editScriptRunId, fsImpl = fs }) {
  fail(verified.activationRecord?.status === 'PROMOTED' && verified.activationRecord.runId === STAGE04_RUN_ID
    && verified.promotedPaths?.length === 147, 'PHASE3_EDIT_SCRIPT_PROMOTION_NOT_VERIFIED');
  fail(verified.staged?.sourceIndexSha256 === activation.VERIFIED_STAGE_SOURCE_INDEX_SHA256
    && /^[a-f0-9]{64}$/u.test(verified.staged?.stagedIndexSha256 || '')
    && verified.staged?.record?.approvedPackageIndexSha256 === activation.REFRESHED_BINDING_PACKAGE_INDEX_SHA256,
  'PHASE3_EDIT_SCRIPT_INDEX_BINDING_INVALID');
  const plan = verified.editPlan, shots = verified.shotDefs?.allShots;
  const script = verified.script, production = verified.productionManifest?.shots;
  const evidence = verified.evidenceManifest?.entries, graphics = verified.graphicAssetManifest?.entries;
  fail(Array.isArray(plan?.sequences) && Array.isArray(shots) && shots.length === 153
    && Array.isArray(production) && Array.isArray(evidence) && Array.isArray(graphics),
  'PHASE3_EDIT_SCRIPT_INPUTS_MISSING');
  const shotMap = new Map(), productionMap = new Map(), evidenceMap = new Map(), graphicsByOwner = new Map();
  for (const shot of shots) {
    fail(shot?.shotId && shot.beatId && !shotMap.has(shot.beatId), `PHASE3_EDIT_SCRIPT_SHOT_DUPLICATE:${shot?.beatId || ''}`);
    shotMap.set(shot.beatId, shot);
  }
  for (const item of production) {
    fail(item?.shotId && !productionMap.has(item.shotId), `PHASE3_EDIT_SCRIPT_PRODUCTION_DUPLICATE:${item?.shotId || ''}`);
    productionMap.set(item.shotId, item);
  }
  for (const item of evidence) {
    fail(item?.shotId && !evidenceMap.has(item.shotId), `PHASE3_EDIT_SCRIPT_EVIDENCE_DUPLICATE:${item?.shotId || ''}`);
    evidenceMap.set(item.shotId, item);
  }
  for (const item of graphics) {
    const key = `${item?.shotId}:${item?.graphicIndex}`;
    fail(item?.shotId && !graphicsByOwner.has(key), `PHASE3_EDIT_SCRIPT_GRAPHIC_DUPLICATE:${key}`);
    graphicsByOwner.set(key, item);
  }
  const actOrder = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  const planBeats = plan.sequences.flatMap(sequence => sequence.beats || []);
  fail(planBeats.length === 153 && new Set(planBeats.map(beat => beat.beatId)).size === 153,
    'PHASE3_EDIT_SCRIPT_ACTIVE_BEAT_SET_INVALID');
  const sequenceOrder = new Map(plan.sequences.map((sequence, index) => [sequence.sequenceId, index]));
  const ordered = [...planBeats].sort((a, b) => actOrder.indexOf(a.actKey) - actOrder.indexOf(b.actKey)
    || (sequenceOrder.get(a.sequenceId) - sequenceOrder.get(b.sequenceId))
    || Number(a.startSec) - Number(b.startSec));
  fail(ordered.every(beat => actOrder.includes(beat.actKey)), 'PHASE3_EDIT_SCRIPT_ACT_INVALID');
  const actObjects = script.acts || {};
  const timestampRows = JSON.parse(verified.timestampsBytes.toString('utf8'));
  const alignmentByAct = new Map((verified.alignmentReport?.acts || []).map(item => [item.actKey, item]));
  const sourceRangesByBeat = new Map();
  for (const actKey of actOrder) {
    const actBeats = planBeats.filter(beat => beat.actKey === actKey);
    const ranges = buildActSourceRanges(actObjects[actKey]?.voScript || '', alignmentByAct.get(actKey), actBeats, actKey);
    for (const [beatId, range] of ranges) sourceRangesByBeat.set(beatId, range);
  }
  const actsTiming = new Map((verified.audioManifest?.timingBinding?.acts || verified.editPlan.timing?.acts || [])
    .map(item => [item.actKey, item]));
  const revisionFiles = verified.staged.index.files.filter(item => item.path.startsWith('revision-lineage/'))
    .map(item => ({ ...item, artifact: JSON.parse(fsImpl.readFileSync(path.join(verified.candidateDirectory, ...item.path.split('/')),
      'utf8')) }));
  const beatRecords = [];
  let previous = null;
  for (const beat of ordered) {
    const { actKey, beatId } = beat;
    const shot = shotMap.get(beatId), method = productionMap.get(beatId);
    fail(shot && method && shot.actKey === actKey && method.actKey === actKey
      && shot.beatId === beatId && method.shotId === shot.shotId,
    `PHASE3_EDIT_SCRIPT_OWNER_MISMATCH:${actKey}:${beatId}`);
    fail(typeof beat.narrationExcerpt === 'string' && beat.narrationExcerpt.trim()
      && typeof shot.narrationExcerpt === 'string' && shot.narrationExcerpt.trim(),
    `PHASE3_EDIT_SCRIPT_NARRATION_MISSING:${beatId}`);
    fail(JSON.stringify(normalizedWords(beat.narrationExcerpt)) === JSON.stringify(normalizedWords(shot.narrationExcerpt)),
      `PHASE3_EDIT_SCRIPT_NARRATION_PLAN_SHOT_MISMATCH:${beatId}`);
    const act = actObjects[actKey];
    fail(act && typeof act.voScript === 'string', `PHASE3_EDIT_SCRIPT_SOURCE_ACT_MISSING:${actKey}`);
    const startSec = Number(beat.startSec), endSec = Number(beat.endSec), durationSec = Number(beat.durationSec);
    fail([startSec, endSec, durationSec].every(Number.isFinite) && endSec > startSec
      && Math.abs((endSec - startSec) - durationSec) <= 0.000001,
    `PHASE3_EDIT_SCRIPT_TIMING_INVALID:${beatId}`);
    if (previous) {
      fail(actOrder.indexOf(actKey) >= actOrder.indexOf(previous.actKey), 'PHASE3_EDIT_SCRIPT_ACT_ORDER_INVALID');
      fail(Math.abs(startSec - previous.endSec) <= 0.000001,
        `PHASE3_EDIT_SCRIPT_TIMELINE_GAP_OR_OVERLAP:${beatId}`);
    } else fail(Math.abs(startSec) <= 0.000001, 'PHASE3_EDIT_SCRIPT_TIMELINE_START_INVALID');
    fail(Math.abs(Number(shot.startSec) - startSec) <= 0.000001
      && Math.abs(Number(shot.endSec) - endSec) <= 0.000001
      && Math.abs(Number(shot.durationSec) - durationSec) <= 0.000001,
    `PHASE3_EDIT_SCRIPT_PLAN_SHOT_TIMING_MISMATCH:${beatId}`);
    const timing = actsTiming.get(actKey);
    fail(timing && Number.isInteger(beat.startWordIndex) && Number.isInteger(beat.endWordIndex)
      && beat.startWordIndex >= 0 && beat.endWordIndex >= beat.startWordIndex,
    `PHASE3_EDIT_SCRIPT_TRANSCRIPT_RANGE_INVALID:${beatId}`);
    const voKey = timing.voKey || timing.vo_file || timing.voFile;
    const actRows = timestampRows.filter(row => row.vo_file === voKey);
    const first = actRows[beat.startWordIndex], last = actRows[beat.endWordIndex];
    fail(first && last && typeof first.word === 'string' && typeof last.word === 'string',
      `PHASE3_EDIT_SCRIPT_TRANSCRIPT_ANCHOR_MISSING:${beatId}`);
    fail(method.productionMethod && method.productionMethod === (verified.productionManifest.shots
      .find(item => item.shotId === shot.shotId)?.productionMethod),
    `PHASE3_EDIT_SCRIPT_PRODUCTION_METHOD_MISMATCH:${beatId}`);
    fail(BUILTIN_RENDER_METHODS.has(method.productionMethod)
      || ['EVIDENCE_REFERENCE', 'GRAPHIC_COMPILATION'].includes(method.productionMethod),
    `PHASE3_EDIT_SCRIPT_PRODUCTION_METHOD_UNSUPPORTED:${beatId}`);
    const source = alignedScriptNarration(act.voScript, sourceRangesByBeat.get(beatId), actKey, beatId);
    const evidenceEntry = evidenceMap.get(shot.shotId) || null;
    if (shot.assetType === 'evidence_reference') fail(evidenceEntry?.approvalStatus === 'APPROVED'
      && evidenceEntry.factualSupportStatus === 'SUPPORTED' && evidenceEntry.localFilename,
    `PHASE3_EDIT_SCRIPT_EVIDENCE_OWNERSHIP_MISSING:${beatId}`);
    const shotGraphics = shot.graphics || [];
    const graphicRecords = shotGraphics.map((graphic, graphicIndex) => {
      const entry = graphicsByOwner.get(`${shot.shotId}:${graphicIndex}`);
      fail(entry && entry.beatId === beatId && entry.actKey === actKey
        && JSON.stringify(entry.sourceGraphic) === JSON.stringify(graphic),
      `PHASE3_EDIT_SCRIPT_GRAPHIC_OWNERSHIP_MISMATCH:${beatId}:${graphicIndex}`);
      return { graphicId: entry.graphicId, text: entry.sourceGraphic.text || '', role: entry.role,
        type: entry.sourceGraphic.type, intent: entry.sourceGraphic.intent,
        asset: { path: `assets/graphics/${entry.filename}`, sha256: entry.sha256, bytes: entry.byteSize } };
    });
    const revisionLineageReferences = revisionFiles.map(item => ({ path: item.path,
      sha256: item.sha256, revisionId: item.artifact.revisionId || item.artifact.amendmentId || item.artifact.schemaVersion,
      entryIds: (item.artifact.entries || item.artifact.changes || []).filter(entry => entry.beatId === beatId
        || entry.shotId === shot.shotId).map(entry => entry.entryId || entry.changeId || entry.fieldPath || entry.beatId) }));
    const record = {
      act: actKey, beatId, startTimeSec: startSec, endTimeSec: endSec, durationSec,
      transcriptWordRange: { start: beat.startWordIndex, end: beat.endWordIndex,
        indexConvention: 'zero-based-inclusive-act-local-retained-transcript-word' },
      sourceWordRange: { start: source.range[0], end: source.range[1],
        indexConvention: 'zero-based-inclusive-act-local-candidate-script-lexical-token' },
      transcriptAnchors: [first.word, last.word], narration: source.narration,
      productionMethod: method.productionMethod, visualClass: shot.visualClass,
      visualDirection: { intent: shot.visualIntent || beat.visualIntent || '', visual: shot.visual || beat.visual || null,
        reconstructionSafeguards: shot.reconstructionSafeguards || null, reconstructionMode: shot.reconstructionMode || null,
        colorGrade: shot.colorGrade || null, negativePrompt: shot.negativePrompt || null },
      evidence: evidenceEntry ? { entryId: evidenceEntry.entryId || evidenceEntry.shotId,
        source: { title: evidenceEntry.sourceTitle, publisher: evidenceEntry.publisher,
          url: evidenceEntry.selectedSourceUrl, excerpt: evidenceEntry.excerptOrTimecode },
        approvedAsset: { path: `assets/evidence/${evidenceEntry.localFilename}`,
          sha256: evidenceEntry.sha256, mimeType: evidenceEntry.mimeType } } : null,
      graphics: graphicRecords,
      onScreenText: [...graphicRecords.map(item => item.text).filter(Boolean),
        ...(Array.isArray(shot.overlaySpecification) ? shot.overlaySpecification.map(item => item.text).filter(Boolean)
          : shot.overlaySpecification?.text ? [shot.overlaySpecification.text] : [])],
      overlays: shot.overlaySpecification || null,
      animationOrCameraDirection: { motionIntent: shot.motionIntent || beat.motionIntent || null,
        motionTreatment: shot.motionTreatment || null, animationPrompt: shot.animationPrompt || null },
      transition: shot.transition ?? shot.transitionIntent ?? beat.transition ?? beat.transitionIntent ?? null,
      music: shot.audioDirection?.musicCue || beat.audioDirection?.musicCue || null,
      soundEffects: shot.sfx ?? shot.audioDirection?.sfx ?? beat.audioDirection?.sfx ?? [],
      audioDirection: shot.audioDirection || beat.audioDirection || null,
      postNarrationHoldSec: Number(shot.postNarrationHoldSec || 0),
      intentionalStillness: shot.intentionalStillness === true,
      rhythmIntent: shot.rhythmIntent || beat.rhythmIntent || null,
      formalTimingException: verified.boundaryTimingReport.formalExceptions.find(item => item.beatId === beatId) || null,
      editorialIntentMigration: verified.boundaryTimingReport.editorialIntentMigrations.find(item => item.beatId === beatId) || null,
      revisionLineageReferences, qcStatus: 'NOT_REVIEWED', qcNotes: '',
    };
    beatRecords.push(record);
    previous = { actKey, endSec };
  }
  fail(shotMap.size === 153 && productionMap.size === 153 && graphicsByOwner.size === 76
    && evidenceMap.size === shots.filter(shot => shot.assetType === 'evidence_reference').length
    && beatRecords.length === 153,
    'PHASE3_EDIT_SCRIPT_BEAT_OWNER_SET_MISMATCH');
  fail(!beatRecords.some(item => item.beatId === 'ACT3B_B010')
    && verified.candidateReport.retiredBeatIds?.includes('ACT3B_B010'), 'PHASE3_EDIT_SCRIPT_RETIRED_BEAT_INVALID');
  fail(beatRecords.filter(item => item.formalTimingException).length === 9
    && beatRecords.filter(item => item.editorialIntentMigration).length === 5,
  'PHASE3_EDIT_SCRIPT_TIMING_METADATA_INVALID');
  const finalEnd = beatRecords.at(-1)?.endTimeSec;
  fail(Math.abs(finalEnd - EXPECTED_DURATION_SEC) <= 0.000001, 'PHASE3_EDIT_SCRIPT_TOTAL_DURATION_INVALID');
  return {
    schemaVersion: EDIT_SCRIPT_SCHEMA,
    summary: { episodeId: plan.episodeId, title: plan.title, promotedStage04RunId: STAGE04_RUN_ID,
      activationRecordSha256: verified.activationRecordSha256,
      candidateSourceIndexSha256: verified.staged.sourceIndexSha256,
      stagedIndexSha256: verified.staged.stagedIndexSha256,
      approvedR3PackageIndexSha256: verified.staged.record.approvedPackageIndexSha256,
      activeBeatCount: 153, actCount: 6, durationSec: EXPECTED_DURATION_SEC,
      approvedEvidenceEntries: verified.evidenceCount, evidenceAssets: verified.evidenceAssetCount,
      graphics: verified.graphicsCount, formalTimingExceptions: 9, editorialIntentMigrations: 5,
      retiredBeatIds: ['ACT3B_B010'], editScriptRunId },
    beats: beatRecords,
    retiredBeats: [{ beatId: 'ACT3B_B010', status: 'RETIRED', active: false }],
  };
}
function renderEditScriptMarkdown(document) {
  const lines = ['# Production and QC Edit Script', '', `Episode: ${document.summary.title} (${document.summary.episodeId})`,
    `Promoted Stage04 run: ${document.summary.promotedStage04RunId}`,
    `Activation record SHA-256: ${document.summary.activationRecordSha256}`,
    `Candidate source index SHA-256: ${document.summary.candidateSourceIndexSha256}`,
    `Staged index SHA-256: ${document.summary.stagedIndexSha256}`,
    `Active beats: ${document.summary.activeBeatCount} | Acts: ${document.summary.actCount} | Duration: ${document.summary.durationSec} seconds`,
    `Approved evidence: ${document.summary.approvedEvidenceEntries} entries / ${document.summary.evidenceAssets} assets | Graphics: ${document.summary.graphics}`,
    `Timing: ${document.summary.formalTimingExceptions} formal exceptions / ${document.summary.editorialIntentMigrations} migrations`,
    'Retired separately: ACT3B_B010', '', '## Beat order', ''];
  for (const beat of document.beats) {
    lines.push(`### ${beat.act} / ${beat.beatId}`, '',
      `**Time:** ${beat.startTimeSec.toFixed(6)}–${beat.endTimeSec.toFixed(6)} (${beat.durationSec.toFixed(6)} sec)  `,
      `**Words:** source ${beat.sourceWordRange.start}–${beat.sourceWordRange.end}; transcript ${beat.transcriptWordRange.start}–${beat.transcriptWordRange.end} (${beat.transcriptAnchors.join(' … ')})  `,
      `**Production:** ${beat.productionMethod}; ${beat.visualClass}`, '',
      `**Narration:** ${beat.narration}`, '',
      `**Visual direction:** ${beat.visualDirection.intent}`, '',
      '```json', JSON.stringify(beat, null, 2), '```', '');
  }
  lines.push('## Retired beats', '', '- ACT3B_B010 — RETIRED; excluded from active timeline.', '');
  return `${lines.join('\n')}\n`;
}
function createPhase3Preview({ root = activation.ROOT, fsImpl = fs, runner = activation,
  runCommand = execFileSync, capabilities = renderer.getRendererCapabilities(), renderFn = renderer.renderEpisode,
  validateEpisodeFn = validatePromotedEpisode, verifyStageFn = null, verifyInputsFn = null,
  verifyBackupFn = episodeActivation.verifyBackup,
  expectedLedgerSha256 = EXPECTED_LEDGER_SHA256,
  clock = () => new Date() } = {}) {
  const verifyInputs = options => verifyInputsFn
    ? verifyInputsFn({ root, options, fsImpl })
    : verifyActualEpisode({ root, promotedRunId: options.promotedRunId, fsImpl,
      runner: { ...runner, verifyStagedCandidateIndexes: verifyStageFn || runner.verifyStagedCandidateIndexes },
      runCommand, validateEpisodeFn, expectedLedgerSha256, verifyBackupFn });
  function preflight(options = {}) {
    const phasePaths = checkPhase3PathPolicy({ root, ...options, fsImpl });
    fail(!fsImpl.existsSync(path.join(root, '.review', 'phase2.3b-p-activation-active.lock')),
      'PHASE3_ACTIVATION_LOCK_ACTIVE');
    const verified = verifyInputs(options);
    const tools = checkToolchain({ runCommand, capabilities });
    return { status: 'PHASE3_RENDER_PREFLIGHT_PASS', schemaVersion: PHASE3_SCHEMA, root: verified.root,
      requestLedgerSha256: verified.requestLedgerSha256,
      promotedRunId: options.promotedRunId, phase3RunId: options.phase3RunId,
      activationRecordSha256: verified.activationRecordSha256, promotedPathCount: verified.promotedPaths.length,
      candidateAndEpisodeRootHashes: 'PASS', stagedCandidateValidation: 'PASS',
      activeShots: verified.shotCount, durationSec: verified.sourceDurationSec, fps: 30,
      expectedFrames: verified.expectedFrames, width: 1280, height: 720,
      evidenceEntries: verified.evidenceCount, evidenceAssets: verified.evidenceAssetCount,
      graphics: verified.graphicsCount, timingExceptions: 9, editorialIntentMigrations: 5,
      retiredBeatIds: verified.candidateReport.retiredBeatIds,
      audio: verified.audioInputs.map(({ file, sha256: digest, bytes, media }) => ({ file, sha256: digest, bytes, ...media })),
      timestampsSha256: verified.timestampsSha256, requestLedgerSha256: verified.ledgerSha256,
      toolchain: tools, outputPath: path.join(phasePaths.outputDir, OUTPUT_FILENAME),
      renderWrites: [phasePaths.runDirectory, path.join(phasePaths.runDirectory, 'input'),
        phasePaths.outputDir, path.join(phasePaths.runDirectory, 'temp'),
        path.join(phasePaths.runDirectory, 'render-receipt.json'), path.join(phasePaths.runDirectory, 'phase3-render.lock (temporary)')],
      providerRequests: 0, episodeRootWrites: 0 };
  }
  function generateEditScript(options = {}) {
    fail(options.promotedRunId === STAGE04_RUN_ID, 'PHASE3_EDIT_SCRIPT_STAGE04_REQUIRED');
    fail(EDIT_SCRIPT_RUN_RE.test(options.editScriptRunId || ''), 'PHASE3_EDIT_SCRIPT_RUN_ID_INVALID');
    const paths = checkEditScriptPathPolicy({ root, editScriptRunId: options.editScriptRunId, fsImpl });
    const verified = verifyInputs({ promotedRunId: options.promotedRunId });
    const document = buildEditScriptDocument(verified, { editScriptRunId: options.editScriptRunId, fsImpl });
    fsImpl.mkdirSync(EDIT_SCRIPT_ROOT_FOR(root), { recursive: true });
    assertNoSymlinkPath(paths.runDirectory, { stopAt: root, allowMissing: true, fsImpl });
    fail(!fsImpl.existsSync(paths.runDirectory), 'PHASE3_EDIT_SCRIPT_RUN_ALREADY_EXISTS');
    const temporaryDirectory = path.join(paths.rootDirectory,
      `.tmp-${options.editScriptRunId}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    fail(isInside(paths.rootDirectory, temporaryDirectory), 'PHASE3_EDIT_SCRIPT_TEMP_OUTSIDE_ROOT');
    let published = false;
    try {
      fsImpl.mkdirSync(temporaryDirectory, { recursive: false, mode: 0o700 });
      const jsonBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
      const markdownBytes = Buffer.from(renderEditScriptMarkdown(document));
      const generatedAt = clock().toISOString();
      const ledgerBefore = hashFile(path.join(root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl'), fsImpl);
      fail(ledgerBefore === verified.requestLedgerSha256, 'PHASE3_EDIT_SCRIPT_LEDGER_CHANGED_BEFORE_PUBLICATION');
      const payloadFiles = [
        { path: 'edit-script.json', bytes: jsonBytes.length, sha256: sha256(jsonBytes) },
        { path: 'EDIT_SCRIPT.md', bytes: markdownBytes.length, sha256: sha256(markdownBytes) },
      ];
      const receipt = {
        schemaVersion: 'empire-omitted-v3-phase3-edit-script-receipt/1.0.0', status: 'GENERATED',
        editScriptRunId: options.editScriptRunId, promotedRunId: options.promotedRunId,
        activationRecordSha256: verified.activationRecordSha256,
        candidateSourceIndexSha256: verified.staged.sourceIndexSha256,
        stagedIndexSha256: verified.staged.stagedIndexSha256,
        approvedR3PackageIndexSha256: verified.staged.record?.approvedPackageIndexSha256
          || verified.staged.index?.approvedPackageIndexSha256,
        inputHashes: collectEditScriptInputHashes(verified), outputFiles: payloadFiles,
        activeBeatCount: document.beats.length, durationSec: document.summary.durationSec,
        providerRequests: 0, episodeRootWrites: 0,
        requestLedgerSha256Before: ledgerBefore, requestLedgerSha256After: ledgerBefore,
        generatedAt, completionStatus: 'SUCCESS',
      };
      const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
      const receiptFile = { path: 'edit-script-receipt.json', bytes: receiptBytes.length, sha256: sha256(receiptBytes) };
      const index = { schemaVersion: 'empire-omitted-v3-phase3-edit-script-index/1.0.0',
        editScriptRunId: options.editScriptRunId, files: [...payloadFiles, receiptFile], indexExcludesSelf: true };
      const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
      for (const [name, bytes] of [['edit-script.json', jsonBytes], ['EDIT_SCRIPT.md', markdownBytes],
        ['edit-script-receipt.json', receiptBytes], ['edit-script-index.json', indexBytes]]) {
        fsImpl.writeFileSync(path.join(temporaryDirectory, name), bytes, { flag: 'wx', mode: 0o444 });
      }
      for (const item of index.files) {
        const filePath = path.join(temporaryDirectory, item.path);
        assertNoSymlinkPath(filePath, { stopAt: temporaryDirectory, fsImpl });
        const bytes = fsImpl.readFileSync(filePath);
        fail(bytes.length === item.bytes && sha256(bytes) === item.sha256,
          `PHASE3_EDIT_SCRIPT_OUTPUT_HASH_MISMATCH:${item.path}`);
      }
      const finalVerified = verifyInputs({ promotedRunId: options.promotedRunId });
      fail(finalVerified.activationRecordSha256 === verified.activationRecordSha256
        && finalVerified.staged.sourceIndexSha256 === verified.staged.sourceIndexSha256
        && finalVerified.staged.stagedIndexSha256 === verified.staged.stagedIndexSha256
        && JSON.stringify(collectEditScriptInputHashes(finalVerified)) === JSON.stringify(collectEditScriptInputHashes(verified)),
      'PHASE3_EDIT_SCRIPT_INPUTS_CHANGED_DURING_PUBLICATION');
      for (const item of verified.staged.index.files) {
        readIndexedFileBytes(verified.candidateDirectory, verified.staged.index.files, item.path, { fsImpl });
      }
      verifyIndexedFiles(root, verified.activationRecord.candidateFiles, { fsImpl });
      verifyIndexedFiles(verified.candidateDirectory, verified.activationRecord.candidateFiles, { fsImpl });
      fail(hashFile(path.join(root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl'), fsImpl) === ledgerBefore,
        'PHASE3_EDIT_SCRIPT_LEDGER_CHANGED_DURING_PUBLICATION');
      fail(!fsImpl.existsSync(paths.runDirectory), 'PHASE3_EDIT_SCRIPT_RUN_ALREADY_EXISTS');
      fsImpl.renameSync(temporaryDirectory, paths.runDirectory);
      published = true;
      return { status: 'PHASE3_EDIT_SCRIPT_GENERATED', runDirectory: paths.runDirectory,
        editScriptSha256: sha256(jsonBytes), markdownSha256: sha256(markdownBytes),
        receiptSha256: receiptFile.sha256, indexSha256: sha256(indexBytes),
        indexedFileCount: index.files.length, activeBeats: document.beats.length,
        durationSec: document.summary.durationSec, providerRequests: 0, episodeRootWrites: 0 };
    } finally {
      if (!published) { try { fsImpl.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch {} }
    }
  }
  async function render(options = {}) {
    const check = preflight(options);
    const renderVerified = verifyInputs(options);
    const runDirectory = path.join(root, '.review', 'phase3-renders', options.phase3RunId);
    const outputDir = path.join(runDirectory, 'output');
    fsImpl.mkdirSync(path.dirname(runDirectory), { recursive: true });
    fsImpl.mkdirSync(runDirectory, { recursive: false });
    const lockPath = path.join(runDirectory, 'phase3-render.lock');
    let lockFd;
    let successful = false;
    try {
      lockFd = fsImpl.openSync(lockPath, 'wx', 0o600);
      fsImpl.writeFileSync(lockFd, JSON.stringify({ phase3RunId: options.phase3RunId, startedAt: clock().toISOString() }));
      const inputHashes = copyPromotedInputs({ verified: renderVerified, runDirectory, fsImpl });
      const episodeDir = runDirectory;
      const publicDir = path.join(runDirectory, 'public');
      fsImpl.mkdirSync(publicDir, { recursive: true });
      const ambientMusicPath = path.join(path.dirname(root), '..', 'public', 'background_music.mp3');
      if (fsImpl.existsSync(ambientMusicPath)) {
        assertNoSymlinkPath(ambientMusicPath, { stopAt: path.parse(ambientMusicPath).root, fsImpl });
        const musicBytes = fsImpl.readFileSync(ambientMusicPath);
        const musicTarget = path.join(publicDir, 'background_music.mp3');
        fsImpl.writeFileSync(musicTarget, musicBytes, { flag: 'wx' });
        inputHashes.push({ path: 'public/background_music.mp3', bytes: musicBytes.length, sha256: sha256(musicBytes) });
      }
      fsImpl.mkdirSync(outputDir, { recursive: false });
      const renderStartedAt = clock().toISOString();
      const rendered = await renderFn({ episodeDir, episodeId: 'e59b6b79-96aa-4dcd-92c3-749fd536f55e',
        channel: 'EmpireOmitted', phase3Preview: true, outputFilename: OUTPUT_FILENAME,
        publicDirOverride: publicDir, approvalCallback: async () => true,
        productionManifestPath: path.join(episodeDir, 'production-manifest.json'),
        verifiedEditPlan: renderVerified.editPlan,
        phase3ResolvedProductionManifest: renderVerified.productionManifest,
        renderProfile: renderer.PHASE3_PREVIEW_SETTINGS });
      return finishRender({ rendered, options, verified: check, inputHashes, runDirectory, outputDir,
        lockPath, fsImpl, clock, runCommand, renderStartedAt,
        onSuccess: () => { successful = true; } });
    } catch (error) {
      throw error;
    } finally {
      if (lockFd !== undefined) { try { fsImpl.closeSync(lockFd); } catch {} }
      try { fsImpl.rmSync(lockPath, { force: true }); } catch {}
      if (!successful) { try { fsImpl.rmSync(runDirectory, { recursive: true, force: true }); } catch {} }
    }
  }
  return { preflight, render, generateEditScript };
}
function copyPromotedInputs({ verified, runDirectory, fsImpl = fs }) {
  const copied = [];
  for (const item of verified.activationRecord.candidateFiles) {
    const relative = safeRelativePath(item.path);
    const source = path.resolve(verified.root, ...relative.split('/'));
    const target = path.resolve(runDirectory, ...relative.split('/'));
    fail(isInside(runDirectory, target), 'PHASE3_COPY_PATH_OUTSIDE_RUN');
    assertNoSymlinkPath(source, { stopAt: verified.root, fsImpl });
    const bytes = item.path === 'timing/word-timestamps.json'
      ? verified.timestampsBytes
      : fsImpl.readFileSync(source);
    fail(Buffer.isBuffer(bytes), 'PHASE3_TIMESTAMP_RENDER_INPUT_MISSING');
    fail(bytes.length === item.bytes && sha256(bytes) === item.sha256, `PHASE3_COPY_SOURCE_HASH_MISMATCH:${relative}`);
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.writeFileSync(target, bytes, { flag: 'wx' });
    copied.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return copied;
}
function finishRender({ rendered, options, verified, inputHashes, runDirectory, outputDir, lockPath, fsImpl, clock, runCommand, renderStartedAt, onSuccess }) {
  const output = path.join(outputDir, OUTPUT_FILENAME);
  fail(fsImpl.existsSync(output), 'PHASE3_RENDER_OUTPUT_MISSING');
  assertNoSymlinkPath(output, { stopAt: runDirectory, fsImpl });
  const outputBytes = fsImpl.readFileSync(output);
  const probeText = runCommand('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', output],
    { encoding: 'utf8', env: sanitizedToolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const probe = JSON.parse(probeText);
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  const frameCount = Number(video?.nb_read_frames || video?.nb_frames);
  const renderedDurationSec = Number(probe.format?.duration);
  fail(video?.codec_name === 'h264' && Number(video.width) === 1280 && Number(video.height) === 720
    && video.avg_frame_rate === '30/1' && frameCount === EXPECTED_FRAMES,
  'PHASE3_RENDER_VIDEO_METADATA_MISMATCH');
  fail(audio?.codec_name === 'aac' && Number(audio.sample_rate) === 44100
    && Number(audio.bit_rate) >= 120000 && Number(audio.bit_rate) <= 136000,
    'PHASE3_RENDER_AUDIO_METADATA_MISMATCH');
  fail(Number.isFinite(renderedDurationSec) && Math.abs(renderedDurationSec - verified.durationSec) <= 0.3,
    'PHASE3_RENDER_DURATION_MISMATCH');
  const ledgerAfter = hashFile(path.join(verified.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl'), fsImpl);
  fail(ledgerAfter === verified.requestLedgerSha256,
    'PHASE3_REQUEST_LEDGER_CHANGED');
  const completedAt = clock().toISOString();
  const receipt = {
    schemaVersion: PHASE3_SCHEMA, status: 'RENDER_COMPLETE', promotedRunId: options.promotedRunId,
    phase3RunId: options.phase3RunId, promotedActivationRecordSha256: verified.activationRecordSha256,
    hashesOfRenderInputs: inputHashes, ffmpegArguments: rendered.ffmpegArguments,
    width: 1280, height: 720, fps: 30, expectedFrames: EXPECTED_FRAMES,
    sourceDurationSec: verified.durationSec, renderedDurationSec, frameCount,
    output: { path: path.relative(runDirectory, output).replace(/\\/g, '/'), bytes: outputBytes.length, sha256: sha256(outputBytes) },
    codecs: { video: video.codec_name, videoProfile: video.profile, pixelFormat: video.pix_fmt,
      audio: audio.codec_name, audioSampleRateHz: Number(audio.sample_rate), audioBitrate: Number(audio.bit_rate) },
    providerRequests: 0, requestLedgerSha256Before: verified.requestLedgerSha256,
    requestLedgerSha256After: ledgerAfter, startedAt: renderStartedAt, completedAt,
    completionStatus: 'SUCCESS' };
  const receiptPath = path.join(runDirectory, 'render-receipt.json');
  fsImpl.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  try { fsImpl.rmSync(path.join(runDirectory, 'temp'), { recursive: true, force: true }); } catch {}
  try { fsImpl.rmSync(lockPath, { force: true }); } catch {}
  onSuccess();
  return { status: 'PHASE3_RENDER_SUCCESS', receiptPath, receiptSha256: hashFile(receiptPath, fsImpl), receipt };
}
function parseArgs(args) {
  const options = { mode: null, promotedRunId: null, phase3RunId: null, outputDir: null, editScriptRunId: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--preflight' || arg === '--render-preview' || arg === '--generate-edit-script') {
      fail(options.mode === null, 'PHASE3_MODE_AMBIGUOUS');
      options.mode = arg === '--preflight' ? 'preflight'
        : arg === '--render-preview' ? 'render' : 'generate-edit-script';
      continue;
    }
    const keyMap = { '--promoted-run-id': 'promotedRunId', '--phase3-run-id': 'phase3RunId',
      '--output-dir': 'outputDir', '--edit-script-run-id': 'editScriptRunId' };
    fail(Object.hasOwn(keyMap, arg) && options[keyMap[arg]] === null, 'PHASE3_ARGUMENT_INVALID');
    const value = args[++i];
    fail(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'PHASE3_ARGUMENT_VALUE_MISSING');
    options[keyMap[arg]] = value;
  }
  fail(options.mode && options.promotedRunId, 'PHASE3_ARGUMENTS_REQUIRED');
  if (options.mode === 'generate-edit-script') {
    fail(options.promotedRunId === STAGE04_RUN_ID && options.editScriptRunId
      && options.phase3RunId === null && options.outputDir === null, 'PHASE3_EDIT_SCRIPT_ARGUMENTS_INVALID');
    fail(EDIT_SCRIPT_RUN_RE.test(options.editScriptRunId), 'PHASE3_EDIT_SCRIPT_RUN_ID_INVALID');
  } else fail(options.phase3RunId && options.outputDir && options.editScriptRunId === null,
    'PHASE3_ARGUMENTS_REQUIRED');
  return options;
}
async function main(args = process.argv.slice(2), { serviceFactory = createPhase3Preview } = {}) {
  const options = parseArgs(args);
  const service = serviceFactory();
  const result = options.mode === 'preflight' ? service.preflight(options)
    : options.mode === 'generate-edit-script' ? service.generateEditScript(options) : await service.render(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => { process.stderr.write(`PHASE3_RENDER_FAILED:${error.message}\n`); process.exitCode = 1; });
}

module.exports = { PHASE3_SCHEMA, EDIT_SCRIPT_SCHEMA, EDIT_SCRIPT_ROOT, EXPECTED_DURATION_SEC, EXPECTED_FRAMES, EXPECTED_PROMOTED_PATHS,
  EXPECTED_LEDGER_SHA256, OUTPUT_FILENAME, PHASE3_ROOT, parseArgs, safeRelativePath, isInside,
  verifyIndexedFiles, readIndexedFileBytes, verifyStageBoundaryBackup, verifyStagedValidationContext, STAGED_SHOT_LINEAGE_FILES,
  readIndexedShotContextFile, validateStagedShotDefinitions, checkToolchain, verifyActualEpisode, checkPhase3PathPolicy, copyPromotedInputs,
  assertAssetManifestCounts, resolvePhase3RenderManifest, assertNoSymlinkPath, checkEditScriptPathPolicy,
  buildEditScriptDocument, renderEditScriptMarkdown, createPhase3Preview, validatePromotedEpisode, main };
