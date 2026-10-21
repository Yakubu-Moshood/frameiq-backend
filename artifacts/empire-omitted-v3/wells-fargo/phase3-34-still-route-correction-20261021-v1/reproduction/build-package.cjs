'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const WELLS = path.join(ROOT, 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const OUT = path.join(WELLS, 'phase3-34-still-route-correction-20261021-v1');
const PACKAGE_ID = path.basename(OUT);
const CANDIDATE = path.join(WELLS, 'phase3-consolidated-act5-production-candidate-20261004-v5');
const CANDIDATE_ROOT = path.join(CANDIDATE, 'candidate');
const MANIFEST_PATH = path.join(CANDIDATE_ROOT, 'production-manifest.json');
const SHOTS_PATH = path.join(CANDIDATE_ROOT, 'shot-definitions.json');
const EVIDENCE_PATH = path.join(CANDIDATE_ROOT, 'evidence-source-manifest.json');
const GRAPHICS_PATH = path.join(CANDIDATE_ROOT, 'graphic-asset-manifest.json');
const CANDIDATE_INDEX_PATH = path.join(CANDIDATE, 'package-index.v2.json');
const REJECTED_PACKAGE = path.join(WELLS, 'phase3-consolidated-completion-review-20261021-v1');
const REJECTED_INDEX_PATH = path.join(REJECTED_PACKAGE, 'package-index.v1.json');
const REJECTED_MATRIX_PATH = path.join(REJECTED_PACKAGE, 'controlled-still-matrix.v1.json');
const REJECTED_CONSTRUCTION_PATH = path.join(REJECTED_PACKAGE, 'controlled-still-construction-record.v1.json');

const read = file => fs.readFileSync(file);
const parse = file => JSON.parse(read(file).toString('utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaText = text => sha(Buffer.from(text, 'utf8'));
const shaFile = file => sha(read(file));
const bytesJson = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const writeJson = (name, value) => write(path.join(OUT, name), bytesJson(value));
const relOut = file => path.relative(OUT, file).replaceAll('\\', '/');
const relRoot = file => path.relative(ROOT, file).replaceAll('\\', '/');
const clone = value => JSON.parse(JSON.stringify(value));

const productionManifest = parse(MANIFEST_PATH);
const shotDefinitions = parse(SHOTS_PATH);
const evidenceManifest = parse(EVIDENCE_PATH);
const graphicManifest = parse(GRAPHICS_PATH);
const rejectedIndex = parse(REJECTED_INDEX_PATH);
const rejectedMatrix = parse(REJECTED_MATRIX_PATH);
const rejectedConstruction = parse(REJECTED_CONSTRUCTION_PATH);
const shotById = new Map(shotDefinitions.allShots.map(row => [row.beatId, row]));
const controlled = productionManifest.shots.filter(row => row.productionMethod === 'CONTROLLED_STILL' && row.assetType === 'controlled_image');
if (controlled.length !== 34) throw new Error(`EXPECTED_34_CONTROLLED_STILLS_GOT_${controlled.length}`);
if (productionManifest.shots.some(row => row.shotId === 'ACT3B_B010')) throw new Error('ACT3B_B010_RETIREMENT_NOT_PRESERVED');
if (shaFile(REJECTED_INDEX_PATH) !== '8ea25ef485e127a70e43fa2867a15d611be174c9925dcc59d5216448f79ce3e6') throw new Error('REJECTED_PACKAGE_INDEX_HASH_MISMATCH');

const route = Object.freeze({
  productionMethod: 'GENERATED_STILL', assetType: 'generated_image', provider: 'FLUX 3',
  endpoint: 'blackforestlabs/flux-3/text-to-image', resolution: '1k', aspectRatio: '16:9',
  outputFormat: 'PNG', imagesPerBeat: 1, promptExpansion: false, retries: 0, fallback: false,
  maximumSubmissions: 34, unitMaximumExposureUsd: 0.048, maximumExposureUsd: 1.632,
  providerEnforced: false, executionAuthorized: false
});

const twoStageText = Object.freeze({
  ACT1_B011: ['ACCOUNT APPLICATION', 'CUSTOMER CONSENT: NOT PRESENT'],
  ACT1_B012: ['CREDIT CARD', 'CHECKING', 'SAVINGS', 'SIGNATURE'],
  ACT1_B020: ['REQUESTED: NO', 'SIGNED: NO'],
  ACT1_B022: ['EMAIL', 'CUSTOMER IDENTITY'],
  ACT2_B011: ['SAVINGS'],
  ACT2_B012: ['SAVINGS', 'CREDIT CARD'],
  ACT2_B013: ['MORTGAGE'],
  ACT2_B015: ['1', '2', '3', '4', '5', '6', '7', '8'],
  ACT2_B020: ['SALES TARGET', 'PERFORMANCE REVIEW'],
  ACT2_B021: ['BONUS', 'CAREER STATUS'],
  ACT3_B006: ['CHECKING', 'SAVINGS', 'CREDIT CARD'],
  ACT3_B007: ['CREDIT CARD', 'ONLINE BANKING', 'PASSWORD'],
  ACT3_B010: ['EMAIL ADDRESS'],
  ACT3_B020: ['DAILY QUOTA', 'PROGRESS'],
  ACT3B_B001: ['ACCOUNT SUMMARY'],
  ACT3B_B004: ['ANNUAL FEE']
});

const commonPositive = [
  'Cinematic documentary-style editorial reconstruction for a serious investigative film.',
  'Create one finished production-grade 16:9 frame with realistic lighting, natural materials, controlled depth, strong focal hierarchy, intentional negative space, and sufficient fine detail for full-resolution final-episode use.',
  'Make the imagery specific to this beat and do not reuse a composition, character arrangement, document layout, interface layout, or final image from any other beat.',
  'Use only anonymous fictional people where people are needed; do not reproduce a real customer, employee, executive, branch, office, or bank location.',
  'Use fictionalized unbranded interfaces and documents. Treat the scene as a representative reconstruction, never as documentary evidence.'
].join(' ');
const commonNegative = [
  'No real bank logos, Wells Fargo branding, stagecoach marks, trademarks, recognizable uniforms, or identifiable real locations.',
  'No identifiable real customers, employees, executives, celebrities, public figures, or news-footage likenesses.',
  'No unsupported documentary-evidence appearance, surveillance-footage claim, authentic-record claim, or fabricated real document.',
  'No malformed hands, extra fingers, fused fingers, malformed faces, distorted anatomy, duplicated limbs, impossible objects, broken perspective, or incoherent reflections.',
  'No generated readable text, gibberish, misspelled labels, pseudo-letters, fake logos, watermarks, signatures, captions, or UI copy.',
  'No cross-beat image sharing, repeated template composition, duplicate final media, stock-placeholder look, flat icon art, primitive vector diagram, clip art, low detail, large accidental blank areas, or unfinished surfaces.',
  'No historically inappropriate props, implausible environment, melodramatic caricature, graphic illness, or sensationalized victim imagery.',
  'Documents and interfaces must be fictionalized and text-free at generation time; any essential semantic typography is added deterministically and locally after generation.'
].join(' ');

const promptContracts = controlled.map((before, ordinal) => {
  const shot = shotById.get(before.shotId);
  if (!shot) throw new Error(`MISSING_SHOT_${before.shotId}`);
  const labels = twoStageText[before.shotId] || null;
  const positivePrompt = `${commonPositive} Beat ID: ${before.shotId}. Narration context: “${shot.narrationExcerpt}” Visual intent: ${shot.visualIntent} Scene direction: ${shot.imagePrompt} ${labels ? 'Generate the photographic or illustrative base with clean text-free surfaces reserved for deterministic local typography; do not ask the image model to render critical readable text.' : 'Keep any incidental writing fully abstract and non-semantic.'}`;
  const negativeInstructions = `${commonNegative} Beat-specific exclusions: ${shot.negativePrompt || 'none beyond the common contract'}.`;
  const positivePromptSha256 = shaText(positivePrompt);
  const negativeInstructionsSha256 = shaText(negativeInstructions);
  const routeContractSha256 = shaText(JSON.stringify(route));
  const requestKey = shaText(`${PACKAGE_ID}|${String(ordinal + 1).padStart(2, '0')}|${before.shotId}|GENERATE_REPLACEMENT_FINAL_STILL|${positivePromptSha256}|${negativeInstructionsSha256}|${routeContractSha256}`);
  return {
    ordinal: ordinal + 1, beatId: before.shotId, narration: shot.narrationExcerpt,
    timing: { startSec: shot.startSec, endSec: shot.endSec, durationSec: shot.durationSec, startWordIndex: shot.startWordIndex, endWordIndex: shot.endWordIndex },
    visualIntent: shot.visualIntent, evidenceBinding: clone(shot.evidenceRequirement), ownershipAndIdentityBinding: { actKey: shot.actKey, sequenceId: shot.sequenceId, shotId: shot.shotId, beatId: shot.beatId },
    positivePrompt, positivePromptSha256, negativeInstructions, negativeInstructionsSha256,
    twoStageRoute: labels ? { required: true, stage1: 'Generate the finished base image without readable text.', stage2: 'Apply deterministic locally rendered typography/interface content after base-image approval.', exactLocalSemanticLabels: labels, imageModelCriticalTextProhibited: true } : { required: false, imageModelCriticalTextProhibited: true },
    requestKey, requestKeyStatus: 'PROPOSED_UNUSED_NOT_RESERVED', route
  };
});
if (new Set(promptContracts.map(row => row.requestKey)).size !== 34) throw new Error('DUPLICATE_REPLACEMENT_REQUEST_KEY');

const rejectionStatement = 'Reject the 33 controlled-still PNGs in package index 8ea25ef485e127a70e43fa2867a15d611be174c9925dcc59d5216448f79ce3e6. Reason: the read-only visual audit found 0/33 suitable for production. They are simplified construction placeholders, contain prohibited cross-beat duplication and do not meet final-episode visual quality. Do not revise those placeholders individually.';
const rejectedPngs = rejectedConstruction.outputs.map(row => ({ beatId: row.beatId, path: `phase3-consolidated-completion-review-20261021-v1/${row.relativePath}`, bytes: row.bytes, sha256: row.sha256 }));
writeJson('controlled-still-rejection-record.v1.json', {
  schemaVersion: 'phase3-controlled-still-human-rejection/1.0.0', status: 'REJECTED_ALL_33_CONSTRUCTED_CONTROLLED_STILLS',
  decisionSource: 'Explicit user instruction following read-only visual-quality audit', decisionDate: '2026-10-21',
  exactDecisionText: rejectionStatement, exactDecisionTextSha256: shaText(rejectionStatement),
  rejectedPackageIndex: { path: relRoot(REJECTED_INDEX_PATH), sha256: shaFile(REJECTED_INDEX_PATH), fileCount: rejectedIndex.fileCount },
  auditResult: { inspectedContactSheets: 3, inspectedFullResolutionPngs: 33, suitableForProduction: 0, rejected: 33,
    findings: ['SIMPLIFIED_CONSTRUCTION_PLACEHOLDERS', 'PROHIBITED_CROSS_BEAT_DUPLICATION', 'FINAL_EPISODE_VISUAL_QUALITY_NOT_MET'] },
  duplicateGroups: [
    { beatIds: ['ACT1_B022', 'ACT3_B007', 'ACT3B_B013'], sha256: 'd980414d86445772fb6d3538a47921acf711eb7c7faceab03afb1194286c3cfb' },
    { beatIds: ['ACT1_B020', 'ACT5_B010'], sha256: 'a212bb1195428b2830c6397c2ea81c0a6cb48fcf51be2de8186284e3e5bb89f3' }
  ],
  rejectedPngs, authority: { mediaGeneration: false, providerSubmission: false, executionAuthorization: false, productionInstallation: false }
});

const amendmentRows = controlled.map(before => {
  const after = clone(before); after.productionMethod = route.productionMethod; after.assetType = route.assetType;
  const contract = promptContracts.find(row => row.beatId === before.shotId);
  return {
    beatId: before.shotId, before, after,
    changedFields: [
      { path: 'productionMethod', before: 'CONTROLLED_STILL', after: 'GENERATED_STILL' },
      { path: 'assetType', before: 'controlled_image', after: 'generated_image' }
    ],
    positivePromptSha256: contract.positivePromptSha256,
    negativeInstructionsSha256: contract.negativeInstructionsSha256,
    requestKey: contract.requestKey
  };
});
writeJson('exact-34-row-route-amendment.v1.json', {
  schemaVersion: 'phase3-controlled-to-generated-still-route-amendment/1.0.0', status: 'PROPOSED_NON_AUTHORIZING_UNAPPLIED',
  rowCount: amendmentRows.length, sourceManifest: { path: relRoot(MANIFEST_PATH), sha256: shaFile(MANIFEST_PATH) },
  route, preservationContract: {
    unchanged: ['beat IDs', 'narration', 'timing and frame allocation', 'visual intent', 'evidence bindings', 'ownership fields', 'all unrelated candidate records', 'ACT3B_B010 retirement', 'completed ACT1_B006 production records', 'completed ACT1_B009 production records', 'completed ACT1_B010 production records'],
    onlyCandidateFieldChanges: ['productionMethod', 'assetType']
  }, rows: amendmentRows,
  authority: { amendmentApplied: false, candidateModified: false, providerSubmission: false, executionAuthorization: false }
});

function diffPaths(a, b, prefix = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return [prefix];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap(key => diffPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key));
}
const differenceRows = amendmentRows.map(row => ({ beatId: row.beatId, beforeRecordSha256: shaText(JSON.stringify(row.before)), afterRecordSha256: shaText(JSON.stringify(row.after)), changedPaths: diffPaths(row.before, row.after), unchangedFieldCount: Object.keys(row.before).length - 2 }));
if (differenceRows.some(row => JSON.stringify(row.changedPaths) !== JSON.stringify(['assetType', 'productionMethod']))) throw new Error('AMENDMENT_CHANGED_MORE_THAN_TWO_FIELDS');
writeJson('before-after-difference-report.v1.json', {
  schemaVersion: 'phase3-route-amendment-difference-report/1.0.0', status: 'PASS_ONLY_PRODUCTION_METHOD_AND_ASSET_TYPE_CHANGE',
  rowCount: 34, changedPathUnion: ['assetType', 'productionMethod'], changedValueCount: 68,
  sourceManifestSha256: shaFile(MANIFEST_PATH), rows: differenceRows,
  globalPreservationChecks: { shotDefinitionsUnmodifiedSha256: shaFile(SHOTS_PATH), evidenceManifestUnmodifiedSha256: shaFile(EVIDENCE_PATH), graphicManifestUnmodifiedSha256: shaFile(GRAPHICS_PATH), unrelatedManifestRowsChanged: 0, act3bB010RemainsRetired: true }
});

writeJson('prompt-and-negative-contracts.v1.json', {
  schemaVersion: 'phase3-generated-still-prompt-contracts/1.0.0', status: 'PROPOSED_NON_AUTHORIZING',
  rowCount: 34, route, requirements: {
    cinematicDocumentaryStyle: true, beatSpecificImagery: true, crossBeatSharingAllowed: false,
    realBankLogosOrTrademarksAllowed: false, identifiableRealPeopleAllowed: false,
    unsupportedDocumentaryEvidenceClaimsAllowed: false, malformedAnatomyOrObjectsAllowed: false,
    generatedCriticalReadableTextAllowed: false, fictionalizedInterfacesAndDocumentsOnly: true,
    historicalAndNarrativeAppropriatenessRequired: true, finalEpisodeDetailRequired: true
  }, rows: promptContracts
});

function collectRequestKeys(value, out = new Set()) {
  if (Array.isArray(value)) { for (const item of value) collectRequestKeys(item, out); return out; }
  if (!value || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    if (/requestkey/i.test(key) && typeof item === 'string' && /^[0-9a-f]{64}$/u.test(item)) out.add(item);
    collectRequestKeys(item, out);
  }
  return out;
}
const existingKeySet = new Set();
function scanJson(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, ent.name);
    if (file.startsWith(OUT)) continue;
    if (ent.isDirectory()) scanJson(file);
    else if (ent.isFile() && ent.name.endsWith('.json')) { try { collectRequestKeys(parse(file), existingKeySet); } catch {} }
  }
}
scanJson(WELLS);
const collisions = promptContracts.filter(row => existingKeySet.has(row.requestKey)).map(row => row.beatId);
if (collisions.length) throw new Error(`REQUEST_KEY_COLLISION_${collisions.join('_')}`);
writeJson('request-key-reconciliation.v1.json', {
  schemaVersion: 'phase3-34-generated-still-request-key-reconciliation/1.0.0', status: 'PASS_ALL_34_PROPOSED_KEYS_UNUSED_AND_UNRESERVED',
  knownExistingRequestKeyCount: existingKeySet.size, proposedRequestKeyCount: 34, uniqueProposedRequestKeyCount: new Set(promptContracts.map(row => row.requestKey)).size,
  collisions, requestKeys: promptContracts.map(row => ({ beatId: row.beatId, requestKey: row.requestKey, status: row.requestKeyStatus })),
  reservationAuthority: false
});

const batches = [promptContracts.slice(0, 10), promptContracts.slice(10, 20), promptContracts.slice(20, 30), promptContracts.slice(30, 34)];
const batchRecords = [];
for (let index = 0; index < batches.length; index++) {
  const rows = batches[index]; const batchNumber = index + 1;
  const maximumExposureUsd = Number((rows.length * route.unitMaximumExposureUsd).toFixed(3));
  const record = {
    schemaVersion: 'phase3-bounded-non-authorizing-generated-still-batch/1.0.0', status: 'PROPOSED_NON_AUTHORIZING',
    batchId: `phase3-34-replacement-stills-batch-${batchNumber}`, requestCount: rows.length,
    provider: route.provider, endpoint: route.endpoint, parameters: { resolution: route.resolution, aspectRatio: route.aspectRatio, outputFormat: route.outputFormat, imagesPerRequest: 1, promptExpansion: false },
    retries: 0, fallback: false, unitMaximumExposureUsd: route.unitMaximumExposureUsd, expectedExposureUsd: maximumExposureUsd, maximumExposureUsd, providerEnforced: false,
    entries: rows.map(row => ({ beatId: row.beatId, operation: 'GENERATE_REPLACEMENT_FINAL_STILL', requestKey: row.requestKey, positivePromptSha256: row.positivePromptSha256, negativeInstructionsSha256: row.negativeInstructionsSha256, dependencyHashes: { candidateIndexSha256: shaFile(CANDIDATE_INDEX_PATH), productionManifestSha256: shaFile(MANIFEST_PATH), shotDefinitionsSha256: shaFile(SHOTS_PATH), amendmentSha256: null }, expectedOutputContract: { mediaType: 'image/png', resolution: '1k', aspectRatio: '16:9', imageCount: 1, isolatedReviewRelativePath: `generated-stills/${row.beatId}.png`, productionPathInstallationAuthorized: false }, twoStageTextRouteRequired: row.twoStageRoute.required })),
    authority: { providerSubmissionsAuthorized: 0, requestKeysReserved: 0, executionAuthorizationCreated: false, generation: false, productionInstallation: false, rendering: false, promotion: false }
  };
  const name = `provider-batches/replacement-generated-stills-batch-${batchNumber}.v1.json`;
  writeJson(name, record);
  batchRecords.push({ batchId: record.batchId, path: name, requestCount: rows.length, expectedExposureUsd: maximumExposureUsd, maximumExposureUsd, sha256: shaFile(path.join(OUT, name)) });
}
if (batchRecords.reduce((sum, row) => sum + row.requestCount, 0) !== 34) throw new Error('BATCH_REQUEST_COUNT_INVALID');
if (Number(batchRecords.reduce((sum, row) => sum + row.maximumExposureUsd, 0).toFixed(3)) !== 1.632) throw new Error('BATCH_EXPOSURE_INVALID');

const existingBatchNames = [
  'generated-final-still-batch.v1.json', 'animation-source-still-batch-1.v1.json', 'animation-source-still-batch-2.v1.json', 'animation-source-still-batch-3.v1.json',
  'animation-batch-1.v1.json', 'animation-batch-2.v1.json', 'animation-batch-3.v1.json'
];
const existingBatches = existingBatchNames.map(name => {
  const file = path.join(REJECTED_PACKAGE, 'provider-batches', name); const record = parse(file);
  return { path: relRoot(file), sha256: shaFile(file), requestCount: record.requestCount, expectedExposureUsd: record.expectedExposureUsd, maximumExposureUsd: record.maximumExposureUsd, status: record.status };
});
const previousRequests = existingBatches.reduce((sum, row) => sum + row.requestCount, 0);
const previousExposure = Number(existingBatches.reduce((sum, row) => sum + row.maximumExposureUsd, 0).toFixed(3));
if (previousRequests !== 49 || previousExposure !== 9.744) throw new Error('EXISTING_SEVEN_MANIFEST_RECONCILIATION_FAILED');
writeJson('existing-seven-provider-manifests-reconciliation.v1.json', {
  schemaVersion: 'phase3-existing-provider-manifest-reconciliation/1.0.0', status: 'PASS_EXISTING_SEVEN_MANIFESTS_UNCHANGED',
  manifestCount: 7, requestCount: previousRequests, maximumExposureUsd: previousExposure, providerEnforced: false, manifests: existingBatches,
  dependencyRule: 'Every animation remains blocked until its corresponding animation-source still is generated, inspected, human-approved, and SHA-256-bound to a separate animation authorization.',
  authority: { providerSubmission: false, executionAuthorization: false }
});
writeJson('exposure-and-submission-reconciliation.v1.json', {
  schemaVersion: 'phase3-route-correction-exposure-reconciliation/1.0.0', status: 'PASS_ARITHMETIC_EXACT',
  arithmetic: {
    replacementGeneratedStills: { submissions: 34, unitMaximumExposureUsd: 0.048, maximumExposureUsd: 1.632, equation: '34 × 0.048 = 1.632' },
    previousProviderPlan: { submissions: 49, maximumExposureUsd: 9.744 },
    revisedProviderPlan: { submissions: 83, maximumExposureUsd: 11.376, submissionsEquation: '34 + 7 + 21 + 21 = 83', exposureEquation: '9.744 + 1.632 = 11.376' }
  }, discrepancy: null, providerEnforced: false
});

writeJson('human-review-and-rejection-criteria.v1.json', {
  schemaVersion: 'phase3-generated-still-human-review-criteria/1.0.0', status: 'PROPOSED_REVIEW_GATE',
  scope: { beats: 34, everyOutputRequiresIndividualHumanReview: true, batchApprovalDoesNotApproveOutputs: true },
  approvalCriteria: [
    'Exact beat, narration, timing context and locked visual intent are served.',
    'Image is cinematic documentary-style editorial reconstruction with production-grade detail at full resolution.',
    'Composition is unique to the beat and is neither byte-identical nor perceptually shared with another beat.',
    'No real bank logo, trademark, identifiable real customer, employee, executive or location is present.',
    'Image cannot reasonably be mistaken for authentic documentary evidence of a specific event, person, record or location.',
    'Hands, faces, anatomy, objects, perspective and reflections are coherent and artifact-free.',
    'Fictional interfaces and documents are plausible, unbranded and appropriate to the historical/narrative setting.',
    'Frame has intentional composition, adequate detail, readable focal hierarchy and no accidental blank regions.',
    'For two-stage beats, the generated base contains no critical generated text and has approved clean surfaces for deterministic local typography.',
    'After local typography, all required semantic text is exact, readable, correctly spelled and separately hash-bound.'
  ],
  rejectionCriteria: [
    'Any cross-beat reuse, exact duplicate, perceptual duplicate, template reuse that defeats beat specificity, or generic placeholder composition.',
    'Any malformed hand, face, limb, object, perspective, reflection, duplicated subject or visual-generation artifact.',
    'Any real or imitation bank logo/trademark, identifiable real person, unsupported documentary-evidence implication, or fabricated authentic record.',
    'Any generated gibberish, unreadable critical text, misspelling, incorrect semantic label or request for the model to render critical readable text.',
    'Any mismatch with narration, visual intent, period, environment, evidence/ownership safeguard, or final-episode quality threshold.',
    'Any low-detail, flat-icon, primitive-vector, clip-art, construction-placeholder or unfinished appearance.'
  ],
  downstreamGate: 'No output may be installed, rendered or promoted until individually inspected, approved, SHA-256-bound and admitted by a separately authorized production step.'
});

const rejectionRecordPath = path.join(OUT, 'controlled-still-rejection-record.v1.json');
writeJson('revision-lineage.v1.json', {
  schemaVersion: 'phase3-34-still-route-correction-lineage/1.0.0', status: 'BOUND_TO_REJECTED_PACKAGE_AND_HUMAN_REJECTION',
  parentCandidate: { path: relRoot(CANDIDATE_INDEX_PATH), sha256: shaFile(CANDIDATE_INDEX_PATH) },
  rejectedPlaceholderPackage: { path: relRoot(REJECTED_INDEX_PATH), sha256: shaFile(REJECTED_INDEX_PATH), controlledStillMatrixSha256: shaFile(REJECTED_MATRIX_PATH), constructionRecordSha256: shaFile(REJECTED_CONSTRUCTION_PATH) },
  visualAuditAndHumanRejection: { recordPath: relOut(rejectionRecordPath), recordSha256: shaFile(rejectionRecordPath), decisionTextSha256: shaText(rejectionStatement), inspected: 33, passed: 0, rejected: 33 },
  amendmentIntent: { from: { productionMethod: 'CONTROLLED_STILL', assetType: 'controlled_image' }, to: { productionMethod: 'GENERATED_STILL', assetType: 'generated_image' }, rows: 34, allOtherCandidateFieldsPreserved: true },
  preservedState: { act3bB010Retirement: true, completedProductionRecordsUnaffected: ['ACT1_B006', 'ACT1_B009', 'ACT1_B010'], sourceCandidateModified: false }
});

const approvalWording = `I approve the non-authorizing Phase 3 34-still route-correction package ${PACKAGE_ID}, bound to its package-index SHA-256 supplied with the final review. I approve the exact 34-row amendment changing only productionMethod from CONTROLLED_STILL to GENERATED_STILL and assetType from controlled_image to generated_image, including ACT1_B005, while preserving every listed locked field and all unrelated candidate and completed production records. I approve the four bounded replacement-still manifests containing 10, 10, 10 and 4 proposed FLUX 3 requests, and accept USD 1.632 as the maximum human-approved replacement-still exposure, not provider-enforced. I acknowledge the reconciled total remaining provider plan of 83 submissions and USD 11.376 maximum planned exposure. I approve the prompt, negative-instruction, two-stage local-typography and human-review contracts as planning inputs only. This approval creates no execution authorization, reserves no request key, and authorizes no provider submission, retry, fallback, media generation, production-path installation, Stage04 modification, rendering, promotion, deployment, commit or push. Every future provider batch requires a separate exact authorization, and every generated image requires individual inspection and human approval before downstream use. Every animation remains blocked until its source still is generated, inspected, explicitly human-approved and SHA-256-bound.`;
write(path.join(OUT, 'exact-human-approval-wording.md'), Buffer.from(`# Exact proposed human approval wording\n\n> ${approvalWording}\n`, 'utf8'));

writeJson('updated-master-completion-docket.v1.json', {
  schemaVersion: 'phase3-master-completion-docket/2.0.0', status: 'PHASE3_34_STILL_ROUTE_CORRECTION_PENDING_HUMAN_APPROVAL',
  repository: { commit: '316177e7595e2e0874e298352cf77374a2fb9f84', branch: 'codex/phase3-controlled-media-pilot' },
  rejection: { rejectedPlaceholderPackageIndexSha256: shaFile(REJECTED_INDEX_PATH), rejectedConstructedStills: 33, passedVisualReview: 0, disposition: 'DO_NOT_REVISE_PLACEHOLDERS_INDIVIDUALLY' },
  routeCorrection: { affectedBeats: 34, includesAct1B005: true, from: { productionMethod: 'CONTROLLED_STILL', assetType: 'controlled_image' }, to: { productionMethod: 'GENERATED_STILL', assetType: 'generated_image' }, route, amendmentApplied: false },
  replacementBatches: batchRecords,
  existingSevenProviderManifests: { unchanged: true, manifestCount: 7, requestCount: 49, maximumExposureUsd: 9.744 },
  revisedRemainingPlan: { replacementGeneratedStills: 34, existingGeneratedFinalStills: 7, animationSourceStills: 21, animations: 21, totalSubmissions: 83, maximumExposureUsd: 11.376, providerEnforced: false },
  preserved: { lockedFields: ['beat IDs', 'narration', 'timing and frame allocation', 'visual intent', 'evidence bindings', 'ownership fields'], unrelatedCandidateRecords: true, act3bB010Retirement: true, completedProductionRecords: ['ACT1_B006', 'ACT1_B009', 'ACT1_B010'] },
  exactHumanApprovalsRequired: [
    'Approve the 34-row route-only amendment.',
    'Approve the 34 prompt/negative contracts and two-stage local-typography designations.',
    'Approve the four non-authorizing replacement-still manifests and USD 1.632 maximum exposure.',
    'Acknowledge the reconciled 83-submission, USD 11.376 maximum remaining provider plan.',
    'Later provide separate exact execution authorization for each batch; this package does not authorize submission.'
  ],
  authority: { providerSubmissionsAuthorized: 0, executionAuthorizationsCreated: 0, requestKeysReserved: 0, mediaGenerated: 0, stage04Modified: false, rendered: false, promoted: false, deployed: false, productionPathWrites: 0, committed: false, pushed: false }
});

const amendmentPath = path.join(OUT, 'exact-34-row-route-amendment.v1.json');
const amendmentSha = shaFile(amendmentPath);
for (const record of batchRecords) {
  const file = path.join(OUT, record.path); const value = parse(file);
  for (const entry of value.entries) entry.dependencyHashes.amendmentSha256 = amendmentSha;
  write(file, bytesJson(value)); record.sha256 = shaFile(file);
}
const docketPath = path.join(OUT, 'updated-master-completion-docket.v1.json');
const docket = parse(docketPath); docket.replacementBatches = batchRecords; write(docketPath, bytesJson(docket));

writeJson('validation-report.v1.json', {
  schemaVersion: 'phase3-34-still-route-correction-validation/1.0.0', status: 'PASS',
  checks: {
    affectedRowsExactly34: amendmentRows.length === 34,
    onlyProductionMethodAndAssetTypeChange: differenceRows.every(row => JSON.stringify(row.changedPaths) === JSON.stringify(['assetType', 'productionMethod'])),
    promptContractsExactly34: promptContracts.length === 34,
    promptHashesExact: promptContracts.every(row => shaText(row.positivePrompt) === row.positivePromptSha256 && shaText(row.negativeInstructions) === row.negativeInstructionsSha256),
    requestKeysUniqueAndUnused: collisions.length === 0 && new Set(promptContracts.map(row => row.requestKey)).size === 34,
    batchesExactly10_10_10_4: JSON.stringify(batchRecords.map(row => row.requestCount)) === JSON.stringify([10, 10, 10, 4]),
    replacementExposureExact: Number(batchRecords.reduce((sum, row) => sum + row.maximumExposureUsd, 0).toFixed(3)) === 1.632,
    priorPlanUnchanged49At9_744: previousRequests === 49 && previousExposure === 9.744,
    revisedPlan83At11_376: previousRequests + 34 === 83 && Number((previousExposure + 1.632).toFixed(3)) === 11.376,
    rejectedPackageHashBound: shaFile(REJECTED_INDEX_PATH) === '8ea25ef485e127a70e43fa2867a15d611be174c9925dcc59d5216448f79ce3e6',
    act3bB010RetirementPreserved: !productionManifest.shots.some(row => row.shotId === 'ACT3B_B010'),
    sourceFilesModified: false, providerCalls: 0, executionAuthorizationsCreated: 0, mediaGenerated: 0
  },
  boundInputs: { candidateIndexSha256: shaFile(CANDIDATE_INDEX_PATH), productionManifestSha256: shaFile(MANIFEST_PATH), shotDefinitionsSha256: shaFile(SHOTS_PATH), evidenceManifestSha256: shaFile(EVIDENCE_PATH), graphicManifestSha256: shaFile(GRAPHICS_PATH), rejectedPackageIndexSha256: shaFile(REJECTED_INDEX_PATH) }
});

function walk(dir) {
  const result = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) result.push(...walk(file));
    else if (ent.isFile()) result.push(file);
    else throw new Error('NON_REGULAR_PACKAGE_ENTRY');
  }
  return result;
}
const indexPath = path.join(OUT, 'package-index.v1.json');
const files = walk(OUT).filter(file => file !== indexPath).map(file => ({ path: relOut(file), bytes: fs.statSync(file).size, sha256: shaFile(file) }));
for (const item of files.filter(item => item.path.endsWith('.json'))) parse(path.join(OUT, item.path));
write(indexPath, bytesJson({
  schemaVersion: 'phase3-34-still-route-correction-package-index/1.0.0', status: 'PHASE3_34_STILL_ROUTE_CORRECTION_PENDING_HUMAN_APPROVAL',
  packageId: PACKAGE_ID, createdAt: '2026-10-21T00:00:00.000+01:00', fileCount: files.length, files,
  summary: { amendmentRows: 34, promptContracts: 34, replacementBatchManifests: 4, replacementRequests: 34, replacementMaximumExposureUsd: 1.632, existingProviderManifests: 7, revisedRemainingProviderSubmissions: 83, revisedMaximumPlannedExposureUsd: 11.376 },
  authority: { providerSubmissionsAuthorized: 0, executionAuthorizationsCreated: 0, requestKeysReserved: 0, mediaGenerated: 0, stage04Modified: false, rendered: false, promoted: false, deployed: false, productionPathWrites: 0, committed: false, pushed: false }
}));
console.log(JSON.stringify({ status: 'BUILT_NON_AUTHORIZING', package: OUT, packageIndexSha256: shaFile(indexPath), fileCount: files.length, replacementBatches: batchRecords, revisedSubmissions: 83, revisedMaximumExposureUsd: 11.376 }, null, 2));
