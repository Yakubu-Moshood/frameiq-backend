'use strict';

// Stage A creates only quarantined review audio and byte-verified backups.
// It never writes to an active episode artifact path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { generateActVoice, MODEL, OUTPUT_FORMAT, APPROVED_VOICE_SETTINGS, sha256 } = require('../pipeline-updates/act-voice-generator.cjs');

const EPISODE = '/data/episodes/EmpireOmitted_V3_SHADOW_WELLSFARGO';
const CANDIDATE = process.env.EO_SG_CANDIDATE_DIR || '/app/artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate';
const GLOBAL_LEDGER = path.join(EPISODE, '.review', 'phase2.3b-sg-request-ledger.json');
const CHANNEL_KEY = 'EmpireOmitted';
const EPISODE_ID = 'e59b6b79-96aa-4dcd-92c3-749fd536f55e';
const ACT_KEYS = ['act3b', 'act4'];
const LIMITS = Object.freeze({ maximumProviderRequests: 2, maximumCharacters: 2457, maximumCharactersPerAct: 2600 });
const EXPECTED = {
  'script.json': 'b9da1e3977d0d0bcd6b246c70c8f17b4a2aa4c2bd7284ca587e4b5749d25aec8',
  'edit-plan.json': '33f5a89fb724bdc8982f85fd9cf8ff223f6e1031bfa557a6f8df609f44bf5337',
  'edit-plan-validation.json': 'b4c37ca8e5c24115e21f218a654bcc2de21368d947f62e159067aedb09616fac',
  'assets/audio/VO_Act3B.mp3': '05f9f48849f2ac94e88ed7b368c1da8a6cb3f833497ef913886cce8300a70d06',
  'shot-definitions.json': '8f878f023cff679b83dad6c5b4c4a1535ff07cdc397cdf7467a45d2d6396d0cb',
  'production-manifest.json': '7d03890ae197d05afa865c7607c1371ca3d9b0c68251b91dbe2056a8c37782ca',
};
const TEXT = {
  act3b: { sha256: 'ff9ab4bbe43c3f25844b6e6231abaa462cde3692dcd9e57f4c319dda168a0e49', characters: 961, filename: 'VO_Act3B.mp3' },
  act4: { sha256: '26d10ba68ea1aa328bc26160e4f795545dc0f02fabbe3717e57187b161be8338', characters: 1496, filename: 'VO_Act4.mp3' },
};
const now = () => new Date().toISOString();
const hashFile = file => sha256(fs.readFileSync(file));
const atomicJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { try { fs.rmSync(tmp, { force: true }); } catch (_) {} }
};
function appendLog(file, entry) { fs.appendFileSync(file, `${JSON.stringify({ at: now(), ...entry })}\n`, { flag: 'a' }); }
function matchingLedgerAttempts(ledger, actKey, textSha256) {
  return (ledger?.attempts || []).filter(item => item.channel === CHANNEL_KEY && item.episodeId === EPISODE_ID
    && item.actKey === actKey && item.textSha256 === textSha256);
}
function refreshAttemptCounts(status, ledger) {
  for (const actKey of ACT_KEYS) {
    const spec = TEXT[actKey];
    const attempts = matchingLedgerAttempts(ledger, actKey, spec.sha256);
    status.attemptsByAct[actKey] = attempts.length;
    status.completedAttemptsByAct[actKey] = attempts.filter(item => item.status === 'COMPLETE').length;
  }
  return status.attemptsByAct;
}
function markPreReservationFailure(status, actKey, ledger, error) {
  const attempts = matchingLedgerAttempts(ledger, actKey, TEXT[actKey].sha256);
  refreshAttemptCounts(status, ledger);
  status.currentAct = null;
  if (attempts.length === 0) {
    status.preReservationFailuresByAct[actKey] += 1;
    status.actStates[actKey] = { state: 'PRE_RESERVATION_FAILURE', failedAt: now(), errorCode: String(error.message || 'ACT_FAILED').split(':')[0] };
  } else {
    const latest = attempts.at(-1);
    status.actStates[actKey] = {
      state: latest.status === 'COMPLETE' ? 'COMPLETED_PROVIDER_ATTEMPT' : 'FAILED_AFTER_RESERVATION',
      requestId: latest.requestId, requestStatus: latest.status, finishedAt: latest.finishedAt || null,
      errorCode: latest.errorCode || String(error.message || 'ACT_FAILED').split(':')[0],
    };
  }
  return status.actStates[actKey];
}
function verifyCandidatePackage(candidateDir = CANDIDATE) {
  const packageManifest = JSON.parse(fs.readFileSync(path.join(candidateDir, 'candidate-package-sha256.json'), 'utf8'));
  for (const [relative, expected] of Object.entries(packageManifest.files || {})) {
    const file = path.resolve(candidateDir, relative);
    if (!file.startsWith(`${path.resolve(candidateDir)}${path.sep}`) || !fs.existsSync(file)) throw new Error(`CANDIDATE_PACKAGE_FILE_MISSING:${relative}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expected.bytes || hashFile(file) !== expected.sha256) throw new Error(`CANDIDATE_PACKAGE_HASH_MISMATCH:${relative}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(candidateDir, 'source-hash-manifest.json'), 'utf8'));
  const captureKeys = {
    'script.json': 'script', 'edit-plan.json': 'editPlan', 'edit-plan-validation.json': 'validation',
    'assets/audio/VO_Act3B.mp3': 'act3bAudio', 'shot-definitions.json': 'shotDefinitions',
    'production-manifest.json': 'productionManifest',
  };
  for (const [relative, key] of Object.entries(captureKeys)) {
    if (manifest.files?.[key]?.sha256 !== EXPECTED[relative]) throw new Error(`SOURCE_CAPTURE_EXPECTATION_MISSING:${relative}`);
  }
  const narration = JSON.parse(fs.readFileSync(path.join(candidateDir, 'narration-texts.json'), 'utf8'));
  for (const [actKey, spec] of Object.entries(TEXT)) {
    const text = narration[actKey]?.next;
    if (typeof text !== 'string' || text.length !== spec.characters || sha256(text) !== spec.sha256) throw new Error(`APPROVED_TEXT_MISMATCH:${actKey}`);
  }
  return { candidateDir: path.resolve(candidateDir), filesVerified: Object.keys(packageManifest.files).length, actsVerified: Object.keys(TEXT) };
}
function checkLiveHashes() {
  verifyCandidatePackage();
  const hashes = {};
  for (const [relative, expected] of Object.entries(EXPECTED)) {
    const file = path.join(EPISODE, relative);
    if (!fs.existsSync(file)) throw new Error(`LIVE_INPUT_MISSING:${relative}`);
    hashes[relative] = hashFile(file);
    if (hashes[relative] !== expected) throw new Error(`LIVE_HASH_MISMATCH:${relative}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(CANDIDATE, 'source-hash-manifest.json'), 'utf8'));
  const packageManifest = JSON.parse(fs.readFileSync(path.join(CANDIDATE, 'candidate-package-sha256.json'), 'utf8'));
  const manifestLock = packageManifest.files?.['source-hash-manifest.json'];
  if (!manifestLock || hashFile(path.join(CANDIDATE, 'source-hash-manifest.json')) !== manifestLock.sha256) throw new Error('SOURCE_MANIFEST_LOCK_MISMATCH');
  for (const item of Object.values(manifest.files)) {
    const livePath = path.resolve(item.remotePath);
    if (!livePath.startsWith(`${path.resolve(EPISODE)}${path.sep}`) || !fs.existsSync(livePath)) throw new Error(`LIVE_CAPTURE_PATH_MISSING:${item.localFile}`);
    hashes[item.localFile] = hashFile(livePath);
    if (hashes[item.localFile] !== item.sha256) throw new Error(`LIVE_CAPTURE_HASH_MISMATCH:${item.localFile}`);
  }
  return hashes;
}
function backupTargets() {
  const statusPath = path.join(EPISODE, 'edit-plan-shadow-status.json');
  if (!fs.existsSync(statusPath)) throw new Error('SHADOW_STATUS_MISSING');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const cache = status.timingCache;
  if (typeof cache !== 'string' || !cache.trim()) throw new Error('TIMING_CACHE_LOCATION_MISSING');
  const cachePath = path.resolve(EPISODE, cache, 'word-timestamps.json');
  if (!cachePath.startsWith(`${path.resolve(EPISODE)}${path.sep}`) || !fs.existsSync(cachePath)) throw new Error('TIMING_CACHE_INVALID');
  return [
    'script.json', 'assets/audio/VO_Act3B.mp3', 'assets/audio/VO_Act4.mp3',
    'edit-plan.json', 'edit-plan-validation.json', 'edit-plan-shadow-status.json',
    'shot-definitions.json', 'production-manifest.json', 'evidence-source-manifest.json',
    'proof-section-plan.json', path.relative(EPISODE, cachePath),
  ];
}
function createBackups(root, targets) {
  const dir = path.join(root, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const records = [];
  for (const rel of targets) {
    const source = path.join(EPISODE, rel);
    const destination = path.join(dir, rel);
    if (!fs.existsSync(source)) { records.push({ relativePath: rel, existed: false, sha256: null, bytes: 0 }); continue; }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) {
      if (hashFile(destination) !== hashFile(source)) throw new Error(`BACKUP_CONFLICT:${rel}`);
    } else {
      const tmp = `${destination}.${process.pid}.tmp`;
      fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL);
      if (hashFile(tmp) !== hashFile(source)) { fs.rmSync(tmp, { force: true }); throw new Error(`BACKUP_HASH_MISMATCH:${rel}`); }
      fs.renameSync(tmp, destination);
    }
    records.push({ relativePath: rel, existed: true, sha256: hashFile(destination), bytes: fs.statSync(destination).size });
  }
  atomicJson(path.join(root, 'backup-manifest.json'), { schemaVersion: 'phase2.3b-sg-backups/1.0.0', createdAt: now(), files: records });
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    const verification = verifyCandidatePackage();
    console.log(JSON.stringify({ status: 'PREFLIGHT_PASS', ...verification, providerRequests: 0, episodeWrites: 0 }, null, 2));
    return;
  }
  const runId = process.env.EO_VOICE_RUN_ID;
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/.test(runId)) throw new Error('EO_VOICE_RUN_ID must be a unique safe 6–64 character token.');
  if (process.env.RAILWAY_PROJECT_ID && process.env.RAILWAY_PROJECT_ID !== '98a75a00-ce8e-4a7a-833e-ff76d3bdefea') throw new Error('WRONG_RAILWAY_PROJECT');
  if (process.env.RAILWAY_ENVIRONMENT_ID && process.env.RAILWAY_ENVIRONMENT_ID !== '6fa50efc-d4bc-4ea1-9c6e-c9daa9336b34') throw new Error('WRONG_RAILWAY_ENVIRONMENT');
  if (process.env.RAILWAY_SERVICE_ID && process.env.RAILWAY_SERVICE_ID !== 'd965705e-d5e7-4f4e-ac58-fc6b1959c81f') throw new Error('WRONG_RAILWAY_SERVICE');
  const root = path.join(EPISODE, '.review', `phase2.3b-sg-${runId}`);
  const lock = path.join(root, 'stage-a.lock');
  const globalLock = path.join(EPISODE, '.review', 'phase2.3b-sg-active.lock');
  fs.mkdirSync(root, { recursive: true });
  let fd; let globalFd;
  try {
    globalFd = fs.openSync(globalLock, 'wx', 0o600);
    fd = fs.openSync(lock, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ runId, pid: process.pid, createdAt: now() }));
    fs.writeFileSync(globalFd, JSON.stringify({ runId, pid: process.pid, createdAt: now() }));
  } catch (error) {
    try { if (fd !== undefined) { fs.closeSync(fd); fs.rmSync(lock, { force: true }); } } catch (_) {}
    try { if (globalFd !== undefined) { fs.closeSync(globalFd); fs.rmSync(globalLock, { force: true }); } } catch (_) {}
    if (error?.code === 'EEXIST') throw new Error('RUN_LOCK_EXISTS: inspect process state before proceeding.');
    throw error;
  }
  const logPath = path.join(root, 'generation.jsonl');
  const statusPath = path.join(root, 'run-status.json');
  const status = {
    schemaVersion: 'phase2.3b-sg-run/1.1.0', runId, pid: process.pid, startedAt: now(), updatedAt: now(),
    state: 'PREPARING', currentAct: null, completedActs: [], attemptsByAct: { act3b: 0, act4: 0 },
    completedAttemptsByAct: { act3b: 0, act4: 0 }, invocationsByAct: { act3b: 0, act4: 0 },
    preReservationFailuresByAct: { act3b: 0, act4: 0 },
    actStates: { act3b: { state: 'NOT_STARTED' }, act4: { state: 'NOT_STARTED' } },
    maximumProviderRequests: LIMITS.maximumProviderRequests, totalCharacters: LIMITS.maximumCharacters,
  };
  atomicJson(path.join(root, 'stage-a.pid.json'), { runId, pid: process.pid, startedAt: status.startedAt });
  const heartbeat = setInterval(() => { status.updatedAt = now(); try { atomicJson(statusPath, status); } catch (_) {} }, 15000);
  const oldLog = console.log;
  console.log = (...args) => { const line = args.map(String).join(' '); appendLog(logPath, { type: 'generator', message: line }); oldLog(...args); };
  try {
    const live = checkLiveHashes();
    status.liveHashes = live; status.updatedAt = now();
    const startingLedger = fs.existsSync(GLOBAL_LEDGER) ? JSON.parse(fs.readFileSync(GLOBAL_LEDGER, 'utf8')) : { attempts: [] };
    refreshAttemptCounts(status, startingLedger);
    createBackups(root, backupTargets());
    const narration = JSON.parse(fs.readFileSync(path.join(CANDIDATE, 'narration-texts.json'), 'utf8'));
    const ledgerPath = GLOBAL_LEDGER;
    status.state = 'GENERATING'; atomicJson(statusPath, status); appendLog(logPath, { type: 'run-start', runId, liveHashes: live });
    for (const actKey of ['act3b', 'act4']) {
      const spec = TEXT[actKey]; const text = narration[actKey]?.next;
      if (typeof text !== 'string' || text.length !== spec.characters || sha256(text) !== spec.sha256) throw new Error(`APPROVED_TEXT_MISMATCH:${actKey}`);
      const outputPath = path.join(root, 'audio', spec.filename);
      const previous = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : { attempts: [] };
      const attempts = matchingLedgerAttempts(previous, actKey, spec.sha256);
      status.attemptsByAct[actKey] = attempts.length;
      status.completedAttemptsByAct[actKey] = attempts.filter(item => item.status === 'COMPLETE').length;
      const prior = attempts[0];
      if (fs.existsSync(outputPath) && prior?.status === 'COMPLETE' && hashFile(outputPath) === prior.audioSha256) {
        if (!status.completedActs.includes(actKey)) status.completedActs.push(actKey);
        status.actStates[actKey] = { state: 'COMPLETED_PROVIDER_ATTEMPT', requestId: prior.requestId, reused: true };
        status.updatedAt = now(); atomicJson(statusPath, status); appendLog(logPath, { type: 'act-reused-verified', actKey, audioSha256: prior.audioSha256 }); continue;
      }
      if (prior || fs.existsSync(outputPath) || fs.existsSync(`${outputPath}.partial`)) throw new Error(`ACT_STATE_UNCERTAIN:${actKey}: preserve output and ledger; no retry is permitted.`);
      status.currentAct = actKey; status.invocationsByAct[actKey] += 1;
      status.actStates[actKey] = { state: 'ACT_INVOKED', invocation: status.invocationsByAct[actKey], invokedAt: now() };
      status.updatedAt = now(); atomicJson(statusPath, status);
      appendLog(logPath, { type: 'act-invoked', actKey, invocation: status.invocationsByAct[actKey] });
      let report;
      try {
        report = await generateActVoice({
          channel: CHANNEL_KEY, episodeId: EPISODE_ID, actKey, text,
          expectedTextSha256: spec.sha256, outputPath, ledgerPath, model: MODEL, outputFormat: OUTPUT_FORMAT,
          voiceSettings: { ...APPROVED_VOICE_SETTINGS }, maximumCharacters: LIMITS.maximumCharactersPerAct,
          maximumRequests: LIMITS.maximumProviderRequests, allowOverwrite: false,
        }, {
          onRequestReserved: reservation => {
            const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
            refreshAttemptCounts(status, ledger);
            status.actStates[actKey] = { state: 'RESERVED_PROVIDER_ATTEMPT', requestId: reservation.requestId, reservedAt: reservation.startedAt };
            status.updatedAt = now(); atomicJson(statusPath, status);
            appendLog(logPath, { type: 'provider-attempt-reserved', actKey, requestId: reservation.requestId, reservedAt: reservation.startedAt });
          },
        });
      } catch (error) {
        const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : { attempts: [] };
        const actState = markPreReservationFailure(status, actKey, ledger, error);
        status.updatedAt = now(); atomicJson(statusPath, status);
        appendLog(logPath, { type: actState.state === 'PRE_RESERVATION_FAILURE' ? 'pre-reservation-failure' : 'provider-attempt-failure', actKey, ...actState });
        throw error;
      }
      atomicJson(path.join(root, 'request-ledger.json'), JSON.parse(fs.readFileSync(ledgerPath, 'utf8')));
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      refreshAttemptCounts(status, ledger);
      status.completedActs.push(actKey);
      status.actStates[actKey] = { state: 'COMPLETED_PROVIDER_ATTEMPT', requestId: report.requestId, completedAt: report.finishedAt };
      status.currentAct = null; status.updatedAt = now(); atomicJson(statusPath, status);
      appendLog(logPath, { type: 'act-complete', ...report });
    }
    status.state = 'SUCCESS'; status.finishedAt = now(); status.updatedAt = now(); atomicJson(statusPath, status);
    atomicJson(path.join(root, 'stage-a-report.json'), { ...status, requestLedger: JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) });
    console.log(JSON.stringify({ status: 'SUCCESS', runId, completedActs: status.completedActs, totalCharacters: LIMITS.maximumCharacters, maximumProviderRequests: LIMITS.maximumProviderRequests, outputDirectory: path.join(root, 'audio') }, null, 2));
  } catch (error) {
    try {
      if (fs.existsSync(GLOBAL_LEDGER)) {
        const ledger = JSON.parse(fs.readFileSync(GLOBAL_LEDGER, 'utf8'));
        refreshAttemptCounts(status, ledger);
        atomicJson(path.join(root, 'request-ledger.json'), ledger);
      }
    } catch (_) {}
    status.state = 'FAILURE'; status.errorCode = String(error.message || 'STAGE_A_FAILED').split(':')[0]; status.updatedAt = now(); status.finishedAt = now();
    try { atomicJson(statusPath, status); appendLog(logPath, { type: 'failure', errorCode: status.errorCode, message: error.message }); } catch (_) {}
    console.error(JSON.stringify({ status: 'FAILURE', runId, completedActs: status.completedActs, attemptsByAct: status.attemptsByAct, errorCode: status.errorCode, reviewDirectory: root }, null, 2));
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    console.log = oldLog;
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(lock, { force: true }); } catch (_) {}
    try { fs.closeSync(globalFd); } catch (_) {}
    try { fs.rmSync(globalLock, { force: true }); } catch (_) {}
  }
}
if (require.main === module) main().catch(error => { console.error(`STAGE_A_FATAL:${String(error.message || 'failure').split(':')[0]}`); process.exitCode = 1; });

module.exports = { verifyCandidatePackage, refreshAttemptCounts, markPreReservationFailure, CHANNEL_KEY, EPISODE_ID, ACT_KEYS, TEXT, LIMITS };
