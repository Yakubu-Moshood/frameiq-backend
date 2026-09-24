'use strict';

// Retimes in a hard-linked sibling clone, validates the complete artifact set,
// then exchanges the episode directory in one Linux renameat2 operation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = '/data/episodes/EmpireOmitted_V3_SHADOW_WELLSFARGO';
const CANDIDATE = '/app/artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate';
const EPISODE_ID = 'e59b6b79-96aa-4dcd-92c3-749fd536f55e';
const ACTS = [['act1','VO_Act1'],['act2','VO_Act2'],['act3','VO_Act3'],['act3b','VO_Act3B'],['act4','VO_Act4'],['act5','VO_Act5']];
const DYNAMIC = new Set(['startWordIndex','endWordIndex','startSec','endSec','durationSec','narrationExcerpt']);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytesHash = file => sha(fs.readFileSync(file));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fileHashFor = value => sha(Buffer.from(JSON.stringify(value)));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, jsonBytes(value), { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.rmSync(temp, { force: true }); } catch (_) {} }
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function assert(condition, code) { if (!condition) throw new Error(code); }
function retimePlan(plan, timestamps, durations) {
  const grouped = new Map(ACTS.map(([, vo]) => [vo, []]));
  for (const item of timestamps) { assert(grouped.has(item.vo_file), 'TIMING_UNKNOWN_VO'); grouped.get(item.vo_file).push(item); }
  let cursor = 0;
  plan.timing = { basis: 'finished_vo_word_timestamps', totalDurationSec: 0, acts: [] };
  for (const [actKey, voKey] of ACTS) {
    const words = grouped.get(voKey); const durationSec = durations[actKey];
    assert(words.length > 0 && Number.isFinite(durationSec) && durationSec > 0, `TIMING_MISSING:${actKey}`);
    assert(durationSec >= words.at(-1).end_seconds, `TIMING_DURATION_SHORT:${actKey}`);
    const startSec = cursor; const endSec = cursor + durationSec;
    plan.timing.acts.push({ actKey, voKey, startSec, endSec, durationSec, wordCount: words.length });
    for (const sequence of plan.sequences.filter(item => item.actKey === actKey)) for (const beat of sequence.beats) {
      const first = beat.startWordIndex, last = beat.endWordIndex;
      assert(Number.isInteger(first) && Number.isInteger(last) && first >= 0 && last >= first && last < words.length, `WORD_RANGE_INVALID:${actKey}`);
      beat.startSec = first === 0 ? startSec : startSec + words[first].start_seconds;
      beat.endSec = last === words.length - 1 ? endSec : startSec + words[last + 1].start_seconds;
      beat.durationSec = beat.endSec - beat.startSec;
      beat.narrationExcerpt = words.slice(first, last + 1).map(word => word.word).join(' ');
    }
    cursor = endSec;
  }
  plan.timing.totalDurationSec = cursor;
  return { plan, grouped };
}
async function main() {
  const runId = process.env.EO_VOICE_RUN_ID;
  assert(runId && /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/.test(runId), 'RUN_ID_INVALID');
  assert(process.env.EO_VOICE_EPISODE_QUIESCED === 'I_CONFIRMED', 'EPISODE_QUIESCENCE_CONFIRMATION_REQUIRED');
  const review = path.join(ROOT, '.review', `phase2.3b-sg-${runId}`);
  const status = readJson(path.join(review, 'run-status.json'));
  const ledger = readJson(path.join(review, 'request-ledger.json'));
  assert(status.state === 'SUCCESS' && equal(status.completedActs.slice().sort(), ['act3b','act4']), 'STAGE_A_NOT_COMPLETE');
  assert(ledger.attempts.length === 2 && ledger.attempts.every(row => row.status === 'COMPLETE'), 'TWO_ACT_LEDGER_INVALID');
  for (const [key, filename, digest] of [['act3b','VO_Act3B.mp3','ff9ab4bbe43c3f25844b6e6231abaa462cde3692dcd9e57f4c319dda168a0e49'],['act4','VO_Act4.mp3','26d10ba68ea1aa328bc26160e4f795545dc0f02fabbe3717e57187b161be8338']]) {
    const row = ledger.attempts.find(item => item.actKey === key && item.textSha256 === digest && item.status === 'COMPLETE');
    assert(row && bytesHash(path.join(review, 'audio', filename)) === row.audioSha256, `REVIEW_AUDIO_INVALID:${key}`);
  }
  const backup = readJson(path.join(review, 'backup-manifest.json'));
  const backupByPath = new Map(backup.files.map(item => [item.relativePath, item]));
  assert(backupByPath.get('assets/audio/VO_Act4.mp3')?.existed === true, 'ACT4_BACKUP_MISSING');
  for (const item of backup.files) {
    const current = path.join(ROOT, item.relativePath);
    if (item.existed) assert(fs.existsSync(current) && bytesHash(current) === item.sha256, `LIVE_FILE_CHANGED_SINCE_BACKUP:${item.relativePath}`);
    else assert(!fs.existsSync(current), `NEW_FILE_APPEARED_SINCE_BACKUP:${item.relativePath}`);
  }
  const captured = readJson(path.join(CANDIDATE, 'source-hash-manifest.json'));
  const liveTargets = { 'script.json': 'script', 'edit-plan.json': 'editPlan', 'edit-plan-validation.json': 'validation', 'assets/audio/VO_Act3B.mp3': 'act3bAudio', 'shot-definitions.json': 'shotDefinitions', 'production-manifest.json': 'productionManifest' };
  for (const [relative, key] of Object.entries(liveTargets)) assert(bytesHash(path.join(ROOT, relative)) === status.liveHashes[relative], `LIVE_HASH_CHANGED:${relative}`);
  for (const [key, item] of Object.entries(captured.files)) assert(bytesHash(path.resolve(item.remotePath)) === status.liveHashes[item.localFile], `LIVE_CAPTURE_CHANGED:${key}`);
  const parent = path.dirname(ROOT); const stage = path.join(parent, `.EmpireOmitted_V3_SHADOW_WELLSFARGO-candidate-${runId}`);
  assert(!fs.existsSync(stage), 'STAGE_DIRECTORY_EXISTS');
  execFileSync('cp', ['-al', ROOT, stage], { stdio: 'ignore' });
  const stageFile = relative => path.join(stage, relative);
  const source = relative => path.join(CANDIDATE, relative);
  let promoted = false;
  try {
    const basePlan = readJson(source('candidate-edit-plan-pretiming.json'));
    const plan = structuredClone(basePlan);
    const text = readJson(source('narration-texts.json'));
    const script = readJson(source('candidate-script.json'));
    for (const act of ['act3b','act4']) script.acts[act].voScript = text[act].next;
    const input = readJson(source('source-hash-manifest.json'));
    const oldWords = readJson(path.resolve(input.files.wordTimestamps.remotePath));
    const oldAudio = {};
    for (const [act, vo] of ACTS) {
      const file = path.join(ROOT, 'assets', 'audio', `${vo}.mp3`);
      oldAudio[act] = bytesHash(file);
    }
    const audioDir = path.join(review, 'stage-b-audio'); fs.mkdirSync(audioDir, { recursive: true });
    for (const [, vo] of ACTS) {
      const name = `${vo}.mp3`;
      const replacement = path.join(review, 'audio', name);
      const original = path.join(ROOT, 'assets', 'audio', name);
      fs.copyFileSync(replacement === original ? original : (fs.existsSync(replacement) ? replacement : original), path.join(audioDir, name));
    }
    const timingRelative = `.v3-shadow/timing/phase2.3b-sg-${runId}`;
    const timingDir = path.join(stage, timingRelative); fs.mkdirSync(timingDir, { recursive: true });
    const unchangedVo = new Set(['VO_Act1','VO_Act2','VO_Act3','VO_Act5']);
    const partial = Object.fromEntries([...unchangedVo].map(vo => [vo, oldWords.filter(word => word.vo_file === vo)]));
    atomicJson(path.join(timingDir, 'word-timestamps.partial.json'), partial);
    const { runWhisper } = require('/data/pipeline/vo-timing.cjs');
    const timestamps = await runWhisper({ audioDir, episodeDir: timingDir });
    const { probeMp3Default } = require('/data/pipeline/act-voice-generator.cjs');
    const durations = {};
    for (const [act, vo] of ACTS) durations[act] = (await probeMp3Default(path.join(audioDir, `${vo}.mp3`))).durationSec;
    retimePlan(plan, timestamps, durations);
    const { validateEditPlan } = require('/data/pipeline/edit-plan-validator.cjs');
    const planValidation = validateEditPlan({ plan, wordTimestamps: timestamps });
    assert(planValidation.status === 'PASS', `EDIT_PLAN_VALIDATION:${planValidation.errors?.[0]?.code || 'FAIL'}`);
    const planSha = fileHashFor(plan);
    const shotDefs = readJson(source('candidate-shot-definitions-pretiming.json'));
    shotDefs.sourceEditPlanSha256 = planSha;
    const byBeat = new Map(plan.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat])));
    for (const shot of shotDefs.allShots) {
      const beat = byBeat.get(shot.beatId); assert(beat, `SHOT_WITHOUT_BEAT:${shot.beatId}`);
      for (const field of ['startWordIndex','endWordIndex','startSec','endSec','durationSec','narrationExcerpt']) shot[field] = beat[field];
    }
    for (const shot of shotDefs.allShots) {
      const original = readJson(source('candidate-shot-definitions-pretiming.json')).allShots.find(item => item.shotId === shot.shotId);
      const clean = value => Object.fromEntries(Object.entries(value).filter(([key]) => !DYNAMIC.has(key) && key !== 'sourceEditPlanSha256'));
      assert(equal(clean(shot), clean(original)), `CREATIVE_FIELD_CHANGED:${shot.shotId}`);
    }
    const preTimingShotDefs = readJson(source('candidate-shot-definitions-pretiming.json'));
    const timingFields = ['startWordIndex','endWordIndex','startSec','endSec','durationSec','narrationExcerpt'];
    const timingEntries = [];
    const permittedImmutablePaths = [];
    for (const shot of shotDefs.allShots) {
      const before = preTimingShotDefs.allShots.find(item => item.shotId === shot.shotId);
      for (const field of timingFields) if (!equal(before[field], shot[field])) {
        const fieldPath = `${shot.shotId}.${field}`;
        permittedImmutablePaths.push(fieldPath);
        timingEntries.push({ shotId: shot.shotId, beatId: shot.beatId, fieldPath: field, beforeValue: before[field], afterValue: shot[field], reason: 'Approved deterministic timing propagation from the two authorized replacement VO acts; creative direction remains frozen.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-SG' });
      }
    }
    const timingLedger = {
      ledgerVersion: '1.0.0', revisionId: `phase2.3b-sg-retiming-${runId}`, revisionVersion: '2.3B-SG', lineageRole: 'current', approvalStatus: 'APPROVED',
      approval: { status: 'APPROVED', basis: 'CTO-approved two-act finished-VO correction with deterministic downstream timing propagation.' },
      parentArtifactSha256: readJson(source('revision-ledger.phase2.3b-sv-amendment.v1.json')).resultArtifactSha256,
      resultArtifactSha256: sha(jsonBytes(shotDefs)), permittedImmutablePaths, entries: timingEntries,
      bindings: [{ fieldPath: 'sourceEditPlanSha256', beforeValue: preTimingShotDefs.sourceEditPlanSha256, afterValue: planSha, reason: 'Approved retiming binds shot definitions to the final finished-VO edit plan.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-SG' }],
    };
    const lineage = [readJson(source('revision-ledger.phase2.2d-lineage.v1.json')), readJson(source('revision-ledger.phase2.3b-sv-amendment.v1.json')), timingLedger];
    const { validateShotDefinitions } = require('/data/pipeline/shot-definitions-validator.cjs');
    const shotValidation = validateShotDefinitions({ plan, shotDefs, revisionChain: lineage });
    assert(shotValidation.status === 'PASS', `SHOT_VALIDATION:${shotValidation.errors?.[0]?.code || 'FAIL'}`);
    atomicJson(path.join(review, 'revision-ledger.phase2.3b-sg-retiming.v1.json'), timingLedger);
    const manifest = readJson(source('candidate-production-manifest-pretiming.json'));
    manifest.sourceEditPlanSha256 = planSha; manifest.candidateSha256 = sha(jsonBytes(shotDefs));
    const { validateProductionMethodManifest } = require('/data/pipeline/production-method-manifest.cjs');
    assert(validateProductionMethodManifest({ manifest, shotDefs, candidateSha256: manifest.candidateSha256 }).status === 'PASS', 'PRODUCTION_MANIFEST_VALIDATION');
    const evidencePath = stageFile('evidence-source-manifest.json');
    assert(fs.existsSync(evidencePath), 'EVIDENCE_MANIFEST_MISSING');
    const evidence = readJson(evidencePath); evidence.shotDefinitionsSha256 = sha(jsonBytes(shotDefs));
    const shotById = new Map(shotDefs.allShots.map(shot => [shot.shotId, shot]));
    for (const entry of evidence.entries || []) if (shotById.has(entry.shotId)) entry.exactSourceRequirement = shotById.get(entry.shotId).evidenceRequirement?.description;
    const { validateEvidenceSourceManifest } = require('/data/pipeline/evidence-source-validator.cjs');
    const evidenceValidation = validateEvidenceSourceManifest({ manifest: evidence, shotDefs, evidenceAssetDir: stageFile('assets/evidence') });
    assert(evidenceValidation.status === 'PASS', `EVIDENCE_VALIDATION:${evidenceValidation.errors?.[0]?.code || 'FAIL'}`);
    const { planProofSection } = require('/data/pipeline/proof-section-planner.cjs');
    const proofPlan = planProofSection({ shotDefs, productionManifest: manifest });
    const statusArtifact = readJson(stageFile('edit-plan-shadow-status.json'));
    statusArtifact.status = 'complete'; statusArtifact.editPlanStatus = 'PASS'; statusArtifact.timingCache = timingRelative;
    atomicJson(stageFile('script.json'), script); atomicJson(stageFile('edit-plan.json'), plan);
    atomicJson(stageFile('edit-plan-validation.json'), planValidation); atomicJson(stageFile('shot-definitions.json'), shotDefs);
    atomicJson(stageFile('production-manifest.json'), manifest); atomicJson(stageFile('evidence-source-manifest.json'), evidence);
    atomicJson(stageFile('proof-section-plan.json'), proofPlan); atomicJson(stageFile('edit-plan-shadow-status.json'), statusArtifact);
    for (const name of ['VO_Act3B.mp3','VO_Act4.mp3']) fs.copyFileSync(path.join(review, 'audio', name), stageFile(path.join('assets','audio',name)));
    for (const [act, vo] of ACTS) if (!['act3b','act4'].includes(act)) assert(bytesHash(stageFile(path.join('assets','audio',`${vo}.mp3`))) === oldAudio[act], `UNRELATED_AUDIO_CHANGED:${act}`);
    const outputs = ['script.json','assets/audio/VO_Act3B.mp3','assets/audio/VO_Act4.mp3','edit-plan.json','edit-plan-validation.json','edit-plan-shadow-status.json','shot-definitions.json','production-manifest.json','evidence-source-manifest.json','proof-section-plan.json',path.join(timingRelative,'word-timestamps.json')];
    const report = { schemaVersion: 'phase2.3b-sg-stage-b/1.0.0', runId, status: 'VALIDATED_NOT_PROMOTED', createdAt: new Date().toISOString(), outputs: Object.fromEntries(outputs.map(rel => [rel, bytesHash(stageFile(rel))])), changedActKeys: ['act3b','act4'], unchangedAudioHashes: oldAudio, validation: { editPlan: planValidation.status, shotDefinitions: shotValidation.status, productionManifest: 'PASS', evidenceManifest: evidenceValidation.status } };
    atomicJson(path.join(review, 'stage-b-report.json'), report);
    // Exact directory swap is attempted only after every candidate is persisted and checked.
    execFileSync('python3', ['/app/scripts/phase2.3b-sg-atomic-exchange.py', ROOT, stage], { stdio: 'ignore' });
    promoted = true;
    for (const [relative, expected] of Object.entries(report.outputs)) assert(bytesHash(path.join(ROOT, relative)) === expected, `PROMOTED_HASH_MISMATCH:${relative}`);
    report.status = 'PROMOTED'; report.promotedAt = new Date().toISOString(); atomicJson(path.join(ROOT,'.review',`phase2.3b-sg-${runId}`,'stage-b-report.json'), report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    // Keep the complete candidate tree for diagnosis; active episode was never
    // changed unless the atomic exchange succeeded.
    if (promoted) {
      try { execFileSync('python3', ['/app/scripts/phase2.3b-sg-atomic-exchange.py', ROOT, stage], { stdio: 'ignore' }); }
      catch (_) { console.error('ROLLBACK_EXCHANGE_FAILED: preserve both trees and stop all further work.'); }
    }
    console.error(`STAGE_B_FAILED:${String(error.message || 'failure').split(':')[0]} candidate=${stage}`);
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(`STAGE_B_FATAL:${String(error.message || 'failure').split(':')[0]}`); process.exitCode = 1; });
