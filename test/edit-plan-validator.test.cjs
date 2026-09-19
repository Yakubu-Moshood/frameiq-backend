'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const pipelineDir = path.resolve(__dirname, '../pipeline-updates');
const schema = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'edit-plan.schema.json'), 'utf8'));
// Load the actual module, but allow only its filesystem, path and local schema
// dependencies. Any network, AI SDK, timing module or subprocess import fails.
const testModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(pipelineDir, 'edit-plan-validator.cjs'), 'utf8'), {
  module: testModule,
  require(name) {
    if (name === 'node:fs') return fs;
    if (name === 'node:path') return path;
    if (name === './edit-plan.schema.json') return schema;
    throw new Error(`Forbidden test dependency: ${name}`);
  },
}, { filename: 'edit-plan-validator.cjs' });
const validate = input => structuredClone(testModule.exports.validateEditPlan(input));

function fixture() {
  const wordTimestamps = [];
  const acts = ['act1', 'act2'].map((actKey, ai) => {
    const voKey = ai === 0 ? 'VO_Act1' : 'VO_Act2';
    for (let i = 0; i < 8; i++) wordTimestamps.push({ vo_file: voKey, word: `word${i}`, start_seconds: i === 0 ? 0.25 : i, end_seconds: i + 0.5 });
    return { actKey, voKey, startSec: ai * 8, endSec: (ai + 1) * 8, durationSec: 8, wordCount: 8 };
  });
  const sequences = acts.map((act, ai) => {
    const sequenceId = `SEQ_${ai}`;
    return {
      sequenceId, actKey: act.actKey,
      sequencePurpose: 'Show how pressure reaches an employee.',
      directorIntent: 'Connect the sales target to the customer consequence.',
      emotionalStateStart: 'curiosity', emotionalStateEnd: 'unease',
      knowledgeQuestion: 'Who set the target?', knowledgeAnswer: 'Executives.', createsQuestion: 'Who pays the price?',
      motifRefs: [], continuityRefs: [],
      beats: [0, 1].map(bi => ({
        beatId: `B_${ai}_${bi}`, sequenceId, actKey: act.actKey,
        startWordIndex: bi * 4, endWordIndex: bi * 4 + 3,
        startSec: act.startSec + bi * 4, endSec: act.startSec + (bi + 1) * 4, durationSec: 4,
        narrationExcerpt: `word${bi * 4} word${bi * 4 + 1} word${bi * 4 + 2} word${bi * 4 + 3}`,
        storyFunction: 'cause', visualIntent: 'An employee reads the target board.',
        visualClass: 'RECONSTRUCTION', rhythmIntent: 'building',
        visual: { type: 'CLIP', description: 'A bank employee studies the target board.', motionType: 'lateral_track', secondaryAction: 'Employee turns toward the customer.' },
        intentionalStillness: false, timingExceptionReason: null,
        motionIntent: { type: 'lateral_track', secondaryAction: 'Employee turns toward the waiting customer.' },
        graphics: [], continuityRefs: [],
        evidenceRequirement: {
          required: false, evidenceType: null, description: null,
          sourceStatus: 'not_applicable', rightsStatus: 'not_applicable', authenticityStatus: 'not_applicable',
          citationLabel: null, humanReviewRequired: false,
        },
      })),
    };
  });
  return { plan: { schemaVersion: '3.0.0', pipelineVersion: 3, channel: 'EmpireOmitted', episodeId: 'TEST', title: 'The target', timing: { basis: 'finished_vo_word_timestamps', totalDurationSec: 16, acts }, sequences }, wordTimestamps };
}
const beats = f => f.plan.sequences[0].beats;
function fail(f, code) {
  const result = validate(f);
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(e => e.code === code), JSON.stringify(result.errors));
  return result;
}
function longBeat(f, reason = null) {
  Object.assign(beats(f)[0], { endWordIndex: 7, endSec: 8, durationSec: 8, timingExceptionReason: reason, narrationExcerpt: 'word0 word1 word2 word3 word4 word5 word6 word7' });
  beats(f).pop();
}

test('valid multi-act plan passes with exact metrics and no input mutation', () => {
  const f = fixture(), before = structuredClone(f);
  const report = validate(f);
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.metrics, {
    totalDurationSec: 16, totalSequences: 2, totalBeats: 4,
    averageBeatDurationSec: 4, longestBeatDurationSec: 4, longestNormalBeatDurationSec: 4,
    timingExceptionCount: 0, intentionalStillnessCount: 0,
    narrationCoveragePercent: 100, timelineCoveragePercent: 100,
    narrationGapCount: 0, narrationOverlapCount: 0, timelineGapCount: 0, timelineOverlapCount: 0,
    missingStoryFunctionCount: 0, missingNarrationExcerptCount: 0, unresolvedVisualIntentCount: 0,
    visualClassCounts: { EVIDENCE: 0, RECONSTRUCTION: 4, EDITORIAL_ILLUSTRATION: 0 },
    storyFunctionCounts: { establish: 0, reveal: 0, evidence: 0, human_cost: 0, cause: 4, consequence: 0, contrast: 0, escalation: 0, orientation: 0, emotional_hold: 0, transition: 0, payoff: 0, context: 0 },
  });
  assert.deepEqual(f, before);
});

test('missing narration word fails with unique coverage below 100%', () => {
  const f = fixture(); beats(f)[1].startWordIndex = 5;
  const r = fail(f, 'NARRATION_GAP');
  assert.equal(r.metrics.narrationGapCount, 1);
  assert.equal(r.metrics.narrationCoveragePercent, 93.75);
});
test('overlapping word ranges fail without inflating coverage', () => {
  const f = fixture(); beats(f)[1].startWordIndex = 3;
  const r = fail(f, 'NARRATION_OVERLAP');
  assert.equal(r.metrics.narrationOverlapCount, 1);
  assert.equal(r.metrics.narrationCoveragePercent, 100);
});
test('timeline gap fails independently of complete word coverage', () => {
  const f = fixture(); Object.assign(beats(f)[1], { startSec: 4.5, durationSec: 3.5 });
  const r = fail(f, 'TIMELINE_GAP');
  assert.equal(r.metrics.timelineGapCount, 1);
  assert.equal(r.metrics.timelineCoveragePercent, 96.875);
  assert.equal(r.metrics.narrationCoveragePercent, 100);
});
test('timeline overlap fails without inflating coverage', () => {
  const f = fixture(); Object.assign(beats(f)[1], { startSec: 3.5, durationSec: 4.5 });
  const r = fail(f, 'TIMELINE_OVERLAP');
  assert.equal(r.metrics.timelineOverlapCount, 1);
  assert.equal(r.metrics.timelineCoveragePercent, 100);
});
test('ordinary beat above 6 seconds fails', () => {
  const f = fixture(); longBeat(f); fail(f, 'BEAT_TOO_LONG');
});
test('justified long beat passes and is counted as an exception', () => {
  const f = fixture(); longBeat(f, 'Allow the audience to read the relevant clause.');
  const r = validate(f);
  assert.equal(r.status, 'PASS');
  assert.equal(r.metrics.timingExceptionCount, 1);
  assert.equal(r.metrics.longestBeatDurationSec, 8);
  assert.equal(r.metrics.longestNormalBeatDurationSec, 4);
  assert.ok(r.warnings.some(w => w.code === 'TIMING_EXCEPTION'));
});
test('intentional stillness requires a nonblank reason even for a normal beat', () => {
  const f = fixture(); Object.assign(beats(f)[0], { intentionalStillness: true, timingExceptionReason: '   ' });
  fail(f, 'STILLNESS_REASON_REQUIRED');
  beats(f)[0].timingExceptionReason = 'Hold on the human consequence.';
  const r = validate(f);
  assert.equal(r.status, 'PASS');
  assert.equal(r.metrics.intentionalStillnessCount, 1);
});
test('EVIDENCE fails without meaningful requirements; pending source needs no URL', () => {
  const f = fixture(); beats(f)[0].visualClass = 'EVIDENCE';
  fail(f, 'EVIDENCE_REQUIREMENT');
  beats(f)[0].evidenceRequirement = { required: true, evidenceType: 'regulatory_filing', description: 'The finding that documents the sales targets.', sourceStatus: 'pending', rightsStatus: 'unknown', authenticityStatus: 'pending_review', citationLabel: null, humanReviewRequired: true };
  assert.equal(validate(f).status, 'PASS');
});
test('duplicate beat IDs across acts fail', () => {
  const f = fixture(); f.plan.sequences[1].beats[0].beatId = beats(f)[0].beatId;
  fail(f, 'DUPLICATE_BEAT_ID');
});
test('missing and blank narration excerpts fail and count correctly', () => {
  const f = fixture(); delete beats(f)[0].narrationExcerpt; beats(f)[1].narrationExcerpt = ' ';
  assert.equal(fail(f, 'MISSING_NARRATION_EXCERPT').metrics.missingNarrationExcerptCount, 2);
});
test('exact narration excerpt passes deterministic word-sequence verification', () => {
  assert.equal(validate(fixture()).status, 'PASS');
});
test('narration excerpt tolerates punctuation and capitalisation differences', () => {
  const f = fixture(); beats(f)[0].narrationExcerpt = 'WORD0, Word1! word2... WORD3?';
  assert.equal(validate(f).status, 'PASS');
});
test('different narration words fail excerpt verification', () => {
  const f = fixture(); beats(f)[0].narrationExcerpt = 'word0 word1 unrelated word3';
  fail(f, 'NARRATION_EXCERPT_MISMATCH');
});
test('excerpt from adjacent narration fails excerpt verification', () => {
  const f = fixture(); beats(f)[0].narrationExcerpt = 'word1 word2 word3 word4';
  fail(f, 'NARRATION_EXCERPT_MISMATCH');
});
test('short and 5.5–6 second beats warn without failing', () => {
  const f = fixture(); f.wordTimestamps[2].start_seconds = 2.4;
  Object.assign(beats(f)[0], { endWordIndex: 1, endSec: 2.4, durationSec: 2.4, narrationExcerpt: 'word0 word1' });
  Object.assign(beats(f)[1], { startWordIndex: 2, startSec: 2.4, durationSec: 5.6, narrationExcerpt: 'word2 word3 word4 word5 word6 word7' });
  const r = validate(f);
  assert.equal(r.status, 'PASS');
  assert.equal(r.warnings.filter(w => w.code === 'TARGET_DURATION').length, 2);
});
test('required visual object supports compatibility treatments and nullable secondary action', () => {
  for (const type of ['CLIP', 'STILL', 'STILL_ZOOM']) {
    const f = fixture();
    Object.assign(beats(f)[0].visual, { type, secondaryAction: null });
    assert.equal(validate(f).status, 'PASS');
  }
});
test('missing visual and blank visual description fail', () => {
  const missing = fixture(); delete beats(missing)[0].visual;
  fail(missing, 'SCHEMA_REQUIRED');
  const blank = fixture(); blank.plan.sequences[0].beats[0].visual.description = ' ';
  fail(blank, 'SCHEMA_TEXT');
});
test('visual and directing motion types cannot contradict each other', () => {
  const f = fixture(); beats(f)[0].visual.motionType = 'dolly_forward';
  fail(f, 'VISUAL_MOTION_MISMATCH');
});
test('audioDirection preserves valid creative intent or may be null', () => {
  const f = fixture();
  beats(f)[0].audioDirection = {
    musicCue: 'pressure_build', musicEvent: 'duck_under_line', musicLevelDb: -24,
    duckUnderVO: true, sfx: ['office_room_tone'], silenceIntent: 'Drop to near-silence after the reveal.',
  };
  beats(f)[1].audioDirection = null;
  assert.equal(validate(f).status, 'PASS');
});
test('audioDirection rejects invalid events, non-finite levels, blank SFX and execution fields', () => {
  const mutations = [
    a => { a.musicEvent = 'crossfade'; },
    a => { a.musicLevelDb = Infinity; },
    a => { a.sfx = [' ']; },
    a => { a.musicCue = ' '; },
    a => { a.silenceIntent = '\n'; },
    a => { a.timelinePosition = 12; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    const audio = { musicCue: null, musicEvent: null, musicLevelDb: null, duckUnderVO: null, sfx: [], silenceIntent: null };
    mutate(audio); beats(f)[0].audioDirection = audio;
    assert.equal(validate(f).status, 'FAIL');
  }
});
test('graphics may be null, empty, or populated with approved creative intent', () => {
  const values = [
    null,
    [],
    [{ type: 'document_callout', intent: 'Isolate the relevant clause.', text: 'Eight is great' }],
  ];
  for (const graphics of values) {
    const f = fixture(); beats(f)[0].graphics = graphics;
    assert.equal(validate(f).status, 'PASS');
  }
});
test('graphics still rejects unknown treatments and execution fields', () => {
  const unknown = fixture(); beats(unknown)[0].graphics = [{ type: 'sparkle', intent: 'Decorate.' }];
  fail(unknown, 'SCHEMA_ENUM');
  const execution = fixture(); beats(execution)[0].graphics = [{ type: 'impact_card', intent: 'Land the fact.', videoTrack: 3 }];
  fail(execution, 'SCHEMA_PROPERTY');
});

for (const field of schema.required) {
  test(`missing top-level ${field} fails`, () => {
    const f = fixture(); delete f.plan[field]; fail(f, 'SCHEMA_REQUIRED');
  });
}
for (const [name, mutate, code] of [
  ['duplicate sequence', f => { f.plan.sequences[1].sequenceId = f.plan.sequences[0].sequenceId; }, 'DUPLICATE_SEQUENCE_ID'],
  ['unknown sequence act', f => { f.plan.sequences[0].actKey = 'act5'; }, 'UNKNOWN_ACT'],
  ['wrong beat sequence', f => { beats(f)[0].sequenceId = 'other'; }, 'BEAT_ASSIGNMENT'],
  ['wrong beat act', f => { beats(f)[0].actKey = 'act2'; }, 'BEAT_ASSIGNMENT'],
  ['negative index', f => { beats(f)[0].startWordIndex = -1; }, 'INVALID_WORD_RANGE'],
  ['fractional index', f => { beats(f)[0].endWordIndex = 2.5; }, 'INVALID_WORD_RANGE'],
  ['reversed indices', f => { beats(f)[0].startWordIndex = 4; }, 'INVALID_WORD_RANGE'],
  ['out-of-range index', f => { beats(f)[1].endWordIndex = 8; }, 'INVALID_WORD_RANGE'],
  ['first word missing', f => { beats(f)[0].startWordIndex = 1; }, 'NARRATION_GAP'],
  ['final word missing', f => { beats(f)[1].endWordIndex = 6; }, 'NARRATION_GAP'],
  ['duration mismatch', f => { beats(f)[0].durationSec = 5; }, 'DURATION_MISMATCH'],
  ['beat outside act', f => { Object.assign(beats(f)[1], { endSec: 9, durationSec: 5 }); }, 'BEAT_OUTSIDE_ACT'],
  ['missing story function', f => { delete beats(f)[0].storyFunction; }, 'MISSING_STORY_FUNCTION'],
  ['empty visual intent', f => { beats(f)[0].visualIntent = '\n '; }, 'MISSING_VISUAL_INTENT'],
  ['extra truth class', f => { beats(f)[0].visualClass = 'ARCHIVAL'; }, 'SCHEMA_ENUM'],
  ['invalid motion type', f => { beats(f)[0].motionIntent.type = 'random_orbit'; }, 'SCHEMA_ENUM'],
  ['blank secondary action', f => { beats(f)[0].motionIntent.secondaryAction = ' '; }, 'SCHEMA_TEXT'],
  ['wrong schema version', f => { f.plan.schemaVersion = '2.0.0'; }, 'SCHEMA_CONST'],
  ['wrong pipeline version', f => { f.plan.pipelineVersion = 2; }, 'SCHEMA_CONST'],
  ['renderer execution field', f => { beats(f)[0].videoTrack = 1; }, 'SCHEMA_PROPERTY'],
  ['wrong word count', f => { f.plan.timing.acts[0].wordCount = 7; }, 'WORD_COUNT_MISMATCH'],
  ['wrong VO mapping', f => { f.plan.timing.acts[0].voKey = 'VO_Act3'; }, 'ACT_VO_MISMATCH'],
  ['unmapped narration', f => { f.wordTimestamps.push({ vo_file: 'VO_Act5', word: 'extra', start_seconds: 0, end_seconds: 1 }); }, 'UNMAPPED_VO'],
  ['duplicate act', f => { f.plan.timing.acts.push(structuredClone(f.plan.timing.acts[0])); }, 'DUPLICATE_ACT'],
  ['duplicate VO key', f => { f.plan.timing.acts[1].voKey = 'VO_Act1'; }, 'DUPLICATE_VO_KEY'],
  ['act boundary gap', f => { f.plan.timing.acts[1].startSec += 1; }, 'ACT_TIMELINE_BOUNDARY'],
  ['wrong total duration', f => { f.plan.timing.totalDurationSec = 17; }, 'TOTAL_DURATION_MISMATCH'],
  ['reordered sequences', f => { f.plan.sequences.reverse(); }, 'SEQUENCE_ORDER'],
  ['reordered beats', f => { beats(f).reverse(); }, 'WORD_RANGE_ORDER'],
  ['act-local seconds used as episode seconds', f => { f.plan.sequences[1].beats[0].startSec = 0; }, 'WORD_TIME_MISMATCH'],
  ['negative timestamp', f => { f.wordTimestamps[0].start_seconds = -1; }, 'INVALID_WORD_TIMESTAMP'],
  ['unordered timestamps', f => { f.wordTimestamps[1].start_seconds = 0; }, 'WORD_TIMESTAMP_ORDER'],
  ['word outside audio duration', f => { f.wordTimestamps[7].end_seconds = 9; }, 'WORD_OUTSIDE_ACT'],
  ['nonfinite time', f => { beats(f)[0].startSec = NaN; }, 'SCHEMA_TYPE'],
]) {
  test(`${name} fails`, () => { const f = fixture(); mutate(f); fail(f, code); });
}

test('invented cut times fail even if all words and timeline seconds are covered', () => {
  const f = fixture(); Object.assign(beats(f)[0], { endSec: 4.5, durationSec: 4.5 }); Object.assign(beats(f)[1], { startSec: 4.5, durationSec: 3.5 });
  const r = fail(f, 'WORD_TIME_MISMATCH');
  assert.equal(r.metrics.narrationCoveragePercent, 100);
  assert.equal(r.metrics.timelineCoveragePercent, 100);
});
test('leading/trailing silence must be covered; inter-word silence belongs to previous beat', () => {
  const f = fixture();
  assert.equal(validate(f).status, 'PASS'); // first word starts .25, last ends 7.5
  Object.assign(beats(f)[0], { startSec: 0.25, durationSec: 3.75 });
  Object.assign(beats(f)[1], { endSec: 7.5, durationSec: 3.5 });
  assert.equal(fail(f, 'TIMELINE_GAP').metrics.timelineGapCount, 2);
});
test('one act can contain several consecutive sequences', () => {
  const f = fixture(), sequence = structuredClone(f.plan.sequences[0]);
  sequence.sequenceId = 'SEQ_extra';
  sequence.beats = [beats(f).pop()];
  sequence.beats[0].sequenceId = sequence.sequenceId;
  f.plan.sequences.splice(1, 0, sequence);
  assert.equal(validate(f).status, 'PASS');
});
test('floating-point boundary tolerance is small and deterministic', () => {
  const f = fixture(); beats(f)[1].startSec += 0.0001; beats(f)[1].durationSec -= 0.0001;
  assert.equal(validate(f).status, 'PASS');
  beats(f)[1].startSec += 0.01; beats(f)[1].durationSec -= 0.01;
  fail(f, 'TIMELINE_GAP');
});
test('an entirely missing act of visuals fails word and time coverage', () => {
  const f = fixture(); f.plan.sequences.pop();
  const r = fail(f, 'NARRATION_GAP');
  assert.equal(r.metrics.narrationCoveragePercent, 50);
  assert.equal(r.metrics.timelineCoveragePercent, 50);
});
test('malformed structures return FAIL reports rather than crashing', () => {
  for (const plan of [undefined, null, [], 7, {}, { timing: { acts: [null] }, sequences: [null] }]) {
    assert.equal(validate({ plan, wordTimestamps: null }).status, 'FAIL');
  }
  const f = fixture(); f.plan.sequences[0].beats = [null, {}];
  assert.equal(validate(f).status, 'FAIL');
  assert.equal(validate().status, 'FAIL');
});
test('report persistence writes exactly the returned report and only the report file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-validation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture();
  for (const valid of [true, false]) {
    if (!valid) delete beats(f)[0].visualIntent;
    const result = validate({ ...f, outputDir: dir });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'edit-plan-validation.json'), 'utf8')), result);
    assert.deepEqual(fs.readdirSync(dir), ['edit-plan-validation.json']);
    assert.equal(result.status, valid ? 'PASS' : 'FAIL');
  }
});
