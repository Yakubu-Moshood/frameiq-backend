'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const preview = require('../scripts/phase3-render-preview.cjs');
const activationRunner = require('../scripts/phase2.3b-p-activate.cjs');
const productionMethods = require('../pipeline-updates/production-method-manifest.cjs');
const phase3Media = require('../pipeline-updates/phase3-render-media-adapter.cjs');

const PHASE2_RUN = 'phase2-3b-p-act3-refresh-20260928-stage04';
const PHASE3_RUN = 'phase3-preview-test01';
const PHASE3_PROFILE = require('../pipeline-updates/surface-renderer.cjs').PHASE3_PREVIEW_SETTINGS;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'eo-phase3-')); }
function fixture() {
  const root = tempRoot();
  const review = path.join(root, '.review', `phase2.3b-p-activation-${PHASE2_RUN}`);
  const candidate = path.join(review, 'candidate');
  const files = [];
  for (let i = 0; i < 147; i += 1) {
    const relative = i === 0 ? 'assets/evidence/evidence.svg'
      : i === 1 ? 'assets/graphics/graphic.svg'
        : `fixture/input-${String(i).padStart(3, '0')}.json`;
    const bytes = Buffer.from(`fixture-${i}`);
    const target = path.join(root, ...relative.split('/'));
    const staged = path.join(candidate, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(target, bytes);
    fs.writeFileSync(staged, bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
  }
  fs.mkdirSync(review, { recursive: true });
  const ledgerPath = path.join(root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
  const ledgerSha = sha(fs.readFileSync(ledgerPath));
  return { root, review, candidate, files, ledgerPath, ledgerSha };
}
function verified(f) {
  return {
    root: f.root,
    activationRecord: { status: 'PROMOTED', runId: PHASE2_RUN, candidateFiles: f.files },
    activationRecordSha256: 'a'.repeat(64), promotedPaths: f.files.map(file => file.path),
    candidateReport: { retiredBeatIds: ['ACT3B_B010'] }, durationSec: 633.782449, sourceDurationSec: 633.782449,
    expectedFrames: 19020, shotCount: 153, evidenceCount: 46, evidenceAssetCount: 29,
    graphicsCount: 76, timestampRows: 1352, timestampsSha256: 'b'.repeat(64),
    audioInputs: [], requestLedgerSha256: f.ledgerSha, ledgerSha256: f.ledgerSha,
    mediaStrategyCensus: { totalShotsChecked: 153,
      countsByFinalStrategy: { DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71, STILL_IMAGE: 43, VIDEO_CLIP: 23 },
      documentCards: 16, htmlDocuments: 0, pdfDocuments: 0, svgAssets: 76,
      rasterStillAssets: 43, videoClipAssets: 23, missingStillOutputs: 0, missingClipOutputs: 0,
      resolvedCount: 153, unresolvedCount: 0, unresolvedBeatIds: [] },
    stagedShotValidation: { revisionChain: [] },
    editPlan: { episodeId: 'test-episode' },
  };
}
function toolCommand(_command, args) {
  if (args.includes('-encoders')) return ' V.... libx264\n A.... aac\n';
  if (args.includes('-count_frames')) return JSON.stringify({
    streams: [
      { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1280, height: 720,
        avg_frame_rate: '30/1', nb_read_frames: '19020', pix_fmt: 'yuv420p' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', bit_rate: '128000' },
    ], format: { duration: '634.000000' },
  });
  if (args.includes('-version')) return `${args[0] === '-version' ? 'tool' : 'ffprobe'} version test\n`;
  return JSON.stringify({ streams: [{ codec_name: 'mp3', sample_rate: '44100', bit_rate: '128000' }], format: { duration: '1' } });
}
function makeService(f, overrides = {}) {
  const verifiedResult = verified(f);
  let renderCalls = 0;
  const service = preview.createPhase3Preview({
    root: f.root,
    expectedLedgerSha256: f.ledgerSha,
    runCommand: overrides.runCommand || toolCommand,
    capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath },
    verifyInputsFn: overrides.verifyInputsFn || (() => verifiedResult),
    renderFn: overrides.renderFn || (async ({ episodeDir, outputFilename }) => {
      renderCalls += 1;
      fs.writeFileSync(path.join(episodeDir, 'output', outputFilename), Buffer.from('rendered-preview'));
      return { ffmpegArguments: ['ffmpeg -y -v error -c:v libx264 -preset veryfast -crf 26 -r 30'] };
    }),
    clock: () => new Date('2026-10-01T12:00:00.000Z'),
  });
  return { service, verifiedResult, renderCalls: () => renderCalls };
}
function options(root, runId = PHASE3_RUN) {
  return { promotedRunId: PHASE2_RUN, phase3RunId: runId,
    outputDir: path.join(root, '.review', 'phase3-renders', runId, 'output') };
}

test('read-only preflight validates without creating a run directory or invoking the renderer', () => {
  const f = fixture();
  try {
    const { service, renderCalls } = makeService(f);
    const report = service.preflight(options(f.root));
    assert.equal(report.status, 'PHASE3_RENDER_PREFLIGHT_PASS');
    assert.equal(report.expectedFrames, 19020);
    assert.equal(report.width, 1280);
    assert.equal(renderCalls(), 0);
    assert.equal(fs.existsSync(path.dirname(report.outputPath)), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('render succeeds in isolation, writes a bound receipt, and releases its lock', async () => {
  const f = fixture();
  try {
    const { service } = makeService(f);
    const result = await service.render(options(f.root));
    assert.equal(result.status, 'PHASE3_RENDER_SUCCESS');
    assert.equal(result.receipt.status, 'RENDER_COMPLETE');
    assert.equal(result.receipt.output.path, 'output/empire-omitted-v3-phase3-preview-01.mp4');
    assert.equal(result.receipt.expectedFrames, 19020);
    assert.equal(result.receipt.requestLedgerSha256Before, f.ledgerSha);
    assert.equal(result.receipt.requestLedgerSha256After, f.ledgerSha);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN, 'phase3-render.lock')), false);
    assert.deepEqual(PHASE3_PROFILE, { width: 1280, height: 720, fps: 30, preset: 'veryfast', crf: 26, audioBitrate: '128k' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('non-promoted activation record is rejected', () => {
  const f = fixture();
  try {
    const recordPath = path.join(f.review, 'activation-record.json');
    fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 'phase2.3b-p-activation-record/1.0.0',
      status: 'CANDIDATE_STAGED', runId: PHASE2_RUN, candidateFiles: f.files }));
    assert.throws(() => preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN,
      runner: { assertNoActivationLocks() {} } }), /PHASE3_PROMOTION_RECORD_NOT_PROMOTED/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('altered promoted file is rejected by the 147-file hash verification', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, ...f.files[4].path.split('/')), 'altered');
    assert.throws(() => preview.verifyIndexedFiles(f.root, f.files), /PHASE3_PROMOTED_INPUT_HASH_MISMATCH/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Stage04 real package uses the approved locked plan from its promotion backup, not the retimed root plan', () => {
  const candidateDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const approvedPackageDirectory = activationRunner.REFRESHED_BINDING_PACKAGE_DIR;
  const source = activationRunner.verifyIndexedCandidateDirectory({ directory: candidateDirectory,
    expectedIndexSha256: activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256, expectedCount: 150 });
  const approved = activationRunner.verifyRefreshedApprovalPackage({ packageDirectory: approvedPackageDirectory,
    expectedIndexSha256: activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256 });
  const candidatePlanHash = sha(fs.readFileSync(path.join(candidateDirectory, 'edit-plan.json')));
  const preTimingPlanPath = path.join(approvedPackageDirectory, 'outputs', 'candidate-edit-plan-pretiming.json');
  const preTimingPlanHash = sha(fs.readFileSync(preTimingPlanPath));
  const boundaryPolicyHash = sha(fs.readFileSync(path.join(candidateDirectory, 'approvals', 'refreshed-boundary-policy.v2.json')));
  const policy = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'approvals', 'refreshed-boundary-policy.v2.json')));
  const lockedHash = policy.binding.lockedEditPlanSha256;
  assert.equal(source.indexSha256, activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256);
  assert.equal(approved.packageIndexSha256, activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256);
  assert.equal(boundaryPolicyHash, require('../pipeline-updates/episode-activation.cjs').REFRESHED_BOUNDARY_POLICY_SHA256);
  assert.equal(preTimingPlanHash, policy.binding.candidatePreTimingEditPlanSha256);
  assert.notEqual(preTimingPlanHash, candidatePlanHash);
  assert.notEqual(lockedHash, candidatePlanHash);

  const planIndex = source.index.files.find(item => item.path === 'edit-plan.json');
  const shotIndex = source.index.files.find(item => item.path === 'shot-definitions.json');
  const shotPackage = preview.validateStagedShotDefinitions({ candidateDirectory,
    staged: { index: source.index }, promotedFiles: [planIndex, shotIndex] });
  assert.equal(shotPackage.status, 'PASS');
  assert.equal(shotPackage.errors.length, 0);
  assert.equal(shotPackage.revisionChain.length, 4);
  assert.equal(shotPackage.plan.sequences.some(sequence => sequence.beats.some(beat => beat.beatId === 'ACT3B_B010')), false);
  assert.equal(shotPackage.shotDefs.allShots.some(shot => shot.beatId === 'ACT3B_B010'), false);

  const f = fixture();
  try {
    const backupDirectory = path.join(f.review, 'backup');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const manifest = { schemaVersion: 'phase2.3b-p-backup/1.0.0', files: [
      { path: 'edit-plan.json', existed: true, bytes: 123, sha256: lockedHash },
    ] };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    fs.writeFileSync(path.join(backupDirectory, 'backup-manifest.json'), manifestBytes);
    const record = { backupManifestSha256: sha(manifestBytes), priorHashes: { 'edit-plan.json': lockedHash } };
    let receivedValidationOptions;
    const result = preview.verifyStagedValidationContext({ runId: PHASE2_RUN, reviewDirectory: f.review,
      candidateDirectory, activationRecord: record, runner: { ...activationRunner, ROOT: f.root },
      verifyBackupFn: ({ manifest: value }) => assert.equal(value.files[0].sha256, lockedHash),
      verifyStageFn: options => { receivedValidationOptions = options.validationOptions; return { status: 'PASS' }; } });
    assert.equal(result.boundaryBackup.lockedEditPlanSha256, lockedHash);
    assert.equal(result.boundaryBackup.lockedEditPlanPath, path.join(backupDirectory, 'edit-plan.json'));
    assert.equal(receivedValidationOptions.lockedEpisodeRoot, backupDirectory);
    assert.notEqual(receivedValidationOptions.lockedEpisodeRoot, f.root);
    assert.equal(result.staged.status, 'PASS');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Stage04 shot validation rejects altered indexed plans, shots, lineage and amendment inputs', () => {
  const candidateDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const source = activationRunner.verifyIndexedCandidateDirectory({ directory: candidateDirectory,
    expectedIndexSha256: activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256, expectedCount: 150 });
  const promotedFiles = source.index.files.filter(item => ['edit-plan.json', 'shot-definitions.json'].includes(item.path));
  const cases = [
    ['edit-plan.json', value => { value.episodeId = 'changed-episode'; }],
    ['shot-definitions.json', value => { value.totalShots += 1; }],
    ['revision-lineage/phase2.3b-p-retiming.v1.json', value => { value.revisionId = 'altered-retiming'; }],
    ['revision-lineage/phase2.3b-b017-factual-correction.v1.json', value => { value.revisionId = 'altered-amendment'; }],
  ];
  for (const [relative, change] of cases) {
    const absolute = path.resolve(candidateDirectory, ...relative.split('/'));
    const fakeFs = Object.create(fs);
    fakeFs.readFileSync = (file, ...args) => {
      const bytes = fs.readFileSync(file, ...args);
      if (path.resolve(file) !== absolute) return bytes;
      const value = JSON.parse(bytes.toString('utf8'));
      change(value);
      return Buffer.from(JSON.stringify(value));
    };
    assert.throws(() => preview.validateStagedShotDefinitions({ candidateDirectory,
      staged: { index: source.index }, promotedFiles, fsImpl: fakeFs }),
    new RegExp(`PHASE3_STAGED_SHOT_CONTEXT_FILE_HASH_MISMATCH:${relative.replaceAll('/', '\\/')}`, 'u'));
  }
});

function realStage04RenderPackage() {
  const candidateDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const shotDefs = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'shot-definitions.json'), 'utf8'));
  const productionManifest = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'production-manifest.json'), 'utf8'));
  const evidenceManifest = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'evidence-source-manifest.json'), 'utf8'));
  const graphicAssetManifest = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'graphic-asset-manifest.json'), 'utf8'));
  return { candidateDirectory, shotDefs, productionManifest, evidenceManifest, graphicAssetManifest };
}

function treeIndex(directory) {
  const files = [];
  const visit = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) visit(absolute, child);
      else {
        const bytes = fs.readFileSync(absolute);
        files.push({ path: child, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  };
  visit(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function fullPreflightStage04Fixture({ includeGeneratedAssets = true } = {}) {
  const sourceDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const source = activationRunner.verifyIndexedCandidateDirectory({ directory: sourceDirectory,
    expectedIndexSha256: activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256, expectedCount: 150 });
  const root = tempRoot();
  const reviewDirectory = path.join(root, '.review', `phase2.3b-p-activation-${PHASE2_RUN}`);
  const candidateDirectory = path.join(reviewDirectory, 'candidate');
  fs.mkdirSync(candidateDirectory, { recursive: true });
  fs.cpSync(sourceDirectory, candidateDirectory, { recursive: true });
  const candidateReportPath = path.join(candidateDirectory, 'candidate-report.json');
  const candidateReport = JSON.parse(fs.readFileSync(candidateReportPath, 'utf8'));
  candidateReport.runId = PHASE2_RUN;
  candidateReport.stageSchemaVersion = 'phase2.3b-p-staged-candidate/1.0.0';
  fs.writeFileSync(candidateReportPath, `${JSON.stringify(candidateReport, null, 2)}\n`);
  const stagedIndex = { files: treeIndex(candidateDirectory) };
  const promotionPaths = activationRunner.buildPromotionWriteSet({ candidateDirectory,
    report: candidateReport, stagedIndex, fsImpl: fs });
  assert.equal(promotionPaths.length, 147);
  for (const item of promotionPaths) {
    const sourceFile = path.join(candidateDirectory, ...item.path.split('/'));
    const destination = path.join(root, ...item.path.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(sourceFile, destination);
  }
  const backupDirectory = path.join(reviewDirectory, 'backup');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const lockedPlanHash = activationRunner.approval.lockedEpisodeHashesBeforeActivation['edit-plan.json'];
  const backupManifest = { schemaVersion: 'phase2.3b-p-backup/1.0.0', files: [
    { path: 'edit-plan.json', existed: true, bytes: 0, sha256: lockedPlanHash },
  ] };
  const backupBytes = Buffer.from(`${JSON.stringify(backupManifest)}\n`);
  fs.writeFileSync(path.join(backupDirectory, 'backup-manifest.json'), backupBytes);
  const activationRecord = { schemaVersion: 'phase2.3b-p-activation-record/1.0.0', status: 'PROMOTED',
    runId: PHASE2_RUN, promotedAt: '2026-10-01T12:00:00.000Z', backupManifestSha256: sha(backupBytes),
    priorHashes: { 'edit-plan.json': lockedPlanHash }, candidateFiles: promotionPaths };
  fs.writeFileSync(path.join(reviewDirectory, 'activation-record.json'), JSON.stringify(activationRecord));
  const phase3CandidateIndex = { schemaVersion: 'phase2.3b-p-staged-candidate-index/1.0.0',
    status: 'VERIFIED_STAGED', runId: PHASE2_RUN, sourceCandidateIndexSha256: source.indexSha256,
    approvedPackageIndexSha256: activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256,
    fileCount: stagedIndex.files.length, files: stagedIndex.files };
  const stagedIndexSha256 = sha(Buffer.from(JSON.stringify(phase3CandidateIndex)));
  const stageVerifier = ({ candidateDirectory: candidate, runId }) => {
    assert.equal(runId, PHASE2_RUN);
    assert.equal(path.resolve(candidate), path.resolve(candidateDirectory));
    const actual = treeIndex(candidate);
    assert.deepEqual(actual, stagedIndex.files);
    for (const item of phase3CandidateIndex.files) {
      const bytes = fs.readFileSync(path.join(candidate, ...item.path.split('/')));
      assert.equal(bytes.length, item.bytes);
      assert.equal(sha(bytes), item.sha256);
    }
    const boundaryTiming = JSON.parse(fs.readFileSync(path.join(candidate,
      'validation/boundary-and-timing-validation.json'), 'utf8'));
    const editPlanValidation = JSON.parse(fs.readFileSync(path.join(candidate, 'edit-plan-validation.json'), 'utf8'));
    const lineageValidation = JSON.parse(fs.readFileSync(path.join(candidate,
      'validation/revision-lineage-validation.json'), 'utf8'));
    const shotValidation = preview.validateStagedShotDefinitions({ candidateDirectory: candidate,
      staged: { index: phase3CandidateIndex }, promotedFiles: promotionPaths });
    assert.equal(boundaryTiming.status, 'PASS');
    assert.equal(boundaryTiming.formalExceptions.length, 9);
    assert.equal(boundaryTiming.editorialIntentMigrations.length, 5);
    assert.equal(boundaryTiming.totalRetimedDurationSec, 633.782449);
    assert.equal(editPlanValidation.status, 'PASS');
    assert.equal(lineageValidation.status, 'PASS');
    assert.equal(shotValidation.status, 'PASS');
    assert.equal(shotValidation.errors.length, 0);
    return { status: 'PASS', index: phase3CandidateIndex, sourceIndexSha256: source.indexSha256,
      stagedIndexSha256, record: { approvedPackageIndexSha256: activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256 } };
  };
  if (includeGeneratedAssets) {
    const definitions = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'shot-definitions.json'), 'utf8'));
    const production = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'production-manifest.json'), 'utf8'));
    populateMissingGeneratedRenderAssets(root, definitions, production);
  }
  return { root, candidateDirectory, reviewDirectory, activationRecord, stagedIndex: phase3CandidateIndex,
    sourceIndexSha256: source.indexSha256, promotionPaths, stageVerifier,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function populateMissingGeneratedRenderAssets(episodeDir, shotDefs, productionManifest) {
  const assetsDir = path.join(episodeDir, 'assets');
  const methods = new Map(productionManifest.shots.map(item => [item.shotId, item.productionMethod]));
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=', 'base64');
  const videoBytes = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  const evidenceIds = new Set(JSON.parse(fs.readFileSync(path.join(activationRunner.VERIFIED_STAGE_SOURCE_DIR,
    'evidence-source-manifest.json'), 'utf8')).entries.map(item => item.shotId));
  for (const shot of shotDefs.allShots) {
    const method = methods.get(shot.shotId);
    if (evidenceIds.has(shot.shotId) || method === 'GRAPHIC_COMPILATION') continue;
    const location = productionMethods.resolveProductionAssetLocation(method);
    if (!location) continue;
    const ext = location.extensions[0];
    const target = path.join(assetsDir, location.directory, `${shot.shotId}${ext}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ext === '.mp4' ? videoBytes : pngBytes);
  }
}

test('Stage04 preflight rejects still and clip files outside its indexed promoted inputs', () => {
  const f = fullPreflightStage04Fixture();
  try {
    const renderer = require('../pipeline-updates/surface-renderer.cjs');
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const service = preview.createPhase3Preview({ root: f.root, runner, verifyStageFn: f.stageVerifier,
      verifyBackupFn: () => true, expectedLedgerSha256: ledgerHash, runCommand: toolCommand,
      capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath },
      renderFn: () => { throw new Error('preflight must not invoke renderer'); } });
    let failure;
    try { service.preflight(options(f.root, 'phase3-real-stage04-test')); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.match(failure.message, /PHASE3_RENDER_INPUT_CENSUS_FAILED:/u);
    const census = JSON.parse(failure.message.slice(failure.message.indexOf('{')));
    assert.equal(census.totalShotsChecked, 153);
    assert.equal(census.resolvedCount, 87);
    assert.equal(census.unresolvedCount, 66);
    assert.equal(census.unboundMediaAssets, 66);
    assert.equal(census.graphicSvgAssets, 76);
    assert.equal(census.documentCards, 16);
    assert.equal(census.htmlDocuments, 10);
    assert.equal(census.pdfDocuments, 6);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', 'phase3-real-stage04-test')), false);
    const verifiedInput = preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN, runner,
      verifyBackupFn: () => true, verifyStageFn: f.stageVerifier, expectedLedgerSha256: ledgerHash,
      runCommand: toolCommand });
    const shotContext = preview.validateStagedShotDefinitions({ candidateDirectory: f.candidateDirectory,
      staged: { index: f.stagedIndex }, promotedFiles: f.promotionPaths });
    const rendererShotReport = renderer.validateV3ShotDefinitionsForRender({ plan: shotContext.plan,
      shotDefs: shotContext.shotDefs, revisionChain: shotContext.revisionChain, requireVerifiedRevisionChain: true });
    assert.equal(rendererShotReport.status, 'PASS');
    assert.equal(shotContext.lineage.counts.approvedHistoricalRevisions, 23);
    const stagedBytes = fs.readFileSync(path.join(f.candidateDirectory, 'timing/word-timestamps.json'));
    assert.equal(verifiedInput.timestampsSha256, sha(stagedBytes));
    assert.equal(fs.existsSync(ledgerPath), true);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
    const renderInputDirectory = path.join(f.root, 'isolated-render-input-check');
    preview.copyPromotedInputs({ verified: { root: f.root, timestampsBytes: stagedBytes,
      activationRecord: { candidateFiles: [{ path: 'timing/word-timestamps.json', bytes: stagedBytes.length,
        sha256: sha(stagedBytes) }] } }, runDirectory: renderInputDirectory });
    assert.deepEqual(fs.readFileSync(path.join(renderInputDirectory, 'timing/word-timestamps.json')), stagedBytes);
  } finally { f.cleanup(); }
});

test('real Stage04 preflight blocks on absent still and clip outputs without creating Phase 3 files', () => {
  const f = fullPreflightStage04Fixture({ includeGeneratedAssets: false });
  const runId = 'phase3-stage04-missing-media-test';
  try {
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const service = preview.createPhase3Preview({ root: f.root, runner, verifyStageFn: f.stageVerifier,
      verifyBackupFn: () => true, expectedLedgerSha256: ledgerHash, runCommand: toolCommand,
      capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath },
      renderFn: () => { throw new Error('preflight must not render'); } });
    let failure;
    try { service.preflight(options(f.root, runId)); } catch (error) { failure = error; }
    assert.ok(failure, 'preflight unexpectedly passed with 66 missing still/clip outputs');
    assert.match(failure.message, /PHASE3_RENDER_INPUT_CENSUS_FAILED:/u);
    const census = JSON.parse(failure.message.slice(failure.message.indexOf('{')));
    assert.equal(census.totalShotsChecked, 153);
    assert.equal(census.missingStillOutputs, 43);
    assert.equal(census.missingClipOutputs, 23);
    assert.deepEqual(census.missingStillOutputsByMethod, { CONTROLLED_STILL: 34, GENERATED_STILL: 9 });
    assert.equal(census.unresolvedCount, 66);
    assert.deepEqual(census.countsByFinalStrategy,
      { DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71, STILL_IMAGE: 43, VIDEO_CLIP: 23 });
    assert.deepEqual(census.resolvedCountsByFinalStrategy,
      { DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71, STILL_IMAGE: 0, VIDEO_CLIP: 0 });
    assert.equal(census.unresolvedBeatIds.length, 66);
    assert.ok(census.unresolvedBeatIds.includes('ACT1_B005'));
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', runId)), false);
    assert.equal(fs.existsSync(path.join(f.root, 'assets', 'stills')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'assets', 'clips')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'assets', 'temp')), false);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
  } finally { f.cleanup(); }
});

test('Phase 3 renderer revalidates Stage04 shots with the complete ordered revision chain', async () => {
  const f = fullPreflightStage04Fixture();
  const rendererPath = require.resolve('../pipeline-updates/surface-renderer.cjs');
  const cachedRendererModule = require.cache[rendererPath];
  const childProcess = require('node:child_process');
  const originalExecSync = childProcess.execSync;
  const externalCommands = [];
  try {
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const verifiedInput = preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN, runner,
      verifyBackupFn: () => true, verifyStageFn: f.stageVerifier, expectedLedgerSha256: ledgerHash,
      runCommand: toolCommand });
    const shotContext = verifiedInput.stagedShotValidation;
    assert.equal(shotContext.status, 'PASS');
    assert.equal(shotContext.lineage.counts.approvedHistoricalRevisions, 23);
    assert.equal(shotContext.revisionChain.length, preview.STAGED_SHOT_LINEAGE_FILES.length);

    const renderer = require('../pipeline-updates/surface-renderer.cjs');
    const report = renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
      shotDefs: verifiedInput.shotDefs, revisionChain: shotContext.revisionChain,
      requireVerifiedRevisionChain: true });
    assert.equal(report.status, 'PASS');
    assert.equal(report.lineage.counts.approvedHistoricalRevisions, 23);

    assert.throws(() => renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
      shotDefs: verifiedInput.shotDefs }), /EDITORIAL_FIELD_MISMATCH \/allShots\/14\/visual/u);
    assert.throws(() => renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
      shotDefs: verifiedInput.shotDefs, requireVerifiedRevisionChain: true }), /PHASE3_VERIFIED_REVISION_CHAIN_REQUIRED/u);

    const alteredCases = [
      ['missing final entry', chain => chain.slice(0, -1), /REVISION_RESULT_HASH/u],
      ['reordered entries', chain => chain.slice().reverse(), /REVISION_CHAIN_LINK/u],
      ['altered parent hash', chain => chain.map((entry, index) => index === 0
        ? { ...entry, parentArtifactSha256: '0'.repeat(64) } : entry), /REVISION_PARENT_HASH/u],
      ['altered result hash', chain => chain.map((entry, index) => index === 3
        ? { ...entry, resultArtifactSha256: '0'.repeat(64) } : entry), /REVISION_RESULT_HASH/u],
      ['altered field change', chain => chain.map((entry, index) => index === 0
        ? { ...entry, entries: entry.entries.map((item, itemIndex) => itemIndex === 0
          ? { ...item, afterValue: 'unapproved visual change' } : item) } : entry), /REVISION_AFTER_VALUE/u],
    ];
    for (const [label, mutate, expected] of alteredCases) {
      assert.throws(() => renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
        shotDefs: verifiedInput.shotDefs, revisionChain: mutate(shotContext.revisionChain),
        requireVerifiedRevisionChain: true }), expected, label);
    }

    const retiredB010 = shotContext.revisionChain.flatMap(item => item.retirements || [])
      .find(item => item.beatId === 'ACT3B_B010');
    assert.ok(retiredB010);
    const revivedShots = structuredClone(verifiedInput.shotDefs);
    revivedShots.allShots.push(structuredClone(retiredB010.shot));
    revivedShots.acts.act3b.push(structuredClone(retiredB010.actShot || retiredB010.shot));
    assert.throws(() => renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
      shotDefs: revivedShots, revisionChain: shotContext.revisionChain, requireVerifiedRevisionChain: true }),
    /V3 shot definitions failed validation/u);

    populateMissingGeneratedRenderAssets(f.root, verifiedInput.shotDefs, verifiedInput.productionManifest);
    const before = treeIndex(f.root);
    childProcess.execSync = (...args) => { externalCommands.push(String(args[0]));
      throw new Error('TEST_FFMPEG_MUST_NOT_START'); };
    delete require.cache[rendererPath];
    const isolatedRenderer = require(rendererPath);
    await assert.rejects(isolatedRenderer.renderEpisode({ episodeDir: f.root,
      episodeId: 'e59b6b79-96aa-4dcd-92c3-749fd536f55e', channel: 'EmpireOmitted',
      phase3Preview: true, outputFilename: 'empire-omitted-v3-phase3-preview-01.mp4',
      renderProfile: isolatedRenderer.PHASE3_PREVIEW_SETTINGS,
      phase3ResolvedProductionManifest: verifiedInput.productionManifest,
      verifiedEditPlan: verifiedInput.editPlan }), /PHASE3_VERIFIED_REVISION_CHAIN_REQUIRED/u);
    assert.equal(externalCommands.length, 0);
    assert.deepEqual(treeIndex(f.root), before);

    await assert.rejects(isolatedRenderer.renderEpisode({ episodeDir: f.root,
      episodeId: 'e59b6b79-96aa-4dcd-92c3-749fd536f55e', channel: 'EmpireOmitted',
      phase3Preview: true, outputFilename: 'empire-omitted-v3-phase3-preview-01.mp4',
      renderProfile: isolatedRenderer.PHASE3_PREVIEW_SETTINGS,
      phase3ResolvedProductionManifest: verifiedInput.productionManifest,
      verifiedEditPlan: verifiedInput.editPlan,
      phase3VerifiedRevisionChain: shotContext.revisionChain,
      phase3ApprovedFiles: verifiedInput.activationRecord.candidateFiles }),
    /PHASE3_RENDER_INPUTS_UNRESOLVED:/u);
    assert.equal(externalCommands.length, 0);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
  } finally {
    childProcess.execSync = originalExecSync;
    if (cachedRendererModule) require.cache[rendererPath] = cachedRendererModule;
    else delete require.cache[rendererPath];
    f.cleanup();
  }
});

test('Stage04 edit-script generation validates the promoted package and atomically publishes parity-bound outputs', () => {
  const f = fullPreflightStage04Fixture();
  try {
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const service = preview.createPhase3Preview({ root: f.root, runner, verifyStageFn: f.stageVerifier,
      verifyBackupFn: () => true, expectedLedgerSha256: ledgerHash, runCommand: toolCommand,
      capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath },
      renderFn: () => { throw new Error('edit-script generation must not render'); } });
    const result = service.generateEditScript({ promotedRunId: PHASE2_RUN, editScriptRunId: 'phase3-edit-script-test01' });
    const runDir = path.join(f.root, '.review', 'phase3-edit-scripts', 'phase3-edit-script-test01');
    assert.equal(result.status, 'PHASE3_EDIT_SCRIPT_GENERATED');
    assert.equal(result.activeBeats, 153);
    assert.equal(result.durationSec, 633.782449);
    const document = JSON.parse(fs.readFileSync(path.join(runDir, 'edit-script.json'), 'utf8'));
    const markdown = fs.readFileSync(path.join(runDir, 'EDIT_SCRIPT.md'), 'utf8');
    const receipt = JSON.parse(fs.readFileSync(path.join(runDir, 'edit-script-receipt.json'), 'utf8'));
    const index = JSON.parse(fs.readFileSync(path.join(runDir, 'edit-script-index.json'), 'utf8'));
    assert.equal(document.beats.length, 153);
    assert.equal(document.summary.promotedStage04RunId, PHASE2_RUN);
    assert.equal(document.summary.approvedEvidenceEntries, 46);
    assert.equal(document.summary.evidenceAssets, 29);
    assert.equal(document.summary.graphics, 76);
    assert.equal(document.summary.formalTimingExceptions, 9);
    assert.equal(document.summary.editorialIntentMigrations, 5);
    assert.deepEqual(document.retiredBeats, [{ beatId: 'ACT3B_B010', status: 'RETIRED', active: false }]);
    assert.ok(document.beats.every(beat => beat.qcStatus === 'NOT_REVIEWED' && beat.qcNotes === ''));
    assert.ok(document.beats.every(beat => markdown.includes(`### ${beat.act} / ${beat.beatId}`)));
    const markdownBeatObjects = [...markdown.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/gu)].map(match => JSON.parse(match[1]));
    assert.deepEqual(markdownBeatObjects, document.beats);
    assert.equal(receipt.status, 'GENERATED');
    assert.equal(receipt.requestLedgerSha256Before, ledgerHash);
    assert.equal(receipt.requestLedgerSha256After, ledgerHash);
    assert.equal(receipt.providerRequests, 0);
    assert.equal(receipt.episodeRootWrites, 0);
    assert.equal(index.files.length, 3);
    for (const entry of index.files) {
      const bytes = fs.readFileSync(path.join(runDir, entry.path));
      assert.equal(bytes.length, entry.bytes);
      assert.equal(sha(bytes), entry.sha256);
    }
    assert.equal(fs.readdirSync(path.join(f.root, '.review', 'phase3-edit-scripts')).some(name => name.startsWith('.tmp-')), false);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
    assert.equal(fs.existsSync(path.join(f.root, 'edit-plan.json')), true);
  } finally { f.cleanup(); }
});

test('edit-script generation refuses completed runs, invalid owners, bad timing, narration and asset bindings', () => {
  const f = fullPreflightStage04Fixture();
  try {
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const service = preview.createPhase3Preview({ root: f.root, runner, verifyStageFn: f.stageVerifier,
      verifyBackupFn: () => true, expectedLedgerSha256: ledgerHash, runCommand: toolCommand,
      capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath } });
    const args = { promotedRunId: PHASE2_RUN, editScriptRunId: 'phase3-edit-script-guards01' };
    const first = service.generateEditScript(args);
    assert.equal(first.status, 'PHASE3_EDIT_SCRIPT_GENERATED');
    assert.throws(() => service.generateEditScript(args), /PHASE3_EDIT_SCRIPT_RUN_ALREADY_EXISTS/);
    for (const [label, mutate] of [
      ['missing beat', value => { value.editPlan.sequences[0].beats.pop(); }],
      ['duplicate beat', value => { value.editPlan.sequences[0].beats.push(structuredClone(value.editPlan.sequences[0].beats[0])); }],
      ['non-monotonic timing', value => { value.editPlan.sequences[0].beats[0].startSec = 1; }],
      ['timeline gap', value => { const beat = value.editPlan.sequences[0].beats[1]; beat.startSec += 0.01; beat.endSec += 0.01; }],
      ['timeline overlap', value => { const beat = value.editPlan.sequences[0].beats[1]; beat.startSec -= 0.01; beat.endSec -= 0.01; }],
      ['missing narration', value => { value.editPlan.sequences[0].beats[0].narrationExcerpt = ''; }],
      ['wrong shot owner', value => { value.shotDefs.allShots[0].beatId = 'wrong-owner'; }],
      ['unsupported production method', value => { value.productionManifest.shots[0].productionMethod = 'UNSUPPORTED'; }],
      ['stored production disagreement', value => { value.productionManifest.shots[0].productionMethod = 'CONTROLLED_STILL'; }],
      ['plan and shot timing disagreement', value => { value.shotDefs.allShots[0].endSec += 0.01; }],
      ['plan and shot narration disagreement', value => { value.shotDefs.allShots[0].narrationExcerpt = 'different narration'; }],
      ['missing evidence owner', value => { value.evidenceManifest.entries.pop(); }],
      ['missing graphic owner', value => { value.graphicAssetManifest.entries.pop(); }],
    ]) {
      const verifiedInput = preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN, runner,
        verifyBackupFn: () => true, verifyStageFn: f.stageVerifier, expectedLedgerSha256: ledgerHash,
        runCommand: toolCommand });
      const changed = { ...verifiedInput, editPlan: structuredClone(verifiedInput.editPlan),
        shotDefs: structuredClone(verifiedInput.shotDefs), productionManifest: structuredClone(verifiedInput.productionManifest),
        storedProductionManifest: structuredClone(verifiedInput.storedProductionManifest),
        evidenceManifest: structuredClone(verifiedInput.evidenceManifest), graphicAssetManifest: structuredClone(verifiedInput.graphicAssetManifest) };
      mutate(changed);
      assert.throws(() => preview.buildEditScriptDocument(changed, { editScriptRunId: 'phase3-edit-script-guard02' }), label);
    }
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-edit-scripts', 'phase3-edit-script-guard02')), false);
    const changedAsset = JSON.parse(fs.readFileSync(path.join(f.candidateDirectory, 'evidence-source-manifest.json'), 'utf8'))
      .entries.find(entry => entry.localFilename).localFilename;
    fs.appendFileSync(path.join(f.candidateDirectory, 'assets', 'evidence', changedAsset), 'altered');
    assert.throws(() => service.generateEditScript({ promotedRunId: PHASE2_RUN,
      editScriptRunId: 'phase3-edit-script-asset-tamper' }), /PHASE3_PROMOTED_INPUT_HASH_MISMATCH/);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-edit-scripts', 'phase3-edit-script-asset-tamper')), false);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
  } finally { f.cleanup(); }
});

test('edit-script publication removes temporary output after an atomic-write failure', () => {
  const f = fullPreflightStage04Fixture();
  try {
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const realVerified = preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN, runner,
      verifyBackupFn: () => true, verifyStageFn: f.stageVerifier, expectedLedgerSha256: ledgerHash,
      runCommand: toolCommand });
    const fsImpl = new Proxy(fs, { get(target, property) {
      if (property === 'writeFileSync') return (file, ...args) => {
        if (String(file).includes('.tmp-phase3-edit-script-failwrite') && String(file).endsWith('EDIT_SCRIPT.md')) {
          throw new Error('SIMULATED_ATOMIC_WRITE_FAILURE');
        }
        return target.writeFileSync(file, ...args);
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const service = preview.createPhase3Preview({ root: f.root, fsImpl, verifyInputsFn: () => realVerified,
      expectedLedgerSha256: ledgerHash, clock: () => new Date('2026-10-01T12:00:00.000Z') });
    assert.throws(() => service.generateEditScript({ promotedRunId: PHASE2_RUN,
      editScriptRunId: 'phase3-edit-script-failwrite' }), /SIMULATED_ATOMIC_WRITE_FAILURE/);
    const parent = path.join(f.root, '.review', 'phase3-edit-scripts');
    assert.equal(fs.existsSync(path.join(parent, 'phase3-edit-script-failwrite')), false);
    assert.equal(fs.readdirSync(parent).some(name => name.startsWith('.tmp-phase3-edit-script-failwrite')), false);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
  } finally { f.cleanup(); }
});

test('Phase 3 resolves the real Stage04 evidence and graphics without mutating stored production status', () => {
  const value = realStage04RenderPackage();
  const before = JSON.stringify(value.productionManifest);
  assert.throws(() => productionMethods.assertManifestReadyForRender(value.productionManifest), /86 pending production method/);
  const resolved = preview.resolvePhase3RenderManifest({ ...value, episodeDir: value.candidateDirectory });
  assert.equal(resolved.shots.length, 153);
  assert.equal(resolved.shots.filter(item => item.status === 'APPROVED').length, 153);
  assert.equal(value.evidenceManifest.entries.length, 46);
  assert.equal(new Set(value.evidenceManifest.entries.map(item => item.localFilename)).size, 29);
  assert.equal(value.graphicAssetManifest.entries.length, 76);
  assert.equal(JSON.stringify(value.productionManifest), before);
  assert.equal(resolved.shots.filter(item => item.productionMethod === 'EVIDENCE_REFERENCE' && item.sourceStatus === 'VERIFIED').length, 46);
  assert.equal(resolved.shots.filter(item => item.graphicObjectCount > 0 && item.graphicStatus === 'COMPLETE').reduce((sum, item) => sum + item.graphicObjectCount, 0), 76);
});

function copyRealRenderInputs() {
  const value = realStage04RenderPackage();
  const root = tempRoot();
  fs.copyFileSync(path.join(value.candidateDirectory, 'shot-definitions.json'), path.join(root, 'shot-definitions.json'));
  for (const dir of ['evidence', 'graphics']) {
    fs.cpSync(path.join(value.candidateDirectory, 'assets', dir), path.join(root, 'assets', dir), { recursive: true });
  }
  return { ...value, episodeDir: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function buildPhase3MediaFixture({ includeGeneratedAssets = true } = {}) {
  const value = copyRealRenderInputs();
  const renderer = require('../pipeline-updates/surface-renderer.cjs');
  const assetsDir = path.join(value.episodeDir, 'assets');
  const productionManifest = preview.resolvePhase3RenderManifest({ ...value, episodeDir: value.episodeDir });
  const plan = JSON.parse(fs.readFileSync(path.join(value.candidateDirectory, 'edit-plan.json'), 'utf8'));
  const resolved = renderer.resolveEditPlanTimestamps({ shotDefs: value.shotDefs, editPlan: plan, productionManifest });
  const evidenceByShot = new Map(value.evidenceManifest.entries.map(entry => [entry.shotId, entry]));
  const graphicsByShot = new Map();
  for (const entry of value.graphicAssetManifest.entries) {
    if (!graphicsByShot.has(entry.shotId)) graphicsByShot.set(entry.shotId, []);
    graphicsByShot.get(entry.shotId).push(entry);
  }
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=', 'base64');
  const videoBytes = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  const mediaShots = resolved.map(shot => {
    const evidence = evidenceByShot.get(shot.shotId);
    const graphicAssetEntries = graphicsByShot.get(shot.shotId) || [];
    const withManifests = { ...shot, graphicAssetEntries,
      ...(evidence ? { phase3EvidenceEntry: evidence,
        evidenceAssetPath: path.join(assetsDir, 'evidence', evidence.localFilename) } : {}) };
    let assetPath = renderer.resolveAssetPath(withManifests, assetsDir);
    if (!assetPath && includeGeneratedAssets) {
      const location = productionMethods.resolveProductionAssetLocation(shot.productionMethod);
      if (location) {
        const ext = location.extensions[0];
        assetPath = path.join(assetsDir, location.directory, `${shot.shotId}${ext}`);
        fs.mkdirSync(path.dirname(assetPath), { recursive: true });
        fs.writeFileSync(assetPath, ext === '.mp4' ? videoBytes : pngBytes);
      }
    }
    return { ...withManifests, phase3BaseAssetPath: assetPath };
  });
  return { ...value, assetsDir, mediaShots, cleanup: value.cleanup };
}

test('complete Stage04 153-shot media census classifies every resolved asset before FFmpeg', () => {
  const value = buildPhase3MediaFixture({ includeGeneratedAssets: false });
  try {
    const census = phase3Media.censusPhase3RenderInputs({ resolvedShots: value.mediaShots,
      assetsDir: value.assetsDir });
    assert.equal(census.activeShotCount, 153);
    assert.equal(census.readyCount, 87);
    assert.equal(census.unresolved.length, 66);
    assert.deepEqual(census.strategies, { DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71 });
    assert.equal(census.entries.find(item => item.beatId === 'ACT1_B003').strategy, 'DOCUMENT_CARD');
    assert.equal(census.entries.find(item => item.beatId === 'ACT1_B003').sourcePath,
      'assets/evidence/doj-wells-fargo-2020-resolution.html');
    assert.equal(census.entries.reduce((sum, item) => sum + item.supportingAssets.length, 0), 76);
    assert.ok(census.entries.filter(item => item.status === 'READY').every(item =>
      ['DOCUMENT_CARD', 'RASTERIZE_APPROVED_SVG', 'STILL_IMAGE', 'VIDEO_CLIP'].includes(item.strategy)));
    assert.equal(fs.existsSync(path.join(value.episodeDir, 'temp')), false);
  } finally { value.cleanup(); }
});

test('all 153 Stage04 shots receive a compatible strategy and document cards stay in the isolated run', () => {
  const value = buildPhase3MediaFixture();
  const isolatedRunDirectory = path.join(value.episodeDir, 'phase3-run');
  const derivedAssetDir = path.join(isolatedRunDirectory, 'temp', 'phase3-derived-assets');
  try {
    const beforeEvidence = treeIndex(path.join(value.assetsDir, 'evidence'));
    const beforeGraphics = treeIndex(path.join(value.assetsDir, 'graphics'));
    const prepared = phase3Media.preparePhase3RenderInputs({ resolvedShots: value.mediaShots,
      assetsDir: value.assetsDir, derivedAssetDir, isolatedRunDirectory });
    assert.equal(prepared.census.activeShotCount, 153);
    assert.equal(prepared.census.resolvedAssetCount, 153);
    assert.deepEqual(prepared.census.strategies, {
      DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71, STILL_IMAGE: 43, VIDEO_CLIP: 23,
    });
    const b003 = prepared.shots.find(item => item.beatId === 'ACT1_B003');
    assert.equal(b003.phase3MediaStrategy, 'DOCUMENT_CARD');
    assert.equal(b003.phase3StillInput, true);
    assert.ok(b003.evidenceAssetPath.startsWith(derivedAssetDir));
    const entry = prepared.census.entries.find(item => item.beatId === 'ACT1_B003');
    assert.equal(entry.sourcePath, 'assets/evidence/doj-wells-fargo-2020-resolution.html');
    assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/u);
    assert.ok(entry.derivedAssetPath.startsWith('temp/phase3-derived-assets/'));
    assert.match(entry.derivedAssetSha256, /^[a-f0-9]{64}$/u);
    assert.equal(prepared.shots.find(item => item.beatId === 'ACT2_B018').phase3MediaStrategy, 'DOCUMENT_CARD');
    assert.deepEqual(treeIndex(path.join(value.assetsDir, 'evidence')), beforeEvidence);
    assert.deepEqual(treeIndex(path.join(value.assetsDir, 'graphics')), beforeGraphics);
  } finally { value.cleanup(); }
});

test('Phase 3 census rejects ambiguous still output extensions before any write', () => {
  const value = buildPhase3MediaFixture();
  try {
    const shot = value.mediaShots.find(item => item.productionMethod === 'CONTROLLED_STILL');
    const location = productionMethods.resolveProductionAssetLocation(shot.productionMethod);
    const existing = shot.phase3BaseAssetPath;
    const alternate = path.join(value.assetsDir, location.directory,
      `${shot.shotId}${location.extensions.find(extension => extension !== path.extname(existing))}`);
    fs.copyFileSync(existing, alternate);
    assert.throws(() => phase3Media.resolvePhase3RenderShots({ resolvedShots: value.mediaShots,
      assetsDir: value.assetsDir, evidenceManifest: value.evidenceManifest,
      graphicAssetManifest: value.graphicAssetManifest,
      resolveAssetPath: require('../pipeline-updates/surface-renderer.cjs').resolveAssetPath }),
    new RegExp(`PHASE3_MEDIA_ASSET_AMBIGUOUS:${shot.beatId}`, 'u'));
    assert.equal(fs.existsSync(path.join(value.episodeDir, 'temp')), false);
  } finally { value.cleanup(); }
});

test('Phase 3 media classifier handles HTML, PDF, approved SVG, raster and actual video only', () => {
  const cases = [
    ['source.html', Buffer.from('<!doctype html><html></html>'), 'text/html', false, 'DOCUMENT_CARD'],
    ['source.pdf', Buffer.from('%PDF-1.7\n'), 'application/pdf', false, 'DOCUMENT_CARD'],
    ['graphic.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', true, 'RASTERIZE_APPROVED_SVG'],
    ['still.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=', 'base64'), null, false, 'STILL_IMAGE'],
    ['clip.mp4', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), null, false, 'VIDEO_CLIP'],
  ];
  for (const [filePath, bytes, expectedMimeType, approvedSvg, strategy] of cases) {
    assert.equal(phase3Media.classifyMedia({ filePath, bytes, expectedMimeType, approvedSvg }).strategy, strategy);
  }
  assert.throws(() => phase3Media.classifyMedia({ filePath: 'audio.mp3', bytes: Buffer.from('ID3') }), /PHASE3_MEDIA_TYPE_UNSUPPORTED/u);
  assert.throws(() => phase3Media.classifyMedia({ filePath: 'graphic.svg', bytes: Buffer.from('<svg/>'), approvedSvg: false }), /PHASE3_MEDIA_TYPE_UNSUPPORTED/u);
});

test('document cards fail closed instead of truncating approved titles or excerpts', () => {
  const base = { shotId: 'ACT1_B003', sourceTitle: 'Approved title', publisher: 'DOJ', excerptOrTimecode: 'Approved excerpt' };
  assert.throws(() => phase3Media.buildDocumentCardSvg({ ...base, sourceTitle: 'title '.repeat(30) }),
    /PHASE3_DOCUMENT_CARD_TITLE_OVERFLOW/u);
  assert.throws(() => phase3Media.buildDocumentCardSvg({ ...base, excerptOrTimecode: 'approved '.repeat(100) }),
    /PHASE3_DOCUMENT_CARD_EXCERPT_OVERFLOW/u);
});

test('Phase 3 media census rejects missing or altered evidence and graphic assets', () => {
  for (const category of ['evidence-missing', 'evidence-altered', 'graphic-missing', 'graphic-altered']) {
    const value = buildPhase3MediaFixture();
    try {
      const isEvidence = category.startsWith('evidence');
      const entry = isEvidence ? value.evidenceManifest.entries.find(item => item.localFilename)
        : value.graphicAssetManifest.entries[0];
      const file = path.join(value.assetsDir, isEvidence ? 'evidence' : 'graphics',
        isEvidence ? entry.localFilename : entry.filename);
      if (category.endsWith('missing')) fs.unlinkSync(file);
      else fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), Buffer.from('tamper')]));
      assert.throws(() => phase3Media.censusPhase3RenderInputs({ resolvedShots: value.mediaShots, assetsDir: value.assetsDir }),
        isEvidence ? /PHASE3_MEDIA_APPROVED_ASSET_HASH_MISMATCH|PHASE3_MEDIA_FILE_MISSING/u
          : /PHASE3_MEDIA_GRAPHIC_HASH_MISMATCH|PHASE3_MEDIA_FILE_MISSING/u);
    } finally { value.cleanup(); }
  }
});

test('unsupported media fails before derived-file creation or any encoder invocation', async () => {
  const value = buildPhase3MediaFixture();
  const isolatedRunDirectory = path.join(value.episodeDir, 'isolated-phase3');
  const derivedAssetDir = path.join(isolatedRunDirectory, 'temp', 'phase3-derived-assets');
  const unsupportedPath = path.join(value.assetsDir, 'evidence', 'unsupported.dat');
  fs.writeFileSync(unsupportedPath, Buffer.from('not a supported visual format'));
  const alteredShots = value.mediaShots.map(shot => shot.beatId === 'ACT1_B003'
    ? { ...shot, phase3BaseAssetPath: unsupportedPath, phase3EvidenceEntry: null } : shot);
  const before = treeIndex(path.join(value.assetsDir));
  let encoderCalls = 0;
  try {
    assert.throws(() => {
      const census = phase3Media.censusPhase3RenderInputs({ resolvedShots: alteredShots, assetsDir: value.assetsDir });
      phase3Media.preparePhase3RenderInputs({ resolvedShots: alteredShots, assetsDir: value.assetsDir,
        derivedAssetDir, isolatedRunDirectory });
      encoderCalls += census.activeShotCount;
    }, /PHASE3_MEDIA_TYPE_UNSUPPORTED/u);
    assert.equal(encoderCalls, 0);
    assert.deepEqual(treeIndex(path.join(value.assetsDir)), before);
    assert.equal(fs.existsSync(derivedAssetDir), false);
  } finally { value.cleanup(); }
});

test('media adapter failure releases Phase 3 lock and removes its isolated run without external writes', async () => {
  const f = fixture();
  let encoderCalls = 0;
  const { service } = makeService(f, { renderFn: async ({ episodeDir }) => {
    const badPath = path.join(episodeDir, 'assets', 'evidence', 'bad.unsupported');
    fs.mkdirSync(path.dirname(badPath), { recursive: true });
    fs.writeFileSync(badPath, 'bad');
    const fakeShots = Array.from({ length: 153 }, (_, index) => ({ actKey: 'act1',
      beatId: `ACT1_B${String(index + 1).padStart(3, '0')}`, shotId: `ACT1_B${String(index + 1).padStart(3, '0')}`,
      productionMethod: 'EVIDENCE_REFERENCE', phase3BaseAssetPath: badPath }));
    phase3Media.preparePhase3RenderInputs({ resolvedShots: fakeShots, assetsDir: path.join(episodeDir, 'assets'),
      derivedAssetDir: path.join(episodeDir, 'temp', 'phase3-derived-assets'), isolatedRunDirectory: episodeDir });
    encoderCalls += 1;
  } });
  try {
    await assert.rejects(service.render(options(f.root)), /PHASE3_MEDIA_TYPE_UNSUPPORTED/u);
    assert.equal(encoderCalls, 0);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN)), false);
    assert.equal(fs.readFileSync(f.ledgerPath, 'utf8'), 'fixture-ledger\n');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Phase 3 resolver rejects missing and altered evidence assets', () => {
  for (const altered of [false, true]) {
    const value = copyRealRenderInputs();
    try {
      const entry = value.evidenceManifest.entries.find(item => item.localFilename);
      const file = path.join(value.episodeDir, 'assets', 'evidence', entry.localFilename);
      if (altered) fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), Buffer.from('tamper')]));
      else fs.unlinkSync(file);
      assert.throws(() => preview.resolvePhase3RenderManifest(value), /EVIDENCE_|PHASE3_EVIDENCE_/);
    } finally { value.cleanup(); }
  }
});

test('Phase 3 resolver rejects missing and altered graphic assets', () => {
  for (const altered of [false, true]) {
    const value = copyRealRenderInputs();
    try {
      const entry = value.graphicAssetManifest.entries[0];
      const file = path.join(value.episodeDir, 'assets', 'graphics', entry.filename);
      if (altered) fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), Buffer.from('tamper')]));
      else fs.unlinkSync(file);
      assert.throws(() => preview.resolvePhase3RenderManifest(value), /GRAPHIC_|PHASE3_GRAPHIC_/);
    } finally { value.cleanup(); }
  }
});

test('Phase 3 resolver rejects wrong owners, duplicate records and unsupported methods', () => {
  const owner = realStage04RenderPackage();
  owner.evidenceManifest.entries[0].shotId = 'UNKNOWN_SHOT';
  assert.throws(() => preview.resolvePhase3RenderManifest({ ...owner, episodeDir: owner.candidateDirectory }), /PHASE3_EVIDENCE_OWNER_UNKNOWN/);
  const duplicate = realStage04RenderPackage();
  duplicate.graphicAssetManifest.entries.push({ ...duplicate.graphicAssetManifest.entries[0] });
  assert.throws(() => preview.resolvePhase3RenderManifest({ ...duplicate, episodeDir: duplicate.candidateDirectory }), /PHASE3_GRAPHIC_OWNER_DUPLICATE/);
  const unsupported = realStage04RenderPackage();
  unsupported.productionManifest.shots[0].productionMethod = 'UNSUPPORTED_METHOD';
  assert.throws(() => preview.resolvePhase3RenderManifest({ ...unsupported, episodeDir: unsupported.candidateDirectory }), /PHASE3_PRODUCTION_METHOD_UNSUPPORTED/);
});

test('Stage04 shot validation rejects a missing mirror owner and retired B010 reappearance', () => {
  const candidateDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const source = activationRunner.verifyIndexedCandidateDirectory({ directory: candidateDirectory,
    expectedIndexSha256: activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256, expectedCount: 150 });
  const promotedFiles = source.index.files.filter(item => ['edit-plan.json', 'shot-definitions.json'].includes(item.path));
  const base = preview.validateStagedShotDefinitions({ candidateDirectory,
    staged: { index: source.index }, promotedFiles });
  const mirrorMissing = structuredClone(base.shotDefs);
  mirrorMissing.acts.act3 = mirrorMissing.acts.act3.filter(shot => shot.beatId !== 'ACT3_B017');
  const mirrorResult = require('../pipeline-updates/shot-definitions-validator.cjs')
    .validateShotDefinitions({ plan: base.plan, shotDefs: mirrorMissing, revisionChain: base.revisionChain });
  assert.equal(mirrorResult.status, 'FAIL');
  assert.ok(mirrorResult.errors.some(error => error.code === 'ACT_SHOTS_MISMATCH' && error.path === '/acts/act3'));

  const shotPath = path.resolve(candidateDirectory, 'shot-definitions.json');
  const sourceShotEntry = source.index.files.find(item => item.path === 'shot-definitions.json');
  const promotedShotEntry = promotedFiles.find(item => item.path === 'shot-definitions.json');
  const alteredShots = structuredClone(base.shotDefs);
  const retiredShot = { ...alteredShots.allShots.find(shot => shot.actKey === 'act3b'), beatId: 'ACT3B_B010', shotId: 'ACT3B_B010' };
  alteredShots.allShots.push(retiredShot);
  alteredShots.acts.act3b.push(retiredShot);
  const alteredBytes = Buffer.from(JSON.stringify(alteredShots));
  const adjusted = entry => ({ ...entry, bytes: alteredBytes.length, sha256: sha(alteredBytes) });
  const adjustedIndex = { ...source.index, files: source.index.files.map(item => item.path === 'shot-definitions.json' ? adjusted(item) : item) };
  const adjustedPromotion = promotedFiles.map(item => item.path === 'shot-definitions.json' ? adjusted(item) : item);
  const fakeFs = Object.create(fs);
  fakeFs.readFileSync = (file, ...args) => path.resolve(file) === shotPath ? alteredBytes : fs.readFileSync(file, ...args);
  assert.equal(sourceShotEntry.path, promotedShotEntry.path);
  assert.throws(() => preview.validateStagedShotDefinitions({ candidateDirectory,
    staged: { index: adjustedIndex }, promotedFiles: adjustedPromotion, fsImpl: fakeFs }),
  /PHASE3_RETIRED_BEAT_REAPPEARED/u);
});

test('Stage04 locked-plan provenance rejects altered policy, approval binding, backup, and missing backup plan', () => {
  const f = fixture();
  const policyPath = path.join(f.root, 'refreshed-boundary-policy.v2.json');
  const reviewDirectory = path.join(f.root, '.review', `phase2.3b-p-activation-${PHASE2_RUN}`);
  const backupDirectory = path.join(reviewDirectory, 'backup');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const lockedHash = activationRunner.approval.lockedEpisodeHashesBeforeActivation['edit-plan.json'];
  const policyBytes = fs.readFileSync(path.join(activationRunner.VERIFIED_STAGE_SOURCE_DIR,
    'approvals', 'refreshed-boundary-policy.v2.json'));
  fs.writeFileSync(policyPath, policyBytes);
  const manifest = { schemaVersion: 'phase2.3b-p-backup/1.0.0', files: [
    { path: 'edit-plan.json', existed: true, bytes: 123, sha256: lockedHash },
  ] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestPath = path.join(backupDirectory, 'backup-manifest.json');
  fs.writeFileSync(manifestPath, manifestBytes);
  const baseRecord = { backupManifestSha256: sha(manifestBytes), priorHashes: { 'edit-plan.json': lockedHash } };
  const candidateDirectory = f.root;
  const make = (record, policyFile = policyPath, verifyBackupFn = () => {}) => {
    const candidate = path.join(f.root, 'candidate');
    fs.mkdirSync(path.join(candidate, 'approvals'), { recursive: true });
    fs.copyFileSync(policyFile, path.join(candidate, 'approvals', 'refreshed-boundary-policy.v2.json'));
    return () => preview.verifyStageBoundaryBackup({ reviewDirectory, candidateDirectory: candidate,
      activationRecord: record, runner: { ...activationRunner, ROOT: f.root }, verifyBackupFn });
  };
  try {
    assert.throws(make({ ...baseRecord, priorHashes: { 'edit-plan.json': 'f'.repeat(64) } }), /PHASE3_LOCKED_PLAN_PROVENANCE_MISMATCH/);
    assert.throws(make({ ...baseRecord, backupManifestSha256: 'f'.repeat(64) }), /PHASE3_PROMOTION_BACKUP_MANIFEST_HASH_MISMATCH/);
    fs.writeFileSync(path.join(f.root, 'altered-policy.json'), Buffer.from(policyBytes.toString('utf8').replace('33f5a89f', '43f5a89f')));
    assert.throws(make(baseRecord, path.join(f.root, 'altered-policy.json')), /PHASE3_STAGED_BOUNDARY_POLICY_HASH_MISMATCH/);
    fs.writeFileSync(manifestPath, Buffer.from(JSON.stringify({ schemaVersion: 'phase2.3b-p-backup/1.0.0', files: [] })));
    const changedBytes = fs.readFileSync(manifestPath);
    assert.throws(make({ ...baseRecord, backupManifestSha256: sha(changedBytes) }), /PHASE3_LOCKED_PLAN_PROVENANCE_MISMATCH/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Stage04 approved r3 package rejects changed boundary approval and pre-timing plan bytes', () => {
  const source = activationRunner.REFRESHED_BINDING_PACKAGE_DIR;
  const f = tempRoot();
  try {
    ['approvals/boundary-policy-approval.v1.json', 'outputs/candidate-edit-plan-pretiming.json'].forEach((relative, index) => {
      const packageCopy = path.join(f, `package-${index}`);
      fs.cpSync(source, packageCopy, { recursive: true });
      const file = path.join(packageCopy, ...relative.split('/'));
      fs.appendFileSync(file, ' ');
      assert.throws(() => activationRunner.verifyRefreshedApprovalPackage({ packageDirectory: packageCopy,
        expectedIndexSha256: activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256 }), /ACTIVATION_REFRESHED_PACKAGE_/);
    });
  } finally { fs.rmSync(f, { recursive: true, force: true }); }
});

test('altered final retimed edit plan is rejected against its immutable candidate index', () => {
  const f = fixture();
  try {
    for (const item of f.files) fs.rmSync(path.join(f.root, ...item.path.split('/')), { force: true });
    f.files = [];
    for (let i = 0; i < 147; i += 1) {
      const relative = i === 0 ? 'edit-plan.json' : `fixture/input-${String(i).padStart(3, '0')}.json`;
      const target = path.join(f.root, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.from(i === 0 ? '{"timing":"retimed"}' : `fixture-${i}`);
      fs.writeFileSync(target, bytes);
      f.files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
    }
    const planFile = path.join(f.root, 'edit-plan.json');
    fs.writeFileSync(planFile, Buffer.from('{"timing":"altered"}'));
    assert.throws(() => preview.verifyIndexedFiles(f.root, f.files), /PHASE3_PROMOTED_INPUT_HASH_MISMATCH:edit-plan.json/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('missing evidence or graphic assets fail indexed verification', () => {
  for (const index of [0, 1]) {
    const f = fixture();
    try {
      fs.rmSync(path.join(f.root, ...f.files[index].path.split('/')));
      assert.throws(() => preview.verifyIndexedFiles(f.root, f.files), /PHASE3_PATH_MISSING/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('evidence and graphic manifests must contain the complete approved asset sets', () => {
  const evidence = { entries: Array.from({ length: 46 }, (_, i) => ({ localFilename: i < 29 ? `e${i}` : null })),
    humanApproval: { approvedEntryCount: 46, isApproved: true } };
  const graphics = { entries: Array.from({ length: 76 }, (_, i) => ({ filename: `g${i}.svg` })) };
  assert.deepEqual(preview.assertAssetManifestCounts(evidence, graphics), { evidenceEntries: 46, evidenceAssets: 29, graphics: 76 });
  assert.throws(() => preview.assertAssetManifestCounts({ ...evidence, entries: evidence.entries.slice(1) }, graphics), /PHASE3_EVIDENCE_ASSETS_INVALID/);
  assert.throws(() => preview.assertAssetManifestCounts(evidence, { entries: graphics.entries.slice(1) }), /PHASE3_GRAPHIC_ASSET_COUNT_INVALID/);
});

test('symlinked promoted paths are rejected', () => {
  const f = fixture();
  try {
    const target = path.resolve(f.root, ...f.files[2].path.split('/'));
    const fakeFs = Object.create(fs);
    fakeFs.lstatSync = candidate => candidate === target
      ? { isSymbolicLink: () => true, isFile: () => false }
      : fs.lstatSync(candidate);
    assert.throws(() => preview.verifyIndexedFiles(f.root, f.files, { fsImpl: fakeFs }), /PHASE3_SYMLINK_PATH_REJECTED/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('path traversal and external output directories are rejected', () => {
  const f = fixture();
  try {
    assert.throws(() => preview.safeRelativePath('../episode-root/script.json'), /PHASE3_INPUT_PATH_TRAVERSAL/);
    const outside = options(f.root);
    outside.outputDir = path.join(f.root, 'output');
    assert.throws(() => makeService(f).service.preflight(outside), /PHASE3_OUTPUT_DIRECTORY_OUTSIDE_RUN/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('duplicate phase3 run IDs and stale locks are refused', () => {
  const f = fixture();
  try {
    const phase3Dir = path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN);
    fs.mkdirSync(phase3Dir, { recursive: true });
    assert.throws(() => makeService(f).service.preflight(options(f.root)), /PHASE3_RUN_ID_ALREADY_EXISTS/);
    fs.writeFileSync(path.join(phase3Dir, 'phase3-render.lock'), 'stale');
    assert.throws(() => makeService(f).service.preflight(options(f.root)), /PHASE3_RENDER_LOCK_PRESENT/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('render failure removes partial preview data and releases the separate lock', async () => {
  const f = fixture();
  try {
    const { service } = makeService(f, { renderFn: async () => { throw new Error('fixture render failure'); } });
    await assert.rejects(service.render(options(f.root)), /fixture render failure/);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN)), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('frame-count and duration mismatches fail closed and clean up the run', async () => {
  for (const mismatch of ['frames', 'duration']) {
    const f = fixture();
    try {
      const { service } = makeService(f, { runCommand: (_cmd, args) => {
        const output = toolCommand(_cmd, args);
        if (!args.includes('-count_frames')) return output;
        const data = JSON.parse(output);
        if (mismatch === 'frames') data.streams[0].nb_read_frames = '19019';
        if (mismatch === 'duration') data.format.duration = '600';
        return JSON.stringify(data);
      } });
      await assert.rejects(service.render(options(f.root)), mismatch === 'frames'
        ? /PHASE3_RENDER_VIDEO_METADATA_MISMATCH/ : /PHASE3_RENDER_DURATION_MISMATCH/);
      assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN)), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('request-ledger mutation during preview blocks receipt and cleans the run', async () => {
  const f = fixture();
  try {
    const { service } = makeService(f, { renderFn: async ({ episodeDir, outputFilename }) => {
      fs.writeFileSync(path.join(episodeDir, 'output', outputFilename), 'preview');
      fs.writeFileSync(f.ledgerPath, 'changed ledger');
      return { ffmpegArguments: ['ffmpeg fixture'] };
    } });
    await assert.rejects(service.render(options(f.root)), /PHASE3_REQUEST_LEDGER_CHANGED/);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN)), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('preview renderer loads no timing/provider module and cannot continue the normal workflow', () => {
  const rendererPath = path.resolve(__dirname, '../pipeline-updates/surface-renderer.cjs');
  const hook = `const Module=require('node:module');const old=Module._load;Module._load=function(request,parent,isMain){if(/vo-timing|@anthropic|@fal-ai|openai/.test(String(request)))throw new Error('PROVIDER_MODULE_ATTEMPT:'+request);return old.call(this,request,parent,isMain)};require(${JSON.stringify(rendererPath)});`;
  const child = spawnSync(process.execPath, ['-e', hook], { encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
  assert.equal(child.status, 0, child.stderr);
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/phase3-render-preview.cjs'), 'utf8');
  assert.doesNotMatch(source, /jobs[\\/]runner/);
  assert.match(source, /options\.mode === 'preflight' \? service\.preflight\(options\)/);
  assert.match(source, /options\.mode === 'generate-edit-script' \? service\.generateEditScript\(options\)/);
});

test('CLI requires an explicit single mode, both run IDs, and output directory', () => {
  assert.throws(() => preview.parseArgs(['--preflight']), /PHASE3_ARGUMENTS_REQUIRED/);
  assert.throws(() => preview.parseArgs(['--preflight', '--render-preview']), /PHASE3_MODE_AMBIGUOUS/);
  assert.deepEqual(preview.parseArgs(['--render-preview', '--promoted-run-id', PHASE2_RUN,
    '--phase3-run-id', PHASE3_RUN, '--output-dir', 'X']), {
    mode: 'render', promotedRunId: PHASE2_RUN, phase3RunId: PHASE3_RUN, outputDir: 'X', editScriptRunId: null,
  });
  assert.deepEqual(preview.parseArgs(['--generate-edit-script', '--promoted-run-id', PHASE2_RUN,
    '--edit-script-run-id', 'phase3-edit-script-final01']), {
    mode: 'generate-edit-script', promotedRunId: PHASE2_RUN, phase3RunId: null, outputDir: null,
    editScriptRunId: 'phase3-edit-script-final01',
  });
  assert.throws(() => preview.parseArgs(['--generate-edit-script', '--promoted-run-id', PHASE2_RUN,
    '--edit-script-run-id', '../outside']), /PHASE3_EDIT_SCRIPT_RUN_ID_INVALID/);
  assert.throws(() => preview.parseArgs(['--generate-edit-script', '--promoted-run-id', 'other-run',
    '--edit-script-run-id', 'phase3-edit-script-x']), /PHASE3_EDIT_SCRIPT_ARGUMENTS_INVALID/);
});

test('edit-script CLI dispatch never invokes the render path', async () => {
  let generated = 0, rendered = 0;
  const originalWrite = process.stdout.write;
  let stdout = '';
  process.stdout.write = chunk => { stdout += String(chunk); return true; };
  try {
    await preview.main(['--generate-edit-script', '--promoted-run-id', PHASE2_RUN,
      '--edit-script-run-id', 'phase3-edit-script-dispatch01'], {
      serviceFactory: () => ({ generateEditScript: options => { generated += 1;
        assert.equal(options.editScriptRunId, 'phase3-edit-script-dispatch01'); return { status: 'GENERATED' }; },
      preflight: () => { throw new Error('unexpected preflight'); },
      render: () => { rendered += 1; throw new Error('unexpected render'); } }),
    });
  } finally { process.stdout.write = originalWrite; }
  assert.equal(generated, 1);
  assert.equal(rendered, 0);
  assert.match(stdout, /GENERATED/);
});
