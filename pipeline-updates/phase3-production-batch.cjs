'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const mediaExecution = require('./phase3-media-execution.cjs');

const CLOSURE_COMMIT = 'f4713564d86908a97a19f2ad8e6726f1dd25ada6';
const PACKAGE_INDEX_SHA256 = '9f60d89fc3009542b804e8fe1dd8c10af6a2d9f16554c85024e1cdad223e29de';
const PLAN_SHA256 = '2b7c8c6223b2ec3d4632ccd3f2c7a4ff8ad64c51b17de7fc97a0cca29eedcdf1';
const ANIMATION_APPROVAL_SHA256 = '78d7307c739050096aab2f8d723897b651151f93395323677ee3332c91d3f327';
const CALIBRATION_FINALIZATION_SHA256 = 'b426f68ce487a88c1a0bb783542b330ed6f7b3d0068e3d704a077f0a811b5c9c';
const CALIBRATION_VERDICT_SHA256 = '10cb46db5340754e737a8e4ebdd05679a380f51bef9c0e9c3b9b8944b939423b';
const B006_APPROVAL_SHA256 = 'd00ce391df1822468eb7fe2d07f85fc6404c483e1a79105c9e50aaa875c1dcd1';
const B009_SOURCE_APPROVAL_SHA256 = '8b2c41cff79bac73a89e22d80a953517091acaa98bc110d6447da06e835b548c';
const MAX_TOTAL_EXPOSURE_USD = 12;
const FLUX_MAX_COST_USD = 0.048;
const H3_MAX_COST_USD = 0.4;
const FIRST_BATCH_MAX_EXPOSURE_USD = 0.5;
const AUTH_SCHEMA = 'phase3-production-batch-execution-authorization/1.0.0';
const LEDGER_SCHEMA = 'phase3-production-batch-request-ledger/1.0.0';
const DECISION_SCHEMA = 'phase3-production-asset-review-decision/1.0.0';
const FIRST_BATCH_KEYS = Object.freeze([
  '8601e214c64e07bc6be1eb92ca57811f99d56adff5691ab46fe99002fbd8febd',
  '147e115a24f634da90798986ad673dc7ac1947cbbc90dbc95dd0c44a6e83c31f',
  '002d78a4380415db4947152a2d58f9b682abce3c4be02bf20f32c24b968269e2',
]);

function fail(ok, code) { if (!ok) throw new Error(code); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function safeRel(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0')
    && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}
function realFile(file, fsImpl = fs, code = 'PHASE3_PRODUCTION_FILE_INVALID') {
  fail(fsImpl.existsSync(file), code);
  const stat = fsImpl.lstatSync(file);
  fail(stat.isFile() && !stat.isSymbolicLink(), code);
  return stat;
}
function readJson(file, fsImpl = fs, code = 'PHASE3_PRODUCTION_JSON_INVALID') {
  realFile(file, fsImpl, code);
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch { throw new Error(code); }
}
function walk(root, fsImpl = fs, prefix = '') {
  if (!fsImpl.existsSync(root)) return [];
  const base = prefix ? path.join(root, ...prefix.split('/')) : root;
  const stat = fsImpl.lstatSync(base);
  fail(stat.isDirectory() && !stat.isSymbolicLink(), 'PHASE3_PRODUCTION_DIRECTORY_INVALID');
  const out = [];
  for (const name of fsImpl.readdirSync(base).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = path.join(base, name), item = fsImpl.lstatSync(full);
    fail(!item.isSymbolicLink(), `PHASE3_PRODUCTION_SYMLINK_FORBIDDEN:${rel}`);
    if (item.isDirectory()) out.push(...walk(root, fsImpl, rel));
    else { fail(item.isFile(), `PHASE3_PRODUCTION_FILE_TYPE_INVALID:${rel}`); out.push(rel); }
  }
  return out;
}
function atomicWrite(file, bytes, fsImpl = fs) {
  fail(!fsImpl.existsSync(file), 'PHASE3_PRODUCTION_OUTPUT_ALREADY_EXISTS');
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fsImpl.writeFileSync(temp, bytes, { flag: 'wx' });
    const fd = fsImpl.openSync(temp, 'r+');
    try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
    fsImpl.renameSync(temp, file);
  } catch (error) {
    try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch (_) {}
    throw error;
  }
}
function atomicJson(file, value, fsImpl = fs) {
  atomicWrite(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), fsImpl);
}
function packageFile(packageDirectory, relative) {
  fail(safeRel(relative), 'PHASE3_PRODUCTION_PACKAGE_PATH_INVALID');
  const target = path.resolve(packageDirectory, ...relative.split('/'));
  fail(target.startsWith(`${path.resolve(packageDirectory)}${path.sep}`), 'PHASE3_PRODUCTION_PACKAGE_PATH_INVALID');
  return target;
}
function verifyPlanningPackage({ packageDirectory, fsImpl = fs } = {}) {
  fail(path.basename(path.resolve(packageDirectory)) === 'phase3-production-batch-planning-20261006-v1',
    'PHASE3_PRODUCTION_PLANNING_PACKAGE_REQUIRED');
  const indexPath = path.join(packageDirectory, 'package-index.v1.json');
  const indexBytes = fsImpl.readFileSync(indexPath);
  fail(sha(indexBytes) === PACKAGE_INDEX_SHA256, 'PHASE3_PRODUCTION_PACKAGE_INDEX_HASH_MISMATCH');
  const index = JSON.parse(indexBytes.toString('utf8'));
  fail(index.status === 'PRODUCTION_BATCH_READY_EXECUTION_UNAUTHORIZED'
    && index.counts?.controlledStills === 34 && index.counts?.generatedStills === 8
    && index.counts?.animationClips === 23 && index.counts?.intermediateAnimationSourceStills === 23
    && index.counts?.finalOutputs === 65 && index.counts?.totalPlannedAssetsIncludingIntermediates === 88
    && index.counts?.externalProviderSubmissions === 54
    && index.proposedHumanExposureCeilingUsd === 12 && index.productionExecutionAuthorization === null,
  'PHASE3_PRODUCTION_PACKAGE_INDEX_CONTRACT_INVALID');
  fail(index.bindings?.humanValidationApprovalSha256 === ANIMATION_APPROVAL_SHA256
    && index.bindings?.finalizationSha256 === CALIBRATION_FINALIZATION_SHA256
    && index.bindings?.consolidatedVerdictSha256 === CALIBRATION_VERDICT_SHA256,
  'PHASE3_PRODUCTION_PACKAGE_APPROVAL_BINDING_INVALID');
  const seen = new Set();
  for (const item of index.files || []) {
    fail(safeRel(item.path) && !seen.has(item.path), 'PHASE3_PRODUCTION_PACKAGE_INDEX_PATH_INVALID');
    seen.add(item.path);
    const bytes = fsImpl.readFileSync(packageFile(packageDirectory, item.path));
    fail(bytes.length === item.bytes && sha(bytes) === item.sha256,
      `PHASE3_PRODUCTION_PACKAGE_FILE_MISMATCH:${item.path}`);
  }
  const actual = walk(packageDirectory, fsImpl).sort();
  fail(canonicalJson(actual) === canonicalJson(['package-index.v1.json', ...seen].sort()),
    'PHASE3_PRODUCTION_PACKAGE_UNKNOWN_OR_MISSING_FILE');
  const planPath = packageFile(packageDirectory, 'production-batch-plan.v1.json');
  const planBytes = fsImpl.readFileSync(planPath);
  fail(sha(planBytes) === PLAN_SHA256, 'PHASE3_PRODUCTION_PLAN_HASH_MISMATCH');
  return { index, indexSha256: sha(indexBytes), plan: JSON.parse(planBytes.toString('utf8')),
    planSha256: sha(planBytes) };
}
function verifyHashBoundApproval(file, expectedHash, predicate, fsImpl = fs) {
  realFile(file, fsImpl, 'PHASE3_PRODUCTION_APPROVAL_MISSING');
  const bytes = fsImpl.readFileSync(file);
  fail(sha(bytes) === expectedHash, 'PHASE3_PRODUCTION_APPROVAL_HASH_MISMATCH');
  const record = JSON.parse(bytes.toString('utf8'));
  fail(predicate(record), 'PHASE3_PRODUCTION_APPROVAL_INVALID');
  return record;
}
function buildJobs(plan) {
  fail(plan.schemaVersion === 'phase3-production-batch-plan/1.0.0'
    && plan.status === 'PRODUCTION_BATCH_READY_EXECUTION_UNAUTHORIZED'
    && plan.authority?.productionExecutionAuthorization === null
    && plan.authority?.providerRequestsAuthorized === 0,
  'PHASE3_PRODUCTION_PLAN_AUTHORITY_INVALID');
  const groups = [
    ['CONTROLLED_STILL', plan.controlledStills, 34],
    ['GENERATED_STILL', plan.generatedStills, 8],
    ['ANIMATION_SOURCE_STILL', plan.animationSourceStills, 23],
    ['ANIMATION_CLIP', plan.animationClips, 23],
  ];
  const jobs = [], keys = new Set();
  for (const [type, rows, expected] of groups) {
    fail(Array.isArray(rows) && rows.length === expected, 'PHASE3_PRODUCTION_PLAN_CENSUS_INVALID');
    for (const row of rows) {
      fail(/^[A-Z0-9]+_B\d{3}$/u.test(row.beatId || '') && /^[a-f0-9]{64}$/u.test(row.requestKey || '')
        && !keys.has(row.requestKey) && safeRel(row.outputPath), 'PHASE3_PRODUCTION_REQUEST_INVALID');
      keys.add(row.requestKey);
      fail(sha(Buffer.from(row.prompt, 'utf8')) === row.promptSha256
        && sha(Buffer.from(row.negativePrompt, 'utf8')) === row.negativePromptSha256,
      'PHASE3_PRODUCTION_PROMPT_HASH_MISMATCH');
      if (type === 'CONTROLLED_STILL') fail(row.routeId === 'LOCAL_CONTROLLED_STILL'
        && row.externalProviderRequests === 0, 'PHASE3_PRODUCTION_CONTROLLED_ROUTE_INVALID');
      if (type === 'GENERATED_STILL' || type === 'ANIMATION_SOURCE_STILL')
        fail(row.routeId === 'FLUX3_STILL_1K_16X9' && row.externalProviderRequests === 1,
          'PHASE3_PRODUCTION_FLUX_ROUTE_INVALID');
      if (type === 'ANIMATION_CLIP') fail(row.routeId === 'H3_MAX_I2V_5S_768P'
        && row.externalProviderRequests === 1 && /^[a-f0-9]{64}$/u.test(row.sourceStillRequestKey || '')
        && Number.isSafeInteger(row.targetFrames) && row.targetFrames > 0
        && row.trimFrames - row.holdFrames === 150 - row.targetFrames
        && safeRel(row.rawOutputPath), 'PHASE3_PRODUCTION_ANIMATION_ROUTE_INVALID');
      jobs.push({ ...row, type, maximumCostUsd: type === 'ANIMATION_CLIP' ? H3_MAX_COST_USD
        : type === 'CONTROLLED_STILL' ? 0 : FLUX_MAX_COST_USD });
    }
  }
  fail(jobs.length === 88 && keys.size === 88, 'PHASE3_PRODUCTION_REQUEST_CENSUS_INVALID');
  for (const job of jobs.filter(item => item.type === 'ANIMATION_CLIP')) {
    const source = jobs.find(item => item.requestKey === job.sourceStillRequestKey);
    fail(source?.type === 'ANIMATION_SOURCE_STILL' && source.beatId === job.beatId,
      'PHASE3_PRODUCTION_ANIMATION_DEPENDENCY_INVALID');
  }
  return jobs;
}
function selectFirstBatch(jobs) {
  const jobsByKey = new Map(jobs.map(job => [job.requestKey, job]));
  const selected = FIRST_BATCH_KEYS.map(key => jobsByKey.get(key));
  fail(selected.every(Boolean) && selected[0].beatId === 'ACT1_B006' && selected[0].type === 'GENERATED_STILL'
    && selected[1].beatId === 'ACT1_B009' && selected[1].type === 'ANIMATION_SOURCE_STILL'
    && selected[2].beatId === 'ACT1_B009' && selected[2].type === 'ANIMATION_CLIP'
    && selected[2].sourceStillRequestKey === selected[1].requestKey,
  'PHASE3_PRODUCTION_FIRST_BATCH_INVALID');
  const expectedCostUsd = selected.reduce((sum, item) => sum + item.maximumCostUsd, 0);
  fail(Math.abs(expectedCostUsd - 0.496) < 1e-9 && expectedCostUsd <= FIRST_BATCH_MAX_EXPOSURE_USD,
    'PHASE3_PRODUCTION_FIRST_BATCH_COST_INVALID');
  return { beatIds: ['ACT1_B006', 'ACT1_B009'], requestKeys: [...FIRST_BATCH_KEYS], jobs: selected,
    requestCounts: { generatedStills: 1, animationSourceStills: 1, animationClips: 1, total: 3 },
    dependencyOrder: [FIRST_BATCH_KEYS[0], FIRST_BATCH_KEYS[1], FIRST_BATCH_KEYS[2]],
    expectedCostUsd, maximumExposureUsd: FIRST_BATCH_MAX_EXPOSURE_USD,
    deferred: [{ beatId: 'ACT1_B005', reason: 'APPROVED_SOURCE_OR_CONSTRUCTION_CONTRACT_UNRESOLVED' }] };
}
function firstBatchAuthorizationStatement() {
  return `Yakubu Moshood authorizes the bounded Empire Omitted V3 Phase 3 production batch comprising exactly three provider submissions: ACT1_B006 generated still request key ${FIRST_BATCH_KEYS[0]}, ACT1_B009 animation source still request key ${FIRST_BATCH_KEYS[1]}, and, only after that source still is inspected and approved, ACT1_B009 animation request key ${FIRST_BATCH_KEYS[2]}. Maximum human-accepted exposure is USD 0.50; this ceiling is not provider-enforced. Zero retries, zero fallback, no request-key reuse, no rendering, no promotion, no Stage04 modification, and no writes to episode production paths are authorized.`;
}
function runtimeHashes({ modulePath = __filename,
  cliPath = path.resolve(__dirname, '..', 'scripts', 'phase3-production-batch.cjs'), fsImpl = fs } = {}) {
  return { moduleSha256: sha(fsImpl.readFileSync(modulePath)), cliSha256: sha(fsImpl.readFileSync(cliPath)) };
}
function genericAuthorizationStatement(requestKeys, maximumExposureUsd) {
  return `Yakubu Moshood authorizes exactly the following Empire Omitted V3 Phase 3 production request keys as one tightly bounded review batch: ${requestKeys.join(', ')}. Maximum human-accepted exposure is USD ${maximumExposureUsd.toFixed(2)}; this ceiling is not provider-enforced. Zero retries, zero fallback, no request-key reuse, no rendering, no promotion, no Stage04 modification, and no writes to episode production paths are authorized.`;
}
function makeAuthorizationTemplate({ requestKeys, authorizedAt, runtime, maximumExposureUsd = null } = {}) {
  fail(Array.isArray(requestKeys) && requestKeys.length > 0 && requestKeys.length <= 10
    && requestKeys.every(key => /^[a-f0-9]{64}$/u.test(key)) && new Set(requestKeys).size === requestKeys.length,
  'PHASE3_PRODUCTION_AUTHORIZATION_KEYS_INVALID');
  fail(typeof authorizedAt === 'string' && new Date(authorizedAt).toISOString() === authorizedAt,
    'PHASE3_PRODUCTION_AUTHORIZED_AT_INVALID');
  const first = canonicalJson(requestKeys) === canonicalJson(FIRST_BATCH_KEYS);
  const maximum = first ? FIRST_BATCH_MAX_EXPOSURE_USD : maximumExposureUsd;
  fail(Number.isFinite(maximum) && maximum >= 0 && maximum <= MAX_TOTAL_EXPOSURE_USD,
    'PHASE3_PRODUCTION_AUTHORIZATION_EXPOSURE_INVALID');
  return { schemaVersion: AUTH_SCHEMA, status: 'AUTHORIZED_FOR_BOUNDED_PRODUCTION_BATCH_EXECUTION',
    approvedBy: 'Yakubu Moshood', authorizedAt,
    authorizationStatement: first ? firstBatchAuthorizationStatement()
      : genericAuthorizationStatement(requestKeys, maximum),
    bindings: { closureCommit: CLOSURE_COMMIT, packageIndexSha256: PACKAGE_INDEX_SHA256,
      planSha256: PLAN_SHA256, candidateIndexSha256: mediaExecution.CANDIDATE_INDEX_SHA256,
      outerCandidatePackageIndexSha256: mediaExecution.OUTER_INDEX_SHA256,
      stage04ActivationRecordSha256: mediaExecution.STAGE04_ACTIVATION_SHA256,
      deployedModuleSha256: runtime.moduleSha256, deployedCliSha256: runtime.cliSha256,
      requestKeys: [...requestKeys] }, limits: { maximumProviderSubmissions: requestKeys.length,
      maximumHumanAcceptedExposureUsd: maximum, providerEnforced: false,
      retries: 0, fallback: false, requestKeyReuse: false },
    denials: { rendering: true, promotion: true, stage04Modification: true,
      episodeProductionPathWrites: true, automaticExecution: true } };
}
function validateAuthorization(record, { expectedSha256, bytes, runtime } = {}) {
  fail(sha(bytes) === expectedSha256, 'PHASE3_PRODUCTION_AUTHORIZATION_HASH_MISMATCH');
  const expected = makeAuthorizationTemplate({ requestKeys: record?.bindings?.requestKeys,
    authorizedAt: record?.authorizedAt, runtime,
    maximumExposureUsd: record?.limits?.maximumHumanAcceptedExposureUsd });
  fail(canonicalJson(record) === canonicalJson(expected), 'PHASE3_PRODUCTION_AUTHORIZATION_INVALID');
  return true;
}
function pngInfo(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fail(Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.subarray(0, 8).equals(signature)
    && bytes.toString('ascii', 12, 16) === 'IHDR', 'PHASE3_PRODUCTION_OUTPUT_NOT_PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mimeType: 'image/png' };
}
function probeVideo(file, { execFile = execFileSync } = {}) {
  const parsed = JSON.parse(execFile('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format',
    '-of', 'json', file], { encoding: 'utf8', windowsHide: true }));
  const videos = parsed.streams.filter(stream => stream.codec_type === 'video');
  const audios = parsed.streams.filter(stream => stream.codec_type === 'audio');
  const rate = value => { const [n, d] = String(value || '0/1').split('/').map(Number); return d ? n / d : n; };
  const video = videos[0];
  return { container: parsed.format?.format_name || '', durationSec: Number(parsed.format?.duration),
    videoStreams: videos.length, audioStreams: audios.length, video: video ? { codec: video.codec_name,
      width: Number(video.width), height: Number(video.height), fps: rate(video.avg_frame_rate || video.r_frame_rate),
      frames: Number(video.nb_read_frames || video.nb_frames) } : null };
}
function fitAnimation({ rawPath, outputPath, targetFrames, ffprobe = probeVideo, ffmpeg = spawnSync, fsImpl = fs } = {}) {
  const raw = ffprobe(rawPath);
  fail(raw.videoStreams === 1 && raw.audioStreams <= 1 && raw.video?.width > 0 && raw.video?.height > 0
    && Number.isFinite(raw.durationSec) && raw.durationSec > 0, 'PHASE3_PRODUCTION_RAW_VIDEO_INVALID');
  const temp = `${outputPath}.tmp-${crypto.randomBytes(8).toString('hex')}.mp4`;
  fsImpl.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = ['-hide_banner', '-nostdin', '-y', '-i', rawPath, '-map', '0:v:0', '-an',
    '-vf', 'fps=30:round=near,tpad=stop_mode=clone:stop_duration=10', '-frames:v', String(targetFrames),
    '-fps_mode', 'cfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', temp];
  try {
    const result = ffmpeg('ffmpeg', args, { encoding: 'utf8', windowsHide: true, shell: false });
    fail(result?.status === 0 && fsImpl.existsSync(temp), 'PHASE3_PRODUCTION_FFMPEG_FAILED');
    const fitted = ffprobe(temp);
    fail(fitted.videoStreams === 1 && fitted.audioStreams === 0 && fitted.video?.codec === 'h264'
      && fitted.video.width === 1344 && fitted.video.height === 768 && fitted.video.fps === 30
      && fitted.video.frames === targetFrames && Math.abs(fitted.durationSec - targetFrames / 30) < 0.001,
    'PHASE3_PRODUCTION_FITTED_VIDEO_INVALID');
    fail(!fsImpl.existsSync(outputPath), 'PHASE3_PRODUCTION_OUTPUT_ALREADY_EXISTS');
    fsImpl.renameSync(temp, outputPath);
    return { raw, fitted, ffmpegArgs: args };
  } catch (error) { try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch (_) {} throw error; }
}
async function download(url, { fetchImpl = fetch, maximumBytes = 512 * 1024 * 1024 } = {}) {
  let parsed; try { parsed = new URL(url); } catch { throw new Error('PHASE3_PRODUCTION_DOWNLOAD_URL_INVALID'); }
  fail(parsed.protocol === 'https:' && !parsed.username && !parsed.password
    && (parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media')
      || parsed.hostname === 'storage.googleapis.com' || parsed.hostname.endsWith('.googleusercontent.com')),
  'PHASE3_PRODUCTION_DOWNLOAD_HOST_FORBIDDEN');
  const response = await fetchImpl(parsed, { redirect: 'error' });
  fail(response.ok, 'PHASE3_PRODUCTION_DOWNLOAD_FAILED');
  const bytes = Buffer.from(await response.arrayBuffer());
  fail(bytes.length > 0 && bytes.length <= maximumBytes, 'PHASE3_PRODUCTION_DOWNLOAD_SIZE_INVALID');
  return { bytes, contentType: response.headers.get('content-type') || '' };
}
function createFalProvider({ loader = () => require('@fal-ai/client'), credentials = () => process.env.FAL_KEY } = {}) {
  async function invoke(endpoint, input, kind) {
    const key = credentials(); fail(Boolean(key), 'PHASE3_PRODUCTION_PROVIDER_CREDENTIAL_MISSING');
    const { fal } = loader(); fal.config({ credentials: key, retry: { maxRetries: 0, retryableStatusCodes: [] } });
    const response = await fal.subscribe(endpoint, { input, logs: false });
    const data = response?.data || {};
    const asset = kind === 'still' ? data.images?.[0] : data.video || data.videos?.[0];
    fail(typeof asset?.url === 'string' && asset.url, 'PHASE3_PRODUCTION_PROVIDER_RESPONSE_INVALID');
    return { url: asset.url, contentType: asset.content_type || null,
      providerRequestId: response.request_id || data.request_id || null,
      actualChargeUsd: Number.isFinite(data.actual_cost_usd) ? data.actual_cost_usd : null,
      metadata: { requestId: response.request_id || data.request_id || null,
        actualCostUsd: Number.isFinite(data.actual_cost_usd) ? data.actual_cost_usd : null,
        contentType: asset.content_type || null } };
  }
  return { generateStill: input => invoke('blackforestlabs/flux-3/text-to-image', input, 'still'),
    generateAnimation: input => invoke('minimax/h3-max/image-to-video', input, 'animation') };
}
function ledgerPath(workRoot) { return path.join(workRoot, 'request-ledger.jsonl'); }
function readLedger(workRoot, fsImpl = fs) {
  const file = ledgerPath(workRoot); if (!fsImpl.existsSync(file)) return [];
  realFile(file, fsImpl, 'PHASE3_PRODUCTION_LEDGER_INVALID');
  let previousEntrySha256 = null;
  const rows = fsImpl.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let row; try { row = JSON.parse(line); } catch { throw new Error(`PHASE3_PRODUCTION_LEDGER_JSON_INVALID:${index + 1}`); }
    const supplied = row.entrySha256, body = { ...row }; delete body.entrySha256;
    fail(row.schemaVersion === LEDGER_SCHEMA && row.sequence === index + 1
      && row.previousEntrySha256 === previousEntrySha256
      && supplied === sha(Buffer.from(canonicalJson(body), 'utf8')),
      `PHASE3_PRODUCTION_LEDGER_CHAIN_INVALID:${index + 1}`);
    previousEntrySha256 = supplied;
    return row;
  });
  const reservations = rows.filter(row => row.recordType === 'SUBMISSION_RESERVED');
  fail(new Set(reservations.map(row => row.requestKey)).size === reservations.length,
    'PHASE3_PRODUCTION_DUPLICATE_REQUEST_KEY');
  for (const reservation of reservations) fail(rows.filter(row => row.recordType === 'SUBMISSION_RESULT'
    && row.requestKey === reservation.requestKey).length <= 1, 'PHASE3_PRODUCTION_DUPLICATE_RESULT');
  return rows;
}
function appendLedger(workRoot, record, fsImpl = fs) {
  fsImpl.mkdirSync(workRoot, { recursive: true });
  const existing = readLedger(workRoot, fsImpl);
  const body = { schemaVersion: LEDGER_SCHEMA, sequence: existing.length + 1,
    previousEntrySha256: existing.length ? existing.at(-1).entrySha256 : null, ...record };
  const row = { ...body, entrySha256: sha(Buffer.from(canonicalJson(body), 'utf8')) };
  fsImpl.appendFileSync(ledgerPath(workRoot), `${JSON.stringify(row)}\n`, { flag: 'a' });
  const fd = fsImpl.openSync(ledgerPath(workRoot), 'a'); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
  return row;
}
function requestDirectory(workRoot, requestKey) {
  fail(/^[a-f0-9]{64}$/u.test(requestKey || ''), 'PHASE3_PRODUCTION_REQUEST_KEY_INVALID');
  const result = path.resolve(workRoot, 'requests', requestKey);
  fail(result.startsWith(`${path.resolve(workRoot)}${path.sep}`), 'PHASE3_PRODUCTION_WRITE_PATH_FORBIDDEN');
  return result;
}
function assertKnownWorkFiles(workRoot, jobs, fsImpl = fs) {
  if (!fsImpl.existsSync(workRoot)) return true;
  const stat = fsImpl.lstatSync(workRoot);
  fail(stat.isDirectory() && !stat.isSymbolicLink(), 'PHASE3_PRODUCTION_WORK_ROOT_INVALID');
  const knownNames = new Set(['operation.lock', 'provider-response.json', 'raw-provider-output.png',
    'raw-controlled-input.png', 'raw-provider-output.mp4', 'output.png', 'fitted-output.mp4',
    'receipt.json', 'terminal-result.json', 'inspection.json', 'decision.json']);
  const keys = new Set(jobs.map(job => job.requestKey));
  for (const rel of walk(workRoot, fsImpl)) {
    if (rel === 'request-ledger.jsonl') continue;
    const parts = rel.split('/');
    const knownTemporary = [...knownNames].some(name => parts[2]?.startsWith(`${name}.tmp-`)
      && /^[a-f0-9]{16}(?:\.mp4)?$/u.test(parts[2].slice(`${name}.tmp-`.length)));
    fail(parts.length === 3 && parts[0] === 'requests' && keys.has(parts[1])
      && (knownNames.has(parts[2]) || knownTemporary), `PHASE3_PRODUCTION_UNKNOWN_FILE:${rel}`);
  }
  return true;
}
function createProductionBatchWorkflow({ packageDirectory, candidatePackageDirectory, artifactRoot,
  episodeRoot, workRoot, fsImpl = fs, verifyStage04Fn = mediaExecution.verifyStage04,
  activationRunner, provider = createFalProvider(), downloader = download, ffprobe = probeVideo,
  ffmpeg = spawnSync, now = () => new Date().toISOString(), modulePath = __filename,
  cliPath = path.resolve(__dirname, '..', 'scripts', 'phase3-production-batch.cjs'),
  pidProbe = process.kill.bind(process), testHooks = {} } = {}) {
  function authoritative() {
    fail(path.resolve(workRoot) === path.resolve(episodeRoot, '.review', 'phase3-production-batch-v1'),
      'PHASE3_PRODUCTION_WORK_ROOT_FORBIDDEN');
    const planning = verifyPlanningPackage({ packageDirectory, fsImpl });
    const jobs = buildJobs(planning.plan), firstBatch = selectFirstBatch(jobs);
    mediaExecution.verifyOuterPackage({ packageDirectory: candidatePackageDirectory, fsImpl });
    verifyHashBoundApproval(path.join(artifactRoot, 'phase3-act1-b006-calibration-human-approval-20261005.v1.json'),
      B006_APPROVAL_SHA256, record => record.approvedBy === 'Yakubu Moshood' || record.reviewer === 'Yakubu Moshood', fsImpl);
    verifyHashBoundApproval(path.join(artifactRoot, 'phase3-act1-b009-source-still-human-approval-20261005.v2.json'),
      B009_SOURCE_APPROVAL_SHA256, record => record.approvedBy === 'Yakubu Moshood' || record.reviewer === 'Yakubu Moshood', fsImpl);
    verifyHashBoundApproval(path.join(artifactRoot, 'phase3-act1-b009-animation-human-validation-approval-20261006.v1.json'),
      ANIMATION_APPROVAL_SHA256, record => record.approvedBy === 'Yakubu Moshood' || record.reviewer === 'Yakubu Moshood', fsImpl);
    const stage04 = verifyStage04Fn({ episodeRoot, fsImpl, runner: activationRunner });
    fail(stage04.recordSha256 === mediaExecution.STAGE04_ACTIVATION_SHA256 && stage04.promotedPathCount === 147
      && stage04.requestLedgerSha256 === mediaExecution.REQUEST_LEDGER_SHA256,
    'PHASE3_PRODUCTION_STAGE04_BINDING_INVALID');
    assertKnownWorkFiles(workRoot, jobs, fsImpl);
    const byKey = new Map(jobs.map(job => [job.requestKey, job]));
    for (const row of readLedger(workRoot, fsImpl)) {
      const job = byKey.get(row.requestKey);
      fail(job, 'PHASE3_PRODUCTION_LEDGER_REQUEST_KEY_UNKNOWN');
      if (row.recordType === 'SUBMISSION_RESERVED') fail(row.beatId === job.beatId
        && row.requestType === job.type && row.routeId === job.routeId
        && row.maximumCostUsd === job.maximumCostUsd && row.retriesAllowed === 0
        && row.fallbackAllowed === false,
      'PHASE3_PRODUCTION_LEDGER_RESERVATION_INVALID');
    }
    return { planning, jobs, firstBatch, stage04 };
  }
  function jobContext(requestKey) {
    const state = authoritative(), job = state.jobs.find(item => item.requestKey === requestKey);
    fail(job, 'PHASE3_PRODUCTION_REQUEST_KEY_UNKNOWN');
    return { ...state, job, dir: requestDirectory(workRoot, requestKey) };
  }
  function decisionFor(requestKey) {
    const file = path.join(requestDirectory(workRoot, requestKey), 'decision.json');
    if (!fsImpl.existsSync(file)) return null;
    const record = readJson(file, fsImpl, 'PHASE3_PRODUCTION_DECISION_INVALID');
    fail(record.schemaVersion === DECISION_SCHEMA && record.requestKey === requestKey
      && ['APPROVED', 'REJECTED'].includes(record.status), 'PHASE3_PRODUCTION_DECISION_INVALID');
    return { record, sha256: sha(fsImpl.readFileSync(file)) };
  }
  function status() {
    const state = authoritative(), ledger = readLedger(workRoot, fsImpl);
    const requests = state.jobs.map(job => {
      const dir = requestDirectory(workRoot, job.requestKey), reservation = ledger.find(row => row.recordType === 'SUBMISSION_RESERVED'
        && row.requestKey === job.requestKey), result = ledger.find(row => row.recordType === 'SUBMISSION_RESULT'
        && row.requestKey === job.requestKey), decision = decisionFor(job.requestKey);
      return { requestKey: job.requestKey, beatId: job.beatId, type: job.type,
        status: decision?.record.status || result?.status || (reservation ? 'RESERVED_INTERRUPTED' : 'PENDING_AUTHORIZATION'),
        consumed: Boolean(reservation), isolatedDirectoryPresent: fsImpl.existsSync(dir) };
    });
    return { schemaVersion: 'phase3-production-batch-status/1.0.0',
      status: 'PRODUCTION_BATCH_EXECUTION_UNAUTHORIZED', packageIndexSha256: PACKAGE_INDEX_SHA256,
      closureCommit: CLOSURE_COMMIT, stage04: { status: state.stage04.record.status,
        activationRecordSha256: state.stage04.recordSha256, promotedPathCount: state.stage04.promotedPathCount },
      census: state.planning.index.counts, maximumTotalExposureUsd: MAX_TOTAL_EXPOSURE_USD,
      providerSubmissions: ledger.filter(row => row.recordType === 'SUBMISSION_RESERVED' && row.externalProviderRequest).length,
      consumedRequestKeys: ledger.filter(row => row.recordType === 'SUBMISSION_RESERVED').map(row => row.requestKey),
      firstBatch: state.firstBatch, requests };
  }
  function preflight({ firstBatchOnly = false } = {}) {
    const value = status(), selected = firstBatchOnly ? value.firstBatch.requestKeys : value.requests.map(row => row.requestKey);
    const selectedRows = value.requests.filter(row => selected.includes(row.requestKey));
    const clean = selectedRows.every(row => !row.consumed);
    return { schemaVersion: 'phase3-production-batch-preflight/1.0.0',
      status: firstBatchOnly && clean ? 'PRODUCTION_FIRST_BATCH_READY_EXECUTION_UNAUTHORIZED'
        : clean ? 'PRODUCTION_BATCH_READY_EXECUTION_UNAUTHORIZED' : 'PRODUCTION_BATCH_PARTIALLY_CONSUMED',
      packageIndexSha256: PACKAGE_INDEX_SHA256, planSha256: PLAN_SHA256, closureCommit: CLOSURE_COMMIT,
      stage04: value.stage04, census: value.census, selectedRequestKeys: selected,
      firstBatch: value.firstBatch, authorizationPresent: false, providerRequestsAuthorized: 0,
      providerSubmissions: value.providerSubmissions, mediaGeneratedByThisCommand: false,
      writesPerformed: 0, exactAuthorizationStatement: firstBatchOnly ? firstBatchAuthorizationStatement() : null };
  }
  function loadAuthorization(file, expectedSha256, requestKey) {
    fail(/^[a-f0-9]{64}$/u.test(expectedSha256 || ''), 'PHASE3_PRODUCTION_EXPECTED_AUTHORIZATION_HASH_REQUIRED');
    const bytes = fsImpl.readFileSync(file), record = JSON.parse(bytes.toString('utf8'));
    const runtime = runtimeHashes({ modulePath, cliPath, fsImpl });
    validateAuthorization(record, { expectedSha256, bytes, runtime });
    fail(record.bindings.requestKeys.includes(requestKey), 'PHASE3_PRODUCTION_REQUEST_NOT_AUTHORIZED');
    const state = authoritative();
    const authorizedJobs = record.bindings.requestKeys.map(key => state.jobs.find(job => job.requestKey === key));
    fail(authorizedJobs.every(Boolean), 'PHASE3_PRODUCTION_AUTHORIZATION_UNKNOWN_REQUEST_KEY');
    const requiredExposure = authorizedJobs.reduce((sum, job) => sum + job.maximumCostUsd, 0);
    fail(requiredExposure <= record.limits.maximumHumanAcceptedExposureUsd + 1e-9
      && record.limits.maximumHumanAcceptedExposureUsd <= MAX_TOTAL_EXPOSURE_USD,
    'PHASE3_PRODUCTION_AUTHORIZATION_COST_CEILING_INVALID');
    return { record, sha256: sha(bytes) };
  }
  function acquire(dir) {
    fsImpl.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'operation.lock');
    fail(!fsImpl.existsSync(file), 'PHASE3_PRODUCTION_LOCK_EXISTS');
    fsImpl.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' }); return file;
  }
  function recoverLockAndTemps(dir) {
    const lock = path.join(dir, 'operation.lock');
    if (fsImpl.existsSync(lock)) {
      const pid = Number(fsImpl.readFileSync(lock, 'utf8').trim());
      fail(Number.isSafeInteger(pid) && pid > 0, 'PHASE3_PRODUCTION_LOCK_INVALID');
      let alive = true;
      try { pidProbe(pid, 0); } catch (error) {
        if (error?.code === 'ESRCH') alive = false;
        else throw error;
      }
      fail(!alive, 'PHASE3_PRODUCTION_LOCK_ACTIVE');
      fsImpl.unlinkSync(lock);
    }
    for (const name of fsImpl.existsSync(dir) ? fsImpl.readdirSync(dir) : []) {
      if (name.includes('.tmp-')) fsImpl.unlinkSync(path.join(dir, name));
    }
  }
  function outputPaths(job, dir) {
    if (job.type === 'ANIMATION_CLIP') return { raw: path.join(dir, 'raw-provider-output.mp4'),
      output: path.join(dir, 'fitted-output.mp4') };
    return { raw: path.join(dir, job.type === 'CONTROLLED_STILL' ? 'raw-controlled-input.png' : 'raw-provider-output.png'),
      output: path.join(dir, 'output.png') };
  }
  function validateOutput(job, file) {
    const bytes = fsImpl.readFileSync(file);
    if (job.type !== 'ANIMATION_CLIP') {
      const info = pngInfo(bytes), expected = job.type === 'CONTROLLED_STILL' ? [1920, 1080] : [1360, 768];
      fail(info.width === expected[0] && info.height === expected[1], 'PHASE3_PRODUCTION_PNG_CONTRACT_INVALID');
      return { bytes: bytes.length, sha256: sha(bytes), ...info };
    }
    const info = ffprobe(file);
    fail(info.videoStreams === 1 && info.audioStreams === 0 && info.video?.codec === 'h264'
      && info.video.width === 1344 && info.video.height === 768 && info.video.fps === 30
      && info.video.frames === job.targetFrames, 'PHASE3_PRODUCTION_FITTED_VIDEO_INVALID');
    return { bytes: bytes.length, sha256: sha(bytes), ...info };
  }
  function assertDependencies(job) {
    if (job.type !== 'ANIMATION_CLIP') return null;
    const sourceDecision = decisionFor(job.sourceStillRequestKey);
    fail(sourceDecision?.record.status === 'APPROVED', 'PHASE3_PRODUCTION_APPROVED_SOURCE_REQUIRED');
    const sourceOutput = path.join(requestDirectory(workRoot, job.sourceStillRequestKey), 'output.png');
    const source = validateOutput({ type: 'ANIMATION_SOURCE_STILL' }, sourceOutput);
    fail(sourceDecision.record.outputSha256 === source.sha256, 'PHASE3_PRODUCTION_APPROVED_SOURCE_HASH_MISMATCH');
    return { path: sourceOutput, ...source };
  }
  function reserve(ctx, authorization, externalProviderRequest) {
    const ledger = readLedger(workRoot, fsImpl);
    fail(!ledger.some(row => row.recordType === 'SUBMISSION_RESERVED' && row.requestKey === ctx.job.requestKey),
      'PHASE3_PRODUCTION_REQUEST_KEY_ALREADY_CONSUMED');
    const reservedExposure = ledger.filter(row => row.recordType === 'SUBMISSION_RESERVED')
      .reduce((sum, row) => sum + Number(row.maximumCostUsd || 0), 0);
    fail(reservedExposure + ctx.job.maximumCostUsd <= MAX_TOTAL_EXPOSURE_USD + 1e-9,
      'PHASE3_PRODUCTION_COST_CEILING_EXCEEDED');
    return appendLedger(workRoot, { recordType: 'SUBMISSION_RESERVED', requestKey: ctx.job.requestKey,
      beatId: ctx.job.beatId, requestType: ctx.job.type, routeId: ctx.job.routeId,
      externalProviderRequest, maximumCostUsd: ctx.job.maximumCostUsd,
      authorizationSha256: authorization.sha256, packageIndexSha256: PACKAGE_INDEX_SHA256,
      retriesAllowed: 0, fallbackAllowed: false, reservedAt: now() }, fsImpl);
  }
  function terminalize(ctx, reservation, statusValue, details) {
    const result = appendLedger(workRoot, { recordType: 'SUBMISSION_RESULT', requestKey: ctx.job.requestKey,
      beatId: ctx.job.beatId, requestType: ctx.job.type, status: statusValue, retryCount: 0,
      fallbackUsed: false, ...details, recordedAt: now() }, fsImpl);
    atomicJson(path.join(ctx.dir, 'terminal-result.json'), { schemaVersion: 'phase3-production-request-result/1.0.0',
      status: statusValue, requestKey: ctx.job.requestKey, reservationEntrySha256: reservation.entrySha256,
      resultEntrySha256: result.entrySha256, ...details, recordedAt: now() }, fsImpl);
    return result;
  }
  async function materializeProviderOutput(ctx, response, source) {
    const paths = outputPaths(ctx.job, ctx.dir);
    if (!fsImpl.existsSync(paths.raw)) {
      const downloaded = await downloader(response.url, { requestKey: ctx.job.requestKey });
      atomicWrite(paths.raw, Buffer.from(downloaded.bytes), fsImpl);
    }
    let fit = null;
    if (ctx.job.type === 'ANIMATION_CLIP' && !fsImpl.existsSync(paths.output)) fit = fitAnimation({ rawPath: paths.raw,
      outputPath: paths.output, targetFrames: ctx.job.targetFrames, ffprobe, ffmpeg, fsImpl });
    if (ctx.job.type !== 'ANIMATION_CLIP' && !fsImpl.existsSync(paths.output))
      atomicWrite(paths.output, fsImpl.readFileSync(paths.raw), fsImpl);
    const output = validateOutput(ctx.job, paths.output);
    const rawBytes = fsImpl.readFileSync(paths.raw);
    return { paths, output, raw: { bytes: rawBytes.length, sha256: sha(rawBytes) }, fit,
      approvedSourceSha256: source?.sha256 || null };
  }
  async function generate({ requestKey, authorizationFile, expectedAuthorizationSha256 } = {}) {
    const ctx = jobContext(requestKey);
    fail(ctx.job.type !== 'CONTROLLED_STILL', 'PHASE3_PRODUCTION_CONTROLLED_STILL_REQUIRES_INGEST');
    const authorization = loadAuthorization(authorizationFile, expectedAuthorizationSha256, requestKey);
    const source = assertDependencies(ctx.job), lock = acquire(ctx.dir);
    let reservation = null, providerResponse = null;
    try {
      reservation = reserve(ctx, authorization, true);
      if (typeof testHooks.afterReservation === 'function') await testHooks.afterReservation({ ctx, reservation });
      if (ctx.job.type === 'ANIMATION_CLIP') {
        const imageUrl = `data:image/png;base64,${fsImpl.readFileSync(source.path).toString('base64')}`;
        providerResponse = await provider.generateAnimation({ image_url: imageUrl, prompt: ctx.job.prompt,
          duration: 5, resolution: '768P', prompt_expansion_mode: 'disabled', enable_safety_checker: true });
      } else providerResponse = await provider.generateStill({ prompt: ctx.job.prompt, resolution: '1k',
        aspect_ratio: '16:9', output_format: 'png', enable_prompt_expansion: false, num_images: 1 });
      fail(providerResponse && typeof providerResponse.url === 'string', 'PHASE3_PRODUCTION_PROVIDER_RESPONSE_INVALID');
      fail(providerResponse.actualChargeUsd === null || providerResponse.actualChargeUsd === undefined
        || providerResponse.actualChargeUsd <= ctx.job.maximumCostUsd + 1e-9,
      'PHASE3_PRODUCTION_PROVIDER_CHARGE_EXCEEDS_REQUEST_MAXIMUM');
      atomicJson(path.join(ctx.dir, 'provider-response.json'), providerResponse, fsImpl);
      const material = await materializeProviderOutput(ctx, providerResponse, source);
      const receipt = { schemaVersion: 'phase3-production-generation-receipt/1.0.0',
        status: 'GENERATED_PENDING_INSPECTION', requestKey, beatId: ctx.job.beatId, type: ctx.job.type,
        authorizationSha256: authorization.sha256, reservationEntrySha256: reservation.entrySha256,
        providerRequestId: providerResponse.providerRequestId || null,
        actualChargeUsd: providerResponse.actualChargeUsd ?? null, raw: material.raw, output: material.output,
        approvedSourceSha256: material.approvedSourceSha256, isolatedPlanOutputPath: ctx.job.outputPath,
        retries: 0, fallback: false, completedAt: now() };
      atomicJson(path.join(ctx.dir, 'receipt.json'), receipt, fsImpl);
      terminalize(ctx, reservation, 'SUCCEEDED_PENDING_INSPECTION', { outputSha256: material.output.sha256,
        rawOutputSha256: material.raw.sha256, receiptSha256: sha(fsImpl.readFileSync(path.join(ctx.dir, 'receipt.json'))),
        providerRequestId: providerResponse.providerRequestId || null,
        actualChargeUsd: providerResponse.actualChargeUsd ?? null, errorCode: null });
      return receipt;
    } catch (error) {
      if (reservation && !fsImpl.existsSync(path.join(ctx.dir, 'terminal-result.json'))) {
        try { terminalize(ctx, reservation, 'FAILED_REQUEST_KEY_CONSUMED', { outputSha256: null,
          rawOutputSha256: null, receiptSha256: null, providerRequestId: providerResponse?.providerRequestId || null,
          actualChargeUsd: providerResponse?.actualChargeUsd ?? null,
          errorCode: String(error.message || error).split(':')[0] }); } catch (_) {}
      }
      throw error;
    } finally { try { if (fsImpl.existsSync(lock)) fsImpl.unlinkSync(lock); } catch (_) {} }
  }
  function ingestControlled({ requestKey, inputFile, authorizationFile, expectedAuthorizationSha256 } = {}) {
    const ctx = jobContext(requestKey);
    fail(ctx.job.type === 'CONTROLLED_STILL', 'PHASE3_PRODUCTION_CONTROLLED_STILL_REQUIRED');
    fail(ctx.job.beatId !== 'ACT1_B005', 'PHASE3_PRODUCTION_ACT1_B005_DEFERRED_CONTRACT_UNRESOLVED');
    const authorization = loadAuthorization(authorizationFile, expectedAuthorizationSha256, requestKey);
    const bytes = fsImpl.readFileSync(inputFile), info = pngInfo(bytes);
    fail(info.width === 1920 && info.height === 1080, 'PHASE3_PRODUCTION_PNG_CONTRACT_INVALID');
    const lock = acquire(ctx.dir); let reservation;
    try {
      reservation = reserve(ctx, authorization, false);
      const paths = outputPaths(ctx.job, ctx.dir); atomicWrite(paths.raw, bytes, fsImpl); atomicWrite(paths.output, bytes, fsImpl);
      const receipt = { schemaVersion: 'phase3-production-generation-receipt/1.0.0',
        status: 'CONTROLLED_STILL_INGESTED_PENDING_INSPECTION', requestKey, beatId: ctx.job.beatId,
        type: ctx.job.type, authorizationSha256: authorization.sha256,
        reservationEntrySha256: reservation.entrySha256, raw: { bytes: bytes.length, sha256: sha(bytes) },
        output: { bytes: bytes.length, sha256: sha(bytes), ...info }, isolatedPlanOutputPath: ctx.job.outputPath,
        providerSubmissions: 0, completedAt: now() };
      atomicJson(path.join(ctx.dir, 'receipt.json'), receipt, fsImpl);
      terminalize(ctx, reservation, 'SUCCEEDED_PENDING_INSPECTION', { outputSha256: sha(bytes),
        rawOutputSha256: sha(bytes), receiptSha256: sha(fsImpl.readFileSync(path.join(ctx.dir, 'receipt.json'))),
        providerRequestId: null, actualChargeUsd: 0, errorCode: null });
      return receipt;
    } catch (error) {
      if (reservation && !fsImpl.existsSync(path.join(ctx.dir, 'terminal-result.json'))) {
        try { terminalize(ctx, reservation, 'FAILED_REQUEST_KEY_CONSUMED', { outputSha256: null,
          rawOutputSha256: null, receiptSha256: null, providerRequestId: null, actualChargeUsd: 0,
          errorCode: String(error.message || error).split(':')[0] }); } catch (_) {}
      }
      throw error;
    } finally { try { if (fsImpl.existsSync(lock)) fsImpl.unlinkSync(lock); } catch (_) {} }
  }
  function inspect({ requestKey } = {}) {
    const ctx = jobContext(requestKey), receiptFile = path.join(ctx.dir, 'receipt.json');
    const receipt = readJson(receiptFile, fsImpl, 'PHASE3_PRODUCTION_SUCCESS_RECEIPT_REQUIRED');
    const paths = outputPaths(ctx.job, ctx.dir), output = validateOutput(ctx.job, paths.output);
    const rawBytes = fsImpl.readFileSync(paths.raw), rawSha256 = sha(rawBytes);
    fail(receipt.output.sha256 === output.sha256 && receipt.raw?.sha256 === rawSha256,
      'PHASE3_PRODUCTION_RECEIPT_OUTPUT_MISMATCH');
    if (ctx.job.type === 'ANIMATION_CLIP') {
      const rawProbe = ffprobe(paths.raw);
      fail(rawProbe.videoStreams === 1 && rawProbe.audioStreams <= 1,
        'PHASE3_PRODUCTION_RAW_VIDEO_INVALID');
    }
    const report = { schemaVersion: 'phase3-production-asset-inspection/1.0.0',
      status: 'INSPECTION_PASS_PENDING_HUMAN_DECISION', requestKey, beatId: ctx.job.beatId,
      type: ctx.job.type, rawOutputSha256: rawSha256, output,
      receiptSha256: sha(fsImpl.readFileSync(receiptFile)),
      finalAssetValidation: 'PASS', integrationAuthorized: false, inspectedAt: now() };
    const file = path.join(ctx.dir, 'inspection.json');
    if (fsImpl.existsSync(file)) fail(canonicalJson(readJson(file, fsImpl)) === canonicalJson(report),
      'PHASE3_PRODUCTION_INSPECTION_ALREADY_EXISTS');
    else atomicJson(file, report, fsImpl);
    return report;
  }
  function recordDecision({ requestKey, decisionFile, expectedDecisionSha256, expectedStatus } = {}) {
    const ctx = jobContext(requestKey), inspectionFile = path.join(ctx.dir, 'inspection.json');
    const inspectionBytes = fsImpl.readFileSync(inspectionFile), inspection = JSON.parse(inspectionBytes.toString('utf8'));
    fail(inspection.status === 'INSPECTION_PASS_PENDING_HUMAN_DECISION', 'PHASE3_PRODUCTION_INSPECTION_REQUIRED');
    const bytes = fsImpl.readFileSync(decisionFile);
    fail(sha(bytes) === expectedDecisionSha256, 'PHASE3_PRODUCTION_DECISION_HASH_MISMATCH');
    const record = JSON.parse(bytes.toString('utf8'));
    fail(record.schemaVersion === DECISION_SCHEMA && record.status === expectedStatus
      && record.reviewedBy === 'Yakubu Moshood' && record.requestKey === requestKey
      && record.outputSha256 === inspection.output.sha256 && record.inspectionSha256 === sha(inspectionBytes),
    'PHASE3_PRODUCTION_DECISION_INVALID');
    atomicWrite(path.join(ctx.dir, 'decision.json'), bytes, fsImpl);
    return { status: expectedStatus, requestKey, decisionSha256: sha(bytes), integrationAuthorized: false };
  }
  async function recover({ requestKey } = {}) {
    const ctx = jobContext(requestKey), ledger = readLedger(workRoot, fsImpl);
    const reservation = ledger.find(row => row.recordType === 'SUBMISSION_RESERVED' && row.requestKey === requestKey);
    fail(reservation, 'PHASE3_PRODUCTION_RECOVERY_RESERVATION_REQUIRED');
    recoverLockAndTemps(ctx.dir);
    const lock = acquire(ctx.dir);
    try {
      const existingResult = ledger.find(row => row.recordType === 'SUBMISSION_RESULT' && row.requestKey === requestKey);
      if (existingResult) {
        const terminalFile = path.join(ctx.dir, 'terminal-result.json');
        if (!fsImpl.existsSync(terminalFile)) atomicJson(terminalFile, {
          schemaVersion: 'phase3-production-request-result/1.0.0', status: existingResult.status,
          requestKey, reservationEntrySha256: reservation.entrySha256,
          resultEntrySha256: existingResult.entrySha256, outputSha256: existingResult.outputSha256 || null,
          rawOutputSha256: existingResult.rawOutputSha256 || null,
          receiptSha256: existingResult.receiptSha256 || null,
          providerRequestId: existingResult.providerRequestId || null,
          actualChargeUsd: existingResult.actualChargeUsd ?? null,
          errorCode: existingResult.errorCode || null, recoveredAt: now() }, fsImpl);
        return { status: existingResult.status, requestKey, providerSubmissions: 0, recovered: true };
      }
      const responseFile = path.join(ctx.dir, 'provider-response.json');
      if (fsImpl.existsSync(responseFile)) {
        const response = readJson(responseFile, fsImpl), source = assertDependencies(ctx.job);
        const material = await materializeProviderOutput(ctx, response, source);
        const receiptFile = path.join(ctx.dir, 'receipt.json');
        let receipt;
        if (fsImpl.existsSync(receiptFile)) {
          receipt = readJson(receiptFile, fsImpl, 'PHASE3_PRODUCTION_RECEIPT_INVALID');
          fail(receipt.requestKey === requestKey && receipt.output?.sha256 === material.output.sha256
            && receipt.raw?.sha256 === material.raw.sha256,
          'PHASE3_PRODUCTION_RECEIPT_OUTPUT_MISMATCH');
        } else {
          receipt = { schemaVersion: 'phase3-production-generation-receipt/1.0.0',
            status: 'RECOVERED_PENDING_INSPECTION', requestKey, beatId: ctx.job.beatId, type: ctx.job.type,
            authorizationSha256: reservation.authorizationSha256, reservationEntrySha256: reservation.entrySha256,
            providerRequestId: response.providerRequestId || null, actualChargeUsd: response.actualChargeUsd ?? null,
            raw: material.raw, output: material.output, approvedSourceSha256: material.approvedSourceSha256,
            isolatedPlanOutputPath: ctx.job.outputPath, providerSubmissionsDuringRecovery: 0, recoveredAt: now() };
          atomicJson(receiptFile, receipt, fsImpl);
        }
        terminalize(ctx, reservation, 'SUCCEEDED_PENDING_INSPECTION', { outputSha256: material.output.sha256,
          rawOutputSha256: material.raw.sha256, receiptSha256: sha(fsImpl.readFileSync(receiptFile)),
          providerRequestId: response.providerRequestId || null, actualChargeUsd: response.actualChargeUsd ?? null,
          errorCode: null });
        return receipt;
      }
      terminalize(ctx, reservation, 'INTERRUPTED_UNKNOWN_PROVIDER_RESULT_REQUEST_KEY_CONSUMED', {
        outputSha256: null, rawOutputSha256: null, receiptSha256: null, providerRequestId: null,
        actualChargeUsd: null, errorCode: 'PROVIDER_RESULT_NOT_DURABLY_RECORDED' });
      return { status: 'INTERRUPTED_UNKNOWN_PROVIDER_RESULT_REQUEST_KEY_CONSUMED', requestKey,
        providerSubmissionsDuringRecovery: 0, retryAllowed: false };
    } finally { try { if (fsImpl.existsSync(lock)) fsImpl.unlinkSync(lock); } catch (_) {} }
  }
  return { status, preflight, generate, ingestControlled, inspect,
    approve: options => recordDecision({ ...options, expectedStatus: 'APPROVED' }),
    reject: options => recordDecision({ ...options, expectedStatus: 'REJECTED' }), recover,
    makeAuthorizationTemplate: args => makeAuthorizationTemplate({ ...args,
      runtime: runtimeHashes({ modulePath, cliPath, fsImpl }) }), firstBatchAuthorizationStatement };
}

module.exports = { CLOSURE_COMMIT, PACKAGE_INDEX_SHA256, PLAN_SHA256, ANIMATION_APPROVAL_SHA256,
  CALIBRATION_FINALIZATION_SHA256, CALIBRATION_VERDICT_SHA256, B006_APPROVAL_SHA256,
  B009_SOURCE_APPROVAL_SHA256, MAX_TOTAL_EXPOSURE_USD, FIRST_BATCH_MAX_EXPOSURE_USD, FIRST_BATCH_KEYS,
  AUTH_SCHEMA, LEDGER_SCHEMA, DECISION_SCHEMA, sha, canonicalJson, safeRel, verifyPlanningPackage,
  buildJobs, selectFirstBatch, firstBatchAuthorizationStatement, genericAuthorizationStatement,
  runtimeHashes, makeAuthorizationTemplate,
  validateAuthorization, pngInfo, probeVideo, fitAnimation, download, createFalProvider, readLedger,
  appendLedger, assertKnownWorkFiles, createProductionBatchWorkflow };
