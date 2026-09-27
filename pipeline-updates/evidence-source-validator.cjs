'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_VERSION = '1.0.0';
const RIGHTS_CLASSIFICATIONS = Object.freeze([
  'PUBLIC_DOMAIN', 'OFFICIAL_GOVERNMENT_SOURCE', 'LICENSED_FOR_USE',
  'CREATIVE_COMMONS_VERIFIED', 'FAIR_DEALING_REVIEW_REQUIRED', 'RIGHTS_UNCLEAR', 'REJECTED',
]);
const BLOCKING_RIGHTS = new Set(['FAIR_DEALING_REVIEW_REQUIRED', 'RIGHTS_UNCLEAR', 'REJECTED']);
const REQUIRED_FIELDS = Object.freeze([
  'shotId', 'exactSourceRequirement', 'selectedSourceUrl', 'sourceTitle', 'publisher',
  'publicationDate', 'assetType', 'directAssetUrl', 'retrievalDate', 'localFilename',
  'sha256', 'mimeType', 'dimensionsOrDuration', 'sourceAuthority', 'rightsClassification',
  'rightsNotes', 'factualRelevance', 'excerptOrTimecode', 'approvalStatus',
  'rejectionReason', 'sourceAccessStatus', 'factualSupportStatus',
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function requiredEvidenceShots(shotDefs) {
  return (shotDefs?.allShots || []).filter(shot => shot?.assetType === 'evidence_reference');
}

function validateEvidenceSourceManifest({ manifest, shotDefs, evidenceAssetDir = null, fsImpl = fs, requireApproved = true, requireLocalAssets = false }) {
  const errors = [];
  const fail = (code, shotId, detail) => errors.push({ code, shotId: shotId || null, detail });
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'FAIL', errors: [{ code: 'EVIDENCE_MANIFEST_INVALID', shotId: null, detail: 'Manifest must be an object.' }] };
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) fail('EVIDENCE_MANIFEST_VERSION', null, `Expected ${MANIFEST_VERSION}.`);
  if (manifest.episodeId !== shotDefs?.episodeId) fail('EVIDENCE_EPISODE_MISMATCH', null, 'Evidence manifest episodeId does not match shot definitions.');
  const expectedHash = manifest.shotDefinitionsSha256;
  if (!/^[a-f0-9]{64}$/i.test(expectedHash || '')) fail('EVIDENCE_SHOT_HASH_INVALID', null, 'shotDefinitionsSha256 must be a SHA-256 hex digest.');
  if (!Array.isArray(manifest.entries)) {
    fail('EVIDENCE_ENTRIES_INVALID', null, 'entries must be an array.');
    return { status: 'FAIL', errors };
  }
  const expected = requiredEvidenceShots(shotDefs);
  const expectedById = new Map(expected.map(shot => [shot.shotId, shot]));
  const seen = new Set();
  for (const shot of expected) if (!manifest.entries.some(entry => entry?.shotId === shot.shotId)) fail('EVIDENCE_SOURCE_MISSING', shot.shotId, 'No source record exists for this EVIDENCE_REFERENCE shot.');
  for (const entry of manifest.entries) {
    const id = entry?.shotId;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { fail('EVIDENCE_ENTRY_INVALID', null, 'Each entry must be an object.'); continue; }
    if (seen.has(id)) fail('EVIDENCE_DUPLICATE_SHOT', id, 'More than one evidence record exists for this shot.');
    seen.add(id);
    const shot = expectedById.get(id);
    if (!shot) { fail('EVIDENCE_UNKNOWN_SHOT', id, 'Entry does not identify a current evidence shot.'); continue; }
    for (const field of REQUIRED_FIELDS) if (!Object.prototype.hasOwnProperty.call(entry, field)) fail('EVIDENCE_FIELD_MISSING', id, `Required field ${field} is missing.`);
    if (entry.exactSourceRequirement !== shot.evidenceRequirement?.description) fail('EVIDENCE_REQUIREMENT_MISMATCH', id, 'Source requirement must exactly match the locked shot requirement.');
    if (typeof entry.selectedSourceUrl !== 'string' || !/^https:\/\//i.test(entry.selectedSourceUrl)) fail('EVIDENCE_SOURCE_URL_INVALID', id, 'selectedSourceUrl must be an HTTPS source URL.');
    if (typeof entry.sourceTitle !== 'string' || !entry.sourceTitle.trim()) fail('EVIDENCE_SOURCE_TITLE_MISSING', id, 'Source title is required.');
    if (typeof entry.publisher !== 'string' || !entry.publisher.trim()) fail('EVIDENCE_PUBLISHER_MISSING', id, 'Publisher or institution is required.');
    if (!RIGHTS_CLASSIFICATIONS.includes(entry.rightsClassification)) fail('EVIDENCE_RIGHTS_INVALID', id, `Unsupported rights classification ${entry.rightsClassification}.`);
    if (!entry.rightsNotes || typeof entry.rightsNotes !== 'string') fail('EVIDENCE_RIGHTS_NOTES_MISSING', id, 'Rights notes are required.');
    if (!entry.sourceAuthority || typeof entry.sourceAuthority !== 'string') fail('EVIDENCE_AUTHORITY_MISSING', id, 'Source authority must be documented.');
    if (!entry.factualRelevance || typeof entry.factualRelevance !== 'string') fail('EVIDENCE_RELEVANCE_MISSING', id, 'Factual relevance is required.');
    if (entry.approvalStatus === 'REJECTED' && !entry.rejectionReason) fail('EVIDENCE_REJECTION_REASON_MISSING', id, 'Rejected sources require a rejection reason.');
    if (entry.localFilename != null) {
      if (typeof entry.localFilename !== 'string' || !entry.localFilename.trim()) fail('EVIDENCE_LOCAL_FILENAME_INVALID', id, 'localFilename must be a non-empty relative filename.');
      else if (!evidenceAssetDir) fail('EVIDENCE_ASSET_ROOT_MISSING', id, 'A local asset directory is required to verify downloaded source files.');
      else {
        const root = path.resolve(evidenceAssetDir);
        const file = path.resolve(root, entry.localFilename);
        if (file !== root && !file.startsWith(root + path.sep)) fail('EVIDENCE_LOCAL_PATH_UNSAFE', id, 'Local source filename escapes the evidence asset directory.');
        else if (!fsImpl.existsSync(file)) fail('EVIDENCE_LOCAL_FILE_MISSING', id, `Source asset is missing: ${entry.localFilename}.`);
        else {
          const actual = sha256(fsImpl.readFileSync(file));
          if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || '') || actual !== entry.sha256) fail('EVIDENCE_LOCAL_HASH_MISMATCH', id, 'Downloaded source SHA-256 does not match the manifest.');
        }
      }
    } else {
      if (entry.sha256 != null) fail('EVIDENCE_HASH_WITHOUT_FILE', id, 'sha256 is only valid when a local file is recorded.');
      if (requireLocalAssets) fail('EVIDENCE_LOCAL_ASSET_REQUIRED', id, 'A hash-verified local source asset is required before production use.');
    }
    if (entry.approvalStatus !== 'APPROVED') fail('EVIDENCE_NOT_APPROVED', id, `Source status is ${entry.approvalStatus || 'missing'}.`);
    if (entry.sourceAccessStatus !== 'ACCESSIBLE') fail('EVIDENCE_SOURCE_INACCESSIBLE', id, 'Source URL accessibility has not been verified.');
    if (entry.factualSupportStatus !== 'SUPPORTED') fail('EVIDENCE_FACT_SUPPORT_UNVERIFIED', id, 'Source has not been verified to support the narration.');
    if (BLOCKING_RIGHTS.has(entry.rightsClassification)) fail('EVIDENCE_RIGHTS_REVIEW_REQUIRED', id, `Rights classification ${entry.rightsClassification} is not cleared for production.`);
    if (!entry.localFilename && !entry.directAssetUrl) fail('EVIDENCE_ASSET_UNAVAILABLE', id, 'No local source asset or direct source asset URL is available.');
    if (requireApproved && entry.approvalStatus !== 'APPROVED') continue;
  }
  for (const entry of manifest.entries) if (!expectedById.has(entry?.shotId)) fail('EVIDENCE_EXTRA_ENTRY', entry?.shotId, 'Manifest contains a non-evidence or stale shot.');
  return errors.length ? { status: 'FAIL', errors } : { status: 'PASS', errors: [] };
}

function listAssetFiles(root, fsImpl, prefix = '') {
  if (!fsImpl.existsSync(root)) return [];
  const output = [];
  for (const name of fsImpl.readdirSync(root).sort()) {
    const relative = prefix ? path.posix.join(prefix, name) : name;
    const absolute = path.join(root, name);
    const stat = fsImpl.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('EVIDENCE_ASSET_SYMLINK_FORBIDDEN:' + relative);
    if (stat.isDirectory()) output.push(...listAssetFiles(absolute, fsImpl, relative));
    else if (stat.isFile()) output.push(relative.split(path.sep).join('/'));
    else throw new Error('EVIDENCE_ASSET_TYPE_UNSUPPORTED:' + relative);
  }
  return output;
}

function createEvidencePackageBinding({ manifestPath, shotDefsPath, evidenceAssetDir, fsImpl = fs } = {}) {
  if (!manifestPath || !shotDefsPath || !evidenceAssetDir) throw new Error('EVIDENCE_BINDING_PATHS_REQUIRED');
  for (const [file, code] of [[manifestPath, 'EVIDENCE_MANIFEST_MISSING'], [shotDefsPath, 'EVIDENCE_SHOT_DEFINITIONS_MISSING']]) {
    if (!fsImpl.existsSync(file)) throw new Error(code);
  }
  if (!fsImpl.existsSync(evidenceAssetDir)) throw new Error('EVIDENCE_ASSET_ROOT_MISSING');
  const assetRootStat = fsImpl.lstatSync(evidenceAssetDir);
  if (assetRootStat.isSymbolicLink()) throw new Error('EVIDENCE_ASSET_SYMLINK_FORBIDDEN:.');
  if (!assetRootStat.isDirectory()) throw new Error('EVIDENCE_ASSET_ROOT_MISSING');
  const manifestBytes = fsImpl.readFileSync(manifestPath);
  const shotBytes = fsImpl.readFileSync(shotDefsPath);
  let manifest, shotDefs;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); shotDefs = JSON.parse(shotBytes.toString('utf8')); }
  catch (_) { throw new Error('EVIDENCE_BINDING_JSON_INVALID'); }
  const validation = validateEvidenceSourceManifest({ manifest, shotDefs, evidenceAssetDir, fsImpl, requireApproved: true, requireLocalAssets: true });
  if (validation.status !== 'PASS') throw new Error('EVIDENCE_PACKAGE_NOT_READY:' + validation.errors.map(item => item.code + (item.shotId ? ':' + item.shotId : '')).join(','));
  const declared = [...new Set(manifest.entries.map(entry => entry.localFilename).filter(Boolean).map(value => value.split(path.sep).join('/')))].sort();
  const actual = listAssetFiles(evidenceAssetDir, fsImpl).sort();
  if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error('EVIDENCE_ASSET_SET_MISMATCH');
  const assets = declared.map(relativePath => {
    const absolute = path.resolve(evidenceAssetDir, relativePath);
    const root = path.resolve(evidenceAssetDir);
    if (!absolute.startsWith(root + path.sep)) throw new Error('EVIDENCE_LOCAL_PATH_UNSAFE:' + relativePath);
    const bytes = fsImpl.readFileSync(absolute);
    const digest = sha256(bytes);
    const rows = manifest.entries.filter(entry => entry.localFilename && entry.localFilename.split(path.sep).join('/') === relativePath);
    if (!rows.length || rows.some(entry => entry.sha256 !== digest)) throw new Error('EVIDENCE_LOCAL_HASH_MISMATCH:' + relativePath);
    return { relativePath, bytes: bytes.length, sha256: digest };
  });
  const core = {
    schemaVersion: 'phase2.3b-evidence-preflight-binding/1.0.0',
    manifestSha256: sha256(manifestBytes),
    shotDefinitionsSha256: sha256(shotBytes),
    assetCount: assets.length,
    assets,
  };
  return { ...core, bindingSha256: sha256(Buffer.from(JSON.stringify(core))) };
}

function verifyEvidencePackageBinding({ expected, manifestPath, shotDefsPath, evidenceAssetDir, fsImpl = fs } = {}) {
  if (!expected || typeof expected !== 'object') throw new Error('EVIDENCE_PREFLIGHT_BINDING_MISSING');
  const actual = createEvidencePackageBinding({ manifestPath, shotDefsPath, evidenceAssetDir, fsImpl });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('EVIDENCE_PREFLIGHT_BINDING_CHANGED');
  return actual;
}

function loadEvidenceSourceManifest({ manifestPath, shotDefsPath, shotDefs = null, evidenceAssetDir = null, fsImpl = fs }) {
  if (!manifestPath || !fsImpl.existsSync(manifestPath)) throw new Error('[evidence][EVIDENCE_MANIFEST_MISSING] Required evidence-source-manifest.json is missing.');
  const bytes = fsImpl.readFileSync(manifestPath);
  const shotBytes = shotDefsPath ? fsImpl.readFileSync(shotDefsPath) : null;
  const definitions = shotDefs || JSON.parse(shotBytes.toString('utf8'));
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (shotBytes && manifest.shotDefinitionsSha256 !== sha256(shotBytes)) throw new Error('[evidence][EVIDENCE_SHOT_HASH_MISMATCH] Evidence manifest was created for different shot definitions.');
  const report = validateEvidenceSourceManifest({ manifest, shotDefs: definitions, evidenceAssetDir, fsImpl, requireLocalAssets: true });
  if (report.status !== 'PASS') {
    const first = report.errors[0];
    throw new Error(`[evidence][${first.code}] ${first.shotId ? `${first.shotId}: ` : ''}${first.detail}`);
  }
  return manifest;
}

module.exports = { MANIFEST_VERSION, RIGHTS_CLASSIFICATIONS, REQUIRED_FIELDS, sha256, requiredEvidenceShots, validateEvidenceSourceManifest, createEvidencePackageBinding, verifyEvidencePackageBinding, loadEvidenceSourceManifest };
