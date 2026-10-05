'use strict';

// Isolated, hash-bound intake for the already approved Phase 3 v5 candidate.
// This module stages review inputs only; it has no provider or episode-root
// write path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const activation = require('./episode-activation.cjs');
const evidence = require('./evidence-source-validator.cjs');
const { validateGraphicAssetManifest } = require('./graphic-compiler.cjs');
const phase3Render = require('../scripts/phase3-render-preview.cjs');
const calibrationRoutes = require('./phase3-media-calibration-bundle.cjs');

const OUTER_INDEX_SHA256 = 'c50dd2d054c430f0daf5748de9a6d3e5c946cef1e8b4fbe57a4f986f6a48dac4';
const CANDIDATE_INDEX_SHA256 = 'a1981dd4c57a5c10c83fd2e3739d0630006e93e628a72cef3d574d07ef83b4cf';
const B015_APPROVAL_SHA256 = '2357cd880a238e2c7c88dc923323f1448441622f9a91dbf1eacff8d719a01272';
const B016_DEPENDENCY_SHA256 = '04369fa3829703121309688a6f17766cd35e4f1e99903b185124f7f1fe69f1b4';
const B009_AMENDMENT_SHA256 = 'f6f50f516f89ed9f27724e994e890cde65513747054a40f16360a9dc1eb46ba8';
const B009_APPROVAL_SHA256 = '6d3e88e24a23777baa38da3325d9fb81f833943fb8b2a8eb6b106b2ce27c516f';
const B015_TIMING_APPROVAL_SHA256 = 'ece9be52468fdd5c73882736c28f4c4acb2bed44c7662a9494ef0aeded29a909';
const B016_APPROVAL_SHA256 = 'e33dc2bac466deac2a1807994064d61e64d4189a56fce5f5b60165c2520f2703';
const STAGE04_RUN_ID = 'phase2-3b-p-act3-refresh-20260928-stage04';
const STAGE04_ACTIVATION_SHA256 = 'f60d360c0179c87329d4e6d8be7b39d09da7ccc9d6c2351645fa2d8a4062923d';
const REQUEST_LEDGER_SHA256 = 'c8b6ad421c378081a6111c51151c4c73a87dadcf2c475194d522e5791407abaf';
const RUN_RE = /^phase3-media-execution-v5-[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/u;
const EXPECTED_METHODS = Object.freeze({ CONTROLLED_STILL: 34, GENERATED_STILL: 8, ESSENTIAL_ANIMATION: 23 });
const ACT_ORDER = Object.freeze(['act1', 'act2', 'act3', 'act3b', 'act4', 'act5']);
const CALIBRATION_AUTHORIZATION_SCHEMA = 'phase3-media-calibration-execution-authorization/1.0.0';
const CALIBRATION_LEDGER_SCHEMA = 'phase3-media-calibration-request-ledger/1.0.0';
const CALIBRATION_RESULT_SCHEMA = 'phase3-media-calibration-generation-result/1.0.0';
const CALIBRATION_RECEIPT_SCHEMA = 'phase3-media-calibration-generation-receipt/1.0.0';
const CALIBRATION_RUN_ID = 'phase3-media-execution-v5-20261004-01';
const CALIBRATION_BEAT_ID = 'ACT1_B006';
const CALIBRATION_OPERATION = 'GENERATE_STILL';
const CALIBRATION_ENDPOINT = 'blackforestlabs/flux-3/text-to-image';
const CALIBRATION_REQUEST_KEY = 'c05d73bed54a10ddd74e79c7b8d4f8c493ad1e6b601a723dd1a733ebbe950fd9';
const CALIBRATION_POSITIVE_PROMPT_SHA256 = 'e1fb18bd4d777cba0f77b47adaacd0da9900251308206985b40d8579e30ef646';
const CALIBRATION_NEGATIVE_INSTRUCTIONS_SHA256 = '7b426ad5e100c1f34075846fb63c1125aa4eda272cdd99ac8de9a5470bf24c42';
const CALIBRATION_SERIALIZED_PROMPT_SHA256 = '1dbe49da404a881bb3763465ecac7d5997a8780e469e55727809805a3096a28e';
const CALIBRATION_ASSET_CLASS = 'NON_PRODUCTION_DISPOSABLE_CALIBRATION';
const CALIBRATION_OWNERSHIP_DISPOSITION = 'UNRESOLVED_ACCEPTED_FOR_NONPRODUCTION_CALIBRATION_ONLY';
const CALIBRATION_MAX_EXPOSURE_USD = 0.05;
const CALIBRATION_AUTHORIZATION_STATEMENT = `Yakubu Moshood authorizes exactly one non-production disposable calibration submission for ${CALIBRATION_BEAT_ID} ${CALIBRATION_OPERATION} on run ${CALIBRATION_RUN_ID} using ${CALIBRATION_ENDPOINT} and request key ${CALIBRATION_REQUEST_KEY}; maximum human-accepted exposure is USD 0.05 and is not provider-enforced. No retries, fallback, other beats, other operations, production use, rendering, promotion, or episode-root writes are authorized.`;
const CALIBRATION_FILES = Object.freeze({
  authorization: 'ACT1_B006/execution-authorization.v1.json',
  ledger: 'ACT1_B006/calibration-request-ledger.jsonl',
  lock: 'ACT1_B006/calibration.lock',
  output: 'ACT1_B006/ACT1_B006-calibration.png',
  receipt: 'ACT1_B006/generation-receipt.v1.json',
  result: 'ACT1_B006/generation-result.v1.json',
});
const CALIBRATION_SOURCE_STILL_FILES = Object.freeze({
  authorization: 'ACT1_B009/source-still-execution-authorization.v1.json',
  ledger: 'ACT1_B009/source-still-request-ledger.jsonl',
  lock: 'ACT1_B009/source-still.lock',
  output: 'ACT1_B009/ACT1_B009-source-still.png',
  receipt: 'ACT1_B009/source-still-generation-receipt.v1.json',
  result: 'ACT1_B009/source-still-generation-result.v1.json',
  failure: 'ACT1_B009/source-still-failure-receipt.v1.json',
});
const MAX_CALIBRATION_IMAGE_BYTES = 32 * 1024 * 1024;

function fail(ok, code) { if (!ok) throw new Error(code); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function errorCode(error) {
  const code = String(error?.message || error).split(':')[0];
  return /^[A-Z][A-Z0-9_]{2,100}$/u.test(code) ? code : 'PHASE3_CALIBRATION_OPERATION_FAILED';
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonicalValue(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
function exactKeys(value, keys, code) {
  fail(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), code);
}
function strictRealFile(file, fsImpl = fs, code = 'PHASE3_CALIBRATION_FILE_INVALID') {
  fail(fsImpl.existsSync(file), code);
  const stat = fsImpl.lstatSync(file);
  fail(stat.isFile() && !stat.isSymbolicLink(), code);
  return stat;
}
function calibrationPath(runDir, relative) {
  const resolved = path.resolve(runDir, ...relative.split('/'));
  fail(resolved.startsWith(`${path.resolve(runDir)}${path.sep}`), 'PHASE3_CALIBRATION_PATH_INVALID');
  return resolved;
}
function writeJsonAtomicExclusive(file, value, fsImpl = fs) {
  fail(!fsImpl.existsSync(file), 'PHASE3_CALIBRATION_OUTPUT_ALREADY_EXISTS');
  const temp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    const fd = fsImpl.openSync(temp, 'r+');
    try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
    fsImpl.renameSync(temp, file);
  } catch (error) {
    try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch (_) {}
    throw error;
  }
}
function writeBytesAtomicExclusive(file, bytes, fsImpl = fs) {
  fail(!fsImpl.existsSync(file), 'PHASE3_CALIBRATION_OUTPUT_ALREADY_EXISTS');
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
function pngInfo(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fail(Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.subarray(0, 8).equals(signature)
    && bytes.toString('ascii', 12, 16) === 'IHDR', 'PHASE3_CALIBRATION_OUTPUT_NOT_PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  fail(width > 0 && height > 0, 'PHASE3_CALIBRATION_PNG_DIMENSIONS_INVALID');
  return { format: 'PNG', mimeType: 'image/png', width, height };
}
function json(file, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`PHASE3_MEDIA_EXECUTION_JSON_INVALID:${path.basename(file)}:${error.message}`); }
}
function safeRel(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0')
    && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}
function walkFiles(root, fsImpl = fs, prefix = '') {
  const base = prefix ? path.join(root, ...prefix.split('/')) : root;
  const st = fsImpl.lstatSync(base);
  fail(!st.isSymbolicLink(), `PHASE3_MEDIA_EXECUTION_SYMLINK:${prefix || '.'}`);
  fail(st.isDirectory(), `PHASE3_MEDIA_EXECUTION_DIRECTORY_INVALID:${prefix || '.'}`);
  const out = [];
  for (const name of fsImpl.readdirSync(base).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = path.join(base, name), item = fsImpl.lstatSync(full);
    fail(!item.isSymbolicLink(), `PHASE3_MEDIA_EXECUTION_SYMLINK:${rel}`);
    if (item.isDirectory()) out.push(...walkFiles(root, fsImpl, rel));
    else { fail(item.isFile(), `PHASE3_MEDIA_EXECUTION_FILE_TYPE_INVALID:${rel}`); out.push(rel); }
  }
  return out;
}
function verifyIndex(root, indexFile, expectedIndexSha256, expectedCount, { fsImpl = fs } = {}) {
  fail(fsImpl.existsSync(indexFile), 'PHASE3_MEDIA_EXECUTION_INDEX_MISSING');
  const indexBytes = fsImpl.readFileSync(indexFile);
  fail(sha(indexBytes) === expectedIndexSha256, 'PHASE3_MEDIA_EXECUTION_INDEX_HASH_MISMATCH');
  const index = JSON.parse(indexBytes.toString('utf8'));
  fail(Array.isArray(index.files) && index.files.length === expectedCount
    && index.fileCount === expectedCount, 'PHASE3_MEDIA_EXECUTION_INDEX_COUNT_MISMATCH');
  const seen = new Set();
  for (const item of index.files) {
    fail(safeRel(item?.path) && !seen.has(item.path), `PHASE3_MEDIA_EXECUTION_INDEX_PATH_INVALID:${item?.path || ''}`);
    seen.add(item.path);
    const target = path.resolve(root, ...item.path.split('/'));
    fail(target.startsWith(`${path.resolve(root)}${path.sep}`) && fsImpl.existsSync(target),
      `PHASE3_MEDIA_EXECUTION_INDEXED_FILE_MISSING:${item.path}`);
    const st = fsImpl.lstatSync(target);
    fail(st.isFile() && !st.isSymbolicLink(), `PHASE3_MEDIA_EXECUTION_INDEXED_FILE_INVALID:${item.path}`);
    const bytes = fsImpl.readFileSync(target);
    fail(bytes.length === item.bytes && sha(bytes) === item.sha256,
      `PHASE3_MEDIA_EXECUTION_INDEXED_FILE_MISMATCH:${item.path}`);
  }
  const actual = walkFiles(root, fsImpl).filter(item => item !== path.relative(root, indexFile).replace(/\\/gu, '/')).sort();
  fail(JSON.stringify(actual) === JSON.stringify([...seen].sort()), 'PHASE3_MEDIA_EXECUTION_UNINDEXED_OR_MISSING_FILE');
  return { index, indexBytes, indexSha256: sha(indexBytes), count: index.files.length };
}
function verifyOuterPackage({ packageDirectory, fsImpl = fs } = {}) {
  fail(path.basename(path.resolve(packageDirectory)) === 'phase3-consolidated-act5-production-candidate-20261004-v5',
    'PHASE3_MEDIA_EXECUTION_V5_SOURCE_REQUIRED');
  const outer = verifyIndex(packageDirectory, path.join(packageDirectory, 'package-index.v2.json'), OUTER_INDEX_SHA256, 194, { fsImpl });
  const candidateRoot = path.join(packageDirectory, 'candidate');
  const candidate = verifyIndex(candidateRoot, path.join(candidateRoot, 'candidate-package-sha256.json'),
    CANDIDATE_INDEX_SHA256, 174, { fsImpl });
  const indexedCandidateIndex = outer.index.files.find(item => item.path === 'candidate/candidate-package-sha256.json');
  fail(indexedCandidateIndex?.sha256 === CANDIDATE_INDEX_SHA256, 'PHASE3_MEDIA_EXECUTION_CANDIDATE_INDEX_NOT_OUTER_BOUND');
  verifyApprovalBindings(candidateRoot, fsImpl);
  return { packageDirectory: path.resolve(packageDirectory), candidateRoot, outer, candidate };
}
function verifyApprovalBindings(candidateRoot, fsImpl = fs) {
  const readHash = (relative, expected) => {
    const bytes = fsImpl.readFileSync(path.join(candidateRoot, ...relative.split('/')));
    fail(sha(bytes) === expected, `PHASE3_MEDIA_EXECUTION_APPROVAL_HASH_MISMATCH:${relative}`);
    return JSON.parse(bytes.toString('utf8'));
  };
  const b015 = readHash('approvals/act5-b015-compiled-visual-approval.v1.json', B015_APPROVAL_SHA256);
  const b016 = readHash('production-dependencies/act5-b016-deferred-b015-source.v1.json', B016_DEPENDENCY_SHA256);
  const lineage = readHash('revision-lineage/phase3-consolidated-act5-amendment-lineage.v1.json',
    '4803b5ea64554b6a0bac0611d374845b9b3b7598011d7bb5f16e55053815b713');
  const b030 = readHash('approvals/act1-b030-timing-obligation-renewal-approval.v1.json',
    '2db259b6ddfd8770e172056603192ec7d88f5fab4e8f8b37f537b6ca015c3373');
  const candidateReport = readHash('candidate-report.json',
    '625767c92674118997ff948280e2baeb06a02703d611497104d03abeaea6faa2');
  const shots = readHash('shot-definitions.json', '08de92b26f39e06a86912454b588d0b112b62f7ab99f5e6e2a44134d628b1a3a');
  const production = readHash('production-manifest.json', 'e26cc97d9327f75c25d69e8a0d6aa759045d5f9a797c32fa4fea617092bbf63d');
  fail(b015.decision === 'APPROVED' && b015.scope?.beatId === 'ACT5_B015'
    && b015.bindings?.timingApprovalSha256 === B015_TIMING_APPROVAL_SHA256,
  'PHASE3_MEDIA_EXECUTION_B015_APPROVAL_BINDING_INVALID');
  fail(b016.status === 'APPROVED_COMPOSITION_SOURCE_BOUND_EXECUTION_BLOCKED_PENDING_B016_MEDIA'
    && b016.beatId === 'ACT5_B016' && b016.approvalSha256 === B016_APPROVAL_SHA256
    && b016.requiredSource?.sha256 === sha(fsImpl.readFileSync(path.join(candidateRoot,
      ...b016.requiredSource.path.split('/')))), 'PHASE3_MEDIA_EXECUTION_B016_BINDING_INVALID');
  fail(lineage.approvals?.b009Amendment === B009_AMENDMENT_SHA256
    && lineage.approvals?.b009Approval === B009_APPROVAL_SHA256
    && lineage.approvals?.b015CompiledVisualApproval === B015_APPROVAL_SHA256
    && lineage.approvals?.b015TimingApproval === B015_TIMING_APPROVAL_SHA256
    && lineage.approvals?.b016DependencyApproval === B016_APPROVAL_SHA256,
  'PHASE3_MEDIA_EXECUTION_LINEAGE_APPROVAL_BINDING_INVALID');
  const b009Shot = shots.allShots.find(item => item.beatId === 'ACT5_B009');
  const b009Production = production.shots.find(item => item.shotId === 'ACT5_B009');
  const b015PlanBeat = json(path.join(candidateRoot, 'edit-plan.json'), fsImpl).sequences
    .flatMap(sequence => sequence.beats || []).find(item => item.beatId === 'ACT5_B015');
  fail(b009Shot?.assetType === 'graphic_compilation' && b009Production?.productionMethod === 'GRAPHIC_COMPILATION'
    && b009Production?.assetType === 'graphic_compilation'
    && candidateReport.retiredBeatIds?.includes('ACT3B_B010'), 'PHASE3_MEDIA_EXECUTION_B009_OR_RETIRED_BEAT_BINDING_INVALID');
  fail(b030.status === 'APPROVED' && b030.scope?.beatId === 'ACT1_B030'
    && b030.scope?.from === 'generated_clip' && b030.scope?.to === 'controlled_image'
    && b030.bindings?.parentCandidateIndexSha256 === '8ff011db727b1cf6ac47acff010f15d9559aa9dcfc763dc6830cbcba7916deac'
    && candidateReport.validators?.revisionLineage === 'PASS_APPROVED_SCOPE_WITH_B030_HASH_RENEWAL',
  'PHASE3_MEDIA_EXECUTION_B030_RENEWAL_INVALID');
  fail(b015PlanBeat && Number(b015PlanBeat.startSec) === 571.9558705585937
    && Number(b015PlanBeat.endSec) === 577.515875746582
    && Number(b015PlanBeat.durationSec) === 5.560005187988281,
  'PHASE3_MEDIA_EXECUTION_B015_TIMING_INVALID');
  return { b015ApprovalSha256: B015_APPROVAL_SHA256, b016DependencySha256: B016_DEPENDENCY_SHA256,
    b009AmendmentSha256: B009_AMENDMENT_SHA256, b009ApprovalSha256: B009_APPROVAL_SHA256,
    b016ApprovalSha256: B016_APPROVAL_SHA256 };
}
function verifyStage04StagedContext({ runId, runDir, candidateDirectory, activationRecord, runner, fsImpl = fs,
  verifyStagedValidationContextFn = phase3Render.verifyStagedValidationContext } = {}) {
  fail(typeof verifyStagedValidationContextFn === 'function', 'PHASE3_MEDIA_EXECUTION_STAGE04_VALIDATOR_UNAVAILABLE');
  const context = verifyStagedValidationContextFn({ runId, reviewDirectory: runDir, candidateDirectory,
    activationRecord, runner, fsImpl });
  fail(context?.staged?.stagedFileCount === 151, 'PHASE3_MEDIA_EXECUTION_STAGE04_STAGED_INDEX_INVALID');
  return context;
}
function verifyStage04({ episodeRoot, fsImpl = fs, runner = activation,
  verifyStagedValidationContextFn = phase3Render.verifyStagedValidationContext } = {}) {
  const runDir = path.join(episodeRoot, '.review', `phase2.3b-p-activation-${STAGE04_RUN_ID}`);
  const recordPath = path.join(runDir, 'activation-record.json');
  fail(fsImpl.existsSync(recordPath), 'PHASE3_MEDIA_EXECUTION_STAGE04_RECORD_MISSING');
  const recordBytes = fsImpl.readFileSync(recordPath);
  fail(sha(recordBytes) === STAGE04_ACTIVATION_SHA256, 'PHASE3_MEDIA_EXECUTION_STAGE04_RECORD_HASH_MISMATCH');
  const record = JSON.parse(recordBytes.toString('utf8'));
  fail(record.status === 'PROMOTED' && record.runId === STAGE04_RUN_ID
    && Array.isArray(record.candidateFiles) && record.candidateFiles.length === 147
    && record.promotionPreflight?.writePathCount === 147, 'PHASE3_MEDIA_EXECUTION_STAGE04_NOT_PROMOTED');
  runner.assertNoActivationLocks({ runId: STAGE04_RUN_ID, fs: fsImpl });
  const globalLock = path.join(episodeRoot, '.review', 'phase2.3b-p-activation-active.lock');
  fail(!fsImpl.existsSync(globalLock), 'PHASE3_MEDIA_EXECUTION_ACTIVATION_LOCK_ACTIVE');
  const candidateDirectory = path.join(runDir, 'candidate');
  const { staged } = verifyStage04StagedContext({ runId: STAGE04_RUN_ID, runDir, candidateDirectory,
    activationRecord: record, runner, fsImpl, verifyStagedValidationContextFn });
  runner.verifyPromotedTree(episodeRoot, record.candidateFiles);
  const ledgerPath = path.join(episodeRoot, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
  fail(fsImpl.existsSync(ledgerPath) && sha(fsImpl.readFileSync(ledgerPath)) === REQUEST_LEDGER_SHA256,
    'PHASE3_MEDIA_EXECUTION_REQUEST_LEDGER_MISMATCH');
  return { record, recordBytes, recordSha256: sha(recordBytes), promotedPathCount: record.candidateFiles.length,
    stagedCandidateIndexSha256: staged.stagedIndexSha256, requestLedgerSha256: REQUEST_LEDGER_SHA256,
    promotedPathsMatch: true };
}
function assertNoPhase3Locks(episodeRoot, fsImpl = fs) {
  const review = path.join(episodeRoot, '.review');
  if (!fsImpl.existsSync(review)) return true;
  for (const file of walkFiles(review, fsImpl)) fail(!/^(?:phase3-render|render)(?:-active)?\.lock$/u.test(path.posix.basename(file)),
    'PHASE3_MEDIA_EXECUTION_RENDER_LOCK_ACTIVE');
  return true;
}
function deriveCensus(candidateRoot, { fsImpl = fs } = {}) {
  const base = path.join(candidateRoot, 'production-manifest.json');
  const manifest = json(base, fsImpl), shots = manifest.shots;
  fail(Array.isArray(shots) && shots.length === 153, 'PHASE3_MEDIA_EXECUTION_SHOT_SET_INVALID');
  const methodCounts = Object.fromEntries(Object.keys(EXPECTED_METHODS).map(key => [key,
    shots.filter(item => item.productionMethod === key).length]));
  fail(JSON.stringify(methodCounts) === JSON.stringify(EXPECTED_METHODS), 'PHASE3_MEDIA_EXECUTION_METHOD_CENSUS_MISMATCH');
  const finalCounts = { controlledStills: methodCounts.CONTROLLED_STILL,
    generatedStills: methodCounts.GENERATED_STILL, animationClips: methodCounts.ESSENTIAL_ANIMATION };
  const finalTotal = Object.values(finalCounts).reduce((sum, count) => sum + count, 0);
  fail(finalTotal === 65, 'PHASE3_MEDIA_EXECUTION_FINAL_OUTPUT_TOTAL_MISMATCH');
  const missing = { controlledStills: [], generatedStills: [], animationClips: [], animationSourceStills: [] };
  for (const shot of shots) {
    if (shot.productionMethod === 'CONTROLLED_STILL') missing.controlledStills.push(shot.shotId);
    if (shot.productionMethod === 'GENERATED_STILL') missing.generatedStills.push(shot.shotId);
    if (shot.productionMethod === 'ESSENTIAL_ANIMATION') {
      missing.animationClips.push(shot.shotId);
      missing.animationSourceStills.push(shot.shotId);
    }
  }
  const assetRoot = path.join(candidateRoot, 'assets');
  const present = (rel) => fsImpl.existsSync(path.join(candidateRoot, ...rel.split('/')));
  const missingFinals = {
    controlledStills: missing.controlledStills.filter(id => !present(`assets/stills/${id}.png`)),
    generatedStills: missing.generatedStills.filter(id => !present(`assets/stills/${id}.png`)),
    animationClips: missing.animationClips.filter(id => !present(`assets/clips/${id}.mp4`)),
    animationSourceStills: missing.animationSourceStills.filter(id => !present(`assets/stills/${id}.png`)),
  };
  const counts = Object.fromEntries(Object.entries(missingFinals).map(([key, rows]) => [key, rows.length]));
  const shotsFile = path.join(candidateRoot, 'shot-definitions.json');
  const shotDefs = json(shotsFile, fsImpl), shotHash = sha(fsImpl.readFileSync(shotsFile));
  const evidenceManifest = json(path.join(candidateRoot, 'evidence-source-manifest.json'), fsImpl);
  const evidenceValidation = evidence.validateEvidenceSourceManifest({ manifest: evidenceManifest, shotDefs,
    evidenceAssetDir: path.join(assetRoot, 'evidence'), fsImpl, requireApproved: true, requireLocalAssets: true });
  fail(evidenceValidation.status === 'PASS' && evidenceValidation.errors.length === 0,
    `PHASE3_MEDIA_EXECUTION_EVIDENCE_INVALID:${evidenceValidation.errors[0]?.code || 'UNKNOWN'}`);
  const graphicManifest = json(path.join(candidateRoot, 'graphic-asset-manifest.json'), fsImpl);
  const graphicValidation = validateGraphicAssetManifest({ manifest: graphicManifest, shotDefs,
    graphicAssetDir: path.join(assetRoot, 'graphics'), shotDefinitionsSha256: shotHash, fsImpl });
  fail(graphicValidation.status === 'PASS' && graphicValidation.errors.length === 0,
    `PHASE3_MEDIA_EXECUTION_GRAPHICS_INVALID:${graphicValidation.errors[0]?.code || 'UNKNOWN'}`);
  const evidenceAssetCount = walkFiles(path.join(assetRoot, 'evidence'), fsImpl).length;
  const graphicAssetCount = walkFiles(path.join(assetRoot, 'graphics'), fsImpl).length;
  fail(evidenceManifest.entries?.length === 46 && evidenceAssetCount === 29 && graphicAssetCount === 79,
    'PHASE3_MEDIA_EXECUTION_VERIFIED_ASSET_TOTALS_MISMATCH');
  const report = json(path.join(candidateRoot, 'candidate-report.json'), fsImpl);
  fail(report.retiredBeatIds?.includes('ACT3B_B010'), 'PHASE3_MEDIA_EXECUTION_RETIRED_BEAT_REAPPEARED');
  const calibrationIds = ['ACT1_B005', 'ACT1_B006', 'ACT1_B009'];
  const calibration = calibrationIds.map(beatId => {
    const item = shots.find(shot => shot.shotId === beatId);
    return { beatId, productionMethod: item?.productionMethod, structurallySpecified: Boolean(item?.productionMethod), finalOutputPresent: ![
      missingFinals.controlledStills.includes(beatId), missingFinals.generatedStills.includes(beatId),
      missingFinals.animationClips.includes(beatId)].some(Boolean),
      animationSourceStillMissing: missingFinals.animationSourceStills.includes(beatId) };
  });
  const routeApproval = calibrationRoutes.readRouteApproval({ fsImpl });
  const routePlan = calibrationRoutes.makeRoutePlan({
    candidate: { productionManifest: manifest, shotDefinitions: shotDefs,
      editPlan: json(path.join(candidateRoot, 'edit-plan.json'), fsImpl) },
    approval: routeApproval,
  });
  const routes = { still: { falEndpoint: calibrationRoutes.FLUX3_ENDPOINT, model: 'FLUX 3 Image',
      parameters: calibrationRoutes.FLUX3, officialSchemaVerified: true,
      availableForCalibration: true, promptSerialization: calibrationRoutes.FLUX_NEGATIVE_PROMPT_DELIMITER,
      productionUse: false },
    animation: { falEndpoint: calibrationRoutes.H3_MAX_ENDPOINT, model: 'H3 Max Image to Video',
      parameters: calibrationRoutes.H3_MAX, officialSchemaVerified: true, availableForCalibration: true,
      targetAudioUrlSent: false, rawMayContainNativeAudio: true, derivativeMustStripAllAudio: true,
      productionUse: false },
    routeApprovalSha256: routeApproval.sha256,
    executionAuthorized: false,
    blockingCondition: routePlan.hardExecutionBlockers.filter(item => item.code !== 'ACT1_B005_DEFERRED_DOES_NOT_BLOCK_CALIBRATION')
      .map(item => item.code) };
  return { activeShots: shots.length, finalOutputCounts: finalCounts, finalOutputTotal: finalTotal,
    intermediateAnimationSourceStills: { required: 23, missing: counts.animationSourceStills,
      excludedFromFinalOutputTotal: true }, missingFinalOutputs: counts, unresolvedBeatIds: missingFinals,
    resolvedDeterministicGraphics: { manifestEntries: graphicManifest.entries.length,
      verifiedAssetFiles: graphicAssetCount, approvedCompiledPngOutputs: 2,
      validation: graphicValidation.status },
    resolvedEvidenceAssets: { approvedEntries: evidenceManifest.entries.length, verifiedAssetFiles: evidenceAssetCount,
      validation: evidenceValidation.status }, productionRouteAvailability: routes,
    calibrationRoutePlan: routePlan,
    singleCalibrationAuthorizationBlocker: routes.blockingCondition,
    calibrationBatch: { beats: calibration, structuralStatus: 'PASS', executionStatus: 'READY_FOR_SEQUENTIAL_SINGLE_REQUEST_AUTHORIZATIONS',
      providerRequestsAuthorized: 0, deferredBeatIds: ['ACT1_B005'] },
    candidateStatus: report.status, retiredBeatIds: report.retiredBeatIds,
    providerRequests: 0, episodeRootWrites: 0 };
}
function makeStagedIndex(candidateRoot, { runId, outerIndexSha256, candidateIndexSha256, fsImpl = fs } = {}) {
  const files = walkFiles(candidateRoot, fsImpl).map(relative => {
    const bytes = fsImpl.readFileSync(path.join(candidateRoot, ...relative.split('/')));
    return { path: relative, bytes: bytes.length, sha256: sha(bytes) };
  });
  return { schemaVersion: 'phase3-media-execution-staged-index/1.0.0', status: 'VERIFIED_V5_STAGED', runId,
    sourceOuterPackageIndexSha256: outerIndexSha256, sourceCandidateIndexSha256: candidateIndexSha256,
    fileCount: files.length, files };
}
function calibrationRuntimeHashes({ executionModulePath = __filename,
  cliPath = path.resolve(__dirname, '..', 'scripts', 'phase3-media-execution.cjs'), fsImpl = fs } = {}) {
  strictRealFile(executionModulePath, fsImpl, 'PHASE3_CALIBRATION_EXECUTION_MODULE_MISSING');
  strictRealFile(cliPath, fsImpl, 'PHASE3_CALIBRATION_CLI_MISSING');
  return { executionModuleSha256: sha(fsImpl.readFileSync(executionModulePath)),
    cliSha256: sha(fsImpl.readFileSync(cliPath)) };
}
function makeCalibrationAuthorizationTemplate({ executionModuleSha256, cliSha256, authorizedAt } = {}) {
  fail(/^[a-f0-9]{64}$/u.test(executionModuleSha256 || '') && /^[a-f0-9]{64}$/u.test(cliSha256 || ''),
    'PHASE3_CALIBRATION_DEPLOYED_HASHES_REQUIRED');
  fail(typeof authorizedAt === 'string' && Number.isFinite(new Date(authorizedAt).getTime())
    && new Date(authorizedAt).toISOString() === authorizedAt, 'PHASE3_CALIBRATION_AUTHORIZED_AT_INVALID');
  return {
    schemaVersion: CALIBRATION_AUTHORIZATION_SCHEMA,
    status: 'AUTHORIZED_FOR_SINGLE_CALIBRATION_STILL_EXECUTION',
    approvedBy: 'Yakubu Moshood',
    authorizedAt,
    authorizationStatement: CALIBRATION_AUTHORIZATION_STATEMENT,
    bindings: {
      runId: CALIBRATION_RUN_ID,
      stagedIndexSha256: calibrationRoutes.TRUST.stagedIndexSha256,
      candidateIndexSha256: CANDIDATE_INDEX_SHA256,
      outerIndexSha256: OUTER_INDEX_SHA256,
      routeResolutionApprovalSha256: calibrationRoutes.ROUTE_APPROVAL_SHA256,
      deployedExecutionModuleSha256: executionModuleSha256,
      deployedCliSha256: cliSha256,
      beatId: CALIBRATION_BEAT_ID,
      operation: CALIBRATION_OPERATION,
      endpoint: CALIBRATION_ENDPOINT,
      requestKey: CALIBRATION_REQUEST_KEY,
      positivePromptSha256: CALIBRATION_POSITIVE_PROMPT_SHA256,
      negativeInstructionsSha256: CALIBRATION_NEGATIVE_INSTRUCTIONS_SHA256,
      serializedPromptSha256: CALIBRATION_SERIALIZED_PROMPT_SHA256,
    },
    requestLimits: {
      resolution: '1k', aspectRatio: '16:9', outputFormat: 'PNG', numberOfImages: 1,
      promptExpansionEnabled: false, maximumProviderSubmissions: 1, retries: 0, fallbackEnabled: false,
    },
    exposure: {
      maximumHumanAcceptedUsd: CALIBRATION_MAX_EXPOSURE_USD,
      providerEnforced: false,
      acknowledgement: 'The USD 0.05 maximum is human-accepted and is not provider-enforced.',
    },
    classification: {
      assetClass: CALIBRATION_ASSET_CLASS,
      ownershipDisposition: CALIBRATION_OWNERSHIP_DISPOSITION,
    },
    denials: {
      allOtherBeatsDenied: true, allOtherOperationsDenied: true, productionUseDenied: true,
      renderingDenied: true, promotionDenied: true, episodeRootWritesDenied: true,
    },
  };
}
function validateCalibrationAuthorizationRecord(record, { runtimeHashes } = {}) {
  exactKeys(record, ['schemaVersion', 'status', 'approvedBy', 'authorizedAt', 'authorizationStatement',
    'bindings', 'requestLimits', 'exposure', 'classification', 'denials'],
  'PHASE3_CALIBRATION_AUTHORIZATION_FIELDS_INVALID');
  fail(record.schemaVersion === CALIBRATION_AUTHORIZATION_SCHEMA
    && record.status === 'AUTHORIZED_FOR_SINGLE_CALIBRATION_STILL_EXECUTION'
    && record.approvedBy === 'Yakubu Moshood'
    && record.authorizationStatement === CALIBRATION_AUTHORIZATION_STATEMENT,
  'PHASE3_CALIBRATION_AUTHORIZATION_IDENTITY_INVALID');
  fail(typeof record.authorizedAt === 'string' && Number.isFinite(new Date(record.authorizedAt).getTime())
    && new Date(record.authorizedAt).toISOString() === record.authorizedAt,
  'PHASE3_CALIBRATION_AUTHORIZED_AT_INVALID');
  exactKeys(record.bindings, ['runId', 'stagedIndexSha256', 'candidateIndexSha256', 'outerIndexSha256',
    'routeResolutionApprovalSha256', 'deployedExecutionModuleSha256', 'deployedCliSha256', 'beatId',
    'operation', 'endpoint', 'requestKey', 'positivePromptSha256', 'negativeInstructionsSha256',
    'serializedPromptSha256'], 'PHASE3_CALIBRATION_AUTHORIZATION_BINDING_FIELDS_INVALID');
  const expectedBindings = makeCalibrationAuthorizationTemplate({ ...runtimeHashes,
    authorizedAt: record.authorizedAt }).bindings;
  fail(canonicalJson(record.bindings) === canonicalJson(expectedBindings),
    'PHASE3_CALIBRATION_AUTHORIZATION_BINDING_MISMATCH');
  exactKeys(record.requestLimits, ['resolution', 'aspectRatio', 'outputFormat', 'numberOfImages',
    'promptExpansionEnabled', 'maximumProviderSubmissions', 'retries', 'fallbackEnabled'],
  'PHASE3_CALIBRATION_AUTHORIZATION_LIMIT_FIELDS_INVALID');
  fail(canonicalJson(record.requestLimits) === canonicalJson({ resolution: '1k', aspectRatio: '16:9',
    outputFormat: 'PNG', numberOfImages: 1, promptExpansionEnabled: false,
    maximumProviderSubmissions: 1, retries: 0, fallbackEnabled: false }),
  'PHASE3_CALIBRATION_AUTHORIZATION_LIMITS_INVALID');
  exactKeys(record.exposure, ['maximumHumanAcceptedUsd', 'providerEnforced', 'acknowledgement'],
    'PHASE3_CALIBRATION_AUTHORIZATION_EXPOSURE_FIELDS_INVALID');
  fail(record.exposure.maximumHumanAcceptedUsd === CALIBRATION_MAX_EXPOSURE_USD
    && record.exposure.providerEnforced === false
    && record.exposure.acknowledgement === 'The USD 0.05 maximum is human-accepted and is not provider-enforced.',
  'PHASE3_CALIBRATION_AUTHORIZATION_EXPOSURE_INVALID');
  exactKeys(record.classification, ['assetClass', 'ownershipDisposition'],
    'PHASE3_CALIBRATION_AUTHORIZATION_CLASSIFICATION_FIELDS_INVALID');
  fail(record.classification.assetClass === CALIBRATION_ASSET_CLASS
    && record.classification.ownershipDisposition === CALIBRATION_OWNERSHIP_DISPOSITION,
  'PHASE3_CALIBRATION_AUTHORIZATION_CLASSIFICATION_INVALID');
  exactKeys(record.denials, ['allOtherBeatsDenied', 'allOtherOperationsDenied', 'productionUseDenied',
    'renderingDenied', 'promotionDenied', 'episodeRootWritesDenied'],
  'PHASE3_CALIBRATION_AUTHORIZATION_DENIAL_FIELDS_INVALID');
  fail(Object.values(record.denials).every(value => value === true),
    'PHASE3_CALIBRATION_AUTHORIZATION_DENIALS_INVALID');
  return true;
}
function loadCalibrationAuthorization({ runDir, expectedSha256, runtimeHashes, fsImpl = fs } = {}) {
  fail(/^[a-f0-9]{64}$/u.test(expectedSha256 || ''), 'PHASE3_CALIBRATION_EXPECTED_AUTHORIZATION_HASH_REQUIRED');
  const file = calibrationPath(runDir, CALIBRATION_FILES.authorization);
  strictRealFile(file, fsImpl, 'PHASE3_CALIBRATION_EXECUTION_AUTHORIZATION_MISSING');
  const bytes = fsImpl.readFileSync(file);
  fail(sha(bytes) === expectedSha256, 'PHASE3_CALIBRATION_EXECUTION_AUTHORIZATION_HASH_MISMATCH');
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('PHASE3_CALIBRATION_EXECUTION_AUTHORIZATION_JSON_INVALID'); }
  validateCalibrationAuthorizationRecord(record, { runtimeHashes });
  return { file, bytes, sha256: sha(bytes), record };
}
function readCalibrationLedger(file, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return [];
  strictRealFile(file, fsImpl, 'PHASE3_CALIBRATION_LEDGER_INVALID');
  const raw = fsImpl.readFileSync(file, 'utf8');
  if (!raw) return [];
  let previousEntrySha256 = null;
  const records = raw.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let record;
    try { record = JSON.parse(line); }
    catch { throw new Error(`PHASE3_CALIBRATION_LEDGER_JSON_INVALID:${index + 1}`); }
    const supplied = record.entrySha256, base = { ...record };
    delete base.entrySha256;
    fail(record.previousEntrySha256 === previousEntrySha256
      && supplied === sha(Buffer.from(canonicalJson(base), 'utf8')),
    `PHASE3_CALIBRATION_LEDGER_CHAIN_INVALID:${index + 1}`);
    previousEntrySha256 = supplied;
    return record;
  });
  const reservations = records.filter(item => item.recordType === 'SUBMISSION_RESERVED');
  fail(reservations.length <= 1 && new Set(reservations.map(item => item.requestKey)).size === reservations.length,
    'PHASE3_CALIBRATION_LEDGER_SUBMISSION_LIMIT_OR_DUPLICATE');
  fail(records.filter(item => item.recordType === 'SUBMISSION_RESULT').length <= 1,
    'PHASE3_CALIBRATION_LEDGER_RESULT_LIMIT_INVALID');
  return records;
}
function appendCalibrationLedgerRecord(file, baseRecord, fsImpl = fs) {
  if (fsImpl.existsSync(file)) strictRealFile(file, fsImpl, 'PHASE3_CALIBRATION_LEDGER_INVALID');
  const records = readCalibrationLedger(file, fsImpl);
  const previousEntrySha256 = records.length ? records[records.length - 1].entrySha256 : null;
  const base = { ...baseRecord, previousEntrySha256 };
  const record = { ...base, entrySha256: sha(Buffer.from(canonicalJson(base), 'utf8')) };
  fsImpl.appendFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'a' });
  const fd = fsImpl.openSync(file, 'a');
  try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
  return record;
}
function acquireCalibrationLock(runDir, fsImpl = fs) {
  const file = calibrationPath(runDir, CALIBRATION_FILES.lock);
  fail(!fsImpl.existsSync(file), 'PHASE3_CALIBRATION_LOCK_EXISTS');
  let fd = null, created = false;
  try {
    fd = fsImpl.openSync(file, 'wx', 0o600); created = true;
    fsImpl.writeSync(fd, `${process.pid}\n`);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd); fd = null;
    return file;
  } catch (error) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch (_) {} }
    if (created) { try { fsImpl.unlinkSync(file); } catch (_) {} }
    if (error?.code === 'EEXIST') throw new Error('PHASE3_CALIBRATION_LOCK_EXISTS');
    throw error;
  }
}
async function downloadCalibrationImage(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('PHASE3_CALIBRATION_DOWNLOAD_URL_INVALID'); }
  fail(parsed.protocol === 'https:' && !parsed.username && !parsed.password,
    'PHASE3_CALIBRATION_DOWNLOAD_URL_INVALID');
  const allowed = parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media')
    || parsed.hostname === 'storage.googleapis.com' || parsed.hostname.endsWith('.googleusercontent.com');
  fail(allowed, 'PHASE3_CALIBRATION_DOWNLOAD_HOST_FORBIDDEN');
  const response = await fetch(parsed, { redirect: 'error' });
  fail(response.ok, 'PHASE3_CALIBRATION_DOWNLOAD_FAILED');
  const declared = Number(response.headers.get('content-length') || 0);
  fail(!declared || declared <= MAX_CALIBRATION_IMAGE_BYTES, 'PHASE3_CALIBRATION_DOWNLOAD_TOO_LARGE');
  const bytes = Buffer.from(await response.arrayBuffer());
  fail(bytes.length > 0 && bytes.length <= MAX_CALIBRATION_IMAGE_BYTES,
    'PHASE3_CALIBRATION_DOWNLOAD_SIZE_INVALID');
  return { bytes, contentType: response.headers.get('content-type') || '' };
}
function jsonSafeMetadata(value) {
  try { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }
  catch { throw new Error('PHASE3_CALIBRATION_PROVIDER_METADATA_INVALID'); }
}
function createFalCalibrationProvider({ falModuleLoader = () => require('@fal-ai/client'),
  credentialResolver = () => process.env.FAL_KEY } = {}) {
  return {
    generateStill: async ({ endpoint, input }) => {
      fail(endpoint === CALIBRATION_ENDPOINT, 'PHASE3_CALIBRATION_PROVIDER_ENDPOINT_FORBIDDEN');
      const credentials = credentialResolver();
      fail(Boolean(credentials), 'PHASE3_CALIBRATION_PROVIDER_CREDENTIAL_MISSING');
      const { fal } = falModuleLoader();
      fal.config({ credentials, retry: { maxRetries: 0, retryableStatusCodes: [] } });
      const raw = await fal.subscribe(endpoint, { input, logs: false });
      const images = raw?.data?.images;
      fail(Array.isArray(images) && images.length === 1, 'PHASE3_CALIBRATION_PROVIDER_RESPONSE_INVALID');
      fail(typeof images[0]?.url === 'string' && images[0].url.length > 0,
        'PHASE3_CALIBRATION_PROVIDER_IMAGE_URL_MISSING');
      const actualCharge = raw?.data?.actual_cost_usd;
      return { url: images[0].url, contentType: images[0].content_type || null, imageCount: images.length,
        providerRequestId: typeof raw?.request_id === 'string' ? raw.request_id
          : typeof raw?.data?.request_id === 'string' ? raw.data.request_id : null,
        actualChargeUsd: Number.isFinite(actualCharge) ? actualCharge : null,
        rawProviderResponseMetadata: jsonSafeMetadata(raw) };
    },
  };
}
function createMediaExecution({ packageDirectory, episodeRoot, reviewRoot, fsImpl = fs, activationRunner = activation,
  b009ApprovalPath, b016ApprovalPath, verifyStage04Fn = verifyStage04,
  assertNoPhase3LocksFn = assertNoPhase3Locks, provider = createFalCalibrationProvider(),
  downloader = downloadCalibrationImage, now = () => new Date().toISOString(),
  executionModulePath = __filename, cliPath = path.resolve(__dirname, '..', 'scripts', 'phase3-media-execution.cjs'),
  testHooks = {} } = {}) {
  let calibrationAnimationRunFilesVerifier = null;
  function stage({ runId }) {
    fail(RUN_RE.test(runId || ''), 'PHASE3_MEDIA_EXECUTION_RUN_ID_INVALID');
    const verified = verifyOuterPackage({ packageDirectory, fsImpl });
    verifyDetachedApprovals({ b009ApprovalPath, b016ApprovalPath, fsImpl });
    const stage04 = verifyStage04Fn({ episodeRoot, fsImpl, runner: activationRunner });
    assertNoPhase3LocksFn(episodeRoot, fsImpl);
    const expectedReviewRoot = assertReviewRootPolicy({ episodeRoot, reviewRoot, fsImpl });
    fail(fsImpl.existsSync(path.dirname(reviewRoot)), 'PHASE3_MEDIA_EXECUTION_REVIEW_PARENT_MISSING');
    if (!fsImpl.existsSync(reviewRoot)) fsImpl.mkdirSync(reviewRoot, { recursive: false });
    const finalDir = path.join(reviewRoot, runId);
    fail(!fsImpl.existsSync(finalDir), 'PHASE3_MEDIA_EXECUTION_RUN_ALREADY_EXISTS');
    const tempDir = path.join(reviewRoot, `.${runId}.stage-${crypto.randomBytes(8).toString('hex')}`);
    fsImpl.mkdirSync(tempDir, { recursive: false });
    try {
      const candidateOut = path.join(tempDir, 'candidate');
      fsImpl.mkdirSync(candidateOut, { recursive: false });
      copyIndexedTree(verified.candidateRoot, candidateOut, verified.candidate.index.files, fsImpl);
      const candidateIndexBytes = fsImpl.readFileSync(path.join(verified.candidateRoot, 'candidate-package-sha256.json'));
      fsImpl.writeFileSync(path.join(candidateOut, 'candidate-package-sha256.json'), candidateIndexBytes, { flag: 'wx' });
      const candidateVerify = verifyIndex(candidateOut, path.join(candidateOut, 'candidate-package-sha256.json'),
        CANDIDATE_INDEX_SHA256, 174, { fsImpl });
      const approvalDirectory = path.join(tempDir, 'detached-approvals');
      fsImpl.mkdirSync(approvalDirectory, { recursive: false });
      const detached = [
        { file: 'act5-b009-human-approval-20261004.v1.json', source: b009ApprovalPath, sha256: B009_APPROVAL_SHA256 },
        { file: 'act5-b016-human-approval-20261004.v1.json', source: b016ApprovalPath, sha256: B016_APPROVAL_SHA256 },
      ];
      for (const item of detached) {
        const bytes = fsImpl.readFileSync(item.source);
        fail(sha(bytes) === item.sha256, `PHASE3_MEDIA_EXECUTION_DETACHED_APPROVAL_CHANGED:${item.file}`);
        fsImpl.writeFileSync(path.join(approvalDirectory, item.file), bytes, { flag: 'wx' });
      }
      const stagedIndex = makeStagedIndex(candidateOut, { runId, outerIndexSha256: verified.outer.indexSha256,
        candidateIndexSha256: candidateVerify.indexSha256, fsImpl });
      stagedIndex.detachedApprovals = detached.map(item => ({ path: `detached-approvals/${item.file}`,
        bytes: fsImpl.readFileSync(path.join(approvalDirectory, item.file)).length, sha256: item.sha256 }));
      const stagedIndexBytes = Buffer.from(`${JSON.stringify(stagedIndex, null, 2)}\n`);
      const status = { schemaVersion: 'phase3-media-execution-run/1.0.0', state: 'STAGED_NOT_EXECUTED', runId,
        stagedAt: new Date().toISOString(), outerPackageIndexSha256: verified.outer.indexSha256,
        candidateIndexSha256: candidateVerify.indexSha256, stagedIndexSha256: sha(stagedIndexBytes),
        candidateFileCount: stagedIndex.fileCount, stage04ActivationRecordSha256: stage04.recordSha256,
        requestLedgerSha256: stage04.requestLedgerSha256,
        providerRequests: 0, episodeRootWrites: 0 };
      fsImpl.writeFileSync(path.join(tempDir, 'staged-candidate-index.json'), stagedIndexBytes, { flag: 'wx' });
      fsImpl.writeFileSync(path.join(tempDir, 'run-status.json'), Buffer.from(`${JSON.stringify(status, null, 2)}\n`), { flag: 'wx' });
      fsImpl.renameSync(tempDir, finalDir);
      return { status: 'PHASE3_MEDIA_CANDIDATE_STAGED', runId, runDirectory: finalDir,
        stagedIndexSha256: sha(stagedIndexBytes), candidateFileCount: stagedIndex.fileCount,
        stage04PromotedPaths: stage04.promotedPathCount, providerRequests: 0, episodeRootWrites: 0 };
    } catch (error) { try { if (fsImpl.existsSync(tempDir)) fsImpl.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {} throw error; }
  }
  function verifyStagedState({ runId, allowedAdditionalRunFiles = [] }) {
    fail(RUN_RE.test(runId || ''), 'PHASE3_MEDIA_EXECUTION_RUN_ID_INVALID');
    assertReviewRootPolicy({ episodeRoot, reviewRoot, fsImpl, allowMissingRunRoot: false });
    const runDir = path.join(reviewRoot, runId), candidateRoot = path.join(runDir, 'candidate');
    fail(fsImpl.existsSync(runDir) && fsImpl.lstatSync(runDir).isDirectory() && !fsImpl.lstatSync(runDir).isSymbolicLink(),
      'PHASE3_MEDIA_EXECUTION_STAGED_RUN_MISSING');
    const status = json(path.join(runDir, 'run-status.json'), fsImpl);
    fail(status.state === 'STAGED_NOT_EXECUTED' && status.runId === runId, 'PHASE3_MEDIA_EXECUTION_STAGED_STATUS_INVALID');
    const stagedBytes = fsImpl.readFileSync(path.join(runDir, 'staged-candidate-index.json'));
    fail(sha(stagedBytes) === status.stagedIndexSha256, 'PHASE3_MEDIA_EXECUTION_STAGED_INDEX_HASH_MISMATCH');
    const stagedIndex = JSON.parse(stagedBytes.toString('utf8'));
    fail(stagedIndex.runId === runId && stagedIndex.status === 'VERIFIED_V5_STAGED'
      && stagedIndex.sourceOuterPackageIndexSha256 === OUTER_INDEX_SHA256
      && stagedIndex.sourceCandidateIndexSha256 === CANDIDATE_INDEX_SHA256,
    'PHASE3_MEDIA_EXECUTION_STAGED_INDEX_BINDING_INVALID');
    verifyIndex(candidateRoot, path.join(candidateRoot, 'candidate-package-sha256.json'), CANDIDATE_INDEX_SHA256, 174, { fsImpl });
    verifyFilesFromList(candidateRoot, stagedIndex.files, fsImpl);
    fail(Array.isArray(stagedIndex.detachedApprovals) && stagedIndex.detachedApprovals.length === 2,
      'PHASE3_MEDIA_EXECUTION_DETACHED_APPROVAL_INDEX_INVALID');
    const expectedApprovalBindings = new Map([
      ['detached-approvals/act5-b009-human-approval-20261004.v1.json', B009_APPROVAL_SHA256],
      ['detached-approvals/act5-b016-human-approval-20261004.v1.json', B016_APPROVAL_SHA256],
    ]);
    for (const item of stagedIndex.detachedApprovals) {
      fail(expectedApprovalBindings.get(item.path) === item.sha256,
      'PHASE3_MEDIA_EXECUTION_DETACHED_APPROVAL_PATH_INVALID');
      const bytes = fsImpl.readFileSync(path.join(runDir, ...item.path.split('/')));
      fail(bytes.length === item.bytes && sha(bytes) === item.sha256,
        `PHASE3_MEDIA_EXECUTION_STAGED_APPROVAL_MISMATCH:${item.path}`);
    }
    const animationRunFiles = runId === CALIBRATION_RUN_ID && calibrationAnimationRunFilesVerifier
      ? calibrationAnimationRunFilesVerifier({ runDir, fsImpl }) : [];
    fail(Array.isArray(animationRunFiles) && animationRunFiles.every(relative => typeof relative === 'string'
      && relative.startsWith('ACT1_B009/') && !relative.split('/').includes('..')),
    'PHASE3_MEDIA_EXECUTION_ANIMATION_FILE_ALLOWLIST_INVALID');
    const expectedRunFiles = ['run-status.json', 'staged-candidate-index.json',
      'detached-approvals/act5-b009-human-approval-20261004.v1.json',
      'detached-approvals/act5-b016-human-approval-20261004.v1.json',
      ...walkFiles(candidateRoot, fsImpl).map(item => `candidate/${item}`),
      ...allowedAdditionalRunFiles, ...animationRunFiles].sort();
    fail(JSON.stringify(walkFiles(runDir, fsImpl).sort()) === JSON.stringify(expectedRunFiles),
      'PHASE3_MEDIA_EXECUTION_RUN_UNKNOWN_FILE');
    const census = deriveCensus(candidateRoot, { fsImpl });
    const outer = verifyOuterPackage({ packageDirectory, fsImpl });
    verifyDetachedApprovals({ b009ApprovalPath, b016ApprovalPath, fsImpl });
    const stage04 = verifyStage04Fn({ episodeRoot, fsImpl, runner: activationRunner });
    assertNoPhase3LocksFn(episodeRoot, fsImpl);
    fail(status.stage04ActivationRecordSha256 === stage04.recordSha256, 'PHASE3_MEDIA_EXECUTION_STAGE04_BINDING_CHANGED');
    fail(status.requestLedgerSha256 === stage04.requestLedgerSha256, 'PHASE3_MEDIA_EXECUTION_LEDGER_BINDING_CHANGED');
    fail(outer.outer.indexSha256 === stagedIndex.sourceOuterPackageIndexSha256, 'PHASE3_MEDIA_EXECUTION_OUTER_INDEX_CHANGED');
    const isAuthorizedCalibrationRun = runId === calibrationRoutes.TRUST.runId;
    if (isAuthorizedCalibrationRun) fail(status.stagedIndexSha256 === calibrationRoutes.TRUST.stagedIndexSha256,
      'PHASE3_MEDIA_EXECUTION_CALIBRATION_STAGED_INDEX_MISMATCH');
    return { status: isAuthorizedCalibrationRun ? 'PHASE3_MEDIA_EXECUTION_PREFLIGHT_PASS_CALIBRATION_READY_EXECUTION_UNAUTHORIZED'
      : 'PHASE3_MEDIA_EXECUTION_PREFLIGHT_PASS_MEDIA_PENDING_ROUTE_BLOCKED',
      runId, stagedIndexSha256: status.stagedIndexSha256, ...census, stage04: { status: stage04.record.status,
        activationRecordSha256: stage04.recordSha256, promotedPathCount: stage04.promotedPathCount,
        promotedPathsMatch: true }, requestLedgerSha256: stage04.requestLedgerSha256,
      providerRequests: 0, episodeRootWrites: 0 };
  }
  function preflight({ runId, includeSourceStillCalibration = false, completedSourceStillVerification = null } = {}) {
    const runDir = path.join(reviewRoot, runId);
    const allowedAdditionalRunFiles = fsImpl.existsSync(runDir)
      ? recognizedCalibrationFiles(runDir, { includeTemporary: true, includeSourceStill: includeSourceStillCalibration }) : [];
    if (completedSourceStillVerification !== null) {
      const proof = completedSourceStillVerification;
      const expectedFiles = Object.values(CALIBRATION_SOURCE_STILL_FILES)
        .filter(relative => !relative.endsWith('/source-still.lock') && !relative.endsWith('/source-still-failure-receipt.v1.json'))
        .sort();
      fail(runId === CALIBRATION_RUN_ID
        && proof?.schemaVersion === 'phase3-act1-b009-completed-source-still-verification/1.0.0'
        && proof.status === 'COMPLETED_SOURCE_STILL_APPROVED_FOR_ANIMATION_INPUT_ONLY'
        && proof.runId === CALIBRATION_RUN_ID && proof.beatId === 'ACT1_B009'
        && proof.requestKey === 'f10feb2552874270ce4af7705e5648e4beede07faedfa2a72072ba6633afdd02'
        && proof.approvalSha256 === '8b2c41cff79bac73a89e22d80a953517091acaa98bc110d6447da06e835b548c'
        && proof.authorizationSha256 === '0b3b6ca57f7a8895a97bc5a67501704cbbf74a437c7053d99b0882499b5a3599'
        && proof.receiptSha256 === '95b75386224f14b213750667cd4715705e28428f5d868d545cfe7c0036294285'
        && proof.ledgerSha256 === 'f59d219075a2e94476f94b74dd444517980599ad50be499e6c682838ee6c7823'
        && proof.outputSha256 === '0a9c9311c20da7dc774b1695f9abe2ea56f648fc0eb2450a8c7f0c4130b9ffdc'
        && proof.historicalRuntimeHashes?.moduleSha256 === 'c3356b2db07b0d2a954a88ebc188e2eb20cdef4a17f4b9c6e5f8c6ec168ee439'
        && proof.historicalRuntimeHashes?.executionModuleSha256 === '206fa77609e681e18dd62708208a2dc47eebbcc9d666c46bb8d231b02f2dc79e'
        && proof.historicalRuntimeHashes?.cliSha256 === '15f206469da1ba11f50c8b1596688cb123ae3b5c8f2b8ea21ceb0fba35e42c86'
        && JSON.stringify(proof.allowedRunFiles) === JSON.stringify(expectedFiles),
      'PHASE3_MEDIA_EXECUTION_COMPLETED_SOURCE_STILL_PROOF_INVALID');
      allowedAdditionalRunFiles.push(...proof.allowedRunFiles);
    }
    const result = verifyStagedState({ runId, allowedAdditionalRunFiles });
    if (completedSourceStillVerification) result.completedSourceStill = {
      status: completedSourceStillVerification.status,
      beatId: completedSourceStillVerification.beatId,
      requestKey: completedSourceStillVerification.requestKey,
      authorizationSha256: completedSourceStillVerification.authorizationSha256,
      receiptSha256: completedSourceStillVerification.receiptSha256,
      ledgerSha256: completedSourceStillVerification.ledgerSha256,
      outputSha256: completedSourceStillVerification.outputSha256,
      approvalSha256: completedSourceStillVerification.approvalSha256,
      historicalRuntimeHashes: completedSourceStillVerification.historicalRuntimeHashes,
      productionReadiness: 'REJECTED',
    };
    return result;
  }
  function assertCalibrationScope({ runId, beatId, operation = CALIBRATION_OPERATION } = {}) {
    fail(runId === CALIBRATION_RUN_ID, 'PHASE3_CALIBRATION_RUN_FORBIDDEN');
    fail(beatId === CALIBRATION_BEAT_ID, 'PHASE3_CALIBRATION_BEAT_FORBIDDEN');
    fail(operation === CALIBRATION_OPERATION, 'PHASE3_CALIBRATION_OPERATION_FORBIDDEN');
  }
  function runDirectory(runId) {
    const runDir = path.join(reviewRoot, runId);
    fail(fsImpl.existsSync(runDir) && fsImpl.lstatSync(runDir).isDirectory()
      && !fsImpl.lstatSync(runDir).isSymbolicLink(), 'PHASE3_MEDIA_EXECUTION_STAGED_RUN_MISSING');
    return runDir;
  }
  function calibrationRequestFromBaseline(baseline) {
    const request = baseline.calibrationRoutePlan?.requests?.find(item => item.beatId === CALIBRATION_BEAT_ID
      && item.operation === CALIBRATION_OPERATION);
    fail(request?.endpoint === CALIBRATION_ENDPOINT && request.requestKey === CALIBRATION_REQUEST_KEY,
      'PHASE3_CALIBRATION_REQUEST_BINDING_MISMATCH');
    fail(request.positivePromptSha256 === CALIBRATION_POSITIVE_PROMPT_SHA256
      && request.negativeInstructionsSha256 === CALIBRATION_NEGATIVE_INSTRUCTIONS_SHA256
      && request.submittedPromptSha256 === CALIBRATION_SERIALIZED_PROMPT_SHA256
      && sha(Buffer.from(request.positivePrompt, 'utf8')) === CALIBRATION_POSITIVE_PROMPT_SHA256
      && sha(Buffer.from(request.negativeInstructions, 'utf8')) === CALIBRATION_NEGATIVE_INSTRUCTIONS_SHA256
      && sha(Buffer.from(request.submittedPrompt, 'utf8')) === CALIBRATION_SERIALIZED_PROMPT_SHA256,
    'PHASE3_CALIBRATION_PROMPT_BINDING_MISMATCH');
    fail(canonicalJson(request.parameters) === canonicalJson({ resolution: '1k', aspect_ratio: '16:9',
      output_format: 'png', enable_prompt_expansion: false }) && request.exactlyOneImage === true,
    'PHASE3_CALIBRATION_REQUEST_PARAMETERS_INVALID');
    return request;
  }
  function recognizedCalibrationFiles(runDir, { includeTemporary = false, includeSourceStill = false } = {}) {
    const present = [...Object.values(CALIBRATION_FILES), ...(includeSourceStill ? Object.values(CALIBRATION_SOURCE_STILL_FILES) : [])]
      .filter(relative => fsImpl.existsSync(calibrationPath(runDir, relative)));
    if (includeTemporary) for (const beatId of includeSourceStill ? [CALIBRATION_BEAT_ID, 'ACT1_B009'] : [CALIBRATION_BEAT_ID]) {
      const beatDir = calibrationPath(runDir, beatId);
      if (!fsImpl.existsSync(beatDir)) continue;
      const stat = fsImpl.lstatSync(beatDir);
      fail(stat.isDirectory() && !stat.isSymbolicLink(), 'PHASE3_CALIBRATION_DIRECTORY_INVALID');
      for (const name of fsImpl.readdirSync(beatDir)) {
        const relative = `${beatId}/${name}`;
        if (name.includes('.tmp-') && !present.includes(relative)) present.push(relative);
      }
    }
    return present.sort();
  }
  function makeTerminalResult(base) {
    const withoutBinding = { schemaVersion: CALIBRATION_RESULT_SCHEMA, ...base };
    return { ...withoutBinding, resultBindingSha256: sha(Buffer.from(canonicalJson(withoutBinding), 'utf8')) };
  }
  function makeGenerationReceipt(base) {
    const withoutBinding = { schemaVersion: CALIBRATION_RECEIPT_SCHEMA, ...base };
    return { ...withoutBinding, receiptBindingSha256: sha(Buffer.from(canonicalJson(withoutBinding), 'utf8')) };
  }
  function verifySelfBinding(record, bindingField, code) {
    const supplied = record?.[bindingField], base = { ...record };
    delete base[bindingField];
    fail(/^[a-f0-9]{64}$/u.test(supplied || '')
      && supplied === sha(Buffer.from(canonicalJson(base), 'utf8')), code);
  }
  async function generateCalibrationStill({ runId, beatId, expectedAuthorizationSha256,
    operation = CALIBRATION_OPERATION } = {}) {
    assertCalibrationScope({ runId, beatId, operation });
    fail(/^[a-f0-9]{64}$/u.test(expectedAuthorizationSha256 || ''),
      'PHASE3_CALIBRATION_EXPECTED_AUTHORIZATION_HASH_REQUIRED');
    const runDir = runDirectory(runId), authorizationPath = calibrationPath(runDir, CALIBRATION_FILES.authorization);
    strictRealFile(authorizationPath, fsImpl, 'PHASE3_CALIBRATION_EXECUTION_AUTHORIZATION_MISSING');
    const beatDir = calibrationPath(runDir, CALIBRATION_BEAT_ID);
    fail(fsImpl.existsSync(beatDir) && fsImpl.lstatSync(beatDir).isDirectory()
      && !fsImpl.lstatSync(beatDir).isSymbolicLink(), 'PHASE3_CALIBRATION_DIRECTORY_INVALID');
    const initialAllowed = recognizedCalibrationFiles(runDir);
    const initialBaseline = verifyStagedState({ runId, allowedAdditionalRunFiles: initialAllowed });
    calibrationRequestFromBaseline(initialBaseline);
    const lock = acquireCalibrationLock(runDir, fsImpl);
    const ledgerPath = calibrationPath(runDir, CALIBRATION_FILES.ledger);
    const outputPath = calibrationPath(runDir, CALIBRATION_FILES.output);
    const receiptPath = calibrationPath(runDir, CALIBRATION_FILES.receipt);
    const resultPath = calibrationPath(runDir, CALIBRATION_FILES.result);
    let reservation = null, providerMetadata = null, providerRequestId = null, actualChargeUsd = null;
    try {
      const runtimeHashes = calibrationRuntimeHashes({ executionModulePath, cliPath, fsImpl });
      const authorization = loadCalibrationAuthorization({ runDir, expectedSha256: expectedAuthorizationSha256,
        runtimeHashes, fsImpl });
      const baseline = verifyStagedState({ runId,
        allowedAdditionalRunFiles: recognizedCalibrationFiles(runDir) });
      const request = calibrationRequestFromBaseline(baseline);
      if (fsImpl.existsSync(ledgerPath)) {
        const existingLedger = readCalibrationLedger(ledgerPath, fsImpl);
        fail(!existingLedger.some(item => item.recordType === 'SUBMISSION_RESERVED'),
          'PHASE3_CALIBRATION_REQUEST_ALREADY_CONSUMED');
      }
      fail(!fsImpl.existsSync(resultPath), 'PHASE3_CALIBRATION_TERMINAL_RESULT_EXISTS');
      fail(!fsImpl.existsSync(outputPath) && !fsImpl.existsSync(receiptPath),
        'PHASE3_CALIBRATION_OUTPUT_ALREADY_EXISTS');
      fail(canonicalJson(recognizedCalibrationFiles(runDir)) === canonicalJson([
        CALIBRATION_FILES.authorization, CALIBRATION_FILES.lock].sort()),
      'PHASE3_CALIBRATION_RUN_ALREADY_USED');
      fail(!fsImpl.existsSync(ledgerPath) && !fsImpl.existsSync(resultPath) && !fsImpl.existsSync(outputPath)
        && !fsImpl.existsSync(receiptPath), 'PHASE3_CALIBRATION_REQUEST_ALREADY_CONSUMED');
      reservation = appendCalibrationLedgerRecord(ledgerPath, {
        schemaVersion: CALIBRATION_LEDGER_SCHEMA,
        recordType: 'SUBMISSION_RESERVED',
        sequence: 1,
        runId,
        beatId,
        operation: CALIBRATION_OPERATION,
        provider: 'fal.ai',
        endpoint: CALIBRATION_ENDPOINT,
        requestKey: CALIBRATION_REQUEST_KEY,
        authorizationSha256: authorization.sha256,
        stagedIndexSha256: baseline.stagedIndexSha256,
        candidateIndexSha256: CANDIDATE_INDEX_SHA256,
        outerIndexSha256: OUTER_INDEX_SHA256,
        routeResolutionApprovalSha256: calibrationRoutes.ROUTE_APPROVAL_SHA256,
        deployedExecutionModuleSha256: runtimeHashes.executionModuleSha256,
        deployedCliSha256: runtimeHashes.cliSha256,
        positivePromptSha256: CALIBRATION_POSITIVE_PROMPT_SHA256,
        negativeInstructionsSha256: CALIBRATION_NEGATIVE_INSTRUCTIONS_SHA256,
        serializedPromptSha256: CALIBRATION_SERIALIZED_PROMPT_SHA256,
        parameters: { resolution: '1k', aspect_ratio: '16:9', output_format: 'png', num_images: 1,
          enable_prompt_expansion: false },
        retryAllowed: false,
        fallbackAllowed: false,
        assetClass: CALIBRATION_ASSET_CLASS,
        reservedAt: now(),
      }, fsImpl);
      if (typeof testHooks.afterReservation === 'function') await testHooks.afterReservation({ reservation, runDir });
      fail(provider && typeof provider.generateStill === 'function', 'PHASE3_CALIBRATION_PROVIDER_ADAPTER_MISSING');
      const providerResult = await provider.generateStill({ endpoint: CALIBRATION_ENDPOINT,
        input: { prompt: request.submittedPrompt, resolution: '1k', aspect_ratio: '16:9', output_format: 'png',
          num_images: 1, enable_prompt_expansion: false }, retries: 0, fallback: false });
      fail(providerResult && providerResult.imageCount === 1, 'PHASE3_CALIBRATION_PROVIDER_RESPONSE_INVALID');
      fail(typeof providerResult.url === 'string' && providerResult.url.length > 0,
        'PHASE3_CALIBRATION_PROVIDER_IMAGE_URL_MISSING');
      providerRequestId = typeof providerResult.providerRequestId === 'string' && providerResult.providerRequestId
        ? providerResult.providerRequestId : null;
      actualChargeUsd = Number.isFinite(providerResult.actualChargeUsd) ? providerResult.actualChargeUsd : null;
      fail(actualChargeUsd === null || (actualChargeUsd >= 0 && actualChargeUsd <= CALIBRATION_MAX_EXPOSURE_USD),
        'PHASE3_CALIBRATION_ACTUAL_CHARGE_EXCEEDS_ACCEPTED_EXPOSURE');
      providerMetadata = jsonSafeMetadata(providerResult.rawProviderResponseMetadata);
      const downloaded = await downloader(providerResult.url, { runDir, beatId, requestKey: CALIBRATION_REQUEST_KEY });
      const imageBytes = Buffer.from(downloaded?.bytes || []);
      fail(imageBytes.length > 0 && imageBytes.length <= MAX_CALIBRATION_IMAGE_BYTES,
        'PHASE3_CALIBRATION_OUTPUT_SIZE_INVALID');
      const contentType = String(downloaded?.contentType || '').split(';')[0].trim().toLowerCase();
      fail(!contentType || contentType === 'image/png', 'PHASE3_CALIBRATION_OUTPUT_CONTENT_TYPE_INVALID');
      const media = pngInfo(imageBytes), outputSha256 = sha(imageBytes);
      writeBytesAtomicExclusive(outputPath, imageBytes, fsImpl);
      if (typeof testHooks.afterOutputWrite === 'function') await testHooks.afterOutputWrite({ outputPath, runDir });
      const persistedBytes = fsImpl.readFileSync(outputPath);
      fail(persistedBytes.length === imageBytes.length && sha(persistedBytes) === outputSha256,
        'PHASE3_CALIBRATION_OUTPUT_HASH_MISMATCH');
      const receipt = makeGenerationReceipt({
        status: 'GENERATED_PENDING_HUMAN_REVIEW',
        assetClass: CALIBRATION_ASSET_CLASS,
        ownershipDisposition: CALIBRATION_OWNERSHIP_DISPOSITION,
        runId, beatId, operation: CALIBRATION_OPERATION, endpoint: CALIBRATION_ENDPOINT,
        requestKey: CALIBRATION_REQUEST_KEY,
        authorizationSha256: authorization.sha256,
        reservationEntrySha256: reservation.entrySha256,
        bindings: { stagedIndexSha256: baseline.stagedIndexSha256, candidateIndexSha256: CANDIDATE_INDEX_SHA256,
          outerIndexSha256: OUTER_INDEX_SHA256, routeResolutionApprovalSha256: calibrationRoutes.ROUTE_APPROVAL_SHA256,
          deployedExecutionModuleSha256: runtimeHashes.executionModuleSha256,
          deployedCliSha256: runtimeHashes.cliSha256,
          positivePromptSha256: CALIBRATION_POSITIVE_PROMPT_SHA256,
          negativeInstructionsSha256: CALIBRATION_NEGATIVE_INSTRUCTIONS_SHA256,
          serializedPromptSha256: CALIBRATION_SERIALIZED_PROMPT_SHA256 },
        provider: { name: 'fal.ai', requestId: providerRequestId, actualChargeUsd,
          rawResponseMetadata: providerMetadata },
        output: { path: CALIBRATION_FILES.output, bytes: persistedBytes.length, sha256: outputSha256, ...media },
        restrictions: { productionUse: false, rendering: false, promotion: false, episodeRootWrites: false },
        completedAt: now(),
      });
      writeJsonAtomicExclusive(receiptPath, receipt, fsImpl);
      const resultRecord = appendCalibrationLedgerRecord(ledgerPath, {
        schemaVersion: CALIBRATION_LEDGER_SCHEMA, recordType: 'SUBMISSION_RESULT', requestKey: CALIBRATION_REQUEST_KEY,
        status: 'SUCCEEDED', providerRequestId, actualChargeUsd, outputSha256,
        receiptSha256: sha(fsImpl.readFileSync(receiptPath)), errorCode: null, recordedAt: now(),
      }, fsImpl);
      const terminal = makeTerminalResult({ status: 'SUCCEEDED_PENDING_HUMAN_REVIEW', assetClass: CALIBRATION_ASSET_CLASS,
        runId, beatId, operation: CALIBRATION_OPERATION, requestKey: CALIBRATION_REQUEST_KEY,
        authorizationSha256: authorization.sha256, reservationEntrySha256: reservation.entrySha256,
        resultEntrySha256: resultRecord.entrySha256, ledgerSha256: sha(fsImpl.readFileSync(ledgerPath)),
        output: receipt.output, receiptSha256: sha(fsImpl.readFileSync(receiptPath)), providerRequestId,
        actualChargeUsd, rawProviderResponseMetadata: providerMetadata, errorCode: null, recordedAt: now() });
      writeJsonAtomicExclusive(resultPath, terminal, fsImpl);
      verifyStagedState({ runId, allowedAdditionalRunFiles: recognizedCalibrationFiles(runDir) });
      return { status: 'CALIBRATION_STILL_GENERATED_PENDING_HUMAN_REVIEW', runId, beatId,
        requestKey: CALIBRATION_REQUEST_KEY, output: receipt.output,
        receipt: { path: CALIBRATION_FILES.receipt, sha256: sha(fsImpl.readFileSync(receiptPath)) },
        ledger: { path: CALIBRATION_FILES.ledger, sha256: sha(fsImpl.readFileSync(ledgerPath)) },
        providerRequestId, actualChargeUsd, providerSubmissions: 1, retries: 0, fallback: false,
        productionUse: false, rendering: false, promotion: false, episodeRootWrites: false };
    } catch (error) {
      if (reservation) {
        try {
          const records = readCalibrationLedger(ledgerPath, fsImpl);
          if (!records.some(item => item.recordType === 'SUBMISSION_RESULT')) appendCalibrationLedgerRecord(ledgerPath, {
            schemaVersion: CALIBRATION_LEDGER_SCHEMA, recordType: 'SUBMISSION_RESULT',
            requestKey: CALIBRATION_REQUEST_KEY, status: 'FAILED', providerRequestId, actualChargeUsd,
            outputSha256: fsImpl.existsSync(outputPath) ? sha(fsImpl.readFileSync(outputPath)) : null,
            receiptSha256: fsImpl.existsSync(receiptPath) ? sha(fsImpl.readFileSync(receiptPath)) : null,
            errorCode: errorCode(error), recordedAt: now(),
          }, fsImpl);
          if (!fsImpl.existsSync(resultPath)) {
            const finalRecords = readCalibrationLedger(ledgerPath, fsImpl);
            const resultRecord = finalRecords.find(item => item.recordType === 'SUBMISSION_RESULT');
            const terminal = makeTerminalResult({ status: 'FAILED_REQUEST_KEY_PERMANENTLY_CONSUMED',
              assetClass: CALIBRATION_ASSET_CLASS, runId, beatId, operation: CALIBRATION_OPERATION,
              requestKey: CALIBRATION_REQUEST_KEY, authorizationSha256: expectedAuthorizationSha256,
              reservationEntrySha256: reservation.entrySha256, resultEntrySha256: resultRecord?.entrySha256 || null,
              ledgerSha256: sha(fsImpl.readFileSync(ledgerPath)),
              output: fsImpl.existsSync(outputPath) ? { path: CALIBRATION_FILES.output,
                bytes: fsImpl.readFileSync(outputPath).length, sha256: sha(fsImpl.readFileSync(outputPath)) } : null,
              receiptSha256: fsImpl.existsSync(receiptPath) ? sha(fsImpl.readFileSync(receiptPath)) : null,
              providerRequestId, actualChargeUsd, rawProviderResponseMetadata: providerMetadata,
              errorCode: errorCode(error), recordedAt: now() });
            writeJsonAtomicExclusive(resultPath, terminal, fsImpl);
          }
        } catch (_) {}
      }
      throw error;
    } finally {
      try { if (fsImpl.existsSync(lock)) fsImpl.unlinkSync(lock); } catch (_) {}
    }
  }
  function calibrationStatus({ runId, beatId } = {}) {
    assertCalibrationScope({ runId, beatId });
    const runDir = runDirectory(runId), present = recognizedCalibrationFiles(runDir, { includeTemporary: true });
    const baseline = verifyStagedState({ runId, allowedAdditionalRunFiles: present });
    const runtimeHashes = calibrationRuntimeHashes({ executionModulePath, cliPath, fsImpl });
    const file = relative => calibrationPath(runDir, relative);
    const authorizationPresent = fsImpl.existsSync(file(CALIBRATION_FILES.authorization));
    let authorizationSha256 = null, executionAuthorized = false, authorizationError = null;
    if (authorizationPresent) {
      try {
        const bytes = fsImpl.readFileSync(file(CALIBRATION_FILES.authorization));
        authorizationSha256 = sha(bytes);
        loadCalibrationAuthorization({ runDir, expectedSha256: authorizationSha256, runtimeHashes, fsImpl });
        executionAuthorized = true;
      } catch (error) { authorizationError = errorCode(error); }
    }
    const ledgerPresent = fsImpl.existsSync(file(CALIBRATION_FILES.ledger));
    const ledger = ledgerPresent ? readCalibrationLedger(file(CALIBRATION_FILES.ledger), fsImpl) : [];
    const reservation = ledger.find(item => item.recordType === 'SUBMISSION_RESERVED') || null;
    const ledgerResult = ledger.find(item => item.recordType === 'SUBMISSION_RESULT') || null;
    const resultPresent = fsImpl.existsSync(file(CALIBRATION_FILES.result));
    const terminalResult = resultPresent ? json(file(CALIBRATION_FILES.result), fsImpl) : null;
    if (terminalResult) verifySelfBinding(terminalResult, 'resultBindingSha256',
      'PHASE3_CALIBRATION_TERMINAL_RESULT_BINDING_INVALID');
    const outputPresent = fsImpl.existsSync(file(CALIBRATION_FILES.output));
    const outputBytes = outputPresent ? fsImpl.readFileSync(file(CALIBRATION_FILES.output)) : null;
    const receiptPresent = fsImpl.existsSync(file(CALIBRATION_FILES.receipt));
    const receiptBytes = receiptPresent ? fsImpl.readFileSync(file(CALIBRATION_FILES.receipt)) : null;
    const lockPresent = fsImpl.existsSync(file(CALIBRATION_FILES.lock));
    const temporaryFiles = present.filter(item => path.posix.basename(item).includes('.tmp-'));
    const safeToInvoke = executionAuthorized && !reservation && !ledgerResult && !terminalResult
      && !outputPresent && !receiptPresent && !lockPresent && temporaryFiles.length === 0;
    let status = 'EXECUTION_READY_UNAUTHORIZED';
    if (executionAuthorized && safeToInvoke) status = 'EXECUTION_AUTHORIZED_SAFE_TO_INVOKE';
    if (reservation && !terminalResult) status = 'REQUEST_RESERVED_NOT_RETRYABLE';
    if (terminalResult?.status === 'SUCCEEDED_PENDING_HUMAN_REVIEW') status = 'GENERATED_PENDING_HUMAN_REVIEW';
    if (terminalResult?.status === 'FAILED_REQUEST_KEY_PERMANENTLY_CONSUMED') status = terminalResult.status;
    return { schemaVersion: 'phase3-media-calibration-status/1.0.0', status, runId, beatId,
      stagedIndexSha256: baseline.stagedIndexSha256,
      authorization: { present: authorizationPresent, sha256: authorizationSha256,
        executionAuthorized, validationError: authorizationError,
        path: CALIBRATION_FILES.authorization },
      requestSafeToInvoke: safeToInvoke,
      reservationState: reservation ? 'RESERVED' : 'ABSENT',
      terminalResultState: terminalResult?.status || 'ABSENT',
      requestKeyConsumed: Boolean(reservation),
      ledger: { present: ledgerPresent, path: ledgerPresent ? CALIBRATION_FILES.ledger : null,
        sha256: ledgerPresent ? sha(fsImpl.readFileSync(file(CALIBRATION_FILES.ledger))) : null,
        resultStatus: ledgerResult?.status || null },
      lock: { present: lockPresent, path: lockPresent ? CALIBRATION_FILES.lock : null },
      output: { present: outputPresent, path: outputPresent ? CALIBRATION_FILES.output : null,
        bytes: outputBytes?.length || null, sha256: outputBytes ? sha(outputBytes) : null },
      receipt: { present: receiptPresent, path: receiptPresent ? CALIBRATION_FILES.receipt : null,
        sha256: receiptBytes ? sha(receiptBytes) : null },
      temporaryFiles: { present: temporaryFiles.length > 0, paths: temporaryFiles },
      providerSubmissions: reservation ? 1 : 0, retries: 0, fallback: false,
      assetClass: CALIBRATION_ASSET_CLASS, productionUse: false, rendering: false,
      promotion: false, episodeRootWrites: false };
  }
  function inspectCalibrationStill({ runId, beatId } = {}) {
    const status = calibrationStatus({ runId, beatId });
    fail(status.status === 'GENERATED_PENDING_HUMAN_REVIEW'
      && !status.lock.present && !status.temporaryFiles.present,
    'PHASE3_CALIBRATION_SUCCESSFUL_GENERATION_REQUIRED');
    const runDir = runDirectory(runId), file = relative => calibrationPath(runDir, relative);
    const ledger = readCalibrationLedger(file(CALIBRATION_FILES.ledger), fsImpl);
    const reservation = ledger.find(item => item.recordType === 'SUBMISSION_RESERVED');
    const resultRecord = ledger.find(item => item.recordType === 'SUBMISSION_RESULT');
    fail(ledger.length === 2 && reservation?.requestKey === CALIBRATION_REQUEST_KEY
      && resultRecord?.requestKey === CALIBRATION_REQUEST_KEY && resultRecord.status === 'SUCCEEDED',
    'PHASE3_CALIBRATION_LEDGER_SUCCESS_BINDING_INVALID');
    const terminal = json(file(CALIBRATION_FILES.result), fsImpl);
    verifySelfBinding(terminal, 'resultBindingSha256', 'PHASE3_CALIBRATION_TERMINAL_RESULT_BINDING_INVALID');
    const receiptBytes = fsImpl.readFileSync(file(CALIBRATION_FILES.receipt));
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    verifySelfBinding(receipt, 'receiptBindingSha256', 'PHASE3_CALIBRATION_RECEIPT_BINDING_INVALID');
    const outputBytes = fsImpl.readFileSync(file(CALIBRATION_FILES.output)), media = pngInfo(outputBytes);
    const outputSha256 = sha(outputBytes);
    fail(receipt.status === 'GENERATED_PENDING_HUMAN_REVIEW'
      && receipt.assetClass === CALIBRATION_ASSET_CLASS && receipt.runId === runId && receipt.beatId === beatId
      && receipt.operation === CALIBRATION_OPERATION && receipt.endpoint === CALIBRATION_ENDPOINT
      && receipt.requestKey === CALIBRATION_REQUEST_KEY
      && receipt.authorizationSha256 === reservation.authorizationSha256
      && receipt.reservationEntrySha256 === reservation.entrySha256
      && receipt.output.path === CALIBRATION_FILES.output && receipt.output.bytes === outputBytes.length
      && receipt.output.sha256 === outputSha256 && receipt.output.format === media.format
      && receipt.output.width === media.width && receipt.output.height === media.height
      && terminal.output?.sha256 === outputSha256 && terminal.receiptSha256 === sha(receiptBytes)
      && terminal.ledgerSha256 === sha(fsImpl.readFileSync(file(CALIBRATION_FILES.ledger)))
      && resultRecord.outputSha256 === outputSha256 && resultRecord.receiptSha256 === sha(receiptBytes),
    'PHASE3_CALIBRATION_OUTPUT_RECEIPT_OR_LEDGER_MISMATCH');
    return { schemaVersion: 'phase3-media-calibration-inspection/1.0.0',
      status: 'INSPECTED_PENDING_HUMAN_REVIEW', runId, beatId,
      assetClass: CALIBRATION_ASSET_CLASS, output: { path: CALIBRATION_FILES.output,
        bytes: outputBytes.length, sha256: outputSha256, ...media },
      receipt: { path: CALIBRATION_FILES.receipt, sha256: sha(receiptBytes) },
      ledger: { path: CALIBRATION_FILES.ledger,
        sha256: sha(fsImpl.readFileSync(file(CALIBRATION_FILES.ledger))) },
      reviewerDecision: null, approved: false, promoted: false, productionUse: false,
      rendering: false, episodeRootWrites: false, filesCreatedOrModified: 0 };
  }
  function setCalibrationAnimationRunFilesVerifier(verifier) {
    fail(typeof verifier === 'function', 'PHASE3_MEDIA_EXECUTION_ANIMATION_VERIFIER_INVALID');
    calibrationAnimationRunFilesVerifier = verifier;
  }
  return { stage, preflight, generateCalibrationStill, calibrationStatus, inspectCalibrationStill,
    setCalibrationAnimationRunFilesVerifier };
}
function copyIndexedTree(sourceRoot, targetRoot, files, fsImpl) {
  for (const item of files) {
    const from = path.join(sourceRoot, ...item.path.split('/'));
    const to = path.join(targetRoot, ...item.path.split('/'));
    fsImpl.mkdirSync(path.dirname(to), { recursive: true });
    fsImpl.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    const bytes = fsImpl.readFileSync(to);
    fail(bytes.length === item.bytes && sha(bytes) === item.sha256, `PHASE3_MEDIA_EXECUTION_COPY_MISMATCH:${item.path}`);
  }
}
function verifyFilesFromList(root, files, fsImpl) {
  fail(Array.isArray(files) && files.length === 175, 'PHASE3_MEDIA_EXECUTION_STAGED_FILE_COUNT_INVALID');
  const expected = new Map();
  for (const item of files) {
    fail(safeRel(item.path) && !expected.has(item.path), 'PHASE3_MEDIA_EXECUTION_STAGED_INDEX_DUPLICATE');
    expected.set(item.path, item);
  }
  for (const [rel, item] of expected) {
    const full = path.join(root, ...rel.split('/'));
    fail(fsImpl.existsSync(full), `PHASE3_MEDIA_EXECUTION_STAGED_FILE_MISSING:${rel}`);
    const st = fsImpl.lstatSync(full), bytes = fsImpl.readFileSync(full);
    fail(st.isFile() && !st.isSymbolicLink() && bytes.length === item.bytes && sha(bytes) === item.sha256,
      `PHASE3_MEDIA_EXECUTION_STAGED_FILE_MISMATCH:${rel}`);
  }
  fail(JSON.stringify(walkFiles(root, fsImpl).sort()) === JSON.stringify([...expected.keys()].sort()),
    'PHASE3_MEDIA_EXECUTION_STAGED_UNKNOWN_FILE');
}
function verifyDetachedApprovals({ b009ApprovalPath, b016ApprovalPath, fsImpl = fs } = {}) {
  fail(typeof b009ApprovalPath === 'string' && typeof b016ApprovalPath === 'string', 'PHASE3_MEDIA_EXECUTION_DETACHED_APPROVALS_REQUIRED');
  for (const [label, file, hash] of [['B009', b009ApprovalPath, B009_APPROVAL_SHA256],
    ['B016', b016ApprovalPath, B016_APPROVAL_SHA256]]) {
    fail(fsImpl.existsSync(file), `PHASE3_MEDIA_EXECUTION_${label}_APPROVAL_MISSING`);
    const st = fsImpl.lstatSync(file), bytes = fsImpl.readFileSync(file);
    fail(st.isFile() && !st.isSymbolicLink() && sha(bytes) === hash,
      `PHASE3_MEDIA_EXECUTION_${label}_APPROVAL_HASH_MISMATCH`);
    const approval = JSON.parse(bytes.toString('utf8'));
    fail((approval.decision === 'APPROVED' || approval.status === 'APPROVED')
      && (approval.approvedBy === 'Yakubu Moshood' || approval.reviewer === 'Yakubu Moshood'),
      `PHASE3_MEDIA_EXECUTION_${label}_APPROVAL_INVALID`);
    if (label === 'B009') fail(approval.bindings?.amendmentSha256 === B009_AMENDMENT_SHA256,
      'PHASE3_MEDIA_EXECUTION_B009_APPROVAL_BINDING_INVALID');
    if (label === 'B016') fail(approval.bindings?.stage04ActivationRecordSha256 === STAGE04_ACTIVATION_SHA256
      && approval.bindings?.stage04PromotedPathCount === 147
      && approval.bindings?.inventoryResult?.providerRequests === 0
      && approval.bindings?.inventoryResult?.remoteWrites === 0
      && approval.bindings?.inventoryResult?.episodeRootWrites === 0,
    'PHASE3_MEDIA_EXECUTION_B016_APPROVAL_BINDING_INVALID');
  }
  return true;
}
function assertReviewRootPolicy({ episodeRoot, reviewRoot, fsImpl = fs, allowMissingRunRoot = true } = {}) {
  const expected = path.resolve(episodeRoot, '.review', 'phase3-media-execution');
  fail(path.resolve(reviewRoot) === expected, 'PHASE3_MEDIA_EXECUTION_REVIEW_ROOT_INVALID');
  for (const target of [path.resolve(episodeRoot), path.join(path.resolve(episodeRoot), '.review')]) {
    fail(fsImpl.existsSync(target), 'PHASE3_MEDIA_EXECUTION_REVIEW_PARENT_MISSING');
    const stat = fsImpl.lstatSync(target);
    fail(stat.isDirectory() && !stat.isSymbolicLink(), 'PHASE3_MEDIA_EXECUTION_REVIEW_PARENT_INVALID');
  }
  if (fsImpl.existsSync(expected)) {
    const stat = fsImpl.lstatSync(expected);
    fail(stat.isDirectory() && !stat.isSymbolicLink(), 'PHASE3_MEDIA_EXECUTION_REVIEW_ROOT_INVALID');
  } else fail(allowMissingRunRoot, 'PHASE3_MEDIA_EXECUTION_REVIEW_ROOT_MISSING');
  return expected;
}

module.exports = { OUTER_INDEX_SHA256, CANDIDATE_INDEX_SHA256, B015_APPROVAL_SHA256, B016_DEPENDENCY_SHA256,
  B009_AMENDMENT_SHA256, B009_APPROVAL_SHA256, B016_APPROVAL_SHA256, STAGE04_RUN_ID, STAGE04_ACTIVATION_SHA256,
  REQUEST_LEDGER_SHA256, CALIBRATION_AUTHORIZATION_SCHEMA, CALIBRATION_LEDGER_SCHEMA,
  CALIBRATION_RESULT_SCHEMA, CALIBRATION_RECEIPT_SCHEMA, CALIBRATION_RUN_ID, CALIBRATION_BEAT_ID,
  CALIBRATION_OPERATION, CALIBRATION_ENDPOINT, CALIBRATION_REQUEST_KEY, CALIBRATION_POSITIVE_PROMPT_SHA256,
  CALIBRATION_NEGATIVE_INSTRUCTIONS_SHA256, CALIBRATION_SERIALIZED_PROMPT_SHA256,
  CALIBRATION_ASSET_CLASS, CALIBRATION_OWNERSHIP_DISPOSITION, CALIBRATION_MAX_EXPOSURE_USD,
  CALIBRATION_AUTHORIZATION_STATEMENT, CALIBRATION_FILES, CALIBRATION_SOURCE_STILL_FILES,
  EXPECTED_METHODS, RUN_RE, sha, safeRel, walkFiles, verifyIndex, verifyOuterPackage, verifyApprovalBindings,
  verifyDetachedApprovals, verifyStage04, assertNoPhase3Locks, deriveCensus, makeStagedIndex, createMediaExecution,
  verifyStage04StagedContext, verifyFilesFromList, copyIndexedTree, assertReviewRootPolicy,
  calibrationRuntimeHashes, makeCalibrationAuthorizationTemplate, validateCalibrationAuthorizationRecord,
  loadCalibrationAuthorization, readCalibrationLedger, appendCalibrationLedgerRecord, acquireCalibrationLock,
  downloadCalibrationImage, createFalCalibrationProvider, pngInfo, errorCode };
