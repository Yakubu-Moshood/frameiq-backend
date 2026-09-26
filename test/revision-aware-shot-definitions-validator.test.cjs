'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const {
  artifactSha256, validateRevisionChain,
} = require('../pipeline-updates/revision-lineage.cjs');
const { validateShotDefinitions, planFingerprint } = require('../pipeline-updates/shot-definitions-validator.cjs');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const PHASE_22D = path.join(ARTIFACTS, 'phase2.2d');
const CAPTURE = path.join(ARTIFACTS, 'phase2.3b-s-authoritative-input');
const CANDIDATE = path.join(ARTIFACTS, 'phase2.3b-sv-candidate');

function tinyFixture() {
  const beat = {
    beatId: 'act1_b001', sequenceId: 'seq_act1_001', actKey: 'act1',
    startWordIndex: 0, endWordIndex: 2, startSec: 0, endSec: 4, durationSec: 4,
    narrationExcerpt: 'act1 alpha beta', storyFunction: 'establish',
    visualIntent: 'Establish a setting.', visualClass: 'EDITORIAL_ILLUSTRATION',
    visual: { type: 'STILL', description: 'A quiet street.', motionType: 'static_locked', secondaryAction: null },
    rhythmIntent: 'measured', graphics: null, audioDirection: null,
    evidenceRequirement: { required: false, evidenceType: null, description: null, sourceStatus: 'not_applicable', rightsStatus: 'not_applicable', authenticityStatus: 'not_applicable', citationLabel: null, humanReviewRequired: false },
    intentionalStillness: false, timingExceptionReason: null, postNarrationHoldSec: 0,
    reconstructionMode: null, motionIntent: { type: 'static_locked', secondaryAction: null }, continuityRefs: [],
  };
  const plan = {
    schemaVersion: '3.1.0', pipelineVersion: 3, channel: 'EmpireOmitted', episodeId: 'lineage-test', title: 'Lineage test',
    timing: { basis: 'finished_vo_word_timestamps', totalDurationSec: 4, acts: [{ actKey: 'act1', voKey: 'VO_Act1', startSec: 0, endSec: 4, durationSec: 4, wordCount: 3 }] },
    sequences: [{ sequenceId: beat.sequenceId, actKey: 'act1', sequencePurpose: 'Context.', directorIntent: 'Establish.', emotionalStateStart: 'curious', emotionalStateEnd: 'alert', knowledgeQuestion: null, knowledgeAnswer: null, createsQuestion: null, motifRefs: [], continuityRefs: [], beats: [beat] }],
  };
  const shot = {
    shotId: beat.beatId, beatId: beat.beatId, ...structuredClone(beat),
    visualType: beat.visual.type, motionTreatment: structuredClone(beat.motionIntent), overlaySpecification: null,
    triggerWord: 'act1', hardcodedSec: null, estimatedDuration: 4, assetType: 'generated_image', requiresGraphicCompilation: false,
    imagePrompt: 'Editorial still of a quiet street.', negativePrompt: 'No text or logos.', sourceSearchInstruction: null,
    animationPrompt: '', reconstructionSafeguards: null, colorGrade: 'neutral', sfx: null,
  };
  const shotDefs = { shotDefinitionVersion: '3.1.0', mode: 'empire-omitted-v3', sourceEditPlanSha256: planFingerprint(plan), episodeId: plan.episodeId, topic: 'Lineage test', title: plan.title, acts: { act1: [structuredClone(shot)] }, allShots: [shot], totalShots: 1 };
  return { plan, shotDefs };
}

function editShot(shotDefs, shotId, fieldPath, value) {
  const copies = shotDefs.allShots.filter(shot => shot.shotId === shotId);
  assert.ok(copies.length, `fixture shot ${shotId} exists`);
  for (const shot of copies) {
    const parts = fieldPath.split('.');
    let target = shot;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)] = structuredClone(value);
  }
}

function readShot(shot, fieldPath) {
  return fieldPath.split('.').reduce((value, key) => value?.[key], shot);
}

function makeLayer(parent, changes, { revisionId = 'test-revision', revisionVersion = 'test-v1', lineageRole = 'historical' } = {}) {
  const result = structuredClone(parent);
  const entries = changes.map(change => {
    const copies = result.allShots.filter(shot => shot.shotId === change.shotId);
    assert.ok(copies.length, `fixture shot ${change.shotId} exists`);
    const beforeValue = structuredClone(readShot(copies[0], change.fieldPath));
    editShot(result, change.shotId, change.fieldPath, change.afterValue);
    return {
      shotId: change.shotId, beatId: copies[0].beatId, fieldPath: change.fieldPath,
      beforeValue, afterValue: structuredClone(change.afterValue), reason: change.reason || 'Approved test fixture revision.',
      approvalStatus: 'APPROVED', revisionVersion,
    };
  });
  return {
    result,
    ledger: {
      ledgerVersion: '1.0.0', revisionId, revisionVersion, lineageRole, approvalStatus: 'APPROVED',
      approval: { status: 'APPROVED', basis: 'Explicit test fixture approval.' },
      parentArtifactSha256: artifactSha256(parent), resultArtifactSha256: artifactSha256(result),
      permittedImmutablePaths: [], entries,
    },
  };
}

function makeMirroredLayer(parent, changes, { revisionId = 'test-mirrored-revision' } = {}) {
  const result = structuredClone(parent);
  const entries = changes.map(change => {
    const canonical = result.allShots.filter(shot => shot.shotId === change.shotId);
    assert.equal(canonical.length, 1);
    const owner = canonical[0].actKey;
    const mirrors = result.acts?.[owner]?.filter(shot => shot.shotId === change.shotId && shot.beatId === canonical[0].beatId) || [];
    assert.equal(mirrors.length, 1);
    const beforeValue = structuredClone(readShot(canonical[0], change.fieldPath));
    editShot(result, change.shotId, change.fieldPath, change.afterValue);
    const segments = change.fieldPath.split('.');
    let target = mirrors[0];
    for (const segment of segments.slice(0, -1)) target = target[segment];
    target[segments.at(-1)] = structuredClone(change.afterValue);
    return { shotId: change.shotId, beatId: canonical[0].beatId, mirrorActKey: owner,
      fieldPath: change.fieldPath, beforeValue, afterValue: structuredClone(change.afterValue),
      reason: 'Approved mirrored test change.', approvalStatus: 'APPROVED', revisionVersion: 'test-v1' };
  });
  const ledger = { ledgerVersion: '1.0.0', revisionId, revisionVersion: 'test-v1', lineageRole: 'historical', approvalStatus: 'APPROVED',
    approval: { status: 'APPROVED', basis: 'Explicit mirrored fixture approval.' }, parentArtifactSha256: artifactSha256(parent),
    resultArtifactSha256: artifactSha256(result), permittedImmutablePaths: [], entries };
  return { result, ledger };
}

function adaptPhase22dLedger(raw) {
  const sourceLedgerSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(PHASE_22D, 'revision-ledger.phase2.2d.json'))).digest('hex');
  assert.equal(sourceLedgerSha256, 'ee483ff82b0f10e42279b0b6b9e4d6b3d4621872e7f605b485085c7456ecdc47');
  const sourceValidationReportSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(PHASE_22D, 'validation-report.phase2.2d.json'))).digest('hex');
  assert.equal(sourceValidationReportSha256, '314668001b6d18a130c353b8753d304f507a98960be096909673c34068a476c9');
  return {
    ledgerVersion: '1.0.0', revisionId: 'phase2.2d', revisionVersion: '2.2D', lineageRole: 'historical', approvalStatus: 'APPROVED',
    approval: { status: 'APPROVED', basis: 'Locked Phase 2.2D ledger and passing validation report; CTO directed this artifact to be treated as approved.' },
    sourceLedgerSha256,
    sourceValidationReportSha256,
    parentArtifactSha256: raw.sourceCandidateSha256, resultArtifactSha256: raw.revisedCandidateSha256,
    permittedImmutablePaths: [],
    entries: raw.fieldChanges.map(change => ({
      shotId: change.shotId, beatId: change.shotId, fieldPath: change.field,
      beforeValue: change.originalFieldValue, afterValue: change.revisedFieldValue,
      reason: change.reason, approvalStatus: 'APPROVED', revisionVersion: '2.2D',
    })),
  };
}

function loadRealLineageInputs() {
  const shotDefs = JSON.parse(fs.readFileSync(path.join(PHASE_22D, 'shot-definitions.phase2.2d.json'), 'utf8'));
  const rawLedger = JSON.parse(fs.readFileSync(path.join(PHASE_22D, 'revision-ledger.phase2.2d.json'), 'utf8'));
  const planPath = path.join(CAPTURE, 'authoritative-edit-plan.json');
  if (!fs.existsSync(planPath)) return null;
  return { shotDefs, plan: JSON.parse(fs.readFileSync(planPath, 'utf8')), history: adaptPhase22dLedger(rawLedger) };
}

test('locked Phase 2.2D shot definitions pass with the exact, hash-verified approved ledger', t => {
  const data = loadRealLineageInputs();
  if (!data) return t.skip('authoritative edit plan is a local Railway capture and is intentionally not committed');
  const report = validateShotDefinitions({ plan: data.plan, shotDefs: data.shotDefs, revisionChain: [data.history] });
  assert.equal(report.status, 'PASS', JSON.stringify(report.errors.slice(0, 5)));
  assert.equal(report.lineage.counts.approvedHistoricalRevisions, 24);
  assert.equal(report.lineage.counts.unapprovedDifferences, 0);
  assert.equal(report.errors.length, 0);
});

test('the same Phase 2.2D artifact fails without an explicitly supplied revision ledger', t => {
  const data = loadRealLineageInputs();
  if (!data) return t.skip('authoritative edit plan is a local Railway capture and is intentionally not committed');
  const report = validateShotDefinitions({ plan: data.plan, shotDefs: data.shotDefs });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.errors.filter(error => error.code === 'EDITORIAL_FIELD_MISMATCH').length, 24);
  assert.equal(report.lineage.counts.approvedHistoricalRevisions, 0);
  assert.equal(report.lineage.counts.unapprovedDifferences, 24);
});

test('a one-character change to a ledger-approved value fails the result and after-value checks', () => {
  const data = tinyFixture();
  const layer = makeLayer(data.shotDefs, [{ shotId: 'act1_b001', fieldPath: 'visual.description', afterValue: 'A quiet street at dawn.' }]);
  const altered = structuredClone(layer.result);
  editShot(altered, 'act1_b001', 'visual.description', 'A quiet street at dawn!');
  const result = validateRevisionChain({ shotDefs: altered, revisionChain: [layer.ledger] });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.errors.some(error => ['REVISION_RESULT_HASH', 'REVISION_AFTER_VALUE'].includes(error.code)));
});

test('an unrelated field alteration is rejected even when another field has an approved revision', () => {
  const data = tinyFixture();
  const layer = makeLayer(data.shotDefs, [{ shotId: 'act1_b001', fieldPath: 'visual.description', afterValue: 'A quiet street at dawn.' }]);
  const altered = structuredClone(layer.result);
  editShot(altered, 'act1_b001', 'imagePrompt', 'Unapproved unrelated prompt change.');
  assert.equal(validateRevisionChain({ shotDefs: altered, revisionChain: [layer.ledger] }).status, 'FAIL');
});

test('an incorrect ledger parent hash is rejected', () => {
  const data = tinyFixture();
  const layer = makeLayer(data.shotDefs, [{ shotId: 'act1_b001', fieldPath: 'visual.description', afterValue: 'A quiet street at dawn.' }]);
  const wrong = structuredClone(layer.ledger);
  wrong.parentArtifactSha256 = '0'.repeat(64);
  assert.ok(validateRevisionChain({ shotDefs: layer.result, revisionChain: [wrong] }).errors.some(error => error.code === 'REVISION_PARENT_HASH'));
});

test('duplicate revision entries are rejected', () => {
  const data = tinyFixture();
  const layer = makeLayer(data.shotDefs, [{ shotId: 'act1_b001', fieldPath: 'visual.description', afterValue: 'A quiet street at dawn.' }]);
  const duplicate = structuredClone(layer.ledger);
  duplicate.entries.push(structuredClone(duplicate.entries[0]));
  assert.ok(validateRevisionChain({ shotDefs: layer.result, revisionChain: [duplicate] }).errors.some(error => error.code === 'REVISION_ENTRY_DUPLICATE'));
});

test('approved mirrored fields reverse in allShots and act copies to the exact approved parent hash', t => {
  const file = path.join(CANDIDATE, 'candidate-shot-definitions-pretiming.json');
  if (!fs.existsSync(file)) return t.skip('canonical approved candidate shot fixture is not present locally');
  const parent = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(artifactSha256(parent), '6ab68c87b61c21b6b3bf74ee419885766c9603b021c0a9c8473be93715cdb71b');
  const owners = [['act2', 'ACT2_B026'], ['act3b', 'ACT3B_B018'], ['act5', 'ACT5_B022'], ['act5', 'ACT5_B023'], ['act5', 'ACT5_B027']];
  const changes = owners.map(([actKey, beatId]) => {
    const shot = parent.allShots.find(item => item.actKey === actKey && item.beatId === beatId);
    assert.ok(shot && typeof shot.timingExceptionReason === 'string' && shot.timingExceptionReason.length > 0);
    return { shotId: shot.shotId, fieldPath: 'timingExceptionReason', afterValue: null };
  });
  const layer = makeMirroredLayer(parent, changes);
  const result = validateRevisionChain({ shotDefs: layer.result, revisionChain: [layer.ledger] });
  assert.equal(result.status, 'PASS', JSON.stringify(result.errors));
  assert.equal(result.reconstructedParentHashes[0], '6ab68c87b61c21b6b3bf74ee419885766c9603b021c0a9c8473be93715cdb71b');
  for (const [actKey, beatId] of owners) {
    const flat = layer.result.allShots.find(item => item.actKey === actKey && item.beatId === beatId);
    const mirror = layer.result.acts[actKey].find(item => item.actKey === actKey && item.beatId === beatId);
    assert.equal(flat.timingExceptionReason, null);
    assert.equal(mirror.timingExceptionReason, null);
  }
});

test('mirrored revision reversal fails closed for missing, duplicate, wrong-owner, or disagreeing mirrors', () => {
  const data = tinyFixture();
  const layer = makeMirroredLayer(data.shotDefs, [{ shotId: 'act1_b001', fieldPath: 'visual.description', afterValue: 'Revised street.' }]);
  const cases = [
    ['missing', shotDefs => { shotDefs.acts.act1 = []; }],
    ['duplicate', shotDefs => { shotDefs.acts.act1.push(structuredClone(shotDefs.acts.act1[0] || layer.result.allShots[0])); }],
    ['wrong owner', shotDefs => { const mirror = shotDefs.acts.act1.pop(); shotDefs.acts.act2 = [mirror]; }],
    ['child disagreement', shotDefs => { shotDefs.acts.act1[0].visual.description = 'Different mirror.'; }],
  ];
  for (const [name, mutate] of cases) {
    const altered = structuredClone(layer.result); mutate(altered);
    layer.ledger.resultArtifactSha256 = artifactSha256(altered);
    const report = validateRevisionChain({ shotDefs: altered, revisionChain: [layer.ledger] });
    assert.equal(report.status, 'FAIL', name);
    assert.ok(report.errors.some(error => error.code.startsWith('REVISION_MIRROR_')), name);
    layer.ledger.resultArtifactSha256 = artifactSha256(layer.result);
  }
});

test('mirrored reversal rejects duplicate canonical identity, wrong child and altered prior values', () => {
  const data = tinyFixture();
  const layer = makeMirroredLayer(data.shotDefs, [{ shotId: 'act1_b001', fieldPath: 'visual.description', afterValue: 'Revised street.' }]);
  const duplicate = structuredClone(layer.result); duplicate.allShots.push(structuredClone(duplicate.allShots[0]));
  layer.ledger.resultArtifactSha256 = artifactSha256(duplicate);
  assert.ok(validateRevisionChain({ shotDefs: duplicate, revisionChain: [layer.ledger] }).errors.some(error => error.code === 'REVISION_SHOT_AMBIGUOUS'));
  layer.ledger.resultArtifactSha256 = artifactSha256(layer.result);

  const wrongChild = structuredClone(layer.result);
  wrongChild.allShots[0].visual.description = wrongChild.acts.act1[0].visual.description = 'Unapproved child.';
  layer.ledger.resultArtifactSha256 = artifactSha256(wrongChild);
  assert.ok(validateRevisionChain({ shotDefs: wrongChild, revisionChain: [layer.ledger] }).errors.some(error => error.code === 'REVISION_AFTER_VALUE'));

  layer.ledger.resultArtifactSha256 = artifactSha256(layer.result);
  const alteredPrior = structuredClone(layer.ledger); alteredPrior.entries[0].beforeValue = 'Altered parent.';
  assert.ok(validateRevisionChain({ shotDefs: layer.result, revisionChain: [alteredPrior] }).errors.some(error => error.code === 'REVISION_PARENT_HASH'));
});

test('unrecorded mirrored mutation fails parent reconstruction and multiple mirrored fields reverse generically', () => {
  const data = tinyFixture();
  const layer = makeMirroredLayer(data.shotDefs, [
    { shotId: 'act1_b001', fieldPath: 'visual.description', afterValue: 'Revised street.' },
    { shotId: 'act1_b001', fieldPath: 'rhythmIntent', afterValue: 'impact' },
  ]);
  // A separate field changed in the mirror but not in the ledger must remain
  // visible in the reconstructed hash and prevent a false pass.
  const unrecorded = structuredClone(layer.result);
  unrecorded.acts.act1[0].imagePrompt = 'Unrecorded mirror mutation.';
  layer.ledger.resultArtifactSha256 = artifactSha256(unrecorded);
  const failed = validateRevisionChain({ shotDefs: unrecorded, revisionChain: [layer.ledger] });
  assert.equal(failed.status, 'FAIL');
  assert.ok(failed.errors.some(error => error.code === 'REVISION_PARENT_HASH'));

  layer.ledger.resultArtifactSha256 = artifactSha256(layer.result);
  const passed = validateRevisionChain({ shotDefs: layer.result, revisionChain: [layer.ledger] });
  assert.equal(passed.status, 'PASS', JSON.stringify(passed.errors));
  assert.deepEqual(passed.reconstructedParentHashes, [artifactSha256(data.shotDefs)]);
});

test('unknown shot IDs and fields are rejected', () => {
  const data = tinyFixture();
  const layer = makeLayer(data.shotDefs, [{ shotId: 'act1_b001', fieldPath: 'visual.description', afterValue: 'A quiet street at dawn.' }]);
  const unknownShot = structuredClone(layer.ledger);
  unknownShot.entries.push({ ...unknownShot.entries[0], shotId: 'ghost', beatId: 'ghost', fieldPath: 'visual.description' });
  assert.ok(validateRevisionChain({ shotDefs: layer.result, revisionChain: [unknownShot] }).errors.some(error => error.code === 'REVISION_SHOT_UNKNOWN'));
  const unknownField = structuredClone(layer.ledger);
  unknownField.entries[0].fieldPath = 'visual.unrecognizedField';
  assert.ok(validateRevisionChain({ shotDefs: layer.result, revisionChain: [unknownField] }).errors.some(error => error.code === 'REVISION_FIELD_UNKNOWN'));
});

test('reordered shots are rejected even when a valid ledger is supplied', t => {
  const data = loadRealLineageInputs();
  if (!data) return t.skip('authoritative edit plan is a local Railway capture and is intentionally not committed');
  const altered = structuredClone(data.shotDefs);
  [altered.allShots[0], altered.allShots[1]] = [altered.allShots[1], altered.allShots[0]];
  const report = validateShotDefinitions({ plan: data.plan, shotDefs: altered, revisionChain: [data.history] });
  assert.equal(report.status, 'FAIL');
  assert.ok(report.errors.some(error => error.code === 'BEAT_ORDER' || error.code === 'REVISION_RESULT_HASH'));
});

test('the approved two-act pre-timing amendment passes only with both verified lineage layers', t => {
  const files = ['candidate-edit-plan-pretiming.json', 'candidate-shot-definitions-pretiming.json', 'candidate-production-manifest-pretiming.json', 'revision-ledger.phase2.2d-lineage.v1.json', 'revision-ledger.phase2.3b-sv-amendment.v1.json'];
  if (!files.every(file => fs.existsSync(path.join(CANDIDATE, file)))) return t.skip('durable candidate package is created after lineage diagnosis');
  const plan = JSON.parse(fs.readFileSync(path.join(CANDIDATE, files[0]), 'utf8'));
  const shotDefs = JSON.parse(fs.readFileSync(path.join(CANDIDATE, files[1]), 'utf8'));
  const history = JSON.parse(fs.readFileSync(path.join(CANDIDATE, files[3]), 'utf8'));
  const amendment = JSON.parse(fs.readFileSync(path.join(CANDIDATE, files[4]), 'utf8'));
  const report = validateShotDefinitions({ plan, shotDefs, revisionChain: [history, amendment] });
  assert.equal(report.status, 'PASS', JSON.stringify(report.errors.slice(0, 10)));
  assert.equal(report.lineage.counts.approvedHistoricalRevisions, 23);
  assert.equal(report.lineage.counts.currentApprovedAmendments, amendment.entries.length);
  assert.equal(report.lineage.counts.unapprovedDifferences, 0);
});

test('an extra candidate change outside the amendment ledger fails', t => {
  const files = ['candidate-edit-plan-pretiming.json', 'candidate-shot-definitions-pretiming.json', 'revision-ledger.phase2.2d-lineage.v1.json', 'revision-ledger.phase2.3b-sv-amendment.v1.json'];
  if (!files.every(file => fs.existsSync(path.join(CANDIDATE, file)))) return t.skip('durable candidate package is created after lineage diagnosis');
  const plan = JSON.parse(fs.readFileSync(path.join(CANDIDATE, files[0]), 'utf8'));
  const shotDefs = JSON.parse(fs.readFileSync(path.join(CANDIDATE, files[1]), 'utf8'));
  const history = JSON.parse(fs.readFileSync(path.join(CANDIDATE, files[2]), 'utf8'));
  const amendment = JSON.parse(fs.readFileSync(path.join(CANDIDATE, files[3]), 'utf8'));
  shotDefs.allShots[0].imagePrompt += ' Unapproved addition.';
  const report = validateShotDefinitions({ plan, shotDefs, revisionChain: [history, amendment] });
  assert.equal(report.status, 'FAIL');
  assert.ok(report.errors.some(error => error.code.startsWith('REVISION_')));
});

test('legacy episodes without revisions retain strict existing behavior', () => {
  const data = tinyFixture();
  assert.equal(validateShotDefinitions({ plan: data.plan, shotDefs: data.shotDefs }).status, 'PASS');
  const altered = structuredClone(data.shotDefs);
  editShot(altered, 'act1_b001', 'visual.description', 'Unapproved drift.');
  assert.equal(validateShotDefinitions({ plan: data.plan, shotDefs: altered }).status, 'FAIL');
});

test('revision validation makes no HTTP or HTTPS provider requests', () => {
  const oldHttp = http.request, oldHttps = https.request;
  let requests = 0;
  http.request = https.request = () => { requests++; throw new Error('Network calls are prohibited in this test.'); };
  try {
    const data = tinyFixture();
    assert.equal(validateShotDefinitions({ plan: data.plan, shotDefs: data.shotDefs }).status, 'PASS');
    const layer = makeLayer(data.shotDefs, [{ shotId: 'act1_b001', fieldPath: 'visual.description', afterValue: 'A quiet street at dawn.' }]);
    assert.equal(validateRevisionChain({ shotDefs: layer.result, revisionChain: [layer.ledger] }).status, 'PASS');
    assert.equal(requests, 0);
  } finally { http.request = oldHttp; https.request = oldHttps; }
});
