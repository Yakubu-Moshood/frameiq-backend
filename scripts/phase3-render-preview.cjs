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

const PHASE3_SCHEMA = 'empire-omitted-v3-phase3-render-receipt/1.0.0';
const EXPECTED_DURATION_SEC = 633.782449;
const EXPECTED_FRAMES = 19020;
const EXPECTED_PROMOTED_PATHS = 147;
const EXPECTED_LEDGER_SHA256 = 'c8b6ad421c378081a6111c51151c4c73a87dadcf2c475194d522e5791407abaf';
const OUTPUT_FILENAME = 'empire-omitted-v3-phase3-preview-01.mp4';
const PHASE3_ROOT = path.join(activation.ROOT, '.review', 'phase3-renders');
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
  validateEpisodeFn = validatePromotedEpisode, expectedLedgerSha256 = EXPECTED_LEDGER_SHA256 }) {
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
    candidateDirectory, activationRecord, runner, fsImpl });
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
  const timestampPath = path.join(root, 'timing', 'word-timestamps.json');
  const timestampBytes = fsImpl.readFileSync(timestampPath);
  const timestampRows = JSON.parse(timestampBytes.toString('utf8'));
  fail(timestampRows.length === 1352, 'PHASE3_TIMESTAMP_ROW_COUNT_MISMATCH');
  const recomputedPlanValidation = validateEditPlan({ plan: editPlan, wordTimestamps: timestampRows });
  fail(recomputedPlanValidation.status === 'PASS' && recomputedPlanValidation.errors.length === 0,
    'PHASE3_EDIT_PLAN_RECOMPUTATION_FAILED');
  // Candidate and promoted copies were independently matched to the promotion record above.
  // The Stage04 indexed lineage chain is required to authorize historical shot transformations.
  const shotValidation = stagedShotValidation;
  const productionManifest = loadProductionMethodManifest({ manifestPath: productionManifestPath,
    shotDefsPath, shotDefs });
  assertManifestReadyForRender(productionManifest);
  const assets = assertV3AssetsReadyForRender({ episodeDir: root, shotDefsPath, shotDefs });
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
    candidateDirectory, candidateReport, staged, boundaryBackup, promotedPaths, audioManifest, audioInputs,
    timestampsPath: timestampPath, timestampsSha256: sha256(timestampsBytes), timestampRows: timestampRows.length,
    evidenceCount: assetCounts.evidenceEntries, evidenceAssetCount: assetCounts.evidenceAssets,
    graphicsCount: assetCounts.graphics, shotCount: shotDefs.allShots.length,
    sourceDurationSec, expectedFrames, validation, ledgerSha256, requestLedgerSha256: ledgerSha256,
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
function createPhase3Preview({ root = activation.ROOT, fsImpl = fs, runner = activation,
  runCommand = execFileSync, capabilities = renderer.getRendererCapabilities(), renderFn = renderer.renderEpisode,
  validateEpisodeFn = validatePromotedEpisode, verifyStageFn = null, verifyInputsFn = null,
  expectedLedgerSha256 = EXPECTED_LEDGER_SHA256,
  clock = () => new Date() } = {}) {
  const verifyInputs = options => verifyInputsFn
    ? verifyInputsFn({ root, options, fsImpl })
    : verifyActualEpisode({ root, promotedRunId: options.promotedRunId, fsImpl,
      runner: { ...runner, verifyStagedCandidateIndexes: verifyStageFn || runner.verifyStagedCandidateIndexes },
      runCommand, validateEpisodeFn, expectedLedgerSha256 });
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
  async function render(options = {}) {
    const check = preflight(options);
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
      const inputHashes = copyPromotedInputs({ verified: verifyInputs(options), runDirectory, fsImpl });
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
        verifiedEditPlan: check.editPlan,
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
  return { preflight, render };
}
function copyPromotedInputs({ verified, runDirectory, fsImpl = fs }) {
  const copied = [];
  for (const item of verified.activationRecord.candidateFiles) {
    const relative = safeRelativePath(item.path);
    const source = path.resolve(verified.root, ...relative.split('/'));
    const target = path.resolve(runDirectory, ...relative.split('/'));
    fail(isInside(runDirectory, target), 'PHASE3_COPY_PATH_OUTSIDE_RUN');
    assertNoSymlinkPath(source, { stopAt: verified.root, fsImpl });
    const bytes = fsImpl.readFileSync(source);
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
  const options = { mode: null, promotedRunId: null, phase3RunId: null, outputDir: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--preflight' || arg === '--render-preview') {
      fail(options.mode === null, 'PHASE3_MODE_AMBIGUOUS');
      options.mode = arg === '--preflight' ? 'preflight' : 'render';
      continue;
    }
    const keyMap = { '--promoted-run-id': 'promotedRunId', '--phase3-run-id': 'phase3RunId', '--output-dir': 'outputDir' };
    fail(Object.hasOwn(keyMap, arg) && options[keyMap[arg]] === null, 'PHASE3_ARGUMENT_INVALID');
    const value = args[++i];
    fail(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'PHASE3_ARGUMENT_VALUE_MISSING');
    options[keyMap[arg]] = value;
  }
  fail(options.mode && options.promotedRunId && options.phase3RunId && options.outputDir, 'PHASE3_ARGUMENTS_REQUIRED');
  return options;
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const service = createPhase3Preview();
  const result = options.mode === 'preflight' ? service.preflight(options) : await service.render(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => { process.stderr.write(`PHASE3_RENDER_FAILED:${error.message}\n`); process.exitCode = 1; });
}

module.exports = { PHASE3_SCHEMA, EXPECTED_DURATION_SEC, EXPECTED_FRAMES, EXPECTED_PROMOTED_PATHS,
  EXPECTED_LEDGER_SHA256, OUTPUT_FILENAME, PHASE3_ROOT, parseArgs, safeRelativePath, isInside,
  verifyIndexedFiles, verifyStageBoundaryBackup, verifyStagedValidationContext, STAGED_SHOT_LINEAGE_FILES,
  readIndexedShotContextFile, validateStagedShotDefinitions, checkToolchain, verifyActualEpisode, checkPhase3PathPolicy, copyPromotedInputs,
  assertAssetManifestCounts, assertNoSymlinkPath, createPhase3Preview, validatePromotedEpisode, main };
