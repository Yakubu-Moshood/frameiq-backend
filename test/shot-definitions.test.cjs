'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const dbStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-db-'));
const dbStubPath = path.join(dbStubDir, 'db.cjs');
fs.writeFileSync(dbStubPath, 'module.exports = { get: async () => null, all: async () => [] };');
const originalDbModulePath = process.env.DB_MODULE_PATH;
process.env.DB_MODULE_PATH = dbStubPath;
process.on('exit', () => {
  if (originalDbModulePath === undefined) delete process.env.DB_MODULE_PATH;
  else process.env.DB_MODULE_PATH = originalDbModulePath;
  fs.rmSync(dbStubDir, { recursive: true, force: true });
});
const { validateEditPlan } = require('../pipeline-updates/edit-plan-validator.cjs');
const { generateShotDefinitions } = require('../pipeline-updates/surface-shot-definitions.cjs');
const { validateShotDefinitions } = require('../pipeline-updates/shot-definitions-validator.cjs');
const { runDurableShotDefinitionGeneration, validateResumeState } = require('../pipeline-updates/shot-definitions-durable-runner.cjs');
const { resolveEditPlanTimestamps } = require('../pipeline-updates/surface-renderer.cjs');

const ACTS = [
  ['act1', 'VO_Act1'], ['act2', 'VO_Act2'], ['act3', 'VO_Act3'],
  ['act3b', 'VO_Act3B'], ['act4', 'VO_Act4'], ['act5', 'VO_Act5'],
];

function fixture() {
  const wordTimestamps = [];
  const timingActs = [];
  const sequences = [];
  let cursor = 0;
  for (const [actKey, voKey] of ACTS) {
    const words = [`${actKey}`, 'alpha', 'beta'];
    wordTimestamps.push(
      { vo_file: voKey, word: words[0], start_seconds: 0.5, end_seconds: 0.9 },
      { vo_file: voKey, word: words[1], start_seconds: 1.5, end_seconds: 1.9 },
      { vo_file: voKey, word: words[2], start_seconds: 3, end_seconds: 3.4 },
    );
    timingActs.push({ actKey, voKey, startSec: cursor, endSec: cursor + 4, durationSec: 4, wordCount: 3 });
    const sequenceId = `${actKey}_seq1`;
    const beatId = `${actKey}_beat1`;
    sequences.push({
      sequenceId, actKey, sequencePurpose: 'Establish the chapter context.',
      directorIntent: 'Move the story forward.', emotionalStateStart: 'curious',
      emotionalStateEnd: 'alert', knowledgeQuestion: null, knowledgeAnswer: null,
      createsQuestion: null, motifRefs: [], continuityRefs: [],
      beats: [{
        beatId, sequenceId, actKey, startWordIndex: 0, endWordIndex: 2,
        startSec: cursor, endSec: cursor + 4, durationSec: 4,
        narrationExcerpt: words.join(' '), storyFunction: 'establish',
        visualIntent: 'Show the relevant setting.', visualClass: 'EDITORIAL_ILLUSTRATION',
        visual: { type: 'STILL', description: 'A restrained contextual setting.', motionType: 'static_locked', secondaryAction: null },
        rhythmIntent: 'measured', intentionalStillness: false, timingExceptionReason: null,
        postNarrationHoldSec: 0, reconstructionMode: null,
        motionIntent: { type: 'static_locked', secondaryAction: 'No movement.' }, graphics: null,
        audioDirection: null,
        evidenceRequirement: { required: false, evidenceType: null, description: null, sourceStatus: 'not_applicable', rightsStatus: 'not_applicable', authenticityStatus: 'not_applicable', citationLabel: null, humanReviewRequired: false },
        continuityRefs: [],
      }],
    });
    cursor += 4;
  }
  const editPlan = {
    schemaVersion: '3.1.0', pipelineVersion: 3, channel: 'EmpireOmitted',
    episodeId: 'phase2-shot-test', title: 'Test Episode',
    timing: { basis: 'finished_vo_word_timestamps', totalDurationSec: cursor, acts: timingActs },
    sequences,
  };
  const validation = validateEditPlan({ plan: editPlan, wordTimestamps });
  assert.equal(validation.status, 'PASS', JSON.stringify(validation.errors));
  const script = { topic: 'Test topic', title: 'Test Episode', acts: Object.fromEntries(ACTS.map(([key]) => [key, { label: key, voScript: `${key} alpha beta` }])) };
  return { script, editPlan, wordTimestamps, editPlanValidation: { status: 'PASS' } };
}

function fakeClient(calls = []) {
  return { messages: { create: async request => {
    calls.push(request);
    const prompt = request.messages[0].content;
    const payload = JSON.parse(prompt.split('LOCKED BEATS:\n')[1]);
    return { content: [{ type: 'text', text: JSON.stringify({ beats: payload.map(beat => ({
      beatId: beat.beatId, imagePrompt: Array.isArray(beat.graphics) && beat.graphics.length ? null : 'Editorial illustration of the described context.',
      negativePrompt: 'No fabricated documents or identifiable people.',
      sourceSearchInstruction: null, animationPrompt: '', reconstructionSafeguards: null,
      colorGrade: 'cold_blue',
    })) }) }] };
  } } };
}

test('durable supervisor pauses after Act 1 until its checkpoint is externally verified', async () => {
  const data = fixture();
  const calls = [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-durable-'));
  try {
    const resultPromise = runDurableShotDefinitionGeneration({ ...data, channel: 'EmpireOmitted', outputDir, client: fakeClient(calls) });
    let waiting;
    for (let i = 0; i < 100; i++) {
      try {
        const current = JSON.parse(fs.readFileSync(path.join(outputDir, 'generation-status.json'), 'utf8'));
        if (current.awaitingAct1CheckpointVerification) { waiting = current; break; }
      } catch (_) { /* process has not written status yet */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(waiting, 'supervisor must pause after the validated Act 1 checkpoint');
    const checkpointPath = path.join(outputDir, '.shot-definitions-checkpoint.json');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    assert.ok(checkpoint.acts.act1);
    assert.deepEqual(Object.keys(checkpoint.acts), ['act1']);
    assert.equal(calls.length, 1, 'Act 2 must not be dispatched before external verification');
    const gatePath = path.join(outputDir, waiting.verificationGate);
    fs.writeFileSync(gatePath, JSON.stringify({ runId: waiting.runId, act1CheckpointSha256: waiting.act1CheckpointSha256 }));
    const result = await resultPromise;
    const status = JSON.parse(fs.readFileSync(path.join(outputDir, 'generation-status.json'), 'utf8'));
    const pid = JSON.parse(fs.readFileSync(path.join(outputDir, 'generation.pid'), 'utf8'));
    const events = fs.readFileSync(path.join(outputDir, 'generation.log'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(calls.length, 6);
    assert.equal(status.terminalState, 'success');
    assert.equal(status.runId, result.runId);
    assert.equal(pid.runId, result.runId);
    assert.equal(status.currentAct, 'act5');
    assert.deepEqual(status.completedActs, ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5']);
    assert.deepEqual(status.attemptsByAct, { act1: 1, act2: 1, act3: 1, act3b: 1, act4: 1, act5: 1 });
    assert.equal(status.totalAnthropicAttempts, 6);
    assert.equal(events.at(-1).event, 'terminal');
    assert.equal(fs.existsSync(path.join(outputDir, '.generation.lock')), false);
    assert.equal(fs.existsSync(path.join(outputDir, 'shot-definitions-sha256.json')), true);
    assert.equal(result.report.status, 'PASS');
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('durable resume accepts only the authorized initial retry or an unused next-act attempt', () => {
  const data = fixture();
  const initial = validateResumeState({ checkpoint: { providerCalls: 2, spendReservedUsd: 0.54, acts: {} }, attemptRecord: null, editPlan: data.editPlan });
  assert.deepEqual(initial, { completedActs: [], firstMissingAct: 'act1' });
  const fingerprint = require('../pipeline-updates/shot-definitions-validator.cjs').planFingerprint(data.editPlan);
  const resume = validateResumeState({
    checkpoint: { providerCalls: 3, spendReservedUsd: 0.8, acts: { act1: { shots: [{}] } } },
    attemptRecord: { version: 1, episodeId: data.editPlan.episodeId, planFingerprint: fingerprint, attemptsByAct: { act1: 3, act2: 0, act3: 0, act3b: 0, act4: 0, act5: 0 } },
    editPlan: data.editPlan,
  });
  assert.deepEqual(resume, { completedActs: ['act1'], firstMissingAct: 'act2' });
  assert.throws(() => validateResumeState({
    checkpoint: { providerCalls: 4, spendReservedUsd: 1, acts: { act1: { shots: [{}] } } },
    attemptRecord: { version: 1, episodeId: data.editPlan.episodeId, planFingerprint: fingerprint, attemptsByAct: { act1: 3, act2: 1, act3: 0, act3b: 0, act4: 0, act5: 0 } },
    editPlan: data.editPlan,
  }), /already used its authorized attempt/);
});

test('durable supervisor never dispatches a fourth Act 1 provider attempt', async () => {
  const data = fixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-act1-limit-'));
  const failingClient = calls => ({ messages: { create: async () => { calls.push('act1'); throw new Error('synthetic Act 1 failure'); } } });
  try {
    const firstCalls = [];
    await assert.rejects(runDurableShotDefinitionGeneration({ ...data, channel: 'EmpireOmitted', outputDir, client: failingClient(firstCalls) }), /synthetic Act 1 failure/);
    const secondCalls = [];
    await assert.rejects(runDurableShotDefinitionGeneration({ ...data, channel: 'EmpireOmitted', outputDir, client: failingClient(secondCalls) }), /synthetic Act 1 failure/);
    const thirdCalls = [];
    await assert.rejects(runDurableShotDefinitionGeneration({ ...data, channel: 'EmpireOmitted', outputDir, client: failingClient(thirdCalls) }), /synthetic Act 1 failure/);
    const fourthCalls = [];
    await assert.rejects(runDurableShotDefinitionGeneration({ ...data, channel: 'EmpireOmitted', outputDir, client: failingClient(fourthCalls) }), /Authorized request limit blocked act1/);
    assert.equal(firstCalls.length, 1);
    assert.equal(secondCalls.length, 1);
    assert.equal(thirdCalls.length, 1);
    assert.equal(fourthCalls.length, 0);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(outputDir, '.shot-definitions-checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.providerCalls, 3, 'the supervisor rolls back the refused dispatch so only actual provider calls are counted');
    const status = JSON.parse(fs.readFileSync(path.join(outputDir, 'generation-status.json'), 'utf8'));
    assert.equal(status.terminalState, 'failure');
    assert.equal(status.attemptsByAct.act1, 3);
    assert.equal(status.actualRequestsInThisRun, 0);
    assert.equal(fs.existsSync(path.join(outputDir, 'shot-definitions.json')), false);
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('realistic V3 response shape with camelCase negativePrompt passes and is quarantined with a hash', async () => {
  const data = fixture();
  const calls = [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-response-shape-'));
  try {
    const client = { messages: { create: async request => {
      calls.push(request);
      const payload = JSON.parse(request.messages[0].content.split('LOCKED BEATS:\n')[1]);
      return { id: 'msg_test', type: 'message', role: 'assistant', model: request.model,
        content: [{ type: 'text', text: JSON.stringify({ beats: payload.map(beat => ({
          beatId: beat.beatId, imagePrompt: 'Restrained documentary illustration of the locked beat.',
          negativePrompt: 'No fabricated documents, logos, or identifiable people.',
          sourceSearchInstruction: null, animationPrompt: '', reconstructionSafeguards: null, colorGrade: 'cold_blue',
        })) }) }], usage: { input_tokens: 7615, output_tokens: 4941 } };
    } } };
    const result = await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', outputDir, client });
    assert.equal(result.totalShots, 6);
    assert.equal(calls.length, 6);
    assert.match(calls[0].system, /exact camelCase field names/);
    assert.match(calls[0].system, /negativePrompt is always a required nonblank string/);
    assert.equal(Object.hasOwn(calls[0], 'tools'), false);
    assert.equal(Object.hasOwn(calls[0], 'output_config'), false);
    const quarantine = path.join(outputDir, '.quarantine', 'anthropic-responses');
    const rawFile = fs.readdirSync(quarantine).find(name => name.startsWith('act1-attempt-1-') && name.endsWith('.json'));
    assert.ok(rawFile);
    const rawText = fs.readFileSync(path.join(quarantine, rawFile), 'utf8');
    const rawObject = JSON.parse(rawText);
    assert.equal(rawObject.usage.input_tokens, 7615);
    assert.equal(rawObject.usage.output_tokens, 4941);
    const metadata = JSON.parse(fs.readFileSync(path.join(quarantine, `${rawFile}.manifest.json`), 'utf8'));
    assert.equal(metadata.validationState, 'accepted');
    assert.equal(metadata.sha256, require('node:crypto').createHash('sha256').update(rawText).digest('hex'));
    assert.equal(metadata.usage.inputTokens, 7615);
    assert.equal(metadata.usage.outputTokens, 4941);
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('wrong negative_prompt spelling is retained in quarantine and never checkpointed', async () => {
  const data = fixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-response-alias-'));
  const client = { messages: { create: async request => {
    const payload = JSON.parse(request.messages[0].content.split('LOCKED BEATS:\n')[1]);
    return { content: [{ type: 'text', text: JSON.stringify({ beats: payload.map(beat => ({
      beatId: beat.beatId, imagePrompt: 'Illustrative context.', negative_prompt: 'No logos.',
      sourceSearchInstruction: null, animationPrompt: '', reconstructionSafeguards: null, colorGrade: 'cold_blue',
    })) }) }] };
  } } };
  try {
    await assert.rejects(generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', outputDir, client }), /negative_prompt/);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(outputDir, '.shot-definitions-checkpoint.json'), 'utf8'));
    assert.equal(Object.hasOwn(checkpoint.acts, 'act1'), false);
    assert.equal(fs.existsSync(path.join(outputDir, 'shot-definitions.json')), false);
    const quarantine = path.join(outputDir, '.quarantine', 'anthropic-responses');
    const rawFile = fs.readdirSync(quarantine).find(name => name.startsWith('act1-attempt-1-') && name.endsWith('.json'));
    assert.ok(rawFile);
    const metadata = JSON.parse(fs.readFileSync(path.join(quarantine, `${rawFile}.manifest.json`), 'utf8'));
    assert.equal(metadata.validationState, 'rejected');
    assert.ok(metadata.validationErrors.some(item => item.field.endsWith('.negative_prompt')));
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('plan-native graphic enrichment cannot silently turn a locked graphic into a synthetic still', async () => {
  const data = fixture();
  data.editPlan.sequences[0].beats[0].graphics = [{ type: 'data_graphic', intent: 'Approved data card.' }];
  const dataValidation = validateEditPlan({ plan: data.editPlan, wordTimestamps: data.wordTimestamps });
  assert.equal(dataValidation.status, 'PASS');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-graphic-contract-'));
  const client = { messages: { create: async request => {
    const payload = JSON.parse(request.messages[0].content.split('LOCKED BEATS:\n')[1]);
    return { content: [{ type: 'text', text: JSON.stringify({ beats: payload.map(beat => ({
      beatId: beat.beatId, imagePrompt: 'Improper synthetic still prompt.',
      negativePrompt: 'No misleading data.', sourceSearchInstruction: null,
      animationPrompt: '', reconstructionSafeguards: null, colorGrade: 'cold_blue',
    })) }) }] };
  } } };
  try {
    await assert.rejects(generateShotDefinitions({ ...data, editPlanValidation: dataValidation, channel: 'EmpireOmitted', mode: 'v3', outputDir, client }), /imagePrompt/);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(outputDir, '.shot-definitions-checkpoint.json'), 'utf8'));
    assert.equal(Object.hasOwn(checkpoint.acts, 'act1'), false);
    assert.equal(fs.existsSync(path.join(outputDir, 'shot-definitions.json')), false);
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('V3 generation makes six ordered enrichments and preserves locked beat identity, timing, and fields', async () => {
  const data = fixture();
  const calls = [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-v3-'));
  try {
    const shotDefs = await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', client: fakeClient(calls), outputDir });
    assert.equal(calls.length, 6);
    assert.equal(shotDefs.mode, 'empire-omitted-v3');
    assert.deepEqual(shotDefs.allShots.map(s => s.beatId), data.editPlan.sequences.map(s => s.beats[0].beatId));
    assert.equal(validateShotDefinitions({ plan: data.editPlan, shotDefs }).status, 'PASS');
    const shot = shotDefs.allShots[0];
    assert.equal(shot.shotId, shot.beatId);
    assert.equal(shot.startSec, data.editPlan.sequences[0].beats[0].startSec);
    assert.equal(shot.endSec, data.editPlan.sequences[0].beats[0].endSec);
    assert.deepEqual(shot.visual, data.editPlan.sequences[0].beats[0].visual);
    assert.equal(fs.existsSync(path.join(outputDir, 'shot-definitions.json')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, '.shot-definitions-checkpoint.json'), 'utf8')).acts.act5.shots.length, 1);
    assert.equal(fs.existsSync(path.join(outputDir, 'shot-definitions-audit.json')), true);
    assert.equal(fs.readdirSync(outputDir).some(name => name.endsWith('.tmp')), false);
    const rendererResolved = resolveEditPlanTimestamps({ shotDefs, editPlan: data.editPlan });
    assert.equal(rendererResolved[0].voKey, 'VO_Act1');
    assert.equal(rendererResolved[0].startSec, 0);
    assert.equal(rendererResolved[0].endSec, 4);
    assert.equal(rendererResolved[0].episodeStartSec, 0);
    assert.equal(rendererResolved[0].matched, true);
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('V3 checkpoints each validated act and resumes after a later-act provider failure without repeating completed calls', async () => {
  const data = fixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-resume-'));
  const firstCalls = [];
  const firstClient = { messages: { create: async request => {
    firstCalls.push(request);
    if (firstCalls.length === 4) throw new Error('Act 3B provider failure');
    const payload = JSON.parse(request.messages[0].content.split('LOCKED BEATS:\n')[1]);
    return { content: [{ type: 'text', text: JSON.stringify({ beats: payload.map(beat => ({ beatId: beat.beatId, imagePrompt: 'Restrained contextual illustration.', negativePrompt: 'No false evidence.', sourceSearchInstruction: null, animationPrompt: '', reconstructionSafeguards: null, colorGrade: 'cold_blue' })) }) }] };
  } } };
  try {
    await assert.rejects(generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', outputDir, client: firstClient }), /Act 3B provider failure/);
    const saved = JSON.parse(fs.readFileSync(path.join(outputDir, '.shot-definitions-checkpoint.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved.acts), ['act1', 'act2', 'act3']);
    assert.equal(fs.existsSync(path.join(outputDir, 'shot-definitions.json')), false);
    const resumeCalls = [];
    const resumeClient = { messages: { create: async request => {
      resumeCalls.push(request);
      const payload = JSON.parse(request.messages[0].content.split('LOCKED BEATS:\n')[1]);
      return { content: [{ type: 'text', text: JSON.stringify({ beats: payload.map(beat => ({ beatId: beat.beatId, imagePrompt: 'Restrained contextual illustration.', negativePrompt: 'No false evidence.', sourceSearchInstruction: null, animationPrompt: '', reconstructionSafeguards: null, colorGrade: 'cold_blue' })) }) }] };
    } } };
    const resumed = await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', outputDir, client: resumeClient });
    assert.equal(resumeCalls.length, 3, 'resume calls only act3b, act4, and act5');
    assert.match(resumeCalls[0].messages[0].content, /Create production enrichment for act3b/);
    assert.equal(resumed.totalShots, 6);
    assert.equal(validateShotDefinitions({ plan: data.editPlan, shotDefs: resumed }).status, 'PASS');
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('plan-native graphics are preserved and marked for compilation without an image prompt', async () => {
  const data = fixture();
  const beat = data.editPlan.sequences[0].beats[0];
  beat.graphics = [{ type: 'data_graphic', intent: 'Show the approved comparison between the two named values.', text: 'Approved comparison' }];
  const checked = validateEditPlan({ plan: data.editPlan, wordTimestamps: data.wordTimestamps });
  assert.equal(checked.status, 'PASS', JSON.stringify(checked.errors));
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-graphics-'));
  try {
    const definitions = await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', outputDir, client: fakeClient() });
    const shot = definitions.allShots[0];
    assert.equal(shot.assetType, 'graphic_compilation');
    assert.equal(shot.requiresGraphicCompilation, true);
    assert.deepEqual(shot.graphics, beat.graphics);
    assert.equal(shot.imagePrompt, null);
    assert.equal(shot.animationPrompt, '');
    assert.equal(validateShotDefinitions({ plan: data.editPlan, shotDefs: definitions }).status, 'PASS');
    const { generateImages } = require('../pipeline-updates/surface-image-generator.cjs');
    const promptsFile = path.join(outputDir, 'prompts.json');
    fs.writeFileSync(promptsFile, JSON.stringify([{ shotId: shot.shotId, filename: `${shot.shotId}.png`, prompt: null, assetType: shot.assetType }]));
    await assert.rejects(generateImages({ promptsFile, outputDir: path.join(outputDir, 'images') }), /graphic compilation/);
    assert.equal(fs.existsSync(path.join(outputDir, 'images')), false);
    const audit = JSON.parse(fs.readFileSync(path.join(outputDir, 'shot-definitions-audit.json'), 'utf8'));
    assert.equal(audit.graphicTreatmentCount, 1);
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('complete valid checkpoint reuse constructs no Anthropic client and makes no model calls', async () => {
  const data = fixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-no-client-'));
  try {
    await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', outputDir, client: fakeClient() });
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, '.shot-definitions-checkpoint.json'), 'utf8')).providerCalls, 6);
    fs.unlinkSync(path.join(outputDir, 'shot-definitions.json'));
    let constructions = 0;
    const result = await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', outputDir, createClient: () => { constructions++; throw new Error('must remain lazy'); } });
    assert.equal(constructions, 0);
    assert.equal(result.totalShots, 6);
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('tampered act checkpoint is rejected and regenerated while intact acts are reused', async () => {
  const data = fixture();
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-tamper-'));
  try {
    await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', outputDir, client: fakeClient() });
    fs.unlinkSync(path.join(outputDir, 'shot-definitions.json'));
    const checkpointPath = path.join(outputDir, '.shot-definitions-checkpoint.json');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    checkpoint.acts.act2.shots[0].rendererTrack = 'untrusted';
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));
    const calls = [];
    const result = await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', outputDir, client: fakeClient(calls) });
    assert.equal(calls.length, 1);
    assert.match(calls[0].messages[0].content, /Create production enrichment for act2/);
    assert.equal(Object.hasOwn(result.acts.act2[0], 'rendererTrack'), false);
  } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
});

test('stable beat IDs resolve to still, clip, and renderer asset paths without provider calls', async () => {
  const data = fixture();
  const beat = data.editPlan.sequences[0].beats[0];
  beat.visual.type = 'CLIP';
  beat.visual.motionType = 'environmental_motion';
  beat.motionIntent.type = 'environmental_motion';
  beat.motionIntent.secondaryAction = 'Subtle ambient movement.';
  const planCheck = validateEditPlan({ plan: data.editPlan, wordTimestamps: data.wordTimestamps });
  assert.equal(planCheck.status, 'PASS', JSON.stringify(planCheck.errors));
  const client = { messages: { create: async request => {
    const payload = JSON.parse(request.messages[0].content.split('LOCKED BEATS:\n')[1]);
    return { content: [{ type: 'text', text: JSON.stringify({ beats: payload.map(item => ({
      beatId: item.beatId,
      imagePrompt: 'A restrained contextual image.', negativePrompt: 'No fabricated evidence.',
      sourceSearchInstruction: null,
      animationPrompt: item.visual.type === 'CLIP' ? 'Subtle atmosphere moves gently.' : '',
      reconstructionSafeguards: null, colorGrade: 'cold_blue',
    })) }) }] };
  } } };
  const shotDefs = await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', client });
  const shot = shotDefs.allShots[0];
  const episodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-id-paths-'));
  const stillsDir = path.join(episodeDir, 'assets', 'stills');
  const clipsDir = path.join(episodeDir, 'assets', 'clips');
  fs.mkdirSync(stillsDir, { recursive: true });
  fs.mkdirSync(clipsDir, { recursive: true });
  const promptsFile = path.join(episodeDir, 'prompts.json');
  fs.writeFileSync(path.join(stillsDir, `${shot.shotId}.png`), 'fixture still');
  fs.writeFileSync(path.join(clipsDir, `${shot.shotId}.mp4`), 'fixture clip');
  fs.writeFileSync(promptsFile, JSON.stringify([{ shotId: shot.shotId, filename: `${shot.shotId}.png`, prompt: shot.imagePrompt, assetType: shot.assetType }]));
  try {
    const { generateImages } = require('../pipeline-updates/surface-image-generator.cjs');
    const imageResult = await generateImages({ promptsFile, outputDir: stillsDir });
    assert.equal(imageResult.skipped, 1);
    const { animateClips } = require('../pipeline-updates/surface-animator.cjs');
    const animationResult = await animateClips({ shotDefs, episodeDir });
    assert.equal(animationResult.skipped, 1);
    const rendererResolved = resolveEditPlanTimestamps({ shotDefs, editPlan: data.editPlan });
    assert.equal(rendererResolved[0].shotId, shot.beatId);
    assert.equal(path.basename(path.join(clipsDir, `${rendererResolved[0].shotId}.mp4`)), `${shot.beatId}.mp4`);
  } finally { fs.rmSync(episodeDir, { recursive: true, force: true }); }
});

test('V3 generator rejects script-only and non-Empire requests before any model call', async () => {
  const calls = [];
  const client = fakeClient(calls);
  const data = fixture();
  await assert.rejects(generateShotDefinitions({ script: data.script, editPlan: data.editPlan, mode: 'v3', channel: 'EmpireOmitted', client }), /edit plan/i);
  await assert.rejects(generateShotDefinitions({ ...data, mode: 'v3', channel: 'MacroDecode', client }), /restricted/);
  assert.equal(calls.length, 0);
});

test('legacy script-only behavior remains behind the explicit legacy mode', async () => {
  const calls = [];
  const makeLegacyResponse = acts => ({ content: [{ type: 'text', text: JSON.stringify({ acts }) }] });
  const client = { messages: { create: async request => {
    calls.push(request);
    const actKeys = request.messages[0].content.match(/GENERATE ONLY THESE ACTS: ([^\n]+)/)[1].split(', ');
    return makeLegacyResponse(Object.fromEntries(actKeys.map((actKey, index) => [actKey, [{
      shotId: `${actKey.toUpperCase()}_001`, actKey, triggerWord: 'test', visualType: 'STILL',
      estimatedDuration: 4, imagePrompt: 'A generic documentary still.', animationPrompt: '',
      colorGrade: 'neutral', sfx: null, cinematic: null,
    }]])));
  } } };
  const result = await generateShotDefinitions({
    mode: 'legacy', client,
    script: { topic: 'Legacy', title: 'Legacy', acts: Object.fromEntries(ACTS.map(([key]) => [key, { label: key, voScript: 'test script' }])) },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.totalShots, 6);
  assert.equal(result.mode, undefined);
});

test('shot-definition validator rejects missing, duplicate, reordered, or retimed beats', async () => {
  const data = fixture();
  const shotDefs = await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', client: fakeClient() });
  for (const mutate of [
    value => { value.allShots.pop(); },
    value => { value.allShots[1].beatId = value.allShots[0].beatId; },
    value => { [value.allShots[0], value.allShots[1]] = [value.allShots[1], value.allShots[0]]; },
    value => { value.allShots[0].startSec += 1; },
    value => { value.allShots[0].narrationExcerpt = ''; },
    value => { delete value.allShots[0].visualClass; },
    value => { delete value.allShots[0].storyFunction; },
    value => { value.allShots[0].assetType = 'renderer_track'; },
  ]) {
    const altered = structuredClone(shotDefs);
    mutate(altered);
    assert.equal(validateShotDefinitions({ plan: data.editPlan, shotDefs: altered }).status, 'FAIL');
  }
  assert.equal(validateShotDefinitions({ plan: null, shotDefs }).status, 'FAIL');
});

test('EVIDENCE cannot be routed through synthetic image generation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-def-evidence-'));
  const promptsFile = path.join(root, 'prompts.json');
  const outputDir = path.join(root, 'output');
  fs.writeFileSync(promptsFile, JSON.stringify([{ shotId: 'evidence-1', filename: 'evidence-1.png', prompt: null, assetType: 'evidence_reference' }]));
  try {
    const { generateImages } = require('../pipeline-updates/surface-image-generator.cjs');
    await assert.rejects(generateImages({ promptsFile, outputDir }), /Refusing synthetic generation/);
    assert.equal(fs.existsSync(outputDir), false, 'refusal happens before creating output folders or provider clients');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('V3 planning tests make no HTTP or HTTPS provider requests', async t => {
  let networkAttempts = 0;
  const saved = [];
  for (const client of [http, https]) for (const method of ['request', 'get']) {
    saved.push([client, method, client[method]]);
    client[method] = () => { networkAttempts++; throw new Error('network disabled'); };
  }
  t.after(() => { for (const [client, method, original] of saved) client[method] = original; });
  const data = fixture();
  await generateShotDefinitions({ ...data, channel: 'EmpireOmitted', mode: 'v3', client: fakeClient() });
  assert.equal(networkAttempts, 0);
});
