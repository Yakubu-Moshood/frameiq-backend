'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const activation = require('../pipeline-updates/episode-activation.cjs');
const validator = require('../pipeline-updates/edit-plan-validator.cjs');
const ROOT = path.resolve(__dirname, '../artifacts/empire-omitted-v3/wells-fargo/phase2.3b-act3-refresh-bindings-20260928-r3');
const OUT = path.join(ROOT, 'outputs');
const read = file => fs.readFileSync(file);
const json = file => JSON.parse(read(path.join(OUT, file)));
const actOrder = ['act1','act2','act3','act3b','act4','act5'];
const actBindings = { act1:'VO_Act1', act2:'VO_Act2', act3:'VO_Act3', act3b:'VO_Act3B', act4:'VO_Act4', act5:'VO_Act5' };
function fixture() {
  const script = json('candidate-script.json');
  const plan = json('candidate-edit-plan-pretiming.json');
  const words = json('fresh-whisper/combined-word-timestamps.json');
  const alignmentProposal = json('alignment-review-proposal.unsigned.v1.json');
  const alignmentApprovalBytes = read(path.join(ROOT, 'approvals/alignment-review-approval.v1.json'));
  const alignmentApproval = JSON.parse(alignmentApprovalBytes);
  const boundaryProposal = json('boundary-policy-proposal.unsigned.v1.json');
  const boundaryApproval = JSON.parse(read(path.join(ROOT, 'approvals/boundary-policy-approval.v1.json')));
  const policyBytes = read(path.join(ROOT, 'approvals/refreshed-boundary-policy.v2.json'));
  const policy = JSON.parse(policyBytes);
  const amendmentBytes = read(path.join(OUT, 'factual-correction-amendment.v1.json'));
  const deterministicAlignment = json('deterministic-alignment.v1.json');
  const reviewed = activation.applyAlignmentReviewApproval({ alignment: deterministicAlignment, approvalArtifact: alignmentApproval, expectedBindings: alignmentApproval.bindings });
  const approvedPolicy = activation.verifyApprovedBoundaryPolicy({ policy, policyBytes, script, scriptSha256: activation.sha256(read(path.join(OUT, 'candidate-script.json'))), amendmentSha256: activation.sha256(amendmentBytes), actualBindings: activation.REFRESHED_BOUNDARY_POLICY_BINDINGS });
  const boundaryInputHashes = {
    lockedEditPlanSha256: '33f5a89fb724bdc8982f85fd9cf8ff223f6e1031bfa557a6f8df609f44bf5337',
    candidatePreTimingEditPlanSha256: activation.sha256(read(path.join(OUT, 'candidate-edit-plan-pretiming.json'))),
    candidateScriptSha256: activation.sha256(read(path.join(OUT, 'candidate-script.json'))),
    retainedTranscriptSha256: activation.sha256(read(path.join(OUT, 'fresh-whisper/combined-word-timestamps.json'))),
    alignmentProposalSha256: activation.sha256(read(path.join(OUT, 'alignment-review-proposal.unsigned.v1.json'))),
    alignmentApprovalSha256: activation.sha256(alignmentApprovalBytes),
    candidateAmendmentSha256: activation.sha256(amendmentBytes),
  };
  const manifest = json('six-act-audio-manifest.json');
  const actDurationsSec = Object.fromEntries(manifest.audio.map(item => [item.actKey, item.ffprobeDurationSeconds]));
  return { script, plan, words, alignmentProposal, alignmentApproval, alignmentApprovalBytes, boundaryProposal, boundaryApproval, policy, policyBytes, amendmentBytes, reviewed, approvedPolicy, boundaryInputHashes, actDurationsSec };
}

test('old boundary policy remains accepted only for its old script and exact bytes', () => {
  const policyBytes = fs.readFileSync(path.resolve(__dirname, '../pipeline-updates/phase2.3b-p-approved-boundary-ranges.json'));
  const policy = JSON.parse(policyBytes);
  const scriptBytes = fs.readFileSync(path.resolve(__dirname, '../artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate/candidate-script.json'));
  const script = JSON.parse(scriptBytes);
  const amendment = fs.readFileSync(path.resolve(__dirname, '../artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate/revision-ledger.phase2.3b-sv-amendment.v1.json'));
  const result = activation.verifyApprovedBoundaryPolicy({ policy, policyBytes, script, scriptSha256: activation.sha256(scriptBytes), amendmentSha256: activation.sha256(amendment) });
  assert.equal(result.verified, true);
  assert.equal(result.policySha256, activation.APPROVED_BOUNDARY_POLICY_SHA256);
  const refreshedScript = fixture().script;
  assert.throws(() => activation.verifyApprovedBoundaryPolicy({ policy, policyBytes, script: refreshedScript, scriptSha256: activation.sha256(read(path.join(ROOT,'outputs/candidate-script.json'))), amendmentSha256: activation.sha256(amendment) }), /ACTIVATION_APPROVED_BOUNDARY_BINDING_MISMATCH/u);
});

test('refreshed policy is bound to exact package/audio/evidence/ledger inputs and approvals', () => {
  const f = fixture();
  assert.equal(f.reviewed.status, 'PASS');
  assert.equal(f.reviewed.acts.length, 6);
  assert.equal(f.reviewed.acts.reduce((n, act) => n + act.approvedExceptions.length, 0), 18);
  assert.equal(f.policy.status, 'USER_APPROVED');
  assert.equal(f.approvedPolicy.policySha256, activation.REFRESHED_BOUNDARY_POLICY_SHA256);
  assert.throws(() => activation.verifyApprovedBoundaryPolicy({ policy:f.policy, policyBytes:f.policyBytes, script:f.script, scriptSha256:f.policy.binding.candidateScriptSha256, amendmentSha256:f.policy.binding.candidateAmendmentSha256 }), /ACTIVATION_REFRESHED_BOUNDARY_BINDING_MISMATCH/u);
  const wrongBindings = { ...activation.REFRESHED_BOUNDARY_POLICY_BINDINGS, globalRequestLedgerSha256:'0'.repeat(64) };
  assert.throws(() => activation.verifyApprovedBoundaryPolicy({ policy:f.policy, policyBytes:f.policyBytes, script:f.script, scriptSha256:f.policy.binding.candidateScriptSha256, amendmentSha256:f.policy.binding.candidateAmendmentSha256, actualBindings:wrongBindings }), /ACTIVATION_REFRESHED_BOUNDARY_BINDING_MISMATCH/u);
  for (const field of ['packageIndexSha256','lockedEditPlanSha256','candidatePreTimingEditPlanSha256','candidateScriptSha256','combinedTranscriptSha256','alignmentProposalSha256','alignmentApprovalSha256','boundaryProposalSha256','boundaryApprovalSha256','newAct3AudioSha256','evidenceApprovalSha256','globalRequestLedgerSha256','candidateAmendmentSha256','retainedTimingSourceReceiptSha256','previousApprovedBoundaryPolicySha256']) {
    const changed = { ...activation.REFRESHED_BOUNDARY_POLICY_BINDINGS, [field]:'0'.repeat(64) };
    assert.throws(() => activation.verifyApprovedBoundaryPolicy({ policy:f.policy, policyBytes:f.policyBytes, script:f.script, scriptSha256:f.policy.binding.candidateScriptSha256, amendmentSha256:f.policy.binding.candidateAmendmentSha256, actualBindings:changed }), /ACTIVATION_REFRESHED_BOUNDARY_BINDING_MISMATCH/u, field);
  }
  for (const actKey of Object.keys(activation.REFRESHED_BOUNDARY_POLICY_BINDINGS.unchangedAudioHashes)) {
    const changed = structuredClone(activation.REFRESHED_BOUNDARY_POLICY_BINDINGS);
    changed.unchangedAudioHashes[actKey]='0'.repeat(64);
    assert.throws(() => activation.verifyApprovedBoundaryPolicy({ policy:f.policy, policyBytes:f.policyBytes, script:f.script, scriptSha256:f.policy.binding.candidateScriptSha256, amendmentSha256:f.policy.binding.candidateAmendmentSha256, actualBindings:changed }), /ACTIVATION_REFRESHED_BOUNDARY_BINDING_MISMATCH/u, actKey);
  }
});

test('audio rebind leaves all 18 alignment occurrences and boundary editorial decisions unchanged', () => {
  const f = fixture();
  const oldProposal = JSON.parse(fs.readFileSync(path.join(ROOT,'immutable-inputs/railway/alignment-review-proposal.v1.json')));
  const oldBoundary = JSON.parse(fs.readFileSync(path.join(OUT,'boundary-policy-proposal.unsigned.v1.json')));
  const removed = oldProposal.proposedExceptions.filter(item => !f.alignmentProposal.proposedExceptions.some(next => next.exceptionId === item.exceptionId));
  assert.equal(oldProposal.proposedExceptions.length,19);
  assert.equal(f.alignmentProposal.proposedExceptions.length,18);
  assert.equal(f.alignmentApproval.approvedExceptions.length,18);
  assert.equal(f.alignmentApproval.humanApproval.sourceProposalSha256,activation.sha256(read(path.join(OUT,'alignment-review-proposal.unsigned.v1.json'))));
  assert.equal(removed.length,1);
  assert.equal(removed[0].actKey,'act3');
  assert.equal(removed[0].scriptToken,'And');
  assert.equal(removed[0].transcriptToken,'an');
  for (const item of f.alignmentProposal.proposedExceptions) {
    const old = oldProposal.proposedExceptions.find(prior => prior.exceptionId === item.exceptionId);
    assert.deepEqual(item,old);
  }
  assert.deepEqual(f.boundaryProposal.carryForwardAssessment,oldBoundary.carryForwardAssessment);
  assert.equal(f.boundaryProposal.carryForwardAssessment.unchangedAct2BoundaryAuthorization.length,1);
  assert.equal(f.boundaryProposal.carryForwardAssessment.unchangedApprovedAllocations.length,6);
  assert.equal(f.boundaryProposal.carryForwardAssessment.approvedAct3CorrectionRanges.length,4);
  assert.equal(f.boundaryProposal.carryForwardAssessment.retirements.some(item => item.beatId==='ACT3B_B010'),true);
});

test('Act 3 lexical boundaries translate exactly to whitespace ranges with same narration ownership', () => {
  const f = fixture();
  const rows = f.policy.allocations.filter(item => item.actKey === 'act3');
  assert.deepEqual(rows.map(item => [item.beatId,item.lexicalRange.start,item.lexicalRange.end,item.startTokenIndex,item.endTokenIndex]), [
    ['ACT3_B016',115,123,116,124], ['ACT3_B017',124,135,125,136], ['ACT3_B018',136,146,137,147], ['ACT3_B019',147,154,148,155],
  ]);
  for (const item of rows) {
    const result = activation.deriveRefreshedWhitespaceRange({ scriptText:f.script.acts.act3.voScript, lexicalRange:item.lexicalRange, expectedExcerpt:item.excerpt });
    assert.deepEqual([result.start,result.end,result.excerpt],[item.startTokenIndex,item.endTokenIndex,item.excerpt]);
  }
  assert.throws(() => activation.deriveRefreshedWhitespaceRange({ scriptText:f.script.acts.act3.voScript, lexicalRange:{start:999,end:1000,indexConvention:'zero-based-inclusive-act-local-lexical-word'}, expectedExcerpt:'x' }), /LEXICAL_RANGE_INVALID/u);
  assert.throws(() => activation.deriveRefreshedWhitespaceRange({ scriptText:f.script.acts.act3.voScript, lexicalRange:rows[0].lexicalRange, expectedExcerpt:'altered narration' }), /LEXICAL_TEXT_MISMATCH/u);
});

test('refreshed verifier refuses missing, extra, reordered or altered decisions and cross-policy bindings', () => {
  const f = fixture();
  const verify = policy => activation.verifyApprovedBoundaryPolicy({ policy, policyBytes:Buffer.from(JSON.stringify(policy,null,2)+'\n'), script:f.script, scriptSha256:f.policy.binding.candidateScriptSha256, amendmentSha256:f.policy.binding.candidateAmendmentSha256, actualBindings:activation.REFRESHED_BOUNDARY_POLICY_BINDINGS });
  for (const mutate of [p => p.allocations.pop(), p => p.allocations.push(p.allocations[0]), p => p.allocations.reverse(), p => { p.allocations[0].startTokenIndex++; }]) {
    const altered=structuredClone(f.policy); mutate(altered);
    assert.throws(() => verify(altered), /POLICY_HASH_MISMATCH/u);
  }
  assert.notEqual(f.boundaryProposal.carryForwardAssessment.approvedAct3CorrectionRanges.length,0);
  assert.equal(f.policy.retirements.some(x => x.actKey==='act3b' && x.beatId==='ACT3B_B010'),true);
});

test('shared six-act mapper and retimer pass on refreshed inputs and keep B010 retired', () => {
  const f=fixture();
  const audit=activation.auditEditPlanBoundaries({ plan:f.plan, wordTimestamps:f.words, actOrder, actBindings, actDurationsSec:f.actDurationsSec, script:f.script, reviewedAlignment:f.reviewed, approvedBoundaryPolicy:f.approvedPolicy, boundaryInputHashes:f.boundaryInputHashes });
  assert.equal(audit.status,'BOUNDARY_AUDIT_PASS');
  assert.deepEqual(audit.acts.map(x=>[x.actKey,x.mappedBoundaryCount,x.boundaryCount]),[['act1',60,60],['act2',52,52],['act3',58,58],['act3b',34,34],['act4',48,48],['act5',54,54]]);
  assert.equal(audit.errors.length,0);
  const retimed=activation.retimeEditPlan({ plan:f.plan, wordTimestamps:f.words, actOrder, actBindings, actDurationsSec:f.actDurationsSec, script:f.script, reviewedAlignment:f.reviewed, approvedBoundaryPolicy:f.approvedPolicy, boundaryInputHashes:f.boundaryInputHashes });
  const act3b=retimed.plan.sequences.filter(s=>s.actKey==='act3b').flatMap(s=>s.beats);
  assert.equal(act3b.length,17);
  assert.equal(act3b.some(b=>b.beatId==='ACT3B_B010'),false);
  assert.equal(retimed.plan.timing.totalDurationSec, 633.782449);
});
