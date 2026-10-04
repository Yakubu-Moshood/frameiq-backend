'use strict';

const crypto = require('node:crypto');

const PARENT = Object.freeze({
  candidateIndexSha256: '8ff011db727b1cf6ac47acff010f15d9559aa9dcfc763dc6830cbcba7916deac',
  shotDefinitionsSha256: '315e0133e49fee61f5625601e4c4d434b04e1db6c6ac943809592229980da2a7',
  productionManifestSha256: '0caef389bd517c5a0898377dc304708fe83666c51205fbdeeddfb365d5ec531e',
  timingPolicySha256: '8a0173087b2e7364e8bd46c4a9e53c3acb738904fc3f94968099b357deea843b',
  timingApprovalSha256: 'fdbc2b00514772350c5b9acb1fafe771e18e8e7f52caa0778e84c67fd34a12b1',
  closurePackageIndexSha256: '1437c1b1bdd34f60d7a42dd4904941f2f2d44b668cbbb0026d3ab018887cce2b',
  applicationApprovalSha256: 'e4d93e08935ebdf1f84a6e532a2a39a736a261f92cfa338ace7fe84354aa742b',
  amendmentSha256: 'fa4fc0c43543c19d8be66303825e3ac713d6ce5d269623075daec46ad35c2df3',
  renewalApprovalSha256: '2db259b6ddfd8770e172056603192ec7d88f5fab4e8f8b37f537b6ca015c3373',
  oldAct1B030ObligationSha256: 'a86f89695d279c6e5ec9d88bf1ea1ed2d522e2e5f50eaaf032bca49091ccecd4',
  newAct1B030ObligationSha256: '20eb5c8b67a9ca4475dbad7fbd5f993f7f817f0980c5143c23d6d5b566161b29',
});

const CONTROLLED_STILL_BEAT_IDS = Object.freeze([
  'ACT1_B005','ACT1_B011','ACT1_B012','ACT1_B013','ACT1_B015','ACT1_B020','ACT1_B022','ACT1_B030',
  'ACT2_B002','ACT2_B003','ACT2_B009','ACT2_B011','ACT2_B012','ACT2_B013','ACT2_B015','ACT2_B020','ACT2_B021','ACT2_B024','ACT2_B025',
  'ACT3_B006','ACT3_B007','ACT3_B010','ACT3_B013','ACT3_B020','ACT3_B026','ACT3_B027',
  'ACT3B_B001','ACT3B_B004','ACT3B_B007','ACT3B_B013','ACT3B_B016','ACT3B_B018','ACT5_B010','ACT5_B013',
]);
const CHILD_ADDITIONS = Object.freeze([
  'approvals/controlled-still-application-approval.v1.json',
  'approvals/act1-b030-timing-obligation-renewal-approval.v1.json',
  'approvals/refreshed-timing-policy.act1-b030-renewal.v1.json',
  'approvals/act1-b030-timing-policy-renewal-binding.v1.json',
  'revision-lineage/parent-candidate-package-sha256.v1.json',
  'revision-lineage/parent-shot-definitions.json',
  'revision-lineage/parent-production-manifest.json',
  'revision-lineage/parent-timing-policy.v5.json',
  'revision-lineage/controlled-still-amendment.v1.json',
  'revision-lineage/controlled-still-child-application-proof.v1.json',
  'revision-lineage/phase3-controlled-still-amendment-application.v1.json',
  'revision-lineage/phase3-controlled-still-asset-type-lineage.v1.json',
]);
const MECHANICAL_PARENT_CHANGES = Object.freeze([
  'candidate-report.json', 'evidence-source-manifest.json', 'graphic-asset-manifest.json',
  'graphic-requirements-inventory.json', 'production-manifest.json', 'shot-definitions.json',
  'validation/boundary-and-timing-validation.json', 'validation/revision-lineage-validation.json',
  'validation/shot-definitions-validation.json',
]);
const VERIFIED_CONTEXTS = new WeakSet();
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonicalSha256 = value => sha256(Buffer.from(JSON.stringify(value), 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => structuredClone(value);

function parseBytes(value, name) {
  if (!Buffer.isBuffer(value)) throw new Error(`CONTROLLED_STILL_${name}_BYTES_REQUIRED`);
  try { return JSON.parse(value.toString('utf8')); }
  catch (_) { throw new Error(`CONTROLLED_STILL_${name}_JSON_INVALID`); }
}

function assertRawHash(bytes, expected, name) {
  if (sha256(bytes) !== expected) throw new Error(`CONTROLLED_STILL_${name}_HASH_MISMATCH`);
}

function makeVerifiedControlledStillContext(input = {}) {
  const parentIndexBytes = input.parentCandidateIndexBytes;
  const parentShotsBytes = input.parentShotDefinitionsBytes;
  const parentManifestBytes = input.parentProductionManifestBytes;
  const childShotsBytes = input.childShotDefinitionsBytes;
  const childManifestBytes = input.childProductionManifestBytes;
  const amendmentBytes = input.amendmentBytes;
  const applicationApprovalBytes = input.applicationApprovalBytes;
  const renewalApprovalBytes = input.renewalApprovalBytes;
  const renewalPolicyBytes = input.renewalPolicyBytes;
  const renewalBindingBytes = input.renewalBindingBytes;
  for (const [name, bytes] of Object.entries({ parentIndexBytes, parentShotsBytes, parentManifestBytes, childShotsBytes,
    childManifestBytes, amendmentBytes, applicationApprovalBytes, renewalApprovalBytes, renewalPolicyBytes, renewalBindingBytes })) {
    if (!Buffer.isBuffer(bytes)) throw new Error(`CONTROLLED_STILL_${name.toUpperCase()}_REQUIRED`);
  }
  assertRawHash(parentIndexBytes, PARENT.candidateIndexSha256, 'PARENT_INDEX');
  assertRawHash(parentShotsBytes, PARENT.shotDefinitionsSha256, 'PARENT_SHOT_DEFINITIONS');
  assertRawHash(parentManifestBytes, PARENT.productionManifestSha256, 'PARENT_PRODUCTION_MANIFEST');
  assertRawHash(amendmentBytes, PARENT.amendmentSha256, 'AMENDMENT');
  assertRawHash(applicationApprovalBytes, PARENT.applicationApprovalSha256, 'APPLICATION_APPROVAL');
  assertRawHash(renewalApprovalBytes, PARENT.renewalApprovalSha256, 'RENEWAL_APPROVAL');

  const parentIndex = parseBytes(parentIndexBytes, 'PARENT_INDEX');
  const parentShots = parseBytes(parentShotsBytes, 'PARENT_SHOT_DEFINITIONS');
  const parentManifest = parseBytes(parentManifestBytes, 'PARENT_PRODUCTION_MANIFEST');
  const childShots = parseBytes(childShotsBytes, 'CHILD_SHOT_DEFINITIONS');
  const childManifest = parseBytes(childManifestBytes, 'CHILD_PRODUCTION_MANIFEST');
  const amendment = parseBytes(amendmentBytes, 'AMENDMENT');
  const applicationApproval = parseBytes(applicationApprovalBytes, 'APPLICATION_APPROVAL');
  const renewalApproval = parseBytes(renewalApprovalBytes, 'RENEWAL_APPROVAL');
  const renewalPolicy = parseBytes(renewalPolicyBytes, 'RENEWAL_POLICY');
  const renewalBinding = parseBytes(renewalBindingBytes, 'RENEWAL_BINDING');

  const parentFiles = Array.isArray(parentIndex.files) ? parentIndex.files : [];
  const parentEntry = parentFiles.find(entry => entry.path === 'shot-definitions.json');
  const manifestEntry = parentFiles.find(entry => entry.path === 'production-manifest.json');
  if (parentEntry?.sha256 !== PARENT.shotDefinitionsSha256 || manifestEntry?.sha256 !== PARENT.productionManifestSha256) {
    throw new Error('CONTROLLED_STILL_PARENT_INDEX_CONTENT_MISMATCH');
  }
  if (applicationApproval.status !== 'APPROVED_FOR_ISOLATED_CANDIDATE_APPLICATION'
      || applicationApproval.approvedBy !== 'Yakubu Moshood'
      || applicationApproval.bindings?.amendmentSha256 !== PARENT.amendmentSha256
      || applicationApproval.bindings?.rowCount !== CONTROLLED_STILL_BEAT_IDS.length
      || !same(applicationApproval.bindings?.affectedBeatIds, CONTROLLED_STILL_BEAT_IDS)) {
    throw new Error('CONTROLLED_STILL_APPLICATION_APPROVAL_INVALID');
  }
  if (amendment.status !== 'PROPOSED_UNSIGNED_PENDING_HUMAN_REVIEW'
      || amendment.parentCandidateIndexSha256 !== PARENT.candidateIndexSha256
      || amendment.parentShotDefinitionsSha256 !== PARENT.shotDefinitionsSha256
      || amendment.parentProductionManifestSha256 !== PARENT.productionManifestSha256
      || amendment.exactScope?.entryCount !== CONTROLLED_STILL_BEAT_IDS.length
      || !same(amendment.exactScope?.beatIds, CONTROLLED_STILL_BEAT_IDS)
      || amendment.exactScope?.onlyChangedField !== 'assetType'
      || amendment.exactScope?.from !== 'generated_clip' || amendment.exactScope?.to !== 'controlled_image'
      || amendment.exactScope?.productionMethod !== 'CONTROLLED_STILL'
      || !Array.isArray(amendment.entries) || amendment.entries.length !== CONTROLLED_STILL_BEAT_IDS.length) {
    throw new Error('CONTROLLED_STILL_AMENDMENT_SCOPE_INVALID');
  }
  const changedIds = [];
  const parentShotsById = new Map(parentShots.allShots.map(shot => [shot.beatId, shot]));
  const childShotsById = new Map(childShots.allShots.map(shot => [shot.beatId, shot]));
  if (parentShotsById.size !== parentShots.allShots.length || childShotsById.size !== childShots.allShots.length
      || !same(parentShots.allShots.map(shot => shot.beatId), childShots.allShots.map(shot => shot.beatId))) {
    throw new Error('CONTROLLED_STILL_SHOT_MEMBERSHIP_CHANGED');
  }
  const scope = new Set(CONTROLLED_STILL_BEAT_IDS);
  for (const id of CONTROLLED_STILL_BEAT_IDS) {
    const before = parentShotsById.get(id), after = childShotsById.get(id);
    const strippedBefore = clone(before || {}), strippedAfter = clone(after || {});
    delete strippedBefore.assetType;
    delete strippedAfter.assetType;
    if (!before || !after || before.assetType !== 'generated_clip' || after.assetType !== 'controlled_image'
        || before.visualType !== 'CLIP' || after.visualType !== 'CLIP'
        || !same(strippedBefore, strippedAfter)) throw new Error(`CONTROLLED_STILL_UNAPPROVED_FIELD_CHANGE:${id}`);
    changedIds.push(id);
  }
  for (const before of parentShots.allShots) {
    if (!scope.has(before.beatId)) {
      if (!same(before, childShotsById.get(before.beatId))) throw new Error(`CONTROLLED_STILL_OUT_OF_SCOPE_SHOT_CHANGE:${before.beatId}`);
    }
  }
  const parentEntries = new Map(parentManifest.shots.map(entry => [entry.shotId, entry]));
  const childEntries = new Map(childManifest.shots.map(entry => [entry.shotId, entry]));
  if (parentEntries.size !== parentManifest.shots.length || childEntries.size !== childManifest.shots.length
      || !same(parentManifest.shots.map(item => item.shotId), childManifest.shots.map(item => item.shotId))) {
    throw new Error('CONTROLLED_STILL_MANIFEST_MEMBERSHIP_CHANGED');
  }
  for (const id of CONTROLLED_STILL_BEAT_IDS) {
    const before = parentEntries.get(id), after = childEntries.get(id);
    const oldEntry = clone(before || {}), newEntry = clone(after || {});
    delete oldEntry.assetType; delete newEntry.assetType;
    if (!before || !after || before.productionMethod !== 'CONTROLLED_STILL' || after.productionMethod !== 'CONTROLLED_STILL'
        || before.assetType !== 'generated_clip' || after.assetType !== 'controlled_image'
        || !same(oldEntry, newEntry)) throw new Error(`CONTROLLED_STILL_MANIFEST_FIELD_CHANGE:${id}`);
  }
  for (const before of parentManifest.shots) {
    if (!scope.has(before.shotId) && !same(before, childEntries.get(before.shotId))) throw new Error(`CONTROLLED_STILL_OUT_OF_SCOPE_MANIFEST_CHANGE:${before.shotId}`);
  }
  if (childManifest.candidateSha256 !== sha256(childShotsBytes)) throw new Error('CONTROLLED_STILL_MANIFEST_CHILD_HASH_MISMATCH');

  const parentPolicy = input.parentTimingPolicy ? (Buffer.isBuffer(input.parentTimingPolicy) ? parseBytes(input.parentTimingPolicy, 'PARENT_TIMING_POLICY') : input.parentTimingPolicy) : null;
  const oldException = parentPolicy?.exceptions?.find(entry => entry.beatId === 'ACT1_B030');
  const expectedOld = oldException?.productionObligationsSha256;
  const newException = renewalPolicy.exceptions?.find(entry => entry.beatId === 'ACT1_B030');
  if (!parentPolicy || !Buffer.isBuffer(input.parentTimingPolicyBytes)) throw new Error('CONTROLLED_STILL_PARENT_TIMING_POLICY_REQUIRED');
  assertRawHash(input.parentTimingPolicyBytes, PARENT.timingPolicySha256, 'PARENT_TIMING_POLICY');
  if (expectedOld !== PARENT.oldAct1B030ObligationSha256
      || newException?.productionObligationsSha256 !== PARENT.newAct1B030ObligationSha256
      || newException?.productionObligations?.assetType !== 'controlled_image'
      || !oldException?.productionObligations || oldException.productionObligations.assetType !== 'generated_clip') {
    throw new Error('CONTROLLED_STILL_ACT1_B030_TIMING_OBLIGATION_MISMATCH');
  }
  const oldObligationClone = clone(oldException.productionObligations);
  const newObligationClone = clone(newException.productionObligations);
  oldObligationClone.assetType = 'controlled_image';
  if (!same(oldObligationClone, newObligationClone)
      || canonicalSha256(oldException.productionObligations) !== PARENT.oldAct1B030ObligationSha256
      || canonicalSha256(newException.productionObligations) !== PARENT.newAct1B030ObligationSha256) {
    throw new Error('CONTROLLED_STILL_ACT1_B030_OBLIGATION_SCOPE_INVALID');
  }
  const expectedChildPolicy = clone(parentPolicy);
  expectedChildPolicy.binding.candidateShotDefinitionsSha256 = sha256(childShotsBytes);
  expectedChildPolicy.binding.candidateProductionManifestSha256 = sha256(childManifestBytes);
  for (const entry of expectedChildPolicy.exceptions) {
    entry.inputHashes = clone(expectedChildPolicy.binding);
    if (entry.beatId === 'ACT1_B030') {
      entry.productionObligations.assetType = 'controlled_image';
      entry.productionObligationsSha256 = PARENT.newAct1B030ObligationSha256;
    }
  }
  if (!same(expectedChildPolicy, renewalPolicy)) throw new Error('CONTROLLED_STILL_RENEWED_POLICY_UNAPPROVED_CHANGE');
  if (renewalBinding.schemaVersion !== 'phase3-timing-policy-child-renewal-binding/1.0.0'
      || renewalBinding.status !== 'APPROVED_CANDIDATE_SPECIFIC_CHILD_BINDING'
      || renewalBinding.beatId !== 'ACT1_B030'
      || renewalBinding.parentTimingPolicySha256 !== PARENT.timingPolicySha256
      || renewalBinding.parentTimingApprovalSha256 !== PARENT.timingApprovalSha256
      || renewalBinding.renewalApprovalSha256 !== PARENT.renewalApprovalSha256
      || renewalBinding.oldProductionObligationSha256 !== PARENT.oldAct1B030ObligationSha256
      || renewalBinding.newProductionObligationSha256 !== PARENT.newAct1B030ObligationSha256
      || renewalBinding.childTimingPolicySha256 !== sha256(renewalPolicyBytes)
      || renewalBinding.childShotDefinitionsSha256 !== sha256(childShotsBytes)
      || renewalBinding.childProductionManifestSha256 !== sha256(childManifestBytes)) {
    throw new Error('CONTROLLED_STILL_TIMING_RENEWAL_BINDING_INVALID');
  }
  if (renewalApproval.status !== 'APPROVED' || renewalApproval.approvedBy !== 'Yakubu Moshood'
      || renewalApproval.scope?.beatId !== 'ACT1_B030'
      || renewalApproval.bindings?.parentTimingApprovalSha256 !== PARENT.timingApprovalSha256
      || renewalApproval.bindings?.parentCandidateIndexSha256 !== PARENT.candidateIndexSha256
      || renewalApproval.bindings?.originalProductionObligationSha256 !== PARENT.oldAct1B030ObligationSha256
      || renewalApproval.bindings?.correctedProductionObligationSha256 !== PARENT.newAct1B030ObligationSha256
      || renewalApproval.authority?.providerAuthorization !== false
      || renewalApproval.authority?.promotionAuthorization !== false) {
    throw new Error('CONTROLLED_STILL_TIMING_RENEWAL_APPROVAL_INVALID');
  }
  const context = Object.freeze({ authorizedBeatIds: Object.freeze(changedIds), amendmentSha256: PARENT.amendmentSha256,
    applicationApprovalSha256: PARENT.applicationApprovalSha256, renewalApprovalSha256: PARENT.renewalApprovalSha256 });
  VERIFIED_CONTEXTS.add(context);
  return context;
}

function isVerifiedControlledStillContext(context) {
  return Boolean(context && VERIFIED_CONTEXTS.has(context));
}

function assertCandidateFileSet({ candidateIndexBytes, candidateFiles } = {}) {
  const index = parseBytes(candidateIndexBytes, 'CHILD_INDEX');
  if (!Array.isArray(index.files)) throw new Error('CONTROLLED_STILL_CHILD_INDEX_INVALID');
  const expected = new Map();
  for (const item of index.files) {
    if (!item || typeof item.path !== 'string' || item.path.startsWith('/') || item.path.includes('..')
        || !Number.isSafeInteger(item.bytes) || !/^[a-f0-9]{64}$/u.test(item.sha256 || '') || expected.has(item.path)) {
      throw new Error('CONTROLLED_STILL_CHILD_INDEX_ENTRY_INVALID');
    }
    expected.set(item.path, item);
  }
  const actual = candidateFiles instanceof Map ? candidateFiles : new Map(Object.entries(candidateFiles || {}));
  if (actual.size !== expected.size) throw new Error('CONTROLLED_STILL_CHILD_INDEX_FILE_SET_MISMATCH');
  for (const [name, record] of expected) {
    const bytes = actual.get(name);
    if (!Buffer.isBuffer(bytes) || bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new Error(`CONTROLLED_STILL_CHILD_INDEX_HASH_MISMATCH:${name}`);
    }
  }
  return { fileCount: expected.size, status: 'PASS' };
}

function readVerifiedChildContext(candidateDirectory, { fsImpl = require('node:fs') } = {}) {
  const path = require('node:path');
  const root = path.resolve(candidateDirectory);
  const indexPath = path.join(root, 'candidate-package-sha256.json');
  const indexBytes = fsImpl.readFileSync(indexPath);
  const actualFiles = new Map();
  const walk = directory => {
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const stat = fsImpl.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`CONTROLLED_STILL_CHILD_SYMLINK_FORBIDDEN:${path.relative(root, fullPath)}`);
      if (stat.isDirectory()) walk(fullPath);
      else if (stat.isFile()) {
        const relative = path.relative(root, fullPath).split(path.sep).join('/');
        if (relative !== 'candidate-package-sha256.json') actualFiles.set(relative, fsImpl.readFileSync(fullPath));
      } else throw new Error(`CONTROLLED_STILL_CHILD_NONREGULAR_FILE:${path.relative(root, fullPath)}`);
    }
  };
  walk(root);
  assertCandidateFileSet({ candidateIndexBytes: indexBytes, candidateFiles: actualFiles });
  const parentIndex = parseBytes(actualFiles.get('revision-lineage/parent-candidate-package-sha256.v1.json'), 'PARENT_INDEX');
  const actualPaths = new Set(actualFiles.keys());
  const parentPaths = new Set(parentIndex.files.map(item => item.path));
  const expectedPaths = new Set([...parentPaths, ...CHILD_ADDITIONS]);
  if (!same([...actualPaths].sort(), [...expectedPaths].sort())) throw new Error('CONTROLLED_STILL_CHILD_PACKAGE_PATH_SET_INVALID');
  const childIndex = parseBytes(indexBytes, 'CHILD_INDEX');
  const childEntries = new Map(childIndex.files.map(item => [item.path, item]));
  const changedParentPaths = [];
  for (const item of parentIndex.files) {
    const actual = childEntries.get(item.path);
    if (!actual) throw new Error(`CONTROLLED_STILL_PARENT_FILE_MISSING:${item.path}`);
    if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) {
      changedParentPaths.push(item.path);
      if (!MECHANICAL_PARENT_CHANGES.includes(item.path)) throw new Error(`CONTROLLED_STILL_UNAPPROVED_PARENT_FILE_CHANGE:${item.path}`);
    }
  }
  if (!same(changedParentPaths.sort(), [...MECHANICAL_PARENT_CHANGES].sort())) {
    throw new Error(`CONTROLLED_STILL_MECHANICAL_PARENT_CHANGE_SET_INVALID:${changedParentPaths.sort().join(',')}`);
  }
  const context = makeVerifiedControlledStillContext({
    parentCandidateIndexBytes: actualFiles.get('revision-lineage/parent-candidate-package-sha256.v1.json'),
    parentShotDefinitionsBytes: actualFiles.get('revision-lineage/parent-shot-definitions.json'),
    parentProductionManifestBytes: actualFiles.get('revision-lineage/parent-production-manifest.json'),
    childShotDefinitionsBytes: actualFiles.get('shot-definitions.json'),
    childProductionManifestBytes: actualFiles.get('production-manifest.json'),
    amendmentBytes: actualFiles.get('revision-lineage/controlled-still-amendment.v1.json'),
    applicationApprovalBytes: actualFiles.get('approvals/controlled-still-application-approval.v1.json'),
    renewalApprovalBytes: actualFiles.get('approvals/act1-b030-timing-obligation-renewal-approval.v1.json'),
    renewalPolicyBytes: actualFiles.get('approvals/refreshed-timing-policy.act1-b030-renewal.v1.json'),
    renewalBindingBytes: actualFiles.get('approvals/act1-b030-timing-policy-renewal-binding.v1.json'),
    parentTimingPolicy: actualFiles.get('revision-lineage/parent-timing-policy.v5.json'),
    parentTimingPolicyBytes: actualFiles.get('revision-lineage/parent-timing-policy.v5.json'),
  });
  const proof = parseBytes(actualFiles.get('revision-lineage/controlled-still-child-application-proof.v1.json'), 'APPLICATION_PROOF');
  if (proof.schemaVersion !== 'phase3-controlled-still-child-amendment-proof/1.0.0'
      || proof.status !== 'PASS' || proof.parentCandidateIndexSha256 !== PARENT.candidateIndexSha256
      || proof.childShotDefinitionsSha256 !== sha256(actualFiles.get('shot-definitions.json'))
      || proof.childProductionManifestSha256 !== sha256(actualFiles.get('production-manifest.json'))
      || proof.childRevisionLineageSha256 !== sha256(actualFiles.get('revision-lineage/phase3-controlled-still-asset-type-lineage.v1.json'))
      || !same(proof.changedBeatIds, CONTROLLED_STILL_BEAT_IDS)
      || !same(proof.changedParentPaths, [...MECHANICAL_PARENT_CHANGES].sort())
      || proof.act1B030?.oldObligationSha256 !== PARENT.oldAct1B030ObligationSha256
      || proof.act1B030?.newObligationSha256 !== PARENT.newAct1B030ObligationSha256) {
    throw new Error(`CONTROLLED_STILL_CHILD_AMENDMENT_PROOF_INVALID:${JSON.stringify({ schema: proof.schemaVersion, status: proof.status,
      parent: proof.parentCandidateIndexSha256, childShots: proof.childShotDefinitionsSha256 === sha256(actualFiles.get('shot-definitions.json')),
      childManifest: proof.childProductionManifestSha256 === sha256(actualFiles.get('production-manifest.json')),
      childLineage: proof.childRevisionLineageSha256 === sha256(actualFiles.get('revision-lineage/phase3-controlled-still-asset-type-lineage.v1.json')),
      beatIds: same(proof.changedBeatIds, CONTROLLED_STILL_BEAT_IDS), parentPaths: same(proof.changedParentPaths, [...MECHANICAL_PARENT_CHANGES].sort()),
      old: proof.act1B030?.oldObligationSha256, next: proof.act1B030?.newObligationSha256 })}`);
  }
  return { context, indexBytes, fileCount: actualFiles.size, files: actualFiles, changedParentPaths };
}

module.exports = { PARENT, CONTROLLED_STILL_BEAT_IDS, makeVerifiedControlledStillContext,
  isVerifiedControlledStillContext, assertCandidateFileSet, readVerifiedChildContext,
  CHILD_ADDITIONS, MECHANICAL_PARENT_CHANGES, sha256, canonicalSha256 };
