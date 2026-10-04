'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const contract = require('../pipeline-updates/controlled-still-asset-amendment.cjs');
const shotValidator = require('../pipeline-updates/shot-definitions-validator.cjs');
const productionManifestValidator = require('../pipeline-updates/production-method-manifest.cjs');
const editPlanValidator = require('../pipeline-updates/edit-plan-validator.cjs');
const revisionLineage = require('../pipeline-updates/revision-lineage.cjs');
const evidenceValidator = require('../pipeline-updates/evidence-source-validator.cjs');
const assetReadiness = require('../pipeline-updates/v3-asset-readiness.cjs');
const proofPlanner = require('../pipeline-updates/proof-section-planner.cjs');

const PARENT_ID = 'phase2.3b-p-act3-refresh-candidate-local-20260928-v2';
const CHILD_ID = 'phase2.3b-p-act3-refresh-controlled-still-child-20261004-v1';
const CLOSURE_ID = 'phase3-controlled-still-child-closure-20261004-v2';
const AMENDMENT_RELATIVE = 'phase3-media-completion-review-20261002-v5/amendments/phase3-controlled-image-child-amendment.v1.json';
const RENEWAL_RELATIVE = 'phase3-act1-b030-timing-obligation-renewal-20261004-v1/act1-b030-renewal-approval.v1.json';
const APPLICATION_RELATIVE = 'phase3-production-media-readiness-closure-20261003-v2/detached-controlled-still-application-approval.v1.json';
const CLOSURE_PACKAGE_RELATIVE = 'phase3-production-media-readiness-closure-20261003-v2';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonicalSha = value => sha(Buffer.from(JSON.stringify(value), 'utf8'));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, jsonBytes(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function assertHash(file, expected, code) {
  if (!fs.existsSync(file)) throw new Error(`${code}:MISSING`);
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== expected) throw new Error(`${code}:HASH_MISMATCH:${sha(bytes)}`);
  return bytes;
}

function verifyIndexedDirectory(directory, indexName, expectedIndexHash, expectedCount) {
  const indexFile = path.join(directory, indexName);
  const indexBytes = fs.readFileSync(indexFile);
  if (expectedIndexHash && sha(indexBytes) !== expectedIndexHash) throw new Error(`INDEX:HASH_MISMATCH:${sha(indexBytes)}`);
  const index = JSON.parse(indexBytes.toString('utf8'));
  if (!Array.isArray(index.files)) throw new Error('PACKAGE_INDEX_SHAPE_INVALID');
  const seen = new Set();
  for (const item of index.files) {
    if (!item || typeof item.path !== 'string' || path.isAbsolute(item.path) || item.path.split(/[\\/]/u).includes('..') || seen.has(item.path)) throw new Error(`PACKAGE_INDEX_PATH_INVALID:${item?.path}`);
    seen.add(item.path);
    const file = path.join(directory, ...item.path.split('/'));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`PACKAGE_FILE_TYPE_INVALID:${item.path}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw new Error(`PACKAGE_FILE_HASH_MISMATCH:${item.path}`);
  }
  const actual = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`PACKAGE_SYMLINK_FORBIDDEN:${path.relative(directory, full)}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        const relative = path.relative(directory, full).split(path.sep).join('/');
        if (relative !== indexName) actual.push(relative);
      } else throw new Error(`PACKAGE_NONREGULAR_FILE:${path.relative(directory, full)}`);
    }
  };
  walk(directory);
  if (!equal(actual.sort(), [...seen].sort())) throw new Error('PACKAGE_FILE_SET_MISMATCH');
  if (expectedCount != null && index.files.length !== expectedCount) throw new Error('PACKAGE_INDEX_COUNT_MISMATCH');
  return { index, indexBytes, indexSha256: sha(indexBytes), fileCount: index.files.length };
}

function verifyParentCandidate(parentDirectory, parentIndexSha) {
  const verified = verifyIndexedDirectory(parentDirectory, 'candidate-package-sha256.json', parentIndexSha, 150);
  return verified;
}

function copyTreeBytes(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name), stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`PARENT_SYMLINK_FORBIDDEN:${entry.name}`);
    if (stat.isDirectory()) copyTreeBytes(from, to);
    else if (stat.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
    else throw new Error(`PARENT_NONREGULAR_FILE:${entry.name}`);
  }
}

function verifyV2Closure(packageDirectory) {
  const packageIndexHash = '1437c1b1bdd34f60d7a42dd4904941f2f2d44b668cbbb0026d3ab018887cce2b';
  const verified = verifyIndexedDirectory(packageDirectory, 'package-index.v2.json', packageIndexHash, 21);
  const app = assertHash(path.join(packageDirectory, 'detached-controlled-still-application-approval.v1.json'),
    'e4d93e08935ebdf1f84a6e532a2a39a736a261f92cfa338ace7fe84354aa742b', 'APPLICATION_APPROVAL');
  const amendment = assertHash(path.join(packageDirectory, '..', 'phase3-media-completion-review-20261002-v5', 'amendments', 'phase3-controlled-image-child-amendment.v1.json'),
    contract.PARENT.amendmentSha256, 'AMENDMENT');
  return { verified, applicationApprovalBytes: app, amendmentBytes: amendment };
}

function collectCandidateFiles(directory) {
  const output = new Map();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`CHILD_SYMLINK_FORBIDDEN:${path.relative(directory, full)}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) {
        const relative = path.relative(directory, full).split(path.sep).join('/');
        if (relative !== 'candidate-package-sha256.json') output.set(relative, fs.readFileSync(full));
      } else throw new Error(`CHILD_NONREGULAR_FILE:${path.relative(directory, full)}`);
    }
  };
  walk(directory);
  return output;
}

function build(repoRoot = path.resolve(__dirname, '..')) {
  const artifactsRoot = path.join(repoRoot, 'artifacts', 'empire-omitted-v3', 'wells-fargo');
  const parentDirectory = path.join(artifactsRoot, PARENT_ID);
  const closurePackage = path.join(artifactsRoot, CLOSURE_PACKAGE_RELATIVE);
  const renewalApprovalFile = path.join(artifactsRoot, RENEWAL_RELATIVE);
  const amendmentFile = path.join(artifactsRoot, AMENDMENT_RELATIVE);
  const childPath = path.join(artifactsRoot, CLOSURE_ID, 'child-candidate');
  const outputRoot = path.dirname(childPath);
  if (fs.existsSync(outputRoot)) throw new Error('CONTROLLED_STILL_CHILD_TARGET_EXISTS');
  if (fs.existsSync(path.join(artifactsRoot, 'phase2.3b-p-act3-refresh-candidate-local-20260928-v2')) === false) throw new Error('PARENT_CANDIDATE_MISSING');
  if (sha(fs.readFileSync(renewalApprovalFile)) !== contract.PARENT.renewalApprovalSha256) throw new Error('RENEWAL_APPROVAL_HASH_MISMATCH');
  const parentVerified = verifyParentCandidate(parentDirectory, contract.PARENT.candidateIndexSha256);
  const closureVerified = verifyV2Closure(closurePackage);
  const amendmentBytes = assertHash(amendmentFile, contract.PARENT.amendmentSha256, 'AMENDMENT');
  const parentPolicyBytes = assertHash(path.join(parentDirectory, 'approvals', 'refreshed-timing-policy.v5.json'), contract.PARENT.timingPolicySha256, 'PARENT_TIMING_POLICY');
  const parentShotsBytes = assertHash(path.join(parentDirectory, 'shot-definitions.json'), contract.PARENT.shotDefinitionsSha256, 'PARENT_SHOT_DEFINITIONS');
  const parentManifestBytes = assertHash(path.join(parentDirectory, 'production-manifest.json'), contract.PARENT.productionManifestSha256, 'PARENT_PRODUCTION_MANIFEST');

  const tempParent = path.join(artifactsRoot, `.${CLOSURE_ID}.tmp-${process.pid}-${Date.now()}`);
  const tempChild = path.join(tempParent, 'child-candidate');
  fs.mkdirSync(tempParent, { recursive: false });
  try {
    copyTreeBytes(parentDirectory, tempChild);
    const amendment = JSON.parse(amendmentBytes.toString('utf8'));
    const shotDefs = JSON.parse(parentShotsBytes.toString('utf8'));
    const production = JSON.parse(parentManifestBytes.toString('utf8'));
    const beatIds = [...contract.CONTROLLED_STILL_BEAT_IDS];
    const idSet = new Set(beatIds);
    const shotsById = new Map(shotDefs.allShots.map(shot => [shot.beatId, shot]));
    if (shotsById.size !== 153 || idSet.size !== 34) throw new Error('PARENT_SHOT_INVENTORY_INVALID');
    for (const id of beatIds) {
      const shot = shotsById.get(id);
      if (!shot || shot.assetType !== 'generated_clip' || shot.visualType !== 'CLIP') throw new Error(`AMENDMENT_PARENT_BEAT_MISMATCH:${id}`);
      shot.assetType = 'controlled_image';
      const mirror = shotDefs.acts[shot.actKey]?.find(item => item.beatId === id);
      if (!mirror || mirror.assetType !== 'generated_clip') throw new Error(`AMENDMENT_PARENT_MIRROR_MISMATCH:${id}`);
      mirror.assetType = 'controlled_image';
      const record = production.shots.find(item => item.shotId === id);
      if (!record || record.productionMethod !== 'CONTROLLED_STILL' || record.assetType !== 'generated_clip') throw new Error(`AMENDMENT_PARENT_MANIFEST_MISMATCH:${id}`);
      record.assetType = 'controlled_image';
    }
    const shotDefsBytes = jsonBytes(shotDefs);
    const shotDefsSha = sha(shotDefsBytes);
    production.candidateSha256 = shotDefsSha;
    const productionBytes = jsonBytes(production);
    const productionSha = sha(productionBytes);
    fs.writeFileSync(path.join(tempChild, 'shot-definitions.json'), shotDefsBytes);
    fs.writeFileSync(path.join(tempChild, 'production-manifest.json'), productionBytes);
    const childEvidenceManifest = readJson(path.join(tempChild, 'evidence-source-manifest.json'));
    childEvidenceManifest.shotDefinitionsSha256 = shotDefsSha;
    writeJson(path.join(tempChild, 'evidence-source-manifest.json'), childEvidenceManifest);
    for (const graphicBindingFile of ['graphic-asset-manifest.json', 'graphic-requirements-inventory.json']) {
      const graphicBinding = readJson(path.join(tempChild, graphicBindingFile));
      graphicBinding.sourceShotDefinitionsSha256 = shotDefsSha;
      graphicBinding.sourceProductionManifestSha256 = productionSha;
      writeJson(path.join(tempChild, graphicBindingFile), graphicBinding);
    }

    const parentTimingPolicy = JSON.parse(parentPolicyBytes.toString('utf8'));
    const renewedPolicy = structuredClone(parentTimingPolicy);
    renewedPolicy.binding.candidateShotDefinitionsSha256 = shotDefsSha;
    renewedPolicy.binding.candidateProductionManifestSha256 = productionSha;
    for (const entry of renewedPolicy.exceptions) {
      entry.inputHashes = structuredClone(renewedPolicy.binding);
      if (entry.beatId === 'ACT1_B030') {
        entry.productionObligations.assetType = 'controlled_image';
        entry.productionObligationsSha256 = contract.PARENT.newAct1B030ObligationSha256;
      }
    }
    const renewedPolicyBytes = jsonBytes(renewedPolicy);
    const renewedPolicySha = sha(renewedPolicyBytes);
    const childRevisionLedger = {
      ledgerVersion: '1.0.0',
      revisionId: 'phase3-controlled-still-asset-type-child-20261004',
      revisionVersion: 'phase3-controlled-still-asset-type-amendment/1.0.0',
      approvalStatus: 'APPROVED',
      lineageRole: 'current',
      parentArtifactSha256: sha(parentShotsBytes),
      resultArtifactSha256: shotDefsSha,
      entries: beatIds.map(beatId => ({ shotId: beatId, beatId,
        actKey: shotsById.get(beatId).actKey, mirrorActKey: shotsById.get(beatId).actKey,
        fieldPath: 'assetType', beforeValue: 'generated_clip', afterValue: 'controlled_image',
        reason: 'APPROVED_34_ROW_CONTROLLED_STILL_ASSET_TYPE_AMENDMENT',
        revisionVersion: 'phase3-controlled-still-asset-type-amendment/1.0.0', approvalStatus: 'APPROVED' })),
      bindings: [], retirements: [], permittedImmutablePaths: [],
      approval: { status: 'APPROVED', basis: `Detached child-application approval ${contract.PARENT.applicationApprovalSha256} and candidate-specific ACT1_B030 timing renewal ${contract.PARENT.renewalApprovalSha256}.` },
    };
    const childRevisionLedgerBytes = jsonBytes(childRevisionLedger);
    const renewalBinding = {
      schemaVersion: 'phase3-timing-policy-child-renewal-binding/1.0.0',
      status: 'APPROVED_CANDIDATE_SPECIFIC_CHILD_BINDING',
      candidateId: CHILD_ID,
      parentPolicyPath: 'revision-lineage/parent-timing-policy.v5.json',
      parentTimingPolicySha256: contract.PARENT.timingPolicySha256,
      parentTimingApprovalSha256: contract.PARENT.timingApprovalSha256,
      renewalApprovalPath: 'approvals/act1-b030-timing-obligation-renewal-approval.v1.json',
      renewalApprovalSha256: contract.PARENT.renewalApprovalSha256,
      childTimingPolicyPath: 'approvals/refreshed-timing-policy.act1-b030-renewal.v1.json',
      childTimingPolicySha256: renewedPolicySha,
      childShotDefinitionsSha256: shotDefsSha,
      childProductionManifestSha256: productionSha,
      childRevisionLineageSha256: sha(childRevisionLedgerBytes),
      beatId: 'ACT1_B030',
      oldProductionObligationSha256: contract.PARENT.oldAct1B030ObligationSha256,
      newProductionObligationSha256: contract.PARENT.newAct1B030ObligationSha256,
      unchangedTimingAndEditorialFields: true,
      parentApprovalPreserved: true,
    };
    const renewalBindingBytes = jsonBytes(renewalBinding);
    const appliedAmendment = {
      schemaVersion: 'phase3-controlled-still-applied-child-amendment/1.0.0',
      status: 'APPLIED_TO_ISOLATED_CHILD_CANDIDATE',
      sourceAmendmentSha256: contract.PARENT.amendmentSha256,
      applicationApprovalSha256: contract.PARENT.applicationApprovalSha256,
      parentCandidateIndexSha256: contract.PARENT.candidateIndexSha256,
      childCandidateId: CHILD_ID,
      exactScope: amendment.exactScope,
      rows: beatIds.map(beatId => ({ beatId, productionMethod: 'CONTROLLED_STILL', visualType: 'CLIP', from: 'generated_clip', to: 'controlled_image' })),
      changedFieldCount: 34,
      preservedFields: ['beatId','narrationExcerpt','startSec','endSec','durationSec','startWordIndex','endWordIndex','visualIntent','visual','visualType','productionMethod','ownership','evidence bindings','revision history'],
      noMediaGenerated: true,
      noEpisodeRootWrites: true,
    };
    const lineageProof = {
      schemaVersion: 'phase3-controlled-still-child-amendment-proof/1.0.0',
      status: 'PASS',
      parentCandidateId: PARENT_ID,
      childCandidateId: CHILD_ID,
      parentCandidateIndexSha256: contract.PARENT.candidateIndexSha256,
      parentShotDefinitionsSha256: contract.PARENT.shotDefinitionsSha256,
      parentProductionManifestSha256: contract.PARENT.productionManifestSha256,
      sourceAmendmentSha256: contract.PARENT.amendmentSha256,
      applicationApprovalSha256: contract.PARENT.applicationApprovalSha256,
      renewalApprovalSha256: contract.PARENT.renewalApprovalSha256,
      changedBeatIds: beatIds,
      changedField: 'assetType',
      from: 'generated_clip',
      to: 'controlled_image',
      childShotDefinitionsSha256: shotDefsSha,
      childProductionManifestSha256: productionSha,
      act1B030: { oldObligationSha256: contract.PARENT.oldAct1B030ObligationSha256, newObligationSha256: contract.PARENT.newAct1B030ObligationSha256 },
      changedParentPaths: [...contract.MECHANICAL_PARENT_CHANGES].sort(),
      childRevisionLineageSha256: sha(childRevisionLedgerBytes),
      noNarrationChanges: true,
      noTimingOrFrameChanges: true,
      noVisualOrVisualTypeChanges: true,
      noProductionMethodChanges: true,
      noOwnershipOrEvidenceChanges: true,
      noParentLineageChanges: true,
      act3bB010Retired: true,
    };
    const lineageProofBytes = jsonBytes(lineageProof);

    const writeChildJson = (relative, value) => writeJson(path.join(tempChild, ...relative.split('/')), value);
    const copyBytes = (relative, bytes) => fs.writeFileSync(path.join(tempChild, ...relative.split('/')), bytes);
    copyBytes('revision-lineage/parent-candidate-package-sha256.v1.json', fs.readFileSync(path.join(parentDirectory, 'candidate-package-sha256.json')));
    copyBytes('revision-lineage/parent-shot-definitions.json', parentShotsBytes);
    copyBytes('revision-lineage/parent-production-manifest.json', parentManifestBytes);
    copyBytes('revision-lineage/parent-timing-policy.v5.json', parentPolicyBytes);
    copyBytes('revision-lineage/controlled-still-amendment.v1.json', amendmentBytes);
    copyBytes('approvals/controlled-still-application-approval.v1.json', closureVerified.applicationApprovalBytes);
    copyBytes('approvals/act1-b030-timing-obligation-renewal-approval.v1.json', fs.readFileSync(renewalApprovalFile));
    copyBytes('approvals/refreshed-timing-policy.act1-b030-renewal.v1.json', renewedPolicyBytes);
    copyBytes('approvals/act1-b030-timing-policy-renewal-binding.v1.json', renewalBindingBytes);
    copyBytes('revision-lineage/phase3-controlled-still-amendment-application.v1.json', jsonBytes(appliedAmendment));
    copyBytes('revision-lineage/phase3-controlled-still-asset-type-lineage.v1.json', childRevisionLedgerBytes);
    // The proof is written to its contract path; the applied amendment is retained as its own audit artifact.
    copyBytes('revision-lineage/controlled-still-child-application-proof.v1.json', lineageProofBytes);

    const plan = readJson(path.join(tempChild, 'edit-plan.json'));
    const timestamps = readJson(path.join(tempChild, 'timing', 'word-timestamps.json'));
    const revisionChain = [
      readJson(path.join(tempChild, 'revision-lineage', 'phase2.2d-lineage.v1.json')),
      readJson(path.join(tempChild, 'revision-lineage', 'phase2.3b-sv-amendment.v1.json')),
      readJson(path.join(tempChild, 'revision-lineage', 'phase2.3b-b017-factual-correction.v1.json')),
      readJson(path.join(tempChild, 'revision-lineage', 'phase2.3b-p-retiming.v1.json')),
      childRevisionLedger,
    ];
    const context = contract.makeVerifiedControlledStillContext({
      parentCandidateIndexBytes: fs.readFileSync(path.join(parentDirectory, 'candidate-package-sha256.json')),
      parentShotDefinitionsBytes: parentShotsBytes,
      parentProductionManifestBytes: parentManifestBytes,
      childShotDefinitionsBytes: shotDefsBytes,
      childProductionManifestBytes: productionBytes,
      amendmentBytes,
      applicationApprovalBytes: closureVerified.applicationApprovalBytes,
      renewalApprovalBytes: fs.readFileSync(renewalApprovalFile),
      renewalPolicyBytes: renewedPolicyBytes,
      renewalBindingBytes,
      parentTimingPolicy: parentTimingPolicy,
      parentTimingPolicyBytes: parentPolicyBytes,
    });
    const editValidation = editPlanValidator.validateEditPlan({ plan, wordTimestamps: timestamps });
    if (editValidation.status !== 'PASS' || editValidation.errors.length) throw new Error('CHILD_EDIT_PLAN_VALIDATION_FAILED');
    const shotValidation = shotValidator.validateShotDefinitions({ plan, shotDefs, revisionChain, controlledStillContext: context });
    if (shotValidation.status !== 'PASS' || shotValidation.errors.length) throw new Error(`CHILD_SHOT_VALIDATION_FAILED:${shotValidation.errors[0]?.code}`);
    const revisionValidation = revisionLineage.validateRevisionChain({ shotDefs, revisionChain });
    if (revisionValidation.status !== 'PASS' || revisionValidation.errors.length) throw new Error('CHILD_REVISION_LINEAGE_VALIDATION_FAILED');
    const productionValidation = productionManifestValidator.validateProductionMethodManifest({ manifest: production, shotDefs, candidateSha256: shotDefsSha });
    if (productionValidation.status !== 'PASS' || productionValidation.errors.length) throw new Error(`CHILD_PRODUCTION_VALIDATION_FAILED:${productionValidation.errors[0]?.code}`);
    const evidence = readJson(path.join(tempChild, 'evidence-source-manifest.json'));
    const evidenceValidation = evidenceValidator.validateEvidenceSourceManifest({ manifest: evidence, shotDefs,
      evidenceAssetDir: path.join(tempChild, 'assets', 'evidence'), requireLocalAssets: true });
    if (evidenceValidation.status !== 'PASS' || evidenceValidation.errors.length) throw new Error('CHILD_EVIDENCE_VALIDATION_FAILED');
    const graphicReadiness = assetReadiness.assertV3AssetsReadyForRender({ episodeDir: tempChild,
      shotDefsPath: path.join(tempChild, 'shot-definitions.json'), shotDefs });
    if (graphicReadiness.graphicAssetManifest.entries.length !== 76) throw new Error('CHILD_GRAPHIC_VALIDATION_FAILED');
    const proofPlan = proofPlanner.planProofSection({ shotDefs, productionManifest: production });
    const parentProofPlan = readJson(path.join(parentDirectory, 'proof-section-plan.json'));
    if (!equal(proofPlan, parentProofPlan)) throw new Error('CHILD_PROOF_SECTION_PLAN_CHANGED');

    writeChildJson('validation/shot-definitions-validation.json', shotValidation);
    writeChildJson('validation/production-manifest-validation.json', productionValidation);
    writeChildJson('validation/revision-lineage-validation.json', { ...revisionValidation,
      controlledStillAmendment: { status: 'PASS', sourceAmendmentSha256: contract.PARENT.amendmentSha256,
        applicationApprovalSha256: contract.PARENT.applicationApprovalSha256, renewalApprovalSha256: contract.PARENT.renewalApprovalSha256,
        changedBeatIds: beatIds } });
    writeChildJson('validation/boundary-and-timing-validation.json', {
      ...readJson(path.join(parentDirectory, 'validation', 'boundary-and-timing-validation.json')),
      childTimingObligationRenewal: { status: 'PASS', policyPath: 'approvals/refreshed-timing-policy.act1-b030-renewal.v1.json',
        policySha256: renewedPolicySha, approvalSha256: contract.PARENT.renewalApprovalSha256,
        beatId: 'ACT1_B030', oldObligationSha256: contract.PARENT.oldAct1B030ObligationSha256,
        newObligationSha256: contract.PARENT.newAct1B030ObligationSha256, timingAndEditorialFieldsChanged: false },
    });
    writeChildJson('proof-section-plan.json', proofPlan);
    const candidateReport = readJson(path.join(tempChild, 'candidate-report.json'));
    candidateReport.candidateSpecificControlledStillAmendment = { status: 'PASS', childCandidateId: CHILD_ID,
      parentCandidateIndexSha256: contract.PARENT.candidateIndexSha256, sourceAmendmentSha256: contract.PARENT.amendmentSha256,
      applicationApprovalSha256: contract.PARENT.applicationApprovalSha256, renewalApprovalSha256: contract.PARENT.renewalApprovalSha256,
      changedBeatCount: 34, changedBeatIds: beatIds, act1B030OldObligationSha256: contract.PARENT.oldAct1B030ObligationSha256,
      act1B030NewObligationSha256: contract.PARENT.newAct1B030ObligationSha256,
      narrationTimingVisualOwnershipEvidenceUnchanged: true, productionMethodUnchanged: true,
      mediaGenerated: false, productionReady: false, renderAuthorized: false };
    candidateReport.controlledStillContractValidation = 'PASS';
    candidateReport.controlledStillTimingRenewalValidation = 'PASS';
    writeChildJson('candidate-report.json', candidateReport);

    const reportRows = [];
    for (const beatId of beatIds) {
      const source = shotsById.get(beatId);
      reportRows.push({ beatId, actKey: source.actKey, changedFields: ['assetType'], before: { assetType: 'generated_clip' }, after: { assetType: 'controlled_image' } });
    }
    const differenceReport = {
      schemaVersion: 'phase3-controlled-still-parent-child-difference-report/1.0.0', status: 'PASS',
      parentCandidateId: PARENT_ID, childCandidateId: CHILD_ID,
      parentCandidateIndexSha256: contract.PARENT.candidateIndexSha256,
      changedAssetTypeRows: 34, changedBeatIds: beatIds, changedRows: reportRows,
      candidateSpecificTimingObligationRenewals: [{ beatId: 'ACT1_B030', field: 'productionObligations.assetType',
        from: 'generated_clip', to: 'controlled_image', oldSha256: contract.PARENT.oldAct1B030ObligationSha256,
        newSha256: contract.PARENT.newAct1B030ObligationSha256, approvalSha256: contract.PARENT.renewalApprovalSha256 }],
      zeroNarrationChanges: true, zeroTimingOrFrameChanges: true, zeroVisualChanges: true, zeroProductionMethodChanges: true,
      zeroEvidenceEntryOrOwnershipChanges: true, evidenceShotDefinitionsBindingRecomputed: true,
      graphicAssetHashesAndContentUnchanged: true, graphicSourceBindingsRecomputed: true,
      zeroRevisionHistoryChangesExceptMechanicalChildEdge: true,
      mechanicallyDerivedPaths: [...contract.MECHANICAL_PARENT_CHANGES].sort(), act3bB010Retired: true,
    };
    writeJson(path.join(tempParent, 'parent-versus-child-difference-report.v1.json'), differenceReport);
    writeJson(path.join(tempParent, 'contract-repair-report.v1.json'), {
      schemaVersion: 'phase3-controlled-still-contract-repair-report/1.0.0', status: 'PASS',
      repair: 'CONTROLLED_STILL + controlled_image is accepted only in the exact approved 34-beat child amendment; still outputs route through CONTROLLED_STILL raster validation.',
      excludedFromAnimationQueue: true, visualTypePreserved: 'CLIP', unknownCombinationsFailClosed: true,
      noMediaGenerated: true, noProviderRequests: true, noEpisodeRootWrites: true,
    });
    writeJson(path.join(tempParent, 'remaining-production-blockers.v1.json'), {
      status: 'BLOCKED_PENDING_REVIEW_AND_PROVIDER_CONTRACT',
      blockers: ['ACT5_B009 child amendment and deterministic graphic binding remain unsigned/unapplied.',
        'ACT5_B016 approved ACT5_B015 source path and hash remain unresolved.',
        'Provider route, terms, ownership, current price and output properties remain unresolved pending pilot.'],
      pilotExecutionAuthorized: false, mediaGenerationAuthorized: false, candidateReconstructionAuthorized: false,
      promotionAuthorized: false, renderingAuthorized: false,
    });
    writeJson(path.join(tempParent, 'test-and-integrity-report.v1.json'), {
      status: 'PENDING_TEST_EXECUTION', baselineCommit: '0b7cf084386bc65a88021b3b11026036f9ddb3ca',
      baselineSuite: { files: 28, passed: 572, failed: 0, skipped: 0 },
      patchedSuite: null,
    });

    const indexFiles = [...collectCandidateFiles(tempChild)].map(([relative, bytes]) => ({ path: relative, bytes: bytes.length, sha256: sha(bytes) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    writeJson(path.join(tempChild, 'candidate-package-sha256.json'), {
      schemaVersion: 'candidate-package-sha256/1.0.0', candidateId: CHILD_ID,
      parentCandidateIndexSha256: contract.PARENT.candidateIndexSha256, fileCount: indexFiles.length, selfHashExcluded: true, files: indexFiles,
    });
    const childVerified = contract.readVerifiedChildContext(tempChild);
    if (childVerified.fileCount !== indexFiles.length || childVerified.context.authorizedBeatIds.length !== 34) throw new Error('CHILD_PACKAGE_INDEX_VERIFICATION_FAILED');
    const outerPackageIndex = root => {
      const rows = [];
      const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name), stat = fs.lstatSync(full);
          if (stat.isSymbolicLink()) throw new Error('CLOSURE_SYMLINK_FORBIDDEN');
          if (stat.isDirectory()) walk(full);
          else if (stat.isFile()) {
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (rel !== 'package-index.v1.json') { const bytes = fs.readFileSync(full); rows.push({ path: rel, bytes: bytes.length, sha256: sha(bytes) }); }
          }
        }
      };
      walk(root); return rows.sort((a, b) => a.path.localeCompare(b.path));
    };
    const packageFiles = outerPackageIndex(tempParent);
    writeJson(path.join(tempParent, 'package-index.v1.json'), { schemaVersion: 'phase3-controlled-still-child-closure-index/1.0.0',
      packageId: CLOSURE_ID, status: 'VALIDATED_LOCAL_CHILD_NOT_PRODUCTION_READY', fileCount: packageFiles.length,
      selfHashExcluded: true, files: packageFiles });
    fs.renameSync(tempParent, outputRoot);
    const finalChild = path.join(outputRoot, 'child-candidate');
    const finalPackage = verifyIndexedDirectory(outputRoot, 'package-index.v1.json', null, null);
    const finalCandidate = contract.readVerifiedChildContext(finalChild);
    return { status: 'CONTROLLED_STILL_CHILD_VALIDATED_NOT_PRODUCTION_READY', childCandidateId: CHILD_ID,
      childCandidateDirectory: finalChild, childCandidateIndexSha256: finalCandidate.indexBytes && sha(finalCandidate.indexBytes),
      closurePackageDirectory: outputRoot, closurePackageIndexSha256: finalPackage.indexSha256,
      childFileCount: finalCandidate.fileCount, closureFileCount: finalPackage.fileCount,
      changedBeatIds: beatIds, renewalApprovalSha256: contract.PARENT.renewalApprovalSha256 };
  } catch (error) {
    fs.rmSync(tempParent, { recursive: true, force: true });
    if (fs.existsSync(outputRoot)) fs.rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  try { console.log(JSON.stringify(build(), null, 2)); }
  catch (error) { console.error(`CONTROLLED_STILL_CHILD_BUILD_FAILED:${error.message}`); process.exitCode = 1; }
}

module.exports = { build, PARENT_ID, CHILD_ID, CLOSURE_ID };
