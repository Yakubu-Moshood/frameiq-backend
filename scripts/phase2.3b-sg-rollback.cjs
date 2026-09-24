'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = '/data/episodes/EmpireOmitted_V3_SHADOW_WELLSFARGO';
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function main() {
  const runId = process.env.EO_VOICE_RUN_ID;
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/.test(runId)) throw new Error('RUN_ID_INVALID');
  if (process.env.EO_VOICE_EPISODE_QUIESCED !== 'I_CONFIRMED') throw new Error('EPISODE_QUIESCENCE_CONFIRMATION_REQUIRED');
  const reportPath = path.join(ROOT, '.review', `phase2.3b-sg-${runId}`, 'stage-b-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.status !== 'PROMOTED') throw new Error('NO_PROMOTED_CANDIDATE_TO_ROLL_BACK');
  const review = path.join(ROOT, '.review', `phase2.3b-sg-${runId}`);
  const stage = path.join(path.dirname(ROOT), `.EmpireOmitted_V3_SHADOW_WELLSFARGO-candidate-${runId}`);
  if (!fs.existsSync(stage)) throw new Error('PREVIOUS_EPISODE_TREE_MISSING');
  for (const [relative, expected] of Object.entries(report.outputs)) {
    const file = path.join(ROOT, relative);
    if (!fs.existsSync(file) || shaFile(file) !== expected) throw new Error(`ACTIVE_ARTIFACT_CHANGED_SINCE_PROMOTION:${relative}`);
  }
  execFileSync('python3', ['/app/scripts/phase2.3b-sg-atomic-exchange.py', ROOT, stage], { stdio: 'ignore' });
  const done = { schemaVersion: 'phase2.3b-sg-rollback/1.0.0', runId, status: 'ROLLED_BACK', rolledBackAt: new Date().toISOString(), restoredTree: ROOT, retainedCandidateTree: stage, priorBackupManifest: path.join(stage, '.review', `phase2.3b-sg-${runId}`, 'backup-manifest.json') };
  fs.writeFileSync(path.join(review, 'rollback-report.json'), `${JSON.stringify(done, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(done, null, 2));
}
try { main(); } catch (error) { console.error(`ROLLBACK_REFUSED:${String(error.message || 'failure').split(':')[0]}`); process.exitCode = 1; }
