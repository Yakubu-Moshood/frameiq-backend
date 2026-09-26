'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TARGET_FILES, sha256, groupWordTimestamps, auditEditPlanBoundaries, retimeEditPlan,
  assertOnlyApprovedActTextChanges, assertScriptTimestampParity,
  assertCreativePlanFieldsFrozen, verifyReplacementSet, makeBackup, verifyBackup, restoreBackup, reserveWhisperAttempt,
  analyzeScriptTimestampAlignment, verifyCompletedTimingArtifacts,
  chooseTimingTranscript, classifyReviewMismatch, buildAlignmentReviewProposal, applyAlignmentReviewApproval,
  verifyApprovedBoundaryPolicy, updateProductionManifestForRetirements, updateShotDefinitions,
} = require('../pipeline-updates/episode-activation.cjs');
const { artifactSha256: revisionArtifactSha256, validateRevisionChain } = require('../pipeline-updates/revision-lineage.cjs');
const activation = require('../pipeline-updates/episode-activation.cjs');
const activationCli = require('../scripts/phase2.3b-p-activate.cjs');
const { validateEditPlan } = require('../pipeline-updates/edit-plan-validator.cjs');

function fixture() {
  const bindings = { act1: 'VO_Act1.mp3', act2: 'VO_Act2.mp3' };
  const plan = {
    episodeId: 'episode-a', title: 'Locked title', schemaVersion: '3.0.0',
    timing: { basis: 'previous', totalDurationSec: 8, acts: [
      { actKey: 'act1', voKey: bindings.act1, wordCount: 2, startSec: 0, endSec: 4, durationSec: 4 },
      { actKey: 'act2', voKey: bindings.act2, wordCount: 2, startSec: 4, endSec: 8, durationSec: 4 },
    ] },
    sequences: [
      { sequenceId: 's1', actKey: 'act1', beats: [{ beatId: 'b1', sequenceId: 's1', actKey: 'act1', startWordIndex: 0, endWordIndex: 1, startSec: 0, endSec: 4, durationSec: 4, narrationExcerpt: 'Hello world.', visual: { type: 'STOCK', description: 'same' } }] },
      { sequenceId: 's2', actKey: 'act2', beats: [{ beatId: 'b2', sequenceId: 's2', actKey: 'act2', startWordIndex: 0, endWordIndex: 1, startSec: 4, endSec: 8, durationSec: 4, narrationExcerpt: 'Second act.', visual: { type: 'STOCK', description: 'same' } }] },
    ],
  };
  const words = [
    { vo_file: bindings.act1, word: 'Hello', start_seconds: 0.2, end_seconds: 0.5 },
    { vo_file: bindings.act1, word: 'world.', start_seconds: 1.1, end_seconds: 1.5 },
    { vo_file: bindings.act2, word: 'Second', start_seconds: 0.1, end_seconds: 0.4 },
    { vo_file: bindings.act2, word: 'act.', start_seconds: 0.8, end_seconds: 1.2 },
  ];
  const script = { acts: { act1: { voScript: 'Hello world.' }, act2: { voScript: 'Second act.' } } };
  return { bindings, plan, words, script };
}

test('groups finished word timing by VO while preserving legacy word shape', () => {
  const { bindings, words } = fixture();
  const grouped = groupWordTimestamps(words, bindings);
  assert.deepEqual(grouped.get(bindings.act1).map(({ word }) => word), ['Hello', 'world.']);
  assert.deepEqual(Object.keys(words[0]), ['vo_file', 'word', 'start_seconds', 'end_seconds']);
});

test('deterministically retimes all beats on episode-absolute timing and preserves creative fields', () => {
  const { bindings, plan, words, script } = fixture();
  const reviewedAlignment = reviewedFor(script, words, bindings);
  const result = retimeEditPlan({ plan, wordTimestamps: words, actOrder: ['act1', 'act2'], actBindings: bindings, actDurationsSec: { act1: 3, act2: 2 }, script, reviewedAlignment });
  assert.equal(result.plan.timing.totalDurationSec, 5);
  assert.deepEqual(result.plan.timing.acts.map(({ startSec, endSec, durationSec }) => [startSec, endSec, durationSec]), [[0, 3, 3], [3, 5, 2]]);
  assert.deepEqual(result.plan.sequences.map(({ beats }) => [beats[0].startSec, beats[0].endSec, beats[0].durationSec, beats[0].narrationExcerpt]), [[0, 3, 3, 'Hello world.'], [3, 5, 2, 'Second act.']]);
  assert.equal(result.plan.sequences[0].beats[0].visual.description, 'same');
  assert.equal(plan.timing.totalDurationSec, 8, 'input plan remains immutable');
  assertCreativePlanFieldsFrozen(plan, result.plan);
});

test('rejects missing, unordered and duplicate-act timing structures', () => {
  const { bindings, words } = fixture();
  assert.throws(() => groupWordTimestamps([], bindings), /ACTIVATION_TIMESTAMPS_EMPTY/);
  assert.throws(() => groupWordTimestamps([words[1], words[0], ...words.slice(2)], bindings), /ACTIVATION_TIMESTAMP_ORDER/);
  const { script } = fixture();
  assert.throws(() => retimeEditPlan({ plan: fixture().plan, wordTimestamps: words, actOrder: ['act1', 'act1'], actBindings: bindings, actDurationsSec: { act1: 3 }, script, reviewedAlignment: reviewedFor(script, words, bindings) }), /ACTIVATION_DUPLICATE_ACT/);
});

test('only approved narration fields may differ in candidate script', () => {
  const original = { title: 'same', acts: { act1: { voScript: 'old', other: 1 }, act2: { voScript: 'same', other: 2 } } };
  const candidate = structuredClone(original); candidate.acts.act1.voScript = 'new';
  assert.equal(assertOnlyApprovedActTextChanges(original, candidate, ['act1']), true);
  candidate.acts.act2.voScript = 'unauthorized';
  assert.throws(() => assertOnlyApprovedActTextChanges(original, candidate, ['act1']), /ACTIVATION_UNAPPROVED_SCRIPT_CHANGE/);
});

test('corrected script text aligns through punctuation and exact token parity', () => {
  const { bindings, words } = fixture();
  assert.equal(assertScriptTimestampParity({ acts: { act1: { voScript: 'Hello world.' }, act2: { voScript: 'Second act.' } } }, words, bindings), true);
  assert.throws(() => assertScriptTimestampParity({ acts: { act1: { voScript: 'Hello missing.' }, act2: { voScript: 'Second act.' } } }, words, bindings), /ACTIVATION_SCRIPT_AUDIO_WORD_PARITY:act1/);
});

function timedWords(voKey, text) {
  return text.trim().split(/\s+/u).map((word, index) => ({ vo_file: voKey, word, start_seconds: index, end_seconds: index + 0.5 }));
}

function alignment(scriptText, transcriptText) {
  const voKey = 'VO_Act1';
  return analyzeScriptTimestampAlignment({ acts: { act1: { voScript: scriptText } } }, timedWords(voKey, transcriptText), { act1: voKey }).acts[0];
}

function reviewedFor(script, words, bindings, approved = false) {
  const deterministic = analyzeScriptTimestampAlignment(script, words, bindings);
  if (deterministic.status === 'PASS') return {
    status: 'PASS', unusedApprovalExceptionIds: [], explicitRefusalOfUnlistedMismatches: true,
    acts: deterministic.acts.map(act => ({ ...act, status: 'PASS', approvedExceptions: [], unapprovedExceptions: [], uncoveredScriptTokenIndices: [] })),
  };
  if (!approved) return { ...deterministic, status: 'FAIL' };
  const reviewBindings = { runId: 'run-123456', episodeId: 'episode-test', channelKey: 'EmpireOmitted' };
  const proposal = buildAlignmentReviewProposal({ runId: reviewBindings.runId, bindings: reviewBindings, alignment: deterministic });
  const approval = {
    ...proposal, schemaVersion: 'phase2.3b-p-alignment-review-approval/1.0.0', status: 'USER_APPROVED',
    approvedExceptions: proposal.proposedExceptions,
    humanApproval: { approvedBy: 'CTO', approvalRef: 'test-review', approvedAt: '2026-01-01T00:00:00Z', sourceProposalSha256: 'a'.repeat(64) },
  };
  return applyAlignmentReviewApproval({ alignment: deterministic, approvalArtifact: approval, expectedBindings: reviewBindings });
}

function makeRetimingFixture({ sourceTexts, planTexts, transcriptTexts, beatRanges } = {}) {
  const actKeys = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  const bindings = Object.fromEntries(actKeys.map(key => [key, `VO_${key}`]));
  const script = { acts: Object.fromEntries(actKeys.map(key => [key, { voScript: sourceTexts?.[key] || `Approved ${key} narration.` }])) };
  const words = [], sequences = [], acts = [];
  let episodeCursor = 0;
  for (const actKey of actKeys) {
    const sourceWords = script.acts[actKey].voScript.trim().split(/\s+/u);
    const planWords = (planTexts?.[actKey] || script.acts[actKey].voScript).trim().split(/\s+/u);
    const transcriptWords = (transcriptTexts?.[actKey] || script.acts[actKey].voScript).trim().split(/\s+/u);
    const localWords = transcriptWords.map((word, index) => ({ vo_file: bindings[actKey], word, start_seconds: index * 0.5, end_seconds: index * 0.5 + 0.2 }));
    words.push(...localWords);
    const durationSec = Math.max(10, localWords.at(-1).end_seconds + 1);
    acts.push({ actKey, voKey: bindings[actKey], startSec: episodeCursor, endSec: episodeCursor + 10, durationSec: 10, wordCount: planWords.length });
    const ranges = beatRanges?.[actKey] || [[0, planWords.length - 1]];
    sequences.push({ sequenceId: `sequence-${actKey}`, actKey, beats: ranges.map(([first, last], index) => ({
      beatId: `beat-${actKey}-${index + 1}`, sequenceId: `sequence-${actKey}`, actKey,
      startWordIndex: first, endWordIndex: last, startSec: episodeCursor, endSec: episodeCursor + 10,
      durationSec: 10, narrationExcerpt: planWords.slice(first, last + 1).join(' '), visual: { type: 'CLIP', description: 'preserved' },
    })) });
    episodeCursor += 10;
  }
  const plan = { episodeId: 'episode-test', title: 'Locked', schemaVersion: '3.0.0', timing: { basis: 'finished_vo_word_timestamps', totalDurationSec: 60, acts }, sequences };
  return { actKeys, bindings, script, words, wordTimestamps: words, plan };
}

function retimeFixture(options = {}) {
  const value = makeRetimingFixture(options);
  const reviewedAlignment = reviewedFor(value.script, value.words, value.bindings, true);
  const actDurationsSec = Object.fromEntries(value.actKeys.map(key => {
    const actWords = value.words.filter(word => word.vo_file === value.bindings[key]);
    return [key, Math.max(10, actWords.at(-1).end_seconds + 1)];
  }));
  return { ...value, reviewedAlignment, result: retimeEditPlan({ ...value, actOrder: value.actKeys, actBindings: value.bindings, actDurationsSec, reviewedAlignment }) };
}

test('Act 2 opening boundaries map to locked transcript indices zero and nine with the reviewed next beat at ten', () => {
  const opening = 'Wells Fargo was founded in 1852 during the California Gold Rush For over 150 years it built a reputation as'.split(/\s+/u);
  const narration = [...opening, ...Array.from({ length: 200 }, (_, index) => `segmentword${index}`), 'Wells', 'Fargo'].join(' ');
  const { result } = retimeFixture({ sourceTexts: { act2: narration }, transcriptTexts: { act2: narration }, beatRanges: { act2: [[0, 9], [10, 19], [20, 221]] } });
  const beats = result.plan.sequences.find(sequence => sequence.actKey === 'act2').beats;
  assert.deepEqual(beats.map(beat => [beat.startWordIndex, beat.endWordIndex]), [[0, 9], [10, 19], [20, 221]]);
  assert.equal(beats[0].narrationExcerpt, 'Wells Fargo was founded in 1852 during the California Gold');
  assert.equal(beats[1].narrationExcerpt, 'Rush For over 150 years it built a reputation as');
});

test('repeated words resolve through their complete ordered surrounding sequence', () => {
  const { result } = retimeFixture({
    sourceTexts: { act2: 'Wells Fargo opened after Wells Fargo closed.' },
    planTexts: { act2: 'Wells opened after Wells closed.' },
    transcriptTexts: { act2: 'Wells Fargo opened after Wells Fargo closed.' },
    beatRanges: { act2: [[0, 2], [3, 4]] },
  });
  const beats = result.plan.sequences.find(sequence => sequence.actKey === 'act2').beats;
  assert.deepEqual(beats.map(beat => [beat.startWordIndex, beat.endWordIndex]), [[0, 3], [4, 6]]);
});

test('repeated word alignments that permit different complete beat boundaries remain ambiguous', () => {
  const value = makeRetimingFixture({
    sourceTexts: { act2: 'A The The B.' },
    planTexts: { act2: 'A The B.' },
    transcriptTexts: { act2: 'A The The B.' },
    beatRanges: { act2: [[0, 1], [2, 2]] },
  });
  const reviewedAlignment = reviewedFor(value.script, value.words, value.bindings);
  const input = { ...value, actOrder: value.actKeys, actBindings: value.bindings, actDurationsSec: Object.fromEntries(value.actKeys.map(key => [key, 10])), reviewedAlignment };
  const audit = auditEditPlanBoundaries(input);
  assert.equal(audit.status, 'BOUNDARY_AUDIT_FAIL');
  assert.ok(audit.acts.find(act => act.actKey === 'act2').ambiguousMappings.length > 0);
  assert.throws(() => retimeEditPlan(input), /ACTIVATION_BOUNDARY_MAPPING_AMBIGUOUS:act2/u);
});

test('six-act CLI boundary audit shares candidate mappings, reports full coverage, and performs no writes or provider calls', async () => {
  const value = approvedRevisionFixture();
  const reviewedAlignment = value.reviewedAlignment;
  const input = { plan: value.plan, wordTimestamps: value.words, actOrder: value.actOrder, actBindings: value.bindings, actDurationsSec: value.durations, script: value.script, reviewedAlignment, approvedBoundaryPolicy: value.approvedBoundaryPolicy };
  const before = structuredClone(input);
  const orchestration = { targetChecks: 0, packageChecks: 0, runtimeChecks: 0, preflightChecks: 0, scriptReads: 0, planReads: 0, audioProbes: 0, providerCalls: 0, writes: 0 };
  const audioContracts = value.actOrder.map(actKey => ({ actKey, file: `${actKey}.mp3` }));
  const audit = await activationCli.auditResumeBoundaries({
    runId: 'audit-run-123',
    ensureTarget: () => { orchestration.targetChecks++; },
    verifyPackageFn: () => { orchestration.packageChecks++; },
    verifyRuntimeSyncFn: () => { orchestration.runtimeChecks++; },
    resumePreflight: runId => { orchestration.preflightChecks++; assert.equal(runId, 'audit-run-123'); return { completed: { timestamps: value.words }, alignment: reviewedAlignment }; },
    getApprovedScript: () => { orchestration.scriptReads++; return value.script; },
    loadBoundaryPolicy: ({ script: loadedScript }) => {
      assert.deepEqual(loadedScript, value.script, 'the approved script is supplied to the lineage loader');
      const policy = JSON.parse(value.policyBytes.toString('utf8'));
      const verified = verifyApprovedBoundaryPolicy({ policy, policyBytes: value.policyBytes, script: loadedScript, scriptSha256: policy.scriptSha256, amendmentSha256: policy.revisionLineage.amendmentSha256 });
      assert.equal(verified.allocations.length, 6, 'the CLI test double validates and supplies every lineage-bound range');
      assert.deepEqual(verified.retirements.map(item => item.revisionLineageEntry), ['approved-retirement:act3b:ACT3B_B010']);
      return verified;
    },
    getBoundaryInputHashes: () => value.boundaryInputHashes,
    loadPlan: () => { orchestration.planReads++; return value.plan; },
    audioContracts,
    actOrder: value.actOrder,
    actBindings: value.bindings,
    probeAudio: file => {
      orchestration.audioProbes++;
      assert.match(file, /fresh-whisper[\\/]audio/u);
      const contract = audioContracts.find(item => file.endsWith(item.file));
      return { durationSec: value.durations[contract.actKey] };
    },
  });
  const candidate = retimeEditPlan(input).plan;
  assert.equal(audit.status, 'BOUNDARY_AUDIT_PASS', JSON.stringify(audit.errors));
  assert.deepEqual(audit.acts.map(act => act.actKey), value.actOrder);
  for (const act of audit.acts) {
    assert.equal(act.mappedBoundaryCount, act.boundaryCount);
    assert.equal(act.firstMappedTranscriptIndex, 0);
    assert.equal(act.lastMappedTranscriptIndex, act.transcriptWordCount - 1);
    assert.deepEqual(act.gaps, []);
    assert.deepEqual(act.overlaps, []);
    const candidateBeats = candidate.sequences.filter(sequence => sequence.actKey === act.actKey).flatMap(sequence => sequence.beats);
    assert.equal(candidateBeats[0].startWordIndex, act.firstMappedTranscriptIndex);
    assert.equal(candidateBeats.at(-1).endWordIndex, act.lastMappedTranscriptIndex);
  }
  assert.equal(audit.providerRequestsMade, 0);
  assert.equal(audit.candidateWrites, 0);
  assert.equal(audit.episodeRootWrites, 0);
  assert.deepEqual(orchestration, { targetChecks: 1, packageChecks: 1, runtimeChecks: 1, preflightChecks: 1, scriptReads: 1, planReads: 1, audioProbes: 6, providerCalls: 0, writes: 0 });
  assert.deepEqual(input, before);
});

test('six-act boundary audit accumulates failures in every affected act', () => {
  const value = makeRetimingFixture({
    sourceTexts: { act2: 'The The.', act4: 'The The.' },
    planTexts: { act2: 'The.', act4: 'The.' },
    transcriptTexts: { act2: 'The The.', act4: 'The The.' },
  });
  const audit = auditEditPlanBoundaries({
    ...value, actOrder: value.actKeys, actBindings: value.bindings,
    actDurationsSec: Object.fromEntries(value.actKeys.map(key => [key, 10])),
    reviewedAlignment: reviewedFor(value.script, value.words, value.bindings),
  });
  assert.equal(audit.status, 'BOUNDARY_AUDIT_FAIL');
  assert.deepEqual([...new Set(audit.errors.map(error => error.actKey))], ['act2', 'act4']);
  assert.equal(audit.acts.length, 6);
});

test('reviewed alignment remaps Act 2 o’clock tokenization and shifts every later boundary by one', () => {
  const { plan, result } = retimeFixture({
    sourceTexts: { act2: "An 8 o'clock signal arrived." },
    transcriptTexts: { act2: 'An 8 o clock signal arrived.' },
    beatRanges: { act2: [[0, 2], [3, 4]] },
  });
  const beats = result.plan.sequences.find(sequence => sequence.actKey === 'act2').beats;
  assert.deepEqual(beats.map(beat => [beat.startWordIndex, beat.endWordIndex, beat.narrationExcerpt]), [
    [0, 3, 'An 8 o clock'], [4, 5, 'signal arrived.'],
  ]);
  assert.equal(result.plan.timing.acts[1].wordCount, 6);
  assertCreativePlanFieldsFrozen(plan, result.plan);
});

test('reviewed alignment remaps split decimals and comma-formatted numbers by normalized units', () => {
  const decimal = retimeFixture({
    sourceTexts: { act2: 'The order required 3.7 billion dollars.' },
    transcriptTexts: { act2: 'The order required 3 7 billion dollars.' },
  });
  const decimalBeat = decimal.result.plan.sequences.find(sequence => sequence.actKey === 'act2').beats[0];
  assert.equal(decimalBeat.endWordIndex, 6);
  assert.equal(decimalBeat.narrationExcerpt, 'The order required 3 7 billion dollars.');
  const comma = retimeFixture({
    sourceTexts: { act2: 'More than 5,300 workers left.' },
    transcriptTexts: { act2: 'More than 5 300 workers left.' },
  });
  const commaBeat = comma.result.plan.sequences.find(sequence => sequence.actKey === 'act2').beats[0];
  assert.equal(commaBeat.endWordIndex, 5);
  assert.match(commaBeat.narrationExcerpt, /5 300/u);
});

test('live Act 1 boundary 11 maps through the approved omitted-currency relation without shifting the next beat', () => {
  const planText = "in 2015 wells fargo was america's most valuable bank worth 300 billion by 2020 the bank had agreed to a 3 billion federal resolution";
  const scriptText = "in 2015 wells fargo was america's most valuable bank worth 300 billion dollars by 2020 the bank had agreed to a 3 billion federal resolution";
  const { result } = retimeFixture({
    sourceTexts: { act1: scriptText },
    planTexts: { act1: planText },
    transcriptTexts: { act1: planText },
    beatRanges: { act1: [[0, 8], [9, 11], [12, 23]] },
  });
  const beats = result.plan.sequences.find(sequence => sequence.actKey === 'act1').beats;
  assert.deepEqual(beats.map(beat => [beat.startWordIndex, beat.endWordIndex]), [[0, 8], [9, 11], [12, 23]]);
  assert.equal(beats[1].narrationExcerpt, 'worth 300 billion');
  assert.equal(beats[1].endWordIndex, 11);
  assert.equal(beats[2].startWordIndex, 12);
  assert.equal(beats[2].narrationExcerpt.startsWith('by '), true);
});

test('an unprovable reviewed boundary does not create candidate output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-retime-no-candidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = makeRetimingFixture({
    sourceTexts: { act2: 'The The.' },
    planTexts: { act2: 'The.' },
    transcriptTexts: { act2: 'The The.' },
  });
  const reviewed = reviewedFor(value.script, value.words, value.bindings, true);
  const candidate = path.join(root, 'candidate');
  assert.throws(() => activationCli.retimeBeforeCandidateOutput({
    candidateDirectory: candidate,
    retime: () => retimeEditPlan({ ...value, actOrder: value.actKeys, actBindings: value.bindings, actDurationsSec: Object.fromEntries(value.actKeys.map(key => [key, 10])), reviewedAlignment: reviewed }),
  }), /ACTIVATION_BOUNDARY_MAPPING_(?:AMBIGUOUS|COVERAGE):act2/u);
  assert.equal(fs.existsSync(candidate), false);
});

test('reviewed multi-token spans map outer boundaries and assign a split indivisible span consistently', () => {
  const good = retimeFixture({
    sourceTexts: { act2: 'Before 300 billion dollars after.' },
    planTexts: { act2: 'Before 300 billion after.' },
    transcriptTexts: { act2: 'Before 300 billion after.' },
    beatRanges: { act2: [[0, 0], [1, 3]] },
  });
  const goodBeats = good.result.plan.sequences.find(sequence => sequence.actKey === 'act2').beats;
  assert.deepEqual(goodBeats.map(beat => [beat.startWordIndex, beat.endWordIndex]), [[0, 0], [1, 3]]);

  const inside = makeRetimingFixture({
    sourceTexts: { act2: 'Before 3.7 billion dollars after.' },
    planTexts: { act2: 'Before 3 7 billion after.' },
    transcriptTexts: { act2: 'Before 3 7 billion after.' },
    beatRanges: { act2: [[0, 1], [2, 4]] },
  });
  const reviewed = reviewedFor(inside.script, inside.words, inside.bindings, true);
  const mapped = retimeEditPlan({ ...inside, actOrder: inside.actKeys, actBindings: inside.bindings, actDurationsSec: Object.fromEntries(inside.actKeys.map(key => [key, 10])), reviewedAlignment: reviewed }).plan.sequences.find(sequence => sequence.actKey === 'act2').beats;
  assert.deepEqual(mapped.map(beat => [beat.startWordIndex, beat.endWordIndex]), [[0, 3], [4, 4]]);
  assert.deepEqual(mapped.map(beat => beat.narrationExcerpt), ['Before 3 7 billion', 'after.']);
});

test('approved multi-token currency omission maps the whole boundary range', () => {
  const { result } = retimeFixture({
    sourceTexts: { act2: 'The bank refunded $3.7 billion dollars today.' },
    transcriptTexts: { act2: 'The bank refunded 3 7 billion today.' },
  });
  const beat = result.plan.sequences.find(sequence => sequence.actKey === 'act2').beats[0];
  assert.equal(beat.endWordIndex, 6);
  assert.equal(beat.narrationExcerpt, 'The bank refunded 3 7 billion today.');
});

test('approved one-to-one phonetic variant maps through the exact reviewed occurrence', () => {
  const { result } = retimeFixture({
    sourceTexts: { act2: 'Stumpf presented a statement.' },
    transcriptTexts: { act2: 'Stump presented a statement.' },
  });
  const beat = result.plan.sequences.find(sequence => sequence.actKey === 'act2').beats[0];
  assert.equal(beat.narrationExcerpt, 'Stump presented a statement.');
  assert.equal(beat.endWordIndex, 3);
});

test('exact-count alignment retains the same word ranges and seconds', () => {
  const { result } = retimeFixture();
  for (const sequence of result.plan.sequences) {
    assert.equal(sequence.beats[0].startWordIndex, 0);
    assert.equal(sequence.beats[0].endWordIndex, 2);
  }
});

test('unapproved substitutions and incomplete reviewed mappings fail closed before candidate output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-retime-no-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = makeRetimingFixture({ sourceTexts: { act2: 'The order stands.' }, transcriptTexts: { act2: 'The settlement stands.' } });
  const failed = reviewedFor(value.script, value.words, value.bindings);
  assert.throws(() => retimeEditPlan({ ...value, actOrder: value.actKeys, actBindings: value.bindings, actDurationsSec: Object.fromEntries(value.actKeys.map(key => [key, 10])), reviewedAlignment: failed }), /ACTIVATION_REVIEWED_ALIGNMENT_NOT_PASS/u);
  assert.deepEqual(fs.readdirSync(root), []);
  const altered = reviewedFor({ acts: Object.fromEntries(value.actKeys.map(key => [key, { voScript: key === 'act2' ? 'The order stands.' : `Approved ${key} narration.` }])) }, value.words, value.bindings, true);
  altered.status = 'PASS';
  const alteredAct = altered.acts.find(act => act.actKey === 'act2');
  alteredAct.status = 'PASS'; alteredAct.unapprovedExceptions = []; alteredAct.uncoveredScriptTokenIndices = []; alteredAct.matchedTokens = [];
  assert.throws(() => retimeEditPlan({ ...value, script: { ...value.script, acts: { ...value.script.acts, act2: { voScript: 'The order stands.' } } }, actOrder: value.actKeys, actBindings: value.bindings, actDurationsSec: Object.fromEntries(value.actKeys.map(key => [key, 10])), reviewedAlignment: altered }), /ACTIVATION_REVIEWED_ALIGNMENT_COVERAGE:act2/u);
});

test('ambiguous, non-monotonic, overlapping and uncovered boundary maps are rejected', () => {
  const ambiguous = makeRetimingFixture({ sourceTexts: { act2: 'The The.' }, planTexts: { act2: 'The.' }, transcriptTexts: { act2: 'The The.' } });
  assert.throws(() => retimeEditPlan({ ...ambiguous, actOrder: ambiguous.actKeys, actBindings: ambiguous.bindings, actDurationsSec: Object.fromEntries(ambiguous.actKeys.map(key => [key, 10])), reviewedAlignment: reviewedFor(ambiguous.script, ambiguous.words, ambiguous.bindings) }), /ACTIVATION_BOUNDARY_MAPPING_(?:AMBIGUOUS|COVERAGE):act2/u);

  const nonMonotonic = makeRetimingFixture();
  const reviewed = reviewedFor(nonMonotonic.script, nonMonotonic.words, nonMonotonic.bindings);
  const act = reviewed.acts.find(item => item.actKey === 'act2');
  [act.matchedTokens[0].transcriptTokenIndex, act.matchedTokens[1].transcriptTokenIndex] = [act.matchedTokens[1].transcriptTokenIndex, act.matchedTokens[0].transcriptTokenIndex];
  assert.throws(() => retimeEditPlan({ ...nonMonotonic, actOrder: nonMonotonic.actKeys, actBindings: nonMonotonic.bindings, actDurationsSec: Object.fromEntries(nonMonotonic.actKeys.map(key => [key, 10])), reviewedAlignment: reviewed }), /ACTIVATION_REVIEWED_ALIGNMENT_RANGE_INVALID|ACTIVATION_REVIEWED_ALIGNMENT_NON_MONOTONIC/u);
  const duplicateRelation = makeRetimingFixture({ sourceTexts: { act2: "Wells Fargo's report." } });
  const duplicateReviewed = reviewedFor(duplicateRelation.script, duplicateRelation.words, duplicateRelation.bindings);
  const duplicateAct = duplicateReviewed.acts.find(item => item.actKey === 'act2');
  const overlappingRelation = structuredClone(duplicateAct.matchedTokens[0]);
  overlappingRelation.transcriptTokenIndex = 1; overlappingRelation.transcriptTokenEndIndex = 1;
  duplicateAct.matchedTokens.push(overlappingRelation);
  assert.throws(() => retimeEditPlan({ ...duplicateRelation, actOrder: duplicateRelation.actKeys, actBindings: duplicateRelation.bindings, actDurationsSec: Object.fromEntries(duplicateRelation.actKeys.map(key => [key, 10])), reviewedAlignment: duplicateReviewed }), /ACTIVATION_REVIEWED_ALIGNMENT_COVERAGE:act2/u);

  const split = makeRetimingFixture({ sourceTexts: { act2: "Say o'clock now." }, transcriptTexts: { act2: 'Say o clock now.' }, beatRanges: { act2: [[0, 1], [2, 3]] } });
  split.plan.timing.acts.find(act => act.actKey === 'act2').wordCount = 4;
  const splitBeats = split.plan.sequences.find(sequence => sequence.actKey === 'act2').beats;
  splitBeats[0].narrationExcerpt = 'Say o'; splitBeats[0].endWordIndex = 1;
  splitBeats[1].narrationExcerpt = 'clock now.'; splitBeats[1].startWordIndex = 2;
  assert.throws(() => retimeEditPlan({ ...split, actOrder: split.actKeys, actBindings: split.bindings, actDurationsSec: Object.fromEntries(split.actKeys.map(key => [key, 10])), reviewedAlignment: reviewedFor(split.script, split.words, split.bindings) }), /ACTIVATION_BOUNDARY_(?:MAPPING_COVERAGE|REVIEW_RELATION_AMBIGUOUS):act2/u);

  const uncovered = makeRetimingFixture();
  uncovered.plan.sequences.find(sequence => sequence.actKey === 'act2').beats[0].startWordIndex = 1;
  assert.throws(() => retimeEditPlan({ ...uncovered, actOrder: uncovered.actKeys, actBindings: uncovered.bindings, actDurationsSec: Object.fromEntries(uncovered.actKeys.map(key => [key, 10])), reviewedAlignment: reviewedFor(uncovered.script, uncovered.words, uncovered.bindings) }), /ACTIVATION_PLAN_SOURCE_WORD_COVERAGE:act2/u);
});

test('six-act candidate retiming succeeds with Act 2 split-token timing and no external provider', () => {
  const { result } = retimeFixture({ sourceTexts: { act2: "An 8 o'clock signal arrived." }, transcriptTexts: { act2: 'An 8 o clock signal arrived.' } });
  assert.equal(result.plan.timing.acts.length, 6);
  assert.equal(result.plan.timing.acts[1].wordCount, 6);
  assert.equal(result.plan.sequences.find(sequence => sequence.actKey === 'act2').beats[0].endWordIndex, 5);
});

test('alignment accepts punctuation, case, apostrophe, contractions, possessives and hyphenation forms', () => {
  for (const [scriptText, transcriptText] of [
    ["Wells Fargo’s first-time customers couldn't open accounts.", "wells Fargo's first time customers could not open accounts"],
    ['The bank did not call.', "The bank didn't call."],
  ]) {
    const result = alignment(scriptText, transcriptText);
    assert.equal(result.status, 'PASS', `${scriptText} ↔ ${transcriptText}: ${JSON.stringify({ substitutions: result.substitutions, insertions: result.transcriptInsertions, deletions: result.scriptDeletions })}`);
    assert.equal(result.alignmentCoverage, 100);
  }
});

test('alignment normalizes written and numeric currency expressions without count tolerance', () => {
  for (const [scriptText, transcriptText] of [
    ['$185 million was recorded.', 'one hundred eighty-five million dollars was recorded'],
    ['$2.6 million in fees.', 'two point six million dollars in fees'],
    ['Twenty-five accounts were opened.', '25 accounts were opened'],
    ['3.5 million accounts.', 'three point five million accounts'],
  ]) assert.equal(alignment(scriptText, transcriptText).status, 'PASS', `${scriptText} ↔ ${transcriptText}`);
});

test('alignment rejoins split numeric tokens and safely normalizes spelling forms', () => {
  for (const [scriptText, transcriptText] of [
    ['3.5 million dollars were reported.', '3 5 million dollars were reported'],
    ['2.6 million dollars were reported.', '2 6 million dollars were reported'],
    ['17.5 million dollars were reported.', '17 5 million dollars were reported'],
    ['3.7 billion dollars were reported.', '3 7 billion dollars were reported'],
    ['5,300 accounts were reviewed.', '5 300 accounts were reviewed'],
    ['The accounts were cancelled at eight o’clock.', 'The accounts were canceled at eight o clock'],
  ]) {
    const result = alignment(scriptText, transcriptText);
    assert.equal(result.status, 'PASS', `${scriptText} ↔ ${transcriptText}: ${JSON.stringify(result)}`);
    assert.equal(result.alignmentCoverage, 100);
    if (/\d[.,]?\d/u.test(scriptText) || /\d,\d{3}/u.test(scriptText)) assert.ok(result.normalizedEquivalents.some(item => item.normalizationClass === 'NUMERIC_TOKENIZATION'));
  }
});

test('currency omissions and listed phonetic variants are proposed with exact contexts but never auto-approved', () => {
  const voKey = 'VO_Act1';
  const report = analyzeScriptTimestampAlignment(
    { acts: { act1: { voScript: 'The $185 million dollars and Stumpf said eight.' } } },
    timedWords(voKey, 'The 185 million and stump said aid.'), { act1: voKey },
  );
  assert.equal(report.status, 'FAIL');
  const bindings = { runId: 'run-123456', episodeId: 'episode-1', channelKey: 'EmpireOmitted', candidateScriptSha256: 'a'.repeat(64), approvedAudio: [{ file: 'one.mp3', sha256: 'b'.repeat(64) }], pacingPlanSha256: 'c'.repeat(64), transcriptSemanticSha256: 'd'.repeat(64), transcriptFileSha256: 'e'.repeat(64), sourceReceiptSha256: 'f'.repeat(64), sourceAlignmentReportSha256: '1'.repeat(64), alignmentReportSha256: '2'.repeat(64), requestLedgerSha256: '3'.repeat(64), humanNarrationApprovalSha256: '4'.repeat(64), lockedHashes: {} };
  const proposal = buildAlignmentReviewProposal({ runId: bindings.runId, bindings, alignment: report });
  assert.deepEqual(proposal.proposedExceptions.map(item => item.classification).sort(), ['ASR_CURRENCY_UNIT_OMISSION', 'ASR_PHONETIC_VARIANT', 'ASR_PHONETIC_VARIANT']);
  assert.ok(proposal.proposedExceptions.every(item => Number.isInteger(item.scriptTokenIndex) && item.scriptContext.text && item.transcriptContext.text));
  assert.equal(proposal.status, 'PENDING_HUMAN_REVIEW');
  assert.throws(() => applyAlignmentReviewApproval({ alignment: report, approvalArtifact: proposal, expectedBindings: bindings }), /ALIGNMENT_REVIEW_APPROVAL_INVALID/u);
  const artifact = { ...proposal, schemaVersion: 'phase2.3b-p-alignment-review-approval/1.0.0', status: 'USER_APPROVED', approvedExceptions: proposal.proposedExceptions, humanApproval: { approvedBy: 'CTO', approvalRef: 'review-123', approvedAt: '2026-09-25T00:00:00Z', sourceProposalSha256: '5'.repeat(64) } };
  assert.equal(applyAlignmentReviewApproval({ alignment: report, approvalArtifact: artifact, expectedBindings: bindings }).status, 'PASS');
  for (const key of Object.keys(bindings)) assert.throws(() => applyAlignmentReviewApproval({ alignment: report, approvalArtifact: artifact, expectedBindings: { ...bindings, [key]: 'changed' } }), /ALIGNMENT_REVIEW_BINDING_MISMATCH/u, `changed binding ${key} must be refused`);
});

test('review approval is exact, hash-bound and refuses every unlisted mismatch', () => {
  const voKey = 'VO_Act1';
  const report = analyzeScriptTimestampAlignment(
    { acts: { act1: { voScript: 'Stumpf and order.' } } },
    timedWords(voKey, 'stump an settlement.'), { act1: voKey },
  );
  const bindings = { runId: 'run-123456', episodeId: 'episode-1', channelKey: 'EmpireOmitted', candidateScriptSha256: 'a'.repeat(64) };
  const proposal = buildAlignmentReviewProposal({ runId: bindings.runId, bindings, alignment: report });
  const artifact = { ...proposal, schemaVersion: 'phase2.3b-p-alignment-review-approval/1.0.0', status: 'USER_APPROVED', approvedExceptions: proposal.proposedExceptions, humanApproval: { approvedBy: 'CTO', approvalRef: 'review-123', approvedAt: '2026-09-25T00:00:00Z', sourceProposalSha256: '5'.repeat(64) } };
  const reviewed = applyAlignmentReviewApproval({ alignment: report, approvalArtifact: artifact, expectedBindings: bindings });
  assert.equal(reviewed.status, 'FAIL');
  assert.equal(reviewed.acts[0].approvedExceptions.length, 2);
  assert.equal(reviewed.acts[0].unapprovedExceptions.length, 1);
  assert.equal(reviewed.explicitRefusalOfUnlistedMismatches, true);
  assert.throws(() => applyAlignmentReviewApproval({ alignment: report, approvalArtifact: artifact, expectedBindings: { ...bindings, transcriptFileSha256: 'changed' } }), /ALIGNMENT_REVIEW_BINDING_MISMATCH/u);
});

test('split decimal plus omitted USD unit is proposed generically with deterministic exact-range IDs', () => {
  for (const [scriptText, transcriptText, amount] of [
    ['The $3.7 billion dollars remain.', 'The 3 7 billion remain.', 'money:USD:3700000000'],
    ['The $17.5 million dollars remain.', 'The 17 5 million remain.', 'money:USD:17500000'],
  ]) {
    const actReport = alignment(scriptText, transcriptText);
    const report = { status: actReport.status, acts: [actReport] };
    assert.equal(actReport.status, 'FAIL', 'currency omission remains non-deterministic and review-gated');
    assert.equal(actReport.substitutions.length, 1);
    assert.equal(actReport.substitutions[0].scriptNormalizedToken, amount);
    assert.equal(actReport.substitutions[0].transcriptNormalizedToken, `number:${amount.split(':').at(-1)}`);
    assert.equal(classifyReviewMismatch(actReport.substitutions[0]), 'ASR_CURRENCY_UNIT_OMISSION');
    const bindings = { runId: 'run-123456', episodeId: 'episode-1', channelKey: 'EmpireOmitted', alignmentReportSha256: 'a'.repeat(64) };
    const first = buildAlignmentReviewProposal({ runId: bindings.runId, bindings, alignment: report });
    const second = buildAlignmentReviewProposal({ runId: bindings.runId, bindings, alignment: report });
    assert.equal(first.proposedExceptions[0].classification, 'ASR_CURRENCY_UNIT_OMISSION');
    assert.equal(first.proposedExceptions[0].scriptTokenIndex, actReport.substitutions[0].scriptTokenIndex);
    assert.equal(first.proposedExceptions[0].scriptTokenEndIndex, actReport.substitutions[0].scriptTokenEndIndex);
    assert.equal(first.proposedExceptions[0].transcriptTokenIndex, actReport.substitutions[0].transcriptTokenIndex);
    assert.equal(first.proposedExceptions[0].transcriptTokenEndIndex, actReport.substitutions[0].transcriptTokenEndIndex);
    assert.equal(first.proposedExceptions[0].exceptionId, second.proposedExceptions[0].exceptionId);
  }
});

test('stale 17-entry approval cannot pass the corrected 18-entry proposal; exact 18-entry approval can', () => {
  const scriptText = [...Array(12).fill('The $3.7 billion dollars remain.'), 'Stumpf and Eight Reckard Tolstedt Stumpf.'].join(' ');
  const transcriptText = [...Array(12).fill('The 3 7 billion remain.'), 'stump an aid record tolstead stump.'].join(' ');
  const report = analyzeScriptTimestampAlignment({ acts: { act1: { voScript: scriptText } } }, timedWords('VO_Act1', transcriptText), { act1: 'VO_Act1' });
  const bindings = { runId: 'run-123456', episodeId: 'episode-1', channelKey: 'EmpireOmitted', alignmentReportSha256: 'a'.repeat(64) };
  const proposal = buildAlignmentReviewProposal({ runId: bindings.runId, bindings, alignment: report });
  assert.equal(proposal.proposedExceptions.length, 18);
  assert.equal(proposal.proposedExceptions.filter(item => item.classification === 'ASR_CURRENCY_UNIT_OMISSION').length, 12);
  assert.equal(proposal.proposedExceptions.filter(item => item.classification === 'ASR_PHONETIC_VARIANT').length, 6);
  const humanApproval = { approvedBy: 'CTO', approvalRef: 'review-123', approvedAt: '2026-09-25T00:00:00Z', sourceProposalSha256: 'b'.repeat(64) };
  const approval17 = { ...proposal, schemaVersion: 'phase2.3b-p-alignment-review-approval/1.0.0', status: 'USER_APPROVED', approvedExceptions: proposal.proposedExceptions.slice(0, 17), humanApproval };
  const stale = applyAlignmentReviewApproval({ alignment: report, approvalArtifact: approval17, expectedBindings: bindings });
  assert.equal(stale.status, 'FAIL');
  assert.equal(stale.acts[0].unapprovedExceptions.length, 1);
  const approval18 = { ...approval17, approvedExceptions: proposal.proposedExceptions };
  const complete = applyAlignmentReviewApproval({ alignment: report, approvalArtifact: approval18, expectedBindings: bindings });
  assert.equal(complete.status, 'PASS');
  assert.deepEqual(complete.acts.map(act => act.uncoveredScriptTokenIndices), [[]]);
  const altered = structuredClone(report);
  altered.acts[0].substitutions[0].scriptContext.text += ' altered';
  const alteredReview = applyAlignmentReviewApproval({ alignment: altered, approvalArtifact: approval18, expectedBindings: bindings });
  assert.equal(alteredReview.status, 'FAIL');
  assert.equal(alteredReview.acts[0].unapprovedExceptions.length, 1);
});

test('alignment rejects a real missing narration word and reports exact context and deletion', () => {
  const result = alignment('The bank opened unauthorized customer accounts.', 'The bank opened customer accounts.');
  assert.equal(result.status, 'FAIL');
  assert.equal(result.scriptTokenCount, 6);
  assert.equal(result.transcriptTokenCount, 5);
  assert.deepEqual(result.scriptDeletions.map(item => item.scriptToken), ['unauthorized']);
  assert.match(result.scriptDeletions[0].scriptContext.text, /bank opened unauthorized customer accounts/u);
  assert.equal(result.alignmentCoverage, 83.333);
});

test('alignment reports transcript-only inserted words with local transcript context', () => {
  const result = alignment('The bank opened accounts.', 'The bank secretly opened accounts.');
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.transcriptInsertions.map(item => item.transcriptToken), ['secretly']);
  assert.match(result.transcriptInsertions[0].transcriptContext.text, /bank secretly opened/u);
});

test('alignment rejects a substituted claim and records both exact local contexts', () => {
  const result = alignment('The order totaled $185 million.', 'The settlement totaled $185 million.');
  assert.equal(result.status, 'FAIL');
  assert.equal(result.substitutions.length, 1);
  assert.equal(result.substitutions[0].scriptToken, 'order');
  assert.equal(result.substitutions[0].transcriptToken, 'settlement');
  assert.match(result.substitutions[0].scriptContext.text, /The order totaled/u);
  assert.match(result.substitutions[0].transcriptContext.text, /The settlement totaled/u);
});

test('alignment report deterministically covers every act and exposes counts and mismatch classes', () => {
  const actKeys = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  const bindings = Object.fromEntries(actKeys.map(key => [key, `VO_${key}`]));
  const script = { acts: Object.fromEntries(actKeys.map(key => [key, { voScript: `The approved ${key} narration.` }])) };
  const words = actKeys.flatMap(key => timedWords(`VO_${key}`, `The approved ${key} narration.`));
  words[0].word = 'A';
  const report = analyzeScriptTimestampAlignment(script, words, bindings);
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.actOrder, actKeys);
  assert.deepEqual(report.acts.map(item => item.actKey), actKeys);
  assert.deepEqual(report.acts.map(item => [item.scriptTokenCount, item.transcriptTokenCount]), actKeys.map(() => [4, 4]));
  assert.equal(report.acts[0].substitutions.length, 1);
  assert.equal(report.acts[0].alignmentCoverage, 75);
  for (const act of report.acts) {
    assert.ok(Array.isArray(act.matchedTokens));
    assert.ok(Array.isArray(act.normalizedEquivalents));
    assert.ok(Array.isArray(act.substitutions));
    assert.ok(Array.isArray(act.transcriptInsertions));
    assert.ok(Array.isArray(act.scriptDeletions));
  }
});

test('completed transcript reuse verifies source receipt and immutable audio without a provider call', () => {
  const bindings = Object.fromEntries(['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'].map(key => [key, `VO_${key}`]));
  const words = Object.entries(bindings).flatMap(([actKey, voKey]) => timedWords(voKey, `approved ${actKey}`));
  const expectedAudio = Object.entries(bindings).map(([actKey]) => ({ file: `${actKey}.mp3`, bytes: 4, sha256: sha256(Buffer.from(actKey)) }));
  const receipt = { schemaVersion: 'phase2.3b-p-timing-source/1.0.0', runId: 'phase2-3b-p-act-20260925', state: 'TRANSCRIPTION_IN_PROGRESS', audio: expectedAudio };
  let providerCalls = 0;
  const verified = verifyCompletedTimingArtifacts({ timestamps: words, receipt, runId: receipt.runId, expectedAudio, partial: null, actBindings: bindings });
  assert.equal(verified.status, 'VERIFIED');
  assert.equal(verified.wordCount, 12);
  assert.equal(providerCalls, 0, 'verified reuse does not invoke a provider');
  assert.throws(() => verifyCompletedTimingArtifacts({ timestamps: words, receipt: { ...receipt, runId: 'other-run' }, runId: receipt.runId, expectedAudio, partial: null, actBindings: bindings }), /TIMING_SOURCE_RECEIPT_MISMATCH/u);
  assert.throws(() => verifyCompletedTimingArtifacts({ timestamps: words, receipt: { ...receipt, audio: expectedAudio.map((item, index) => index ? item : { ...item, sha256: 'wrong' }) }, runId: receipt.runId, expectedAudio, partial: null, actBindings: bindings }), /TIMING_SOURCE_RECEIPT_MISMATCH/u);
});

test('completed transcript reuse refuses altered transcript hashes and partial checkpoints', () => {
  const bindings = { act1: 'VO_Act1' };
  const words = timedWords('VO_Act1', 'one two');
  const expectedAudio = [{ file: 'VO_Act1.mp3', bytes: 3, sha256: 'audio-hash' }];
  const receipt = { schemaVersion: 'phase2.3b-p-timing-source/1.0.0', runId: 'resume-123', state: 'TRANSCRIPTION_IN_PROGRESS', audio: expectedAudio, wordTimestampsSha256: 'wrong-transcript-hash' };
  assert.throws(() => verifyCompletedTimingArtifacts({ timestamps: words, receipt, runId: 'resume-123', expectedAudio, partial: null, actBindings: bindings }), /TIMING_SOURCE_TRANSCRIPT_HASH_MISMATCH/u);
  delete receipt.wordTimestampsSha256;
  assert.throws(() => verifyCompletedTimingArtifacts({ timestamps: words, receipt, runId: 'resume-123', expectedAudio, partial: { VO_Act1: [words[0]] }, actBindings: bindings }), /TIMING_PARTIAL_MISMATCH:act1/u);
});

test('resume-only transcript selection reuses completed data and forbids Whisper fallback', async () => {
  const cached = [{ vo_file: 'VO_Act1', word: 'approved', start_seconds: 0, end_seconds: 0.4 }];
  let providerCalls = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-resume-ledger-'));
  try {
    const ledger = path.join(root, 'request-ledger.jsonl'), originalLedger = Buffer.from('{"actKey":"act1","attempt":1}\n');
    fs.writeFileSync(ledger, originalLedger);
    const reused = await chooseTimingTranscript({ resumeOnly: true, readExisting: async () => cached, transcribe: async () => { providerCalls++; return []; } });
    assert.deepEqual(reused, cached);
    assert.deepEqual(fs.readFileSync(ledger), originalLedger, 'resume reuse leaves request history byte-for-byte unchanged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  assert.equal(providerCalls, 0);
  await assert.rejects(chooseTimingTranscript({ resumeOnly: true, readExisting: async () => null, transcribe: async () => { providerCalls++; return []; } }), /COMPLETED_TRANSCRIPT_MISSING/u);
  assert.equal(providerCalls, 0);
});

test('alignment resume accepts only exact approved deterministic alignment failures after all transcripts completed', () => {
  const runId = 'phase2-3b-p-act-20260925';
  const completedActs = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  const status = { runId, state: 'FAILURE', currentStage: 'FAILED', completedAt: '2026-09-25T16:23:14.453Z', error: 'ACTIVATION_WORD_ALIGNMENT_MISMATCH:act2', completedActs, pid: 26 };
  const fakeFs = { existsSync: () => true, readFileSync: () => Buffer.from(JSON.stringify(status)) };
  assert.deepEqual(activationCli.verifyResumableAlignmentFailure({ fs: fakeFs, runId }), status);
  const eligibility = { terminalFailure: true, locksAbsent: true, candidateAbsent: true, immutableInputsVerified: true };
  assert.equal(activationCli.assertFailedRunProcessInactive({ ...status, pid: 987654321 }, { isProcessAlive: () => false }), true);
  assert.throws(() => activationCli.assertFailedRunProcessInactive({ ...status, pid: 1234 }, { isProcessAlive: () => true, currentPid: 26 }), /RESUME_RUN_PROCESS_ACTIVE/u);

  // Legacy status has no process-start identity. Same PID is accepted only
  // after both diagnosis and resume have completed their strict eligibility gates.
  assert.equal(activationCli.assertFailedRunProcessInactive(status, { isProcessAlive: () => true, currentPid: status.pid, eligibility }), true);
  assert.throws(() => activationCli.assertFailedRunProcessInactive({ ...status, completedAt: null }, { isProcessAlive: () => true, currentPid: status.pid, eligibility }), /RESUME_RUN_ELIGIBILITY_UNVERIFIED/u);
  for (const failedGate of ['locksAbsent', 'candidateAbsent', 'immutableInputsVerified']) {
    assert.throws(() => activationCli.assertFailedRunProcessInactive(status, {
      isProcessAlive: () => true, currentPid: status.pid,
      eligibility: { ...eligibility, [failedGate]: false },
    }), /RESUME_RUN_ELIGIBILITY_UNVERIFIED/u, `${failedGate} must block PID-reuse acceptance`);
  }
  for (const lockPath of [
    path.join(activationCli.ROOT, '.review', `phase2.3b-p-activation-${runId}`, 'activation.lock'),
    path.join(activationCli.ROOT, '.review', 'phase2.3b-p-activation-active.lock'),
  ]) {
    assert.throws(() => {
      activationCli.assertNoActivationLocks({ fs: { existsSync: file => file === lockPath }, runId });
      activationCli.assertFailedRunProcessInactive(status, { isProcessAlive: () => true, currentPid: status.pid, eligibility });
    }, /ACTIVATION_(?:RUN|GLOBAL_RUN)_ALREADY_LOCKED/u, `active lock ${path.basename(lockPath)} must block PID-reuse acceptance`);
  }

  const processIdentityStatus = { ...status, processStartIdentity: '12345' };
  assert.throws(() => activationCli.assertFailedRunProcessInactive(processIdentityStatus, {
    isProcessAlive: () => true, currentPid: status.pid,
    getProcessStartIdentity: () => '12345', eligibility,
  }), /RESUME_RUN_PROCESS_ACTIVE/u, 'matching process-start identity proves the prior process is still alive');
  assert.equal(activationCli.assertFailedRunProcessInactive(processIdentityStatus, {
    isProcessAlive: () => true, currentPid: status.pid,
    getProcessStartIdentity: () => '67890', eligibility,
  }), true, 'different process-start identity proves PID reuse');
  assert.throws(() => activationCli.assertFailedRunProcessInactive({ ...status, pid: '26' }, { isProcessAlive: () => false }), /RESUME_RUN_PID_INVALID/u);
  assert.throws(() => activationCli.assertFailedRunProcessInactive({ ...processIdentityStatus, processStartIdentity: 'bad' }, {
    isProcessAlive: () => true, currentPid: status.pid,
  }), /RESUME_RUN_PROCESS_IDENTITY_INVALID/u);
  assert.throws(() => activationCli.verifyResumableAlignmentFailure({ fs: { ...fakeFs, readFileSync: () => Buffer.from(JSON.stringify({ ...status, completedAt: 'not-a-date' })) }, runId }), /RESUME_RUN_STATE_MISMATCH/u);

  // Diagnosis and resume use the same process-identity decision helper; its
  // pure checks perform no provider, candidate, or episode-root writes.
  let providerCalls = 0, candidateWrites = 0, rootWrites = 0;
  const sharedOptions = { isProcessAlive: () => true, currentPid: status.pid, eligibility };
  const diagnosisDecision = activationCli.assertFailedRunProcessInactive(status, sharedOptions);
  const resumeDecision = activationCli.assertFailedRunProcessInactive(status, sharedOptions);
  assert.equal(diagnosisDecision, resumeDecision);
  assert.deepEqual([providerCalls, candidateWrites, rootWrites], [0, 0, 0]);

  const liveBoundaryFailure = { ...status, error: 'ACTIVATION_BOUNDARY_MAPPING_MISSING:act1:11' };
  assert.deepEqual(activationCli.verifyResumableAlignmentFailure({ fs: { ...fakeFs, readFileSync: () => Buffer.from(JSON.stringify(liveBoundaryFailure)) }, runId }), liveBoundaryFailure);
  const liveAct2OpeningBoundaryFailure = { ...status, error: 'ACTIVATION_BOUNDARY_MAPPING_MISSING:act2:0' };
  assert.deepEqual(activationCli.verifyResumableAlignmentFailure({ fs: { ...fakeFs, readFileSync: () => Buffer.from(JSON.stringify(liveAct2OpeningBoundaryFailure)) }, runId }), liveAct2OpeningBoundaryFailure);
  for (const change of [
    { error: 'ACTIVATION_WORD_ALIGNMENT_MISMATCH:act3' },
    { error: 'ACTIVATION_BOUNDARY_MAPPING_MISSING:act1:12' },
    { state: 'SUCCESS' },
    { completedActs: completedActs.slice(0, -1) },
    { runId: 'other-run' },
  ]) {
    assert.throws(() => activationCli.verifyResumableAlignmentFailure({ fs: { ...fakeFs, readFileSync: () => Buffer.from(JSON.stringify({ ...status, ...change })) }, runId }), /RESUME_RUN_STATE_MISMATCH/u);
  }
  assert.throws(() => activationCli.assertNoActivationLocks({ fs: { existsSync: () => true }, runId }), /ACTIVATION_RUN_ALREADY_LOCKED/u);
  assert.equal(activationCli.assertOwnedActivationLocks({ fs: { existsSync: () => true, readFileSync: () => Buffer.from(JSON.stringify({ runId, pid: process.pid })) }, runId }), true);
  assert.throws(() => activationCli.assertOwnedActivationLocks({ fs: { existsSync: () => true, readFileSync: () => Buffer.from(JSON.stringify({ runId, pid: process.pid + 1 })) }, runId }), /ACTIVATION_RUN_ALREADY_LOCKED/u);
});

test('resume immutable-input guard refuses altered proposal, approval, transcript, ledger, audio and locked hashes', () => {
  const assertChanged = (name, expected, actual) => assert.throws(
    () => activationCli.assertResumeImmutableBinding(name, expected, actual),
    new RegExp(`RESUME_IMMUTABLE_INPUT_CHANGED:${name}`, 'u'),
  );
  for (const name of ['alignment-proposal', 'alignment-approval', 'transcript', 'request-ledger', 'audio-hash', 'locked-episode']) {
    assertChanged(name, 'a'.repeat(64), 'b'.repeat(64));
  }
  assert.equal(activationCli.assertResumeImmutableBinding('request-ledger', 'same-ledger-hash', 'same-ledger-hash'), true);
});

test('approved and copied audio bytes must both match the immutable hashes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-resume-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const approved = path.join(root, 'approved'), timing = path.join(root, 'timing');
  fs.mkdirSync(approved); fs.mkdirSync(timing);
  const file = 'VO_Act1.mp3', bytes = Buffer.from('immutable approved audio');
  fs.writeFileSync(path.join(approved, file), bytes); fs.writeFileSync(path.join(timing, file), bytes);
  const contracts = [{ file, bytes: bytes.length, sha256: sha256(bytes) }];
  const options = { fs, runId: 'resume-run-001', timingAudioDir: timing, contracts, approvedRunId: 'approved-run', approvedPathFor: (_runId, name) => path.join(approved, name) };
  assert.deepEqual(activationCli.expectedTimingAudioManifest(options), contracts.map(item => ({ ...item })));
  fs.writeFileSync(path.join(timing, file), 'altered audio');
  assert.throws(() => activationCli.expectedTimingAudioManifest(options), /TIMING_SOURCE_COPY_MISMATCH:VO_Act1.mp3/u);
  fs.writeFileSync(path.join(timing, file), bytes); fs.writeFileSync(path.join(approved, file), 'altered authoritative audio');
  assert.throws(() => activationCli.expectedTimingAudioManifest(options), /APPROVED_AUDIO_HASH_MISMATCH:VO_Act1.mp3/u);
});

test('disk transcript resume verification binds all six approved audio files, receipt and partial checkpoint', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-resume-transcript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const review = path.join(root, 'review'), timing = path.join(review, 'fresh-whisper');
  const source = path.join(root, 'approved-audio'), copied = path.join(timing, 'audio');
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(copied, { recursive: true });
  const acts = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  const bindings = Object.fromEntries(acts.map(key => [key, `VO_${key}`]));
  const contracts = acts.map(key => {
    const file = `${key}.mp3`, bytes = Buffer.from(`audio:${key}`), digest = sha256(bytes);
    fs.writeFileSync(path.join(source, file), bytes); fs.writeFileSync(path.join(copied, file), bytes);
    return { actKey: key, file, bytes: bytes.length, sha256: digest };
  });
  const words = Object.entries(bindings).flatMap(([key, voKey]) => timedWords(voKey, `approved ${key}`));
  const partial = Object.fromEntries(Object.entries(bindings).map(([key, voKey]) => [voKey, words.filter(item => item.vo_file === voKey)]));
  fs.writeFileSync(path.join(timing, 'word-timestamps.json'), JSON.stringify(words, null, 2));
  fs.writeFileSync(path.join(timing, 'word-timestamps.partial.json'), JSON.stringify(partial, null, 2));
  const runId = 'phase2-3b-p-act-20260925';
  fs.writeFileSync(path.join(timing, 'timing-source-receipt.json'), JSON.stringify({ schemaVersion: 'phase2.3b-p-timing-source/1.0.0', runId, state: 'TRANSCRIPTION_IN_PROGRESS', audio: contracts.map(({ actKey, ...item }) => item) }));
  const options = { fs, runId, reviewDirectory: review, actBindings: bindings, contracts, approvedRunId: 'approved', approvedPathFor: (_id, file) => path.join(source, file) };
  const verified = activationCli.readAndVerifyCompletedTranscript(options);
  assert.equal(verified.verification.status, 'VERIFIED');
  assert.deepEqual(verified.verification.acts, Object.fromEntries(acts.map(key => [key, 2])));
  const changedTranscript = structuredClone(words); changedTranscript[0].word = 'altered';
  fs.writeFileSync(path.join(timing, 'word-timestamps.json'), JSON.stringify(changedTranscript, null, 2));
  assert.throws(() => activationCli.readAndVerifyCompletedTranscript(options), /TIMING_PARTIAL_MISMATCH:act1/u);
  fs.writeFileSync(path.join(timing, 'word-timestamps.json'), JSON.stringify(words, null, 2));
  fs.writeFileSync(path.join(copied, 'act4.mp3'), 'changed audio bytes');
  assert.throws(() => activationCli.readAndVerifyCompletedTranscript(options), /TIMING_SOURCE_COPY_MISMATCH:act4.mp3/u);
});

test('candidate replacement requires exact complete file set and verified bytes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-activation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = TARGET_FILES.map(relative => {
    const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(`candidate:${relative}`); fs.writeFileSync(file, bytes);
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  assert.equal(verifyReplacementSet(directory, manifest), true);
  assert.throws(() => verifyReplacementSet(directory, manifest.slice(1)), /ACTIVATION_REPLACEMENT_SET_INVALID/);
  fs.appendFileSync(path.join(directory, TARGET_FILES[0]), 'tamper');
  assert.throws(() => verifyReplacementSet(directory, manifest), /ACTIVATION_CANDIDATE_HASH_MISMATCH/);
});

test('backup records and preserves bytes of every existing replacement target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-activation-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const episode = path.join(root, 'episode'), backup = path.join(root, 'backup');
  for (const relative of TARGET_FILES) { const file = path.join(episode, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(`original:${relative}`)); }
  const manifest = makeBackup({ episodeDirectory: episode, backupDirectory: backup });
  assert.equal(manifest.files.length, TARGET_FILES.length);
  for (const item of manifest.files) {
    const bytes = fs.readFileSync(path.join(backup, item.path));
    assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
    assert.deepEqual(bytes, fs.readFileSync(path.join(episode, item.path)));
  }
});

test('durable Whisper reservations enforce the global and per-act retry ceilings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-whisper-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, 'request-ledger.jsonl');
  assert.equal(reserveWhisperAttempt({ ledgerPath, actKey: 'act1', attempt: 1 }).requestOrdinal, 1);
  reserveWhisperAttempt({ ledgerPath, actKey: 'act1', attempt: 2 });
  reserveWhisperAttempt({ ledgerPath, actKey: 'act1', attempt: 3 });
  assert.throws(() => reserveWhisperAttempt({ ledgerPath, actKey: 'act1', attempt: 4 }), /ACTIVATION_WHISPER_BUDGET_EXHAUSTED/);
  for (const actKey of ['act2', 'act3', 'act3b', 'act4', 'act5']) for (let attempt = 1; attempt <= 3; attempt++) reserveWhisperAttempt({ ledgerPath, actKey, attempt });
  assert.equal(fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/u).length, 18);
  assert.throws(() => reserveWhisperAttempt({ ledgerPath, actKey: 'act6', attempt: 1 }), /ACTIVATION_WHISPER_BUDGET_EXHAUSTED/);
});

test('verified backup restores replaced bytes and removes paths that did not previously exist', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const episode = path.join(root, 'episode'), backup = path.join(root, 'backup');
  fs.mkdirSync(episode, { recursive: true }); fs.writeFileSync(path.join(episode, 'locked.json'), 'before');
  const manifest = makeBackup({ episodeDirectory: episode, backupDirectory: backup, targets: ['locked.json', 'new.json'] });
  fs.writeFileSync(path.join(episode, 'locked.json'), 'promoted'); fs.writeFileSync(path.join(episode, 'new.json'), 'new');
  assert.equal(verifyBackup({ backupDirectory: backup, manifest }), true);
  assert.equal(restoreBackup({ episodeDirectory: episode, backupDirectory: backup, manifest }), true);
  assert.equal(fs.readFileSync(path.join(episode, 'locked.json'), 'utf8'), 'before');
  assert.equal(fs.existsSync(path.join(episode, 'new.json')), false);
  fs.writeFileSync(path.join(backup, 'locked.json'), 'tampered');
  assert.throws(() => verifyBackup({ backupDirectory: backup, manifest }), /ACTIVATION_BACKUP_HASH_MISMATCH/);
});

test('reviewed alignment approval alone cannot authorize a deleted source boundary', () => {
  const value = makeRetimingFixture({
    sourceTexts: { act2: 'The bank and customers were convinced.' },
    transcriptTexts: { act2: 'The bank customers were convinced.' },
    beatRanges: { act2: [[0, 2], [3, 5]] },
  });
  const reviewedAlignment = reviewedFor(value.script, value.words, value.bindings, true);
  assert.equal(reviewedAlignment.status, 'PASS');
  assert.throws(() => retimeEditPlan({ ...value, actOrder: value.actKeys, actBindings: value.bindings, actDurationsSec: Object.fromEntries(value.actKeys.map(key => [key, 10])), reviewedAlignment }), /ACTIVATION_BOUNDARY_AUTHORIZATION_REQUIRED:act2:2/u);
});

test('Act 4 normalized money-span edge remains shared and Act 5 decimal-currency span maps around its whole unit', () => {
  const act4 = retimeFixture({
    sourceTexts: { act4: 'The board clawed back roughly 69 million dollars from the executive.' },
    transcriptTexts: { act4: 'The board clawed back roughly 69 million from the executive.' },
    beatRanges: { act4: [[0, 6], [7, 10]] },
  });
  const beats4 = act4.result.plan.sequences.find(sequence => sequence.actKey === 'act4').beats;
  assert.equal(beats4[0].endWordIndex + 1, beats4[1].startWordIndex);
  assert.equal(beats4[0].narrationExcerpt, 'The board clawed back roughly 69 million');

  const act5 = retimeFixture({
    sourceTexts: { act5: 'She received 17.5 million dollars from the bank.' },
    transcriptTexts: { act5: 'She received 17 5 million from the bank.' },
    beatRanges: { act5: [[0, 3], [4, 7]] },
  });
  const beats5 = act5.result.plan.sequences.find(sequence => sequence.actKey === 'act5').beats;
  assert.equal(beats5[0].endWordIndex + 1, beats5[1].startWordIndex);
  assert.equal(beats5[0].narrationExcerpt, 'She received 17 5 million');
  assert.match(beats5[1].narrationExcerpt, /^from/u);
});

function approvedRevisionFixture({ act2Authorization = false } = {}) {
  const fs = require('node:fs');
  const policyBytes = Buffer.from(fs.readFileSync(require('node:path').join(__dirname, '../pipeline-updates/phase2.3b-p-approved-boundary-ranges.json'), 'utf8').replace(/\r\n/gu, '\n'));
  const policy = JSON.parse(policyBytes);
  const act2Source = Array.from({ length: 110 }, (_, i) => `a2word${i}`);
  if (act2Authorization) act2Source.splice(85, 10, 'had', 'a', 'checking', 'account', 'and', 'convinced', 'them', 'to', 'open', 'a');
  const act2Candidate = act2Authorization ? act2Source.filter((_, index) => index !== 89) : act2Source;
  if (act2Authorization) act2Candidate[89] = 'convince';
  const actTexts = Object.fromEntries(['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'].map(key => [key, key === 'act2' ? act2Candidate : key === 'act3b' ? Array(153).fill(0).map((_, i) => `c${i}`) : key === 'act4' ? Array(232).fill(0).map((_, i) => `d${i}`) : ['Ordinary', `${key}.`]]));
  for (const item of policy.allocations) {
    const tokens = actTexts[item.actKey], replacement = item.excerpt.split(/\s+/u);
    tokens.splice(item.startTokenIndex, item.endTokenIndex - item.startTokenIndex + 1, ...replacement);
  }
  const script = { acts: Object.fromEntries(Object.entries(actTexts).map(([key, tokens]) => [key, { voScript: tokens.join(' ') }])) };
  const bindings = Object.fromEntries(Object.keys(actTexts).map(key => [key, `VO_${key}`]));
  const sourceWords = {};
  const priorRanges = {
    act3b: [[0,3],[4,8],[9,16],[17,25],[26,35],[36,47],[48,58],[59,69],[70,76],[77,83],[84,89],[90,101],[102,107],[108,119],[120,124],[125,133],[134,143],[144,157]],
    act4: [[0,8],[9,21],[22,30],[31,39],[40,48],[49,60],[61,66],[67,71],[72,81],[82,92],[93,101],[102,111],[112,120],[121,131],[132,140],[141,149],[150,159],[160,171],[172,180],[181,189],[190,197],[198,207],[208,217],[218,231]],
  };
  const words = [], sequences = [], timingActs = [];
  for (const [actKey, tokens] of Object.entries(actTexts)) {
    const voKey = bindings[actKey];
    let oldWords = act2Authorization && actKey === 'act2' ? act2Source : tokens;
    let ranges = [[0, tokens.length - 1]];
    if (act2Authorization && actKey === 'act2') {
      ranges = [[0,88],[89,96],[97,107],[108,109]];
    } else if (actKey === 'act3b') {
      oldWords = Array.from({ length: 158 }, (_, i) => `legacy${i}`);
      for (let i = 0; i < 58; i++) oldWords[i] = tokens[i];
      for (let i = 102; i < 107; i++) oldWords[i] = tokens[i - 4];
      for (let i = 107; i < 158; i++) oldWords[i] = tokens[i - 5];
      ranges = priorRanges.act3b;
    } else if (actKey === 'act4') {
      oldWords = Array.from({ length: 232 }, (_, i) => `legacy${i}`);
      for (let i = 22; i < 231; i++) oldWords[i] = tokens[i - 3];
      oldWords[231] = tokens[231];
      ranges = priorRanges.act4;
    }
    sourceWords[actKey] = oldWords;
    const local = tokens.map((word, i) => ({ vo_file: voKey, word, start_seconds: i * 0.1, end_seconds: i * 0.1 + 0.05 }));
    words.push(...local);
    timingActs.push({ actKey, voKey, wordCount: oldWords.length, startSec: 0, endSec: 100, durationSec: 100 });
    sequences.push({ sequenceId: `sequence-${actKey}`, actKey, beats: ranges.map(([startWordIndex, endWordIndex], index) => ({
      beatId: act2Authorization && actKey === 'act2' ? ['ACT2_B001', 'ACT2_B011', 'ACT2_B012', 'ACT2_B013'][index] : actKey === 'act3b' ? `ACT3B_B${String(index + 1).padStart(3, '0')}` : actKey === 'act4' ? `ACT4_B${String(index + 1).padStart(3, '0')}` : `beat-${actKey}`,
      sequenceId: `sequence-${actKey}`, actKey, startWordIndex, endWordIndex,
      startSec: 0, endSec: 100, durationSec: 100, narrationExcerpt: oldWords.slice(startWordIndex, endWordIndex + 1).join(' '),
      visual: { type: 'STOCK', description: 'frozen' },
    })) });
  }
  const plan = { schemaVersion: '3.0.0', episodeId: 'episode-revision', title: 'Locked', timing: { basis: 'previous', totalDurationSec: 600, acts: timingActs }, sequences };
  const durations = Object.fromEntries(Object.keys(actTexts).map(key => [key, Math.max(100, words.filter(item => item.vo_file === bindings[key]).at(-1).end_seconds + 1)]));
  const reviewedAlignment = reviewedFor(script, words, bindings);
  const approvedBoundaryPolicy = verifyApprovedBoundaryPolicy({ policy, policyBytes, script, scriptSha256: policy.scriptSha256, amendmentSha256: policy.revisionLineage.amendmentSha256 });
  const authorization = policy.boundaryAuthorizations[0];
  const boundaryInputHashes = Object.fromEntries(Object.entries(authorization.inputHashes).filter(([key]) => key !== 'previousApprovedBoundaryPolicySha256'));
  return { plan, script, words, bindings, actOrder: Object.keys(actTexts), durations, reviewedAlignment, approvedBoundaryPolicy, boundaryInputHashes, policy, policyBytes };
}

function authorizedAct2Input() {
  const value = approvedRevisionFixture({ act2Authorization: true });
  return {
    value,
    input: { plan: value.plan, wordTimestamps: value.words, actOrder: value.actOrder, actBindings: value.bindings,
      actDurationsSec: value.durations, script: value.script, reviewedAlignment: value.reviewedAlignment,
      approvedBoundaryPolicy: value.approvedBoundaryPolicy, boundaryInputHashes: value.boundaryInputHashes },
  };
}

function approvedTimingExceptionFixture() {
  const root = path.join(__dirname, '../artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate');
  const policyPath = path.join(__dirname, '../pipeline-updates/phase2.3b-p-approved-timing-exceptions.json');
  const bytes = Buffer.from(fs.readFileSync(policyPath, 'utf8').replace(/\r\n/gu, '\n'));
  const policy = JSON.parse(bytes.toString('utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'candidate-edit-plan-pretiming.json'), 'utf8'));
  const script = JSON.parse(fs.readFileSync(path.join(root, 'candidate-script.json'), 'utf8'));
  const shots = JSON.parse(fs.readFileSync(path.join(root, 'candidate-shot-definitions-pretiming.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'candidate-production-manifest-pretiming.json'), 'utf8'));
  const boundaryFile = path.join(__dirname, '../pipeline-updates/phase2.3b-p-approved-boundary-ranges.json');
  const boundaryBytes = Buffer.from(fs.readFileSync(boundaryFile, 'utf8').replace(/\r\n/gu, '\n'));
  const boundary = JSON.parse(boundaryBytes.toString('utf8'));
  const amendment = fs.readFileSync(path.join(root, 'revision-ledger.phase2.3b-sv-amendment.v1.json'));
  const approvedBoundaryPolicy = verifyApprovedBoundaryPolicy({ policy: boundary, policyBytes: boundaryBytes, script, scriptSha256: sha256(fs.readFileSync(path.join(root, 'candidate-script.json'))), amendmentSha256: sha256(amendment) });
  const binding = policy.binding;
  const boundaryInputHashes = {
    lockedEditPlanSha256: binding.lockedEditPlanSha256,
    candidatePreTimingEditPlanSha256: binding.candidatePreTimingEditPlanSha256,
    candidateScriptSha256: binding.candidateScriptSha256,
    retainedTranscriptSha256: binding.retainedTranscriptSha256,
    alignmentProposalSha256: binding.alignmentProposalSha256,
    alignmentApprovalSha256: binding.alignmentApprovalSha256,
    candidateAmendmentSha256: binding.candidateAmendmentSha256,
  };
  const approvedTimingExceptions = activationCli.loadApprovedTimingExceptions({
    runId: binding.runId, policyFile: policyPath, approvedBoundaryPolicy, boundaryInputHashes, packageDirectory: root,
  });
  return { root, policy, bytes, plan, script, shots, manifest, approvedBoundaryPolicy, boundaryInputHashes, approvedTimingExceptions };
}

function syntheticApprovedTimingExceptionInput(approvedTimingExceptions, sourcePlan, { unapprovedDuration = null, unapprovedAct = 'act1' } = {}) {
  const actOrder = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  const actBindings = Object.fromEntries(actOrder.map(key => [key, `VO_${key === 'act3b' ? 'Act3B' : `${key[0].toUpperCase()}${key.slice(1)}`}`]));
  const groups = new Map(actOrder.map(key => [key, approvedTimingExceptions.exceptions.filter(item => item.actKey === key).sort((a, b) => a.mappedTranscriptWordRange.start - b.mappedTranscriptWordRange.start)]));
  const script = { ...structuredClone(sourcePlan.script), acts: {} };
  const plan = structuredClone(sourcePlan.plan);
  const wordTimestamps = [], actDurationsSec = {};
  const sequences = [];
  const splitSpoken = value => value.replace(/\$(?=\d)/gu, '').replace(/(?<=\d)[,.](?=\d)/gu, ' ').replace(/(?<=[\p{L}])-(?=[\p{L}])/gu, ' ').trim().split(/\s+/u);

  for (const actKey of actOrder) {
    const exceptions = groups.get(actKey);
    const intervals = [];
    let cursor = 0;
    for (const exception of exceptions) {
      const { start, end } = exception.mappedTranscriptWordRange;
      if (start > cursor) intervals.push({ start: cursor, end: start - 1, exception: null });
      intervals.push({ start, end, exception });
      cursor = end + 1;
    }
    if (!intervals.length) intervals.push({ start: 0, end: 3, exception: null });
    const tokenCount = intervals.at(-1).end + 1;
    const words = Array.from({ length: tokenCount }, (_, index) => `fixture_${actKey}_${String(index).padStart(3, '0')}`);
    const beats = [];
    const originalSequence = plan.sequences.find(sequence => sequence.actKey === actKey);
    const sequence = structuredClone(originalSequence);
    sequence.beats = [];
    const specialSourceBeats = new Map(sourcePlan.plan.sequences.flatMap(item => item.beats).map(beat => [`${beat.actKey}:${beat.beatId}`, beat]));
    let cursorSec = 0;
    for (let index = 0; index < intervals.length; index++) {
      const interval = intervals[index];
      const exception = interval.exception;
      const beatId = exception?.beatId || `FIXTURE_${actKey}_B${String(index + 1).padStart(3, '0')}`;
      const sourceBeat = exception ? specialSourceBeats.get(`${actKey}:${beatId}`) : sourcePlan.plan.sequences.find(item => item.actKey === actKey)?.beats[0];
      const beat = structuredClone(sourceBeat);
      beat.beatId = beatId;
      beat.actKey = actKey;
      beat.sequenceId = sequence.sequenceId;
      beat.startWordIndex = interval.start;
      beat.endWordIndex = interval.end;
      const narrationWords = exception ? splitSpoken(exception.approvedNarrationExcerpt) : words.slice(interval.start, interval.end + 1);
      assert.equal(narrationWords.length, interval.end - interval.start + 1, `${actKey}:${beatId} fixture range size`);
      narrationWords.forEach((word, offset) => { words[interval.start + offset] = word; });
      beat.narrationExcerpt = narrationWords.join(' ');
      beat.startSec = cursorSec;
      beat.durationSec = exception?.approvedDurationSec || (unapprovedDuration !== null && actKey === unapprovedAct && !beats.some(item => item.beatId.startsWith(`FIXTURE_${actKey}_`)) ? unapprovedDuration : 4);
      beat.endSec = cursorSec + beat.durationSec;
      beat.timingExceptionReason = null;
      const intervalDuration = beat.durationSec / narrationWords.length;
      narrationWords.forEach((_, offset) => {
        const start = cursorSec + offset * intervalDuration;
        wordTimestamps.push({ vo_file: actBindings[actKey], word: words[interval.start + offset], start_seconds: start, end_seconds: start + Math.min(0.05, intervalDuration / 2) });
      });
      cursorSec += beat.durationSec;
      beats.push(beat);
    }
    sequence.beats = beats;
    sequences.push(sequence);
    script.acts[actKey] = { voScript: words.join(' ') };
    actDurationsSec[actKey] = cursorSec;
  }
  plan.sequences = sequences;
  plan.timing = {
    basis: 'finished_vo_word_timestamps', totalDurationSec: Object.values(actDurationsSec).reduce((sum, value) => sum + value, 0),
    acts: actOrder.map(actKey => ({ actKey, voKey: actBindings[actKey], wordCount: wordTimestamps.filter(item => item.vo_file === actBindings[actKey]).length, startSec: 0, endSec: actDurationsSec[actKey], durationSec: actDurationsSec[actKey] })),
  };
  const reviewedAlignment = reviewedFor(script, wordTimestamps, actBindings, true);
  const input = { plan, wordTimestamps, actOrder, actBindings, actDurationsSec, script, reviewedAlignment, approvedTimingExceptions };
  return { input, wordTimestamps, actDurationsSec, reviewedAlignment };
}

test('policy authorization maps ACT2_B011 start 89 to transcript 89 through the shared six-act audit and retimer', () => {
  const { value, input } = authorizedAct2Input();
  const sourceAct2 = input.plan.sequences.find(sequence => sequence.actKey === 'act2').beats;
  assert.deepEqual(sourceAct2.slice(1, 3).map(beat => [beat.beatId, beat.startWordIndex, beat.endWordIndex]), [['ACT2_B011', 89, 96], ['ACT2_B012', 97, 107]]);
  const audit = auditEditPlanBoundaries(input);
  assert.equal(audit.status, 'BOUNDARY_AUDIT_PASS', JSON.stringify(audit.errors));
  assert.deepEqual(audit.acts.map(act => act.actKey), value.actOrder);
  const act2Audit = audit.acts.find(act => act.actKey === 'act2');
  assert.ok(act2Audit.boundaryMappings.some(item => item.sourceIndex === 89 && item.start === 89 && item.end === 89));
  assert.deepEqual(act2Audit.gaps, []);
  assert.deepEqual(act2Audit.overlaps, []);
  assert.equal(audit.providerRequestsMade, 0);
  assert.equal(audit.candidateWrites, 0);
  assert.equal(audit.episodeRootWrites, 0);

  const retimed = retimeEditPlan(input).plan;
  const beats = retimed.sequences.find(sequence => sequence.actKey === 'act2').beats;
  assert.equal(beats.find(beat => beat.beatId === 'ACT2_B011').startWordIndex, 89);
  assert.equal(beats.find(beat => beat.beatId === 'ACT2_B012').startWordIndex, 96);
  assert.equal(beats.find(beat => beat.beatId === 'ACT2_B011').endWordIndex + 1, beats.find(beat => beat.beatId === 'ACT2_B012').startWordIndex);
  assert.equal(retimed.sequences.find(sequence => sequence.actKey === 'act3b').beats.some(beat => beat.beatId === 'ACT3B_B010'), false);
  for (const act of audit.acts) {
    assert.deepEqual(act.gaps, []);
    assert.deepEqual(act.overlaps, []);
  }
});

test('policy-authorized Act 2 edge fails closed for missing policy, bad integrity, hashes, owner, index and token anchors', () => {
  const { value, input } = authorizedAct2Input();
  assert.equal(auditEditPlanBoundaries({ ...input, approvedBoundaryPolicy: undefined }).status, 'BOUNDARY_AUDIT_FAIL');
  assert.throws(() => verifyApprovedBoundaryPolicy({ policy: value.policy, policyBytes: Buffer.from(`${value.policyBytes} `), script: value.script, scriptSha256: value.policy.scriptSha256, amendmentSha256: value.policy.revisionLineage.amendmentSha256 }), /POLICY_HASH_MISMATCH/u);
  for (const [field, replacement] of [['actKey', 'act3'], ['beatId', 'ACT2_B012'], ['edge', 'end'], ['sourceBoundaryIndex', 90], ['targetTranscriptIndex', 90]]) {
    const alteredPolicy = structuredClone(value.policy);
    alteredPolicy.boundaryAuthorizations[0][field] = replacement;
    assert.throws(() => verifyApprovedBoundaryPolicy({ policy: alteredPolicy, policyBytes: value.policyBytes, script: value.script, scriptSha256: value.policy.scriptSha256, amendmentSha256: value.policy.revisionLineage.amendmentSha256 }), /POLICY_OBJECT_MISMATCH/u, field);
  }

  for (const key of Object.keys(value.boundaryInputHashes)) {
    const boundaryInputHashes = { ...value.boundaryInputHashes, [key]: '0'.repeat(64) };
    const failed = auditEditPlanBoundaries({ ...input, boundaryInputHashes });
    assert.equal(failed.status, 'BOUNDARY_AUDIT_FAIL', key);
    assert.ok(failed.errors.some(error => /AUTHORIZATION_INPUT_HASH_MISMATCH/u.test(error.code)), key);
  }

  const changeSource = index => {
    const plan = structuredClone(input.plan);
    const beat = plan.sequences.find(sequence => sequence.actKey === 'act2').beats.find(item => index >= item.startWordIndex && index <= item.endWordIndex);
    const words = beat.narrationExcerpt.split(/\s+/u); words[index - beat.startWordIndex] = `${words[index - beat.startWordIndex]}x`; beat.narrationExcerpt = words.join(' ');
    return auditEditPlanBoundaries({ ...input, plan });
  };
  for (const index of [88, 89, 90, 91]) assert.equal(changeSource(index).status, 'BOUNDARY_AUDIT_FAIL', `source ${index}`);

  for (const index of [88, 89, 90]) {
    const changedCandidate = structuredClone(input.script);
    const candidateTokens = changedCandidate.acts.act2.voScript.split(/\s+/u); candidateTokens[index] = `${candidateTokens[index]}x`; changedCandidate.acts.act2.voScript = candidateTokens.join(' ');
    assert.equal(auditEditPlanBoundaries({ ...input, script: changedCandidate }).status, 'BOUNDARY_AUDIT_FAIL', `candidate ${index}`);
    const changedTranscript = structuredClone(input.wordTimestamps);
    const act2Words = changedTranscript.filter(item => item.vo_file === input.actBindings.act2); act2Words[index].word = `${act2Words[index].word}x`;
    assert.equal(auditEditPlanBoundaries({ ...input, wordTimestamps: changedTranscript }).status, 'BOUNDARY_AUDIT_FAIL', `transcript ${index}`);
  }

  const wrongOwner = structuredClone(input.plan);
  wrongOwner.sequences.find(sequence => sequence.actKey === 'act2').beats[1].beatId = 'ACT2_B010';
  assert.equal(auditEditPlanBoundaries({ ...input, plan: wrongOwner }).status, 'BOUNDARY_AUDIT_FAIL');
  const wrongIndex = structuredClone(input.plan);
  wrongIndex.sequences.find(sequence => sequence.actKey === 'act2').beats[1].startWordIndex = 88;
  assert.equal(auditEditPlanBoundaries({ ...input, plan: wrongIndex }).status, 'BOUNDARY_AUDIT_FAIL');

  const unapprovedDeletion = approvedRevisionFixture({ act2Authorization: true });
  const unapprovedInput = { plan: unapprovedDeletion.plan, wordTimestamps: unapprovedDeletion.words, actOrder: unapprovedDeletion.actOrder,
    actBindings: unapprovedDeletion.bindings, actDurationsSec: unapprovedDeletion.durations, script: unapprovedDeletion.script,
    reviewedAlignment: unapprovedDeletion.reviewedAlignment };
  assert.equal(auditEditPlanBoundaries(unapprovedInput).status, 'BOUNDARY_AUDIT_FAIL');
});

test('ambiguous preceding anchor sequences and non-monotonic target relations fail closed', () => {
  const { input } = authorizedAct2Input();
  const duplicate = structuredClone(input);
  const planBeat = duplicate.plan.sequences.find(sequence => sequence.actKey === 'act2').beats[0];
  const duplicatePrefix = ['had', 'a', 'checking', 'account'];
  const firstWords = planBeat.narrationExcerpt.split(/\s+/u); firstWords.splice(0, 4, ...duplicatePrefix); planBeat.narrationExcerpt = firstWords.join(' ');
  const candidate = duplicate.script.acts.act2.voScript.split(/\s+/u); candidate.splice(0, 4, ...duplicatePrefix); duplicate.script.acts.act2.voScript = candidate.join(' ');
  const transcriptAct = duplicate.wordTimestamps.filter(item => item.vo_file === duplicate.actBindings.act2);
  duplicatePrefix.forEach((word, index) => { transcriptAct[index].word = word; });
  duplicate.reviewedAlignment = reviewedFor(duplicate.script, duplicate.wordTimestamps, duplicate.actBindings);
  const ambiguous = auditEditPlanBoundaries(duplicate);
  assert.equal(ambiguous.status, 'BOUNDARY_AUDIT_FAIL');
  assert.ok(ambiguous.errors.some(error => /ANCHOR_SOURCE_PRECEDING_AMBIGUOUS/u.test(error.code)));

  const reversed = structuredClone(input);
  const words = reversed.wordTimestamps.filter(item => item.vo_file === reversed.actBindings.act2);
  [words[89].word, words[90].word] = [words[90].word, words[89].word];
  reversed.reviewedAlignment = reviewedFor(reversed.script, reversed.wordTimestamps, reversed.actBindings);
  assert.equal(auditEditPlanBoundaries(reversed).status, 'BOUNDARY_AUDIT_FAIL');
});

test('approved hash-bound revised ranges share six-act audit and retiming; retirement leaves no plan, shot, manifest or narration orphan', () => {
  const value = approvedRevisionFixture();
  const input = { plan: value.plan, wordTimestamps: value.words, actOrder: value.actOrder, actBindings: value.bindings, actDurationsSec: value.durations, script: value.script, reviewedAlignment: value.reviewedAlignment, approvedBoundaryPolicy: value.approvedBoundaryPolicy };
  const audit = auditEditPlanBoundaries(input);
  assert.equal(audit.status, 'BOUNDARY_AUDIT_PASS', JSON.stringify(audit.errors));
  assert.equal(audit.acts.length, 6);
  assert.equal(audit.providerRequestsMade, 0);
  assert.equal(audit.candidateWrites, 0);
  assert.equal(audit.episodeRootWrites, 0);
  assert.deepEqual(audit.acts.find(item => item.actKey === 'act1').errors, []);
  assert.deepEqual(audit.acts.find(item => item.actKey === 'act3').errors, []);
  const retimed = retimeEditPlan(input).plan;
  const act3b = retimed.sequences.filter(item => item.actKey === 'act3b').flatMap(item => item.beats);
  const act4 = retimed.sequences.filter(item => item.actKey === 'act4').flatMap(item => item.beats);
  assert.equal(act3b.some(item => item.beatId === 'ACT3B_B010'), false);
  for (const [beatId, excerpt] of [['ACT3B_B008', value.policy.allocations[0].excerpt], ['ACT3B_B009', value.policy.allocations[1].excerpt], ['ACT3B_B011', value.policy.allocations[2].excerpt], ['ACT3B_B012', value.policy.allocations[3].excerpt]]) assert.equal(act3b.find(item => item.beatId === beatId).narrationExcerpt, excerpt);
  assert.equal(act3b.find(item => item.beatId === 'ACT3B_B011').endWordIndex + 1, act3b.find(item => item.beatId === 'ACT3B_B012').startWordIndex);
  assert.equal(act4.find(item => item.beatId === 'ACT4_B001').narrationExcerpt, value.policy.allocations[4].excerpt);
  assert.equal(act4.find(item => item.beatId === 'ACT4_B002').narrationExcerpt, value.policy.allocations[5].excerpt);
  assert.equal(act4.find(item => item.beatId === 'ACT4_B001').endWordIndex + 1, act4.find(item => item.beatId === 'ACT4_B002').startWordIndex);
  assert.deepEqual(act3b.flatMap(item => item.narrationExcerpt.split(/\s+/u)), value.script.acts.act3b.voScript.trim().split(/\s+/u));
  assertCreativePlanFieldsFrozen(value.plan, retimed, { retiredBeatIds: ['ACT3B_B010'] });

  const originalShots = { mode: 'empire-omitted-v3', episodeId: value.plan.episodeId, sourceEditPlanSha256: 'b'.repeat(64), totalShots: value.plan.sequences.flatMap(s => s.beats).length, acts: {}, allShots: [] };
  for (const sequence of value.plan.sequences) {
    originalShots.acts[sequence.actKey] = sequence.beats.map(beat => structuredClone(beat));
    originalShots.allShots.push(...sequence.beats.map(beat => ({ ...structuredClone(beat), shotId: beat.beatId })));
  }
  const shotResult = updateShotDefinitions({ originalShotDefs: originalShots, plan: retimed, revisionChain: [{ resultArtifactSha256: 'a'.repeat(64) }], revisionId: 'test-retirement', retiredBeatIds: ['ACT3B_B010'], retirementRecords: value.policy.retirements });
  assert.equal(shotResult.shotDefs.allShots.some(item => item.beatId === 'ACT3B_B010'), false);
  assert.equal(shotResult.shotDefs.acts.act3b.some(item => item.beatId === 'ACT3B_B010'), false);
  assert.equal(shotResult.revisionLedger.retirements[0].reason.includes('removed as unsupported'), true);
  const manifest = updateProductionManifestForRetirements({ totalShots: 1, shots: [{ shotId: 'ACT3B_B010', productionMethod: 'EVIDENCE_REFERENCE', overlayGraphicRequirement: false, graphicObjectCount: 0 }] }, ['ACT3B_B010']);
  assert.deepEqual(manifest.shots, []);
  assert.equal(manifest.totalShots, 0);
});

test('approved boundary ranges fail closed on missing or altered policy and lineage binding', () => {
  const value = approvedRevisionFixture();
  const valid = () => verifyApprovedBoundaryPolicy({ policy: value.policy, policyBytes: value.policyBytes, script: value.script, scriptSha256: value.policy.scriptSha256, amendmentSha256: value.policy.revisionLineage.amendmentSha256 });
  assert.equal(valid().allocations.length, 6);
  const missingRange = structuredClone(value.policy); missingRange.allocations.pop();
  assert.throws(() => verifyApprovedBoundaryPolicy({ policy: missingRange, policyBytes: value.policyBytes, script: value.script, scriptSha256: value.policy.scriptSha256, amendmentSha256: value.policy.revisionLineage.amendmentSha256 }), /ACTIVATION_APPROVED_BOUNDARY_POLICY_OBJECT_MISMATCH|ACTIVATION_APPROVED_BOUNDARY_SET_INVALID/u);
  assert.throws(() => verifyApprovedBoundaryPolicy({ policy: value.policy, policyBytes: Buffer.from(`${value.policyBytes} `), script: value.script, scriptSha256: value.policy.scriptSha256, amendmentSha256: value.policy.revisionLineage.amendmentSha256 }), /POLICY_HASH_MISMATCH/u);
  assert.throws(() => verifyApprovedBoundaryPolicy({ policy: value.policy, policyBytes: value.policyBytes, script: value.script, scriptSha256: value.policy.scriptSha256, amendmentSha256: '0'.repeat(64) }), /BINDING_MISMATCH/u);
  const altered = structuredClone(value.script); altered.acts.act3b.voScript = altered.acts.act3b.voScript.replace('5,300', '5,301');
  assert.throws(() => verifyApprovedBoundaryPolicy({ policy: value.policy, policyBytes: value.policyBytes, script: altered, scriptSha256: value.policy.scriptSha256, amendmentSha256: value.policy.revisionLineage.amendmentSha256 }), /RANGE_MISMATCH/u);
  assert.throws(() => updateShotDefinitions({ originalShotDefs: { allShots: [] }, plan: value.plan, revisionChain: [], retiredBeatIds: ['ACT3B_B010'], retirementRecords: [] }), /RETIREMENT_APPROVAL_MISSING/u);
  assert.throws(() => updateShotDefinitions({ originalShotDefs: { allShots: [] }, plan: value.plan, revisionChain: [], retiredBeatIds: ['ACT3B_B010', 'ACT3B_B010'] }), /RETIREMENT_NOT_APPROVED/u);
});

test('the five timing exceptions are versioned, pinned, run-bound, and tied to exact narration, ranges, lineage and production obligations', () => {
  const value = approvedTimingExceptionFixture();
  const policy = value.approvedTimingExceptions;
  assert.equal(policy.verified, true);
  assert.equal(policy.schemaVersion, 'phase2.3b-p-approved-timing-exceptions/1.0.0');
  assert.equal(policy.policySha256, '9df5925a9410ab47966e156e03e9675c011d3205ae31f8d8bc8394edcef5e0a5');
  assert.equal(policy.runId, 'phase2-3b-p-act-20260925');
  assert.equal(policy.exceptions.length, 5);
  assert.deepEqual(policy.exceptions.map(item => `${item.actKey}:${item.beatId}`), [
    'act2:ACT2_B006', 'act3b:ACT3B_B008', 'act3b:ACT3B_B012', 'act4:ACT4_B022', 'act5:ACT5_B012',
  ]);
  assert.deepEqual(policy.exceptions.map(item => item.approvedDurationSec), [1.720001, 7.270000, 6.760002, 6.019997, 6.099998]);
  assert.deepEqual(policy.exceptions.map(item => item.productionMethod), ['EVIDENCE_REFERENCE', 'EVIDENCE_REFERENCE', 'EVIDENCE_REFERENCE', 'EVIDENCE_REFERENCE', 'ESSENTIAL_ANIMATION']);
  for (const item of policy.exceptions) {
    assert.match(item.approvedNarrationSha256, /^[a-f0-9]{64}$/u);
    assert.match(item.sourcePlanNarrationSha256, /^[a-f0-9]{64}$/u);
    assert.match(item.productionObligationsSha256, /^[a-f0-9]{64}$/u);
    assert.ok(item.revisionLineage.entryId);
  }

  const verify = (actualBindings = value.policy.binding, options = {}) => activation.verifyApprovedTimingExceptionPolicy({
    policy: options.policy || value.policy, policyBytes: options.policyBytes || value.bytes, actualBindings,
    plan: options.plan || value.plan, script: options.script || value.script,
    shotDefinitions: options.shots || value.shots, productionManifest: options.manifest || value.manifest,
    approvedBoundaryPolicy: value.approvedBoundaryPolicy,
  });
  for (const key of Object.keys(value.policy.binding)) {
    const changed = structuredClone(value.policy.binding);
    changed[key] = key.endsWith('Sha256') ? '0'.repeat(64) : `${changed[key]}-stale`;
    assert.throws(() => verify(changed), /TIMING_EXCEPTION_(?:POLICY_)?(?:APPROVAL_INVALID|BINDING_MISMATCH)/u, key);
  }
  assert.equal(activationCli.loadApprovedTimingExceptions({ runId: 'another-independent-run' }), null);
  assert.throws(() => activationCli.loadApprovedTimingExceptions({
    runId: value.policy.binding.runId, policyFile: path.join(os.tmpdir(), `missing-timing-exceptions-${process.pid}.json`),
    approvedBoundaryPolicy: value.approvedBoundaryPolicy, boundaryInputHashes: {
      lockedEditPlanSha256: value.policy.binding.lockedEditPlanSha256,
      candidatePreTimingEditPlanSha256: value.policy.binding.candidatePreTimingEditPlanSha256,
      candidateScriptSha256: value.policy.binding.candidateScriptSha256,
      retainedTranscriptSha256: value.policy.binding.retainedTranscriptSha256,
      alignmentProposalSha256: value.policy.binding.alignmentProposalSha256,
      alignmentApprovalSha256: value.policy.binding.alignmentApprovalSha256,
      candidateAmendmentSha256: value.policy.binding.candidateAmendmentSha256,
    }, packageDirectory: value.root,
  }), /ACTIVATION_TIMING_EXCEPTION_POLICY_MISSING/u);
  const alteredShots = structuredClone(value.shots);
  alteredShots.allShots.find(item => item.beatId === 'ACT3B_B008').graphics[0].text = 'ALTERED GRAPHIC';
  assert.throws(() => verify(undefined, { shots: alteredShots }), /TIMING_EXCEPTION_PRODUCTION_BINDING_MISMATCH/u);
  const alteredPlan = structuredClone(value.plan);
  alteredPlan.sequences.flatMap(sequence => sequence.beats).find(item => item.beatId === 'ACT2_B006').startWordIndex++;
  assert.throws(() => verify(undefined, { plan: alteredPlan }), /TIMING_EXCEPTION_SOURCE_BEAT_MISMATCH/u);
  assert.throws(() => verify(undefined, { policyBytes: Buffer.concat([value.bytes, Buffer.from(' ')]) }), /TIMING_EXCEPTION_POLICY_HASH_MISMATCH/u);
  const duplicate = structuredClone(value.policy);
  duplicate.exceptions.push(structuredClone(duplicate.exceptions[0]));
  assert.throws(() => verify(undefined, { policy: duplicate }), /TIMING_EXCEPTION_POLICY_OBJECT_MISMATCH/u);
  const unknown = structuredClone(value.policy);
  unknown.exceptions[0].beatId = 'UNKNOWN_BEAT';
  assert.throws(() => verify(undefined, { policy: unknown }), /TIMING_EXCEPTION_POLICY_OBJECT_MISMATCH/u);
  const alteredDuration = structuredClone(value.policy);
  alteredDuration.exceptions[0].maximumAllowedDurationSec += 0.01;
  assert.throws(() => verify(undefined, { policy: alteredDuration }), /TIMING_EXCEPTION_POLICY_OBJECT_MISMATCH/u);
});

test('approved exceptions pass the same six-act boundary mapper and deterministic edit-plan validator', () => {
  const source = approvedTimingExceptionFixture();
  const fixture = syntheticApprovedTimingExceptionInput(source.approvedTimingExceptions, source);
  const audit = auditEditPlanBoundaries(fixture.input);
  assert.equal(audit.status, 'BOUNDARY_AUDIT_PASS', JSON.stringify(audit.errors));
  assert.equal(audit.acts.length, 6);
  assert.equal(audit.timingExceptionAudit.status, 'PASS');
  assert.equal(audit.timingExceptionAudit.entries.length, 5);
  assert.deepEqual(audit.acts.flatMap(act => act.errors), []);
  assert.deepEqual(audit.acts.flatMap(act => act.gaps), []);
  assert.deepEqual(audit.acts.flatMap(act => act.overlaps), []);
  assert.equal(audit.providerRequestsMade, 0);
  assert.equal(audit.candidateWrites, 0);
  assert.equal(audit.episodeRootWrites, 0);

  const retimed = retimeEditPlan(fixture.input).plan;
  const report = activation.verifyTimingExceptionApplications({ plan: retimed, approvedTimingExceptions: source.approvedTimingExceptions });
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.entries.map(item => item.beatId), ['ACT2_B006', 'ACT3B_B008', 'ACT3B_B012', 'ACT4_B022', 'ACT5_B012']);
  for (const item of source.approvedTimingExceptions.exceptions) {
    const beat = retimed.sequences.flatMap(sequence => sequence.beats).find(value => value.beatId === item.beatId);
    assert.equal(beat.timingExceptionReason, item.justification);
    assert.deepEqual([beat.startWordIndex, beat.endWordIndex], [item.mappedTranscriptWordRange.start, item.mappedTranscriptWordRange.end]);
    assert.ok(beat.durationSec >= item.minimumAllowedDurationSec && beat.durationSec <= item.maximumAllowedDurationSec, item.beatId);
  }
  assertCreativePlanFieldsFrozen(fixture.input.plan, retimed, { approvedTimingExceptionBeatIds: source.approvedTimingExceptions.exceptions.map(item => item.beatId) });
  const validation = validateEditPlan({ plan: retimed, wordTimestamps: fixture.wordTimestamps });
  assert.equal(validation.status, 'PASS', JSON.stringify(validation.errors));
  assert.deepEqual(validation.errors, []);
});

test('removing any one approved exception restores its original hard timing violation', () => {
  const source = approvedTimingExceptionFixture();
  const complete = syntheticApprovedTimingExceptionInput(source.approvedTimingExceptions, source);
  for (const omitted of source.approvedTimingExceptions.exceptions) {
    const reduced = {
      ...source.approvedTimingExceptions,
      exceptions: source.approvedTimingExceptions.exceptions.filter(item => item.exceptionId !== omitted.exceptionId),
    };
    const input = { ...complete.input, approvedTimingExceptions: reduced };
    const retimed = retimeEditPlan(input).plan;
    const validation = validateEditPlan({ plan: retimed, wordTimestamps: complete.wordTimestamps });
    assert.equal(validation.status, 'FAIL', omitted.beatId);
    const code = omitted.approvedDurationSec < 2 ? 'BEAT_TOO_SHORT' : 'BEAT_TOO_LONG';
    assert.equal(validation.errors.filter(error => error.code === code).length, 1, omitted.beatId);
  }
});

test('unlisted short and long beats still fail; the five near-minimum normal beats receive no exception', () => {
  const source = approvedTimingExceptionFixture();
  for (const [duration, code] of [[1.5, 'BEAT_TOO_SHORT'], [7, 'BEAT_TOO_LONG']]) {
    const fixture = syntheticApprovedTimingExceptionInput(source.approvedTimingExceptions, source, { unapprovedDuration: duration });
    const retimed = retimeEditPlan(fixture.input).plan;
    const validation = validateEditPlan({ plan: retimed, wordTimestamps: fixture.wordTimestamps });
    assert.equal(validation.status, 'FAIL');
    assert.equal(validation.errors.filter(error => error.code === code).length, 1);
  }
  const approvedIds = new Set(source.approvedTimingExceptions.exceptions.map(item => item.beatId));
  for (const id of ['ACT1_B014', 'ACT2_B004', 'ACT4_B008', 'ACT1_B010', 'ACT2_B024']) assert.equal(approvedIds.has(id), false, id);
});

test('revision lineage restores an approved retired shot before validating its parent hash', () => {
  const shot = { shotId: 'ACT3B_B010', beatId: 'ACT3B_B010', actKey: 'act3b', visual: { description: 'before' } };
  const amendedShot = structuredClone(shot); amendedShot.visual.description = 'approved';
  const parent = { sourceEditPlanSha256: 'b'.repeat(64), totalShots: 1, allShots: [shot], acts: { act3b: [shot] } };
  const amended = { ...structuredClone(parent), allShots: [amendedShot], acts: { act3b: [shot] } };
  const result = { ...structuredClone(parent), totalShots: 0, allShots: [], acts: { act3b: [] } };
  const amendment = { ledgerVersion: '1.0.0', revisionId: 'prior-shot-amendment', revisionVersion: '2.3B-SV', lineageRole: 'current', approvalStatus: 'APPROVED', approval: { status: 'APPROVED', basis: 'Earlier approved visual amendment.' }, parentArtifactSha256: revisionArtifactSha256(parent), resultArtifactSha256: revisionArtifactSha256(amended), entries: [{ shotId: shot.shotId, beatId: shot.beatId, fieldPath: 'visual.description', beforeValue: 'before', afterValue: 'approved', reason: 'Previously approved correction.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-SV' }], permittedImmutablePaths: [] };
  const retirement = { ledgerVersion: '1.0.0', revisionId: 'retire-b010', revisionVersion: '2.3B-P-ACTIVATION', lineageRole: 'current', approvalStatus: 'APPROVED', approval: { status: 'APPROVED', basis: 'Explicit approved beat retirement.' }, parentArtifactSha256: revisionArtifactSha256(amended), resultArtifactSha256: revisionArtifactSha256(result), entries: [], permittedImmutablePaths: [], retirements: [{ beatId: shot.beatId, shotId: shot.shotId, actKey: shot.actKey, allShotsIndex: 0, actShotsIndex: 0, shot: amendedShot, actShot: shot, reason: 'Approved unsupported narration retirement.', revisionLineageEntry: 'approved-retirement:act3b:ACT3B_B010', approvalStatus: 'APPROVED' }] };
  assert.equal(validateRevisionChain({ shotDefs: result, revisionChain: [amendment, retirement] }).status, 'PASS');
  const tampered = structuredClone(retirement); tampered.retirements[0].shot.visual.description = 'tampered';
  assert.equal(validateRevisionChain({ shotDefs: result, revisionChain: [amendment, tampered] }).status, 'FAIL');
});
