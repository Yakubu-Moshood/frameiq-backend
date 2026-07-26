#!/usr/bin/env node
'use strict';

/**
 * Staging-only boot guard.
 *
 * This runs before server.js in Railway's "staging" environment. It refuses to
 * claim a non-empty, unmarked /data volume, which is the main guard against
 * accidentally attaching production storage. On an empty volume it creates a
 * staging marker and the standard directory layout.
 *
 * STAGING_BOOTSTRAP=true performs only environment/volume preparation so the
 * service can start while an operator uploads runtime-only pipeline files.
 * Set it to false and redeploy before calling the staging environment ready.
 */

const fs = require('fs');
const path = require('path');

const PREFIX = '[staging-preflight]';
const EXPECTED_ENVIRONMENT = 'staging';
const DEFAULT_DATA_ROOT = '/data';
const MARKER_FILE = '.fraymiq-environment';
const REQUIRED_DIRS = ['pipeline', 'pipeline/assets', 'episodes', 'public', 'db'];
const REQUIRED_PIPELINE_FILES = [
  'pipeline.config.json',
  'config-reader.cjs',
  'surface-script-writer.cjs',
  'surface-vo-generator.cjs',
  'surface-image-generator.cjs',
  'surface-animator.cjs',
  'append-outro.cjs',
];
const REQUIRED_PUBLIC_FILES = [
  'background_music.mp3',
  'outro_EmpireOmitted.mp4',
];

function fail(message, details = []) {
  console.error(`${PREFIX} FAIL: ${message}`);
  for (const detail of details) console.error(`${PREFIX}   - ${detail}`);
  process.exitCode = 1;
}

function isTruthy(value) {
  return String(value || '').toLowerCase() === 'true';
}

function dataRootFromArgs() {
  const arg = process.argv.find(value => value.startsWith('--data-root='));
  return arg ? path.resolve(arg.slice('--data-root='.length)) : DEFAULT_DATA_ROOT;
}

function missingEnv(names) {
  return names.filter(name => !process.env[name] || !process.env[name].trim());
}

function collectStringValues(value, result = []) {
  if (typeof value === 'string') {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, result);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, result);
  }
  return result;
}

function validateEnvironment(dataRoot) {
  const localOverride = dataRoot !== DEFAULT_DATA_ROOT;
  const appEnvironment = process.env.FRAYMIQ_ENVIRONMENT;
  const railwayEnvironment = process.env.RAILWAY_ENVIRONMENT_NAME;

  if (appEnvironment !== EXPECTED_ENVIRONMENT) {
    fail(`FRAYMIQ_ENVIRONMENT must be "${EXPECTED_ENVIRONMENT}".`, [
      `received: ${appEnvironment || '(unset)'}`,
    ]);
  }

  if (!localOverride && railwayEnvironment !== EXPECTED_ENVIRONMENT) {
    fail(`Refusing to run the staging start command outside Railway environment "${EXPECTED_ENVIRONMENT}".`, [
      `RAILWAY_ENVIRONMENT_NAME=${railwayEnvironment || '(unset)'}`,
    ]);
  }

  if (!localOverride && process.env.RAILWAY_VOLUME_MOUNT_PATH !== DEFAULT_DATA_ROOT) {
    fail('The Railway Volume is not mounted at the required staging path.', [
      `RAILWAY_VOLUME_MOUNT_PATH=${process.env.RAILWAY_VOLUME_MOUNT_PATH || '(unset)'}`,
      `expected: ${DEFAULT_DATA_ROOT}`,
    ]);
  }

  const baseMissing = missingEnv(['JWT_SECRET', 'FRONTEND_URL']);
  if (baseMissing.length) {
    fail('Required application variables are missing.', baseMissing);
  }

  if (!isTruthy(process.env.TEST_MODE)) {
    const paidMissing = missingEnv([
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'FAL_KEY',
      'ELEVENLABS_API_KEY',
      'ELEVENLABS_VOICE_ID',
    ]);
    if (paidMissing.length) {
      fail('A real pipeline run requires paid-provider variables.', paidMissing);
    }
  }

  if (!process.env.BACKEND_URL) {
    console.warn(`${PREFIX} WARN: BACKEND_URL is unset; preview download URLs may be relative.`);
  }
}

function prepareAndValidateVolume(dataRoot) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const markerPath = path.join(dataRoot, MARKER_FILE);

  if (!fs.existsSync(markerPath)) {
    const existingEntries = fs.readdirSync(dataRoot)
      .filter(entry => entry !== 'lost+found');

    if (existingEntries.length > 0) {
      fail('Refusing to mark a non-empty, unclassified volume as staging.', [
        `data root: ${dataRoot}`,
        `existing entries: ${existingEntries.join(', ')}`,
        'Attach a new empty staging-only Volume; do not reuse production storage.',
      ]);
      return;
    }

    fs.writeFileSync(markerPath, `${EXPECTED_ENVIRONMENT}\n`, { flag: 'wx' });
    console.log(`${PREFIX} Initialized empty staging volume marker at ${markerPath}`);
  }

  const marker = fs.readFileSync(markerPath, 'utf8').trim();
  if (marker !== EXPECTED_ENVIRONMENT) {
    fail('Volume environment marker does not identify staging.', [
      `marker: ${marker || '(empty)'}`,
      `expected: ${EXPECTED_ENVIRONMENT}`,
    ]);
    return;
  }

  for (const relativeDir of REQUIRED_DIRS) {
    fs.mkdirSync(path.join(dataRoot, relativeDir), { recursive: true });
  }
  console.log(`${PREFIX} Staging-only volume marker and directory layout are valid.`);
}

function validateRuntimeFiles(dataRoot) {
  const required = [
    ...REQUIRED_PIPELINE_FILES.map(file => path.join(dataRoot, 'pipeline', file)),
    ...REQUIRED_PUBLIC_FILES.map(file => path.join(dataRoot, 'public', file)),
  ];
  const missing = required.filter(file => !fs.existsSync(file));
  if (missing.length) {
    fail('Runtime-only staging files are missing.', missing);
    return;
  }

  const configuredPath = process.env.PIPELINE_CONFIG_PATH
    || path.join(dataRoot, 'pipeline', 'pipeline.config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configuredPath, 'utf8'));
  } catch (error) {
    fail(`Could not parse pipeline config at ${configuredPath}.`, [error.message]);
    return;
  }

  if (!config.channels || !config.channels.EmpireOmitted) {
    fail('pipeline.config.json has no channels.EmpireOmitted entry.');
  }

  const strings = collectStringValues(config);
  const windowsPaths = strings.filter(value => /^[A-Za-z]:[\\/]/.test(value));
  if (windowsPaths.length) {
    fail('pipeline.config.json contains Windows-only paths that cannot resolve on Railway.', windowsPaths);
  }

  const referencedDataPaths = [...new Set(strings.filter(value => value.startsWith(`${dataRoot}/`)))];
  const missingReferences = referencedDataPaths.filter(value => !fs.existsSync(value));
  if (missingReferences.length) {
    fail('pipeline.config.json references missing staging files/directories.', missingReferences);
  }

  const registryPath = path.join(__dirname, '..', 'src', 'data', 'channelRegistry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const registryStrings = collectStringValues(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
      const registryWindowsPaths = registryStrings.filter(value => /^[A-Za-z]:[\\/]/.test(value));
      if (registryWindowsPaths.length) {
        console.warn(
          `${PREFIX} WARN: src/data/channelRegistry.json still has Windows-only paths. ` +
          'The live jobs/runner.js path does not consume this registry, but standalone adapter tooling will not work on Railway.'
        );
      }
    } catch (error) {
      console.warn(`${PREFIX} WARN: could not inspect channelRegistry.json: ${error.message}`);
    }
  }

  console.log(`${PREFIX} Runtime pipeline configuration and required Empire Omitted assets are present.`);
}

function main() {
  const dataRoot = dataRootFromArgs();
  const bootstrap = isTruthy(process.env.STAGING_BOOTSTRAP);

  console.log(`${PREFIX} Starting checks (data root: ${dataRoot}, bootstrap: ${bootstrap})`);
  validateEnvironment(dataRoot);
  if (process.exitCode) return;

  try {
    prepareAndValidateVolume(dataRoot);
  } catch (error) {
    fail('Volume validation failed.', [error.message]);
  }
  if (process.exitCode) return;

  if (bootstrap) {
    console.warn(
      `${PREFIX} BOOTSTRAP MODE: runtime-only files were not validated. ` +
      'Set STAGING_BOOTSTRAP=false and redeploy before using this environment for verification.'
    );
    return;
  }

  validateRuntimeFiles(dataRoot);
  if (!process.exitCode) console.log(`${PREFIX} PASS: staging is ready to start.`);
}

main();
