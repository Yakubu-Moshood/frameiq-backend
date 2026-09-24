'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planProofSection } = require('../pipeline-updates/proof-section-planner.cjs');
function fixtures() {
  const methods = ['ESSENTIAL_ANIMATION', 'CONTROLLED_STILL', 'EVIDENCE_REFERENCE', 'GRAPHIC_COMPILATION', 'GENERATED_STILL'];
  const shots = Array.from({ length: 16 }, (_, i) => ({ shotId: `ACT${i < 8 ? 3 : 4}_B${String(i + 1).padStart(3, '0')}`, actKey: i < 8 ? 'act3b' : 'act4', sequenceId: `SEQ_${Math.floor(i / 2)}`, startSec: i * 5, endSec: (i + 1) * 5, durationSec: 5, narrationExcerpt: `narration ${i}`, visualClass: i % 5 === 2 ? 'EVIDENCE' : i % 5 === 0 ? 'RECONSTRUCTION' : 'EDITORIAL_ILLUSTRATION', assetType: methods[i % 5] === 'GRAPHIC_COMPILATION' ? 'graphic_compilation' : methods[i % 5] === 'EVIDENCE_REFERENCE' ? 'evidence_reference' : methods[i % 5] === 'GENERATED_STILL' ? 'generated_image' : 'generated_clip', evidenceRequirement: { description: 'source requirement' }, sourceSearchInstruction: 'search', animationPrompt: 'motion', graphics: i % 2 ? [{ type: 'date_marker', text: `date ${i}`, intent: 'date' }] : [] }));
  const manifest = { shots: shots.map((shot, i) => ({ shotId: shot.shotId, productionMethod: methods[i % 5], overlayGraphicRequirement: (shot.graphics || []).length > 0 && methods[i % 5] !== 'GRAPHIC_COMPILATION' })) };
  return { shotDefs: { allShots: shots }, productionManifest: manifest };
}
test('planner selects a contiguous 60–90 second proof range maximizing method diversity', () => {
  const input = fixtures(); const plan = planProofSection(input);
  assert.ok(plan.durationSec >= 60 && plan.durationSec <= 90);
  assert.equal(plan.startSec, 0); assert.ok(plan.criteria.evidenceShotIds.length); assert.ok(plan.criteria.primaryGraphicShotIds.length); assert.ok(plan.criteria.overlayShotIds.length); assert.ok(plan.criteria.reconstructionShotIds.length); assert.ok(plan.criteria.essentialAnimationShotIds.length); assert.ok(plan.criteria.controlledStillShotIds.length); assert.equal(plan.criteria.narrationTimingPresent, true);
  assert.equal(plan.expectedProviderCalls.evidenceSourceProviderCalls, 0); assert.equal(plan.expectedProviderCalls.graphicCompilationProviderCalls, 0);
});
test('proof requirements enumerate narration-locked sources, graphics, images, animations and expected jobs', () => {
  const plan = planProofSection(fixtures());
  assert.ok(plan.shotIds.length); assert.ok(plan.requiredEvidenceSources.every(item => item.exactRequirement));
  assert.ok(plan.requiredGraphicObjects.every(item => ['PRIMARY', 'OVERLAY'].includes(item.role)));
  assert.equal(plan.expectedProviderCalls.generationProviderCallsTotal, plan.expectedProviderCalls.imageJobs + plan.expectedProviderCalls.animationJobs);
});
test('same-checklist candidate selection uses the complete score, not raw still count', () => {
  const methodsA = [...Array(8).fill('CONTROLLED_STILL'), 'EVIDENCE_REFERENCE', 'GRAPHIC_COMPILATION', 'GENERATED_STILL', 'ESSENTIAL_ANIMATION', 'GENERATED_STILL'];
  const methodsB = ['EVIDENCE_REFERENCE','EVIDENCE_REFERENCE','EVIDENCE_REFERENCE','EVIDENCE_REFERENCE','GRAPHIC_COMPILATION','GRAPHIC_COMPILATION','GRAPHIC_COMPILATION','GENERATED_STILL','GENERATED_STILL','GENERATED_STILL','GENERATED_STILL','ESSENTIAL_ANIMATION','ESSENTIAL_ANIMATION','ESSENTIAL_ANIMATION','CONTROLLED_STILL','GENERATED_STILL'];
  const rows = [];
  for (const [block, methods] of [[0, methodsA], [100, methodsB]]) for (let i = 0; i < methods.length; i++) {
    const method = methods[i]; const assetType = method === 'EVIDENCE_REFERENCE' ? 'evidence_reference' : method === 'GRAPHIC_COMPILATION' ? 'graphic_compilation' : method === 'GENERATED_STILL' ? 'generated_image' : 'generated_clip';
    rows.push({ shot: { shotId: `S${block}_${i}`, actKey: 'act1', sequenceId: `Q${block}`, startSec: block + i * 5, endSec: block + (i + 1) * 5, durationSec: 5, narrationExcerpt: `line ${i}`, visualClass: ['CONTROLLED_STILL','ESSENTIAL_ANIMATION'].includes(method) ? 'RECONSTRUCTION' : method === 'EVIDENCE_REFERENCE' ? 'EVIDENCE' : 'EDITORIAL_ILLUSTRATION', assetType, evidenceRequirement: { description: 'source' }, sourceSearchInstruction: 'find source', graphics: method === 'GRAPHIC_COMPILATION' || (method === 'GENERATED_STILL' && i === 10) ? [{ type: 'impact_card', text: `G${i}`, intent: 'impact' }] : [] }, manifest: { shotId: `S${block}_${i}`, productionMethod: method, overlayGraphicRequirement: method !== 'GRAPHIC_COMPILATION' && (method === 'GENERATED_STILL' && i === 10) } });
  }
  const result = planProofSection({ shotDefs: { allShots: rows.map(row => row.shot) }, productionManifest: { shots: rows.map(row => row.manifest) }, minDurationSec: 60, maxDurationSec: 90, targetDurationSec: 65 });
  assert.equal(result.startSec, 100);
  assert.ok(result.selectionScore > 0);
  assert.ok(result.criteria.evidenceShotIds.length > 1);
});
test('planner refuses missing or non-contiguous inputs rather than inventing timing', () => {
  assert.throws(() => planProofSection({}), /PROOF_INPUT_INVALID/);
  const input = fixtures(); input.shotDefs.allShots = input.shotDefs.allShots.slice(0, 3); input.productionManifest.shots = input.productionManifest.shots.slice(0, 3);
  assert.throws(() => planProofSection(input), /PROOF_SECTION_NOT_FOUND/);
});
