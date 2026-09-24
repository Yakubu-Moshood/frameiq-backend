'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TARGET, auditFailedRun } = require('../scripts/phase2.3b-sg-recover-zero-call-run.cjs');

function fixture(t, { status = {}, journal = '{"type":"run-start"}\n', extras = [] } = {}) {
  const episodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-zero-call-audit-'));
  t.after(() => fs.rmSync(episodeRoot, { recursive: true, force: true }));
  const runDir = path.join(episodeRoot, '.review', `phase2.3b-sg-${TARGET.runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run-status.json'), JSON.stringify({ runId: TARGET.runId, state: 'FAILURE', pid: 99999999, completedActs: [], attemptsByAct: { act3b: 0, act4: 0 }, ...status }));
  fs.writeFileSync(path.join(runDir, 'generation.jsonl'), journal);
  for (const [relative, contents] of extras) {
    const file = path.join(runDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return { episodeRoot, runDir };
}

const inactive = () => false;

test('audit accepts only named failed run with no completed acts, locks, ledger, provider events, audio, or live process', t => {
  const f = fixture(t);
  const report = auditFailedRun({ episodeRoot: f.episodeRoot, processAlive: inactive });
  assert.equal(report.runId, TARGET.runId);
  assert.equal(report.state, 'FAILURE');
  assert.deepEqual(report.completedActs, []);
  assert.equal(report.checks.noRequestLedger, true);
  assert.equal(report.checks.noProviderEvents, true);
  assert.equal(report.checks.noAudioOrPartial, true);
  assert.match(report.evidence.runStatus.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.evidence.generationJournal.sha256, /^[a-f0-9]{64}$/);
});

test('audit refuses wrong run identity, non-failure state, or completed acts', t => {
  const f = fixture(t);
  assert.throws(() => auditFailedRun({ episodeRoot: f.episodeRoot, runId: 'different-run', processAlive: inactive }), /RUN_ID_MISMATCH/);
  const success = fixture(t, { status: { state: 'SUCCESS' } });
  assert.throws(() => auditFailedRun({ episodeRoot: success.episodeRoot, processAlive: inactive }), /RUN_NOT_CONFIRMED_FAILURE/);
  const g = fixture(t, { status: { completedActs: ['act3b'] } });
  assert.throws(() => auditFailedRun({ episodeRoot: g.episodeRoot, processAlive: inactive }), /RUN_HAS_COMPLETED_ACTS/);
});

test('audit fails closed on provider event, request ledger, lock, active PID, and audio partial evidence', t => {
  const event = fixture(t, { journal: '{"type":"provider-attempt-reserved"}\n' });
  assert.throws(() => auditFailedRun({ episodeRoot: event.episodeRoot, processAlive: inactive }), /PROVIDER_EVENT_EVIDENCE_PRESENT/);
  const ledger = fixture(t);
  const sharedLedger = path.join(ledger.episodeRoot, '.review', 'phase2.3b-sg-request-ledger.json');
  fs.writeFileSync(sharedLedger, '{"attempts":[]}');
  assert.throws(() => auditFailedRun({ episodeRoot: ledger.episodeRoot, processAlive: inactive }), /REQUEST_LEDGER_PRESENT/);
  const lock = fixture(t);
  fs.writeFileSync(path.join(lock.episodeRoot, '.review', 'phase2.3b-sg-active.lock'), 'active');
  assert.throws(() => auditFailedRun({ episodeRoot: lock.episodeRoot, processAlive: inactive }), /LOCK_REQUIRES_INSPECTION/);
  const active = fixture(t);
  assert.throws(() => auditFailedRun({ episodeRoot: active.episodeRoot, processAlive: pid => pid === 99999999 }), /RUN_PROCESS_STILL_ACTIVE/);
  const audio = fixture(t, { extras: [['audio/VO_Act3B.mp3.partial', 'partial']] });
  assert.throws(() => auditFailedRun({ episodeRoot: audio.episodeRoot, processAlive: inactive }), /AUDIO_OR_PARTIAL_PRESENT/);
});

test('recovery utility is hard-bound to the approved Railway target and is not executed in local tests', () => {
  assert.deepEqual(TARGET, {
    projectId: '98a75a00-ce8e-4a7a-833e-ff76d3bdefea',
    environmentId: '6fa50efc-d4bc-4ea1-9c6e-c9daa9336b34',
    serviceId: 'd965705e-d5e7-4f4e-ac58-fc6b1959c81f',
    episodeRoot: '/data/episodes/EmpireOmitted_V3_SHADOW_WELLSFARGO',
    runId: 'eo-v3-sg-20260924-1738z-5cdf5b5',
  });
});
