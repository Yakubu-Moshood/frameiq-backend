'use strict';

const crypto = require('node:crypto');
const fsDefault = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MODEL = 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';
const APPROVED_VOICE_SETTINGS = Object.freeze({
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1,
});
const LEDGER_VERSION = 'act-voice-request-ledger/1.0.0';
const MIN_MP3_BYTES = 1024;
const SAFE_ACT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function voiceFingerprint(voiceId, apiKey) {
  return crypto.createHmac('sha256', apiKey).update(voiceId).digest('hex');
}

function atomicWriteJson(fs, filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch (_) { /* preserve the primary result */ }
  }
}

function withExclusiveFileLock(fs, lockPath, operation) {
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('ACT_VOICE_LOCKED: an earlier act-voice operation may still be active; inspect its ledger and lock before proceeding.');
    throw new Error('ACT_VOICE_LOCK_FAILED: unable to acquire the operation lock.');
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
    return operation();
  } finally {
    try { fs.closeSync(descriptor); } catch (_) {}
    try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
  }
}

function withExclusiveFileLockAsync(fs, lockPath, operation) {
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('ACT_VOICE_LOCKED: an earlier act-voice operation may still be active; inspect its ledger and lock before proceeding.');
    throw new Error('ACT_VOICE_LOCK_FAILED: unable to acquire the operation lock.');
  }
  return Promise.resolve().then(() => {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
    return operation();
  }).finally(() => {
    try { fs.closeSync(descriptor); } catch (_) {}
    try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
  });
}

function readLedger(fs, ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return { schemaVersion: LEDGER_VERSION, attempts: [] };
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
  catch (_) { throw new Error('ACT_VOICE_LEDGER_INVALID: request ledger is unreadable JSON; refusing to spend.'); }
  if (!ledger || ledger.schemaVersion !== LEDGER_VERSION || !Array.isArray(ledger.attempts)) {
    throw new Error('ACT_VOICE_LEDGER_INVALID: request ledger schema is unsupported; refusing to spend.');
  }
  return ledger;
}

function updateLedger(fs, ledgerPath, mutate) {
  const lockPath = `${ledgerPath}.lock`;
  return withExclusiveFileLock(fs, lockPath, () => {
    const ledger = readLedger(fs, ledgerPath);
    mutate(ledger);
    atomicWriteJson(fs, ledgerPath, ledger);
    return ledger;
  });
}

function probeMp3Default(filePath, { ffprobePath = process.env.FFPROBE_PATH || 'ffprobe', execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=format_name,duration', '-of', 'json', filePath,
    ], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error('ACT_VOICE_FFPROBE_FAILED: generated audio could not be probed.'));
      let metadata;
      try { metadata = JSON.parse(stdout); }
      catch (_) { return reject(new Error('ACT_VOICE_FFPROBE_FAILED: ffprobe returned invalid metadata.')); }
      const durationSec = Number(metadata?.format?.duration);
      const formatNames = String(metadata?.format?.format_name || '').split(',');
      if (!formatNames.includes('mp3') || !Number.isFinite(durationSec) || durationSec <= 0) {
        return reject(new Error('ACT_VOICE_AUDIO_INVALID: output is not a positive-duration MP3.'));
      }
      resolve({ format: 'mp3', durationSec });
    });
  });
}

function validateInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('ACT_VOICE_INPUT_INVALID: request must be an object.');
  if (Object.prototype.hasOwnProperty.call(args, 'acts') || Object.prototype.hasOwnProperty.call(args, 'actKeys')) {
    throw new Error('ACT_VOICE_SINGLE_ACT_ONLY: provide one actKey per call.');
  }
  for (const key of ['channel', 'episodeId', 'actKey', 'text', 'expectedTextSha256', 'outputPath', 'ledgerPath']) {
    if (typeof args[key] !== 'string' || (key !== 'text' && !args[key].trim())) throw new Error(`ACT_VOICE_INPUT_INVALID: ${key} is required.`);
  }
  if (!SAFE_ACT_KEY.test(args.actKey)) throw new Error('ACT_VOICE_INPUT_INVALID: actKey must be one safe token.');
  if (!Number.isSafeInteger(args.maximumCharacters) || args.maximumCharacters < 1) throw new Error('ACT_VOICE_INPUT_INVALID: maximumCharacters must be a positive integer.');
  if (!/^[a-f0-9]{64}$/.test(args.expectedTextSha256)) throw new Error('ACT_VOICE_INPUT_INVALID: expectedTextSha256 must be lowercase SHA-256.');
  if (sha256(args.text) !== args.expectedTextSha256) throw new Error('ACT_VOICE_TEXT_HASH_MISMATCH: narration text does not match the approved hash.');
  if (!args.text.trim()) throw new Error('ACT_VOICE_TEXT_EMPTY: narration text is empty.');
  if (args.text.length > args.maximumCharacters) throw new Error('ACT_VOICE_TEXT_TOO_LONG: narration exceeds maximumCharacters.');
  if (args.allowOverwrite !== undefined && args.allowOverwrite !== false) throw new Error('ACT_VOICE_OVERWRITE_FORBIDDEN: allowOverwrite must be false.');
  if (args.model !== MODEL) throw new Error('ACT_VOICE_MODEL_INVALID: only the approved ElevenLabs model is permitted.');
  if (args.outputFormat !== OUTPUT_FORMAT) throw new Error('ACT_VOICE_FORMAT_INVALID: only the approved MP3 output format is permitted.');
  const suppliedSettings = args.voiceSettings && typeof args.voiceSettings === 'object' && !Array.isArray(args.voiceSettings)
    ? Object.keys(args.voiceSettings).sort().map(key => [key, args.voiceSettings[key]]) : null;
  const expectedSettings = Object.keys(APPROVED_VOICE_SETTINGS).sort().map(key => [key, APPROVED_VOICE_SETTINGS[key]]);
  if (!suppliedSettings || JSON.stringify(suppliedSettings) !== JSON.stringify(expectedSettings)) {
    throw new Error('ACT_VOICE_SETTINGS_INVALID: voice settings must exactly match the approved values.');
  }
}

function safeReport(attempt) {
  return {
    requestId: attempt.requestId,
    channel: attempt.channel,
    episodeId: attempt.episodeId,
    actKey: attempt.actKey,
    textSha256: attempt.textSha256,
    voiceIdFingerprint: attempt.voiceIdFingerprint,
    provider: 'elevenlabs',
    model: attempt.model,
    outputFormat: attempt.outputFormat,
    voiceSettings: { ...attempt.voiceSettings },
    status: attempt.status,
    httpStatus: attempt.httpStatus ?? null,
    contentType: attempt.contentType ?? null,
    audioSha256: attempt.audioSha256 ?? null,
    audioBytes: attempt.audioBytes ?? null,
    durationSec: attempt.durationSec ?? null,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt ?? null,
    errorCode: attempt.errorCode ?? null,
  };
}

async function generateActVoice(args = {}, dependencies = {}) {
  validateInput(args);
  const fs = dependencies.fs || fsDefault;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const probeAudio = dependencies.probeAudio || (filePath => probeMp3Default(filePath, dependencies));
  if (typeof fetchImpl !== 'function') throw new Error('ACT_VOICE_FETCH_UNAVAILABLE: fetch implementation is unavailable.');
  const outputPath = path.resolve(args.outputPath);
  const ledgerPath = path.resolve(args.ledgerPath);
  const partialPath = `${outputPath}.partial`;
  const operationLockPath = `${outputPath}.act-voice.lock`;
  if (outputPath === ledgerPath || outputPath === partialPath || ledgerPath === partialPath) throw new Error('ACT_VOICE_PATH_INVALID: output and ledger paths must be distinct.');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) throw new Error('ACT_VOICE_OUTPUT_EXISTS: refusing to overwrite an existing final audio file.');
  if (fs.existsSync(partialPath)) throw new Error('ACT_VOICE_PARTIAL_EXISTS: refusing to overwrite or resume a partial audio file.');

  const resolver = dependencies.resolveChannelDna || (async channel => require('./config-reader.cjs').getChannelConfigByLabel(channel));
  const dna = args.channelDna || await resolver(args.channel);
  const voiceId = dna?.voice_id_elevenlabs || dna?.elevenlabs_voice_id || process.env.ELEVENLABS_VOICE_ID;
  if (typeof voiceId !== 'string' || !voiceId.trim()) throw new Error('ACT_VOICE_ID_MISSING: no ElevenLabs voice is configured for this channel.');
  const apiKey = dependencies.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('ACT_VOICE_CREDENTIAL_MISSING: ElevenLabs credentials are unavailable.');
  const maxRequests = args.maximumRequests === undefined ? Infinity : args.maximumRequests;
  if (!(maxRequests === Infinity || (Number.isSafeInteger(maxRequests) && maxRequests >= 1))) throw new Error('ACT_VOICE_INPUT_INVALID: maximumRequests must be a positive integer.');

  return withExclusiveFileLockAsync(fs, operationLockPath, async () => {
    // Recheck after locking to close the race between preflight and reservation.
    if (fs.existsSync(outputPath)) throw new Error('ACT_VOICE_OUTPUT_EXISTS: refusing to overwrite an existing final audio file.');
    if (fs.existsSync(partialPath)) throw new Error('ACT_VOICE_PARTIAL_EXISTS: refusing to overwrite or resume a partial audio file.');
    const ledgerLock = `${ledgerPath}.lock`;
    const attempt = {
      requestId: crypto.randomUUID(), channel: args.channel, episodeId: args.episodeId,
      actKey: args.actKey, textSha256: args.expectedTextSha256,
      voiceIdFingerprint: voiceFingerprint(voiceId, apiKey), provider: 'elevenlabs',
      model: MODEL, outputFormat: OUTPUT_FORMAT, voiceSettings: { ...APPROVED_VOICE_SETTINGS },
      status: 'RESERVED', httpStatus: null, contentType: null, audioSha256: null,
      audioBytes: null, durationSec: null, startedAt: new Date().toISOString(),
      finishedAt: null, errorCode: null,
    };
    withExclusiveFileLock(fs, ledgerLock, () => {
      const ledger = readLedger(fs, ledgerPath);
      const duplicate = ledger.attempts.some(item => item.channel === args.channel
        && item.episodeId === args.episodeId && item.actKey === args.actKey
        && item.textSha256 === args.expectedTextSha256);
      if (duplicate) throw new Error('ACT_VOICE_ATTEMPT_ALREADY_RECORDED: this act and text hash already consumed a request reservation.');
      if (ledger.attempts.length >= maxRequests) throw new Error('ACT_VOICE_REQUEST_LIMIT_REACHED: request ledger has consumed its approved request budget.');
      ledger.attempts.push(attempt);
      atomicWriteJson(fs, ledgerPath, ledger);
    });

    const finishLedger = (status, details = {}) => withExclusiveFileLock(fs, ledgerLock, () => {
      const ledger = readLedger(fs, ledgerPath);
      const entry = ledger.attempts.find(item => item.requestId === attempt.requestId);
      if (!entry) throw new Error('ACT_VOICE_LEDGER_LOST: reserved request record is missing.');
      Object.assign(entry, details, { status, finishedAt: new Date().toISOString() });
      atomicWriteJson(fs, ledgerPath, ledger);
      Object.assign(attempt, details, { status, finishedAt: entry.finishedAt });
    });

    try {
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`;
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text: args.text, model_id: MODEL, voice_settings: { ...APPROVED_VOICE_SETTINGS } }),
        });
      } catch (_) {
        await finishLedger('FAILED', { errorCode: 'PROVIDER_TRANSPORT_ERROR' });
        throw new Error('ACT_VOICE_PROVIDER_TRANSPORT_ERROR: request outcome is uncertain; the reservation remains consumed.');
      }
      const status = Number(response?.status);
      const contentType = String(response?.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response?.ok || status < 200 || status >= 300) {
        await finishLedger('FAILED', { httpStatus: Number.isFinite(status) ? status : null, contentType, errorCode: 'PROVIDER_HTTP_ERROR' });
        throw new Error(`ACT_VOICE_PROVIDER_HTTP_ERROR: ElevenLabs returned HTTP ${Number.isFinite(status) ? status : 'unknown'}; no retry was made.`);
      }
      if (!['audio/mpeg', 'audio/mp3'].includes(contentType)) {
        await finishLedger('REJECTED', { httpStatus: status, contentType, errorCode: 'INVALID_CONTENT_TYPE' });
        throw new Error('ACT_VOICE_CONTENT_TYPE_INVALID: provider response was not an MP3 media type.');
      }
      let bytes;
      try { bytes = Buffer.from(await response.arrayBuffer()); }
      catch (_) {
        await finishLedger('FAILED', { httpStatus: status, contentType, errorCode: 'RESPONSE_BODY_ERROR' });
        throw new Error('ACT_VOICE_RESPONSE_BODY_ERROR: provider response body could not be read; reservation remains consumed.');
      }
      // The final output is never opened directly. Create a new same-directory
      // partial file, validate it, and only then perform the atomic rename.
      try { fs.writeFileSync(partialPath, bytes, { flag: 'wx' }); }
      catch (_) {
        await finishLedger('REJECTED', { httpStatus: status, contentType, errorCode: 'PARTIAL_WRITE_FAILED' });
        throw new Error('ACT_VOICE_PARTIAL_WRITE_FAILED: could not create the exclusive partial output.');
      }
      const hasId3 = bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
      const hasMpegSync = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
      if (bytes.length < MIN_MP3_BYTES || (!hasId3 && !hasMpegSync)) {
        await finishLedger('REJECTED', { httpStatus: status, contentType, audioBytes: bytes.length, errorCode: 'INVALID_MP3_SIGNATURE_OR_SIZE' });
        throw new Error('ACT_VOICE_AUDIO_INVALID: response is too small or has no MP3 signature; partial retained for diagnosis.');
      }
      let probed;
      try { probed = await probeAudio(partialPath); }
      catch (_) {
        await finishLedger('REJECTED', { httpStatus: status, contentType, audioBytes: bytes.length, errorCode: 'FFPROBE_FAILED' });
        throw new Error('ACT_VOICE_FFPROBE_FAILED: generated audio failed media validation; partial retained for diagnosis.');
      }
      const durationSec = typeof probed === 'number' ? probed : Number(probed?.durationSec);
      const format = typeof probed === 'number' ? 'mp3' : String(probed?.format || probed?.formatName || '');
      if (!(durationSec > 0) || !Number.isFinite(durationSec) || !format.toLowerCase().includes('mp3')) {
        await finishLedger('REJECTED', { httpStatus: status, contentType, audioBytes: bytes.length, errorCode: 'FFPROBE_FORMAT_INVALID' });
        throw new Error('ACT_VOICE_AUDIO_INVALID: ffprobe did not confirm positive-duration MP3 media; partial retained for diagnosis.');
      }
      if (fs.existsSync(outputPath)) {
        await finishLedger('REJECTED', { httpStatus: status, contentType, audioBytes: bytes.length, durationSec, errorCode: 'OUTPUT_APPEARED_DURING_REQUEST' });
        throw new Error('ACT_VOICE_OUTPUT_EXISTS: destination appeared during the request; partial retained and not promoted.');
      }
      const audioSha256 = sha256(bytes);
      fs.renameSync(partialPath, outputPath);
      await finishLedger('COMPLETE', { httpStatus: status, contentType, audioSha256, audioBytes: bytes.length, durationSec });
      return safeReport(attempt);
    } catch (error) {
      // Provider or validation errors have already recorded a terminal state.
      // Unexpected local failures still consume the reservation.
      try {
        const latest = readLedger(fs, ledgerPath).attempts.find(item => item.requestId === attempt.requestId);
        if (latest?.status === 'RESERVED') await finishLedger('FAILED', { errorCode: 'LOCAL_EXECUTION_ERROR' });
      } catch (_) { /* a RESERVED row remains fail-closed if ledger I/O failed */ }
      if (error instanceof Error && /^ACT_VOICE_/.test(error.message)) throw error;
      throw new Error('ACT_VOICE_LOCAL_EXECUTION_ERROR: operation failed; inspect the ledger and partial before recovery.');
    }
  });
}

module.exports = {
  generateActVoice,
  MODEL,
  OUTPUT_FORMAT,
  APPROVED_VOICE_SETTINGS,
  LEDGER_VERSION,
  MIN_MP3_BYTES,
  sha256,
  voiceFingerprint,
  probeMp3Default,
};
