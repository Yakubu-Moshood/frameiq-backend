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

function fail(ok, code) { if (!ok) throw new Error(code); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
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
function verifyStage04({ episodeRoot, fsImpl = fs, runner = activation } = {}) {
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
  const staged = runner.verifyStagedCandidateIndexes({ runId: STAGE04_RUN_ID, candidateDirectory,
    reviewDirectory: runDir });
  fail(staged && staged.stagedFileCount === 151, 'PHASE3_MEDIA_EXECUTION_STAGE04_STAGED_INDEX_INVALID');
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
  const routes = { still: { implementedFalEndpoint: 'fal-ai/flux/dev',
      otherImplementedModels: ['gpt-image-1', 'stability-ai/sdxl'],
      requiredApprovedRoute: 'FLUX 3 text-to-image', requiredRouteImplemented: false,
      availableForProduction: false, clarification: 'fal-ai/flux/dev is not FLUX 3.' },
    animation: { implementedFalEndpoint: 'fal-ai/kling-video/v1.6/standard/image-to-video',
      otherImplementedModel: 'christophy/stable-video-diffusion', selectedProductionRoute: null,
      approvedProductionRoute: false, availableForProduction: false,
      exclusions: ['Kling 1.6 is not an approved production route', 'FramePack is not an approved production route'] },
    blockingCondition: 'NO_IMPLEMENTED_AND_APPROVED_STILL_AND_ANIMATION_ROUTE_BUNDLE' };
  return { activeShots: shots.length, finalOutputCounts: finalCounts, finalOutputTotal: finalTotal,
    intermediateAnimationSourceStills: { required: 23, missing: counts.animationSourceStills,
      excludedFromFinalOutputTotal: true }, missingFinalOutputs: counts, unresolvedBeatIds: missingFinals,
    resolvedDeterministicGraphics: { manifestEntries: graphicManifest.entries.length,
      verifiedAssetFiles: graphicAssetCount, approvedCompiledPngOutputs: 2,
      validation: graphicValidation.status },
    resolvedEvidenceAssets: { approvedEntries: evidenceManifest.entries.length, verifiedAssetFiles: evidenceAssetCount,
      validation: evidenceValidation.status }, productionRouteAvailability: routes,
    singleCalibrationAuthorizationBlocker: routes.blockingCondition,
    calibrationBatch: { beats: calibration, structuralStatus: 'PASS', executionStatus: 'BLOCKED_PRODUCTION_ROUTE_UNAVAILABLE' },
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
function createMediaExecution({ packageDirectory, episodeRoot, reviewRoot, fsImpl = fs, activationRunner = activation,
  b009ApprovalPath, b016ApprovalPath, verifyStage04Fn = verifyStage04,
  assertNoPhase3LocksFn = assertNoPhase3Locks } = {}) {
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
  function preflight({ runId }) {
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
    const expectedRunFiles = ['run-status.json', 'staged-candidate-index.json',
      'detached-approvals/act5-b009-human-approval-20261004.v1.json',
      'detached-approvals/act5-b016-human-approval-20261004.v1.json',
      ...walkFiles(candidateRoot, fsImpl).map(item => `candidate/${item}`)].sort();
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
    return { status: census.calibrationBatch.executionStatus === 'BLOCKED_PRODUCTION_ROUTE_UNAVAILABLE'
      ? 'PHASE3_MEDIA_EXECUTION_PREFLIGHT_PASS_MEDIA_PENDING_ROUTE_BLOCKED' : 'PHASE3_MEDIA_EXECUTION_PREFLIGHT_PASS',
      runId, stagedIndexSha256: status.stagedIndexSha256, ...census, stage04: { status: stage04.record.status,
        activationRecordSha256: stage04.recordSha256, promotedPathCount: stage04.promotedPathCount,
        promotedPathsMatch: true }, requestLedgerSha256: stage04.requestLedgerSha256,
      providerRequests: 0, episodeRootWrites: 0 };
  }
  return { stage, preflight };
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
  REQUEST_LEDGER_SHA256,
  EXPECTED_METHODS, RUN_RE, sha, safeRel, walkFiles, verifyIndex, verifyOuterPackage, verifyApprovalBindings,
  verifyDetachedApprovals, verifyStage04, assertNoPhase3Locks, deriveCensus, makeStagedIndex, createMediaExecution,
  verifyFilesFromList, copyIndexedTree, assertReviewRootPolicy };
