'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const activation = require('../pipeline-updates/episode-activation.cjs');
const activationCli = require('../scripts/phase2.3b-p-activate.cjs');

const ROOT = path.resolve(__dirname, '..');
const WELL_FARGO = path.join(ROOT, 'artifacts/empire-omitted-v3/wells-fargo');
const REFRESH = path.join(WELL_FARGO, 'phase2.3b-act3-refresh-bindings-20260928-r3');
const CHILD = path.join(WELL_FARGO, 'phase2.3b-b017-candidate');
const PARENT = path.join(WELL_FARGO, 'phase2.3b-sv-candidate');
const POLICY_PATH = path.join(ROOT, 'pipeline-updates/phase2.3b-p-approved-timing-exceptions.refresh-v5.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file);
const readJson = file => JSON.parse(read(file).toString('utf8'));

function fixture() {
  const policyBytes = read(POLICY_PATH);
  const policy = JSON.parse(policyBytes.toString('utf8'));
  const scriptPath = path.join(CHILD, 'candidate-script.json');
  const planPath = path.join(REFRESH, 'outputs/candidate-edit-plan-pretiming.json');
  const shotsPath = path.join(CHILD, 'candidate-shot-definitions-pretiming.json');
  const manifestPath = path.join(CHILD, 'candidate-production-manifest-pretiming.json');
  const transcriptPath = path.join(REFRESH, 'outputs/fresh-whisper/combined-word-timestamps.json');
  const amendmentPath = path.join(CHILD, 'factual-correction-amendment.v1.json');
  const historyPath = path.join(CHILD, 'revision-ledger.phase2.2d-lineage.v1.json');
  const alignmentProposalPath = path.join(REFRESH, 'outputs/alignment-review-proposal.unsigned.v1.json');
  const alignmentApprovalPath = path.join(REFRESH, 'approvals/alignment-review-approval.v1.json');
  const boundaryPath = path.join(REFRESH, 'approvals/refreshed-boundary-policy.v2.json');
  const boundaryBytes = read(boundaryPath);
  const boundary = activation.verifyApprovedBoundaryPolicy({
    policy: JSON.parse(boundaryBytes.toString('utf8')),
    policyBytes: boundaryBytes,
    script: readJson(scriptPath),
    scriptSha256: hash(read(scriptPath)),
    amendmentSha256: hash(read(amendmentPath)),
    actualBindings: readJson(boundaryPath).binding,
  });
  const actualBindings = {
    runId: policy.binding.runId,
    episodeId: policy.binding.episodeId,
    channelKey: policy.binding.channelKey,
    lockedEditPlanSha256: policy.binding.lockedEditPlanSha256,
    candidatePreTimingEditPlanSha256: hash(read(planPath)),
    candidateScriptSha256: hash(read(scriptPath)),
    retainedTranscriptSha256: hash(read(transcriptPath)),
    alignmentProposalSha256: hash(read(alignmentProposalPath)),
    alignmentApprovalSha256: hash(read(alignmentApprovalPath)),
    approvedBoundaryPolicySha256: boundary.policySha256,
    candidateAmendmentSha256: hash(read(amendmentPath)),
    candidateHistorySha256: hash(read(historyPath)),
    candidateShotDefinitionsSha256: hash(read(shotsPath)),
    candidateProductionManifestSha256: hash(read(manifestPath)),
  };
  const lineageEvidence = activationCli.loadRefreshedTimingLineageEvidence({ packageDirectory: CHILD });
  const actualRefreshBindings = activationCli.loadRefreshedTimingBindingHashes();
  const args = {
    policy, policyBytes, actualBindings, actualRefreshBindings,
    plan: readJson(planPath), script: readJson(scriptPath),
    shotDefinitions: readJson(shotsPath), productionManifest: readJson(manifestPath),
    approvedBoundaryPolicy: boundary,
    wordTimestamps: readJson(transcriptPath), lineageEvidence,
    expectedPolicySha256: activation.REFRESHED_TIMING_EXCEPTION_POLICY_SHA256,
  };
  return { args, actualBindings, actualRefreshBindings, lineageEvidence, policyBytes };
}

test('refreshed policy verifies the exact parent-to-child B017 chain and keeps original timing provenance', () => {
  const f = fixture();
  const result = activation.verifyApprovedTimingExceptionPolicy(f.args);
  const loadedThroughExecutionPath = activationCli.loadApprovedTimingExceptions({
    runId: 'phase2-3b-p-act-20260925', packageDirectory: CHILD,
    approvedBoundaryPolicy: f.args.approvedBoundaryPolicy,
    boundaryInputHashes: f.args.actualBindings,
    wordTimestamps: f.args.wordTimestamps,
    lineageEvidence: f.lineageEvidence,
  });
  assert.equal(loadedThroughExecutionPath.verified, true);
  assert.equal(loadedThroughExecutionPath.policySha256, result.policySha256);
  assert.equal(result.verified, true);
  assert.equal(result.exceptions.length, 9);
  assert.equal(result.editorialIntentMigrations.entries.length, 5);
  const lineageProofs = [...result.exceptions, ...result.editorialIntentMigrations.entries]
    .map(item => item.revisionLineageProof);
  assert.ok(lineageProofs.length > 0);
  assert.ok(lineageProofs.every(proof => proof.reconstructedParentShotDefinitionsSha256 ===
    '6ab68c87b61c21b6b3bf74ee419885766c9603b021c0a9c8473be93715cdb71b'));
  for (const item of [...result.exceptions, ...result.editorialIntentMigrations.entries]) {
    assert.equal(item.revisionLineage.artifactSha256,
      '6ac0e48bb2b9f90112a46db117f08b7d79f98e8c7aa73236e47a1b98b98c660a');
    assert.equal(item.approvalProvenanceAmendmentSha256,
      '6ac0e48bb2b9f90112a46db117f08b7d79f98e8c7aa73236e47a1b98b98c660a');
    assert.equal(item.currentCandidateAmendmentSha256,
      '93ebed017ff23b7487daa3591cdff2860917c0fe3ef1695a47659aa61a43d8f5');
  }
});

test('refreshed policy refuses direct provenance replacement and altered parent, child amendment, or B017 ledger', () => {
  const f = fixture();
  const replaced = structuredClone(f.args.policy);
  replaced.approvalProvenanceAmendmentSha256 = replaced.currentCandidateAmendmentSha256;
  assert.throws(() => activation.verifyApprovedTimingExceptionPolicy({ ...f.args, policy: replaced }), /POLICY_(?:OBJECT_)?HASH_MISMATCH|POLICY_OBJECT_MISMATCH/u);

  for (const field of ['parentAmendmentBytes', 'childAmendmentBytes']) {
    const altered = structuredClone(f.lineageEvidence);
    altered[field] = Buffer.from(altered[field]);
    altered[field][0] ^= 1;
    assert.throws(() => activation.verifyApprovedTimingExceptionPolicy({
      ...f.args, lineageEvidence: altered,
    }), /REVISION_LINEAGE_(?:HASH_MISMATCH|MISSING)/u, field);
  }

  const ledger = structuredClone(f.lineageEvidence);
  ledger.revisionChainBytes[2] = Buffer.from(ledger.revisionChainBytes[2]);
  ledger.revisionChainBytes[2][0] ^= 1;
  assert.throws(() => activation.verifyApprovedTimingExceptionPolicy({
    ...f.args, lineageEvidence: ledger,
  }), /REVISION_LINEAGE_(?:HASH_MISMATCH|MISSING)/u);
});

test('refreshed policy rejects any change to the 14 inherited timing owners or their production obligations', () => {
  for (const mutation of [
    shot => { shot.narration = `${shot.narration} altered`; },
    shot => { shot.actKey = 'act5'; },
    shot => { shot.productionMethod = `${shot.productionMethod}_ALTERED`; },
    shot => { shot.visualIntent = `${shot.visualIntent} altered`; },
    shot => { shot.evidenceRequired = !shot.evidenceRequired; },
  ]) {
    const f = fixture();
    const changed = structuredClone(f.args.shotDefinitions);
    const canonical = changed.allShots.find(shot => shot.actKey === 'act2' && shot.beatId === 'ACT2_B026');
    const mirror = changed.acts.act2.find(shot => shot.actKey === 'act2' && shot.beatId === 'ACT2_B026');
    mutation(canonical);
    mutation(mirror);
    assert.throws(() => activation.verifyApprovedTimingExceptionPolicy({
      ...f.args, shotDefinitions: changed,
    }), /REVISION_CHAIN_INVALID|OWNER_SCOPE_CHANGED|OWNER_SCOPE_INVALID/u);
  }
});

test('refreshed duration bindings require the approved package, transcript, audio, alignment, boundary, timing, evidence, ledger and approval hashes', () => {
  const f = fixture();
  for (const key of Object.keys(f.actualRefreshBindings)) {
    const changed = { ...f.actualRefreshBindings, [key]: '0'.repeat(64) };
    assert.throws(() => activation.verifyApprovedTimingExceptionPolicy({
      ...f.args, actualRefreshBindings: changed,
    }), /REFRESHED_TIMING_APPROVAL_BINDING_MISMATCH/u, key);
  }

  const alteredPolicy = structuredClone(f.args.policy);
  alteredPolicy.exceptions[0].currentTimingBinding.audioManifestSha256 = '0'.repeat(64);
  assert.throws(() => activation.verifyApprovedTimingExceptionPolicy({
    ...f.args, policy: alteredPolicy,
  }), /POLICY_(?:OBJECT_)?HASH_MISMATCH|POLICY_OBJECT_MISMATCH/u);
});

test('refreshed policy runs the shared mapper, retimer and validator with the hash-bound B017 plan mirror', () => {
  const f = fixture();
  const boundaryInputHashes = Object.fromEntries([
    'lockedEditPlanSha256', 'candidatePreTimingEditPlanSha256', 'candidateScriptSha256',
    'retainedTranscriptSha256', 'alignmentProposalSha256', 'alignmentApprovalSha256', 'candidateAmendmentSha256',
  ].map(key => [key, f.actualBindings[key]]));
  const timingPolicy = activationCli.loadApprovedTimingExceptions({
    runId: 'phase2-3b-p-act-20260925', packageDirectory: CHILD,
    approvedBoundaryPolicy: f.args.approvedBoundaryPolicy,
    boundaryInputHashes,
    wordTimestamps: f.args.wordTimestamps,
    lineageEvidence: f.lineageEvidence,
  });
  const audio = readJson(path.join(REFRESH, 'outputs/six-act-audio-manifest.json'));
  const durations = Object.fromEntries(audio.audio.map(item => [item.actKey, item.ffprobeDurationSeconds]));
  const result = activationCli.verifyTimingRemediation({
    plan: f.args.plan, wordTimestamps: f.args.wordTimestamps, script: f.args.script,
    reviewedAlignment: f.args.approvedBoundaryPolicy && require('../pipeline-updates/episode-activation.cjs').applyAlignmentReviewApproval({
      alignment: readJson(path.join(REFRESH, 'outputs/deterministic-alignment.v1.json')),
      approvalArtifact: readJson(path.join(REFRESH, 'approvals/alignment-review-approval.v1.json')),
      expectedBindings: readJson(path.join(REFRESH, 'approvals/alignment-review-approval.v1.json')).bindings,
    }),
    approvedBoundaryPolicy: f.args.approvedBoundaryPolicy, boundaryInputHashes,
    approvedTimingExceptions: timingPolicy, actDurationsSec: durations,
    validator: require('../pipeline-updates/edit-plan-validator.cjs'),
  });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.audit.acts.map(item => [item.actKey, item.mappedBoundaryCount, item.boundaryCount]), [
    ['act1', 60, 60], ['act2', 52, 52], ['act3', 58, 58],
    ['act3b', 34, 34], ['act4', 48, 48], ['act5', 54, 54],
  ]);
  assert.equal(result.timingExceptionAudit.entries.length, 9);
  assert.equal(result.timingExceptionAudit.editorialIntentMigrations.length, 5);
  assert.deepEqual(result.timingExceptionAudit.excludedFormalExceptionClosures.map(item => [item.actKey, item.beatId]), [['act3', 'ACT3_B025']]);
  assert.equal(result.validation.status, 'PASS');
  assert.equal(result.validation.errors.length, 0);
  assert.equal(result.totalDurationSec, 633.782449);
  const b025 = result.plan.sequences.flatMap(sequence => sequence.beats).find(beat => beat.actKey === 'act3' && beat.beatId === 'ACT3_B025');
  assert.equal(b025.timingExceptionReason, null);
  assert.equal(b025.intentionalStillness, true);
  assert.equal(b025.rhythmIntent, 'impact');

  const amendmentLedgerPath = path.join(CHILD, 'revision-ledger.phase2.3b-b017-factual-correction.v1.json');
  const amendmentLedgerBytes = read(amendmentLedgerPath);
  const planAmendment = require('../pipeline-updates/episode-activation.cjs').applyApprovedB017AmendmentToPlan({
    plan: result.plan,
    sourcePlanSha256: f.actualBindings.candidatePreTimingEditPlanSha256,
    amendmentLedgerBytes,
    approvedTimingExceptions: timingPolicy,
  });
  assert.equal(planAmendment.proof.status, 'PASS');
  assert.equal(planAmendment.proof.changes.length, 6);
  const amendedPlanValidation = require('../pipeline-updates/edit-plan-validator.cjs').validateEditPlan({ plan: planAmendment.plan, wordTimestamps: f.args.wordTimestamps });
  assert.equal(amendedPlanValidation.status, 'PASS', JSON.stringify(amendedPlanValidation.errors));
  const sourceShots = readJson(path.join(CHILD, 'candidate-shot-definitions-pretiming.json'));
  const revisionChain = [
    'revision-ledger.phase2.2d-lineage.v1.json',
    'revision-ledger.phase2.3b-sv-amendment.v1.json',
    'revision-ledger.phase2.3b-b017-factual-correction.v1.json',
  ].map(name => readJson(path.join(CHILD, name)));
  const transformed = require('../pipeline-updates/episode-activation.cjs').updateShotDefinitions({
    originalShotDefs: sourceShots,
    plan: planAmendment.plan,
    revisionChain,
    revisionId: 'phase2.3b-p-refreshed-policy-fixture',
    retiredBeatIds: [],
    retirementRecords: [],
    editorialIntentMigrations: timingPolicy.editorialIntentMigrations,
    approvedTimingExceptions: timingPolicy,
  });
  const canonicalB025 = transformed.shotDefs.allShots.find(shot => shot.actKey === 'act3' && shot.beatId === 'ACT3_B025');
  const mirroredB025 = transformed.shotDefs.acts.act3.find(shot => shot.actKey === 'act3' && shot.beatId === 'ACT3_B025');
  assert.equal(canonicalB025.timingExceptionReason, null);
  assert.equal(mirroredB025.timingExceptionReason, null);
  assert.equal(canonicalB025.intentionalStillness, true);
  assert.equal(mirroredB025.intentionalStillness, true);
  assert.equal(canonicalB025.rhythmIntent, 'impact');
  assert.equal(mirroredB025.rhythmIntent, 'impact');
  assert.equal(transformed.excludedFormalClosuresApplied, 1);
  assert.equal(transformed.shotDefs.allShots.some(shot => shot.beatId === 'ACT3B_B010'), false);
  const shotValidation = require('../pipeline-updates/shot-definitions-validator.cjs').validateShotDefinitions({
    plan: planAmendment.plan, shotDefs: transformed.shotDefs, revisionChain: transformed.revisionChain,
  });
  assert.equal(shotValidation.status, 'PASS', JSON.stringify(shotValidation.errors));
  const revisionValidation = require('../pipeline-updates/revision-lineage.cjs').validateRevisionChain({ shotDefs: transformed.shotDefs, revisionChain: transformed.revisionChain });
  assert.throws(() => require('../pipeline-updates/episode-activation.cjs').applyApprovedB017AmendmentToPlan({
    plan: result.plan, sourcePlanSha256: '0'.repeat(64), amendmentLedgerBytes, approvedTimingExceptions: timingPolicy,
  }), /ACTIVATION_B017_PLAN_AMENDMENT_BINDING_INVALID/u);
  const alteredLedger = Buffer.from(amendmentLedgerBytes);
  alteredLedger[alteredLedger.length - 2] ^= 1;
  assert.throws(() => require('../pipeline-updates/episode-activation.cjs').applyApprovedB017AmendmentToPlan({
    plan: result.plan, sourcePlanSha256: f.actualBindings.candidatePreTimingEditPlanSha256,
    amendmentLedgerBytes: alteredLedger, approvedTimingExceptions: timingPolicy,
  }), /ACTIVATION_B017_PLAN_AMENDMENT_LEDGER_HASH_MISMATCH/u);
});
