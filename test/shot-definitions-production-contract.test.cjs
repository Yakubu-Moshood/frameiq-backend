'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PRODUCTION_FIELD_CONTRACT, RESPONSE_FIELDS, responseExample,
  validateModelEnrichment, validatePersistedProductionFields,
} = require('../pipeline-updates/shot-definitions-production-contract.cjs');

function enrichment(overrides = {}) {
  return {
    beatId: 'act1_beat1',
    imagePrompt: 'A restrained, illustrative boardroom establishing image.',
    negativePrompt: 'No fabricated documents, logos, or identifiable people.',
    sourceSearchInstruction: null,
    reconstructionSafeguards: null,
    animationPrompt: '',
    colorGrade: 'cold_blue',
    ...overrides,
  };
}

test('shared response contract accepts every prompted field with its correct type and class rules', () => {
  assert.deepEqual(Object.keys(responseExample()), RESPONSE_FIELDS);
  const cases = [
    [{ visualClass: 'EVIDENCE', visual: { type: 'STILL' }, graphics: null }, enrichment({ imagePrompt: null, sourceSearchInstruction: 'Find the filed court exhibit for the stated date.' })],
    [{ visualClass: 'RECONSTRUCTION', visual: { type: 'STILL' }, graphics: null }, enrichment({ reconstructionSafeguards: 'Label the scene as illustrative and avoid matching any real person.' })],
    [{ visualClass: 'EDITORIAL_ILLUSTRATION', visual: { type: 'STILL' }, graphics: null }, enrichment()],
    [{ visualClass: 'EDITORIAL_ILLUSTRATION', visual: { type: 'CLIP' }, graphics: null }, enrichment({ animationPrompt: 'Slow push toward the empty boardroom; keep all subjects still.' })],
    [{ visualClass: 'EDITORIAL_ILLUSTRATION', visual: { type: 'CLIP' }, graphics: [{ type: 'data_graphic' }] }, enrichment({ imagePrompt: null })],
  ];
  for (const [beat, value] of cases) {
    const result = validateModelEnrichment(value, { beat });
    assert.equal(result.status, 'PASS', JSON.stringify(result.errors));
  }
  for (const field of RESPONSE_FIELDS) {
    assert.ok(PRODUCTION_FIELD_CONTRACT[field], `contract includes ${field}`);
    assert.ok(PRODUCTION_FIELD_CONTRACT[field].consumer, `accepted field ${field} has a downstream consumer or preservation point`);
  }
  assert.equal(PRODUCTION_FIELD_CONTRACT.providerHint.response, false);
  assert.equal(PRODUCTION_FIELD_CONTRACT.providerHint.persisted, false);
});

test('canonical negativePrompt spelling is required and negative_prompt is rejected', () => {
  const wrong = enrichment();
  delete wrong.negativePrompt;
  wrong.negative_prompt = 'wrong spelling';
  const result = validateModelEnrichment(wrong, { beat: { visualClass: 'EDITORIAL_ILLUSTRATION', visual: { type: 'STILL' } } });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(item => item.field === 'negative_prompt' && /Unknown/.test(item.message)));
  assert.ok(result.errors.some(item => item.field === 'negativePrompt' && /missing/.test(item.message)));
});

test('incorrect production field types fail contract validation', () => {
  const result = validateModelEnrichment(enrichment({ negativePrompt: ['not a string'], imagePrompt: 5, animationPrompt: null, colorGrade: 'ultraviolet' }), {
    beat: { visualClass: 'EDITORIAL_ILLUSTRATION', visual: { type: 'STILL' } },
  });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(item => item.field === 'negativePrompt'));
  assert.ok(result.errors.some(item => item.field === 'imagePrompt'));
  assert.ok(result.errors.some(item => item.field === 'animationPrompt'));
  assert.ok(result.errors.some(item => item.field === 'colorGrade'));
});

test('asset routing, locked overlay/motion, and intentional stillness are code-owned typed fields', () => {
  const sourceBeat = { visual: { type: 'STILL' }, graphics: null, motionIntent: { type: 'static_locked' }, intentionalStillness: true };
  const shot = {
    assetType: 'generated_image', requiresGraphicCompilation: false,
    visualType: 'STILL', motionTreatment: { type: 'static_locked' }, intentionalStillness: true,
    graphics: null, overlaySpecification: null,
    imagePrompt: 'A contextual illustration.', negativePrompt: 'No logos.', sourceSearchInstruction: null,
    reconstructionSafeguards: null, animationPrompt: '', colorGrade: 'neutral',
  };
  assert.equal(validatePersistedProductionFields(shot, { sourceBeat }).status, 'PASS');
  assert.equal(validatePersistedProductionFields({ ...shot, providerHint: 'sdxl' }, { sourceBeat }).status, 'FAIL');
  assert.equal(validatePersistedProductionFields({ ...shot, assetType: 9 }, { sourceBeat }).status, 'FAIL');
  assert.equal(validatePersistedProductionFields({ ...shot, intentionalStillness: 'yes' }, { sourceBeat }).status, 'FAIL');
  assert.equal(validatePersistedProductionFields({ ...shot, negative_prompt: 'wrong alias' }, { sourceBeat }).status, 'FAIL');
});

test('image generator forwards the canonical negativePrompt to its provider router without making requests', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-contract-db-'));
  const dbPath = path.join(dbDir, 'db.cjs');
  const priorDbModulePath = process.env.DB_MODULE_PATH;
  fs.writeFileSync(dbPath, 'module.exports = { get: async () => null, all: async () => [] };');
  process.env.DB_MODULE_PATH = dbPath;
  const { generateImages, withNegativePrompt } = require('../pipeline-updates/surface-image-generator.cjs');
  assert.equal(withNegativePrompt('Positive.', ''), 'Positive.');
  assert.equal(withNegativePrompt('Positive.', 'No logos.'), 'Positive.\n\nAvoid these elements: No logos.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-contract-image-'));
  const promptsFile = path.join(dir, 'prompts.json');
  let routedInput;
  fs.writeFileSync(promptsFile, JSON.stringify([{ shotId: 'act1_beat1', filename: 'act1_beat1.png', prompt: 'Positive prompt.', negativePrompt: 'Avoid logos.', assetType: 'generated_image' }]));
  try {
    await generateImages({ promptsFile, outputDir: path.join(dir, 'out'), routerFactory: () => ({ run: async (_providers, request) => { routedInput = request.input; return { provider: 'injected-test' }; } }) });
    assert.deepEqual(routedInput, { prompt: 'Positive prompt.', negativePrompt: 'Avoid logos.', width: 1536, height: 1024, outputPath: path.join(dir, 'out', 'act1_beat1.png') });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
    if (priorDbModulePath === undefined) delete process.env.DB_MODULE_PATH;
    else process.env.DB_MODULE_PATH = priorDbModulePath;
  }
});
