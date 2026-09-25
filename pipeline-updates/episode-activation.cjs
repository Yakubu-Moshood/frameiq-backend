'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_DYNAMIC_FIELDS = new Set(['startSec', 'endSec', 'durationSec', 'narrationExcerpt']);
const SHOT_DYNAMIC_FIELDS = new Set(['startWordIndex', 'endWordIndex', 'startSec', 'endSec', 'durationSec', 'narrationExcerpt']);
const TARGET_FILES = [
  'script.json', 'assets/audio/VO_Act1.mp3', 'assets/audio/VO_Act2.mp3', 'assets/audio/VO_Act3.mp3',
  'assets/audio/VO_Act3B.mp3', 'assets/audio/VO_Act4.mp3', 'assets/audio/VO_Act5.mp3',
  'edit-plan.json', 'edit-plan-validation.json', 'edit-plan-shadow-status.json', 'shot-definitions.json',
  'production-manifest.json', 'evidence-source-manifest.json', 'proof-section-plan.json',
];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
const deepClone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const token = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9']/g, '');
const tokens = value => String(value ?? '').split(/\s+/u).map(token).filter(Boolean);

function assertSafeRelative(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error('ACTIVATION_PATH_INVALID');
  return relative;
}

function atomicWrite(fsImpl, file, bytes) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fsImpl.writeFileSync(temp, bytes, { flag: 'wx' }); fsImpl.renameSync(temp, file); }
  finally { try { fsImpl.rmSync(temp, { force: true }); } catch (_) {} }
}

function reserveWhisperAttempt({ fs: fsImpl = fs, ledgerPath, actKey, attempt, maximumTotal = 18, maximumPerAct = 3, at = new Date().toISOString() }) {
  if (typeof ledgerPath !== 'string' || !ledgerPath || typeof actKey !== 'string' || !actKey) throw new Error('ACTIVATION_WHISPER_LEDGER_INPUT_INVALID');
  let rows = [];
  if (fsImpl.existsSync(ledgerPath)) {
    const text = fsImpl.readFileSync(ledgerPath, 'utf8');
    try { rows = text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)); }
    catch (_) { throw new Error('ACTIVATION_WHISPER_LEDGER_CORRUPT'); }
  }
  const countForAct = rows.filter(row => row.eventType === 'request-reserved' && row.actKey === actKey).length;
  const total = rows.filter(row => row.eventType === 'request-reserved').length;
  if (countForAct >= maximumPerAct || total >= maximumTotal) throw new Error(`ACTIVATION_WHISPER_BUDGET_EXHAUSTED:${actKey}`);
  const record = { eventType: 'request-reserved', at, actKey, attempt: countForAct + 1, reportedAttempt: attempt, requestOrdinal: total + 1 };
  fsImpl.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const fd = fsImpl.openSync(ledgerPath, 'a', 0o600);
  try { fsImpl.writeSync(fd, `${JSON.stringify(record)}\n`); fsImpl.fsyncSync(fd); }
  finally { fsImpl.closeSync(fd); }
  return record;
}

function groupWordTimestamps(wordTimestamps, actBindings) {
  if (!Array.isArray(wordTimestamps) || !wordTimestamps.length) throw new Error('ACTIVATION_TIMESTAMPS_EMPTY');
  const byVo = new Map(Object.values(actBindings).map(voKey => [voKey, []]));
  for (const [index, item] of wordTimestamps.entries()) {
    if (!item || typeof item !== 'object' || !byVo.has(item.vo_file)) throw new Error(`ACTIVATION_UNKNOWN_VO:${index}`);
    if (typeof item.word !== 'string' || !Number.isFinite(item.start_seconds) || !Number.isFinite(item.end_seconds)
        || item.start_seconds < 0 || item.end_seconds < item.start_seconds) throw new Error(`ACTIVATION_TIMESTAMP_INVALID:${index}`);
    const actWords = byVo.get(item.vo_file);
    const previous = actWords.at(-1);
    if (previous && (item.start_seconds < previous.start_seconds || item.start_seconds < previous.end_seconds - 0.001)) throw new Error(`ACTIVATION_TIMESTAMP_ORDER:${item.vo_file}:${index}`);
    actWords.push(item);
  }
  for (const [actKey, voKey] of Object.entries(actBindings)) if (!byVo.get(voKey)?.length) throw new Error(`ACTIVATION_ACT_TIMING_MISSING:${actKey}`);
  return byVo;
}

function retimeEditPlan({ plan, wordTimestamps, actOrder, actBindings, actDurationsSec }) {
  if (!Array.isArray(actOrder) || !actOrder.length || !actBindings || !actDurationsSec) throw new Error('ACTIVATION_TIMING_CONFIG_INVALID');
  if (new Set(actOrder).size !== actOrder.length) throw new Error('ACTIVATION_DUPLICATE_ACT');
  if (!plan || !Array.isArray(plan.sequences) || !plan.sequences.length) throw new Error('ACTIVATION_PLAN_INVALID');
  const next = deepClone(plan);
  const grouped = groupWordTimestamps(wordTimestamps, actBindings);
  const priorActs = plan.timing?.acts || [];
  if (!Array.isArray(priorActs) || new Set(priorActs.map(act => act.actKey)).size !== priorActs.length) throw new Error('ACTIVATION_PRIOR_TIMING_INVALID');
  const priorTiming = new Map(priorActs.map(act => [act.actKey, act]));
  const planActKeys = new Set(next.sequences.map(sequence => sequence.actKey));
  if (planActKeys.size !== actOrder.length || actOrder.some(actKey => !planActKeys.has(actKey))) throw new Error('ACTIVATION_PLAN_ACT_SET_MISMATCH');
  const allBeatIds = next.sequences.flatMap(sequence => sequence.beats.map(beat => beat.beatId));
  if (allBeatIds.some(id => typeof id !== 'string' || !id) || new Set(allBeatIds).size !== allBeatIds.length) throw new Error('ACTIVATION_PLAN_BEAT_IDS_INVALID');
  let episodeCursor = 0;
  const timingActs = [];
  for (const actKey of actOrder) {
    const voKey = actBindings[actKey];
    const words = grouped.get(voKey);
    const durationSec = actDurationsSec[actKey];
    if (!words?.length || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec + 0.001 < words.at(-1).end_seconds) throw new Error(`ACTIVATION_DURATION_INVALID:${actKey}`);
    const oldTiming = priorTiming.get(actKey);
    if (!oldTiming || oldTiming.voKey !== voKey || oldTiming.wordCount !== words.length) throw new Error(`ACTIVATION_WORD_ALIGNMENT_MISMATCH:${actKey}`);
    const startSec = episodeCursor;
    const endSec = startSec + durationSec;
    timingActs.push({ actKey, voKey, startSec, endSec, durationSec, wordCount: words.length });
    const sequences = next.sequences.filter(sequence => sequence.actKey === actKey);
    if (!sequences.length) throw new Error(`ACTIVATION_PLAN_ACT_MISSING:${actKey}`);
    for (const sequence of sequences) for (const beat of sequence.beats) {
      const first = beat.startWordIndex, last = beat.endWordIndex;
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || last >= words.length) throw new Error(`ACTIVATION_BEAT_RANGE_INVALID:${beat.beatId}`);
      beat.startSec = first === 0 ? startSec : startSec + words[first].start_seconds;
      beat.endSec = last === words.length - 1 ? endSec : startSec + words[last + 1].start_seconds;
      beat.durationSec = beat.endSec - beat.startSec;
      beat.narrationExcerpt = words.slice(first, last + 1).map(word => word.word).join(' ');
    }
    episodeCursor = endSec;
  }
  if (next.sequences.some(sequence => !actOrder.includes(sequence.actKey))) throw new Error('ACTIVATION_PLAN_HAS_UNKNOWN_ACT');
  next.timing = { basis: 'finished_vo_word_timestamps', totalDurationSec: episodeCursor, acts: timingActs };
  return { plan: next, grouped };
}

function assertOnlyApprovedActTextChanges(originalScript, candidateScript, correctedActKeys) {
  const approved = new Set(correctedActKeys);
  const oldActs = originalScript?.acts, newActs = candidateScript?.acts;
  if (!oldActs || !newActs || !equal(Object.keys(oldActs), Object.keys(newActs))) throw new Error('ACTIVATION_SCRIPT_ACT_SET_CHANGED');
  const before = deepClone(originalScript), after = deepClone(candidateScript);
  for (const actKey of approved) {
    if (!oldActs[actKey] || !newActs[actKey] || typeof oldActs[actKey].voScript !== 'string' || typeof newActs[actKey].voScript !== 'string') throw new Error(`ACTIVATION_APPROVED_ACT_INVALID:${actKey}`);
    before.acts[actKey].voScript = after.acts[actKey].voScript;
  }
  if (!equal(before, after)) throw new Error('ACTIVATION_UNAPPROVED_SCRIPT_CHANGE');
  for (const actKey of Object.keys(oldActs)) if (!approved.has(actKey) && oldActs[actKey].voScript !== newActs[actKey].voScript) throw new Error(`ACTIVATION_UNAPPROVED_NARRATION_CHANGE:${actKey}`);
  return true;
}

function assertScriptTimestampParity(script, wordTimestamps, actBindings) {
  const grouped = groupWordTimestamps(wordTimestamps, actBindings);
  for (const [actKey, voKey] of Object.entries(actBindings)) {
    const expected = tokens(script.acts?.[actKey]?.voScript);
    const actual = grouped.get(voKey).flatMap(item => tokens(item.word));
    if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) throw new Error(`ACTIVATION_SCRIPT_AUDIO_WORD_PARITY:${actKey}`);
  }
  return true;
}

function updateShotDefinitions({ originalShotDefs, plan, revisionChain, revisionId }) {
  const shotDefs = deepClone(originalShotDefs);
  const beatEntries = plan.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat]));
  const planBeats = new Map(beatEntries);
  if (planBeats.size !== beatEntries.length) throw new Error('ACTIVATION_PLAN_BEAT_IDS_INVALID');
  if (!Array.isArray(shotDefs.allShots) || shotDefs.allShots.length !== planBeats.size) throw new Error('ACTIVATION_SHOT_SET_MISMATCH');
  if (new Set(shotDefs.allShots.map(shot => shot.shotId)).size !== shotDefs.allShots.length || new Set(shotDefs.allShots.map(shot => shot.beatId)).size !== shotDefs.allShots.length) throw new Error('ACTIVATION_SHOT_IDS_INVALID');
  if (!Array.isArray(revisionChain) || revisionChain.length === 0 || !revisionChain.at(-1)?.resultArtifactSha256) throw new Error('ACTIVATION_REVISION_CHAIN_INVALID');
  const entries = [], permittedImmutablePaths = [];
  for (const shot of shotDefs.allShots) {
    const beat = planBeats.get(shot.beatId);
    if (!beat || shot.sequenceId !== beat.sequenceId || shot.actKey !== beat.actKey) throw new Error(`ACTIVATION_SHOT_IDENTITY_MISMATCH:${shot.shotId}`);
    for (const field of SHOT_DYNAMIC_FIELDS) {
      const beforeValue = shot[field]; const afterValue = beat[field];
      if (!equal(beforeValue, afterValue)) {
        shot[field] = deepClone(afterValue);
        permittedImmutablePaths.push(`${shot.shotId}.${field}`);
        entries.push({ shotId: shot.shotId, beatId: shot.beatId, fieldPath: field, beforeValue, afterValue, reason: 'Deterministic timing propagation from the approved finished voiceover.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-P-ACTIVATION' });
      }
    }
  }
  const planSha256 = require('./shot-definitions-validator.cjs').planFingerprint(plan);
  const beforePlanSha = shotDefs.sourceEditPlanSha256;
  shotDefs.sourceEditPlanSha256 = planSha256;
  const ledger = {
    ledgerVersion: '1.0.0', revisionId, revisionVersion: '2.3B-P-ACTIVATION', lineageRole: 'current', approvalStatus: 'APPROVED',
    approval: { status: 'APPROVED', basis: 'User-approved six-act narration and deterministic finished-VO retiming; creative fields remain frozen.' },
    parentArtifactSha256: revisionChain.at(-1).resultArtifactSha256,
    resultArtifactSha256: require('./revision-lineage.cjs').artifactSha256(shotDefs),
    permittedImmutablePaths, entries,
    bindings: [{ fieldPath: 'sourceEditPlanSha256', beforeValue: beforePlanSha, afterValue: planSha256, reason: 'Bind shot definitions to the deterministically retimed approved edit plan.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-P-ACTIVATION' }],
  };
  return { shotDefs, revisionLedger: ledger, revisionChain: [...revisionChain, ledger] };
}

function assertCreativePlanFieldsFrozen(before, after) {
  if (!equal(Object.keys(before), Object.keys(after))) throw new Error('ACTIVATION_PLAN_TOP_LEVEL_KEYS_CHANGED');
  const beforeBeats = new Map(before.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat])));
  const afterBeats = new Map(after.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat])));
  if (!equal([...beforeBeats.keys()], [...afterBeats.keys()])) throw new Error('ACTIVATION_BEAT_SET_CHANGED');
  for (const [beatId, oldBeat] of beforeBeats) {
    const newBeat = afterBeats.get(beatId);
    const a = deepClone(oldBeat), b = deepClone(newBeat);
    for (const field of PLAN_DYNAMIC_FIELDS) { delete a[field]; delete b[field]; }
    if (!equal(a, b)) throw new Error(`ACTIVATION_CREATIVE_BEAT_FIELD_CHANGED:${beatId}`);
  }
  const beforeSequences = before.sequences.map(sequence => ({ ...sequence, beats: sequence.beats.map(({ startWordIndex, endWordIndex, startSec, endSec, durationSec, narrationExcerpt, ...beat }) => beat) }));
  const afterSequences = after.sequences.map(sequence => ({ ...sequence, beats: sequence.beats.map(({ startWordIndex, endWordIndex, startSec, endSec, durationSec, narrationExcerpt, ...beat }) => beat) }));
  if (!equal(beforeSequences, afterSequences)) throw new Error('ACTIVATION_SEQUENCE_OR_CREATIVE_FIELD_CHANGED');
  return true;
}

function verifyReplacementSet(candidateDirectory, fileManifest) {
  if (!Array.isArray(fileManifest) || fileManifest.length !== TARGET_FILES.length || new Set(fileManifest.map(item => item.path)).size !== TARGET_FILES.length) throw new Error('ACTIVATION_REPLACEMENT_SET_INVALID');
  const expected = new Set(TARGET_FILES);
  for (const item of fileManifest) {
    assertSafeRelative(item.path);
    if (!expected.has(item.path)) throw new Error(`ACTIVATION_REPLACEMENT_UNKNOWN:${item.path}`);
    const file = path.resolve(candidateDirectory, item.path);
    if (!file.startsWith(`${path.resolve(candidateDirectory)}${path.sep}`) || !fs.existsSync(file)) throw new Error(`ACTIVATION_CANDIDATE_MISSING:${item.path}`);
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error(`ACTIVATION_CANDIDATE_HASH_MISMATCH:${item.path}`);
  }
  return true;
}

function makeBackup({ fs: fsImpl = fs, episodeDirectory, backupDirectory, targets = TARGET_FILES }) {
  const files = [];
  for (const relative of targets) {
    assertSafeRelative(relative);
    const source = path.join(episodeDirectory, relative);
    const existed = fsImpl.existsSync(source);
    if (!existed) { files.push({ path: relative, existed: false }); continue; }
    const bytes = fsImpl.readFileSync(source);
    const target = path.join(backupDirectory, relative);
    atomicWrite(fsImpl, target, bytes);
    files.push({ path: relative, existed: true, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { schemaVersion: 'phase2.3b-p-backup/1.0.0', createdAt: new Date().toISOString(), files };
}

function verifyBackup({ fs: fsImpl = fs, backupDirectory, manifest }) {
  if (manifest?.schemaVersion !== 'phase2.3b-p-backup/1.0.0' || !Array.isArray(manifest.files)) throw new Error('ACTIVATION_BACKUP_MANIFEST_INVALID');
  const seen = new Set();
  for (const item of manifest.files) {
    assertSafeRelative(item?.path);
    if (seen.has(item.path)) throw new Error(`ACTIVATION_BACKUP_DUPLICATE_PATH:${item.path}`);
    seen.add(item.path);
    const file = path.resolve(backupDirectory, item.path);
    if (!file.startsWith(`${path.resolve(backupDirectory)}${path.sep}`)) throw new Error(`ACTIVATION_BACKUP_PATH_INVALID:${item.path}`);
    const exists = fsImpl.existsSync(file);
    if (item.existed === true) {
      if (!exists) throw new Error(`ACTIVATION_BACKUP_MISSING:${item.path}`);
      const bytes = fsImpl.readFileSync(file);
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`ACTIVATION_BACKUP_HASH_MISMATCH:${item.path}`);
    } else if (item.existed === false && exists) throw new Error(`ACTIVATION_UNEXPECTED_BACKUP:${item.path}`);
    else if (item.existed !== true && item.existed !== false) throw new Error(`ACTIVATION_BACKUP_ENTRY_INVALID:${item.path}`);
  }
  return true;
}

function restoreBackup({ fs: fsImpl = fs, episodeDirectory, backupDirectory, manifest }) {
  verifyBackup({ fs: fsImpl, backupDirectory, manifest });
  for (const item of manifest.files) {
    const target = path.join(episodeDirectory, item.path);
    if (!item.existed) fsImpl.rmSync(target, { force: true });
    else atomicWrite(fsImpl, target, fsImpl.readFileSync(path.join(backupDirectory, item.path)));
  }
  return true;
}

module.exports = {
  PLAN_DYNAMIC_FIELDS, SHOT_DYNAMIC_FIELDS, TARGET_FILES, sha256, jsonHash, tokens, reserveWhisperAttempt,
  groupWordTimestamps, retimeEditPlan, assertOnlyApprovedActTextChanges, assertScriptTimestampParity,
  updateShotDefinitions, assertCreativePlanFieldsFrozen, verifyReplacementSet, makeBackup, verifyBackup, restoreBackup, atomicWrite,
};
