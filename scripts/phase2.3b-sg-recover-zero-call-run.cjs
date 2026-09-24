'use strict';

// This recovery utility is intentionally limited to the named Railway staging run.
// It is prepared for remote invocation and must not be run against a local fixture.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TARGET = Object.freeze({
  projectId: '98a75a00-ce8e-4a7a-833e-ff76d3bdefea',
  environmentId: '6fa50efc-d4bc-4ea1-9c6e-c9daa9336b34',
  serviceId: 'd965705e-d5e7-4f4e-ac58-fc6b1959c81f',
  episodeRoot: '/data/episodes/EmpireOmitted_V3_SHADOW_WELLSFARGO',
  runId: 'eo-v3-sg-20260924-1738z-5cdf5b5',
});
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function walkFiles(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(target));
    else if (entry.isFile()) found.push(target);
  }
  return found;
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}

function auditFailedRun({ episodeRoot = TARGET.episodeRoot, runId = TARGET.runId, processAlive = pidIsAlive } = {}) {
  if (runId !== TARGET.runId) throw new Error('RECOVERY_RUN_ID_MISMATCH');
  const runDir = path.join(episodeRoot, '.review', `phase2.3b-sg-${runId}`);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) throw new Error('FAILED_RUN_DIRECTORY_MISSING');
  const statusPath = path.join(runDir, 'run-status.json');
  const journalPath = path.join(runDir, 'generation.jsonl');
  if (!fs.existsSync(statusPath) || !fs.existsSync(journalPath)) throw new Error('RUN_EVIDENCE_MISSING');
  const status = readJson(statusPath);
  if (status.runId !== runId || status.state !== 'FAILURE') throw new Error('RUN_NOT_CONFIRMED_FAILURE');
  if (!Array.isArray(status.completedActs) || status.completedActs.length !== 0) throw new Error('RUN_HAS_COMPLETED_ACTS');
  if (status.attemptsByAct && Object.values(status.attemptsByAct).some(value => value !== 0)) throw new Error('RUN_STATUS_REPORTS_PROVIDER_ATTEMPTS');
  if (status.completedAttemptsByAct && Object.values(status.completedAttemptsByAct).some(value => value !== 0)) throw new Error('RUN_STATUS_REPORTS_COMPLETED_PROVIDER_ATTEMPTS');

  const pidFile = path.join(runDir, 'stage-a.pid.json');
  const pidRecord = fs.existsSync(pidFile) ? readJson(pidFile) : null;
  if (processAlive(status.pid) || processAlive(pidRecord?.pid)) throw new Error('RUN_PROCESS_STILL_ACTIVE');
  const files = walkFiles(runDir);
  const reviewRoot = path.join(episodeRoot, '.review');
  const lockFiles = [
    path.join(runDir, 'stage-a.lock'), path.join(runDir, 'stage-b.lock'),
    path.join(runDir, 'request-ledger.json.lock'), path.join(reviewRoot, 'phase2.3b-sg-active.lock'),
    path.join(reviewRoot, 'phase2.3b-sg-request-ledger.json.lock'),
  ];
  if (lockFiles.some(file => fs.existsSync(file)) || files.some(file => file.endsWith('.lock'))) throw new Error('ACTIVE_OR_STALE_LOCK_REQUIRES_INSPECTION');
  const sharedLedger = path.join(reviewRoot, 'phase2.3b-sg-request-ledger.json');
  if (fs.existsSync(sharedLedger) || fs.existsSync(path.join(runDir, 'request-ledger.json'))) throw new Error('REQUEST_LEDGER_PRESENT');

  if (files.some(file => /[\\/]audio[\\/]/i.test(file) || /\.(?:mp3|wav|m4a|aac|ogg|partial)$/i.test(file))) throw new Error('AUDIO_OR_PARTIAL_PRESENT');
  const eventMarker = /(?:provider[-_ ]?attempt[-_ ]?(?:reserved|started)|\bRESERVED\b|provider[-_ ]?(?:request|response)|http[-_ ]?(?:request|response)|elevenlabs[-_ ]?(?:request|response)|["']?(?:requestId|requestStatus|httpStatus)["']?\s*:)/i;
  for (const file of files.filter(item => /\.(?:json|jsonl|log|txt)$/i.test(item))) {
    const text = fs.readFileSync(file, 'utf8');
    if (eventMarker.test(text)) throw new Error(`PROVIDER_EVENT_EVIDENCE_PRESENT:${path.relative(runDir, file)}`);
  }

  const statusBytes = fs.readFileSync(statusPath);
  const journalBytes = fs.readFileSync(journalPath);
  const logPath = files.find(file => /(?:^|[\\/])(?:generation|run)\.log$/i.test(file)) || journalPath;
  const logBytes = fs.readFileSync(logPath);
  return {
    runDir, runId, state: status.state, completedActs: status.completedActs,
    attemptsByAct: status.attemptsByAct || null,
    checks: { failureState: true, noCompletedActs: true, processInactive: true, noLocks: true, noRequestLedger: true, noProviderEvents: true, noAudioOrPartial: true },
    evidence: {
      runStatus: { path: path.relative(runDir, statusPath), sha256: sha256(statusBytes), bytes: statusBytes.length },
      log: { path: path.relative(runDir, logPath), sha256: sha256(logBytes), bytes: logBytes.length },
      generationJournal: { path: path.relative(runDir, journalPath), sha256: sha256(journalBytes), bytes: journalBytes.length },
      sameLogAndJournal: logPath === journalPath,
      providerLedger: { path: path.relative(episodeRoot, sharedLedger), exists: false },
      audioFiles: [],
      observedEvents: ['channel-config-lookup-failed-before-request-reservation'],
    },
  };
}

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { try { fs.rmSync(temp, { force: true }); } catch (_) {} }
}

function archiveFailedRun({ episodeRoot = TARGET.episodeRoot, runId = TARGET.runId, env = process.env } = {}) {
  if (env.RAILWAY_PROJECT_ID !== TARGET.projectId || env.RAILWAY_ENVIRONMENT_ID !== TARGET.environmentId
    || env.RAILWAY_SERVICE_ID !== TARGET.serviceId) throw new Error('WRONG_RAILWAY_TARGET');
  const report = auditFailedRun({ episodeRoot, runId });
  const runDir = report.runDir;
  const recoveryRecord = {
    schemaVersion: 'phase2.3b-sg-zero-call-recovery/1.0.0',
    archivedAt: new Date().toISOString(),
    target: { ...TARGET },
    classification: 'FAILED_BEFORE_PROVIDER_RESERVATION_ZERO_PAID_REQUESTS',
    audit: report,
  };
  const archiveDir = path.join(episodeRoot, '.review', 'failed-run-archive');
  const destination = path.join(archiveDir, runId);
  if (fs.existsSync(destination)) throw new Error('FAILED_RUN_ARCHIVE_DESTINATION_EXISTS');
  atomicJson(path.join(runDir, 'recovery-record.json'), recoveryRecord);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.renameSync(runDir, destination);
  return { ...recoveryRecord, archivedPath: destination };
}

if (require.main === module) {
  try {
    const result = archiveFailedRun();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`ZERO_CALL_RECOVERY_REFUSED:${String(error.message || error)}`);
    process.exitCode = 1;
  }
}

module.exports = { TARGET, auditFailedRun, archiveFailedRun, walkFiles, sha256 };
