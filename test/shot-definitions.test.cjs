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
      beatId: beat.beatId, imagePrompt: 'Editorial illustration of the described context.',
      negativePrompt: 'No fabricated documents or identifiable people.',
      sourceSearchInstruction: null, animationPrompt: '', reconstructionSafeguards: null,
      colorGrade: 'cold_blue',
    })) }) }] };
  } } };
}

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
    const rendererResolved = resolveEditPlanTimestamps({ shotDefs, editPlan: data.editPlan });
    assert.equal(rendererResolved[0].voKey, 'VO_Act1');
    assert.equal(rendererResolved[0].startSec, 0);
    assert.equal(rendererResolved[0].endSec, 4);
    assert.equal(rendererResolved[0].episodeStartSec, 0);
    assert.equal(rendererResolved[0].matched, true);
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
