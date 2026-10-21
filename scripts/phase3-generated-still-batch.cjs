'use strict';

const path = require('node:path');
const activation = require('./phase2.3b-p-activate.cjs');
const generated = require('../pipeline-updates/phase3-generated-still-batch.cjs');

const ROOT = path.join(__dirname, '..');
const WELLS = path.join(ROOT, 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const PLANNING = path.join(WELLS, 'phase3-34-still-route-correction-20261021-v1');
const APPLICATION = path.join(WELLS, 'phase3-34-still-route-correction-applied-20261021-v1');
const WORK_ROOT = path.join(activation.ROOT, '.review', 'phase3-generated-still-batches-v1');
const WORKFLOW = generated.createGeneratedStillBatchWorkflow({
  manifestFile: path.join(PLANNING, 'provider-batches', 'replacement-generated-stills-batch-1.v1.json'),
  expectedManifestSha256: 'bda967e41208c317e189691606d4763d33e70950af573a0a7d83b3a1bec1401b',
  promptContractFile: path.join(PLANNING, 'prompt-and-negative-contracts.v1.json'),
  expectedPromptContractSha256: '8ecb834a08acf2012f4555f371e762ee8f181e0a285a871d7b168e2251d367fb',
  planningIndexFile: path.join(PLANNING, 'package-index.v1.json'),
  expectedPlanningIndexSha256: '5cdee80e0762b7cb559def2e8d888d1b10d457817cb9bb6fdf14296faa6e6036',
  applicationIndexFile: path.join(APPLICATION, 'package-index.v1.json'),
  expectedApplicationIndexSha256: 'a5fde14c1547bd1c35858891576e9060ccb3b299c0d6a3a39a16ad3a20592139',
  candidateDirectory: path.join(APPLICATION, 'child-candidate'),
  expectedCandidateIndexSha256: '865d1535a9498765c5a4dd3d948e14d6dbb93142692b51640a506afffc8596b9',
  approvalFile: path.join(APPLICATION, 'detached-route-correction-application-approval.v1.json'),
  expectedApprovalSha256: 'd61a0a1c8fcc958b246e97d04a61892fbf98d7a5304413dd808c6756056cc977',
  expectedCommit: '1ecbaf5a0777948546f2fa3c0ce4f471d46cdd6f',
  expectedAmendmentSha256: '6695bd45e055a6d0c91c3f96291901affbad99fd37e8b98182c2362a8043d973',
  expectedManifestDependencyCandidateIndexSha256: 'c50dd2d054c430f0daf5748de9a6d3e5c946cef1e8b4fbe57a4f986f6a48dac4',
  episodeRoot: activation.ROOT, workRoot: WORK_ROOT, activationRunner: activation,
  legacyLedgerFiles: [path.join(activation.ROOT, '.review', 'phase3-production-batch-v1', 'request-ledger.jsonl')],
});

function pairs(args) {
  const out = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] == null || out[args[i]] != null)
      throw new Error('PHASE3_GENERATED_STILL_USAGE');
    out[args[i]] = args[i + 1];
  }
  return out;
}
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--status') return { mode: 'status' };
  if (args.length === 1 && args[0] === '--select-candidate') return { mode: 'select' };
  if (args.length === 1 && args[0] === '--preflight') return { mode: 'preflight' };
  if (args[0] === '--create-authorization') {
    const p = pairs(args); if (args.length !== 3 || !p['--authorized-at']) throw new Error('PHASE3_GENERATED_STILL_USAGE');
    return { mode: 'create-authorization', authorizedAt: p['--authorized-at'] };
  }
  if (args[0] === '--generate') {
    const p = pairs(args);
    if (args.length !== 7 || !/^[a-f0-9]{64}$/u.test(p['--request-key'] || '') || !p['--authorization-file']
      || !/^[a-f0-9]{64}$/u.test(p['--expected-authorization-sha256'] || ''))
      throw new Error('PHASE3_GENERATED_STILL_USAGE');
    return { mode: 'generate', requestKey: p['--request-key'], authorizationFile: p['--authorization-file'],
      expectedAuthorizationSha256: p['--expected-authorization-sha256'] };
  }
  if (args[0] === '--inspect') {
    const p = pairs(args); if (args.length !== 3 || !/^[a-f0-9]{64}$/u.test(p['--request-key'] || ''))
      throw new Error('PHASE3_GENERATED_STILL_USAGE');
    return { mode: 'inspect', requestKey: p['--request-key'] };
  }
  throw new Error('PHASE3_GENERATED_STILL_USAGE');
}
async function main(args = process.argv.slice(2), workflow = WORKFLOW) {
  const p = parseArgs(args); let result;
  if (p.mode === 'status') result = workflow.status();
  else if (p.mode === 'select') result = workflow.select();
  else if (p.mode === 'preflight') result = workflow.preflight();
  else if (p.mode === 'create-authorization') result = workflow.createAuthorization(p);
  else if (p.mode === 'generate') result = await workflow.generate(p);
  else result = workflow.inspect(p);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result;
}
if (require.main === module) main().catch(error => {
  process.stderr.write(`PHASE3_GENERATED_STILL_BATCH_FAILED:${error.message}\n`); process.exitCode = 1;
});
module.exports = { ROOT, WELLS, PLANNING, APPLICATION, WORK_ROOT, WORKFLOW, parseArgs, main };
