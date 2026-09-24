'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_OUTPUT_FORMAT, DEFAULT_JOIN_PAUSE_MS, lexicalTokens, splitSentences,
  planPacedNarration, runPacedNarration, joinPacedSegments, sha256,
} = require('../pipeline-updates/paced-narration-generator.cjs');
const { buildActMap, makePlan, getCredentialState, verifyRailwayTarget, parseArgs, verifyPacingPackage } = require('../scripts/phase2.3b-p-run.cjs');

const SETTINGS = Object.freeze({ stability: 0.45, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true, speed: 0.94 });
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1400, 0x41)]);
const SECRET_KEY = 'fake-elevenlabs-key-never-persist';
const SECRET_VOICE = 'fake-voice-id-never-persist';
const tempDirs = new Set();
const realFetch = globalThis.fetch;
let realNetworkCalls = 0;
test.before(() => { globalThis.fetch = async () => { realNetworkCalls += 1; throw new Error('REAL_NETWORK_BLOCKED_IN_TEST'); }; });
test.after(() => { globalThis.fetch = realFetch; });

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempEpisode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paced-narration-test-'));
  tempDirs.add(dir);
  fs.mkdirSync(path.join(dir, '.review'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets', 'audio'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'audio', 'VO_Act1.mp3'), 'root audio must remain unchanged');
  return dir;
}

function options(episodeDirectory, overrides = {}) {
  const actMap = overrides.actMap || {
    act1: { voFilename: 'VO_Act1.mp3', text: 'The first sentence is steady. The second sentence gives it room. The final sentence closes.' },
    act2: { voFilename: 'VO_Act2.mp3', text: 'Another act follows the first.' },
  };
  return {
    channelKey: overrides.channelKey || 'ExampleChannel',
    episodeDirectory,
    actMap,
    voiceSettings: { ...SETTINGS },
    outputFormat: DEFAULT_OUTPUT_FORMAT,
    maximumSegmentLength: overrides.maximumSegmentLength ?? 48,
    joinPauseDurationMs: overrides.joinPauseDurationMs ?? DEFAULT_JOIN_PAUSE_MS,
    maximumRequests: overrides.maximumRequests ?? 20,
    maximumCharacters: overrides.maximumCharacters ?? 4000,
    reviewOutputDirectory: overrides.reviewOutputDirectory || path.join(episodeDirectory, '.review', 'phase2.3b-p-narration-test-run01'),
  };
}

function fakeDependencies(overrides = {}) {
  const calls = [];
  const probes = [];
  let requestNumber = 0;
  const dependencies = {
    apiKey: SECRET_KEY,
    channelDna: { voice_id_elevenlabs: SECRET_VOICE },
    fetch: async (url, request) => {
      calls.push({ url, request, ledgerText: fs.readFileSync(path.join(overrides.reviewDirectory, 'request-ledger.jsonl'), 'utf8') });
      requestNumber += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: name => ({ 'content-type': 'audio/mpeg', 'request-id': 'provider-request-' + requestNumber, 'character-cost': String(JSON.parse(request.body).text.length) }[name.toLowerCase()] || null) },
        arrayBuffer: async () => MP3,
      };
    },
    probeAudio: async filePath => { probes.push(filePath); return { format: 'mp3', durationSec: 2.25 }; },
    joinAudio: async (inputs, outputPath, pauseMs) => {
      assert.equal(pauseMs, DEFAULT_JOIN_PAUSE_MS);
      fs.writeFileSync(outputPath, Buffer.concat([MP3, Buffer.from('|pause=' + pauseMs + '|'), MP3]), { flag: 'wx' });
    },
  };
  return { dependencies: { ...dependencies, ...overrides.dependencies }, calls, probes };
}

function makeResponse(text, requestId = 'provider-request-test') {
  return {
    ok: true, status: 200,
    headers: { get: name => ({ 'content-type': 'audio/mpeg', 'request-id': requestId, 'character-cost': String(text.length) }[name.toLowerCase()] || null) },
    arrayBuffer: async () => MP3,
  };
}

function countJsonl(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/u).filter(Boolean).length;
}

test('sentence segmentation uses double line breaks and preserves normalized spoken tokens and source spans', () => {
  const text = 'E. Scott cited 3.5 million dollars. “The report was clear,” she said. Next, it changed.';
  const sentences = splitSentences(text);
  assert.deepEqual(sentences.map(item => item.text), ['E. Scott cited 3.5 million dollars.', '“The report was clear,” she said.', 'Next, it changed.']);
  const plan = planPacedNarration({ ...options(tempEpisode(), { actMap: { act1: { voFilename: 'VO_Act1.mp3', text } }, maximumSegmentLength: 200 }) });
  const performance = plan.acts[0].segments.map(segment => segment.text).join('\n\n');
  assert.equal(performance, sentences.map(item => item.text).join('\n\n'));
  assert.deepEqual(lexicalTokens(text), lexicalTokens(performance));
  for (const segment of plan.acts[0].segments) {
    assert.ok(segment.sourceStart >= 0 && segment.sourceEnd <= text.length);
    assert.deepEqual(lexicalTokens(text.slice(segment.sourceStart, segment.sourceEnd)), lexicalTokens(segment.text));
    assert.match(segment.textSha256, /^[a-f0-9]{64}$/u);
    assert.match(segment.sourceTextSha256, /^[a-f0-9]{64}$/u);
  }
});

test('deterministic sentence packing stays at or below 720 characters without splitting words', () => {
  const sentences = Array.from({ length: 24 }, (_, index) => 'Sentence ' + String(index + 1).padStart(2, '0') + ' carries intact words.');
  const text = sentences.join(' ');
  const input = { ...options(tempEpisode(), { actMap: { actA: { voFilename: 'VO_ActA.mp3', text } }, maximumSegmentLength: 720 }) };
  const first = planPacedNarration(input);
  const second = planPacedNarration(input);
  assert.deepEqual(first, second);
  assert.equal(first.totalWords, lexicalTokens(text).length);
  assert.ok(first.acts[0].segments.every(segment => segment.characters <= 720));
  assert.deepEqual(lexicalTokens(first.acts[0].segments.map(item => item.text).join('\n\n')), lexicalTokens(text));
  for (const segment of first.acts[0].segments) assert.ok(sentences.some(sentence => segment.text.split('\n\n').includes(sentence)));
});

test('an oversized sentence fails closed rather than splitting a word or rewriting narration', () => {
  const text = 'A' + ' extraordinarilylong'.repeat(40) + '.';
  assert.throws(() => planPacedNarration({ ...options(tempEpisode(), { actMap: { act1: { voFilename: 'VO_Act1.mp3', text } }, maximumSegmentLength: 720 }) }), /PACED_PLAN_OVERSIZED_SENTENCE/);
});

test('request and character ceilings reject a plan before provider execution', () => {
  const actMap = { act1: { voFilename: 'VO_Act1.mp3', text: 'One. Two. Three.' } };
  assert.throws(() => planPacedNarration({ ...options(tempEpisode(), { actMap, maximumSegmentLength: 6, maximumRequests: 2 }) }), /PACED_PLAN_REQUEST_CEILING_EXCEEDED/);
  assert.throws(() => planPacedNarration({ ...options(tempEpisode(), { actMap, maximumSegmentLength: 20, maximumCharacters: 4 }) }), /PACED_PLAN_CHARACTER_CEILING_EXCEEDED/);
});

test('the reusable plan accepts independent channel keys, act maps, settings, limits, and review paths', () => {
  const dir = tempEpisode();
  const input = options(dir, { channelKey: 'AnyDocumentaryChannel', actMap: { opening: { voFilename: 'VO_Opening.mp3', text: 'A deliberate opening.' } }, maximumSegmentLength: 720, maximumRequests: 1, maximumCharacters: 100 });
  const plan = planPacedNarration(input);
  assert.equal(plan.channelKey, 'AnyDocumentaryChannel');
  assert.equal(plan.acts[0].actKey, 'opening');
  assert.equal(plan.acts[0].voFilename, 'VO_Opening.mp3');
  assert.deepEqual(plan.voiceSettings, SETTINGS);
  assert.equal(plan.episodeDirectory, path.resolve(dir));
  const alternate = planPacedNarration({ ...input, outputFormat: 'mp3_22050_32' });
  assert.equal(alternate.outputFormat, 'mp3_22050_32');
});

test('provider requests carry prior request IDs and upcoming context across segments and acts', async () => {
  const dir = tempEpisode();
  const actMap = {
    act1: { voFilename: 'VO_Act1.mp3', text: 'First sentence has words. Second sentence gives context.' },
    act2: { voFilename: 'VO_Act2.mp3', text: 'Third sentence begins the next act.' },
  };
  const args = options(dir, { actMap, maximumSegmentLength: 40 });
  const reviewDirectory = args.reviewOutputDirectory;
  const fake = fakeDependencies({ reviewDirectory });
  await runPacedNarration(args, fake.dependencies);
  assert.ok(fake.calls.length >= 3);
  const first = JSON.parse(fake.calls[0].request.body);
  assert.deepEqual(first.previous_request_ids, []);
  const planned = planPacedNarration(args);
  assert.equal(first.next_text, planned.acts[0].segments[1].text);
  assert.equal(first.voice_settings.speed, 0.94);
  const second = JSON.parse(fake.calls[1].request.body);
  assert.deepEqual(second.previous_request_ids, ['provider-request-1']);
  const later = JSON.parse(fake.calls.at(-1).request.body);
  assert.ok(later.previous_request_ids.length <= 3);
  assert.ok(fake.calls.every(call => JSON.parse(call.request.body).model_id === 'eleven_multilingual_v2'));
});

test('durable reservation is present before dispatch and no real fetch is used by the test', async () => {
  const dir = tempEpisode();
  const args = options(dir, { actMap: { act1: { voFilename: 'VO_Act1.mp3', text: 'A single review sentence.' } } });
  const reviewDirectory = args.reviewOutputDirectory;
  const fake = fakeDependencies({ reviewDirectory });
  await runPacedNarration(args, fake.dependencies);
  const ledger = fs.readFileSync(path.join(reviewDirectory, 'request-ledger.jsonl'), 'utf8');
  assert.equal(JSON.parse(ledger.trim().split(/\r?\n/u)[0]).eventType, 'reserved');
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].ledgerText, /"eventType":"reserved"/u);
  assert.equal(fs.readFileSync(path.join(dir, 'assets', 'audio', 'VO_Act1.mp3'), 'utf8'), 'root audio must remain unchanged');
});

test('provider transport failure is never retried and ambiguous reservation blocks resume', async () => {
  const dir = tempEpisode();
  const args = options(dir, { actMap: { act1: { voFilename: 'VO_Act1.mp3', text: 'A sentence that cannot be repeated.' } } });
  const reviewDirectory = args.reviewOutputDirectory;
  let calls = 0;
  const deps = {
    ...fakeDependencies({ reviewDirectory }).dependencies,
    fetch: async () => { calls += 1; throw new Error('ambiguous transport failure'); },
  };
  await assert.rejects(runPacedNarration(args, deps), /PACED_PROVIDER_OUTCOME_AMBIGUOUS/);
  assert.equal(calls, 1);
  await assert.rejects(runPacedNarration(args, deps), /PACED_SEGMENT_OUTCOME_AMBIGUOUS/);
  assert.equal(calls, 1);
});

test('partial resume reuses verified completed segments and never repeats an ambiguous later request', async () => {
  const dir = tempEpisode();
  const args = options(dir, { actMap: { act1: { voFilename: 'VO_Act1.mp3', text: 'First short sentence. Second short sentence.' } }, maximumSegmentLength: 23 });
  const reviewDirectory = args.reviewOutputDirectory;
  let dispatches = 0;
  const probes = [];
  const deps = {
    apiKey: SECRET_KEY, channelDna: { voice_id_elevenlabs: SECRET_VOICE },
    fetch: async (url, request) => {
      dispatches += 1;
      if (dispatches === 2) throw new Error('connection lost after reservation');
      return makeResponse(JSON.parse(request.body).text, 'partial-resume-request-1');
    },
    probeAudio: async filePath => { probes.push(filePath); return { format: 'mp3', durationSec: 2 }; },
    joinAudio: async () => { throw new Error('act should not join while second segment is unresolved'); },
  };
  await assert.rejects(runPacedNarration(args, deps), /PACED_PROVIDER_OUTCOME_AMBIGUOUS/);
  assert.equal(dispatches, 2);
  const completedPath = path.join(reviewDirectory, 'audio', 'segments');
  assert.equal(fs.readdirSync(completedPath).filter(name => name.endsWith('.mp3')).length, 1);
  await assert.rejects(runPacedNarration(args, deps), /PACED_SEGMENT_OUTCOME_AMBIGUOUS/);
  assert.equal(dispatches, 2);
  assert.ok(probes.some(filePath => filePath.endsWith('.mp3')));
});

test('an HTTP provider failure consumes one reservation and cannot be retried on resume', async () => {
  const dir = tempEpisode();
  const args = options(dir, { actMap: { act1: { voFilename: 'VO_Act1.mp3', text: 'A provider rejection is final.' } } });
  let dispatches = 0;
  const deps = {
    apiKey: SECRET_KEY, channelDna: { voice_id_elevenlabs: SECRET_VOICE },
    fetch: async () => { dispatches += 1; return { ok: false, status: 503, headers: { get: () => null } }; },
    probeAudio: async () => ({ format: 'mp3', durationSec: 1 }),
  };
  await assert.rejects(runPacedNarration(args, deps), /PACED_PROVIDER_HTTP_ERROR/);
  assert.equal(dispatches, 1);
  await assert.rejects(runPacedNarration(args, deps), /PACED_SEGMENT_OUTCOME_AMBIGUOUS/);
  assert.equal(dispatches, 1);
});

test('completed hash-verified segments resume without a duplicate provider request', async () => {
  const dir = tempEpisode();
  const args = options(dir, { actMap: { act1: { voFilename: 'VO_Act1.mp3', text: 'One sentence. Another sentence.' } }, maximumSegmentLength: 20 });
  const fake = fakeDependencies({ reviewDirectory: args.reviewOutputDirectory });
  const first = await runPacedNarration(args, fake.dependencies);
  const callsAfterFirstRun = fake.calls.length;
  const second = await runPacedNarration(args, fake.dependencies);
  assert.equal(first.status, 'SUCCESS');
  assert.equal(second.status, 'SUCCESS');
  assert.ok(callsAfterFirstRun > 0);
  assert.equal(fake.calls.length, callsAfterFirstRun);
  assert.deepEqual(second.state.completedActs, ['act1']);
});

test('tampered completed audio is refused instead of regenerated', async () => {
  const dir = tempEpisode();
  const args = options(dir, { actMap: { act1: { voFilename: 'VO_Act1.mp3', text: 'One final sentence.' } } });
  const fake = fakeDependencies({ reviewDirectory: args.reviewOutputDirectory });
  const completed = await runPacedNarration(args, fake.dependencies);
  const segment = completed.plan.acts[0].segments[0];
  const segmentFile = path.join(args.reviewOutputDirectory, 'audio', 'segments', segment.segmentId + '-' + segment.textSha256.slice(0, 12) + '.mp3');
  fs.writeFileSync(segmentFile, 'tampered');
  const count = fake.calls.length;
  await assert.rejects(runPacedNarration(args, fake.dependencies), /PACED_COMPLETED_AUDIO_HASH_MISMATCH/);
  assert.equal(fake.calls.length, count);
});

test('segment and joined-act media are ffprobe validated and each segment is joined with 350ms pauses', async () => {
  const dir = tempEpisode();
  const args = options(dir, { actMap: { act1: { voFilename: 'VO_Act1.mp3', text: 'First sentence here. Second sentence here.' } }, maximumSegmentLength: 24 });
  const fake = fakeDependencies({ reviewDirectory: args.reviewOutputDirectory });
  await runPacedNarration(args, fake.dependencies);
  assert.ok(fake.probes.some(item => item.endsWith('.mp3.partial')));
  const joined = JSON.parse(fs.readFileSync(path.join(args.reviewOutputDirectory, 'run-status.json'), 'utf8')).joinedActs.act1;
  assert.equal(joined.joinPauseDurationMs, 350);
  assert.equal(joined.segmentIds.length, 2);
  assert.ok(fs.existsSync(path.join(args.reviewOutputDirectory, 'audio', 'VO_Act1.mp3')));
});

test('failed ffprobe leaves quarantined partial output and never retries', async () => {
  const dir = tempEpisode();
  const args = options(dir, { actMap: { act1: { voFilename: 'VO_Act1.mp3', text: 'A sentence stays here.' } } });
  let calls = 0;
  const deps = {
    ...fakeDependencies({ reviewDirectory: args.reviewOutputDirectory }).dependencies,
    fetch: async (url, request) => { calls += 1; return makeResponse(JSON.parse(request.body).text); },
    probeAudio: async () => { throw new Error('PACED_FFPROBE_FAILED'); },
  };
  await assert.rejects(runPacedNarration(args, deps), /PACED_RUN_FAILED|PACED_FFPROBE_FAILED/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(args.reviewOutputDirectory, 'audio', 'segments')), true);
  assert.equal(countJsonl(path.join(args.reviewOutputDirectory, 'request-ledger.jsonl')), 2);
  await assert.rejects(runPacedNarration(args, deps), /PACED_SEGMENT_OUTCOME_AMBIGUOUS/);
  assert.equal(calls, 1);
});

test('ffmpeg join construction inserts deterministic 350ms silence only between provider segments', async () => {
  const dir = tempEpisode();
  const a = path.join(dir, 'a.mp3'); const b = path.join(dir, 'b.mp3'); const out = path.join(dir, 'joined.partial');
  fs.writeFileSync(a, MP3); fs.writeFileSync(b, MP3);
  let observed;
  await joinPacedSegments([a, b], out, 350, { execFile: async (command, args) => { observed = { command, args }; fs.writeFileSync(out, MP3); return { stdout: '', stderr: '' }; } });
  assert.equal(observed.command, 'ffmpeg');
  assert.ok(observed.args.includes('0.350'));
  assert.ok(observed.args.some(arg => String(arg).includes('anullsrc=')));
  assert.match(observed.args[observed.args.indexOf('-filter_complex') + 1], /concat=n=3:v=0:a=1/u);
  assert.equal(fs.readFileSync(out).length, MP3.length);
});


test('the versioned portable pacing package verifies by exact file hashes', () => {
  const packageDirectory = path.resolve(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo', 'phase2.3b-p-review');
  const verified = verifyPacingPackage({ packageDirectory });
  assert.deepEqual(verified.verified.sort(), ['pacing-plan-baseline.json', 'pacing-run-spec.json']);
  const preview = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'pacing-plan-baseline.json'), 'utf8'));
  assert.equal(preview.plan.totalRequests, 16);
  assert.equal(preview.plan.totalBillableCharacters, 8686);
});

test('the Wells Fargo adapter changes only approved corrected acts and preserves locked source text elsewhere', () => {
  const spec = {
    actOrder: ['act1', 'act3b'], voFilenames: { act1: 'VO_Act1.mp3', act3b: 'VO_Act3B.mp3' },
    approvedCorrectionText: { act3b: { characters: 4, sha256: sha256('new.') } },
    channelKey: 'EmpireOmitted', episodeDirectory: '/episode', voiceSettings: SETTINGS,
    outputFormat: DEFAULT_OUTPUT_FORMAT, maximumSegmentLength: 720, joinPauseDurationMs: 350,
    maximumRequests: 18, maximumCharacters: 9200,
  };
  const script = { acts: { act1: { voScript: 'Old authoritative wording.' }, act3b: { voScript: 'Old corrected act wording.' } } };
  const actMap = buildActMap({ script, narrationTexts: { act3b: { next: 'new.' } }, spec });
  assert.equal(actMap.act1.text, 'Old authoritative wording.');
  assert.equal(actMap.act3b.text, 'new.');
  assert.equal(script.acts.act3b.voScript, 'Old corrected act wording.');
  assert.equal(actMap.act3b.voFilename, 'VO_Act3B.mp3');
});

test('credential presence is reported only as booleans and staging target mismatches fail closed', () => {
  assert.deepEqual(getCredentialState({ channelDna: { voice_id_elevenlabs: SECRET_VOICE }, env: { ELEVENLABS_API_KEY: SECRET_KEY } }), { credentialsPresent: true, voiceIdConfigured: true });
  const result = JSON.stringify(getCredentialState({ channelDna: { voice_id_elevenlabs: SECRET_VOICE }, env: { ELEVENLABS_API_KEY: SECRET_KEY } }));
  assert.equal(result.includes(SECRET_KEY), false);
  assert.equal(result.includes(SECRET_VOICE), false);
  assert.throws(() => verifyRailwayTarget({ RAILWAY_PROJECT_ID: 'production-project' }), /WRONG_RAILWAY_TARGET/);
  assert.equal(verifyRailwayTarget({}), true);
});

test('CLI has a read-only help path and requires an explicit safe run ID', () => {
  assert.equal(parseArgs(['--help']).mode, 'help');
  assert.throws(() => parseArgs(['--preflight']), /RUN_ID_REQUIRED/);
  assert.equal(parseArgs(['--preflight', '--run-id', 'paced-review-001']).runId, 'paced-review-001');
});

test('source inputs and settings are not mutated during planning', () => {
  const dir = tempEpisode();
  const actMap = { opening: { voFilename: 'VO_Opening.mp3', text: 'A sentence remains unchanged.' } };
  const settings = { ...SETTINGS };
  const before = JSON.stringify({ actMap, settings });
  planPacedNarration({ ...options(dir, { actMap, channelKey: 'NeutralChannel' }), voiceSettings: settings });
  assert.equal(JSON.stringify({ actMap, settings }), before);
});

test('no real provider network requests occur during this test file', () => {
  assert.equal(realNetworkCalls, 0);
  assert.equal(DEFAULT_OUTPUT_FORMAT, 'mp3_44100_128');
});
