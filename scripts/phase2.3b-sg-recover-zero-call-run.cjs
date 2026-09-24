'use strict';

// Zero-call recovery is restricted to one named Railway staging failure. The CLI
// never selects a run implicitly; --dry-run audits only and never moves files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TARGET = Object.freeze({
  projectId: '98a75a00-ce8e-4a7a-833e-ff76d3bdefea',
  environmentId: '6fa50efc-d4bc-4ea1-9c6e-c9daa9336b34',
  serviceId: 'd965705e-d5e7-4f4e-ac58-fc6b1959c81f',
  episodeRoot: '/data/episodes/EmpireOmitted_V3_SHADOW_WELLSFARGO',
  episodeId: 'e59b6b79-96aa-4dcd-92c3-749fd536f55e',
  runId: 'eo-v3-sg-20260924-1738z-5cdf5b5',
});
const EXPECTED_EPISODE_HASHES = Object.freeze({
  'script.json': 'b9da1e3977d0d0bcd6b246c70c8f17b4a2aa4c2bd7284ca587e4b5749d25aec8',
  'edit-plan.json': '33f5a89fb724bdc8982f85fd9cf8ff223f6e1031bfa557a6f8df609f44bf5337',
  'edit-plan-validation.json': 'b4c37ca8e5c24115e21f218a654bcc2de21368d947f62e159067aedb09616fac',
  'assets/audio/VO_Act3B.mp3': '05f9f48849f2ac94e88ed7b368c1da8a6cb3f833497ef913886cce8300a70d06',
  'shot-definitions.json': '8f878f023cff679b83dad6c5b4c4a1535ff07cdc397cdf7467a45d2d6396d0cb',
  'production-manifest.json': '7d03890ae197d05afa865c7607c1371ca3d9b0c68251b91dbe2056a8c37782ca',
});
const ARCHIVE_VERSION = 'phase2.3b-sg-zero-call-recovery-v1';
const USAGE = [
  'Usage: node /app/scripts/phase2.3b-sg-recover-zero-call-run.cjs --run-id <id> [--dry-run]',
  '       EO_SG_RECOVERY_RUN_ID=<id> node /app/scripts/phase2.3b-sg-recover-zero-call-run.cjs [--dry-run]',
  `Allowed run ID: ${TARGET.runId}`,
  '--help prints this text without inspecting or changing any run.',
  '--dry-run verifies the failed run and locked episode hashes, then exits without moving or writing files.',
].join('\n');
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

function verifyLockedEpisodeHashes(episodeRoot = TARGET.episodeRoot) {
  const hashes = {};
  for (const [relative, expected] of Object.entries(EXPECTED_EPISODE_HASHES)) {
    const file = path.join(episodeRoot, relative);
    if (!fs.existsSync(file)) throw new Error(`LOCKED_EPISODE_FILE_MISSING:${relative}`);
    const actual = sha256(fs.readFileSync(file));
    hashes[relative] = actual;
    if (actual !== expected) throw new Error(`LOCKED_EPISODE_HASH_MISMATCH:${relative}`);
  }
  return hashes;
}

function readLedgerEvidence(ledgerPath, runDir) {
  if (!fs.existsSync(ledgerPath)) return { path: path.relative(runDir, ledgerPath), exists: false, attempts: 0, reservations: [] };
  let ledger;
  try { ledger = readJson(ledgerPath); }
  catch (_) { throw new Error(`REQUEST_LEDGER_UNREADABLE:${path.relative(runDir, ledgerPath)}`); }
  if (!ledger || !Array.isArray(ledger.attempts)) throw new Error(`REQUEST_LEDGER_INVALID:${path.relative(runDir, ledgerPath)}`);
  const reservations = ledger.attempts.filter(item => item?.channel === 'EmpireOmitted' && item?.episodeId === TARGET.episodeId);
  if (reservations.length) throw new Error(`PROVIDER_REQUEST_LEDGER_ENTRY_FOUND:${path.relative(runDir, ledgerPath)}`);
  return { path: path.relative(runDir, ledgerPath), exists: true, attempts: ledger.attempts.length, reservations: [] };
}

function auditFailedRun({ episodeRoot = TARGET.episodeRoot, runId, processAlive = pidIsAlive, verifyEpisodeHashes = verifyLockedEpisodeHashes } = {}) {
  if (runId !== TARGET.runId) throw new Error('RECOVERY_RUN_ID_MISMATCH');
  const runDir = path.join(episodeRoot, '.review', `phase2.3b-sg-${runId}`);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) throw new Error('FAILED_RUN_DIRECTORY_MISSING');
  const statusPath = path.join(runDir, 'run-status.json');
  const journalPath = path.join(runDir, 'generation.jsonl');
  if (!fs.existsSync(statusPath) || !fs.existsSync(journalPath)) throw new Error('RUN_EVIDENCE_MISSING');
  const status = readJson(statusPath);
  if (status.runId !== runId || status.state !== 'FAILURE') throw new Error('RUN_NOT_CONFIRMED_FAILURE');
  if (!Array.isArray(status.completedActs) || status.completedActs.length !== 0) throw new Error('RUN_HAS_COMPLETED_ACTS');

  const pidFile = path.join(runDir, 'stage-a.pid.json');
  const pidRecord = fs.existsSync(pidFile) ? readJson(pidFile) : null;
  if (processAlive(status.pid) || processAlive(pidRecord?.pid)) throw new Error('RUN_PROCESS_STILL_ACTIVE');
  const files = walkFiles(runDir);
  const reviewRoot = path.join(episodeRoot, '.review');
  const lockPaths = [
    path.join(runDir, 'stage-a.lock'), path.join(runDir, 'stage-b.lock'),
    path.join(runDir, 'request-ledger.json.lock'), path.join(reviewRoot, 'phase2.3b-sg-active.lock'),
    path.join(reviewRoot, 'phase2.3b-sg-request-ledger.json.lock'),
  ];
  if (lockPaths.some(file => fs.existsSync(file)) || files.some(file => file.endsWith('.lock'))) throw new Error('ACTIVE_OR_STALE_LOCK_REQUIRES_INSPECTION');

  const sharedLedger = path.join(reviewRoot, 'phase2.3b-sg-request-ledger.json');
  const localLedger = path.join(runDir, 'request-ledger.json');
  const ledgerEvidence = [readLedgerEvidence(sharedLedger, runDir), readLedgerEvidence(localLedger, runDir)];

  const audioFiles = files.filter(file => /[\\/]audio[\\/]/i.test(file)
    || /\.(?:mp3|wav|m4a|aac|ogg|partial)$/i.test(file));
  if (audioFiles.length) throw new Error(`AUDIO_OR_PARTIAL_PRESENT:${path.relative(runDir, audioFiles[0])}`);
  const eventMarker = /(?:provider[-_ ]?attempt[-_ ]?(?:reserved|started)|\bRESERVED\b|provider[-_ ]?(?:request|response)|http[-_ ]?(?:request|response)|elevenlabs[-_ ]?(?:request|response)|["']?(?:requestId|requestStatus|httpStatus)["']?\s*:)/i;
  for (const file of files.filter(item => /\.(?:json|jsonl|log|txt)$/i.test(item))) {
    if (eventMarker.test(fs.readFileSync(file, 'utf8'))) throw new Error(`PROVIDER_EVENT_EVIDENCE_PRESENT:${path.relative(runDir, file)}`);
  }

  const episodeHashes = verifyEpisodeHashes(episodeRoot);
  const statusBytes = fs.readFileSync(statusPath);
  const journalBytes = fs.readFileSync(journalPath);
  const logPath = files.find(file => /(?:^|[\\/])(?:generation|run)\.log$/i.test(file)) || journalPath;
  const logBytes = fs.readFileSync(logPath);
  return {
    runDir, runId, state: status.state, completedActs: status.completedActs,
    legacyInvocationCounters: status.attemptsByAct || null,
    checks: { failureState: true, noCompletedActs: true, processInactive: true, noLocks: true, noProviderLedgerReservations: true, noProviderEvents: true, noAudioOrPartial: true, lockedEpisodeHashesMatch: true },
    evidence: {
      runStatus: { path: path.relative(runDir, statusPath), sha256: sha256(statusBytes), bytes: statusBytes.length },
      log: { path: path.relative(runDir, logPath), sha256: sha256(logBytes), bytes: logBytes.length },
      generationJournal: { path: path.relative(runDir, journalPath), sha256: sha256(journalBytes), bytes: journalBytes.length },
      sameLogAndJournal: logPath === journalPath,
      ledgers: ledgerEvidence,
      providerEvents: [], audioFiles: [], episodeHashes,
      legacyInvocationCounters: status.attemptsByAct || null,
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

function archiveFailedRun({ episodeRoot = TARGET.episodeRoot, runId, env = process.env, processAlive = pidIsAlive, verifyEpisodeHashes = verifyLockedEpisodeHashes } = {}) {
  if (env.RAILWAY_PROJECT_ID !== TARGET.projectId || env.RAILWAY_ENVIRONMENT_ID !== TARGET.environmentId
    || env.RAILWAY_SERVICE_ID !== TARGET.serviceId) throw new Error('WRONG_RAILWAY_TARGET');
  const report = auditFailedRun({ episodeRoot, runId, processAlive, verifyEpisodeHashes });
  const archiveDir = path.join(episodeRoot, '.review', 'failed-run-archive', ARCHIVE_VERSION);
  const destination = path.join(archiveDir, runId);
  const recoveryRecordPath = path.join(archiveDir, `${runId}.recovery-record.json`);
  if (fs.existsSync(destination) || fs.existsSync(recoveryRecordPath)) throw new Error('FAILED_RUN_ARCHIVE_DESTINATION_EXISTS');
  const recoveryRecord = {
    schemaVersion: 'phase2.3b-sg-zero-call-recovery/1.0.0', archivedAt: new Date().toISOString(),
    target: { ...TARGET }, classification: 'FAILED_BEFORE_PROVIDER_RESERVATION_ZERO_PAID_REQUESTS', audit: report,
  };
  fs.mkdirSync(archiveDir, { recursive: true });
  const tempRecord = `${recoveryRecordPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempRecord, `${JSON.stringify(recoveryRecord, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(report.runDir, destination);
    fs.renameSync(tempRecord, recoveryRecordPath);
  } finally { try { fs.rmSync(tempRecord, { force: true }); } catch (_) {} }
  return { ...recoveryRecord, archivedPath: destination, recoveryRecordPath };
}

function parseArgs(args, env = process.env) {
  const parsed = { help: false, dryRun: false, runId: undefined };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--help' || args[i] === '-h') parsed.help = true;
    else if (args[i] === '--dry-run') parsed.dryRun = true;
    else if (args[i] === '--run-id') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('RUN_ID_REQUIRED');
      parsed.runId = args[++i];
    } else throw new Error(`UNKNOWN_ARGUMENT:${args[i]}`);
  }
  if (parsed.help) return parsed;
  parsed.runId ||= env.EO_SG_RECOVERY_RUN_ID;
  if (!parsed.runId) throw new Error('RUN_ID_REQUIRED: use --run-id <id> or EO_SG_RECOVERY_RUN_ID.');
  if (parsed.runId !== TARGET.runId) throw new Error('RECOVERY_RUN_ID_MISMATCH');
  return parsed;
}

function executeRecovery({ runId, dryRun = false, episodeRoot = TARGET.episodeRoot, env = process.env, processAlive = pidIsAlive, verifyEpisodeHashes = verifyLockedEpisodeHashes } = {}) {
  if (!runId) throw new Error('RUN_ID_REQUIRED');
  if (runId !== TARGET.runId) throw new Error('RECOVERY_RUN_ID_MISMATCH');
  if (dryRun) return { status: 'DRY_RUN_PASS', ...auditFailedRun({ episodeRoot, runId, processAlive, verifyEpisodeHashes }) };
  return archiveFailedRun({ episodeRoot, runId, env, processAlive, verifyEpisodeHashes });
}

function main(args = process.argv.slice(2), env = process.env) {
  let options;
  try { options = parseArgs(args, env); }
  catch (error) { console.error(`ZERO_CALL_RECOVERY_REFUSED:${String(error.message || error)}`); process.exitCode = 2; return; }
  if (options.help) { console.log(USAGE); return; }
  if (options.dryRun) {
    try { console.log(JSON.stringify(executeRecovery({ runId: options.runId, dryRun: true }), null, 2)); }
    catch (error) { console.error(`ZERO_CALL_RECOVERY_REFUSED:${String(error.message || error)}`); process.exitCode = 1; }
    return;
  }
  if (process.platform !== 'linux' || TARGET.episodeRoot !== '/data/episodes/EmpireOmitted_V3_SHADOW_WELLSFARGO') {
    console.error('ZERO_CALL_RECOVERY_REFUSED:RECOVERY_REQUIRES_APPROVED_RAILWAY_VOLUME'); process.exitCode = 1; return;
  }
  try { console.log(JSON.stringify(executeRecovery({ runId: options.runId, env }), null, 2)); }
  catch (error) { console.error(`ZERO_CALL_RECOVERY_REFUSED:${String(error.message || error)}`); process.exitCode = 1; }
}

if (require.main === module) main();

module.exports = { TARGET, EXPECTED_EPISODE_HASHES, ARCHIVE_VERSION, USAGE, auditFailedRun, archiveFailedRun, executeRecovery, verifyLockedEpisodeHashes, parseArgs, main, walkFiles, sha256 };
