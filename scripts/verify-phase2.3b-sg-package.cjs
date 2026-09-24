'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const OPERATIONAL_FILES = [
  'pipeline-updates/act-voice-generator.cjs',
  'test/act-voice-generator.test.cjs',
  'test/phase2.3b-sg-stage-a-accounting.test.cjs',
  'test/phase2.3b-sg-zero-call-recovery.test.cjs',
  'test/deployment-package-portability.test.cjs',
  'test/paced-narration-generator.test.cjs',
  'pipeline-updates/paced-narration-generator.cjs',
  'scripts/phase2.3b-p-run.cjs',
  'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-p-review/pacing-run-spec.json',
  'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-p-review/pacing-plan-baseline.json',
  'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-p-review/pacing-package-sha256.json',
  'scripts/phase2.3b-sg-stage-a.cjs',
  'scripts/phase2.3b-sg-recover-zero-call-run.cjs',
  'scripts/phase2.3b-sg-stage-b.cjs',
  'scripts/phase2.3b-sg-rollback.cjs',
  'scripts/phase2.3b-sg-atomic-exchange.py',
  'scripts/verify-phase2.3b-sg-package.cjs',
  'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate/narration-texts.json',
  'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate/source-hash-manifest.json',
  'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate/candidate-package-sha256.json',
];
const CANDIDATE = 'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-sv-candidate';
const PACING_PACKAGE = 'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-p-review';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function gitBlob(commit, gitPath, cwd) {
  const result = spawnSync('git', ['cat-file', 'blob', `${commit}:${gitPath}`], { cwd, encoding: null, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`GIT_OBJECT_MISSING:${gitPath}`);
  return result.stdout;
}

function verifyPackage({ root, commit, gitRoot = process.cwd() }) {
  const snapshotRoot = path.resolve(root);
  const gitDirectory = path.resolve(gitRoot);
  const files = [];
  for (const gitPath of OPERATIONAL_FILES) {
    const packaged = fs.readFileSync(path.join(snapshotRoot, gitPath));
    const committed = gitBlob(commit, gitPath, gitDirectory);
    if (!packaged.equals(committed)) throw new Error(`COMMITTED_BYTES_MISMATCH:${gitPath}`);
    files.push({ path: gitPath, gitBlobSha256: sha256(committed), packageSha256: sha256(packaged), bytes: packaged.length });
  }

  const candidateRoot = path.join(snapshotRoot, CANDIDATE);
  const packageManifest = JSON.parse(fs.readFileSync(path.join(candidateRoot, 'candidate-package-sha256.json'), 'utf8'));
  for (const [relative, expected] of Object.entries(packageManifest.files || {})) {
    const file = path.resolve(candidateRoot, relative);
    if (!file.startsWith(`${path.resolve(candidateRoot)}${path.sep}`)) throw new Error(`CANDIDATE_PACKAGE_PATH_INVALID:${relative}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`CANDIDATE_PACKAGE_HASH_MISMATCH:${relative}`);
  }
  const pacingRoot = path.join(snapshotRoot, PACING_PACKAGE);
  const pacingManifest = JSON.parse(fs.readFileSync(path.join(pacingRoot, 'pacing-package-sha256.json'), 'utf8'));
  for (const [relative, expected] of Object.entries(pacingManifest.files || {})) {
    const file = path.resolve(pacingRoot, relative);
    if (!file.startsWith(path.resolve(pacingRoot) + path.sep)) throw new Error('PACING_PACKAGE_PATH_INVALID:' + relative);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error('PACING_PACKAGE_HASH_MISMATCH:' + relative);
  }
  return { commit, files, candidateFilesVerified: Object.keys(packageManifest.files || {}).length, pacingFilesVerified: Object.keys(pacingManifest.files || {}).length };
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') values.root = args[++index];
    else if (args[index] === '--commit') values.commit = args[++index];
    else throw new Error(`UNKNOWN_ARGUMENT:${args[index]}`);
  }
  if (!values.root || !values.commit) throw new Error('USAGE: node scripts/verify-phase2.3b-sg-package.cjs --root <snapshot-directory> --commit <git-commit>');
  return values;
}

if (require.main === module) {
  try { console.log(JSON.stringify(verifyPackage(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`PACKAGE_VERIFICATION_FAILED:${String(error.message || error)}`); process.exitCode = 1; }
}

module.exports = { OPERATIONAL_FILES, verifyPackage };
