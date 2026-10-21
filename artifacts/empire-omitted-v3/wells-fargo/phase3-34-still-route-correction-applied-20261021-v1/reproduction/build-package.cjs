'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const WELLS = path.join(ROOT, 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const OUT = path.join(WELLS, 'phase3-34-still-route-correction-applied-20261021-v1');
const CHILD = path.join(OUT, 'child-candidate');
const SOURCE_PACKAGE = path.join(WELLS, 'phase3-consolidated-act5-production-candidate-20261004-v5');
const SOURCE = path.join(SOURCE_PACKAGE, 'candidate');
const ROUTE_PACKAGE = path.join(WELLS, 'phase3-34-still-route-correction-20261021-v1');
const REJECTED_PACKAGE = path.join(WELLS, 'phase3-consolidated-completion-review-20261021-v1');

const EXPECTED = Object.freeze({
  sourcePackageIndex: 'c50dd2d054c430f0daf5748de9a6d3e5c946cef1e8b4fbe57a4f986f6a48dac4',
  sourceCandidateIndex: 'a1981dd4c57a5c10c83fd2e3739d0630006e93e628a72cef3d574d07ef83b4cf',
  routePackageIndex: '5cdee80e0762b7cb559def2e8d888d1b10d457817cb9bb6fdf14296faa6e6036',
  amendment: '6695bd45e055a6d0c91c3f96291901affbad99fd37e8b98182c2362a8043d973',
  promptContracts: '8ecb834a08acf2012f4555f371e762ee8f181e0a285a871d7b168e2251d367fb',
  rejectedPackageIndex: '8ea25ef485e127a70e43fa2867a15d611be174c9925dcc59d5216448f79ce3e6',
  batches: [
    'bda967e41208c317e189691606d4763d33e70950af573a0a7d83b3a1bec1401b',
    '9d057eddd17fb02bb271a759ed1310c0dcf0be0bf3050483a8755d7abb4c07e5',
    '3de215b309a566be58745bb8bf1f309fe118f4eafbee2fb12b366c08cb709c2a',
    '5670c11fa945b30966f9254ac4e1d76f842691973ebc1afa3c0b5da964c757d1'
  ]
});

const shaBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => shaBytes(fs.readFileSync(file));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeBytes = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const writeJson = (file, value) => writeBytes(file, jsonBytes(value));
const clone = value => JSON.parse(JSON.stringify(value));
const posix = value => value.split(path.sep).join('/');
const relRoot = file => posix(path.relative(ROOT, file));
const relOut = file => posix(path.relative(OUT, file));

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function stableEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function recursiveDiff(before, after, prefix = '') {
  if (stableEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const out = [];
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i += 1) out.push(...recursiveDiff(before[i], after[i], `${prefix}[${i}]`));
    return out;
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const out = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) out.push(...recursiveDiff(before[key], after[key], prefix ? `${prefix}.${key}` : key));
    return out;
  }
  return [{ path: prefix, before, after }];
}

function walk(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(file));
    else if (entry.isFile()) result.push(file);
    else throw new Error(`NON_REGULAR_ENTRY:${file}`);
  }
  return result;
}

function replaceHashFields(value, oldHash, newHash) {
  if (Array.isArray(value)) return value.map(item => replaceHashFields(item, oldHash, newHash));
  if (!value || typeof value !== 'object') return value === oldHash ? newHash : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = replaceHashFields(item, oldHash, newHash);
  return out;
}

assert(path.basename(OUT) === 'phase3-34-still-route-correction-applied-20261021-v1', 'OUTPUT_SCOPE_INVALID');
assert(fs.existsSync(path.join(ROOT, '.git')), 'REPOSITORY_ROOT_NOT_FOUND');

const sourcePackageIndexPath = path.join(SOURCE_PACKAGE, 'package-index.v2.json');
const sourceCandidateIndexPath = path.join(SOURCE, 'candidate-package-sha256.json');
const routeIndexPath = path.join(ROUTE_PACKAGE, 'package-index.v1.json');
const amendmentPath = path.join(ROUTE_PACKAGE, 'exact-34-row-route-amendment.v1.json');
const promptContractsPath = path.join(ROUTE_PACKAGE, 'prompt-and-negative-contracts.v1.json');
const rejectedIndexPath = path.join(REJECTED_PACKAGE, 'package-index.v1.json');
assert(shaFile(sourcePackageIndexPath) === EXPECTED.sourcePackageIndex, 'SOURCE_PACKAGE_INDEX_HASH_MISMATCH');
assert(shaFile(sourceCandidateIndexPath) === EXPECTED.sourceCandidateIndex, 'SOURCE_CANDIDATE_INDEX_HASH_MISMATCH');
assert(shaFile(routeIndexPath) === EXPECTED.routePackageIndex, 'ROUTE_PACKAGE_INDEX_HASH_MISMATCH');
assert(shaFile(amendmentPath) === EXPECTED.amendment, 'AMENDMENT_HASH_MISMATCH');
assert(shaFile(promptContractsPath) === EXPECTED.promptContracts, 'PROMPT_CONTRACT_HASH_MISMATCH');
assert(shaFile(rejectedIndexPath) === EXPECTED.rejectedPackageIndex, 'REJECTED_PACKAGE_INDEX_HASH_MISMATCH');

const batchPaths = [1, 2, 3, 4].map(number => path.join(ROUTE_PACKAGE, 'provider-batches', `replacement-generated-stills-batch-${number}.v1.json`));
assert(batchPaths.every((file, index) => shaFile(file) === EXPECTED.batches[index]), 'BATCH_HASH_MISMATCH');

const approvalStatement = [
  'I, Yakubu Moshood, approve the non-authorizing Phase 3 34-still route-correction package `phase3-34-still-route-correction-20261021-v1`, bound to package-index SHA-256:',
  '',
  EXPECTED.routePackageIndex,
  '',
  'I approve the exact 34-row amendment, SHA-256:',
  '',
  EXPECTED.amendment,
  '',
  'This changes only:',
  '',
  '- `productionMethod`: `CONTROLLED_STILL` → `GENERATED_STILL`',
  '- `assetType`: `controlled_image` → `generated_image`',
  '',
  'The amendment includes ACT1_B005 and must preserve every locked editorial field, evidence and ownership binding, unrelated candidate record, completed production record and ACT3B_B010’s retired status.',
  '',
  'I approve the prompt and negative-instruction contracts, SHA-256:',
  '',
  EXPECTED.promptContracts,
  '',
  'I approve the four bounded replacement-still manifests:',
  '',
  `- Batch 1: \`${EXPECTED.batches[0]}\``,
  `- Batch 2: \`${EXPECTED.batches[1]}\``,
  `- Batch 3: \`${EXPECTED.batches[2]}\``,
  `- Batch 4: \`${EXPECTED.batches[3]}\``,
  '',
  'I accept USD 1.632 as the maximum human-approved exposure for these 34 replacement stills. I acknowledge the reconciled remaining plan of 83 provider submissions and USD 11.376 maximum planned exposure. Neither ceiling is provider-enforced.',
  '',
  'For the 16 text-sensitive beats, critical readable text must be applied deterministically after generation and must not be delegated to the image model.',
  '',
  'This approval is for planning and candidate application only. It creates no execution authorization, reserves no request key and authorizes no provider submission, retry, fallback, media generation, Stage04 modification, production-path installation, rendering or promotion.',
  '',
  'Every provider batch requires separate authorization. Every generated image must be inspected and explicitly approved by a human before use. Every animation remains blocked until its source still is generated, inspected, human-approved and SHA-256-bound.',
  '',
  'Record this as an immutable detached approval. Then apply the exact amendment to one isolated child candidate, regenerate only affected indexes, lineage and validation records, and prove that no field outside the approved 34-row route change was altered.',
  '',
  'Run the focused and complete canonical test suites. If validation passes, commit and push the candidate application to both authorized branches, but do not deploy or execute provider requests.'
].join('\n');

const approvalRecordPath = path.join(OUT, 'detached-route-correction-application-approval.v1.json');
writeJson(approvalRecordPath, {
  schemaVersion: 'phase3-34-still-route-correction-application-approval/1.0.0',
  status: 'APPROVED_FOR_ISOLATED_CHILD_CANDIDATE_APPLICATION_EXECUTION_UNAUTHORIZED',
  recordedAt: '2026-10-21T00:00:00.000+01:00',
  approvedBy: 'Yakubu Moshood',
  approvalStatement,
  approvalStatementSha256: shaBytes(Buffer.from(approvalStatement, 'utf8')),
  bindings: {
    routePackageIndexSha256: EXPECTED.routePackageIndex,
    amendmentSha256: EXPECTED.amendment,
    promptContractsSha256: EXPECTED.promptContracts,
    providerBatchManifestSha256s: EXPECTED.batches,
    replacementMaximumExposureUsd: 1.632,
    remainingProviderSubmissions: 83,
    remainingMaximumExposureUsd: 11.376
  },
  authority: {
    isolatedChildCandidateApplication: true,
    providerSubmissionsAuthorized: 0,
    executionAuthorizationsCreated: 0,
    requestKeysReserved: 0,
    retriesAuthorized: 0,
    fallbacksAuthorized: 0,
    mediaGenerationAuthorized: false,
    stage04ModificationAuthorized: false,
    productionPathInstallationAuthorized: false,
    renderingAuthorized: false,
    promotionAuthorized: false,
    deploymentAuthorized: false
  }
});
const approvalSha256 = shaFile(approvalRecordPath);

if (fs.existsSync(CHILD)) fs.rmSync(CHILD, { recursive: true, force: false });
fs.cpSync(SOURCE, CHILD, { recursive: true, errorOnExist: true, force: false });

const amendment = readJson(amendmentPath);
const promptContracts = readJson(promptContractsPath);
assert(amendment.rowCount === 34 && amendment.rows.length === 34, 'AMENDMENT_ROW_COUNT_INVALID');
assert(promptContracts.rowCount === 34 && promptContracts.rows.length === 34, 'PROMPT_ROW_COUNT_INVALID');
assert(promptContracts.rows.filter(row => row.twoStageRoute.required).length === 16, 'TEXT_SENSITIVE_COUNT_INVALID');
const amendmentByBeat = new Map(amendment.rows.map(row => [row.beatId, row]));
assert(amendmentByBeat.size === 34, 'AMENDMENT_BEAT_IDS_NOT_UNIQUE');

const parentShotPath = path.join(SOURCE, 'shot-definitions.json');
const childShotPath = path.join(CHILD, 'shot-definitions.json');
const parentManifestPath = path.join(SOURCE, 'production-manifest.json');
const childManifestPath = path.join(CHILD, 'production-manifest.json');
const parentShots = readJson(parentShotPath);
const childShots = clone(parentShots);
const parentManifest = readJson(parentManifestPath);
const childManifest = clone(parentManifest);

const changedBeatIds = [...amendmentByBeat.keys()];
for (const beatId of changedBeatIds) {
  const approved = amendmentByBeat.get(beatId);
  const manifestRow = childManifest.shots.find(row => row.shotId === beatId);
  assert(manifestRow, `MANIFEST_BEAT_MISSING:${beatId}`);
  assert(stableEqual(manifestRow, approved.before), `MANIFEST_BEFORE_BINDING_MISMATCH:${beatId}`);
  manifestRow.productionMethod = 'GENERATED_STILL';
  manifestRow.assetType = 'generated_image';
  assert(stableEqual(manifestRow, approved.after), `MANIFEST_AFTER_BINDING_MISMATCH:${beatId}`);

  const canonical = childShots.allShots.find(row => row.shotId === beatId);
  const mirror = childShots.acts[canonical.actKey].find(row => row.shotId === beatId);
  assert(canonical && mirror, `SHOT_DEFINITION_BEAT_MISSING:${beatId}`);
  assert(canonical.assetType === 'controlled_image' && mirror.assetType === 'controlled_image', `SHOT_BEFORE_ASSET_TYPE_MISMATCH:${beatId}`);
  canonical.assetType = 'generated_image';
  mirror.assetType = 'generated_image';
}
writeJson(childShotPath, childShots);
writeJson(childManifestPath, childManifest);

const manifestDiffs = recursiveDiff(parentManifest, childManifest);
const shotDiffs = recursiveDiff(parentShots, childShots);
const allowedManifest = new Set();
const allowedShot = new Set();
for (const beatId of changedBeatIds) {
  const manifestIndex = parentManifest.shots.findIndex(row => row.shotId === beatId);
  const canonicalIndex = parentShots.allShots.findIndex(row => row.shotId === beatId);
  const actKey = parentShots.allShots[canonicalIndex].actKey;
  const mirrorIndex = parentShots.acts[actKey].findIndex(row => row.shotId === beatId);
  allowedManifest.add(`shots[${manifestIndex}].assetType`);
  allowedManifest.add(`shots[${manifestIndex}].productionMethod`);
  allowedShot.add(`allShots[${canonicalIndex}].assetType`);
  allowedShot.add(`acts.${actKey}[${mirrorIndex}].assetType`);
}
assert(manifestDiffs.length === 68, `MANIFEST_DIFF_COUNT_INVALID:${manifestDiffs.length}`);
assert(shotDiffs.length === 68, `SHOT_DIFF_COUNT_INVALID:${shotDiffs.length}`);
assert(manifestDiffs.every(diff => allowedManifest.has(diff.path)), 'UNAUTHORIZED_MANIFEST_CHANGE');
assert(shotDiffs.every(diff => allowedShot.has(diff.path)), 'UNAUTHORIZED_SHOT_CHANGE');
assert(childManifest.shots.filter(row => row.productionMethod === 'CONTROLLED_STILL').length === 0, 'CONTROLLED_STILL_ROWS_REMAIN');
assert(childManifest.shots.filter(row => row.productionMethod === 'GENERATED_STILL').length === 42, 'GENERATED_STILL_COUNT_INVALID');
assert(!childManifest.shots.some(row => row.shotId === 'ACT3B_B010'), 'ACT3B_B010_RETIREMENT_VIOLATED');

const parentShotSha256 = shaFile(parentShotPath);
const childShotSha256 = shaFile(childShotPath);
const parentManifestSha256 = shaFile(parentManifestPath);
const childManifestSha256 = shaFile(childManifestPath);

const lineagePath = path.join(CHILD, 'revision-lineage', 'phase3-34-still-route-correction-application.v1.json');
writeJson(lineagePath, {
  schemaVersion: 'phase3-34-still-route-correction-application-lineage/1.0.0',
  status: 'PASS_APPROVED_ROUTE_ONLY_CHILD_APPLICATION_EXECUTION_UNAUTHORIZED',
  childCandidateId: 'phase3-34-still-route-correction-child-20261021-v1',
  parent: {
    packageIndexPath: relRoot(sourcePackageIndexPath),
    packageIndexSha256: EXPECTED.sourcePackageIndex,
    candidateIndexPath: relRoot(sourceCandidateIndexPath),
    candidateIndexSha256: EXPECTED.sourceCandidateIndex,
    shotDefinitionsSha256: parentShotSha256,
    productionManifestSha256: parentManifestSha256
  },
  approval: { path: relOut(approvalRecordPath), sha256: approvalSha256 },
  approvedPlanningPackage: {
    packageIndexSha256: EXPECTED.routePackageIndex,
    amendmentSha256: EXPECTED.amendment,
    promptContractsSha256: EXPECTED.promptContracts,
    providerBatchManifestSha256s: EXPECTED.batches
  },
  result: {
    shotDefinitionsSha256: childShotSha256,
    productionManifestSha256: childManifestSha256,
    affectedBeatIds: changedBeatIds,
    productionManifestScalarChanges: manifestDiffs.length,
    shotDefinitionScalarChanges: shotDiffs.length,
    changedFieldNames: ['assetType', 'productionMethod']
  },
  invariants: {
    beatIdsUnchanged: true,
    narrationUnchanged: true,
    timingAndFrameAllocationUnchanged: true,
    visualIntentUnchanged: true,
    evidenceBindingsUnchanged: true,
    ownershipFieldsUnchanged: true,
    unrelatedCandidateRecordsUnchanged: true,
    completedProductionRecordsUnchanged: ['ACT1_B006', 'ACT1_B009', 'ACT1_B010'],
    act3bB010Retired: true,
    providerSubmissionsAuthorized: 0,
    executionAuthorizationsCreated: 0
  }
});

const routeValidation = {
  schemaVersion: 'phase3-34-still-route-correction-application-validation/1.0.0',
  status: 'PASS_EXECUTION_UNAUTHORIZED',
  approvalSha256,
  amendmentSha256: EXPECTED.amendment,
  promptContractsSha256: EXPECTED.promptContracts,
  parentShotDefinitionsSha256: parentShotSha256,
  resultShotDefinitionsSha256: childShotSha256,
  parentProductionManifestSha256: parentManifestSha256,
  resultProductionManifestSha256: childManifestSha256,
  checks: {
    exact34ApprovedBeatsChanged: true,
    productionManifestChangesExactly68ApprovedRouteScalars: true,
    shotDefinitionChangesExactly68ApprovedAssetTypeMirrors: true,
    changedFieldUnionExactlyAssetTypeAndProductionMethod: true,
    allLockedEditorialFieldsPreserved: true,
    act1B005Included: changedBeatIds.includes('ACT1_B005'),
    act3bB010RetirementPreserved: true,
    completedProductionRecordsPreserved: true,
    promptContracts34Bound: true,
    textSensitiveBeats16Bound: true,
    providerBatchManifests4Bound: true,
    providerSubmissionAuthorityAbsent: true,
    executionAuthorizationAbsent: true,
    mediaGenerated: false,
    stage04Modified: false,
    productionPathsWritten: 0,
    rendered: false,
    promoted: false,
    deployed: false
  },
  errors: []
};
writeJson(path.join(CHILD, 'validation', 'route-correction-application-validation.v1.json'), routeValidation);

const productionValidationPath = path.join(CHILD, 'validation', 'production-manifest-validation.json');
const productionValidation = readJson(productionValidationPath);
productionValidation.candidateId = 'phase3-34-still-route-correction-child-20261021-v1';
productionValidation.productionManifestSha256 = childManifestSha256;
productionValidation.shotDefinitionsSha256 = childShotSha256;
productionValidation.methodCounts = { ESSENTIAL_ANIMATION: 23, GENERATED_STILL: 42, EVIDENCE_REFERENCE: 46, GRAPHIC_COMPILATION: 42 };
productionValidation.routeCorrection = { status: 'PASS', approvalSha256, amendmentSha256: EXPECTED.amendment, affectedRows: 34 };
writeJson(productionValidationPath, productionValidation);

const shotValidationPath = path.join(CHILD, 'validation', 'shot-definitions-validation.json');
const shotValidation = readJson(shotValidationPath);
shotValidation.routeCorrection = { status: 'PASS', parentSha256: parentShotSha256, resultSha256: childShotSha256, changedAssetTypeMirrors: 68, allOtherFieldsUnchanged: true };
writeJson(shotValidationPath, shotValidation);

const revisionValidationPath = path.join(CHILD, 'validation', 'revision-lineage-validation.json');
const revisionValidation = readJson(revisionValidationPath);
revisionValidation.generatedStillRouteCorrection = { status: 'PASS', approvalSha256, amendmentSha256: EXPECTED.amendment, lineageSha256: shaFile(lineagePath), affectedBeatIds: changedBeatIds, changedFieldNames: ['assetType', 'productionMethod'], executionAuthorized: false };
writeJson(revisionValidationPath, revisionValidation);

const boundaryValidationPath = path.join(CHILD, 'validation', 'boundary-and-timing-validation.json');
let boundaryValidation = readJson(boundaryValidationPath);
boundaryValidation = replaceHashFields(boundaryValidation, parentShotSha256, childShotSha256);
boundaryValidation = replaceHashFields(boundaryValidation, parentManifestSha256, childManifestSha256);
boundaryValidation.routeCorrectionTimingImpact = 'NONE';
writeJson(boundaryValidationPath, boundaryValidation);

const graphicValidationPath = path.join(CHILD, 'validation', 'graphic-asset-manifest-validation.v2.json');
const graphicValidation = readJson(graphicValidationPath);
graphicValidation.sourceProductionManifestSha256 = childManifestSha256;
graphicValidation.shotDefinitionsSha256 = childShotSha256;
graphicValidation.routeCorrectionGraphicImpact = 'NONE';
writeJson(graphicValidationPath, graphicValidation);

const consolidatedValidationPath = path.join(CHILD, 'validation', 'consolidated-candidate-validation.json');
const consolidatedValidation = readJson(consolidatedValidationPath);
consolidatedValidation.candidateId = 'phase3-34-still-route-correction-child-20261021-v1';
consolidatedValidation.status = 'PLANNING_READY_ROUTE_CORRECTION_APPLIED_EXECUTION_UNAUTHORIZED';
consolidatedValidation.passed.routeCorrection = 'PASS_34_APPROVED_ROWS_ONLY';
consolidatedValidation.blockers = [{ code: 'REMAINING_PROVIDER_MEDIA_EXECUTION_UNAUTHORIZED', replacementGeneratedStills: 34, existingGeneratedFinalStills: 7, animationSourceStills: 21, animations: 21, totalProviderSubmissions: 83, maximumPlannedExposureUsd: 11.376, providerEnforced: false }];
consolidatedValidation.limits.productionEligible = false;
consolidatedValidation.limits.providerRequests = 0;
writeJson(consolidatedValidationPath, consolidatedValidation);

const readinessPath = path.join(CHILD, 'validation', 'render-readiness.json');
const readiness = readJson(readinessPath);
readiness.candidateId = 'phase3-34-still-route-correction-child-20261021-v1';
readiness.blockers = [{ code: 'REMAINING_PROVIDER_MEDIA_EXECUTION_UNAUTHORIZED', replacementGeneratedStills: 34, existingGeneratedFinalStills: 7, animationSourceStills: 21, animations: 21, totalProviderSubmissions: 83, maximumPlannedExposureUsd: 11.376, providerEnforced: false }];
readiness.productionEligible = false;
readiness.providerRequests = 0;
readiness.candidatePlanning = 'PASS_ROUTE_CORRECTION_APPLIED';
readiness.mediaExecution = 'UNAUTHORIZED';
writeJson(readinessPath, readiness);

const reportPath = path.join(CHILD, 'candidate-report.json');
const report = readJson(reportPath);
report.candidateId = 'phase3-34-still-route-correction-child-20261021-v1';
report.status = 'PLANNING_READY_ROUTE_CORRECTION_APPLIED_EXECUTION_UNAUTHORIZED';
report.validators.productionManifest = 'PASS_34_ROUTE_CORRECTIONS';
report.validators.shotDefinitions = 'PASS_34_ASSET_TYPE_CORRECTIONS';
report.validators.revisionLineage = 'PASS_APPROVAL_AND_AMENDMENT_BOUND';
report.validators.renderReadiness = 'BLOCKED_EXECUTION_UNAUTHORIZED';
report.blockers = clone(consolidatedValidation.blockers);
report.providerRequests = 0;
report.episodeRootWrites = 0;
report.readiness.candidatePlanning = 'PASS';
report.readiness.mediaExecution = 'UNAUTHORIZED';
report.readiness.providerRequests = 0;
writeJson(reportPath, report);

const candidateIndexPath = path.join(CHILD, 'candidate-package-sha256.json');
const childFiles = walk(CHILD).filter(file => file !== candidateIndexPath).map(file => ({ path: posix(path.relative(CHILD, file)), bytes: fs.statSync(file).size, sha256: shaFile(file) }));
writeJson(candidateIndexPath, {
  schemaVersion: 'candidate-package-sha256/1.0.0',
  candidateId: 'phase3-34-still-route-correction-child-20261021-v1',
  parentCandidateIndexSha256: EXPECTED.sourceCandidateIndex,
  approvalSha256,
  amendmentSha256: EXPECTED.amendment,
  fileCount: childFiles.length,
  selfHashExcluded: true,
  files: childFiles
});
const childIndexSha256 = shaFile(candidateIndexPath);

const parentIndex = readJson(sourceCandidateIndexPath);
const parentFileMap = new Map(parentIndex.files.map(item => [item.path, item.sha256]));
const childFileMap = new Map(childFiles.map(item => [item.path, item.sha256]));
const deliberatelyRegenerated = new Set([
  'shot-definitions.json',
  'production-manifest.json',
  'candidate-report.json',
  'validation/boundary-and-timing-validation.json',
  'validation/consolidated-candidate-validation.json',
  'validation/graphic-asset-manifest-validation.v2.json',
  'validation/production-manifest-validation.json',
  'validation/render-readiness.json',
  'validation/revision-lineage-validation.json',
  'validation/shot-definitions-validation.json'
]);
const newFiles = new Set([
  'revision-lineage/phase3-34-still-route-correction-application.v1.json',
  'validation/route-correction-application-validation.v1.json'
]);
const unexpectedChangedFiles = [];
for (const [file, parentHash] of parentFileMap) {
  if (file === 'candidate-package-sha256.json') continue;
  const childHash = childFileMap.get(file);
  if (childHash !== parentHash && !deliberatelyRegenerated.has(file)) unexpectedChangedFiles.push(file);
}
const unexpectedNewFiles = [...childFileMap.keys()].filter(file => !parentFileMap.has(file) && !newFiles.has(file));
assert(unexpectedChangedFiles.length === 0, `UNEXPECTED_CHANGED_FILES:${unexpectedChangedFiles.join(',')}`);
assert(unexpectedNewFiles.length === 0, `UNEXPECTED_NEW_FILES:${unexpectedNewFiles.join(',')}`);

const changeProofPath = path.join(OUT, 'candidate-application-change-proof.v1.json');
writeJson(changeProofPath, {
  schemaVersion: 'phase3-34-still-route-correction-child-change-proof/1.0.0',
  status: 'PASS_ONLY_APPROVED_ROUTE_FIELDS_CHANGED',
  parentCandidateIndexSha256: EXPECTED.sourceCandidateIndex,
  childCandidateIndexSha256: childIndexSha256,
  approvalSha256,
  amendmentSha256: EXPECTED.amendment,
  routeDataChanges: {
    productionManifest: { scalarChangeCount: manifestDiffs.length, allowedScalarChangeCount: allowedManifest.size, changedFields: ['assetType', 'productionMethod'], diffs: manifestDiffs },
    shotDefinitions: { scalarChangeCount: shotDiffs.length, allowedScalarChangeCount: allowedShot.size, changedFields: ['assetType'], diffs: shotDiffs }
  },
  fileLevelProof: {
    sourceCandidateIndexedFiles: parentIndex.fileCount,
    childCandidateIndexedFiles: childFiles.length,
    deliberatelyRegenerated: [...deliberatelyRegenerated].sort(),
    newLineageAndValidationRecords: [...newFiles].sort(),
    unexpectedChangedFiles,
    unexpectedNewFiles,
    allOtherParentFilesByteIdentical: true
  },
  preservation: {
    lockedEditorialFields: 'PASS',
    evidenceAndOwnershipBindings: 'PASS',
    unrelatedCandidateRecords: 'PASS',
    completedProductionRecords: ['ACT1_B006', 'ACT1_B009', 'ACT1_B010'],
    act3bB010Retired: true
  }
});

writeJson(path.join(OUT, 'application-summary.v1.json'), {
  schemaVersion: 'phase3-34-still-route-correction-application-summary/1.0.0',
  status: 'PHASE3_34_STILL_ROUTE_CORRECTION_APPLIED_EXECUTION_UNAUTHORIZED',
  approvalSha256,
  childCandidateIndexSha256: childIndexSha256,
  amendment: { rows: 34, sha256: EXPECTED.amendment, changedFields: ['productionMethod', 'assetType'] },
  promptContracts: { rows: 34, textSensitiveRows: 16, sha256: EXPECTED.promptContracts },
  remainingPlan: { providerSubmissions: 83, maximumExposureUsd: 11.376, providerEnforced: false },
  authority: { providerSubmissionsAuthorized: 0, executionAuthorizationsCreated: 0, requestKeysReserved: 0, mediaGenerated: 0, stage04Modified: false, productionPathWrites: 0, rendered: false, promoted: false, deployed: false }
});

const outerIndexPath = path.join(OUT, 'package-index.v1.json');
const outerFiles = walk(OUT).filter(file => file !== outerIndexPath).map(file => ({ path: relOut(file), bytes: fs.statSync(file).size, sha256: shaFile(file) }));
for (const item of outerFiles.filter(item => item.path.endsWith('.json'))) readJson(path.join(OUT, ...item.path.split('/')));
writeJson(outerIndexPath, {
  schemaVersion: 'phase3-34-still-route-correction-applied-package-index/1.0.0',
  packageId: 'phase3-34-still-route-correction-applied-20261021-v1',
  status: 'PHASE3_34_STILL_ROUTE_CORRECTION_APPLIED_EXECUTION_UNAUTHORIZED',
  parentCandidateIndexSha256: EXPECTED.sourceCandidateIndex,
  approvedRoutePackageIndexSha256: EXPECTED.routePackageIndex,
  approvalSha256,
  amendmentSha256: EXPECTED.amendment,
  childCandidateIndexSha256: childIndexSha256,
  fileCount: outerFiles.length,
  selfHashExcluded: true,
  files: outerFiles,
  authority: { providerSubmissionsAuthorized: 0, executionAuthorizationsCreated: 0, requestKeysReserved: 0, mediaGenerated: 0, stage04Modified: false, productionPathWrites: 0, rendered: false, promoted: false, deployed: false }
});

console.log(JSON.stringify({
  status: 'PHASE3_34_STILL_ROUTE_CORRECTION_APPLIED_EXECUTION_UNAUTHORIZED',
  approvalSha256,
  childCandidateIndexSha256: childIndexSha256,
  packageIndexSha256: shaFile(outerIndexPath),
  packageFileCount: outerFiles.length,
  childFileCount: childFiles.length,
  manifestScalarChanges: manifestDiffs.length,
  shotDefinitionScalarChanges: shotDiffs.length,
  unexpectedChangedFiles,
  unexpectedNewFiles
}, null, 2));
