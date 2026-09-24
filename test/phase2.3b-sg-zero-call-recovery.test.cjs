'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TARGET, EXPECTED_EPISODE_HASHES, ARCHIVE_VERSION, USAGE, auditFailedRun, executeRecovery, parseArgs, sha256 } = require('../scripts/phase2.3b-sg-recover-zero-call-run.cjs');

function fixture(t, { status = {}, journal = '{"type":"run-start"}\n', extras = [], ledger = undefined, backup = true } = {}) {
  const episodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-zero-call-audit-'));
  t.after(() => fs.rmSync(episodeRoot, { recursive: true, force: true }));
  const review = path.join(episodeRoot, '.review');
  const runDir = path.join(review, `phase2.3b-sg-${TARGET.runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run-status.json'), JSON.stringify({ runId: TARGET.runId, state: 'FAILURE', pid: 99999999, completedActs: [], attemptsByAct: { act3b: 1, act4: 0 }, ...status }));
  fs.writeFileSync(path.join(runDir, 'generation.jsonl'), journal);
  const backupBytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1021, 0x42)]);
  const backupSha256 = sha256(backupBytes);
  const expectedEpisodeHashes = { ...EXPECTED_EPISODE_HASHES, 'assets/audio/VO_Act3B.mp3': backupSha256 };
  const backupManifestFiles = [{ relativePath: 'assets/audio/VO_Act3B.mp3', existed: backup, sha256: backupSha256, bytes: backupBytes.length }];
  fs.writeFileSync(path.join(runDir, 'backup-manifest.json'), JSON.stringify({ schemaVersion: 'phase2.3b-sg-backups/1.0.0', files: backupManifestFiles }));
  if (backup) {
    const backupPath = path.join(runDir, 'backups', 'assets', 'audio', 'VO_Act3B.mp3');
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, backupBytes);
  }
  if (ledger !== undefined) fs.writeFileSync(path.join(review, 'phase2.3b-sg-request-ledger.json'), JSON.stringify(ledger));
  for (const [relative, contents] of extras) {
    const file = path.join(runDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const hashVerifier = () => Object.fromEntries(Object.entries(expectedEpisodeHashes));
  return { episodeRoot, review, runDir, hashVerifier, expectedEpisodeHashes, backupBytes, backupSha256 };
}

const inactive = () => false;
const railwayEnv = {
  RAILWAY_PROJECT_ID: TARGET.projectId,
  RAILWAY_ENVIRONMENT_ID: TARGET.environmentId,
  RAILWAY_SERVICE_ID: TARGET.serviceId,
};
function treeHashes(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, Object.fromEntries(Object.entries(treeHashes(file)).map(([name, hash]) => [path.join(entry.name, name), hash])));
    else result[entry.name] = sha256(fs.readFileSync(file));
  }
  return result;
}

test('--help prints usage and exits successfully without mutating or inspecting a run', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'phase2.3b-sg-recover-zero-call-run.cjs'), '--help'], { encoding: 'utf8', env: { ...process.env, EO_SG_RECOVERY_RUN_ID: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node .*--run-id <id> \[--dry-run\]/);
  assert.match(result.stdout, /--dry-run verifies/);
  assert.equal(result.stderr, '');
});

test('explicit run ID is required and environment fallback is documented', () => {
  assert.throws(() => parseArgs([], {}), /RUN_ID_REQUIRED/);
  assert.equal(parseArgs(['--run-id', TARGET.runId], {}).runId, TARGET.runId);
  assert.equal(parseArgs([], { EO_SG_RECOVERY_RUN_ID: TARGET.runId }).runId, TARGET.runId);
  assert.match(USAGE, /EO_SG_RECOVERY_RUN_ID/);
  assert.throws(() => parseArgs(['--run-id', 'another-run'], {}), /RUN_ID_MISMATCH/);
});

test('legacy Stage A attemptsByAct is reported separately and exact zero-call failure passes dry-run', t => {
  const f = fixture(t);
  const before = treeHashes(f.runDir);
  const report = executeRecovery({ runId: TARGET.runId, dryRun: true, episodeRoot: f.episodeRoot, processAlive: inactive, verifyEpisodeHashes: f.hashVerifier, expectedEpisodeHashes: f.expectedEpisodeHashes });
  assert.equal(report.status, 'DRY_RUN_PASS');
  assert.equal(report.legacyInvocationCounters.act3b, 1);
  assert.equal(report.checks.noProviderLedgerReservations, true);
  assert.equal(report.checks.lockedEpisodeHashesMatch, true);
  assert.equal(report.audioAudit.verifiedAuthoritativeBackups.count, 1);
  assert.deepEqual(report.audioAudit.verifiedAuthoritativeBackups.files[0], {
    path: 'backups/assets/audio/VO_Act3B.mp3', relativePath: 'assets/audio/VO_Act3B.mp3',
    bytes: f.backupBytes.length, sha256: f.backupSha256, authoritativeSourceSha256: f.backupSha256,
  });
  assert.deepEqual(report.audioAudit.generatedAudioOutputs, { count: 0, files: [] });
  assert.deepEqual(report.audioAudit.partialOutputs, { count: 0, files: [] });
  assert.equal(report.audioAudit.durableProviderAttemptEvidence.count, 0);
  assert.deepEqual(treeHashes(f.runDir), before);
  assert.equal(fs.existsSync(path.join(f.review, 'failed-run-archive')), false);
});

test('a real request-ledger reservation is refused regardless of the legacy counter', t => {
  const f = fixture(t, { ledger: { attempts: [{ channel: 'EmpireOmitted', episodeId: TARGET.episodeId, actKey: 'act3b', status: 'RESERVED' }] } });
  assert.throws(() => auditFailedRun({ runId: TARGET.runId, episodeRoot: f.episodeRoot, processAlive: inactive, verifyEpisodeHashes: f.hashVerifier, expectedEpisodeHashes: f.expectedEpisodeHashes }), /PROVIDER_REQUEST_LEDGER_ENTRY_FOUND/);
});

test('reservation, request, and response events are refused', t => {
  for (const event of ['provider-attempt-reserved', 'HTTP request sent', 'ElevenLabs response received']) {
    const f = fixture(t, { journal: `${JSON.stringify({ type: event })}\n` });
    assert.throws(() => auditFailedRun({ runId: TARGET.runId, episodeRoot: f.episodeRoot, processAlive: inactive, verifyEpisodeHashes: f.hashVerifier, expectedEpisodeHashes: f.expectedEpisodeHashes }), /PROVIDER_EVENT_EVIDENCE_PRESENT/);
  }
});

test('backup hash mismatch and a backup absent from the manifest are refused', t => {
  const altered = fixture(t);
  fs.writeFileSync(path.join(altered.runDir, 'backups', 'assets', 'audio', 'VO_Act3B.mp3'), Buffer.from('altered'));
  assert.throws(() => auditFailedRun({ runId: TARGET.runId, episodeRoot: altered.episodeRoot, processAlive: inactive, verifyEpisodeHashes: altered.hashVerifier, expectedEpisodeHashes: altered.expectedEpisodeHashes }), /BACKUP_SIZE_MISMATCH|BACKUP_HASH_MISMATCH|BACKUP_AUTHORITATIVE_HASH_MISMATCH/);
  const unlisted = fixture(t);
  const extra = path.join(unlisted.runDir, 'backups', 'assets', 'audio', 'unexpected.mp3');
  fs.writeFileSync(extra, 'unlisted backup');
  assert.throws(() => auditFailedRun({ runId: TARGET.runId, episodeRoot: unlisted.episodeRoot, processAlive: inactive, verifyEpisodeHashes: unlisted.hashVerifier, expectedEpisodeHashes: unlisted.expectedEpisodeHashes }), /BACKUP_FILE_ABSENT_FROM_MANIFEST/);
});

test('verified immutable pre-run backup metadata is not mistaken for a current provider event', t => {
  const f = fixture(t);
  const relativePath = 'prior-run-metadata.json';
  const bytes = Buffer.from('{"requestId":"historical-render-request","httpStatus":200}\n');
  const backupPath = path.join(f.runDir, 'backups', relativePath);
  fs.writeFileSync(backupPath, bytes);
  const manifestPath = path.join(f.runDir, 'backup-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files.push({ relativePath, existed: true, sha256: sha256(bytes), bytes: bytes.length });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const report = auditFailedRun({ runId: TARGET.runId, episodeRoot: f.episodeRoot, processAlive: inactive, verifyEpisodeHashes: f.hashVerifier, expectedEpisodeHashes: f.expectedEpisodeHashes });
  assert.equal(report.audioAudit.durableProviderAttemptEvidence.count, 0);
  assert.ok(report.audioAudit.verifiedAuthoritativeBackups.files.some(file => file.relativePath === relativePath));
});

test('generated MP3 and partial output outside verified backups are refused', t => {
  for (const audio of ['audio/VO_Act3B.mp3', 'diagnostics/VO_Act4.mp3.partial']) {
    const f = fixture(t, { extras: [[audio, 'audio bytes']] });
    assert.throws(() => auditFailedRun({ runId: TARGET.runId, episodeRoot: f.episodeRoot, processAlive: inactive, verifyEpisodeHashes: f.hashVerifier, expectedEpisodeHashes: f.expectedEpisodeHashes }), /AUDIO_OR_PARTIAL_PRESENT/);
  }
});

test('Act 3B backup absent from manifest or disk is refused', t => {
  const f = fixture(t, { backup: false });
  assert.throws(() => auditFailedRun({ runId: TARGET.runId, episodeRoot: f.episodeRoot, processAlive: inactive, verifyEpisodeHashes: f.hashVerifier, expectedEpisodeHashes: f.expectedEpisodeHashes }), /AUTHORITATIVE_ACT3B_BACKUP_MISSING_FROM_MANIFEST/);
});

test('active lock, live process, and completed-act state are refused', t => {
  const lock = fixture(t);
  fs.writeFileSync(path.join(lock.review, 'phase2.3b-sg-active.lock'), 'active');
  assert.throws(() => auditFailedRun({ runId: TARGET.runId, episodeRoot: lock.episodeRoot, processAlive: inactive, verifyEpisodeHashes: lock.hashVerifier, expectedEpisodeHashes: lock.expectedEpisodeHashes }), /LOCK_REQUIRES_INSPECTION/);
  const active = fixture(t);
  assert.throws(() => auditFailedRun({ runId: TARGET.runId, episodeRoot: active.episodeRoot, processAlive: pid => pid === 99999999, verifyEpisodeHashes: active.hashVerifier, expectedEpisodeHashes: active.expectedEpisodeHashes }), /RUN_PROCESS_STILL_ACTIVE/);
  const done = fixture(t, { status: { completedActs: ['act3b'] } });
  assert.throws(() => auditFailedRun({ runId: TARGET.runId, episodeRoot: done.episodeRoot, processAlive: inactive, verifyEpisodeHashes: done.hashVerifier, expectedEpisodeHashes: done.expectedEpisodeHashes }), /RUN_HAS_COMPLETED_ACTS/);
});

test('locked episode hash mismatch prevents dry-run and archival', t => {
  const f = fixture(t);
  const mismatch = () => { throw new Error('LOCKED_EPISODE_HASH_MISMATCH:script.json'); };
  assert.throws(() => executeRecovery({ runId: TARGET.runId, dryRun: true, episodeRoot: f.episodeRoot, processAlive: inactive, verifyEpisodeHashes: mismatch, expectedEpisodeHashes: f.expectedEpisodeHashes }), /LOCKED_EPISODE_HASH_MISMATCH/);
  assert.equal(fs.existsSync(path.join(f.review, 'failed-run-archive')), false);
});

test('archive preserves every failed-run file byte-for-byte at the versioned location', t => {
  const f = fixture(t, { extras: [['diagnostics/raw.log', 'original diagnostic bytes'], ['nested/state.json', '{"unchanged":true}\n']] });
  const before = treeHashes(f.runDir);
  const result = executeRecovery({ runId: TARGET.runId, episodeRoot: f.episodeRoot, env: railwayEnv, processAlive: inactive, verifyEpisodeHashes: f.hashVerifier, expectedEpisodeHashes: f.expectedEpisodeHashes });
  const archivedRun = path.join(f.review, 'failed-run-archive', ARCHIVE_VERSION, TARGET.runId);
  assert.equal(result.archivedPath, archivedRun);
  assert.deepEqual(treeHashes(archivedRun), before);
  assert.deepEqual(fs.readFileSync(path.join(archivedRun, 'backups', 'assets', 'audio', 'VO_Act3B.mp3')), f.backupBytes);
  assert.equal(sha256(fs.readFileSync(path.join(archivedRun, 'backups', 'assets', 'audio', 'VO_Act3B.mp3'))), f.backupSha256);
  assert.equal(fs.existsSync(f.runDir), false);
  assert.equal(fs.existsSync(result.recoveryRecordPath), true);
  assert.equal(JSON.parse(fs.readFileSync(result.recoveryRecordPath, 'utf8')).classification, 'FAILED_BEFORE_PROVIDER_RESERVATION_ZERO_PAID_REQUESTS');
});

test('archive requires the approved staging target', t => {
  const f = fixture(t);
  assert.throws(() => executeRecovery({ runId: TARGET.runId, episodeRoot: f.episodeRoot, env: {}, processAlive: inactive, verifyEpisodeHashes: f.hashVerifier, expectedEpisodeHashes: f.expectedEpisodeHashes }), /WRONG_RAILWAY_TARGET/);
});
