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
  assert.match(source, /options\.mode === 'preflight' \? service\.preflight\(options\) : await service\.render\(options\)/);
});

test('CLI requires an explicit single mode, both run IDs, and output directory', () => {
  assert.throws(() => preview.parseArgs(['--preflight']), /PHASE3_ARGUMENTS_REQUIRED/);
  assert.throws(() => preview.parseArgs(['--preflight', '--render-preview']), /PHASE3_MODE_AMBIGUOUS/);
  assert.deepEqual(preview.parseArgs(['--render-preview', '--promoted-run-id', PHASE2_RUN,
    '--phase3-run-id', PHASE3_RUN, '--output-dir', 'X']), {
    mode: 'render', promotedRunId: PHASE2_RUN, phase3RunId: PHASE3_RUN, outputDir: 'X',
  });
});
