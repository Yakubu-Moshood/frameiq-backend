'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const preview = require('../scripts/phase3-render-preview.cjs');
const activationRunner = require('../scripts/phase2.3b-p-activate.cjs');
const productionMethods = require('../pipeline-updates/production-method-manifest.cjs');
const phase3Media = require('../pipeline-updates/phase3-render-media-adapter.cjs');
const pilotWorkflow = require('../pipeline-updates/phase3-media-pilot.cjs');
const v3AssetReadiness = require('../pipeline-updates/v3-asset-readiness.cjs');
const mediaExecution = require('../pipeline-updates/phase3-media-execution.cjs');
const calibrationRoutes = require('../pipeline-updates/phase3-media-calibration-bundle.cjs');
const b009SourceStill = require('../pipeline-updates/phase3-media-calibration-source-still.cjs');
const b009Animation = require('../pipeline-updates/phase3-media-calibration-animation.cjs');
const calibrationClosure = require('../pipeline-updates/phase3-calibration-closure.cjs');
const mediaExecutionCli = require('../scripts/phase3-media-execution.cjs');
const productionBatch = require('../pipeline-updates/phase3-production-batch.cjs');
const productionBatchCli = require('../scripts/phase3-production-batch.cjs');

const PHASE2_RUN = 'phase2-3b-p-act3-refresh-20260928-stage04';
const PHASE3_RUN = 'phase3-preview-test01';
const PHASE3_PROFILE = require('../pipeline-updates/surface-renderer.cjs').PHASE3_PREVIEW_SETTINGS;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'eo-phase3-')); }
function withFixedDate(iso, callback) {
  const RealDate = global.Date;
  const fixedTime = RealDate.parse(iso);
  global.Date = class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedTime])); }
    static now() { return fixedTime; }
  };
  try { return callback(); } finally { global.Date = RealDate; }
}
function loadTestAuthorization(root, planning, fsImpl, expectedSha256, context, clock = {}) {
  return pilotWorkflow.loadDetachedExecutionAuthorization(root, planning, fsImpl, expectedSha256, context,
    { now: () => '2026-10-03T12:00:00.000Z', ...clock });
}
function fixture() {
  const root = tempRoot();
  const review = path.join(root, '.review', `phase2.3b-p-activation-${PHASE2_RUN}`);
  const candidate = path.join(review, 'candidate');
  const files = [];
  for (let i = 0; i < 147; i += 1) {
    const relative = i === 0 ? 'assets/evidence/evidence.svg'
      : i === 1 ? 'assets/graphics/graphic.svg'
        : `fixture/input-${String(i).padStart(3, '0')}.json`;
    const bytes = Buffer.from(`fixture-${i}`);
    const target = path.join(root, ...relative.split('/'));
    const staged = path.join(candidate, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(target, bytes);
    fs.writeFileSync(staged, bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
  }
  fs.mkdirSync(review, { recursive: true });
  const ledgerPath = path.join(root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
  const ledgerSha = sha(fs.readFileSync(ledgerPath));
  return { root, review, candidate, files, ledgerPath, ledgerSha };
}
function verified(f) {
  return {
    root: f.root,
    activationRecord: { status: 'PROMOTED', runId: PHASE2_RUN, candidateFiles: f.files },
    activationRecordSha256: 'a'.repeat(64), promotedPaths: f.files.map(file => file.path),
    candidateReport: { retiredBeatIds: ['ACT3B_B010'] }, durationSec: 633.782449, sourceDurationSec: 633.782449,
    expectedFrames: 19020, shotCount: 153, evidenceCount: 46, evidenceAssetCount: 29,
    graphicsCount: 76, timestampRows: 1352, timestampsSha256: 'b'.repeat(64),
    audioInputs: [], requestLedgerSha256: f.ledgerSha, ledgerSha256: f.ledgerSha,
    mediaStrategyCensus: { totalShotsChecked: 153,
      countsByFinalStrategy: { DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71, STILL_IMAGE: 43, VIDEO_CLIP: 23 },
      documentCards: 16, htmlDocuments: 0, pdfDocuments: 0, svgAssets: 76,
      rasterStillAssets: 43, videoClipAssets: 23, missingStillOutputs: 0, missingClipOutputs: 0,
      resolvedCount: 153, unresolvedCount: 0, unresolvedBeatIds: [] },
    stagedShotValidation: { revisionChain: [] },
    editPlan: { episodeId: 'test-episode' },
  };
}
function toolCommand(_command, args) {
  if (args.includes('-encoders')) return ' V.... libx264\n A.... aac\n';
  if (args.includes('-count_frames')) return JSON.stringify({
    streams: [
      { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1280, height: 720,
        avg_frame_rate: '30/1', nb_read_frames: '19020', pix_fmt: 'yuv420p' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', bit_rate: '128000' },
    ], format: { duration: '634.000000' },
  });
  if (args.includes('-version')) return `${args[0] === '-version' ? 'tool' : 'ffprobe'} version test\n`;
  return JSON.stringify({ streams: [{ codec_name: 'mp3', sample_rate: '44100', bit_rate: '128000' }], format: { duration: '1' } });
}
function makeService(f, overrides = {}) {
  const verifiedResult = verified(f);
  let renderCalls = 0;
  const service = preview.createPhase3Preview({
    root: f.root,
    expectedLedgerSha256: f.ledgerSha,
    runCommand: overrides.runCommand || toolCommand,
    capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath },
    verifyInputsFn: overrides.verifyInputsFn || (() => verifiedResult),
    renderFn: overrides.renderFn || (async ({ episodeDir, outputFilename }) => {
      renderCalls += 1;
      fs.writeFileSync(path.join(episodeDir, 'output', outputFilename), Buffer.from('rendered-preview'));
      return { ffmpegArguments: ['ffmpeg -y -v error -c:v libx264 -preset veryfast -crf 26 -r 30'] };
    }),
    clock: () => new Date('2026-10-01T12:00:00.000Z'),
  });
  return { service, verifiedResult, renderCalls: () => renderCalls };
}

const WELLS = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const V5_DIR = path.join(WELLS, 'phase3-media-completion-review-20261002-v5');
const PILOT_DIR = path.join(WELLS, 'phase3-media-pilot-proposal-20261002-v1');
const PILOT02_DIR = path.join(WELLS, 'phase3-media-pilot-proposal-20261002-v2');
const EDITORIAL_APPROVAL = path.join(WELLS, 'phase3-media-completion-review-20261002-v5-human-editorial-approval.v1.json');
const PILOT02_APPROVAL = path.join(WELLS, 'phase3-media-pilot-proposal-20261002-v2-human-approval.v1.json');
const PILOT02_STILL_FIXTURE = path.join(__dirname, 'fixtures', 'phase3-pilot02-approved-still.png');
const PILOT02_VALIDATION_APPROVAL = path.join(WELLS, 'phase3-pilot02-animation-review-20261003-v1', 'human-validation-approval.v1.json');
const PILOT02_MOTION_PROPOSAL = path.join(WELLS, 'phase3-pilot02-animation-review-20261003-v1', 'production-motion-requirement-proposal.v1.json');
function pilotPng(width = 1280, height = 720) {
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 4, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
}
function pilotExecutionAuthorization(planning, scope = 'STILL_ONLY', context = {}, overrides = {}) {
  const policy = scope === 'STILL_ONLY'
    ? { request: planning.still, operation: 'GENERATE_STILL' }
    : { request: planning.animation, operation: 'GENERATE_ANIMATION' };
  const request = policy.request, requestKey = request.requestKey;
  const authorization = {
    schemaVersion: pilotWorkflow.SCHEMAS.authorization,
    status: 'AUTHORIZED_FOR_EXECUTION', decision: 'AUTHORIZED_FOR_EXECUTION', approvedBy: 'Yakubu Moshood',
    approvalRef: 'TEST_ONLY_NOT_EXECUTABLE', executionSignature: 'fixture-only', providerAuthorization: 'fixture-only',
    pilotRunId: pilotWorkflow.TRUST.runId, beatId: 'ACT3_B005', scope, operation: policy.operation, requestKey,
    authorizedAt: context.authorizedAt || '2026-10-02T12:00:01.000Z',
    maxProviderSubmissions: 1, noRetry: true, noFallback: true,
    outputClassification: 'NON_PRODUCTION_DISPOSABLE_PILOT',
    productionUseProhibited: true, candidateReconstructionProhibited: true, promotionProhibited: true,
    renderingProhibited: true, normalProductionAssetReadiness: 'REJECTED',
    ownershipDisposition: 'UNRESOLVED_ACCEPTED_FOR_NONPRODUCTION_PILOT_ONLY',
    nonProductionRiskAcceptance: {
      accepted: true, acceptedBy: 'Yakubu Moshood', outputClassification: 'NON_PRODUCTION_DISPOSABLE_PILOT',
      productionUseProhibited: true, candidateReconstructionProhibited: true, promotionProhibited: true,
      renderingProhibited: true, normalProductionAssetReadiness: 'REJECTED',
      falTermsOwnershipStatement: 'FAL_TERMS_DO_NOT_CLEARLY_ASSIGN_GENERATED_OUTPUT_OWNERSHIP',
      limitedToPilotRun: pilotWorkflow.TRUST.runId, limitedToRequestKey: requestKey,
      noRightsConclusionFromCommercialUseLabel: true,
    },
    priceCheckedAt: '2026-10-02T00:00:00.000Z',
    priceAssumptions: { stillUsdPerImage: 0.024, stillPromotionEnds: '2026-10-08', animationUsdPerSecond: 0.0333,
      proposedCapUsd: 0.25, capProviderEnforced: false },
    stillExposureAcceptance: scope === 'STILL_ONLY' ? { acceptedBy: 'Yakubu Moshood', requestKey,
      publishedPriceUsd: 0.024, maximumAcceptedExposureUsd: 0.05, providerEnforcedMaximumCharge: false } : undefined,
    acceptsUnboundedAnimationExposure: scope === 'ANIMATION_ONLY' ? true : undefined,
    bindings: { editorialApprovalSha256: planning.approvalSha256, pilotProposalSha256: planning.proposalSha256,
      v5PackageIndexSha256: planning.v5IndexSha256, pilotPackageIndexSha256: planning.pilotIndexSha256,
      pilotRunId: pilotWorkflow.TRUST.runId, scope, requestKey, beatId: 'ACT3_B005',
      ...(scope === 'ANIMATION_ONLY' ? { stillSha256: context.stillSha256,
        stillApprovalSha256: context.stillApprovalSha256 } : {}) },
    authorizedRequests: [{ requestKey, provider: request.provider, model: request.model,
      endpointId: request.model, parameters: request.parameters, prompt: request.prompt, negativePrompt: request.negativePrompt }],
  };
  return Object.assign(authorization, overrides);
}
function makePilotFixture(overrides = {}) {
  const base = tempRoot(), root = path.join(base, pilotWorkflow.TRUST.runId);
  fs.mkdirSync(root, { recursive: true });
  const planning = pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, pilotDir: PILOT_DIR, editorialApprovalPath: EDITORIAL_APPROVAL });
  const authorization = pilotExecutionAuthorization(planning, overrides.scope || 'STILL_ONLY', overrides.context || {}, overrides.authorization || {});
  const authorizationBytes = Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`);
  const authFile = overrides.authorizationFile || 'still-execution-authorization.v1.json';
  fs.writeFileSync(path.join(root, authFile), authorizationBytes);
  const calls = [];
  const provider = overrides.provider || {
    async generateStill(payload) {
      calls.push({ service: 'still', payload, ledger: fs.existsSync(path.join(root, 'request-ledger.jsonl'))
        ? pilotWorkflow.readLedger(path.join(root, 'request-ledger.jsonl')) : [] });
      return { bytes: pilotPng(), contentType: 'image/png', actualChargeUsd: 0.024 };
    },
    async generateAnimation(payload) {
      calls.push({ service: 'animation', payload, ledger: pilotWorkflow.readLedger(path.join(root, 'request-ledger.jsonl')) });
      return { bytes: Buffer.from('fixture-mp4'), contentType: 'video/mp4', actualChargeUsd: 0.1665 };
    },
  };
  const probe = overrides.ffprobe || (() => ({ container: 'mov,mp4,m4a,3gp,3g2,mj2', durationSeconds: 5, bytes: 11,
    video: { codec: 'h264', width: 640, height: 360, frameRate: '30/1', frameCount: 150 }, audioStreams: [] }));
  const workflowFor = bytes => pilotWorkflow.createPilotWorkflow({ root, expectedRoot: base, v5Dir: V5_DIR, pilotDir: PILOT_DIR,
    editorialApprovalPath: EDITORIAL_APPROVAL, provider, ffprobe: probe, now: () => new Date('2026-10-02T12:00:00.000Z'),
    authorizationNow: () => '2026-10-02T12:00:00.000Z',
    expectedAuthorizationSha256: sha(bytes), ...(overrides.workflow || {}) });
  const workflow = workflowFor(authorizationBytes);
  return { base, root, workflow, workflowFor, planning, calls, authorization, authorizationBytes, probe };
}
function pilot02Authorization(planning, overrides = {}) {
  const request = planning.still;
  const authorizedRequest = { requestKey: request.requestKey, provider: request.provider, model: request.model,
    endpointId: request.model, parameters: request.parameters, prompt: request.prompt, negativePrompt: request.negativePrompt };
  return {
    schemaVersion: pilotWorkflow.SCHEMAS.authorization, status: 'AUTHORIZED_FOR_EXECUTION',
    decision: 'AUTHORIZED_FOR_EXECUTION', approvedBy: 'Yakubu Moshood', approvalRef: 'test-only',
    executionSignature: 'test-only', providerAuthorization: 'test-only', pilotRunId: pilotWorkflow.PILOT02.runId,
    beatId: 'ACT3_B005', scope: 'STILL_ONLY', operation: 'GENERATE_STILL', requestKey: request.requestKey,
    authorizedAt: '2026-10-02T12:00:01.000Z', maxProviderSubmissions: 1, noRetry: true, noFallback: true,
    outputClassification: 'NON_PRODUCTION_DISPOSABLE_PILOT', productionUseProhibited: true,
    candidateReconstructionProhibited: true, promotionProhibited: true, renderingProhibited: true,
    normalProductionAssetReadiness: 'REJECTED', animationAuthorityGranted: false,
    ownershipDisposition: 'UNRESOLVED_ACCEPTED_FOR_NONPRODUCTION_PILOT_ONLY',
    nonProductionRiskAcceptance: { accepted: true, acceptedBy: 'Yakubu Moshood',
      outputClassification: 'NON_PRODUCTION_DISPOSABLE_PILOT', productionUseProhibited: true,
      candidateReconstructionProhibited: true, promotionProhibited: true, renderingProhibited: true,
      normalProductionAssetReadiness: 'REJECTED',
      falTermsOwnershipStatement: 'FAL_TERMS_DO_NOT_CLEARLY_ASSIGN_GENERATED_OUTPUT_OWNERSHIP',
      limitedToPilotRun: pilotWorkflow.PILOT02.runId, limitedToRequestKey: request.requestKey,
      noRightsConclusionFromCommercialUseLabel: true },
    priceCheckedAt: '2026-10-02T00:00:00.000Z',
    priceAssumptions: { stillUsdPerImage: 0.024, stillPromotionEnds: '2026-10-08', animationUsdPerSecond: 0.0333,
      proposedCapUsd: 0.25, capProviderEnforced: false },
    stillExposureAcceptance: { acceptedBy: 'Yakubu Moshood', requestKey: request.requestKey,
      publishedPriceUsd: 0.024, maximumAcceptedExposureUsd: 0.05, providerEnforcedMaximumCharge: false },
    bindings: { editorialApprovalSha256: planning.approvalSha256, pilotProposalSha256: planning.proposalSha256,
      v5PackageIndexSha256: planning.v5IndexSha256, pilotPackageIndexSha256: planning.pilotIndexSha256,
      pilotRunId: pilotWorkflow.PILOT02.runId, scope: 'STILL_ONLY', requestKey: request.requestKey,
      beatId: 'ACT3_B005', repromptApprovalSha256: planning.repromptApprovalSha256,
      priorRejectionRecordSha256: pilotWorkflow.PILOT02.rejection,
      priorRejectedStillSha256: pilotWorkflow.PILOT02.rejectedStill,
      pilot02PackageIndexSha256: pilotWorkflow.PILOT02.packageIndex },
    authorizedRequests: [authorizedRequest], ...overrides,
  };
}
function pilot02AnimationAuthorization(planning, stillApproval, stillApprovalSha256, overrides = {}) {
  const request = planning.animation;
  return {
    schemaVersion: pilotWorkflow.SCHEMAS.authorization, status: 'AUTHORIZED_FOR_EXECUTION',
    decision: 'AUTHORIZED_FOR_EXECUTION', approvedBy: 'Yakubu Moshood', approvalRef: 'test-animation-only',
    executionSignature: 'test-only', providerAuthorization: 'test-only', pilotRunId: pilotWorkflow.PILOT02.runId,
    beatId: 'ACT3_B005', scope: 'ANIMATION_ONLY', operation: 'GENERATE_ANIMATION', requestKey: request.requestKey,
    authorizedAt: new Date(Date.parse(stillApproval.decidedAt) + 1000).toISOString(), maxProviderSubmissions: 1,
    noRetry: true, noFallback: true, animationAuthorityGranted: true,
    outputClassification: 'NON_PRODUCTION_DISPOSABLE_PILOT', productionUseProhibited: true,
    candidateReconstructionProhibited: true, promotionProhibited: true, renderingProhibited: true,
    normalProductionAssetReadiness: 'REJECTED', ownershipDisposition: 'UNRESOLVED_ACCEPTED_FOR_NONPRODUCTION_PILOT_ONLY',
    nonProductionRiskAcceptance: { accepted: true, acceptedBy: 'Yakubu Moshood', outputClassification: 'NON_PRODUCTION_DISPOSABLE_PILOT',
      productionUseProhibited: true, candidateReconstructionProhibited: true, promotionProhibited: true, renderingProhibited: true,
      normalProductionAssetReadiness: 'REJECTED', falTermsOwnershipStatement: 'FAL_TERMS_DO_NOT_CLEARLY_ASSIGN_GENERATED_OUTPUT_OWNERSHIP',
      limitedToPilotRun: pilotWorkflow.PILOT02.runId, limitedToRequestKey: request.requestKey,
      noRightsConclusionFromCommercialUseLabel: true },
    priceCheckedAt: '2026-10-03T00:00:00.000Z',
    priceAssumptions: { stillUsdPerImage: 0.024, stillPromotionEnds: '2026-10-08', animationUsdPerSecond: 0.0333,
      proposedCapUsd: 0.25, capProviderEnforced: false },
    animationExposureAcceptance: { acceptedBy: 'Yakubu Moshood', requestKey: request.requestKey,
      publishedRateUsdPerGeneratedSecond: 0.0333, maximumAcceptedExposureUsd: 0.25,
      providerEnforcedMaximumCharge: false, exposureIsHumanAcceptedOnly: true },
    bindings: { editorialApprovalSha256: planning.approvalSha256, pilotProposalSha256: planning.proposalSha256,
      v5PackageIndexSha256: planning.v5IndexSha256, pilotPackageIndexSha256: planning.pilotIndexSha256,
      pilotRunId: pilotWorkflow.PILOT02.runId, scope: 'ANIMATION_ONLY', requestKey: request.requestKey, beatId: 'ACT3_B005',
      repromptApprovalSha256: planning.repromptApprovalSha256, priorRejectionRecordSha256: pilotWorkflow.PILOT02.rejection,
      priorRejectedStillSha256: pilotWorkflow.PILOT02.rejectedStill, pilot02PackageIndexSha256: pilotWorkflow.PILOT02.packageIndex,
      stillSha256: pilotWorkflow.PILOT02.approvedStill, stillApprovalSha256,
      stillAuthorizationSha256: pilotWorkflow.PILOT02.stillAuthorization, stillRequestKey: pilotWorkflow.PILOT02.requestKey,
      currentPilotLedgerSha256: pilotWorkflow.PILOT02.currentLedger,
      animationExtensionPackageIndexSha256: pilotWorkflow.PILOT02_EXTENSION.packageIndex,
      animationExtensionProposalSha256: pilotWorkflow.PILOT02_EXTENSION.proposal,
      animationExtensionApprovalSha256: '4b2a72062a0defd1c945a413995c5108d0a2d5fd8ea64af1f5b3f7927e312047' },
    authorizedRequests: [{ requestKey: request.requestKey, provider: request.provider, model: request.model,
      endpointId: request.endpointId, parameters: request.parameters, prompt: request.prompt, negativePrompt: request.negativePrompt }],
    ...overrides,
  };
}
function makePilot02Fixture({ provider, packageDir = PILOT02_DIR, approvalPath = PILOT02_APPROVAL } = {}) {
  const base = tempRoot(), root = path.join(base, pilotWorkflow.PILOT02.runId);
  const pins = { ...pilotWorkflow.TRUST, runId: pilotWorkflow.PILOT02.runId };
  const planning = pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, editorialApprovalPath: EDITORIAL_APPROVAL,
    pilotDir: packageDir, pins });
  const animationPackage = path.join(path.dirname(PILOT02_DIR), 'phase3-media-pilot-animation-extension-20261003-v1');
  const animationApproval = path.join(path.dirname(animationPackage), 'phase3-media-pilot-animation-extension-20261003-v1-human-approval.v1.json');
  const fullPlanning = pilotWorkflow.verifyPilot02AnimationExtension(planning,
    { extensionDir: animationPackage, extensionApprovalPath: animationApproval });
  const authorization = pilot02Authorization(fullPlanning);
  const authorizationBytes = Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`);
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'still-execution-authorization.v1.json'), authorizationBytes);
  const calls = [];
  const providerImpl = provider || { async generateStill(payload) { calls.push(payload);
    return { bytes: pilotPng(), contentType: 'image/png', actualChargeUsd: 0.024 }; } };
  const workflowFor = (bytes, workflowOverrides = {}) => pilotWorkflow.createPilotWorkflow({ root, expectedRoot: base,
    v5Dir: V5_DIR, pilotDir: packageDir, editorialApprovalPath: EDITORIAL_APPROVAL, pins,
    enforcePilot01Rejection: true, provider: providerImpl, extensionDir: animationPackage,
    extensionApprovalPath: animationApproval, expectedAuthorizationSha256: sha(bytes),
    now: () => new Date('2026-10-02T12:00:00.000Z'),
    authorizationNow: () => '2026-10-03T12:00:00.000Z', ...workflowOverrides });
  const workflow = workflowFor(authorizationBytes);
  return { base, root, planning: fullPlanning, authorization, authorizationBytes, workflow, workflowFor, calls, approvalPath,
    animationPackage, animationApproval };
}
function attachAnimationAuthorization(f) {
  const stillPath = path.join(f.root, 'ACT3_B005-still.png'), approvalPath = path.join(f.root, 'still-approval.v1.json');
  const stillSha256 = sha(fs.readFileSync(stillPath)), stillApprovalSha256 = sha(fs.readFileSync(approvalPath));
  const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
  const authorizedAt = new Date(Date.parse(approval.decidedAt) + 1000).toISOString();
  const authorization = pilotExecutionAuthorization(f.planning, 'ANIMATION_ONLY',
    { stillSha256, stillApprovalSha256, authorizedAt });
  const bytes = Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, 'animation-execution-authorization.v1.json'), bytes);
  return { authorization, bytes, workflow: f.workflowFor(bytes), stillSha256, stillApprovalSha256 };
}
async function makePilot02CompletedFixture(t, { includeLegacyFailures = true } = {}) {
  const rawBytes = Buffer.from('deterministic provider-output fixture bytes');
  const fittedBytes = Buffer.from('deterministic fitted-video fixture bytes');
  const calls = [];
  const provider = {
    async generateStill() { calls.push('still'); return { bytes: fs.readFileSync(PILOT02_STILL_FIXTURE), contentType: 'image/png', actualChargeUsd: 0.024 }; },
    async generateAnimation() { calls.push('animation'); return { bytes: rawBytes, contentType: 'video/mp4', actualChargeUsd: 0.16 }; },
  };
  const ffprobe = file => {
    const isFitted = /110f|\.tmp-[^.]+\.mp4$/u.test(path.basename(file));
    return { container: 'mov,mp4', durationSeconds: isFitted ? 110 / 30 : 5,
      bytes: fs.statSync(file).size, video: { codec: 'h264', width: 848, height: 480,
        frameRate: '30/1', frameCount: isFitted ? 110 : 150 }, audioStreams: [] };
  };
  const ffmpeg = (_bin, args) => { fs.writeFileSync(args.at(-1), fittedBytes); return { status: 0 }; };
  const pilot02StateVerifier = (root, planning, fsImpl, options = {}) => {
    const ledger = pilotWorkflow.readLedger(path.join(root, 'request-ledger.jsonl'), fsImpl);
    pilotWorkflow.validatePilot02RunFileSet(root, planning, fsImpl, { ...options, ledger });
    const stillBytes = fsImpl.readFileSync(path.join(root, 'ACT3_B005-still.png'));
    return { stillBytes, stillSha256: sha(stillBytes),
      // The synthetic animation fixture binds to the immutable approved still
      // decision hash while the generated local approval file is test-only.
      stillApprovalSha256: pilotWorkflow.PILOT02.stillApproval };
  };
  // The fixture deliberately creates a fresh synthetic ledger, so its copied
  // pre-animation ledger cannot equal the immutable live ledger pin. Preserve
  // index integrity checks while this test exercises the finalizer's state
  // validation and side-effect guarantees.
  const pilot02InputCopyIndexVerifier = planning => {
    for (const indexName of ['pilot-inputs-still-index.v1.json', 'pilot-inputs-animation-index.v1.json']) {
      const indexPath = path.join(f.root, indexName);
      assert.ok(fs.existsSync(indexPath));
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      assert.equal(index.schemaVersion, 'phase3-media-pilot-input-index/1.0.0');
      const seen = new Set();
      for (const row of index.files) {
        assert.ok(!seen.has(row.path)); seen.add(row.path);
        const bytes = fs.readFileSync(path.join(f.root, 'inputs', ...row.path.split('/')));
        assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, sha(bytes));
      }
    }
    assert.ok(planning.animationExtension);
  };
  const f = makePilot02Fixture({ provider }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.workflow.generateStill(); f.workflow.inspectStill();
  f.workflow.approveStill({ decision: 'APPROVED', approvedBy: 'Yakubu Moshood',
    approvalRef: pilotWorkflow.PILOT02_EXTENSION.stillApprovalRef });
  const stillApprovalPath = path.join(f.root, 'still-approval.v1.json');
  const stillApprovalBytes = fs.readFileSync(stillApprovalPath), stillApproval = JSON.parse(stillApprovalBytes);
  const animationAuthorization = pilot02AnimationAuthorization(f.planning, stillApproval, sha(stillApprovalBytes));
  const animationAuthorizationBytes = Buffer.from(`${JSON.stringify(animationAuthorization, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, 'animation-execution-authorization.v1.json'), animationAuthorizationBytes);
  const workflow = f.workflowFor(animationAuthorizationBytes, { ffprobe, ffmpeg,
    pilot02StateVerifier, pilot02InputCopyIndexVerifier });
  await workflow.generateAnimation();
  const receiptPath = path.join(f.root, 'animation-receipt.v1.json'), receiptBytes = fs.readFileSync(receiptPath);
  const ledgerPath = path.join(f.root, 'request-ledger.jsonl'), ledgerBytes = fs.readFileSync(ledgerPath);
  const rawPath = path.join(f.root, 'ACT3_B005-animation-provider-output.bin');
  const fittedPath = path.join(f.root, 'ACT3_B005-animation-30fps-110f.mp4');
  const approval = { schemaVersion: 'phase3-media-pilot-human-validation-approval/1.0.0',
    recordType: 'DETACHED_HUMAN_PILOT_VALIDATION_DECISION', status: 'APPROVED_FOR_PILOT_VALIDATION_ONLY',
    approvedBy: 'Yakubu Moshood', pilotRunId: pilotWorkflow.PILOT02.runId, beatId: 'ACT3_B005',
    decisionDate: '2026-10-03', requestKey: f.planning.animation.requestKey,
    scope: ['still-to-animation route', 'provider-output measurement', 'deterministic 110-frame fitting',
      'authorization controls', 'ledger controls', 'review workflow'], productionAssetApproval: false,
    rawOutput: { sha256: sha(fs.readFileSync(rawPath)), assetClass: pilotWorkflow.PILOT_ASSET_CLASS, productionReadiness: 'REJECTED' },
    fittedOutput: { sha256: sha(fs.readFileSync(fittedPath)), assetClass: pilotWorkflow.PILOT_ASSET_CLASS, productionReadiness: 'REJECTED' },
    animationReceiptSha256: sha(receiptBytes), requestLedgerSha256: sha(ledgerBytes),
    animationAuthorizationSha256: sha(animationAuthorizationBytes), approvedStillSha256: pilotWorkflow.PILOT02.approvedStill,
    stillApprovalSha256: pilotWorkflow.PILOT02.stillApproval, animationExtensionPackageIndexSha256: pilotWorkflow.PILOT02_EXTENSION.packageIndex,
    animationExtensionPlanningApprovalSha256: '4b2a72062a0defd1c945a413995c5108d0a2d5fd8ea64af1f5b3f7927e312047',
    minorObservations: [{ code: 'MINOR_MOTION_DEVIATION', description: 'The customer slightly lifts/carries the card during part of the handoff instead of keeping it completely flat against the desk. The handoff remains understandable and is acceptable for validating the pilot route, but this motion is not the preferred production behavior.' }],
    approvalEffect: 'Confirms pilot route validation only; does not approve either Pilot-02 video as a production asset.' };
  const validationApprovalPath = path.join(f.base, 'human-validation-approval.v1.json');
  fs.writeFileSync(validationApprovalPath, `${JSON.stringify(approval, null, 2)}\n`);
  const finalizeFailurePath = path.join(f.root, 'finalize-failure-receipt.json');
  let originalLegacyFinalizeFailureBytes = null;
  if (includeLegacyFailures) {
    const animationFailureBase = { schemaVersion: 'phase3-media-pilot-failure-receipt/1.0.0', status: 'FAILED',
      command: 'generate-animation', errorCode: 'PILOT02_STILL_RUN_FILE_SET_INVALID',
      context: { authorizationSha256: sha(animationAuthorizationBytes), animationReservationCount: 0,
        animationProviderRequestCount: 0 }, recordedAt: '2000-01-01T00:00:00.000Z', providerRequestCount: 1,
      pilotRunId: pilotWorkflow.PILOT02.runId, requestKey: f.planning.animation.requestKey,
      scope: 'ANIMATION_ONLY', failureStage: 'BEFORE_RESERVATION' };
    const animationFailure = { ...animationFailureBase,
      receiptBindingSha256: sha(Buffer.from(JSON.stringify(animationFailureBase))) };
    fs.writeFileSync(path.join(f.root, 'generate-animation-failure-receipt.json'), `${JSON.stringify(animationFailure, null, 2)}\n`);
    const failureReceipt = { schemaVersion: 'phase3-media-pilot-failure-receipt/1.0.0', status: 'FAILED',
      command: 'finalize', errorCode: 'PILOT02_STILL_RUN_FILE_SET_INVALID', context: {},
      recordedAt: '2026-10-03T17:35:18.994Z', providerRequestCount: 2 };
    fs.writeFileSync(finalizeFailurePath, `${JSON.stringify(failureReceipt, null, 2)}\n`);
    originalLegacyFinalizeFailureBytes = fs.readFileSync(finalizeFailurePath);
  }
  const finalizationPins = { ...pilotWorkflow.PILOT02_FINALIZATION,
    humanValidationApprovalSha256: sha(fs.readFileSync(validationApprovalPath)),
    ledgerSha256: sha(ledgerBytes), animationReceiptSha256: sha(receiptBytes),
    rawAnimationSha256: sha(fs.readFileSync(rawPath)), fittedAnimationSha256: sha(fs.readFileSync(fittedPath)),
    animationAuthorizationSha256: sha(animationAuthorizationBytes), stillApprovalSha256: pilotWorkflow.PILOT02.stillApproval,
    historicalFinalizeFailureSha256: includeLegacyFailures ? sha(fs.readFileSync(finalizeFailurePath)) : '0'.repeat(64) };
  const finalWorkflow = f.workflowFor(animationAuthorizationBytes, { ffprobe, ffmpeg,
    animationValidationApprovalPath: validationApprovalPath, motionPolicyProposalPath: PILOT02_MOTION_PROPOSAL,
    finalizationPins, pilot02StateVerifier, pilot02InputCopyIndexVerifier });
  return { ...f, finalWorkflow, animationAuthorizationBytes, animationAuthorization, finalizationPins,
    validationApprovalPath, calls, rawBytes, fittedBytes, ffprobe, originalLegacyFinalizeFailureBytes };
}
function makePilotReadOnlyFixture(overrides = {}) {
  const base = tempRoot(), root = path.join(base, pilotWorkflow.TRUST.runId);
  const workflow = pilotWorkflow.createPilotWorkflow({ root, expectedRoot: base, v5Dir: V5_DIR, pilotDir: PILOT_DIR,
    editorialApprovalPath: EDITORIAL_APPROVAL, ...(overrides.workflow || {}) });
  return { base, root, workflow };
}
function clonePilotPackage() {
  const base = tempRoot(), pilotDir = path.join(base, 'pilot'); fs.cpSync(PILOT_DIR, pilotDir, { recursive: true });
  return { base, pilotDir };
}
function rewritePilotIndex(dir, proposalBytes) {
  const indexPath = path.join(dir, 'package-index.json'), index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entry = index.files.find(item => item.path === 'phase3-media-pilot-proposal.v1.json');
  entry.bytes = proposalBytes.length; entry.sha256 = sha(proposalBytes);
  fs.writeFileSync(path.join(dir, entry.path), proposalBytes);
  const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`); fs.writeFileSync(indexPath, bytes); return sha(bytes);
}
function options(root, runId = PHASE3_RUN) {
  return { promotedRunId: PHASE2_RUN, phase3RunId: runId,
    outputDir: path.join(root, '.review', 'phase3-renders', runId, 'output') };
}

test('read-only preflight validates without creating a run directory or invoking the renderer', () => {
  const f = fixture();
  try {
    const { service, renderCalls } = makeService(f);
    const report = service.preflight(options(f.root));
    assert.equal(report.status, 'PHASE3_RENDER_PREFLIGHT_PASS');
    assert.equal(report.expectedFrames, 19020);
    assert.equal(report.width, 1280);
    assert.equal(renderCalls(), 0);
    assert.equal(fs.existsSync(path.dirname(report.outputPath)), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('render succeeds in isolation, writes a bound receipt, and releases its lock', async () => {
  const f = fixture();
  try {
    const { service } = makeService(f);
    const result = await service.render(options(f.root));
    assert.equal(result.status, 'PHASE3_RENDER_SUCCESS');
    assert.equal(result.receipt.status, 'RENDER_COMPLETE');
    assert.equal(result.receipt.output.path, 'output/empire-omitted-v3-phase3-preview-01.mp4');
    assert.equal(result.receipt.expectedFrames, 19020);
    assert.equal(result.receipt.requestLedgerSha256Before, f.ledgerSha);
    assert.equal(result.receipt.requestLedgerSha256After, f.ledgerSha);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN, 'phase3-render.lock')), false);
    assert.deepEqual(PHASE3_PROFILE, { width: 1280, height: 720, fps: 30, preset: 'veryfast', crf: 26, audioBitrate: '128k' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('non-promoted activation record is rejected', () => {
  const f = fixture();
  try {
    const recordPath = path.join(f.review, 'activation-record.json');
    fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 'phase2.3b-p-activation-record/1.0.0',
      status: 'CANDIDATE_STAGED', runId: PHASE2_RUN, candidateFiles: f.files }));
    assert.throws(() => preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN,
      runner: { assertNoActivationLocks() {} } }), /PHASE3_PROMOTION_RECORD_NOT_PROMOTED/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('altered promoted file is rejected by the 147-file hash verification', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, ...f.files[4].path.split('/')), 'altered');
    assert.throws(() => preview.verifyIndexedFiles(f.root, f.files), /PHASE3_PROMOTED_INPUT_HASH_MISMATCH/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Stage04 real package uses the approved locked plan from its promotion backup, not the retimed root plan', () => {
  const candidateDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const approvedPackageDirectory = activationRunner.REFRESHED_BINDING_PACKAGE_DIR;
  const source = activationRunner.verifyIndexedCandidateDirectory({ directory: candidateDirectory,
    expectedIndexSha256: activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256, expectedCount: 150 });
  const approved = activationRunner.verifyRefreshedApprovalPackage({ packageDirectory: approvedPackageDirectory,
    expectedIndexSha256: activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256 });
  const candidatePlanHash = sha(fs.readFileSync(path.join(candidateDirectory, 'edit-plan.json')));
  const preTimingPlanPath = path.join(approvedPackageDirectory, 'outputs', 'candidate-edit-plan-pretiming.json');
  const preTimingPlanHash = sha(fs.readFileSync(preTimingPlanPath));
  const boundaryPolicyHash = sha(fs.readFileSync(path.join(candidateDirectory, 'approvals', 'refreshed-boundary-policy.v2.json')));
  const policy = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'approvals', 'refreshed-boundary-policy.v2.json')));
  const lockedHash = policy.binding.lockedEditPlanSha256;
  assert.equal(source.indexSha256, activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256);
  assert.equal(approved.packageIndexSha256, activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256);
  assert.equal(boundaryPolicyHash, require('../pipeline-updates/episode-activation.cjs').REFRESHED_BOUNDARY_POLICY_SHA256);
  assert.equal(preTimingPlanHash, policy.binding.candidatePreTimingEditPlanSha256);
  assert.notEqual(preTimingPlanHash, candidatePlanHash);
  assert.notEqual(lockedHash, candidatePlanHash);

  const planIndex = source.index.files.find(item => item.path === 'edit-plan.json');
  const shotIndex = source.index.files.find(item => item.path === 'shot-definitions.json');
  const shotPackage = preview.validateStagedShotDefinitions({ candidateDirectory,
    staged: { index: source.index }, promotedFiles: [planIndex, shotIndex] });
  assert.equal(shotPackage.status, 'PASS');
  assert.equal(shotPackage.errors.length, 0);
  assert.equal(shotPackage.revisionChain.length, 4);
  assert.equal(shotPackage.plan.sequences.some(sequence => sequence.beats.some(beat => beat.beatId === 'ACT3B_B010')), false);
  assert.equal(shotPackage.shotDefs.allShots.some(shot => shot.beatId === 'ACT3B_B010'), false);

  const f = fixture();
  try {
    const backupDirectory = path.join(f.review, 'backup');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const manifest = { schemaVersion: 'phase2.3b-p-backup/1.0.0', files: [
      { path: 'edit-plan.json', existed: true, bytes: 123, sha256: lockedHash },
    ] };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    fs.writeFileSync(path.join(backupDirectory, 'backup-manifest.json'), manifestBytes);
    const record = { backupManifestSha256: sha(manifestBytes), priorHashes: { 'edit-plan.json': lockedHash } };
    let receivedValidationOptions;
    const result = preview.verifyStagedValidationContext({ runId: PHASE2_RUN, reviewDirectory: f.review,
      candidateDirectory, activationRecord: record, runner: { ...activationRunner, ROOT: f.root },
      verifyBackupFn: ({ manifest: value }) => assert.equal(value.files[0].sha256, lockedHash),
      verifyStageFn: options => { receivedValidationOptions = options.validationOptions; return { status: 'PASS' }; } });
    assert.equal(result.boundaryBackup.lockedEditPlanSha256, lockedHash);
    assert.equal(result.boundaryBackup.lockedEditPlanPath, path.join(backupDirectory, 'edit-plan.json'));
    assert.equal(receivedValidationOptions.lockedEpisodeRoot, backupDirectory);
    assert.notEqual(receivedValidationOptions.lockedEpisodeRoot, f.root);
    assert.equal(result.staged.status, 'PASS');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Stage04 shot validation rejects altered indexed plans, shots, lineage and amendment inputs', () => {
  const candidateDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const source = activationRunner.verifyIndexedCandidateDirectory({ directory: candidateDirectory,
    expectedIndexSha256: activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256, expectedCount: 150 });
  const promotedFiles = source.index.files.filter(item => ['edit-plan.json', 'shot-definitions.json'].includes(item.path));
  const cases = [
    ['edit-plan.json', value => { value.episodeId = 'changed-episode'; }],
    ['shot-definitions.json', value => { value.totalShots += 1; }],
    ['revision-lineage/phase2.3b-p-retiming.v1.json', value => { value.revisionId = 'altered-retiming'; }],
    ['revision-lineage/phase2.3b-b017-factual-correction.v1.json', value => { value.revisionId = 'altered-amendment'; }],
  ];
  for (const [relative, change] of cases) {
    const absolute = path.resolve(candidateDirectory, ...relative.split('/'));
    const fakeFs = Object.create(fs);
    fakeFs.readFileSync = (file, ...args) => {
      const bytes = fs.readFileSync(file, ...args);
      if (path.resolve(file) !== absolute) return bytes;
      const value = JSON.parse(bytes.toString('utf8'));
      change(value);
      return Buffer.from(JSON.stringify(value));
    };
    assert.throws(() => preview.validateStagedShotDefinitions({ candidateDirectory,
      staged: { index: source.index }, promotedFiles, fsImpl: fakeFs }),
    new RegExp(`PHASE3_STAGED_SHOT_CONTEXT_FILE_HASH_MISMATCH:${relative.replaceAll('/', '\\/')}`, 'u'));
  }
});

function realStage04RenderPackage() {
  const candidateDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const shotDefs = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'shot-definitions.json'), 'utf8'));
  const productionManifest = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'production-manifest.json'), 'utf8'));
  const evidenceManifest = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'evidence-source-manifest.json'), 'utf8'));
  const graphicAssetManifest = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'graphic-asset-manifest.json'), 'utf8'));
  return { candidateDirectory, shotDefs, productionManifest, evidenceManifest, graphicAssetManifest };
}

function treeIndex(directory) {
  const files = [];
  const visit = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) visit(absolute, child);
      else {
        const bytes = fs.readFileSync(absolute);
        files.push({ path: child, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  };
  visit(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function fullPreflightStage04Fixture({ includeGeneratedAssets = true } = {}) {
  const sourceDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const source = activationRunner.verifyIndexedCandidateDirectory({ directory: sourceDirectory,
    expectedIndexSha256: activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256, expectedCount: 150 });
  const root = tempRoot();
  const reviewDirectory = path.join(root, '.review', `phase2.3b-p-activation-${PHASE2_RUN}`);
  const candidateDirectory = path.join(reviewDirectory, 'candidate');
  fs.mkdirSync(candidateDirectory, { recursive: true });
  fs.cpSync(sourceDirectory, candidateDirectory, { recursive: true });
  const candidateReportPath = path.join(candidateDirectory, 'candidate-report.json');
  const candidateReport = JSON.parse(fs.readFileSync(candidateReportPath, 'utf8'));
  candidateReport.runId = PHASE2_RUN;
  candidateReport.stageSchemaVersion = 'phase2.3b-p-staged-candidate/1.0.0';
  fs.writeFileSync(candidateReportPath, `${JSON.stringify(candidateReport, null, 2)}\n`);
  const stagedIndex = { files: treeIndex(candidateDirectory) };
  const promotionPaths = activationRunner.buildPromotionWriteSet({ candidateDirectory,
    report: candidateReport, stagedIndex, fsImpl: fs });
  assert.equal(promotionPaths.length, 147);
  for (const item of promotionPaths) {
    const sourceFile = path.join(candidateDirectory, ...item.path.split('/'));
    const destination = path.join(root, ...item.path.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(sourceFile, destination);
  }
  const backupDirectory = path.join(reviewDirectory, 'backup');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const lockedPlanHash = activationRunner.approval.lockedEpisodeHashesBeforeActivation['edit-plan.json'];
  const backupManifest = { schemaVersion: 'phase2.3b-p-backup/1.0.0', files: [
    { path: 'edit-plan.json', existed: true, bytes: 0, sha256: lockedPlanHash },
  ] };
  const backupBytes = Buffer.from(`${JSON.stringify(backupManifest)}\n`);
  fs.writeFileSync(path.join(backupDirectory, 'backup-manifest.json'), backupBytes);
  const activationRecord = { schemaVersion: 'phase2.3b-p-activation-record/1.0.0', status: 'PROMOTED',
    runId: PHASE2_RUN, promotedAt: '2026-10-01T12:00:00.000Z', backupManifestSha256: sha(backupBytes),
    priorHashes: { 'edit-plan.json': lockedPlanHash }, candidateFiles: promotionPaths };
  fs.writeFileSync(path.join(reviewDirectory, 'activation-record.json'), JSON.stringify(activationRecord));
  const phase3CandidateIndex = { schemaVersion: 'phase2.3b-p-staged-candidate-index/1.0.0',
    status: 'VERIFIED_STAGED', runId: PHASE2_RUN, sourceCandidateIndexSha256: source.indexSha256,
    approvedPackageIndexSha256: activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256,
    fileCount: stagedIndex.files.length, files: stagedIndex.files };
  const stagedIndexSha256 = sha(Buffer.from(JSON.stringify(phase3CandidateIndex)));
  const stageVerifier = ({ candidateDirectory: candidate, runId }) => {
    assert.equal(runId, PHASE2_RUN);
    assert.equal(path.resolve(candidate), path.resolve(candidateDirectory));
    const actual = treeIndex(candidate);
    assert.deepEqual(actual, stagedIndex.files);
    for (const item of phase3CandidateIndex.files) {
      const bytes = fs.readFileSync(path.join(candidate, ...item.path.split('/')));
      assert.equal(bytes.length, item.bytes);
      assert.equal(sha(bytes), item.sha256);
    }
    const boundaryTiming = JSON.parse(fs.readFileSync(path.join(candidate,
      'validation/boundary-and-timing-validation.json'), 'utf8'));
    const editPlanValidation = JSON.parse(fs.readFileSync(path.join(candidate, 'edit-plan-validation.json'), 'utf8'));
    const lineageValidation = JSON.parse(fs.readFileSync(path.join(candidate,
      'validation/revision-lineage-validation.json'), 'utf8'));
    const shotValidation = preview.validateStagedShotDefinitions({ candidateDirectory: candidate,
      staged: { index: phase3CandidateIndex }, promotedFiles: promotionPaths });
    assert.equal(boundaryTiming.status, 'PASS');
    assert.equal(boundaryTiming.formalExceptions.length, 9);
    assert.equal(boundaryTiming.editorialIntentMigrations.length, 5);
    assert.equal(boundaryTiming.totalRetimedDurationSec, 633.782449);
    assert.equal(editPlanValidation.status, 'PASS');
    assert.equal(lineageValidation.status, 'PASS');
    assert.equal(shotValidation.status, 'PASS');
    assert.equal(shotValidation.errors.length, 0);
    return { status: 'PASS', index: phase3CandidateIndex, sourceIndexSha256: source.indexSha256,
      stagedIndexSha256, record: { approvedPackageIndexSha256: activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256 } };
  };
  if (includeGeneratedAssets) {
    const definitions = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'shot-definitions.json'), 'utf8'));
    const production = JSON.parse(fs.readFileSync(path.join(candidateDirectory, 'production-manifest.json'), 'utf8'));
    populateMissingGeneratedRenderAssets(root, definitions, production);
  }
  return { root, candidateDirectory, reviewDirectory, activationRecord, stagedIndex: phase3CandidateIndex,
    sourceIndexSha256: source.indexSha256, promotionPaths, stageVerifier,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function populateMissingGeneratedRenderAssets(episodeDir, shotDefs, productionManifest) {
  const assetsDir = path.join(episodeDir, 'assets');
  const methods = new Map(productionManifest.shots.map(item => [item.shotId, item.productionMethod]));
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=', 'base64');
  const videoBytes = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  const evidenceIds = new Set(JSON.parse(fs.readFileSync(path.join(activationRunner.VERIFIED_STAGE_SOURCE_DIR,
    'evidence-source-manifest.json'), 'utf8')).entries.map(item => item.shotId));
  for (const shot of shotDefs.allShots) {
    const method = methods.get(shot.shotId);
    if (evidenceIds.has(shot.shotId) || method === 'GRAPHIC_COMPILATION') continue;
    const location = productionMethods.resolveProductionAssetLocation(method);
    if (!location) continue;
    const ext = location.extensions[0];
    const target = path.join(assetsDir, location.directory, `${shot.shotId}${ext}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ext === '.mp4' ? videoBytes : pngBytes);
  }
}

test('Stage04 preflight rejects still and clip files outside its indexed promoted inputs', () => {
  const f = fullPreflightStage04Fixture();
  try {
    const renderer = require('../pipeline-updates/surface-renderer.cjs');
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const service = preview.createPhase3Preview({ root: f.root, runner, verifyStageFn: f.stageVerifier,
      verifyBackupFn: () => true, expectedLedgerSha256: ledgerHash, runCommand: toolCommand,
      capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath },
      renderFn: () => { throw new Error('preflight must not invoke renderer'); } });
    let failure;
    try { service.preflight(options(f.root, 'phase3-real-stage04-test')); } catch (error) { failure = error; }
    assert.ok(failure);
    assert.match(failure.message, /PHASE3_RENDER_INPUT_CENSUS_FAILED:/u);
    const census = JSON.parse(failure.message.slice(failure.message.indexOf('{')));
    assert.equal(census.totalShotsChecked, 153);
    assert.equal(census.resolvedCount, 87);
    assert.equal(census.unresolvedCount, 66);
    assert.equal(census.unboundMediaAssets, 66);
    assert.equal(census.graphicSvgAssets, 76);
    assert.equal(census.documentCards, 16);
    assert.equal(census.htmlDocuments, 10);
    assert.equal(census.pdfDocuments, 6);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', 'phase3-real-stage04-test')), false);
    const verifiedInput = preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN, runner,
      verifyBackupFn: () => true, verifyStageFn: f.stageVerifier, expectedLedgerSha256: ledgerHash,
      runCommand: toolCommand });
    const shotContext = preview.validateStagedShotDefinitions({ candidateDirectory: f.candidateDirectory,
      staged: { index: f.stagedIndex }, promotedFiles: f.promotionPaths });
    const rendererShotReport = renderer.validateV3ShotDefinitionsForRender({ plan: shotContext.plan,
      shotDefs: shotContext.shotDefs, revisionChain: shotContext.revisionChain, requireVerifiedRevisionChain: true });
    assert.equal(rendererShotReport.status, 'PASS');
    assert.equal(shotContext.lineage.counts.approvedHistoricalRevisions, 23);
    const stagedBytes = fs.readFileSync(path.join(f.candidateDirectory, 'timing/word-timestamps.json'));
    assert.equal(verifiedInput.timestampsSha256, sha(stagedBytes));
    assert.equal(fs.existsSync(ledgerPath), true);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
    const renderInputDirectory = path.join(f.root, 'isolated-render-input-check');
    preview.copyPromotedInputs({ verified: { root: f.root, timestampsBytes: stagedBytes,
      activationRecord: { candidateFiles: [{ path: 'timing/word-timestamps.json', bytes: stagedBytes.length,
        sha256: sha(stagedBytes) }] } }, runDirectory: renderInputDirectory });
    assert.deepEqual(fs.readFileSync(path.join(renderInputDirectory, 'timing/word-timestamps.json')), stagedBytes);
  } finally { f.cleanup(); }
});

test('real Stage04 preflight blocks on absent still and clip outputs without creating Phase 3 files', () => {
  const f = fullPreflightStage04Fixture({ includeGeneratedAssets: false });
  const runId = 'phase3-stage04-missing-media-test';
  try {
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const service = preview.createPhase3Preview({ root: f.root, runner, verifyStageFn: f.stageVerifier,
      verifyBackupFn: () => true, expectedLedgerSha256: ledgerHash, runCommand: toolCommand,
      capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath },
      renderFn: () => { throw new Error('preflight must not render'); } });
    let failure;
    try { service.preflight(options(f.root, runId)); } catch (error) { failure = error; }
    assert.ok(failure, 'preflight unexpectedly passed with 66 missing still/clip outputs');
    assert.match(failure.message, /PHASE3_RENDER_INPUT_CENSUS_FAILED:/u);
    const census = JSON.parse(failure.message.slice(failure.message.indexOf('{')));
    assert.equal(census.totalShotsChecked, 153);
    assert.equal(census.missingStillOutputs, 43);
    assert.equal(census.missingClipOutputs, 23);
    assert.deepEqual(census.missingStillOutputsByMethod, { CONTROLLED_STILL: 34, GENERATED_STILL: 9 });
    assert.equal(census.unresolvedCount, 66);
    assert.deepEqual(census.countsByFinalStrategy,
      { DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71, STILL_IMAGE: 43, VIDEO_CLIP: 23 });
    assert.deepEqual(census.resolvedCountsByFinalStrategy,
      { DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71, STILL_IMAGE: 0, VIDEO_CLIP: 0 });
    assert.equal(census.unresolvedBeatIds.length, 66);
    assert.ok(census.unresolvedBeatIds.includes('ACT1_B005'));
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', runId)), false);
    assert.equal(fs.existsSync(path.join(f.root, 'assets', 'stills')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'assets', 'clips')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'assets', 'temp')), false);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
  } finally { f.cleanup(); }
});

test('Phase 3 renderer revalidates Stage04 shots with the complete ordered revision chain', async () => {
  const f = fullPreflightStage04Fixture();
  const rendererPath = require.resolve('../pipeline-updates/surface-renderer.cjs');
  const cachedRendererModule = require.cache[rendererPath];
  const childProcess = require('node:child_process');
  const originalExecSync = childProcess.execSync;
  const externalCommands = [];
  try {
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const verifiedInput = preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN, runner,
      verifyBackupFn: () => true, verifyStageFn: f.stageVerifier, expectedLedgerSha256: ledgerHash,
      runCommand: toolCommand });
    const shotContext = verifiedInput.stagedShotValidation;
    assert.equal(shotContext.status, 'PASS');
    assert.equal(shotContext.lineage.counts.approvedHistoricalRevisions, 23);
    assert.equal(shotContext.revisionChain.length, preview.STAGED_SHOT_LINEAGE_FILES.length);

    const renderer = require('../pipeline-updates/surface-renderer.cjs');
    const report = renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
      shotDefs: verifiedInput.shotDefs, revisionChain: shotContext.revisionChain,
      requireVerifiedRevisionChain: true });
    assert.equal(report.status, 'PASS');
    assert.equal(report.lineage.counts.approvedHistoricalRevisions, 23);

    assert.throws(() => renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
      shotDefs: verifiedInput.shotDefs }), /EDITORIAL_FIELD_MISMATCH \/allShots\/14\/visual/u);
    assert.throws(() => renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
      shotDefs: verifiedInput.shotDefs, requireVerifiedRevisionChain: true }), /PHASE3_VERIFIED_REVISION_CHAIN_REQUIRED/u);

    const alteredCases = [
      ['missing final entry', chain => chain.slice(0, -1), /REVISION_RESULT_HASH/u],
      ['reordered entries', chain => chain.slice().reverse(), /REVISION_CHAIN_LINK/u],
      ['altered parent hash', chain => chain.map((entry, index) => index === 0
        ? { ...entry, parentArtifactSha256: '0'.repeat(64) } : entry), /REVISION_PARENT_HASH/u],
      ['altered result hash', chain => chain.map((entry, index) => index === 3
        ? { ...entry, resultArtifactSha256: '0'.repeat(64) } : entry), /REVISION_RESULT_HASH/u],
      ['altered field change', chain => chain.map((entry, index) => index === 0
        ? { ...entry, entries: entry.entries.map((item, itemIndex) => itemIndex === 0
          ? { ...item, afterValue: 'unapproved visual change' } : item) } : entry), /REVISION_AFTER_VALUE/u],
    ];
    for (const [label, mutate, expected] of alteredCases) {
      assert.throws(() => renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
        shotDefs: verifiedInput.shotDefs, revisionChain: mutate(shotContext.revisionChain),
        requireVerifiedRevisionChain: true }), expected, label);
    }

    const retiredB010 = shotContext.revisionChain.flatMap(item => item.retirements || [])
      .find(item => item.beatId === 'ACT3B_B010');
    assert.ok(retiredB010);
    const revivedShots = structuredClone(verifiedInput.shotDefs);
    revivedShots.allShots.push(structuredClone(retiredB010.shot));
    revivedShots.acts.act3b.push(structuredClone(retiredB010.actShot || retiredB010.shot));
    assert.throws(() => renderer.validateV3ShotDefinitionsForRender({ plan: verifiedInput.editPlan,
      shotDefs: revivedShots, revisionChain: shotContext.revisionChain, requireVerifiedRevisionChain: true }),
    /V3 shot definitions failed validation/u);

    populateMissingGeneratedRenderAssets(f.root, verifiedInput.shotDefs, verifiedInput.productionManifest);
    const before = treeIndex(f.root);
    childProcess.execSync = (...args) => { externalCommands.push(String(args[0]));
      throw new Error('TEST_FFMPEG_MUST_NOT_START'); };
    delete require.cache[rendererPath];
    const isolatedRenderer = require(rendererPath);
    await assert.rejects(isolatedRenderer.renderEpisode({ episodeDir: f.root,
      episodeId: 'e59b6b79-96aa-4dcd-92c3-749fd536f55e', channel: 'EmpireOmitted',
      phase3Preview: true, outputFilename: 'empire-omitted-v3-phase3-preview-01.mp4',
      renderProfile: isolatedRenderer.PHASE3_PREVIEW_SETTINGS,
      phase3ResolvedProductionManifest: verifiedInput.productionManifest,
      verifiedEditPlan: verifiedInput.editPlan }), /PHASE3_VERIFIED_REVISION_CHAIN_REQUIRED/u);
    assert.equal(externalCommands.length, 0);
    assert.deepEqual(treeIndex(f.root), before);

    await assert.rejects(isolatedRenderer.renderEpisode({ episodeDir: f.root,
      episodeId: 'e59b6b79-96aa-4dcd-92c3-749fd536f55e', channel: 'EmpireOmitted',
      phase3Preview: true, outputFilename: 'empire-omitted-v3-phase3-preview-01.mp4',
      renderProfile: isolatedRenderer.PHASE3_PREVIEW_SETTINGS,
      phase3ResolvedProductionManifest: verifiedInput.productionManifest,
      verifiedEditPlan: verifiedInput.editPlan,
      phase3VerifiedRevisionChain: shotContext.revisionChain,
      phase3ApprovedFiles: verifiedInput.activationRecord.candidateFiles }),
    /PHASE3_RENDER_INPUTS_UNRESOLVED:/u);
    assert.equal(externalCommands.length, 0);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
  } finally {
    childProcess.execSync = originalExecSync;
    if (cachedRendererModule) require.cache[rendererPath] = cachedRendererModule;
    else delete require.cache[rendererPath];
    f.cleanup();
  }
});

test('Stage04 edit-script generation validates the promoted package and atomically publishes parity-bound outputs', () => {
  const f = fullPreflightStage04Fixture();
  try {
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const service = preview.createPhase3Preview({ root: f.root, runner, verifyStageFn: f.stageVerifier,
      verifyBackupFn: () => true, expectedLedgerSha256: ledgerHash, runCommand: toolCommand,
      capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath },
      renderFn: () => { throw new Error('edit-script generation must not render'); } });
    const result = service.generateEditScript({ promotedRunId: PHASE2_RUN, editScriptRunId: 'phase3-edit-script-test01' });
    const runDir = path.join(f.root, '.review', 'phase3-edit-scripts', 'phase3-edit-script-test01');
    assert.equal(result.status, 'PHASE3_EDIT_SCRIPT_GENERATED');
    assert.equal(result.activeBeats, 153);
    assert.equal(result.durationSec, 633.782449);
    const document = JSON.parse(fs.readFileSync(path.join(runDir, 'edit-script.json'), 'utf8'));
    const markdown = fs.readFileSync(path.join(runDir, 'EDIT_SCRIPT.md'), 'utf8');
    const receipt = JSON.parse(fs.readFileSync(path.join(runDir, 'edit-script-receipt.json'), 'utf8'));
    const index = JSON.parse(fs.readFileSync(path.join(runDir, 'edit-script-index.json'), 'utf8'));
    assert.equal(document.beats.length, 153);
    assert.equal(document.summary.promotedStage04RunId, PHASE2_RUN);
    assert.equal(document.summary.approvedEvidenceEntries, 46);
    assert.equal(document.summary.evidenceAssets, 29);
    assert.equal(document.summary.graphics, 76);
    assert.equal(document.summary.formalTimingExceptions, 9);
    assert.equal(document.summary.editorialIntentMigrations, 5);
    assert.deepEqual(document.retiredBeats, [{ beatId: 'ACT3B_B010', status: 'RETIRED', active: false }]);
    assert.ok(document.beats.every(beat => beat.qcStatus === 'NOT_REVIEWED' && beat.qcNotes === ''));
    assert.ok(document.beats.every(beat => markdown.includes(`### ${beat.act} / ${beat.beatId}`)));
    const markdownBeatObjects = [...markdown.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/gu)].map(match => JSON.parse(match[1]));
    assert.deepEqual(markdownBeatObjects, document.beats);
    assert.equal(receipt.status, 'GENERATED');
    assert.equal(receipt.requestLedgerSha256Before, ledgerHash);
    assert.equal(receipt.requestLedgerSha256After, ledgerHash);
    assert.equal(receipt.providerRequests, 0);
    assert.equal(receipt.episodeRootWrites, 0);
    assert.equal(index.files.length, 3);
    for (const entry of index.files) {
      const bytes = fs.readFileSync(path.join(runDir, entry.path));
      assert.equal(bytes.length, entry.bytes);
      assert.equal(sha(bytes), entry.sha256);
    }
    assert.equal(fs.readdirSync(path.join(f.root, '.review', 'phase3-edit-scripts')).some(name => name.startsWith('.tmp-')), false);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
    assert.equal(fs.existsSync(path.join(f.root, 'edit-plan.json')), true);
  } finally { f.cleanup(); }
});

test('edit-script generation refuses completed runs, invalid owners, bad timing, narration and asset bindings', () => {
  const f = fullPreflightStage04Fixture();
  try {
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const service = preview.createPhase3Preview({ root: f.root, runner, verifyStageFn: f.stageVerifier,
      verifyBackupFn: () => true, expectedLedgerSha256: ledgerHash, runCommand: toolCommand,
      capabilities: { textEnabled: true, fontBoldPath: process.execPath, fontImpactPath: process.execPath } });
    const args = { promotedRunId: PHASE2_RUN, editScriptRunId: 'phase3-edit-script-guards01' };
    const first = service.generateEditScript(args);
    assert.equal(first.status, 'PHASE3_EDIT_SCRIPT_GENERATED');
    assert.throws(() => service.generateEditScript(args), /PHASE3_EDIT_SCRIPT_RUN_ALREADY_EXISTS/);
    for (const [label, mutate] of [
      ['missing beat', value => { value.editPlan.sequences[0].beats.pop(); }],
      ['duplicate beat', value => { value.editPlan.sequences[0].beats.push(structuredClone(value.editPlan.sequences[0].beats[0])); }],
      ['non-monotonic timing', value => { value.editPlan.sequences[0].beats[0].startSec = 1; }],
      ['timeline gap', value => { const beat = value.editPlan.sequences[0].beats[1]; beat.startSec += 0.01; beat.endSec += 0.01; }],
      ['timeline overlap', value => { const beat = value.editPlan.sequences[0].beats[1]; beat.startSec -= 0.01; beat.endSec -= 0.01; }],
      ['missing narration', value => { value.editPlan.sequences[0].beats[0].narrationExcerpt = ''; }],
      ['wrong shot owner', value => { value.shotDefs.allShots[0].beatId = 'wrong-owner'; }],
      ['unsupported production method', value => { value.productionManifest.shots[0].productionMethod = 'UNSUPPORTED'; }],
      ['stored production disagreement', value => { value.productionManifest.shots[0].productionMethod = 'CONTROLLED_STILL'; }],
      ['plan and shot timing disagreement', value => { value.shotDefs.allShots[0].endSec += 0.01; }],
      ['plan and shot narration disagreement', value => { value.shotDefs.allShots[0].narrationExcerpt = 'different narration'; }],
      ['missing evidence owner', value => { value.evidenceManifest.entries.pop(); }],
      ['missing graphic owner', value => { value.graphicAssetManifest.entries.pop(); }],
    ]) {
      const verifiedInput = preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN, runner,
        verifyBackupFn: () => true, verifyStageFn: f.stageVerifier, expectedLedgerSha256: ledgerHash,
        runCommand: toolCommand });
      const changed = { ...verifiedInput, editPlan: structuredClone(verifiedInput.editPlan),
        shotDefs: structuredClone(verifiedInput.shotDefs), productionManifest: structuredClone(verifiedInput.productionManifest),
        storedProductionManifest: structuredClone(verifiedInput.storedProductionManifest),
        evidenceManifest: structuredClone(verifiedInput.evidenceManifest), graphicAssetManifest: structuredClone(verifiedInput.graphicAssetManifest) };
      mutate(changed);
      assert.throws(() => preview.buildEditScriptDocument(changed, { editScriptRunId: 'phase3-edit-script-guard02' }), label);
    }
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-edit-scripts', 'phase3-edit-script-guard02')), false);
    const changedAsset = JSON.parse(fs.readFileSync(path.join(f.candidateDirectory, 'evidence-source-manifest.json'), 'utf8'))
      .entries.find(entry => entry.localFilename).localFilename;
    fs.appendFileSync(path.join(f.candidateDirectory, 'assets', 'evidence', changedAsset), 'altered');
    assert.throws(() => service.generateEditScript({ promotedRunId: PHASE2_RUN,
      editScriptRunId: 'phase3-edit-script-asset-tamper' }), /PHASE3_PROMOTED_INPUT_HASH_MISMATCH/);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-edit-scripts', 'phase3-edit-script-asset-tamper')), false);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
  } finally { f.cleanup(); }
});

test('edit-script publication removes temporary output after an atomic-write failure', () => {
  const f = fullPreflightStage04Fixture();
  try {
    const runner = { ...activationRunner, ROOT: f.root, assertNoActivationLocks() {},
      verifyPromotedTree: () => true, verifyStagedCandidateIndexes: f.stageVerifier };
    const ledgerPath = path.join(f.root, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true }); fs.writeFileSync(ledgerPath, 'fixture-ledger\n');
    const ledgerHash = sha(fs.readFileSync(ledgerPath));
    const realVerified = preview.verifyActualEpisode({ root: f.root, promotedRunId: PHASE2_RUN, runner,
      verifyBackupFn: () => true, verifyStageFn: f.stageVerifier, expectedLedgerSha256: ledgerHash,
      runCommand: toolCommand });
    const fsImpl = new Proxy(fs, { get(target, property) {
      if (property === 'writeFileSync') return (file, ...args) => {
        if (String(file).includes('.tmp-phase3-edit-script-failwrite') && String(file).endsWith('EDIT_SCRIPT.md')) {
          throw new Error('SIMULATED_ATOMIC_WRITE_FAILURE');
        }
        return target.writeFileSync(file, ...args);
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const service = preview.createPhase3Preview({ root: f.root, fsImpl, verifyInputsFn: () => realVerified,
      expectedLedgerSha256: ledgerHash, clock: () => new Date('2026-10-01T12:00:00.000Z') });
    assert.throws(() => service.generateEditScript({ promotedRunId: PHASE2_RUN,
      editScriptRunId: 'phase3-edit-script-failwrite' }), /SIMULATED_ATOMIC_WRITE_FAILURE/);
    const parent = path.join(f.root, '.review', 'phase3-edit-scripts');
    assert.equal(fs.existsSync(path.join(parent, 'phase3-edit-script-failwrite')), false);
    assert.equal(fs.readdirSync(parent).some(name => name.startsWith('.tmp-phase3-edit-script-failwrite')), false);
    assert.equal(sha(fs.readFileSync(ledgerPath)), ledgerHash);
  } finally { f.cleanup(); }
});

test('Phase 3 resolves the real Stage04 evidence and graphics without mutating stored production status', () => {
  const value = realStage04RenderPackage();
  const before = JSON.stringify(value.productionManifest);
  assert.throws(() => productionMethods.assertManifestReadyForRender(value.productionManifest), /86 pending production method/);
  const resolved = preview.resolvePhase3RenderManifest({ ...value, episodeDir: value.candidateDirectory });
  assert.equal(resolved.shots.length, 153);
  assert.equal(resolved.shots.filter(item => item.status === 'APPROVED').length, 153);
  assert.equal(value.evidenceManifest.entries.length, 46);
  assert.equal(new Set(value.evidenceManifest.entries.map(item => item.localFilename)).size, 29);
  assert.equal(value.graphicAssetManifest.entries.length, 76);
  assert.equal(JSON.stringify(value.productionManifest), before);
  assert.equal(resolved.shots.filter(item => item.productionMethod === 'EVIDENCE_REFERENCE' && item.sourceStatus === 'VERIFIED').length, 46);
  assert.equal(resolved.shots.filter(item => item.graphicObjectCount > 0 && item.graphicStatus === 'COMPLETE').reduce((sum, item) => sum + item.graphicObjectCount, 0), 76);
});

function copyRealRenderInputs() {
  const value = realStage04RenderPackage();
  const root = tempRoot();
  fs.copyFileSync(path.join(value.candidateDirectory, 'shot-definitions.json'), path.join(root, 'shot-definitions.json'));
  for (const dir of ['evidence', 'graphics']) {
    fs.cpSync(path.join(value.candidateDirectory, 'assets', dir), path.join(root, 'assets', dir), { recursive: true });
  }
  return { ...value, episodeDir: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function buildPhase3MediaFixture({ includeGeneratedAssets = true } = {}) {
  const value = copyRealRenderInputs();
  const renderer = require('../pipeline-updates/surface-renderer.cjs');
  const assetsDir = path.join(value.episodeDir, 'assets');
  const productionManifest = preview.resolvePhase3RenderManifest({ ...value, episodeDir: value.episodeDir });
  const plan = JSON.parse(fs.readFileSync(path.join(value.candidateDirectory, 'edit-plan.json'), 'utf8'));
  const resolved = renderer.resolveEditPlanTimestamps({ shotDefs: value.shotDefs, editPlan: plan, productionManifest });
  const evidenceByShot = new Map(value.evidenceManifest.entries.map(entry => [entry.shotId, entry]));
  const graphicsByShot = new Map();
  for (const entry of value.graphicAssetManifest.entries) {
    if (!graphicsByShot.has(entry.shotId)) graphicsByShot.set(entry.shotId, []);
    graphicsByShot.get(entry.shotId).push(entry);
  }
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=', 'base64');
  const videoBytes = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
  const mediaShots = resolved.map(shot => {
    const evidence = evidenceByShot.get(shot.shotId);
    const graphicAssetEntries = graphicsByShot.get(shot.shotId) || [];
    const withManifests = { ...shot, graphicAssetEntries,
      ...(evidence ? { phase3EvidenceEntry: evidence,
        evidenceAssetPath: path.join(assetsDir, 'evidence', evidence.localFilename) } : {}) };
    let assetPath = renderer.resolveAssetPath(withManifests, assetsDir);
    if (!assetPath && includeGeneratedAssets) {
      const location = productionMethods.resolveProductionAssetLocation(shot.productionMethod);
      if (location) {
        const ext = location.extensions[0];
        assetPath = path.join(assetsDir, location.directory, `${shot.shotId}${ext}`);
        fs.mkdirSync(path.dirname(assetPath), { recursive: true });
        fs.writeFileSync(assetPath, ext === '.mp4' ? videoBytes : pngBytes);
      }
    }
    return { ...withManifests, phase3BaseAssetPath: assetPath };
  });
  return { ...value, assetsDir, mediaShots, cleanup: value.cleanup };
}

test('complete Stage04 153-shot media census classifies every resolved asset before FFmpeg', () => {
  const value = buildPhase3MediaFixture({ includeGeneratedAssets: false });
  try {
    const census = phase3Media.censusPhase3RenderInputs({ resolvedShots: value.mediaShots,
      assetsDir: value.assetsDir });
    assert.equal(census.activeShotCount, 153);
    assert.equal(census.readyCount, 87);
    assert.equal(census.unresolved.length, 66);
    assert.deepEqual(census.strategies, { DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71 });
    assert.equal(census.entries.find(item => item.beatId === 'ACT1_B003').strategy, 'DOCUMENT_CARD');
    assert.equal(census.entries.find(item => item.beatId === 'ACT1_B003').sourcePath,
      'assets/evidence/doj-wells-fargo-2020-resolution.html');
    assert.equal(census.entries.reduce((sum, item) => sum + item.supportingAssets.length, 0), 76);
    assert.ok(census.entries.filter(item => item.status === 'READY').every(item =>
      ['DOCUMENT_CARD', 'RASTERIZE_APPROVED_SVG', 'STILL_IMAGE', 'VIDEO_CLIP'].includes(item.strategy)));
    assert.equal(fs.existsSync(path.join(value.episodeDir, 'temp')), false);
  } finally { value.cleanup(); }
});

test('all 153 Stage04 shots receive a compatible strategy and document cards stay in the isolated run', () => {
  const value = buildPhase3MediaFixture();
  const isolatedRunDirectory = path.join(value.episodeDir, 'phase3-run');
  const derivedAssetDir = path.join(isolatedRunDirectory, 'temp', 'phase3-derived-assets');
  try {
    const beforeEvidence = treeIndex(path.join(value.assetsDir, 'evidence'));
    const beforeGraphics = treeIndex(path.join(value.assetsDir, 'graphics'));
    const prepared = phase3Media.preparePhase3RenderInputs({ resolvedShots: value.mediaShots,
      assetsDir: value.assetsDir, derivedAssetDir, isolatedRunDirectory });
    assert.equal(prepared.census.activeShotCount, 153);
    assert.equal(prepared.census.resolvedAssetCount, 153);
    assert.deepEqual(prepared.census.strategies, {
      DOCUMENT_CARD: 16, RASTERIZE_APPROVED_SVG: 71, STILL_IMAGE: 43, VIDEO_CLIP: 23,
    });
    const b003 = prepared.shots.find(item => item.beatId === 'ACT1_B003');
    assert.equal(b003.phase3MediaStrategy, 'DOCUMENT_CARD');
    assert.equal(b003.phase3StillInput, true);
    assert.ok(b003.evidenceAssetPath.startsWith(derivedAssetDir));
    const entry = prepared.census.entries.find(item => item.beatId === 'ACT1_B003');
    assert.equal(entry.sourcePath, 'assets/evidence/doj-wells-fargo-2020-resolution.html');
    assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/u);
    assert.ok(entry.derivedAssetPath.startsWith('temp/phase3-derived-assets/'));
    assert.match(entry.derivedAssetSha256, /^[a-f0-9]{64}$/u);
    assert.equal(prepared.shots.find(item => item.beatId === 'ACT2_B018').phase3MediaStrategy, 'DOCUMENT_CARD');
    assert.deepEqual(treeIndex(path.join(value.assetsDir, 'evidence')), beforeEvidence);
    assert.deepEqual(treeIndex(path.join(value.assetsDir, 'graphics')), beforeGraphics);
  } finally { value.cleanup(); }
});

test('Phase 3 census rejects ambiguous still output extensions before any write', () => {
  const value = buildPhase3MediaFixture();
  try {
    const shot = value.mediaShots.find(item => item.productionMethod === 'CONTROLLED_STILL');
    const location = productionMethods.resolveProductionAssetLocation(shot.productionMethod);
    const existing = shot.phase3BaseAssetPath;
    const alternate = path.join(value.assetsDir, location.directory,
      `${shot.shotId}${location.extensions.find(extension => extension !== path.extname(existing))}`);
    fs.copyFileSync(existing, alternate);
    assert.throws(() => phase3Media.resolvePhase3RenderShots({ resolvedShots: value.mediaShots,
      assetsDir: value.assetsDir, evidenceManifest: value.evidenceManifest,
      graphicAssetManifest: value.graphicAssetManifest,
      resolveAssetPath: require('../pipeline-updates/surface-renderer.cjs').resolveAssetPath }),
    new RegExp(`PHASE3_MEDIA_ASSET_AMBIGUOUS:${shot.beatId}`, 'u'));
    assert.equal(fs.existsSync(path.join(value.episodeDir, 'temp')), false);
  } finally { value.cleanup(); }
});

test('Phase 3 media classifier handles HTML, PDF, approved SVG, raster and actual video only', () => {
  const cases = [
    ['source.html', Buffer.from('<!doctype html><html></html>'), 'text/html', false, 'DOCUMENT_CARD'],
    ['source.pdf', Buffer.from('%PDF-1.7\n'), 'application/pdf', false, 'DOCUMENT_CARD'],
    ['graphic.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', true, 'RASTERIZE_APPROVED_SVG'],
    ['still.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=', 'base64'), null, false, 'STILL_IMAGE'],
    ['clip.mp4', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), null, false, 'VIDEO_CLIP'],
  ];
  for (const [filePath, bytes, expectedMimeType, approvedSvg, strategy] of cases) {
    assert.equal(phase3Media.classifyMedia({ filePath, bytes, expectedMimeType, approvedSvg }).strategy, strategy);
  }
  assert.throws(() => phase3Media.classifyMedia({ filePath: 'audio.mp3', bytes: Buffer.from('ID3') }), /PHASE3_MEDIA_TYPE_UNSUPPORTED/u);
  assert.throws(() => phase3Media.classifyMedia({ filePath: 'graphic.svg', bytes: Buffer.from('<svg/>'), approvedSvg: false }), /PHASE3_MEDIA_TYPE_UNSUPPORTED/u);
});

test('document cards fail closed instead of truncating approved titles or excerpts', () => {
  const base = { shotId: 'ACT1_B003', sourceTitle: 'Approved title', publisher: 'DOJ', excerptOrTimecode: 'Approved excerpt' };
  assert.throws(() => phase3Media.buildDocumentCardSvg({ ...base, sourceTitle: 'title '.repeat(30) }),
    /PHASE3_DOCUMENT_CARD_TITLE_OVERFLOW/u);
  assert.throws(() => phase3Media.buildDocumentCardSvg({ ...base, excerptOrTimecode: 'approved '.repeat(100) }),
    /PHASE3_DOCUMENT_CARD_EXCERPT_OVERFLOW/u);
});

test('Phase 3 media census rejects missing or altered evidence and graphic assets', () => {
  for (const category of ['evidence-missing', 'evidence-altered', 'graphic-missing', 'graphic-altered']) {
    const value = buildPhase3MediaFixture();
    try {
      const isEvidence = category.startsWith('evidence');
      const entry = isEvidence ? value.evidenceManifest.entries.find(item => item.localFilename)
        : value.graphicAssetManifest.entries[0];
      const file = path.join(value.assetsDir, isEvidence ? 'evidence' : 'graphics',
        isEvidence ? entry.localFilename : entry.filename);
      if (category.endsWith('missing')) fs.unlinkSync(file);
      else fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), Buffer.from('tamper')]));
      assert.throws(() => phase3Media.censusPhase3RenderInputs({ resolvedShots: value.mediaShots, assetsDir: value.assetsDir }),
        isEvidence ? /PHASE3_MEDIA_APPROVED_ASSET_HASH_MISMATCH|PHASE3_MEDIA_FILE_MISSING/u
          : /PHASE3_MEDIA_GRAPHIC_HASH_MISMATCH|PHASE3_MEDIA_FILE_MISSING/u);
    } finally { value.cleanup(); }
  }
});

test('unsupported media fails before derived-file creation or any encoder invocation', async () => {
  const value = buildPhase3MediaFixture();
  const isolatedRunDirectory = path.join(value.episodeDir, 'isolated-phase3');
  const derivedAssetDir = path.join(isolatedRunDirectory, 'temp', 'phase3-derived-assets');
  const unsupportedPath = path.join(value.assetsDir, 'evidence', 'unsupported.dat');
  fs.writeFileSync(unsupportedPath, Buffer.from('not a supported visual format'));
  const alteredShots = value.mediaShots.map(shot => shot.beatId === 'ACT1_B003'
    ? { ...shot, phase3BaseAssetPath: unsupportedPath, phase3EvidenceEntry: null } : shot);
  const before = treeIndex(path.join(value.assetsDir));
  let encoderCalls = 0;
  try {
    assert.throws(() => {
      const census = phase3Media.censusPhase3RenderInputs({ resolvedShots: alteredShots, assetsDir: value.assetsDir });
      phase3Media.preparePhase3RenderInputs({ resolvedShots: alteredShots, assetsDir: value.assetsDir,
        derivedAssetDir, isolatedRunDirectory });
      encoderCalls += census.activeShotCount;
    }, /PHASE3_MEDIA_TYPE_UNSUPPORTED/u);
    assert.equal(encoderCalls, 0);
    assert.deepEqual(treeIndex(path.join(value.assetsDir)), before);
    assert.equal(fs.existsSync(derivedAssetDir), false);
  } finally { value.cleanup(); }
});

test('media adapter failure releases Phase 3 lock and removes its isolated run without external writes', async () => {
  const f = fixture();
  let encoderCalls = 0;
  const { service } = makeService(f, { renderFn: async ({ episodeDir }) => {
    const badPath = path.join(episodeDir, 'assets', 'evidence', 'bad.unsupported');
    fs.mkdirSync(path.dirname(badPath), { recursive: true });
    fs.writeFileSync(badPath, 'bad');
    const fakeShots = Array.from({ length: 153 }, (_, index) => ({ actKey: 'act1',
      beatId: `ACT1_B${String(index + 1).padStart(3, '0')}`, shotId: `ACT1_B${String(index + 1).padStart(3, '0')}`,
      productionMethod: 'EVIDENCE_REFERENCE', phase3BaseAssetPath: badPath }));
    phase3Media.preparePhase3RenderInputs({ resolvedShots: fakeShots, assetsDir: path.join(episodeDir, 'assets'),
      derivedAssetDir: path.join(episodeDir, 'temp', 'phase3-derived-assets'), isolatedRunDirectory: episodeDir });
    encoderCalls += 1;
  } });
  try {
    await assert.rejects(service.render(options(f.root)), /PHASE3_MEDIA_TYPE_UNSUPPORTED/u);
    assert.equal(encoderCalls, 0);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN)), false);
    assert.equal(fs.readFileSync(f.ledgerPath, 'utf8'), 'fixture-ledger\n');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Phase 3 resolver rejects missing and altered evidence assets', () => {
  for (const altered of [false, true]) {
    const value = copyRealRenderInputs();
    try {
      const entry = value.evidenceManifest.entries.find(item => item.localFilename);
      const file = path.join(value.episodeDir, 'assets', 'evidence', entry.localFilename);
      if (altered) fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), Buffer.from('tamper')]));
      else fs.unlinkSync(file);
      assert.throws(() => preview.resolvePhase3RenderManifest(value), /EVIDENCE_|PHASE3_EVIDENCE_/);
    } finally { value.cleanup(); }
  }
});

test('Phase 3 resolver rejects missing and altered graphic assets', () => {
  for (const altered of [false, true]) {
    const value = copyRealRenderInputs();
    try {
      const entry = value.graphicAssetManifest.entries[0];
      const file = path.join(value.episodeDir, 'assets', 'graphics', entry.filename);
      if (altered) fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file), Buffer.from('tamper')]));
      else fs.unlinkSync(file);
      assert.throws(() => preview.resolvePhase3RenderManifest(value), /GRAPHIC_|PHASE3_GRAPHIC_/);
    } finally { value.cleanup(); }
  }
});

test('Phase 3 resolver rejects wrong owners, duplicate records and unsupported methods', () => {
  const owner = realStage04RenderPackage();
  owner.evidenceManifest.entries[0].shotId = 'UNKNOWN_SHOT';
  assert.throws(() => preview.resolvePhase3RenderManifest({ ...owner, episodeDir: owner.candidateDirectory }), /PHASE3_EVIDENCE_OWNER_UNKNOWN/);
  const duplicate = realStage04RenderPackage();
  duplicate.graphicAssetManifest.entries.push({ ...duplicate.graphicAssetManifest.entries[0] });
  assert.throws(() => preview.resolvePhase3RenderManifest({ ...duplicate, episodeDir: duplicate.candidateDirectory }), /PHASE3_GRAPHIC_OWNER_DUPLICATE/);
  const unsupported = realStage04RenderPackage();
  unsupported.productionManifest.shots[0].productionMethod = 'UNSUPPORTED_METHOD';
  assert.throws(() => preview.resolvePhase3RenderManifest({ ...unsupported, episodeDir: unsupported.candidateDirectory }), /PHASE3_PRODUCTION_METHOD_UNSUPPORTED/);
});

test('Stage04 shot validation rejects a missing mirror owner and retired B010 reappearance', () => {
  const candidateDirectory = activationRunner.VERIFIED_STAGE_SOURCE_DIR;
  const source = activationRunner.verifyIndexedCandidateDirectory({ directory: candidateDirectory,
    expectedIndexSha256: activationRunner.VERIFIED_STAGE_SOURCE_INDEX_SHA256, expectedCount: 150 });
  const promotedFiles = source.index.files.filter(item => ['edit-plan.json', 'shot-definitions.json'].includes(item.path));
  const base = preview.validateStagedShotDefinitions({ candidateDirectory,
    staged: { index: source.index }, promotedFiles });
  const mirrorMissing = structuredClone(base.shotDefs);
  mirrorMissing.acts.act3 = mirrorMissing.acts.act3.filter(shot => shot.beatId !== 'ACT3_B017');
  const mirrorResult = require('../pipeline-updates/shot-definitions-validator.cjs')
    .validateShotDefinitions({ plan: base.plan, shotDefs: mirrorMissing, revisionChain: base.revisionChain });
  assert.equal(mirrorResult.status, 'FAIL');
  assert.ok(mirrorResult.errors.some(error => error.code === 'ACT_SHOTS_MISMATCH' && error.path === '/acts/act3'));

  const shotPath = path.resolve(candidateDirectory, 'shot-definitions.json');
  const sourceShotEntry = source.index.files.find(item => item.path === 'shot-definitions.json');
  const promotedShotEntry = promotedFiles.find(item => item.path === 'shot-definitions.json');
  const alteredShots = structuredClone(base.shotDefs);
  const retiredShot = { ...alteredShots.allShots.find(shot => shot.actKey === 'act3b'), beatId: 'ACT3B_B010', shotId: 'ACT3B_B010' };
  alteredShots.allShots.push(retiredShot);
  alteredShots.acts.act3b.push(retiredShot);
  const alteredBytes = Buffer.from(JSON.stringify(alteredShots));
  const adjusted = entry => ({ ...entry, bytes: alteredBytes.length, sha256: sha(alteredBytes) });
  const adjustedIndex = { ...source.index, files: source.index.files.map(item => item.path === 'shot-definitions.json' ? adjusted(item) : item) };
  const adjustedPromotion = promotedFiles.map(item => item.path === 'shot-definitions.json' ? adjusted(item) : item);
  const fakeFs = Object.create(fs);
  fakeFs.readFileSync = (file, ...args) => path.resolve(file) === shotPath ? alteredBytes : fs.readFileSync(file, ...args);
  assert.equal(sourceShotEntry.path, promotedShotEntry.path);
  assert.throws(() => preview.validateStagedShotDefinitions({ candidateDirectory,
    staged: { index: adjustedIndex }, promotedFiles: adjustedPromotion, fsImpl: fakeFs }),
  /PHASE3_RETIRED_BEAT_REAPPEARED/u);
});

test('Stage04 locked-plan provenance rejects altered policy, approval binding, backup, and missing backup plan', () => {
  const f = fixture();
  const policyPath = path.join(f.root, 'refreshed-boundary-policy.v2.json');
  const reviewDirectory = path.join(f.root, '.review', `phase2.3b-p-activation-${PHASE2_RUN}`);
  const backupDirectory = path.join(reviewDirectory, 'backup');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const lockedHash = activationRunner.approval.lockedEpisodeHashesBeforeActivation['edit-plan.json'];
  const policyBytes = fs.readFileSync(path.join(activationRunner.VERIFIED_STAGE_SOURCE_DIR,
    'approvals', 'refreshed-boundary-policy.v2.json'));
  fs.writeFileSync(policyPath, policyBytes);
  const manifest = { schemaVersion: 'phase2.3b-p-backup/1.0.0', files: [
    { path: 'edit-plan.json', existed: true, bytes: 123, sha256: lockedHash },
  ] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const manifestPath = path.join(backupDirectory, 'backup-manifest.json');
  fs.writeFileSync(manifestPath, manifestBytes);
  const baseRecord = { backupManifestSha256: sha(manifestBytes), priorHashes: { 'edit-plan.json': lockedHash } };
  const candidateDirectory = f.root;
  const make = (record, policyFile = policyPath, verifyBackupFn = () => {}) => {
    const candidate = path.join(f.root, 'candidate');
    fs.mkdirSync(path.join(candidate, 'approvals'), { recursive: true });
    fs.copyFileSync(policyFile, path.join(candidate, 'approvals', 'refreshed-boundary-policy.v2.json'));
    return () => preview.verifyStageBoundaryBackup({ reviewDirectory, candidateDirectory: candidate,
      activationRecord: record, runner: { ...activationRunner, ROOT: f.root }, verifyBackupFn });
  };
  try {
    assert.throws(make({ ...baseRecord, priorHashes: { 'edit-plan.json': 'f'.repeat(64) } }), /PHASE3_LOCKED_PLAN_PROVENANCE_MISMATCH/);
    assert.throws(make({ ...baseRecord, backupManifestSha256: 'f'.repeat(64) }), /PHASE3_PROMOTION_BACKUP_MANIFEST_HASH_MISMATCH/);
    fs.writeFileSync(path.join(f.root, 'altered-policy.json'), Buffer.from(policyBytes.toString('utf8').replace('33f5a89f', '43f5a89f')));
    assert.throws(make(baseRecord, path.join(f.root, 'altered-policy.json')), /PHASE3_STAGED_BOUNDARY_POLICY_HASH_MISMATCH/);
    fs.writeFileSync(manifestPath, Buffer.from(JSON.stringify({ schemaVersion: 'phase2.3b-p-backup/1.0.0', files: [] })));
    const changedBytes = fs.readFileSync(manifestPath);
    assert.throws(make({ ...baseRecord, backupManifestSha256: sha(changedBytes) }), /PHASE3_LOCKED_PLAN_PROVENANCE_MISMATCH/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('Stage04 approved r3 package rejects changed boundary approval and pre-timing plan bytes', () => {
  const source = activationRunner.REFRESHED_BINDING_PACKAGE_DIR;
  const f = tempRoot();
  try {
    ['approvals/boundary-policy-approval.v1.json', 'outputs/candidate-edit-plan-pretiming.json'].forEach((relative, index) => {
      const packageCopy = path.join(f, `package-${index}`);
      fs.cpSync(source, packageCopy, { recursive: true });
      const file = path.join(packageCopy, ...relative.split('/'));
      fs.appendFileSync(file, ' ');
      assert.throws(() => activationRunner.verifyRefreshedApprovalPackage({ packageDirectory: packageCopy,
        expectedIndexSha256: activationRunner.REFRESHED_BINDING_PACKAGE_INDEX_SHA256 }), /ACTIVATION_REFRESHED_PACKAGE_/);
    });
  } finally { fs.rmSync(f, { recursive: true, force: true }); }
});

test('altered final retimed edit plan is rejected against its immutable candidate index', () => {
  const f = fixture();
  try {
    for (const item of f.files) fs.rmSync(path.join(f.root, ...item.path.split('/')), { force: true });
    f.files = [];
    for (let i = 0; i < 147; i += 1) {
      const relative = i === 0 ? 'edit-plan.json' : `fixture/input-${String(i).padStart(3, '0')}.json`;
      const target = path.join(f.root, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.from(i === 0 ? '{"timing":"retimed"}' : `fixture-${i}`);
      fs.writeFileSync(target, bytes);
      f.files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
    }
    const planFile = path.join(f.root, 'edit-plan.json');
    fs.writeFileSync(planFile, Buffer.from('{"timing":"altered"}'));
    assert.throws(() => preview.verifyIndexedFiles(f.root, f.files), /PHASE3_PROMOTED_INPUT_HASH_MISMATCH:edit-plan.json/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('missing evidence or graphic assets fail indexed verification', () => {
  for (const index of [0, 1]) {
    const f = fixture();
    try {
      fs.rmSync(path.join(f.root, ...f.files[index].path.split('/')));
      assert.throws(() => preview.verifyIndexedFiles(f.root, f.files), /PHASE3_PATH_MISSING/);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('evidence and graphic manifests must contain the complete approved asset sets', () => {
  const evidence = { entries: Array.from({ length: 46 }, (_, i) => ({ localFilename: i < 29 ? `e${i}` : null })),
    humanApproval: { approvedEntryCount: 46, isApproved: true } };
  const graphics = { entries: Array.from({ length: 76 }, (_, i) => ({ filename: `g${i}.svg` })) };
  assert.deepEqual(preview.assertAssetManifestCounts(evidence, graphics), { evidenceEntries: 46, evidenceAssets: 29, graphics: 76 });
  assert.throws(() => preview.assertAssetManifestCounts({ ...evidence, entries: evidence.entries.slice(1) }, graphics), /PHASE3_EVIDENCE_ASSETS_INVALID/);
  assert.throws(() => preview.assertAssetManifestCounts(evidence, { entries: graphics.entries.slice(1) }), /PHASE3_GRAPHIC_ASSET_COUNT_INVALID/);
});

test('symlinked promoted paths are rejected', () => {
  const f = fixture();
  try {
    const target = path.resolve(f.root, ...f.files[2].path.split('/'));
    const fakeFs = Object.create(fs);
    fakeFs.lstatSync = candidate => candidate === target
      ? { isSymbolicLink: () => true, isFile: () => false }
      : fs.lstatSync(candidate);
    assert.throws(() => preview.verifyIndexedFiles(f.root, f.files, { fsImpl: fakeFs }), /PHASE3_SYMLINK_PATH_REJECTED/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('path traversal and external output directories are rejected', () => {
  const f = fixture();
  try {
    assert.throws(() => preview.safeRelativePath('../episode-root/script.json'), /PHASE3_INPUT_PATH_TRAVERSAL/);
    const outside = options(f.root);
    outside.outputDir = path.join(f.root, 'output');
    assert.throws(() => makeService(f).service.preflight(outside), /PHASE3_OUTPUT_DIRECTORY_OUTSIDE_RUN/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('duplicate phase3 run IDs and stale locks are refused', () => {
  const f = fixture();
  try {
    const phase3Dir = path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN);
    fs.mkdirSync(phase3Dir, { recursive: true });
    assert.throws(() => makeService(f).service.preflight(options(f.root)), /PHASE3_RUN_ID_ALREADY_EXISTS/);
    fs.writeFileSync(path.join(phase3Dir, 'phase3-render.lock'), 'stale');
    assert.throws(() => makeService(f).service.preflight(options(f.root)), /PHASE3_RENDER_LOCK_PRESENT/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('render failure removes partial preview data and releases the separate lock', async () => {
  const f = fixture();
  try {
    const { service } = makeService(f, { renderFn: async () => { throw new Error('fixture render failure'); } });
    await assert.rejects(service.render(options(f.root)), /fixture render failure/);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN)), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('frame-count and duration mismatches fail closed and clean up the run', async () => {
  for (const mismatch of ['frames', 'duration']) {
    const f = fixture();
    try {
      const { service } = makeService(f, { runCommand: (_cmd, args) => {
        const output = toolCommand(_cmd, args);
        if (!args.includes('-count_frames')) return output;
        const data = JSON.parse(output);
        if (mismatch === 'frames') data.streams[0].nb_read_frames = '19019';
        if (mismatch === 'duration') data.format.duration = '600';
        return JSON.stringify(data);
      } });
      await assert.rejects(service.render(options(f.root)), mismatch === 'frames'
        ? /PHASE3_RENDER_VIDEO_METADATA_MISMATCH/ : /PHASE3_RENDER_DURATION_MISMATCH/);
      assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN)), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('request-ledger mutation during preview blocks receipt and cleans the run', async () => {
  const f = fixture();
  try {
    const { service } = makeService(f, { renderFn: async ({ episodeDir, outputFilename }) => {
      fs.writeFileSync(path.join(episodeDir, 'output', outputFilename), 'preview');
      fs.writeFileSync(f.ledgerPath, 'changed ledger');
      return { ffmpegArguments: ['ffmpeg fixture'] };
    } });
    await assert.rejects(service.render(options(f.root)), /PHASE3_REQUEST_LEDGER_CHANGED/);
    assert.equal(fs.existsSync(path.join(f.root, '.review', 'phase3-renders', PHASE3_RUN)), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('preview renderer loads no timing/provider module and cannot continue the normal workflow', () => {
  const rendererPath = path.resolve(__dirname, '../pipeline-updates/surface-renderer.cjs');
  const hook = `const Module=require('node:module');const old=Module._load;Module._load=function(request,parent,isMain){if(/vo-timing|@anthropic|@fal-ai|openai/.test(String(request)))throw new Error('PROVIDER_MODULE_ATTEMPT:'+request);return old.call(this,request,parent,isMain)};require(${JSON.stringify(rendererPath)});`;
  const child = spawnSync(process.execPath, ['-e', hook], { encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
  assert.equal(child.status, 0, child.stderr);
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/phase3-render-preview.cjs'), 'utf8');
  assert.doesNotMatch(source, /jobs[\\/]runner/);
  assert.match(source, /options\.mode === 'preflight' \? service\.preflight\(options\)/);
  assert.match(source, /options\.mode === 'generate-edit-script' \? service\.generateEditScript\(options\)/);
});

test('CLI requires an explicit single mode, both run IDs, and output directory', () => {
  assert.throws(() => preview.parseArgs(['--preflight']), /PHASE3_ARGUMENTS_REQUIRED/);
  assert.throws(() => preview.parseArgs(['--preflight', '--render-preview']), /PHASE3_MODE_AMBIGUOUS/);
  assert.deepEqual(preview.parseArgs(['--render-preview', '--promoted-run-id', PHASE2_RUN,
    '--phase3-run-id', PHASE3_RUN, '--output-dir', 'X']), {
    mode: 'render', promotedRunId: PHASE2_RUN, phase3RunId: PHASE3_RUN, outputDir: 'X', editScriptRunId: null,
  });
  assert.deepEqual(preview.parseArgs(['--generate-edit-script', '--promoted-run-id', PHASE2_RUN,
    '--edit-script-run-id', 'phase3-edit-script-final01']), {
    mode: 'generate-edit-script', promotedRunId: PHASE2_RUN, phase3RunId: null, outputDir: null,
    editScriptRunId: 'phase3-edit-script-final01',
  });
  assert.throws(() => preview.parseArgs(['--generate-edit-script', '--promoted-run-id', PHASE2_RUN,
    '--edit-script-run-id', '../outside']), /PHASE3_EDIT_SCRIPT_RUN_ID_INVALID/);
  assert.throws(() => preview.parseArgs(['--generate-edit-script', '--promoted-run-id', 'other-run',
    '--edit-script-run-id', 'phase3-edit-script-x']), /PHASE3_EDIT_SCRIPT_ARGUMENTS_INVALID/);
});

test('edit-script CLI dispatch never invokes the render path', async () => {
  let generated = 0, rendered = 0;
  const originalWrite = process.stdout.write;
  let stdout = '';
  process.stdout.write = chunk => { stdout += String(chunk); return true; };
  try {
    await preview.main(['--generate-edit-script', '--promoted-run-id', PHASE2_RUN,
      '--edit-script-run-id', 'phase3-edit-script-dispatch01'], {
      serviceFactory: () => ({ generateEditScript: options => { generated += 1;
        assert.equal(options.editScriptRunId, 'phase3-edit-script-dispatch01'); return { status: 'GENERATED' }; },
      preflight: () => { throw new Error('unexpected preflight'); },
      render: () => { rendered += 1; throw new Error('unexpected render'); } }),
    });
  } finally { process.stdout.write = originalWrite; }
  assert.equal(generated, 1);
  assert.equal(rendered, 0);
  assert.match(stdout, /GENERATED/);
});

test('controlled-media pilot preflight verifies the exact approved planning packages without writes', t => {
  const f = makePilotReadOnlyFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const report = f.workflow.preflight();
  assert.equal(report.status, 'PILOT_PREFLIGHT_PASS_PLANNING_ONLY');
  assert.equal(report.executionAuthorized, false);
  assert.equal(report.providerSubmissionsMaximum, 2);
  assert.deepEqual(report.requestKeys, [pilotWorkflow.REQUESTS.still.key, pilotWorkflow.REQUESTS.animation.key]);
  assert.equal(report.proposedCapProviderEnforced, false);
  assert.equal(report.wouldCreateNoFiles, true);
  assert.equal(fs.existsSync(f.root), false);
  assert.equal(fs.existsSync(path.join(f.base, 'request-ledger.jsonl')), false);
});

test('pilot rejects altered editorial approval, unsigned proposal, package index and indexed source bytes', t => {
  const f = makePilotReadOnlyFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const approvalCopy = path.join(f.base, 'approval.json'); fs.copyFileSync(EDITORIAL_APPROVAL, approvalCopy);
  fs.appendFileSync(approvalCopy, ' ');
  assert.throws(() => pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, pilotDir: PILOT_DIR, editorialApprovalPath: approvalCopy }),
    /PILOT_EDITORIAL_APPROVAL_HASH_MISMATCH/);
  assert.throws(() => pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, pilotDir: PILOT_DIR,
    editorialApprovalPath: EDITORIAL_APPROVAL, pins: { ...pilotWorkflow.TRUST, proposal: '0'.repeat(64) } }), /PILOT_APPROVAL_BINDING_MISMATCH/);
  assert.throws(() => pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, pilotDir: PILOT_DIR,
    editorialApprovalPath: EDITORIAL_APPROVAL, pins: { ...pilotWorkflow.TRUST, pilotIndex: '0'.repeat(64) } }), /PILOT_INDEX_HASH_MISMATCH/);
  const clone = clonePilotPackage(); t.after(() => fs.rmSync(clone.base, { recursive: true, force: true }));
  const proposalPath = path.join(clone.pilotDir, 'phase3-media-pilot-proposal.v1.json');
  fs.appendFileSync(proposalPath, ' ');
  assert.throws(() => pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, pilotDir: clone.pilotDir,
    editorialApprovalPath: EDITORIAL_APPROVAL }), /PILOT_INDEX_FILE_MISMATCH/);
});

test('pilot request parameters, model, endpoint and exact prompt must match the pinned proposal', t => {
  const clone = clonePilotPackage(); t.after(() => fs.rmSync(clone.base, { recursive: true, force: true }));
  const proposalPath = path.join(clone.pilotDir, 'phase3-media-pilot-proposal.v1.json');
  const proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
  proposal.requests[0].parameters.resolution = '2k';
  const proposalBytes = Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`);
  const indexHash = rewritePilotIndex(clone.pilotDir, proposalBytes);
  assert.throws(() => pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, pilotDir: clone.pilotDir,
    editorialApprovalPath: EDITORIAL_APPROVAL, pins: { ...pilotWorkflow.TRUST, pilotIndex: indexHash,
      pilotProposal: sha(proposalBytes) } }), /PILOT_REQUEST_DRIFT:still/);
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  f.authorization.authorizedRequests[0].endpointId = 'fal.ai/another-model';
  const altered = Buffer.from(`${JSON.stringify(f.authorization, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, 'still-execution-authorization.v1.json'), altered);
  assert.throws(() => loadTestAuthorization(f.root, f.planning, fs,
    sha(altered), { scope: 'STILL_ONLY', operation: 'GENERATE_STILL' }), /PILOT_AUTHORIZED_REQUEST_DRIFT/);
});

test('detached execution authorization is mandatory, hash-bound, ownership-aware and no-retry', async t => {
  const f = makePilotReadOnlyFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  let calls = 0;
  const workflow = pilotWorkflow.createPilotWorkflow({ root: f.root, expectedRoot: f.base, v5Dir: V5_DIR, pilotDir: PILOT_DIR,
    editorialApprovalPath: EDITORIAL_APPROVAL, provider: { async generateStill() { calls += 1; } } });
  await assert.rejects(workflow.generateStill(), /PILOT_EXECUTION_AUTHORIZATION_MISSING/);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'request-ledger.jsonl')), false);
  assert.throws(() => pilotWorkflow.parseCli(['--generate-still', '--pilot-run-id', pilotWorkflow.TRUST.runId]),
    /PILOT_EXPECTED_AUTHORIZATION_HASH_REQUIRED/);
  assert.throws(() => pilotWorkflow.parseCli(['--generate-still', '--pilot-run-id', pilotWorkflow.TRUST.runId,
    '--expected-execution-authorization-sha256', 'a'.repeat(64), '--retry']), /PILOT_UNKNOWN_ARGUMENT/);
  assert.throws(() => pilotWorkflow.parseCli(['--preflight', '--pilot-run-id', 'other-run']), /PILOT_RUN_ID_INVALID/);
});

test('request-scoped still authorization accepts exactly one deterministic still request', t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const loaded = loadTestAuthorization(f.root, f.planning, fs, sha(f.authorizationBytes),
    { scope: 'STILL_ONLY', operation: 'GENERATE_STILL' });
  assert.equal(loaded.record.scope, 'STILL_ONLY');
  assert.equal(loaded.record.operation, 'GENERATE_STILL');
  assert.equal(loaded.record.pilotRunId, pilotWorkflow.TRUST.runId);
  assert.equal(loaded.record.beatId, 'ACT3_B005');
  assert.equal(loaded.record.maxProviderSubmissions, 1);
  assert.deepEqual(loaded.record.authorizedRequests.map(x => x.requestKey), [pilotWorkflow.REQUESTS.still.key]);
  assert.equal(loaded.record.stillExposureAcceptance.maximumAcceptedExposureUsd, 0.05);
  assert.equal(loaded.record.stillExposureAcceptance.providerEnforcedMaximumCharge, false);
});

test('still-only authorization cannot be reused by animation, even after valid still approval', async t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.workflow.generateStill(); f.workflow.inspectStill();
  f.workflow.approveStill({ decision: 'APPROVED', approvedBy: 'Yakubu Moshood', approvalRef: 'test-review' });
  fs.copyFileSync(path.join(f.root, 'still-execution-authorization.v1.json'),
    path.join(f.root, 'animation-execution-authorization.v1.json'));
  const animationWorkflow = f.workflowFor(f.authorizationBytes);
  await assert.rejects(animationWorkflow.generateAnimation(), /PILOT_AUTHORIZATION_SCOPE_BINDING_MISMATCH/);
  assert.equal(f.calls.length, 1);
  assert.equal(pilotWorkflow.readLedger(path.join(f.root, 'request-ledger.jsonl'))
    .filter(row => row.recordType === 'SUBMISSION_RESERVED').length, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
});

test('combined requests, two-submission scoped auth, and missing ownership acceptance fail closed', t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const context = { scope: 'STILL_ONLY', operation: 'GENERATE_STILL' };
  const animationRequest = pilotExecutionAuthorization(f.planning, 'ANIMATION_ONLY').authorizedRequests[0];
  const combined = { ...f.authorization, authorizedRequests: [...f.authorization.authorizedRequests, animationRequest] };
  let bytes = Buffer.from(`${JSON.stringify(combined, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, 'still-execution-authorization.v1.json'), bytes);
  assert.throws(() => loadTestAuthorization(f.root, f.planning, fs, sha(bytes), context),
    /PILOT_AUTHORIZED_REQUEST_COUNT_INVALID/);
  const twoLimit = { ...f.authorization, maxProviderSubmissions: 2 };
  bytes = Buffer.from(`${JSON.stringify(twoLimit, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, 'still-execution-authorization.v1.json'), bytes);
  assert.throws(() => loadTestAuthorization(f.root, f.planning, fs, sha(bytes), context),
    /PILOT_EXECUTION_LIMITS_INVALID/);
  const noRiskAcceptance = { ...f.authorization, nonProductionRiskAcceptance: null };
  bytes = Buffer.from(`${JSON.stringify(noRiskAcceptance, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, 'still-execution-authorization.v1.json'), bytes);
  assert.throws(() => loadTestAuthorization(f.root, f.planning, fs, sha(bytes), context),
    /PILOT_UNRESOLVED_OWNERSHIP_RISK_ACCEPTANCE_INVALID/);
});

test('non-production ownership risk disposition is accepted only with every explicit restriction', t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const context = { scope: 'STILL_ONLY', operation: 'GENERATE_STILL' };
  assert.equal(loadTestAuthorization(f.root, f.planning, fs, sha(f.authorizationBytes), context)
    .record.ownershipDisposition, 'UNRESOLVED_ACCEPTED_FOR_NONPRODUCTION_PILOT_ONLY');
  const production = { ...f.authorization, outputClassification: 'PRODUCTION',
    nonProductionRiskAcceptance: { ...f.authorization.nonProductionRiskAcceptance, outputClassification: 'PRODUCTION' } };
  const bytes = Buffer.from(`${JSON.stringify(production, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, 'still-execution-authorization.v1.json'), bytes);
  assert.throws(() => loadTestAuthorization(f.root, f.planning, fs, sha(bytes), context),
    /PILOT_NONPRODUCTION_RESTRICTIONS_INVALID|PILOT_UNRESOLVED_OWNERSHIP_RISK_ACCEPTANCE_INVALID/);
});

test('animation authorization is blocked before still approval and valid separate authorization follows it', async t => {
  const early = makePilotFixture({ scope: 'ANIMATION_ONLY', authorizationFile: 'animation-execution-authorization.v1.json' });
  t.after(() => fs.rmSync(early.base, { recursive: true, force: true }));
  await assert.rejects(early.workflow.generateAnimation(), /PILOT_STILL_HUMAN_APPROVAL_REQUIRED/);
  assert.equal(early.calls.length, 0);
  assert.equal(fs.existsSync(path.join(early.root, 'pilot.lock')), false);

  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.workflow.generateStill(); f.workflow.inspectStill();
  const approval = f.workflow.approveStill({ decision: 'APPROVED', approvedBy: 'Yakubu Moshood', approvalRef: 'test-review' });
  const animation = attachAnimationAuthorization(f);
  assert.equal(animation.authorization.bindings.stillSha256, approval.stillSha256);
  assert.equal(animation.authorization.bindings.stillApprovalSha256, sha(fs.readFileSync(path.join(f.root, 'still-approval.v1.json'))));
  await animation.workflow.generateAnimation();
  const ledger = pilotWorkflow.readLedger(path.join(f.root, 'request-ledger.jsonl'));
  assert.equal(ledger.filter(row => row.recordType === 'SUBMISSION_RESERVED').length, 2);
  assert.deepEqual(new Set(ledger.filter(row => row.recordType === 'SUBMISSION_RESERVED').map(row => row.requestKey)),
    new Set([pilotWorkflow.REQUESTS.still.key, pilotWorkflow.REQUESTS.animation.key]));
});

test('animation-only authorization must bind the inspected and human-approved still exactly', async t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.workflow.generateStill(); f.workflow.inspectStill();
  f.workflow.approveStill({ decision: 'APPROVED', approvedBy: 'Yakubu Moshood', approvalRef: 'test-review' });
  const animation = attachAnimationAuthorization(f);
  const altered = { ...animation.authorization, bindings: { ...animation.authorization.bindings,
    stillSha256: '0'.repeat(64) } };
  const alteredBytes = Buffer.from(`${JSON.stringify(altered, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, 'animation-execution-authorization.v1.json'), alteredBytes);
  const alteredWorkflow = f.workflowFor(alteredBytes);
  await assert.rejects(alteredWorkflow.generateAnimation(), /PILOT_ANIMATION_AUTHORIZATION_STILL_BINDING_INVALID/);
  assert.equal(f.calls.length, 1);
  assert.equal(pilotWorkflow.readLedger(path.join(f.root, 'request-ledger.jsonl'))
    .filter(row => row.recordType === 'SUBMISSION_RESERVED').length, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
});

test('run paths must stay inside the isolated pilot root and reject completed or traversal targets', t => {
  const f = makePilotReadOnlyFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const outside = path.join(f.base, '..', 'episode-root', pilotWorkflow.TRUST.runId);
  const invalid = pilotWorkflow.createPilotWorkflow({ root: outside, expectedRoot: path.join(f.base, 'pilots'),
    v5Dir: V5_DIR, pilotDir: PILOT_DIR, editorialApprovalPath: EDITORIAL_APPROVAL });
  assert.throws(() => invalid.preflight(), /PILOT_PATH_OUTSIDE_AUTHORIZED_ROOT/);
  assert.throws(() => pilotWorkflow.parseCli(['--preflight', '--pilot-run-id', pilotWorkflow.TRUST.runId, '--promoted-run-id', PHASE2_RUN]),
    /PILOT_UNKNOWN_ARGUMENT/);
  const promotedFile = path.join(f.base, 'promoted-script.json'); fs.writeFileSync(promotedFile, 'immutable-promoted-bytes');
  const promotedHash = sha(fs.readFileSync(promotedFile));
  const promotedTarget = pilotWorkflow.createPilotWorkflow({ root: f.base, expectedRoot: f.base,
    v5Dir: V5_DIR, pilotDir: PILOT_DIR, editorialApprovalPath: EDITORIAL_APPROVAL });
  assert.throws(() => promotedTarget.preflight(), /PILOT_PREFLIGHT_EXISTING_RUN_NOT_EMPTY/);
  assert.equal(sha(fs.readFileSync(promotedFile)), promotedHash, 'attempts cannot alter promoted input files');
  fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, 'old-output.mp4'), 'already complete');
  assert.throws(() => f.workflow.preflight(), /PILOT_PREFLIGHT_EXISTING_RUN_NOT_EMPTY/);
});

test('symlinked planning packages are rejected before any pilot run files are created', t => {
  const f = makePilotReadOnlyFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const link = path.join(f.base, 'linked-pilot-inputs');
  try { fs.symlinkSync(PILOT_DIR, link, 'junction'); }
  catch { t.skip('Windows junction creation is unavailable in this test environment'); return; }
  const linked = pilotWorkflow.createPilotWorkflow({ root: f.root, expectedRoot: f.base, v5Dir: V5_DIR, pilotDir: link,
    editorialApprovalPath: EDITORIAL_APPROVAL });
  assert.throws(() => linked.preflight(), /PILOT_PACKAGE_ROOT_INVALID/);
  assert.equal(fs.existsSync(f.root), false);
});

test('request ledger reservations are append-only, hash chained, duplicate-safe and capped at two', t => {
  const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planning = { proposalSha256: 'a'.repeat(64) }, auth = { sha256: 'b'.repeat(64) };
  const still = { requestKey: pilotWorkflow.REQUESTS.still.key, model: pilotWorkflow.REQUESTS.still.model, parameters: pilotWorkflow.REQUESTS.still.params };
  const animation = { requestKey: pilotWorkflow.REQUESTS.animation.key, model: pilotWorkflow.REQUESTS.animation.model, parameters: pilotWorkflow.REQUESTS.animation.params };
  const stillAuth = { ...auth, scope: 'STILL_ONLY', record: { maxProviderSubmissions: 1, authorizedRequests: [{ requestKey: still.requestKey }] } };
  const animationAuth = { ...auth, scope: 'ANIMATION_ONLY', record: { maxProviderSubmissions: 1, authorizedRequests: [{ requestKey: animation.requestKey }] } };
  pilotWorkflow.reserveRequest({ root, request: still, stage: 'still', planning, auth: stillAuth });
  const ledger = path.join(root, 'request-ledger.jsonl'), firstHash = sha(fs.readFileSync(ledger));
  assert.throws(() => pilotWorkflow.reserveRequest({ root, request: still, stage: 'still', planning, auth: stillAuth }), /PILOT_DUPLICATE_REQUEST_KEY/);
  assert.equal(sha(fs.readFileSync(ledger)), firstHash);
  pilotWorkflow.reserveRequest({ root, request: animation, stage: 'animation', planning, auth: animationAuth });
  assert.throws(() => pilotWorkflow.reserveRequest({ root, request: animation, stage: 'animation', planning, auth: animationAuth }), /PILOT_SUBMISSION_LIMIT_REACHED/);
  const altered = fs.readFileSync(ledger, 'utf8').replace('SUBMISSION_RESERVED', 'SUBMISSION_RETRY'); fs.writeFileSync(ledger, altered);
  assert.throws(() => pilotWorkflow.readLedger(ledger), /PILOT_LEDGER_CHAIN_INVALID/);
});

test('successful still inspection, separate human approval, animation and final receipt use exactly two submissions', async t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.workflow.generateStill();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].service, 'still');
  assert.equal(f.calls[0].ledger.filter(row => row.recordType === 'SUBMISSION_RESERVED').length, 1,
    'reservation is durable before provider submission');
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
  const inspection = f.workflow.inspectStill();
  assert.deepEqual({ mimeType: inspection.mimeType, format: inspection.format, width: inspection.width, height: inspection.height },
    { mimeType: 'image/png', format: 'PNG', width: 1280, height: 720 });
  const decision = f.workflow.approveStill({ decision: 'APPROVED', approvedBy: 'Yakubu Moshood', approvalRef: 'test-review' });
  assert.equal(decision.stillSha256, inspection.stillSha256);
  const animationAuthorization = attachAnimationAuthorization(f);
  await animationAuthorization.workflow.generateAnimation();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].service, 'animation');
  assert.match(f.calls[1].payload.input.image_url, /^data:image\/png;base64,/u);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
  const receipt = f.workflow.finalize();
  assert.equal(receipt.status, 'PILOT_VALIDATED_DISPOSABLE_NOT_PRODUCTION');
  assert.equal(receipt.providerRequestCount, 2);
  assert.equal(receipt.outputs.still.assetClass, 'NON_PRODUCTION_DISPOSABLE_PILOT');
  assert.equal(receipt.outputs.animation.media.video.frameCount, 150);
  const outputIndex = JSON.parse(fs.readFileSync(path.join(f.root, 'pilot-package-index.v1.json'), 'utf8'));
  for (const file of outputIndex.files) assert.equal(sha(fs.readFileSync(path.join(f.root, ...file.path.split('/')))), file.sha256);
  assert.throws(() => v3AssetReadiness.assertNoDisposablePilotMedia(receipt.outputs), /DISPOSABLE_PILOT_ASSET_FORBIDDEN/);
  assert.throws(() => v3AssetReadiness.assertNoDisposablePilotMedia({ assetClass: 'NON_PRODUCTION_DISPOSABLE_PILOT' }),
    /DISPOSABLE_PILOT_ASSET_FORBIDDEN/);
});

test('animation is blocked before separate still approval and before any second reservation', async t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await assert.rejects(f.workflow.generateAnimation(), /PILOT_STILL_HUMAN_APPROVAL_REQUIRED/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'request-ledger.jsonl')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
});

test('altered still cannot be used for animation and provider failure leaves a redacted receipt and releases lock', async t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.workflow.generateStill(); f.workflow.inspectStill();
  f.workflow.approveStill({ decision: 'APPROVED', approvedBy: 'Yakubu Moshood', approvalRef: 'test-review' });
  const animationAuthorization = attachAnimationAuthorization(f);
  fs.appendFileSync(path.join(f.root, 'ACT3_B005-still.png'), 'altered');
  await assert.rejects(animationAuthorization.workflow.generateAnimation(), /PILOT_STILL_INPUT_INVALID/);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
  const f2 = makePilotFixture({ provider: { async generateStill() { throw new Error('FAL_KEY=must-never-be-recorded'); } } });
  t.after(() => fs.rmSync(f2.base, { recursive: true, force: true }));
  await assert.rejects(f2.workflow.generateStill(), /PILOT_OPERATION_FAILED/);
  assert.equal(fs.existsSync(path.join(f2.root, 'pilot.lock')), false);
  const receiptPath = path.join(f2.root, 'generate-still-failure-receipt.json');
  assert.equal(fs.existsSync(receiptPath), true);
  const contents = fs.readFileSync(receiptPath, 'utf8') + fs.readFileSync(path.join(f2.root, 'request-ledger.jsonl'), 'utf8');
  assert.equal(contents.includes('must-never-be-recorded'), false);
  await assert.rejects(f2.workflow.generateStill(), /PILOT_RUN_ALREADY_USED/);
});

test('invalid MIME or PNG signature blocks acceptance, consumes the one attempt and cleans temporary lock', async t => {
  const f = makePilotFixture({ provider: { async generateStill() { return { bytes: Buffer.from('not png'), contentType: 'text/plain' }; } } });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await assert.rejects(f.workflow.generateStill(), /PILOT_STILL_MIME_INVALID/);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
  const ledger = pilotWorkflow.readLedger(path.join(f.root, 'request-ledger.jsonl'));
  assert.equal(ledger.filter(row => row.recordType === 'SUBMISSION_RESERVED').length, 1);
  assert.equal(ledger.find(row => row.recordType === 'SUBMISSION_RESULT').status, 'FAILED');
});

test('stale lock is never cleared or overwritten and output outside pilot directory is rejected', async t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const lock = path.join(f.root, 'pilot.lock'); fs.writeFileSync(lock, 'stale-owner');
  await assert.rejects(f.workflow.generateStill(), /PILOT_RUN_ALREADY_USED|PILOT_LOCK_EXISTS/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'stale-owner');
  const out = path.join(f.base, '..', 'escaped');
  const invalid = pilotWorkflow.createPilotWorkflow({ root: out, expectedRoot: f.base, v5Dir: V5_DIR, pilotDir: PILOT_DIR,
    editorialApprovalPath: EDITORIAL_APPROVAL });
  assert.throws(() => invalid.preflight(), /PILOT_PATH_OUTSIDE_AUTHORIZED_ROOT/);
});

test('execution controls reject fallback, retries, and more than the two authorized requests', t => {
  assert.throws(() => pilotWorkflow.parseCli(['--generate-animation', '--pilot-run-id', pilotWorkflow.TRUST.runId,
    '--expected-execution-authorization-sha256', 'a'.repeat(64), '--fallback-provider', 'other']), /PILOT_UNKNOWN_ARGUMENT/);
  const base = tempRoot(), root = path.join(base, pilotWorkflow.TRUST.runId); fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const planning = { proposalSha256: 'a'.repeat(64) }, auth = { sha256: 'b'.repeat(64) };
  const still = pilotWorkflow.REQUESTS.still, animation = pilotWorkflow.REQUESTS.animation;
  const stillAuth = { ...auth, scope: 'STILL_ONLY', record: { maxProviderSubmissions: 1,
    authorizedRequests: [{ requestKey: still.key }] } };
  const animationAuth = { ...auth, scope: 'ANIMATION_ONLY', record: { maxProviderSubmissions: 1,
    authorizedRequests: [{ requestKey: animation.key }] } };
  pilotWorkflow.reserveRequest({ root, request: { ...still, requestKey: still.key, parameters: still.params }, stage: 'still', planning, auth: stillAuth });
  pilotWorkflow.reserveRequest({ root, request: { ...animation, requestKey: animation.key, parameters: animation.params }, stage: 'animation', planning, auth: animationAuth });
  assert.throws(() => pilotWorkflow.reserveRequest({ root, request: { ...animation, requestKey: animation.key, parameters: animation.params },
    stage: 'animation', planning, auth: animationAuth }), /PILOT_SUBMISSION_LIMIT_REACHED/);
});

test('unsupported media, invalid FFprobe output and production pilot references fail closed', () => {
  assert.throws(() => pilotWorkflow.pngInfo(Buffer.from('html')), /PILOT_STILL_NOT_PNG/);
  assert.throws(() => pilotWorkflow.probeVideo('ignored', () => ({ status: 1, stdout: '' })), /PILOT_FFPROBE_FAILED/);
  assert.throws(() => pilotWorkflow.probeVideo('ignored', () => ({ status: 0, stdout: JSON.stringify({ streams: [] }) })),
    /PILOT_VIDEO_STREAM_COUNT_INVALID/);
  assert.throws(() => v3AssetReadiness.assertNoDisposablePilotMedia({ allShots: [{ shotId: 'ACT3_B005',
    productionEligibility: 'NON_PRODUCTION_DISPOSABLE_PILOT' }] }), /DISPOSABLE_PILOT_ASSET_FORBIDDEN/);
  assert.throws(() => v3AssetReadiness.assertNoDisposablePilotMedia({ assetPath: '/data/.review/phase3-media-pilots/phase3-media-pilot-01/asset.png' }),
    /DISPOSABLE_PILOT_ASSET_FORBIDDEN/);
});

test('FAL SDK automatic retries are explicitly disabled for each one-shot pilot submission', async () => {
  const configurations = [], submissions = [];
  const fakeFal = { config(value) { configurations.push(value); }, async subscribe(model, options) {
    submissions.push({ model, options });
    return { data: model === pilotWorkflow.REQUESTS.still.model
      ? { images: [{ url: 'https://fal.media/fixture.png', content_type: 'image/png' }] }
      : { video: { url: 'https://fal.media/fixture.mp4', content_type: 'video/mp4' } } };
  } };
  const provider = pilotWorkflow.createFalProvider({ falModuleLoader: () => ({ fal: fakeFal }),
    credentialResolver: () => 'test-only-credential-sentinel' });
  await provider.generateStill({ model: pilotWorkflow.REQUESTS.still.model, input: { prompt: 'fixture' } });
  await provider.generateAnimation({ model: pilotWorkflow.REQUESTS.animation.model, input: { prompt: 'fixture' } });
  assert.equal(configurations.length, 2);
  assert.ok(configurations.every(config => config.retry.maxRetries === 0 && config.retry.retryableStatusCodes.length === 0));
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions.map(item => item.model), [pilotWorkflow.REQUESTS.still.model, pilotWorkflow.REQUESTS.animation.model]);
});

test('pilot-01 rejection is terminal and preserves its rejected output and run records', async t => {
  const f = makePilotFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const rejection = fs.readFileSync(path.join(PILOT02_DIR, 'human-rejection.v1.json'));
  fs.writeFileSync(path.join(f.root, 'human-rejection.v1.json'), rejection);
  fs.writeFileSync(path.join(f.root, 'ACT3_B005-still.png'), pilotPng());
  const locked = pilotWorkflow.createPilotWorkflow({ root: f.root, expectedRoot: f.base, v5Dir: V5_DIR,
    pilotDir: PILOT_DIR, editorialApprovalPath: EDITORIAL_APPROVAL, enforcePilot01Rejection: true });
  assert.equal(locked.preflight().status, 'HUMAN_REJECTED_AFTER_INSPECTION');
  const before = new Map(pilotWorkflow.strictTreeFiles(f.root).map(rel => [rel, sha(fs.readFileSync(path.join(f.root, rel)))]));
  await assert.rejects(locked.generateStill(), /PILOT01_HUMAN_REJECTED_TERMINAL/);
  await assert.rejects(locked.generateAnimation(), /PILOT01_HUMAN_REJECTED_TERMINAL/);
  assert.throws(() => locked.approveStill({ decision: 'APPROVED', approvedBy: 'Yakubu Moshood', approvalRef: 'bad' }),
    /PILOT01_HUMAN_REJECTED_TERMINAL/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(new Map(pilotWorkflow.strictTreeFiles(f.root).map(rel => [rel, sha(fs.readFileSync(path.join(f.root, rel)))])), before);
});

test('pilot-02 v2 approval and rejection bindings pass read-only preflight without creating files or locks', t => {
  const base = tempRoot(), root = path.join(base, pilotWorkflow.PILOT02.runId), pins = { ...pilotWorkflow.TRUST, runId: pilotWorkflow.PILOT02.runId };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const planning = pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, editorialApprovalPath: EDITORIAL_APPROVAL,
    pilotDir: PILOT02_DIR, pins });
  assert.equal(planning.proposalSha256, 'c31d49a3a7b9fda8a70c17b24c08c6a1ee5634e82cb447ebf9a438ffdf6329d7');
  assert.equal(planning.repromptApprovalSha256, '7569cf6f75807f256fa760d53a0fa28311cf98d41ecd572e18b96ca2920b90f9');
  assert.equal(planning.still.requestKey, pilotWorkflow.PILOT02.requestKey);
  const workflow = pilotWorkflow.createPilotWorkflow({ root, expectedRoot: base, v5Dir: V5_DIR,
    editorialApprovalPath: EDITORIAL_APPROVAL, pilotDir: PILOT02_DIR, pins });
  const result = workflow.preflight();
  assert.equal(result.status, 'PILOT_PREFLIGHT_PASS_ANIMATION_PLANNING_READY_EXECUTION_UNAUTHORIZED');
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.providerSubmissionsMaximum, 2);
  assert.deepEqual(result.requestKeys, [pilotWorkflow.PILOT02.requestKey, pilotWorkflow.PILOT02_EXTENSION.requestKey]);
  assert.equal(result.sourceBindings.animationExtensionPackageIndexSha256, pilotWorkflow.PILOT02_EXTENSION.packageIndex);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(path.join(root, 'pilot.lock')), false);
});

test('pilot-02 planning fails closed on a missing or altered rejection record, prompt, approval, or package binding', t => {
  const base = tempRoot(), packageCopy = path.join(base, 'package'), approvalCopy = path.join(base, 'phase3-media-pilot-proposal-20261002-v2-human-approval.v1.json');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.cpSync(PILOT02_DIR, packageCopy, { recursive: true });
  const verify = () => pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, editorialApprovalPath: EDITORIAL_APPROVAL,
    pilotDir: packageCopy, pins: { ...pilotWorkflow.TRUST, runId: pilotWorkflow.PILOT02.runId } });
  assert.throws(verify, /ENOENT/);
  fs.copyFileSync(PILOT02_APPROVAL, approvalCopy);
  verify();
  fs.writeFileSync(path.join(packageCopy, 'phase3-media-pilot-plan.v1.json'),
    fs.readFileSync(path.join(packageCopy, 'phase3-media-pilot-plan.v1.json'), 'utf8').replace('customer’s', "customer's"));
  assert.throws(verify, /PILOT_INDEX_FILE_MISMATCH/);
  fs.rmSync(packageCopy, { recursive: true, force: true }); fs.cpSync(PILOT02_DIR, packageCopy, { recursive: true });
  fs.unlinkSync(path.join(packageCopy, 'human-rejection.v1.json'));
  assert.throws(verify, /ENOENT|PILOT_PACKAGE/);
  fs.cpSync(PILOT02_DIR, packageCopy, { recursive: true });
  fs.writeFileSync(path.join(packageCopy, 'human-rejection.v1.json'), 'altered');
  assert.throws(verify, /PILOT_INDEX_FILE_MISMATCH/);
  fs.rmSync(packageCopy, { recursive: true, force: true }); fs.cpSync(PILOT02_DIR, packageCopy, { recursive: true });
  fs.writeFileSync(approvalCopy, 'altered');
  const approvalBytes = fs.readFileSync(PILOT02_APPROVAL);
  assert.notEqual(sha(fs.readFileSync(approvalCopy)), sha(approvalBytes));
  assert.throws(verify, /PILOT02_HUMAN_APPROVAL_HASH_MISMATCH/);
});

test('Pilot-02 animation extension package and detached planning approval verify as immutable inputs', t => {
  const f = makePilotReadOnlyFixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const planning = pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, editorialApprovalPath: EDITORIAL_APPROVAL,
    pilotDir: PILOT02_DIR, pins: { ...pilotWorkflow.TRUST, runId: pilotWorkflow.PILOT02.runId } });
  const extensionDir = path.join(path.dirname(PILOT02_DIR), 'phase3-media-pilot-animation-extension-20261003-v1');
  const approvalPath = path.join(path.dirname(extensionDir), 'phase3-media-pilot-animation-extension-20261003-v1-human-approval.v1.json');
  const extension = pilotWorkflow.verifyPilot02AnimationExtension(planning, { extensionDir, extensionApprovalPath: approvalPath });
  assert.equal(extension.animation.requestKey, pilotWorkflow.PILOT02_EXTENSION.requestKey);
  assert.equal(extension.animation.sourceStillSha256, pilotWorkflow.PILOT02.approvedStill);
  assert.equal(extension.animationExtension.packageIndexSha256, pilotWorkflow.PILOT02_EXTENSION.packageIndex);
  assert.equal(fs.existsSync(f.root), false);
  const copy = path.join(f.base, 'altered-extension'); fs.cpSync(extensionDir, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'animation-extension-proposal.v1.json'), 'altered');
  assert.throws(() => pilotWorkflow.verifyPilot02AnimationExtension(planning,
    { extensionDir: copy, extensionApprovalPath: approvalPath }), /PILOT_INDEX_FILE_MISMATCH/);
  const approvalCopy = path.join(f.base, 'altered-approval.json'); fs.writeFileSync(approvalCopy, 'altered');
  assert.throws(() => pilotWorkflow.verifyPilot02AnimationExtension(planning,
    { extensionDir, extensionApprovalPath: approvalCopy }), /PILOT02_ANIMATION_EXTENSION_APPROVAL_HASH_MISMATCH/);
});

test('Pilot-02 animation authorization is separate, post-approval, still-bound and one-request only', t => {
  const f = makePilot02Fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const approval = { decision: 'APPROVED', decidedAt: '2026-10-03T12:00:00.000Z' };
  const approvalSha256 = 'd'.repeat(64), auth = pilot02AnimationAuthorization(f.planning, approval, approvalSha256);
  const bytes = Buffer.from(`${JSON.stringify(auth, null, 2)}\n`);
  const authPath = path.join(f.root, 'animation-execution-authorization.v1.json'); fs.writeFileSync(authPath, bytes);
  const context = { scope: 'ANIMATION_ONLY', operation: 'GENERATE_ANIMATION', stillSha256: pilotWorkflow.PILOT02.approvedStill,
    stillApprovalSha256: approvalSha256, stillApprovalDecidedAt: approval.decidedAt };
  const loaded = pilotWorkflow.loadDetachedExecutionAuthorization(f.root, f.planning, fs, sha(bytes), context,
    { now: () => '2026-10-03T12:00:00.000Z' });
  assert.equal(loaded.scope, 'ANIMATION_ONLY');
  assert.equal(loaded.record.maxProviderSubmissions, 1);
  assert.deepEqual(loaded.record.authorizedRequests.map(item => item.requestKey), [pilotWorkflow.PILOT02_EXTENSION.requestKey]);
  for (const altered of [
    { ...auth, authorizedRequests: [...auth.authorizedRequests, auth.authorizedRequests[0]] },
    { ...auth, maxProviderSubmissions: 2 },
    { ...auth, requestKey: pilotWorkflow.PILOT02.requestKey },
    { ...auth, authorizedAt: '2026-10-03T11:59:59.000Z' },
    { ...auth, bindings: { ...auth.bindings, stillSha256: '0'.repeat(64) } },
    { ...auth, animationExposureAcceptance: { ...auth.animationExposureAcceptance, providerEnforcedMaximumCharge: true } },
  ]) {
    const changed = Buffer.from(`${JSON.stringify(altered, null, 2)}\n`); fs.writeFileSync(authPath, changed);
    assert.throws(() => loadTestAuthorization(f.root, f.planning, fs, sha(changed), context),
      /PILOT_AUTHORIZED_REQUEST_COUNT_INVALID|PILOT_EXECUTION_LIMITS_INVALID|PILOT_AUTHORIZATION_SCOPE_BINDING_MISMATCH|PILOT_ANIMATION_AUTHORIZATION_STILL_BINDING_INVALID|PILOT02_ANIMATION_AUTHORIZATION_BINDING_INVALID|PILOT02_ANIMATION_EXPOSURE_ACCEPTANCE_INVALID/);
  }
});

test('Pilot-02 animation price freshness uses an explicit UTC clock and expires at next UTC midnight', t => {
  const f = makePilot02Fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const approval = { decision: 'APPROVED', decidedAt: '2026-10-03T12:00:00.000Z' };
  const approvalSha256 = 'd'.repeat(64), auth = pilot02AnimationAuthorization(f.planning, approval, approvalSha256);
  const bytes = Buffer.from(JSON.stringify(auth, null, 2) + '\n');
  const authPath = path.join(f.root, 'animation-execution-authorization.v1.json');
  fs.writeFileSync(authPath, bytes);
  const context = { scope: 'ANIMATION_ONLY', operation: 'GENERATE_ANIMATION',
    stillSha256: pilotWorkflow.PILOT02.approvedStill, stillApprovalSha256: approvalSha256,
    stillApprovalDecidedAt: approval.decidedAt };
  const loadAt = now => pilotWorkflow.loadDetachedExecutionAuthorization(f.root, f.planning, fs, sha(bytes), context,
    { now: () => now });
  const deadline = '2026-10-04T00:00:00.000Z';

  assert.doesNotThrow(() => loadAt('2026-10-03T23:59:59.999Z'));
  assert.throws(() => loadAt(deadline), /PILOT02_ANIMATION_PRICE_RECHECK_REQUIRED/);
  assert.throws(() => loadAt('2026-10-04T00:00:00.001Z'), /PILOT02_ANIMATION_PRICE_RECHECK_REQUIRED/);
  assert.throws(() => loadAt('not-a-time'), /PILOT_VALIDATION_CLOCK_INVALID/);
  assert.throws(() => loadAt('2026-10-03T12:00:00.000+01:00'), /PILOT_VALIDATION_CLOCK_INVALID/);

  withFixedDate('2026-10-03T23:59:59.999Z', () => {
    assert.doesNotThrow(() => pilotWorkflow.loadDetachedExecutionAuthorization(f.root, f.planning, fs, sha(bytes), context));
  });
  withFixedDate(deadline, () => {
    assert.throws(() => pilotWorkflow.loadDetachedExecutionAuthorization(f.root, f.planning, fs, sha(bytes), context),
      /PILOT02_ANIMATION_PRICE_RECHECK_REQUIRED/);
  });
});

test('historical read-only authorization validation cannot authorize a new expired animation submission', async t => {
  const f = makePilot02Fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.workflow.generateStill();
  f.workflow.inspectStill();
  const stillApproval = f.workflow.approveStill({ decision: 'APPROVED', approvedBy: 'Yakubu Moshood',
    approvalRef: pilotWorkflow.PILOT02_EXTENSION.stillApprovalRef });
  const stillApprovalBytes = fs.readFileSync(path.join(f.root, 'still-approval.v1.json'));
  const animationAuth = pilot02AnimationAuthorization(f.planning, stillApproval, sha(stillApprovalBytes),
    { priceCheckedAt: '2026-10-03T00:00:00.000Z' });
  animationAuth.bindings.stillSha256 = stillApproval.stillSha256;
  const bytes = Buffer.from(JSON.stringify(animationAuth, null, 2) + '\n');
  fs.writeFileSync(path.join(f.root, 'animation-execution-authorization.v1.json'), bytes);
  const context = { scope: 'ANIMATION_ONLY', operation: 'GENERATE_ANIMATION',
    stillSha256: stillApproval.stillSha256, stillApprovalSha256: sha(stillApprovalBytes),
    stillApprovalDecidedAt: stillApproval.decidedAt };
  assert.doesNotThrow(() => pilotWorkflow.loadDetachedExecutionAuthorization(f.root, f.planning, fs, sha(bytes), context,
    { now: () => '2026-10-03T12:00:00.000Z' }));

  const ledgerPath = path.join(f.root, 'request-ledger.jsonl');
  const ledgerBefore = fs.readFileSync(ledgerPath), providerCallsBefore = f.calls.length;
  const expiredWorkflow = f.workflowFor(bytes, { authorizationNow: () => '2026-10-04T00:00:00.000Z' });
  assert.throws(() => expiredWorkflow.preflight(), /PILOT02_ANIMATION_PRICE_RECHECK_REQUIRED/);
  await assert.rejects(expiredWorkflow.generateAnimation(), /PILOT02_ANIMATION_PRICE_RECHECK_REQUIRED/);
  assert.equal(f.calls.length, providerCallsBefore);
  assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBefore);
  assert.equal(pilotWorkflow.readLedger(ledgerPath).filter(row => row.recordType === 'SUBMISSION_RESERVED').length, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
});

test('Pilot-02 file-set validation admits only its verified animation state and pre-reservation failure audit', async t => {
  const f = makePilot02Fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.workflow.generateStill();
  f.workflow.inspectStill();
  f.workflow.approveStill({ decision: 'APPROVED', approvedBy: 'Yakubu Moshood',
    approvalRef: pilotWorkflow.PILOT02_EXTENSION.stillApprovalRef });

  const ledgerPath = path.join(f.root, 'request-ledger.jsonl');
  let ledger = pilotWorkflow.readLedger(ledgerPath);
  const stillOnlyState = pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, { ledger });
  assert.equal(stillOnlyState.hasAnimationAuthorization, false);
  assert.equal(stillOnlyState.existing.includes('pilot.lock'), false);

  const approval = JSON.parse(fs.readFileSync(path.join(f.root, 'still-approval.v1.json'), 'utf8'));
  const approvalSha256 = sha(fs.readFileSync(path.join(f.root, 'still-approval.v1.json')));
  const animationAuthorization = pilot02AnimationAuthorization(f.planning, approval, approvalSha256);
  const animationBytes = Buffer.from(`${JSON.stringify(animationAuthorization, null, 2)}\n`);
  const animationAuthPath = path.join(f.root, 'animation-execution-authorization.v1.json');
  fs.writeFileSync(animationAuthPath, animationBytes);
  const animationAuthSha = sha(animationBytes);
  loadTestAuthorization(f.root, f.planning, fs, animationAuthSha,
    { scope: 'ANIMATION_ONLY', operation: 'GENERATE_ANIMATION', stillSha256: pilotWorkflow.PILOT02.approvedStill,
      stillApprovalSha256: approvalSha256, stillApprovalDecidedAt: approval.decidedAt },
    { now: () => '2026-10-03T12:00:00.000Z' });
  const options = { animationAuthorizationSha256: animationAuthSha, ledger };
  assert.equal(pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options).hasAnimationAuthorization, true);
  assert.throws(() => pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs,
    { ...options, animationAuthorizationSha256: '0'.repeat(64) }), /PILOT02_ANIMATION_AUTHORIZATION_UNVERIFIED/);

  const lockPath = path.join(f.root, 'pilot.lock');
  fs.writeFileSync(lockPath, `${process.pid}\n`);
  assert.doesNotThrow(() => pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs,
    { ...options, executionLockPath: lockPath }));
  assert.throws(() => pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options),
    /PILOT02_STILL_RUN_FILE_SET_INVALID/);
  fs.unlinkSync(lockPath);

  const receiptBase = { schemaVersion: 'phase3-media-pilot-failure-receipt/1.0.0', status: 'FAILED',
    command: 'generate-animation', errorCode: 'PILOT02_STILL_RUN_FILE_SET_INVALID',
    context: { authorizationSha256: sha(animationBytes), animationReservationCount: 0,
      animationProviderRequestCount: 0 }, recordedAt: '2026-10-03T14:00:00.000Z', providerRequestCount: 1,
    pilotRunId: pilotWorkflow.PILOT02.runId, requestKey: pilotWorkflow.PILOT02_EXTENSION.requestKey,
    scope: 'ANIMATION_ONLY', failureStage: 'BEFORE_RESERVATION' };
  const receipt = { ...receiptBase, receiptBindingSha256: sha(Buffer.from(JSON.stringify(receiptBase))) };
  const receiptPath = path.join(f.root, 'generate-animation-failure-receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.equal(pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options).hasAnimationAuthorization, true);

  const afterReservationBase = { ...receiptBase, failureStage: 'AFTER_RESERVATION',
    context: { ...receiptBase.context, animationReservationCount: 1, animationProviderRequestCount: 1 } };
  const afterReservationReceipt = { ...afterReservationBase,
    receiptBindingSha256: sha(Buffer.from(JSON.stringify(afterReservationBase))) };
  fs.writeFileSync(receiptPath, `${JSON.stringify(afterReservationReceipt, null, 2)}\n`);
  assert.throws(() => pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options),
    /PILOT02_ANIMATION_FAILURE_RECEIPT_INVALID/);

  const altered = { ...receipt, requestKey: pilotWorkflow.PILOT02.requestKey };
  fs.writeFileSync(receiptPath, `${JSON.stringify(altered, null, 2)}\n`);
  assert.throws(() => pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options),
    /PILOT02_ANIMATION_FAILURE_RECEIPT_INVALID/);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receiptBase, null, 2)}\n`);
  assert.throws(() => pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options),
    /PILOT02_ANIMATION_FAILURE_RECEIPT_INVALID/);

  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.writeFileSync(path.join(f.root, 'unrecognized-extra.txt'), 'unknown');
  assert.throws(() => pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options),
    /PILOT02_STILL_RUN_FILE_SET_INVALID/);
  fs.unlinkSync(path.join(f.root, 'unrecognized-extra.txt'));

  assert.equal(pilotWorkflow.assertPilot02AnimationSubmissionEligible(ledger, f.planning), true);
  const afterReservation = [...ledger, { recordType: 'SUBMISSION_RESERVED', requestKey: f.planning.animation.requestKey,
    stage: 'animation', retryAllowed: false, fallbackAllowed: false }];
  assert.throws(() => pilotWorkflow.assertPilot02AnimationSubmissionEligible(afterReservation, f.planning),
    /PILOT_ANIMATION_REQUIRES_SUCCESSFUL_STILL_ATTEMPT/);
});

test('Pilot-02 finalization approval and motion proposal are the exact detached immutable records', () => {
  const recordBytes = fs.readFileSync(PILOT02_VALIDATION_APPROVAL), motionBytes = fs.readFileSync(PILOT02_MOTION_PROPOSAL);
  assert.equal(sha(recordBytes), pilotWorkflow.PILOT02_FINALIZATION.humanValidationApprovalSha256);
  assert.equal(recordBytes.length, 2261);
  assert.equal(sha(motionBytes), pilotWorkflow.PILOT02_FINALIZATION.motionPolicyProposalSha256);
  assert.equal(motionBytes.length, 1636);
  const approval = JSON.parse(recordBytes), motion = JSON.parse(motionBytes);
  assert.equal(approval.status, 'APPROVED_FOR_PILOT_VALIDATION_ONLY');
  assert.equal(approval.productionAssetApproval, false);
  assert.equal(approval.rawOutput.productionReadiness, 'REJECTED');
  assert.equal(approval.fittedOutput.productionReadiness, 'REJECTED');
  assert.equal(motion.status, 'PROPOSED_UNSIGNED_NOT_APPLIED');
  assert.equal(motion.approval, 'Not approved or applied by the pilot-validation decision.');
});

test('Pilot-02 accepts the exact completed animation file set and only a finalizer-owned lock', async t => {
  const f = await makePilot02CompletedFixture(t);
  const lockPath = path.join(f.root, 'pilot.lock'); fs.writeFileSync(lockPath, `${process.pid}\n`);
  const options = { allowAnimationResults: true,
    animationAuthorizationSha256: f.finalizationPins.animationAuthorizationSha256,
    executionLockPath: lockPath, allowFinalizeFailureReceipt: true, finalizationPins: f.finalizationPins,
    ledger: pilotWorkflow.readLedger(path.join(f.root, 'request-ledger.jsonl')) };
  const state = pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options);
  assert.equal(state.hasAnimationAuthorization, true);
  const legacyFailurePath = path.join(f.root, 'finalize-failure-receipt.json');
  const legacyFailureBytes = fs.readFileSync(legacyFailurePath);
  assert.equal(legacyFailureBytes.length, 256);
  assert.equal(sha(legacyFailureBytes), 'c9883ae81aa4eb82e8aff6b60a963c378f31a505dac19714b1ed49ccd7ad37e8');
  assert.equal(pilotWorkflow.validatePilot02FinalizeFailureReceipt(f.root, fs, options.ledger,
    f.finalizationPins), true);
  assert.equal(pilotWorkflow.strictTreeFiles(f.root).includes('generate-animation-failure-receipt.json'), true);
  assert.equal(pilotWorkflow.strictTreeFiles(f.root).includes('finalize-failure-receipt.json'), true);
  assert.equal(pilotWorkflow.strictTreeFiles(f.root).includes('ACT3_B005-animation-provider-output.bin'), true);
  assert.equal(pilotWorkflow.strictTreeFiles(f.root).includes('ACT3_B005-animation-30fps-110f.mp4'), true);
  assert.equal(pilotWorkflow.strictTreeFiles(f.root).includes('animation-receipt.v1.json'), true);
  assert.equal(pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options).hasAnimationAuthorization, true);
  assert.throws(() => pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs,
    { ...options, executionLockPath: '' }), /PILOT02_STILL_RUN_FILE_SET_INVALID/);
  fs.writeFileSync(lockPath, 'other-process\n');
  assert.throws(() => pilotWorkflow.validatePilot02RunFileSet(f.root, f.planning, fs, options),
    /PILOT02_EXECUTION_LOCK_NOT_OWNED/);
  fs.unlinkSync(lockPath);
});

test('Pilot-02 historical finalize failure receipt is accepted only byte-for-byte with the pinned completed state', async t => {
  const f = await makePilot02CompletedFixture(t);
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const receiptPath = path.join(f.root, 'finalize-failure-receipt.json');
  const ledgerPath = path.join(f.root, 'request-ledger.jsonl');
  const ledgerBytes = fs.readFileSync(ledgerPath), ledger = pilotWorkflow.readLedger(ledgerPath);
  const validate = () => pilotWorkflow.validatePilot02FinalizeFailureReceipt(f.root, fs, ledger, f.finalizationPins);
  const before = pilotWorkflow.strictTreeFiles(f.root).map(rel => [rel,
    sha(fs.readFileSync(path.join(f.root, ...rel.split('/'))))]);
  assert.equal(validate(), true);
  for (const [field, value] of [
    ['schemaVersion', 'phase3-media-pilot-finalize-failure-receipt/1.0.0'],
    ['status', 'SUCCEEDED'], ['command', 'generate-animation'],
    ['errorCode', 'OTHER_FAILURE'], ['recordedAt', '2026-10-03T17:35:18.995Z'],
    ['providerRequestCount', 1],
  ]) {
    const changed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    changed[field] = value;
    fs.writeFileSync(receiptPath, `${JSON.stringify(changed, null, 2)}\n`);
    assert.throws(validate, /PILOT02_FINALIZE_FAILURE_RECEIPT_INVALID/,
      `historical receipt field ${field} must be pinned`);
    fs.writeFileSync(receiptPath, f.originalLegacyFinalizeFailureBytes);
  }
  assert.equal(sha(fs.readFileSync(receiptPath)), 'c9883ae81aa4eb82e8aff6b60a963c378f31a505dac19714b1ed49ccd7ad37e8');

  const arbitrary = { schemaVersion: 'phase3-media-pilot-failure-receipt/1.0.0', status: 'FAILED',
    command: 'finalize', errorCode: 'PILOT02_STILL_RUN_FILE_SET_INVALID', context: {},
    recordedAt: '2026-10-03T17:35:18.994Z', providerRequestCount: 3 };
  fs.writeFileSync(receiptPath, `${JSON.stringify(arbitrary, null, 2)}\n`);
  assert.throws(validate, /PILOT02_FINALIZE_FAILURE_RECEIPT_INVALID/,
    'an arbitrary empty-context receipt cannot use the legacy exception');
  fs.writeFileSync(receiptPath, f.originalLegacyFinalizeFailureBytes);

  const alteredLedger = { ...f.finalizationPins, ledgerSha256: '0'.repeat(64) };
  assert.throws(() => pilotWorkflow.validatePilot02FinalizeFailureReceipt(f.root, fs, ledger, alteredLedger),
    /PILOT02_FINALIZE_FAILURE_RECEIPT_INVALID/);
  const extraLedger = [...ledger, { recordType: 'SUBMISSION_RESERVED', requestKey: 'extra', stage: 'animation',
    retryAllowed: false, fallbackAllowed: false }];
  assert.throws(() => pilotWorkflow.validatePilot02FinalizeFailureReceipt(f.root, fs, extraLedger, f.finalizationPins),
    /PILOT02_FINALIZE_FAILURE_RECEIPT_INVALID/);

  for (const [relative, expectedError] of [
    ['ACT3_B005-animation-provider-output.bin', /PILOT02_FINALIZE_FAILURE_RECEIPT_INVALID/],
    ['ACT3_B005-animation-30fps-110f.mp4', /PILOT02_FINALIZE_FAILURE_RECEIPT_INVALID/],
    ['animation-receipt.v1.json', /PILOT02_FINALIZE_FAILURE_RECEIPT_INVALID/],
  ]) {
    const file = path.join(f.root, relative), original = fs.readFileSync(file);
    fs.appendFileSync(file, 'altered');
    assert.throws(validate, expectedError);
    fs.writeFileSync(file, original);
  }
  assert.equal(sha(fs.readFileSync(ledgerPath)), sha(ledgerBytes));
  assert.deepEqual(pilotWorkflow.strictTreeFiles(f.root).map(rel => [rel,
    sha(fs.readFileSync(path.join(f.root, ...rel.split('/'))))]), before);
  assert.equal(f.calls.length, 2);
});

test('Pilot-02 read-only preflight recognises the exact legacy finalization failure state without writes', async t => {
  const f = await makePilot02CompletedFixture(t);
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const filesBefore = pilotWorkflow.strictTreeFiles(f.root).map(rel => [rel,
    sha(fs.readFileSync(path.join(f.root, ...rel.split('/'))))]);
  const result = f.finalWorkflow.preflight();
  assert.equal(result.status, 'PILOT_PREFLIGHT_PASS_FINALIZATION_READY');
  assert.equal(result.executionAuthorized, true);
  assert.deepEqual(pilotWorkflow.strictTreeFiles(f.root).map(rel => [rel,
    sha(fs.readFileSync(path.join(f.root, ...rel.split('/'))))]), filesBefore);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
  assert.equal(f.calls.length, 2);
});

test('Pilot-02 finalizes the approved route without provider, ledger, media or Stage04 changes and remains disposable', async t => {
  const f = await makePilot02CompletedFixture(t);
  const stage04Sentinel = path.join(f.base, 'stage04-promoted-file-sentinel');
  fs.writeFileSync(stage04Sentinel, 'immutable Stage04 fixture');
  const stage04Hash = sha(fs.readFileSync(stage04Sentinel));
  const ledgerPath = path.join(f.root, 'request-ledger.jsonl'), ledgerBefore = fs.readFileSync(ledgerPath);
  const rawPath = path.join(f.root, 'ACT3_B005-animation-provider-output.bin');
  const fittedPath = path.join(f.root, 'ACT3_B005-animation-30fps-110f.mp4');
  const rawBefore = sha(fs.readFileSync(rawPath)), fittedBefore = sha(fs.readFileSync(fittedPath));
  const receipt = f.finalWorkflow.finalize();
  assert.equal(receipt.status, 'PILOT_VALIDATED_DISPOSABLE_NOT_PRODUCTION');
  assert.equal(receipt.humanDecision, 'APPROVED_FOR_PILOT_VALIDATION_ONLY');
  assert.equal(receipt.productionReadiness, 'REJECTED');
  assert.equal(receipt.providerRequestCount, 2);
  assert.equal(receipt.requestLedgerSha256BeforeFinalize, sha(ledgerBefore));
  assert.equal(receipt.requestLedgerSha256AfterFinalize, sha(ledgerBefore));
  assert.equal(receipt.bindings.humanValidationApprovalSha256, f.finalizationPins.humanValidationApprovalSha256);
  assert.equal(receipt.bindings.motionPolicyProposalSha256, f.finalizationPins.motionPolicyProposalSha256);
  assert.equal(sha(fs.readFileSync(ledgerPath)), sha(ledgerBefore));
  assert.equal(f.calls.length, 2, 'finalization performs no third provider call');
  assert.equal(sha(fs.readFileSync(rawPath)), rawBefore);
  assert.equal(sha(fs.readFileSync(fittedPath)), fittedBefore);
  assert.equal(sha(fs.readFileSync(stage04Sentinel)), stage04Hash);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, 'pilot-asset-manifest.v1.json')));
  assert.equal(manifest.assetClass, 'NON_PRODUCTION_DISPOSABLE_PILOT');
  assert.equal(manifest.productionReadiness, 'REJECTED');
  assert.equal(manifest.entries.length, 3);
  assert.throws(() => v3AssetReadiness.assertNoDisposablePilotMedia(manifest), /DISPOSABLE_PILOT_ASSET_FORBIDDEN/);
  const indexBytes = fs.readFileSync(path.join(f.root, 'pilot-package-index.v1.json'));
  const index = JSON.parse(indexBytes);
  assert.equal(index.status, 'PILOT_VALIDATED_DISPOSABLE_NOT_PRODUCTION');
  for (const item of index.files) {
    const bytes = fs.readFileSync(path.join(f.root, ...item.path.split('/')));
    assert.equal(bytes.length, item.bytes, item.path);
    assert.equal(sha(bytes), item.sha256, item.path);
  }
  const indexedSet = new Set(index.files.map(item => item.path));
  assert.equal(indexedSet.has('generate-animation-failure-receipt.json'), true);
  assert.equal(indexedSet.has('finalize-failure-receipt.json'), true);
  const snapshot = index.files.map(item => [item.path, sha(fs.readFileSync(path.join(f.root, ...item.path.split('/'))))]);
  assert.throws(() => f.finalWorkflow.finalize(), /PILOT_RUN_ALREADY_COMPLETE/);
  assert.deepEqual(index.files.map(item => [item.path, sha(fs.readFileSync(path.join(f.root, ...item.path.split('/'))))]), snapshot);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
});

test('Pilot-02 finalization rejects altered receipts, unknown files, changed media and changed ledger', async t => {
  const alteredFailure = await makePilot02CompletedFixture(t);
  const failurePath = path.join(alteredFailure.root, 'finalize-failure-receipt.json');
  fs.appendFileSync(failurePath, 'altered');
  assert.throws(() => alteredFailure.finalWorkflow.finalize(), /PILOT02_FINALIZE_FAILURE_RECEIPT_INVALID/);
  assert.equal(fs.existsSync(path.join(alteredFailure.root, 'pilot.lock')), false);
  assert.equal(fs.existsSync(path.join(alteredFailure.root, 'pilot-package-index.v1.json')), false);

  const alteredAnimationFailure = await makePilot02CompletedFixture(t);
  fs.appendFileSync(path.join(alteredAnimationFailure.root, 'generate-animation-failure-receipt.json'), 'altered');
  assert.throws(() => alteredAnimationFailure.finalWorkflow.finalize(), /PILOT02_ANIMATION_FAILURE_RECEIPT_INVALID/);
  assert.equal(fs.existsSync(path.join(alteredAnimationFailure.root, 'pilot.lock')), false);

  const unknown = await makePilot02CompletedFixture(t);
  fs.writeFileSync(path.join(unknown.root, 'unexpected.txt'), 'no');
  assert.throws(() => unknown.finalWorkflow.finalize(), /PILOT02_STILL_RUN_FILE_SET_INVALID/);
  assert.equal(fs.existsSync(path.join(unknown.root, 'pilot.lock')), false);

  const alteredMedia = await makePilot02CompletedFixture(t);
  fs.appendFileSync(path.join(alteredMedia.root, 'ACT3_B005-animation-provider-output.bin'), 'changed');
  assert.throws(() => alteredMedia.finalWorkflow.finalize(), /PILOT02_FINALIZE_FAILURE_RECEIPT_INVALID|PILOT02_FINAL_OUTPUT_HASH_MISMATCH/);
  assert.equal(fs.existsSync(path.join(alteredMedia.root, 'pilot.lock')), false);

  const alteredLedger = await makePilot02CompletedFixture(t);
  fs.appendFileSync(path.join(alteredLedger.root, 'request-ledger.jsonl'), 'tampered\n');
  assert.throws(() => alteredLedger.finalWorkflow.finalize(), /PILOT_LEDGER_INVALID_LINE/);
  assert.equal(fs.existsSync(path.join(alteredLedger.root, 'pilot.lock')), false);
});

test('Pilot-02 media fit deterministically trims to 110 frames at 30 fps and fails if source coverage is short', t => {
  const dir = tempRoot(), input = path.join(dir, 'provider.bin'), output = path.join(dir, 'fit.mp4'), temp = `${output}.tmp.mp4`;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.writeFileSync(input, 'provider video');
  let probes = 0, ffmpegCalls = 0;
  const ffprobe = () => { probes += 1; return probes === 1
    ? { container: 'mov,mp4', durationSeconds: 5, bytes: 100, video: { codec: 'h264', width: 640, height: 360,
      frameRate: '30/1', frameCount: 150 }, audioStreams: [] }
    : { container: 'mov,mp4', durationSeconds: 110 / 30, bytes: 80, video: { codec: 'h264', width: 640, height: 360,
      frameRate: '30/1', frameCount: 110 }, audioStreams: [] }; };
  const fit = pilotWorkflow.normalizeAnimation({ sourcePath: input, outputPath: output, temporaryOutputPath: temp,
    ffprobe, ffmpeg: (_bin, args) => { ffmpegCalls += 1; fs.writeFileSync(args.at(-1), 'normalized video'); return { status: 0 }; } });
  assert.equal(ffmpegCalls, 1); assert.equal(fit.fitted.video.frameCount, 110); assert.match(fit.args.join(' '), /fps=30.*-frames:v 110/u);
  assert.equal(fs.existsSync(output), true); assert.equal(fs.existsSync(temp), false);
  const shortOutput = path.join(dir, 'short.mp4'), shortTemp = `${shortOutput}.tmp.mp4`;
  assert.throws(() => pilotWorkflow.normalizeAnimation({ sourcePath: input, outputPath: shortOutput,
    temporaryOutputPath: shortTemp, ffprobe: () => ({ video: { frameCount: 109 } }),
    ffmpeg: () => { throw new Error('must not encode'); } }), /PILOT_ANIMATION_SOURCE_TOO_FEW_FRAMES/);
  assert.equal(fs.existsSync(shortOutput), false); assert.equal(fs.existsSync(shortTemp), false);
});

test('pilot-02 accepts only its separate one-request authorization and keeps its run data isolated', async t => {
  const f = makePilot02Fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const authPath = path.join(f.root, 'still-execution-authorization.v1.json');
  const loaded = loadTestAuthorization(f.root, f.planning, fs, sha(f.authorizationBytes),
    { scope: 'STILL_ONLY', operation: 'GENERATE_STILL' });
  assert.equal(loaded.record.pilotRunId, pilotWorkflow.PILOT02.runId);
  assert.deepEqual(loaded.record.authorizedRequests.map(entry => entry.requestKey), [pilotWorkflow.PILOT02.requestKey]);
  const p1Planning = pilotWorkflow.verifyPlanningInputs({ v5Dir: V5_DIR, editorialApprovalPath: EDITORIAL_APPROVAL, pilotDir: PILOT_DIR });
  const p1Auth = pilotExecutionAuthorization(p1Planning);
  const p1Bytes = Buffer.from(`${JSON.stringify(p1Auth, null, 2)}\n`); fs.writeFileSync(authPath, p1Bytes);
  assert.throws(() => loadTestAuthorization(f.root, f.planning, fs, sha(p1Bytes),
    { scope: 'STILL_ONLY', operation: 'GENERATE_STILL' }), /PILOT_AUTHORIZATION_SCOPE_BINDING_MISMATCH/);
  fs.writeFileSync(authPath, f.authorizationBytes);
  await f.workflow.generateStill();
  assert.equal(f.calls.length, 1);
  const ledger = pilotWorkflow.readLedger(path.join(f.root, 'request-ledger.jsonl'));
  assert.deepEqual(ledger.filter(row => row.recordType === 'SUBMISSION_RESERVED').map(row => row.requestKey), [pilotWorkflow.PILOT02.requestKey]);
  assert.equal(fs.existsSync(path.join(f.root, 'pilot.lock')), false);
  await assert.rejects(f.workflow.generateAnimation(), /PILOT_STILL_HUMAN_APPROVAL_REQUIRED/);
  assert.equal(f.calls.length, 1);
  assert.throws(() => v3AssetReadiness.assertNoDisposablePilotMedia({ assetClass: 'NON_PRODUCTION_DISPOSABLE_PILOT',
    assetPath: '/data/.review/phase3-media-pilots/phase3-media-pilot-02/ACT3_B005-still.png' }), /DISPOSABLE_PILOT_ASSET_FORBIDDEN/);
  assert.equal(path.basename(authPath), 'still-execution-authorization.v1.json');
});

test('pilot-02 refuses pilot-01 request keys and output files', t => {
  const f = makePilot02Fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  assert.throws(() => pilotWorkflow.reserveRequest({ root: f.root, request: { ...pilotWorkflow.REQUESTS.still,
    requestKey: pilotWorkflow.REQUESTS.still.key }, stage: 'still', planning: f.planning,
    auth: { scope: 'STILL_ONLY', record: { maxProviderSubmissions: 1, authorizedRequests: [{ requestKey: pilotWorkflow.REQUESTS.still.key }] } } }),
  /PILOT_REQUEST_KEY_INVALID/);
  const base = tempRoot(), root = path.join(base, pilotWorkflow.PILOT02.runId); fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'ACT3_B005-still.png'), pilotPng());
  const workflow = pilotWorkflow.createPilotWorkflow({ root, expectedRoot: base, v5Dir: V5_DIR,
    editorialApprovalPath: EDITORIAL_APPROVAL, pilotDir: PILOT02_DIR,
    pins: { ...pilotWorkflow.TRUST, runId: pilotWorkflow.PILOT02.runId } });
  assert.throws(() => workflow.preflight(), /PILOT02_STILL_RUN_FILE_SET_INVALID/);
});

test('pilot-02 CLI permits its isolated animation command but retains run-specific gates', () => {
  assert.equal(pilotWorkflow.parseCli(['--preflight', '--pilot-run-id', pilotWorkflow.PILOT02.runId]).mode, '--preflight');
  assert.equal(pilotWorkflow.parseCli(['--preflight', '--pilot-run-id', pilotWorkflow.TRUST.runId]).mode, '--preflight');
  assert.equal(pilotWorkflow.parseCli(['--generate-animation', '--pilot-run-id', pilotWorkflow.PILOT02.runId,
    '--expected-execution-authorization-sha256', 'a'.repeat(64)]).mode, '--generate-animation');
  assert.equal(pilotWorkflow.parseCli(['--finalize', '--pilot-run-id', pilotWorkflow.PILOT02.runId]).mode, '--finalize');
});

const V5_MEDIA_PACKAGE = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
  'phase3-consolidated-act5-production-candidate-20261004-v5');
const DETACHED_APPROVAL_ROOT = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const V5_MEDIA_RUN = 'phase3-media-execution-v5-test01';

function makeMediaExecutionFixture(overrides = {}) {
  const root = tempRoot();
  const episodeRoot = path.join(root, 'episode'); fs.mkdirSync(path.join(episodeRoot, '.review'), { recursive: true });
  const runner = mediaExecution.createMediaExecution({
    packageDirectory: V5_MEDIA_PACKAGE,
    episodeRoot,
    reviewRoot: path.join(episodeRoot, '.review', 'phase3-media-execution'),
    b009ApprovalPath: path.join(DETACHED_APPROVAL_ROOT, 'phase3-act5-b009-human-approval-20261004.v1.json'),
    b016ApprovalPath: path.join(DETACHED_APPROVAL_ROOT, 'phase3-act5-b016-human-approval-20261004.v1.json'),
    verifyStage04Fn: () => ({ record: { status: 'PROMOTED' }, recordBytes: Buffer.from('verified'),
      recordSha256: mediaExecution.STAGE04_ACTIVATION_SHA256, promotedPathCount: 147,
      requestLedgerSha256: mediaExecution.REQUEST_LEDGER_SHA256 }),
    assertNoPhase3LocksFn: () => true,
    activationRunner: { assertNoActivationLocks: () => true, verifyStagedCandidateIndexes: () => ({ stagedIndexSha256: 'a'.repeat(64) }),
      verifyPromotedTree: () => true },
    ...overrides,
  });
  return { root, runner };
}

test('v5 package indexes, approvals, source lineage and corrected final-output census reconcile without editing v5', () => {
  const before = fs.readFileSync(path.join(V5_MEDIA_PACKAGE, 'package-index.v2.json'));
  const verified = mediaExecution.verifyOuterPackage({ packageDirectory: V5_MEDIA_PACKAGE });
  assert.equal(verified.outer.count, 194);
  assert.equal(verified.candidate.count, 174);
  assert.equal(verified.outer.indexSha256, mediaExecution.OUTER_INDEX_SHA256);
  assert.equal(verified.candidate.indexSha256, mediaExecution.CANDIDATE_INDEX_SHA256);
  const census = mediaExecution.deriveCensus(verified.candidateRoot);
  assert.deepEqual(census.finalOutputCounts, { controlledStills: 34, generatedStills: 8, animationClips: 23 });
  assert.equal(census.finalOutputTotal, 65);
  assert.deepEqual(census.intermediateAnimationSourceStills, { required: 23, missing: 23, excludedFromFinalOutputTotal: true });
  assert.equal(census.resolvedDeterministicGraphics.manifestEntries, 77);
  assert.equal(census.resolvedDeterministicGraphics.verifiedAssetFiles, 79);
  assert.equal(census.resolvedDeterministicGraphics.approvedCompiledPngOutputs, 2);
  assert.equal(census.resolvedEvidenceAssets.approvedEntries, 46);
  assert.equal(census.resolvedEvidenceAssets.verifiedAssetFiles, 29);
  assert.deepEqual(census.missingFinalOutputs, { controlledStills: 34, generatedStills: 8,
    animationClips: 23, animationSourceStills: 23 });
  assert.equal(census.calibrationBatch.structuralStatus, 'PASS');
  assert.equal(census.calibrationBatch.executionStatus, 'READY_FOR_SEQUENTIAL_SINGLE_REQUEST_AUTHORIZATIONS');
  assert.equal(census.calibrationRoutePlan.status, 'PLANNING_ONLY_EXECUTION_UNAUTHORIZED');
  assert.deepEqual(census.calibrationRoutePlan.trust, calibrationRoutes.TRUST);
  assert.equal(census.calibrationRoutePlan.requests[0].endpoint, 'blackforestlabs/flux-3/text-to-image');
  assert.equal(census.calibrationRoutePlan.requests[2].endpoint, 'minimax/h3-max/image-to-video');
  assert.deepEqual(census.calibrationRoutePlan.hardExecutionBlockers.map(item => item.code), [
    'ACT1_B005_DEFERRED_DOES_NOT_BLOCK_CALIBRATION',
  ]);
  assert.equal(census.calibrationBatch.executionStatus, 'READY_FOR_SEQUENTIAL_SINGLE_REQUEST_AUTHORIZATIONS');
  assert.equal(census.calibrationBatch.providerRequestsAuthorized, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(V5_MEDIA_PACKAGE, 'package-index.v2.json'))), verified.outer.index);
  assert.deepEqual(fs.readFileSync(path.join(V5_MEDIA_PACKAGE, 'package-index.v2.json')), before);
});

function readCalibrationCandidate() {
  const candidateRoot = path.join(V5_MEDIA_PACKAGE, 'candidate');
  return {
    productionManifest: JSON.parse(fs.readFileSync(path.join(candidateRoot, 'production-manifest.json'), 'utf8')),
    shotDefinitions: JSON.parse(fs.readFileSync(path.join(candidateRoot, 'shot-definitions.json'), 'utf8')),
    editPlan: JSON.parse(fs.readFileSync(path.join(candidateRoot, 'edit-plan.json'), 'utf8')),
  };
}

function readCalibrationRouteApproval() { return calibrationRoutes.readRouteApproval(); }

test('calibration route plan is pinned to the authorized run, staged indexes, beats and exact approved prompts', () => {
  const candidate = readCalibrationCandidate();
  const plan = calibrationRoutes.makeRoutePlan({ candidate, approval: readCalibrationRouteApproval() });
  assert.equal(plan.trust.runId, 'phase3-media-execution-v5-20261004-01');
  assert.equal(plan.trust.stagedIndexSha256, '2b9c5f4c65b18d229a7ad158889ec6753811454a410b0b808b6785b8057c92ad');
  assert.deepEqual(plan.permittedBeatIds, ['ACT1_B005', 'ACT1_B006', 'ACT1_B009']);
  assert.equal(plan.requests[0].positivePrompt, candidate.shotDefinitions.allShots.find(item => item.beatId === 'ACT1_B006').imagePrompt);
  assert.equal(plan.requests[0].negativePrompt, candidate.shotDefinitions.allShots.find(item => item.beatId === 'ACT1_B006').negativePrompt);
  assert.equal(plan.requests[0].prompt, `${plan.requests[0].positivePrompt}${calibrationRoutes.FLUX_NEGATIVE_PROMPT_DELIMITER}${plan.requests[0].negativePrompt}`);
  assert.throws(() => calibrationRoutes.makeRoutePlan({ candidate, runId: 'phase3-media-execution-v5-other' }),
    /CALIBRATION_RUN_ID_MISMATCH/);
  assert.throws(() => calibrationRoutes.makeRoutePlan({ candidate, stagedIndexSha256: '0'.repeat(64) }),
    /CALIBRATION_STAGED_INDEX_MISMATCH/);
});

test('calibration plan rejects altered candidate prompts and protects controlled ACT1_B005 from provider use', () => {
  const candidate = readCalibrationCandidate();
  candidate.shotDefinitions.allShots.find(item => item.beatId === 'ACT1_B006').imagePrompt += ' altered';
  assert.throws(() => calibrationRoutes.makeRoutePlan({ candidate }), /CALIBRATION_PROMPT_HASH_MISMATCH:ACT1_B006/);
  const plan = calibrationRoutes.makeRoutePlan({ candidate: readCalibrationCandidate(), approval: readCalibrationRouteApproval() });
  assert.equal(plan.controlledStill.providerAllowed, false);
  assert.equal(plan.controlledStill.status, 'DEFERRED');
  assert.deepEqual(plan.controlledStill.shotFieldsPreserved, { visualType: 'CLIP', motionType: 'dolly_back' });
  assert.deepEqual(plan.controlledStill.doesNotBlockCalibrationBeats, ['ACT1_B006', 'ACT1_B009']);
  assert.equal(plan.controlledStill.boundSource, null);
  assert.throws(() => calibrationRoutes.deterministicRequestKey({ beatId: 'ACT1_B005', operation: 'GENERATE_STILL',
    endpoint: calibrationRoutes.FLUX3_ENDPOINT, parameters: calibrationRoutes.FLUX3, prompt: 'x' }),
  /CALIBRATION_ENDPOINT_OR_OPERATION_FORBIDDEN/);
});

test('calibration key derivation rejects endpoint, parameter, fallback and retry drift and binds animation source hash', () => {
  const candidate = readCalibrationCandidate();
  const plan = calibrationRoutes.makeRoutePlan({ candidate, approval: readCalibrationRouteApproval() });
  const still = plan.requests[0];
  assert.throws(() => calibrationRoutes.deterministicRequestKey({ ...still, endpoint: 'fal-ai/flux/dev' }),
    /CALIBRATION_ENDPOINT_OR_OPERATION_FORBIDDEN/);
  assert.throws(() => calibrationRoutes.deterministicRequestKey({ ...still, parameters: { ...still.parameters, resolution: '2k' } }),
    /CALIBRATION_STILL_PARAMETERS_MISMATCH/);
  assert.equal(plan.constraints.retries, 0);
  assert.deepEqual(plan.constraints.fallbackModels, []);
  const keyInputs = { beatId: 'ACT1_B009', operation: 'GENERATE_ANIMATION', endpoint: calibrationRoutes.H3_MAX_ENDPOINT,
    parameters: { duration: 5, resolution: '768P', prompt_expansion_mode: 'disabled', enable_safety_checker: true,
      image_url: 'data:image/png;base64,YQ==' },
    prompt: plan.requests[2].prompt, negativePrompt: plan.requests[2].negativePrompt,
    sourceSha256: 'a'.repeat(64) };
  const first = calibrationRoutes.deterministicRequestKey(keyInputs);
  const changedSource = calibrationRoutes.deterministicRequestKey({ ...keyInputs, sourceSha256: 'b'.repeat(64) });
  assert.notEqual(first, changedSource);
  assert.throws(() => calibrationRoutes.deterministicRequestKey({ ...keyInputs, beatId: 'ACT2_B001' }),
    /CALIBRATION_SCOPE_MISMATCH/);
});

test('calibration plan blocks FLUX negative-prompt loss and H3 generated audio, and grants no execution authority', () => {
  const plan = calibrationRoutes.makeRoutePlan({ candidate: readCalibrationCandidate(), approval: readCalibrationRouteApproval() });
  assert.equal(plan.requests[0].executionStatus, 'PLANNED_ONLY_REQUIRES_SEPARATE_SINGLE_REQUEST_AUTHORIZATION');
  assert.equal(plan.requests[2].executionStatus, 'PLANNED_ONLY_REQUIRES_APPROVED_SOURCE_STILL_AND_SEPARATE_SINGLE_REQUEST_AUTHORIZATION');
  assert.equal(plan.requests[2].requestKey, null);
  assert.equal(plan.requests[2].sourceStill.requiresHashVerifiedHumanApprovedOutput, true);
  assert.equal(plan.requests[2].derivative.frames, 114);
  assert.equal(plan.requests[2].derivative.fps, 30);
  assert.equal(plan.constraints.providerRequestsAuthorized, 0);
  assert.equal(plan.constraints.executionAuthorization, null);
  assert.equal(plan.constraints.outputClassification, 'NON_PRODUCTION_DISPOSABLE_CALIBRATION');
  assert.equal(plan.pricing.providerEnforcedCap, false);
  assert.equal(plan.pricing.humanAcceptedMaximumExposureUsd, 0.60);
  assert.equal(plan.pricing.providerEnforcedCap, false);
  assert.equal(plan.ownership.disposition, 'UNRESOLVED_ACCEPTED_FOR_NONPRODUCTION_CALIBRATION_ONLY');
  assert.equal(typeof calibrationRoutes.generate, 'undefined');
});

test('detached route-resolution approval is hash-pinned to the exact staged v5 route contract', () => {
  const approval = readCalibrationRouteApproval();
  assert.equal(approval.sha256, 'bfa8c0d00c8dbb81d4516a663b1ce3c5ef22cd199fed4f95a545468bc3676b14');
  assert.equal(approval.record.providerExecutionAuthorized, false);
  assert.equal(approval.record.bindings.stagedRunId, calibrationRoutes.TRUST.runId);
  assert.equal(approval.record.bindings.stagedIndexSha256, calibrationRoutes.TRUST.stagedIndexSha256);
  const altered = path.join(tempRoot(), 'altered-route-approval.json');
  try {
    fs.writeFileSync(altered, Buffer.concat([approval.bytes, Buffer.from(' ')]));
    assert.throws(() => calibrationRoutes.readRouteApproval({ file: altered }), /CALIBRATION_ROUTE_APPROVAL_HASH_MISMATCH/);
  } finally { fs.rmSync(path.dirname(altered), { recursive: true, force: true }); }
  const unapprovedPlan = calibrationRoutes.makeRoutePlan({ candidate: readCalibrationCandidate(),
    approval: { ...approval, sha256: '0'.repeat(64) } });
  assert.deepEqual(unapprovedPlan.hardExecutionBlockers.map(item => item.code), [
    'ROUTE_RESOLUTION_APPROVAL_MISSING_OR_INVALID', 'ACT1_B005_DEFERRED_DOES_NOT_BLOCK_CALIBRATION',
  ]);
});

test('FLUX serialization preserves exact approved positive and negative bytes and rejects any drift or expansion', () => {
  const plan = calibrationRoutes.makeRoutePlan({ candidate: readCalibrationCandidate(), approval: readCalibrationRouteApproval() });
  for (const request of plan.requests.slice(0, 2)) {
    assert.equal(request.prompt, request.positivePrompt + calibrationRoutes.FLUX_NEGATIVE_PROMPT_DELIMITER + request.negativePrompt);
    assert.equal(request.submittedPromptSha256, calibrationRoutes.sha(Buffer.from(request.prompt, 'utf8')));
    assert.equal(request.parameters.enable_prompt_expansion, false);
    assert.equal(Object.hasOwn(request.parameters, 'negative_prompt'), false);
    assert.equal(request.requestKey, calibrationRoutes.deterministicRequestKey({ ...request,
      parameters: { resolution: '1k', aspect_ratio: '16:9', output_format: 'png', enable_prompt_expansion: false },
      positivePrompt: request.positivePrompt, prompt: request.prompt, negativePrompt: request.negativePrompt }));
  }
  const req = plan.requests[0];
  assert.throws(() => calibrationRoutes.serializedFluxPrompt(req.beatId, req.positivePrompt + ' x', req.negativePrompt),
    /CALIBRATION_PROMPT_HASH_MISMATCH/);
  assert.throws(() => calibrationRoutes.serializedFluxPrompt(req.beatId, req.positivePrompt, req.negativePrompt + ' x'),
    /CALIBRATION_NEGATIVE_PROMPT_HASH_MISMATCH/);
  assert.throws(() => calibrationRoutes.serializedFluxPrompt(req.beatId, req.positivePrompt, req.negativePrompt, 'bad delimiter'),
    /CALIBRATION_FLUX_DELIMITER_MISMATCH/);
  assert.throws(() => calibrationRoutes.deterministicRequestKey({ ...req, prompt: req.prompt + ' rewritten' }),
    /CALIBRATION_SERIALIZED_PROMPT_MISMATCH/);
  assert.throws(() => calibrationRoutes.deterministicRequestKey({ ...req,
    parameters: { ...req.parameters, enable_prompt_expansion: true } }), /CALIBRATION_STILL_PARAMETERS_MISMATCH/);
});

test('calibration request keys bind each staged request and defer animation key until approved source hash exists', () => {
  const plan = calibrationRoutes.makeRoutePlan({ candidate: readCalibrationCandidate(), approval: readCalibrationRouteApproval() });
  assert.equal(plan.requests[0].operation, 'GENERATE_STILL');
  assert.equal(plan.requests[1].operation, 'GENERATE_ANIMATION_SOURCE_STILL');
  assert.notEqual(plan.requests[0].requestKey, plan.requests[1].requestKey);
  assert.equal(plan.requests[2].requestKey, null);
  assert.match(plan.requests[2].provisionalPlanningRequestKey, /^[a-f0-9]{64}$/u);
  assert.throws(() => calibrationRoutes.deriveApprovedAnimationRequestKey({ sourceStillBytes: Buffer.from('still'),
    sourceStillSha256: calibrationRoutes.sha(Buffer.from('still')), sourceStillApproved: false,
    prompt: plan.requests[2].prompt, negativePrompt: plan.requests[2].negativePrompt }),
  /CALIBRATION_ANIMATION_SOURCE_NOT_APPROVED_OR_HASHED/);
  const bytes = Buffer.from('approved still bytes');
  const key = calibrationRoutes.deriveApprovedAnimationRequestKey({ sourceStillBytes: bytes,
    sourceStillSha256: calibrationRoutes.sha(bytes), sourceStillApproved: true,
    prompt: plan.requests[2].prompt, negativePrompt: plan.requests[2].negativePrompt });
  assert.match(key, /^[a-f0-9]{64}$/u);
  assert.equal(calibrationRoutes.nextAuthorizationStep({ approvedOutputs: [], submissions: 0 }).next, 'ACT1_B006/GENERATE_STILL');
  assert.throws(() => calibrationRoutes.nextAuthorizationStep({ approvedOutputs: [], submissions: 1 }),
    /CALIBRATION_UNAPPROVED_SUBMISSION_EXISTS/);
  assert.throws(() => calibrationRoutes.nextAuthorizationStep({ approvedOutputs: [], submissions: 0,
    beatId: 'ACT1_B009', operation: 'GENERATE_ANIMATION' }), /CALIBRATION_SEQUENCE_ORDER_VIOLATION/);
  assert.equal(calibrationRoutes.nextAuthorizationStep({ approvedOutputs: ['ACT1_B006/GENERATE_STILL'], submissions: 1 }).next,
    'ACT1_B009/GENERATE_ANIMATION_SOURCE_STILL');
  assert.equal(calibrationRoutes.nextAuthorizationStep({ approvedOutputs: ['ACT1_B006/GENERATE_STILL',
    'ACT1_B009/GENERATE_ANIMATION_SOURCE_STILL'], submissions: 2 }).next, 'ACT1_B009/GENERATE_ANIMATION');
});

test('H3 Max omits target audio, preserves raw, and requires a silent exact 114-frame derivative', () => {
  const plan = calibrationRoutes.makeRoutePlan({ candidate: readCalibrationCandidate(), approval: readCalibrationRouteApproval() });
  const animation = plan.requests[2];
  assert.equal(animation.endpoint, 'minimax/h3-max/image-to-video');
  assert.equal(animation.parameters.duration, 5);
  assert.equal(animation.parameters.resolution, '768P');
  assert.equal(animation.parameters.prompt_expansion_mode, 'disabled');
  assert.equal(Object.hasOwn(animation.parameters, 'target_audio_url'), false);
  assert.equal(animation.rawOutput.preserveUnchanged, true);
  assert.deepEqual(animation.derivative.ffmpegArgs.slice(2, 11), ['-map', '0:v:0', '-an', '-vf', 'fps=30', '-frames:v', '114', '-fps_mode', 'cfr']);
  assert.equal(calibrationRoutes.validateH3DerivativeMetadata({ videoStreamCount: 1, audioStreamCount: 0, fps: 30, frameCount: 114 }), true);
  assert.throws(() => calibrationRoutes.validateH3DerivativeMetadata({ videoStreamCount: 1, audioStreamCount: 1, fps: 30, frameCount: 114 }),
    /CALIBRATION_DERIVATIVE_MUST_BE_VIDEO_ONLY/);
  assert.throws(() => calibrationRoutes.validateH3DerivativeMetadata({ videoStreamCount: 1, audioStreamCount: 0, fps: 30, frameCount: 113 }),
    /CALIBRATION_DERIVATIVE_FRAME_CONTRACT_MISMATCH/);
  assert.throws(() => calibrationRoutes.deterministicRequestKey({ beatId: 'ACT1_B009', operation: 'GENERATE_ANIMATION',
    endpoint: calibrationRoutes.H3_MAX_ENDPOINT, parameters: { ...calibrationRoutes.H3_MAX,
      image_url: 'data:image/png;base64,YQ==', target_audio_url: 'https://example.test/audio' },
    prompt: animation.prompt, negativePrompt: animation.negativePrompt, sourceSha256: 'a'.repeat(64) }),
  /CALIBRATION_ANIMATION_PARAMETERS_OR_SOURCE_MISMATCH/);
});

test('calibration sequence forbids B005 provider route, retries, fallback, duplicates, excess submissions and production use', () => {
  const plan = calibrationRoutes.makeRoutePlan({ candidate: readCalibrationCandidate(), approval: readCalibrationRouteApproval() });
  assert.equal(plan.controlledStill.providerAllowed, false);
  assert.equal(plan.controlledStill.status, 'DEFERRED');
  assert.throws(() => calibrationRoutes.deterministicRequestKey({ beatId: 'ACT1_B005', operation: 'GENERATE_STILL',
    endpoint: calibrationRoutes.FLUX3_ENDPOINT, parameters: calibrationRoutes.FLUX3, prompt: 'anything' }),
  /CALIBRATION_ENDPOINT_OR_OPERATION_FORBIDDEN/);
  assert.equal(plan.constraints.maximumProviderSubmissions, 3);
  assert.throws(() => calibrationRoutes.nextAuthorizationStep({ approvedOutputs: [], submissions: 0, retries: 1 }),
    /CALIBRATION_RETRY_OR_FALLBACK_FORBIDDEN/);
  assert.throws(() => calibrationRoutes.nextAuthorizationStep({ approvedOutputs: [], submissions: 0, fallbackUsed: true }),
    /CALIBRATION_RETRY_OR_FALLBACK_FORBIDDEN/);
  assert.throws(() => calibrationRoutes.nextAuthorizationStep({ approvedOutputs: [], submissions: 4 }),
    /CALIBRATION_SUBMISSION_LIMIT_EXCEEDED/);
  assert.throws(() => calibrationRoutes.nextAuthorizationStep({ approvedOutputs: [], submissions: 0,
    requestKeys: ['a'.repeat(64), 'a'.repeat(64)] }), /CALIBRATION_DUPLICATE_REQUEST_KEY/);
  assert.throws(() => calibrationRoutes.assertCalibrationOutputNotProduction({
    classification: 'NON_PRODUCTION_DISPOSABLE_CALIBRATION', productionUse: true }), /CALIBRATION_OUTPUT_PRODUCTION_USE_FORBIDDEN/);
  assert.throws(() => calibrationRoutes.assertExposureWithinHumanCeiling(0.6001), /CALIBRATION_ACCEPTED_EXPOSURE_EXCEEDED/);
  assert.equal(calibrationRoutes.assertExposureWithinHumanCeiling(0.552), true);
  assert.equal(plan.constraints.providerRequestsAuthorized, 0);
});

test('v5 Stage04 verification reuses the backup-bound Phase 3 validation context', () => {
  const record = { status: 'PROMOTED', runId: PHASE2_RUN, candidateFiles: [] };
  const staged = { stagedFileCount: 151, stagedIndexSha256: 'b'.repeat(64) };
  let supplied;
  const result = mediaExecution.verifyStage04StagedContext({ runId: PHASE2_RUN, runDir: '/episode/.review/stage04',
    candidateDirectory: '/episode/.review/stage04/candidate', activationRecord: record, runner: {
      verifyStagedCandidateIndexes: () => { throw new Error('GENERIC_VALIDATOR_MUST_NOT_RUN'); },
    }, verifyStagedValidationContextFn: options => {
      supplied = options;
      return { boundaryBackup: { backupDirectory: '/episode/.review/stage04/backup' }, staged };
    } });
  assert.equal(result.staged, staged);
  assert.equal(supplied.runId, PHASE2_RUN);
  assert.equal(supplied.reviewDirectory, '/episode/.review/stage04');
  assert.equal(supplied.candidateDirectory, '/episode/.review/stage04/candidate');
  assert.equal(supplied.activationRecord, record);
  assert.equal(supplied.runner.verifyStagedCandidateIndexes instanceof Function, true);
  assert.throws(() => mediaExecution.verifyStage04StagedContext({ runId: PHASE2_RUN, runDir: '/episode/.review/stage04',
    candidateDirectory: '/episode/.review/stage04/candidate', activationRecord: record, runner: {},
    verifyStagedValidationContextFn: () => ({ staged: { stagedFileCount: 150 } }) }),
  /PHASE3_MEDIA_EXECUTION_STAGE04_STAGED_INDEX_INVALID/);
});

test('v5 staging and read-only preflight stage only isolated candidate bytes and report all media blockers', t => {
  const f = makeMediaExecutionFixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const staged = f.runner.stage({ runId: V5_MEDIA_RUN });
  assert.equal(staged.status, 'PHASE3_MEDIA_CANDIDATE_STAGED');
  assert.equal(staged.providerRequests, 0);
  assert.equal(staged.episodeRootWrites, 0);
  const result = f.runner.preflight({ runId: V5_MEDIA_RUN });
  assert.equal(result.status, 'PHASE3_MEDIA_EXECUTION_PREFLIGHT_PASS_MEDIA_PENDING_ROUTE_BLOCKED');
  assert.equal(result.stage04.promotedPathCount, 147);
  assert.equal(result.finalOutputTotal, 65);
  assert.equal(result.missingFinalOutputs.controlledStills, 34);
  assert.equal(result.missingFinalOutputs.generatedStills, 8);
  assert.equal(result.missingFinalOutputs.animationClips, 23);
  assert.equal(result.missingFinalOutputs.animationSourceStills, 23);
  assert.equal(result.resolvedDeterministicGraphics.validation, 'PASS');
  assert.equal(result.resolvedEvidenceAssets.validation, 'PASS');
  assert.equal(result.providerRequests, 0);
  assert.equal(result.episodeRootWrites, 0);
  assert.equal(result.requestLedgerSha256, mediaExecution.REQUEST_LEDGER_SHA256);
  assert.equal(fs.existsSync(path.join(f.root, 'episode', 'assets')), false);
  assert.equal(fs.existsSync(path.join(staged.runDirectory, '.stage')), false);
  assert.equal(fs.existsSync(path.join(staged.runDirectory, 'candidate', 'assets', 'stills')), false);
  assert.equal(fs.existsSync(path.join(staged.runDirectory, 'candidate', 'assets', 'clips')), false);
});

test('v5 verifier rejects the earlier v2 candidate and any altered outer or candidate index', () => {
  assert.throws(() => mediaExecution.verifyOuterPackage({ packageDirectory: path.join(__dirname, '..', 'artifacts',
    'empire-omitted-v3', 'wells-fargo', 'phase2.3b-p-act3-refresh-candidate-local-20260928-v2') }),
  /PHASE3_MEDIA_EXECUTION_V5_SOURCE_REQUIRED/);
  assert.throws(() => mediaExecution.verifyIndex(V5_MEDIA_PACKAGE,
    path.join(V5_MEDIA_PACKAGE, 'package-index.v2.json'), '0'.repeat(64), 194),
  /PHASE3_MEDIA_EXECUTION_INDEX_HASH_MISMATCH/);
  const candidate = path.join(V5_MEDIA_PACKAGE, 'candidate');
  assert.throws(() => mediaExecution.verifyIndex(candidate,
    path.join(candidate, 'candidate-package-sha256.json'), '0'.repeat(64), 174),
  /PHASE3_MEDIA_EXECUTION_INDEX_HASH_MISMATCH/);
});

test('v5 preflight rejects altered candidate counts, candidate files and revision lineage', t => {
  const f = makeMediaExecutionFixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const staged = f.runner.stage({ runId: V5_MEDIA_RUN });
  const manifestPath = path.join(staged.runDirectory, 'candidate', 'production-manifest.json');
  const originalManifest = fs.readFileSync(manifestPath);
  fs.writeFileSync(manifestPath, Buffer.concat([originalManifest, Buffer.from(' ')]));
  assert.throws(() => f.runner.preflight({ runId: V5_MEDIA_RUN }), /PHASE3_MEDIA_EXECUTION_INDEXED_FILE_MISMATCH/);
  fs.writeFileSync(manifestPath, originalManifest);
  const lineagePath = path.join(staged.runDirectory, 'candidate', 'revision-lineage',
    'phase3-consolidated-act5-amendment-lineage.v1.json');
  const originalLineage = fs.readFileSync(lineagePath);
  fs.writeFileSync(lineagePath, Buffer.concat([originalLineage, Buffer.from(' ')]));
  assert.throws(() => f.runner.preflight({ runId: V5_MEDIA_RUN }), /PHASE3_MEDIA_EXECUTION_INDEXED_FILE_MISMATCH/);
  fs.writeFileSync(lineagePath, originalLineage);
  const stagedIndexPath = path.join(staged.runDirectory, 'staged-candidate-index.json');
  const index = JSON.parse(fs.readFileSync(stagedIndexPath));
  index.sourceCandidateIndexSha256 = '0'.repeat(64);
  fs.writeFileSync(stagedIndexPath, `${JSON.stringify(index, null, 2)}\n`);
  assert.throws(() => f.runner.preflight({ runId: V5_MEDIA_RUN }), /PHASE3_MEDIA_EXECUTION_STAGED_INDEX_HASH_MISMATCH/);
});

test('v5 intake rejects altered detached approvals and altered staged approvals', t => {
  const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(DETACHED_APPROVAL_ROOT, 'phase3-act5-b009-human-approval-20261004.v1.json');
  const changed = path.join(root, 'approval.json');
  fs.writeFileSync(changed, Buffer.concat([fs.readFileSync(source), Buffer.from(' ')]));
  assert.throws(() => mediaExecution.verifyDetachedApprovals({ b009ApprovalPath: changed,
    b016ApprovalPath: path.join(DETACHED_APPROVAL_ROOT, 'phase3-act5-b016-human-approval-20261004.v1.json') }),
  /PHASE3_MEDIA_EXECUTION_B009_APPROVAL_HASH_MISMATCH/);
  const f = makeMediaExecutionFixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const staged = f.runner.stage({ runId: V5_MEDIA_RUN });
  const stagedApproval = path.join(staged.runDirectory, 'detached-approvals', 'act5-b016-human-approval-20261004.v1.json');
  fs.writeFileSync(stagedApproval, Buffer.concat([fs.readFileSync(stagedApproval), Buffer.from(' ')]));
  assert.throws(() => f.runner.preflight({ runId: V5_MEDIA_RUN }), /PHASE3_MEDIA_EXECUTION_STAGED_APPROVAL_MISMATCH/);
});

test('v5 staging refuses duplicate runs and leaves no temporary state after validation failure', t => {
  const f = makeMediaExecutionFixture({ verifyStage04Fn: () => { throw new Error('STAGE04_TEST_BLOCK'); } });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  assert.throws(() => f.runner.stage({ runId: V5_MEDIA_RUN }), /STAGE04_TEST_BLOCK/);
  const reviewRoot = path.join(f.root, 'episode', '.review', 'phase3-media-execution');
  assert.equal(fs.existsSync(reviewRoot), false);
});

function makeCalibrationExecutionFixture(t, options = {}) {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const episodeRoot = path.join(root, 'episode');
  fs.mkdirSync(path.join(episodeRoot, '.review'), { recursive: true });
  const stage04Sentinel = path.join(episodeRoot, '.review', 'stage04-request-ledger-baseline.jsonl');
  fs.writeFileSync(stage04Sentinel, 'stage04 unchanged sentinel\n');
  const state = { providerCalls: 0, downloadCalls: 0,
    requestLedgerSha256: mediaExecution.REQUEST_LEDGER_SHA256 };
  const provider = options.provider || { generateStill: async request => {
    state.providerCalls += 1;
    state.providerRequest = request;
    return { url: 'https://unit-test.fal.media/output.png', contentType: 'image/png', imageCount: 1,
      providerRequestId: 'mock-request-001', actualChargeUsd: 0.024,
      rawProviderResponseMetadata: { request_id: 'mock-request-001', data: { actual_cost_usd: 0.024,
        images: [{ url: 'https://unit-test.fal.media/output.png', content_type: 'image/png' }] } } };
  } };
  const downloader = options.downloader || (async () => {
    state.downloadCalls += 1;
    return { bytes: pilotPng(1280, 720), contentType: 'image/png' };
  });
  const runner = mediaExecution.createMediaExecution({ packageDirectory: V5_MEDIA_PACKAGE, episodeRoot,
    reviewRoot: path.join(episodeRoot, '.review', 'phase3-media-execution'),
    b009ApprovalPath: path.join(DETACHED_APPROVAL_ROOT, 'phase3-act5-b009-human-approval-20261004.v1.json'),
    b016ApprovalPath: path.join(DETACHED_APPROVAL_ROOT, 'phase3-act5-b016-human-approval-20261004.v1.json'),
    verifyStage04Fn: () => ({ record: { status: 'PROMOTED' }, recordBytes: Buffer.from('verified'),
      recordSha256: mediaExecution.STAGE04_ACTIVATION_SHA256, promotedPathCount: 147,
      requestLedgerSha256: state.requestLedgerSha256 }),
    assertNoPhase3LocksFn: () => true,
    activationRunner: { assertNoActivationLocks: () => true,
      verifyPromotedTree: () => true },
    provider, downloader, now: () => '2026-10-05T12:00:00.000Z', testHooks: options.testHooks || {},
  });
  const staged = runner.stage({ runId: mediaExecution.CALIBRATION_RUN_ID });
  let authorization = null, authorizationSha256 = null;
  if (options.authorization !== false) {
    const beatDir = path.join(staged.runDirectory, mediaExecution.CALIBRATION_BEAT_ID);
    fs.mkdirSync(beatDir);
    const hashes = mediaExecution.calibrationRuntimeHashes();
    authorization = mediaExecution.makeCalibrationAuthorizationTemplate({ ...hashes,
      authorizedAt: '2026-10-05T11:59:00.000Z' });
    if (options.authorizationMutator) options.authorizationMutator(authorization);
    const bytes = Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`);
    fs.writeFileSync(path.join(staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.authorization.split('/')), bytes);
    authorizationSha256 = sha(bytes);
  }
  return { root, episodeRoot, stage04Sentinel, stage04SentinelSha256: sha(fs.readFileSync(stage04Sentinel)),
    state, runner, staged, authorization, authorizationSha256 };
}

function calibrationGenerateOptions(f, overrides = {}) {
  return { runId: mediaExecution.CALIBRATION_RUN_ID, beatId: mediaExecution.CALIBRATION_BEAT_ID,
    expectedAuthorizationSha256: f.authorizationSha256, ...overrides };
}

test('ACT1_B006 detached execution authorization schema rejects every scope, prompt, limit and production-authority drift', () => {
  const runtimeHashes = { executionModuleSha256: 'a'.repeat(64), cliSha256: 'b'.repeat(64) };
  const valid = () => mediaExecution.makeCalibrationAuthorizationTemplate({ ...runtimeHashes,
    authorizedAt: '2026-10-05T11:59:00.000Z' });
  assert.equal(mediaExecution.validateCalibrationAuthorizationRecord(valid(), { runtimeHashes }), true);
  const cases = [
    ['wrong run', record => { record.bindings.runId = 'phase3-media-execution-v5-other'; }],
    ['wrong beat', record => { record.bindings.beatId = 'ACT1_B009'; }],
    ['wrong operation', record => { record.bindings.operation = 'GENERATE_ANIMATION'; }],
    ['wrong endpoint', record => { record.bindings.endpoint = 'fal-ai/flux/dev'; }],
    ['positive prompt hash', record => { record.bindings.positivePromptSha256 = '0'.repeat(64); }],
    ['negative prompt hash', record => { record.bindings.negativeInstructionsSha256 = '0'.repeat(64); }],
    ['serialized prompt hash', record => { record.bindings.serializedPromptSha256 = '0'.repeat(64); }],
    ['prompt expansion', record => { record.requestLimits.promptExpansionEnabled = true; }],
    ['more than one image', record => { record.requestLimits.numberOfImages = 2; }],
    ['more than one submission', record => { record.requestLimits.maximumProviderSubmissions = 2; }],
    ['retries enabled', record => { record.requestLimits.retries = 1; }],
    ['fallback enabled', record => { record.requestLimits.fallbackEnabled = true; }],
    ['exposure above USD 0.05', record => { record.exposure.maximumHumanAcceptedUsd = 0.051; }],
    ['provider-enforced false acknowledgement removed', record => { record.exposure.providerEnforced = true; }],
    ['production use granted', record => { record.denials.productionUseDenied = false; }],
    ['rendering granted', record => { record.denials.renderingDenied = false; }],
    ['promotion granted', record => { record.denials.promotionDenied = false; }],
    ['episode-root write granted', record => { record.denials.episodeRootWritesDenied = false; }],
    ['other beats granted', record => { record.denials.allOtherBeatsDenied = false; }],
    ['other operations granted', record => { record.denials.allOtherOperationsDenied = false; }],
  ];
  for (const [label, mutate] of cases) {
    const record = valid(); mutate(record);
    assert.throws(() => mediaExecution.validateCalibrationAuthorizationRecord(record, { runtimeHashes }),
      /PHASE3_CALIBRATION_AUTHORIZATION_/, label);
  }
});

test('ACT1_B006 fal adapter disables SDK retries and accepts exactly one returned image without a real request', async () => {
  let configured = null, subscriptions = 0;
  const fal = { config: value => { configured = value; }, subscribe: async (endpoint, options) => {
    subscriptions += 1;
    assert.equal(endpoint, mediaExecution.CALIBRATION_ENDPOINT);
    assert.equal(options.logs, false);
    return { request_id: 'mock-sdk-request', data: { images: [{ url: 'https://mock.fal.media/one.png',
      content_type: 'image/png' }] } };
  } };
  const provider = mediaExecution.createFalCalibrationProvider({ falModuleLoader: () => ({ fal }),
    credentialResolver: () => 'mock-credential-never-sent' });
  const result = await provider.generateStill({ endpoint: mediaExecution.CALIBRATION_ENDPOINT,
    input: { prompt: 'mock' } });
  assert.deepEqual(configured.retry, { maxRetries: 0, retryableStatusCodes: [] });
  assert.equal(subscriptions, 1);
  assert.equal(result.imageCount, 1);
  assert.equal(result.providerRequestId, 'mock-sdk-request');
  assert.equal(result.actualChargeUsd, null);
  assert.equal(result.rawProviderResponseMetadata.request_id, 'mock-sdk-request');
});

test('generation fails closed for missing, omitted, wrong-hash and altered detached authorization without provider use', async t => {
  const missing = makeCalibrationExecutionFixture(t, { authorization: false });
  await assert.rejects(() => missing.runner.generateCalibrationStill({ runId: mediaExecution.CALIBRATION_RUN_ID,
    beatId: mediaExecution.CALIBRATION_BEAT_ID }), /EXPECTED_AUTHORIZATION_HASH_REQUIRED/);
  await assert.rejects(() => missing.runner.generateCalibrationStill({ runId: mediaExecution.CALIBRATION_RUN_ID,
    beatId: mediaExecution.CALIBRATION_BEAT_ID, expectedAuthorizationSha256: 'a'.repeat(64) }),
  /EXECUTION_AUTHORIZATION_MISSING/);
  assert.equal(missing.state.providerCalls, 0);
  assert.equal(fs.existsSync(path.join(missing.staged.runDirectory, mediaExecution.CALIBRATION_BEAT_ID)), false);
  const wrong = makeCalibrationExecutionFixture(t);
  await assert.rejects(() => wrong.runner.generateCalibrationStill(calibrationGenerateOptions(wrong,
    { expectedAuthorizationSha256: '0'.repeat(64) })), /EXECUTION_AUTHORIZATION_HASH_MISMATCH/);
  assert.equal(wrong.state.providerCalls, 0);
  const altered = makeCalibrationExecutionFixture(t, { authorizationMutator: record => {
    record.bindings.serializedPromptSha256 = '0'.repeat(64);
  } });
  await assert.rejects(() => altered.runner.generateCalibrationStill(calibrationGenerateOptions(altered)),
    /AUTHORIZATION_BINDING_MISMATCH/);
  assert.equal(altered.state.providerCalls, 0);
});

test('CLI supports only ACT1_B006 GENERATE_STILL and rejects ACT1_B005, ACT1_B009 and other operations', () => {
  const common = ['--phase3-run-id', mediaExecution.CALIBRATION_RUN_ID, '--beat-id'];
  assert.equal(mediaExecutionCli.parseArgs(['--calibration-status', ...common, 'ACT1_B006']).mode,
    'calibration-status');
  assert.equal(mediaExecutionCli.parseArgs(['--inspect-calibration-still', ...common, 'ACT1_B006']).mode,
    'inspect-calibration-still');
  assert.equal(mediaExecutionCli.parseArgs(['--generate-calibration-still', ...common, 'ACT1_B006',
    '--expected-execution-authorization-sha256', 'a'.repeat(64)]).mode, 'generate-calibration-still');
  assert.throws(() => mediaExecutionCli.parseArgs(['--calibration-status', ...common, 'ACT1_B005']),
    /PHASE3_CALIBRATION_BEAT_FORBIDDEN/);
  assert.throws(() => mediaExecutionCli.parseArgs(['--calibration-status', ...common, 'ACT1_B009']),
    /PHASE3_CALIBRATION_BEAT_FORBIDDEN/);
  assert.throws(() => mediaExecutionCli.parseArgs(['--generate-calibration-still', ...common, 'ACT1_B006',
    '--operation', 'GENERATE_ANIMATION', '--expected-execution-authorization-sha256', 'a'.repeat(64)]),
  /PHASE3_MEDIA_EXECUTION_USAGE/);
});

test('generation rejects unknown run files, changed staged input and changed Stage04 ledger baseline before provider submission', async t => {
  const unknown = makeCalibrationExecutionFixture(t);
  fs.writeFileSync(path.join(unknown.staged.runDirectory, mediaExecution.CALIBRATION_BEAT_ID, 'unknown.txt'), 'unknown');
  await assert.rejects(() => unknown.runner.generateCalibrationStill(calibrationGenerateOptions(unknown)),
    /PHASE3_MEDIA_EXECUTION_RUN_UNKNOWN_FILE/);
  assert.equal(unknown.state.providerCalls, 0);
  const changed = makeCalibrationExecutionFixture(t);
  fs.appendFileSync(path.join(changed.staged.runDirectory, 'candidate', 'shot-definitions.json'), ' ');
  await assert.rejects(() => changed.runner.generateCalibrationStill(calibrationGenerateOptions(changed)),
    /PHASE3_MEDIA_EXECUTION_INDEXED_FILE_MISMATCH/);
  assert.equal(changed.state.providerCalls, 0);
  const stage04 = makeCalibrationExecutionFixture(t);
  stage04.state.requestLedgerSha256 = '0'.repeat(64);
  await assert.rejects(() => stage04.runner.generateCalibrationStill(calibrationGenerateOptions(stage04)),
    /PHASE3_MEDIA_EXECUTION_LEDGER_BINDING_CHANGED/);
  assert.equal(stage04.state.providerCalls, 0);
});

test('atomic lock collision, existing reservation, existing terminal result and duplicate request key are permanently rejected', async t => {
  const locked = makeCalibrationExecutionFixture(t);
  fs.writeFileSync(path.join(locked.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.lock.split('/')), 'other\n');
  await assert.rejects(() => locked.runner.generateCalibrationStill(calibrationGenerateOptions(locked)),
    /PHASE3_CALIBRATION_LOCK_EXISTS/);
  assert.equal(locked.state.providerCalls, 0);
  const reserved = makeCalibrationExecutionFixture(t);
  mediaExecution.appendCalibrationLedgerRecord(path.join(reserved.staged.runDirectory,
    ...mediaExecution.CALIBRATION_FILES.ledger.split('/')), {
    schemaVersion: mediaExecution.CALIBRATION_LEDGER_SCHEMA, recordType: 'SUBMISSION_RESERVED',
    requestKey: mediaExecution.CALIBRATION_REQUEST_KEY, previous: 'test' });
  await assert.rejects(() => reserved.runner.generateCalibrationStill(calibrationGenerateOptions(reserved)),
    /PHASE3_CALIBRATION_REQUEST_ALREADY_CONSUMED/);
  const terminal = makeCalibrationExecutionFixture(t);
  fs.writeFileSync(path.join(terminal.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.result.split('/')), '{}\n');
  await assert.rejects(() => terminal.runner.generateCalibrationStill(calibrationGenerateOptions(terminal)),
    /PHASE3_CALIBRATION_TERMINAL_RESULT_EXISTS/);
  const duplicate = makeCalibrationExecutionFixture(t, { provider: { generateStill: async () => {
    duplicate.state.providerCalls += 1; throw new Error('MOCK_PROVIDER_FAILURE');
  } } });
  await assert.rejects(() => duplicate.runner.generateCalibrationStill(calibrationGenerateOptions(duplicate)),
    /MOCK_PROVIDER_FAILURE/);
  await assert.rejects(() => duplicate.runner.generateCalibrationStill(calibrationGenerateOptions(duplicate)),
    /PHASE3_CALIBRATION_REQUEST_ALREADY_CONSUMED/);
  assert.equal(duplicate.state.providerCalls, 1);
});

test('failure before provider submission writes a durable reservation and terminal failure and releases the lock', async t => {
  const f = makeCalibrationExecutionFixture(t, { testHooks: { afterReservation: () => {
    throw new Error('MOCK_PRE_PROVIDER_FAILURE');
  } } });
  await assert.rejects(() => f.runner.generateCalibrationStill(calibrationGenerateOptions(f)),
    /MOCK_PRE_PROVIDER_FAILURE/);
  const ledgerPath = path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.ledger.split('/'));
  const records = mediaExecution.readCalibrationLedger(ledgerPath);
  assert.equal(records.filter(row => row.recordType === 'SUBMISSION_RESERVED').length, 1);
  assert.equal(records.find(row => row.recordType === 'SUBMISSION_RESULT').status, 'FAILED');
  assert.equal(f.state.providerCalls, 0);
  assert.equal(fs.existsSync(path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.result.split('/'))), true);
  assert.equal(fs.existsSync(path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.lock.split('/'))), false);
});

test('failure after reservation is terminal, records provider failure and releases the lock', async t => {
  const state = { calls: 0 };
  const f = makeCalibrationExecutionFixture(t, { provider: { generateStill: async () => {
    state.calls += 1; throw new Error('MOCK_PROVIDER_TRANSPORT_FAILURE');
  } } });
  await assert.rejects(() => f.runner.generateCalibrationStill(calibrationGenerateOptions(f)),
    /MOCK_PROVIDER_TRANSPORT_FAILURE/);
  assert.equal(state.calls, 1);
  const result = JSON.parse(fs.readFileSync(path.join(f.staged.runDirectory,
    ...mediaExecution.CALIBRATION_FILES.result.split('/'))));
  assert.equal(result.status, 'FAILED_REQUEST_KEY_PERMANENTLY_CONSUMED');
  assert.equal(result.errorCode, 'MOCK_PROVIDER_TRANSPORT_FAILURE');
  assert.equal(fs.existsSync(path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.lock.split('/'))), false);
});

test('malformed provider response and missing image URL consume one request without downloading', async t => {
  for (const [label, provider] of [
    ['malformed', { generateStill: async () => null }],
    ['missing-url', { generateStill: async () => ({ imageCount: 1, url: '', rawProviderResponseMetadata: {} }) }],
  ]) {
    const f = makeCalibrationExecutionFixture(t, { provider });
    await assert.rejects(() => f.runner.generateCalibrationStill(calibrationGenerateOptions(f)),
      /PHASE3_CALIBRATION_PROVIDER_(RESPONSE_INVALID|IMAGE_URL_MISSING)/, label);
    assert.equal(f.state.downloadCalls, 0, label);
    assert.equal(mediaExecution.readCalibrationLedger(path.join(f.staged.runDirectory,
      ...mediaExecution.CALIBRATION_FILES.ledger.split('/')))
      .filter(row => row.recordType === 'SUBMISSION_RESERVED').length, 1, label);
  }
});

test('non-PNG provider output is terminal and never leaves a generated output or lock', async t => {
  const f = makeCalibrationExecutionFixture(t, { downloader: async () => {
    f.state.downloadCalls += 1; return { bytes: Buffer.from('not png'), contentType: 'image/png' };
  } });
  await assert.rejects(() => f.runner.generateCalibrationStill(calibrationGenerateOptions(f)),
    /PHASE3_CALIBRATION_OUTPUT_NOT_PNG/);
  assert.equal(f.state.downloadCalls, 1);
  assert.equal(fs.existsSync(path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.output.split('/'))), false);
  assert.equal(fs.existsSync(path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.lock.split('/'))), false);
});

test('output hash mismatch after atomic write is terminal and cannot be resubmitted', async t => {
  const f = makeCalibrationExecutionFixture(t, { testHooks: { afterOutputWrite: ({ outputPath }) => {
    fs.appendFileSync(outputPath, Buffer.from([0]));
  } } });
  await assert.rejects(() => f.runner.generateCalibrationStill(calibrationGenerateOptions(f)),
    /PHASE3_CALIBRATION_OUTPUT_HASH_MISMATCH/);
  assert.equal(f.state.providerCalls, 1);
  await assert.rejects(() => f.runner.generateCalibrationStill(calibrationGenerateOptions(f)),
    /PHASE3_CALIBRATION_REQUEST_ALREADY_CONSUMED/);
  assert.equal(f.state.providerCalls, 1);
});

test('mocked ACT1_B006 success submits and downloads exactly once and writes hash-bound durable records only in review isolation', async t => {
  const f = makeCalibrationExecutionFixture(t);
  const sourceCandidateBefore = sha(fs.readFileSync(path.join(V5_MEDIA_PACKAGE, 'candidate', 'candidate-package-sha256.json')));
  const stagedCandidateBefore = sha(fs.readFileSync(path.join(f.staged.runDirectory, 'candidate', 'candidate-package-sha256.json')));
  const result = await f.runner.generateCalibrationStill(calibrationGenerateOptions(f));
  assert.equal(result.status, 'CALIBRATION_STILL_GENERATED_PENDING_HUMAN_REVIEW');
  assert.equal(f.state.providerCalls, 1);
  assert.equal(f.state.downloadCalls, 1);
  assert.deepEqual(f.state.providerRequest.input, { prompt: readCalibrationCandidate().shotDefinitions.allShots
    .find(item => item.beatId === 'ACT1_B006').imagePrompt + calibrationRoutes.FLUX_NEGATIVE_PROMPT_DELIMITER
      + readCalibrationCandidate().shotDefinitions.allShots.find(item => item.beatId === 'ACT1_B006').negativePrompt,
  resolution: '1k', aspect_ratio: '16:9', output_format: 'png', num_images: 1, enable_prompt_expansion: false });
  assert.equal(f.state.providerRequest.retries, 0);
  assert.equal(f.state.providerRequest.fallback, false);
  const ledgerPath = path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.ledger.split('/'));
  const ledger = mediaExecution.readCalibrationLedger(ledgerPath);
  assert.deepEqual(ledger.map(row => row.recordType), ['SUBMISSION_RESERVED', 'SUBMISSION_RESULT']);
  assert.equal(ledger[1].status, 'SUCCEEDED');
  const receiptPath = path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.receipt.split('/'));
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  assert.equal(receipt.provider.requestId, 'mock-request-001');
  assert.equal(receipt.provider.actualChargeUsd, 0.024);
  assert.equal(receipt.provider.rawResponseMetadata.request_id, 'mock-request-001');
  assert.equal(receipt.assetClass, mediaExecution.CALIBRATION_ASSET_CLASS);
  assert.equal(receipt.restrictions.episodeRootWrites, false);
  assert.equal(fs.existsSync(path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.lock.split('/'))), false);
  assert.equal(sha(fs.readFileSync(f.stage04Sentinel)), f.stage04SentinelSha256);
  assert.equal(sha(fs.readFileSync(path.join(V5_MEDIA_PACKAGE, 'candidate', 'candidate-package-sha256.json'))), sourceCandidateBefore);
  assert.equal(sha(fs.readFileSync(path.join(f.staged.runDirectory, 'candidate', 'candidate-package-sha256.json'))), stagedCandidateBefore);
  assert.equal(fs.existsSync(path.join(f.episodeRoot, 'assets')), false);
  assert.equal(fs.existsSync(path.join(f.episodeRoot, 'render-output')), false);
});

test('status is read-only and reports pristine unauthorized, authorized-ready, consumed and successful states', async t => {
  const pristine = makeCalibrationExecutionFixture(t, { authorization: false });
  const before = mediaExecution.walkFiles(pristine.staged.runDirectory);
  const first = pristine.runner.calibrationStatus({ runId: mediaExecution.CALIBRATION_RUN_ID,
    beatId: mediaExecution.CALIBRATION_BEAT_ID });
  assert.equal(first.status, 'EXECUTION_READY_UNAUTHORIZED');
  assert.equal(first.authorization.present, false);
  assert.equal(first.requestSafeToInvoke, false);
  assert.deepEqual(mediaExecution.walkFiles(pristine.staged.runDirectory), before);
  const ready = makeCalibrationExecutionFixture(t);
  const readyBefore = mediaExecution.walkFiles(ready.staged.runDirectory);
  const authorized = ready.runner.calibrationStatus({ runId: mediaExecution.CALIBRATION_RUN_ID,
    beatId: mediaExecution.CALIBRATION_BEAT_ID });
  assert.equal(authorized.status, 'EXECUTION_AUTHORIZED_SAFE_TO_INVOKE');
  assert.equal(authorized.authorization.sha256, ready.authorizationSha256);
  assert.equal(authorized.requestSafeToInvoke, true);
  assert.deepEqual(mediaExecution.walkFiles(ready.staged.runDirectory), readyBefore);
  await ready.runner.generateCalibrationStill(calibrationGenerateOptions(ready));
  const completedBefore = mediaExecution.walkFiles(ready.staged.runDirectory);
  const completed = ready.runner.calibrationStatus({ runId: mediaExecution.CALIBRATION_RUN_ID,
    beatId: mediaExecution.CALIBRATION_BEAT_ID });
  assert.equal(completed.status, 'GENERATED_PENDING_HUMAN_REVIEW');
  assert.equal(completed.requestKeyConsumed, true);
  assert.equal(completed.output.present, true);
  assert.equal(completed.receipt.present, true);
  assert.equal(completed.temporaryFiles.present, false);
  assert.deepEqual(mediaExecution.walkFiles(ready.staged.runDirectory), completedBefore);
});

test('inspection verifies PNG, receipt and ledger but creates no approval, promotion or file mutation', async t => {
  const f = makeCalibrationExecutionFixture(t);
  await f.runner.generateCalibrationStill(calibrationGenerateOptions(f));
  const beforeFiles = mediaExecution.walkFiles(f.staged.runDirectory);
  const beforeHashes = Object.fromEntries(beforeFiles.map(relative => [relative,
    sha(fs.readFileSync(path.join(f.staged.runDirectory, ...relative.split('/'))))]));
  const inspected = f.runner.inspectCalibrationStill({ runId: mediaExecution.CALIBRATION_RUN_ID,
    beatId: mediaExecution.CALIBRATION_BEAT_ID });
  assert.equal(inspected.status, 'INSPECTED_PENDING_HUMAN_REVIEW');
  assert.equal(inspected.approved, false);
  assert.equal(inspected.promoted, false);
  assert.equal(inspected.reviewerDecision, null);
  assert.equal(inspected.filesCreatedOrModified, 0);
  assert.deepEqual(mediaExecution.walkFiles(f.staged.runDirectory), beforeFiles);
  for (const [relative, expected] of Object.entries(beforeHashes))
    assert.equal(sha(fs.readFileSync(path.join(f.staged.runDirectory, ...relative.split('/')))), expected);
  assert.equal(fs.existsSync(path.join(f.staged.runDirectory, mediaExecution.CALIBRATION_BEAT_ID,
    'approval.json')), false);
  assert.equal(fs.existsSync(path.join(f.episodeRoot, 'assets')), false);
});

test('inspection rejects a successful receipt whose PNG bytes no longer match', async t => {
  const f = makeCalibrationExecutionFixture(t);
  await f.runner.generateCalibrationStill(calibrationGenerateOptions(f));
  fs.appendFileSync(path.join(f.staged.runDirectory, ...mediaExecution.CALIBRATION_FILES.output.split('/')), Buffer.from([0]));
  assert.throws(() => f.runner.inspectCalibrationStill({ runId: mediaExecution.CALIBRATION_RUN_ID,
    beatId: mediaExecution.CALIBRATION_BEAT_ID }), /PHASE3_CALIBRATION_OUTPUT_RECEIPT_OR_LEDGER_MISMATCH/);
});

function makeB009SourceStillFixture(t, options = {}) {
  const f = makeMediaExecutionFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const staged = f.runner.stage({ runId: b009SourceStill.RUN_ID });
  const reviewRoot = path.join(f.root, 'episode', '.review', 'phase3-media-execution');
  const approvalPath = typeof options.approvalPath === 'function' ? options.approvalPath(f.root)
    : options.approvalPath || path.join(DETACHED_APPROVAL_ROOT,
      'phase3-act1-b009-source-still-human-approval-20261005.v2.json');
  const state = { providerCalls: 0, downloadCalls: 0, requestLedgerSha256: mediaExecution.REQUEST_LEDGER_SHA256 };
  const workflow = b009SourceStill.createB009SourceStillWorkflow({ stagedRunner: f.runner,
    episodeRoot: path.join(f.root, 'episode'), reviewRoot,
    approvalPath,
    b006ApprovalPath: path.join(DETACHED_APPROVAL_ROOT,
      'phase3-act1-b006-calibration-human-approval-20261005.v1.json'),
    verifyB006StateFn: options.verifyB006StateFn || (() => true),
    reconciliationPath: options.reconciliationPath,
    routeBundlePath: options.routeBundlePath,
    completedStateVerifier: options.completedStateVerifier || null,
    provider: options.provider || { generateStill: async request => {
      state.providerCalls += 1; state.providerRequest = request;
      return { url: 'https://unit-test.fal.media/b009.png', imageCount: 1,
        providerRequestId: 'b009-test-request', actualChargeUsd: 0.024 };
    } },
    downloader: options.downloader || (async () => {
      state.downloadCalls += 1; return { bytes: pilotPng(1360, 768), contentType: 'image/png' };
    }), now: () => '2026-10-05T16:00:00.000Z', testHooks: options.testHooks || {} });
  const runDir = staged.runDirectory;
  const beatDir = path.join(runDir, b009SourceStill.BEAT_ID);
  function authorize(mutator) {
    fs.mkdirSync(beatDir, { recursive: false });
    const moduleBytes = fs.readFileSync(require.resolve('../pipeline-updates/phase3-media-calibration-source-still.cjs'));
    const executionModuleBytes = fs.readFileSync(require.resolve('../pipeline-updates/phase3-media-execution.cjs'));
    const cliBytes = fs.readFileSync(require.resolve('../scripts/phase3-media-execution.cjs'));
    const record = workflow.makeAuthTemplate({ moduleSha256: sha(moduleBytes),
      executionModuleSha256: sha(executionModuleBytes), cliSha256: sha(cliBytes),
      authorizedAt: '2026-10-05T15:59:00.000Z' });
    if (mutator) mutator(record);
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    fs.writeFileSync(path.join(beatDir, path.basename(b009SourceStill.FILES.authorization)), bytes, { flag: 'wx' });
    return { record, bytes, sha256: sha(bytes) };
  }
  return { ...f, episodeRoot: path.join(f.root, 'episode'), staged, reviewRoot, runDir, beatDir, workflow, state, authorize, approvalPath };
}

async function makeCompletedB009VerificationFixture(t) {
  let expected = null;
  const f = makeB009SourceStillFixture(t, { approvalPath: root => path.join(root, 'detached-source-still-approval.json'),
    completedStateVerifier: options => b009SourceStill.verifyCompletedSourceStillStateForTest({ ...options, expected }) }), authorization = f.authorize();
  await f.workflow.generate({ expectedAuthorizationSha256: authorization.sha256 });
  const bytesAt = key => fs.readFileSync(path.join(f.beatDir, path.basename(b009SourceStill.FILES[key])));
  const authorizationBytes = bytesAt('authorization'), receiptBytes = bytesAt('receipt');
  const ledgerBytes = bytesAt('ledger'), outputBytes = bytesAt('output');
  const authRecord = JSON.parse(authorizationBytes.toString('utf8'));
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const result = JSON.parse(bytesAt('result').toString('utf8'));
  const ledgerSha256 = sha(ledgerBytes), outputSha256 = sha(outputBytes);
  const approvalPath = f.approvalPath;
  const approval = JSON.parse(fs.readFileSync(path.join(DETACHED_APPROVAL_ROOT,
    'phase3-act1-b009-source-still-human-approval-20261005.v2.json'), 'utf8'));
  Object.assign(approval.bindings, {
    sourceStillAuthorizationSha256: sha(authorizationBytes), sourceStillReceiptSha256: sha(receiptBytes),
    sourceStillLedgerSha256: ledgerSha256, sourceStillSha256: outputSha256, sourceStillBytes: outputBytes.length,
    sourceStillWidth: 1360, sourceStillHeight: 768,
    deployedSourceStillWorkflowSha256: authRecord.bindings.deployedSourceStillWorkflowSha256,
    deployedMediaExecutionModuleSha256: authRecord.bindings.deployedMediaExecutionModuleSha256,
    deployedCliSha256: authRecord.bindings.deployedCliSha256,
  });
  const approvalBytes = Buffer.from(`${JSON.stringify(approval, null, 2)}\n`);
  fs.writeFileSync(approvalPath, approvalBytes, { flag: 'wx' });
  expected = {
    runId: b009SourceStill.RUN_ID, beatId: b009SourceStill.BEAT_ID, operation: b009SourceStill.OPERATION,
    requestKey: b009SourceStill.REQUEST_KEY, approvalSha256: sha(approvalBytes),
    authorizationSha256: sha(authorizationBytes), receiptSha256: sha(receiptBytes), ledgerSha256,
    outputSha256, outputBytes: outputBytes.length, width: 1360, height: 768,
    stagedIndexSha256: calibrationRoutes.TRUST.stagedIndexSha256,
    candidateIndexSha256: calibrationRoutes.TRUST.candidateIndexSha256,
    outerIndexSha256: calibrationRoutes.TRUST.outerIndexSha256,
    routeBundleSha256: b009SourceStill.ROUTE_BUNDLE_SHA256,
    routeResolutionApprovalSha256: calibrationRoutes.ROUTE_APPROVAL_SHA256,
    reconciliationSha256: b009SourceStill.RECONCILIATION_SHA256,
    stage04ActivationRecordSha256: 'f60d360c0179c87329d4e6d8be7b39d09da7ccc9d6c2351645fa2d8a4062923d',
    stage04LedgerBaselineSha256: mediaExecution.REQUEST_LEDGER_SHA256,
    assetClass: b009SourceStill.CLASSIFICATION,
  };
  const proof = b009SourceStill.verifyCompletedSourceStillStateForTest({ runDir: f.runDir, approvalPath, expected });
  assert.equal(f.workflow.status().status, 'APPROVED_FOR_ANIMATION_CALIBRATION_INPUT_ONLY');
  const completedPreflight = f.workflow.preflight();
  assert.equal(completedPreflight.status, 'COMPLETED_APPROVED_NOT_AUTHORIZED_FOR_PRODUCTION');
  assert.equal(completedPreflight.animationExecutionAuthority, false);
  return { ...f, expected, proof, approvalPath, hashes: { approval: sha(approvalBytes), authorization: sha(authorizationBytes),
    receipt: sha(receiptBytes), ledger: ledgerSha256, output: outputSha256 }, receipt, result, authRecord };
}

test('completed B009 verifier accepts only the exact human-approved historical source-still state', async t => {
  const f = await makeCompletedB009VerificationFixture(t);
  assert.equal(f.proof.status, 'COMPLETED_SOURCE_STILL_APPROVED_FOR_ANIMATION_INPUT_ONLY');
  assert.equal(f.proof.historicalRuntimeHashes.cliSha256, f.authRecord.bindings.deployedCliSha256);
  assert.equal(f.proof.historicalRuntimeHashes.cliSha256, JSON.parse(fs.readFileSync(f.approvalPath, 'utf8'))
    .bindings.deployedCliSha256);
  const pinnedHumanApproval = JSON.parse(fs.readFileSync(path.join(DETACHED_APPROVAL_ROOT,
    'phase3-act1-b009-source-still-human-approval-20261005.v2.json'), 'utf8'));
  assert.equal(pinnedHumanApproval.bindings.deployedCliSha256,
    '15f206469da1ba11f50c8b1596688cb123ae3b5c8f2b8ea21ceb0fba35e42c86');
  assert.notEqual(pinnedHumanApproval.bindings.deployedCliSha256,
    sha(fs.readFileSync(require.resolve('../scripts/phase3-media-execution.cjs'))),
  'the real approved source-still runtime predates the current CLI');
  assert.deepEqual(f.proof.allowedRunFiles, Object.values(b009SourceStill.FILES)
    .filter(relative => ['authorization', 'ledger', 'output', 'receipt', 'result'].some(key => b009SourceStill.FILES[key] === relative)).sort());
  const check = () => b009SourceStill.verifyCompletedSourceStillStateForTest({ runDir: f.runDir,
    approvalPath: f.approvalPath, expected: f.expected });
  const files = [
    [b009SourceStill.FILES.authorization, 'authorization'], [b009SourceStill.FILES.receipt, 'receipt'],
    [b009SourceStill.FILES.result, 'result'], [b009SourceStill.FILES.output, 'output'],
    [b009SourceStill.FILES.ledger, 'ledger'],
  ];
  for (const [relative] of files) {
    const target = path.join(f.runDir, ...relative.split('/')), original = fs.readFileSync(target);
    fs.appendFileSync(target, Buffer.from(' '));
    assert.throws(check, /PHASE3_B009_COMPLETED_(HASH|RECEIPT|RESULT|LEDGER|OUTPUT|HISTORICAL)_/, relative);
    fs.writeFileSync(target, original);
  }
  const approvalBytes = fs.readFileSync(f.approvalPath);
  fs.appendFileSync(f.approvalPath, Buffer.from(' '));
  assert.throws(check, /PHASE3_B009_COMPLETED_APPROVAL_HASH_MISMATCH/);
  fs.writeFileSync(f.approvalPath, approvalBytes);
  fs.writeFileSync(path.join(f.beatDir, 'unknown.json'), '{}\n');
  assert.throws(check, /PHASE3_B009_COMPLETED_FILE_SET_INVALID/);
});

test('overall preflight admits only the verified completed B009 file set and remains read-only', async t => {
  const f = await makeCompletedB009VerificationFixture(t);
  const proof = { ...f.proof, approvalSha256: '8b2c41cff79bac73a89e22d80a953517091acaa98bc110d6447da06e835b548c',
    authorizationSha256: '0b3b6ca57f7a8895a97bc5a67501704cbbf74a437c7053d99b0882499b5a3599',
    receiptSha256: '95b75386224f14b213750667cd4715705e28428f5d868d545cfe7c0036294285',
    ledgerSha256: 'f59d219075a2e94476f94b74dd444517980599ad50be499e6c682838ee6c7823',
    outputSha256: '0a9c9311c20da7dc774b1695f9abe2ea56f648fc0eb2450a8c7f0c4130b9ffdc',
    historicalRuntimeHashes: { moduleSha256: 'c3356b2db07b0d2a954a88ebc188e2eb20cdef4a17f4b9c6e5f8c6ec168ee439',
      executionModuleSha256: '206fa77609e681e18dd62708208a2dc47eebbcc9d666c46bb8d231b02f2dc79e',
      cliSha256: '15f206469da1ba11f50c8b1596688cb123ae3b5c8f2b8ea21ceb0fba35e42c86' } };
  const before = mediaExecution.walkFiles(f.runDir).map(relative => [relative,
    sha(fs.readFileSync(path.join(f.runDir, ...relative.split('/'))))]);
  assert.throws(() => f.runner.preflight({ runId: b009SourceStill.RUN_ID }), /PHASE3_MEDIA_EXECUTION_RUN_UNKNOWN_FILE/);
  const priorWrite = process.stdout.write;
  process.stdout.write = () => true;
  let result;
  try { result = await mediaExecutionCli.main(['--preflight', '--run-id', b009SourceStill.RUN_ID], f.runner,
    { verifyCompletedState: () => proof }); }
  finally { process.stdout.write = priorWrite; }
  assert.equal(result.runId, b009SourceStill.RUN_ID);
  assert.equal(result.stage04.status, 'PROMOTED');
  assert.equal(result.completedSourceStill.status, 'COMPLETED_SOURCE_STILL_APPROVED_FOR_ANIMATION_INPUT_ONLY');
  assert.equal(result.completedSourceStill.productionReadiness, 'REJECTED');
  assert.equal(result.providerRequests, 0);
  assert.deepEqual(mediaExecution.walkFiles(f.runDir).map(relative => [relative,
    sha(fs.readFileSync(path.join(f.runDir, ...relative.split('/'))))]), before);
  const providerCallsBefore = f.state.providerCalls;
  fs.writeFileSync(path.join(f.beatDir, 'unknown-extra.json'), '{}\n');
  assert.throws(() => f.runner.preflight({ runId: b009SourceStill.RUN_ID,
    completedSourceStillVerification: proof }), /PHASE3_MEDIA_EXECUTION_RUN_UNKNOWN_FILE/);
  assert.equal(f.state.providerCalls, providerCallsBefore);
});

test('B009 stale route-bundle request key is reproducibly reconciled from exact v5 candidate inputs', t => {
  const f = makeB009SourceStillFixture(t);
  const routeBytesBefore = fs.readFileSync(path.join(DETACHED_APPROVAL_ROOT,
    'phase3-media-execution-calibration-route-bundle-20261004.v1.json'));
  const result = f.workflow.assertBindings();
  assert.equal(result.request.requestKey, 'f10feb2552874270ce4af7705e5648e4beede07faedfa2a72072ba6633afdd02');
  assert.equal(result.request.requestKey, b009SourceStill.REQUEST_KEY);
  assert.equal(result.request.endpoint, 'blackforestlabs/flux-3/text-to-image');
  assert.equal(result.request.serializationDelimiter, calibrationRoutes.FLUX_NEGATIVE_PROMPT_DELIMITER);
  assert.equal(result.reconciliationSha256, b009SourceStill.RECONCILIATION_SHA256);
  assert.equal(sha(routeBytesBefore), b009SourceStill.ROUTE_BUNDLE_SHA256);
  assert.deepEqual(fs.readFileSync(path.join(DETACHED_APPROVAL_ROOT,
    'phase3-media-execution-calibration-route-bundle-20261004.v1.json')), routeBytesBefore);
});

test('B006 approval records truthful in-memory inspection provenance and exact media bindings', () => {
  const file = path.join(DETACHED_APPROVAL_ROOT, 'phase3-act1-b006-calibration-human-approval-20261005.v1.json');
  const bytes = fs.readFileSync(file), record = JSON.parse(bytes.toString('utf8'));
  assert.equal(sha(bytes), 'd00ce391df1822468eb7fe2d07f85fc6404c483e1a79105c9e50aaa875c1dcd1');
  assert.equal(record.status, 'APPROVED_FOR_CALIBRATION_VALIDATION_ONLY');
  assert.equal(record.output.bytes, 1445712);
  assert.equal(record.output.sha256, '5315292eecda643f19472224474cb011c70b4e7a3e104899ca6542b21ef1fe36');
  assert.equal(record.inspection.mechanism, 'runner-returned read-only inspection plus human visual review');
  assert.equal(record.inspection.persistedRunnerInspectionArtifact, null);
  assert.equal(record.inspection.inspectionArtifactSha256, null);
  assert.equal(record.inspection.originalMediaByteVerification, 'PASS');
  assert.equal(record.restrictions.act1B009Authority, false);
});

test('B009 accepts the exact hash-pinned historical B006 receipt status only with the complete approved state', () => {
  const valid = {
    approvalSha256: b009SourceStill.B006_APPROVAL_SHA256,
    authorizationSha256: 'b08ebd11da1018aafa388bf54e173655938453e50fc10bece4091a40c87abcc3',
    imageSha256: '5315292eecda643f19472224474cb011c70b4e7a3e104899ca6542b21ef1fe36',
    imageBytes: 1445712,
    receiptSha256: '730f1df08b948727c4c7950f8e0a70d51935d8ff69fdd72e5f7f3fce376175fd',
    receiptRecord: { schemaVersion: mediaExecution.CALIBRATION_RECEIPT_SCHEMA,
      status: 'GENERATED_PENDING_HUMAN_REVIEW', runId: b009SourceStill.RUN_ID,
      beatId: 'ACT1_B006', operation: 'GENERATE_STILL', requestKey: mediaExecution.CALIBRATION_REQUEST_KEY,
      authorizationSha256: 'b08ebd11da1018aafa388bf54e173655938453e50fc10bece4091a40c87abcc3',
      assetClass: b009SourceStill.CLASSIFICATION,
      output: { path: mediaExecution.CALIBRATION_FILES.output, format: 'PNG', width: 1360, height: 768,
        sha256: '5315292eecda643f19472224474cb011c70b4e7a3e104899ca6542b21ef1fe36', bytes: 1445712 } },
    ledgerSha256: 'f4ef26ce9b91d7976aecaa0e0a84014ae6d59a9726ce59f391ba8f63d1f417c1',
    ledgerRecords: [
      { schemaVersion: mediaExecution.CALIBRATION_LEDGER_SCHEMA, recordType: 'SUBMISSION_RESERVED', sequence: 1,
        runId: b009SourceStill.RUN_ID, beatId: 'ACT1_B006', operation: 'GENERATE_STILL',
        requestKey: mediaExecution.CALIBRATION_REQUEST_KEY, retryAllowed: false, fallbackAllowed: false },
      { schemaVersion: mediaExecution.CALIBRATION_LEDGER_SCHEMA, recordType: 'SUBMISSION_RESULT',
        status: 'SUCCEEDED', requestKey: mediaExecution.CALIBRATION_REQUEST_KEY },
    ],
  };
  assert.equal(b009SourceStill.verifyB006CompletedState(valid), true);
  assert.equal(b009SourceStill.b006ReceiptStatusAccepted('CALIBRATION_STILL_GENERATED_PENDING_HUMAN_REVIEW',
    '0'.repeat(64)), true, 'the previous canonical status remains recognized');
  assert.equal(b009SourceStill.b006ReceiptStatusAccepted('GENERATED_PENDING_HUMAN_REVIEW', valid.receiptSha256), true);
  assert.equal(b009SourceStill.b006ReceiptStatusAccepted('GENERATED_PENDING_HUMAN_REVIEW', '0'.repeat(64)), false);

  for (const [label, change] of [
    ['legacy status with altered receipt hash', value => { value.receiptSha256 = '0'.repeat(64); }],
    ['altered receipt status', value => { value.receiptRecord.status = 'INSPECTED_PENDING_HUMAN_REVIEW'; }],
    ['altered image hash', value => { value.imageSha256 = '0'.repeat(64); }],
    ['altered image binding in receipt', value => { value.receiptRecord.output.sha256 = '0'.repeat(64); }],
    ['altered authorization hash', value => { value.authorizationSha256 = '0'.repeat(64); }],
    ['altered ledger hash', value => { value.ledgerSha256 = '0'.repeat(64); }],
    ['altered approval hash', value => { value.approvalSha256 = '0'.repeat(64); }],
    ['altered request key', value => { value.receiptRecord.requestKey = '0'.repeat(64); }],
    ['non-success terminal result', value => { value.ledgerRecords[1].status = 'FAILED'; }],
    ['extra ledger entry', value => { value.ledgerRecords.push({ recordType: 'SUBMISSION_RESERVED' }); }],
  ]) {
    const altered = structuredClone(valid);
    change(altered);
    assert.equal(b009SourceStill.verifyB006CompletedState(altered), false, label);
  }
});

test('B009 read-only status and preflight bind exact candidate without creating run files or locks', t => {
  const f = makeB009SourceStillFixture(t);
  const before = mediaExecution.walkFiles(f.runDir);
  const result = f.workflow.preflight();
  assert.equal(result.status, 'EXECUTION_READY_UNAUTHORIZED');
  assert.equal(result.requestKey, b009SourceStill.REQUEST_KEY);
  assert.equal(result.sourceStillRequest.authorization.present, false);
  assert.equal(result.sourceStillRequest.providerRequests, 0);
  assert.equal(result.maximumProviderSubmissions, 1);
  assert.equal(result.humanApprovalRequiredBeforeAnimation, true);
  assert.equal(result.episodeRootWrites, 0);
  assert.equal(f.state.providerCalls, 0);
  assert.deepEqual(mediaExecution.walkFiles(f.runDir), before);
  assert.equal(fs.existsSync(f.beatDir), false);
});

test('B009 source-still authorization is one-request only and rejects changed or stale bindings before writes', t => {
  const valid = makeB009SourceStillFixture(t); const auth = valid.authorize();
  assert.equal(valid.workflow.status().status, 'EXECUTION_AUTHORIZED_SAFE_TO_INVOKE');
  assert.equal(valid.workflow.status().authorization.sha256, auth.sha256);
  assert.equal(valid.workflow.preflight().status, 'EXECUTION_AUTHORIZED_NOT_EXECUTED');
  assert.throws(() => valid.runner.preflight({ runId: b009SourceStill.RUN_ID }),
    /PHASE3_MEDIA_EXECUTION_RUN_UNKNOWN_FILE/);
  assert.equal(valid.state.providerCalls, 0);
  const altered = makeB009SourceStillFixture(t); altered.authorize(record => { record.request.retries = 1; });
  assert.equal(altered.workflow.status().authorization.valid, false);
  assert.equal(altered.state.providerCalls, 0);
  const badReconciliation = makeB009SourceStillFixture(t);
  const copy = path.join(badReconciliation.root, 'reconciliation.json');
  const original = fs.readFileSync(path.join(DETACHED_APPROVAL_ROOT,
    'phase3-act1-b009-request-key-reconciliation-20261005.v1.json'));
  fs.writeFileSync(copy, Buffer.concat([original, Buffer.from(' ')]));
  assert.throws(() => b009SourceStill.createB009SourceStillWorkflow({ stagedRunner: badReconciliation.runner,
    episodeRoot: path.join(badReconciliation.root, 'episode'), reviewRoot: badReconciliation.reviewRoot,
    b006ApprovalPath: path.join(DETACHED_APPROVAL_ROOT, 'phase3-act1-b006-calibration-human-approval-20261005.v1.json'),
    verifyB006StateFn: () => true, reconciliationPath: copy }).status(),
  /PHASE3_B009_REQUEST_RECONCILIATION_HASH_MISMATCH/);
});

test('B009 generation reserves once, invokes one image request, inspects exact PNG and keeps outputs non-production', async t => {
  const f = makeB009SourceStillFixture(t); const auth = f.authorize();
  const generated = await f.workflow.generate({ expectedAuthorizationSha256: auth.sha256 });
  assert.equal(generated.status, 'GENERATED_PENDING_HUMAN_REVIEW');
  assert.equal(generated.requestKey, b009SourceStill.REQUEST_KEY);
  assert.equal(f.state.providerCalls, 1); assert.equal(f.state.downloadCalls, 1);
  assert.equal(f.state.providerRequest.endpoint, calibrationRoutes.FLUX3_ENDPOINT);
  assert.deepEqual(f.state.providerRequest.input, {
    prompt: f.workflow.assertBindings().request.submittedPrompt,
    resolution: '1k', aspect_ratio: '16:9', output_format: 'png', num_images: 1, enable_prompt_expansion: false,
  });
  assert.equal(f.state.providerRequest.retries, 0); assert.equal(f.state.providerRequest.fallback, false);
  const inspected = f.workflow.inspect();
  assert.equal(inspected.status, 'INSPECTED_PENDING_HUMAN_REVIEW');
  assert.equal(inspected.output.format, 'PNG'); assert.equal(inspected.output.width, 1360);
  assert.equal(inspected.output.height, 768); assert.equal(inspected.approved, false);
  const ledger = mediaExecution.readCalibrationLedger(path.join(f.beatDir,
    path.basename(b009SourceStill.FILES.ledger)));
  assert.deepEqual(ledger.map(item => item.recordType), ['SUBMISSION_RESERVED', 'SUBMISSION_RESULT']);
  assert.equal(ledger[1].status, 'SUCCEEDED'); assert.equal(ledger[1].retryCount, 0);
  assert.equal(ledger[1].fallbackUsed, false);
  assert.equal(fs.existsSync(path.join(f.beatDir, path.basename(b009SourceStill.FILES.lock))), false);
  assert.equal(fs.existsSync(path.join(f.episodeRoot, 'assets')), false);
  assert.equal(fs.existsSync(path.join(f.episodeRoot, 'render-output')), false);
  assert.equal(inspected.assetClass, 'NON_PRODUCTION_DISPOSABLE_CALIBRATION');
  assert.equal(inspected.productionReadiness, 'REJECTED');
  assert.equal(inspected.requiresHumanApprovalBeforeAnimation, true);
});

test('B009 failure after reservation is permanent, releases lock, and leaves animation blocked', async t => {
  const f = makeB009SourceStillFixture(t, { testHooks: { afterReservation: async () => {
    throw new Error('TEST_STOP_AFTER_RESERVATION');
  } } });
  const auth = f.authorize();
  await assert.rejects(() => f.workflow.generate({ expectedAuthorizationSha256: auth.sha256 }), /TEST_STOP_AFTER_RESERVATION/);
  assert.equal(f.state.providerCalls, 0);
  const status = f.workflow.status();
  assert.equal(status.status, 'FAILED_REQUEST_KEY_PERMANENTLY_CONSUMED');
  assert.equal(status.requestKeyConsumed, true); assert.equal(status.animationAuthorized, false);
  assert.equal(fs.existsSync(path.join(f.beatDir, path.basename(b009SourceStill.FILES.lock))), false);
  assert.throws(() => f.workflow.preflight(), /PHASE3_B009_NOT_READY/);
  assert.deepEqual(mediaExecution.readCalibrationLedger(path.join(f.beatDir,
    path.basename(b009SourceStill.FILES.ledger))).map(item => item.recordType), ['SUBMISSION_RESERVED', 'SUBMISSION_RESULT']);
});

test('B009 pre-reservation failure is validated, consumed for retry purposes, and never reaches the provider', async t => {
  const f = makeB009SourceStillFixture(t, { testHooks: { beforeReservation: async () => {
    throw new Error('TEST_STOP_BEFORE_RESERVATION');
  } } });
  const auth = f.authorize();
  await assert.rejects(() => f.workflow.generate({ expectedAuthorizationSha256: auth.sha256 }), /TEST_STOP_BEFORE_RESERVATION/);
  assert.equal(f.state.providerCalls, 0);
  const status = f.workflow.status();
  assert.equal(status.status, 'FAILED_BEFORE_RESERVATION_NOT_RETRYABLE');
  assert.equal(status.failureReceipt.failureStage, 'BEFORE_RESERVATION');
  assert.equal(status.reservationState, 'ABSENT');
  assert.equal(status.requestKeyConsumed, false);
  await assert.rejects(() => f.workflow.generate({ expectedAuthorizationSha256: auth.sha256 }), /PHASE3_B009_RUN_ALREADY_USED/);
  assert.equal(f.state.providerCalls, 0);
  assert.equal(fs.existsSync(path.join(f.beatDir, path.basename(b009SourceStill.FILES.lock))), false);
});

test('B009 altered failure receipts and malformed result ledgers fail closed', async t => {
  const f = makeB009SourceStillFixture(t, { testHooks: { beforeReservation: async () => {
    throw new Error('TEST_FAILURE_RECEIPT');
  } } });
  const auth = f.authorize();
  await assert.rejects(() => f.workflow.generate({ expectedAuthorizationSha256: auth.sha256 }));
  const failurePath = path.join(f.beatDir, path.basename(b009SourceStill.FILES.failure));
  fs.appendFileSync(failurePath, ' ');
  assert.throws(() => f.workflow.status(), /PHASE3_B009_FAILURE_RECEIPT_INVALID/);
  const extra = makeB009SourceStillFixture(t);
  extra.authorize();
  const ledgerPath = path.join(extra.beatDir, path.basename(b009SourceStill.FILES.ledger));
  fs.writeFileSync(ledgerPath, '{"schemaVersion":"x"}\n');
  assert.throws(() => extra.workflow.status(), /PHASE3_CALIBRATION_LEDGER_CHAIN_INVALID|PHASE3_B009_LEDGER_INVALID/);
});

test('B009 rejects unknown files, alternate run/beat CLI scope, and any existing reservation', t => {
  const f = makeB009SourceStillFixture(t);
  const auth = f.authorize();
  fs.writeFileSync(path.join(f.beatDir, 'unexpected.json'), '{}\n');
  assert.throws(() => f.workflow.status(), /PHASE3_MEDIA_EXECUTION_RUN_UNKNOWN_FILE/);
  assert.throws(() => mediaExecutionCli.parseArgs(['--generate-calibration-source-still', '--phase3-run-id',
    b009SourceStill.RUN_ID, '--beat-id', 'ACT1_B006', '--expected-execution-authorization-sha256', auth.sha256]),
  /PHASE3_CALIBRATION_BEAT_FORBIDDEN/);
  assert.throws(() => mediaExecutionCli.parseArgs(['--generate-calibration-source-still', '--phase3-run-id',
    'phase3-media-execution-v5-other', '--beat-id', b009SourceStill.BEAT_ID,
    '--expected-execution-authorization-sha256', auth.sha256]), /PHASE3_CALIBRATION_RUN_FORBIDDEN/);
});

test('B009 animation lane uses the exact approved route prompts and source-bound deterministic key', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
    'phase3-media-execution-calibration-route-bundle-20261004.v1.json'), 'utf8'));
  const request = bundle.calibrationRequests.find(row => row.beatId === 'ACT1_B009' && row.operation === 'GENERATE_ANIMATION');
  assert.equal(bundle.bindings.stagedIndexSha256, b009Animation.PACKAGE.stagedIndexSha256);
  assert.equal(request.endpoint, 'minimax/h3-max/image-to-video');
  assert.equal(sha(Buffer.from(request.prompt)), '5b76ea425eb891f077866a2bd1fd40b44b1bc3e4d1b0ae3d392dc151b8d1348d');
  assert.equal(sha(Buffer.from(request.negativePrompt)), '1e07c7c0150f5f29cb5b20bee765e3e8056a4928013cd35771ecefabb078bae9');
  assert.equal(request.requestedSourceSeconds, 5);
  assert.equal(request.requestedResolution, '768P');
  assert.deepEqual(calibrationRoutes.H3_MAX, { duration: 5, resolution: '768P', prompt_expansion_mode: 'disabled', enable_safety_checker: true });
  const key = b009Animation.deriveAnimationRequestKey({ prompt: request.prompt, negativePrompt: request.negativePrompt });
  assert.equal(key, '946a3ac047028bf95badf61753f46e340bb27d8a3931c9f675ba210e1d9de3c3');
  assert.throws(() => b009Animation.deriveAnimationRequestKey({ prompt: request.prompt,
    negativePrompt: request.negativePrompt, sourceStillApprovalSha256: 'a'.repeat(64) }), /KEY_BINDING_MISMATCH/);
  assert.throws(() => b009Animation.deriveAnimationRequestKey({ prompt: `${request.prompt} `,
    negativePrompt: request.negativePrompt }), /PROMPT_HASH_MISMATCH/);
});

test('ACT1_B009 source-still approval is detached, hash-bound, accurately records the read-only inspection, and grants no execution authority', () => {
  const approvalPath = b009Animation.SOURCE_STILL_APPROVAL_PATH;
  const bytes = fs.readFileSync(approvalPath), record = JSON.parse(bytes.toString('utf8'));
  assert.equal(sha(bytes), b009Animation.SOURCE_STILL_APPROVAL_SHA256);
  assert.equal(record.status, 'APPROVED_FOR_ANIMATION_CALIBRATION_INPUT_ONLY');
  assert.equal(record.bindings.sourceStillSha256, b009Animation.SOURCE_STILL_SHA256);
  assert.equal(record.bindings.sourceStillAuthorizationSha256, b009Animation.SOURCE_STILL_AUTH_SHA256);
  assert.equal(record.bindings.sourceStillReceiptSha256, b009Animation.SOURCE_STILL_RECEIPT_SHA256);
  assert.equal(record.bindings.sourceStillLedgerSha256, b009Animation.SOURCE_STILL_LEDGER_SHA256);
  assert.equal(record.inspection.mechanism, 'runner-returned read-only inspection plus human visual review');
  assert.equal(record.inspection.persistedInspectionArtifact, 'NONE');
  assert.equal(record.inspection.inspectionArtifactSha256, null);
  assert.equal(record.inspection.observedStatus, 'INSPECTED_PENDING_HUMAN_REVIEW');
  assert.equal(record.restrictions.animationExecutionAuthorized, false);
  assert.equal(record.restrictions.providerRequestsAuthorized, 0);
});

test('B009 animation authorization is one exact ANIMATION_ONLY request and preserves non-production denials', () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
    'phase3-media-execution-calibration-route-bundle-20261004.v1.json'), 'utf8'));
  const request = bundle.calibrationRequests.find(row => row.beatId === 'ACT1_B009' && row.operation === 'GENERATE_ANIMATION');
  const requestKey = b009Animation.deriveAnimationRequestKey({ prompt: request.prompt, negativePrompt: request.negativePrompt });
  const runtimeHashes = { animationWorkflowSha256: 'a'.repeat(64), executionModuleSha256: 'b'.repeat(64), cliSha256: 'c'.repeat(64) };
  const auth = b009Animation.makeAuthorizationTemplate({ requestKey, runtimeHashes, authorizedAt: '2026-10-06T00:00:00.000Z' });
  assert.equal(auth.scope, 'ANIMATION_ONLY');
  assert.equal(auth.maxProviderSubmissions, 1);
  assert.equal(auth.request.maximumProviderSubmissions, 1);
  assert.equal(auth.request.retries, 0);
  assert.equal(auth.request.fallback, false);
  assert.equal(auth.request.expectedPublishedChargeUsd, 0.4);
  assert.equal(auth.request.maximumHumanAcceptedExposureUsd, 0.6);
  assert.equal(auth.request.exposureProviderEnforced, false);
  assert.equal(auth.classification.assetClass, 'NON_PRODUCTION_DISPOSABLE_CALIBRATION');
  assert.equal(auth.classification.productionReadiness, 'REJECTED');
  assert.equal(auth.denials.secondSubmission, true);
  assert.equal(auth.denials.retry, true);
  assert.equal(auth.denials.fallback, true);
  assert.equal(auth.denials.productionUse, true);
  assert.equal(auth.bindings.sourceStillApprovalSha256, b009Animation.SOURCE_STILL_APPROVAL_SHA256);
  assert.equal(auth.bindings.sourceStillSha256, b009Animation.SOURCE_STILL_SHA256);
  assert.equal(b009Animation.validateAnimationAuthorization(auth, 'd'.repeat(64),
    { requestKey, runtimeHashes }), true);
  assert.throws(() => b009Animation.validateAnimationAuthorization(auth, 'd'.repeat(64),
    { requestKey, runtimeHashes: { ...runtimeHashes, cliSha256: 'e'.repeat(64) } }),
  /AUTHORIZATION_BINDING_INVALID/, 'animation readiness remains pinned to the current deployed CLI');
  assert.throws(() => b009Animation.validateAnimationAuthorization({ ...auth, scope: 'STILL_ONLY' }, 'd'.repeat(64),
    { requestKey, runtimeHashes }), /AUTHORIZATION_BINDING_INVALID/);
  assert.throws(() => b009Animation.validateAnimationAuthorization({ ...auth, maxProviderSubmissions: 2 }, 'd'.repeat(64),
    { requestKey, runtimeHashes }), /AUTHORIZATION_BINDING_INVALID/);
});

test('B009 animation staged-file compatibility accepts only the exact unused v1 audit authorization', t => {
  const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, b009Animation.RUN_ID), beatDir = path.join(runDir, 'ACT1_B009');
  fs.mkdirSync(beatDir, { recursive: true });
  const legacy = fs.readFileSync(path.join(__dirname, 'fixtures', 'phase3-b009-unused-animation-auth-v1.json'));
  assert.equal(legacy.length, 3860);
  assert.equal(sha(legacy), b009Animation.LEGACY_AUTHORIZATION.sha256);
  fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.LEGACY_AUTHORIZATION.path)), legacy);
  assert.deepEqual(b009Animation.verifyStagedRunFiles({ runDir }), [b009Animation.LEGACY_AUTHORIZATION.path]);

  fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.LEGACY_AUTHORIZATION.path)), Buffer.concat([legacy, Buffer.from(' ')]));
  assert.throws(() => b009Animation.verifyStagedRunFiles({ runDir }), /LEGACY_AUTHORIZATION_HASH_MISMATCH/);
  fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.LEGACY_AUTHORIZATION.path)), legacy);
  fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.FILES.ledger)), Buffer.alloc(0));
  assert.throws(() => b009Animation.verifyStagedRunFiles({ runDir }), /LEGACY_AUTHORIZATION_ALREADY_CONSUMED/);
  fs.unlinkSync(path.join(beatDir, path.basename(b009Animation.FILES.ledger)));
  fs.writeFileSync(path.join(beatDir, 'unrecognized.json'), '{}');
  assert.throws(() => b009Animation.verifyStagedRunFiles({ runDir }), /ANIMATION_UNKNOWN_FILE/);
});

test('B009 animation staged-file compatibility accepts a strictly bound superseding v2 authorization only', t => {
  const root = tempRoot(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, b009Animation.RUN_ID), beatDir = path.join(runDir, 'ACT1_B009');
  fs.mkdirSync(beatDir, { recursive: true });
  const legacy = fs.readFileSync(path.join(__dirname, 'fixtures', 'phase3-b009-unused-animation-auth-v1.json'));
  fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.LEGACY_AUTHORIZATION.path)), legacy);
  const runtimeHashes = { animationWorkflowSha256: 'a'.repeat(64), executionModuleSha256: 'b'.repeat(64), cliSha256: 'c'.repeat(64) };
  const record = b009Animation.makeAuthorizationTemplate({ requestKey: b009Animation.ANIMATION_REQUEST_KEY,
    runtimeHashes, authorizedAt: '2026-10-06T00:00:00.000Z' });
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.FILES.authorization)), bytes);
  assert.deepEqual(b009Animation.verifyStagedRunFiles({ runDir, currentRuntimeHashes: runtimeHashes }), [
    b009Animation.LEGACY_AUTHORIZATION.path, b009Animation.FILES.authorization,
  ].sort());
  record.supersedes.sha256 = '0'.repeat(64);
  fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.FILES.authorization)), Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
  assert.throws(() => b009Animation.verifyStagedRunFiles({ runDir, currentRuntimeHashes: runtimeHashes }),
    /AUTHORIZATION_BINDING_INVALID/);
  fs.unlinkSync(path.join(beatDir, path.basename(b009Animation.LEGACY_AUTHORIZATION.path)));
  assert.throws(() => b009Animation.verifyStagedRunFiles({ runDir, currentRuntimeHashes: runtimeHashes }),
    /SUPERSEDED_AUTHORIZATION_REQUIRED/);
});

test('B009 staged runner admits verified animation audit file in exact v5 run but still rejects unknown paths', t => {
  const f = makeMediaExecutionFixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const staged = f.runner.stage({ runId: b009Animation.RUN_ID });
  const beatDir = path.join(staged.runDirectory, 'ACT1_B009'); fs.mkdirSync(beatDir);
  for (const relative of Object.values(mediaExecution.CALIBRATION_SOURCE_STILL_FILES)) {
    if (relative.endsWith('/source-still.lock') || relative.endsWith('/source-still-failure-receipt.v1.json')) continue;
    const target = path.join(staged.runDirectory, ...relative.split('/'));
    fs.writeFileSync(target, Buffer.from(`verified-source-still-fixture:${path.basename(relative)}`));
  }
  const legacy = fs.readFileSync(path.join(__dirname, 'fixtures', 'phase3-b009-unused-animation-auth-v1.json'));
  fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.LEGACY_AUTHORIZATION.path)), legacy);
  f.runner.setCalibrationAnimationRunFilesVerifier(({ runDir, fsImpl }) =>
    b009Animation.verifyStagedRunFiles({ runDir, fsImpl }));
  const before = mediaExecution.walkFiles(staged.runDirectory);
  const result = f.runner.preflight({ runId: b009Animation.RUN_ID, includeSourceStillCalibration: true });
  assert.equal(result.status, 'PHASE3_MEDIA_EXECUTION_PREFLIGHT_PASS_CALIBRATION_READY_EXECUTION_UNAUTHORIZED');
  assert.deepEqual(mediaExecution.walkFiles(staged.runDirectory), before);
  assert.equal(result.providerRequests, 0);
  assert.equal(result.episodeRootWrites, 0);
  fs.writeFileSync(path.join(beatDir, 'unknown.json'), '{}');
  assert.throws(() => f.runner.preflight({ runId: b009Animation.RUN_ID, includeSourceStillCalibration: true }),
    /PHASE3_B009_ANIMATION_UNKNOWN_FILE/);
});

test('B009 animation derivative deterministically strips audio and produces exactly 114 30-fps frames in its isolated directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-b009-animation-fit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'raw.bin'), output = path.join(dir, 'fitted.mp4'); fs.writeFileSync(input, Buffer.from('raw-video'));
  let ffmpegArgs, probeCalls = 0;
  const ffprobe = () => (++probeCalls === 1
    ? { videoStreamCount: 1, audioStreamCount: 1, durationSeconds: 5, video: { fps: 30, frameCount: 150, width: 1280, height: 720 } }
    : { videoStreamCount: 1, audioStreamCount: 0, durationSeconds: 3.8, video: { fps: 30, frameCount: 114, width: 1280, height: 720 } });
  const ffmpeg = (_command, args) => { ffmpegArgs = args; fs.writeFileSync(args.at(-1), Buffer.from('fitted-video')); return { status: 0 }; };
  const result = b009Animation.fitSilentDerivative({ inputPath: input, outputPath: output, ffmpeg, ffprobe });
  assert.equal(fs.existsSync(output), true);
  assert.equal(result.metadata.video.frameCount, 114);
  assert.equal(result.metadata.video.fps, 30);
  assert.equal(result.metadata.audioStreamCount, 0);
  assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-an')], '-an');
  assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-frames:v') + 1], '114');
  assert.ok(path.resolve(ffmpegArgs.at(-1)).startsWith(`${path.resolve(dir)}${path.sep}`));
});

test('B009 animation refuses malformed or short raw media before FFmpeg and CLI stays beat/run scoped', () => {
  let ffmpegCalls = 0;
  assert.throws(() => b009Animation.fitSilentDerivative({ inputPath: 'raw.bin', outputPath: 'out.mp4',
    ffprobe: () => ({ videoStreamCount: 1, durationSeconds: 2, video: { fps: 30, frameCount: 60 } }),
    ffmpeg: () => { ffmpegCalls++; return { status: 0 }; } }), /RAW_VIDEO_NOT_FRAME_ALIGNED/);
  assert.equal(ffmpegCalls, 0);
  const args = ['--preflight-calibration-animation', '--phase3-run-id', b009Animation.RUN_ID,
    '--beat-id', b009Animation.BEAT_ID];
  assert.equal(mediaExecutionCli.parseArgs(args).mode, 'preflight-calibration-animation');
  assert.throws(() => mediaExecutionCli.parseArgs(['--preflight-calibration-animation', '--phase3-run-id',
    b009Animation.RUN_ID, '--beat-id', 'ACT1_B006']), /PHASE3_CALIBRATION_BEAT_FORBIDDEN/);
});

test('B009 offline recovery pins the preserved raw and audit bindings and normalizes verified CFR 24 fps to silent 114-frame 30 fps', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-b009-animation-recovery-fit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'ACT1_B009-animation-provider-output.bin');
  const output = path.join(dir, 'ACT1_B009-animation-30fps-114f.mp4');
  const raw = Buffer.from('exact-live-binding-is-checked-by-the-supported-recovery-command');
  fs.writeFileSync(input, raw);
  const timestamps = Array.from({ length: 124 }, (_, index) => index / 24);
  const source = { container: 'mov,mp4,m4a,3gp,3g2,mj2', durationSeconds: 5.184,
    videoStreamCount: 1, audioStreamCount: 1,
    video: { codec: 'h264', width: 1344, height: 768, fps: 24, avgFps: 24, rFps: 24, frameCount: 124 } };
  const fitted = { container: 'mov,mp4,m4a,3gp,3g2,mj2', durationSeconds: 3.8,
    videoStreamCount: 1, audioStreamCount: 0,
    video: { codec: 'h264', width: 1344, height: 768, fps: 30, avgFps: 30, rFps: 30, frameCount: 114 } };
  let calls = 0, ffmpegArgs;
  const result = b009Animation.fitSilentDerivative({ inputPath: input, outputPath: output, recoveryMode: true,
    frameTimestamps: timestamps, ffprobe: () => (++calls === 1 ? source : fitted),
    ffmpeg: (_command, args) => { ffmpegArgs = args; fs.writeFileSync(args.at(-1), Buffer.from('fitted')); return { status: 0 }; } });
  assert.equal(result.metadata.video.fps, 30);
  assert.equal(result.metadata.video.frameCount, 114);
  assert.equal(result.metadata.audioStreamCount, 0);
  assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-vf') + 1], 'fps=30:round=near');
  assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-an')], '-an');
  assert.equal(ffmpegArgs[ffmpegArgs.indexOf('-frames:v') + 1], '114');
  assert.deepEqual(fs.readFileSync(input), raw, 'fitting leaves raw provider bytes untouched');
  assert.equal(b009Animation.RECOVERY.rawBytes, 6951973);
  assert.equal(b009Animation.RECOVERY.rawSha256, '976a45b4230d20638a260d8fc41306951ff308b077a174531257a7534e468c79');
  assert.equal(b009Animation.RECOVERY.ledgerSha256, 'fe3e7ab055ed1a2925cfb92f0e9511f87b512b702333afc89fcbfd77b214d024');
  assert.equal(b009Animation.RECOVERY.failureSha256, '7dd3b9cb69b866105f18986ae4ee76169779105f881c74645e0631239be69c9c');
});

test('B009 FFprobe JSON timestamps parse the observed SEI-bearing output and enforce the bound 124-frame CFR source', () => {
  const observedFrames = Array.from({ length: 124 }, (_, index) => ({
    best_effort_timestamp_time: (index / 24).toFixed(6),
    ...(index === 0 ? { side_data_list: [{
      side_data_type: 'H.26[45] User Data Unregistered SEI message',
    }] } : {}),
  }));
  const observedOutput = `${JSON.stringify({ frames: observedFrames }, null, 4)}\n\n  `;
  let observedArgs;
  const parse = (frames = observedFrames, { expectedFrameCount = 124, expectedFps = 24 } = {}) =>
    b009Animation.probeFrameTimestamps('raw.bin', {
      expectedFrameCount, expectedFps,
      execFileImpl: (_command, args) => { observedArgs = args; return `${JSON.stringify({ frames })}\n\t`; },
    });
  const timestamps = b009Animation.probeFrameTimestamps('raw.bin', {
    expectedFrameCount: 124, expectedFps: 24,
    execFileImpl: (_command, args) => { observedArgs = args; return observedOutput; },
  });
  assert.deepEqual(observedArgs, ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', 'raw.bin']);
  assert.equal(timestamps.length, 124, 'JSON document whitespace must not create an extra timestamp');
  assert.equal(b009Animation.isConstantFrameRate(timestamps, 24, 124), true);
  assert.equal(timestamps[0], 0);
  assert.equal(timestamps.at(-1), Number((123 / 24).toFixed(6)));
  assert.equal(Object.hasOwn(observedFrames[1], 'pkt_pts_time'), false,
    'optional timestamp fields may be absent when best_effort_timestamp_time is present');

  assert.throws(() => parse(observedFrames.map((frame, index) => index === 12
    ? {} : frame)), /FRAME_TIMESTAMP_INVALID/, 'missing best-effort timestamps are rejected');
  assert.throws(() => parse(observedFrames.map((frame, index) => index === 12
    ? { best_effort_timestamp_time: 'not-a-timestamp' } : frame)), /FRAME_TIMESTAMP_INVALID/);
  assert.throws(() => parse([...observedFrames, { best_effort_timestamp_time: '5.166667' }]),
    /FRAME_TIMESTAMP_COUNT_INVALID/);
  assert.throws(() => parse(observedFrames.map((frame, index) => index === 70
    ? { best_effort_timestamp_time: observedFrames[69].best_effort_timestamp_time } : frame)),
  /FRAME_TIMESTAMP_CADENCE_INVALID/, 'duplicate timestamps are rejected');
  assert.throws(() => parse(observedFrames.map((frame, index) => index === 70
    ? { best_effort_timestamp_time: '2.800000' } : frame)),
  /FRAME_TIMESTAMP_CADENCE_INVALID/, 'non-monotonic timestamps are rejected');
  assert.throws(() => parse(observedFrames.map((frame, index) => index === 70
    ? { best_effort_timestamp_time: (index / 24 + 0.01).toFixed(6) } : frame)),
  /FRAME_TIMESTAMP_CADENCE_INVALID/, 'materially variable cadence is rejected');
  assert.throws(() => b009Animation.probeFrameTimestamps('raw.bin', {
    expectedFrameCount: 124, expectedFps: 24, execFileImpl: () => '{not-json}',
  }), /FRAME_TIMESTAMP_INVALID/);
  assert.equal(b009Animation.isConstantFrameRate(timestamps.map((value, index) =>
    index === 70 ? value - 0.01 : value), 24, 124), false,
  'non-monotonic or off-cadence timestamps are rejected without sorting or deduplication');
  assert.equal(b009Animation.isConstantFrameRate([...timestamps, timestamps.at(-1) + 1 / 24], 24, 124), false,
    'a genuinely extra frame is rejected');
});

test('B009 offline recovery rejects VFR, truncated and mismatched source metadata before FFmpeg', () => {
  const valid = { container: 'mov,mp4,m4a,3gp,3g2,mj2', durationSeconds: 5.184,
    videoStreamCount: 1, audioStreamCount: 1,
    video: { codec: 'h264', width: 1344, height: 768, fps: 24, avgFps: 24, rFps: 24, frameCount: 124 } };
  const timestamps = Array.from({ length: 124 }, (_, index) => index / 24);
  for (const [metadata, frameTimes, code] of [
    [valid, timestamps.map((value, index) => value + (index === 70 ? 0.01 : 0)), 'RECOVERY_RAW_NOT_VERIFIED_CFR_24'],
    [{ ...valid, video: { ...valid.video, frameCount: 123 } }, timestamps, 'RECOVERY_RAW_NOT_VERIFIED_CFR_24'],
    [{ ...valid, video: { ...valid.video, codec: 'vp9' } }, timestamps, 'RECOVERY_RAW_NOT_VERIFIED_CFR_24'],
  ]) {
    let ffmpegCalls = 0;
    assert.throws(() => b009Animation.fitSilentDerivative({ inputPath: 'untrusted.bin', outputPath: 'out.mp4',
      recoveryMode: true, frameTimestamps: frameTimes, ffprobe: () => metadata,
      ffmpeg: () => { ffmpegCalls++; return { status: 0 }; } }), new RegExp(code));
    assert.equal(ffmpegCalls, 0);
  }
  assert.equal(b009Animation.isConstantFrameRate(timestamps, 24, 124), true);
  assert.equal(b009Animation.isConstantFrameRate(timestamps.slice(1), 24, 124), false);
});

test('B009 reservation ledger accepts exactly one terminal result for its reserved request without reserving again', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-b009-ledger-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'animation-request-ledger.jsonl');
  const base = { runId: b009Animation.RUN_ID, beatId: b009Animation.BEAT_ID,
    operation: b009Animation.OPERATION, endpoint: b009Animation.ENDPOINT,
    requestKey: b009Animation.ANIMATION_REQUEST_KEY, fallbackAllowed: false };
  b009Animation.appendLedger(file, { ...base, recordType: 'SUBMISSION_RESERVED', sequence: 1,
    authorizationSha256: b009Animation.RECOVERY.authorizationSha256, retriesAllowed: false,
    reservedAt: b009Animation.RECOVERY.expectedReservationAt }, fs);
  assert.equal(b009Animation.readLedger(file, fs).length, 1);
  b009Animation.appendLedger(file, { ...base, recordType: 'SUBMISSION_RESULT', sequence: 2,
    status: 'SUCCEEDED', retryCount: 0, fallbackUsed: false, recordedAt: '2026-10-06T10:00:00.000Z' }, fs);
  assert.deepEqual(b009Animation.readLedger(file, fs).map(row => row.recordType),
    ['SUBMISSION_RESERVED', 'SUBMISSION_RESULT']);
  assert.throws(() => b009Animation.appendLedger(file, { ...base, recordType: 'SUBMISSION_RESERVED',
    sequence: 3, retriesAllowed: false }, fs), /REQUEST_ALREADY_CONSUMED/);
  assert.throws(() => b009Animation.appendLedger(file, { ...base, recordType: 'SUBMISSION_RESULT',
    sequence: 2, status: 'SUCCEEDED', retryCount: 0, fallbackUsed: false }, fs), /TERMINAL_WITHOUT_RESERVATION/);
});

test('B009 offline recovery completes only its existing reservation, never invokes a provider, and preserves raw and production state', t => {
  const makeRecoveryFixture = (alter = null, pidProbe = process.kill.bind(process)) => {
    const root = tempRoot(), reviewRoot = path.join(root, '.review'), runDir = path.join(reviewRoot, b009Animation.RUN_ID);
    const beatDir = path.join(runDir, b009Animation.BEAT_ID), episodeRoot = path.join(root, 'episode-root');
    fs.mkdirSync(beatDir, { recursive: true }); fs.mkdirSync(episodeRoot, { recursive: true });
    const sourceNames = ['authorization', 'ledger', 'output', 'receipt', 'result'];
    for (const key of sourceNames) fs.writeFileSync(path.join(beatDir, path.basename(b009SourceStill.FILES[key])), `source-${key}`);
    const legacy = fs.readFileSync(path.join(__dirname, 'fixtures', 'phase3-b009-unused-animation-auth-v1.json'));
    fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.LEGACY_AUTHORIZATION.path)), legacy);
    const routeBundlePath = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
      'phase3-media-execution-calibration-route-bundle-20261004.v1.json');
    const routeBundle = JSON.parse(fs.readFileSync(routeBundlePath, 'utf8'));
    const request = { ...routeBundle.calibrationRequests.find(item => item.beatId === b009Animation.BEAT_ID
      && item.operation === b009Animation.OPERATION), parameters: { ...calibrationRoutes.H3_MAX } };
    const runtimeHashes = b009Animation.RECOVERY.historicalAuthorizationRuntimeHashes;
    const authorization = b009Animation.makeAuthorizationTemplate({ requestKey: b009Animation.ANIMATION_REQUEST_KEY,
      runtimeHashes, authorizedAt: '2026-10-06T09:00:00.000Z' });
    const authorizationBytes = Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`);
    fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.FILES.authorization)), authorizationBytes);
    const raw = Buffer.from('deterministic synthetic fixture for the pinned CFR recovery contract');
    const rawPath = path.join(beatDir, path.basename(b009Animation.FILES.raw)); fs.writeFileSync(rawPath, raw);
    const expectedReservationAt = b009Animation.RECOVERY.expectedReservationAt;
    const ledgerPath = path.join(beatDir, path.basename(b009Animation.FILES.ledger));
    b009Animation.appendLedger(ledgerPath, { schemaVersion: b009Animation.LEDGER_SCHEMA,
      recordType: 'SUBMISSION_RESERVED', sequence: 1, runId: b009Animation.RUN_ID,
      beatId: b009Animation.BEAT_ID, operation: b009Animation.OPERATION, endpoint: b009Animation.ENDPOINT,
      requestKey: b009Animation.ANIMATION_REQUEST_KEY, authorizationSha256: sha(authorizationBytes),
      sourceStillSha256: b009Animation.SOURCE_STILL_SHA256,
      sourceStillApprovalSha256: b009Animation.SOURCE_STILL_APPROVAL_SHA256,
      stagedIndexSha256: b009Animation.PACKAGE.stagedIndexSha256,
      retriesAllowed: false, fallbackAllowed: false, reservedAt: expectedReservationAt }, fs);
    const ledgerBytes = fs.readFileSync(ledgerPath), ledgerSha256 = sha(ledgerBytes);
    const failure = { schemaVersion: b009Animation.FAILURE_SCHEMA, status: 'FAILED', runId: b009Animation.RUN_ID,
      beatId: b009Animation.BEAT_ID, operation: b009Animation.OPERATION,
      requestKey: b009Animation.ANIMATION_REQUEST_KEY, failureStage: 'AFTER_RESERVATION',
      reservationCount: 1, providerRequestCount: 1, ledgerSha256,
      errorCode: 'PHASE3_B009_ANIMATION_RAW_VIDEO_NOT_FRAME_ALIGNED',
      recordedAt: b009Animation.RECOVERY.expectedFailureAt, retryAllowed: false, fallbackAllowed: false,
      assetClass: b009Animation.ASSET_CLASS };
    const failureBytes = Buffer.from(`${JSON.stringify(failure, null, 2)}\n`);
    fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.FILES.failure)), failureBytes);
    const recoveryBindings = { authorizationSha256: sha(authorizationBytes), rawBytes: raw.length,
      rawSha256: sha(raw), ledgerSha256, failureSha256: sha(failureBytes), expectedReservationAt,
      expectedFailureAt: failure.recordedAt };
    if (alter) alter({ root, beatDir, rawPath, raw, ledgerPath, failurePath: path.join(beatDir,
      path.basename(b009Animation.FILES.failure)), recoveryBindings, authorizationBytes });
    let providerCalls = 0, downloaderCalls = 0, ffmpegCalls = 0;
    const sourceStillWorkflow = { assertBindings() { return { stage04: { status: 'PROMOTED', promotedPathCount: 147,
      promotedPathsMatch: true }, staged: { calibrationRoutePlan: { requests: [request] } } }; } };
    const sourceMetadata = { container: 'mov,mp4,m4a,3gp,3g2,mj2', durationSeconds: 5.184,
      videoStreamCount: 1, audioStreamCount: 1,
      video: { codec: 'h264', width: 1344, height: 768, fps: 24, avgFps: 24, rFps: 24, frameCount: 124 } };
    const fittedMetadata = { container: 'mov,mp4,m4a,3gp,3g2,mj2', durationSeconds: 3.8,
      videoStreamCount: 1, audioStreamCount: 0,
      video: { codec: 'h264', width: 1344, height: 768, fps: 30, avgFps: 30, rFps: 30, frameCount: 114 } };
    let pidProbeCalls = 0;
    const workflow = b009Animation.createB009AnimationWorkflow({ sourceStillWorkflow, reviewRoot, episodeRoot,
      approvalPath: b009Animation.SOURCE_STILL_APPROVAL_PATH, testHooks: { recoveryBindings },
      pidProbe: (pid, signal) => { pidProbeCalls++; return pidProbe(pid, signal); },
      provider: { async generateAnimation() { providerCalls++; throw new Error('PROVIDER_MUST_NOT_BE_CALLED'); } },
      downloader: async () => { downloaderCalls++; throw new Error('DOWNLOAD_MUST_NOT_BE_CALLED'); },
      ffprobe: file => file === rawPath ? sourceMetadata : fittedMetadata,
      ffprobeFrames: () => Array.from({ length: 124 }, (_, index) => index / 24),
      ffmpeg: (_command, args) => { ffmpegCalls++; fs.writeFileSync(args.at(-1), Buffer.from('recovered-derivative')); return { status: 0 }; },
      now: () => '2026-10-06T12:00:00.000Z' });
    return { root, beatDir, episodeRoot, rawPath, raw, ledgerPath, ledgerBytes, failureBytes, workflow,
      providerCalls: () => providerCalls, downloaderCalls: () => downloaderCalls, ffmpegCalls: () => ffmpegCalls,
      pidProbeCalls: () => pidProbeCalls };
  };
  const f = makeRecoveryFixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const beforeEpisode = fs.readdirSync(f.episodeRoot);
  const recovered = f.workflow.recoverExistingProviderOutput();
  assert.equal(recovered.status, 'ANIMATION_GENERATED_PENDING_HUMAN_REVIEW');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.providerRequestsDuringRecovery, 0);
  assert.equal(recovered.newReservations, 0);
  assert.equal(f.providerCalls(), 0); assert.equal(f.downloaderCalls(), 0); assert.equal(f.ffmpegCalls(), 1);
  assert.equal(f.pidProbeCalls(), 1, 'PID liveness is checked only for the runner-owned lock');
  assert.deepEqual(fs.readFileSync(f.rawPath), f.raw);
  assert.deepEqual(b009Animation.readLedger(f.ledgerPath, fs).map(row => row.recordType),
    ['SUBMISSION_RESERVED', 'SUBMISSION_RESULT']);
  const records = b009Animation.readLedger(f.ledgerPath, fs);
  assert.equal(records.filter(row => row.recordType === 'SUBMISSION_RESERVED').length, 1);
  assert.equal(records.filter(row => row.recordType === 'SUBMISSION_RESULT').length, 1);
  assert.equal(records[1].status, 'SUCCEEDED'); assert.equal(records[1].providerRequestId, null);
  assert.equal(records[1].actualChargeUsd, null); assert.equal(records[1].retryCount, 0);
  assert.equal(records[1].fallbackUsed, false); assert.equal(records[1].providerSubmissionCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.beatDir, path.basename(b009Animation.FILES.receipt)), 'utf8'))
    .assetClass, 'NON_PRODUCTION_DISPOSABLE_CALIBRATION');
  assert.deepEqual(fs.readdirSync(f.episodeRoot), beforeEpisode);
  assert.equal(fs.existsSync(path.join(f.beatDir, path.basename(b009Animation.FILES.lock))), false);
  assert.equal(fs.readdirSync(f.beatDir).some(name => name.includes('.tmp-')), false);
  assert.throws(() => f.workflow.recoverExistingProviderOutput(), /RECOVERY_FILE_SET_INVALID/,
    'a successful recovery cannot be run a second time');
  assert.equal(f.providerCalls(), 0); assert.equal(f.downloaderCalls(), 0);
  const workflowSource = fs.readFileSync(path.join(__dirname, '..', 'pipeline-updates',
    'phase3-media-calibration-animation.cjs'), 'utf8');
  assert.doesNotMatch(workflowSource, /execFileSync\(['"]ps['"]|processTable/u);
  const lockName = path.basename(b009Animation.FILES.lock);
  const makeLock = pid => ({ pid, runId: b009Animation.RUN_ID, beatId: b009Animation.BEAT_ID,
    operation: 'RECOVER_EXISTING_PROVIDER_OUTPUT', requestKey: b009Animation.ANIMATION_REQUEST_KEY,
    createdAt: '2026-10-06T12:00:00.000Z' });
  const cases = [
    ['live runner lock', ({ beatDir }) => fs.writeFileSync(path.join(beatDir, lockName), JSON.stringify(makeLock(process.pid))),
      () => {}, /RECOVERY_LOCK_ACTIVE/],
    ['stale lock', ({ beatDir }) => fs.writeFileSync(path.join(beatDir, lockName), JSON.stringify(makeLock(987654321))),
      () => { throw Object.assign(new Error('stale'), { code: 'ESRCH' }); }, /RECOVERY_STALE_LOCK/],
    ['inaccessible PID', ({ beatDir }) => fs.writeFileSync(path.join(beatDir, lockName), JSON.stringify(makeLock(12345))),
      () => { throw Object.assign(new Error('inaccessible'), { code: 'EPERM' }); }, /RECOVERY_LOCK_ACTIVE/],
      ['malformed lock', ({ beatDir }) => fs.writeFileSync(path.join(beatDir, lockName), JSON.stringify({ pid: 'bad' })),
      () => assert.fail('malformed lock must not be probed'), /RECOVERY_LOCK_INVALID/],
  ];
  for (const [label, writeLock, pidProbe, expected] of cases) {
    const f = makeRecoveryFixture(writeLock, pidProbe);
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    assert.throws(() => f.workflow.recoverExistingProviderOutput(), expected, label);
    assert.equal(f.providerCalls(), 0); assert.equal(f.ffmpegCalls(), 0);
    assert.equal(fs.readFileSync(f.ledgerPath).equals(f.ledgerBytes), true);
    assert.equal(fs.existsSync(path.join(f.beatDir, path.basename(b009Animation.FILES.derivative))), false);
  }
});

test('B009 historical authorization uses its recorded runtime hashes while recovery runtime bindings stay current', () => {
  const historical = b009Animation.RECOVERY.historicalAuthorizationRuntimeHashes;
  assert.deepEqual(b009Animation.historicalAuthorizationRuntimeHashes({ bindings: { ...historical } }), historical);
  assert.throws(() => b009Animation.historicalAuthorizationRuntimeHashes({
    bindings: { ...historical, cliSha256: 'f'.repeat(64) },
  }), /HISTORICAL_RUNTIME_BINDING_MISMATCH/);
  const current = { animationWorkflowSha256: 'd'.repeat(64),
    executionModuleSha256: b009Animation.RECOVERY.currentExecutionModuleSha256,
    cliSha256: b009Animation.RECOVERY.currentCliSha256 };
  assert.equal(b009Animation.verifyRecoveryRuntimeBindings(current, current.animationWorkflowSha256), true);
  assert.throws(() => b009Animation.verifyRecoveryRuntimeBindings({ ...current, cliSha256: 'e'.repeat(64) }),
    /RECOVERY_RUNTIME_BINDING_MISMATCH/);
  assert.throws(() => b009Animation.verifyRecoveryRuntimeBindings(current, 'f'.repeat(64)),
    /RECOVERY_WORKFLOW_SYNC_MISMATCH/);
});

test('B009 offline recovery rejects altered raw, ledger, failure receipts, extras and VFR without writes or provider access', t => {
  const makeState = alter => {
    const root = tempRoot(), reviewRoot = path.join(root, '.review'), beatDir = path.join(reviewRoot,
      b009Animation.RUN_ID, b009Animation.BEAT_ID);
    fs.mkdirSync(beatDir, { recursive: true });
    for (const key of ['authorization', 'ledger', 'output', 'receipt', 'result'])
      fs.writeFileSync(path.join(beatDir, path.basename(b009SourceStill.FILES[key])), `source-${key}`);
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'phase3-b009-unused-animation-auth-v1.json'),
      path.join(beatDir, path.basename(b009Animation.LEGACY_AUTHORIZATION.path)));
    const requestRecord = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
      'phase3-media-execution-calibration-route-bundle-20261004.v1.json'), 'utf8')).calibrationRequests
      .find(item => item.beatId === b009Animation.BEAT_ID && item.operation === b009Animation.OPERATION);
    const request = { ...requestRecord, parameters: { ...calibrationRoutes.H3_MAX } };
    const runtimeHashes = b009Animation.RECOVERY.historicalAuthorizationRuntimeHashes;
    const auth = b009Animation.makeAuthorizationTemplate({ requestKey: b009Animation.ANIMATION_REQUEST_KEY,
      runtimeHashes, authorizedAt: '2026-10-06T09:00:00.000Z' });
    const authBytes = Buffer.from(`${JSON.stringify(auth, null, 2)}\n`);
    fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.FILES.authorization)), authBytes);
    const raw = Buffer.from('recovery fixture');
    const rawPath = path.join(beatDir, path.basename(b009Animation.FILES.raw)); fs.writeFileSync(rawPath, raw);
    const ledgerPath = path.join(beatDir, path.basename(b009Animation.FILES.ledger));
    b009Animation.appendLedger(ledgerPath, { recordType: 'SUBMISSION_RESERVED', sequence: 1,
      runId: b009Animation.RUN_ID, beatId: b009Animation.BEAT_ID, operation: b009Animation.OPERATION,
      endpoint: b009Animation.ENDPOINT, requestKey: b009Animation.ANIMATION_REQUEST_KEY,
      authorizationSha256: sha(authBytes), sourceStillSha256: b009Animation.SOURCE_STILL_SHA256,
      sourceStillApprovalSha256: b009Animation.SOURCE_STILL_APPROVAL_SHA256,
      stagedIndexSha256: b009Animation.PACKAGE.stagedIndexSha256, retriesAllowed: false,
      fallbackAllowed: false, reservedAt: b009Animation.RECOVERY.expectedReservationAt }, fs);
    const ledgerSha256 = sha(fs.readFileSync(ledgerPath));
    const failure = { schemaVersion: b009Animation.FAILURE_SCHEMA, status: 'FAILED', runId: b009Animation.RUN_ID,
      beatId: b009Animation.BEAT_ID, operation: b009Animation.OPERATION,
      requestKey: b009Animation.ANIMATION_REQUEST_KEY, failureStage: 'AFTER_RESERVATION', reservationCount: 1,
      providerRequestCount: 1, ledgerSha256, errorCode: 'PHASE3_B009_ANIMATION_RAW_VIDEO_NOT_FRAME_ALIGNED',
      recordedAt: b009Animation.RECOVERY.expectedFailureAt, retryAllowed: false, fallbackAllowed: false,
      assetClass: b009Animation.ASSET_CLASS };
    const failureBytes = Buffer.from(`${JSON.stringify(failure, null, 2)}\n`);
    fs.writeFileSync(path.join(beatDir, path.basename(b009Animation.FILES.failure)), failureBytes);
    const recoveryBindings = { authorizationSha256: sha(authBytes), rawBytes: raw.length, rawSha256: sha(raw),
      ledgerSha256, failureSha256: sha(failureBytes), expectedReservationAt: b009Animation.RECOVERY.expectedReservationAt,
      expectedFailureAt: failure.recordedAt };
    const result = alter?.({ root, beatDir, rawPath, ledgerPath, recoveryBindings, failurePath: path.join(beatDir,
      path.basename(b009Animation.FILES.failure)) }) || {};
    const sourceStillWorkflow = { assertBindings: () => ({ staged: { calibrationRoutePlan: { requests: [request] } } }) };
    let providerCalls = 0, ffmpegCalls = 0;
    const rawMetadata = { container: 'mov,mp4,m4a,3gp,3g2,mj2', durationSeconds: 5.184,
      videoStreamCount: 1, audioStreamCount: 1, video: { codec: 'h264', width: 1344, height: 768,
        fps: 24, avgFps: 24, rFps: 24, frameCount: 124 } };
    const workflow = b009Animation.createB009AnimationWorkflow({ sourceStillWorkflow, reviewRoot,
      episodeRoot: path.join(root, 'episode'), approvalPath: b009Animation.SOURCE_STILL_APPROVAL_PATH,
      testHooks: { recoveryBindings },
      provider: { generateAnimation: () => { providerCalls++; } }, downloader: () => { providerCalls++; },
      ffprobe: () => result.vfr ? { ...rawMetadata, video: { ...rawMetadata.video, fps: 23, avgFps: 23, rFps: 23 } } : rawMetadata,
      ffprobeFrames: () => Array.from({ length: 124 }, (_, index) => index / 24),
      ffmpeg: () => { ffmpegCalls++; return { status: 1 }; } });
    return { root, beatDir, workflow, providerCalls: () => providerCalls, ffmpegCalls: () => ffmpegCalls, result };
  };
  const cases = [
    ['altered raw', ({ rawPath }) => fs.appendFileSync(rawPath, 'x')],
    ['altered ledger', ({ ledgerPath }) => fs.appendFileSync(ledgerPath, 'altered\n')],
    ['altered failure receipt', ({ failurePath }) => fs.appendFileSync(failurePath, 'x')],
    ['unknown file', ({ beatDir }) => fs.writeFileSync(path.join(beatDir, 'unknown.tmp'), 'x')],
  ];
  for (const [label, alter] of cases) {
    const f = makeState(alter); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    assert.throws(() => f.workflow.recoverExistingProviderOutput(), /RECOVERY_(?:RAW_BINDING_INVALID|LEDGER_MISMATCH|FAILURE_RECEIPT_MISMATCH|FILE_SET_INVALID)/,
      label);
    assert.equal(f.providerCalls(), 0); assert.equal(f.ffmpegCalls(), 0);
    assert.equal(fs.existsSync(path.join(f.beatDir, path.basename(b009Animation.FILES.lock))), false);
  }
  const vfr = makeState(({ recoveryBindings }) => { recoveryBindings.rawFps = 23; return { vfr: true }; });
  t.after(() => fs.rmSync(vfr.root, { recursive: true, force: true }));
  assert.throws(() => vfr.workflow.recoverExistingProviderOutput(), /RECOVERY_(?:RAW_BINDING_INVALID|RAW_NOT_VERIFIED_CFR_24)/);
  assert.equal(vfr.providerCalls(), 0); assert.equal(vfr.ffmpegCalls(), 0);
});

test('B009 recovery command remains exact-run scoped and does not accept generation or arbitrary arguments', () => {
  const command = ['--recover-calibration-animation', '--phase3-run-id', b009Animation.RUN_ID,
    '--beat-id', b009Animation.BEAT_ID];
  assert.equal(mediaExecutionCli.parseArgs(command).mode, 'recover-calibration-animation');
  assert.throws(() => mediaExecutionCli.parseArgs(['--recover-calibration-animation', '--phase3-run-id',
    'phase3-media-execution-v5-other', '--beat-id', b009Animation.BEAT_ID]), /PHASE3_CALIBRATION_RUN_FORBIDDEN/);
  assert.throws(() => mediaExecutionCli.parseArgs(['--recover-calibration-animation', '--phase3-run-id',
    b009Animation.RUN_ID, '--beat-id', 'ACT1_B006']), /PHASE3_CALIBRATION_BEAT_FORBIDDEN/);
  assert.throws(() => mediaExecutionCli.parseArgs([...command, '--unexpected', 'value']), /PHASE3_MEDIA_EXECUTION_USAGE/);
});

test('ACT1_B009 detached calibration approval, finalization and consolidated verdict are immutable and production-rejected', () => {
  const packageRoot = path.join(WELLS, 'phase3-production-batch-planning-20261006-v1');
  const approvalPath = path.join(WELLS, 'phase3-act1-b009-animation-human-validation-approval-20261006.v1.json');
  const finalizationPath = path.join(packageRoot, 'calibration-finalization.v1.json');
  const verdictPath = path.join(packageRoot, 'consolidated-calibration-verdict.v1.json');
  assert.equal(sha(fs.readFileSync(approvalPath)), '78d7307c739050096aab2f8d723897b651151f93395323677ee3332c91d3f327');
  assert.equal(sha(fs.readFileSync(finalizationPath)), 'b426f68ce487a88c1a0bb783542b330ed6f7b3d0068e3d704a077f0a811b5c9c');
  assert.equal(sha(fs.readFileSync(verdictPath)), '10cb46db5340754e737a8e4ebdd05679a380f51bef9c0e9c3b9b8944b939423b');
  const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
  const finalization = JSON.parse(fs.readFileSync(finalizationPath, 'utf8'));
  const verdict = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
  for (const [record, field] of [[approval, 'approvalBindingSha256'], [finalization, 'finalizationBindingSha256'],
    [verdict, 'verdictBindingSha256']]) {
    const body = { ...record }; const binding = body[field]; delete body[field];
    assert.equal(binding, calibrationClosure.hashObject(body));
  }
  assert.equal(approval.status, 'APPROVED_FOR_CALIBRATION_VALIDATION_ONLY');
  assert.equal(approval.bindings.successReceiptSha256, calibrationClosure.EVIDENCE['animation-generation-receipt.v1.json'].sha256);
  assert.equal(approval.bindings.terminalResultSha256, calibrationClosure.EVIDENCE['animation-generation-result.v1.json'].sha256);
  assert.equal(approval.bindings.finalAnimationLedgerSha256, calibrationClosure.EVIDENCE['animation-request-ledger.jsonl'].sha256);
  assert.equal(approval.classification.assetClass, 'NON_PRODUCTION_DISPOSABLE_CALIBRATION');
  assert.equal(approval.classification.productionReadiness, 'REJECTED');
  assert.equal(approval.restrictions.productionExecutionAuthorized, false);
  assert.equal(finalization.effects.providerRequests, 0);
  assert.equal(finalization.effects.productionPathWrites, 0);
  assert.equal(verdict.status, 'CALIBRATION_LANE_CLOSED');
  assert.deepEqual(verdict.verdicts.map(item => [item.asset, item.calibration]), [
    ['ACT1_B006_STILL', 'APPROVED'], ['ACT1_B009_SOURCE_STILL', 'APPROVED'],
    ['ACT1_B009_ANIMATION', 'APPROVED'], ['ACT1_B005', 'DEFERRED'],
  ]);
  assert.equal(verdict.verdicts.every(item => item.production === 'REJECTED'
    && item.assetClass === 'NON_PRODUCTION_DISPOSABLE_CALIBRATION'), true);
});

test('production-batch planning package has exact 34/8/23/23 jobs, unique request keys, review gates and no execution authority', () => {
  const packageRoot = path.join(WELLS, 'phase3-production-batch-planning-20261006-v1');
  const indexPath = path.join(packageRoot, 'package-index.v1.json');
  assert.equal(sha(fs.readFileSync(indexPath)), '9f60d89fc3009542b804e8fe1dd8c10af6a2d9f16554c85024e1cdad223e29de');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const indexBody = { ...index }; delete indexBody.indexBindingSha256;
  assert.equal(index.indexBindingSha256, calibrationClosure.hashObject(indexBody));
  for (const item of index.files) {
    const bytes = fs.readFileSync(path.join(packageRoot, item.path));
    assert.equal(bytes.length, item.bytes, item.path);
    assert.equal(sha(bytes), item.sha256, item.path);
  }
  assert.equal(index.status, 'PRODUCTION_BATCH_READY_EXECUTION_UNAUTHORIZED');
  assert.deepEqual(index.counts, { controlledStills: 34, generatedStills: 8, animationClips: 23,
    intermediateAnimationSourceStills: 23, finalOutputs: 65, totalPlannedAssetsIncludingIntermediates: 88,
    externalProviderSubmissions: 54 });
  assert.equal(index.productionExecutionAuthorization, null);
  const plan = JSON.parse(fs.readFileSync(path.join(packageRoot, 'production-batch-plan.v1.json'), 'utf8'));
  const jobs = [...plan.controlledStills, ...plan.generatedStills, ...plan.animationSourceStills, ...plan.animationClips];
  assert.equal(jobs.length, 88);
  assert.equal(new Set(jobs.map(job => job.requestKey)).size, 88);
  assert.equal(jobs.every(job => /^[a-f0-9]{64}$/u.test(job.requestKey)
    && /^[a-f0-9]{64}$/u.test(job.promptSha256)
    && /^[a-f0-9]{64}$/u.test(job.negativePromptSha256)
    && job.executionAuthorized === false), true);
  assert.equal(plan.authority.productionExecutionAuthorization, null);
  assert.equal(plan.authority.providerRequestsAuthorized, 0);
  const gates = JSON.parse(fs.readFileSync(path.join(packageRoot, 'review-gates-and-retry-policy.v1.json'), 'utf8'));
  assert.equal(gates.retryPolicy.automaticRetries, 0);
  assert.deepEqual(gates.retryPolicy.fallbackModels, []);
  const cost = JSON.parse(fs.readFileSync(path.join(packageRoot, 'cost-and-exposure.v1.json'), 'utf8'));
  assert.equal(cost.estimateUsd.promotionalTotal, 9.944);
  assert.equal(cost.estimateUsd.regularTotal, 10.688);
  assert.equal(cost.proposedHumanExposureCeilingUsd, 12);
  assert.equal(cost.ceilingStatus, 'PROPOSED_NOT_APPROVED');
});

function productionBatchFixture(overrides = {}) {
  const root = tempRoot(), episodeRoot = path.join(root, 'episode');
  fs.mkdirSync(path.join(episodeRoot, '.review'), { recursive: true });
  const workRoot = overrides.workRoot || path.join(episodeRoot, '.review', 'phase3-production-batch-v1');
  const packageDirectory = path.join(WELLS, 'phase3-production-batch-planning-20261006-v1');
  const candidatePackageDirectory = path.join(WELLS, 'phase3-consolidated-act5-production-candidate-20261004-v5');
  const stillBytes = fs.readFileSync(PILOT02_STILL_FIXTURE);
  let stillCalls = 0, animationCalls = 0;
  const provider = overrides.provider || {
    async generateStill() { stillCalls++; return { url: 'https://fal.media/production-still.png',
      providerRequestId: `still-${stillCalls}`, actualChargeUsd: 0.048, metadata: {} }; },
    async generateAnimation() { animationCalls++; return { url: 'https://fal.media/production-animation.mp4',
      providerRequestId: `animation-${animationCalls}`, actualChargeUsd: 0.4, metadata: {} }; },
  };
  const ffprobe = file => file.includes('raw-provider-output')
    ? { container: 'mov,mp4,m4a,3gp,3g2,mj2', durationSec: 5, videoStreams: 1, audioStreams: 1,
      video: { codec: 'h264', width: 1344, height: 768, fps: 24, frames: 120 } }
    : { container: 'mov,mp4,m4a,3gp,3g2,mj2', durationSec: 3.8, videoStreams: 1, audioStreams: 0,
      video: { codec: 'h264', width: 1344, height: 768, fps: 30, frames: 114 } };
  const workflow = productionBatch.createProductionBatchWorkflow({ packageDirectory,
    candidatePackageDirectory, artifactRoot: WELLS, episodeRoot, workRoot,
    verifyStage04Fn: () => ({ record: { status: 'PROMOTED' },
      recordSha256: mediaExecution.STAGE04_ACTIVATION_SHA256, promotedPathCount: 147,
      requestLedgerSha256: mediaExecution.REQUEST_LEDGER_SHA256 }),
    provider, downloader: overrides.downloader || (async url => ({ bytes: url.endsWith('.mp4')
      ? Buffer.from('raw-production-animation') : stillBytes, contentType: url.endsWith('.mp4')
        ? 'video/mp4' : 'image/png' })), ffprobe,
    ffmpeg: (_command, args) => { fs.writeFileSync(args.at(-1), Buffer.from('fitted-production-animation'));
      return { status: 0 }; }, now: () => '2026-10-06T23:30:00.000Z',
    pidProbe: overrides.pidProbe || process.kill.bind(process), testHooks: overrides.testHooks || {} });
  const authorization = workflow.makeAuthorizationTemplate({ requestKeys: [...productionBatch.FIRST_BATCH_KEYS],
    authorizedAt: '2026-10-06T23:20:00.000Z' });
  const authorizationFile = path.join(root, 'first-batch-authorization.json');
  fs.writeFileSync(authorizationFile, `${JSON.stringify(authorization, null, 2)}\n`);
  return { root, episodeRoot, workRoot, workflow, authorizationFile,
    authorizationSha256: sha(fs.readFileSync(authorizationFile)), stillCalls: () => stillCalls,
    animationCalls: () => animationCalls, stillBytes };
}

function approveProductionOutput(f, requestKey) {
  const inspection = f.workflow.inspect({ requestKey });
  const inspectionFile = path.join(f.workRoot, 'requests', requestKey, 'inspection.json');
  const decision = { schemaVersion: productionBatch.DECISION_SCHEMA, status: 'APPROVED',
    reviewedBy: 'Yakubu Moshood', requestKey, outputSha256: inspection.output.sha256,
    inspectionSha256: sha(fs.readFileSync(inspectionFile)), reviewedAt: '2026-10-06T23:40:00.000Z' };
  const decisionFile = path.join(f.root, `${requestKey}-approval.json`);
  fs.writeFileSync(decisionFile, `${JSON.stringify(decision, null, 2)}\n`);
  return f.workflow.approve({ requestKey, decisionFile,
    expectedDecisionSha256: sha(fs.readFileSync(decisionFile)) });
}

test('production batch preflight verifies closure, package, candidate, Stage04 and selects the dependency-complete first batch without writes', () => {
  const f = productionBatchFixture();
  const before = fs.existsSync(f.workRoot);
  const result = f.workflow.preflight({ firstBatchOnly: true });
  assert.equal(before, false);
  assert.equal(fs.existsSync(f.workRoot), false);
  assert.equal(result.status, 'PRODUCTION_FIRST_BATCH_READY_EXECUTION_UNAUTHORIZED');
  assert.deepEqual(result.firstBatch.beatIds, ['ACT1_B006', 'ACT1_B009']);
  assert.deepEqual(result.selectedRequestKeys, [...productionBatch.FIRST_BATCH_KEYS]);
  assert.deepEqual(result.firstBatch.requestCounts,
    { generatedStills: 1, animationSourceStills: 1, animationClips: 1, total: 3 });
  assert.equal(result.firstBatch.expectedCostUsd, 0.496);
  assert.equal(result.firstBatch.maximumExposureUsd, 0.5);
  assert.equal(result.providerRequestsAuthorized, 0);
  assert.match(result.exactAuthorizationStatement, /ACT1_B006 generated still request key 8601e214/u);
  assert.match(result.exactAuthorizationStatement, /only after that source still is inspected and approved/u);
});

test('production executor reserves before one FLUX submission, validates output and prevents duplicate key use', async () => {
  const f = productionBatchFixture();
  const requestKey = productionBatch.FIRST_BATCH_KEYS[0];
  const result = await f.workflow.generate({ requestKey, authorizationFile: f.authorizationFile,
    expectedAuthorizationSha256: f.authorizationSha256 });
  assert.equal(result.status, 'GENERATED_PENDING_INSPECTION');
  assert.equal(result.output.width, 1360);
  assert.equal(result.output.height, 768);
  assert.equal(f.stillCalls(), 1);
  const ledger = productionBatch.readLedger(f.workRoot);
  assert.deepEqual(ledger.map(row => row.recordType), ['SUBMISSION_RESERVED', 'SUBMISSION_RESULT']);
  assert.equal(ledger[0].requestKey, requestKey);
  assert.equal(ledger[1].status, 'SUCCEEDED_PENDING_INSPECTION');
  await assert.rejects(() => f.workflow.generate({ requestKey, authorizationFile: f.authorizationFile,
    expectedAuthorizationSha256: f.authorizationSha256 }), /PHASE3_PRODUCTION_REQUEST_KEY_ALREADY_CONSUMED/);
  assert.equal(f.stillCalls(), 1);
  assert.equal(approveProductionOutput(f, requestKey).status, 'APPROVED');
});

test('production animation enforces approved source, preserves raw output and creates exact silent fitted derivative', async () => {
  const f = productionBatchFixture(), sourceKey = productionBatch.FIRST_BATCH_KEYS[1];
  const animationKey = productionBatch.FIRST_BATCH_KEYS[2];
  await assert.rejects(() => f.workflow.generate({ requestKey: animationKey,
    authorizationFile: f.authorizationFile, expectedAuthorizationSha256: f.authorizationSha256 }),
  /PHASE3_PRODUCTION_APPROVED_SOURCE_REQUIRED/);
  assert.equal(f.animationCalls(), 0);
  await f.workflow.generate({ requestKey: sourceKey, authorizationFile: f.authorizationFile,
    expectedAuthorizationSha256: f.authorizationSha256 });
  approveProductionOutput(f, sourceKey);
  const animation = await f.workflow.generate({ requestKey: animationKey,
    authorizationFile: f.authorizationFile, expectedAuthorizationSha256: f.authorizationSha256 });
  assert.equal(animation.status, 'GENERATED_PENDING_INSPECTION');
  assert.equal(animation.output.video.frames, 114);
  assert.equal(animation.output.audioStreams, 0);
  assert.equal(f.animationCalls(), 1);
  const dir = path.join(f.workRoot, 'requests', animationKey);
  assert.equal(fs.readFileSync(path.join(dir, 'raw-provider-output.mp4'), 'utf8'), 'raw-production-animation');
  assert.equal(fs.readFileSync(path.join(dir, 'fitted-output.mp4'), 'utf8'), 'fitted-production-animation');
  fs.appendFileSync(path.join(dir, 'raw-provider-output.mp4'), '-tampered');
  assert.throws(() => f.workflow.inspect({ requestKey: animationKey }),
    /PHASE3_PRODUCTION_RECEIPT_OUTPUT_MISMATCH/);
});

test('malformed provider output consumes the request key with no retry or fallback', async () => {
  const f = productionBatchFixture({ downloader: async () => ({ bytes: pilotPng(1280, 720), contentType: 'image/png' }) });
  const requestKey = productionBatch.FIRST_BATCH_KEYS[0];
  await assert.rejects(() => f.workflow.generate({ requestKey, authorizationFile: f.authorizationFile,
    expectedAuthorizationSha256: f.authorizationSha256 }), /PHASE3_PRODUCTION_PNG_CONTRACT_INVALID/);
  assert.equal(f.stillCalls(), 1);
  const ledger = productionBatch.readLedger(f.workRoot);
  assert.equal(ledger.at(-1).status, 'FAILED_REQUEST_KEY_CONSUMED');
  await assert.rejects(() => f.workflow.generate({ requestKey, authorizationFile: f.authorizationFile,
    expectedAuthorizationSha256: f.authorizationSha256 }), /PHASE3_PRODUCTION_REQUEST_KEY_ALREADY_CONSUMED/);
  assert.equal(f.stillCalls(), 1);
});

test('recovery terminalizes an interrupted reservation without another provider submission', async () => {
  const f = productionBatchFixture(), requestKey = productionBatch.FIRST_BATCH_KEYS[0];
  productionBatch.appendLedger(f.workRoot, { recordType: 'SUBMISSION_RESERVED', requestKey,
    beatId: 'ACT1_B006', requestType: 'GENERATED_STILL', routeId: 'FLUX3_STILL_1K_16X9',
    externalProviderRequest: true, maximumCostUsd: 0.048, authorizationSha256: f.authorizationSha256,
    retriesAllowed: 0, fallbackAllowed: false, reservedAt: '2026-10-06T23:30:00.000Z' });
  const result = await f.workflow.recover({ requestKey });
  assert.equal(result.status, 'INTERRUPTED_UNKNOWN_PROVIDER_RESULT_REQUEST_KEY_CONSUMED');
  assert.equal(result.providerSubmissionsDuringRecovery, 0);
  assert.equal(f.stillCalls(), 0);
  assert.equal(productionBatch.readLedger(f.workRoot).at(-1).recordType, 'SUBMISSION_RESULT');
});

test('recovery resumes a durably recorded provider response after stale lock and temp cleanup without resubmission', async () => {
  const missingPid = () => { const error = new Error('missing'); error.code = 'ESRCH'; throw error; };
  const f = productionBatchFixture({ pidProbe: missingPid }), requestKey = productionBatch.FIRST_BATCH_KEYS[0];
  productionBatch.appendLedger(f.workRoot, { recordType: 'SUBMISSION_RESERVED', requestKey,
    beatId: 'ACT1_B006', requestType: 'GENERATED_STILL', routeId: 'FLUX3_STILL_1K_16X9',
    externalProviderRequest: true, maximumCostUsd: 0.048, authorizationSha256: f.authorizationSha256,
    retriesAllowed: 0, fallbackAllowed: false, reservedAt: '2026-10-06T23:30:00.000Z' });
  const dir = path.join(f.workRoot, 'requests', requestKey); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'provider-response.json'), JSON.stringify({
    url: 'https://fal.media/production-still.png', providerRequestId: 'already-submitted',
    actualChargeUsd: 0.048, metadata: {} }));
  fs.writeFileSync(path.join(dir, 'operation.lock'), '99999\n');
  fs.writeFileSync(path.join(dir, 'output.png.tmp-0123456789abcdef'), 'partial');
  const result = await f.workflow.recover({ requestKey });
  assert.equal(result.status, 'RECOVERED_PENDING_INSPECTION');
  assert.equal(result.providerSubmissionsDuringRecovery, 0);
  assert.equal(f.stillCalls(), 0);
  assert.equal(fs.existsSync(path.join(dir, 'operation.lock')), false);
  assert.equal(fs.existsSync(path.join(dir, 'output.png.tmp-0123456789abcdef')), false);
  assert.equal(productionBatch.readLedger(f.workRoot).at(-1).status, 'SUCCEEDED_PENDING_INSPECTION');
});

test('production authorization and aggregate ledger enforce cost ceilings', async () => {
  const f = productionBatchFixture();
  assert.throws(() => f.workflow.makeAuthorizationTemplate({ requestKeys: [productionBatch.FIRST_BATCH_KEYS[0]],
    authorizedAt: '2026-10-06T23:20:00.000Z', maximumExposureUsd: 12.01 }),
  /PHASE3_PRODUCTION_AUTHORIZATION_EXPOSURE_INVALID/);
  const tooLow = f.workflow.makeAuthorizationTemplate({ requestKeys: [productionBatch.FIRST_BATCH_KEYS[2]],
    authorizedAt: '2026-10-06T23:20:00.000Z', maximumExposureUsd: 0.39 });
  const file = path.join(f.root, 'too-low.json'); fs.writeFileSync(file, `${JSON.stringify(tooLow, null, 2)}\n`);
  await assert.rejects(() => f.workflow.generate({ requestKey: productionBatch.FIRST_BATCH_KEYS[2],
    authorizationFile: file, expectedAuthorizationSha256: sha(fs.readFileSync(file)) }),
  /PHASE3_PRODUCTION_AUTHORIZATION_COST_CEILING_INVALID/);
  assert.equal(f.animationCalls(), 0);
});

test('production workflow rejects unknown isolated files, forbidden roots and unresolved ACT1_B005', () => {
  const f = productionBatchFixture();
  fs.mkdirSync(f.workRoot, { recursive: true }); fs.writeFileSync(path.join(f.workRoot, 'unknown.bin'), 'x');
  assert.throws(() => f.workflow.preflight({ firstBatchOnly: true }), /PHASE3_PRODUCTION_UNKNOWN_FILE/);
  const outside = productionBatchFixture({ workRoot: path.join(tempRoot(), 'outside-review') });
  assert.throws(() => outside.workflow.preflight(), /PHASE3_PRODUCTION_WORK_ROOT_FORBIDDEN/);
  const clean = productionBatchFixture();
  const planning = productionBatch.verifyPlanningPackage({ packageDirectory: path.join(WELLS,
    'phase3-production-batch-planning-20261006-v1') });
  const b005 = productionBatch.buildJobs(planning.plan).find(job => job.beatId === 'ACT1_B005');
  assert.throws(() => clean.workflow.ingestControlled({ requestKey: b005.requestKey,
    inputFile: PILOT02_STILL_FIXTURE, authorizationFile: clean.authorizationFile,
    expectedAuthorizationSha256: clean.authorizationSha256 }),
  /PHASE3_PRODUCTION_ACT1_B005_DEFERRED_CONTRACT_UNRESOLVED/);
});

test('production batch CLI exposes only status, preflight, generation, inspection, decisions and recovery', () => {
  assert.equal(productionBatchCli.parseArgs(['--status']).mode, 'status');
  assert.deepEqual(productionBatchCli.parseArgs(['--preflight', '--first-batch']),
    { mode: 'preflight', firstBatchOnly: true });
  assert.equal(productionBatchCli.parseArgs(['--recover', '--request-key', productionBatch.FIRST_BATCH_KEYS[0]]).mode,
    'recover');
  assert.throws(() => productionBatchCli.parseArgs(['--create-authorization']), /PHASE3_PRODUCTION_BATCH_USAGE/);
  assert.doesNotMatch(productionBatchCli.help(), /promote|render/u);
});
