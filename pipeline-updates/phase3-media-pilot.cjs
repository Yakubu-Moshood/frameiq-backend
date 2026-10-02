'use strict';

// Isolated, two-submission Phase 3 pilot. This module is deliberately inert on
// import: provider SDK and credentials are loaded only after every execution
// gate has passed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const WELLS_ROOT = path.resolve(__dirname, '..', 'artifacts', 'empire-omitted-v3', 'wells-fargo');
const V5_DIR_NAME = 'phase3-media-completion-review-20261002-v5';
const PILOT_PACKAGE_NAME = 'phase3-media-pilot-proposal-20261002-v1';
const TRUST = Object.freeze({
  v5Index: '2d7fae8b138b259f7e4917290cdae7489307b9055904817d1b69e4867935c8b0',
  proposal: '8a867a6b0a826d97207148ac094fbb7485ae6fe9b445979816c44acac202fb87',
  reviewJson: 'b6cd1067a3b440d39c2a6de8d8dc1ea2554ab71704bd0c7c5f24fff9eb05c68c',
  reviewMarkdown: '37dfe892e0993dec5675db2a36357543e9143693028608f07d45917333cdde33',
  reviewPdf: '407eab6e85b5e93b656c03b98daf3d801d3b1c450135eb3a94d32ef72c9e9260',
  editorialApproval: '99b14463be09903e53dfea68914d12faa6bff0be756f7fe5f3eef5cabcb72e7a',
  pilotIndex: '9cffcb0aea31bb29848be99799a0ae8035a6b57afd5298dda39222ef789b519b',
  pilotProposal: '3a7420ffd3474ef1d7e5e90b0a90c9b306a5181bfe1aa79a42138d0b9b491775',
  runId: 'phase3-media-pilot-01',
});
const SCHEMAS = Object.freeze({
  authorization: 'phase3-media-pilot-execution-authorization/1.0.0',
  ledger: 'phase3-media-pilot-request-ledger/1.0.0',
  stillReceipt: 'phase3-media-pilot-still-receipt/1.0.0',
  inspection: 'phase3-media-pilot-still-inspection/1.0.0',
  stillApproval: 'phase3-media-pilot-still-approval/1.0.0',
  animationReceipt: 'phase3-media-pilot-animation-receipt/1.0.0',
  finalReceipt: 'phase3-media-pilot-final-receipt/1.0.0',
});
const REQUESTS = Object.freeze({
  still: Object.freeze({ key: 'a74eaf05273a5de26cb8b442beab03a929f4af957730ca7502dc802c3d968130',
    model: 'blackforestlabs/flux-3/text-to-image', params: Object.freeze({ resolution: '1k', aspect_ratio: '16:9', output_format: 'png', enable_prompt_expansion: false }),
    usdPerImage: 0.024, promoEnds: '2026-10-08' }),
  animation: Object.freeze({ key: 'ece9c247c65ac876942b522d8549e7d8f46426a3853e96c2f0e02e993ebfff34',
    model: 'fal-ai/framepack', params: Object.freeze({ aspect_ratio: '16:9', resolution: '480p', num_frames: 150 }), usdPerSecond: 0.0333 }),
});
const PILOT_ASSET_CLASS = 'NON_PRODUCTION_DISPOSABLE_PILOT';
const MAX_SUBMISSIONS = 2;
const MAX_REMOTE_BYTES = 80 * 1024 * 1024;

function fail(ok, code) { if (!ok) throw new Error(code); }
function errorCode(error) {
  const code = String(error?.message || error).split(':')[0];
  return /^[A-Z][A-Z0-9_]{2,80}$/u.test(code) ? code : 'PILOT_OPERATION_FAILED';
}
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) { return JSON.stringify(value); }
function readJson(file, fsImpl) { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
function safeRel(rel) {
  fail(typeof rel === 'string' && rel.length > 0 && !path.isAbsolute(rel) && !rel.includes('\\')
    && !rel.split('/').some(part => !part || part === '.' || part === '..'), 'PILOT_PACKAGE_PATH_INVALID');
  return rel;
}
function assertRealFile(file, fsImpl) {
  const stat = fsImpl.lstatSync(file);
  fail(stat.isFile() && !stat.isSymbolicLink(), `PILOT_SYMLINK_OR_NONFILE:${path.basename(file)}`);
}
function strictTreeFiles(root, fsImpl = fs, prefix = '') {
  if (!prefix) { const st = fsImpl.lstatSync(root); fail(st.isDirectory() && !st.isSymbolicLink(), 'PILOT_PACKAGE_ROOT_INVALID'); }
  const out = [];
  for (const name of fsImpl.readdirSync(root).sort()) {
    const full = path.join(root, name), rel = prefix ? `${prefix}/${name}` : name, st = fsImpl.lstatSync(full);
    fail(!st.isSymbolicLink(), `PILOT_PACKAGE_SYMLINK:${rel}`);
    if (st.isDirectory()) out.push(...strictTreeFiles(full, fsImpl, rel));
    else { fail(st.isFile(), `PILOT_PACKAGE_SPECIAL_FILE:${rel}`); out.push(rel); }
  }
  return out;
}
function verifyIndexedDirectory(dir, indexName, expectedIndexHash, fsImpl = fs, detachedFiles = []) {
  const indexPath = path.join(dir, indexName); assertRealFile(indexPath, fsImpl);
  const indexBytes = fsImpl.readFileSync(indexPath);
  fail(hash(indexBytes) === expectedIndexHash, `PILOT_INDEX_HASH_MISMATCH:${indexName}`);
  const index = JSON.parse(indexBytes.toString('utf8'));
  fail(Array.isArray(index.files) && (index.indexedFileCount === undefined
    || index.indexedFileCount === index.files.length), `PILOT_INDEX_SCHEMA_INVALID:${indexName}`);
  const seen = new Set();
  for (const entry of index.files) {
    const rel = safeRel(entry.path); fail(!seen.has(rel), `PILOT_INDEX_DUPLICATE:${rel}`); seen.add(rel);
    const file = path.join(dir, ...rel.split('/')); assertRealFile(file, fsImpl);
    const bytes = fsImpl.readFileSync(file);
    fail(bytes.length === entry.bytes && hash(bytes) === entry.sha256, `PILOT_INDEX_FILE_MISMATCH:${rel}`);
  }
  const actual = strictTreeFiles(dir, fsImpl).filter(rel => rel !== indexName).sort();
  const allowedDetached = [...detachedFiles].sort();
  fail(canonical(actual) === canonical([...seen, ...allowedDetached].sort()), `PILOT_INDEX_FILE_SET_MISMATCH:${indexName}`);
  return { index, indexPath, indexBytes, entries: new Map(index.files.map(x => [x.path, x])) };
}
function verifyPlanningInputs({ v5Dir, editorialApprovalPath, pilotDir, fsImpl = fs,
  pins = TRUST }) {
  const detachedProposal = 'unsigned-approval-proposal.v5.json';
  const v5 = verifyIndexedDirectory(v5Dir, 'phase3-media-package-index.v5.json', pins.v5Index, fsImpl, [detachedProposal]);
  fail(v5.index.files.length === 49 && v5.index.packageId === 'phase3-media-completion-review-20261002-v5'
    && v5.index.executionEligible === false, 'PILOT_V5_PACKAGE_SCOPE_INVALID');
  const approvalBytes = fsImpl.readFileSync(editorialApprovalPath);
  fail(hash(approvalBytes) === pins.editorialApproval, 'PILOT_EDITORIAL_APPROVAL_HASH_MISMATCH');
  const approval = JSON.parse(approvalBytes.toString('utf8'));
  fail(approval.decision === 'APPROVED_FOR_PILOT_PLANNING_ONLY' && approval.reviewer === 'Yakubu Moshood'
    && approval.humanEditorialApprovalRecorded === true, 'PILOT_EDITORIAL_APPROVAL_INVALID');
  fail(approval.executionSignature === '' && approval.providerAuthorization === '', 'PILOT_APPROVAL_SCOPE_ESCALATED');
  const bound = approval.bindings || {};
  for (const [key, expected] of Object.entries({ packageIndex: pins.v5Index, unsignedApprovalProposal: pins.proposal,
    reviewJson: pins.reviewJson, reviewMarkdown: pins.reviewMarkdown, reviewPdf: pins.reviewPdf })) {
    fail(bound[key]?.sha256 === expected, `PILOT_APPROVAL_BINDING_MISMATCH:${key}`);
    fail(bound[key].path.startsWith(`${V5_DIR_NAME}/`) && !bound[key].path.slice(V5_DIR_NAME.length + 1).split('/').includes('..'),
      `PILOT_V5_BOUND_PATH_INVALID:${key}`);
    const rel = bound[key].path.slice(V5_DIR_NAME.length + 1), absolute = path.join(v5Dir, ...rel.split('/'));
    assertRealFile(absolute, fsImpl);
    const actualBytes = rel === 'phase3-media-package-index.v5.json' ? v5.indexBytes : fsImpl.readFileSync(absolute);
    if (key !== 'packageIndex' && key !== 'unsignedApprovalProposal') {
      const entry = v5.entries.get(rel);
      fail(entry && entry.sha256 === expected && entry.bytes === bound[key].bytes, `PILOT_V5_BOUND_FILE_MISMATCH:${key}`);
    }
    fail(actualBytes.length === bound[key].bytes && hash(actualBytes) === expected, `PILOT_V5_DETACHED_BOUND_FILE_MISMATCH:${key}`);
  }
  const pilot = verifyIndexedDirectory(pilotDir, 'package-index.json', pins.pilotIndex, fsImpl);
  fail(pilot.index.files.length === 2 && pilot.index.status === 'PROPOSED_UNSIGNED_NOT_AUTHORIZED_FOR_EXECUTION', 'PILOT_PACKAGE_SCOPE_INVALID');
  const proposalBytes = fsImpl.readFileSync(path.join(pilotDir, 'phase3-media-pilot-proposal.v1.json'));
  fail(hash(proposalBytes) === pins.pilotProposal && pilot.entries.get('phase3-media-pilot-proposal.v1.json')?.sha256 === pins.pilotProposal,
    'PILOT_PROPOSAL_HASH_MISMATCH');
  const proposal = JSON.parse(proposalBytes.toString('utf8'));
  fail(proposal.status === 'PROPOSED_UNSIGNED_NOT_AUTHORIZED_FOR_EXECUTION'
    && proposal.executionSignature === '' && proposal.providerAuthorization === '', 'PILOT_PROPOSAL_NOT_UNSIGNED');
  fail(proposal.packageBindings?.packageIndex === pins.v5Index && proposal.packageBindings?.approvalProposal === pins.proposal
    && proposal.packageBindings?.reviewJson === pins.reviewJson && proposal.packageBindings?.reviewMarkdown === pins.reviewMarkdown,
  'PILOT_PROPOSAL_V5_BINDING_MISMATCH');
  fail(proposal.requests?.length === 2 && proposal.requestReservation?.maxProviderRequests === MAX_SUBMISSIONS,
    'PILOT_REQUEST_COUNT_INVALID');
  const still = proposal.requests.find(r => r.kind === 'generated_still');
  const animation = proposal.requests.find(r => r.kind === 'animation_clip');
  fail(still?.beatId === 'ACT3_B005' && animation?.beatId === 'ACT3_B005', 'PILOT_BEAT_SCOPE_INVALID');
  for (const [request, expected, kind] of [[still, REQUESTS.still, 'still'], [animation, REQUESTS.animation, 'animation']]) {
    fail(request.provider === 'fal.ai' && request.model === expected.model && request.requestKey === expected.key
      && canonical(request.parameters) === canonical(expected.params), `PILOT_REQUEST_DRIFT:${kind}`);
    fail(request.maxAttempts === 1 && request.retry?.toLowerCase().includes('no retry'), `PILOT_RETRY_POLICY_INVALID:${kind}`);
  }
  fail(still.currentPublishedPrice?.usdPerImage === REQUESTS.still.usdPerImage
    && still.currentPublishedPrice?.qualifier?.includes(REQUESTS.still.promoEnds), 'PILOT_STILL_PRICE_ASSUMPTION_DRIFT');
  fail(animation.currentPublishedPrice?.usdPerSecond === REQUESTS.animation.usdPerSecond
    && proposal.cost?.publishedEstimatedUsd?.still === 0.024
    && proposal.cost?.publishedEstimatedUsd?.clipAtFiveSeconds === 0.1665
    && proposal.cost?.publishedEstimatedUsd?.totalAtFiveSeconds === 0.1905,
  'PILOT_CLIP_PRICE_ASSUMPTION_DRIFT');
  fail(proposal.cost?.capStatus?.includes('not confirmed as enforceable'), 'PILOT_FALSE_PRICE_CAP_CLAIM');
  fail(still.ownershipTerms?.outputOwnership?.includes('Not established')
    && animation.ownershipTerms?.outputOwnership?.includes('Not established'), 'PILOT_OWNERSHIP_BLOCKER_MISSING');
  return { v5IndexSha256: hash(v5.indexBytes), approvalSha256: hash(approvalBytes), pilotIndexSha256: hash(pilot.indexBytes),
    proposalSha256: hash(proposalBytes), v5, approval, pilot, proposal, still, animation };
}
function inside(base, target, pathImpl = path) {
  const rel = pathImpl.relative(base, target);
  return rel === '' || (!rel.startsWith(`..${pathImpl.sep}`) && rel !== '..' && !pathImpl.isAbsolute(rel));
}
function assertRunRoot(root, expectedRoot, fsImpl = fs) {
  const absolute = path.resolve(root), allowed = path.resolve(expectedRoot);
  fail(inside(allowed, absolute), 'PILOT_PATH_OUTSIDE_AUTHORIZED_ROOT');
  const missing = [];
  let cursor = absolute;
  while (cursor !== path.dirname(cursor) && !fsImpl.existsSync(cursor)) { missing.push(cursor); cursor = path.dirname(cursor); }
  for (const item of [cursor, ...missing.reverse()]) {
    if (!fsImpl.existsSync(item)) continue;
    const st = fsImpl.lstatSync(item); fail(!st.isSymbolicLink(), 'PILOT_PATH_SYMLINK_FORBIDDEN');
  }
}
function ensureInputsCopied(root, inputs, fsImpl) {
  const inputDir = path.join(root, 'inputs');
  if (!fsImpl.existsSync(inputDir)) fsImpl.mkdirSync(inputDir, { recursive: false });
  const indexed = [];
  for (const [name, bytes] of Object.entries(inputs)) {
    safeRel(name);
    const dest = path.join(inputDir, ...name.split('/'));
    fail(inside(inputDir, dest), 'PILOT_INPUT_PATH_ESCAPE');
    const parent = path.dirname(dest);
    if (!fsImpl.existsSync(parent)) fsImpl.mkdirSync(parent, { recursive: true });
    if (fsImpl.existsSync(dest)) fail(hash(fsImpl.readFileSync(dest)) === hash(bytes), `PILOT_INPUT_COPY_ALTERED:${name}`);
    else fsImpl.writeFileSync(dest, bytes, { flag: 'wx' });
    indexed.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  const indexBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 'phase3-media-pilot-input-index/1.0.0',
    files: indexed.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`);
  const indexPath = path.join(root, 'pilot-inputs-index.v1.json');
  if (fsImpl.existsSync(indexPath)) fail(hash(fsImpl.readFileSync(indexPath)) === hash(indexBytes), 'PILOT_INPUT_INDEX_MISMATCH');
  else writeBytesExclusive(indexPath, indexBytes, fsImpl);
  return { sha256: hash(indexBytes), files: indexed };
}
function loadDetachedExecutionAuthorization(root, planning, fsImpl, expectedSha256) {
  const file = path.join(root, 'execution-authorization.v1.json');
  fail(fsImpl.existsSync(file), 'PILOT_EXECUTION_AUTHORIZATION_MISSING');
  assertRealFile(file, fsImpl);
  const bytes = fsImpl.readFileSync(file);
  fail(/^[a-f0-9]{64}$/u.test(expectedSha256 || '') && hash(bytes) === expectedSha256,
    'PILOT_EXECUTION_AUTHORIZATION_HASH_MISMATCH');
  const record = JSON.parse(bytes.toString('utf8'));
  fail(record.schemaVersion === SCHEMAS.authorization && record.status === 'AUTHORIZED_FOR_EXECUTION'
    && record.approvedBy === 'Yakubu Moshood' && record.providerAuthorization && record.executionSignature,
  'PILOT_EXECUTION_AUTHORIZATION_INVALID');
  fail(record.bindings?.editorialApprovalSha256 === planning.approvalSha256
    && record.bindings?.pilotProposalSha256 === planning.proposalSha256
    && record.bindings?.v5PackageIndexSha256 === planning.v5IndexSha256
    && record.bindings?.pilotPackageIndexSha256 === planning.pilotIndexSha256, 'PILOT_EXECUTION_AUTHORIZATION_BINDING_MISMATCH');
  fail(record.maxProviderSubmissions === MAX_SUBMISSIONS && record.noRetry === true && record.noFallback === true,
    'PILOT_EXECUTION_LIMITS_INVALID');
  fail(record.outputOwnershipResolved === true && record.approvalRef && record.decision === 'AUTHORIZED_FOR_EXECUTION',
    'PILOT_OWNERSHIP_OR_DECISION_UNRESOLVED');
  fail(record.acceptsUnboundedAnimationExposure === true || record.enforcedMaximumChargeUsd >= 0,
    'PILOT_UNBOUNDED_COST_NOT_AUTHORIZED');
  const expected = planning.proposal.requests.map(r => ({ requestKey: r.requestKey, provider: r.provider, model: r.model,
    endpointId: r.model, parameters: r.parameters, prompt: r.prompt, negativePrompt: r.negativePrompt }));
  fail(canonical(record.authorizedRequests) === canonical(expected), 'PILOT_AUTHORIZED_REQUEST_DRIFT');
  const asOf = new Date(record.priceCheckedAt || 'invalid');
  fail(Number.isFinite(asOf.getTime()) && asOf.toISOString().slice(0, 10) <= REQUESTS.still.promoEnds,
    'PILOT_PRICE_ASSUMPTION_EXPIRED');
  fail(new Date().toISOString().slice(0, 10) <= REQUESTS.still.promoEnds, 'PILOT_PRICE_ASSUMPTION_EXPIRED');
  const requiredPriceAssumptions = { stillUsdPerImage: 0.024, stillPromotionEnds: '2026-10-08',
    animationUsdPerSecond: 0.0333, proposedCapUsd: 0.25, capProviderEnforced: false };
  fail(canonical(record.priceAssumptions) === canonical(requiredPriceAssumptions), 'PILOT_AUTHORIZED_PRICE_DRIFT');
  if (record.acceptsUnboundedAnimationExposure !== true) {
    fail(Number.isFinite(record.enforcedMaximumChargeUsd) && record.enforcedMaximumChargeUsd > 0
      && /^[a-f0-9]{64}$/u.test(record.billingControlSha256 || '') && record.billingControlProviderEnforced === true,
    'PILOT_COST_CONTROL_NOT_VERIFIED');
  }
  return { record, sha256: hash(bytes), file };
}
function readLedger(file, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return [];
  assertRealFile(file, fsImpl);
  const raw = fsImpl.readFileSync(file, 'utf8'); if (!raw) return [];
  let previousEntrySha256 = null;
  const records = raw.split(/\r?\n/u).filter(Boolean).map((line, i) => {
    let record; try { record = JSON.parse(line); } catch { throw new Error(`PILOT_LEDGER_INVALID_LINE:${i + 1}`); }
    const supplied = record.entrySha256, base = { ...record }; delete base.entrySha256;
    fail(record.previousEntrySha256 === previousEntrySha256 && supplied === hash(Buffer.from(canonical(base))), `PILOT_LEDGER_CHAIN_INVALID:${i + 1}`);
    previousEntrySha256 = supplied; return record;
  });
  const reservations = records.filter(r => r.recordType === 'SUBMISSION_RESERVED');
  fail(reservations.length <= MAX_SUBMISSIONS && new Set(reservations.map(r => r.requestKey)).size === reservations.length,
    'PILOT_LEDGER_SUBMISSION_LIMIT_OR_DUPLICATE');
  return records;
}
function appendLedgerRecord(file, baseRecord, fsImpl = fs) {
  if (fsImpl.existsSync(file)) assertRealFile(file, fsImpl);
  const records = readLedger(file, fsImpl);
  const previousEntrySha256 = records.length ? records[records.length - 1].entrySha256 : null;
  const base = { ...baseRecord, previousEntrySha256 };
  const record = { ...base, entrySha256: hash(Buffer.from(canonical(base))) };
  fsImpl.appendFileSync(file, `${canonical(record)}\n`, { flag: 'a' });
  const fd = fsImpl.openSync(file, 'a'); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
  return record;
}
function writeLedgerBaseline(root, fsImpl) {
  const file = path.join(root, 'pilot-ledger-baseline.v1.json');
  if (fsImpl.existsSync(file)) return readJson(file, fsImpl);
  const ledger = path.join(root, 'request-ledger.jsonl');
  const record = { schemaVersion: 'phase3-media-pilot-ledger-baseline/1.0.0',
    sha256: fsImpl.existsSync(ledger) ? hash(fsImpl.readFileSync(ledger)) : hash(Buffer.alloc(0)), recordedAt: new Date().toISOString() };
  writeJsonExclusive(file, record, fsImpl); return record;
}
function reserveRequest({ root, request, stage, planning, auth, inputAssetSha256 = null, fsImpl = fs }) {
  const ledgerPath = path.join(root, 'request-ledger.jsonl');
  const records = readLedger(ledgerPath, fsImpl);
  const reservations = records.filter(r => r.recordType === 'SUBMISSION_RESERVED');
  fail(reservations.length < MAX_SUBMISSIONS, 'PILOT_SUBMISSION_LIMIT_REACHED');
  fail(!records.some(r => r.requestKey === request.requestKey), 'PILOT_DUPLICATE_REQUEST_KEY');
  fail(stage === 'still' ? request.requestKey === REQUESTS.still.key : request.requestKey === REQUESTS.animation.key,
    'PILOT_REQUEST_KEY_INVALID');
  const record = { schemaVersion: SCHEMAS.ledger, recordType: 'SUBMISSION_RESERVED', sequence: reservations.length + 1,
    requestKey: request.requestKey, stage, beatId: 'ACT3_B005', provider: 'fal.ai', model: request.model,
    parameters: request.parameters, promptSha256: request.prompt ? hash(Buffer.from(request.prompt)) : null,
    negativePromptSha256: request.negativePrompt ? hash(Buffer.from(request.negativePrompt)) : null,
    inputAssetSha256, proposalSha256: planning.proposalSha256, authorizationSha256: auth.sha256,
    reservedAt: new Date().toISOString(), retryAllowed: false, fallbackAllowed: false };
  const appended = appendLedgerRecord(ledgerPath, record, fsImpl);
  return { ledgerPath, record: appended };
}
function appendRequestResult({ ledgerPath, requestKey, status, actualChargeUsd = null, errorCode = null, fsImpl = fs }) {
  const record = { schemaVersion: SCHEMAS.ledger, recordType: 'SUBMISSION_RESULT', requestKey, status,
    actualChargeUsd: Number.isFinite(actualChargeUsd) ? actualChargeUsd : null, errorCode, recordedAt: new Date().toISOString() };
  appendLedgerRecord(ledgerPath, record, fsImpl);
}
function acquireLock(root, fsImpl) {
  const lock = path.join(root, 'pilot.lock');
  fail(!fsImpl.existsSync(lock), 'PILOT_LOCK_EXISTS');
  let fd = null;
  try {
    fd = fsImpl.openSync(lock, 'wx', 0o600);
    fsImpl.writeSync(fd, `${process.pid}\n`); fsImpl.closeSync(fd); fd = null;
    return lock;
  } catch (error) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch {} }
    if (fsImpl.existsSync(lock)) { try { fsImpl.unlinkSync(lock); } catch {} }
    throw error;
  }
}
function writeJsonExclusive(file, value, fsImpl) {
  fail(!fsImpl.existsSync(file), 'PILOT_OUTPUT_ALREADY_EXISTS');
  const temp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try { fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); fsImpl.renameSync(temp, file); }
  catch (error) { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); throw error; }
}
function writeBytesExclusive(file, bytes, fsImpl) {
  fail(!fsImpl.existsSync(file), 'PILOT_OUTPUT_ALREADY_EXISTS');
  const temp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try { fsImpl.writeFileSync(temp, bytes, { flag: 'wx' }); fsImpl.renameSync(temp, file); }
  catch (error) { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); throw error; }
}
function recordFailure(root, command, error, context, fsImpl) {
  if (!fsImpl.existsSync(root)) fsImpl.mkdirSync(root, { recursive: true });
  const rawCode = String(error.message || error).split(':')[0];
  const errorCode = /^[A-Z][A-Z0-9_]{2,80}$/u.test(rawCode) ? rawCode : 'PILOT_OPERATION_FAILED';
  let providerRequestCount = null;
  try { providerRequestCount = readLedger(path.join(root, 'request-ledger.jsonl'), fsImpl).filter(r => r.recordType === 'SUBMISSION_RESERVED').length; } catch {}
  const receipt = { schemaVersion: 'phase3-media-pilot-failure-receipt/1.0.0', status: 'FAILED', command,
    errorCode, context, recordedAt: new Date().toISOString(), providerRequestCount };
  const file = path.join(root, `${command}-failure-receipt.json`);
  if (!fsImpl.existsSync(file)) writeJsonExclusive(file, receipt, fsImpl);
}
function pngInfo(bytes) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fail(bytes.length >= 24 && bytes.subarray(0, 8).equals(sig) && bytes.toString('ascii', 12, 16) === 'IHDR', 'PILOT_STILL_NOT_PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  fail(width > 0 && height > 0, 'PILOT_STILL_DIMENSIONS_INVALID');
  return { mimeType: 'image/png', format: 'PNG', width, height };
}
function probeVideo(file, probe = spawnSync) {
  const result = probe('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'format=format_name,duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_frames,duration,sample_rate,channels,bit_rate',
    '-of', 'json', file], { encoding: 'utf8', shell: false });
  fail(result.status === 0 && result.stdout, 'PILOT_FFPROBE_FAILED');
  const data = JSON.parse(result.stdout), format = data.format || {}, streams = data.streams || [];
  const video = streams.filter(s => s.codec_type === 'video'), audio = streams.filter(s => s.codec_type === 'audio');
  fail(video.length === 1, 'PILOT_VIDEO_STREAM_COUNT_INVALID');
  const durationSeconds = Number(format.duration), width = Number(video[0].width), height = Number(video[0].height);
  const frameRate = video[0].avg_frame_rate || video[0].r_frame_rate, frameCount = Number(video[0].nb_read_frames || video[0].nb_frames || 0);
  fail(typeof format.format_name === 'string' && format.format_name.length > 0 && Number.isFinite(durationSeconds) && durationSeconds > 0
    && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 && typeof frameRate === 'string'
    && frameRate.length > 0 && Number.isFinite(frameCount) && frameCount > 0, 'PILOT_VIDEO_METADATA_INCOMPLETE');
  return { container: format.format_name, durationSeconds, bytes: Number(format.size),
    video: { codec: video[0].codec_name, width, height,
      frameRate, frameCount },
    audioStreams: audio.map(s => ({ codec: s.codec_name, sampleRate: s.sample_rate, channels: s.channels, bitrate: s.bit_rate || null })) };
}
async function downloadRemote(url) {
  const parsed = new URL(url);
  fail(parsed.protocol === 'https:' && !parsed.username && !parsed.password, 'PILOT_DOWNLOAD_URL_INVALID');
  const allowed = parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media')
    || parsed.hostname === 'storage.googleapis.com' || parsed.hostname.endsWith('.googleusercontent.com');
  fail(allowed, 'PILOT_DOWNLOAD_HOST_UNAPPROVED');
  const response = await fetch(parsed, { redirect: 'error' });
  fail(response.ok, 'PILOT_DOWNLOAD_FAILED');
  const declared = Number(response.headers.get('content-length') || 0);
  fail(!declared || declared <= MAX_REMOTE_BYTES, 'PILOT_DOWNLOAD_TOO_LARGE');
  const bytes = Buffer.from(await response.arrayBuffer());
  fail(bytes.length <= MAX_REMOTE_BYTES, 'PILOT_DOWNLOAD_TOO_LARGE');
  return { bytes, contentType: response.headers.get('content-type') || '' };
}
function createFalProvider({ falModuleLoader = () => require('@fal-ai/client'), credentialResolver = () => process.env.FAL_KEY } = {}) {
  function client() {
    const credentials = credentialResolver();
    if (!credentials) throw new Error('PILOT_PROVIDER_CREDENTIAL_MISSING');
    const { fal } = falModuleLoader();
    // The SDK retries transient submissions by default. The pilot has one
    // durable reservation per authorized request and must never resubmit.
    fal.config({ credentials, retry: { maxRetries: 0, retryableStatusCodes: [] } });
    return fal;
  }
  return {
    generateStill: async ({ model, input }) => {
      fail(model === REQUESTS.still.model, 'PILOT_PROVIDER_MODEL_MISMATCH');
      const result = await client().subscribe(model, { input, logs: false });
      const image = result?.data?.images?.[0];
      fail(typeof image?.url === 'string', 'PILOT_PROVIDER_STILL_RESPONSE_INVALID');
      return { url: image.url, contentType: image.content_type || 'image/png',
        actualChargeUsd: Number.isFinite(result?.data?.actual_cost_usd) ? result.data.actual_cost_usd : null };
    },
    generateAnimation: async ({ model, input }) => {
      fail(model === REQUESTS.animation.model, 'PILOT_PROVIDER_MODEL_MISMATCH');
      const result = await client().subscribe(model, { input, logs: false });
      const video = result?.data?.video;
      fail(typeof video?.url === 'string', 'PILOT_PROVIDER_ANIMATION_RESPONSE_INVALID');
      return { url: video.url, contentType: video.content_type || 'video/mp4',
        actualChargeUsd: Number.isFinite(result?.data?.actual_cost_usd) ? result.data.actual_cost_usd : null };
    },
  };
}
function assertPilotAssetNotProduction(value, pointer = '$') {
  if (typeof value === 'string') {
    fail(!value.includes('/.review/phase3-media-pilots/') && !value.includes('\\.review\\phase3-media-pilots\\')
      && value !== PILOT_ASSET_CLASS, `PRODUCTION_PILOT_ASSET_FORBIDDEN:${pointer}`);
  } else if (Array.isArray(value)) value.forEach((item, i) => assertPilotAssetNotProduction(item, `${pointer}/${i}`));
  else if (value && typeof value === 'object') {
    fail(value.assetClass !== PILOT_ASSET_CLASS && value.productionEligibility !== PILOT_ASSET_CLASS,
      `PRODUCTION_PILOT_ASSET_FORBIDDEN:${pointer}`);
    for (const [key, item] of Object.entries(value)) assertPilotAssetNotProduction(item, `${pointer}/${key}`);
  }
  return true;
}

function createPilotWorkflow({ fsImpl = fs, root, expectedRoot = root, v5Dir, pilotDir, editorialApprovalPath,
  pins = TRUST, provider = null, downloader = downloadRemote, ffprobe = probeVideo, now = () => new Date(),
  expectedAuthorizationSha256 = '' }) {
  const getPlanning = () => verifyPlanningInputs({ v5Dir, editorialApprovalPath, pilotDir, fsImpl, pins });
  const runPath = () => { fail(pins.runId === TRUST.runId, 'PILOT_RUN_ID_INVALID'); assertRunRoot(root, expectedRoot, fsImpl); return path.resolve(root); };
  const getInputs = planning => {
    const inputs = { 'v5/phase3-media-package-index.v5.json': planning.v5.indexBytes,
      'detached-editorial-approval.json': fsImpl.readFileSync(editorialApprovalPath),
      'pilot/package-index.json': planning.pilot.indexBytes,
      'v5/unsigned-approval-proposal.v5.json': fsImpl.readFileSync(path.join(v5Dir, 'unsigned-approval-proposal.v5.json')),
      'execution-authorization.v1.json': fsImpl.readFileSync(path.join(root, 'execution-authorization.v1.json')) };
    for (const entry of planning.v5.index.files) inputs[`v5/${entry.path}`] = fsImpl.readFileSync(path.join(v5Dir, ...entry.path.split('/')));
    for (const entry of planning.pilot.index.files) inputs[`pilot/${entry.path}`] = fsImpl.readFileSync(path.join(pilotDir, ...entry.path.split('/')));
    return inputs;
  };
  function preflight() {
    const planning = getPlanning(); runPath();
    const rootExists = fsImpl.existsSync(root);
    let authorizationStatus = 'MISSING; no provider requests permitted';
    let executionAuthorized = false;
    if (rootExists) {
      const existing = strictTreeFiles(root, fsImpl);
      if (existing.length) {
        fail(canonical(existing) === canonical(['execution-authorization.v1.json']) && expectedAuthorizationSha256,
          'PILOT_PREFLIGHT_EXISTING_RUN_NOT_EMPTY');
        const auth = loadDetachedExecutionAuthorization(root, planning, fsImpl, expectedAuthorizationSha256);
        authorizationStatus = `VERIFIED:${auth.sha256}`;
        executionAuthorized = true;
      }
    } else if (expectedAuthorizationSha256) fail(false, 'PILOT_EXECUTION_AUTHORIZATION_MISSING');
    return { status: executionAuthorized ? 'PILOT_PREFLIGHT_PASS_EXECUTION_AUTHORIZED_NOT_EXECUTED' : 'PILOT_PREFLIGHT_PASS_PLANNING_ONLY', executionAuthorized,
      executionAuthorization: authorizationStatus, approvedPilotBeat: 'ACT3_B005',
      providerSubmissionsMaximum: MAX_SUBMISSIONS, requestKeys: [planning.still.requestKey, planning.animation.requestKey],
      providerModels: [planning.still.model, planning.animation.model],
      proposedCostUsdAtPublishedAssumptions: planning.proposal.cost.publishedEstimatedUsd.totalAtFiveSeconds,
      proposedCapProviderEnforced: false, priceAndOwnershipExecutionBlockers: planning.proposal.stopConditions,
      sourceBindings: { v5PackageIndexSha256: planning.v5IndexSha256, editorialApprovalSha256: planning.approvalSha256,
        pilotPackageIndexSha256: planning.pilotIndexSha256, proposalSha256: planning.proposalSha256 },
      requestLedger: 'not created or modified by preflight',
      outputRoot: root, wouldCreateNoFiles: true };
  }
  async function withExecutionLock(command, callback) {
    const runRoot = runPath();
    fail(!fsImpl.existsSync(runRoot) || fsImpl.lstatSync(runRoot).isDirectory(), 'PILOT_RUN_ROOT_INVALID');
    const planning = getPlanning();
    const auth = loadDetachedExecutionAuthorization(runRoot, planning, fsImpl, expectedAuthorizationSha256);
    const stageExisting = command === 'generate-still' ? 'still' : 'animation';
    fail(!fsImpl.existsSync(path.join(runRoot, 'pilot.lock')), 'PILOT_LOCK_EXISTS');
    if (stageExisting === 'animation') {
      const approvalPath = path.join(runRoot, 'still-approval.v1.json');
      fail(fsImpl.existsSync(approvalPath), 'PILOT_STILL_HUMAN_APPROVAL_REQUIRED');
      const approval = readJson(approvalPath, fsImpl), stillReceipt = readJson(path.join(runRoot, 'still-receipt.v1.json'), fsImpl);
      fail(approval.decision === 'APPROVED' && approval.approvedBy === 'Yakubu Moshood'
        && approval.stillSha256 === stillReceipt.output.sha256, 'PILOT_STILL_HUMAN_APPROVAL_INVALID');
    }
    const existing = fsImpl.existsSync(runRoot) ? strictTreeFiles(runRoot, fsImpl) : [];
    if (stageExisting === 'still') {
      fail(canonical(existing) === canonical(['execution-authorization.v1.json']), 'PILOT_RUN_ALREADY_USED');
    } else {
      const allowed = ['ACT3_B005-still.png', 'execution-authorization.v1.json', 'inputs/detached-editorial-approval.json',
        'inputs/execution-authorization.v1.json', 'inputs/pilot/package-index.json', 'inputs/pilot/phase3-media-pilot-proposal.v1.json',
        'inputs/pilot/phase3-media-pilot-proposal.v1.md', 'inputs/v5/unsigned-approval-proposal.v5.json',
        'inputs/v5/phase3-media-package-index.v5.json',
        'pilot-inputs-index.v1.json', 'pilot-ledger-baseline.v1.json', 'request-ledger.jsonl',
        'still-inspection.v1.json', 'still-receipt.v1.json', 'still-approval.v1.json'];
      for (const entry of planning.v5.index.files) allowed.push(`inputs/v5/${entry.path}`);
      fail(existing.every(item => allowed.includes(item)) && existing.includes('still-approval.v1.json'), 'PILOT_RUN_ALREADY_USED');
      const ledgerBefore = readLedger(path.join(runRoot, 'request-ledger.jsonl'), fsImpl);
      fail(ledgerBefore.filter(r => r.recordType === 'SUBMISSION_RESERVED').length === 1
        && ledgerBefore.some(r => r.recordType === 'SUBMISSION_RESULT' && r.requestKey === REQUESTS.still.key && r.status === 'SUCCEEDED'),
      'PILOT_ANIMATION_REQUIRES_SUCCESSFUL_STILL_ATTEMPT');
    }
    if (!fsImpl.existsSync(runRoot)) fsImpl.mkdirSync(runRoot, { recursive: false });
    const lock = acquireLock(runRoot, fsImpl);
    try {
      const inputIndex = ensureInputsCopied(runRoot, getInputs(planning), fsImpl);
      writeLedgerBaseline(runRoot, fsImpl);
      await callback({ runRoot, planning, auth, request: planning[stageExisting], lock, inputIndex });
    } catch (error) {
      try { recordFailure(runRoot, command, error, { authorizationSha256: auth.sha256 }, fsImpl); } catch {}
      throw error;
    } finally { if (fsImpl.existsSync(lock)) fsImpl.unlinkSync(lock); }
  }
  function withRecordLock(command, callback) {
    const runRoot = runPath(); fail(fsImpl.existsSync(runRoot), 'PILOT_RUN_DIRECTORY_MISSING');
    fail(!fsImpl.existsSync(path.join(runRoot, 'pilot-receipt.v1.json')), 'PILOT_RUN_ALREADY_COMPLETE');
    const lock = acquireLock(runRoot, fsImpl);
    try { return callback(runRoot); }
    catch (error) { try { recordFailure(runRoot, command, error, {}, fsImpl); } catch {} throw new Error(errorCode(error)); }
    finally { if (fsImpl.existsSync(lock)) fsImpl.unlinkSync(lock); }
  }
  async function generateStill() {
    return withExecutionLock('generate-still', async ({ runRoot, planning, auth, request, inputIndex }) => {
      const ledger = reserveRequest({ root: runRoot, request, stage: 'still', planning, auth, fsImpl });
      try {
        fail(provider && typeof provider.generateStill === 'function', 'PILOT_PROVIDER_ADAPTER_MISSING');
        const result = await provider.generateStill({ model: request.model, input: { prompt: request.prompt,
          negative_prompt: request.negativePrompt, ...request.parameters } });
        const downloaded = result.bytes ? { bytes: Buffer.from(result.bytes), contentType: result.contentType || '' } : await downloader(result.url, runRoot);
        const bytes = Buffer.from(downloaded.bytes);
        fail(bytes.length > 0 && bytes.length <= MAX_REMOTE_BYTES, 'PILOT_STILL_BYTE_SIZE_INVALID');
        fail(String(downloaded.contentType).split(';')[0].trim().toLowerCase() === 'image/png', 'PILOT_STILL_MIME_INVALID');
        const media = pngInfo(bytes), output = path.join(runRoot, 'ACT3_B005-still.png');
        writeBytesExclusive(output, bytes, fsImpl);
        const receipt = { schemaVersion: SCHEMAS.stillReceipt, status: 'STILL_GENERATED_PENDING_INSPECTION', assetClass: PILOT_ASSET_CLASS,
          beatId: 'ACT3_B005', requestKey: request.requestKey, inputHashes: { v5PackageIndexSha256: planning.v5IndexSha256,
            editorialApprovalSha256: planning.approvalSha256, pilotPackageIndexSha256: planning.pilotIndexSha256,
            proposalSha256: planning.proposalSha256, copiedInputIndexSha256: inputIndex.sha256 },
          provider: 'fal.ai', model: request.model, providerContentType: downloaded.contentType,
          output: { path: 'ACT3_B005-still.png', bytes: bytes.length, sha256: hash(bytes), ...media },
          actualChargeUsd: Number.isFinite(result.actualChargeUsd) ? result.actualChargeUsd : null, completedAt: now().toISOString() };
        writeJsonExclusive(path.join(runRoot, 'still-receipt.v1.json'), receipt, fsImpl);
        appendRequestResult({ ledgerPath: ledger.ledgerPath, requestKey: request.requestKey, status: 'SUCCEEDED', actualChargeUsd: result.actualChargeUsd, fsImpl });
      } catch (error) {
        if (!readLedger(ledger.ledgerPath, fsImpl).some(r => r.recordType === 'SUBMISSION_RESULT' && r.requestKey === request.requestKey))
          appendRequestResult({ ledgerPath: ledger.ledgerPath, requestKey: request.requestKey, status: 'FAILED', errorCode: errorCode(error), fsImpl });
        throw new Error(errorCode(error));
      }
    });
  }
  function inspectStill() {
    const planning = getPlanning();
    return withRecordLock('inspect-still', runRoot => {
    const stillPath = path.join(runRoot, 'ACT3_B005-still.png'), receipt = readJson(path.join(runRoot, 'still-receipt.v1.json'), fsImpl);
    assertRealFile(stillPath, fsImpl); const bytes = fsImpl.readFileSync(stillPath);
    fail(hash(bytes) === receipt.output.sha256, 'PILOT_STILL_HASH_MISMATCH');
    const info = pngInfo(bytes);
    const inspection = { schemaVersion: SCHEMAS.inspection, status: 'INSPECTED_PENDING_HUMAN_APPROVAL', assetClass: PILOT_ASSET_CLASS,
      beatId: 'ACT3_B005', stillSha256: hash(bytes), bytes: bytes.length, ...info, inspectedAt: now().toISOString(),
      inputProposalSha256: planning.proposalSha256, reviewerDecision: '' };
    writeJsonExclusive(path.join(runRoot, 'still-inspection.v1.json'), inspection, fsImpl);
    return inspection;
    });
  }
  function approveStill({ decision, notes = '', approvedBy = '', approvalRef = '' } = {}) {
    return withRecordLock('approve-still', runRoot => {
    fail(approvedBy === 'Yakubu Moshood' && typeof approvalRef === 'string' && approvalRef.trim().length > 0
      && ['APPROVED', 'REJECTED'].includes(decision), 'PILOT_STILL_APPROVAL_FIELDS_INVALID');
    const inspection = readJson(path.join(runRoot, 'still-inspection.v1.json'), fsImpl);
    const stillReceipt = readJson(path.join(runRoot, 'still-receipt.v1.json'), fsImpl);
    fail(inspection.status === 'INSPECTED_PENDING_HUMAN_APPROVAL' && inspection.stillSha256 === stillReceipt.output.sha256,
      'PILOT_STILL_INSPECTION_BINDING_INVALID');
    const record = { schemaVersion: SCHEMAS.stillApproval, recordType: 'DETACHED_PILOT_STILL_HUMAN_DECISION',
      decision, approvedBy, approvalRef, notes, stillSha256: inspection.stillSha256, proposalSha256: getPlanning().proposalSha256,
      assetClass: PILOT_ASSET_CLASS, decidedAt: now().toISOString() };
    const target = path.join(runRoot, 'still-approval.v1.json');
    fail(!fsImpl.existsSync(target), 'PILOT_STILL_DECISION_ALREADY_RECORDED');
    writeJsonExclusive(target, record, fsImpl); return record;
    });
  }
  async function generateAnimation() {
    return withExecutionLock('generate-animation', async ({ runRoot, planning, auth, request, inputIndex }) => {
      const stillPath = path.join(runRoot, 'ACT3_B005-still.png'), stillBytes = fsImpl.readFileSync(stillPath);
      const approval = readJson(path.join(runRoot, 'still-approval.v1.json'), fsImpl);
      fail(hash(stillBytes) === approval.stillSha256 && approval.decision === 'APPROVED', 'PILOT_STILL_INPUT_INVALID');
      pngInfo(stillBytes);
      const ledger = reserveRequest({ root: runRoot, request, stage: 'animation', planning, auth,
        inputAssetSha256: hash(stillBytes), fsImpl });
      try {
        fail(provider && typeof provider.generateAnimation === 'function', 'PILOT_PROVIDER_ADAPTER_MISSING');
        const result = await provider.generateAnimation({ model: request.model, input: { image_url: `data:image/png;base64,${stillBytes.toString('base64')}`,
          prompt: request.prompt, negative_prompt: request.negativePrompt, ...request.parameters } });
        const downloaded = result.bytes ? { bytes: Buffer.from(result.bytes), contentType: result.contentType || '' } : await downloader(result.url, runRoot);
        const bytes = Buffer.from(downloaded.bytes);
        fail(bytes.length > 0 && bytes.length <= MAX_REMOTE_BYTES, 'PILOT_CLIP_BYTE_SIZE_INVALID');
        fail(String(downloaded.contentType).split(';')[0].trim().toLowerCase() === 'video/mp4', 'PILOT_CLIP_MIME_INVALID');
        const outputPath = path.join(runRoot, 'ACT3_B005-animation.mp4'); writeBytesExclusive(outputPath, bytes, fsImpl);
        const probe = ffprobe(outputPath), receipt = { schemaVersion: SCHEMAS.animationReceipt,
          status: 'ANIMATION_GENERATED_PENDING_FINAL_VALIDATION', assetClass: PILOT_ASSET_CLASS, beatId: 'ACT3_B005',
          requestKey: request.requestKey, stillSha256: approval.stillSha256, model: request.model,
          inputIndexSha256: inputIndex.sha256,
          output: { path: 'ACT3_B005-animation.mp4', bytes: bytes.length, sha256: hash(bytes), ...probe },
          actualChargeUsd: Number.isFinite(result.actualChargeUsd) ? result.actualChargeUsd : null, completedAt: now().toISOString() };
        writeJsonExclusive(path.join(runRoot, 'animation-receipt.v1.json'), receipt, fsImpl);
        appendRequestResult({ ledgerPath: ledger.ledgerPath, requestKey: request.requestKey, status: 'SUCCEEDED', actualChargeUsd: result.actualChargeUsd, fsImpl });
      } catch (error) {
        if (!readLedger(ledger.ledgerPath, fsImpl).some(r => r.recordType === 'SUBMISSION_RESULT' && r.requestKey === request.requestKey))
          appendRequestResult({ ledgerPath: ledger.ledgerPath, requestKey: request.requestKey, status: 'FAILED', errorCode: errorCode(error), fsImpl });
        throw new Error(errorCode(error));
      }
    });
  }
  function finalize() {
    const planning = getPlanning();
    return withRecordLock('finalize', runRoot => {
    fail(!fsImpl.existsSync(path.join(runRoot, 'pilot-package-index.v1.json')), 'PILOT_RUN_ALREADY_COMPLETE');
    const stillReceipt = readJson(path.join(runRoot, 'still-receipt.v1.json'), fsImpl);
    const inspection = readJson(path.join(runRoot, 'still-inspection.v1.json'), fsImpl);
    const approval = readJson(path.join(runRoot, 'still-approval.v1.json'), fsImpl);
    const animationReceipt = readJson(path.join(runRoot, 'animation-receipt.v1.json'), fsImpl);
    fail(approval.decision === 'APPROVED' && approval.stillSha256 === stillReceipt.output.sha256
      && inspection.stillSha256 === approval.stillSha256, 'PILOT_FINAL_STILL_APPROVAL_INVALID');
    const stillBytes = fsImpl.readFileSync(path.join(runRoot, stillReceipt.output.path));
    const clipBytes = fsImpl.readFileSync(path.join(runRoot, animationReceipt.output.path));
    fail(hash(stillBytes) === stillReceipt.output.sha256 && hash(clipBytes) === animationReceipt.output.sha256,
      'PILOT_FINAL_OUTPUT_HASH_MISMATCH');
    const ledger = readLedger(path.join(runRoot, 'request-ledger.jsonl'), fsImpl);
    const reserved = ledger.filter(r => r.recordType === 'SUBMISSION_RESERVED');
    fail(reserved.length === 2 && new Set(reserved.map(r => r.requestKey)).size === 2
      && reserved.some(r => r.requestKey === REQUESTS.still.key) && reserved.some(r => r.requestKey === REQUESTS.animation.key), 'PILOT_FINAL_REQUEST_SET_INVALID');
    const results = ledger.filter(r => r.recordType === 'SUBMISSION_RESULT');
    fail(results.length === 2 && results.every(r => r.status === 'SUCCEEDED')
      && new Set(results.map(r => r.requestKey)).size === 2, 'PILOT_FINAL_REQUEST_RESULTS_INVALID');
    const ledgerHash = hash(fsImpl.readFileSync(path.join(runRoot, 'request-ledger.jsonl')));
    const videoProbe = ffprobe(path.join(runRoot, animationReceipt.output.path));
    const savedProbe = { container: animationReceipt.output.container, durationSeconds: animationReceipt.output.durationSeconds,
      bytes: animationReceipt.output.bytes, video: animationReceipt.output.video, audioStreams: animationReceipt.output.audioStreams };
    fail(canonical(videoProbe) === canonical(savedProbe), 'PILOT_FINAL_FFPROBE_BINDING_MISMATCH');
    const inputIndexPath = path.join(runRoot, 'pilot-inputs-index.v1.json');
    const inputIndexSha256 = hash(fsImpl.readFileSync(inputIndexPath));
    const outputs = { still: { bytes: stillBytes.length, sha256: hash(stillBytes), assetClass: PILOT_ASSET_CLASS },
      animation: { bytes: clipBytes.length, sha256: hash(clipBytes), media: animationReceipt.output, assetClass: PILOT_ASSET_CLASS } };
    const inputs = { v5PackageIndexSha256: planning.v5IndexSha256, editorialApprovalSha256: planning.approvalSha256,
      pilotPackageIndexSha256: planning.pilotIndexSha256, proposalSha256: planning.proposalSha256, copiedInputIndexSha256: inputIndexSha256 };
    const baseline = readJson(path.join(runRoot, 'pilot-ledger-baseline.v1.json'), fsImpl);
    const assetManifest = { schemaVersion: 'phase3-media-pilot-asset-manifest/1.0.0', status: 'DISPOSABLE_NOT_PRODUCTION',
      assetClass: PILOT_ASSET_CLASS, entries: [
        { beatId: 'ACT3_B005', role: 'still', path: 'ACT3_B005-still.png', bytes: stillBytes.length, sha256: hash(stillBytes) },
        { beatId: 'ACT3_B005', role: 'animation', path: 'ACT3_B005-animation.mp4', bytes: clipBytes.length, sha256: hash(clipBytes) },
      ] };
    writeJsonExclusive(path.join(runRoot, 'pilot-asset-manifest.v1.json'), assetManifest, fsImpl);
    const receipt = { schemaVersion: SCHEMAS.finalReceipt, status: 'PILOT_VALIDATED_DISPOSABLE_NOT_PRODUCTION', assetClass: PILOT_ASSET_CLASS,
      runId: pins.runId, beatId: 'ACT3_B005', inputs, outputs, requestKeys: reserved.map(r => r.requestKey).sort(),
      providerRequestCount: reserved.length, actualChargesUsd: ledger.filter(r => r.recordType === 'SUBMISSION_RESULT').map(r => r.actualChargeUsd),
      requestLedgerSha256Before: baseline.sha256, requestLedgerSha256After: ledgerHash, noProductionUse: true, completedAt: now().toISOString() };
    writeJsonExclusive(path.join(runRoot, 'pilot-receipt.v1.json'), receipt, fsImpl);
    const files = strictTreeFiles(runRoot, fsImpl).filter(rel => !['pilot-package-index.v1.json', 'pilot.lock'].includes(rel));
    const indexed = files.map(rel => { const bytes = fsImpl.readFileSync(path.join(runRoot, rel)); return { path: rel, bytes: bytes.length, sha256: hash(bytes) }; });
    writeJsonExclusive(path.join(runRoot, 'pilot-package-index.v1.json'),
      { schemaVersion: 'phase3-media-pilot-output-index/1.0.0', status: 'PILOT_VALIDATED_DISPOSABLE_NOT_PRODUCTION', files: indexed }, fsImpl);
    return receipt;
    });
  }
  return { preflight, generateStill, inspectStill, approveStill, generateAnimation, finalize, getPlanning };
}

function defaultWorkflow(expectedAuthorizationSha256 = '') {
  const activation = require('../scripts/phase2.3b-p-activate.cjs');
  const base = path.resolve(activation.ROOT, '.review', 'phase3-media-pilots');
  const runRoot = path.join(base, TRUST.runId);
  return createPilotWorkflow({ root: runRoot, expectedRoot: base, provider: createFalProvider(), expectedAuthorizationSha256,
    v5Dir: path.join(WELLS_ROOT, V5_DIR_NAME),
    editorialApprovalPath: path.join(WELLS_ROOT, 'phase3-media-completion-review-20261002-v5-human-editorial-approval.v1.json'),
    pilotDir: path.join(WELLS_ROOT, PILOT_PACKAGE_NAME) });
}
function parseCli(argv) {
  const args = new Set(argv);
  const modes = ['--preflight', '--generate-still', '--inspect-still', '--approve-still', '--generate-animation', '--finalize'].filter(x => args.has(x));
  fail(modes.length === 1, 'PILOT_EXACTLY_ONE_COMMAND_REQUIRED');
  const values = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) values[argv[i]] = argv[++i];
  fail(values['--pilot-run-id'] === TRUST.runId, 'PILOT_RUN_ID_INVALID');
  for (const flag of argv.filter(x => x.startsWith('--'))) fail(['--preflight', '--generate-still', '--inspect-still', '--approve-still',
    '--generate-animation', '--finalize', '--pilot-run-id', '--decision', '--approved-by', '--approval-ref', '--notes',
    '--expected-execution-authorization-sha256'].includes(flag), `PILOT_UNKNOWN_ARGUMENT:${flag}`);
  if (parsedExecutionMode(modes[0])) fail(/^[a-f0-9]{64}$/u.test(values['--expected-execution-authorization-sha256'] || ''),
    'PILOT_EXPECTED_AUTHORIZATION_HASH_REQUIRED');
  return { mode: modes[0], values };
}
function parsedExecutionMode(mode) { return ['--generate-still', '--generate-animation'].includes(mode); }
async function cli(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv), workflow = defaultWorkflow(parsed.values['--expected-execution-authorization-sha256'] || '');
  if (parsed.mode === '--preflight') return workflow.preflight();
  if (parsed.mode === '--inspect-still') return workflow.inspectStill();
  if (parsed.mode === '--approve-still') return workflow.approveStill({ decision: parsed.values['--decision'],
    approvedBy: parsed.values['--approved-by'], approvalRef: parsed.values['--approval-ref'], notes: parsed.values['--notes'] || '' });
  if (parsed.mode === '--generate-still') return workflow.generateStill();
  if (parsed.mode === '--generate-animation') return workflow.generateAnimation();
  return workflow.finalize();
}
if (require.main === module) cli().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
  process.stderr.write(`${errorCode(error)}\n`); process.exitCode = 1;
});

module.exports = { TRUST, REQUESTS, PILOT_ASSET_CLASS, SCHEMAS, verifyPlanningInputs, createPilotWorkflow,
  loadDetachedExecutionAuthorization, readLedger, reserveRequest, appendRequestResult, pngInfo, probeVideo,
  appendLedgerRecord, assertPilotAssetNotProduction, parseCli, cli, createFalProvider, downloadRemote, errorCode };
