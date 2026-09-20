'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  runEmpireOmittedV3Shadow, VO_FILES, voSetFingerprint,
} = require('../pipeline-updates/eo-v3-shadow.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-v3-shadow-'));
  const audioDir = path.join(root, 'audio'); const episodeDir = path.join(root, 'episode');
  fs.mkdirSync(audioDir); fs.mkdirSync(episodeDir);
  VO_FILES.forEach(([filename]) => fs.writeFileSync(path.join(audioDir, filename), Buffer.from(`fixture:${filename}`)));
  return { root, audioDir, episodeDir, episodeId: 'episode-1', channel: 'Empire Omitted', channelDna: { id: 'EmpireOmitted', label: 'Empire Omitted' }, script: { title: 'Test', acts: {} } };
}

function words() {
  return VO_FILES.flatMap(([, , voKey]) => [{ vo_file: voKey, word: 'word', start_seconds: 0, end_seconds: 1 }]);
}

function cleanup(data) { fs.rmSync(data.root, { recursive: true, force: true }); }

function durations() { return Object.fromEntries(VO_FILES.map(([, act]) => [act, 10])); }

test('rejects non-Empire channels before transcription or Director work', async () => {
  const f = fixture(); let timing = 0; let director = 0;
  try {
    await assert.rejects(runEmpireOmittedV3Shadow({ ...f, channel: 'Macro Decode', runWhisper: async () => { timing++; }, generateEditPlan: async () => { director++; } }), /another channel/);
    assert.equal(timing, 0); assert.equal(director, 0);
  } finally { cleanup(f); }
});

test('reports one or multiple missing VO files before paid work', async () => {
  for (const count of [1, 2]) {
    const f = fixture(); let timing = 0; let director = 0;
    try {
      VO_FILES.slice(0, count).forEach(([filename]) => fs.rmSync(path.join(f.audioDir, filename)));
      await assert.rejects(runEmpireOmittedV3Shadow({ ...f, runWhisper: async () => { timing++; }, generateEditPlan: async () => { director++; } }), error => {
        assert.match(error.message, /Missing finished VO file/);
        for (const [filename] of VO_FILES.slice(0, count)) assert.match(error.message, new RegExp(filename));
        return true;
      });
      assert.equal(timing, 0); assert.equal(director, 0);
    } finally { cleanup(f); }
  }
});

test('zero-byte VO files fail preflight before hashing, probing, Whisper, or Director', async () => {
  const f = fixture(); let probes = 0; let timing = 0; let director = 0;
  try {
    fs.writeFileSync(path.join(f.audioDir, 'VO_Act4.mp3'), Buffer.alloc(0));
    await assert.rejects(runEmpireOmittedV3Shadow({ ...f,
      probeDuration: async () => { probes++; return 10; },
      runWhisper: async () => { timing++; return words(); },
      generateEditPlan: async () => { director++; },
    }), error => { assert.match(error.message, /VO_Act4\.mp3/); return true; });
    const status = JSON.parse(fs.readFileSync(path.join(f.episodeDir, 'edit-plan-shadow-status.json')));
    assert.equal(status.errorStage, 'vo_preflight');
    assert.equal(probes, 0); assert.equal(timing, 0); assert.equal(director, 0);
  } finally { cleanup(f); }
});

test('VO set identity is byte based, ordered and changes when one file changes', () => {
  const a = VO_FILES.map(([filename]) => ({ filename, sha256: filename }));
  const b = a.map(value => ({ ...value })); b[3].sha256 = 'changed';
  const reordered = [...a].reverse();
  assert.equal(voSetFingerprint(a), voSetFingerprint(a));
  assert.notEqual(voSetFingerprint(a), voSetFingerprint(b));
  assert.notEqual(voSetFingerprint(a), voSetFingerprint(reordered));
});

test('successful orchestration probes exact durations, isolates timing cache, and writes PASS status', async () => {
  const f = fixture(); const timingDirs = []; let received;
  try {
    const plan = { schemaVersion: '3.0.0' };
    const result = await runEmpireOmittedV3Shadow({ ...f,
      probeDuration: async () => 10,
      runWhisper: async args => { timingDirs.push(args.episodeDir); return words(); },
      generateEditPlan: async args => { received = args; return plan; },
    });
    assert.equal(timingDirs.length, 1);
    assert.match(result.timingDir, new RegExp('\\.v3-shadow[\\\\/]timing[\\\\/][a-f0-9]{64}$'));
    assert.equal(received.channel, 'EmpireOmitted');
    assert.deepEqual(received.actDurationsSec, durations());
    assert.deepEqual(received.wordTimestamps, words());
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.episodeDir, 'edit-plan-shadow-status.json'))).status, 'complete');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.episodeDir, 'edit-plan-shadow-status.json'))).editPlanStatus, 'PASS');
    assert.equal(fs.existsSync(path.join(f.episodeDir, 'edit-plan.json')), false);
  } finally { cleanup(f); }
});

test('V3 timing cache path is reused for identical bytes and differs after a byte change', async () => {
  const f = fixture(); const paths = [];
  try {
    const options = { ...f, probeDuration: async () => 10, runWhisper: async args => { paths.push(args.episodeDir); return words(); }, generateEditPlan: async () => ({}) };
    await runEmpireOmittedV3Shadow(options); await runEmpireOmittedV3Shadow(options);
    fs.appendFileSync(path.join(f.audioDir, 'VO_Act3.mp3'), 'changed');
    await runEmpireOmittedV3Shadow(options);
    assert.equal(paths[0], paths[1]); assert.notEqual(paths[1], paths[2]);
  } finally { cleanup(f); }
});

test('legacy V2 timestamp file remains untouched and independent from V3 cache', async () => {
  const f = fixture(); const legacy = path.join(f.episodeDir, 'word-timestamps.json');
  fs.writeFileSync(legacy, '{"legacy":true}\n'); const before = fs.readFileSync(legacy);
  try {
    const result = await runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async ({ episodeDir }) => { fs.mkdirSync(episodeDir, { recursive: true }); fs.writeFileSync(path.join(episodeDir, 'word-timestamps.json'), JSON.stringify(words())); return words(); }, generateEditPlan: async () => ({}) });
    assert.deepEqual(fs.readFileSync(legacy), before);
    assert.notEqual(result.timingDir, f.episodeDir);
    assert.equal(fs.existsSync(path.join(result.timingDir, 'word-timestamps.json')), true);
  } finally { cleanup(f); }
});

test('Act3B duration maps to act3b and invalid duration stops before Director', async () => {
  const f = fixture(); let director = 0; const seen = [];
  try {
    await runEmpireOmittedV3Shadow({ ...f, probeDuration: async file => { seen.push(path.basename(file)); return file.includes('Act3B') ? 13 : 10; }, runWhisper: async () => words(), generateEditPlan: async ({ actDurationsSec }) => { assert.equal(actDurationsSec.act3b, 13); director++; return {}; } });
    assert.equal(director, 1); assert.equal(seen[3], 'VO_Act3B.mp3');
    await assert.rejects(runEmpireOmittedV3Shadow({ ...f, probeDuration: async file => file.includes('Act4') ? 0 : 10, runWhisper: async () => words(), generateEditPlan: async () => { director++; } }), /Invalid duration/);
    assert.equal(director, 1);
  } finally { cleanup(f); }
});

test('incomplete Whisper result prevents Director calls', async () => {
  const f = fixture(); let director = 0;
  try {
    await assert.rejects(runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => words().filter(word => word.vo_file !== 'VO_Act4'), generateEditPlan: async () => { director++; } }), /Missing timed words|timing is incomplete/);
    assert.equal(director, 0);
  } finally { cleanup(f); }
});

test('invalid timing records are rejected before Director work', async () => {
  const cases = [
    words().map(word => ({ ...word })),
    words().map(word => ({ ...word })),
    words().map(word => ({ ...word })),
    words().map(word => ({ ...word })),
  ];
  cases[0][0].start_seconds = -1;
  cases[1][0].end_seconds = -1;
  cases[2][0].word = 42;
  cases[3].splice(1, 0, { ...cases[3][0], start_seconds: 0.5, end_seconds: 1.5 });
  for (const invalid of cases) {
    const f = fixture(); let director = 0;
    try {
      await assert.rejects(runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => invalid, generateEditPlan: async () => { director++; } }), /Invalid timing|Overlapping/);
      assert.equal(director, 0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.episodeDir, 'edit-plan-shadow-status.json'))).errorStage, 'vo_timing');
    } finally { cleanup(f); }
  }
});

test('unexpected and missing VO keys are rejected before Director work', async () => {
  for (const timed of [
    words().map(word => word.vo_file === 'VO_Act6' ? word : word),
    words().filter(word => word.vo_file !== 'VO_Act5'),
  ]) {
    const f = fixture(); let director = 0;
    try {
      const altered = timed === timed ? timed : timed;
      if (timed.length === words().length) altered[0] = { ...altered[0], vo_file: 'VO_Act6' };
      await assert.rejects(runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => altered, generateEditPlan: async () => { director++; } }), /Unexpected VO key|Missing timed words/);
      assert.equal(director, 0);
    } finally { cleanup(f); }
  }
});

test('legacy empty-string word text remains valid when timing is valid', async () => {
  const f = fixture(); const timed = words().map(word => ({ ...word })); timed[0].word = '';
  let received;
  try {
    await runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => timed, generateEditPlan: async args => { received = args.wordTimestamps; return {}; } });
    assert.equal(received[0].word, '');
  } finally { cleanup(f); }
});

test('timing failure records vo_timing and rethrows the original error', async () => {
  const f = fixture(); const original = new Error('timing exploded');
  try {
    await assert.rejects(runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => { throw original; }, generateEditPlan: async () => ({}) }), error => error === original);
    const status = JSON.parse(fs.readFileSync(path.join(f.episodeDir, 'edit-plan-shadow-status.json')));
    assert.equal(status.status, 'failed'); assert.equal(status.errorStage, 'vo_timing');
  } finally { cleanup(f); }
});

test('controlled status text excludes upstream timing secrets and preserves the original error', async () => {
  const f = fixture(); const original = new Error('Bearer sk-test-super-secret');
  try {
    await assert.rejects(runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => { throw original; }, generateEditPlan: async () => ({}) }), error => error === original);
    const text = fs.readFileSync(path.join(f.episodeDir, 'edit-plan-shadow-status.json'), 'utf8');
    assert.doesNotMatch(text, /sk-test-super-secret|Bearer/);
    assert.match(text, /Finished VO timing\/transcription failed/);
  } finally { cleanup(f); }
});

test('Director failure records director and rethrows the original error', async () => {
  const f = fixture(); const original = new Error('director exploded');
  try {
    await assert.rejects(runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => words(), generateEditPlan: async () => { throw original; } }), error => error === original);
    const status = JSON.parse(fs.readFileSync(path.join(f.episodeDir, 'edit-plan-shadow-status.json')));
    assert.equal(status.status, 'failed'); assert.equal(status.errorStage, 'director');
  } finally { cleanup(f); }
});

test('controlled status text excludes upstream Director secrets', async () => {
  const f = fixture(); const original = new Error('Anthropic api_key=fake-anthropic-secret Authorization: Bearer token');
  try {
    await assert.rejects(runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => words(), generateEditPlan: async () => { throw original; } }), error => error === original);
    const text = fs.readFileSync(path.join(f.episodeDir, 'edit-plan-shadow-status.json'), 'utf8');
    assert.doesNotMatch(text, /fake-anthropic-secret|Bearer token/);
    assert.match(text, /V3 Director generation failed/);
  } finally { cleanup(f); }
});

test('status-writer failure never masks the original timing error', async () => {
  const f = fixture(); const original = new Error('timing original'); let director = 0;
  try {
    await assert.rejects(runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => { throw original; }, generateEditPlan: async () => { director++; }, writeStatus: () => { throw new Error('status writer failed'); } }), error => error === original);
    assert.equal(director, 0);
  } finally { cleanup(f); }
});

test('status artifacts contain no secrets and leave no temp file', async () => {
  const f = fixture();
  try {
    await runEmpireOmittedV3Shadow({ ...f, channelDna: { id: 'EmpireOmitted', api_key: 'SECRET_TEST', voice_id_elevenlabs: 'SECRET_VOICE' }, probeDuration: async () => 10, runWhisper: async () => words(), generateEditPlan: async () => ({}) });
    const text = fs.readFileSync(path.join(f.episodeDir, 'edit-plan-shadow-status.json'), 'utf8');
    assert.doesNotMatch(text, /SECRET_TEST|SECRET_VOICE|api_key|voice_id/);
    assert.equal(fs.readdirSync(f.episodeDir).some(name => name.endsWith('.tmp')), false);
  } finally { cleanup(f); }
});

test('shadow tests use injected dependencies and make no network calls', async () => {
  const f = fixture(); let timing = 0; let director = 0;
  try {
    await runEmpireOmittedV3Shadow({ ...f, probeDuration: async () => 10, runWhisper: async () => { timing++; return words(); }, generateEditPlan: async () => { director++; return {}; } });
    assert.equal(timing, 1); assert.equal(director, 1);
  } finally { cleanup(f); }
});
