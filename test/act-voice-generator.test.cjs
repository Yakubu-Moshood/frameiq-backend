'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'pipeline-updates', 'act-voice-generator.cjs'), 'utf8');
const {
  generateActVoice, MODEL, OUTPUT_FORMAT, APPROVED_VOICE_SETTINGS, LEDGER_VERSION, sha256, resolveChannelDnaByKey,
} = require('../pipeline-updates/act-voice-generator.cjs');

const SECRET_KEY = 'test-elevenlabs-api-key-never-report';
const SECRET_VOICE = 'private-voice-id-never-report';
const TEXT = 'A single act of test narration.';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1021, 0x41)]);
const ORIGINAL_FETCH = globalThis.fetch;
let trappedNetworkCalls = 0;

test.before(() => {
  globalThis.fetch = async () => { trappedNetworkCalls++; throw new Error('Real network is disabled in tests.'); };
});
test.after(() => { globalThis.fetch = ORIGINAL_FETCH; });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-voice-test-'));
  const outputPath = path.join(dir, 'VO_Act3B.mp3');
  const ledgerPath = path.join(dir, 'request-ledger.json');
  const calls = [];
  const dependencies = {
    apiKey: SECRET_KEY,
    resolveChannelDna: async channel => { assert.equal(channel, 'EmpireOmitted'); return { voice_id_elevenlabs: SECRET_VOICE }; },
    fetch: async (url, options) => {
      calls.push({ url, options, ledger: fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : null });
      return response(200, 'audio/mpeg', MP3);
    },
    probeAudio: async partialPath => {
      assert.match(path.basename(partialPath), /\.mp3\.partial$/);
      assert.equal(fs.existsSync(partialPath.slice(0, -'.partial'.length)), false);
      assert.equal(fs.existsSync(partialPath), true);
      return { format: 'mp3', durationSec: 12.5 };
    },
  };
  const args = {
    channel: 'EmpireOmitted', episodeId: 'episode-test', actKey: 'act3b', text: TEXT,
    expectedTextSha256: sha256(TEXT), outputPath, ledgerPath, model: MODEL,
    outputFormat: OUTPUT_FORMAT, voiceSettings: { ...APPROVED_VOICE_SETTINGS },
    maximumCharacters: 1000, maximumRequests: 2, allowOverwrite: false,
  };
  return { dir, outputPath, ledgerPath, calls, dependencies, args };
}

function response(status, contentType, bytes) {
  return { status, ok: status >= 200 && status < 300, headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null }, arrayBuffer: async () => bytes };
}

async function expectError(promise, code) {
  await assert.rejects(promise, new RegExp(code));
}

test('one requested act makes one provider request with an atomic reservation already persisted', async () => {
  const f = setup();
  const report = await generateActVoice(f.args, f.dependencies);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].ledger.attempts.length, 1);
  assert.equal(f.calls[0].ledger.attempts[0].status, 'RESERVED');
  assert.equal(f.calls[0].options.method, 'POST');
  assert.match(f.calls[0].url, /\/text-to-speech\/private-voice-id-never-report\?output_format=mp3_44100_128$/);
  const body = JSON.parse(f.calls[0].options.body);
  assert.equal(body.model_id, 'eleven_multilingual_v2');
  assert.deepEqual(body.voice_settings, APPROVED_VOICE_SETTINGS);
  assert.equal(report.status, 'COMPLETE');
  assert.equal(report.actKey, 'act3b');
  assert.equal(report.audioSha256, sha256(MP3));
  assert.equal(fs.existsSync(f.outputPath), true);
  assert.equal(fs.existsSync(`${f.outputPath}.partial`), false);
  const ledger = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'));
  assert.equal(ledger.schemaVersion, LEDGER_VERSION);
  assert.equal(ledger.attempts[0].status, 'COMPLETE');
  assert.equal(ledger.attempts[0].audioSha256, sha256(MP3));
  assert.equal(trappedNetworkCalls, 0);
});

test('canonical EmpireOmitted key is passed unchanged to the channel config resolver', async () => {
  const f = setup();
  const lookupKeys = [];
  f.dependencies.resolveChannelDna = key => resolveChannelDnaByKey(key, async exactKey => {
    lookupKeys.push(exactKey);
    return { voice_id_elevenlabs: SECRET_VOICE };
  });
  await generateActVoice(f.args, f.dependencies);
  assert.deepEqual(lookupKeys, ['EmpireOmitted']);
  assert.equal(f.calls.length, 1);
});

test('display label channel failure occurs before ledger creation or provider request', async () => {
  const f = setup();
  f.args.channel = 'Empire Omitted';
  const lookupKeys = [];
  f.dependencies.resolveChannelDna = key => resolveChannelDnaByKey(key, async exactKey => {
    lookupKeys.push(exactKey);
    throw new Error(`[config-reader] Channel not found by id: ${exactKey}`);
  });
  let reservations = 0;
  f.dependencies.onRequestReserved = async () => { reservations += 1; };
  await assert.rejects(generateActVoice(f.args, f.dependencies), /Channel not found by id: Empire Omitted/);
  assert.deepEqual(lookupKeys, ['Empire Omitted']);
  assert.equal(reservations, 0);
  assert.equal(fs.existsSync(f.ledgerPath), false);
  assert.equal(f.calls.length, 0);
});

test('request reservation callback observes the durable RESERVED ledger before fetch', async () => {
  const f = setup();
  const order = [];
  f.dependencies.onRequestReserved = async reservation => {
    order.push('reservation-callback');
    assert.equal(reservation.status, 'RESERVED');
    const ledger = JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8'));
    assert.equal(ledger.attempts.length, 1);
    assert.equal(ledger.attempts[0].requestId, reservation.requestId);
    assert.equal(ledger.attempts[0].status, 'RESERVED');
  };
  f.dependencies.fetch = async (url, options) => { order.push('provider-request'); f.calls.push({ url, options }); return response(200, 'audio/mpeg', MP3); };
  await generateActVoice(f.args, f.dependencies);
  assert.deepEqual(order, ['reservation-callback', 'provider-request']);
  assert.equal(f.calls.length, 1);
});

test('a text-hash mismatch is rejected before any provider request', async () => {
  const f = setup();
  f.args.expectedTextSha256 = '0'.repeat(64);
  await expectError(generateActVoice(f.args, f.dependencies), 'ACT_VOICE_TEXT_HASH_MISMATCH');
  assert.equal(f.calls.length, 0);
});

test('an existing final destination is never overwritten or requested', async () => {
  const f = setup();
  fs.writeFileSync(f.outputPath, 'preserve me');
  await expectError(generateActVoice(f.args, f.dependencies), 'ACT_VOICE_OUTPUT_EXISTS');
  assert.equal(fs.readFileSync(f.outputPath, 'utf8'), 'preserve me');
  assert.equal(f.calls.length, 0);
});

test('an existing partial output is never overwritten or requested', async () => {
  const f = setup();
  fs.writeFileSync(`${f.outputPath}.partial`, 'preserve partial');
  await expectError(generateActVoice(f.args, f.dependencies), 'ACT_VOICE_PARTIAL_EXISTS');
  assert.equal(fs.readFileSync(`${f.outputPath}.partial`, 'utf8'), 'preserve partial');
  assert.equal(f.calls.length, 0);
});

test('a prior ledger reservation for the same act and text hash prevents a second request', async () => {
  const f = setup();
  fs.writeFileSync(f.ledgerPath, JSON.stringify({ schemaVersion: LEDGER_VERSION, attempts: [{ channel: f.args.channel, episodeId: f.args.episodeId, actKey: f.args.actKey, textSha256: f.args.expectedTextSha256, status: 'RESERVED' }] }));
  await expectError(generateActVoice(f.args, f.dependencies), 'ACT_VOICE_ATTEMPT_ALREADY_RECORDED');
  assert.equal(f.calls.length, 0);
});

test('an HTTP failure consumes one reservation and is never retried', async () => {
  const f = setup();
  f.dependencies.fetch = async () => { f.calls.push('attempt'); return response(503, 'application/json', Buffer.from('{}')); };
  await expectError(generateActVoice(f.args, f.dependencies), 'ACT_VOICE_PROVIDER_HTTP_ERROR');
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')).attempts[0].status, 'FAILED');
  await expectError(generateActVoice(f.args, f.dependencies), 'ACT_VOICE_ATTEMPT_ALREADY_RECORDED');
  assert.equal(f.calls.length, 1);
});

test('invalid MP3 bytes are rejected and quarantined as a partial', async () => {
  const f = setup();
  f.dependencies.fetch = async () => { f.calls.push('attempt'); return response(200, 'audio/mpeg', Buffer.alloc(2048, 0)); };
  await expectError(generateActVoice(f.args, f.dependencies), 'ACT_VOICE_AUDIO_INVALID');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(f.outputPath), false);
  assert.equal(fs.existsSync(`${f.outputPath}.partial`), true);
  assert.equal(JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')).attempts[0].errorCode, 'INVALID_MP3_SIGNATURE_OR_SIZE');
});

test('ffprobe failure rejects audio and retains the diagnostic partial', async () => {
  const f = setup();
  f.dependencies.probeAudio = async () => { throw new Error('ffprobe error must not escape'); };
  await expectError(generateActVoice(f.args, f.dependencies), 'ACT_VOICE_FFPROBE_FAILED');
  assert.equal(fs.existsSync(f.outputPath), false);
  assert.equal(fs.existsSync(`${f.outputPath}.partial`), true);
  assert.equal(JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')).attempts[0].errorCode, 'FFPROBE_FAILED');
});

test('HTTP status and content type are checked before the response becomes a partial', async () => {
  const f = setup();
  f.dependencies.fetch = async () => { f.calls.push('attempt'); return response(200, 'application/octet-stream', MP3); };
  await expectError(generateActVoice(f.args, f.dependencies), 'ACT_VOICE_CONTENT_TYPE_INVALID');
  assert.equal(fs.existsSync(`${f.outputPath}.partial`), false);
  assert.equal(f.calls.length, 1);
});

test('raw API key and voice ID never appear in returned report or persisted ledger', async () => {
  const f = setup();
  const report = await generateActVoice(f.args, f.dependencies);
  const publicText = JSON.stringify({ report, ledger: JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')) });
  assert.equal(publicText.includes(SECRET_KEY), false);
  assert.equal(publicText.includes(SECRET_VOICE), false);
  assert.match(report.voiceIdFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(source.includes("require('../jobs/runner.js')"), false);
  assert.equal(source.includes('jobs/runner'), false);
});

test('Channel DNA voice ID wins over the environment fallback, without exposing either', async () => {
  const f = setup();
  let resolved;
  f.dependencies.resolveChannelDna = async () => ({ elevenlabs_voice_id: 'channel-dna-voice' });
  f.dependencies.fetch = async url => { resolved = decodeURIComponent(url.split('/text-to-speech/')[1].split('?')[0]); return response(200, 'audio/mpeg', MP3); };
  const prior = process.env.ELEVENLABS_VOICE_ID;
  process.env.ELEVENLABS_VOICE_ID = 'environment-fallback-voice';
  try {
    const report = await generateActVoice(f.args, f.dependencies);
    assert.equal(resolved, 'channel-dna-voice');
    assert.equal(JSON.stringify(report).includes('channel-dna-voice'), false);
  } finally {
    if (prior === undefined) delete process.env.ELEVENLABS_VOICE_ID; else process.env.ELEVENLABS_VOICE_ID = prior;
  }
});

test('an environment voice fallback is supported when Channel DNA has no ID', async () => {
  const f = setup();
  const prior = process.env.ELEVENLABS_VOICE_ID;
  process.env.ELEVENLABS_VOICE_ID = 'environment-fallback-voice';
  let used;
  f.dependencies.resolveChannelDna = async () => ({});
  f.dependencies.fetch = async url => { used = decodeURIComponent(url.split('/text-to-speech/')[1].split('?')[0]); return response(200, 'audio/mpeg', MP3); };
  try { await generateActVoice(f.args, f.dependencies); assert.equal(used, 'environment-fallback-voice'); }
  finally { if (prior === undefined) delete process.env.ELEVENLABS_VOICE_ID; else process.env.ELEVENLABS_VOICE_ID = prior; }
});

test('multiple acts and omitted act keys are rejected before any request', async () => {
  const f = setup();
  await expectError(generateActVoice({ ...f.args, acts: ['act3b', 'act4'] }, f.dependencies), 'ACT_VOICE_SINGLE_ACT_ONLY');
  const omitted = { ...f.args }; delete omitted.actKey;
  await expectError(generateActVoice(omitted, f.dependencies), 'ACT_VOICE_INPUT_INVALID');
  assert.equal(f.calls.length, 0);
});

test('empty and over-limit narration fail before ledger reservation', async () => {
  const f = setup();
  const empty = { ...f.args, text: '  ', expectedTextSha256: sha256('  ') };
  await expectError(generateActVoice(empty, f.dependencies), 'ACT_VOICE_TEXT_EMPTY');
  const long = { ...f.args, maximumCharacters: 2 };
  await expectError(generateActVoice(long, f.dependencies), 'ACT_VOICE_TEXT_TOO_LONG');
  assert.equal(fs.existsSync(f.ledgerPath), false);
  assert.equal(f.calls.length, 0);
});

test('approved model, output format, and all settings are enforced exactly', async () => {
  const f = setup();
  await expectError(generateActVoice({ ...f.args, model: 'eleven_turbo_v2' }, f.dependencies), 'ACT_VOICE_MODEL_INVALID');
  await expectError(generateActVoice({ ...f.args, outputFormat: 'mp3_22050_32' }, f.dependencies), 'ACT_VOICE_FORMAT_INVALID');
  await expectError(generateActVoice({ ...f.args, voiceSettings: { ...f.args.voiceSettings, speed: 0.9 } }, f.dependencies), 'ACT_VOICE_SETTINGS_INVALID');
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.ledgerPath), false);
});

test('the configurable request budget is enforced across distinct acts', async () => {
  const f = setup();
  await generateActVoice(f.args, f.dependencies);
  const second = { ...f.args, actKey: 'act4', outputPath: path.join(f.dir, 'VO_Act4.mp3') };
  await generateActVoice(second, f.dependencies);
  const third = { ...f.args, actKey: 'act5', outputPath: path.join(f.dir, 'VO_Act5.mp3') };
  await expectError(generateActVoice(third, f.dependencies), 'ACT_VOICE_REQUEST_LIMIT_REACHED');
  assert.equal(f.calls.length, 2);
});

test('test suite made no real network calls', () => {
  assert.equal(trappedNetworkCalls, 0);
});
