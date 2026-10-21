'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const mediaExecution = require('./phase3-media-execution.cjs');
const legacy = require('./phase3-production-batch.cjs');

const AUTH_SCHEMA = 'phase3-generated-still-batch-execution-authorization/1.0.0';
const LEDGER_SCHEMA = 'phase3-generated-still-batch-request-ledger/1.0.0';
const SELECTION_SCHEMA = 'phase3-generated-still-batch-candidate-selection/1.0.0';
const UNIT_MAXIMUM_USD = 0.048;
const MAX_BATCH_REQUESTS = 10;

function fail(value, code) { if (!value) throw new Error(code); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function atomicWrite(file, bytes, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  fsImpl.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
  try { fsImpl.renameSync(temp, file); } catch (error) { try { fsImpl.unlinkSync(temp); } catch (_) {} throw error; }
}
function writeImmutableJson(file, value, fsImpl = fs) {
  const bytes = jsonBytes(value);
  if (fsImpl.existsSync(file)) {
    fail(sha(fsImpl.readFileSync(file)) === sha(bytes), 'PHASE3_GENERATED_STILL_IMMUTABLE_CONFLICT');
  } else atomicWrite(file, bytes, fsImpl);
  return { path: file, bytes: bytes.length, sha256: sha(bytes) };
}
function readJson(file, fsImpl = fs, code = 'PHASE3_GENERATED_STILL_JSON_INVALID') {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { throw new Error(code); }
}
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && value === value.replaceAll('\\', '/')
    && !path.posix.isAbsolute(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function verifyIndexFile(indexPath, root, expectedSha256, fsImpl = fs) {
  const bytes = fsImpl.readFileSync(indexPath);
  fail(sha(bytes) === expectedSha256, 'PHASE3_GENERATED_STILL_INDEX_HASH_MISMATCH');
  const index = JSON.parse(bytes.toString('utf8'));
  const rows = Array.isArray(index.files) ? index.files
    : Object.entries(index.files || {}).map(([filePath, record]) => ({ path: filePath, ...record }));
  fail(rows.length === index.fileCount && rows.length > 0, 'PHASE3_GENERATED_STILL_INDEX_COUNT_INVALID');
  const seen = new Set();
  for (const row of rows) {
    fail(safeRelative(row.path) && !seen.has(row.path) && /^[a-f0-9]{64}$/u.test(row.sha256 || ''),
      'PHASE3_GENERATED_STILL_INDEX_ENTRY_INVALID');
    seen.add(row.path);
    const file = path.resolve(root, ...row.path.split('/'));
    fail(file.startsWith(`${path.resolve(root)}${path.sep}`), 'PHASE3_GENERATED_STILL_INDEX_PATH_INVALID');
    const item = fsImpl.readFileSync(file);
    fail(item.length === row.bytes && sha(item) === row.sha256,
      `PHASE3_GENERATED_STILL_INDEX_FILE_MISMATCH:${row.path}`);
  }
  return { index, sha256: expectedSha256, rows };
}
function verifyManifest({ manifestFile, expectedManifestSha256, promptContractFile,
  expectedPromptContractSha256, fsImpl = fs } = {}) {
  const manifestBytes = fsImpl.readFileSync(manifestFile);
  fail(sha(manifestBytes) === expectedManifestSha256, 'PHASE3_GENERATED_STILL_MANIFEST_HASH_MISMATCH');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  fail(manifest.schemaVersion === 'phase3-bounded-non-authorizing-generated-still-batch/1.0.0'
    && manifest.status === 'PROPOSED_NON_AUTHORIZING' && Array.isArray(manifest.entries)
    && manifest.entries.length === manifest.requestCount && manifest.requestCount > 0
    && manifest.requestCount <= MAX_BATCH_REQUESTS && manifest.endpoint === 'blackforestlabs/flux-3/text-to-image'
    && manifest.parameters?.resolution === '1k' && manifest.parameters?.aspectRatio === '16:9'
    && manifest.parameters?.outputFormat === 'PNG' && manifest.parameters?.imagesPerRequest === 1
    && manifest.parameters?.promptExpansion === false && manifest.retries === 0
    && manifest.fallback === false && manifest.maximumExposureUsd === manifest.requestCount * UNIT_MAXIMUM_USD,
  'PHASE3_GENERATED_STILL_MANIFEST_CONTRACT_INVALID');
  const contractBytes = fsImpl.readFileSync(promptContractFile);
  fail(sha(contractBytes) === expectedPromptContractSha256,
    'PHASE3_GENERATED_STILL_PROMPT_CONTRACT_HASH_MISMATCH');
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const rows = contract.rows || contract.entries;
  fail(Array.isArray(rows), 'PHASE3_GENERATED_STILL_PROMPT_CONTRACT_INVALID');
  const byBeat = new Map(rows.map(row => [row.beatId, row]));
  const keys = new Set(), beats = new Set();
  const jobs = manifest.entries.map(entry => {
    const row = byBeat.get(entry.beatId);
    fail(row && !keys.has(entry.requestKey) && !beats.has(entry.beatId)
      && /^[a-f0-9]{64}$/u.test(entry.requestKey || '')
      && entry.operation === 'GENERATE_REPLACEMENT_FINAL_STILL'
      && entry.expectedOutputContract?.mediaType === 'image/png'
      && entry.expectedOutputContract?.resolution === '1k'
      && entry.expectedOutputContract?.aspectRatio === '16:9'
      && entry.expectedOutputContract?.imageCount === 1
      && entry.expectedOutputContract?.productionPathInstallationAuthorized === false
      && safeRelative(entry.expectedOutputContract?.isolatedReviewRelativePath),
    'PHASE3_GENERATED_STILL_MANIFEST_ENTRY_INVALID');
    fail(sha(Buffer.from(row.positivePrompt, 'utf8')) === entry.positivePromptSha256
      && sha(Buffer.from(row.negativeInstructions, 'utf8')) === entry.negativeInstructionsSha256
      && row.positivePromptSha256 === entry.positivePromptSha256
      && row.negativeInstructionsSha256 === entry.negativeInstructionsSha256
      && row.requestKey === entry.requestKey
      && Boolean(row.twoStageRoute?.required) === Boolean(entry.twoStageTextRouteRequired),
    'PHASE3_GENERATED_STILL_PROMPT_BINDING_INVALID');
    keys.add(entry.requestKey); beats.add(entry.beatId);
    const serializedPrompt = `${row.positivePrompt}\n\nMandatory negative instructions:\n${row.negativeInstructions}`;
    return { beatId: entry.beatId, requestKey: entry.requestKey,
      positivePrompt: row.positivePrompt, positivePromptSha256: entry.positivePromptSha256,
      negativeInstructions: row.negativeInstructions,
      negativeInstructionsSha256: entry.negativeInstructionsSha256,
      serializedPrompt, serializedPromptSha256: sha(Buffer.from(serializedPrompt, 'utf8')),
      dependencyHashes: entry.dependencyHashes, outputPath: entry.expectedOutputContract.isolatedReviewRelativePath,
      twoStageRoute: row.twoStageRoute, maximumCostUsd: UNIT_MAXIMUM_USD };
  });
  return { manifest, manifestBytes, manifestSha256: expectedManifestSha256,
    promptContractSha256: expectedPromptContractSha256, jobs };
}
function ledgerPath(workRoot) { return path.join(workRoot, 'request-ledger.jsonl'); }
function readLedgerFile(file, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return [];
  let previous = null;
  return fsImpl.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => {
    const row = JSON.parse(line), entry = { ...row }; delete entry.entrySha256;
    fail(row.schemaVersion === LEDGER_SCHEMA && row.previousEntrySha256 === previous
      && row.entrySha256 === sha(Buffer.from(canonicalJson(entry), 'utf8')),
    'PHASE3_GENERATED_STILL_LEDGER_INVALID');
    previous = row.entrySha256; return row;
  });
}
function appendLedger(workRoot, record, fsImpl = fs) {
  const file = ledgerPath(workRoot), rows = readLedgerFile(file, fsImpl), previous = rows.at(-1)?.entrySha256 || null;
  const base = { schemaVersion: LEDGER_SCHEMA, previousEntrySha256: previous, ...record };
  const row = { ...base, entrySha256: sha(Buffer.from(canonicalJson(base), 'utf8')) };
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  return row;
}
function pngInfo(bytes) { return legacy.pngInfo(bytes); }
function requestDirectory(workRoot, key) { return path.join(workRoot, 'requests', key); }
function runtimeHashes(modulePath, cliPath, fsImpl = fs) {
  return { moduleSha256: sha(fsImpl.readFileSync(modulePath)), cliSha256: sha(fsImpl.readFileSync(cliPath)) };
}

function createGeneratedStillBatchWorkflow(options = {}) {
  const { manifestFile, expectedManifestSha256, promptContractFile, expectedPromptContractSha256,
    planningIndexFile, expectedPlanningIndexSha256, applicationIndexFile, expectedApplicationIndexSha256,
    candidateDirectory, expectedCandidateIndexSha256, approvalFile, expectedApprovalSha256,
    expectedCommit, expectedAmendmentSha256, episodeRoot, workRoot,
    expectedManifestDependencyCandidateIndexSha256,
    legacyLedgerFiles = [], fsImpl = fs, activationRunner,
    verifyStage04Fn = mediaExecution.verifyStage04, provider = legacy.createFalProvider(),
    downloader = async url => legacy.download(url), now = () => new Date().toISOString(),
    modulePath = __filename, cliPath = path.resolve(__dirname, '..', 'scripts', 'phase3-generated-still-batch.cjs'),
    renderer = null, exec = spawnSync } = options;
  function authoritative() {
    fail(path.resolve(workRoot) === path.resolve(episodeRoot, '.review', 'phase3-generated-still-batches-v1'),
      'PHASE3_GENERATED_STILL_WORK_ROOT_FORBIDDEN');
    const manifestState = verifyManifest({ manifestFile, expectedManifestSha256, promptContractFile,
      expectedPromptContractSha256, fsImpl });
    const planning = verifyIndexFile(planningIndexFile, path.dirname(planningIndexFile),
      expectedPlanningIndexSha256, fsImpl);
    const application = verifyIndexFile(applicationIndexFile, path.dirname(applicationIndexFile),
      expectedApplicationIndexSha256, fsImpl);
    const candidateIndex = path.join(candidateDirectory, 'candidate-package-sha256.json');
    const candidate = verifyIndexFile(candidateIndex, candidateDirectory, expectedCandidateIndexSha256, fsImpl);
    const approvalBytes = fsImpl.readFileSync(approvalFile);
    fail(sha(approvalBytes) === expectedApprovalSha256, 'PHASE3_GENERATED_STILL_APPROVAL_HASH_MISMATCH');
    const approval = JSON.parse(approvalBytes.toString('utf8'));
    fail(approval.approvedBy === 'Yakubu Moshood' && approval.bindings?.routePackageIndexSha256
      === expectedPlanningIndexSha256 && approval.bindings?.amendmentSha256 === expectedAmendmentSha256
      && approval.bindings?.promptContractsSha256 === expectedPromptContractSha256
      && approval.bindings?.providerBatchManifestSha256s?.includes(expectedManifestSha256),
    'PHASE3_GENERATED_STILL_APPROVAL_BINDING_INVALID');
    fail(application.index.approvalSha256 === expectedApprovalSha256
      && application.index.amendmentSha256 === expectedAmendmentSha256
      && application.index.childCandidateIndexSha256 === expectedCandidateIndexSha256
      && application.index.approvedRoutePackageIndexSha256 === expectedPlanningIndexSha256,
    'PHASE3_GENERATED_STILL_APPLICATION_BINDING_INVALID');
    for (const job of manifestState.jobs) fail(job.dependencyHashes?.amendmentSha256 === expectedAmendmentSha256
      && job.dependencyHashes?.candidateIndexSha256 === expectedManifestDependencyCandidateIndexSha256,
    'PHASE3_GENERATED_STILL_LINEAGE_BINDING_INVALID');
    const stage04 = verifyStage04Fn({ episodeRoot, fsImpl, runner: activationRunner });
    fail(stage04.record?.status === 'PROMOTED' && stage04.promotedPathCount === 147,
      'PHASE3_GENERATED_STILL_STAGE04_INVALID');
    const ownLedger = readLedgerFile(ledgerPath(workRoot), fsImpl);
    const historical = legacyLedgerFiles.flatMap(file => {
      if (!fsImpl.existsSync(file)) return [];
      return file === ledgerPath(workRoot) ? ownLedger : legacy.readLedger(path.dirname(file), fsImpl);
    });
    const consumed = new Set([...ownLedger, ...historical]
      .filter(row => row.recordType === 'SUBMISSION_RESERVED').map(row => row.requestKey));
    return { manifestState, planning, application, candidate, approval, stage04, ownLedger, consumed };
  }
  function select() {
    const state = authoritative(), file = path.join(workRoot, 'selected-candidate.v1.json');
    const record = { schemaVersion: SELECTION_SCHEMA, status: 'APPLIED_CHILD_CANDIDATE_SELECTED_FOR_ISOLATED_REVIEW',
      commit: expectedCommit, manifestSha256: expectedManifestSha256,
      applicationIndexSha256: expectedApplicationIndexSha256,
      candidateIndexSha256: expectedCandidateIndexSha256,
      stage04ActivationRecordSha256: state.stage04.recordSha256,
      stage04Status: state.stage04.record.status, stage04PromotedPathCount: state.stage04.promotedPathCount,
      productionPathInstallationAuthorized: false, stage04ModificationAuthorized: false };
    return { status: record.status, selection: writeImmutableJson(file, record, fsImpl), providerSubmissions: 0 };
  }
  function selection(state) {
    const file = path.join(workRoot, 'selected-candidate.v1.json');
    fail(fsImpl.existsSync(file), 'PHASE3_GENERATED_STILL_CANDIDATE_NOT_SELECTED');
    const record = readJson(file, fsImpl);
    fail(record.schemaVersion === SELECTION_SCHEMA && record.commit === expectedCommit
      && record.manifestSha256 === expectedManifestSha256
      && record.applicationIndexSha256 === expectedApplicationIndexSha256
      && record.candidateIndexSha256 === expectedCandidateIndexSha256
      && record.stage04ActivationRecordSha256 === state.stage04.recordSha256,
    'PHASE3_GENERATED_STILL_SELECTION_INVALID');
    return { file, record, sha256: sha(fsImpl.readFileSync(file)) };
  }
  function preflight() {
    const state = authoritative(), selected = selection(state);
    const keys = state.manifestState.jobs.map(job => job.requestKey);
    fail(keys.every(key => !state.consumed.has(key)), 'PHASE3_GENERATED_STILL_REQUEST_KEY_ALREADY_CONSUMED');
    fail(state.ownLedger.length === 0, 'PHASE3_GENERATED_STILL_BATCH_ALREADY_STARTED');
    return { schemaVersion: 'phase3-generated-still-batch-preflight/1.0.0',
      status: 'REPLACEMENT_GENERATED_STILL_BATCH_READY_EXECUTION_UNAUTHORIZED',
      commit: expectedCommit, manifestSha256: expectedManifestSha256,
      candidateIndexSha256: expectedCandidateIndexSha256, selectionSha256: selected.sha256,
      requestCount: keys.length, requestKeys: keys, maximumExposureUsd: keys.length * UNIT_MAXIMUM_USD,
      retries: 0, fallback: false, providerSubmissionsByThisCommand: 0, ledgerWrites: 0,
      stage04: { status: state.stage04.record.status, activationRecordSha256: state.stage04.recordSha256,
        promotedPathCount: state.stage04.promotedPathCount, promotedPathsMatch: true } };
  }
  function makeAuthorization({ authorizedAt, allowStarted = false } = {}) {
    const state = authoritative(), selected = selection(state);
    const requestKeys = state.manifestState.jobs.map(job => job.requestKey);
    if (!allowStarted) {
      fail(requestKeys.every(key => !state.consumed.has(key)), 'PHASE3_GENERATED_STILL_REQUEST_KEY_ALREADY_CONSUMED');
      fail(state.ownLedger.length === 0, 'PHASE3_GENERATED_STILL_BATCH_ALREADY_STARTED');
    }
    fail(typeof authorizedAt === 'string' && new Date(authorizedAt).toISOString() === authorizedAt,
      'PHASE3_GENERATED_STILL_AUTHORIZED_AT_INVALID');
    const runtime = runtimeHashes(modulePath, cliPath, fsImpl);
    return { schemaVersion: AUTH_SCHEMA, status: 'AUTHORIZED_FOR_EXACT_GENERATED_STILL_BATCH_EXECUTION',
      approvedBy: 'Yakubu Moshood', authorizedAt,
      authorizationStatement: `Yakubu Moshood authorizes exactly ${requestKeys.length} sequential FLUX 3 submissions bound to manifest ${expectedManifestSha256}. Maximum human-approved exposure is USD ${(requestKeys.length * UNIT_MAXIMUM_USD).toFixed(3)}, not provider-enforced. Zero retries, no fallback, no request-key substitution or reuse, no Stage04 modification, no production-path installation, no render, and no promotion are authorized.`,
      bindings: { commit: expectedCommit, routeCorrectionApprovalSha256: expectedApprovalSha256,
        planningIndexSha256: expectedPlanningIndexSha256, applicationIndexSha256: expectedApplicationIndexSha256,
        candidateIndexSha256: expectedCandidateIndexSha256, amendmentSha256: expectedAmendmentSha256,
        promptContractSha256: expectedPromptContractSha256, manifestSha256: expectedManifestSha256,
        selectionSha256: selected.sha256, stage04ActivationRecordSha256: state.stage04.recordSha256,
        deployedModuleSha256: runtime.moduleSha256, deployedCliSha256: runtime.cliSha256,
        requestKeys },
      request: { endpoint: 'blackforestlabs/flux-3/text-to-image', resolution: '1k', aspectRatio: '16:9',
        outputFormat: 'PNG', imagesPerRequest: 1, promptExpansion: false },
      limits: { maximumProviderSubmissions: requestKeys.length,
        maximumHumanApprovedExposureUsd: requestKeys.length * UNIT_MAXIMUM_USD,
        providerEnforced: false, retries: 0, fallback: false, requestKeyReuse: false },
      denials: { otherRequests: true, requestKeySubstitution: true, rendering: true, promotion: true,
        stage04Modification: true, episodeProductionPathWrites: true } };
  }
  function createAuthorization({ authorizedAt } = {}) {
    const record = makeAuthorization({ authorizedAt });
    const file = path.join(workRoot, 'execution-authorization.v1.json');
    fail(!fsImpl.existsSync(file), 'PHASE3_GENERATED_STILL_AUTHORIZATION_ALREADY_EXISTS');
    const artifact = writeImmutableJson(file, record, fsImpl);
    return { status: 'REPLACEMENT_GENERATED_STILL_BATCH_EXECUTION_AUTHORIZATION_CREATED',
      authorization: artifact, maximumProviderSubmissions: record.limits.maximumProviderSubmissions,
      maximumExposureUsd: record.limits.maximumHumanApprovedExposureUsd };
  }
  function loadAuthorization(file, expectedSha256, requestKey) {
    const bytes = fsImpl.readFileSync(file);
    fail(sha(bytes) === expectedSha256, 'PHASE3_GENERATED_STILL_AUTHORIZATION_HASH_MISMATCH');
    const record = JSON.parse(bytes.toString('utf8'));
    const expected = makeAuthorization({ authorizedAt: record.authorizedAt, allowStarted: true });
    fail(canonicalJson(record) === canonicalJson(expected)
      && record.bindings.requestKeys.includes(requestKey), 'PHASE3_GENERATED_STILL_AUTHORIZATION_INVALID');
    return { record, bytes, sha256: expectedSha256 };
  }
  function context(requestKey) {
    const state = authoritative(), selected = selection(state);
    const job = state.manifestState.jobs.find(row => row.requestKey === requestKey);
    fail(job, 'PHASE3_GENERATED_STILL_REQUEST_KEY_UNKNOWN');
    fail(!state.consumed.has(requestKey), 'PHASE3_GENERATED_STILL_REQUEST_KEY_ALREADY_CONSUMED');
    return { state, selected, job, dir: requestDirectory(workRoot, requestKey) };
  }
  async function generate({ requestKey, authorizationFile, expectedAuthorizationSha256 } = {}) {
    const ctx = context(requestKey), authorization = loadAuthorization(authorizationFile,
      expectedAuthorizationSha256, requestKey);
    const expectedOrdinal = ctx.state.ownLedger.filter(row => row.recordType === 'SUBMISSION_RESERVED').length;
    fail(ctx.state.manifestState.jobs[expectedOrdinal]?.requestKey === requestKey,
      'PHASE3_GENERATED_STILL_SEQUENTIAL_ORDER_REQUIRED');
    fsImpl.mkdirSync(ctx.dir, { recursive: true });
    const lock = path.join(ctx.dir, 'operation.lock');
    fsImpl.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
    let reservation = null, response = null;
    try {
      reservation = appendLedger(workRoot, { recordType: 'SUBMISSION_RESERVED', requestKey,
        beatId: ctx.job.beatId, requestType: 'GENERATED_STILL', routeId: 'FLUX3_STILL_1K_16X9',
        manifestSha256: expectedManifestSha256, authorizationSha256: authorization.sha256,
        externalProviderRequest: true, maximumCostUsd: UNIT_MAXIMUM_USD,
        retriesAllowed: 0, fallbackAllowed: false, reservedAt: now() }, fsImpl);
      response = await provider.generateStill({ prompt: ctx.job.serializedPrompt, resolution: '1k',
        aspect_ratio: '16:9', output_format: 'png', enable_prompt_expansion: false, num_images: 1 });
      fail(response && typeof response.url === 'string', 'PHASE3_GENERATED_STILL_PROVIDER_RESPONSE_INVALID');
      fail(response.actualChargeUsd == null || response.actualChargeUsd <= UNIT_MAXIMUM_USD + 1e-9,
        'PHASE3_GENERATED_STILL_PROVIDER_CHARGE_EXCEEDS_MAXIMUM');
      writeImmutableJson(path.join(ctx.dir, 'provider-response.json'), response, fsImpl);
      const downloaded = await downloader(response.url, { requestKey });
      const raw = Buffer.from(downloaded.bytes), info = pngInfo(raw);
      fail(info.width === 1360 && info.height === 768, 'PHASE3_GENERATED_STILL_PNG_CONTRACT_INVALID');
      atomicWrite(path.join(ctx.dir, 'raw-provider-output.png'), raw, fsImpl);
      atomicWrite(path.join(ctx.dir, 'base-review.png'), raw, fsImpl);
      const receipt = { schemaVersion: 'phase3-generated-still-generation-receipt/1.0.0',
        status: 'GENERATED_PENDING_INSPECTION', requestKey, beatId: ctx.job.beatId,
        manifestSha256: expectedManifestSha256, authorizationSha256: authorization.sha256,
        providerRequestId: response.providerRequestId || null, actualChargeUsd: response.actualChargeUsd ?? null,
        positivePromptSha256: ctx.job.positivePromptSha256,
        negativeInstructionsSha256: ctx.job.negativeInstructionsSha256,
        serializedPromptSha256: ctx.job.serializedPromptSha256,
        raw: { bytes: raw.length, sha256: sha(raw), ...info }, retries: 0, fallback: false,
        isolatedReviewPath: ctx.job.outputPath, productionPathInstalled: false, completedAt: now() };
      const receiptArtifact = writeImmutableJson(path.join(ctx.dir, 'generation-receipt.json'), receipt, fsImpl);
      appendLedger(workRoot, { recordType: 'SUBMISSION_RESULT', requestKey, beatId: ctx.job.beatId,
        status: 'SUCCEEDED_PENDING_INSPECTION', providerRequestId: receipt.providerRequestId,
        actualChargeUsd: receipt.actualChargeUsd, rawOutputSha256: receipt.raw.sha256,
        receiptSha256: receiptArtifact.sha256, retryCount: 0, fallbackUsed: false, errorCode: null,
        recordedAt: now() }, fsImpl);
      return receipt;
    } catch (error) {
      if (reservation) {
        const rows = readLedgerFile(ledgerPath(workRoot), fsImpl);
        if (!rows.some(row => row.recordType === 'SUBMISSION_RESULT' && row.requestKey === requestKey))
          appendLedger(workRoot, { recordType: 'SUBMISSION_RESULT', requestKey, beatId: ctx.job.beatId,
            status: 'FAILED_REQUEST_KEY_CONSUMED', providerRequestId: response?.providerRequestId || null,
            actualChargeUsd: response?.actualChargeUsd ?? null, rawOutputSha256: null, receiptSha256: null,
            retryCount: 0, fallbackUsed: false, errorCode: String(error.message || error).split(':')[0],
            recordedAt: now() }, fsImpl);
      }
      throw error;
    } finally { try { fsImpl.unlinkSync(lock); } catch (_) {} }
  }
  function renderTypography(input, output, labels) {
    if (renderer) return renderer({ input, output, labels });
    const labelFile = `${output}.labels.txt`; fsImpl.writeFileSync(labelFile, labels.join('\n'), { flag: 'wx' });
    const font = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const filter = `drawbox=x=48:y=h-188:w=w-96:h=140:color=black@0.72:t=fill,drawtext=fontfile=${font}:textfile=${labelFile}:fontcolor=white:fontsize=34:line_spacing=12:x=82:y=h-158`;
    const result = exec('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vf', filter,
      '-frames:v', '1', '-threads', '1', '-compression_level', '9', output], { encoding: 'utf8' });
    try { fsImpl.unlinkSync(labelFile); } catch (_) {}
    fail(result.status === 0, 'PHASE3_GENERATED_STILL_TYPOGRAPHY_RENDER_FAILED');
  }
  function inspect({ requestKey } = {}) {
    const state = authoritative(), selected = selection(state);
    const job = state.manifestState.jobs.find(row => row.requestKey === requestKey);
    fail(job, 'PHASE3_GENERATED_STILL_REQUEST_KEY_UNKNOWN');
    const dir = requestDirectory(workRoot, requestKey), receiptFile = path.join(dir, 'generation-receipt.json');
    const receipt = readJson(receiptFile, fsImpl, 'PHASE3_GENERATED_STILL_RECEIPT_MISSING');
    const base = fsImpl.readFileSync(path.join(dir, 'base-review.png')), baseInfo = pngInfo(base);
    fail(receipt.raw.sha256 === sha(base) && baseInfo.width === 1360 && baseInfo.height === 768,
      'PHASE3_GENERATED_STILL_RECEIPT_OUTPUT_MISMATCH');
    const finalFile = path.join(dir, 'final-review.png');
    if (!fsImpl.existsSync(finalFile)) {
      if (job.twoStageRoute?.required) renderTypography(path.join(dir, 'base-review.png'), finalFile,
        job.twoStageRoute.exactLocalSemanticLabels || []);
      else atomicWrite(finalFile, base, fsImpl);
    }
    const final = fsImpl.readFileSync(finalFile), finalInfo = pngInfo(final);
    fail(finalInfo.width === 1360 && finalInfo.height === 768, 'PHASE3_GENERATED_STILL_FINAL_REVIEW_INVALID');
    const report = { schemaVersion: 'phase3-generated-still-inspection/1.0.0',
      status: 'INSPECTION_PASS_PENDING_HUMAN_REVIEW', requestKey, beatId: job.beatId,
      manifestSha256: expectedManifestSha256, selectionSha256: selected.sha256,
      base: { bytes: base.length, sha256: sha(base), ...baseInfo },
      finalReview: { bytes: final.length, sha256: sha(final), ...finalInfo,
        deterministicTypographyApplied: Boolean(job.twoStageRoute?.required),
        semanticLabels: job.twoStageRoute?.exactLocalSemanticLabels || [] },
      retries: 0, fallback: false, integrationAuthorized: false, inspectedAt: now() };
    const artifact = writeImmutableJson(path.join(dir, 'inspection.json'), report, fsImpl);
    return { ...report, inspectionSha256: artifact.sha256 };
  }
  function status() {
    const state = authoritative(), selected = fsImpl.existsSync(path.join(workRoot, 'selected-candidate.v1.json'));
    const rows = state.ownLedger;
    return { schemaVersion: 'phase3-generated-still-batch-status/1.0.0',
      status: 'GENERATED_STILL_BATCH_REVIEW_ISOLATED', manifestSha256: expectedManifestSha256,
      selected, stage04: { status: state.stage04.record.status, activationRecordSha256: state.stage04.recordSha256,
        promotedPathCount: state.stage04.promotedPathCount },
      reservations: rows.filter(row => row.recordType === 'SUBMISSION_RESERVED').length,
      results: rows.filter(row => row.recordType === 'SUBMISSION_RESULT').length,
      consumedRequestKeys: rows.filter(row => row.recordType === 'SUBMISSION_RESERVED').map(row => row.requestKey) };
  }
  return { authoritative, select, preflight, makeAuthorization, createAuthorization, generate, inspect, status };
}

module.exports = { AUTH_SCHEMA, LEDGER_SCHEMA, SELECTION_SCHEMA, UNIT_MAXIMUM_USD,
  MAX_BATCH_REQUESTS, sha, canonicalJson, verifyIndexFile, verifyManifest, readLedgerFile,
  appendLedger, createGeneratedStillBatchWorkflow };
