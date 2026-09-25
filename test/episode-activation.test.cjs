'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TARGET_FILES, sha256, groupWordTimestamps, retimeEditPlan,
  assertOnlyApprovedActTextChanges, assertScriptTimestampParity,
  assertCreativePlanFieldsFrozen, verifyReplacementSet, makeBackup, verifyBackup, restoreBackup, reserveWhisperAttempt,
  analyzeScriptTimestampAlignment, verifyCompletedTimingArtifacts,
  chooseTimingTranscript, classifyReviewMismatch, buildAlignmentReviewProposal, applyAlignmentReviewApproval,
} = require('../pipeline-updates/episode-activation.cjs');
const activationCli = require('../scripts/phase2.3b-p-activate.cjs');

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
  }), /ACTIVATION_BOUNDARY_MAPPING_AMBIGUOUS:act2/u);
  assert.equal(fs.existsSync(candidate), false);
});

test('reviewed multi-token spans map boundaries before and after while an interior indivisible boundary fails closed', () => {
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
  assert.throws(() => retimeEditPlan({ ...inside, actOrder: inside.actKeys, actBindings: inside.bindings, actDurationsSec: Object.fromEntries(inside.actKeys.map(key => [key, 10])), reviewedAlignment: reviewed }), /ACTIVATION_BOUNDARY_(?:MAPPING_COVERAGE|REVIEW_RELATION_AMBIGUOUS):act2/u);
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
  assert.throws(() => retimeEditPlan({ ...ambiguous, actOrder: ambiguous.actKeys, actBindings: ambiguous.bindings, actDurationsSec: Object.fromEntries(ambiguous.actKeys.map(key => [key, 10])), reviewedAlignment: reviewedFor(ambiguous.script, ambiguous.words, ambiguous.bindings) }), /ACTIVATION_BOUNDARY_MAPPING_AMBIGUOUS:act2/u);

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

test('alignment resume accepts only the two exact approved deterministic alignment failures after all transcripts completed', () => {
  const runId = 'phase2-3b-p-act-20260925';
  const completedActs = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  const status = { runId, state: 'FAILURE', error: 'ACTIVATION_WORD_ALIGNMENT_MISMATCH:act2', completedActs };
  const fakeFs = { existsSync: () => true, readFileSync: () => Buffer.from(JSON.stringify(status)) };
  assert.deepEqual(activationCli.verifyResumableAlignmentFailure({ fs: fakeFs, runId }), status);
  assert.equal(activationCli.assertFailedRunProcessInactive({ pid: 987654321 }, { isProcessAlive: () => false }), true);
  assert.throws(() => activationCli.assertFailedRunProcessInactive({ pid: 1234 }, { isProcessAlive: () => true }), /RESUME_RUN_PROCESS_ACTIVE/u);
  const liveBoundaryFailure = { ...status, error: 'ACTIVATION_BOUNDARY_MAPPING_MISSING:act1:11' };
  assert.deepEqual(activationCli.verifyResumableAlignmentFailure({ fs: { ...fakeFs, readFileSync: () => Buffer.from(JSON.stringify(liveBoundaryFailure)) }, runId }), liveBoundaryFailure);
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
