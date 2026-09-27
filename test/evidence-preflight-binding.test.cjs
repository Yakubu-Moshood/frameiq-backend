'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MANIFEST_VERSION, sha256, validateEvidenceSourceManifest, createEvidencePackageBinding, verifyEvidencePackageBinding } = require('../pipeline-updates/evidence-source-validator.cjs');
const { createActivationEvidenceBinding } = require('../scripts/phase2.3b-p-activate.cjs');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-evidence-bind-'));
  const assets = path.join(root, 'assets', 'evidence'); fs.mkdirSync(assets, { recursive: true });
  const shotDefs = { episodeId: 'wf', allShots: [{ shotId: 'ACT1_B001', assetType: 'evidence_reference', evidenceRequirement: { description: 'Official item verifies claim.' } }] };
  const shotPath = path.join(root, 'shot-definitions.json'); fs.writeFileSync(shotPath, JSON.stringify(shotDefs));
  const content = Buffer.from('verified public evidence asset'); fs.writeFileSync(path.join(assets, 'record.pdf'), content);
  const manifest = { manifestVersion: MANIFEST_VERSION, episodeId: 'wf', shotDefinitionsSha256: sha256(fs.readFileSync(shotPath)), entries: [{
    shotId: 'ACT1_B001', exactSourceRequirement: shotDefs.allShots[0].evidenceRequirement.description,
    selectedSourceUrl: 'https://agency.gov/action', sourceTitle: 'Agency order', publisher: 'Agency', publicationDate: '2025-01-02',
    assetType: 'PDF_DOCUMENT', directAssetUrl: 'https://agency.gov/order.pdf', retrievalDate: '2026-09-27', localFilename: 'record.pdf',
    sha256: sha256(content), mimeType: 'application/pdf', dimensionsOrDuration: null, sourceAuthority: 'Official primary record',
    rightsClassification: 'OFFICIAL_GOVERNMENT_SOURCE', rightsNotes: 'Official agency-created order; selected asset reviewed; no third-party exhibit pages included.',
    factualRelevance: 'The cited paragraph addresses the exact requirement.', excerptOrTimecode: 'p. 4, paragraph 8', approvalStatus: 'APPROVED', rejectionReason: null,
    sourceAccessStatus: 'ACCESSIBLE', factualSupportStatus: 'SUPPORTED',
  }] };
  const manifestPath = path.join(root, 'evidence-source-manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, assets, shotPath, shotDefs, manifest, manifestPath };
}
test('activation evidence binding records the manifest and every selected asset byte hash', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const binding = createEvidencePackageBinding({ manifestPath: f.manifestPath, shotDefsPath: f.shotPath, evidenceAssetDir: f.assets });
  assert.equal(binding.schemaVersion, 'phase2.3b-evidence-preflight-binding/1.0.0');
  assert.equal(binding.manifestSha256, sha256(fs.readFileSync(f.manifestPath)));
  assert.deepEqual(binding.assets, [{ relativePath: 'record.pdf', bytes: fs.statSync(path.join(f.assets, 'record.pdf')).size, sha256: sha256(fs.readFileSync(path.join(f.assets, 'record.pdf'))) }]);
  assert.deepEqual(verifyEvidencePackageBinding({ expected: binding, manifestPath: f.manifestPath, shotDefsPath: f.shotPath, evidenceAssetDir: f.assets }), binding);
  assert.deepEqual(createActivationEvidenceBinding({ episodeDirectory: f.root }), binding);
});
test('preflight evidence binding fails closed for changed manifest or selected asset bytes', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const binding = createEvidencePackageBinding({ manifestPath: f.manifestPath, shotDefsPath: f.shotPath, evidenceAssetDir: f.assets });
  fs.appendFileSync(path.join(f.assets, 'record.pdf'), 'tamper');
  assert.throws(() => verifyEvidencePackageBinding({ expected: binding, manifestPath: f.manifestPath, shotDefsPath: f.shotPath, evidenceAssetDir: f.assets }), /EVIDENCE_LOCAL_HASH_MISMATCH/u);
  fs.writeFileSync(path.join(f.assets, 'record.pdf'), 'verified public evidence asset');
  fs.appendFileSync(f.manifestPath, ' ');
  assert.throws(() => verifyEvidencePackageBinding({ expected: binding, manifestPath: f.manifestPath, shotDefsPath: f.shotPath, evidenceAssetDir: f.assets }), /EVIDENCE_PREFLIGHT_BINDING_CHANGED/u);
});
test('preflight binding refuses missing/unapproved assets and unmanifested local files', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const unapproved = structuredClone(f.manifest); unapproved.entries[0].approvalStatus = 'REVIEW_REQUIRED'; fs.writeFileSync(f.manifestPath, JSON.stringify(unapproved));
  assert.throws(() => createEvidencePackageBinding({ manifestPath: f.manifestPath, shotDefsPath: f.shotPath, evidenceAssetDir: f.assets }), /EVIDENCE_PACKAGE_NOT_READY/u);
  fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest)); fs.writeFileSync(path.join(f.assets, 'unexpected.pdf'), 'orphan');
  assert.throws(() => createEvidencePackageBinding({ manifestPath: f.manifestPath, shotDefsPath: f.shotPath, evidenceAssetDir: f.assets }), /EVIDENCE_ASSET_SET_MISMATCH/u);
});
test('preflight binding rejects symlinked evidence assets', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const other = path.join(f.root, 'other.pdf'); fs.writeFileSync(other, 'other');
  const link = path.join(f.assets, 'link.pdf');
  try { fs.symlinkSync(other, link); } catch { return; }
  assert.throws(() => createEvidencePackageBinding({ manifestPath: f.manifestPath, shotDefsPath: f.shotPath, evidenceAssetDir: f.assets }), /EVIDENCE_ASSET_SYMLINK_FORBIDDEN/u);
});
