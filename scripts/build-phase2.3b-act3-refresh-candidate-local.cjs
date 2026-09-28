'use strict';

// Builds the authorized local-only Act 3 refresh candidate after every input,
// lineage, timing, production, and evidence check has passed in memory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const well = path.join(root, 'artifacts/empire-omitted-v3/wells-fargo');
const child = path.join(well, 'phase2.3b-b017-candidate');
const refresh = path.join(well, 'phase2.3b-act3-refresh-bindings-20260928-r3');
const evidenceDir = path.join(well, 'phase2.3b-evidence');
const output = path.join(well, 'phase2.3b-p-act3-refresh-candidate-local-20260928-v1');
const expected = {
  policy: '8a0173087b2e7364e8bd46c4a9e53c3acb738904fc3f94968099b357deea843b',
  script: 'fd377ddc30498bf921b33c9cb409ff159804e99862d96910bf68ae12e4dee7f4',
  timestamps: 'e7c341bdde3cd0537bcb6a840dd130b185864ebc25d659b60f27362f9464dea0',
  evidenceApproval: 'c0de5baef64e8a9ff6a612b58f2d5089cd6789562c3b367686d243ca72c0afb2',
  requestLedger: 'c8b6ad421c378081a6111c51151c4c73a87dadcf2c475194d522e5791407abaf',
  durationSec: 633.782449,
  reconstructedParent: '6ab68c87b61c21b6b3bf74ee419885766c9603b021c0a9c8473be93715cdb71b',
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file);
const readJson = file => JSON.parse(read(file).toString('utf8'));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const rel = (base, file) => path.relative(base, file).split(path.sep).join('/');
function stageFiles(directory, files) {
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(directory, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, { flag: 'wx' });
  }
}

function main() {
  assert(!fs.existsSync(output), 'CANDIDATE_ALREADY_EXISTS');
  const act = require(path.join(root, 'pipeline-updates/episode-activation.cjs'));
  const cli = require(path.join(root, 'scripts/phase2.3b-p-activate.cjs'));
  const scriptFile = path.join(child, 'candidate-script.json');
  const planFile = path.join(refresh, 'outputs/candidate-edit-plan-pretiming.json');
  const shotsFile = path.join(child, 'candidate-shot-definitions-pretiming.json');
  const sourceManifestFile = path.join(child, 'candidate-production-manifest-pretiming.json');
  const policyFile = path.join(root, 'pipeline-updates/phase2.3b-p-approved-timing-exceptions.refresh-v5.json');
  const boundaryFile = path.join(refresh, 'approvals/refreshed-boundary-policy.v2.json');
  const transcriptFile = path.join(refresh, 'outputs/fresh-whisper/combined-word-timestamps.json');
  const alignmentFile = path.join(refresh, 'outputs/deterministic-alignment.v1.json');
  const proposalFile = path.join(refresh, 'outputs/alignment-review-proposal.unsigned.v1.json');
  const alignmentApprovalFile = path.join(refresh, 'approvals/alignment-review-approval.v1.json');
  const audioManifestFile = path.join(refresh, 'outputs/six-act-audio-manifest.json');
  const timingProposalFile = path.join(refresh, 'outputs/timing-policy-proposal.unsigned.v2.json');
  const timingApprovalFile = path.join(refresh, 'approvals/timing-approval.refresh-2026-09-28.json');
  const scriptBytes = read(scriptFile), planBytes = read(planFile), timestampBytes = read(transcriptFile);
  const policyBytes = read(policyFile), boundaryBytes = read(boundaryFile);
  assert(sha(policyBytes) === expected.policy, 'REFRESHED_TIMING_POLICY_HASH_MISMATCH');
  assert(sha(scriptBytes) === expected.script, 'CANDIDATE_SCRIPT_HASH_MISMATCH');
  assert(sha(planBytes) === readJson(policyFile).binding.candidatePreTimingEditPlanSha256, 'PRETIMING_PLAN_HASH_MISMATCH');
  assert(sha(timestampBytes) === expected.timestamps, 'COMBINED_TIMESTAMP_HASH_MISMATCH');
  const timestamps = JSON.parse(timestampBytes.toString('utf8'));
  assert(Array.isArray(timestamps) && timestamps.length === 1352, 'TIMESTAMP_ROW_COUNT_MISMATCH');
  const script = JSON.parse(scriptBytes.toString('utf8'));
  const basePlan = JSON.parse(planBytes.toString('utf8'));
  const policy = JSON.parse(policyBytes.toString('utf8'));
  const audioManifestBytes = read(audioManifestFile), audioManifest = JSON.parse(audioManifestBytes.toString('utf8'));
  const audioInputs = {
    act1: ['VO_Act1.mp3', path.join(refresh, 'authoritative-audio/VO_Act1.mp3'), '453206fdeb6f6d2f36abd63a58bd2efb0fb40d92b5aa6453161e8779f2a72986'],
    act2: ['VO_Act2.mp3', path.join(refresh, 'authoritative-audio/VO_Act2.mp3'), '46f59093fede22d2ea84a1a52d81d3a913d50cdf3f69afa27e84bcb1c3c37d32'],
    act3: ['VO_Act3.mp3', path.join(refresh, 'outputs/audio/VO_Act3.mp3'), '79909b5f4923fbe2aae04663068cbf4b5926a2ae3fb7a274b73013a778193449'],
    act3b: ['VO_Act3B.mp3', path.join(refresh, 'authoritative-audio/VO_Act3B.mp3'), '31390130983a45394b920f72e148235046779dd027287a1b2fead77c8847054e'],
    act4: ['VO_Act4.mp3', path.join(refresh, 'authoritative-audio/VO_Act4.mp3'), '9043109ad5b9d4907114d5fd7f3f8649f8b7191dc92409ddf636c6b2aff285e0'],
    act5: ['VO_Act5.mp3', path.join(refresh, 'authoritative-audio/VO_Act5.mp3'), 'a80cc813614e8012849ddbec8c584ae1112ba14bf72306aabbd02d96b0b187db'],
  };
  const audio = {};
  for (const [actKey, [filename, file, expectedHash]] of Object.entries(audioInputs)) {
    const content = read(file);
    assert(sha(content) === expectedHash, `AUDIO_HASH_MISMATCH:${actKey}`);
    audio[actKey] = { filename, file, bytes: content.length, sha256: sha(content) };
  }

  const boundaryRaw = JSON.parse(boundaryBytes.toString('utf8'));
  const boundary = act.verifyApprovedBoundaryPolicy({ policy: boundaryRaw, policyBytes: boundaryBytes, script,
    scriptSha256: sha(scriptBytes), amendmentSha256: policy.binding.candidateAmendmentSha256,
    actualBindings: boundaryRaw.binding });
  const boundaryKeys = ['lockedEditPlanSha256', 'candidatePreTimingEditPlanSha256', 'candidateScriptSha256',
    'retainedTranscriptSha256', 'alignmentProposalSha256', 'alignmentApprovalSha256', 'candidateAmendmentSha256'];
  const boundaryInputHashes = Object.fromEntries(boundaryKeys.map(key => [key, policy.binding[key]]));
  const lineageEvidence = cli.loadRefreshedTimingLineageEvidence({ packageDirectory: child });
  const timingPolicy = cli.loadApprovedTimingExceptions({ runId: policy.binding.runId, packageDirectory: child,
    approvedBoundaryPolicy: boundary, boundaryInputHashes, wordTimestamps: timestamps, lineageEvidence });
  assert(timingPolicy.policySha256 === expected.policy, 'TIMING_POLICY_VERIFICATION_FAILED');
  const alignmentApproval = readJson(alignmentApprovalFile);
  const reviewedAlignment = act.applyAlignmentReviewApproval({ alignment: readJson(alignmentFile),
    approvalArtifact: alignmentApproval, expectedBindings: alignmentApproval.bindings });
  const durations = Object.fromEntries(audioManifest.audio.map(item => [item.actKey, Number(item.ffprobeDurationSeconds)]));
  const timing = cli.verifyTimingRemediation({ plan: basePlan, wordTimestamps: timestamps, script, reviewedAlignment,
    approvedBoundaryPolicy: boundary, boundaryInputHashes, approvedTimingExceptions: timingPolicy,
    actDurationsSec: durations, validator: require(path.join(root, 'pipeline-updates/edit-plan-validator.cjs')) });
  assert(timing.status === 'PASS', 'SHARED_TIMING_REMEDIATION_FAILED');
  assert(timing.totalDurationSec === expected.durationSec, 'RETIMED_TOTAL_MISMATCH');
  assert(timing.timingExceptionAudit.entries.length === 9 && timing.timingExceptionAudit.editorialIntentMigrations.length === 5,
    'TIMING_EXCEPTION_OR_MIGRATION_COUNT_MISMATCH');

  const amendmentLedgerFile = path.join(child, 'revision-ledger.phase2.3b-b017-factual-correction.v1.json');
  const amendmentLedgerBytes = read(amendmentLedgerFile);
  const amendedBase = act.applyApprovedB017AmendmentToPlan({ plan: basePlan, sourcePlanSha256: sha(planBytes),
    amendmentLedgerBytes, approvedTimingExceptions: timingPolicy });
  const amendedRetimed = act.applyApprovedB017AmendmentToPlan({ plan: timing.plan, sourcePlanSha256: sha(planBytes),
    amendmentLedgerBytes, approvedTimingExceptions: timingPolicy });
  const plan = amendedRetimed.plan;
  act.assertCreativePlanFieldsFrozen(amendedBase.plan, plan, { retiredBeatIds: boundary.retirements.map(item => item.beatId),
    approvedTimingExceptionBeatIds: timingPolicy.exceptions.map(item => item.beatId),
    editorialIntentMigrationBeatIds: timingPolicy.editorialIntentMigrations.entries.map(item => item.beatId),
    excludedTimingExceptionBeatIds: timingPolicy.excludedFormalExceptionIds.map(item => item.split(':')[1]) });
  const editValidation = require(path.join(root, 'pipeline-updates/edit-plan-validator.cjs')).validateEditPlan({ plan, wordTimestamps: timestamps });
  assert(editValidation.status === 'PASS' && editValidation.errors.length === 0, 'FINAL_EDIT_PLAN_VALIDATION_FAILED');

  const sourceShots = readJson(shotsFile);
  const chainFiles = [
    path.join(child, 'revision-ledger.phase2.2d-lineage.v1.json'),
    path.join(child, 'revision-ledger.phase2.3b-sv-amendment.v1.json'),
    amendmentLedgerFile,
  ];
  const sourceChain = chainFiles.map(readJson);
  const transformed = act.updateShotDefinitions({ originalShotDefs: sourceShots, plan, revisionChain: sourceChain,
    revisionId: 'phase2.3b-p-act3-refresh-local-20260928', retiredBeatIds: [], retirementRecords: [],
    editorialIntentMigrations: timingPolicy.editorialIntentMigrations, approvedTimingExceptions: timingPolicy });
  const shotValidation = require(path.join(root, 'pipeline-updates/shot-definitions-validator.cjs'))
    .validateShotDefinitions({ plan, shotDefs: transformed.shotDefs, revisionChain: transformed.revisionChain });
  assert(shotValidation.status === 'PASS' && shotValidation.errors.length === 0, 'SHOT_DEFINITIONS_VALIDATION_FAILED');
  const revision = require(path.join(root, 'pipeline-updates/revision-lineage.cjs'))
    .validateRevisionChain({ shotDefs: transformed.shotDefs, revisionChain: transformed.revisionChain });
  assert(revision.status === 'PASS' && revision.reconstructedParentHashes.includes(expected.reconstructedParent),
    'REVISION_LINEAGE_VALIDATION_FAILED');
  const productionManifest = act.updateProductionManifestForRetirements(readJson(sourceManifestFile), []);
  productionManifest.sourceEditPlanSha256 = require(path.join(root, 'pipeline-updates/shot-definitions-validator.cjs')).planFingerprint(plan);
  productionManifest.candidateSha256 = sha(jsonBytes(transformed.shotDefs));
  assert(!plan.sequences.flatMap(sequence => sequence.beats).some(beat => beat.beatId === 'ACT3B_B010')
    && !transformed.shotDefs.allShots.some(shot => shot.beatId === 'ACT3B_B010')
    && !productionManifest.shots.some(shot => shot.beatId === 'ACT3B_B010'), 'B010_RETIREMENT_NOT_PRESERVED');

  const approvalFile = path.join(evidenceDir, 'evidence-review-approval-record.v1.json');
  const approvalBytes = read(approvalFile);
  assert(sha(approvalBytes) === expected.evidenceApproval, 'EVIDENCE_APPROVAL_HASH_MISMATCH');
  const evidence = readJson(path.join(evidenceDir, 'evidence-source-manifest.json'));
  assert(evidence.entries.length === 46 && evidence.entries.every(entry => entry.approvalStatus === 'APPROVED'),
    'EVIDENCE_ENTRY_APPROVALS_INVALID');
  evidence.shotDefinitionsSha256 = sha(jsonBytes(transformed.shotDefs));
  const shotsById = new Map(transformed.shotDefs.allShots.map(shot => [shot.shotId, shot]));
  for (const entry of evidence.entries) if (shotsById.has(entry.shotId)) {
    entry.exactSourceRequirement = shotsById.get(entry.shotId).evidenceRequirement?.description;
  }
  const assetsSource = path.join(evidenceDir, 'production-assets');
  const evidenceValidation = require(path.join(root, 'pipeline-updates/evidence-source-validator.cjs'))
    .validateEvidenceSourceManifest({ manifest: evidence, shotDefs: transformed.shotDefs, evidenceAssetDir: assetsSource });
  assert(evidenceValidation.status === 'PASS' && evidenceValidation.errors.length === 0, 'EVIDENCE_VALIDATION_FAILED');
  const selectedNames = [...new Set(evidence.entries.map(entry => entry.localFilename))];
  assert(evidence.entries.length === 46 && selectedNames.length === 29
    && selectedNames.every(name => fs.existsSync(path.join(assetsSource, name))), 'EVIDENCE_ASSET_SET_INVALID');
  const evidenceEntryByShot = new Map(evidence.entries.map(entry => [entry.shotId, entry]));
  const originalProductionEntries = new Map(productionManifest.shots.map(entry => [entry.shotId, JSON.stringify(entry)]));
  const shotById = new Map(transformed.shotDefs.allShots.map(shot => [shot.shotId, shot]));
  for (const entry of productionManifest.shots) {
    if (!['ACT3_B017', 'ACT3_B018'].includes(entry.shotId)) continue;
    const shot = shotById.get(entry.shotId);
    const graphics = Array.isArray(shot.graphics) ? shot.graphics : [];
    const isPrimaryGraphic = entry.productionMethod === 'GRAPHIC_COMPILATION';
    const hasEvidence = entry.productionMethod === 'EVIDENCE_REFERENCE';
    const sourceApproved = hasEvidence && evidenceEntryByShot.get(entry.shotId)?.approvalStatus === 'APPROVED';
    entry.primaryGraphicAsset = isPrimaryGraphic;
    entry.overlayGraphicRequirement = graphics.length > 0 && !isPrimaryGraphic;
    entry.graphicObjectCount = graphics.length;
    entry.graphicObjects = graphics;
    entry.sourceRequirement = hasEvidence
      ? { evidenceRequirement: shot.evidenceRequirement, sourceSearchInstruction: shot.sourceSearchInstruction }
      : null;
    entry.sourceStatus = hasEvidence ? (sourceApproved ? 'VERIFIED' : 'PENDING') : 'NOT_REQUIRED';
    const graphicRequired = isPrimaryGraphic || graphics.length > 0;
    entry.graphicStatus = graphicRequired ? 'PENDING' : 'NOT_REQUIRED';
    entry.blockerCodes = [
      ...(hasEvidence && !sourceApproved ? ['EVIDENCE_SOURCE_PENDING'] : []),
      ...(graphicRequired ? ['GRAPHIC_COMPILATION_PENDING'] : []),
    ];
    entry.status = entry.blockerCodes.length ? 'BLOCKED' : 'APPROVED';
  }
  const changedProductionOwners = productionManifest.shots.filter(entry => originalProductionEntries.get(entry.shotId) !== JSON.stringify(entry)).map(entry => entry.shotId);
  assert(changedProductionOwners.every(id => ['ACT3_B017', 'ACT3_B018'].includes(id)),
    `UNAPPROVED_PRODUCTION_MANIFEST_SCOPE:${JSON.stringify(changedProductionOwners)}`);
  const productionValidation = require(path.join(root, 'pipeline-updates/production-method-manifest.cjs'))
    .validateProductionMethodManifest({ manifest: productionManifest, shotDefs: transformed.shotDefs,
      candidateSha256: productionManifest.candidateSha256 });
  assert(productionValidation.status === 'PASS' && productionValidation.errors.length === 0,
    `PRODUCTION_MANIFEST_VALIDATION_FAILED:${JSON.stringify(productionValidation.errors)}`);
  const proofPlan = require(path.join(root, 'pipeline-updates/proof-section-planner.cjs'))
    .planProofSection({ shotDefs: transformed.shotDefs, productionManifest });

  const acts = timing.audit.acts.map(item => ({ actKey: item.actKey,
    activeBeatCount: plan.sequences.filter(sequence => (sequence.actKey || sequence.act) === item.actKey)
      .reduce((count, sequence) => count + sequence.beats.length, 0),
    mappedBoundaries: item.mappedBoundaryCount, boundaries: item.boundaryCount,
    gaps: item.gaps.length, overlaps: item.overlaps.length, ambiguities: item.ambiguousMappings.length,
    unmapped: item.unmappedBoundaries.length, errors: item.errors.length,
    status: item.errors.length === 0 && item.mappedBoundaryCount === item.boundaryCount ? 'PASS' : 'FAIL' }));
  assert(timing.audit.status === 'BOUNDARY_AUDIT_PASS' && timing.audit.errors.length === 0
    && acts.length === 6 && acts.every(item => item.status === 'PASS' && item.mappedBoundaries === item.boundaries
      && item.gaps === 0 && item.overlaps === 0 && item.ambiguities === 0 && item.unmapped === 0 && item.errors === 0),
    'SIX_ACT_BOUNDARY_COVERAGE_FAILED');

  const audioList = audioManifest.audio.map(item => ({ actKey: item.actKey, file: audio[item.actKey].filename,
    sha256: audio[item.actKey].sha256, bytes: audio[item.actKey].bytes, durationSec: Number(item.ffprobeDurationSeconds) }));
  const originalDurationReportFile = path.join(refresh, 'outputs/duration-separation-report.json');
  const files = {
    'script.json': scriptBytes,
    'edit-plan.json': jsonBytes(plan),
    'edit-plan-validation.json': jsonBytes(editValidation),
    'shot-definitions.json': jsonBytes(transformed.shotDefs),
    'production-manifest.json': jsonBytes(productionManifest),
    'evidence-source-manifest.json': jsonBytes(evidence),
    'proof-section-plan.json': jsonBytes(proofPlan),
    'edit-plan-shadow-status.json': jsonBytes({ schemaVersion: 'phase2.3b-p-candidate-shadow-status/1.0.0',
      status: 'complete', candidateOnly: true, editPlanStatus: 'PASS', editPlanSha256: sha(jsonBytes(plan)), episodeRootWrite: false }),
    'timing/six-act-audio-manifest.json': audioManifestBytes,
    'timing/word-timestamps.json': timestampBytes,
    'timing/alignment-report.json': jsonBytes(reviewedAlignment),
    'approvals/refreshed-boundary-policy.v2.json': boundaryBytes,
    'approvals/refreshed-timing-policy.v5.json': policyBytes,
    'approvals/alignment-proposal.unsigned.v1.json': read(proposalFile),
    'approvals/alignment-approval.v1.json': read(alignmentApprovalFile),
    'approvals/timing-proposal.v1.json': read(timingProposalFile),
    'approvals/timing-approval.v1.json': read(timingApprovalFile),
    'approvals/evidence-review-approval-record.v1.json': approvalBytes,
    'approvals/evidence-review-approval-proposal.v1.json': read(path.join(evidenceDir, 'evidence-review-approval.v1.json')),
    'evidence-review/evidence-matrix.v1.json': read(path.join(evidenceDir, 'evidence-matrix.v1.json')),
    'evidence-review/source-rights-log.json': read(path.join(evidenceDir, 'source-rights-log.json')),
    'evidence-review/asset-hashes.json': read(path.join(evidenceDir, 'asset-hashes.json')),
    'evidence-review/approval-docket.json': read(path.join(evidenceDir, 'APPROVAL_DOCKET.json')),
    'revision-lineage/phase2.2d-lineage.v1.json': read(chainFiles[0]),
    'revision-lineage/phase2.3b-sv-amendment.v1.json': read(chainFiles[1]),
    'revision-lineage/phase2.3b-b017-factual-correction.v1.json': read(amendmentLedgerFile),
    'revision-lineage/phase2.3b-p-retiming.v1.json': jsonBytes(transformed.revisionLedger),
    'revision-lineage/b017-plan-amendment-proof.v1.json': jsonBytes(amendedRetimed.proof),
    'validation/shot-definitions-validation.json': jsonBytes(shotValidation),
    'validation/revision-lineage-validation.json': jsonBytes(revision),
    'validation/production-manifest-validation.json': jsonBytes(productionValidation),
    'validation/evidence-validation.json': jsonBytes(evidenceValidation),
    'validation/boundary-and-timing-validation.json': jsonBytes({ status: 'PASS', acts,
      totalRetimedDurationSec: timing.totalDurationSec, formalExceptions: timing.timingExceptionAudit.entries,
      editorialIntentMigrations: timing.timingExceptionAudit.editorialIntentMigrations,
      excludedFormalClosures: timing.timingExceptionAudit.excludedFormalExceptionClosures,
      errors: timing.validation.errors }),
    'duration-separation-report.json': read(originalDurationReportFile),
    'duration-separation-superseded-marker.json': jsonBytes({ schemaVersion: 'phase2.3b-duration-report-supersession/1.0.0',
      status: 'SUPERSEDED_DIAGNOSTIC_HISTORY', reportSha256: sha(read(originalDurationReportFile)),
      supersededValueSec: 623.36, reason: 'Computed from the invalid audio binding; excluded from current validation.' }),
  };
  for (const [actKey, item] of Object.entries(audio)) files[`assets/audio/${item.filename}`] = read(item.file);
  for (const name of selectedNames) files[`assets/evidence/${name}`] = read(path.join(assetsSource, name));
  const fileEntries = Object.entries(files).map(([file, content]) => ({ path: file, bytes: content.length, sha256: sha(content) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const summary = { schemaVersion: 'phase2.3b-act3-refresh-local-candidate/1.0.0', status: 'VALIDATED_NOT_PROMOTED',
    scriptSha256: sha(scriptBytes), timestampSha256: sha(timestampBytes), audio: audioList, acts,
    totalRetimedDurationSec: timing.totalDurationSec, formalExceptionCount: timing.timingExceptionAudit.entries.length,
    editorialIntentMigrationCount: timing.timingExceptionAudit.editorialIntentMigrations.length,
    editPlanValidation: editValidation.status, shotValidation: shotValidation.status,
    revisionValidation: revision.status, reconstructedParentHash: expected.reconstructedParent,
    productionManifestValidation: productionValidation.status, evidenceValidation: evidenceValidation.status,
    evidenceEntries: evidence.entries.length, selectedAssets: selectedNames.length, retiredBeatIds: ['ACT3B_B010'],
    providerRequests: 0, episodeRootWrites: 0, fileCountBeforeReports: fileEntries.length };
  files['candidate-report.json'] = jsonBytes({ ...summary, candidateFiles: fileEntries });

  // All checks above run before the only write, which is the new candidate directory.
  fs.mkdirSync(output, { recursive: false });
  stageFiles(output, files);
  let renderReadiness;
  try {
    require(path.join(root, 'pipeline-updates/v3-asset-readiness.cjs'))
      .assertV3AssetsReadyForRender({ episodeDir: output, shotDefs: transformed.shotDefs });
    renderReadiness = { status: 'PASS', errors: [] };
  } catch (error) {
    renderReadiness = { status: 'BLOCKED', errors: [String(error.message || error)] };
  }
  const renderBytes = jsonBytes(renderReadiness);
  stageFiles(output, { 'validation/render-readiness.json': renderBytes });
  const indexed = Object.keys(files).concat('validation/render-readiness.json').map(file => {
    const content = read(path.join(output, file));
    return { path: file, bytes: content.length, sha256: sha(content) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const indexBytes = jsonBytes({ schemaVersion: 'phase2.3b-act3-refresh-candidate-index/1.0.0',
    status: 'PASS', selfHashExcluded: true, fileCount: indexed.length, files: indexed });
  stageFiles(output, { 'candidate-package-sha256.json': indexBytes });
  for (const entry of indexed) {
    const content = read(path.join(output, entry.path));
    assert(content.length === entry.bytes && sha(content) === entry.sha256, `CANDIDATE_PACKAGE_HASH_MISMATCH:${entry.path}`);
  }
  console.log(JSON.stringify({ ...summary, candidateDirectory: output,
    packageIndexSha256: sha(indexBytes), indexedFileCount: indexed.length,
    completeFileCount: indexed.length + 1, renderReadiness, candidateFiles: indexed }, null, 2));
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}

module.exports = { main };
