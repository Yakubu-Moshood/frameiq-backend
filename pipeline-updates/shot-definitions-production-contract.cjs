'use strict';

const COLOR_GRADES = Object.freeze(['cold_blue', 'gold_warm', 'deep_shadow', 'red_alert', 'neutral', 'desaturated']);
const ASSET_TYPES = Object.freeze(['evidence_reference', 'graphic_compilation', 'generated_image', 'generated_clip']);

// This is the shared contract for the V3 response, canonical shot fields, and
// their owners. Model output is deliberately limited to the enrichment fields;
// asset routing, overlays, motion treatment, and stillness are code-owned copies
// of the validated edit plan.
const PRODUCTION_FIELD_CONTRACT = Object.freeze({
  beatId: { type: 'string', source: 'locked-plan-join-key', response: true, required: true, classes: 'all', consumer: 'shot-definition identity' },
  imagePrompt: { type: 'string|null', source: 'model', response: true, required: true, classes: 'generated visuals only; null for evidence/graphics', consumer: 'runner pending-prompts.prompt -> image provider' },
  negativePrompt: { type: 'nonblank string', source: 'model', response: true, required: true, classes: 'all', consumer: 'runner pending-prompts.negativePrompt -> image provider input' },
  sourceSearchInstruction: { type: 'string|null', source: 'model', response: true, required: true, classes: 'nonblank for EVIDENCE; null otherwise', consumer: 'source acquisition metadata/audit' },
  reconstructionSafeguards: { type: 'string|null', source: 'model', response: true, required: true, classes: 'nonblank for RECONSTRUCTION; null otherwise', consumer: 'shot audit/review metadata' },
  animationPrompt: { type: 'string', source: 'model', response: true, required: true, classes: 'nonblank for generated CLIP; empty otherwise', consumer: 'surface-animator.cjs for generated_clip' },
  colorGrade: { type: 'enum', values: COLOR_GRADES, source: 'model', response: true, required: true, classes: 'all', consumer: 'surface-renderer.cjs' },
  assetType: { type: 'enum', values: ASSET_TYPES, source: 'deterministic projection', persisted: true, required: true, classes: 'derived from locked class/graphics/visual type', consumer: 'runner, image generator, animator, renderer' },
  requiresGraphicCompilation: { type: 'boolean', source: 'deterministic projection', persisted: true, required: true, classes: 'all', consumer: 'runner and image-generator safety gate' },
  visualType: { type: 'string', source: 'locked plan', persisted: true, required: true, classes: 'all', consumer: 'animator and renderer' },
  overlaySpecification: { type: 'same-as-locked graphics', source: 'locked plan copy', persisted: true, required: true, classes: 'all', consumer: 'preserved for manual/future graphic compilation; current image generator blocks these shots' },
  graphics: { type: 'array|null', source: 'locked plan copy', persisted: true, required: true, classes: 'all', consumer: 'preserved for manual/future graphic compilation; current image generator blocks these shots' },
  motionTreatment: { type: 'same-as-locked motionIntent', source: 'locked plan copy', persisted: true, required: true, classes: 'all', consumer: 'preserved/validated; animator consumes its corresponding animationPrompt' },
  intentionalStillness: { type: 'boolean', source: 'locked plan copy', persisted: true, required: true, classes: 'all', consumer: 'review/audit metadata' },
  providerHint: { type: 'forbidden', source: 'not part of contract', response: false, persisted: false, required: false, classes: 'none', consumer: 'provider router owns selection from channel configuration' },
});

const RESPONSE_FIELDS = Object.freeze(Object.keys(PRODUCTION_FIELD_CONTRACT).filter(name => PRODUCTION_FIELD_CONTRACT[name].response));
const PERSISTED_PRODUCTION_FIELDS = Object.freeze(Object.keys(PRODUCTION_FIELD_CONTRACT).filter(name => PRODUCTION_FIELD_CONTRACT[name].persisted));
const CANONICAL_SHOT_FIELDS = Object.freeze([
  'shotId', 'beatId', 'sequenceId', 'actKey', 'startWordIndex', 'endWordIndex', 'startSec', 'endSec', 'durationSec',
  'narrationExcerpt', 'storyFunction', 'visualIntent', 'visualClass', 'rhythmIntent', 'visual', 'visualType',
  'motionIntent', 'motionTreatment', 'intentionalStillness', 'timingExceptionReason', 'postNarrationHoldSec',
  'reconstructionMode', 'continuityRefs', 'evidenceRequirement', 'graphics', 'overlaySpecification', 'audioDirection',
  'triggerWord', 'hardcodedSec', 'estimatedDuration', 'assetType', 'requiresGraphicCompilation', 'imagePrompt',
  'negativePrompt', 'sourceSearchInstruction', 'animationPrompt', 'reconstructionSafeguards', 'colorGrade', 'sfx',
]);

function responseExample() {
  return {
    beatId: '<copy locked beatId>',
    imagePrompt: '<nonblank string, or null for EVIDENCE/graphics>',
    negativePrompt: '<nonblank string in camelCase>',
    sourceSearchInstruction: '<nonblank string for EVIDENCE, otherwise null>',
    reconstructionSafeguards: '<nonblank string for RECONSTRUCTION, otherwise null>',
    animationPrompt: '<nonblank string for generated CLIP, otherwise empty string>',
    colorGrade: 'cold_blue',
  };
}

function validateModelEnrichment(value, { beat, assetType } = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'FAIL', errors: [{ field: '/', message: 'Enrichment must be an object.' }] };
  for (const key of Object.keys(value)) if (!RESPONSE_FIELDS.includes(key)) fail(key, `Unknown model field ${key}.`);
  for (const key of RESPONSE_FIELDS) if (!Object.hasOwn(value, key)) fail(key, `Required field ${key} is missing.`);
  if (typeof value.beatId !== 'string' || !value.beatId.trim()) fail('beatId', 'beatId must be a nonblank string.');
  if (value.imagePrompt !== null && (typeof value.imagePrompt !== 'string' || !value.imagePrompt.trim())) fail('imagePrompt', 'imagePrompt must be null or a nonblank string.');
  if (typeof value.negativePrompt !== 'string' || !value.negativePrompt.trim()) fail('negativePrompt', 'negativePrompt must be a nonblank string; use this exact camelCase spelling.');
  if (value.sourceSearchInstruction !== null && (typeof value.sourceSearchInstruction !== 'string' || !value.sourceSearchInstruction.trim())) fail('sourceSearchInstruction', 'sourceSearchInstruction must be null or a nonblank string.');
  if (value.reconstructionSafeguards !== null && (typeof value.reconstructionSafeguards !== 'string' || !value.reconstructionSafeguards.trim())) fail('reconstructionSafeguards', 'reconstructionSafeguards must be null or a nonblank string.');
  if (typeof value.animationPrompt !== 'string') fail('animationPrompt', 'animationPrompt must be a string.');
  if (typeof value.colorGrade !== 'string' || !COLOR_GRADES.includes(value.colorGrade)) fail('colorGrade', `colorGrade must be one of: ${COLOR_GRADES.join(', ')}.`);

  const hasGraphics = Array.isArray(beat?.graphics) && beat.graphics.length > 0;
  const isEvidence = beat?.visualClass === 'EVIDENCE' || assetType === 'evidence_reference';
  const isReconstruction = beat?.visualClass === 'RECONSTRUCTION';
  const isClip = !isEvidence && !hasGraphics && beat?.visual?.type === 'CLIP';
  if (isEvidence || hasGraphics) {
    if (value.imagePrompt !== null) fail('imagePrompt', 'EVIDENCE and plan-native graphics require imagePrompt:null.');
  } else if (typeof value.imagePrompt !== 'string' || !value.imagePrompt.trim()) fail('imagePrompt', 'Generated visuals require a nonblank imagePrompt.');
  if (isEvidence) {
    if (typeof value.sourceSearchInstruction !== 'string' || !value.sourceSearchInstruction.trim()) fail('sourceSearchInstruction', 'EVIDENCE requires a source-search instruction.');
  } else if (value.sourceSearchInstruction !== null) fail('sourceSearchInstruction', 'Only EVIDENCE may carry a source-search instruction.');
  if (isReconstruction) {
    if (typeof value.reconstructionSafeguards !== 'string' || !value.reconstructionSafeguards.trim()) fail('reconstructionSafeguards', 'RECONSTRUCTION requires safeguards.');
  } else if (value.reconstructionSafeguards !== null) fail('reconstructionSafeguards', 'Only RECONSTRUCTION may carry reconstruction safeguards.');
  if (isClip) {
    if (typeof value.animationPrompt !== 'string' || !value.animationPrompt.trim()) fail('animationPrompt', 'Generated CLIP requires a nonblank animationPrompt.');
  } else if (value.animationPrompt !== '') fail('animationPrompt', 'Only generated CLIP may carry an animationPrompt.');
  return { status: errors.length ? 'FAIL' : 'PASS', errors };
}

function validatePersistedProductionFields(shot, { sourceBeat } = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  if (typeof shot?.imagePrompt !== 'string' && shot?.imagePrompt !== null) fail('imagePrompt', 'imagePrompt must be a string or null.');
  if (typeof shot?.negativePrompt !== 'string' || !shot.negativePrompt.trim()) fail('negativePrompt', 'negativePrompt must be a nonblank string.');
  if (typeof shot?.sourceSearchInstruction !== 'string' && shot?.sourceSearchInstruction !== null) fail('sourceSearchInstruction', 'sourceSearchInstruction must be a string or null.');
  if (typeof shot?.reconstructionSafeguards !== 'string' && shot?.reconstructionSafeguards !== null) fail('reconstructionSafeguards', 'reconstructionSafeguards must be a string or null.');
  if (typeof shot?.animationPrompt !== 'string') fail('animationPrompt', 'animationPrompt must be a string.');
  if (!COLOR_GRADES.includes(shot?.colorGrade)) fail('colorGrade', 'Unsupported colorGrade.');
  if (!ASSET_TYPES.includes(shot?.assetType)) fail('assetType', 'Unsupported assetType.');
  if (typeof shot?.requiresGraphicCompilation !== 'boolean') fail('requiresGraphicCompilation', 'requiresGraphicCompilation must be boolean.');
  if (typeof shot?.intentionalStillness !== 'boolean') fail('intentionalStillness', 'intentionalStillness must be boolean.');
  if (sourceBeat) {
    if (shot?.visualType !== sourceBeat.visual?.type) fail('visualType', 'visualType must match the locked plan.');
    if (JSON.stringify(shot?.motionTreatment) !== JSON.stringify(sourceBeat.motionIntent)) fail('motionTreatment', 'motionTreatment must preserve locked motionIntent.');
    if (JSON.stringify(shot?.overlaySpecification) !== JSON.stringify(sourceBeat.graphics)) fail('overlaySpecification', 'overlaySpecification must preserve locked graphics.');
    if (JSON.stringify(shot?.graphics) !== JSON.stringify(sourceBeat.graphics)) fail('graphics', 'graphics must preserve locked graphics.');
    if (shot?.intentionalStillness !== sourceBeat.intentionalStillness) fail('intentionalStillness', 'intentionalStillness must preserve the locked plan.');
  }
  for (const key of Object.keys(shot || {})) if (!CANONICAL_SHOT_FIELDS.includes(key)) fail(key, `Unknown canonical shot field ${key}.`);
  return { status: errors.length ? 'FAIL' : 'PASS', errors };
}

module.exports = {
  ASSET_TYPES,
  COLOR_GRADES,
  PRODUCTION_FIELD_CONTRACT,
  RESPONSE_FIELDS,
  PERSISTED_PRODUCTION_FIELDS,
  CANONICAL_SHOT_FIELDS,
  responseExample,
  validateModelEnrichment,
  validatePersistedProductionFields,
};
