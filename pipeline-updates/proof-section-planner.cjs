'use strict';

const { PRODUCTION_METHODS } = require('./production-method-manifest.cjs');

function planProofSection({ shotDefs, productionManifest, minDurationSec = 60, maxDurationSec = 90, targetDurationSec = 80 }) {
  if (!shotDefs || !Array.isArray(shotDefs.allShots) || !productionManifest || !Array.isArray(productionManifest.shots)) throw new Error('[proof][PROOF_INPUT_INVALID] Current V3 shot definitions and production manifest are required.');
  if (!(minDurationSec > 0 && maxDurationSec >= minDurationSec)) throw new Error('[proof][PROOF_DURATION_RANGE_INVALID] Proof duration limits are invalid.');
  const manifestById = new Map(productionManifest.shots.map(entry => [entry.shotId, entry]));
  const shots = shotDefs.allShots.map(shot => ({ shot, manifest: manifestById.get(shot.shotId) }));
  const candidates = [];
  for (let start = 0; start < shots.length; start++) {
    for (let end = start; end < shots.length; end++) {
      const first = shots[start].shot;
      const last = shots[end].shot;
      const durationSec = last.endSec - first.startSec;
      if (durationSec > maxDurationSec) break;
      if (durationSec < minDurationSec) continue;
      const window = shots.slice(start, end + 1);
      let contiguous = true;
      for (let i = 1; i < window.length; i++) if (Math.abs(window[i - 1].shot.endSec - window[i].shot.startSec) > 0.001) contiguous = false;
      if (!contiguous) continue;
      const evidence = window.filter(item => item.manifest?.productionMethod === 'EVIDENCE_REFERENCE');
      const primaryGraphics = window.filter(item => item.manifest?.productionMethod === 'GRAPHIC_COMPILATION');
      const overlays = window.filter(item => item.manifest?.overlayGraphicRequirement === true);
      const reconstructions = window.filter(item => item.shot.visualClass === 'RECONSTRUCTION');
      const essentialAnimations = window.filter(item => item.manifest?.productionMethod === 'ESSENTIAL_ANIMATION');
      const controlledStills = window.filter(item => item.manifest?.productionMethod === 'CONTROLLED_STILL');
      const methods = new Set(window.map(item => item.manifest?.productionMethod).filter(Boolean));
      const acts = [...new Set(window.map(item => item.shot.actKey))];
      const sequences = [...new Set(window.map(item => item.shot.sequenceId))];
      const methodTransitions = window.slice(1).filter((item, index) => item.manifest?.productionMethod !== window[index].manifest?.productionMethod).length;
      const hasChecklist = Boolean(evidence.length && primaryGraphics.length && overlays.length && reconstructions.length && essentialAnimations.length && controlledStills.length);
      const score = Number(Boolean(evidence.length)) * 10 + Number(Boolean(primaryGraphics.length)) * 8 + Number(Boolean(overlays.length)) * 8
        + Number(Boolean(reconstructions.length)) * 7 + Number(Boolean(essentialAnimations.length)) * 7 + Number(Boolean(controlledStills.length)) * 5
        + Math.min(evidence.length, 8) * 1.5 + Math.min(primaryGraphics.length, 5) + Math.min(overlays.length, 5)
        + Math.min(methods.size, PRODUCTION_METHODS.length) * 1.5 + Math.min(methodTransitions, 12) * 0.8
        + Math.min(acts.length, 3) * 1.2 + Math.min(sequences.length, 8) * 0.2;
      candidates.push({ start, end, first, last, durationSec, window, evidence, primaryGraphics, overlays, reconstructions, essentialAnimations, controlledStills, methods, acts, sequences, methodTransitions, hasChecklist, score });
    }
  }
  if (!candidates.length) throw new Error('[proof][PROOF_SECTION_NOT_FOUND] No contiguous section fits the requested duration range.');
  candidates.sort((a, b) => Number(b.hasChecklist) - Number(a.hasChecklist) || b.score - a.score || Math.abs(a.durationSec - targetDurationSec) - Math.abs(b.durationSec - targetDurationSec) || a.first.startSec - b.first.startSec);
  const best = candidates[0];
  const selectedShots = best.window.map(item => item.shot);
  const requiredGraphics = best.window.flatMap(({ shot }) => (shot.graphics || []).map((graphic, graphicIndex) => ({ shotId: shot.shotId, graphicIndex, role: shot.assetType === 'graphic_compilation' ? 'PRIMARY' : 'OVERLAY', graphic })));
  const generatedBaseImages = best.window.filter(({ manifest }) => ['ESSENTIAL_ANIMATION', 'CONTROLLED_STILL', 'GENERATED_STILL'].includes(manifest?.productionMethod));
  return {
    plannerVersion: '1.0.0',
    durationBoundsSec: { min: minDurationSec, max: maxDurationSec },
    startSec: best.first.startSec,
    endSec: best.last.endSec,
    durationSec: best.durationSec,
    acts: best.acts,
    sequences: best.sequences,
    shotIds: selectedShots.map(shot => shot.shotId),
    selectionScore: best.score,
    criteria: {
      evidenceShotIds: best.evidence.map(item => item.shot.shotId),
      primaryGraphicShotIds: best.primaryGraphics.map(item => item.shot.shotId),
      overlayShotIds: best.overlays.map(item => item.shot.shotId),
      reconstructionShotIds: best.reconstructions.map(item => item.shot.shotId),
      essentialAnimationShotIds: best.essentialAnimations.map(item => item.shot.shotId),
      controlledStillShotIds: best.controlledStills.map(item => item.shot.shotId),
      methodTransitions: best.methodTransitions,
      narrationTimingPresent: selectedShots.every(shot => Number.isFinite(shot.startSec) && Number.isFinite(shot.endSec) && typeof shot.narrationExcerpt === 'string' && shot.narrationExcerpt.trim()),
    },
    requiredEvidenceSources: best.evidence.map(item => ({ shotId: item.shot.shotId, exactRequirement: item.shot.evidenceRequirement?.description, sourceSearchInstruction: item.shot.sourceSearchInstruction })),
    requiredGraphicObjects: requiredGraphics,
    requiredGeneratedBaseImages: generatedBaseImages.map(item => ({ shotId: item.shot.shotId, productionMethod: item.manifest.productionMethod, visualIntent: item.shot.visualIntent })),
    requiredAnimations: best.essentialAnimations.map(item => ({ shotId: item.shot.shotId, visualIntent: item.shot.visualIntent, animationPrompt: item.shot.animationPrompt })),
    expectedProviderCalls: {
      imageJobs: generatedBaseImages.length,
      animationJobs: best.essentialAnimations.length,
      evidenceSourceProviderCalls: 0,
      graphicCompilationProviderCalls: 0,
      generationProviderCallsTotal: generatedBaseImages.length + best.essentialAnimations.length,
      note: 'Counts are deterministic job counts; provider failover may add attempts. This plan does not execute them.',
    },
    knownBlockers: [
      'Evidence sources and rights have not yet been approved; all source candidates require individual review.',
      'Episode-level graphics have not been compiled; only one representative preview per unique type is produced in Phase 2.3A.',
      'Generated base images and animations are requirements only; no provider calls are made in this phase.',
    ],
  };
}
module.exports = { planProofSection };
