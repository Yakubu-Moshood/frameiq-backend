'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { validateEvidenceSourceManifest, loadEvidenceSourceManifest, RIGHTS_CLASSIFICATIONS } = require('../pipeline-updates/evidence-source-validator.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const shot = { shotId: 'ACT1_B001', assetType: 'evidence_reference', evidenceRequirement: { description: 'Official finding for the stated claim.' } };
  const bytes = Buffer.from('official-record');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-validator-'));
  fs.writeFileSync(path.join(temp, 'record.pdf'), bytes);
  const entry = {
    shotId: shot.shotId, exactSourceRequirement: shot.evidenceRequirement.description,
    selectedSourceUrl: 'https://agency.gov/order', sourceTitle: 'Agency order', publisher: 'Agency', publicationDate: null,
    assetType: 'PDF_DOCUMENT', directAssetUrl: 'https://agency.gov/order.pdf', retrievalDate: '2026-09-24', localFilename: 'record.pdf',
    sha256: hash(bytes), mimeType: 'application/pdf', dimensionsOrDuration: null, sourceAuthority: 'Primary government record',
    rightsClassification: 'OFFICIAL_GOVERNMENT_SOURCE', rightsNotes: 'Official agency record; reuse terms reviewed for this asset.',
    factualRelevance: 'Contains the cited finding.', excerptOrTimecode: 'p. 4', approvalStatus: 'APPROVED', rejectionReason: null,
    sourceAccessStatus: 'ACCESSIBLE', factualSupportStatus: 'SUPPORTED',
  };
  const manifest = { manifestVersion: '1.0.0', episodeId: 'episode-1', shotDefinitionsSha256: 'a'.repeat(64), entries: [entry] };
  return { shot, temp, entry, manifest, shotDefs: { episodeId: 'episode-1', allShots: [shot] } };
}
test('evidence source manifest passes only with complete approved record and matching local hash', () => {
  const f = fixture();
  assert.deepEqual(validateEvidenceSourceManifest({ manifest: f.manifest, shotDefs: f.shotDefs, evidenceAssetDir: f.temp }), { status: 'PASS', errors: [] });
  fs.rmSync(f.temp, { recursive: true, force: true });
});
test('every allowed rights classification is recognized and unresolved rights fail closed', () => {
  assert.deepEqual(RIGHTS_CLASSIFICATIONS, ['PUBLIC_DOMAIN', 'OFFICIAL_GOVERNMENT_SOURCE', 'LICENSED_FOR_USE', 'CREATIVE_COMMONS_VERIFIED', 'FAIR_DEALING_REVIEW_REQUIRED', 'RIGHTS_UNCLEAR', 'REJECTED']);
  const f = fixture();
  f.entry.rightsClassification = 'RIGHTS_UNCLEAR';
  const codes = validateEvidenceSourceManifest({ manifest: f.manifest, shotDefs: f.shotDefs, evidenceAssetDir: f.temp }).errors.map(error => error.code);
  assert.ok(codes.includes('EVIDENCE_RIGHTS_REVIEW_REQUIRED'));
  fs.rmSync(f.temp, { recursive: true, force: true });
});
test('source missing, unverified access, rejection, and unsupported factual relevance all fail closed', () => {
  const f = fixture(); f.entry.sourceAccessStatus = 'INACCESSIBLE'; f.entry.factualSupportStatus = 'UNVERIFIED'; f.entry.approvalStatus = 'REJECTED'; f.entry.rejectionReason = 'Wrong record.';
  const codes = validateEvidenceSourceManifest({ manifest: f.manifest, shotDefs: f.shotDefs, evidenceAssetDir: f.temp }).errors.map(error => error.code);
  assert.ok(codes.includes('EVIDENCE_SOURCE_INACCESSIBLE'));
  assert.ok(codes.includes('EVIDENCE_FACT_SUPPORT_UNVERIFIED'));
  assert.ok(codes.includes('EVIDENCE_NOT_APPROVED'));
  const missing = { ...f.manifest, entries: [] };
  assert.ok(validateEvidenceSourceManifest({ manifest: missing, shotDefs: f.shotDefs }).errors.some(error => error.code === 'EVIDENCE_SOURCE_MISSING'));
  fs.rmSync(f.temp, { recursive: true, force: true });
});
test('local file hash mismatch and path traversal are rejected', () => {
  const f = fixture(); f.entry.sha256 = '0'.repeat(64);
  assert.ok(validateEvidenceSourceManifest({ manifest: f.manifest, shotDefs: f.shotDefs, evidenceAssetDir: f.temp }).errors.some(error => error.code === 'EVIDENCE_LOCAL_HASH_MISMATCH'));
  f.entry.localFilename = '../outside.pdf';
  assert.ok(validateEvidenceSourceManifest({ manifest: f.manifest, shotDefs: f.shotDefs, evidenceAssetDir: f.temp }).errors.some(error => error.code === 'EVIDENCE_LOCAL_PATH_UNSAFE'));
  fs.rmSync(f.temp, { recursive: true, force: true });
});
test('loading a source manifest rejects a changed locked shot-definition hash', () => {
  const f = fixture();
  const manifestPath = path.join(f.temp, 'evidence-source-manifest.json');
  const shotDefsPath = path.join(f.temp, 'shot-definitions.json');
  fs.writeFileSync(manifestPath, JSON.stringify(f.manifest));
  fs.writeFileSync(shotDefsPath, JSON.stringify(f.shotDefs));
  assert.throws(() => loadEvidenceSourceManifest({ manifestPath, shotDefsPath, evidenceAssetDir: f.temp }), /EVIDENCE_SHOT_HASH_MISMATCH/);
  fs.rmSync(f.temp, { recursive: true, force: true });
});
test('wrong shot requirement and unsupported rights spelling are rejected', () => {
  const f = fixture(); f.entry.exactSourceRequirement = 'paraphrased'; f.entry.rightsClassification = 'GOVERNMENT';
  const codes = validateEvidenceSourceManifest({ manifest: f.manifest, shotDefs: f.shotDefs, evidenceAssetDir: f.temp }).errors.map(error => error.code);
  assert.ok(codes.includes('EVIDENCE_REQUIREMENT_MISMATCH'));
  assert.ok(codes.includes('EVIDENCE_RIGHTS_INVALID'));
  fs.rmSync(f.temp, { recursive: true, force: true });
});
test('candidate manifest can never bypass approval, source access, support, and local asset checks', () => {
  const f = fixture(); f.entry.approvalStatus = 'REVIEW_REQUIRED'; f.entry.sourceAccessStatus = 'UNCHECKED'; f.entry.factualSupportStatus = 'PENDING'; f.entry.localFilename = null; f.entry.sha256 = null; f.entry.directAssetUrl = null;
  const codes = validateEvidenceSourceManifest({ manifest: f.manifest, shotDefs: f.shotDefs }).errors.map(error => error.code);
  assert.ok(codes.includes('EVIDENCE_NOT_APPROVED'));
  assert.ok(codes.includes('EVIDENCE_SOURCE_INACCESSIBLE'));
  assert.ok(codes.includes('EVIDENCE_FACT_SUPPORT_UNVERIFIED'));
  assert.ok(codes.includes('EVIDENCE_ASSET_UNAVAILABLE'));
});
