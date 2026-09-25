'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TARGET_FILES, sha256, groupWordTimestamps, retimeEditPlan,
  assertOnlyApprovedActTextChanges, assertScriptTimestampParity,
  assertCreativePlanFieldsFrozen, verifyReplacementSet, makeBackup, verifyBackup, restoreBackup, reserveWhisperAttempt,
} = require('../pipeline-updates/episode-activation.cjs');

function fixture() {
  const bindings = { act1: 'VO_Act1.mp3', act2: 'VO_Act2.mp3' };
  const plan = {
    episodeId: 'episode-a', title: 'Locked title', schemaVersion: '3.0.0',
    timing: { basis: 'previous', totalDurationSec: 8, acts: [
      { actKey: 'act1', voKey: bindings.act1, wordCount: 2, startSec: 0, endSec: 4, durationSec: 4 },
      { actKey: 'act2', voKey: bindings.act2, wordCount: 2, startSec: 4, endSec: 8, durationSec: 4 },
    ] },
    sequences: [
      { sequenceId: 's1', actKey: 'act1', beats: [{ beatId: 'b1', sequenceId: 's1', actKey: 'act1', startWordIndex: 0, endWordIndex: 1, startSec: 0, endSec: 4, durationSec: 4, narrationExcerpt: 'OLD', visual: { type: 'STOCK', description: 'same' } }] },
      { sequenceId: 's2', actKey: 'act2', beats: [{ beatId: 'b2', sequenceId: 's2', actKey: 'act2', startWordIndex: 0, endWordIndex: 1, startSec: 4, endSec: 8, durationSec: 4, narrationExcerpt: 'OLD', visual: { type: 'STOCK', description: 'same' } }] },
    ],
  };
  const words = [
    { vo_file: bindings.act1, word: 'Hello', start_seconds: 0.2, end_seconds: 0.5 },
    { vo_file: bindings.act1, word: 'world.', start_seconds: 1.1, end_seconds: 1.5 },
    { vo_file: bindings.act2, word: 'Second', start_seconds: 0.1, end_seconds: 0.4 },
    { vo_file: bindings.act2, word: 'act.', start_seconds: 0.8, end_seconds: 1.2 },
  ];
  return { bindings, plan, words };
}

test('groups finished word timing by VO while preserving legacy word shape', () => {
  const { bindings, words } = fixture();
  const grouped = groupWordTimestamps(words, bindings);
  assert.deepEqual(grouped.get(bindings.act1).map(({ word }) => word), ['Hello', 'world.']);
  assert.deepEqual(Object.keys(words[0]), ['vo_file', 'word', 'start_seconds', 'end_seconds']);
});

test('deterministically retimes all beats on episode-absolute timing and preserves creative fields', () => {
  const { bindings, plan, words } = fixture();
  const result = retimeEditPlan({ plan, wordTimestamps: words, actOrder: ['act1', 'act2'], actBindings: bindings, actDurationsSec: { act1: 3, act2: 2 } });
  assert.equal(result.plan.timing.totalDurationSec, 5);
  assert.deepEqual(result.plan.timing.acts.map(({ startSec, endSec, durationSec }) => [startSec, endSec, durationSec]), [[0, 3, 3], [3, 5, 2]]);
  assert.deepEqual(result.plan.sequences.map(({ beats }) => [beats[0].startSec, beats[0].endSec, beats[0].durationSec, beats[0].narrationExcerpt]), [[0, 3, 3, 'Hello world.'], [3, 5, 2, 'Second act.']]);
  assert.equal(result.plan.sequences[0].beats[0].visual.description, 'same');
  assert.equal(plan.timing.totalDurationSec, 8, 'input plan remains immutable');
  assertCreativePlanFieldsFrozen(plan, result.plan);
});

test('rejects missing, unordered and duplicate-act timing structures', () => {
  const { bindings, words } = fixture();
  assert.throws(() => groupWordTimestamps([], bindings), /ACTIVATION_TIMESTAMPS_EMPTY/);
  assert.throws(() => groupWordTimestamps([words[1], words[0], ...words.slice(2)], bindings), /ACTIVATION_TIMESTAMP_ORDER/);
  assert.throws(() => retimeEditPlan({ plan: fixture().plan, wordTimestamps: words, actOrder: ['act1', 'act1'], actBindings: bindings, actDurationsSec: { act1: 3 } }), /ACTIVATION_DUPLICATE_ACT/);
});

test('only approved narration fields may differ in candidate script', () => {
  const original = { title: 'same', acts: { act1: { voScript: 'old', other: 1 }, act2: { voScript: 'same', other: 2 } } };
  const candidate = structuredClone(original); candidate.acts.act1.voScript = 'new';
  assert.equal(assertOnlyApprovedActTextChanges(original, candidate, ['act1']), true);
  candidate.acts.act2.voScript = 'unauthorized';
  assert.throws(() => assertOnlyApprovedActTextChanges(original, candidate, ['act1']), /ACTIVATION_UNAPPROVED_SCRIPT_CHANGE/);
});

test('corrected script text must have exact timestamp token parity', () => {
  const { bindings, words } = fixture();
  assert.equal(assertScriptTimestampParity({ acts: { act1: { voScript: 'Hello world.' }, act2: { voScript: 'Second act.' } } }, words, bindings), true);
  assert.throws(() => assertScriptTimestampParity({ acts: { act1: { voScript: 'Hello missing.' }, act2: { voScript: 'Second act.' } } }, words, bindings), /ACTIVATION_SCRIPT_AUDIO_WORD_PARITY:act1/);
});

test('candidate replacement requires exact complete file set and verified bytes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-activation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = TARGET_FILES.map(relative => {
    const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(`candidate:${relative}`); fs.writeFileSync(file, bytes);
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
  assert.equal(verifyReplacementSet(directory, manifest), true);
  assert.throws(() => verifyReplacementSet(directory, manifest.slice(1)), /ACTIVATION_REPLACEMENT_SET_INVALID/);
  fs.appendFileSync(path.join(directory, TARGET_FILES[0]), 'tamper');
  assert.throws(() => verifyReplacementSet(directory, manifest), /ACTIVATION_CANDIDATE_HASH_MISMATCH/);
});

test('backup records and preserves bytes of every existing replacement target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-activation-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const episode = path.join(root, 'episode'), backup = path.join(root, 'backup');
  for (const relative of TARGET_FILES) { const file = path.join(episode, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(`original:${relative}`)); }
  const manifest = makeBackup({ episodeDirectory: episode, backupDirectory: backup });
  assert.equal(manifest.files.length, TARGET_FILES.length);
  for (const item of manifest.files) {
    const bytes = fs.readFileSync(path.join(backup, item.path));
    assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
    assert.deepEqual(bytes, fs.readFileSync(path.join(episode, item.path)));
  }
});

test('durable Whisper reservations enforce the global and per-act retry ceilings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-whisper-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, 'request-ledger.jsonl');
  assert.equal(reserveWhisperAttempt({ ledgerPath, actKey: 'act1', attempt: 1 }).requestOrdinal, 1);
  reserveWhisperAttempt({ ledgerPath, actKey: 'act1', attempt: 2 });
  reserveWhisperAttempt({ ledgerPath, actKey: 'act1', attempt: 3 });
  assert.throws(() => reserveWhisperAttempt({ ledgerPath, actKey: 'act1', attempt: 4 }), /ACTIVATION_WHISPER_BUDGET_EXHAUSTED/);
  for (const actKey of ['act2', 'act3', 'act3b', 'act4', 'act5']) for (let attempt = 1; attempt <= 3; attempt++) reserveWhisperAttempt({ ledgerPath, actKey, attempt });
  assert.equal(fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/u).length, 18);
  assert.throws(() => reserveWhisperAttempt({ ledgerPath, actKey: 'act6', attempt: 1 }), /ACTIVATION_WHISPER_BUDGET_EXHAUSTED/);
});

test('verified backup restores replaced bytes and removes paths that did not previously exist', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const episode = path.join(root, 'episode'), backup = path.join(root, 'backup');
  fs.mkdirSync(episode, { recursive: true }); fs.writeFileSync(path.join(episode, 'locked.json'), 'before');
  const manifest = makeBackup({ episodeDirectory: episode, backupDirectory: backup, targets: ['locked.json', 'new.json'] });
  fs.writeFileSync(path.join(episode, 'locked.json'), 'promoted'); fs.writeFileSync(path.join(episode, 'new.json'), 'new');
  assert.equal(verifyBackup({ backupDirectory: backup, manifest }), true);
  assert.equal(restoreBackup({ episodeDirectory: episode, backupDirectory: backup, manifest }), true);
  assert.equal(fs.readFileSync(path.join(episode, 'locked.json'), 'utf8'), 'before');
  assert.equal(fs.existsSync(path.join(episode, 'new.json')), false);
  fs.writeFileSync(path.join(backup, 'locked.json'), 'tampered');
  assert.throws(() => verifyBackup({ backupDirectory: backup, manifest }), /ACTIVATION_BACKUP_HASH_MISMATCH/);
});
