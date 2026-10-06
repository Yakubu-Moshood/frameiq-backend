'use strict';

// Isolated ACT1_B009 animation calibration. This lane is intentionally separate
// from production rendering and the Phase 2 activation workflow.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const mediaExecution = require('./phase3-media-execution.cjs');
const routes = require('./phase3-media-calibration-bundle.cjs');

const RUN_ID = 'phase3-media-execution-v5-20261004-01';
const BEAT_ID = 'ACT1_B009';
const OPERATION = 'GENERATE_ANIMATION';
const ENDPOINT = routes.H3_MAX_ENDPOINT;
const MODEL = 'H3 Max Image to Video';
const PACKAGE = routes.TRUST;
const SOURCE_STILL_SHA256 = '0a9c9311c20da7dc774b1695f9abe2ea56f648fc0eb2450a8c7f0c4130b9ffdc';
const SOURCE_STILL_BYTES = 1324401;
const SOURCE_STILL_AUTH_SHA256 = '0b3b6ca57f7a8895a97bc5a67501704cbbf74a437c7053d99b0882499b5a3599';
const SOURCE_STILL_RECEIPT_SHA256 = '95b75386224f14b213750667cd4715705e28428f5d868d545cfe7c0036294285';
const SOURCE_STILL_LEDGER_SHA256 = 'f59d219075a2e94476f94b74dd444517980599ad50be499e6c682838ee6c7823';
const SOURCE_STILL_APPROVAL_SHA256 = '8b2c41cff79bac73a89e22d80a953517091acaa98bc110d6447da06e835b548c';
const SOURCE_STILL_APPROVAL_PATH = path.resolve(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
  'phase3-act1-b009-source-still-human-approval-20261005.v2.json');
const B006_APPROVAL_SHA256 = 'd00ce391df1822468eb7fe2d07f85fc6404c483e1a79105c9e50aaa875c1dcd1';
const B009_RECONCILIATION_SHA256 = 'b93dd0f59f74197d7e7e9f7e4be0ef3360890dfdca8550f90101443dddc15207';
const STAGE04_ACTIVATION_SHA256 = 'f60d360c0179c87329d4e6d8be7b39d09da7ccc9d6c2351645fa2d8a4062923d';
const STAGE04_LEDGER_SHA256 = mediaExecution.REQUEST_LEDGER_SHA256;
const ROUTE_BUNDLE_SHA256 = '6981bda36cd4e9dda4da5b701fb23b2f705e1fd5bb04fcca30157160bac85b42';
const ROUTE_APPROVAL_SHA256 = routes.ROUTE_APPROVAL_SHA256;
const AUTH_SCHEMA = 'phase3-media-calibration-animation-authorization/1.0.0';
const LEDGER_SCHEMA = 'phase3-media-calibration-animation-ledger/1.0.0';
const RECEIPT_SCHEMA = 'phase3-media-calibration-animation-receipt/1.0.0';
const RESULT_SCHEMA = 'phase3-media-calibration-animation-result/1.0.0';
const FAILURE_SCHEMA = 'phase3-media-calibration-animation-failure/1.0.0';
const ASSET_CLASS = 'NON_PRODUCTION_DISPOSABLE_CALIBRATION';
const OWNERSHIP = routes.OWNERSHIP_DISPOSITION;
const MAX_EXPOSURE_USD = 0.60;
const EXPECTED_CHARGE_USD = 5 * 0.08;
const TARGET_FPS = 30;
const TARGET_FRAMES = 114;
const TARGET_DURATION_SECONDS = 3.8;
const RECOVERY = Object.freeze({
  rawBytes: 6951973,
  rawSha256: '976a45b4230d20638a260d8fc41306951ff308b077a174531257a7534e468c79',
  ledgerSha256: 'fe3e7ab055ed1a2925cfb92f0e9511f87b512b702333afc89fcbfd77b214d024',
  failureSha256: '7dd3b9cb69b866105f18986ae4ee76169779105f881c74645e0631239be69c9c',
  authorizationSha256: 'd8063bff367eac9771e47174295a51450a7ea1e8a7c4c704f1690a5496c95e37',
  sourceFps: 24,
  sourceFrames: 124,
  sourceWidth: 1344,
  sourceHeight: 768,
  sourceDurationSeconds: 5.184,
  sourceCodec: 'h264',
  sourceAudioStreams: 1,
  expectedFailureAt: '2026-10-06T09:53:39.571Z',
  expectedReservationAt: '2026-10-06T09:53:33.435Z',
});
const SOURCE_FILES = mediaExecution.CALIBRATION_SOURCE_STILL_FILES;
const LEGACY_AUTHORIZATION = Object.freeze({ path: `${BEAT_ID}/animation-execution-authorization.v1.json`,
  sha256: 'f15ae242027a7475c14d6139e89418a16764034656599c40ce576178be85dfd3' });
const ANIMATION_REQUEST_KEY = '946a3ac047028bf95badf61753f46e340bb27d8a3931c9f675ba210e1d9de3c3';
const FILES = Object.freeze({ authorization: `${BEAT_ID}/animation-execution-authorization.v2.json`,
  ledger: `${BEAT_ID}/animation-request-ledger.jsonl`, lock: `${BEAT_ID}/animation.lock`,
  raw: `${BEAT_ID}/ACT1_B009-animation-provider-output.bin`,
  derivative: `${BEAT_ID}/ACT1_B009-animation-30fps-114f.mp4`,
  receipt: `${BEAT_ID}/animation-generation-receipt.v1.json`,
  result: `${BEAT_ID}/animation-generation-result.v1.json`,
  failure: `${BEAT_ID}/animation-failure-receipt.v1.json` });
const HUMAN_APPROVAL = Object.freeze({ schemaVersion: 'phase3-act1-b009-source-still-human-approval/1.0.0',
  status: 'APPROVED_FOR_ANIMATION_CALIBRATION_INPUT_ONLY', approvedBy: 'Yakubu Moshood',
  runId: RUN_ID, beatId: BEAT_ID, operation: 'GENERATE_ANIMATION_SOURCE_STILL',
  requestKey: 'f10feb2552874270ce4af7705e5648e4beede07faedfa2a72072ba6633afdd02' });

function fail(ok, code) { if (!ok) throw new Error(code); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function selfBound(schemaVersion, body, field) {
  const unsigned = { schemaVersion, ...body };
  return { ...unsigned, [field]: sha(Buffer.from(canonicalJson(unsigned), 'utf8')) };
}
function verifySelfBound(record, field, code) {
  const unsigned = { ...record }; const binding = unsigned[field]; delete unsigned[field];
  fail(binding === sha(Buffer.from(canonicalJson(unsigned), 'utf8')), code);
  return true;
}
function routePrompt(routeRequest) {
  fail(routeRequest?.beatId === BEAT_ID && routeRequest.operation === OPERATION
    && routeRequest.endpoint === ENDPOINT, 'PHASE3_B009_ANIMATION_ROUTE_REQUEST_MISSING');
  fail(sha(Buffer.from(routeRequest.prompt || '', 'utf8')) === routes.PROMPT_HASHES.ACT1_B009.animationPrompt
    && sha(Buffer.from(routeRequest.negativePrompt || '', 'utf8')) === routes.PROMPT_HASHES.ACT1_B009.negativePrompt,
  'PHASE3_B009_ANIMATION_PROMPT_HASH_MISMATCH');
  fail(canonicalJson(routeRequest.parameters) === canonicalJson(routes.H3_MAX), 'PHASE3_B009_ANIMATION_PARAMETERS_MISMATCH');
  return { prompt: routeRequest.prompt, negativePrompt: routeRequest.negativePrompt,
    promptSha256: sha(Buffer.from(routeRequest.prompt, 'utf8')),
    negativePromptSha256: sha(Buffer.from(routeRequest.negativePrompt, 'utf8')) };
}
function deriveAnimationRequestKey({ prompt, negativePrompt, sourceStillSha256 = SOURCE_STILL_SHA256,
  sourceStillApprovalSha256 = SOURCE_STILL_APPROVAL_SHA256, stagedIndexSha256 = PACKAGE.stagedIndexSha256 } = {}) {
  fail(sha(Buffer.from(prompt || '', 'utf8')) === routes.PROMPT_HASHES.ACT1_B009.animationPrompt
    && sha(Buffer.from(negativePrompt || '', 'utf8')) === routes.PROMPT_HASHES.ACT1_B009.negativePrompt,
  'PHASE3_B009_ANIMATION_PROMPT_HASH_MISMATCH');
  fail(sourceStillSha256 === SOURCE_STILL_SHA256 && sourceStillApprovalSha256 === SOURCE_STILL_APPROVAL_SHA256
    && stagedIndexSha256 === PACKAGE.stagedIndexSha256, 'PHASE3_B009_ANIMATION_KEY_BINDING_MISMATCH');
  const parameters = { ...routes.H3_MAX, sourceStillSha256 };
  const body = canonical({ schemaVersion: 'phase3-calibration-request-key/3.0.0', runId: RUN_ID,
    beatId: BEAT_ID, operation: OPERATION, modelId: ENDPOINT, endpoint: ENDPOINT, parameters,
    prompt, negativePrompt, sourceStillSha256, sourceStillApprovalSha256, stagedIndexSha256 });
  return sha(Buffer.from(JSON.stringify(body), 'utf8'));
}
function makeAuthorizationTemplate({ requestKey, runtimeHashes, authorizedAt } = {}) {
  fail(/^[a-f0-9]{64}$/u.test(requestKey || ''), 'PHASE3_B009_ANIMATION_REQUEST_KEY_REQUIRED');
  fail(runtimeHashes && ['animationWorkflowSha256', 'executionModuleSha256', 'cliSha256']
    .every(key => /^[a-f0-9]{64}$/u.test(runtimeHashes[key] || '')), 'PHASE3_B009_ANIMATION_RUNTIME_HASHES_REQUIRED');
  fail(typeof authorizedAt === 'string' && Number.isFinite(Date.parse(authorizedAt))
    && new Date(authorizedAt).toISOString() === authorizedAt, 'PHASE3_B009_ANIMATION_AUTHORIZED_AT_INVALID');
  return {
    schemaVersion: AUTH_SCHEMA, status: 'AUTHORIZED_FOR_SINGLE_NONPRODUCTION_CALIBRATION_ANIMATION',
    approvedBy: 'Yakubu Moshood', authorizedAt, scope: 'ANIMATION_ONLY', maxProviderSubmissions: 1,
    supersedes: { path: LEGACY_AUTHORIZATION.path, sha256: LEGACY_AUTHORIZATION.sha256,
      reason: 'PREFLIGHT_FILE_SET_COMPATIBILITY_REPAIR', oldAuthorizationConsumed: false,
      oldProviderSubmissions: 0 },
    bindings: { runId: RUN_ID, beatId: BEAT_ID, operation: OPERATION, endpoint: ENDPOINT, requestKey,
      stagedIndexSha256: PACKAGE.stagedIndexSha256, candidateIndexSha256: PACKAGE.candidateIndexSha256,
      outerIndexSha256: PACKAGE.outerIndexSha256, routeBundleSha256: ROUTE_BUNDLE_SHA256,
      routeResolutionApprovalSha256: ROUTE_APPROVAL_SHA256, b009ReconciliationSha256: B009_RECONCILIATION_SHA256,
      b006ApprovalSha256: B006_APPROVAL_SHA256, sourceStillAuthorizationSha256: SOURCE_STILL_AUTH_SHA256,
      sourceStillReceiptSha256: SOURCE_STILL_RECEIPT_SHA256, sourceStillLedgerSha256: SOURCE_STILL_LEDGER_SHA256,
      sourceStillApprovalSha256: SOURCE_STILL_APPROVAL_SHA256, sourceStillPath: SOURCE_FILES.output,
      sourceStillBytes: SOURCE_STILL_BYTES, sourceStillSha256: SOURCE_STILL_SHA256,
      sourceStillWidth: 1360, sourceStillHeight: 768, stage04ActivationRecordSha256: STAGE04_ACTIVATION_SHA256,
      stage04LedgerBaselineSha256: STAGE04_LEDGER_SHA256,
      animationWorkflowSha256: runtimeHashes.animationWorkflowSha256,
      executionModuleSha256: runtimeHashes.executionModuleSha256, cliSha256: runtimeHashes.cliSha256,
      promptSha256: routes.PROMPT_HASHES.ACT1_B009.animationPrompt,
      negativeInstructionsSha256: routes.PROMPT_HASHES.ACT1_B009.negativePrompt },
    request: { endpoint: ENDPOINT, model: MODEL, parameters: { ...routes.H3_MAX },
      sourceInput: { path: SOURCE_FILES.output, sha256: SOURCE_STILL_SHA256, bytes: SOURCE_STILL_BYTES },
      maximumProviderSubmissions: 1, retries: 0, fallback: false,
      expectedPublishedChargeUsd: EXPECTED_CHARGE_USD, maximumHumanAcceptedExposureUsd: MAX_EXPOSURE_USD,
      exposureProviderEnforced: false },
    classification: { assetClass: ASSET_CLASS, ownershipDisposition: OWNERSHIP,
      productionReadiness: 'REJECTED', productionUse: false },
    denials: { anotherB009Still: true, act1B005: true, act1B006: true, allOtherBeats: true,
      allOtherOperations: true, productionUse: true, rendering: true, promotion: true,
      candidateReconstruction: true, stage04Modification: true, episodeRootWrites: true,
      secondSubmission: true, retry: true, fallback: true },
  };
}
function validateAnimationAuthorization(record, expectedSha256, context, recordBytes = null) {
  fail(/^[a-f0-9]{64}$/u.test(expectedSha256 || ''), 'PHASE3_B009_ANIMATION_AUTHORIZATION_HASH_MISMATCH');
  if (recordBytes !== null) fail(Buffer.isBuffer(recordBytes) && sha(recordBytes) === expectedSha256,
    'PHASE3_B009_ANIMATION_AUTHORIZATION_HASH_MISMATCH');
  const expected = makeAuthorizationTemplate({ requestKey: context.requestKey,
    runtimeHashes: context.runtimeHashes, authorizedAt: record?.authorizedAt });
  fail(canonicalJson(record) === canonicalJson(expected), 'PHASE3_B009_ANIMATION_AUTHORIZATION_BINDING_INVALID');
  return true;
}
function verifyStagedRunFiles({ runDir, fsImpl = fs, currentRuntimeHashes = null } = {}) {
  fail(typeof runDir === 'string' && path.basename(path.resolve(runDir)) === RUN_ID,
    'PHASE3_B009_ANIMATION_STAGED_RUN_CONTEXT_INVALID');
  const beatDir = path.join(path.resolve(runDir), BEAT_ID);
  if (!fsImpl.existsSync(beatDir)) return [];
  const beatStat = fsImpl.lstatSync(beatDir);
  fail(beatStat.isDirectory() && !beatStat.isSymbolicLink(), 'PHASE3_B009_ANIMATION_DIRECTORY_INVALID');
  const legacyPath = path.join(path.resolve(runDir), ...LEGACY_AUTHORIZATION.path.split('/'));
  const currentPath = path.join(path.resolve(runDir), ...FILES.authorization.split('/'));
  const legacyPresent = fsImpl.existsSync(legacyPath), currentPresent = fsImpl.existsSync(currentPath);
  if (!legacyPresent && !currentPresent) return [];
  const legacyNames = [path.posix.basename(LEGACY_AUTHORIZATION.path)];
  const animationNames = [...Object.values(FILES).map(relative => path.posix.basename(relative)), ...legacyNames];
  const sourceNames = Object.values(SOURCE_FILES).map(relative => path.posix.basename(relative));
  const actualNames = fsImpl.readdirSync(beatDir).sort();
  fail(actualNames.every(name => sourceNames.includes(name) || animationNames.includes(name)),
    'PHASE3_B009_ANIMATION_UNKNOWN_FILE');
  for (const name of actualNames) {
    const stat = fsImpl.lstatSync(path.join(beatDir, name));
    fail(stat.isFile() && !stat.isSymbolicLink(), 'PHASE3_B009_ANIMATION_FILE_TYPE_INVALID');
  }
  if (legacyPresent) {
    const bytes = fsImpl.readFileSync(legacyPath);
    fail(sha(bytes) === LEGACY_AUTHORIZATION.sha256, 'PHASE3_B009_ANIMATION_LEGACY_AUTHORIZATION_HASH_MISMATCH');
    const record = JSON.parse(bytes.toString('utf8'));
    fail(record.schemaVersion === AUTH_SCHEMA
      && record.status === 'AUTHORIZED_FOR_SINGLE_NONPRODUCTION_CALIBRATION_ANIMATION'
      && record.scope === 'ANIMATION_ONLY' && record.maxProviderSubmissions === 1
      && record.approvedBy === 'Yakubu Moshood' && record.authorizedAt === '2026-10-05T20:52:07.598Z'
      && record.bindings?.runId === RUN_ID && record.bindings?.beatId === BEAT_ID
      && record.bindings?.operation === OPERATION && record.bindings?.requestKey === ANIMATION_REQUEST_KEY
      && record.request?.maximumProviderSubmissions === 1 && record.request?.retries === 0
      && record.request?.fallback === false && record.classification?.assetClass === ASSET_CLASS
      && record.classification?.productionReadiness === 'REJECTED' && record.classification?.productionUse === false,
    'PHASE3_B009_ANIMATION_LEGACY_AUTHORIZATION_INVALID');
  }
  if (currentPresent) {
    fail(legacyPresent, 'PHASE3_B009_ANIMATION_SUPERSEDED_AUTHORIZATION_REQUIRED');
    const bytes = fsImpl.readFileSync(currentPath), record = JSON.parse(bytes.toString('utf8'));
    const exactRecoveryState = sha(bytes) === RECOVERY.authorizationSha256
      && actualNames.includes(path.posix.basename(FILES.raw))
      && actualNames.includes(path.posix.basename(FILES.failure))
      && actualNames.includes(path.posix.basename(FILES.ledger));
    const hashes = exactRecoveryState ? {
      animationWorkflowSha256: record.bindings?.animationWorkflowSha256,
      executionModuleSha256: record.bindings?.executionModuleSha256,
      cliSha256: record.bindings?.cliSha256,
    } : currentRuntimeHashes || {
      animationWorkflowSha256: sha(fsImpl.readFileSync(__filename)),
      executionModuleSha256: sha(fsImpl.readFileSync(path.resolve(__dirname, 'phase3-media-execution.cjs'))),
      cliSha256: sha(fsImpl.readFileSync(path.resolve(__dirname, '..', 'scripts', 'phase3-media-execution.cjs'))),
    };
    if (exactRecoveryState) fail(sha(bytes) === RECOVERY.authorizationSha256,
      'PHASE3_B009_ANIMATION_RECOVERY_AUTHORIZATION_HASH_MISMATCH');
    validateAnimationAuthorization(record, sha(bytes), { requestKey: ANIMATION_REQUEST_KEY, runtimeHashes: hashes }, bytes);
  } else {
    const executionArtifacts = Object.values(FILES).filter(relative => relative !== FILES.authorization)
      .map(relative => path.posix.basename(relative));
    fail(!actualNames.some(name => executionArtifacts.includes(name)),
      'PHASE3_B009_ANIMATION_LEGACY_AUTHORIZATION_ALREADY_CONSUMED');
  }
  return actualNames.filter(name => animationNames.includes(name)).map(name => `${BEAT_ID}/${name}`).sort();
}
function safeRunPath(runDir, relative) {
  fail(typeof relative === 'string' && !relative.includes('\\') && !relative.split('/').includes('..'),
    'PHASE3_B009_ANIMATION_PATH_INVALID');
  const root = path.resolve(runDir), target = path.resolve(root, ...relative.split('/'));
  fail(target.startsWith(`${root}${path.sep}`), 'PHASE3_B009_ANIMATION_PATH_INVALID');
  return target;
}
function atomicExclusive(file, bytes, fsImpl = fs) {
  fail(!fsImpl.existsSync(file), 'PHASE3_B009_ANIMATION_OUTPUT_ALREADY_EXISTS');
  const temp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fsImpl.writeFileSync(temp, bytes, { flag: 'wx' });
    const fd = fsImpl.openSync(temp, 'r+'); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
    fsImpl.renameSync(temp, file);
  } catch (error) { try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch (_) {} throw error; }
}
function readJson(file, fsImpl) { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
function appendLedger(file, record, fsImpl) {
  const prior = readLedger(file, fsImpl);
  if (record.recordType === 'SUBMISSION_RESERVED') {
    fail(prior.length === 0 && !prior.some(row => row.requestKey === record.requestKey),
      'PHASE3_B009_ANIMATION_REQUEST_ALREADY_CONSUMED');
  } else {
    fail(record.recordType === 'SUBMISSION_RESULT' && prior.length === 1
      && prior[0].recordType === 'SUBMISSION_RESERVED' && prior[0].requestKey === record.requestKey
      && record.sequence === 2 && !prior.some(row => row.recordType === 'SUBMISSION_RESULT'),
    'PHASE3_B009_ANIMATION_TERMINAL_WITHOUT_RESERVATION');
  }
  const body = { schemaVersion: LEDGER_SCHEMA, ...record };
  body.entrySha256 = sha(Buffer.from(canonicalJson(body), 'utf8'));
  fsImpl.appendFileSync(file, `${JSON.stringify(body)}\n`, { flag: fsImpl.existsSync(file) ? 'a' : 'wx' });
  return body;
}
function readLedger(file, fsImpl) {
  if (!fsImpl.existsSync(file)) return [];
  const lines = fsImpl.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean);
  const rows = lines.map(line => JSON.parse(line));
  fail(rows.length <= 2 && rows.every((row, i) => {
    const { entrySha256, ...body } = row;
    const common = row.schemaVersion === LEDGER_SCHEMA && row.sequence === i + 1
      && entrySha256 === sha(Buffer.from(canonicalJson(body), 'utf8'))
      && row.requestKey === rows[0]?.requestKey && row.runId === RUN_ID && row.beatId === BEAT_ID
      && row.operation === OPERATION;
    if (i === 0) return common && row.recordType === 'SUBMISSION_RESERVED'
      && (row.retryAllowed === false || row.retriesAllowed === false) && row.fallbackAllowed === false;
    return common && row.recordType === 'SUBMISSION_RESULT'
      && ['SUCCEEDED', 'FAILED'].includes(row.status) && row.retryCount === 0 && row.fallbackUsed === false;
  }), 'PHASE3_B009_ANIMATION_LEDGER_INVALID');
  if (rows.length === 2) fail(rows[0].recordType === 'SUBMISSION_RESERVED'
    && ['SUCCEEDED', 'FAILED'].includes(rows[1].status) && rows[1].recordType === 'SUBMISSION_RESULT',
  'PHASE3_B009_ANIMATION_LEDGER_INVALID');
  if (rows.length === 1) fail(rows[0].recordType === 'SUBMISSION_RESERVED', 'PHASE3_B009_ANIMATION_LEDGER_INVALID');
  return rows;
}
function probeVideo(file, { ffprobePath = 'ffprobe', execFileImpl = execFileSync } = {}) {
  const text = execFileImpl(ffprobePath, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file],
    { encoding: 'utf8', windowsHide: true });
  const record = JSON.parse(text), videos = record.streams.filter(s => s.codec_type === 'video'), audios = record.streams.filter(s => s.codec_type === 'audio');
  const video = videos[0];
  const toFps = text => { const [n, d] = String(text || '0/1').split('/').map(Number); return d ? n / d : n; };
  return { container: record.format?.format_name || null, durationSeconds: Number(record.format?.duration),
    videoStreamCount: videos.length, audioStreamCount: audios.length,
    video: video ? { codec: video.codec_name, width: Number(video.width), height: Number(video.height),
      fps: toFps(video.avg_frame_rate || video.r_frame_rate), avgFps: toFps(video.avg_frame_rate),
      rFps: toFps(video.r_frame_rate), frameCount: Number(video.nb_read_frames || video.nb_frames) } : null,
    audioCodecs: audios.map(s => s.codec_name) };
}
function probeFrameTimestamps(file, { ffprobePath = 'ffprobe', execFileImpl = execFileSync } = {}) {
  const text = execFileImpl(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file],
  { encoding: 'utf8', windowsHide: true });
  return String(text).split(/\r?\n/u).map(line => Number(line.trim())).filter(Number.isFinite);
}
function isConstantFrameRate(timestamps, fps, frameCount, tolerance = 0.000002) {
  return Array.isArray(timestamps) && timestamps.length === frameCount && timestamps.length > 1
    && timestamps.every(Number.isFinite)
    && timestamps.slice(1).every((value, index) => value > timestamps[index]
      && Math.abs((value - timestamps[index]) - 1 / fps) <= tolerance);
}
function processTable() {
  if (process.platform === 'win32') return [];
  const text = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', windowsHide: true });
  return String(text).split(/\r?\n/u).filter(Boolean).map(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    return match ? { pid: Number(match[1]), args: match[2] } : null;
  }).filter(Boolean);
}
function fitSilentDerivative({ inputPath, outputPath, ffmpeg = spawnSync, ffprobe = probeVideo, fsImpl = fs,
  recoveryMode = false, frameTimestamps = null }) {
  const source = ffprobe(inputPath);
  if (recoveryMode) {
    fail(source.container && /(?:^|,)mp4(?:,|$)/u.test(source.container)
      && source.videoStreamCount === 1 && source.video?.codec === RECOVERY.sourceCodec
      && source.video.width === RECOVERY.sourceWidth && source.video.height === RECOVERY.sourceHeight
      && source.video.fps === RECOVERY.sourceFps && source.video.avgFps === RECOVERY.sourceFps
      && source.video.rFps === RECOVERY.sourceFps && source.video.frameCount === RECOVERY.sourceFrames
      && source.audioStreamCount === RECOVERY.sourceAudioStreams
      && Math.abs(source.durationSeconds - RECOVERY.sourceDurationSeconds) < 0.0005
      && isConstantFrameRate(frameTimestamps, RECOVERY.sourceFps, RECOVERY.sourceFrames),
    'PHASE3_B009_ANIMATION_RECOVERY_RAW_NOT_VERIFIED_CFR_24');
  } else {
    fail(source.videoStreamCount === 1 && source.video?.fps === 30 && Number.isInteger(source.video.frameCount)
      && source.video.frameCount >= TARGET_FRAMES && source.durationSeconds >= TARGET_DURATION_SECONDS,
    'PHASE3_B009_ANIMATION_RAW_VIDEO_NOT_FRAME_ALIGNED');
  }
  const tempPath = `${outputPath}.tmp-${crypto.randomBytes(8).toString('hex')}.mp4`;
  const args = ['-hide_banner', '-nostdin', '-y', '-i', inputPath, '-map', '0:v:0'];
  if (recoveryMode) args.push('-vf', 'fps=30:round=near');
  args.push('-an', '-frames:v', String(TARGET_FRAMES),
    '-fps_mode', 'cfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tempPath);
  try {
    const result = ffmpeg('ffmpeg', args, { encoding: 'utf8', windowsHide: true, shell: false });
    fail(result && result.status === 0 && fsImpl.existsSync(tempPath), 'PHASE3_B009_ANIMATION_FFMPEG_FAILED');
    const fitted = ffprobe(tempPath);
    fail(fitted.videoStreamCount === 1 && fitted.audioStreamCount === 0 && fitted.video?.fps === TARGET_FPS
      && fitted.video?.frameCount === TARGET_FRAMES && Math.abs(fitted.durationSeconds - TARGET_DURATION_SECONDS) < 0.001,
    'PHASE3_B009_ANIMATION_DERIVATIVE_INVALID');
    if (recoveryMode) fail(/(?:^|,)mp4(?:,|$)/u.test(fitted.container || '')
      && fitted.video.codec === 'h264' && fitted.video.width === RECOVERY.sourceWidth
      && fitted.video.height === RECOVERY.sourceHeight,
    'PHASE3_B009_ANIMATION_RECOVERY_DERIVATIVE_PROFILE_INVALID');
    fail(!fsImpl.existsSync(outputPath), 'PHASE3_B009_ANIMATION_OUTPUT_ALREADY_EXISTS');
    fsImpl.renameSync(tempPath, outputPath);
    return { args, metadata: fitted };
  } catch (error) { try { if (fsImpl.existsSync(tempPath)) fsImpl.unlinkSync(tempPath); } catch (_) {} throw error; }
}
function downloadVideo(url, { fetchImpl = fetch } = {}) {
  let parsed; try { parsed = new URL(url); } catch { throw new Error('PHASE3_B009_ANIMATION_DOWNLOAD_URL_INVALID'); }
  fail(parsed.protocol === 'https:' && !parsed.username && !parsed.password
    && (parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media')
      || parsed.hostname === 'storage.googleapis.com' || parsed.hostname.endsWith('.googleusercontent.com')),
  'PHASE3_B009_ANIMATION_DOWNLOAD_HOST_FORBIDDEN');
  return fetchImpl(parsed, { redirect: 'error' }).then(async response => {
    fail(response.ok, 'PHASE3_B009_ANIMATION_DOWNLOAD_FAILED');
    const bytes = Buffer.from(await response.arrayBuffer());
    fail(bytes.length > 0 && bytes.length <= 512 * 1024 * 1024, 'PHASE3_B009_ANIMATION_DOWNLOAD_SIZE_INVALID');
    return bytes;
  });
}
function createFalAnimationProvider({ falModuleLoader = () => require('@fal-ai/client'), credentialResolver = () => process.env.FAL_KEY } = {}) {
  return { async generateAnimation({ endpoint, input }) {
    fail(endpoint === ENDPOINT, 'PHASE3_B009_ANIMATION_ENDPOINT_FORBIDDEN');
    const credentials = credentialResolver(); fail(Boolean(credentials), 'PHASE3_B009_ANIMATION_CREDENTIAL_MISSING');
    const { fal } = falModuleLoader(); fal.config({ credentials, retry: { maxRetries: 0, retryableStatusCodes: [] } });
    const response = await fal.subscribe(endpoint, { input, logs: false });
    const data = response?.data || {}, video = data.video || data.videos?.[0];
    fail(typeof video?.url === 'string' && video.url.length > 0, 'PHASE3_B009_ANIMATION_PROVIDER_RESPONSE_INVALID');
    return { url: video.url, requestId: response.request_id || data.request_id || null,
      actualChargeUsd: Number.isFinite(data.actual_cost_usd) ? data.actual_cost_usd : null,
      contentType: video.content_type || null,
      responseMetadata: { requestId: response.request_id || data.request_id || null,
        actualCostUsd: Number.isFinite(data.actual_cost_usd) ? data.actual_cost_usd : null,
        videoContentType: video.content_type || null } };
  } };
}

function createB009AnimationWorkflow({ sourceStillWorkflow, reviewRoot, episodeRoot, approvalPath = SOURCE_STILL_APPROVAL_PATH,
  modulePath = __filename, executionModulePath = path.resolve(__dirname, 'phase3-media-execution.cjs'),
  cliPath = path.resolve(__dirname, '..', 'scripts', 'phase3-media-execution.cjs'), fsImpl = fs,
  provider = createFalAnimationProvider(), downloader = downloadVideo, ffprobe = probeVideo,
  ffprobeFrames = probeFrameTimestamps, ffmpeg = spawnSync, now = () => new Date().toISOString(),
  processScanner = processTable, testHooks = {} } = {}) {
  const recoveryTrust = Object.freeze({ ...RECOVERY, ...(testHooks.recoveryBindings || {}) });
  const runDir = path.resolve(reviewRoot, RUN_ID), beatDir = path.join(runDir, BEAT_ID);
  const file = key => safeRunPath(runDir, FILES[key]);
  const sourceFile = key => safeRunPath(runDir, SOURCE_FILES[key]);
  const sourceApproval = () => {
    fail(fsImpl.existsSync(approvalPath), 'PHASE3_B009_ANIMATION_SOURCE_APPROVAL_MISSING');
    const stat = fsImpl.lstatSync(approvalPath), bytes = fsImpl.readFileSync(approvalPath);
    fail(stat.isFile() && !stat.isSymbolicLink() && sha(bytes) === SOURCE_STILL_APPROVAL_SHA256,
      'PHASE3_B009_ANIMATION_SOURCE_APPROVAL_HASH_MISMATCH');
    const record = JSON.parse(bytes.toString('utf8'));
    fail(record.schemaVersion === HUMAN_APPROVAL.schemaVersion && record.status === HUMAN_APPROVAL.status
      && record.approvedBy === HUMAN_APPROVAL.approvedBy && record.runId === HUMAN_APPROVAL.runId
      && record.beatId === HUMAN_APPROVAL.beatId && record.operation === HUMAN_APPROVAL.operation
      && record.requestKey === HUMAN_APPROVAL.requestKey && record.bindings?.sourceStillSha256 === SOURCE_STILL_SHA256
      && record.bindings?.sourceStillReceiptSha256 === SOURCE_STILL_RECEIPT_SHA256
      && record.bindings?.sourceStillLedgerSha256 === SOURCE_STILL_LEDGER_SHA256
      && record.bindings?.sourceStillAuthorizationSha256 === SOURCE_STILL_AUTH_SHA256
      && record.inspection?.persistedInspectionArtifact === 'NONE'
      && record.inspection?.observedStatus === 'INSPECTED_PENDING_HUMAN_REVIEW'
      && record.inspection?.humanDecision === HUMAN_APPROVAL.status
      && record.restrictions?.animationExecutionAuthorized === false,
    'PHASE3_B009_ANIMATION_SOURCE_APPROVAL_INVALID');
    return { record, bytes, sha256: sha(bytes) };
  };
  function inputContext() {
    fail(sourceStillWorkflow && typeof sourceStillWorkflow.assertBindings === 'function'
      && typeof sourceStillWorkflow.inspect === 'function', 'PHASE3_B009_ANIMATION_SOURCE_WORKFLOW_REQUIRED');
    const verified = sourceStillWorkflow.assertBindings();
    const inspected = sourceStillWorkflow.inspect();
    fail(inspected.status === 'INSPECTED_PENDING_HUMAN_REVIEW' && inspected.output.sha256 === SOURCE_STILL_SHA256
      && inspected.output.bytes === SOURCE_STILL_BYTES && inspected.output.width === 1360 && inspected.output.height === 768
      && inspected.receiptSha256 === SOURCE_STILL_RECEIPT_SHA256 && inspected.ledgerSha256 === SOURCE_STILL_LEDGER_SHA256
      && inspected.assetClass === ASSET_CLASS && inspected.productionReadiness === 'REJECTED',
    'PHASE3_B009_ANIMATION_SOURCE_STILL_BINDING_INVALID');
    const approval = sourceApproval();
    const sourceBytes = fsImpl.readFileSync(sourceFile('output'));
    fail(sourceBytes.length === SOURCE_STILL_BYTES && sha(sourceBytes) === SOURCE_STILL_SHA256,
      'PHASE3_B009_ANIMATION_SOURCE_STILL_HASH_MISMATCH');
    const route = verified.staged?.calibrationRoutePlan?.requests?.find(item => item.beatId === BEAT_ID && item.operation === OPERATION);
    const prompt = routePrompt(route);
    routes.readRouteApproval();
    const bundlePath = path.resolve(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
      'phase3-media-execution-calibration-route-bundle-20261004.v1.json');
    const bundleBytes = fsImpl.readFileSync(bundlePath);
    fail(sha(bundleBytes) === ROUTE_BUNDLE_SHA256 && JSON.parse(bundleBytes.toString('utf8')).bindings?.stagedIndexSha256
      === PACKAGE.stagedIndexSha256, 'PHASE3_B009_ANIMATION_ROUTE_BUNDLE_INVALID');
    const requestKey = deriveAnimationRequestKey({ prompt: prompt.prompt, negativePrompt: prompt.negativePrompt,
      sourceStillSha256: SOURCE_STILL_SHA256, sourceStillApprovalSha256: approval.sha256 });
    return { verified, inspected, approval, sourceBytes, prompt, requestKey };
  }
  function recoveryContext() {
    fail(sourceStillWorkflow && typeof sourceStillWorkflow.assertBindings === 'function',
      'PHASE3_B009_ANIMATION_SOURCE_WORKFLOW_REQUIRED');
    const verified = sourceStillWorkflow.assertBindings();
    const approval = sourceApproval();
    const route = verified.staged?.calibrationRoutePlan?.requests?.find(item => item.beatId === BEAT_ID
      && item.operation === OPERATION);
    const prompt = routePrompt(route);
    routes.readRouteApproval();
    const bundlePath = path.resolve(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo',
      'phase3-media-execution-calibration-route-bundle-20261004.v1.json');
    const bundleBytes = fsImpl.readFileSync(bundlePath);
    fail(sha(bundleBytes) === ROUTE_BUNDLE_SHA256 && JSON.parse(bundleBytes.toString('utf8')).bindings?.stagedIndexSha256
      === PACKAGE.stagedIndexSha256, 'PHASE3_B009_ANIMATION_ROUTE_BUNDLE_INVALID');
    const requestKey = deriveAnimationRequestKey({ prompt: prompt.prompt, negativePrompt: prompt.negativePrompt,
      sourceStillSha256: SOURCE_STILL_SHA256, sourceStillApprovalSha256: approval.sha256 });
    return { verified, approval, prompt, requestKey };
  }
  function runtimeHashes() {
    return { animationWorkflowSha256: sha(fsImpl.readFileSync(modulePath)),
      executionModuleSha256: sha(fsImpl.readFileSync(executionModulePath)), cliSha256: sha(fsImpl.readFileSync(cliPath)) };
  }
  function inventory() {
    fail(fsImpl.existsSync(beatDir), 'PHASE3_B009_ANIMATION_BEAT_DIRECTORY_MISSING');
    const stat = fsImpl.lstatSync(beatDir); fail(stat.isDirectory() && !stat.isSymbolicLink(), 'PHASE3_B009_ANIMATION_BEAT_DIRECTORY_INVALID');
    return fsImpl.readdirSync(beatDir).sort();
  }
  function validateFileSet({ allowLock = false } = {}) {
    const expected = [SOURCE_FILES.authorization, SOURCE_FILES.ledger, SOURCE_FILES.output, SOURCE_FILES.receipt,
      SOURCE_FILES.result, LEGACY_AUTHORIZATION.path, FILES.authorization, FILES.ledger, FILES.raw, FILES.derivative, FILES.receipt,
      FILES.result, FILES.failure, ...(allowLock ? [FILES.lock] : [])].map(item => path.posix.basename(item)).sort();
    const actual = inventory();
    const required = expected.filter(name => name !== path.posix.basename(LEGACY_AUTHORIZATION.path)
      && name !== path.posix.basename(FILES.authorization)
      && name !== path.posix.basename(FILES.ledger) && name !== path.posix.basename(FILES.raw)
      && name !== path.posix.basename(FILES.derivative) && name !== path.posix.basename(FILES.receipt)
      && name !== path.posix.basename(FILES.result) && name !== path.posix.basename(FILES.failure)
      && name !== path.posix.basename(FILES.lock));
    fail(required.every(name => actual.includes(name)), 'PHASE3_B009_ANIMATION_SOURCE_FILE_SET_INVALID');
    const known = new Set(expected);
    fail(actual.every(name => known.has(name)), 'PHASE3_B009_ANIMATION_UNKNOWN_FILE');
    return actual;
  }
  function exactHistoricalFailure(bytes) {
    fail(Buffer.isBuffer(bytes) && sha(bytes) === recoveryTrust.failureSha256,
      'PHASE3_B009_ANIMATION_RECOVERY_FAILURE_RECEIPT_MISMATCH');
    let receipt;
    try { receipt = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('PHASE3_B009_ANIMATION_RECOVERY_FAILURE_RECEIPT_INVALID'); }
    const expected = { schemaVersion: FAILURE_SCHEMA, status: 'FAILED', runId: RUN_ID, beatId: BEAT_ID,
      operation: OPERATION, requestKey: ANIMATION_REQUEST_KEY, failureStage: 'AFTER_RESERVATION',
      reservationCount: 1, providerRequestCount: 1, ledgerSha256: recoveryTrust.ledgerSha256,
      errorCode: 'PHASE3_B009_ANIMATION_RAW_VIDEO_NOT_FRAME_ALIGNED', recordedAt: recoveryTrust.expectedFailureAt,
      retryAllowed: false, fallbackAllowed: false, assetClass: ASSET_CLASS };
    fail(Object.entries(expected).every(([key, value]) => canonicalJson(receipt[key]) === canonicalJson(value)),
    'PHASE3_B009_ANIMATION_RECOVERY_FAILURE_RECEIPT_INVALID');
    return receipt;
  }
  function assertNoRelatedProcesses() {
    const currentPid = process.pid;
    const active = processScanner().filter(item => item.pid !== currentPid).some(item => {
      const args = String(item.args || '');
      return (args.includes(RUN_ID) && (args.includes('--generate-calibration-animation')
        || args.includes('--recover-calibration-animation') || args.includes('phase3-media-calibration-animation')))
        || ((/ffmpeg|ffprobe/iu.test(args)) && args.includes(beatDir));
    });
    fail(!active, 'PHASE3_B009_ANIMATION_RECOVERY_PROCESS_ACTIVE');
  }
  function assertRecoverableState(ctx, { allowLock = false } = {}) {
    fail(ctx.requestKey === ANIMATION_REQUEST_KEY, 'PHASE3_B009_ANIMATION_RECOVERY_REQUEST_KEY_MISMATCH');
    const names = inventory();
    const sourceNames = ['authorization', 'ledger', 'output', 'receipt', 'result']
      .map(key => path.posix.basename(SOURCE_FILES[key]));
    const expected = [...sourceNames, path.posix.basename(LEGACY_AUTHORIZATION.path),
      path.posix.basename(FILES.authorization), path.posix.basename(FILES.ledger),
      path.posix.basename(FILES.raw), path.posix.basename(FILES.failure),
      ...(allowLock ? [path.posix.basename(FILES.lock)] : [])].sort();
    fail(canonicalJson(names) === canonicalJson(expected), 'PHASE3_B009_ANIMATION_RECOVERY_FILE_SET_INVALID');
    for (const name of names) {
      const stat = fsImpl.lstatSync(path.join(beatDir, name));
      fail(stat.isFile() && !stat.isSymbolicLink(), 'PHASE3_B009_ANIMATION_RECOVERY_FILE_TYPE_INVALID');
    }
    fail(!allowLock || fsImpl.existsSync(file('lock')), 'PHASE3_B009_ANIMATION_RECOVERY_LOCK_MISSING');
    fail(allowLock || !fsImpl.existsSync(file('lock')), 'PHASE3_B009_ANIMATION_LOCK_ACTIVE');
    if (allowLock) {
      const lockPath = file('lock'), lockStat = fsImpl.lstatSync(lockPath);
      const lock = readJson(lockPath, fsImpl);
      fail(lockStat.isFile() && !lockStat.isSymbolicLink() && lock.pid === process.pid
        && lock.runId === RUN_ID && lock.beatId === BEAT_ID
        && lock.operation === 'RECOVER_EXISTING_PROVIDER_OUTPUT'
        && lock.requestKey === ANIMATION_REQUEST_KEY
        && typeof lock.createdAt === 'string' && Number.isFinite(Date.parse(lock.createdAt))
        && new Date(lock.createdAt).toISOString() === lock.createdAt,
      'PHASE3_B009_ANIMATION_RECOVERY_LOCK_INVALID');
    }
    const authBytes = fsImpl.readFileSync(file('authorization'));
    fail(sha(authBytes) === recoveryTrust.authorizationSha256, 'PHASE3_B009_ANIMATION_RECOVERY_AUTHORIZATION_MISMATCH');
    const authorization = JSON.parse(authBytes.toString('utf8'));
    validateAnimationAuthorization(authorization, recoveryTrust.authorizationSha256, {
      requestKey: ANIMATION_REQUEST_KEY,
      runtimeHashes: { animationWorkflowSha256: authorization.bindings?.animationWorkflowSha256,
        executionModuleSha256: authorization.bindings?.executionModuleSha256,
        cliSha256: authorization.bindings?.cliSha256 },
    }, authBytes);
    const ledgerBytes = fsImpl.readFileSync(file('ledger'));
    fail(sha(ledgerBytes) === recoveryTrust.ledgerSha256, 'PHASE3_B009_ANIMATION_RECOVERY_LEDGER_MISMATCH');
    const ledger = readLedger(file('ledger'), fsImpl);
    fail(ledger.length === 1, 'PHASE3_B009_ANIMATION_RECOVERY_RESERVATION_STATE_INVALID');
    const reservation = ledger[0];
    fail(reservation.recordType === 'SUBMISSION_RESERVED' && reservation.sequence === 1
      && reservation.runId === RUN_ID && reservation.beatId === BEAT_ID && reservation.operation === OPERATION
      && reservation.endpoint === ENDPOINT && reservation.requestKey === ANIMATION_REQUEST_KEY
      && reservation.authorizationSha256 === recoveryTrust.authorizationSha256
      && reservation.sourceStillSha256 === SOURCE_STILL_SHA256
      && reservation.sourceStillApprovalSha256 === SOURCE_STILL_APPROVAL_SHA256
      && reservation.stagedIndexSha256 === PACKAGE.stagedIndexSha256
      && reservation.retriesAllowed === false && reservation.fallbackAllowed === false
      && reservation.reservedAt === recoveryTrust.expectedReservationAt,
    'PHASE3_B009_ANIMATION_RECOVERY_RESERVATION_BINDING_INVALID');
    const failureBytes = fsImpl.readFileSync(file('failure'));
    const failure = exactHistoricalFailure(failureBytes);
    fail(failure.ledgerSha256 === sha(ledgerBytes) && failure.reservationCount === 1
      && failure.providerRequestCount === 1, 'PHASE3_B009_ANIMATION_RECOVERY_FAILURE_STATE_INVALID');
    const rawStat = fsImpl.lstatSync(file('raw')), raw = fsImpl.readFileSync(file('raw'));
    fail(rawStat.isFile() && !rawStat.isSymbolicLink() && raw.length === recoveryTrust.rawBytes
      && sha(raw) === recoveryTrust.rawSha256, 'PHASE3_B009_ANIMATION_RECOVERY_RAW_BINDING_INVALID');
    return { authorization, authorizationBytes: authBytes, reservation, ledgerBytes, ledger, failure,
      failureBytes, raw, rawStat };
  }
  function expectedAuth(record, ctx) {
    validateAnimationAuthorization(record, sha(fsImpl.readFileSync(file('authorization'))), {
      requestKey: ctx.requestKey, runtimeHashes: runtimeHashes() });
  }
  function status() {
    const ctx = inputContext();
    verifyStagedRunFiles({ runDir, fsImpl, currentRuntimeHashes: runtimeHashes() });
    const actual = validateFileSet({ allowLock: false });
    const authPresent = actual.includes(path.posix.basename(FILES.authorization));
    const legacyAuthPresent = actual.includes(path.posix.basename(LEGACY_AUTHORIZATION.path));
    let authorization = { present: authPresent, sha256: null, valid: false };
    if (authPresent) {
      const bytes = fsImpl.readFileSync(file('authorization')), record = JSON.parse(bytes.toString('utf8'));
      const hash = sha(bytes); validateAnimationAuthorization(record, hash,
        { requestKey: ctx.requestKey, runtimeHashes: runtimeHashes() }, bytes);
      authorization = { present: true, sha256: hash, valid: true };
    }
    const legacyAuthorization = { present: legacyAuthPresent,
      sha256: legacyAuthPresent ? sha(fsImpl.readFileSync(path.join(beatDir, path.posix.basename(LEGACY_AUTHORIZATION.path)))) : null,
      valid: legacyAuthPresent, auditOnly: legacyAuthPresent, consumed: false,
      superseded: authPresent };
    const ledger = readLedger(file('ledger'), fsImpl), lockPresent = fsImpl.existsSync(file('lock'));
    fail(!lockPresent, 'PHASE3_B009_ANIMATION_LOCK_ACTIVE');
    fail(ledger.length === 0 || ledger.length === 1 || ledger.length === 2, 'PHASE3_B009_ANIMATION_LEDGER_INCOMPLETE');
    if (ledger.length) fail(ledger[0].requestKey === ctx.requestKey, 'PHASE3_B009_ANIMATION_LEDGER_REQUEST_MISMATCH');
    const recoverable = ledger.length === 1 ? assertRecoverableState(ctx) : null;
    const rawExists = fsImpl.existsSync(file('raw')), derivativeExists = fsImpl.existsSync(file('derivative'));
    const receiptExists = fsImpl.existsSync(file('receipt')), resultExists = fsImpl.existsSync(file('result'));
    const failureExists = fsImpl.existsSync(file('failure'));
    fail([rawExists, derivativeExists, receiptExists, resultExists].every(Boolean) === (ledger.length === 2 && ledger[1].status === 'SUCCEEDED'),
      'PHASE3_B009_ANIMATION_TERMINAL_FILE_SET_INVALID');
    if (failureExists) {
      const recovered = ledger.length === 2 && ledger[1].status === 'SUCCEEDED' && receiptExists
        && readJson(file('receipt'), fsImpl).recovery?.failureReceiptSha256 === RECOVERY.failureSha256;
      fail(recoverable !== null || ledger.length === 2 && ledger[1].status === 'FAILED' || recovered,
        'PHASE3_B009_ANIMATION_FAILURE_FILE_SET_INVALID');
      if (recoverable || recovered) {
        const historicalFailure = exactHistoricalFailure(fsImpl.readFileSync(file('failure')));
        fail(historicalFailure.runId === RUN_ID && historicalFailure.requestKey === ctx.requestKey,
          'PHASE3_B009_ANIMATION_FAILURE_FILE_SET_INVALID');
      }
    }
    if (receiptExists) verifyCompleted(ctx);
    const next = routes.nextAuthorizationStep({ approvedOutputs: ['ACT1_B006/GENERATE_STILL',
      'ACT1_B009/GENERATE_ANIMATION_SOURCE_STILL'], submissions: 2,
      requestKeys: [mediaExecution.CALIBRATION_REQUEST_KEY, 'f10feb2552874270ce4af7705e5648e4beede07faedfa2a72072ba6633afdd02'] });
    return { schemaVersion: 'phase3-act1-b009-animation-calibration-status/1.0.0',
      status: ledger.length === 1 ? 'ANIMATION_RECOVERY_READY'
        : ledger.length === 2 ? (ledger[1].status === 'SUCCEEDED' ? 'ANIMATION_GENERATED_PENDING_HUMAN_REVIEW' : 'ANIMATION_FAILED_TERMINAL')
        : authorization.valid ? 'EXECUTION_AUTHORIZED_NOT_EXECUTED' : 'EXECUTION_READY_UNAUTHORIZED',
      runId: RUN_ID, beatId: BEAT_ID, operation: OPERATION, endpoint: ENDPOINT, model: MODEL,
      requestKey: ctx.requestKey, requestKeyDerivation: 'phase3-calibration-request-key/3.0.0 canonical JSON; binds exact route prompts/settings, source PNG SHA-256, detached source-still approval SHA-256, and staged index SHA-256',
      promptSha256: ctx.prompt.promptSha256, negativeInstructionsSha256: ctx.prompt.negativePromptSha256,
      sourceStill: { path: SOURCE_FILES.output, bytes: SOURCE_STILL_BYTES, sha256: SOURCE_STILL_SHA256,
        approvalSha256: ctx.approval.sha256, receiptSha256: SOURCE_STILL_RECEIPT_SHA256,
        authorizationSha256: SOURCE_STILL_AUTH_SHA256 },
      bindings: { stagedIndexSha256: PACKAGE.stagedIndexSha256, candidateIndexSha256: PACKAGE.candidateIndexSha256,
        outerIndexSha256: PACKAGE.outerIndexSha256, routeBundleSha256: ROUTE_BUNDLE_SHA256,
        routeResolutionApprovalSha256: ROUTE_APPROVAL_SHA256, reconciliationSha256: B009_RECONCILIATION_SHA256,
        b006ApprovalSha256: B006_APPROVAL_SHA256, stage04ActivationRecordSha256: STAGE04_ACTIVATION_SHA256,
        stage04LedgerBaselineSha256: STAGE04_LEDGER_SHA256 },
      authorization, legacyAuthorization, ledgerEntries: ledger.length,
      reservationCount: ledger.filter(x => x.recordType === 'SUBMISSION_RESERVED').length,
      terminalResultCount: ledger.filter(x => x.recordType === 'SUBMISSION_RESULT').length,
      providerRequests: ledger.filter(x => x.recordType === 'SUBMISSION_RESERVED').length,
      remainingPilotSubmissions: next.remainingSubmissions, maximumPilotSubmissions: 3,
      retries: 0, fallback: false, lockPresent, rawOutputPresent: rawExists, derivativePresent: derivativeExists,
      receiptPresent: receiptExists, failureReceiptPresent: failureExists,
      recoveryReady: Boolean(recoverable), assetClass: ASSET_CLASS,
      ownershipDisposition: OWNERSHIP, productionReadiness: 'REJECTED', rendering: false, promotion: false,
      episodeRootWrites: false };
  }
  function preflight() {
    const current = status();
    fail(current.status === 'EXECUTION_READY_UNAUTHORIZED' || current.status === 'EXECUTION_AUTHORIZED_NOT_EXECUTED',
      'PHASE3_B009_ANIMATION_NOT_READY');
    return { schemaVersion: 'phase3-act1-b009-animation-calibration-preflight/1.0.0', status: current.status,
      runId: RUN_ID, beatId: BEAT_ID, operation: OPERATION, requestKey: current.requestKey,
      endpoint: ENDPOINT, model: MODEL, parameters: { ...routes.H3_MAX, target_audio_url: 'NOT_SENT' },
      promptSha256: current.promptSha256, negativeInstructionsSha256: current.negativeInstructionsSha256,
      expectedPublishedChargeUsd: EXPECTED_CHARGE_USD, maximumHumanAcceptedExposureUsd: MAX_EXPOSURE_USD,
      exposureProviderEnforced: false, maximumProviderSubmissions: 1, retries: 0, fallback: false,
      totalPilotSubmissions: 2, remainingPilotSubmissions: current.remainingPilotSubmissions,
      sourceStill: current.sourceStill, derivative: { fps: TARGET_FPS, frames: TARGET_FRAMES,
        durationSeconds: TARGET_DURATION_SECONDS, audioStreams: 0, classification: ASSET_CLASS,
        productionReadiness: 'REJECTED' }, authorizationRequired: true,
      providerRequests: 0, reservations: 0, episodeRootWrites: 0 };
  }
  function verifyCompleted(ctx) {
    const raw = fsImpl.readFileSync(file('raw')), derivative = fsImpl.readFileSync(file('derivative'));
    const receiptBytes = fsImpl.readFileSync(file('receipt')), receipt = readJson(file('receipt'), fsImpl);
    const resultBytes = fsImpl.readFileSync(file('result')), result = readJson(file('result'), fsImpl);
    const ledgerRows = readLedger(file('ledger'), fsImpl);
    const recovery = receipt.recovery || null;
    verifySelfBound(receipt, 'receiptBindingSha256', 'PHASE3_B009_ANIMATION_RECEIPT_BINDING_INVALID');
    verifySelfBound(result, 'resultBindingSha256', 'PHASE3_B009_ANIMATION_RESULT_BINDING_INVALID');
    fail(receipt.status === 'ANIMATION_GENERATED_PENDING_HUMAN_REVIEW' && receipt.runId === RUN_ID
      && receipt.beatId === BEAT_ID && receipt.requestKey === ctx.requestKey
      && receipt.assetClass === ASSET_CLASS && receipt.sourceStillSha256 === SOURCE_STILL_SHA256
      && receipt.sourceStillApprovalSha256 === SOURCE_STILL_APPROVAL_SHA256
      && receipt.rawOutput?.sha256 === sha(raw) && receipt.rawOutput?.bytes === raw.length
      && receipt.derivative?.sha256 === sha(derivative) && receipt.derivative?.bytes === derivative.length
      && receipt.derivative?.video.frameCount === TARGET_FRAMES && receipt.derivative?.video.fps === TARGET_FPS
      && receipt.derivative?.audioStreamCount === 0
      && receipt.ledgerSha256 === sha(Buffer.from(`${JSON.stringify(ledgerRows[0])}\n`, 'utf8'))
      && ledgerRows.length === 2 && ledgerRows[0].recordType === 'SUBMISSION_RESERVED'
      && ledgerRows[0].requestKey === ctx.requestKey && ledgerRows[1].recordType === 'SUBMISSION_RESULT'
      && ledgerRows[1].requestKey === ctx.requestKey && ledgerRows[1].status === 'SUCCEEDED'
      && ledgerRows[1].rawOutputSha256 === sha(raw) && ledgerRows[1].derivativeSha256 === sha(derivative)
      && (!recovery || recovery.schemaVersion === 'phase3-b009-animation-offline-recovery/1.0.0'
        && recovery.status === 'RECOVERED_EXISTING_PROVIDER_OUTPUT'
        && recovery.authorizationSha256 === recoveryTrust.authorizationSha256
        && recovery.originalLedgerSha256 === recoveryTrust.ledgerSha256
        && recovery.failureReceiptSha256 === recoveryTrust.failureSha256
        && recovery.rawOutputSha256 === recoveryTrust.rawSha256 && recovery.rawOutputBytes === recoveryTrust.rawBytes
        && recovery.rawFps === RECOVERY.sourceFps && recovery.rawFrames === RECOVERY.sourceFrames
        && recovery.frameRateFilter === 'fps=30:round=near' && recovery.targetFps === TARGET_FPS
        && recovery.targetFrames === TARGET_FRAMES && recovery.providerRequestsDuringRecovery === 0
        && recovery.newReservations === 0 && recovery.providerSubmissionCount === 1
        && recovery.retries === 0 && recovery.fallbacks === 0)
      && result.status === 'SUCCEEDED' && result.receiptSha256 === sha(receiptBytes)
      && result.rawOutputSha256 === sha(raw) && result.derivativeSha256 === sha(derivative)
      && result.ledgerSha256 === sha(fsImpl.readFileSync(file('ledger')))
      && result.reservationEntrySha256 === ledgerRows[0].entrySha256
      && result.resultEntrySha256 === ledgerRows[1].entrySha256
      && result.resultBindingSha256 === sha(Buffer.from(canonicalJson(Object.fromEntries(Object.entries(result)
        .filter(([key]) => key !== 'resultBindingSha256'))), 'utf8')),
    'PHASE3_B009_ANIMATION_OUTPUT_BINDING_INVALID');
    return { receipt, receiptBytes, raw, derivative };
  }
  function acquireLock(requestKey, operation = OPERATION) {
    const lockPath = file('lock'); let fd, created = false;
    try { fd = fsImpl.openSync(lockPath, 'wx', 0o600); created = true; fsImpl.writeSync(fd, `${JSON.stringify({ pid: process.pid,
      runId: RUN_ID, beatId: BEAT_ID, operation, requestKey, createdAt: now() })}\n`); fsImpl.fsyncSync(fd); }
    catch (error) { if (created) { try { fsImpl.unlinkSync(lockPath); } catch (_) {} }
      if (error?.code === 'EEXIST') throw new Error('PHASE3_B009_ANIMATION_LOCK_EXISTS'); throw error; }
    finally { if (fd !== undefined) fsImpl.closeSync(fd); }
    return lockPath;
  }
  async function generate({ expectedAuthorizationSha256 } = {}) {
    const before = preflight();
    fail(/^[a-f0-9]{64}$/u.test(expectedAuthorizationSha256 || '') && before.status === 'EXECUTION_AUTHORIZED_NOT_EXECUTED',
      'PHASE3_B009_ANIMATION_EXECUTION_AUTHORIZATION_REQUIRED');
    const ctx = inputContext(), authBytes = fsImpl.readFileSync(file('authorization'));
    const auth = JSON.parse(authBytes.toString('utf8'));
    validateAnimationAuthorization(auth, expectedAuthorizationSha256,
      { requestKey: ctx.requestKey, runtimeHashes: runtimeHashes() });
    fail(sha(authBytes) === expectedAuthorizationSha256, 'PHASE3_B009_ANIMATION_AUTHORIZATION_HASH_MISMATCH');
    const lockPath = acquireLock(before.requestKey); let reservation = null, providerInvoked = false, providerRequestId = null, actualChargeUsd = null;
    try {
      const ctxLocked = inputContext();
      const actual = validateFileSet({ allowLock: true });
      const expected = [...actual].sort();
      fail(expected.includes(path.posix.basename(FILES.lock)) && actual.length === expected.length,
        'PHASE3_B009_ANIMATION_RUN_FILE_SET_INVALID');
      const ledgerPath = file('ledger'); fail(readLedger(ledgerPath, fsImpl).length === 0,
        'PHASE3_B009_ANIMATION_REQUEST_ALREADY_CONSUMED');
      if (testHooks.beforeReservation) await testHooks.beforeReservation();
      reservation = appendLedger(ledgerPath, { recordType: 'SUBMISSION_RESERVED', sequence: 1, runId: RUN_ID,
        beatId: BEAT_ID, operation: OPERATION, endpoint: ENDPOINT, requestKey: ctxLocked.requestKey,
        authorizationSha256: expectedAuthorizationSha256, sourceStillSha256: SOURCE_STILL_SHA256,
        sourceStillApprovalSha256: SOURCE_STILL_APPROVAL_SHA256, stagedIndexSha256: PACKAGE.stagedIndexSha256,
        retriesAllowed: false, fallbackAllowed: false, reservedAt: now() }, fsImpl);
      if (testHooks.afterReservation) await testHooks.afterReservation({ reservation });
      const imageUrl = `data:image/png;base64,${ctxLocked.sourceBytes.toString('base64')}`;
      const input = { image_url: imageUrl, prompt: ctxLocked.prompt.prompt, ...routes.H3_MAX };
      fail(!Object.prototype.hasOwnProperty.call(input, 'target_audio_url'), 'PHASE3_B009_TARGET_AUDIO_MUST_NOT_BE_SENT');
      providerInvoked = true;
      const response = await provider.generateAnimation({ endpoint: ENDPOINT, input });
      providerRequestId = response.requestId || null; actualChargeUsd = Number.isFinite(response.actualChargeUsd) ? response.actualChargeUsd : null;
      fail(actualChargeUsd === null || actualChargeUsd <= MAX_EXPOSURE_USD, 'PHASE3_B009_ANIMATION_EXPOSURE_EXCEEDED');
      const rawBytes = Buffer.from(await downloader(response.url));
      fail(rawBytes.length > 0 && rawBytes.length <= 512 * 1024 * 1024, 'PHASE3_B009_ANIMATION_RAW_OUTPUT_INVALID');
      atomicExclusive(file('raw'), rawBytes, fsImpl);
      const rawMetadata = ffprobe(file('raw'));
      fail(rawMetadata.videoStreamCount === 1 && Number.isFinite(rawMetadata.durationSeconds)
        && rawMetadata.durationSeconds > 0 && rawMetadata.video?.width > 0 && rawMetadata.video?.height > 0,
      'PHASE3_B009_ANIMATION_RAW_PROBE_INVALID');
      const fitted = fitSilentDerivative({ inputPath: file('raw'), outputPath: file('derivative'), ffmpeg, ffprobe, fsImpl });
      const derivativeBytes = fsImpl.readFileSync(file('derivative'));
      const ledgerBeforeTerminal = fsImpl.readFileSync(ledgerPath);
      const receiptBody = { status: 'ANIMATION_GENERATED_PENDING_HUMAN_REVIEW', runId: RUN_ID, beatId: BEAT_ID,
        operation: OPERATION, requestKey: ctxLocked.requestKey, authorizationSha256: expectedAuthorizationSha256,
        sourceStillSha256: SOURCE_STILL_SHA256, sourceStillApprovalSha256: SOURCE_STILL_APPROVAL_SHA256,
        routeBundleSha256: ROUTE_BUNDLE_SHA256, routeResolutionApprovalSha256: ROUTE_APPROVAL_SHA256,
        promptSha256: ctxLocked.prompt.promptSha256, negativeInstructionsSha256: ctxLocked.prompt.negativePromptSha256,
        parameters: { ...routes.H3_MAX, target_audio_url: 'NOT_SENT' },
        provider: { name: 'fal.ai', requestId: providerRequestId, actualChargeUsd,
          responseMetadata: response.responseMetadata || null },
        rawOutput: { path: path.posix.basename(FILES.raw), bytes: rawBytes.length, sha256: sha(rawBytes), ...rawMetadata },
        derivative: { path: path.posix.basename(FILES.derivative), bytes: derivativeBytes.length,
          sha256: sha(derivativeBytes), ...fitted.metadata },
        ffmpegArguments: fitted.args, reservationEntrySha256: reservation.entrySha256,
        ledgerSha256: sha(ledgerBeforeTerminal), assetClass: ASSET_CLASS, ownershipDisposition: OWNERSHIP,
        productionReadiness: 'REJECTED', retries: 0, fallback: false, completedAt: now() };
      const receipt = selfBound(RECEIPT_SCHEMA, receiptBody, 'receiptBindingSha256');
      atomicExclusive(file('receipt'), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), fsImpl);
      const terminal = appendLedger(ledgerPath, { recordType: 'SUBMISSION_RESULT', sequence: 2, runId: RUN_ID,
        beatId: BEAT_ID, operation: OPERATION, requestKey: ctxLocked.requestKey, status: 'SUCCEEDED',
        retryCount: 0, fallbackUsed: false, providerRequestId, actualChargeUsd, rawOutputSha256: sha(rawBytes),
        derivativeSha256: sha(derivativeBytes), receiptSha256: sha(fsImpl.readFileSync(file('receipt'))), recordedAt: now() }, fsImpl);
      const result = selfBound(RESULT_SCHEMA, { status: 'SUCCEEDED', runId: RUN_ID, beatId: BEAT_ID,
        requestKey: ctxLocked.requestKey, receiptSha256: sha(fsImpl.readFileSync(file('receipt'))),
        rawOutputSha256: sha(rawBytes), derivativeSha256: sha(derivativeBytes), ledgerSha256: sha(fsImpl.readFileSync(ledgerPath)),
        reservationEntrySha256: reservation.entrySha256, resultEntrySha256: terminal.entrySha256,
        assetClass: ASSET_CLASS, productionReadiness: 'REJECTED', providerRequestId, actualChargeUsd }, 'resultBindingSha256');
      const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
      atomicExclusive(file('result'), resultBytes, fsImpl);
      return { status: 'ANIMATION_GENERATED_PENDING_HUMAN_REVIEW', requestKey: ctxLocked.requestKey,
        providerRequestId, actualChargeUsd, rawOutput: receipt.rawOutput, derivative: receipt.derivative };
    } catch (error) {
      if (reservation) {
        try { appendLedger(file('ledger'), { recordType: 'SUBMISSION_RESULT', sequence: 2, runId: RUN_ID,
          beatId: BEAT_ID, operation: OPERATION, requestKey: reservation.requestKey, status: 'FAILED',
          retryCount: 0, fallbackUsed: false, providerRequestId, actualChargeUsd,
          errorCode: String(error.message).split(':')[0], recordedAt: now() }, fsImpl); } catch (_) {}
      }
      const failure = selfBound(FAILURE_SCHEMA, { status: 'FAILED', runId: RUN_ID, beatId: BEAT_ID,
        operation: OPERATION, requestKey: reservation?.requestKey || before.requestKey,
        failureStage: reservation ? 'AFTER_RESERVATION' : providerInvoked ? 'PROVIDER_INVOKED' : 'BEFORE_RESERVATION',
        reservationCount: reservation ? 1 : 0, providerRequestCount: providerInvoked ? 1 : 0,
        ledgerSha256: fsImpl.existsSync(file('ledger')) ? sha(fsImpl.readFileSync(file('ledger'))) : null,
        errorCode: String(error.message).split(':')[0], recordedAt: now(), retryAllowed: false, fallbackAllowed: false,
        assetClass: ASSET_CLASS }, 'failureBindingSha256');
      try { atomicExclusive(file('failure'), Buffer.from(`${JSON.stringify(failure, null, 2)}\n`), fsImpl); } catch (_) {}
      throw error;
    } finally { try { if (fsImpl.existsSync(lockPath)) fsImpl.unlinkSync(lockPath); } catch (_) {} }
  }
  function recoverExistingProviderOutput() {
    const ctx = recoveryContext();
    assertRecoverableState(ctx);
    assertNoRelatedProcesses();
    const lockPath = acquireLock(ctx.requestKey, 'RECOVER_EXISTING_PROVIDER_OUTPUT');
    try {
      const lockedContext = recoveryContext();
      const locked = assertRecoverableState(lockedContext, { allowLock: true });
      assertNoRelatedProcesses();
      const rawBefore = sha(locked.raw);
      const rawMetadata = ffprobe(file('raw'));
      const frameTimestamps = ffprobeFrames(file('raw'));
      const fitted = fitSilentDerivative({ inputPath: file('raw'), outputPath: file('derivative'),
        ffmpeg, ffprobe, fsImpl, recoveryMode: true, frameTimestamps });
      const rawAfter = fsImpl.readFileSync(file('raw'));
      fail(rawAfter.length === recoveryTrust.rawBytes && sha(rawAfter) === rawBefore
        && rawBefore === recoveryTrust.rawSha256, 'PHASE3_B009_ANIMATION_RECOVERY_RAW_CHANGED');
      const derivativeBytes = fsImpl.readFileSync(file('derivative'));
      const ledgerPath = file('ledger'), beforeLedgerBytes = fsImpl.readFileSync(ledgerPath);
      fail(sha(beforeLedgerBytes) === recoveryTrust.ledgerSha256
        && sha(beforeLedgerBytes) === sha(locked.ledgerBytes), 'PHASE3_B009_ANIMATION_RECOVERY_LEDGER_CHANGED');
      const recovery = { schemaVersion: 'phase3-b009-animation-offline-recovery/1.0.0',
        status: 'RECOVERED_EXISTING_PROVIDER_OUTPUT', authorizationSha256: recoveryTrust.authorizationSha256,
        originalLedgerSha256: recoveryTrust.ledgerSha256, failureReceiptSha256: recoveryTrust.failureSha256,
        rawOutputSha256: recoveryTrust.rawSha256, rawOutputBytes: recoveryTrust.rawBytes,
        rawFps: RECOVERY.sourceFps, rawFrames: RECOVERY.sourceFrames,
        rawFrameTiming: 'CONSTANT_FRAME_RATE_VERIFIED_FROM_ALL_PRESENTATION_TIMESTAMPS',
        method: 'OFFLINE_FFMPEG_FPS_FILTER_NO_GENERATIVE_INTERPOLATION',
        frameRateFilter: 'fps=30:round=near', targetFps: TARGET_FPS, targetFrames: TARGET_FRAMES,
        targetDurationSeconds: TARGET_DURATION_SECONDS, audioRemoved: true,
        providerGenerationSucceeded: true, localFittingInitiallyFailed: true,
        providerRequestsDuringRecovery: 0, newReservations: 0, providerSubmissionCount: 1,
        retries: 0, fallbacks: 0, recoveredAt: now() };
      const receiptBody = { status: 'ANIMATION_GENERATED_PENDING_HUMAN_REVIEW', runId: RUN_ID, beatId: BEAT_ID,
        operation: OPERATION, requestKey: lockedContext.requestKey,
        authorizationSha256: recoveryTrust.authorizationSha256, sourceStillSha256: SOURCE_STILL_SHA256,
        sourceStillApprovalSha256: SOURCE_STILL_APPROVAL_SHA256, routeBundleSha256: ROUTE_BUNDLE_SHA256,
        routeResolutionApprovalSha256: ROUTE_APPROVAL_SHA256,
        promptSha256: lockedContext.prompt.promptSha256,
        negativeInstructionsSha256: lockedContext.prompt.negativePromptSha256,
        parameters: { ...routes.H3_MAX, target_audio_url: 'NOT_SENT' },
        provider: { name: 'fal.ai', requestId: null, actualChargeUsd: null,
          responseMetadata: { recoveredExistingProviderOutput: true, providerRequestId: null, actualChargeUsd: null } },
        rawOutput: { path: path.posix.basename(FILES.raw), bytes: rawAfter.length, sha256: rawBefore, ...rawMetadata },
        derivative: { path: path.posix.basename(FILES.derivative), bytes: derivativeBytes.length,
          sha256: sha(derivativeBytes), ...fitted.metadata },
        ffmpegArguments: fitted.args, reservationEntrySha256: locked.reservation.entrySha256,
        ledgerSha256: sha(beforeLedgerBytes), assetClass: ASSET_CLASS, ownershipDisposition: OWNERSHIP,
        productionReadiness: 'REJECTED', retries: 0, fallback: false, recovery, completedAt: now() };
      const receipt = selfBound(RECEIPT_SCHEMA, receiptBody, 'receiptBindingSha256');
      const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      atomicExclusive(file('receipt'), receiptBytes, fsImpl);
      const terminal = appendLedger(ledgerPath, { recordType: 'SUBMISSION_RESULT', sequence: 2, runId: RUN_ID,
        beatId: BEAT_ID, operation: OPERATION, requestKey: lockedContext.requestKey, status: 'SUCCEEDED',
        retryCount: 0, fallbackUsed: false, providerRequestId: null, actualChargeUsd: null,
        rawOutputSha256: rawBefore, derivativeSha256: sha(derivativeBytes), receiptSha256: sha(receiptBytes),
        recoveryMethod: recovery.method, providerSubmissionCount: 1, retries: 0, fallbacks: 0,
        recordedAt: now() }, fsImpl);
      const result = selfBound(RESULT_SCHEMA, { status: 'SUCCEEDED', runId: RUN_ID, beatId: BEAT_ID,
        requestKey: lockedContext.requestKey, receiptSha256: sha(receiptBytes), rawOutputSha256: rawBefore,
        derivativeSha256: sha(derivativeBytes), ledgerSha256: sha(fsImpl.readFileSync(ledgerPath)),
        reservationEntrySha256: locked.reservation.entrySha256, resultEntrySha256: terminal.entrySha256,
        assetClass: ASSET_CLASS, productionReadiness: 'REJECTED', providerRequestId: null, actualChargeUsd: null,
        recoveryMethod: recovery.method, providerSubmissionCount: 1, retries: 0, fallbacks: 0 }, 'resultBindingSha256');
      atomicExclusive(file('result'), Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8'), fsImpl);
      const verified = verifyCompleted(lockedContext);
      return { status: 'ANIMATION_GENERATED_PENDING_HUMAN_REVIEW', recovered: true,
        requestKey: lockedContext.requestKey, providerRequestId: null, actualChargeUsd: null,
        rawOutput: { path: FILES.raw, bytes: verified.raw.length, sha256: sha(verified.raw), ...rawMetadata },
        derivative: { path: FILES.derivative, bytes: verified.derivative.length,
          sha256: sha(verified.derivative), ...fitted.metadata },
        receiptSha256: sha(verified.receiptBytes), ledgerSha256: sha(fsImpl.readFileSync(ledgerPath)),
        providerRequestsDuringRecovery: 0, newReservations: 0, retries: 0, fallbacks: 0 };
    } finally { try { if (fsImpl.existsSync(lockPath)) fsImpl.unlinkSync(lockPath); } catch (_) {} }
  }
  function inspect() {
    const current = status(); fail(current.status === 'ANIMATION_GENERATED_PENDING_HUMAN_REVIEW',
      'PHASE3_B009_ANIMATION_OUTPUT_REQUIRED');
    const ctx = inputContext(); const complete = verifyCompleted(ctx);
    const rawProbe = ffprobe(file('raw')), fittedProbe = ffprobe(file('derivative'));
    routes.validateH3DerivativeMetadata({ videoStreamCount: fittedProbe.videoStreamCount,
      audioStreamCount: fittedProbe.audioStreamCount, fps: fittedProbe.video?.fps, frameCount: fittedProbe.video?.frameCount });
    return { schemaVersion: 'phase3-act1-b009-animation-inspection/1.0.0', status: current.status,
      runId: RUN_ID, beatId: BEAT_ID, requestKey: current.requestKey,
      rawOutput: { path: FILES.raw, bytes: complete.raw.length, sha256: sha(complete.raw), ...rawProbe },
      derivative: { path: FILES.derivative, bytes: complete.derivative.length, sha256: sha(complete.derivative), ...fittedProbe },
      receiptSha256: sha(complete.receiptBytes), ledgerSha256: sha(fsImpl.readFileSync(file('ledger'))),
      assetClass: ASSET_CLASS, productionReadiness: 'REJECTED', providerRequestsDuringInspection: 0,
      episodeRootWrites: 0, lockPresent: false };
  }
  return { status, preflight, generate, recoverExistingProviderOutput, inspect, inputContext, runtimeHashes,
    verifyStagedRunFiles: ({ runDir, fsImpl: verifierFs = fsImpl } = {}) =>
      verifyStagedRunFiles({ runDir, fsImpl: verifierFs, currentRuntimeHashes: runtimeHashes() }),
    makeAuthorizationTemplate: args => makeAuthorizationTemplate({ ...args, requestKey: inputContext().requestKey }),
    validateAuthorization: (record, expectedHash) => validateAnimationAuthorization(record, expectedHash,
      { requestKey: inputContext().requestKey, runtimeHashes: runtimeHashes() }),
    constants: { RUN_ID, BEAT_ID, OPERATION, ENDPOINT, AUTH_SCHEMA, FILES, SOURCE_STILL_APPROVAL_SHA256 } };
}

module.exports = { RUN_ID, BEAT_ID, OPERATION, ENDPOINT, MODEL, PACKAGE, SOURCE_STILL_SHA256,
  SOURCE_STILL_BYTES, SOURCE_STILL_AUTH_SHA256, SOURCE_STILL_RECEIPT_SHA256, SOURCE_STILL_LEDGER_SHA256,
  SOURCE_STILL_APPROVAL_SHA256, SOURCE_STILL_APPROVAL_PATH, B006_APPROVAL_SHA256,
  B009_RECONCILIATION_SHA256, STAGE04_ACTIVATION_SHA256, STAGE04_LEDGER_SHA256, ROUTE_BUNDLE_SHA256,
  ROUTE_APPROVAL_SHA256, AUTH_SCHEMA, LEDGER_SCHEMA, RECEIPT_SCHEMA, RESULT_SCHEMA, FAILURE_SCHEMA,
  ASSET_CLASS, OWNERSHIP, MAX_EXPOSURE_USD, EXPECTED_CHARGE_USD, TARGET_FPS, TARGET_FRAMES,
  TARGET_DURATION_SECONDS, RECOVERY, FILES, LEGACY_AUTHORIZATION, ANIMATION_REQUEST_KEY, sha, canonical, canonicalJson, deriveAnimationRequestKey,
  makeAuthorizationTemplate, validateAnimationAuthorization, verifyStagedRunFiles, fitSilentDerivative, probeVideo,
  probeFrameTimestamps, isConstantFrameRate, appendLedger, readLedger,
  createFalAnimationProvider, createB009AnimationWorkflow };
