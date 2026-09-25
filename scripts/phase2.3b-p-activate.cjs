'use strict';

// Phase 2.3B-P activation. Candidate construction is review-only; promotion is
// a separately requested operation and uses a full-directory atomic exchange.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const spec = require('./phase2.3b-p-run.cjs').SPEC;
const activation = require('../pipeline-updates/episode-activation.cjs');
const APPROVAL_PATH = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo', 'phase2.3b-p-review', 'activation-approval.v1.json');
const approval = JSON.parse(fs.readFileSync(APPROVAL_PATH, 'utf8'));
const ROOT = spec.episodeDirectory;
const CANDIDATE_PACKAGE = process.env.EO_P_CANDIDATE_PACKAGE || path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo', 'phase2.3b-sv-candidate');
const GLOBAL_LOCK_PATH = path.join(ROOT, '.review', 'phase2.3b-p-activation-active.lock');
const GLOBAL_STATE_PATH = path.join(ROOT, '.review', 'phase2.3b-p-activation-state.json');
const GLOBAL_LEDGER_PATH = path.join(ROOT, '.review', 'phase2.3b-p-activation-request-ledger.jsonl');
const RUNTIME_SYNC_FILES = [
  'episode-activation.cjs', 'vo-timing.cjs', 'edit-plan-validator.cjs', 'edit-plan.schema.json',
  'shot-definitions-validator.cjs', 'shot-definitions-production-contract.cjs', 'revision-lineage.cjs',
  'production-method-manifest.cjs', 'evidence-source-validator.cjs', 'proof-section-planner.cjs', 'act-voice-generator.cjs',
];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
const ACT_ORDER = spec.actOrder;
const VO_BINDINGS = Object.fromEntries(ACT_ORDER.map(key => [key, spec.voFilenames[key].replace(/\.mp3$/iu, '')]));
const CANDIDATE_FILES = {
  script: 'candidate-script.json', plan: 'candidate-edit-plan-pretiming.json',
  shots: 'candidate-shot-definitions-pretiming.json', manifest: 'candidate-production-manifest-pretiming.json',
  history: 'revision-ledger.phase2.2d-lineage.v1.json', amendment: 'revision-ledger.phase2.3b-sv-amendment.v1.json',
  sourceManifest: 'source-hash-manifest.json', narration: 'narration-texts.json',
};
const sha = activation.sha256;
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const atomicJson = (file, value) => activation.atomicWrite(fs, file, jsonBytes(value));
function writeImmutableJson(fsImpl, file, value) {
  const bytes = jsonBytes(value);
  if (fsImpl.existsSync(file)) {
    assert(sha(fsImpl.readFileSync(file)) === sha(bytes), `IMMUTABLE_REVIEW_ARTIFACT_CONFLICT:${path.basename(file)}`);
    return sha(bytes);
  }
  fsImpl.writeFileSync(file, bytes, { flag: 'wx' });
  return sha(bytes);
}
function assert(value, code) { if (!value) throw new Error(code); }
function hashFile(file) { return sha(fs.readFileSync(file)); }
function reviewPath(runId) { return path.join(ROOT, '.review', `phase2.3b-p-activation-${runId}`); }
function approvedAudioPath(runId, filename) { return path.join(ROOT, '.review', `phase2.3b-p-narration-${runId}`, 'audio', filename); }
function ensureRailwayTarget(env = process.env) {
  const target = { RAILWAY_PROJECT_ID: '98a75a00-ce8e-4a7a-833e-ff76d3bdefea', RAILWAY_ENVIRONMENT_ID: '6fa50efc-d4bc-4ea1-9c6e-c9daa9336b34', RAILWAY_SERVICE_ID: 'd965705e-d5e7-4f4e-ac58-fc6b1959c81f' };
  for (const [key, value] of Object.entries(target)) if (env[key] !== value) throw new Error(`WRONG_OR_UNVERIFIED_RAILWAY_TARGET:${key}`);
  return target;
}
async function verifyApprovalAudio(runId, probe = file => require('/data/pipeline/act-voice-generator.cjs').probeMp3Default(file)) {
  assert(approval.approvalStatus === 'USER_APPROVED' && approval.userConfirmedListeningApproval === true, 'AUDIO_APPROVAL_MISSING');
  const actual = [];
  for (const contract of approval.approvedAudio) {
    const file = approvedAudioPath(approval.approvedRunId, contract.file);
    assert(fs.existsSync(file), `APPROVED_AUDIO_MISSING:${contract.file}`);
    const bytes = fs.readFileSync(file);
    assert(bytes.length === contract.bytes && sha(bytes) === contract.sha256, `APPROVED_AUDIO_HASH_MISMATCH:${contract.file}`);
    const media = await probe(file);
    assert(Number(media?.durationSec) > 0 && Math.abs(Number(media.durationSec) - contract.durationSec) <= 0.1, `APPROVED_AUDIO_DURATION_MISMATCH:${contract.file}`);
    actual.push({ actKey: contract.actKey, file: contract.file, sha256: sha(bytes), bytes: bytes.length, durationSec: Number(media.durationSec) });
  }
  assert(runId === undefined || SAFE_ID.test(runId), 'RUN_ID_INVALID');
  return actual;
}
function verifyPackage() {
  require('./phase2.3b-sg-stage-a.cjs').verifyCandidatePackage(CANDIDATE_PACKAGE);
  return true;
}
function verifyRuntimeSync({ appPipeline = path.join(__dirname, '..', 'pipeline-updates'), activePipeline = '/data/pipeline' } = {}) {
  const hashes = {};
  for (const name of RUNTIME_SYNC_FILES) {
    const source = path.join(appPipeline, name); const active = path.join(activePipeline, name);
    assert(fs.existsSync(source) && fs.existsSync(active), `PIPELINE_SYNC_FILE_MISSING:${name}`);
    const sourceHash = hashFile(source), activeHash = hashFile(active);
    assert(sourceHash === activeHash, `PIPELINE_SYNC_HASH_MISMATCH:${name}`);
    hashes[name] = sourceHash;
  }
  return hashes;
}
function verifyLockedEpisode() {
  return require('./phase2.3b-p-run.cjs').verifyLockedFiles({ episodeDirectory: ROOT, spec });
}
function verifyApprovedScript() {
  const current = readJson(path.join(ROOT, 'script.json'));
  const candidate = readJson(path.join(CANDIDATE_PACKAGE, CANDIDATE_FILES.script));
  activation.assertOnlyApprovedActTextChanges(current, candidate, ['act3b', 'act4']);
  return { current, candidate };
}
async function preflight({ runId, probeAudio, inspectActivity } = {}) {
  assert(SAFE_ID.test(runId || ''), 'RUN_ID_REQUIRED');
  assert(!fs.existsSync(GLOBAL_LOCK_PATH), 'ACTIVATION_GLOBAL_RUN_ALREADY_LOCKED');
  assert(!fs.existsSync(GLOBAL_STATE_PATH) && !fs.existsSync(GLOBAL_LEDGER_PATH), 'ACTIVATION_PRIOR_RUN_REQUIRES_REVIEW');
  ensureRailwayTarget(); verifyPackage();
  const runtimeSyncHashes = verifyRuntimeSync();
  const lockedHashes = verifyLockedEpisode();
  const scripts = verifyApprovedScript();
  const run = await require('./phase2.3b-p-run.cjs').verifyReviewOutputs({ episodeDirectory: ROOT, runId: approval.approvedRunId, fs, probeAudio });
  const pacingPlan = readJson(path.join(run.reviewDirectory, 'generation-plan.json'));
  assert(run.status === 'VERIFIED_SUCCESS' && run.providerRequestCount === pacingPlan.totalSegments && run.completedSegmentCount === pacingPlan.totalSegments, 'PACING_RUN_NOT_COMPLETE');
  assert(pacingPlan.planSha256 === approval.approvedPacingPlanSha256, 'PACING_PLAN_HASH_MISMATCH');
  assert(run.lockedHashes['script.json'] === approval.lockedEpisodeHashesBeforeActivation['script.json'], 'PACED_SOURCE_SCRIPT_CHANGED');
  assert(run.plannedCharacters <= require('./phase2.3b-p-run.cjs').SPEC.maximumCharacters, 'PACING_CHARACTER_CEILING');
  const approvedAudio = await verifyApprovalAudio(runId, probeAudio);
  const activity = await (inspectActivity
    ? inspectActivity()
    : require('./phase2.3b-p-run.cjs').inspectProductionActivity({ db: require('/app/db').db, episodeId: approval.episodeId, episodeDirectory: ROOT, fs }));
  const outDir = reviewPath(runId);
  assert(!fs.existsSync(path.join(outDir, 'preflight.json')), 'ACTIVATION_PREFLIGHT_ALREADY_EXISTS');
  fs.mkdirSync(outDir, { recursive: true });
  const totalSeconds = approvedAudio.reduce((sum, item) => sum + item.durationSec, 0);
  const whisperCostPerMinute = 0.006;
  const record = {
    schemaVersion: 'phase2.3b-p-activation-preflight/1.0.0', status: 'PREFLIGHT_PASS', runId,
    createdAt: new Date().toISOString(), railwayTarget: { ...ensureRailwayTarget(), environmentName: 'staging', serviceName: 'giving-success' }, episodeId: approval.episodeId,
    lockedHashes, pacingRun: { runId: approval.approvedRunId, planSha256: pacingPlan.planSha256, providerRequestCount: run.providerRequestCount, plannedCharacters: run.plannedCharacters, completedActs: ACT_ORDER },
    approvedAudio, candidateScriptSha256: sha(jsonBytes(scripts.candidate)), activity, runtimeSyncHashes,
    userApprovalArtifactSha256: hashFile(APPROVAL_PATH),
    costs: { paidRequestsMade: 0, whisperRequestsPlanned: 6, maximumWhisperAttempts: 18, expectedAudioSeconds: totalSeconds, expectedAudioMinutes: totalSeconds / 60, estimatedWhisperCostUsd: (totalSeconds / 60) * whisperCostPerMinute, conservativeMaximumAudioMinutes: (totalSeconds * 3) / 60, conservativeMaximumCostUsd: ((totalSeconds * 3) / 60) * whisperCostPerMinute, priceUsdPerMinute: whisperCostPerMinute, automaticRetriesPerAct: 2, ttsRequestsPlanned: 0, anthropicRequestsPlanned: 0, imageRequestsPlanned: 0, videoRequestsPlanned: 0, renderRequestsPlanned: 0 },
    outputs: { reviewDirectory: outDir, freshWhisperDirectory: path.join(outDir, 'fresh-whisper'), wordTimestamps: path.join(outDir, 'fresh-whisper', 'word-timestamps.json'), partialCheckpoint: path.join(outDir, 'fresh-whisper', 'word-timestamps.partial.json'), durableRequestLedger: GLOBAL_LEDGER_PATH, candidateDirectory: path.join(outDir, 'candidate') },
  };
  atomicJson(path.join(outDir, 'user-approval.json'), approval);
  atomicJson(path.join(outDir, 'preflight.json'), record);
  return record;
}
function requireCurrentPreflight(runId) {
  ensureRailwayTarget();
  const record = readJson(path.join(reviewPath(runId), 'preflight.json'));
  assert(record.status === 'PREFLIGHT_PASS' && record.runId === runId, 'ACTIVATION_PREFLIGHT_NOT_CURRENT');
  const hashes = verifyLockedEpisode();
  assert(JSON.stringify(hashes) === JSON.stringify(record.lockedHashes), 'ACTIVATION_LOCKED_HASHES_CHANGED');
  return record;
}

function expectedTimingAudioManifest({ fs: fsImpl = fs, runId, timingAudioDir = path.join(reviewPath(runId), 'fresh-whisper', 'audio'), contracts = approval.approvedAudio, approvedRunId = approval.approvedRunId, approvedPathFor = approvedAudioPath } = {}) {
  const manifest = [];
  for (const contract of contracts) {
    const approvedPath = approvedPathFor(approvedRunId, contract.file);
    const timingPath = path.join(timingAudioDir, contract.file);
    for (const [file, code] of [[approvedPath, 'APPROVED_AUDIO_HASH_MISMATCH'], [timingPath, 'TIMING_SOURCE_COPY_MISMATCH']]) {
      assert(fsImpl.existsSync(file), `TIMING_SOURCE_AUDIO_MISSING:${contract.file}`);
      const bytes = fsImpl.readFileSync(file);
      assert(bytes.length === contract.bytes && sha(bytes) === contract.sha256, `${code}:${contract.file}`);
    }
    manifest.push({ file: contract.file, bytes: contract.bytes, sha256: contract.sha256 });
  }
  return manifest;
}

function readAndVerifyCompletedTranscript({ fs: fsImpl = fs, runId, reviewDirectory = reviewPath(runId), actBindings = VO_BINDINGS, contracts = approval.approvedAudio, approvedRunId = approval.approvedRunId, approvedPathFor = approvedAudioPath } = {}) {
  const timingDir = path.join(reviewDirectory, 'fresh-whisper');
  const timestampsPath = path.join(timingDir, 'word-timestamps.json');
  const receiptPath = path.join(timingDir, 'timing-source-receipt.json');
  const partialPath = path.join(timingDir, 'word-timestamps.partial.json');
  assert(fsImpl.existsSync(timestampsPath), 'COMPLETED_TRANSCRIPT_MISSING');
  assert(fsImpl.existsSync(receiptPath), 'TIMING_SOURCE_RECEIPT_MISSING');
  const timestampsBytes = fsImpl.readFileSync(timestampsPath);
  const timestamps = JSON.parse(timestampsBytes.toString('utf8'));
  const receipt = JSON.parse(fsImpl.readFileSync(receiptPath, 'utf8'));
  const expectedAudio = expectedTimingAudioManifest({ fs: fsImpl, runId, timingAudioDir: path.join(timingDir, 'audio'), contracts, approvedRunId, approvedPathFor });
  const partial = fsImpl.existsSync(partialPath) ? JSON.parse(fsImpl.readFileSync(partialPath, 'utf8')) : null;
  const verification = activation.verifyCompletedTimingArtifacts({ timestamps, receipt, runId, expectedAudio, partial, actBindings });
  const receiptBytes = fsImpl.readFileSync(receiptPath);
  const partialBytes = partial === null ? null : fsImpl.readFileSync(partialPath);
  return { timestamps, receipt, partial, timestampsPath, receiptPath, partialPath, timestampFileSha256: sha(timestampsBytes), receiptFileSha256: sha(receiptBytes), partialFileSha256: partialBytes === null ? null : sha(partialBytes), verification, expectedAudio };
}

function assertNoActivationLocks({ fs: fsImpl = fs, runId } = {}) {
  const runLock = path.join(reviewPath(runId), 'activation.lock');
  assert(!fsImpl.existsSync(runLock), 'ACTIVATION_RUN_ALREADY_LOCKED');
  assert(!fsImpl.existsSync(GLOBAL_LOCK_PATH), 'ACTIVATION_GLOBAL_RUN_ALREADY_LOCKED');
  return true;
}

function diagnoseResume({ runId, fs: fsImpl = fs } = {}) {
  assert(SAFE_ID.test(runId || ''), 'RUN_ID_REQUIRED');
  ensureRailwayTarget();
  const preflight = requireCurrentPreflight(runId);
  verifyPackage(); verifyRuntimeSync(); assertNoActivationLocks({ fs: fsImpl, runId });
  const statusPath = path.join(reviewPath(runId), 'run-status.json');
  assert(fsImpl.existsSync(statusPath), 'FAILED_RUN_STATUS_MISSING');
  const priorStatus = JSON.parse(fsImpl.readFileSync(statusPath, 'utf8'));
  assert(priorStatus.runId === runId && priorStatus.state === 'FAILURE', 'RESUME_REQUIRES_FAILED_RUN');
  assert(JSON.stringify(priorStatus.completedActs) === JSON.stringify(ACT_ORDER), 'RESUME_TRANSCRIPTION_NOT_COMPLETE');
  assert(fsImpl.existsSync(GLOBAL_STATE_PATH), 'ACTIVATION_GLOBAL_STATE_MISSING');
  const globalState = JSON.parse(fsImpl.readFileSync(GLOBAL_STATE_PATH, 'utf8'));
  const audioFingerprint = sha(Buffer.from(JSON.stringify(approval.approvedAudio.map(({ actKey, file, sha256: digest, bytes }) => ({ actKey, file, sha256: digest, bytes })))));
  assert(globalState.runId === runId && globalState.audioFingerprint === audioFingerprint && globalState.state === 'FAILURE', 'ACTIVATION_GLOBAL_STATE_MISMATCH');
  assert(!fsImpl.existsSync(path.join(reviewPath(runId), 'candidate')), 'RESUME_CANDIDATE_ALREADY_EXISTS');
  const completed = readAndVerifyCompletedTranscript({ fs: fsImpl, runId });
  const alignment = activation.analyzeScriptTimestampAlignment(verifyApprovedScript().candidate, completed.timestamps, VO_BINDINGS);
  const ledgerPath = GLOBAL_LEDGER_PATH;
  assert(fsImpl.existsSync(ledgerPath), 'RESUME_REQUEST_LEDGER_MISSING');
  const ledgerSha256 = hashFile(ledgerPath);
  const originalAlignmentPath = path.join(reviewPath(runId), 'alignment-report.json');
  assert(fsImpl.existsSync(originalAlignmentPath), 'SOURCE_ALIGNMENT_REPORT_MISSING');
  const deterministicBytes = jsonBytes(alignment), deterministicSha256 = sha(deterministicBytes);
  const deterministicPath = path.join(reviewPath(runId), 'alignment-report.deterministic.v2.json');
  const deterministicReportSha256 = writeImmutableJson(fsImpl, deterministicPath, alignment);
  assert(deterministicReportSha256 === deterministicSha256, 'DETERMINISTIC_ALIGNMENT_REPORT_HASH_MISMATCH');
  const lockedHashes = verifyLockedEpisode();
  const bindings = {
    runId, episodeId: approval.episodeId, channelKey: approval.channelKey,
    candidateScriptSha256: preflight.candidateScriptSha256,
    approvedAudio: completed.expectedAudio.map(({ file, bytes, sha256: digest }) => ({ file, bytes, sha256: digest })),
    pacingPlanSha256: preflight.pacingRun.planSha256,
    transcriptSemanticSha256: completed.verification.wordTimestampsSha256,
    transcriptFileSha256: completed.timestampFileSha256,
    sourceReceiptSha256: completed.receiptFileSha256,
    sourceAlignmentReportSha256: hashFile(originalAlignmentPath),
    alignmentReportSha256: deterministicReportSha256,
    requestLedgerSha256: ledgerSha256,
    humanNarrationApprovalSha256: hashFile(APPROVAL_PATH),
    lockedHashes,
  };
  const proposal = activation.buildAlignmentReviewProposal({ runId, bindings, alignment });
  const proposalPath = path.join(reviewPath(runId), 'alignment-review-proposal.v1.json');
  const proposalSha256 = writeImmutableJson(fsImpl, proposalPath, proposal);
  const approvalPath = path.join(reviewPath(runId), 'alignment-review-approval.v1.json');
  let reviewedAlignment = null, approvedExceptions = [], unapprovedExceptions = [];
  if (fsImpl.existsSync(approvalPath)) {
    const approvalArtifact = JSON.parse(fsImpl.readFileSync(approvalPath, 'utf8'));
    assert(approvalArtifact.humanApproval?.sourceProposalSha256 === proposalSha256 && approvalArtifact.humanApproval?.approvalRef, 'ALIGNMENT_APPROVAL_AUTHORITY_MISMATCH');
    reviewedAlignment = activation.applyAlignmentReviewApproval({ alignment, approvalArtifact, expectedBindings: bindings });
    approvedExceptions = reviewedAlignment.acts.flatMap(act => act.approvedExceptions);
    unapprovedExceptions = reviewedAlignment.acts.flatMap(act => act.unapprovedExceptions);
  } else {
    unapprovedExceptions = alignment.acts.flatMap(act => [
      ...act.substitutions.map(item => ({ actKey: act.actKey, classification: activation.classifyReviewMismatch(item), ...item })),
      ...act.scriptDeletions.map(item => ({ actKey: act.actKey, classification: 'SCRIPT_DELETION', ...item })),
      ...act.transcriptInsertions.map(item => ({ actKey: act.actKey, classification: 'TRANSCRIPT_INSERTION', ...item })),
    ]);
    if (alignment.status === 'PASS') reviewedAlignment = {
      schemaVersion: 'phase2.3b-p-script-audio-reviewed-alignment/1.0.0', status: 'PASS', baseStatus: 'PASS',
      acts: alignment.acts.map(act => ({ ...act, deterministicStatus: act.status, status: 'PASS', approvedExceptions: [], unapprovedExceptions: [], uncoveredScriptTokenIndices: [] })),
      unusedApprovalExceptionIds: [], explicitRefusalOfUnlistedMismatches: true,
    };
  }
  const reviewedPath = reviewedAlignment ? path.join(reviewPath(runId), 'alignment-report.reviewed.v1.json') : null;
  const reviewedAlignmentSha256 = reviewedPath ? writeImmutableJson(fsImpl, reviewedPath, reviewedAlignment) : null;
  const report = {
    schemaVersion: 'phase2.3b-p-resume-preflight/2.0.0', status: reviewedAlignment?.status === 'PASS' ? 'RESUME_READY' : 'ALIGNMENT_REQUIRES_REVIEW',
    runId, preflightSha256: hashFile(path.join(reviewPath(runId), 'preflight.json')),
    lockedHashes, approvedAudio: completed.expectedAudio,
    transcript: { file: path.relative(reviewPath(runId), completed.timestampsPath).split(path.sep).join('/'), wordCount: completed.timestamps.length, semanticSha256: completed.verification.wordTimestampsSha256, fileSha256: completed.timestampFileSha256, sourceReceiptSha256: completed.receiptFileSha256, partialFileSha256: completed.partialFileSha256 },
    sourceAlignmentReportSha256: bindings.sourceAlignmentReportSha256,
    deterministicAlignmentReport: { file: path.basename(deterministicPath), sha256: deterministicReportSha256 },
    alignmentReviewProposal: { file: path.basename(proposalPath), sha256: proposalSha256 },
    alignmentReviewApproval: fsImpl.existsSync(approvalPath) ? { file: path.basename(approvalPath), sha256: hashFile(approvalPath) } : null,
    reviewedAlignmentReport: reviewedPath ? { file: path.basename(reviewedPath), sha256: reviewedAlignmentSha256 } : null,
    alignment: { deterministicStatus: alignment.status, reviewedStatus: reviewedAlignment?.status || null, deterministicMatches: alignment.acts.map(act => ({ actKey: act.actKey, matchedTokenCount: act.matchedTokenCount, normalizedEquivalents: act.normalizedEquivalents })), approvedExceptions, unapprovedExceptions },
    requestLedgerSha256: ledgerSha256,
    preservedRunMetadata: { completedActs: priorStatus.completedActs, attemptsByAct: priorStatus.attemptsByAct },
    providerRequestsMade: 0, rootArtifactWrites: 0,
  };
  atomicJson(path.join(reviewPath(runId), 'resume-preflight.json'), report);
  return { ...report, alignment };
}

function recordAlignmentReviewApproval({ runId, exceptionIds, approvedBy, approvalRef, fs: fsImpl = fs } = {}) {
  assert(SAFE_ID.test(runId || ''), 'RUN_ID_REQUIRED');
  assert(typeof approvedBy === 'string' && approvedBy.trim(), 'ALIGNMENT_APPROVER_REQUIRED');
  assert(typeof approvalRef === 'string' && approvalRef.trim(), 'ALIGNMENT_APPROVAL_REFERENCE_REQUIRED');
  assert(Array.isArray(exceptionIds) && new Set(exceptionIds).size === exceptionIds.length, 'ALIGNMENT_EXCEPTION_IDS_REQUIRED');
  const review = reviewPath(runId), proposalPath = path.join(review, 'alignment-review-proposal.v1.json');
  assert(fsImpl.existsSync(proposalPath), 'ALIGNMENT_REVIEW_PROPOSAL_MISSING');
  const proposal = JSON.parse(fsImpl.readFileSync(proposalPath, 'utf8'));
  assert(proposal.schemaVersion === 'phase2.3b-p-alignment-review-proposal/1.0.0' && proposal.status === 'PENDING_HUMAN_REVIEW' && proposal.runId === runId, 'ALIGNMENT_REVIEW_PROPOSAL_INVALID');
  const available = new Map(proposal.proposedExceptions.map(item => [item.exceptionId, item]));
  for (const id of exceptionIds) assert(available.has(id), `ALIGNMENT_EXCEPTION_NOT_IN_PROPOSAL:${id}`);
  const artifact = {
    schemaVersion: 'phase2.3b-p-alignment-review-approval/1.0.0', status: 'USER_APPROVED',
    runId, episodeId: proposal.episodeId, channelKey: proposal.channelKey, bindings: proposal.bindings,
    approvedExceptions: exceptionIds.map(id => available.get(id)), unlistedMismatchPolicy: 'REFUSE',
    humanApproval: { approvedBy: approvedBy.trim(), approvalRef: approvalRef.trim(), approvedAt: new Date().toISOString(), sourceProposalSha256: hashFile(proposalPath) },
  };
  const target = path.join(review, 'alignment-review-approval.v1.json');
  const digest = writeImmutableJson(fsImpl, target, artifact);
  return { path: target, sha256: digest, approvedExceptionCount: artifact.approvedExceptions.length };
}

function requireResumePreflight(runId, { fs: fsImpl = fs, checkLocks = true } = {}) {
  const file = path.join(reviewPath(runId), 'resume-preflight.json');
  assert(fsImpl.existsSync(file), 'RESUME_PREFLIGHT_MISSING');
  const record = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  assert(record.status === 'RESUME_READY' && record.runId === runId, 'RESUME_PREFLIGHT_NOT_PASS');
  const current = readAndVerifyCompletedTranscript({ fs: fsImpl, runId });
  assert(current.timestampFileSha256 === record.transcript.fileSha256 && current.receiptFileSha256 === record.transcript.sourceReceiptSha256 && current.verification.wordTimestampsSha256 === record.transcript.semanticSha256 && current.partialFileSha256 === record.transcript.partialFileSha256, 'RESUME_TRANSCRIPT_CHANGED');
  assert((fsImpl.existsSync(GLOBAL_LEDGER_PATH) ? hashFile(GLOBAL_LEDGER_PATH) : null) === record.requestLedgerSha256, 'RESUME_REQUEST_LEDGER_CHANGED');
  assert(hashFile(path.join(reviewPath(runId), 'preflight.json')) === record.preflightSha256, 'RESUME_PREFLIGHT_SOURCE_CHANGED');
  assert(hashFile(path.join(reviewPath(runId), record.deterministicAlignmentReport.file)) === record.deterministicAlignmentReport.sha256, 'RESUME_ALIGNMENT_REPORT_CHANGED');
  if (record.alignmentReviewApproval?.file) assert(hashFile(path.join(reviewPath(runId), record.alignmentReviewApproval.file)) === record.alignmentReviewApproval.sha256, 'RESUME_ALIGNMENT_APPROVAL_CHANGED');
  else assert(record.alignment.deterministicStatus === 'PASS', 'RESUME_ALIGNMENT_APPROVAL_MISSING');
  assert(record.reviewedAlignmentReport?.file && hashFile(path.join(reviewPath(runId), record.reviewedAlignmentReport.file)) === record.reviewedAlignmentReport.sha256, 'RESUME_REVIEWED_ALIGNMENT_CHANGED');
  assert(JSON.stringify(verifyLockedEpisode()) === JSON.stringify(record.lockedHashes), 'ACTIVATION_LOCKED_HASHES_CHANGED');
  if (checkLocks) assertNoActivationLocks({ fs: fsImpl, runId });
  const preflight = requireCurrentPreflight(runId), candidateScript = verifyApprovedScript().candidate;
  assert(sha(jsonBytes(candidateScript)) === preflight.candidateScriptSha256, 'RESUME_CANDIDATE_SCRIPT_CHANGED');
  const originalAlignmentPath = path.join(reviewPath(runId), 'alignment-report.json');
  assert(fsImpl.existsSync(originalAlignmentPath) && hashFile(originalAlignmentPath) === record.sourceAlignmentReportSha256, 'RESUME_SOURCE_ALIGNMENT_REPORT_CHANGED');
  const proposalPath = path.join(reviewPath(runId), record.alignmentReviewProposal.file);
  assert(hashFile(proposalPath) === record.alignmentReviewProposal.sha256, 'RESUME_ALIGNMENT_PROPOSAL_CHANGED');
  const pacingPlan = readJson(path.join(approval.approvedReviewDirectory, 'generation-plan.json'));
  assert(pacingPlan.planSha256 === preflight.pacingRun.planSha256 && pacingPlan.planSha256 === approval.approvedPacingPlanSha256, 'RESUME_PACING_PLAN_CHANGED');
  assert(hashFile(APPROVAL_PATH) === preflight.userApprovalArtifactSha256, 'RESUME_HUMAN_APPROVAL_CHANGED');
  const currentAlignment = activation.analyzeScriptTimestampAlignment(candidateScript, current.timestamps, VO_BINDINGS);
  const currentAlignmentPath = path.join(reviewPath(runId), record.deterministicAlignmentReport.file);
  assert(sha(jsonBytes(currentAlignment)) === hashFile(currentAlignmentPath), 'RESUME_ALIGNMENT_RECOMPUTE_MISMATCH');
  const expectedBindings = {
    runId, episodeId: approval.episodeId, channelKey: approval.channelKey,
    candidateScriptSha256: preflight.candidateScriptSha256,
    approvedAudio: current.expectedAudio.map(({ file, bytes, sha256: digest }) => ({ file, bytes, sha256: digest })),
    pacingPlanSha256: preflight.pacingRun.planSha256,
    transcriptSemanticSha256: current.verification.wordTimestampsSha256,
    transcriptFileSha256: current.timestampFileSha256,
    sourceReceiptSha256: current.receiptFileSha256,
    sourceAlignmentReportSha256: record.sourceAlignmentReportSha256,
    alignmentReportSha256: record.deterministicAlignmentReport.sha256,
    requestLedgerSha256: record.requestLedgerSha256,
    humanNarrationApprovalSha256: preflight.userApprovalArtifactSha256,
    lockedHashes: record.lockedHashes,
  };
  const proposal = JSON.parse(fsImpl.readFileSync(proposalPath, 'utf8'));
  assert(JSON.stringify(proposal.bindings) === JSON.stringify(expectedBindings), 'RESUME_ALIGNMENT_PROPOSAL_BINDING_CHANGED');
  let alignment;
  if (record.alignmentReviewApproval?.file) {
    const approvalArtifact = JSON.parse(fsImpl.readFileSync(path.join(reviewPath(runId), record.alignmentReviewApproval.file), 'utf8'));
    assert(approvalArtifact.humanApproval?.sourceProposalSha256 === record.alignmentReviewProposal.sha256 && approvalArtifact.humanApproval?.approvalRef, 'RESUME_ALIGNMENT_APPROVAL_AUTHORITY_CHANGED');
    alignment = activation.applyAlignmentReviewApproval({ alignment: currentAlignment, approvalArtifact, expectedBindings });
  } else {
    assert(currentAlignment.status === 'PASS', 'RESUME_ALIGNMENT_APPROVAL_MISSING');
    alignment = { schemaVersion: 'phase2.3b-p-script-audio-reviewed-alignment/1.0.0', status: 'PASS', baseStatus: 'PASS', acts: currentAlignment.acts.map(act => ({ ...act, deterministicStatus: act.status, status: 'PASS', approvedExceptions: [], unapprovedExceptions: [], uncoveredScriptTokenIndices: [] })), unusedApprovalExceptionIds: [], explicitRefusalOfUnlistedMismatches: true };
  }
  assert(sha(jsonBytes(alignment)) === record.reviewedAlignmentReport.sha256, 'RESUME_REVIEWED_ALIGNMENT_RECOMPUTE_MISMATCH');
  assert(alignment.status === 'PASS', 'RESUME_REVIEWED_ALIGNMENT_NOT_PASS');
  return { completed: current, alignment, record };
}

async function transcribeAndBuildInternal({ runId, onProgress, resumeOnly = false, runWhisper = require('/data/pipeline/vo-timing.cjs').runWhisper, probeAudio = file => require('/data/pipeline/act-voice-generator.cjs').probeMp3Default(file) } = {}) {
  requireCurrentPreflight(runId); verifyPackage(); verifyRuntimeSync();
  require('./phase2.3b-p-run.cjs').inspectProductionActivity({ db: require('/app/db').db, episodeId: approval.episodeId, episodeDirectory: ROOT, fs });
  const review = reviewPath(runId); const timingDir = path.join(review, 'fresh-whisper'); const audioDir = path.join(timingDir, 'audio');
  const receiptPath = path.join(timingDir, 'timing-source-receipt.json');
  const requestLedgerPath = GLOBAL_LEDGER_PATH;
  const timestampsPath = path.join(timingDir, 'word-timestamps.json');
  fs.mkdirSync(audioDir, { recursive: true });
  const audioManifest = [];
  for (const contract of approval.approvedAudio) {
    const source = approvedAudioPath(approval.approvedRunId, contract.file); const target = path.join(audioDir, contract.file);
    const bytes = fs.readFileSync(source);
    assert(bytes.length === contract.bytes && sha(bytes) === contract.sha256, `APPROVED_AUDIO_HASH_MISMATCH:${contract.file}`);
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target);
      assert(existing.length === bytes.length && sha(existing) === sha(bytes), `TIMING_SOURCE_COPY_MISMATCH:${contract.file}`);
    } else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    audioManifest.push({ file: contract.file, bytes: bytes.length, sha256: sha(bytes) });
  }
  let receipt;
  if (fs.existsSync(receiptPath)) {
    receipt = readJson(receiptPath);
    assert(receipt.runId === runId && JSON.stringify(receipt.audio) === JSON.stringify(audioManifest), 'TIMING_SOURCE_RECEIPT_MISMATCH');
  } else {
    assert(!fs.existsSync(timestampsPath), 'UNRECEIPTED_TIMING_OUTPUT_EXISTS');
    receipt = { schemaVersion: 'phase2.3b-p-timing-source/1.0.0', runId, createdAt: new Date().toISOString(), audio: audioManifest, state: 'TRANSCRIPTION_IN_PROGRESS' };
    atomicJson(receiptPath, receipt);
  }
  const resumeReview = resumeOnly ? requireResumePreflight(runId, { checkLocks: false }) : null;
  const timestamps = await activation.chooseTimingTranscript({
    resumeOnly,
    readExisting: () => fs.existsSync(timestampsPath) ? readJson(timestampsPath) : null,
    transcribe: () => runWhisper({
      audioDir, episodeDir: timingDir,
      onProgress(event) {
        if (event.type === 'attempt-start') activation.reserveWhisperAttempt({ ledgerPath: requestLedgerPath, actKey: event.voKey.replace(/^VO_/u, '').toLowerCase(), attempt: event.attempt });
        if (typeof onProgress === 'function') onProgress(event);
      },
    }),
  });
  assert(Array.isArray(timestamps) && timestamps.length > 0, 'WHISPER_OUTPUT_EMPTY');
  const verifiedTiming = readAndVerifyCompletedTranscript({ runId });
  const alignment = resumeOnly ? resumeReview.alignment : activation.analyzeScriptTimestampAlignment(verifyApprovedScript().candidate, timestamps, VO_BINDINGS);
  if (!resumeOnly) {
    const alignmentPath = path.join(review, 'alignment-report.json');
    atomicJson(alignmentPath, alignment);
    const failedAlignment = alignment.acts.find(act => act.status !== 'PASS');
    if (failedAlignment) {
      const error = new Error(`ACTIVATION_SCRIPT_AUDIO_WORD_PARITY:${failedAlignment.actKey}`);
      error.alignmentReport = alignment;
      throw error;
    }
  }
  assert(verifiedTiming.verification.wordTimestampsSha256 === activation.jsonHash(timestamps), 'TIMING_TRANSCRIPT_VERIFICATION_FAILED');
  const durations = {};
  for (const contract of approval.approvedAudio) durations[contract.actKey] = Number((await probeAudio(path.join(audioDir, contract.file))).durationSec);
  const candidate = path.join(review, 'candidate');
  assert(!fs.existsSync(candidate), 'ACTIVATION_CANDIDATE_ALREADY_EXISTS');
  const basePlan = readJson(path.join(CANDIDATE_PACKAGE, CANDIDATE_FILES.plan));
  const retimed = activation.retimeEditPlan({ plan: basePlan, wordTimestamps: timestamps, actOrder: ACT_ORDER, actBindings: VO_BINDINGS, actDurationsSec: durations }).plan;
  const editValidation = require('/data/pipeline/edit-plan-validator.cjs').validateEditPlan({ plan: retimed, wordTimestamps: timestamps });
  assert(editValidation.status === 'PASS', `EDIT_PLAN_VALIDATION:${editValidation.errors?.[0]?.code || 'FAIL'}`);
  activation.assertCreativePlanFieldsFrozen(basePlan, retimed);
  const originalShots = readJson(path.join(CANDIDATE_PACKAGE, CANDIDATE_FILES.shots));
  const lineage = [readJson(path.join(CANDIDATE_PACKAGE, CANDIDATE_FILES.history)), readJson(path.join(CANDIDATE_PACKAGE, CANDIDATE_FILES.amendment))];
  const shotResult = activation.updateShotDefinitions({ originalShotDefs: originalShots, plan: retimed, revisionChain: lineage, revisionId: `phase2.3b-p-retiming-${runId}` });
  const shotValidation = require('/data/pipeline/shot-definitions-validator.cjs').validateShotDefinitions({ plan: retimed, shotDefs: shotResult.shotDefs, revisionChain: shotResult.revisionChain });
  assert(shotValidation.status === 'PASS', `SHOT_VALIDATION:${shotValidation.errors?.[0]?.code || 'FAIL'}`);
  const manifest = readJson(path.join(CANDIDATE_PACKAGE, CANDIDATE_FILES.manifest));
  const planFingerprint = require('/data/pipeline/shot-definitions-validator.cjs').planFingerprint(retimed);
  manifest.sourceEditPlanSha256 = planFingerprint; manifest.candidateSha256 = sha(jsonBytes(shotResult.shotDefs));
  const manifestValidation = require('/data/pipeline/production-method-manifest.cjs').validateProductionMethodManifest({ manifest, shotDefs: shotResult.shotDefs, candidateSha256: manifest.candidateSha256 });
  assert(manifestValidation.status === 'PASS', `PRODUCTION_MANIFEST_VALIDATION:${manifestValidation.errors?.[0]?.code || 'FAIL'}`);
  const evidence = readJson(path.join(ROOT, 'evidence-source-manifest.json'));
  evidence.shotDefinitionsSha256 = sha(jsonBytes(shotResult.shotDefs));
  const shotById = new Map(shotResult.shotDefs.allShots.map(shot => [shot.shotId, shot]));
  for (const entry of evidence.entries || []) if (shotById.has(entry.shotId)) entry.exactSourceRequirement = shotById.get(entry.shotId).evidenceRequirement?.description;
  const evidenceValidation = require('/data/pipeline/evidence-source-validator.cjs').validateEvidenceSourceManifest({ manifest: evidence, shotDefs: shotResult.shotDefs, evidenceAssetDir: path.join(ROOT, 'assets', 'evidence') });
  assert(evidenceValidation.status === 'PASS', `EVIDENCE_VALIDATION:${evidenceValidation.errors?.[0]?.code || 'FAIL'}`);
  const proofPlan = require('/data/pipeline/proof-section-planner.cjs').planProofSection({ shotDefs: shotResult.shotDefs, productionManifest: manifest });
  const timingLedgerPath = path.join(review, `revision-ledger.phase2.3b-p-retiming-${runId}.json`);
  atomicJson(timingLedgerPath, shotResult.revisionLedger);
  const activeStatus = readJson(path.join(ROOT, 'edit-plan-shadow-status.json'));
  activeStatus.status = 'complete'; activeStatus.editPlanStatus = 'PASS';
  const timingRelative = `.v3-shadow/timing/phase2.3b-p-activation-${runId}`; activeStatus.timingCache = timingRelative;
  const files = {
    'script.json': jsonBytes(verifyApprovedScript().candidate),
    'edit-plan.json': jsonBytes(retimed),
    'edit-plan-validation.json': jsonBytes(editValidation),
    'shot-definitions.json': jsonBytes(shotResult.shotDefs),
    'production-manifest.json': jsonBytes(manifest),
    'evidence-source-manifest.json': jsonBytes(evidence),
    'proof-section-plan.json': jsonBytes(proofPlan),
    'edit-plan-shadow-status.json': jsonBytes(activeStatus),
    [`${timingRelative}/word-timestamps.json`]: jsonBytes(timestamps),
  };
  for (const contract of approval.approvedAudio) files[`assets/audio/${contract.file}`] = fs.readFileSync(path.join(audioDir, contract.file));
  // Timing propagation must not rewrite creative/production/evidence decisions.
  fs.mkdirSync(candidate, { recursive: true });
  for (const [relative, bytes] of Object.entries(files)) {
    const target = path.join(candidate, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); activation.atomicWrite(fs, target, bytes);
  }
  const fileManifest = Object.entries(files).map(([relative, bytes]) => ({ path: relative, bytes: bytes.length, sha256: sha(bytes) }));
  const report = { schemaVersion: 'phase2.3b-p-activation-candidate/1.0.0', status: 'VALIDATED_NOT_PROMOTED', runId, createdAt: new Date().toISOString(), actOrder: ACT_ORDER, freshTimingWords: timestamps.length, audio: approval.approvedAudio.map(({ actKey, file, sha256: digest, bytes }) => ({ actKey, file, sha256: digest, bytes, durationSec: durations[actKey] })), lineageLedger: { path: path.basename(timingLedgerPath), sha256: hashFile(timingLedgerPath) }, validation: { scriptAudioParity: 'PASS', editPlan: editValidation.status, shotDefinitions: shotValidation.status, productionManifest: manifestValidation.status, evidenceManifest: evidenceValidation.status }, candidateFiles: fileManifest };
  atomicJson(path.join(candidate, 'candidate-report.json'), report);
  receipt = readJson(receiptPath); receipt.state = 'COMPLETE'; receipt.wordTimestampsSha256 = sha(jsonBytes(timestamps)); receipt.completedAt = new Date().toISOString(); atomicJson(receiptPath, receipt);
  return report;
}
async function transcribeAndBuild(options = {}) {
  const { runId } = options;
  assert(SAFE_ID.test(runId || ''), 'RUN_ID_REQUIRED');
  if (options.resumeOnly) requireResumePreflight(runId);
  const review = reviewPath(runId); fs.mkdirSync(review, { recursive: true });
  const statusPath = path.join(review, 'run-status.json');
  const priorStatus = options.resumeOnly && fs.existsSync(statusPath) ? readJson(statusPath) : null;
  if (options.resumeOnly) assert(priorStatus?.runId === runId && priorStatus.state === 'FAILURE' && JSON.stringify(priorStatus.completedActs) === JSON.stringify(ACT_ORDER), 'RESUME_RUN_STATE_MISMATCH');
  const lockPath = path.join(review, 'activation.lock');
  let fd, globalFd;
  try { fd = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') throw new Error('ACTIVATION_RUN_ALREADY_LOCKED'); throw error; }
  try {
    globalFd = fs.openSync(GLOBAL_LOCK_PATH, 'wx', 0o600);
    const fingerprint = sha(Buffer.from(JSON.stringify(approval.approvedAudio.map(({ actKey, file, sha256: digest, bytes }) => ({ actKey, file, sha256: digest, bytes })))));
    if (fs.existsSync(GLOBAL_STATE_PATH)) {
      const previous = readJson(GLOBAL_STATE_PATH);
      assert(previous.runId === runId && previous.audioFingerprint === fingerprint, 'ACTIVATION_PRIOR_RUN_REQUIRES_REVIEW');
    } else atomicJson(GLOBAL_STATE_PATH, { schemaVersion: 'phase2.3b-p-activation-state/1.0.0', runId, audioFingerprint: fingerprint, state: 'RUNNING', startedAt: new Date().toISOString() });
    fs.writeFileSync(globalFd, JSON.stringify({ runId, pid: process.pid, startedAt: new Date().toISOString(), audioFingerprint: fingerprint }), 'utf8');
  } catch (error) {
    try { if (globalFd !== undefined) fs.closeSync(globalFd); } catch (_) {}
    if (globalFd !== undefined) { try { fs.rmSync(GLOBAL_LOCK_PATH, { force: true }); } catch (_) {} }
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
    throw error;
  }
  const status = priorStatus
    ? { ...priorStatus, pid: process.pid, heartbeatAt: new Date().toISOString(), state: 'RUNNING', currentStage: 'RESUMING_FROM_VERIFIED_TRANSCRIPT', resumeStartedAt: new Date().toISOString() }
    : { schemaVersion: 'phase2.3b-p-activation-run-status/1.0.0', runId, pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), state: 'RUNNING', currentStage: 'STARTING', completedActs: [], attemptsByAct: Object.fromEntries(ACT_ORDER.map(act => [act, null])) };
  fs.writeFileSync(fd, JSON.stringify({ runId, pid: process.pid, startedAt: status.startedAt, mode: 'TRANSCRIBE_AND_BUILD' }), 'utf8');
  atomicJson(statusPath, status);
  const heartbeat = setInterval(() => { status.heartbeatAt = new Date().toISOString(); status.currentStage = 'TRANSCRIBING_OR_VALIDATING'; atomicJson(statusPath, status); }, 15000);
  try {
    const report = await transcribeAndBuildInternal({ ...options, onProgress(event) {
      status.currentStage = event.type === 'attempt-start' ? 'WHISPER_REQUEST_RESERVED' : event.type.toUpperCase().replace(/-/gu, '_');
      status.currentAct = event.actKey?.replace(/^VO_/u, '').toLowerCase() || null;
      status.heartbeatAt = new Date().toISOString();
      const ledgerPath = GLOBAL_LEDGER_PATH;
      if (fs.existsSync(ledgerPath)) {
        const reservations = fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
        for (const act of ACT_ORDER) status.attemptsByAct[act] = reservations.filter(item => item.actKey === act).length;
      }
      const partialPath = path.join(review, 'fresh-whisper', 'word-timestamps.partial.json');
      if (event.type === 'file-complete' && fs.existsSync(partialPath)) {
        const partial = readJson(partialPath);
        status.completedActs = Object.keys(partial).map(key => key.replace(/^VO_/u, '').toLowerCase()).filter(act => ACT_ORDER.includes(act));
      }
      atomicJson(statusPath, status);
    } });
    status.state = 'SUCCESS'; status.currentStage = 'CANDIDATE_VALIDATED'; status.completedActs = [...ACT_ORDER]; status.heartbeatAt = new Date().toISOString(); status.completedAt = status.heartbeatAt; status.candidatePath = path.join(review, 'candidate');
    atomicJson(statusPath, status);
    const globalState = readJson(GLOBAL_STATE_PATH); globalState.state = 'CANDIDATE_VALIDATED'; globalState.completedAt = status.completedAt; atomicJson(GLOBAL_STATE_PATH, globalState);
    return report;
  } catch (error) {
    status.state = 'FAILURE'; status.currentStage = 'FAILED'; status.error = String(error.message || error).slice(0, 500); status.heartbeatAt = new Date().toISOString(); status.completedAt = status.heartbeatAt;
    atomicJson(statusPath, status);
    try { const globalState = readJson(GLOBAL_STATE_PATH); globalState.state = 'FAILURE'; globalState.lastError = status.error; globalState.updatedAt = status.heartbeatAt; atomicJson(GLOBAL_STATE_PATH, globalState); } catch (_) {}
    throw error;
  } finally {
    clearInterval(heartbeat);
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
    try { fs.closeSync(globalFd); } catch (_) {}
    try { fs.rmSync(GLOBAL_LOCK_PATH, { force: true }); } catch (_) {}
  }
}
async function resumeAndBuild({ runId } = {}) {
  requireResumePreflight(runId);
  return transcribeAndBuild({ runId, resumeOnly: true, runWhisper: async () => { throw new Error('RESUME_WHISPER_CALL_FORBIDDEN'); } });
}
function verifyCandidate(runId) {
  requireCurrentPreflight(runId);
  const candidateDir = path.join(reviewPath(runId), 'candidate'); const report = readJson(path.join(candidateDir, 'candidate-report.json'));
  assert(report.status === 'VALIDATED_NOT_PROMOTED' && report.runId === runId, 'ACTIVATION_CANDIDATE_INVALID');
  for (const item of report.candidateFiles) {
    const file = path.resolve(candidateDir, item.path); assert(file.startsWith(`${path.resolve(candidateDir)}${path.sep}`) && fs.existsSync(file), `CANDIDATE_MISSING:${item.path}`);
    const bytes = fs.readFileSync(file); assert(bytes.length === item.bytes && sha(bytes) === item.sha256, `CANDIDATE_HASH_MISMATCH:${item.path}`);
  }
  return report;
}
function promoteLocked(runId) {
  ensureRailwayTarget(); requireCurrentPreflight(runId); verifyCandidate(runId); verifyLockedEpisode(); verifyRuntimeSync();
  require('./phase2.3b-p-run.cjs').inspectProductionActivity({ db: require('/app/db').db, episodeId: approval.episodeId, episodeDirectory: ROOT, fs });
  const review = reviewPath(runId); const candidateDir = path.join(review, 'candidate');
  const report = readJson(path.join(candidateDir, 'candidate-report.json'));
  const backupDir = path.join(review, 'backup');
  assert(!fs.existsSync(backupDir), 'ACTIVATION_BACKUP_ALREADY_EXISTS');
  const backupManifest = activation.makeBackup({ episodeDirectory: ROOT, backupDirectory: backupDir, targets: report.candidateFiles.map(item => item.path) });
  atomicJson(path.join(backupDir, 'backup-manifest.json'), backupManifest);
  const parent = path.dirname(ROOT); const stage = path.join(parent, `.eo-v3-activation-${runId}`);
  assert(!fs.existsSync(stage), 'ACTIVATION_STAGE_ALREADY_EXISTS');
  execFileSync('cp', ['-al', ROOT, stage], { stdio: 'ignore' });
  let exchanged = false;
  try {
    for (const item of report.candidateFiles) {
      const target = path.join(stage, item.path); fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = fs.readFileSync(path.join(candidateDir, item.path)); activation.atomicWrite(fs, target, bytes);
    }
    verifyPromotedTree(stage, report);
    const activationRecord = { schemaVersion: 'phase2.3b-p-activation-record/1.0.0', status: 'READY_TO_EXCHANGE', runId, createdAt: new Date().toISOString(), priorHashes: verifyLockedEpisode(), candidateFiles: report.candidateFiles, backupManifestSha256: hashFile(path.join(backupDir, 'backup-manifest.json')) };
    atomicJson(path.join(review, 'activation-record.json'), activationRecord);
    execFileSync('python3', [path.join(__dirname, 'phase2.3b-sg-atomic-exchange.py'), ROOT, stage], { stdio: 'ignore' });
    exchanged = true;
    try { verifyPromotedTree(ROOT, report); }
    catch (error) { execFileSync('python3', [path.join(__dirname, 'phase2.3b-sg-atomic-exchange.py'), ROOT, stage], { stdio: 'ignore' }); throw error; }
    activationRecord.status = 'PROMOTED'; activationRecord.promotedAt = new Date().toISOString(); atomicJson(path.join(ROOT, '.review', `phase2.3b-p-activation-${runId}`, 'activation-record.json'), activationRecord);
    return activationRecord;
  } catch (error) {
    if (exchanged && fs.existsSync(stage)) {
      try { execFileSync('python3', [path.join(__dirname, 'phase2.3b-sg-atomic-exchange.py'), ROOT, stage], { stdio: 'ignore' }); exchanged = false; }
      catch (_) { console.error(`ACTIVATION_RECOVERY_REQUIRED: preserve active=${ROOT} prior=${stage}`); throw error; }
    }
    if (!exchanged && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
function withGlobalActivationLock(runId, mode, fn) {
  fs.mkdirSync(GLOBAL_REVIEW, { recursive: true });
  let fd;
  try { fd = fs.openSync(GLOBAL_LOCK_PATH, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') throw new Error('ACTIVATION_GLOBAL_RUN_ALREADY_LOCKED'); throw error; }
  try { fs.writeFileSync(fd, JSON.stringify({ runId, pid: process.pid, startedAt: new Date().toISOString(), mode }), 'utf8'); return fn(); }
  finally { try { fs.closeSync(fd); } catch (_) {} try { fs.rmSync(GLOBAL_LOCK_PATH, { force: true }); } catch (_) {} }
}
function promote(runId) { return withGlobalActivationLock(runId, 'PROMOTE', () => promoteLocked(runId)); }
function verifyPromotedTree(root, report) {
  for (const item of report.candidateFiles) {
    const file = path.resolve(root, item.path); assert(file.startsWith(`${path.resolve(root)}${path.sep}`) && fs.existsSync(file), `PROMOTED_FILE_MISSING:${item.path}`);
    const bytes = fs.readFileSync(file); assert(bytes.length === item.bytes && sha(bytes) === item.sha256, `PROMOTED_HASH_MISMATCH:${item.path}`);
  }
  return true;
}
function rollbackLocked(runId) {
  const review = reviewPath(runId); const record = readJson(path.join(review, 'activation-record.json'));
  assert(record.status === 'PROMOTED', 'ACTIVATION_NOT_PROMOTED');
  const backupDir = path.join(review, 'backup'); const backup = readJson(path.join(backupDir, 'backup-manifest.json'));
  activation.verifyBackup({ backupDirectory: backupDir, manifest: backup });
  const restored = path.join(path.dirname(ROOT), `.eo-v3-rollback-${runId}`);
  assert(!fs.existsSync(restored), 'ROLLBACK_STAGE_EXISTS'); execFileSync('cp', ['-al', ROOT, restored], { stdio: 'ignore' });
  activation.restoreBackup({ episodeDirectory: restored, backupDirectory: backupDir, manifest: backup });
  execFileSync('python3', [path.join(__dirname, 'phase2.3b-sg-atomic-exchange.py'), ROOT, restored], { stdio: 'ignore' });
  record.status = 'ROLLED_BACK'; record.rolledBackAt = new Date().toISOString(); atomicJson(path.join(review, 'activation-record.json'), record);
  return record;
}
function rollback(runId) { return withGlobalActivationLock(runId, 'ROLLBACK', () => rollbackLocked(runId)); }
function usage() { return 'Usage: node /app/scripts/phase2.3b-p-activate.cjs --preflight --run-id <id> | --transcribe-build --run-id <id> | --diagnose-resume --run-id <id> | --approve-alignment-review --run-id <id> --approved-by <name> --approval-ref <reference> [--exception-id <id> ...] | --resume-build --run-id <id> | --status --run-id <id> | --promote --run-id <id> | --rollback --run-id <id>'; }
async function main(argv = process.argv.slice(2)) {
  const mode = argv[0]; const idAt = argv.indexOf('--run-id'); const runId = idAt >= 0 ? argv[idAt + 1] : null;
  if (mode === '--help' || mode === '-h') { console.log(usage()); return; }
  assert(SAFE_ID.test(runId || ''), 'RUN_ID_REQUIRED');
  let result;
  if (mode === '--preflight') result = await preflight({ runId });
  else if (mode === '--transcribe-build') result = await transcribeAndBuild({ runId });
  else if (mode === '--diagnose-resume') result = diagnoseResume({ runId });
  else if (mode === '--approve-alignment-review') {
    const readOption = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : null; };
    result = recordAlignmentReviewApproval({ runId, approvedBy: readOption('--approved-by'), approvalRef: readOption('--approval-ref'), exceptionIds: argv.flatMap((item, index) => item === '--exception-id' && argv[index + 1] ? [argv[index + 1]] : []) });
  }
  else if (mode === '--resume-build') result = await resumeAndBuild({ runId });
  else if (mode === '--status') result = { globalState: fs.existsSync(GLOBAL_STATE_PATH) ? readJson(GLOBAL_STATE_PATH) : null, runStatus: fs.existsSync(path.join(reviewPath(runId), 'run-status.json')) ? readJson(path.join(reviewPath(runId), 'run-status.json')) : null, activeLock: fs.existsSync(GLOBAL_LOCK_PATH) ? readJson(GLOBAL_LOCK_PATH) : null };
  else if (mode === '--promote') result = promote(runId);
  else if (mode === '--rollback') result = rollback(runId);
  else throw new Error('MODE_REQUIRED');
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error(`PHASE2_3B_P_ACTIVATION_FAILED:${String(error.message || error)}`); process.exitCode = 1; });
module.exports = { APPROVAL_PATH, approval, ROOT, CANDIDATE_PACKAGE, verifyApprovalAudio, verifyPackage, verifyLockedEpisode, verifyApprovedScript, expectedTimingAudioManifest, readAndVerifyCompletedTranscript, diagnoseResume, recordAlignmentReviewApproval, requireResumePreflight, preflight, transcribeAndBuildInternal, transcribeAndBuild, resumeAndBuild, verifyCandidate, verifyPromotedTree, promote, rollback, usage, main };
