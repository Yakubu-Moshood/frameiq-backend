'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const pipelineDir = path.resolve(__dirname, '../pipeline-updates');
const word = (vo_file, text = 'cached', start = 1, end = 2) =>
  ({ vo_file, word: text, start_seconds: start, end_seconds: end });
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(t, replies = [], env = { OPENAI_API_KEY: 'test-only' }) {
  const episodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-timing-test-'));
  const audioDir = path.join(episodeDir, 'assets', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  t.after(() => fs.rmSync(episodeDir, { recursive: true, force: true }));
  const calls = [], delays = [], timeouts = [];
  const fakeFs = { ...fs, createReadStream: filePath => ({ path: filePath }) };
  class FakeFormData {
    constructor() { this.fields = {}; }
    append(key, value) { this.fields[key] = value; }
    getHeaders() { return { 'content-type': 'multipart/form-data; boundary=test' }; }
    pipe(req) { req.send(this.fields); }
  }
  const https = {
    request(options, callback) {
      const req = new EventEmitter();
      req.setTimeout = (ms, handler) => { timeouts.push(ms); req.timeout = handler; };
      req.destroy = err => queueMicrotask(() => req.emit('error', err));
      req.send = fields => {
        calls.push({ options, fields });
        const reply = replies.shift();
        assert.ok(reply, 'Unexpected transcription request (real network is never allowed)');
        queueMicrotask(() => {
          if (reply.timeout) return req.timeout();
          const res = new EventEmitter();
          res.statusCode = reply.status || 200;
          callback(res);
          res.emit('data', JSON.stringify(reply.body || { words: [] }));
          res.emit('end');
        });
      };
      return req;
    },
  };
  function load(filename, suffix = '') {
    const module = { exports: {} };
    const sandbox = {
      module, exports: module.exports, __dirname: pipelineDir,
      console: { log() {}, warn() {}, error() {} }, process: { env },
      setTimeout(fn, ms) { delays.push(ms); queueMicrotask(fn); },
      require(name) {
        if (name === 'fs') return fakeFs;
        if (name === 'path') return path;
        if (name === 'https') return https;
        if (name === 'form-data') return FakeFormData;
        if (name === 'dotenv') return { config() {} };
        if (name === 'readline') return {};
        if (name === 'child_process') return { execSync() { throw new Error('Unexpected external command'); } };
        if (name === './vo-timing.cjs') return load('vo-timing.cjs');
        if (name === './shot-definitions-validator.cjs') return {
          loadValidatedV3Plan() { throw new Error('V3 validation is not expected in the legacy renderer test'); },
          validateShotDefinitions() { throw new Error('V3 validation is not expected in the legacy renderer test'); },
        };
        if (name === './production-method-manifest.cjs') return {
          loadProductionMethodManifest() { throw new Error('V3 manifest loading is not expected in the legacy renderer test'); },
          assertManifestReadyForRender() { throw new Error('V3 manifest validation is not expected in the legacy renderer test'); },
          resolveProductionAssetLocation() { throw new Error('V3 asset routing is not expected in the legacy renderer test'); },
        };
        if (name === './v3-asset-readiness.cjs') return {
          assertV3AssetsReadyForRender() { throw new Error('V3 asset readiness is not expected in the legacy renderer test'); },
        };
        throw new Error('Unexpected dependency: ' + name);
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(pipelineDir, filename), 'utf8') + suffix, sandbox, { filename });
    return module.exports;
  }
  const timing = () => load('vo-timing.cjs');
  const write = (name, value) => fs.writeFileSync(path.join(episodeDir, name), JSON.stringify(value));
  const read = name => JSON.parse(fs.readFileSync(path.join(episodeDir, name), 'utf8'));
  const audio = name => fs.writeFileSync(path.join(audioDir, name + '.mp3'), 'fixture');
  return { episodeDir, audioDir, calls, delays, timeouts, timing, load, write, read, audio };
}

test('completed timestamps are reused without an API key or transcription', async t => {
  const f = fixture(t, [], {});
  const cached = [word('VO_Act1')];
  f.write('word-timestamps.json', cached);
  assert.deepEqual(plain(await f.timing().runWhisper(f)), cached);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.read('word-timestamps.json'), cached);
});

test('partial entries are reused and fresh words retain the legacy format and act order', async t => {
  const f = fixture(t, [{ body: { words: [{ word: "DON'T!", start: 0.25, end: 0.75 }, { word: '$42,', start: 1, end: 2 }] } }]);
  const cached = word('VO_Act1');
  f.write('word-timestamps.partial.json', { VO_Act3B: [word('VO_Act3B')], VO_Act1: [cached] });
  f.audio('VO_Act1'); f.audio('VO_Act2'); f.audio('VO_Act3B');
  const expected = [cached, word('VO_Act2', "don't", 0.25, 0.75), word('VO_Act2', '42'), word('VO_Act3B')];
  assert.deepEqual(plain(await f.timing().runWhisper(f)), expected);
  assert.deepEqual(f.read('word-timestamps.json'), expected);
  assert.equal(fs.existsSync(path.join(f.episodeDir, 'word-timestamps.partial.json')), false);
  assert.equal(f.calls.length, 1);
  const { options, fields } = f.calls[0];
  assert.equal(path.basename(fields.file.path), 'VO_Act2.mp3');
  assert.equal(fields.model, 'whisper-1');
  assert.equal(fields.response_format, 'verbose_json');
  assert.equal(fields['timestamp_granularities[]'], 'word');
  assert.equal(options.hostname, 'api.openai.com');
  assert.equal(options.path, '/v1/audio/transcriptions');
  assert.equal(options.method, 'POST');
  assert.deepEqual(f.timeouts, [120000]);
});

test('failed later act keeps the successful checkpoint and resumes without rebilling it', async t => {
  const replies = [{ body: { words: [{ word: 'First', start: 1, end: 2 }] } }, ...Array.from({ length: 3 }, () => ({ status: 500 }))];
  const f = fixture(t, replies);
  f.audio('VO_Act1'); f.audio('VO_Act2');
  await assert.rejects(f.timing().runWhisper(f), /VO_Act2: failed after 3 attempt/);
  assert.deepEqual(f.read('word-timestamps.partial.json'), { VO_Act1: [word('VO_Act1', 'first')] });
  assert.equal(fs.existsSync(path.join(f.episodeDir, 'word-timestamps.json')), false);
  assert.deepEqual(f.delays, [2000, 4000]);
  replies.push({ body: { words: [{ word: 'Second', start: 1, end: 2 }] } });
  assert.deepEqual(plain(await f.timing().runWhisper(f)), [word('VO_Act1', 'first'), word('VO_Act2', 'second')]);
  assert.equal(f.calls.filter(c => path.basename(c.fields.file.path) === 'VO_Act1.mp3').length, 1);
});

test('request timeout rejects and retries without hanging', async t => {
  const f = fixture(t, [{ timeout: true }, { body: { words: [{ word: 'OK', start: 1, end: 2 }] } }]);
  f.audio('VO_Act1');
  assert.deepEqual(plain(await f.timing().runWhisper(f)), [word('VO_Act1', 'ok')]);
  assert.deepEqual(f.delays, [2000]);
  assert.deepEqual(f.timeouts, [120000, 120000]);
});

test('optional progress events identify each Whisper attempt and completed checkpoint without changing output', async t => {
  const f = fixture(t, [{ status: 500 }, { body: { words: [{ word: 'Progress', start: 0.2, end: 0.6 }] } }]);
  f.audio('VO_Act1');
  const events = [];
  const result = await f.timing().runWhisper({ ...f, onProgress: event => events.push(event) });
  assert.deepEqual(plain(result), [word('VO_Act1', 'progress', 0.2, 0.6)]);
  assert.deepEqual(events.filter(event => event.type === 'attempt-start').map(event => [event.voKey, event.attempt]), [['VO_Act1', 1], ['VO_Act1', 2]]);
  assert.deepEqual(events.filter(event => event.type === 'file-complete').map(event => event.voKey), ['VO_Act1']);
  assert.equal(f.calls.length, 2, 'all provider I/O is handled by the fake HTTP client');
});

for (const channel of ['EmpireOmitted', 'MoneyExplained']) {
  test(`renderer consumes cached timestamps unchanged for ${channel}`, async t => {
    const f = fixture(t, [], {});
    const cached = [word('VO_Act1', 'alpha', 1, 2), word('VO_Act1', 'omega', 10, 12)];
    f.write('word-timestamps.json', cached);
    const shots = ['alpha', 'omega'].map((triggerWord, i) => ({ shotId: 'ACT1_00' + (i + 1), actKey: 'act1', triggerWord, visualType: 'CLIP' }));
    f.write('shot-definitions.json', { acts: { act1: shots }, allShots: shots });
    // Run the real orchestration, trigger repair and timestamp resolution;
    // replace only media/OS work, stopping at the segment-rendering boundary.
    const renderer = f.load('surface-renderer.cjs', `
      logDiskSpace = () => {};
      renderSegments = ({ resolved }) => {
        module.exports.resolved = resolved;
        throw new Error('TEST_SEGMENT_BOUNDARY');
      };
    `);
    await assert.rejects(renderer.renderEpisode({ episodeDir: f.episodeDir, episodeId: 'TEST', channel, maxShotDurationSec: 7 }), /TEST_SEGMENT_BOUNDARY/);
    assert.deepEqual(plain(renderer.resolved).map(s => ({ start: s.startSec, end: s.endSec, motion: s.motionDurSec, freeze: s.freezeDurSec })), [
      { start: 1, end: 10, motion: 7, freeze: 2 },
      { start: 10, end: 12, motion: 2, freeze: 0 },
    ]);
    assert.deepEqual(f.read('shot-definitions.json').allShots.map(s => s.hardcodedSec), [1, 10]);
    assert.deepEqual(f.read('word-timestamps.json'), cached);
    assert.equal(f.calls.length, 0);
  });
}
