'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const { syncPipelineDirectory } = require('../jobs/pipeline-sync');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('pipeline sync recursively copies canonical provider files and backs up replacements', () => {
  const root = makeTempDir('fraymiq-pipeline-sync-');
  const sourceDir = path.join(root, 'source');
  const targetDir = path.join(root, 'target');
  const backupDir = path.join(root, 'backup');
  try {
    fs.mkdirSync(path.join(sourceDir, 'providers', 'image'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'providers', 'video'), { recursive: true });
    fs.mkdirSync(path.join(targetDir, 'providers', 'image'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'surface-image-generator.cjs'), 'image-gen-v2');
    fs.writeFileSync(path.join(sourceDir, 'providers', 'provider-router.cjs'), 'router-v2');
    fs.writeFileSync(path.join(sourceDir, 'providers', 'image', 'sdxl.cjs'), 'sdxl-v2');
    fs.writeFileSync(path.join(sourceDir, 'providers', 'video', 'svd.cjs'), 'svd-v2');
    fs.writeFileSync(path.join(sourceDir, 'ignored.txt'), 'ignore');
    fs.writeFileSync(path.join(targetDir, 'surface-image-generator.cjs'), 'old-image-gen');
    fs.writeFileSync(path.join(targetDir, 'providers', 'image', 'sdxl.cjs'), 'old-sdxl');
    fs.writeFileSync(path.join(targetDir, 'keep.log'), 'unmanaged');

    const copied = syncPipelineDirectory({ sourceDir, targetDir, backupDir });

    assert.deepEqual(copied, [
      'providers/image/sdxl.cjs',
      'providers/provider-router.cjs',
      'providers/video/svd.cjs',
      'surface-image-generator.cjs',
    ]);
    assert.equal(fs.readFileSync(path.join(targetDir, 'providers', 'provider-router.cjs'), 'utf8'), 'router-v2');
    assert.equal(fs.readFileSync(path.join(targetDir, 'providers', 'video', 'svd.cjs'), 'utf8'), 'svd-v2');
    assert.equal(fs.readFileSync(path.join(backupDir, 'surface-image-generator.cjs'), 'utf8'), 'old-image-gen');
    assert.equal(fs.readFileSync(path.join(backupDir, 'providers', 'image', 'sdxl.cjs'), 'utf8'), 'old-sdxl');
    assert.equal(fs.readFileSync(path.join(targetDir, 'keep.log'), 'utf8'), 'unmanaged');
    assert.equal(fs.existsSync(path.join(targetDir, 'ignored.txt')), false);
    assert.deepEqual(syncPipelineDirectory({ sourceDir, targetDir, backupDir }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Phase 2 modules load without provider credentials or a production database', async t => {
  const tempDir = makeTempDir('fraymiq-module-load-');
  const dbStubPath = path.join(tempDir, 'db-stub.cjs');
  const priorEnv = {
    DB_MODULE_PATH: process.env.DB_MODULE_PATH,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    FAL_KEY: process.env.FAL_KEY,
    REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN,
  };
  const priorDbCalls = global.__phase2DbCalls;
  let networkAttempts = 0;
  const originalNetworkMethods = {};
  for (const client of [http, https]) {
    for (const method of ['request', 'get']) {
      originalNetworkMethods[method] = originalNetworkMethods[method] || [];
      originalNetworkMethods[method].push([client, client[method]]);
      client[method] = () => { networkAttempts++; throw new Error('network is disabled in this test'); };
    }
  }
  global.__phase2DbCalls = [];
  fs.writeFileSync(dbStubPath, [
    "'use strict';",
    'module.exports = {',
    '  run: async (...args) => { global.__phase2DbCalls.push(args); },',
    '  get: async () => null,',
    '  all: async () => [],',
    '};',
  ].join('\n'));
  process.env.DB_MODULE_PATH = dbStubPath;
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'FAL_KEY', 'REPLICATE_API_TOKEN']) delete process.env[key];

  t.after(() => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [client, original] of originalNetworkMethods.request || []) client.request = original;
    for (const [client, original] of originalNetworkMethods.get || []) client.get = original;
    if (priorDbCalls === undefined) delete global.__phase2DbCalls;
    else global.__phase2DbCalls = priorDbCalls;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const phase2Modules = [
    '../pipeline-updates/surface-shot-definitions.cjs',
    '../pipeline-updates/surface-image-generator.cjs',
    '../pipeline-updates/surface-animator.cjs',
    '../pipeline-updates/surface-renderer.cjs',
    '../pipeline-updates/providers/provider-router.cjs',
    '../pipeline-updates/providers/image/sdxl.cjs',
    '../pipeline-updates/providers/video/svd.cjs',
    '../pipeline-updates/config-reader.cjs',
  ];
  for (const relativePath of phase2Modules) {
    assert.doesNotThrow(() => require(relativePath), relativePath);
  }

  const sdxl = require('../pipeline-updates/providers/image/sdxl.cjs');
  const svd = require('../pipeline-updates/providers/video/svd.cjs');
  assert.deepEqual(await sdxl.generate({ prompt: 'test only', outputPath: path.join(tempDir, 'unused.png') }), {
    success: false,
    statusCode: 401,
    error: 'REPLICATE_API_TOKEN not set',
  });
  assert.deepEqual(await svd.generate({ sourceImagePath: path.join(tempDir, 'missing.png'), outputPath: path.join(tempDir, 'unused.mp4') }), {
    success: false,
    statusCode: 401,
    error: 'REPLICATE_API_TOKEN not set',
  });

  const { createRouter } = require('../pipeline-updates/providers/provider-router.cjs');
  const router = createRouter({
    step: 'image',
    estimateCost: provider => provider === 'fallback' ? 0 : null,
    providers: {
      primary: { generate: async () => ({ success: false, statusCode: 401, error: 'disabled in test' }) },
      fallback: { generate: async () => ({ success: true, path: 'test-output', provider: 'fallback', durationMs: 1 }) },
    },
  });
  const result = await router.run(['primary', 'fallback'], { input: {}, providerConfig: {}, episodeId: 'test-episode', shotId: 'test-shot' });
  assert.equal(result.provider, 'fallback');
  assert.equal(router.getEpisodeLock('test-episode'), 'fallback');
  assert.equal(global.__phase2DbCalls.length, 3, 'router keeps provider-event and provider-selection database logging');
  assert.equal(networkAttempts, 0, 'tests make no HTTP/HTTPS provider requests');
});
