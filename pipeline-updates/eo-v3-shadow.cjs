'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const VO_FILES = [
  ['VO_Act1.mp3', 'act1', 'VO_Act1'],
  ['VO_Act2.mp3', 'act2', 'VO_Act2'],
  ['VO_Act3.mp3', 'act3', 'VO_Act3'],
  ['VO_Act3B.mp3', 'act3b', 'VO_Act3B'],
  ['VO_Act4.mp3', 'act4', 'VO_Act4'],
  ['VO_Act5.mp3', 'act5', 'VO_Act5'],
];
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function canonicalChannel(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[\s_-]/g, '') : '';
}

function assertEmpireOmitted(channelDna, channel) {
  const values = [channel, channelDna?.id, channelDna?.label]
    .filter(value => typeof value === 'string' && value.trim());
  if (!values.length || values.some(value => canonicalChannel(value) !== 'empireomitted')) {
    throw new Error('[eo-v3-shadow] Empire Omitted V3 shadow cannot be used for another channel.');
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function voSetFingerprint(files) {
  return crypto.createHash('sha256').update(JSON.stringify(files.map(({ filename, sha256 }) => ({ filename, sha256 })))).digest('hex');
}

function runFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`ffprobe failed: ${(stderr || error.message).trim().slice(-1500)}`));
      resolve(stdout);
    });
  });
}

async function probeDurationDefault(filePath) {
  const output = await runFile(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ]);
  const duration = Number.parseFloat(String(output).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid audio duration for ${path.basename(filePath)}.`);
  return duration;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(tempPath, filePath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
  }
}

function validateTimingPreflight(wordTimestamps) {
  if (!Array.isArray(wordTimestamps)) throw new Error('[eo-v3-shadow] Whisper timing must be an array.');
  const expected = new Set(VO_FILES.map(([, , voKey]) => voKey));
  const byAct = new Map(VO_FILES.map(([, , voKey]) => [voKey, []]));
  for (const [index, word] of wordTimestamps.entries()) {
    if (!word || typeof word !== 'object' || Array.isArray(word)) {
      throw new Error(`[eo-v3-shadow] Invalid timing record at index ${index}.`);
    }
    if (!expected.has(word.vo_file)) {
      throw new Error(`[eo-v3-shadow] Unexpected VO key in timing record: ${String(word.vo_file)}.`);
    }
    if (typeof word.word !== 'string' || !Number.isFinite(word.start_seconds)
      || !Number.isFinite(word.end_seconds) || word.start_seconds < 0
      || word.end_seconds < word.start_seconds) {
      throw new Error(`[eo-v3-shadow] Invalid timing record for ${word.vo_file} at index ${index}.`);
    }
    byAct.get(word.vo_file).push(word);
  }
  for (const [, , voKey] of VO_FILES) {
    const words = byAct.get(voKey);
    if (!words.length) throw new Error(`[eo-v3-shadow] Missing timed words for ${voKey}.`);
    for (let index = 1; index < words.length; index++) {
      if (words[index].start_seconds < words[index - 1].end_seconds - 0.001) {
        throw new Error(`[eo-v3-shadow] Overlapping or out-of-order timing for ${voKey}.`);
      }
    }
  }
}

async function runEmpireOmittedV3Shadow({
  script, audioDir, episodeDir, episodeId, channel, channelDna,
  runWhisper: injectedRunWhisper,
  generateEditPlan: injectedGenerateEditPlan,
  probeDuration: injectedProbeDuration,
  writeStatus: injectedWriteStatus,
} = {}) {
  if (!episodeDir || typeof episodeDir !== 'string') throw new Error('[eo-v3-shadow] episodeDir is required.');
  const statusPath = path.join(episodeDir, 'edit-plan-shadow-status.json');
  const startedAt = new Date().toISOString();
  let stage = 'vo_preflight';
  let identity = null;
  const persistStatus = injectedWriteStatus || writeJsonAtomic;
  const writeStatus = (status, errorStage, editPlanStatus, durations) => persistStatus(statusPath, {
    version: 1, status, episodeId: typeof episodeId === 'string' ? episodeId : null,
    channel: 'EmpireOmitted', voSetFingerprint: identity?.voSetFingerprint || null,
    timingCache: identity ? path.relative(episodeDir, identity.timingDir).replace(/\\/g, '/') : null,
    actDurationsSec: durations || null, editPlanStatus: editPlanStatus || null,
    errorStage: errorStage || null,
    error: errorStage ? ({
      vo_preflight: 'Finished VO preflight failed.',
      vo_identity: 'Finished VO identity calculation failed.',
      vo_duration: 'Finished VO duration probing failed.',
      vo_timing: 'Finished VO timing/transcription failed.',
      director: 'V3 Director generation failed.',
    }[errorStage] || 'Empire Omitted V3 shadow failed.') : null,
    startedAt, finishedAt: new Date().toISOString(),
  });
  try {
    assertEmpireOmitted(channelDna, channel);
    if (!audioDir || typeof audioDir !== 'string') throw new Error('[eo-v3-shadow] audioDir is required.');
    if (typeof episodeId !== 'string' || !episodeId.trim()) throw new Error('[eo-v3-shadow] episodeId is required.');
    const missing = VO_FILES.filter(([filename]) => {
      const filePath = path.join(audioDir, filename);
      if (!fs.existsSync(filePath)) return true;
      const stat = fs.statSync(filePath);
      return !stat.isFile() || stat.size === 0;
    }).map(([filename]) => filename);
    if (missing.length) throw new Error(`[eo-v3-shadow] Missing finished VO file(s): ${missing.join(', ')}`);

    stage = 'vo_identity';
    const files = VO_FILES.map(([filename]) => ({ filename, sha256: sha256File(path.join(audioDir, filename)) }));
    const voFingerprint = voSetFingerprint(files);
    const timingDir = path.join(episodeDir, '.v3-shadow', 'timing', voFingerprint);
    identity = { files, voSetFingerprint: voFingerprint, timingDir };

    stage = 'vo_duration';
    const probeDuration = injectedProbeDuration || probeDurationDefault;
    const actDurationsSec = {};
    for (const [filename, actKey] of VO_FILES) {
      const duration = await probeDuration(path.join(audioDir, filename));
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`[eo-v3-shadow] Invalid duration for ${filename}.`);
      actDurationsSec[actKey] = duration;
    }
    identity.actDurationsSec = actDurationsSec;

    stage = 'vo_timing';
    const runWhisper = injectedRunWhisper || require('./vo-timing.cjs').runWhisper;
    const wordTimestamps = await runWhisper({ audioDir, episodeDir: timingDir });
    validateTimingPreflight(wordTimestamps);

    stage = 'director';
    const generateEditPlan = injectedGenerateEditPlan || require('./edit-plan-generator.cjs').generateEditPlan;
    const editPlan = await generateEditPlan({
      script, wordTimestamps, actDurationsSec, channelDna,
      episodeId: episodeId.trim(), outputDir: episodeDir, channel: 'EmpireOmitted',
    });
    writeStatus('complete', null, 'PASS', actDurationsSec);
    return { editPlan, wordTimestamps, actDurationsSec, voFiles: files, voSetFingerprint: voFingerprint, timingDir, statusPath };
  } catch (error) {
    try {
      writeStatus('failed', stage, null, identity?.actDurationsSec || null);
    } catch (_) {
      console.warn('[eo-v3-shadow] Unable to write shadow status artifact.');
    }
    throw error;
  }
}

module.exports = {
  runEmpireOmittedV3Shadow,
  VO_FILES,
  sha256File,
  voSetFingerprint,
  probeDurationDefault,
  writeJsonAtomic,
};
