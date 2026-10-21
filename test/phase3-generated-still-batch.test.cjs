'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const generated = require('../pipeline-updates/phase3-generated-still-batch.cjs');
const cli = require('../scripts/phase3-generated-still-batch.cjs');

const ROOT = path.join(__dirname, '..');
const WELLS = path.join(ROOT, 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const PLANNING = path.join(WELLS, 'phase3-34-still-route-correction-20261021-v1');
const APPLICATION = path.join(WELLS, 'phase3-34-still-route-correction-applied-20261021-v1');
const PNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'phase3-pilot02-approved-still.png'));

function fixture(t, overrides = {}) {
  const episodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-generated-still-'));
  t.after(() => fs.rmSync(episodeRoot, { recursive: true, force: true }));
  const workRoot = path.join(episodeRoot, '.review', 'phase3-generated-still-batches-v1');
  let calls = 0;
  const workflow = generated.createGeneratedStillBatchWorkflow({
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
    episodeRoot, workRoot,
    verifyStage04Fn: () => ({ record: { status: 'PROMOTED' }, recordSha256: 'f'.repeat(64),
      promotedPathCount: 147 }),
    provider: overrides.provider || { async generateStill(input) { calls++; return {
      url: 'https://provider.invalid/output.png', providerRequestId: `provider-${calls}`,
      actualChargeUsd: 0.048, input }; } },
    downloader: async () => ({ bytes: PNG, contentType: 'image/png' }),
    renderer: ({ input, output }) => fs.copyFileSync(input, output),
    now: () => '2026-10-21T12:00:00.000Z',
    modulePath: path.join(ROOT, 'pipeline-updates', 'phase3-generated-still-batch.cjs'),
    cliPath: path.join(ROOT, 'scripts', 'phase3-generated-still-batch.cjs'),
  });
  return { workflow, workRoot, calls: () => calls };
}

test('manifest-driven preflight verifies exact applied candidate and Stage04 without provider calls', t => {
  const f = fixture(t);
  assert.equal(f.workflow.select().providerSubmissions, 0);
  const result = f.workflow.preflight();
  assert.equal(result.status, 'REPLACEMENT_GENERATED_STILL_BATCH_READY_EXECUTION_UNAUTHORIZED');
  assert.equal(result.requestCount, 10);
  assert.equal(result.maximumExposureUsd, 0.48);
  assert.equal(result.stage04.status, 'PROMOTED');
  assert.equal(result.stage04.promotedPathCount, 147);
  assert.equal(f.calls(), 0);
});

test('authorization is immutable and binds exact ten keys, runtime and USD 0.480 ceiling', t => {
  const f = fixture(t); f.workflow.select();
  const created = f.workflow.createAuthorization({ authorizedAt: '2026-10-21T12:00:00.000Z' });
  assert.equal(created.maximumProviderSubmissions, 10);
  assert.equal(created.maximumExposureUsd, 0.48);
  assert.throws(() => f.workflow.createAuthorization({ authorizedAt: '2026-10-21T12:00:00.000Z' }),
    /AUTHORIZATION_ALREADY_EXISTS/u);
});

test('generation submits one exact request, preserves response, validates PNG and prevents reuse', async t => {
  const f = fixture(t); f.workflow.select();
  const auth = f.workflow.createAuthorization({ authorizedAt: '2026-10-21T12:00:00.000Z' }).authorization;
  const key = f.workflow.preflight().requestKeys[0];
  const receipt = await f.workflow.generate({ requestKey: key, authorizationFile: auth.path,
    expectedAuthorizationSha256: auth.sha256 });
  assert.equal(receipt.status, 'GENERATED_PENDING_INSPECTION');
  assert.equal(receipt.raw.width, 1360); assert.equal(receipt.raw.height, 768);
  assert.equal(f.calls(), 1);
  assert.ok(fs.existsSync(path.join(f.workRoot, 'requests', key, 'provider-response.json')));
  await assert.rejects(() => f.workflow.generate({ requestKey: key, authorizationFile: auth.path,
    expectedAuthorizationSha256: auth.sha256 }), /REQUEST_KEY_ALREADY_CONSUMED/u);
  assert.equal(f.calls(), 1);
});

test('manifest order is enforced and no later request is submitted early', async t => {
  const f = fixture(t); f.workflow.select();
  const auth = f.workflow.createAuthorization({ authorizedAt: '2026-10-21T12:00:00.000Z' }).authorization;
  const keys = f.workflow.preflight().requestKeys;
  await assert.rejects(() => f.workflow.generate({ requestKey: keys[1], authorizationFile: auth.path,
    expectedAuthorizationSha256: auth.sha256 }), /SEQUENTIAL_ORDER_REQUIRED/u);
  assert.equal(f.calls(), 0);
});

test('provider failure consumes the request key, records zero retry/fallback and stops reuse', async t => {
  const f = fixture(t, { provider: { async generateStill() { throw new Error('provider-timeout'); } } });
  f.workflow.select();
  const auth = f.workflow.createAuthorization({ authorizedAt: '2026-10-21T12:00:00.000Z' }).authorization;
  const key = f.workflow.preflight().requestKeys[0];
  await assert.rejects(() => f.workflow.generate({ requestKey: key, authorizationFile: auth.path,
    expectedAuthorizationSha256: auth.sha256 }), /provider-timeout/u);
  const rows = generated.readLedgerFile(path.join(f.workRoot, 'request-ledger.jsonl'));
  assert.deepEqual(rows.map(row => row.recordType), ['SUBMISSION_RESERVED', 'SUBMISSION_RESULT']);
  assert.equal(rows[1].status, 'FAILED_REQUEST_KEY_CONSUMED');
  assert.equal(rows[1].retryCount, 0); assert.equal(rows[1].fallbackUsed, false);
});

test('inspection creates a separate review PNG and leaves approval/integration pending', async t => {
  const f = fixture(t); f.workflow.select();
  const auth = f.workflow.createAuthorization({ authorizedAt: '2026-10-21T12:00:00.000Z' }).authorization;
  const key = f.workflow.preflight().requestKeys[0];
  await f.workflow.generate({ requestKey: key, authorizationFile: auth.path,
    expectedAuthorizationSha256: auth.sha256 });
  const report = f.workflow.inspect({ requestKey: key });
  assert.equal(report.status, 'INSPECTION_PASS_PENDING_HUMAN_REVIEW');
  assert.equal(report.integrationAuthorized, false);
  assert.ok(fs.existsSync(path.join(f.workRoot, 'requests', key, 'final-review.png')));
});

test('CLI exposes only bounded selection, preflight, authorization, generation, inspection and status', () => {
  assert.equal(cli.parseArgs(['--select-candidate']).mode, 'select');
  assert.equal(cli.parseArgs(['--preflight']).mode, 'preflight');
  assert.equal(cli.parseArgs(['--status']).mode, 'status');
  assert.throws(() => cli.parseArgs(['--approve']), /USAGE/u);
  assert.throws(() => cli.parseArgs(['--generate', '--request-key', 'x']), /USAGE/u);
});
