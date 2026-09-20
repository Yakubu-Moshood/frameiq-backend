'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { generateEditPlan, MODEL, _classifyRepairErrors } = require('../pipeline-updates/edit-plan-generator.cjs');
const { validateEditPlan } = require('../pipeline-updates/edit-plan-validator.cjs');

const ACTS = [
  ['act1', 'VO_Act1'], ['act2', 'VO_Act2'], ['act3', 'VO_Act3'],
  ['act3b', 'VO_Act3B'], ['act4', 'VO_Act4'], ['act5', 'VO_Act5'],
];

function inputs() {
  const script = { title: 'Test Empire', topic: 'Test', acts: {} };
  const wordTimestamps = [];
  const actDurationsSec = {};
  for (const [actKey, voKey] of ACTS) {
    script.acts[actKey] = { label: actKey, voScript: `${actKey} alpha beta` };
    actDurationsSec[actKey] = 4;
    wordTimestamps.push(
      { vo_file: voKey, word: actKey, start_seconds: 0.5, end_seconds: 0.9 },
      { vo_file: voKey, word: 'alpha', start_seconds: 1.5, end_seconds: 2 },
      { vo_file: voKey, word: 'beta', start_seconds: 3, end_seconds: 3.4 },
    );
  }
  return {
    script,
    wordTimestamps,
    actDurationsSec,
    channelDna: {
      id: 'EmpireOmitted', label: 'Empire Omitted', description: 'Investigative documentary',
      blueprint_label: 'Documentary', narration_style: 'dramatic-investigative',
      voice_id_elevenlabs: 'must-not-leak', image_primary: 'must-not-leak', api_key: 'must-not-leak',
    },
    episodeId: 'episode-123',
  };
}

function evidence(required = false) {
  return required ? {
    required: true, evidenceType: 'regulatory filing', description: 'The relevant authenticated filing',
    sourceStatus: 'pending', rightsStatus: 'unknown', authenticityStatus: 'pending_review',
    citationLabel: null, humanReviewRequired: true,
  } : {
    required: false, evidenceType: null, description: null, sourceStatus: 'not_applicable',
    rightsStatus: 'not_applicable', authenticityStatus: 'not_applicable', citationLabel: null,
    humanReviewRequired: false,
  };
}

function beat(first = 0, last = 2, overrides = {}) {
  return {
    startWordIndex: first,
    endWordIndex: last,
    storyFunction: 'establish',
    visualIntent: 'Show a connected human action that establishes the mechanism.',
    visualClass: 'RECONSTRUCTION',
    reconstructionMode: 'representative',
    visual: { type: 'CLIP', description: 'An employee studies a target board.', motionType: 'lateral_track', secondaryAction: 'The employee marks a target.' },
    rhythmIntent: 'measured',
    intentionalStillness: false,
    timingExceptionReason: null,
    postNarrationHoldSec: 0,
    motionIntent: { type: 'lateral_track', secondaryAction: 'The employee marks a target.' },
    graphics: null,
    audioDirection: { musicCue: 'restrained pulse', musicEvent: null, musicLevelDb: -24, duckUnderVO: true, sfx: ['office room tone'], silenceIntent: null },
    evidenceRequirement: evidence(false),
    continuityRefs: [],
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    sequences: [{
      sequencePurpose: 'Establish the mechanism.',
      directorIntent: 'The audience understands how pressure reaches an employee.',
      emotionalStateStart: 'curious', emotionalStateEnd: 'uneasy',
      knowledgeQuestion: 'How does pressure travel?', knowledgeAnswer: 'Through targets.',
      createsQuestion: 'What happens next?', motifRefs: [], continuityRefs: [],
      beats: [beat()],
      ...overrides,
    }],
  };
}

function fakeClient(makeDraft = () => draft(), { fenced = false, malformed = false } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(request) {
        calls.push(request);
        if (malformed) return { content: [{ type: 'text', text: '{bad json' }] };
        const body = JSON.stringify(makeDraft(calls.length - 1, request));
        return { content: [{ type: 'text', text: fenced ? `\n\n\`\`\`json\n${body}\n\`\`\`\n` : body }] };
      },
    },
  };
}

async function generate(overrides = {}, client = fakeClient()) {
  return generateEditPlan({ ...inputs(), ...overrides, client });
}

function checkpointPath(dir) {
  return path.join(dir, 'edit-plan-drafts.partial.json');
}

function readCheckpoint(dir) {
  return JSON.parse(fs.readFileSync(checkpointPath(dir), 'utf8'));
}

function hashDraft(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function createSixReusableCheckpoints(dir, data = inputs()) {
  const originalRmSync = fs.rmSync;
  fs.rmSync = (target, options) => target === checkpointPath(dir) ? undefined : originalRmSync(target, options);
  try { await generateEditPlan({ ...data, outputDir: dir, client: fakeClient() }); }
  finally { fs.rmSync = originalRmSync; }
  fs.rmSync(path.join(dir, 'edit-plan.json'), { force: true });
  const checkpoint = readCheckpoint(dir);
  return checkpoint;
}

test('makes exactly one independent model call per act in playback order', async () => {
  const client = fakeClient();
  await generate({}, client);
  assert.equal(client.calls.length, 6);
  ACTS.forEach(([actKey], index) => assert.match(client.calls[index].messages[0].content, new RegExp(`Plan only ${actKey}`)));
  assert.ok(client.calls.every(call => call.model === MODEL));
});

test('rejects non-Empire channels before any model call', async () => {
  const client = fakeClient();
  await assert.rejects(generate({ channelDna: { id: 'MacroDecode', label: 'Macro Decode' } }, client), /another channel/);
  await assert.rejects(generate({ channel: 'Empire Omitted', channelDna: { id: 'MacroDecode', label: 'Macro Decode' } }, client), /another channel/);
  assert.equal(client.calls.length, 0);
});

test('model cannot control beat or sequence IDs', async () => {
  const client = fakeClient(() => draft({ sequenceId: 'EVIL_SEQ', beats: [beat(0, 2, { beatId: 'EVIL_BEAT', sequenceId: 'EVIL_SEQ' })] }));
  const plan = await generate({}, client);
  assert.equal(plan.sequences[0].sequenceId, 'SEQ_ACT1_01');
  assert.equal(plan.sequences[0].beats[0].beatId, 'ACT1_B001');
});

test('model cannot control derived seconds or narration excerpt', async () => {
  const client = fakeClient(() => draft({ beats: [beat(0, 2, { startSec: 99, endSec: 100, durationSec: 1, narrationExcerpt: 'invented' })] }));
  const plan = await generate({}, client);
  assert.deepEqual(Object.fromEntries(['startSec', 'endSec', 'durationSec', 'narrationExcerpt'].map(k => [k, plan.sequences[0].beats[0][k]])), {
    startSec: 0, endSec: 4, durationSec: 4, narrationExcerpt: 'act1 alpha beta',
  });
});

test('constructs cumulative episode-absolute act timing', async () => {
  const data = inputs();
  Object.assign(data.actDurationsSec, { act1: 4, act2: 4.1, act3: 4.2, act3b: 4.3, act4: 4.4, act5: 4.5 });
  const plan = await generate(data);
  assert.deepEqual(plan.timing.acts.map(a => [a.startSec, a.endSec]), [[0,4],[4,8.1],[8.1,12.3],[12.3,16.6],[16.6,21],[21,25.5]]);
  assert.equal(plan.timing.totalDurationSec, 25.5);
});

test('first beat absorbs leading silence', async () => {
  const plan = await generate();
  assert.equal(plan.sequences[0].beats[0].startSec, 0);
  assert.equal(inputs().wordTimestamps[0].start_seconds, 0.5);
});

test('inter-word silence belongs to the preceding beat', async () => {
  const plan = await generate({}, fakeClient(() => draft({ beats: [beat(0, 0, { timingExceptionReason: 'short impact beat' }), beat(1, 2)] })));
  const [first, second] = plan.sequences[0].beats;
  assert.equal(first.endSec, 1.5);
  assert.equal(second.startSec, 1.5);
});

test('final beat absorbs trailing silence', async () => {
  const plan = await generate();
  assert.equal(plan.sequences[0].beats[0].endSec, 4);
  assert.equal(inputs().wordTimestamps[2].end_seconds, 3.4);
});

test('narration excerpt is assembled from selected legacy words', async () => {
  const plan = await generate();
  assert.equal(plan.sequences[1].beats[0].narrationExcerpt, 'act2 alpha beta');
});

test('missing, zero, negative, and nonfinite durations fail before model calls', async () => {
  for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const data = inputs(); const client = fakeClient(); data.actDurationsSec.act3 = value;
    await assert.rejects(generate(data, client), /positive finite/);
    assert.equal(client.calls.length, 0);
  }
});

test('act duration shorter than its final timed word fails before model calls', async () => {
  const data = inputs(); const client = fakeClient(); data.actDurationsSec.act4 = 3;
  await assert.rejects(generate(data, client), /final timed word/);
  assert.equal(client.calls.length, 0);
});

test('optional markdown JSON fences parse', async () => {
  const plan = await generate({}, fakeClient(() => draft(), { fenced: true }));
  assert.equal(plan.schemaVersion, '3.1.0');
});

test('malformed model JSON fails clearly', async () => {
  await assert.rejects(generate({}, fakeClient(() => draft(), { malformed: true })), /act1 model JSON parse failed/);
});

test('gapped model word selection fails through the existing validator', async () => {
  const client = fakeClient((_i) => draft({ beats: [beat(0, 0), beat(2, 2)] }));
  await assert.rejects(generate({}, client), /Repair made no progress/);
});

test('overlapping model word selection fails through the existing validator', async () => {
  const client = fakeClient(() => draft({ beats: [beat(0, 1), beat(1, 2)] }));
  await assert.rejects(generate({}, client), /Repair made no progress/);
});

test('an unjustified beat over six seconds fails through the validator', async () => {
  const data = inputs(); data.actDurationsSec.act1 = 7;
  await assert.rejects(generate(data), /Repair made no progress/);
});

test('EVIDENCE planning passes with pending statuses and no invented URL', async () => {
  const client = fakeClient(() => draft({ beats: [beat(0, 2, {
    storyFunction: 'evidence', visualClass: 'EVIDENCE', reconstructionMode: null, evidenceRequirement: evidence(true),
  })] }));
  const plan = await generate({}, client);
  const requirement = plan.sequences[0].beats[0].evidenceRequirement;
  assert.equal(requirement.sourceStatus, 'pending');
  assert.equal(Object.hasOwn(requirement, 'url'), false);
});

test('valid final plan passes the existing deterministic validator', async () => {
  const data = inputs(); const plan = await generate(data);
  assert.equal(validateEditPlan({ plan, wordTimestamps: data.wordTimestamps }).status, 'PASS');
});

test('existing valid edit-plan.json is reused with zero model calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-reuse-'));
  try {
    const data = inputs(); const first = fakeClient();
    const plan = await generateEditPlan({ ...data, outputDir: dir, client: first });
    assert.equal(first.calls.length, 6);
    const second = fakeClient();
    assert.deepEqual(await generateEditPlan({ ...data, outputDir: dir, client: second }), plan);
    assert.equal(second.calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changed current trailing silence makes an existing plan stale without model calls or overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-stale-duration-'));
  try {
    const data = inputs();
    await generateEditPlan({ ...data, outputDir: dir, client: fakeClient() });
    const file = path.join(dir, 'edit-plan.json'); const original = fs.readFileSync(file);
    data.actDurationsSec.act3b = 4.5;
    const client = fakeClient();
    await assert.rejects(generateEditPlan({ ...data, outputDir: dir, client }), /is stale.*current finished VO timing or episode identity/);
    assert.equal(client.calls.length, 0);
    assert.deepEqual(fs.readFileSync(file), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('different requested episode ID makes an existing plan stale without model calls or overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-stale-episode-'));
  try {
    const data = inputs();
    await generateEditPlan({ ...data, outputDir: dir, client: fakeClient() });
    const file = path.join(dir, 'edit-plan.json'); const original = fs.readFileSync(file);
    const client = fakeClient();
    await assert.rejects(generateEditPlan({ ...data, episodeId: 'another-episode', outputDir: dir, client }), /is stale/);
    assert.equal(client.calls.length, 0);
    assert.deepEqual(fs.readFileSync(file), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changed current word timing rejects an existing plan without model calls or overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-stale-words-'));
  try {
    const data = inputs();
    const splitBeats = fakeClient(() => draft({ beats: [beat(0, 0, { timingExceptionReason: 'short impact beat' }), beat(1, 2)] }));
    await generateEditPlan({ ...data, outputDir: dir, client: splitBeats });
    const file = path.join(dir, 'edit-plan.json'); const original = fs.readFileSync(file);
    data.wordTimestamps.find(word => word.vo_file === 'VO_Act2' && word.word === 'alpha').start_seconds = 1.75;
    const client = fakeClient();
    await assert.rejects(generateEditPlan({ ...data, outputDir: dir, client }), /is stale/);
    assert.equal(client.calls.length, 0);
    assert.deepEqual(fs.readFileSync(file), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing invalid edit-plan.json is rejected and never overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-invalid-'));
  try {
    const file = path.join(dir, 'edit-plan.json'); const original = '{"invalid":true}\n';
    fs.writeFileSync(file, original); const client = fakeClient();
    await assert.rejects(generateEditPlan({ ...inputs(), outputDir: dir, client }), /is stale.*refusing to overwrite/);
    assert.equal(client.calls.length, 0); assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('approved malformed model fields reach the existing validator and are never defaulted', async () => {
  const cases = [
    ['unsupported visual type', { visual: { ...beat().visual, type: 'HOLOGRAM' } }, /SCHEMA_ENUM/],
    ['missing visual description', { visual: { type: 'CLIP', motionType: 'lateral_track', secondaryAction: null } }, /SCHEMA_REQUIRED/],
    ['blank visual description', { visual: { ...beat().visual, description: '   ' } }, /SCHEMA_TEXT/],
    ['invalid story function', { storyFunction: 'decorate' }, /SCHEMA_ENUM/],
    ['malformed evidence requirement', { visualClass: 'EVIDENCE', reconstructionMode: null, evidenceRequirement: evidence(false) }, /EVIDENCE_REQUIREMENT/],
  ];
  for (const [label, malformed, expected] of cases) {
    const client = fakeClient(() => draft({ beats: [beat(0, 2, malformed)] }));
    await assert.rejects(generate({}, client), /Repair made no progress/, label);
  }
});

test('generator does not mutate script, timestamps, durations, or Channel DNA', async () => {
  const data = inputs();
  const before = JSON.parse(JSON.stringify({
    script: data.script,
    wordTimestamps: data.wordTimestamps,
    actDurationsSec: data.actDurationsSec,
    channelDna: data.channelDna,
  }));
  await generate(data);
  assert.deepEqual(data.script, before.script);
  assert.deepEqual(data.wordTimestamps, before.wordTimestamps);
  assert.deepEqual(data.actDurationsSec, before.actDurationsSec);
  assert.deepEqual(data.channelDna, before.channelDna);
});

test('Act 4 model failure checkpoints Acts 1-3 and leaves no canonical or validation output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-act4-failure-'));
  try {
    const failure = new Error('Act 4 provider failure');
    const client = fakeClient(callIndex => {
      if (callIndex === 3) throw failure;
      return draft();
    });
    await assert.rejects(generateEditPlan({ ...inputs(), outputDir: dir, client }), error => error === failure);
    assert.equal(client.calls.length, 4);
    const checkpoint = readCheckpoint(dir);
    assert.deepEqual(Object.keys(checkpoint.acts), ['act1', 'act2', 'act3']);
    assert.equal(Object.hasOwn(checkpoint.acts, 'act4'), false);
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan.candidate.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan-validation.json')), false);
    assert.deepEqual(fs.readdirSync(dir), ['edit-plan-drafts.partial.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('retry after Act 4 failure reuses Acts 1-3 and calls only Acts 4-6', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-resume-'));
  try {
    const data = inputs();
    const first = fakeClient(callIndex => {
      if (callIndex === 3) throw new Error('temporary Act 4 failure');
      return draft();
    });
    await assert.rejects(generateEditPlan({ ...data, outputDir: dir, client: first }), /temporary Act 4 failure/);
    const retry = fakeClient();
    const plan = await generateEditPlan({ ...data, outputDir: dir, client: retry });
    assert.equal(retry.calls.length, 3);
    assert.match(retry.calls[0].messages[0].content, /Plan only act3b/);
    assert.match(retry.calls[1].messages[0].content, /Plan only act4/);
    assert.match(retry.calls[2].messages[0].content, /Plan only act5/);
    assert.equal(validateEditPlan({ plan, wordTimestamps: data.wordTimestamps }).status, 'PASS');
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan.json')), true);
    assert.equal(fs.existsSync(checkpointPath(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Act 4 malformed JSON preserves earlier checkpoints and is not checkpointed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-malformed-act4-'));
  try {
    const client = fakeClient(callIndex => {
      if (callIndex === 3) return JSON.parse('{');
      return draft();
    });
    client.messages.create = async request => {
      client.calls.push(request);
      if (client.calls.length === 4 || client.calls.length === 5) return { content: [{ type: 'text', text: '{bad json' }] };
      return { content: [{ type: 'text', text: JSON.stringify(draft()) }] };
    };
    await assert.rejects(generateEditPlan({ ...inputs(), outputDir: dir, client }), /act3b model JSON parse failed/);
    assert.deepEqual(Object.keys(readCheckpoint(dir).acts), ['act1', 'act2', 'act3']);
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('six reusable checkpoints need no client creation and still produce a valid canonical plan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-six-checkpoints-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    const plan = await generateEditPlan({ ...data, outputDir: dir });
    assert.equal(validateEditPlan({ plan, wordTimestamps: data.wordTimestamps }).status, 'PASS');
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan.json')), true);
    assert.equal(fs.existsSync(checkpointPath(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fresh generation atomically checkpoints every successful act then removes the checkpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-progress-'));
  try {
    const client = fakeClient((callIndex) => {
      if (callIndex === 0) assert.equal(fs.existsSync(checkpointPath(dir)), false);
      else assert.deepEqual(Object.keys(readCheckpoint(dir).acts), ACTS.slice(0, callIndex).map(([actKey]) => actKey));
      return draft();
    });
    await generateEditPlan({ ...inputs(), outputDir: dir, client });
    assert.equal(client.calls.length, 6);
    assert.equal(fs.existsSync(checkpointPath(dir)), false);
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('final validation failure preserves only act-level-passing draft checkpoints', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-validation-failure-'));
  try {
    const client = fakeClient(callIndex => {
      if (callIndex === 5) return draft({ beats: [beat(0, 0), beat(2, 2)] });
      if (callIndex === 6) throw new Error('repair provider unavailable');
      return draft();
    });
    await assert.rejects(generateEditPlan({ ...inputs(), outputDir: dir, client }), /repair provider unavailable/);
    assert.deepEqual(Object.keys(readCheckpoint(dir).acts), ACTS.slice(0, 5).map(([actKey]) => actKey));
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan-validation.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changed timed words invalidate only the affected reusable act request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-words-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    data.wordTimestamps.find(word => word.vo_file === 'VO_Act3' && word.word === 'alpha').start_seconds = 1.6;
    const client = fakeClient();
    await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].messages[0].content, /Plan only act3/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changed finished duration invalidates only the affected reusable act request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-duration-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    data.actDurationsSec.act4 = 4.25;
    const client = fakeClient();
    await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].messages[0].content, /Plan only act4/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changed allowlisted creative DNA invalidates creative request checkpoints', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-dna-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    data.channelDna.description = 'A newly approved creative description';
    const client = fakeClient();
    await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changed secret DNA does not invalidate any creative request checkpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-secret-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    data.channelDna.api_key = 'rotated-secret';
    data.channelDna.voice_id_elevenlabs = 'rotated-voice';
    const client = fakeClient();
    await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('schema-valid checkpoint tampering is rejected by draft integrity without contaminating downstream prompts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-tamper-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    const checkpoint = readCheckpoint(dir);
    checkpoint.acts.act1.draft.sequences[0].sequencePurpose = 'Tampered but schema-valid purpose.';
    fs.writeFileSync(checkpointPath(dir), JSON.stringify(checkpoint, null, 2) + '\n');
    const client = fakeClient();
    const plan = await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].messages[0].content, /Plan only act1/);
    assert.equal(validateEditPlan({ plan, wordTimestamps: data.wordTimestamps }).status, 'PASS');
    assert.equal(plan.sequences.some(sequence => sequence.sequencePurpose.includes('Tampered')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legitimate upstream request change regenerates acts whose continuity prompts change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-context-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    data.script.acts.act1.voScript += ' Legitimate creative revision.';
    const client = fakeClient(callIndex => callIndex === 0
      ? draft({ sequencePurpose: 'Legitimately revised Act 1 purpose.' })
      : draft());
    const plan = await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 3);
    assert.match(client.calls[0].messages[0].content, /Plan only act1/);
    assert.match(client.calls[1].messages[0].content, /Plan only act2/);
    assert.match(client.calls[1].messages[0].content, /Legitimately revised Act 1 purpose/);
    assert.match(client.calls[2].messages[0].content, /Plan only act3/);
    assert.equal(validateEditPlan({ plan, wordTimestamps: data.wordTimestamps }).status, 'PASS');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing draftHash rejects only the affected act checkpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-missing-hash-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    const checkpoint = readCheckpoint(dir); delete checkpoint.acts.act2.draftHash;
    fs.writeFileSync(checkpointPath(dir), JSON.stringify(checkpoint, null, 2) + '\n');
    const client = fakeClient();
    await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].messages[0].content, /Plan only act2/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('incorrect draftHash rejects only the affected act checkpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-wrong-hash-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    const checkpoint = readCheckpoint(dir); checkpoint.acts.act3.draftHash = '0'.repeat(64);
    fs.writeFileSync(checkpointPath(dir), JSON.stringify(checkpoint, null, 2) + '\n');
    const client = fakeClient();
    await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].messages[0].content, /Plan only act3/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('matching request fingerprint and draftHash reuse an unchanged act without a paid call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-intact-hash-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    const checkpoint = readCheckpoint(dir);
    assert.equal(checkpoint.acts.act1.draftHash, hashDraft(checkpoint.acts.act1.draft));
    const client = fakeClient();
    await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt checkpoint is never reused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-corrupt-'));
  try {
    fs.writeFileSync(checkpointPath(dir), '{not json');
    const client = fakeClient();
    await generateEditPlan({ ...inputs(), outputDir: dir, client });
    assert.equal(client.calls.length, 6);
    assert.equal(fs.existsSync(checkpointPath(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('checkpoint for a different episode ID is never reused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-episode-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    const client = fakeClient();
    await generateEditPlan({ ...data, episodeId: 'different-episode', outputDir: dir, client });
    assert.equal(client.calls.length, 6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('checkpoint claiming a different channel is never reused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-checkpoint-channel-'));
  try {
    const data = inputs(); await createSixReusableCheckpoints(dir, data);
    const checkpoint = readCheckpoint(dir); checkpoint.channel = 'MacroDecode';
    fs.writeFileSync(checkpointPath(dir), JSON.stringify(checkpoint, null, 2) + '\n');
    const client = fakeClient();
    await generateEditPlan({ ...data, outputDir: dir, client });
    assert.equal(client.calls.length, 6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without outputDir generation creates no checkpoint artifact', async () => {
  const localCheckpoint = path.resolve('edit-plan-drafts.partial.json');
  const existedBefore = fs.existsSync(localCheckpoint);
  await generate();
  assert.equal(fs.existsSync(localCheckpoint), existedBefore);
});

test('unknown model fields do not leak into the canonical plan at any projected level', async () => {
  const client = fakeClient(() => ({
    maliciousTop: true,
    sequences: [{ ...draft().sequences[0], rendererTrack: 4, beats: [beat(0, 2, {
      filename: 'evil.mp4', visual: { ...beat().visual, ffmpeg: '-i evil' },
      motionIntent: { ...beat().motionIntent, keyframes: [] },
      audioDirection: { ...beat().audioDirection, timelinePosition: 3 },
      evidenceRequirement: { ...evidence(false), url: 'invented' },
    })] }],
  }));
  const plan = await generate({}, client); const sequence = plan.sequences[0]; const outputBeat = sequence.beats[0];
  assert.equal(Object.hasOwn(sequence, 'rendererTrack'), false);
  assert.equal(Object.hasOwn(outputBeat, 'filename'), false);
  assert.equal(Object.hasOwn(outputBeat.visual, 'ffmpeg'), false);
  assert.equal(Object.hasOwn(outputBeat.motionIntent, 'keyframes'), false);
  assert.equal(Object.hasOwn(outputBeat.audioDirection, 'timelinePosition'), false);
  assert.equal(Object.hasOwn(outputBeat.evidenceRequirement, 'url'), false);
});

test('creative prompt excludes secrets, provider routing, and voice IDs', async () => {
  const client = fakeClient(); await generate({}, client);
  const prompt = client.calls[0].messages[0].content;
  assert.doesNotMatch(prompt, /must-not-leak|voice_id|api_key|image_primary/);
  assert.match(prompt, /dramatic-investigative/);
});

test('draft prompt forbids deterministic and renderer-specific output fields', async () => {
  const client = fakeClient(); await generate({}, client);
  const prompt = client.calls[0].messages[0].content;
  assert.match(prompt, /Do not output startSec, endSec, durationSec, narrationExcerpt, beatId, sequenceId, actKey/);
  assert.match(prompt, /Cover every word index exactly once/);
});

test('all generator tests inject a fake client and make no network calls', () => {
  const client = fakeClient();
  assert.equal(typeof client.messages.create, 'function');
  assert.deepEqual(client.calls, []);
});

test('repairable narration gap is repaired only for the affected act', async () => {
  const client = fakeClient(callIndex => {
    if (callIndex === 0) return draft({ beats: [beat(0, 0), beat(2, 2)] });
    return draft();
  });
  const plan = await generate({}, client);
  assert.equal(client.calls.length, 7);
  assert.match(client.calls[1].messages[0].content, /Repair the complete model draft for act1/);
  assert.match(client.calls[1].messages[0].content, /NARRATION_GAP/);
  assert.equal(validateEditPlan({ plan, wordTimestamps: inputs().wordTimestamps }).status, 'PASS');
});

test('negative startWordIndex is repaired despite its deterministic timing and excerpt symptoms', async () => {
  const client = fakeClient(callIndex => callIndex === 0
    ? draft({ beats: [beat(-1, 2)] })
    : draft());
  const plan = await generate({}, client);
  const repairCall = client.calls[1];
  const repairErrors = repairCall.messages[0].content.split('VALIDATOR HARD ERRORS:\n')[1];
  assert.equal(client.calls.length, 7);
  assert.match(repairErrors, /SCHEMA_MINIMUM/);
  assert.match(repairErrors, /INVALID_WORD_RANGE/);
  assert.doesNotMatch(repairErrors, /\/startSec|\/endSec|\/durationSec|\/narrationExcerpt|MISSING_NARRATION_EXCERPT|INVALID_TIME_RANGE|DURATION_MISMATCH/);
  assert.deepEqual(Object.fromEntries(['startSec', 'endSec', 'durationSec', 'narrationExcerpt'].map(key => [key, plan.sequences[0].beats[0][key]])), {
    startSec: 0, endSec: 4, durationSec: 4, narrationExcerpt: 'act1 alpha beta',
  });
  assert.equal(validateEditPlan({ plan, wordTimestamps: inputs().wordTimestamps }).status, 'PASS');
});

test('endWordIndex outside the act is repaired and deterministic values are rebuilt', async () => {
  const client = fakeClient(callIndex => callIndex === 0
    ? draft({ beats: [beat(0, 99)] })
    : draft());
  const plan = await generate({}, client);
  assert.equal(client.calls.length, 7);
  assert.match(client.calls[1].messages[0].content, /INVALID_WORD_RANGE/);
  assert.equal(plan.sequences[0].beats[0].endWordIndex, 2);
  assert.equal(plan.sequences[0].beats[0].endSec, 4);
  assert.equal(plan.sequences[0].beats[0].narrationExcerpt, 'act1 alpha beta');
});

test('model-owned schema failures for storyFunction and visual.type are repairable', async () => {
  for (const malformed of [
    { storyFunction: 'not_approved' },
    { visual: { ...beat().visual, type: 'NOT_APPROVED' } },
  ]) {
    const client = fakeClient(callIndex => callIndex === 0
      ? draft({ beats: [beat(0, 2, malformed)] })
      : draft());
    const plan = await generate({}, client);
    assert.equal(client.calls.length, 7);
    assert.match(client.calls[1].messages[0].content, /SCHEMA_ENUM/);
    assert.equal(validateEditPlan({ plan, wordTimestamps: inputs().wordTimestamps }).status, 'PASS');
  }
});

test('empty beats and duplicate model-controlled refs are repairable schema failures', async () => {
  for (const initial of [
    draft({ beats: [] }),
    draft({ motifRefs: ['ledger', 'ledger'] }),
  ]) {
    const client = fakeClient(callIndex => callIndex === 0 ? initial : draft());
    const plan = await generate({}, client);
    assert.equal(client.calls.length, 7);
    assert.match(client.calls[1].messages[0].content, /SCHEMA_(?:MIN_ITEMS|UNIQUE)/);
    assert.equal(validateEditPlan({ plan, wordTimestamps: inputs().wordTimestamps }).status, 'PASS');
  }
});

test('deterministic validation faults are not independently AI-repairable', () => {
  const plan = {
    timing: { acts: [{ actKey: 'act1' }] },
    sequences: [{ actKey: 'act1', beats: [{ actKey: 'act1' }] }],
  };
  const cases = [
    { code: 'MISSING_NARRATION_EXCERPT', path: '/sequences/0/beats/0/narrationExcerpt', message: 'missing' },
    { code: 'SCHEMA_TYPE', path: '/sequences/0/beats/0/startSec', message: 'wrong type' },
    { code: 'SCHEMA_TEXT', path: '/sequences/0/beats/0/narrationExcerpt', message: 'blank' },
    { code: 'INVALID_TIME_RANGE', path: '/sequences/0/beats/0', message: 'bad range' },
    { code: 'DURATION_MISMATCH', path: '/sequences/0/beats/0/durationSec', message: 'bad duration' },
  ];
  for (const error of cases) {
    const classified = _classifyRepairErrors({ errors: [error] }, plan);
    assert.equal(classified.nonrepairable, error);
    assert.equal(classified.byAct.size, 0);
  }
});

test('range-root classification suppresses only deterministic derivative errors from the AI repair prompt', () => {
  const plan = {
    timing: { acts: [{ actKey: 'act1' }] },
    sequences: [{ actKey: 'act1', beats: [{ actKey: 'act1' }] }],
  };
  const root = { code: 'INVALID_WORD_RANGE', path: '/sequences/0/beats/0', message: 'invalid selection' };
  const classified = _classifyRepairErrors({ errors: [
    { code: 'SCHEMA_MINIMUM', path: '/sequences/0/beats/0/startWordIndex', message: 'negative' },
    root,
    { code: 'SCHEMA_TYPE', path: '/sequences/0/beats/0/startSec', message: 'derived' },
    { code: 'SCHEMA_TEXT', path: '/sequences/0/beats/0/narrationExcerpt', message: 'derived' },
    { code: 'MISSING_NARRATION_EXCERPT', path: '/sequences/0/beats/0/narrationExcerpt', message: 'derived' },
    { code: 'INVALID_TIME_RANGE', path: '/sequences/0/beats/0', message: 'derived' },
  ] }, plan);
  assert.equal(classified.nonrepairable, null);
  assert.deepEqual(classified.byAct.get('act1').map(error => error.code), ['SCHEMA_MINIMUM', 'INVALID_WORD_RANGE']);
});

test('repair handles overlap, evidence metadata and invalid vocabulary while compact motion is derived', async () => {
  const broken = [
    draft({ beats: [beat(0, 1), beat(1, 2)] }),
    draft({ beats: [beat(0, 2, { visualClass: 'EVIDENCE', reconstructionMode: null, evidenceRequirement: evidence(false) })] }),
    draft({ beats: [beat(0, 2, { storyFunction: 'invalid' })] }),
  ];
  for (const initial of broken) {
    const client = fakeClient(callIndex => callIndex === 0 ? initial : draft());
    const plan = await generate({}, client);
    assert.equal(client.calls.length, 7);
    assert.equal(validateEditPlan({ plan, wordTimestamps: inputs().wordTimestamps }).status, 'PASS');
  }
});

test('overlong beat is repaired by splitting coverage rather than changing deterministic time', async () => {
  const data = inputs(); data.actDurationsSec.act1 = 7;
  const client = fakeClient(callIndex => callIndex === 0
    ? draft()
    : callIndex === 1
      ? draft({ beats: [beat(0, 0, { timingExceptionReason: 'short impact beat' }), beat(1, 2)] })
      : draft());
  const plan = await generate(data, client);
  assert.equal(client.calls.length, 7);
  assert.equal(plan.sequences[0].beats.length, 2);
  assert.equal(plan.sequences[0].beats[0].startSec, 0);
  assert.equal(plan.sequences[0].beats[1].endSec, 7);
});

test('nonrepairable word timestamp corruption makes no repair call', async () => {
  const data = inputs(); data.wordTimestamps[1].start_seconds = 0.7;
  const client = fakeClient();
  await assert.rejects(generate(data, client), /Nonrepairable validation error WORD_TIMESTAMP_ORDER/);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls.some(call => /Repair the complete model draft/.test(call.messages[0].content)), false);
});

test('two changed invalid repairs consume the cap and a restart makes no further paid call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-repair-cap-'));
  try {
    const client = fakeClient(callIndex => {
      if (callIndex === 0) return draft({ beats: [beat(0, 2, { storyFunction: 'bad_one' })] });
      if (callIndex === 1) return draft({ beats: [beat(0, 2, { storyFunction: 'bad_two' })] });
      if (callIndex === 2) return draft({ beats: [beat(0, 2, { storyFunction: 'bad_three' })] });
      return draft();
    });
    await assert.rejects(generateEditPlan({ ...inputs(), outputDir: dir, client }), /Repair limit reached for act1: 2/);
    assert.equal(client.calls.length, 3);
    assert.equal(readCheckpoint(dir).repairAttempts.act1, 2);
    const retry = fakeClient();
    await generateEditPlan({ ...inputs(), outputDir: dir, client: retry });
    assert.equal(retry.calls.length, 6);
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan.json')), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('first changed repair may remain invalid and second repair can succeed', async () => {
  const client = fakeClient(callIndex => {
    if (callIndex === 0) return draft({ beats: [beat(0, 2, { storyFunction: 'bad_one' })] });
    if (callIndex === 1) return draft({ beats: [beat(0, 2, { storyFunction: 'bad_two' })] });
    return draft();
  });
  const plan = await generate({}, client);
  assert.equal(client.calls.length, 8);
  assert.equal(validateEditPlan({ plan, wordTimestamps: inputs().wordTimestamps }).status, 'PASS');
});

test('provider and transport failures do not consume semantic attempts, but identical valid repair does', async () => {
  for (const mode of ['provider', 'malformed', 'identical']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `edit-plan-repair-${mode}-`));
    try {
      const client = fakeClient(callIndex => callIndex === 0
        ? draft({ beats: [beat(0, 0), beat(2, 2)] })
        : draft());
      client.messages.create = async request => {
        client.calls.push(request);
        if (!request.messages[0].content.includes('Repair the complete')) return { content: [{ type: 'text', text: JSON.stringify(client.calls.length === 1 ? draft({ beats: [beat(0, 0), beat(2, 2)] }) : draft()) }] };
        if (mode === 'provider') throw new Error('repair provider failed');
        if (mode === 'malformed') return { content: [{ type: 'text', text: '{bad' }] };
        return { content: [{ type: 'text', text: JSON.stringify(draft({ beats: [beat(0, 0), beat(2, 2)] })) }] };
      };
      await assert.rejects(generateEditPlan({ ...inputs(), outputDir: dir, client }));
      const checkpoint = fs.existsSync(checkpointPath(dir)) ? readCheckpoint(dir) : { repairAttempts: {}, acts: {} };
      assert.equal(checkpoint.repairAttempts.act1 || 0, mode === 'identical' ? 1 : 0);
      assert.equal(checkpoint.acts.act1, undefined);
      assert.equal(fs.existsSync(path.join(dir, 'edit-plan.json')), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('warnings alone trigger no repair request', async () => {
  const data = inputs(); data.actDurationsSec.act1 = 3.5;
  const client = fakeClient();
  await generate(data, client);
  assert.equal(client.calls.length, 6);
});

function responseClient(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(request) {
        calls.push(request);
        return responses[calls.length - 1];
      },
    },
  };
}

test('normal generation still makes exactly six model calls', async () => {
  const client = fakeClient();
  await generate({}, client);
  assert.equal(client.calls.length, 6);
});

test('max_tokens on Act 1 triggers one compact regeneration and checkpoints only the valid draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-truncated-retry-'));
  try {
    let checkpointObserved = false;
    const client = responseClient([
      { stop_reason: 'max_tokens', usage: { output_tokens: 16000 }, content: [{ type: 'text', text: '{"sequences":[' }] },
      { stop_reason: 'end_turn', usage: { output_tokens: 100 }, content: [{ type: 'text', text: JSON.stringify(draft()) }] },
      ...Array.from({ length: 5 }, () => ({ stop_reason: 'end_turn', usage: { output_tokens: 100 }, content: [{ type: 'text', text: JSON.stringify(draft()) }] })),
    ]);
    const originalCreate = client.messages.create;
    client.messages.create = async request => {
      if (client.calls.length === 2) checkpointObserved = fs.existsSync(checkpointPath(dir));
      return originalCreate(request);
    };
    await generateEditPlan({ ...inputs(), outputDir: dir, client });
    assert.equal(client.calls.length, 7);
    assert.match(client.calls[1].messages[0].content, /previous answer was incomplete|JSON only|concise/);
    assert.equal(checkpointObserved, true);
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan.json')), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('malformed JSON with a normal stop reason gets one regeneration retry', async () => {
  const client = responseClient([
    { stop_reason: 'end_turn', usage: { output_tokens: 10 }, content: [{ type: 'text', text: '{bad' }] },
    ...Array.from({ length: 6 }, () => ({ stop_reason: 'end_turn', usage: { output_tokens: 100 }, content: [{ type: 'text', text: JSON.stringify(draft()) }] })),
  ]);
  await generate({}, client);
  assert.equal(client.calls.length, 7);
});

test('repeated truncation fails after one bounded regeneration and persists no invalid draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-plan-truncated-fail-'));
  try {
    const client = responseClient([
      { stop_reason: 'max_tokens', usage: { output_tokens: 16000 }, content: [{ type: 'text', text: '{' }] },
      { stop_reason: 'max_tokens', usage: { output_tokens: 16000 }, content: [{ type: 'text', text: '{' }] },
    ]);
    await assert.rejects(generateEditPlan({ ...inputs(), outputDir: dir, client }), /act1 model output truncated.*stop_reason=max_tokens.*output_tokens=16000.*text_chars=1/);
    assert.equal(client.calls.length, 2);
    assert.equal(fs.existsSync(path.join(dir, 'edit-plan.json')), false);
    assert.equal(fs.existsSync(checkpointPath(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('repeated malformed JSON fails after one bounded regeneration with safe diagnostics', async () => {
  const secret = 'sk-test-super-secret';
  const client = responseClient([
    { stop_reason: 'end_turn', usage: { output_tokens: 7 }, content: [{ type: 'text', text: `{ "secret": "${secret}"` }] },
    { stop_reason: 'end_turn', usage: { output_tokens: 8 }, content: [{ type: 'text', text: `{ "secret": "${secret}"` }] },
  ]);
  await assert.rejects(generate({ }, client), error => {
    assert.match(error.message, /act1 model JSON parse failed/);
    assert.match(error.message, /stop_reason=end_turn/);
    assert.match(error.message, /output_tokens=8/);
    assert.match(error.message, /text_chars=/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  assert.equal(client.calls.length, 2);
});

test('compact model drafts expand deterministically with safe defaults and schema vocab', async () => {
  const compact = {
    sequences: [{
      sequencePurpose: 'Establish the mechanism.',
      directorIntent: 'Show how pressure reaches an employee.',
      emotionalStateStart: 'curious',
      emotionalStateEnd: 'uneasy',
      motifRefs: [],
      continuityRefs: [],
      beats: [{
        startWordIndex: 0,
        endWordIndex: 2,
        storyFunction: 'establish',
        visualIntent: 'An employee studies a target board.',
        visualClass: 'RECONSTRUCTION',
        reconstructionMode: 'representative',
        visual: { type: 'CLIP', description: 'An employee studies a target board.', motionType: 'static_locked' },
        rhythmIntent: 'measured',
        audioDirection: {},
      }],
    }],
  };
  const plan = await generate({}, fakeClient(() => compact));
  assert.equal(plan.sequences[0].knowledgeQuestion, null);
  const output = plan.sequences[0].beats[0];
  assert.equal(output.intentionalStillness, false);
  assert.equal(output.timingExceptionReason, null);
  assert.equal(output.motionIntent.type, 'static_locked');
  assert.equal(Object.hasOwn(output.motionIntent, 'secondaryAction'), false);
  assert.equal(output.graphics, null);
  assert.deepEqual(output.audioDirection, {
    musicCue: null, musicEvent: null, musicLevelDb: null, duckUnderVO: null,
    sfx: [], silenceIntent: null,
  });
  assert.deepEqual(output.evidenceRequirement, evidence(false));
  assert.deepEqual(output.continuityRefs, []);
  assert.equal(validateEditPlan({ plan, wordTimestamps: inputs().wordTimestamps }).status, 'PASS');
});

test('compact EVIDENCE drafts retain explicit metadata while defaulting pending safety states', async () => {
  const compact = draft({ beats: [beat(0, 2, {
    visualClass: 'EVIDENCE', reconstructionMode: null,
    evidenceRequirement: { evidenceType: 'regulatory filing', description: 'Authenticated filing' },
  })] });
  const plan = await generate({}, fakeClient(() => compact));
  assert.deepEqual(plan.sequences[0].beats[0].evidenceRequirement, {
    required: true, evidenceType: 'regulatory filing', description: 'Authenticated filing',
    sourceStatus: 'pending', rightsStatus: 'unknown', authenticityStatus: 'pending_review',
    citationLabel: null, humanReviewRequired: true,
  });
});

test('checkpoint version 3 is written', async () => { const d=fs.mkdtempSync(path.join(os.tmpdir(),'cp3-')); try { const c=fakeClient(); await assert.rejects(generateEditPlan({...inputs(),outputDir:d,client:{calls:c.calls,messages:{create:async r=>{c.calls.push(r);throw new Error('stop')}}}})); } finally { fs.rmSync(d,{recursive:true,force:true}); } });
test('version 2 checkpoint is ignored', async () => { const d=fs.mkdtempSync(path.join(os.tmpdir(),'cp2-')); try { fs.writeFileSync(checkpointPath(d),JSON.stringify({checkpointVersion:2,episodeId:'episode-123',channel:'EmpireOmitted',acts:{}})); const c=fakeClient(); await generateEditPlan({...inputs(),outputDir:d,client:c}); assert.equal(c.calls.length,6); } finally { fs.rmSync(d,{recursive:true,force:true}); } });
test('normal compact path remains six calls', async () => { const c=fakeClient(); await generate({},c); assert.equal(c.calls.length,6); });
test('compact prompt defines reconstruction modes', async () => { const c=fakeClient(); await generate({},c); const p=c.calls[0].messages[0].content; assert.match(p,/literal_supported/); assert.match(p,/representative/); assert.match(p,/atmospheric/); });
test('compact prompt defines stillness distinction', async () => { const c=fakeClient(); await generate({},c); const p=c.calls[0].messages[0].content; assert.match(p,/static_locked/); assert.match(p,/static_locked alone does not mean intentionalStillness/); });
test('compact prompt gives operational evidence-first rule', async () => { const c=fakeClient(); await generate({},c); assert.match(c.calls[0].messages[0].content,/Should authentic material prove this claim/); });
test('compact prompt forbids synthetic source impersonation', async () => { const c=fakeClient(); await generate({},c); assert.match(c.calls[0].messages[0].content,/must not impersonate authentic source material/); });
test('compact reconstruction example includes mode and action', async () => { const c=fakeClient(); await generate({},c); const p=c.calls[0].messages[0].content; assert.match(p,/"reconstructionMode":"representative"/); assert.match(p,/"secondaryAction":"The employee marks the target\."/); });
test('missing reconstruction mode is repaired rather than defaulted', async () => { const c=fakeClient(i=>i===0?draft({beats:[beat(0,2,{reconstructionMode:undefined})]}):draft()); const plan=await generate({},c); assert.equal(c.calls.length,7); assert.equal(plan.sequences[0].beats[0].reconstructionMode,'representative'); });
test('invalid hold type is repaired', async () => { const c=fakeClient(i=>i===0?draft({beats:[beat(0,2,{postNarrationHoldSec:'bad'})]}):draft()); await generate({},c); assert.equal(c.calls.length,7); });
