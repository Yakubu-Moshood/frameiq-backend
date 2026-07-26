#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const preflight = path.join(__dirname, 'staging-preflight.cjs');
const baseEnv = {
  ...process.env,
  FRAYMIQ_ENVIRONMENT: 'staging',
  JWT_SECRET: 'test-only-secret',
  FRONTEND_URL: 'https://staging.example.test',
  BACKEND_URL: 'https://api-staging.example.test',
  TEST_MODE: 'true',
};

function run(dataRoot, overrides = {}) {
  return spawnSync(process.execPath, [preflight, `--data-root=${dataRoot}`], {
    cwd: repoRoot,
    env: { ...baseEnv, ...overrides },
    encoding: 'utf8',
  });
}

function writeFixture(root, relativePath, content = '') {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function testBootstrapInitializesEmptyVolume() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frameiq-staging-empty-'));
  const result = run(root, { STAGING_BOOTSTRAP: 'true' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(
    fs.readFileSync(path.join(root, '.fraymiq-environment'), 'utf8').trim(),
    'staging'
  );
}

function testNonEmptyUnmarkedVolumeIsRejected() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frameiq-staging-dirty-'));
  writeFixture(root, 'frameiq.db', 'do-not-claim');
  const result = run(root, { STAGING_BOOTSTRAP: 'true' });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to mark a non-empty, unclassified volume/);
}

function testReadyVolumePassesFullValidation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frameiq-staging-ready-'));
  let result = run(root, { STAGING_BOOTSTRAP: 'true' });
  assert.strictEqual(result.status, 0, result.stderr);

  const pipelineFiles = [
    'pipeline/config-reader.cjs',
    'pipeline/surface-script-writer.cjs',
    'pipeline/surface-vo-generator.cjs',
    'pipeline/surface-image-generator.cjs',
    'pipeline/surface-animator.cjs',
    'pipeline/append-outro.cjs',
  ];
  for (const file of pipelineFiles) writeFixture(root, file);
  writeFixture(root, 'public/background_music.mp3');
  writeFixture(root, 'public/outro_EmpireOmitted.mp4');
  writeFixture(root, 'pipeline/assets/EmpireOmitted_Watermark_Transparent.png');
  writeFixture(
    root,
    'pipeline/pipeline.config.json',
    JSON.stringify({
      channels: {
        EmpireOmitted: {
          paths: {
            pipelineRoot: path.join(root, 'pipeline'),
            publicDir: path.join(root, 'public'),
            watermarkFile: path.join(
              root,
              'pipeline/assets/EmpireOmitted_Watermark_Transparent.png'
            ),
          },
        },
      },
    })
  );

  result = run(root, {
    STAGING_BOOTSTRAP: 'false',
    PIPELINE_CONFIG_PATH: path.join(root, 'pipeline/pipeline.config.json'),
  });
  assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: staging is ready to start/);
}

testBootstrapInitializesEmptyVolume();
testNonEmptyUnmarkedVolumeIsRejected();
testReadyVolumePassesFullValidation();
console.log('staging-preflight tests passed');
