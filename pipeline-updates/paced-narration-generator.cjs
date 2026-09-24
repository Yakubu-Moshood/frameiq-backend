'use strict';

const crypto = require('node:crypto');
const fsDefault = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const MODEL = 'eleven_multilingual_v2';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_MAX_SEGMENT_CHARACTERS = 720;
const DEFAULT_JOIN_PAUSE_MS = 350;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const execFileAsync = promisify(execFile);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function lexicalTokens(value) {
  return (String(value).normalize('NFKC').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [])
    .map(token => token.toLocaleLowerCase('en'));
}

function wordCount(text) {
  return lexicalTokens(text).length;
}

const ABBREVIATIONS = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'u.s.', 'u.k.', 'e.g.', 'i.e.', 'a.m.', 'p.m.', 'vs.', 'etc.', 'inc.', 'ltd.']);

function splitSentences(text) {
  const result = [];
  let sentenceStart = 0;
  const boundary = /[.!?]+["'’”)}\]]*(?=\s|$)/gu;
  let match;
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const candidate = text.slice(sentenceStart, end);
    const trimmed = candidate.trim();
    const lastToken = trimmed.split(/\s+/u).at(-1)?.toLocaleLowerCase('en') || '';
    const previous = text[match.index - 1] || '';
    const next = text[end] || '';
    const decimalPoint = match[0][0] === '.' && /\d/u.test(previous) && /\d/u.test(next);
    const initial = match[0][0] === '.' && /^[A-Z]$/u.test(trimmed.slice(-2, -1)) && /\s+[A-Z]/u.test(text.slice(end));
    if (decimalPoint || initial || (match[0][0] === '.' && ABBREVIATIONS.has(lastToken))) continue;
    if (trimmed) {
      const leading = candidate.length - candidate.trimStart().length;
      result.push({ text: trimmed, start: sentenceStart + leading, end });
    }
    sentenceStart = end;
    while (/\s/u.test(text[sentenceStart] || '')) sentenceStart += 1;
    boundary.lastIndex = sentenceStart;
  }
  const tail = text.slice(sentenceStart);
  if (tail.trim()) {
    const leading = tail.length - tail.trimStart().length;
    result.push({ text: tail.trim(), start: sentenceStart + leading, end: sentenceStart + tail.trimEnd().length });
  }
  return result;
}

function validateVoiceSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('PACED_VOICE_SETTINGS_INVALID');
  const required = ['stability', 'similarity_boost', 'style', 'use_speaker_boost', 'speed'];
  const keys = Object.keys(settings).sort();
  if (JSON.stringify(keys) !== JSON.stringify(required.slice().sort())
      || !Number.isFinite(settings.stability) || settings.stability < 0 || settings.stability > 1
      || !Number.isFinite(settings.similarity_boost) || settings.similarity_boost < 0 || settings.similarity_boost > 1
      || !Number.isFinite(settings.style) || settings.style < 0 || settings.style > 1
      || typeof settings.use_speaker_boost !== 'boolean'
      || !Number.isFinite(settings.speed) || settings.speed < 0.7 || settings.speed > 1.2) {
    throw new Error('PACED_VOICE_SETTINGS_INVALID');
  }
  return { ...settings };
}

function planPacedNarration(options = {}) {
  const channelKey = options.channelKey;
  const episodeDirectory = options.episodeDirectory;
  const actMap = options.actMap;
  if (typeof channelKey !== 'string' || !channelKey.trim()) throw new Error('PACED_PLAN_CHANNEL_REQUIRED');
  if (typeof episodeDirectory !== 'string' || !path.isAbsolute(episodeDirectory)) throw new Error('PACED_PLAN_EPISODE_DIRECTORY_REQUIRED');
  if (!actMap || typeof actMap !== 'object' || Array.isArray(actMap) || !Object.keys(actMap).length) throw new Error('PACED_PLAN_ACT_MAP_REQUIRED');
  const voiceSettings = validateVoiceSettings(options.voiceSettings);
  const outputFormat = options.outputFormat || DEFAULT_OUTPUT_FORMAT;
  const maximumSegmentLength = options.maximumSegmentLength === undefined ? DEFAULT_MAX_SEGMENT_CHARACTERS : options.maximumSegmentLength;
  const joinPauseDurationMs = options.joinPauseDurationMs === undefined ? DEFAULT_JOIN_PAUSE_MS : options.joinPauseDurationMs;
  const maximumRequests = options.maximumRequests;
  const maximumCharacters = options.maximumCharacters;
  for (const [name, value] of [['maximumSegmentLength', maximumSegmentLength], ['maximumRequests', maximumRequests], ['maximumCharacters', maximumCharacters]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('PACED_PLAN_LIMIT_INVALID:' + name);
  }
  if (!Number.isSafeInteger(joinPauseDurationMs) || joinPauseDurationMs < 0 || joinPauseDurationMs > 5000) throw new Error('PACED_PLAN_JOIN_PAUSE_INVALID');
  if (!/^mp3_[0-9]+_[0-9]+$/u.test(outputFormat)) throw new Error('PACED_PLAN_OUTPUT_FORMAT_INVALID');

  const acts = [];
  const flatSegments = [];
  let totalCharacters = 0;
  let totalWords = 0;
  for (const [actKey, source] of Object.entries(actMap)) {
    if (!SAFE_KEY.test(actKey)) throw new Error('PACED_PLAN_ACT_KEY_INVALID:' + actKey);
    if (!source || typeof source !== 'object' || typeof source.text !== 'string' || !source.text.trim()) throw new Error('PACED_PLAN_ACT_TEXT_INVALID:' + actKey);
    if (typeof source.voFilename !== 'string' || path.basename(source.voFilename) !== source.voFilename || !/^VO_[A-Za-z0-9_-]+\.mp3$/u.test(source.voFilename)) throw new Error('PACED_PLAN_VO_FILENAME_INVALID:' + actKey);
    const sentences = splitSentences(source.text);
    if (!sentences.length) throw new Error('PACED_PLAN_SENTENCES_EMPTY:' + actKey);
    const actSegments = [];
    let bucket = [];
    const flush = () => {
      if (!bucket.length) return;
      const performanceText = bucket.map(sentence => sentence.text).join('\n\n');
      const first = bucket[0];
      const last = bucket.at(-1);
      const segmentIndex = actSegments.length + 1;
      const segment = {
        segmentId: actKey + '.segment-' + String(segmentIndex).padStart(3, '0'),
        actKey,
        segmentIndex,
        voFilename: source.voFilename,
        sourceStart: first.start,
        sourceEnd: last.end,
        sourceTextSha256: sha256(source.text.slice(first.start, last.end)),
        text: performanceText,
        textSha256: sha256(performanceText),
        characters: performanceText.length,
        words: wordCount(performanceText),
      };
      if (segment.characters > maximumSegmentLength) throw new Error('PACED_PLAN_SEGMENT_OVER_LIMIT:' + segment.segmentId);
      actSegments.push(segment);
      flatSegments.push(segment);
      totalCharacters += segment.characters;
      totalWords += segment.words;
      bucket = [];
    };
    for (const sentence of sentences) {
      if (sentence.text.length > maximumSegmentLength) throw new Error('PACED_PLAN_OVERSIZED_SENTENCE:' + actKey + ':' + sentence.start);
      const candidate = bucket.length ? bucket.map(item => item.text).join('\n\n') + '\n\n' + sentence.text : sentence.text;
      if (candidate.length > maximumSegmentLength) flush();
      bucket.push(sentence);
    }
    flush();
    const sourceWords = lexicalTokens(source.text);
    const performanceWords = lexicalTokens(actSegments.map(segment => segment.text).join('\n\n'));
    if (JSON.stringify(sourceWords) !== JSON.stringify(performanceWords)) throw new Error('PACED_PLAN_TOKEN_PARITY_FAILED:' + actKey);
    acts.push({
      actKey,
      voFilename: source.voFilename,
      sourceTextSha256: sha256(source.text),
      sourceCharacters: source.text.length,
      sourceWords: sourceWords.length,
      performanceCharacters: actSegments.reduce((sum, item) => sum + item.characters, 0),
      performanceWords: performanceWords.length,
      segmentCount: actSegments.length,
      segments: actSegments,
    });
  }
  if (flatSegments.length > maximumRequests) throw new Error('PACED_PLAN_REQUEST_CEILING_EXCEEDED:' + flatSegments.length + '/' + maximumRequests);
  if (totalCharacters > maximumCharacters) throw new Error('PACED_PLAN_CHARACTER_CEILING_EXCEEDED:' + totalCharacters + '/' + maximumCharacters);
  return {
    schemaVersion: 'paced-narration-plan/1.0.0',
    channelKey,
    episodeDirectory: path.resolve(episodeDirectory),
    model: MODEL,
    voiceSettings,
    outputFormat,
    maximumSegmentLength,
    joinPauseDurationMs,
    maximumRequests,
    maximumCharacters,
    acts,
    totalSegments: flatSegments.length,
    totalCharacters,
    totalWords,
    tokenParity: true,
    planSha256: sha256(JSON.stringify({ channelKey, acts, voiceSettings, outputFormat, maximumSegmentLength, joinPauseDurationMs, maximumRequests, maximumCharacters })),
  };
}

function atomicWriteJson(fs, filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, filePath);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch (_) { /* keep primary outcome */ }
  }
}

function appendJsonlDurable(fs, filePath, event) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(event) + '\n', null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonl(fs, filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return [];
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch (_) { throw new Error('PACED_LEDGER_INVALID_JSONL:' + (index + 1)); }
    if (!value || typeof value !== 'object' || typeof value.eventType !== 'string') throw new Error('PACED_LEDGER_EVENT_INVALID:' + (index + 1));
    if (!['reserved', 'provider-response', 'outcome-unknown', 'segment-complete'].includes(value.eventType)) throw new Error('PACED_LEDGER_UNKNOWN_EVENT:' + (index + 1));
    return value;
  });
}

function assertReviewDirectory(episodeDirectory, reviewOutputDirectory) {
  if (typeof reviewOutputDirectory !== 'string' || !path.isAbsolute(reviewOutputDirectory)) throw new Error('PACED_REVIEW_DIRECTORY_REQUIRED');
  const reviewRoot = path.resolve(episodeDirectory, '.review') + path.sep;
  const resolved = path.resolve(reviewOutputDirectory);
  if (!resolved.startsWith(reviewRoot) || resolved === path.resolve(episodeDirectory, '.review')) throw new Error('PACED_REVIEW_DIRECTORY_OUTSIDE_QUARANTINE');
  return resolved;
}

function probeMp3(filePath, options = {}) {
  const execFileImpl = options.execFile || execFileAsync;
  return Promise.resolve(execFileImpl(options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-show_entries', 'format=format_name,duration,size', '-of', 'json', filePath,
  ], { maxBuffer: 1024 * 1024 })).then(result => {
    const stdout = Array.isArray(result) ? result[0] : result.stdout;
    let metadata;
    try { metadata = JSON.parse(stdout); } catch (_) { throw new Error('PACED_FFPROBE_OUTPUT_INVALID'); }
    const formatNames = String(metadata?.format?.format_name || '').split(',');
    const durationSec = Number(metadata?.format?.duration);
    if (!formatNames.includes('mp3') || !(durationSec > 0) || !Number.isFinite(durationSec)) throw new Error('PACED_AUDIO_INVALID');
    return { format: 'mp3', durationSec, bytes: Number(metadata?.format?.size) || null };
  }).catch(error => {
    if (/^PACED_/.test(error.message || '')) throw error;
    throw new Error('PACED_FFPROBE_FAILED');
  });
}

async function joinPacedSegments(segmentPaths, outputPath, joinPauseDurationMs, options = {}) {
  if (!Array.isArray(segmentPaths) || !segmentPaths.length) throw new Error('PACED_JOIN_SEGMENTS_REQUIRED');
  if (segmentPaths.length === 1) {
    fsDefault.copyFileSync(segmentPaths[0], outputPath, fsDefault.constants.COPYFILE_EXCL);
    return;
  }
  const ffmpeg = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const args = [];
  const parts = [];
  let inputIndex = 0;
  for (let index = 0; index < segmentPaths.length; index += 1) {
    args.push('-i', segmentPaths[index]);
    parts.push('[' + inputIndex + ':a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[p' + parts.length + ']');
    inputIndex += 1;
    if (index < segmentPaths.length - 1 && joinPauseDurationMs > 0) {
      args.push('-f', 'lavfi', '-t', (joinPauseDurationMs / 1000).toFixed(3), '-i', 'anullsrc=channel_layout=mono:sample_rate=44100');
      parts.push('[' + inputIndex + ':a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[p' + parts.length + ']');
      inputIndex += 1;
    }
  }
  const labels = parts.map((_, index) => '[p' + index + ']').join('');
  const filter = parts.join(';') + ';' + labels + 'concat=n=' + parts.length + ':v=0:a=1[outa]';
  args.push('-filter_complex', filter, '-map', '[outa]', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', outputPath);
  try { await (options.execFile || execFileAsync)(ffmpeg, args, { maxBuffer: 2 * 1024 * 1024 }); }
  catch (_) { throw new Error('PACED_FFMPEG_JOIN_FAILED'); }
}

function readJsonIfExists(fs, filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { throw new Error('PACED_STATE_JSON_INVALID:' + path.basename(filePath)); }
}

function verifyAudioFile(fs, filePath, expectedSha256, expectedBytes) {
  if (!fs.existsSync(filePath)) throw new Error('PACED_COMPLETED_AUDIO_MISSING:' + path.basename(filePath));
  const bytes = fs.readFileSync(filePath);
  const digest = sha256(bytes);
  if (digest !== expectedSha256 || bytes.length !== expectedBytes) throw new Error('PACED_COMPLETED_AUDIO_HASH_MISMATCH:' + path.basename(filePath));
  return { digest, bytes: bytes.length };
}

function flattenPlan(plan) {
  return plan.acts.flatMap(act => act.segments);
}

async function runPacedNarration(options = {}, dependencies = {}) {
  const plan = planPacedNarration(options);
  const fs = dependencies.fs || fsDefault;
  const reviewDirectory = assertReviewDirectory(plan.episodeDirectory, options.reviewOutputDirectory);
  const resolver = dependencies.resolveChannelDna || (key => require('./config-reader.cjs').getChannelConfig(key));
  const dna = options.channelDna || dependencies.channelDna || await resolver(plan.channelKey);
  const voiceId = dna?.voice_id_elevenlabs || dna?.elevenlabs_voice_id || process.env.ELEVENLABS_VOICE_ID;
  const apiKey = dependencies.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (typeof voiceId !== 'string' || !voiceId.trim()) throw new Error('PACED_VOICE_ID_MISSING');
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('PACED_CREDENTIAL_MISSING');
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('PACED_FETCH_UNAVAILABLE');
  const probe = dependencies.probeAudio || (filePath => probeMp3(filePath, dependencies));
  const joiner = dependencies.joinAudio || ((inputs, output, pause) => joinPacedSegments(inputs, output, pause, dependencies));
  const audioDirectory = path.join(reviewDirectory, 'audio');
  const segmentDirectory = path.join(audioDirectory, 'segments');
  const ledgerPath = path.join(reviewDirectory, 'request-ledger.jsonl');
  const planPath = path.join(reviewDirectory, 'generation-plan.json');
  const statePath = path.join(reviewDirectory, 'run-status.json');
  const logPath = path.join(reviewDirectory, 'generation.jsonl');
  const lockPath = path.join(reviewDirectory, 'run.lock');
  fs.mkdirSync(reviewDirectory, { recursive: true });
  const existingPlan = readJsonIfExists(fs, planPath);
  if (existingPlan && JSON.stringify(existingPlan) !== JSON.stringify(plan)) throw new Error('PACED_PLAN_MISMATCH_ON_RESUME');
  if (!existingPlan) atomicWriteJson(fs, planPath, plan);
  fs.mkdirSync(segmentDirectory, { recursive: true });
  let lockFd;
  try { lockFd = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') throw new Error('PACED_RUN_LOCKED'); throw error; }

  const startedAt = new Date().toISOString();
  let state;
  let events;
  let reservations;
  try {
    state = readJsonIfExists(fs, statePath) || {
      schemaVersion: 'paced-narration-run/1.0.0', runId: path.basename(reviewDirectory), pid: process.pid,
      startedAt, updatedAt: startedAt, heartbeatAt: startedAt, state: 'RUNNING', currentAct: null,
      completedActs: [], completedSegments: [], attemptCountByAct: {}, billedCharactersReported: 0, planSha256: plan.planSha256,
    };
    if (state.planSha256 !== plan.planSha256) throw new Error('PACED_STATE_PLAN_MISMATCH');
    events = readJsonl(fs, ledgerPath);
    reservations = events.filter(event => event.eventType === 'reserved');
    if (reservations.some(event => event.planSha256 !== plan.planSha256)) throw new Error('PACED_LEDGER_PLAN_MISMATCH');
    const reservedSegmentIds = reservations.map(event => event.segmentId);
    if (new Set(reservedSegmentIds).size !== reservedSegmentIds.length) throw new Error('PACED_DUPLICATE_RESERVATION_IN_LEDGER');
    const reservationById = new Map(reservations.map(event => [event.requestId, event]));
    const responseById = new Map();
    const completionById = new Map();
    for (const event of events) {
      if (event.eventType === 'reserved') continue;
      const reservation = reservationById.get(event.requestId);
      if (!reservation || reservation.segmentId !== event.segmentId) throw new Error('PACED_LEDGER_ORPHAN_EVENT');
      if (event.eventType === 'provider-response') {
        if (responseById.has(event.requestId)) throw new Error('PACED_LEDGER_DUPLICATE_RESPONSE');
        responseById.set(event.requestId, event);
      }
      if (event.eventType === 'segment-complete') {
        if (completionById.has(event.requestId)) throw new Error('PACED_LEDGER_DUPLICATE_COMPLETION');
        completionById.set(event.requestId, event);
      }
    }
    for (const [requestId, completion] of completionById) {
      const response = responseById.get(requestId);
      if (!response || response.httpStatus < 200 || response.httpStatus >= 300 || !response.providerRequestId || response.providerRequestId !== completion.providerRequestId) throw new Error('PACED_LEDGER_COMPLETION_UNVERIFIED');
    }
    state.attemptCountByAct = Object.fromEntries([...new Set(reservations.map(item => item.actKey))].map(actKey => [actKey, reservations.filter(item => item.actKey === actKey).length]));
    state.completedSegments = events.filter(event => event.eventType === 'segment-complete').map(event => ({ segmentId: event.segmentId, textSha256: event.textSha256, audioSha256: event.audioSha256, audioBytes: event.audioBytes, durationSec: event.durationSec }));
    const responseEvents = events.filter(event => event.eventType === 'provider-response');
    state.billedCharactersReported = responseEvents.reduce((sum, event) => {
      const reservation = reservations.find(item => item.requestId === event.requestId);
      return sum + (Number.isSafeInteger(event.characterCost) && event.characterCost >= 0 ? event.characterCost : Number(reservation?.characters || 0));
    }, 0);
  } catch (error) {
    try { fs.closeSync(lockFd); } catch (_) {}
    try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
    throw error;
  }
  let interval;
  const heartbeat = () => {
    state.updatedAt = new Date().toISOString();
    state.heartbeatAt = state.updatedAt;
    atomicWriteJson(fs, statePath, state);
  };
  const log = entry => appendJsonlDurable(fs, logPath, { at: new Date().toISOString(), ...entry });
  const saveStatus = () => { state.updatedAt = new Date().toISOString(); state.heartbeatAt = state.updatedAt; atomicWriteJson(fs, statePath, state); };
  const appendLedger = event => appendJsonlDurable(fs, ledgerPath, { at: new Date().toISOString(), planSha256: plan.planSha256, ...event });
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, runId: state.runId, createdAt: startedAt }), 'utf8');
    interval = setInterval(heartbeat, 10000);
    if (typeof interval.unref === 'function') interval.unref();
    state.state = 'RUNNING'; state.pid = process.pid; state.updatedAt = startedAt; state.heartbeatAt = startedAt; saveStatus();
    log({ eventType: 'run-start', runId: state.runId, planSha256: plan.planSha256 });
    const flat = flattenPlan(plan);
    const completedEvents = new Map(events.filter(event => event.eventType === 'segment-complete').map(event => [event.segmentId, event]));
    const nonCompletedReservations = new Map();
    for (const reservation of reservations) {
      if (!completedEvents.has(reservation.segmentId)) nonCompletedReservations.set(reservation.segmentId, reservation);
    }
    const providerRequestCount = reservations.length;
    const providerCharacters = reservations.reduce((sum, item) => sum + item.characters, 0);
    if (providerRequestCount > plan.maximumRequests || providerCharacters > plan.maximumCharacters) throw new Error('PACED_EXISTING_BUDGET_EXCEEDED');
    const priorRequestIds = [];
    const reservedCharactersBeforeRun = providerCharacters;
    for (let position = 0; position < flat.length; position += 1) {
      const segment = flat[position];
      const segmentPath = path.join(segmentDirectory, segment.segmentId + '-' + segment.textSha256.slice(0, 12) + '.mp3');
      const partialPath = segmentPath + '.partial';
      const complete = completedEvents.get(segment.segmentId);
      if (complete) {
        if (complete.textSha256 !== segment.textSha256 || complete.relativeAudioPath !== path.relative(reviewDirectory, segmentPath).split(path.sep).join('/')) throw new Error('PACED_COMPLETED_SEGMENT_PLAN_MISMATCH:' + segment.segmentId);
        verifyAudioFile(fs, segmentPath, complete.audioSha256, complete.audioBytes);
        const media = await probe(segmentPath);
        if (!(Number(media?.durationSec) > 0) || Math.abs(Number(media.durationSec) - Number(complete.durationSec)) > 0.1) throw new Error('PACED_COMPLETED_SEGMENT_PROBE_MISMATCH:' + segment.segmentId);
        if (!complete.providerRequestId) throw new Error('PACED_COMPLETED_SEGMENT_REQUEST_ID_MISSING:' + segment.segmentId);
        priorRequestIds.push(complete.providerRequestId);
      } else {
        if (nonCompletedReservations.has(segment.segmentId) || fs.existsSync(segmentPath) || fs.existsSync(partialPath)) throw new Error('PACED_SEGMENT_OUTCOME_AMBIGUOUS:' + segment.segmentId);
        if (reservations.length >= plan.maximumRequests) throw new Error('PACED_REQUEST_CEILING_REACHED');
        const remainingPlannedCharacters = flat.slice(position).reduce((sum, item) => sum + item.characters, 0);
        if (state.billedCharactersReported + remainingPlannedCharacters > plan.maximumCharacters) throw new Error('PACED_REPORTED_CHARACTER_BUDGET_EXCEEDED');
        const previousIds = priorRequestIds.slice(-3);
        const nextText = flat[position + 1]?.text;
        const localRequestId = crypto.randomUUID();
        appendLedger({ eventType: 'reserved', requestId: localRequestId, segmentId: segment.segmentId, actKey: segment.actKey, textSha256: segment.textSha256, characters: segment.characters, previousRequestIds: previousIds, nextTextSha256: nextText ? sha256(nextText) : null, nextTextCharacters: nextText ? nextText.length : 0, reservedAt: new Date().toISOString() });
        reservations.push({ eventType: 'reserved', requestId: localRequestId, segmentId: segment.segmentId, actKey: segment.actKey, textSha256: segment.textSha256, characters: segment.characters, previousRequestIds: previousIds, nextTextSha256: nextText ? sha256(nextText) : null, nextTextCharacters: nextText ? nextText.length : 0, planSha256: plan.planSha256 });
        state.currentAct = segment.actKey;
        state.attemptCountByAct[segment.actKey] = (state.attemptCountByAct[segment.actKey] || 0) + 1;
        saveStatus();
        log({ eventType: 'segment-reserved', actKey: segment.actKey, segmentId: segment.segmentId, attemptCountForAct: state.attemptCountByAct[segment.actKey] });
        let response;
        try {
          const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=' + encodeURIComponent(plan.outputFormat);
          response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify({
              text: segment.text,
              model_id: MODEL,
              voice_settings: plan.voiceSettings,
              previous_request_ids: previousIds,
              ...(nextText ? { next_text: nextText } : {}),
            }),
          });
        } catch (_) {
          appendLedger({ eventType: 'outcome-unknown', requestId: localRequestId, segmentId: segment.segmentId });
          log({ eventType: 'provider-outcome-unknown', segmentId: segment.segmentId });
          throw new Error('PACED_PROVIDER_OUTCOME_AMBIGUOUS:' + segment.segmentId);
        }
        const httpStatus = Number(response?.status) || null;
        const providerRequestId = response?.headers?.get?.('request-id') || null;
        const contentType = String(response?.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
        const characterCostHeader = response?.headers?.get?.('character-cost');
        const characterCost = characterCostHeader === null || characterCostHeader === undefined ? null : Number(characterCostHeader);
        appendLedger({ eventType: 'provider-response', requestId: localRequestId, providerRequestId, segmentId: segment.segmentId, httpStatus, contentType, characterCost: Number.isFinite(characterCost) ? characterCost : null });
        state.billedCharactersReported += Number.isSafeInteger(characterCost) && characterCost >= 0 ? characterCost : segment.characters;
        saveStatus();
        if (state.billedCharactersReported > plan.maximumCharacters) throw new Error('PACED_REPORTED_CHARACTER_BUDGET_EXCEEDED');
        if (!response?.ok || httpStatus < 200 || httpStatus >= 300) throw new Error('PACED_PROVIDER_HTTP_ERROR:' + segment.segmentId + ':' + (httpStatus || 'unknown'));
        if (!providerRequestId) throw new Error('PACED_PROVIDER_REQUEST_ID_MISSING:' + segment.segmentId);
        if (!['audio/mpeg', 'audio/mp3'].includes(contentType)) throw new Error('PACED_PROVIDER_CONTENT_TYPE_INVALID:' + segment.segmentId);
        let audioBytes;
        try { audioBytes = Buffer.from(await response.arrayBuffer()); }
        catch (_) { appendLedger({ eventType: 'outcome-unknown', requestId: localRequestId, segmentId: segment.segmentId }); throw new Error('PACED_PROVIDER_BODY_OUTCOME_AMBIGUOUS:' + segment.segmentId); }
        if (fs.existsSync(partialPath) || fs.existsSync(segmentPath)) throw new Error('PACED_SEGMENT_FILE_ALREADY_EXISTS:' + segment.segmentId);
        fs.writeFileSync(partialPath, audioBytes, { flag: 'wx' });
        const id3 = audioBytes.length >= 3 && audioBytes[0] === 0x49 && audioBytes[1] === 0x44 && audioBytes[2] === 0x33;
        const mpeg = audioBytes.length >= 2 && audioBytes[0] === 0xff && (audioBytes[1] & 0xe0) === 0xe0;
        if (audioBytes.length < 1024 || (!id3 && !mpeg)) throw new Error('PACED_SEGMENT_MP3_INVALID:' + segment.segmentId);
        const media = await probe(partialPath);
        const durationSec = Number(media?.durationSec);
        if (!(durationSec > 0) || !Number.isFinite(durationSec)) throw new Error('PACED_SEGMENT_FFPROBE_INVALID:' + segment.segmentId);
        const audioSha256 = sha256(audioBytes);
        fs.renameSync(partialPath, segmentPath);
        const completeEvent = {
          eventType: 'segment-complete', requestId: localRequestId, providerRequestId,
          segmentId: segment.segmentId, actKey: segment.actKey, textSha256: segment.textSha256,
          relativeAudioPath: path.relative(reviewDirectory, segmentPath).split(path.sep).join('/'),
          audioSha256, audioBytes: audioBytes.length, durationSec,
          responseMetadata: { httpStatus, contentType, characterCost: Number.isFinite(characterCost) ? characterCost : null },
        };
        appendLedger(completeEvent);
        completedEvents.set(segment.segmentId, completeEvent);
        priorRequestIds.push(providerRequestId);
        log({ eventType: 'segment-complete', actKey: segment.actKey, segmentId: segment.segmentId, providerRequestId, audioSha256, durationSec, audioBytes: audioBytes.length });
      }
      state.currentAct = segment.actKey;
      if (!completedEvents.has(segment.segmentId)) throw new Error('PACED_SEGMENT_CHECKPOINT_MISSING:' + segment.segmentId);
      if (!state.completedSegments.some(item => item.segmentId === segment.segmentId)) {
        const checkpoint = completedEvents.get(segment.segmentId);
        state.completedSegments.push({ segmentId: checkpoint.segmentId, textSha256: checkpoint.textSha256, audioSha256: checkpoint.audioSha256, audioBytes: checkpoint.audioBytes, durationSec: checkpoint.durationSec });
      }
      saveStatus();
      const next = flat[position + 1];
      if (!next || next.actKey !== segment.actKey) {
        const act = plan.acts.find(item => item.actKey === segment.actKey);
        const actOutputPath = path.join(audioDirectory, act.voFilename);
        const actRelativePath = path.relative(reviewDirectory, actOutputPath).split(path.sep).join('/');
        const completedAct = (state.joinedActs || {})[segment.actKey];
        if (completedAct) {
          verifyAudioFile(fs, actOutputPath, completedAct.audioSha256, completedAct.audioBytes);
          const checked = await probe(actOutputPath);
          if (!(Number(checked?.durationSec) > 0)) throw new Error('PACED_JOINED_ACT_INVALID:' + segment.actKey);
        } else {
          if (fs.existsSync(actOutputPath) || fs.existsSync(actOutputPath + '.partial')) throw new Error('PACED_JOINED_ACT_OUTCOME_AMBIGUOUS:' + segment.actKey);
          const segmentFiles = act.segments.map(item => path.join(segmentDirectory, item.segmentId + '-' + item.textSha256.slice(0, 12) + '.mp3'));
          for (const item of act.segments) if (!completedEvents.has(item.segmentId)) throw new Error('PACED_ACT_SEGMENT_INCOMPLETE:' + item.segmentId);
          const partialActPath = actOutputPath + '.partial';
          await joiner(segmentFiles, partialActPath, plan.joinPauseDurationMs);
          const joinedMedia = await probe(partialActPath);
          const joinedBytes = fs.readFileSync(partialActPath);
          if (!(Number(joinedMedia?.durationSec) > 0) || joinedBytes.length < 1024) throw new Error('PACED_JOINED_ACT_INVALID:' + segment.actKey);
          const audioSha256 = sha256(joinedBytes);
          fs.renameSync(partialActPath, actOutputPath);
          const joined = { audioSha256, audioBytes: joinedBytes.length, durationSec: Number(joinedMedia.durationSec), relativeAudioPath: actRelativePath, segmentIds: act.segments.map(item => item.segmentId), joinPauseDurationMs: plan.joinPauseDurationMs };
          state.joinedActs = { ...(state.joinedActs || {}), [segment.actKey]: joined };
          state.completedActs = [...new Set([...(state.completedActs || []), segment.actKey])];
          log({ eventType: 'act-joined', actKey: segment.actKey, ...joined });
        }
        if (!state.completedActs.includes(segment.actKey)) state.completedActs.push(segment.actKey);
        state.currentAct = null;
        saveStatus();
      }
    }
    if (state.billedCharactersReported > plan.maximumCharacters || reservedCharactersBeforeRun > plan.maximumCharacters) throw new Error('PACED_REPORTED_CHARACTER_BUDGET_EXCEEDED');
    state.state = 'SUCCESS'; state.currentAct = null; state.finishedAt = new Date().toISOString(); saveStatus();
    log({ eventType: 'run-success', completedActs: state.completedActs });
    return { status: state.state, runId: state.runId, reviewDirectory, plan, state };
  } catch (error) {
    state.state = 'FAILURE'; state.errorCode = String(error.message || 'PACED_RUN_FAILED').split(':')[0]; state.errorMessage = String(error.message || 'PACED_RUN_FAILED'); state.finishedAt = new Date().toISOString();
    try { saveStatus(); log({ eventType: 'run-failure', errorCode: state.errorCode, message: state.errorMessage }); } catch (_) { /* retain underlying failure */ }
    throw error;
  } finally {
    if (interval) clearInterval(interval);
    try { fs.closeSync(lockFd); } catch (_) {}
    try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
  }
}

module.exports = {
  MODEL,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_MAX_SEGMENT_CHARACTERS,
  DEFAULT_JOIN_PAUSE_MS,
  sha256,
  lexicalTokens,
  splitSentences,
  planPacedNarration,
  runPacedNarration,
  probeMp3,
  joinPacedSegments,
  assertReviewDirectory,
};
