'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { planPacedNarration, runPacedNarration, sha256 } = require('../pipeline-updates/paced-narration-generator.cjs');

const SPEC_PATH = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo', 'phase2.3b-p-review', 'pacing-run-spec.json');
const SPEC = JSON.parse(fsDefault.readFileSync(SPEC_PATH, 'utf8'));
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;

function readJson(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { throw new Error('PACING_INPUT_JSON_INVALID:' + path.basename(file)); }
}

function verifyLockedFiles({ fs = fsDefault, episodeDirectory, spec = SPEC }) {
  const actual = {};
  for (const [relative, expected] of Object.entries(spec.lockedFiles)) {
    const file = path.resolve(episodeDirectory, relative);
    if (!file.startsWith(path.resolve(episodeDirectory) + path.sep) || !fs.existsSync(file)) throw new Error('LOCKED_INPUT_MISSING:' + relative);
    const digest = sha256(fs.readFileSync(file));
    actual[relative] = digest;
    if (digest !== expected) throw new Error('LOCKED_INPUT_HASH_MISMATCH:' + relative);
  }
  return actual;
}

function buildActMap({ script, narrationTexts, spec = SPEC }) {
  if (!script || !script.acts || typeof script.acts !== 'object') throw new Error('SCRIPT_ACT_MAP_INVALID');
  const result = {};
  for (const actKey of spec.actOrder) {
    const voFilename = spec.voFilenames[actKey];
    let text;
    if (Object.prototype.hasOwnProperty.call(spec.approvedCorrectionText, actKey)) {
      const correction = narrationTexts?.[actKey]?.next;
      const expected = spec.approvedCorrectionText[actKey];
      if (typeof correction !== 'string' || correction.length !== expected.characters || sha256(correction) !== expected.sha256) throw new Error('APPROVED_CORRECTION_TEXT_INVALID:' + actKey);
      text = correction;
    } else {
      text = script.acts[actKey]?.voScript;
      if (typeof text !== 'string' || !text.trim()) throw new Error('AUTHORITATIVE_ACT_TEXT_MISSING:' + actKey);
    }
    result[actKey] = { text, voFilename };
  }
  return result;
}

function makePlan({ episodeDirectory, script, narrationTexts, spec = SPEC }) {
  const actMap = buildActMap({ script, narrationTexts, spec });
  return planPacedNarration({
    channelKey: spec.channelKey,
    episodeDirectory,
    actMap,
    voiceSettings: spec.voiceSettings,
    outputFormat: spec.outputFormat,
    maximumSegmentLength: spec.maximumSegmentLength,
    joinPauseDurationMs: spec.joinPauseDurationMs,
    maximumRequests: spec.maximumRequests,
    maximumCharacters: spec.maximumCharacters,
  });
}

const PACING_PACKAGE_DIR = path.join(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo', 'phase2.3b-p-review');

function verifyPacingPackage({ fs = fsDefault, packageDirectory = PACING_PACKAGE_DIR } = {}) {
  const manifest = readJson(fs, path.join(packageDirectory, 'pacing-package-sha256.json'));
  if (manifest.schemaVersion !== 'phase2.3b-p-package/1.0.0' || !manifest.files || typeof manifest.files !== 'object') throw new Error('PACING_PACKAGE_MANIFEST_INVALID');
  const verified = [];
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const file = path.resolve(packageDirectory, relative);
    if (!file.startsWith(path.resolve(packageDirectory) + path.sep) || !fs.existsSync(file)) throw new Error('PACING_PACKAGE_FILE_MISSING:' + relative);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error('PACING_PACKAGE_HASH_MISMATCH:' + relative);
    verified.push(relative);
  }
  return { manifest, verified };
}
function readCandidateTexts({ fs = fsDefault, candidateDirectory = SPEC.candidateDirectory }) {
  const verifier = require('./phase2.3b-sg-stage-a.cjs');
  verifier.verifyCandidatePackage(candidateDirectory);
  return readJson(fs, path.join(candidateDirectory, 'narration-texts.json'));
}

function loadInputs({ fs = fsDefault, episodeDirectory = SPEC.episodeDirectory, candidateDirectory = SPEC.candidateDirectory, spec = SPEC, packageDirectory = PACING_PACKAGE_DIR }) {
  const pacingPackage = verifyPacingPackage({ fs, packageDirectory });
  const lockedHashes = verifyLockedFiles({ fs, episodeDirectory, spec });
  const script = readJson(fs, path.join(episodeDirectory, 'script.json'));
  const narrationTexts = readCandidateTexts({ fs, candidateDirectory });
  const plan = makePlan({ episodeDirectory, script, narrationTexts, spec });
  const preview = readJson(fs, path.join(packageDirectory, 'pacing-plan-baseline.json'));
  const summary = planSummary(plan);
  if (preview.schemaVersion !== 'phase2.3b-p-plan-preview/1.0.0' || preview.sourceScriptSha256 !== spec.lockedFiles['script.json'] || preview.authoritativeWordTimestampsSha256 !== spec.lockedFiles[spec.timingRelativePath] || JSON.stringify(preview.plan) !== JSON.stringify(summary)) throw new Error('PACING_PLAN_BASELINE_MISMATCH');
  return { pacingPackageFiles: pacingPackage.verified, lockedHashes, script, narrationTexts, plan };
}

function getCredentialState({ channelDna, env = process.env }) {
  const voiceId = channelDna?.voice_id_elevenlabs || channelDna?.elevenlabs_voice_id || env.ELEVENLABS_VOICE_ID;
  return { credentialsPresent: Boolean(typeof env.ELEVENLABS_API_KEY === 'string' && env.ELEVENLABS_API_KEY.trim()), voiceIdConfigured: Boolean(typeof voiceId === 'string' && voiceId.trim()) };
}

function dbAll(db, sql, params) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

async function inspectProductionActivity({ db, episodeId, episodeDirectory, fs = fsDefault, reviewOutputDirectory }) {
  const rows = await dbAll(db,
    "SELECT e.id, e.status AS episodeStatus, j.step, j.status AS jobStatus FROM episodes e LEFT JOIN jobs j ON j.episode_id = e.id WHERE e.id = ? OR e.episode_id = ?",
    [episodeId, episodeId]);
  const activeStatuses = new Set(['queued', 'pending', 'running', 'awaiting_approval']);
  const activeRows = rows.filter(row => activeStatuses.has(row.episodeStatus) || activeStatuses.has(row.jobStatus));
  if (activeRows.length) throw new Error('EPISODE_PRODUCTION_JOB_ACTIVE');
  const reviewRoot = path.join(episodeDirectory, '.review');
  const lockCandidates = [
    path.join(reviewRoot, 'phase2.3b-sg-active.lock'),
    path.join(reviewRoot, 'narration-pacing-active.lock'),
    path.join(episodeDirectory, 'assets', 'audio', 'VO_Act1.mp3.act-voice.lock'),
    path.join(episodeDirectory, 'assets', 'audio', 'VO_Act2.mp3.act-voice.lock'),
    path.join(episodeDirectory, 'assets', 'audio', 'VO_Act3.mp3.act-voice.lock'),
    path.join(episodeDirectory, 'assets', 'audio', 'VO_Act3B.mp3.act-voice.lock'),
    path.join(episodeDirectory, 'assets', 'audio', 'VO_Act4.mp3.act-voice.lock'),
    path.join(episodeDirectory, 'assets', 'audio', 'VO_Act5.mp3.act-voice.lock'),
  ];
  for (const lock of lockCandidates) if (fs.existsSync(lock)) throw new Error('NARRATION_OR_STAGE_LOCK_ACTIVE:' + path.basename(lock));
  for (const filename of fs.readdirSync(reviewRoot)) {
    const directory = path.join(reviewRoot, filename);
    if (!fs.statSync(directory).isDirectory() || !filename.startsWith('phase2.3b-p-narration-')) continue;
    const runLock = path.join(directory, 'run.lock');
    if (fs.existsSync(runLock) && directory !== reviewOutputDirectory) throw new Error('OTHER_PACING_RUN_LOCK_ACTIVE:' + filename);
  }
  return { databaseRowsChecked: rows.length, activeRows: 0, locksChecked: lockCandidates.length };
}

function verifyRailwayTarget(env = process.env) {
  const expected = {
    RAILWAY_PROJECT_ID: '98a75a00-ce8e-4a7a-833e-ff76d3bdefea',
    RAILWAY_ENVIRONMENT_ID: '6fa50efc-d4bc-4ea1-9c6e-c9daa9336b34',
    RAILWAY_SERVICE_ID: 'd965705e-d5e7-4f4e-ac58-fc6b1959c81f',
  };
  for (const [name, value] of Object.entries(expected)) if (env[name] && env[name] !== value) throw new Error('WRONG_RAILWAY_TARGET:' + name);
  return true;
}

function planSummary(plan) {
  return {
    channelKey: plan.channelKey,
    model: plan.model,
    voiceSettings: plan.voiceSettings,
    outputFormat: plan.outputFormat,
    maximumSegmentLength: plan.maximumSegmentLength,
    joinPauseDurationMs: plan.joinPauseDurationMs,
    totalRequests: plan.totalSegments,
    totalBillableCharacters: plan.totalCharacters,
    totalWords: plan.totalWords,
    planSha256: plan.planSha256,
    acts: plan.acts.map(act => ({ actKey: act.actKey, sourceCharacters: act.sourceCharacters, sourceWords: act.sourceWords, performanceCharacters: act.performanceCharacters, performanceWords: act.performanceWords, segments: act.segments.map(segment => ({ segmentId: segment.segmentId, sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd, characters: segment.characters, words: segment.words, textSha256: segment.textSha256 })) })),
  };
}

function atomicJson(file, value) {
  const fs = fsDefault;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.rmSync(temp, { force: true }); } catch (_) {} }
}

function parseArgs(args) {
  const options = { mode: null, runId: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--help' || args[index] === '-h') options.mode = 'help';
    else if (args[index] === '--preflight') options.mode = 'preflight';
    else if (args[index] === '--execute') options.mode = 'execute';
    else if (args[index] === '--status') options.mode = 'status';
    else if (args[index] === '--verify-complete') options.mode = 'verify-complete';
    else if (args[index] === '--run-id') options.runId = args[++index];
    else throw new Error('UNKNOWN_ARGUMENT:' + args[index]);
  }
  if (!options.mode) throw new Error('USAGE_REQUIRED');
  if (options.mode !== 'help' && (!options.runId || !SAFE_RUN_ID.test(options.runId))) throw new Error('RUN_ID_REQUIRED: pass --run-id <safe-unique-id>.');
  return options;
}

function usage() {
  return 'Usage:\n  node /app/scripts/phase2.3b-p-run.cjs --preflight --run-id <unique-id>\n  node /app/scripts/phase2.3b-p-run.cjs --execute --run-id <same-id>\n  node /app/scripts/phase2.3b-p-run.cjs --status --run-id <same-id>\n  node /app/scripts/phase2.3b-p-run.cjs --verify-complete --run-id <same-id>\n\nPreflight makes no provider request. Execute requires a passing preflight report and is intended to run detached.';
}

async function verifyReviewOutputs({ episodeDirectory = SPEC.episodeDirectory, runId, fs = fsDefault, probeAudio } = {}) {
  if (!runId || !SAFE_RUN_ID.test(runId)) throw new Error('RUN_ID_REQUIRED');
  const reviewDirectory = path.join(episodeDirectory, '.review', 'phase2.3b-p-narration-' + runId);
  const state = readJson(fs, path.join(reviewDirectory, 'run-status.json'));
  if (state.state !== 'SUCCESS' || JSON.stringify(state.completedActs) !== JSON.stringify(SPEC.actOrder)) throw new Error('PACING_RUN_NOT_COMPLETE');
  const lockedHashes = verifyLockedFiles({ fs, episodeDirectory, spec: SPEC });
  const plan = readJson(fs, path.join(reviewDirectory, 'generation-plan.json'));
  const ledgerPath = path.join(reviewDirectory, 'request-ledger.jsonl');
  const ledgerText = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const ledger = ledgerText.trim() ? ledgerText.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) : [];
  const reservedCount = ledger.filter(item => item.eventType === 'reserved').length;
  const completionRecords = ledger.filter(item => item.eventType === 'segment-complete');
  if (reservedCount !== plan.totalSegments || completionRecords.length !== plan.totalSegments || state.completedSegments?.length !== plan.totalSegments) throw new Error('PACED_FINAL_LEDGER_COUNT_MISMATCH');
  const completedSegments = new Map(completionRecords.map(item => [item.segmentId, item]));
  if (completedSegments.size !== plan.totalSegments) throw new Error('PACED_FINAL_SEGMENT_DUPLICATE');
  if (reservedCount > plan.maximumRequests || plan.totalCharacters > plan.maximumCharacters) throw new Error('PACED_FINAL_BUDGET_INVALID');
  const responseRecords = ledger.filter(item => item.eventType === 'provider-response');
  if (responseRecords.length !== plan.totalSegments || responseRecords.some(item => !item.providerRequestId || item.httpStatus < 200 || item.httpStatus >= 300)) throw new Error('PACED_FINAL_PROVIDER_RESPONSE_INVALID');
  const probe = probeAudio || (file => require('../pipeline-updates/paced-narration-generator.cjs').probeMp3(file));
  const segmentAudits = [];
  for (const act of plan.acts) for (const segment of act.segments) {
    const record = completedSegments.get(segment.segmentId);
    if (!record || record.textSha256 !== segment.textSha256) throw new Error('PACED_SEGMENT_NOT_COMPLETE:' + segment.segmentId);
    const file = path.resolve(reviewDirectory, record.relativeAudioPath);
    if (!file.startsWith(path.resolve(reviewDirectory) + path.sep)) throw new Error('PACED_SEGMENT_PATH_INVALID:' + segment.segmentId);
    const bytes = fs.readFileSync(file);
    const digest = sha256(bytes);
    if (bytes.length !== record.audioBytes || digest !== record.audioSha256) throw new Error('PACED_SEGMENT_HASH_MISMATCH:' + segment.segmentId);
    const media = await probe(file);
    if (!(Number(media?.durationSec) > 0) || Math.abs(Number(media.durationSec) - Number(record.durationSec)) > 0.1) throw new Error('PACED_SEGMENT_PROBE_MISMATCH:' + segment.segmentId);
    segmentAudits.push({ segmentId: segment.segmentId, textSha256: segment.textSha256, audioSha256: digest, audioBytes: bytes.length, durationSec: Number(media.durationSec), providerRequestId: record.providerRequestId });
  }
  const joinedActs = [];
  for (const actKey of SPEC.actOrder) {
    const record = state.joinedActs?.[actKey];
    const filename = SPEC.voFilenames[actKey];
    const file = path.join(reviewDirectory, 'audio', filename);
    if (!record || !fs.existsSync(file)) throw new Error('PACED_JOINED_ACT_MISSING:' + actKey);
    const bytes = fs.readFileSync(file);
    const digest = sha256(bytes);
    if (bytes.length !== record.audioBytes || digest !== record.audioSha256 || record.relativeAudioPath !== path.relative(reviewDirectory, file).split(path.sep).join('/')) throw new Error('PACED_JOINED_ACT_HASH_MISMATCH:' + actKey);
    const media = await probe(file);
    if (!(Number(media?.durationSec) > 0) || Math.abs(Number(media.durationSec) - Number(record.durationSec)) > 0.1) throw new Error('PACED_JOINED_ACT_PROBE_MISMATCH:' + actKey);
    joinedActs.push({ actKey, filename, audioSha256: digest, audioBytes: bytes.length, durationSec: Number(media.durationSec), segmentIds: record.segmentIds, joinPauseDurationMs: record.joinPauseDurationMs });
  }
  const billedCharactersReported = responseRecords.reduce((sum, item) => sum + (Number.isSafeInteger(item.characterCost) && item.characterCost >= 0 ? item.characterCost : 0), 0);
  return { status: 'VERIFIED_SUCCESS', runId, reviewDirectory, lockedHashes, providerRequestCount: reservedCount, plannedCharacters: plan.totalCharacters, billedCharactersReported, completedSegmentCount: segmentAudits.length, segmentAudits, joinedActs };
}
async function runCli(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args);
  if (options.mode === 'help') return { status: 'HELP', usage: usage() };
  const fs = dependencies.fs || fsDefault;
  const episodeDirectory = dependencies.episodeDirectory || SPEC.episodeDirectory;
  const candidateDirectory = dependencies.candidateDirectory || SPEC.candidateDirectory;
  const outputDirectory = path.join(episodeDirectory, '.review', 'phase2.3b-p-narration-' + options.runId);
  if (options.mode === 'status') {
    const status = readJson(fs, path.join(outputDirectory, 'run-status.json'));
    return { status: 'RUN_STATUS', runStatus: status, reviewDirectory: outputDirectory };
  }
  if (options.mode === 'verify-complete') return verifyReviewOutputs({ episodeDirectory, runId: options.runId, fs, probeAudio: dependencies.probeAudio });
  verifyRailwayTarget(dependencies.env || process.env);
  const inputs = loadInputs({ fs, episodeDirectory, candidateDirectory, spec: SPEC });
  const dna = dependencies.channelDna || await (dependencies.resolveChannelDna || (key => require('/data/pipeline/config-reader.cjs').getChannelConfig(key)))(SPEC.channelKey);
  const credentialState = getCredentialState({ channelDna: dna, env: dependencies.env || process.env });
  if (!credentialState.credentialsPresent || !credentialState.voiceIdConfigured) throw new Error('PACING_CREDENTIAL_PREFLIGHT_FAILED');
  const activity = await inspectProductionActivity({ db: dependencies.db || require('/app/db').db, episodeId: SPEC.episodeId, episodeDirectory, fs, reviewOutputDirectory: outputDirectory });
  if (options.mode === 'preflight') {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const report = {
      schemaVersion: 'phase2.3b-p-preflight/1.0.0', status: 'PREFLIGHT_PASS', runId: options.runId,
      createdAt: new Date().toISOString(), lockedHashes: inputs.lockedHashes,
      planSha256: inputs.plan.planSha256, totalRequests: inputs.plan.totalSegments,
      totalBillableCharacters: inputs.plan.totalCharacters, requestCeiling: SPEC.maximumRequests,
      characterCeiling: SPEC.maximumCharacters, credentialsPresent: credentialState.credentialsPresent,
      voiceIdConfigured: credentialState.voiceIdConfigured, activity,
      audioGenerationRequests: 0, rootArtifactWrites: 0,
    };
    const planPath = path.join(outputDirectory, 'generation-plan.json');
    const preflightPath = path.join(outputDirectory, 'preflight-report.json');
    if (fs.existsSync(planPath) || fs.existsSync(preflightPath)) throw new Error('PACING_PREFLIGHT_OUTPUT_ALREADY_EXISTS');
    atomicJson(planPath, inputs.plan);
    atomicJson(preflightPath, report);
    return { ...report, plan: planSummary(inputs.plan), reviewDirectory: outputDirectory };
  }
  const preflightPath = path.join(outputDirectory, 'preflight-report.json');
  const preflight = readJson(fs, preflightPath);
  if (preflight.status !== 'PREFLIGHT_PASS' || preflight.runId !== options.runId || preflight.planSha256 !== inputs.plan.planSha256) throw new Error('PACING_PREFLIGHT_NOT_CURRENT');
  const globalLock = path.join(episodeDirectory, '.review', 'narration-pacing-active.lock');
  let fd;
  try { fd = fs.openSync(globalLock, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') throw new Error('NARRATION_PACING_LOCK_ACTIVE'); throw error; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, runId: options.runId, startedAt: new Date().toISOString() }), 'utf8');
    verifyLockedFiles({ fs, episodeDirectory, spec: SPEC });
    await inspectProductionActivity({ db: dependencies.db || require('/app/db').db, episodeId: SPEC.episodeId, episodeDirectory, fs, reviewOutputDirectory: outputDirectory });
    const narrationTexts = readCandidateTexts({ fs, candidateDirectory });
    const script = readJson(fs, path.join(episodeDirectory, 'script.json'));
    const actMap = buildActMap({ script, narrationTexts, spec: SPEC });
    const result = await runPacedNarration({
      channelKey: SPEC.channelKey, episodeDirectory, actMap,
      voiceSettings: SPEC.voiceSettings, outputFormat: SPEC.outputFormat,
      maximumSegmentLength: SPEC.maximumSegmentLength, joinPauseDurationMs: SPEC.joinPauseDurationMs,
      maximumRequests: SPEC.maximumRequests, maximumCharacters: SPEC.maximumCharacters,
      reviewOutputDirectory: outputDirectory, channelDna: dna,
    }, dependencies);
    return { status: result.status, runId: result.runId, reviewDirectory: result.reviewDirectory, plan: planSummary(result.plan), state: result.state };
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(globalLock, { force: true }); } catch (_) {}
  }
}

if (require.main === module) {
  runCli().then(result => {
    if (result.status === 'HELP') console.log(result.usage);
    else console.log(JSON.stringify(result.status === 'PREFLIGHT_PASS' ? { ...result, plan: result.plan } : result, null, 2));
  }).catch(error => { console.error('PHASE2_3B_P_FAILED:' + String(error.message || error)); process.exitCode = 1; });
}

module.exports = { SPEC, verifyPacingPackage, verifyLockedFiles, verifyReviewOutputs, buildActMap, makePlan, loadInputs, getCredentialState, inspectProductionActivity, verifyRailwayTarget, planSummary, parseArgs, usage, runCli };