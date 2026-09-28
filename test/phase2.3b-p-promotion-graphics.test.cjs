'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const activation = require('../pipeline-updates/episode-activation.cjs');
const graphicCompiler = require('../pipeline-updates/graphic-compiler.cjs');
const cli = require('../scripts/phase2.3b-p-activate.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function makeFixture(root, { preexistingGraphic = false } = {}) {
  const candidateDirectory = path.join(root, 'candidate');
  const episodeDirectory = path.join(root, 'episode');
  const stageDirectory = path.join(root, 'exchange-stage');
  const backupDirectory = path.join(root, 'backup');
  const graphicsDirectory = path.join(candidateDirectory, 'assets', 'graphics');
  fs.mkdirSync(graphicsDirectory, { recursive: true }); fs.mkdirSync(episodeDirectory, { recursive: true });
  const shots = Array.from({ length: 76 }, (_, index) => ({
    shotId: `TEST_${String(index + 1).padStart(3, '0')}`, beatId: `TEST_${String(index + 1).padStart(3, '0')}`,
    actKey: 'act1', assetType: 'graphic_compilation', graphics: [{ type: 'impact_card', text: `Approved ${index + 1}`, intent: 'Test exact graphic requirement.' }],
  }));
  const shotDefs = { episodeId: 'fixture-episode', allShots: shots };
  const shotBytes = json(shotDefs); fs.writeFileSync(path.join(candidateDirectory, 'shot-definitions.json'), shotBytes);
  const entries = [];
  for (const shot of shots) entries.push(...graphicCompiler.compileShotGraphics({ shot, outputDir: graphicsDirectory,
    brandConfig: { width: 1920, height: 1080, fontFamily: 'Arial', palette: { background: '#111', foreground: '#fff', accent: '#aa0', muted: '#888' } } }));
  const graphicManifest = { manifestVersion: '1.0.0', episodeId: shotDefs.episodeId,
    sourceShotDefinitionsSha256: hash(shotBytes), entries };
  fs.writeFileSync(path.join(candidateDirectory, 'graphic-asset-manifest.json'), json(graphicManifest));
  fs.writeFileSync(path.join(candidateDirectory, 'script.json'), Buffer.from('approved script'));
  if (preexistingGraphic) {
    const firstPath = path.join(episodeDirectory, 'assets', 'graphics', entries[0].filename);
    fs.mkdirSync(path.dirname(firstPath), { recursive: true }); fs.writeFileSync(firstPath, 'old approved graphic');
  }
  const files = [];
  for (const relative of ['script.json', 'shot-definitions.json', 'graphic-asset-manifest.json',
    ...entries.map(entry => `assets/graphics/${entry.filename}`)]) {
    const bytes = fs.readFileSync(path.join(candidateDirectory, ...relative.split('/')));
    files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  const report = { stageSchemaVersion: cli.VERIFIED_STAGE_RECORD_SCHEMA,
    candidateFiles: [files.find(item => item.path === 'script.json')] };
  const stagedIndex = { files };
  const writeSet = () => cli.buildPromotionWriteSet({ candidateDirectory, report, stagedIndex });
  const exchangeDirectories = (left, right) => {
    const temp = `${left}.swap`;
    fs.renameSync(left, temp); fs.renameSync(right, left); fs.renameSync(temp, right);
  };
  const createStage = (source, target) => fs.cpSync(source, target, { recursive: true });
  const backup = targets => {
    const manifest = activation.makeBackup({ episodeDirectory, backupDirectory, targets });
    fs.mkdirSync(backupDirectory, { recursive: true });
    fs.writeFileSync(path.join(backupDirectory, 'backup-manifest.json'), json(manifest));
    return manifest;
  };
  return { root, candidateDirectory, episodeDirectory, stageDirectory, backupDirectory, graphicsDirectory,
    entries, files, report, stagedIndex, writeSet, exchangeDirectories, createStage, backup };
}

test('promotion write set derives manifest and all 76 unique graphics from validated candidate', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-promo-graphics-pass-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = makeFixture(root), writeSet = f.writeSet();
  assert.equal(writeSet.length, 78); // One ordinary declared artifact, the manifest, and 76 manifest assets.
  assert.equal(writeSet.filter(item => item.path.startsWith('assets/graphics/')).length, 76);
  assert.ok(writeSet.some(item => item.path === 'graphic-asset-manifest.json'));
  assert.equal(new Set(writeSet.map(item => item.path)).size, writeSet.length);
  assert.equal(cli.verifyPromotedTree(f.candidateDirectory, writeSet), true);
});

test('promotion preflight rejects a missing graphic, altered graphic, duplicate destination and traversal', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-promo-graphics-reject-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = makeFixture(path.join(root, 'missing'));
  fs.rmSync(path.join(missing.graphicsDirectory, missing.entries[0].filename));
  assert.throws(() => missing.writeSet(), /GRAPHIC_FILE_MISSING|PROMOTION_SOURCE|GRAPHIC_ASSET_SET/u);
  const altered = makeFixture(path.join(root, 'altered'));
  fs.appendFileSync(path.join(altered.graphicsDirectory, altered.entries[0].filename), 'changed');
  assert.throws(() => altered.writeSet(), /GRAPHIC_HASH_MISMATCH|PROMOTION_SOURCE_HASH/u);
  const duplicate = makeFixture(path.join(root, 'duplicate'));
  duplicate.report.candidateFiles.push(duplicate.files.find(item => item.path.startsWith('assets/graphics/')));
  assert.throws(() => duplicate.writeSet(), /ACTIVATION_PROMOTION_DUPLICATE_DESTINATION/u);
  const traversal = makeFixture(path.join(root, 'traversal'));
  const manifestFile = path.join(traversal.candidateDirectory, 'graphic-asset-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.entries[0].filename = '../escape.svg'; fs.writeFileSync(manifestFile, json(manifest));
  assert.throws(() => traversal.writeSet(), /GRAPHIC_FILENAME_MISMATCH|GRAPHIC_PATH_UNSAFE|ACTIVATION_GRAPHIC_FILENAME_INVALID/u);
});

test('graphic backup records existing targets and rollback restores replacements and removes new assets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-promo-graphics-rollback-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = makeFixture(root, { preexistingGraphic: true }), writeSet = f.writeSet();
  const manifest = f.backup(writeSet.map(item => item.path));
  assert.equal(manifest.files.length, writeSet.length);
  assert.equal(manifest.files.find(item => item.path === writeSet.find(x => x.path.startsWith('assets/graphics/')).path).existed, true);
  assert.equal(manifest.files.find(item => item.path === writeSet.find(x => x.path === 'graphic-asset-manifest.json').path).existed, false);
  cli.exchangePromotionWriteSet({ candidateDirectory: f.candidateDirectory, episodeDirectory: f.episodeDirectory,
    stageDirectory: f.stageDirectory, writeSet, backupManifest: manifest, createStage: f.createStage,
    exchangeDirectories: f.exchangeDirectories });
  assert.equal(cli.verifyPromotedTree(f.episodeDirectory, writeSet), true);
  activation.restoreBackup({ episodeDirectory: f.episodeDirectory, backupDirectory: f.backupDirectory, manifest });
  assert.equal(cli.verifyRestoredPromotionTree(f.episodeDirectory, manifest), true);
  assert.equal(fs.existsSync(path.join(f.episodeDirectory, 'graphic-asset-manifest.json')), false);
  const first = f.entries[0].filename;
  assert.equal(fs.readFileSync(path.join(f.episodeDirectory, 'assets', 'graphics', first), 'utf8'), 'old approved graphic');
  assert.equal(fs.existsSync(path.join(f.episodeDirectory, 'assets', 'graphics', f.entries[1].filename)), false);
});

test('post-exchange verification failure triggers complete atomic rollback of graphics', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-promo-graphics-postfail-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = makeFixture(path.join(root, 'case'), { preexistingGraphic: true }), writeSet = f.writeSet();
  const manifest = f.backup(writeSet.map(item => item.path)); let postPromotionVerification = false;
  const verifyTree = (directory, files) => {
    if (directory === f.episodeDirectory && !postPromotionVerification) {
      postPromotionVerification = true; throw new Error('forced post-promotion verification failure');
    }
    return cli.verifyPromotedTree(directory, files);
  };
  assert.throws(() => cli.exchangePromotionWriteSet({ candidateDirectory: f.candidateDirectory,
    episodeDirectory: f.episodeDirectory, stageDirectory: f.stageDirectory, writeSet, backupManifest: manifest,
    createStage: f.createStage, exchangeDirectories: f.exchangeDirectories, verifyTree }), /forced post-promotion/u);
  assert.equal(cli.verifyRestoredPromotionTree(f.episodeDirectory, manifest), true);
  assert.equal(fs.existsSync(path.join(f.episodeDirectory, 'graphic-asset-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(f.episodeDirectory, 'assets', 'graphics', f.entries[1].filename)), false);
  assert.equal(fs.existsSync(f.stageDirectory), false);
});

test('a ROLLED_BACK activation run is permanently ineligible for another promotion', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-promo-rolledback-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recordPath = path.join(root, 'activation-record.json');
  fs.writeFileSync(recordPath, JSON.stringify({ status: 'ROLLED_BACK' }));
  assert.throws(() => cli.assertPromotionRunUnfinalized({ recordPath }), /ACTIVATION_RUN_ALREADY_ROLLED_BACK/u);
  fs.writeFileSync(recordPath, JSON.stringify({ status: 'PROMOTED' }));
  assert.throws(() => cli.assertPromotionRunUnfinalized({ recordPath }), /ACTIVATION_RUN_ALREADY_FINALIZED/u);
});
