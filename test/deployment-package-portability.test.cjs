'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OPERATIONAL_FILES, verifyPackage } = require('../scripts/verify-phase2.3b-sg-package.cjs');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

test('portable Git archive preserves committed bytes and candidate integrity hashes', t => {
  const gitRoot = path.resolve(__dirname, '..');
  const commit = run('git', ['write-tree'], { cwd: gitRoot });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-sg-portable-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const archive = path.join(tempRoot, 'source.tar');
  const snapshot = path.join(tempRoot, 'snapshot');
  fs.mkdirSync(snapshot);

  // Explicit false/LF settings make the archive match committed blobs on any host.
  run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', `--output=${archive}`, commit], { cwd: gitRoot });
  run('tar', ['-xf', archive, '-C', snapshot], { cwd: gitRoot });

  const report = verifyPackage({ root: snapshot, commit, gitRoot });
  assert.equal(report.files.length, OPERATIONAL_FILES.length);
  assert.equal(report.candidateFilesVerified, 12);
  assert.equal(report.pacingFilesVerified, 2);
  assert.ok(report.files.every(file => file.gitBlobSha256 === file.packageSha256));
  for (const relative of OPERATIONAL_FILES.filter(file => file.endsWith('.cjs'))) {
    run(process.execPath, ['--check', path.join(snapshot, relative)], { cwd: gitRoot });
  }
  const trap = path.join(tempRoot, 'block-network.cjs');
  fs.writeFileSync(trap, 'globalThis.fetch = () => { throw new Error("NETWORK_BLOCKED_IN_TEST"); };\n');
  const stageA = path.join(snapshot, 'scripts', 'phase2.3b-sg-stage-a.cjs');
  const dryRun = spawnSync(process.execPath, [stageA, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, EO_SG_CANDIDATE_DIR: path.join(snapshot, CANDIDATE), NODE_OPTIONS: `--require=${trap}` },
  });
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.match(dryRun.stdout, /"status": "PREFLIGHT_PASS"/);
  assert.match(dryRun.stdout, /"providerRequests": 0/);
  assert.match(dryRun.stdout, /"episodeWrites": 0/);
  assert.equal(dryRun.stdout.includes('NETWORK_BLOCKED_IN_TEST'), false);
});

test('Stage B preflight validates staging inputs without audio generation or promotion', t => {
  const gitRoot = path.resolve(__dirname, '..');
  const commit = run('git', ['write-tree'], { cwd: gitRoot });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-sg-stage-b-preflight-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const episode = path.join(tempRoot, 'episode');
  const candidate = path.join(tempRoot, 'candidate');
  const archive = path.join(tempRoot, 'source.tar');
  const snapshot = path.join(tempRoot, 'snapshot');
  fs.mkdirSync(snapshot);
  run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', `--output=${archive}`, commit], { cwd: gitRoot });
  run('tar', ['-xf', archive, '-C', snapshot], { cwd: gitRoot });
  const review = path.join(episode, '.review', 'phase2.3b-sg-portability-0001');
  fs.mkdirSync(review, { recursive: true });
  fs.mkdirSync(candidate, { recursive: true });
  const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const rootFiles = [
    'script.json', 'edit-plan.json', 'edit-plan-validation.json', 'assets/audio/VO_Act3B.mp3',
    'shot-definitions.json', 'production-manifest.json', 'assets/audio/VO_Act4.mp3',
    'evidence-source-manifest.json', 'proof-section-plan.json', '.v3-shadow/timing/fixture/word-timestamps.json',
  ];
  const bytesByPath = new Map();
  for (const relative of rootFiles) {
    const bytes = Buffer.from(`preflight fixture ${relative}`);
    const file = path.join(episode, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    bytesByPath.set(relative, bytes);
  }
  const capturedPaths = {
    script: 'script.json', editPlan: 'edit-plan.json', validation: 'edit-plan-validation.json',
    act3bAudio: 'assets/audio/VO_Act3B.mp3', shotDefinitions: 'shot-definitions.json',
    productionManifest: 'production-manifest.json', wordTimestamps: '.v3-shadow/timing/fixture/word-timestamps.json',
  };
  const sourceFiles = {};
  const liveHashes = {};
  for (const [key, relative] of Object.entries(capturedPaths)) {
    const localFile = `authoritative-${key}.json`;
    sourceFiles[key] = { remotePath: path.join(episode, relative), localFile, size: bytesByPath.get(relative).length, sha256: hash(bytesByPath.get(relative)) };
    liveHashes[relative] = hash(bytesByPath.get(relative));
    liveHashes[localFile] = hash(bytesByPath.get(relative));
  }
  const sourceManifestBytes = json({ files: sourceFiles });
  fs.writeFileSync(path.join(candidate, 'source-hash-manifest.json'), sourceManifestBytes);
  fs.writeFileSync(path.join(candidate, 'candidate-package-sha256.json'), json({ files: {
    'source-hash-manifest.json': { bytes: sourceManifestBytes.length, sha256: hash(sourceManifestBytes) },
  } }));
  const audio3b = bytesByPath.get('assets/audio/VO_Act3B.mp3');
  const audio4 = bytesByPath.get('assets/audio/VO_Act4.mp3');
  fs.mkdirSync(path.join(review, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(review, 'audio', 'VO_Act3B.mp3'), audio3b);
  fs.writeFileSync(path.join(review, 'audio', 'VO_Act4.mp3'), audio4);
  const runId = 'portability-0001';
  fs.writeFileSync(path.join(review, 'run-status.json'), json({ state: 'SUCCESS', completedActs: ['act3b', 'act4'], liveHashes }));
  fs.writeFileSync(path.join(review, 'request-ledger.json'), json({ attempts: [
    { actKey: 'act3b', textSha256: 'ff9ab4bbe43c3f25844b6e6231abaa462cde3692dcd9e57f4c319dda168a0e49', status: 'COMPLETE', audioSha256: hash(audio3b) },
    { actKey: 'act4', textSha256: '26d10ba68ea1aa328bc26160e4f795545dc0f02fabbe3717e57187b161be8338', status: 'COMPLETE', audioSha256: hash(audio4) },
  ] }));
  const backups = rootFiles.map(relative => ({ relativePath: relative, existed: true, sha256: hash(bytesByPath.get(relative)), bytes: bytesByPath.get(relative).length }));
  fs.writeFileSync(path.join(review, 'backup-manifest.json'), json({ files: backups }));

  const stageB = path.join(snapshot, 'scripts', 'phase2.3b-sg-stage-b.cjs');
  const result = spawnSync(process.execPath, [stageB, '--preflight-only'], {
    encoding: 'utf8',
    env: { ...process.env, EO_VOICE_RUN_ID: runId, EO_VOICE_EPISODE_QUIESCED: 'I_CONFIRMED', EO_SG_EPISODE_DIR: episode, EO_SG_CANDIDATE_DIR: candidate },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"status": "PREFLIGHT_PASS"/);
  assert.match(result.stdout, /"audioGeneration": false/);
  assert.match(result.stdout, /"promotion": false/);
  assert.equal(fs.existsSync(path.join(path.dirname(episode), '.EmpireOmitted_V3_SHADOW_WELLSFARGO-candidate-portability-0001')), false);
  assert.equal(fs.readFileSync(path.join(episode, 'script.json'), 'utf8'), bytesByPath.get('script.json').toString());
  assert.equal(run('git', ['write-tree'], { cwd: gitRoot }), commit);
});

const CANDIDATE = 'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate';
