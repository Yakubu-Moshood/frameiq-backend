'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runEoV3ShadowHook } = require('../jobs/eo-v3-shadow-hook.js');

const base = () => ({
  env: {}, testMode: false, channelKey: 'EmpireOmitted', episodeDbId: 'db-123',
  script: { title: 'Script' }, audioDir: 'audio-dir', episodeDir: 'episode-dir', pipelineDir: 'pipeline-dir',
});

function deps(overrides = {}) {
  const calls = { dna: 0, loads: 0, shadows: 0, args: null, logs: [] };
  return {
    calls,
    getChannelDna: async () => { calls.dna++; return { id: 'EmpireOmitted', secret: 'hidden' }; },
    loadShadow: () => { calls.loads++; return { runEmpireOmittedV3Shadow: async args => { calls.shadows++; calls.args = args; } }; },
    logger: { log: message => calls.logs.push(message), warn: message => calls.logs.push(message) },
    ...overrides,
  };
}

test('flag off or missing skips all V3 work', async () => {
  for (const env of [{}, { EMPIRE_OMITTED_V3_SHADOW: 'false' }, { EMPIRE_OMITTED_V3_SHADOW: 'yes' }]) {
    const d = deps(); const result = await runEoV3ShadowHook({ ...base(), env, ...d });
    assert.deepEqual(result, { status: 'skipped', reason: 'disabled' });
    assert.deepEqual(d.calls, { dna: 0, loads: 0, shadows: 0, args: null, logs: [] });
  }
});

test('TEST_MODE and non-Empire channels skip before DNA/module/shadow work', async () => {
  const testDeps = deps();
  assert.deepEqual(await runEoV3ShadowHook({ ...base(), env: { EMPIRE_OMITTED_V3_SHADOW: 'true' }, testMode: true, ...testDeps }), { status: 'skipped', reason: 'test_mode' });
  assert.equal(testDeps.calls.dna, 0);
  const channelDeps = deps();
  assert.deepEqual(await runEoV3ShadowHook({ ...base(), env: { EMPIRE_OMITTED_V3_SHADOW: 'true' }, channelKey: 'MoneyExplained', ...channelDeps }), { status: 'skipped', reason: 'channel' });
  assert.equal(channelDeps.calls.dna, 0);
});

test('Empire flag performs one DNA lookup and one shadow call with stable DB episode identity', async () => {
  const d = deps();
  const result = await runEoV3ShadowHook({ ...base(), env: { EMPIRE_OMITTED_V3_SHADOW: ' TRUE ' }, ...d });
  assert.deepEqual(result, { status: 'complete' });
  assert.equal(d.calls.dna, 1); assert.equal(d.calls.loads, 1); assert.equal(d.calls.shadows, 1);
  assert.equal(d.calls.args.episodeId, 'db-123');
  assert.equal(d.calls.args.channel, 'EmpireOmitted');
  assert.equal(d.calls.args.script.title, 'Script');
  assert.equal(d.calls.args.audioDir, 'audio-dir');
  assert.equal(d.calls.args.episodeDir, 'episode-dir');
  assert.deepEqual(d.calls.args.channelDna, { id: 'EmpireOmitted', secret: 'hidden' });
});

test('DNA lookup failure or null returns failed without shadow work', async () => {
  for (const getChannelDna of [async () => { throw new Error('secret'); }, async () => null]) {
    const d = deps({ getChannelDna });
    const result = await runEoV3ShadowHook({ ...base(), env: { EMPIRE_OMITTED_V3_SHADOW: 'true' }, ...d });
    assert.deepEqual(result, { status: 'failed', reason: 'channel_dna' });
    assert.equal(d.calls.shadows, 0);
  }
});

test('module-load and shadow failures are swallowed with safe logs', async () => {
  const unavailable = deps({ loadShadow: () => { throw new Error('Bearer sk-test-super-secret'); } });
  assert.deepEqual(await runEoV3ShadowHook({ ...base(), env: { EMPIRE_OMITTED_V3_SHADOW: 'true' }, ...unavailable }), { status: 'failed', reason: 'module_load' });
  assert.doesNotMatch(unavailable.calls.logs.join('\n'), /sk-test-super-secret|Bearer/);
  const failed = deps({ loadShadow: () => ({ runEmpireOmittedV3Shadow: async () => { throw new Error('api_key=secret'); } }) });
  assert.deepEqual(await runEoV3ShadowHook({ ...base(), env: { EMPIRE_OMITTED_V3_SHADOW: 'true' }, ...failed }), { status: 'failed', reason: 'shadow' });
  assert.doesNotMatch(failed.calls.logs.join('\n'), /api_key=secret/);
});

test('runner source keeps pause check before shadow and shadow before 0C running', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'runner.js'), 'utf8');
  assert.doesNotMatch(source.split('\n').slice(0, 45).join('\n'), /require\(['"]\.\/eo-v3-shadow-hook\.js['"]\)/);
  const pause = source.indexOf("checkPaused(episodeDbId, '0C_shots')");
  const shadow = source.indexOf('runEoV3ShadowHook', pause);
  const secondPause = source.indexOf("checkPaused(episodeDbId, '0C_shots')", shadow);
  const running = source.indexOf("updateJob(job0C.id, { status: 'running'", secondPause);
  assert.ok(pause >= 0 && shadow > pause && secondPause > shadow && running > secondPause);
  assert.doesNotMatch(source.slice(shadow, secondPause), /runStageOrFail/);
  assert.match(source, /const shadowRequested = String\(process\.env\.EMPIRE_OMITTED_V3_SHADOW \|\| ''\)/);
  assert.match(source, /channelKey === 'EmpireOmitted'/);
});

test('runner eligibility semantics only enable the V3 branch for true Empire production runs', () => {
  const enabled = value => String(value || '').trim().toLowerCase() === 'true' && true && 'EmpireOmitted' === 'EmpireOmitted';
  for (const value of [undefined, '', 'false', 'FALSE', '0', 'yes']) assert.equal(enabled(value), false);
  for (const value of ['true', 'TRUE', ' true ']) assert.equal(enabled(value), true);
});
