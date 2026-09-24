'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const testDbStub = path.join(tempDir(), 'test-db-stub.cjs');
fs.writeFileSync(testDbStub, 'module.exports = { get: async () => null, all: async () => [], run: async () => undefined };');
process.env.DB_MODULE_PATH = testDbStub;
const contract = require('../pipeline-updates/production-method-manifest.cjs');
const { generateImages } = require('../pipeline-updates/surface-image-generator.cjs');
const { animateClips } = require('../pipeline-updates/surface-animator.cjs');
const { resolveAssetPath } = require('../pipeline-updates/surface-renderer.cjs');

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'eo-v3-method-')); }

function fixture(rows) {
  const shotDefs = {
    mode: 'empire-omitted-v3', episodeId: 'fixture-episode', totalShots: rows.length, sourceEditPlanSha256: 'a'.repeat(64),
    allShots: rows.map((row, index) => ({
      shotId: row.shotId || `ACT1_B${String(index + 1).padStart(3, '0')}`,
      sequenceId: row.sequenceId || `SEQ_${index + 1}`,
      actKey: row.actKey || 'act1', visualClass: row.visualClass,
      assetType: row.assetType, graphics: row.graphics || null, evidenceRequirement: row.assetType === 'evidence_reference' ? { required: true, sourceStatus: 'pending' } : null, sourceSearchInstruction: row.assetType === 'evidence_reference' ? 'Find authentic source.' : null,
      visualType: row.visualType || (row.assetType === 'generated_image' ? 'STILL_ZOOM' : 'CLIP'),
      imagePrompt: 'safe test prompt', animationPrompt: 'safe test motion', negativePrompt: '',
    })),
  };
  const entries = shotDefs.allShots.map((shot, index) => {
    const productionMethod = rows[index].productionMethod;
    const graphicObjects = shot.graphics || [];
    const blockers = [];
    if (productionMethod === 'EVIDENCE_REFERENCE') blockers.push('EVIDENCE_SOURCE_PENDING');
    if (productionMethod === 'GRAPHIC_COMPILATION' || (graphicObjects.length > 0 && productionMethod !== 'GRAPHIC_COMPILATION')) blockers.push('GRAPHIC_COMPILATION_PENDING');
    return {
      shotId: shot.shotId, actKey: shot.actKey, sequenceId: shot.sequenceId,
      visualClass: shot.visualClass, assetType: shot.assetType, productionMethod,
      status: blockers.length ? 'BLOCKED' : 'APPROVED', blockerCodes: blockers,
      sourceStatus: productionMethod === 'EVIDENCE_REFERENCE' ? 'PENDING' : 'NOT_REQUIRED',
      graphicStatus: (productionMethod === 'GRAPHIC_COMPILATION' || graphicObjects.length > 0) ? 'PENDING' : 'NOT_REQUIRED',
      primaryGraphicAsset: productionMethod === 'GRAPHIC_COMPILATION',
      overlayGraphicRequirement: graphicObjects.length > 0 && productionMethod !== 'GRAPHIC_COMPILATION',
      graphicObjectCount: graphicObjects.length, graphicObjects,
      sourceRequirement: productionMethod === 'EVIDENCE_REFERENCE' ? { evidenceRequirement: shot.evidenceRequirement, sourceSearchInstruction: shot.sourceSearchInstruction } : null,
    };
  });
  const methods = contract.PRODUCTION_METHODS;
  const methodCounts = Object.fromEntries(methods.map(method => [method, entries.filter(e => e.productionMethod === method).length]));
  const graphicSummary = {
    primaryGraphicAssetShots: entries.filter(e => e.primaryGraphicAsset).length,
    overlayGraphicShots: entries.filter(e => e.overlayGraphicRequirement).length,
    graphicBearingBeats: entries.filter(e => e.graphicObjectCount > 0).length,
    graphicObjectCount: entries.reduce((n, e) => n + e.graphicObjectCount, 0),
    multiObjectBeatCount: entries.filter(e => e.graphicObjectCount > 1).length,
  };
  const candidateBytes = Buffer.from(JSON.stringify(shotDefs));
  const manifest = {
    manifestVersion: contract.MANIFEST_VERSION, mode: 'empire-omitted-v3', episodeId: shotDefs.episodeId,
    candidateSha256: sha(candidateBytes), sourceEditPlanSha256: 'a'.repeat(64), totalShots: rows.length,
    sequenceCount: new Set(shotDefs.allShots.map(s => s.sequenceId)).size, methodCounts, graphicSummary,
    baseImageCount: entries.filter(e => contract.BASE_IMAGE_METHODS.has(e.productionMethod)).length,
    animationCallCount: entries.filter(e => contract.ANIMATION_METHODS.has(e.productionMethod)).length,
    shots: entries,
  };
  return { shotDefs, candidateBytes, manifest };
}

function writeFixture(dir, value) {
  const shotDefsPath = path.join(dir, 'shot-definitions.json');
  const manifestPath = path.join(dir, 'production-manifest.json');
  fs.writeFileSync(shotDefsPath, value.candidateBytes);
  fs.writeFileSync(manifestPath, JSON.stringify(value.manifest));
  return { shotDefsPath, manifestPath };
}

test('all Phase 2 production modules load without invoking providers', () => {
  assert.equal(typeof require('../pipeline-updates/surface-shot-definitions.cjs').generateShotDefinitions, 'function');
  assert.equal(typeof generateImages, 'function');
  assert.equal(typeof animateClips, 'function');
  assert.equal(typeof require('../pipeline-updates/surface-renderer.cjs').renderEpisode, 'function');
});

test('manifest accepts all five method classes and computes the 67-image/23-animation routing', () => {
  const value = fixture([
    { visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'ESSENTIAL_ANIMATION' },
    { visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'CONTROLLED_STILL' },
    { visualClass: 'EDITORIAL_ILLUSTRATION', assetType: 'generated_image', productionMethod: 'GENERATED_STILL' },
    { visualClass: 'EVIDENCE', assetType: 'evidence_reference', productionMethod: 'EVIDENCE_REFERENCE' },
    { visualClass: 'EDITORIAL_ILLUSTRATION', assetType: 'graphic_compilation', productionMethod: 'GRAPHIC_COMPILATION', graphics: [{ graphicId: 'g1' }] },
  ]);
  assert.deepEqual(contract.validateProductionMethodManifest({ manifest: value.manifest, shotDefs: value.shotDefs, candidateSha256: value.manifest.candidateSha256 }), { status: 'PASS', errors: [] });
  assert.deepEqual(contract.essentialAnimationShotIds(value.manifest), [value.shotDefs.allShots[0].shotId]);
  assert.deepEqual(contract.baseImageShotIds(value.manifest), value.shotDefs.allShots.slice(0, 3).map(s => s.shotId));
});

test('manifest rejects changed candidate bytes, unknown, duplicate, and reordered shot IDs', () => {
  const value = fixture([{ visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'CONTROLLED_STILL' }, { visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'ESSENTIAL_ANIMATION' }]);
  const changed = contract.validateProductionMethodManifest({ manifest: value.manifest, shotDefs: value.shotDefs, candidateSha256: 'b'.repeat(64) });
  assert.ok(changed.errors.some(error => error.code === 'CANDIDATE_HASH_MISMATCH'));
  for (const mutate of [m => { m.shots[0].shotId = 'UNKNOWN'; }, m => { m.shots[1].shotId = m.shots[0].shotId; }, m => { [m.shots[0], m.shots[1]] = [m.shots[1], m.shots[0]]; }]) {
    const manifest = structuredClone(value.manifest); mutate(manifest);
    const report = contract.validateProductionMethodManifest({ manifest, shotDefs: value.shotDefs });
    assert.equal(report.status, 'FAIL');
    assert.ok(report.errors.some(error => ['MANIFEST_UNKNOWN_ID', 'MANIFEST_DUPLICATE_ID', 'MANIFEST_ORDER_MISMATCH'].includes(error.code)));
  }
});

test('manifest rejects EVIDENCE and graphic shots assigned to synthetic methods', () => {
  const evidence = fixture([{ visualClass: 'EVIDENCE', assetType: 'generated_clip', productionMethod: 'CONTROLLED_STILL' }]);
  assert.ok(contract.validateProductionMethodManifest({ manifest: evidence.manifest, shotDefs: evidence.shotDefs }).errors.some(error => error.code === 'SYNTHETIC_EVIDENCE_ROUTE'));
  const graphic = fixture([{ visualClass: 'EDITORIAL_ILLUSTRATION', assetType: 'graphic_compilation', productionMethod: 'GENERATED_STILL' }]);
  assert.ok(contract.validateProductionMethodManifest({ manifest: graphic.manifest, shotDefs: graphic.shotDefs }).errors.some(error => error.code === 'PRODUCTION_METHOD_ASSET_MISMATCH'));
});


test('verified evidence and completed graphics can reach approved status without weakening pending-state checks', () => {
  const value = fixture([
    { visualClass: 'EVIDENCE', assetType: 'evidence_reference', productionMethod: 'EVIDENCE_REFERENCE' },
    { visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'CONTROLLED_STILL', graphics: [{ graphicId: 'overlay' }] },
  ]);
  const pending = contract.validateProductionMethodManifest({ manifest: value.manifest, shotDefs: value.shotDefs });
  assert.equal(pending.status, 'PASS');
  const completed = structuredClone(value.manifest);
  completed.shots[0].sourceStatus = 'VERIFIED'; completed.shots[0].blockerCodes = []; completed.shots[0].status = 'APPROVED';
  completed.shots[1].graphicStatus = 'COMPLETE'; completed.shots[1].blockerCodes = []; completed.shots[1].status = 'APPROVED';
  assert.deepEqual(contract.validateProductionMethodManifest({ manifest: completed, shotDefs: value.shotDefs }), { status: 'PASS', errors: [] });
  const bypass = structuredClone(value.manifest); bypass.shots[0].status = 'APPROVED'; bypass.shots[0].blockerCodes = [];
  assert.ok(contract.validateProductionMethodManifest({ manifest: bypass, shotDefs: value.shotDefs }).errors.some(error => error.code === 'BLOCKER_STATE_MISMATCH'));
});

test('image prompt batch only accepts ordered base-image entries with matching safe fields', () => {
  const value = fixture([
    { visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'CONTROLLED_STILL' },
    { visualClass: 'EVIDENCE', assetType: 'evidence_reference', productionMethod: 'EVIDENCE_REFERENCE' },
  ]);
  assert.equal(contract.validateImagePromptBatch([{ shotId: value.shotDefs.allShots[0].shotId, filename: `${value.shotDefs.allShots[0].shotId}.png`, assetType: 'generated_clip', prompt: 'safe', negativePrompt: '' }], value.manifest), true);
  assert.throws(() => contract.validateImagePromptBatch([{ shotId: value.shotDefs.allShots[1].shotId, filename: 'e.png', assetType: 'evidence_reference', prompt: 'safe', negativePrompt: '' }], value.manifest), /Refusing synthetic image route/);
  assert.throws(() => contract.validateImagePromptBatch([{ shotId: value.shotDefs.allShots[0].shotId, filename: 'else.png', assetType: 'generated_clip', prompt: 'safe', negativePrompt: '' }], value.manifest), /filename/);
  assert.throws(() => contract.validateImagePromptBatch([{ shotId: value.shotDefs.allShots[0].shotId, filename: `${value.shotDefs.allShots[0].shotId}.png`, assetType: 'evidence_reference', prompt: 'safe', negativePrompt: '' }], value.manifest), /assetType mismatch/);
  assert.throws(() => contract.validateImagePromptBatch([{ shotId: value.shotDefs.allShots[0].shotId, filename: `${value.shotDefs.allShots[0].shotId}.png`, assetType: 'generated_clip', prompt: '', negativePrompt: '' }], value.manifest), /prompt text is missing/);
});

test('image generator rejects invalid or missing V3 manifest before constructing its provider router', async () => {
  const dir = tempDir(); const value = fixture([{ visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'CONTROLLED_STILL' }]);
  const paths = writeFixture(dir, value); const promptsFile = path.join(dir, 'prompts.json');
  fs.writeFileSync(promptsFile, JSON.stringify([{ shotId: value.shotDefs.allShots[0].shotId, filename: 'unsafe.png', assetType: 'generated_clip', prompt: 'safe test prompt', negativePrompt: '' }]));
  let routerCreations = 0;
  await assert.rejects(generateImages({ promptsFile, outputDir: path.join(dir, 'out'), mode: 'v3', routerFactory: () => { routerCreations++; } }), /requires current shot definitions and production manifest/);
  await assert.rejects(generateImages({ promptsFile, outputDir: path.join(dir, 'out'), shotDefsPath: paths.shotDefsPath, productionManifestPath: paths.manifestPath, routerFactory: () => { routerCreations++; throw new Error('must not create router'); } }), /filename/);
  assert.equal(routerCreations, 0);
  await assert.rejects(generateImages({ promptsFile, outputDir: path.join(dir, 'out'), shotDefsPath: paths.shotDefsPath, productionManifestPath: path.join(dir, 'missing.json'), routerFactory: () => { routerCreations++; } }), /manifest is missing/);
  assert.equal(routerCreations, 0);
});

test('animator sends only ESSENTIAL_ANIMATION shots to the fake video router', async () => {
  const dir = tempDir(); const value = fixture([
    { visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'ESSENTIAL_ANIMATION' },
    { visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'CONTROLLED_STILL' },
  ]);
  const paths = writeFixture(dir, value); const stills = path.join(dir, 'assets', 'stills'); fs.mkdirSync(stills, { recursive: true });
  fs.writeFileSync(path.join(stills, `${value.shotDefs.allShots[0].shotId}.png`), 'fixture');
  const calls = []; let routerCreations = 0;
  const result = await animateClips({ shotDefs: value.shotDefs, episodeDir: dir, channel: 'Empire Omitted', shotDefsPath: paths.shotDefsPath, productionManifestPath: paths.manifestPath, channelConfigLoader: async () => ({ animation_style: 'minimal', image_motion: 'subtle-ken-burns', video_primary: 'fake' }), routerFactory: () => { routerCreations++; return { run: async (_priority, req) => { calls.push(req.shotId); return { provider: 'fake' }; } }; }, sleepFn: async () => {} });
  assert.equal(routerCreations, 1); assert.deepEqual(calls, [value.shotDefs.allShots[0].shotId]); assert.equal(result.completed, 1);
});

test('animator fails missing V3 manifest before channel lookup or router creation; legacy route remains explicit', async () => {
  const dir = tempDir(); const value = fixture([{ visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'ESSENTIAL_ANIMATION' }]);
  let channels = 0, routers = 0;
  await assert.rejects(animateClips({ shotDefs: value.shotDefs, episodeDir: dir, channel: 'Empire Omitted', channelConfigLoader: async () => { channels++; return {}; }, routerFactory: () => { routers++; } }), /manifest is missing/);
  assert.equal(channels, 0); assert.equal(routers, 0);
  const legacy = { mode: 'legacy', allShots: [{ shotId: 'OLD_CLIP', visualType: 'CLIP', animationPrompt: 'legacy prompt' }] };
  await animateClips({ shotDefs: legacy, episodeDir: dir, channel: null, channelConfigLoader: async () => ({ animation_style: 'minimal' }), routerFactory: () => { routers++; return { run: async () => ({ provider: 'fake' }) }; }, sleepFn: async () => {} });
  assert.equal(routers, 1);
});

test('animator cannot silently skip required V3 animation when Channel DNA disables it', async () => {
  const dir = tempDir(); const value = fixture([{ visualClass: 'RECONSTRUCTION', assetType: 'generated_clip', productionMethod: 'ESSENTIAL_ANIMATION' }]); const paths = writeFixture(dir, value); let routers = 0;
  await assert.rejects(animateClips({ shotDefs: value.shotDefs, episodeDir: dir, channel: 'Empire Omitted', shotDefsPath: paths.shotDefsPath, productionManifestPath: paths.manifestPath, channelConfigLoader: async () => ({ animation_style: 'none' }), routerFactory: () => { routers++; } }), /requires essential animation/);
  assert.equal(routers, 0);
});

test('renderer resolves method-specific paths and refuses unknown methods', () => {
  const dir = tempDir(); const clips = path.join(dir, 'clips'); fs.mkdirSync(clips); const filename = path.join(clips, 'ACT1_B001.mp4'); fs.writeFileSync(filename, 'fixture');
  assert.equal(resolveAssetPath({ shotId: 'ACT1_B001', productionMethod: 'ESSENTIAL_ANIMATION' }, dir), filename);
  assert.equal(resolveAssetPath({ shotId: 'ACT1_B001', productionMethod: 'UNKNOWN' }, dir), null);
});


test('renderer refuses pending or missing V3 manifest before Whisper or render work', async () => {
  const dir = tempDir(); const value = fixture([{ visualClass: 'EVIDENCE', assetType: 'evidence_reference', productionMethod: 'EVIDENCE_REFERENCE' }]);
  const paths = writeFixture(dir, value);
  await assert.rejects(require('../pipeline-updates/surface-renderer.cjs').renderEpisode({ episodeDir: dir, episodeId: 'fixture-episode', channel: 'EmpireOmitted', productionManifestPath: paths.manifestPath }), /Rendering blocked by/);
  fs.unlinkSync(paths.manifestPath);
  await assert.rejects(require('../pipeline-updates/surface-renderer.cjs').renderEpisode({ episodeDir: dir, episodeId: 'fixture-episode', channel: 'EmpireOmitted' }), /manifest is missing/);
});

test('approved Wells Fargo 2.2D manifest validates exact workload, graphics and 24 targeted revisions', () => {
  const root = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo', 'phase2.2d');
  const candidatePath = path.join(root, 'shot-definitions.phase2.2d.json');
  const manifestPath = path.join(root, 'production-manifest.phase2.2d.json');
  const candidateBytes = fs.readFileSync(candidatePath); const candidate = JSON.parse(candidateBytes);
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  assert.deepEqual(contract.validateProductionMethodManifest({ manifest, shotDefs: candidate, candidateSha256: sha(candidateBytes) }), { status: 'PASS', errors: [] });
  assert.deepEqual(manifest.methodCounts, { ESSENTIAL_ANIMATION: 23, CONTROLLED_STILL: 34, GENERATED_STILL: 10, EVIDENCE_REFERENCE: 46, GRAPHIC_COMPILATION: 41 });
  assert.deepEqual(manifest.graphicSummary, { primaryGraphicAssetShots: 41, overlayGraphicShots: 28, graphicBearingBeats: 69, graphicObjectCount: 73, multiObjectBeatCount: 4 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'revision-ledger.phase2.2d.json'))).revisionCount, 24);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'validation-report.phase2.2d.json')));
  assert.equal(report.overallStatus, 'PASS'); assert.ok(Object.values(report.checks).every(Boolean));
  const hashIndex = JSON.parse(fs.readFileSync(path.join(root, 'phase2.2d-artifact-hashes.json')));
  for (const [filename, expectedHash] of Object.entries(hashIndex.artifacts)) assert.equal(sha(fs.readFileSync(path.join(root, filename))), expectedHash, `${filename} hash`);
});
