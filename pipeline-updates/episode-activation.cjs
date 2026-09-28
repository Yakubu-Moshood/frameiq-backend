'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_DYNAMIC_FIELDS = new Set(['startWordIndex', 'endWordIndex', 'startSec', 'endSec', 'durationSec', 'narrationExcerpt']);
const SHOT_DYNAMIC_FIELDS = new Set(['startWordIndex', 'endWordIndex', 'startSec', 'endSec', 'durationSec', 'narrationExcerpt']);
const APPROVED_BOUNDARY_POLICY_SHA256 = '3b745ad921ef4fadea24579e0a9bd61ad9ea28d6e88372e861620d80a87b59b9';
const REFRESHED_BOUNDARY_POLICY_SHA256 = 'cf59c265604e3b602df12bc89aa8328b7a8faa18df78f0273f5139789e4eaebf';
const REFRESHED_BOUNDARY_POLICY_BINDINGS = Object.freeze({
  packageIndexSha256: '4ad51af55f4686b60ceed7c5fecad5d6fa477b6151ec8dcad05f6d9334fa86c0',
  lockedEditPlanSha256: '33f5a89fb724bdc8982f85fd9cf8ff223f6e1031bfa557a6f8df609f44bf5337',
  candidatePreTimingEditPlanSha256: '94366ed6e448b79ff6568d42ed0903708dda37da7ae93c80f4db7fa3bffe4504',
  candidateScriptSha256: 'fd377ddc30498bf921b33c9cb409ff159804e99862d96910bf68ae12e4dee7f4',
  combinedTranscriptSha256: 'e7c341bdde3cd0537bcb6a840dd130b185864ebc25d659b60f27362f9464dea0',
  alignmentProposalSha256: '7bea33b6be01432f5e0d4e2703e98640e1f27a2f4e473ec586eee76ea060ffee',
  alignmentApprovalSha256: '32936b3c7279c8636c0b1ba9709c4ee8afe04a4a84eb3bea32579cf0a42bad42',
  boundaryProposalSha256: '1d43fb52c0fd75f9040f25b1b811b1b54d880cc7fad411bc37951d1bb784971e',
  boundaryApprovalSha256: '29c6d85046da6d1d136c617d1f75e77b62cdcc88e69753593dd0b2a5f1fc113f',
  newAct3AudioSha256: '79909b5f4923fbe2aae04663068cbf4b5926a2ae3fb7a274b73013a778193449',
  unchangedAudioHashes: Object.freeze({
    act1: '453206fdeb6f6d2f36abd63a58bd2efb0fb40d92b5aa6453161e8779f2a72986',
    act2: '46f59093fede22d2ea84a1a52d81d3a913d50cdf3f69afa27e84bcb1c3c37d32',
    act3b: '31390130983a45394b920f72e148235046779dd027287a1b2fead77c8847054e',
    act4: '9043109ad5b9d4907114d5fd7f3f8649f8b7191dc92409ddf636c6b2aff285e0',
    act5: 'a80cc813614e8012849ddbec8c584ae1112ba14bf72306aabbd02d96b0b187db',
  }),
  evidenceApprovalSha256: 'c0de5baef64e8a9ff6a612b58f2d5089cd6789562c3b367686d243ca72c0afb2',
  globalRequestLedgerSha256: 'c8b6ad421c378081a6111c51151c4c73a87dadcf2c475194d522e5791407abaf',
  candidateAmendmentSha256: '93ebed017ff23b7487daa3591cdff2860917c0fe3ef1695a47659aa61a43d8f5',
  retainedTimingSourceReceiptSha256: 'a13249e0503f047e3c2d705aa3efabcf072d6e0098655e6317fd4566b5e241d1',
  previousApprovedBoundaryPolicySha256: '3b745ad921ef4fadea24579e0a9bd61ad9ea28d6e88372e861620d80a87b59b9',
});
const APPROVED_TIMING_EXCEPTION_POLICY_SHA256 = '423d77c02fdec6949382556913767a63974fba3784f26115e544bb4b9f881215';
const REFRESHED_TIMING_EXCEPTION_POLICY_SHA256 = '8a0173087b2e7364e8bd46c4a9e53c3acb738904fc3f94968099b357deea843b';
const REFRESHED_ORIGINAL_TIMING_AMENDMENT_SHA256 = '6ac0e48bb2b9f90112a46db117f08b7d79f98e8c7aa73236e47a1b98b98c660a';
const REFRESHED_B017_AMENDMENT_SHA256 = '93ebed017ff23b7487daa3591cdff2860917c0fe3ef1695a47659aa61a43d8f5';
const REFRESHED_B017_REVISION_LEDGER_SHA256 = '61a3fa3df81fe7350d43ad592820e1f04ca004fa9bf7f48e29d8d36685dd3b2a';
const REFRESHED_REVISION_CHAIN_FILE_SHA256S = Object.freeze([
  '82964237109ebf33f6502cb270957b739623870609f6399b0f95e0cde10f3c86',
  REFRESHED_ORIGINAL_TIMING_AMENDMENT_SHA256,
  REFRESHED_B017_REVISION_LEDGER_SHA256,
]);
const REFRESHED_TIMING_OWNER_KEYS = Object.freeze([
  'act1:ACT1_B030','act2:ACT2_B006','act2:ACT2_B023','act2:ACT2_B026',
  'act3:ACT3_B004','act3:ACT3_B025','act3b:ACT3B_B008','act3b:ACT3B_B012',
  'act3b:ACT3B_B018','act4:ACT4_B022','act4:ACT4_B024','act5:ACT5_B012',
  'act5:ACT5_B022','act5:ACT5_B023','act5:ACT5_B027',
]);
const REFRESHED_B017_CHANGED_BEATS = Object.freeze(['ACT3_B016','ACT3_B017','ACT3_B018','ACT3_B019']);
const OLD_TIMING_EXCEPTION_OWNERS = Object.freeze(['act1:ACT1_B030','act2:ACT2_B006','act2:ACT2_B023','act3:ACT3_B004','act3:ACT3_B025','act3b:ACT3B_B008','act3b:ACT3B_B012','act4:ACT4_B022','act4:ACT4_B024','act5:ACT5_B012']);
const REFRESHED_TIMING_EXCEPTION_OWNERS = Object.freeze(['act1:ACT1_B030','act2:ACT2_B006','act2:ACT2_B023','act3:ACT3_B004','act3b:ACT3B_B008','act3b:ACT3B_B012','act4:ACT4_B022','act4:ACT4_B024','act5:ACT5_B012']);
const EDITORIAL_INTENT_MIGRATION_OWNERS = Object.freeze(['act2:ACT2_B026','act3b:ACT3B_B018','act5:ACT5_B022','act5:ACT5_B023','act5:ACT5_B027']);
function timingExceptionOwnersFor(policySha256) {
  if (policySha256 === APPROVED_TIMING_EXCEPTION_POLICY_SHA256) return OLD_TIMING_EXCEPTION_OWNERS;
  if (policySha256 === REFRESHED_TIMING_EXCEPTION_POLICY_SHA256) return REFRESHED_TIMING_EXCEPTION_OWNERS;
  return null;
}
function isVerifiedTimingExceptionPolicy(policy) {
  return policy?.verified === true && timingExceptionOwnersFor(policy.policySha256) !== null;
}
const TARGET_FILES = [
  'script.json', 'assets/audio/VO_Act1.mp3', 'assets/audio/VO_Act2.mp3', 'assets/audio/VO_Act3.mp3',
  'assets/audio/VO_Act3B.mp3', 'assets/audio/VO_Act4.mp3', 'assets/audio/VO_Act5.mp3',
  'edit-plan.json', 'edit-plan-validation.json', 'edit-plan-shadow-status.json', 'shot-definitions.json',
  'production-manifest.json', 'evidence-source-manifest.json', 'proof-section-plan.json',
];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
const deepClone = value => structuredClone(value);
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonicalJsonSha256 = value => sha256(Buffer.from(JSON.stringify(value), 'utf8'));
const token = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9']/g, '');
const tokens = value => String(value ?? '').split(/\s+/u).map(token).filter(Boolean);

function assertSafeRelative(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error('ACTIVATION_PATH_INVALID');
  return relative;
}

function atomicWrite(fsImpl, file, bytes) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fsImpl.writeFileSync(temp, bytes, { flag: 'wx' }); fsImpl.renameSync(temp, file); }
  finally { try { fsImpl.rmSync(temp, { force: true }); } catch (_) {} }
}

function reserveWhisperAttempt({ fs: fsImpl = fs, ledgerPath, actKey, attempt, maximumTotal = 18, maximumPerAct = 3, at = new Date().toISOString() }) {
  if (typeof ledgerPath !== 'string' || !ledgerPath || typeof actKey !== 'string' || !actKey) throw new Error('ACTIVATION_WHISPER_LEDGER_INPUT_INVALID');
  let rows = [];
  if (fsImpl.existsSync(ledgerPath)) {
    const text = fsImpl.readFileSync(ledgerPath, 'utf8');
    try { rows = text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)); }
    catch (_) { throw new Error('ACTIVATION_WHISPER_LEDGER_CORRUPT'); }
  }
  const countForAct = rows.filter(row => row.eventType === 'request-reserved' && row.actKey === actKey).length;
  const total = rows.filter(row => row.eventType === 'request-reserved').length;
  if (countForAct >= maximumPerAct || total >= maximumTotal) throw new Error(`ACTIVATION_WHISPER_BUDGET_EXHAUSTED:${actKey}`);
  const record = { eventType: 'request-reserved', at, actKey, attempt: countForAct + 1, reportedAttempt: attempt, requestOrdinal: total + 1 };
  fsImpl.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const fd = fsImpl.openSync(ledgerPath, 'a', 0o600);
  try { fsImpl.writeSync(fd, `${JSON.stringify(record)}\n`); fsImpl.fsyncSync(fd); }
  finally { fsImpl.closeSync(fd); }
  return record;
}

function groupWordTimestamps(wordTimestamps, actBindings) {
  if (!Array.isArray(wordTimestamps) || !wordTimestamps.length) throw new Error('ACTIVATION_TIMESTAMPS_EMPTY');
  const byVo = new Map(Object.values(actBindings).map(voKey => [voKey, []]));
  for (const [index, item] of wordTimestamps.entries()) {
    if (!item || typeof item !== 'object' || !byVo.has(item.vo_file)) throw new Error(`ACTIVATION_UNKNOWN_VO:${index}`);
    if (typeof item.word !== 'string' || !Number.isFinite(item.start_seconds) || !Number.isFinite(item.end_seconds)
        || item.start_seconds < 0 || item.end_seconds < item.start_seconds) throw new Error(`ACTIVATION_TIMESTAMP_INVALID:${index}`);
    const actWords = byVo.get(item.vo_file);
    const previous = actWords.at(-1);
    if (previous && (item.start_seconds < previous.start_seconds || item.start_seconds < previous.end_seconds - 0.001)) throw new Error(`ACTIVATION_TIMESTAMP_ORDER:${item.vo_file}:${index}`);
    actWords.push(item);
  }
  for (const [actKey, voKey] of Object.entries(actBindings)) if (!byVo.get(voKey)?.length) throw new Error(`ACTIVATION_ACT_TIMING_MISSING:${actKey}`);
  return byVo;
}

function lcsTables(left, right) {
  const n = left.length, m = right.length, width = m + 1;
  const prefix = new Uint16Array((n + 1) * width);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const at = i * width + j;
    prefix[at] = left[i - 1].canonical === right[j - 1].canonical
      ? prefix[(i - 1) * width + j - 1] + 1
      : Math.max(prefix[(i - 1) * width + j], prefix[i * width + j - 1]);
  }
  const suffix = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const at = i * width + j;
    suffix[at] = left[i].canonical === right[j].canonical
      ? suffix[(i + 1) * width + j + 1] + 1
      : Math.max(suffix[(i + 1) * width + j], suffix[i * width + j + 1]);
  }
  return { prefix, suffix, width, length: prefix[n * width + m] };
}

function uniqueExactUnitPairs(left, right, actKey, requiredIndexes = new Set(left.map((_, index) => index)), forcedTargetIndexes = new Map()) {
  const table = lcsTables(left, right), pairs = new Map();
  for (let i = 0; i < left.length; i++) {
    if (!requiredIndexes.has(i)) continue;
    const targetPositions = [];
    for (let j = 0; j < right.length; j++) {
      if (left[i].canonical === right[j].canonical
          && table.prefix[i * table.width + j] + 1 + table.suffix[(i + 1) * table.width + j + 1] === table.length) targetPositions.push(j);
    }
    if (!targetPositions.length) continue;
    const forcedTarget = forcedTargetIndexes.get(i);
    if (forcedTarget !== undefined) {
      if (!targetPositions.includes(forcedTarget)) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}`);
      pairs.set(i, forcedTarget);
      continue;
    }
    if (targetPositions.length !== 1) {
      throw new Error(`ACTIVATION_BOUNDARY_MAPPING_AMBIGUOUS:${actKey}`);
    }
    pairs.set(i, targetPositions[0]);
  }
  return pairs;
}

function sourceWordSpans(words) {
  const spans = [];
  let offset = 0;
  for (let index = 0; index < words.length; index++) {
    const word = String(words[index]);
    spans.push({ start: offset, end: offset + word.length, wordIndex: index });
    offset += word.length + 1;
  }
  return spans;
}

function lexicalSourceWordIndexes(text, spans) {
  return lexicalTokens(text).map(token => {
    const span = spans.find(item => token.offset >= item.start && token.offset < item.end);
    if (!span) throw new Error('ACTIVATION_BOUNDARY_SOURCE_TOKEN_INVALID');
    return span.wordIndex;
  });
}

function reconstructPlanSourceWords({ plan, actKey, priorTiming }) {
  const sequences = plan.sequences.filter(sequence => sequence.actKey === actKey);
  const beats = sequences.flatMap(sequence => sequence.beats).sort((a, b) => a.startWordIndex - b.startWordIndex);
  const words = Array(priorTiming.wordCount);
  let cursor = 0;
  for (const beat of beats) {
    const { startWordIndex: first, endWordIndex: last } = beat;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first !== cursor || last < first || last >= words.length) {
      throw new Error(`ACTIVATION_PLAN_SOURCE_WORD_COVERAGE:${actKey}`);
    }
    const excerptWords = typeof beat.narrationExcerpt === 'string' ? beat.narrationExcerpt.trim().split(/\s+/u).filter(Boolean) : [];
    if (excerptWords.length !== last - first + 1) throw new Error(`ACTIVATION_PLAN_SOURCE_EXCERPT_MISMATCH:${beat.beatId}`);
    excerptWords.forEach((word, offset) => { words[first + offset] = word; });
    cursor = last + 1;
  }
  if (!beats.length || cursor !== words.length || words.some(word => typeof word !== 'string')) throw new Error(`ACTIVATION_PLAN_SOURCE_WORD_COVERAGE:${actKey}`);
  return { beats, words };
}

function mapPlanSourceWordsToScript({ sourceWords, scriptText, boundaryIndexes, actKey, structuralStartVerified = false, structuralEndVerified = false }) {
  const sourceText = sourceWords.join(' '), sourceLex = lexicalTokens(sourceText), scriptUnits = normalizedUnits(scriptText).units;
  const sourceWordByLexical = lexicalSourceWordIndexes(sourceText, sourceWordSpans(sourceWords));
  const sourceUnits = normalizedUnits(sourceText).units;
  const required = new Set();
  for (const index of boundaryIndexes) {
    const lexicalIndexes = sourceWordByLexical.flatMap((wordIndex, lexicalIndex) => wordIndex === index ? [lexicalIndex] : []);
    if (!lexicalIndexes.length) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${index}`);
    for (const [unitIndex, unit] of sourceUnits.entries()) {
      if (lexicalIndexes.some(lexicalIndex => lexicalIndex >= unit.tokenStart && lexicalIndex <= unit.tokenEnd)) required.add(unitIndex);
    }
  }
  const forced = new Map();
  const setForced = (unitIndex, targetIndex) => {
    if (forced.has(unitIndex) && forced.get(unitIndex) !== targetIndex) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_AMBIGUOUS:${actKey}`);
    forced.set(unitIndex, targetIndex);
  };
  for (const index of boundaryIndexes) {
    const lexicalIndexes = sourceWordByLexical.flatMap((wordIndex, lexicalIndex) => wordIndex === index ? [lexicalIndex] : []);
    const relevant = [...required].filter(unitIndex => lexicalIndexes.some(lexicalIndex => lexicalIndex >= sourceUnits[unitIndex].tokenStart && lexicalIndex <= sourceUnits[unitIndex].tokenEnd));
    if (index === 0 && structuralStartVerified && relevant.length && scriptUnits[0]?.tokenStart === 0) setForced(relevant[0], 0);
    if (index === sourceWords.length - 1 && structuralEndVerified && relevant.length && scriptUnits.at(-1)?.tokenEnd === sourceLex.length - 1) setForced(relevant.at(-1), scriptUnits.length - 1);
  }
  const pairs = uniqueExactUnitPairs(sourceUnits, scriptUnits, actKey, required, forced);
  const mapping = new Map();
  for (const index of boundaryIndexes) {
    const lexicalIndexes = sourceWordByLexical.flatMap((wordIndex, lexicalIndex) => wordIndex === index ? [lexicalIndex] : []);
    const targetRanges = [];
    for (const [unitIndex, unit] of sourceUnits.entries()) {
      if (!lexicalIndexes.some(lexicalIndex => lexicalIndex >= unit.tokenStart && lexicalIndex <= unit.tokenEnd)) continue;
      const targetIndex = pairs.get(unitIndex);
      if (targetIndex === undefined) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${index}`);
      const target = scriptUnits[targetIndex];
      targetRanges.push([target.tokenStart, target.tokenEnd]);
    }
    targetRanges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < targetRanges.length; i++) if (targetRanges[i][0] > targetRanges[i - 1][1] + 1) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_NON_MONOTONIC:${actKey}:${index}`);
    if (!targetRanges.length) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${index}`);
    mapping.set(index, { start: Math.min(...targetRanges.map(range => range[0])), end: Math.max(...targetRanges.map(range => range[1])) });
  }
  return mapping;
}

function mapPlanSourceWordsToTranscript({ sourceWords, words, boundaryIndexes, actKey, structuralStartVerified = false, structuralEndVerified = false }) {
  const sourceText = sourceWords.join(' '), sourceUnits = normalizedUnits(sourceText).units;
  const sourceWordByLexical = lexicalSourceWordIndexes(sourceText, sourceWordSpans(sourceWords));
  const transcriptText = words.map(item => item.word).join(' '), transcriptUnits = normalizedUnits(transcriptText).units;
  const transcriptWordByLexical = transcriptLexicalWordIndexes(words);
  const required = new Set();
  for (const index of boundaryIndexes) {
    const lexicalIndexes = sourceWordByLexical.flatMap((wordIndex, lexicalIndex) => wordIndex === index ? [lexicalIndex] : []);
    if (!lexicalIndexes.length) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${index}`);
    for (const [unitIndex, unit] of sourceUnits.entries()) {
      if (lexicalIndexes.some(lexicalIndex => lexicalIndex >= unit.tokenStart && lexicalIndex <= unit.tokenEnd)) required.add(unitIndex);
    }
  }
  const forced = new Map();
  const setForced = (unitIndex, targetIndex) => {
    if (forced.has(unitIndex) && forced.get(unitIndex) !== targetIndex) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_AMBIGUOUS:${actKey}`);
    forced.set(unitIndex, targetIndex);
  };
  for (const index of boundaryIndexes) {
    const lexicalIndexes = sourceWordByLexical.flatMap((wordIndex, lexicalIndex) => wordIndex === index ? [lexicalIndex] : []);
    const relevant = [...required].filter(unitIndex => lexicalIndexes.some(lexicalIndex => lexicalIndex >= sourceUnits[unitIndex].tokenStart && lexicalIndex <= sourceUnits[unitIndex].tokenEnd));
    if (index === 0 && structuralStartVerified && relevant.length && transcriptUnits[0]?.tokenStart === 0) setForced(relevant[0], 0);
    if (index === sourceWords.length - 1 && structuralEndVerified && relevant.length && transcriptUnits.at(-1)?.tokenEnd === lexicalToWord.length - 1) setForced(relevant.at(-1), transcriptUnits.length - 1);
  }
  const pairs = uniqueExactUnitPairs(sourceUnits, transcriptUnits, actKey, required, forced), mapping = new Map();
  for (const index of boundaryIndexes) {
    const lexicalIndexes = sourceWordByLexical.flatMap((wordIndex, lexicalIndex) => wordIndex === index ? [lexicalIndex] : []);
    const targetRanges = [];
    for (const [unitIndex, unit] of sourceUnits.entries()) {
      if (!lexicalIndexes.some(lexicalIndex => lexicalIndex >= unit.tokenStart && lexicalIndex <= unit.tokenEnd)) continue;
      const targetIndex = pairs.get(unitIndex);
      if (targetIndex === undefined) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${index}`);
      const target = transcriptUnits[targetIndex];
      targetRanges.push([
        transcriptWordByLexical[target.tokenStart],
        transcriptWordByLexical[target.tokenEnd],
      ]);
    }
    targetRanges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < targetRanges.length; i++) {
      if (targetRanges[i][0] > targetRanges[i - 1][1] + 1) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_NON_MONOTONIC:${actKey}:${index}`);
    }
    if (!targetRanges.length) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${index}`);
    mapping.set(index, { start: Math.min(...targetRanges.map(range => range[0])), end: Math.max(...targetRanges.map(range => range[1])) });
  }
  return mapping;
}

function verifyReviewedTranscriptRange(range, scriptToTranscript, actKey, boundaryIndex) {
  const covered = new Set();
  for (const mapped of scriptToTranscript) {
    if (mapped.end < range.start || mapped.start > range.end) continue;
    for (let index = mapped.start; index <= mapped.end; index++) covered.add(index);
  }
  for (let index = range.start; index <= range.end; index++) {
    if (!covered.has(index)) throw new Error(`ACTIVATION_BOUNDARY_REVIEW_RELATION_MISSING:${actKey}:${boundaryIndex}`);
  }
  if ([...covered].some(index => index < range.start || index > range.end)) throw new Error(`ACTIVATION_BOUNDARY_REVIEW_RELATION_AMBIGUOUS:${actKey}:${boundaryIndex}`);
}

function deriveRefreshedWhitespaceRange({ scriptText, lexicalRange, expectedExcerpt } = {}) {
  const lexical = lexicalTokens(scriptText);
  const whitespace = [...String(scriptText || '').matchAll(/\S+/gu)].map(match => ({ text: match[0], start: match.index, end: match.index + match[0].length - 1 }));
  if (!lexicalRange || lexicalRange.indexConvention !== 'zero-based-inclusive-act-local-lexical-word'
      || !Number.isSafeInteger(lexicalRange.start) || !Number.isSafeInteger(lexicalRange.end)
      || lexicalRange.start < 0 || lexicalRange.end < lexicalRange.start || !lexical[lexicalRange.start] || !lexical[lexicalRange.end]) throw new Error('ACTIVATION_REFRESHED_BOUNDARY_LEXICAL_RANGE_INVALID');
  const selected = lexical.slice(lexicalRange.start, lexicalRange.end + 1);
  const translated = selected.map(token => whitespace.flatMap((span, index) => token.offset >= span.start && token.offset <= span.end ? [index] : []));
  if (translated.some(indexes => indexes.length !== 1)) throw new Error('ACTIVATION_REFRESHED_BOUNDARY_LEXICAL_TRANSLATION_AMBIGUOUS');
  const indexes = translated.map(indexes => indexes[0]);
  const start = Math.min(...indexes), end = Math.max(...indexes);
  const canonical = value => String(value || '').normalize('NFKC').replace(/[’‘`]/gu, "'").toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}']/gu, ' ').replace(/\s+/gu, ' ').trim();
  const lexicalText = selected.map(token => token.surface).join(' '), whitespaceText = whitespace.slice(start, end + 1).map(token => token.text).join(' ');
  if (canonical(lexicalText) !== canonical(expectedExcerpt) || canonical(whitespaceText) !== canonical(expectedExcerpt)) throw new Error('ACTIVATION_REFRESHED_BOUNDARY_LEXICAL_TEXT_MISMATCH');
  return { start, end, excerpt: whitespaceText, lexicalText };
}

function verifyApprovedBoundaryPolicy({ policy, policyBytes, script, scriptSha256, amendmentSha256, actualBindings }) {
  if (!Buffer.isBuffer(policyBytes)) throw new Error('ACTIVATION_APPROVED_BOUNDARY_POLICY_HASH_MISMATCH');
  const canonicalPolicyBytes = Buffer.from(policyBytes.toString('utf8').replace(/\r\n/gu, '\n'));
  const receivedHash = sha256(canonicalPolicyBytes);
  if (![APPROVED_BOUNDARY_POLICY_SHA256, REFRESHED_BOUNDARY_POLICY_SHA256].includes(receivedHash)) throw new Error('ACTIVATION_APPROVED_BOUNDARY_POLICY_HASH_MISMATCH');
  let parsedPolicy;
  try { parsedPolicy = JSON.parse(canonicalPolicyBytes.toString('utf8')); } catch (_) { throw new Error('ACTIVATION_APPROVED_BOUNDARY_POLICY_JSON_INVALID'); }
  if (!equal(policy, parsedPolicy)) throw new Error('ACTIVATION_APPROVED_BOUNDARY_POLICY_OBJECT_MISMATCH');
  if (receivedHash === REFRESHED_BOUNDARY_POLICY_SHA256) {
    const fail = code => { throw new Error(code); };
    if (policy?.schemaVersion !== 'phase2.3b-p-approved-boundary-ranges/2.0.0'
        || policy.status !== 'USER_APPROVED'
        || policy.runId !== 'phase2-3b-p-act-20260925'
        || policy.episodeId !== 'e59b6b79-96aa-4dcd-92c3-749fd536f55e'
        || policy.channelKey !== 'EmpireOmitted'
        || !equal(policy.binding, REFRESHED_BOUNDARY_POLICY_BINDINGS)
        || !equal(actualBindings, REFRESHED_BOUNDARY_POLICY_BINDINGS)
        || scriptSha256 !== REFRESHED_BOUNDARY_POLICY_BINDINGS.candidateScriptSha256
        || amendmentSha256 !== REFRESHED_BOUNDARY_POLICY_BINDINGS.candidateAmendmentSha256
        || policy.approval?.approvedBy !== 'Yakubu Moshood'
        || policy.approval?.decision !== 'APPROVED'
        || policy.approval?.alignmentProposalSha256 !== REFRESHED_BOUNDARY_POLICY_BINDINGS.alignmentProposalSha256
        || policy.approval?.alignmentApprovalSha256 !== REFRESHED_BOUNDARY_POLICY_BINDINGS.alignmentApprovalSha256
        || policy.approval?.boundaryProposalSha256 !== REFRESHED_BOUNDARY_POLICY_BINDINGS.boundaryProposalSha256
        || policy.approval?.boundaryApprovalSha256 !== REFRESHED_BOUNDARY_POLICY_BINDINGS.boundaryApprovalSha256) fail('ACTIVATION_REFRESHED_BOUNDARY_BINDING_MISMATCH');
    const exactIds = (actual, expected, label) => {
      if (!Array.isArray(expected) || !Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index]) || new Set(actual).size !== actual.length) fail(`ACTIVATION_REFRESHED_BOUNDARY_DECISION_SET_INVALID:${label}`);
    };
    exactIds(policy.boundaryAuthorizations?.map(item => item.authorizationId), policy.decisionOrder?.boundaryAuthorizations, 'AUTHORIZATIONS');
    exactIds(policy.allocations?.map(item => `${item.actKey}:${item.beatId}`), policy.decisionOrder?.allocations, 'ALLOCATIONS');
    exactIds(policy.retirements?.map(item => `${item.actKey}:${item.beatId}`), policy.decisionOrder?.retirements, 'RETIREMENTS');
    if (!equal(policy.declaredCounts, { boundaryAuthorizations: policy.decisionOrder.boundaryAuthorizations.length, allocations: policy.decisionOrder.allocations.length, retirements: policy.decisionOrder.retirements.length })
        || policy.unlistedChangesPolicy !== 'REFUSE'
        || policy.supersedesPolicySha256 !== APPROVED_BOUNDARY_POLICY_SHA256
        || policy.tokenization?.act3Translation !== 'lexical-token-offset-to-whitespace-span-intersection/1.0.0') fail('ACTIVATION_REFRESHED_BOUNDARY_DECISION_SET_INVALID:COUNTS');
    for (const item of policy.allocations) {
      const beatKey = `${item.actKey}:${item.beatId}`;
      if (!Number.isSafeInteger(item.startTokenIndex) || !Number.isSafeInteger(item.endTokenIndex) || item.startTokenIndex < 0 || item.endTokenIndex < item.startTokenIndex
          || !item.whitespaceRange || item.whitespaceRange.start !== item.startTokenIndex || item.whitespaceRange.end !== item.endTokenIndex
          || item.whitespaceRange.indexConvention !== 'zero-based-inclusive-whitespace-token') fail(`ACTIVATION_REFRESHED_BOUNDARY_RANGE_MISMATCH:${beatKey}`);
      if (item.actKey === 'act3') {
        let translated;
        try { translated = deriveRefreshedWhitespaceRange({ scriptText: script?.acts?.act3?.voScript, lexicalRange: item.lexicalRange, expectedExcerpt: item.excerpt }); }
        catch (error) { fail(`ACTIVATION_REFRESHED_BOUNDARY_LEXICAL_TRANSLATION_MISMATCH:${beatKey}:${error.message}`); }
        if (translated.start !== item.startTokenIndex || translated.end !== item.endTokenIndex || translated.excerpt !== item.excerpt) fail(`ACTIVATION_REFRESHED_BOUNDARY_LEXICAL_TRANSLATION_MISMATCH:${beatKey}`);
      }
    }
    const expected = new Map(policy.allocations.map(item => [`${item.actKey}:${item.beatId}`, item]));
    const retired = new Map(policy.retirements.map(item => [`${item.actKey}:${item.beatId}`, item]));
    const lineageEntries = [...policy.allocations.map(item => [item.revisionLineageEntry, `approved-range:${item.actKey}:${item.beatId}`]), ...policy.retirements.map(item => [item.revisionLineageEntry, `approved-retirement:${item.actKey}:${item.beatId}`])];
    if (lineageEntries.some(([actual, expectedEntry]) => actual !== expectedEntry && !(actual === `phase2.3b-b017-factual-correction/1.0.0:${expectedEntry.split(':').at(-1)}` && expectedEntry.startsWith('approved-range:act3:'))) || new Set(lineageEntries.map(([actual]) => actual)).size !== lineageEntries.length) fail('ACTIVATION_APPROVED_BOUNDARY_LINEAGE_ENTRY_INVALID');
    for (const [key, item] of expected) {
      const tokens = String(script?.acts?.[item.actKey]?.voScript || '').trim().split(/\s+/u);
      if (tokens.slice(item.startTokenIndex, item.endTokenIndex + 1).join(' ') !== item.excerpt) fail(`ACTIVATION_APPROVED_BOUNDARY_RANGE_MISMATCH:${key}`);
    }
    if (!retired.has('act3b:ACT3B_B010') || expected.has('act3b:ACT3B_B010')) fail('ACTIVATION_REFRESHED_BOUNDARY_RETIREMENT_INVALID');
    return { verified: true, policySha256: receivedHash, supersedesPolicySha256: policy.supersedesPolicySha256, allocations: [...expected.values()], retirements: [...retired.values()], boundaryAuthorizations: deepFreeze(deepClone(policy.boundaryAuthorizations)), byBeat: expected, retiredByBeat: retired, refreshedPolicy: true };
  }
  if (policy?.schemaVersion !== 'phase2.3b-p-approved-boundary-ranges/1.1.0'
      || policy.scriptSha256 !== scriptSha256
      || scriptSha256 !== '319d0cf162b7a90a8c163e2edb0fe12b37acaf0d36a22e59995dda1a42db1955'
      || amendmentSha256 !== policy.revisionLineage?.amendmentSha256
      || policy.revisionLineage?.revisionId !== 'phase2.3b-s-approved-factual-correction'
      || policy.revisionLineage?.candidateScriptArtifact !== 'candidate-script.json'
      || policy.revisionLineage?.candidateScriptPackageSha256 !== scriptSha256
      || policy.tokenization?.rangeTokenization !== 'js-trim-split-whitespace/1.0.0'
      || policy.tokenization?.mappingTokenization !== 'phase2.3b-p-lexical-tokenization/1.0.0'
      || policy.tokenization?.indexConvention !== 'zero-based-inclusive'
      || policy.boundaryAuthorizationsVersion !== 'phase2.3b-p-boundary-authorizations/1.0.0'
      || !/^[a-f0-9]{64}$/u.test(policy.supersedesPolicySha256 || '')
      || policy.boundaryAuthorizations?.some(item => item?.authorizationVersion !== 'phase2.3b-p-boundary-authorization/1.0.0'
        || typeof item.authorizationId !== 'string' || !item.authorizationId
        || typeof item.actKey !== 'string' || typeof item.beatId !== 'string'
        || !['start', 'end'].includes(item.edge)
        || !Number.isSafeInteger(item.sourceBoundaryIndex) || item.sourceBoundaryIndex < 0
        || !Number.isSafeInteger(item.targetTranscriptIndex) || item.targetTranscriptIndex < 0
        || !item.sourceBeatRange || !Number.isSafeInteger(item.sourceBeatRange.startWordIndex)
        || !Number.isSafeInteger(item.sourceBeatRange.endWordIndex) || item.sourceBeatRange.indexConvention !== 'zero-based-inclusive'
        || !item.approvedTranscriptSpan || !Number.isSafeInteger(item.approvedTranscriptSpan.startIndex)
        || !Number.isSafeInteger(item.approvedTranscriptSpan.endIndex) || item.approvedTranscriptSpan.indexConvention !== 'zero-based-inclusive'
        || !Array.isArray(item.sourceAnchors) || !item.sourceAnchors.length
        || !Array.isArray(item.candidateAnchors) || !item.candidateAnchors.length
        || !Array.isArray(item.transcriptAnchors) || !item.transcriptAnchors.length
        || !item.uniqueAnchorSequences || Object.values(item.uniqueAnchorSequences).some(sequence => !Array.isArray(sequence) || !sequence.length || sequence.some(tokenValue => typeof tokenValue !== 'string'))
        || !item.inputHashes || Object.values(item.inputHashes).some(hash => !/^[a-f0-9]{64}$/u.test(hash || ''))
        || item.inputHashes.previousApprovedBoundaryPolicySha256 !== policy.supersedesPolicySha256
        || typeof item.revisionLineageEntry !== 'string' || !item.revisionLineageEntry)
      || !Array.isArray(policy.boundaryAuthorizations)
      || new Set(policy.boundaryAuthorizations.map(item => item.authorizationId)).size !== policy.boundaryAuthorizations.length
      || new Set(policy.boundaryAuthorizations.map(item => `${item.actKey}:${item.beatId}:${item.edge}:${item.sourceBoundaryIndex}`)).size !== policy.boundaryAuthorizations.length
      || policy.boundaryAuthorizations.some(item => item.inputHashes.candidateScriptSha256 !== policy.scriptSha256
        || item.inputHashes.candidateAmendmentSha256 !== policy.revisionLineage.amendmentSha256)) throw new Error('ACTIVATION_APPROVED_BOUNDARY_BINDING_MISMATCH');
  const expected = new Map(policy.allocations.map(item => [`${item.actKey}:${item.beatId}`, item]));
  const retired = new Map(policy.retirements.map(item => [`${item.actKey}:${item.beatId}`, item]));
  const lineageEntries = [...policy.allocations.map(item => [item.revisionLineageEntry, `approved-range:${item.actKey}:${item.beatId}`]), ...policy.retirements.map(item => [item.revisionLineageEntry, `approved-retirement:${item.actKey}:${item.beatId}`])];
  if (lineageEntries.some(([actual, expectedEntry]) => actual !== expectedEntry) || new Set(lineageEntries.map(([actual]) => actual)).size !== lineageEntries.length) throw new Error('ACTIVATION_APPROVED_BOUNDARY_LINEAGE_ENTRY_INVALID');
  for (const [key, item] of expected) {
    const text = script?.acts?.[item.actKey]?.voScript;
    const tokens = typeof text === 'string' ? text.trim().split(/\s+/u) : [];
    if (!Number.isSafeInteger(item.startTokenIndex) || !Number.isSafeInteger(item.endTokenIndex) || item.startTokenIndex < 0 || item.endTokenIndex < item.startTokenIndex
        || tokens.slice(item.startTokenIndex, item.endTokenIndex + 1).join(' ') !== item.excerpt) throw new Error(`ACTIVATION_APPROVED_BOUNDARY_RANGE_MISMATCH:${key}`);
  }
  if (expected.size !== 6 || retired.size !== 1 || !retired.has('act3b:ACT3B_B010')) throw new Error('ACTIVATION_APPROVED_BOUNDARY_SET_INVALID');
  return { verified: true, policySha256: APPROVED_BOUNDARY_POLICY_SHA256, supersedesPolicySha256: policy.supersedesPolicySha256, allocations: [...expected.values()], retirements: [...retired.values()], boundaryAuthorizations: deepFreeze(deepClone(policy.boundaryAuthorizations)), byBeat: expected, retiredByBeat: retired };
}

function approvedTimingProductionObligations({ shot, manifestEntry }) {
  const fields = {
    productionMethod: manifestEntry?.productionMethod,
    visualClass: shot?.visualClass,
    assetType: shot?.assetType,
    visualIntent: shot?.visualIntent,
    rhythmIntent: shot?.rhythmIntent,
    intentionalStillness: shot?.intentionalStillness,
    postNarrationHoldSec: shot?.postNarrationHoldSec,
    reconstructionMode: shot?.reconstructionMode,
    continuityRefs: shot?.continuityRefs,
    audioDirection: shot?.audioDirection,
    visual: shot?.visual,
    motionIntent: shot?.motionIntent,
    evidenceRequirement: shot?.evidenceRequirement,
    graphics: shot?.graphics,
    overlaySpecification: shot?.overlaySpecification,
    sourceSearchInstruction: shot?.sourceSearchInstruction,
    sourceRequirement: manifestEntry?.sourceRequirement,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function normalizeTimingAnchor(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu, '');
}

function refreshedTimingOwnerProjection(shotDefinitions, productionManifest) {
  return REFRESHED_TIMING_OWNER_KEYS.map(key => {
    const [actKey, beatId] = key.split(':');
    const canonical = (shotDefinitions?.allShots || []).filter(shot => shot?.actKey === actKey && shot?.beatId === beatId && shot?.shotId === beatId);
    const mirrors = (shotDefinitions?.acts?.[actKey] || []).filter(shot => shot?.actKey === actKey && shot?.beatId === beatId && shot?.shotId === beatId);
    const records = (productionManifest?.shots || []).filter(shot => shot?.actKey === actKey && shot?.shotId === beatId);
    if (canonical.length !== 1 || mirrors.length !== 1 || records.length !== 1) throw new Error(`ACTIVATION_REFRESHED_TIMING_OWNER_SCOPE_INVALID:${key}`);
    return { actKey, beatId, canonical: canonical[0], mirror: mirrors[0], manifest: records[0] };
  });
}

function verifyRefreshedTimingRevisionLineage({ policy, lineageEvidence, script, scriptSha256, shotDefinitions, productionManifest, actualBindings } = {}) {
  const fail = code => { throw new Error(code); };
  const proof = policy?.revisionLineage;
  if (!lineageEvidence || !Buffer.isBuffer(lineageEvidence.parentAmendmentBytes)
      || !Buffer.isBuffer(lineageEvidence.childAmendmentBytes)
      || !Buffer.isBuffer(lineageEvidence.parentScriptBytes)
      || !Buffer.isBuffer(lineageEvidence.parentShotDefinitionsBytes)
      || !Buffer.isBuffer(lineageEvidence.parentProductionManifestBytes)
      || !Array.isArray(lineageEvidence.revisionChainBytes) || lineageEvidence.revisionChainBytes.length !== 3
      || !Array.isArray(lineageEvidence.revisionChain) || lineageEvidence.revisionChain.length !== 3) fail('ACTIVATION_REFRESHED_TIMING_REVISION_LINEAGE_MISSING');
  const hashes = {
    parentAmendmentSha256: sha256(lineageEvidence.parentAmendmentBytes),
    childAmendmentSha256: sha256(lineageEvidence.childAmendmentBytes),
    parentScriptSha256: sha256(lineageEvidence.parentScriptBytes),
    currentScriptSha256: scriptSha256,
    parentShotDefinitionsSha256: sha256(lineageEvidence.parentShotDefinitionsBytes),
    currentShotDefinitionsSha256: actualBindings?.candidateShotDefinitionsSha256,
    parentProductionManifestSha256: sha256(lineageEvidence.parentProductionManifestBytes),
    currentProductionManifestSha256: actualBindings?.candidateProductionManifestSha256,
    revisionChainFileSha256s: lineageEvidence.revisionChainBytes.map(sha256),
  };
  if (hashes.parentAmendmentSha256 !== REFRESHED_ORIGINAL_TIMING_AMENDMENT_SHA256
      || hashes.childAmendmentSha256 !== REFRESHED_B017_AMENDMENT_SHA256
      || hashes.parentScriptSha256 !== '319d0cf162b7a90a8c163e2edb0fe12b37acaf0d36a22e59995dda1a42db1955'
      || hashes.currentScriptSha256 !== REFRESHED_BOUNDARY_POLICY_BINDINGS.candidateScriptSha256
      || hashes.parentShotDefinitionsSha256 !== '6ab68c87b61c21b6b3bf74ee419885766c9603b021c0a9c8473be93715cdb71b'
      || hashes.currentShotDefinitionsSha256 !== '0aaabb2ddac2b607d8b8580af578fd1375aff8aee4f5ee26354d1145f421bbb1'
      || hashes.parentProductionManifestSha256 !== '9fc39863342bec152ea81363fab45919e181f5f16f66272c617e445e922e1aed'
      || hashes.currentProductionManifestSha256 !== '364eeeedb1a5ddfc91a3761f0f99806fb46dad902586b4dfd83e70a613f14dfe'
      || !equal(hashes.revisionChainFileSha256s, REFRESHED_REVISION_CHAIN_FILE_SHA256S)) fail('ACTIVATION_REFRESHED_TIMING_REVISION_LINEAGE_HASH_MISMATCH');
  let amendment, parentScript, parentShots, parentManifest;
  try {
    amendment = JSON.parse(lineageEvidence.childAmendmentBytes.toString('utf8'));
    parentScript = JSON.parse(lineageEvidence.parentScriptBytes.toString('utf8'));
    parentShots = JSON.parse(lineageEvidence.parentShotDefinitionsBytes.toString('utf8'));
    parentManifest = JSON.parse(lineageEvidence.parentProductionManifestBytes.toString('utf8'));
  } catch (_) { fail('ACTIVATION_REFRESHED_TIMING_REVISION_LINEAGE_JSON_INVALID'); }
  const expectedAmendmentBindings = {
    parentCandidateScriptSha256: hashes.parentScriptSha256,
    candidateScriptSha256: hashes.currentScriptSha256,
    sourceEditPlanParentSha256: 'a15f99e70788343569a9620695923e94374f8c12986fcffc21e143d290a7a03a',
    sourceEditPlanSha256: '94366ed6e448b79ff6568d42ed0903708dda37da7ae93c80f4db7fa3bffe4504',
    parentShotDefinitionsSha256: hashes.parentShotDefinitionsSha256,
    shotDefinitionsSha256: hashes.currentShotDefinitionsSha256,
    parentProductionManifestSha256: hashes.parentProductionManifestSha256,
    productionManifestSha256: hashes.currentProductionManifestSha256,
    evidenceMatrixSha256: 'bc255ed7b49a3e1898f574936f0b65cecb20a8f8753c7dbde88be14d779cc841',
    evidenceManifestSha256: 'aa13ec374430ee86d7438d9ba6202755dcb1f7c483603e8bd18f01e9227f6ef8',
    sourceRightsLogSha256: '127a2e65245749102f71b9cf526f4f863fd44e1b39d88f8f269e9cf2982e6cef',
    assetSha256: '9ffceab6cffe4419e12a7f10e7f6b475d780337296aaf654aaa0eef62140b1ca',
    lineageLedgerSha256: hashes.revisionChainFileSha256s[2],
    existingBoundaryPolicySha256: 'fb4f0a80ebe3ab4bded1f4786defc57b6348e485d79cfd6c2396e6f700829b98',
    existingTimingPolicySha256: APPROVED_TIMING_EXCEPTION_POLICY_SHA256,
    retainedTranscriptSha256: '238a5316b9297a07f4c3122212e2131d64ac1c6ac55ec61237867a2f8f5e70a1',
    reviewedAlignmentStatus: 'STALE_FOR_ACT3_NARRATION',
    approvalPolicyStatus: 'EVIDENCE_PENDING_HUMAN_APPROVAL',
    sourceEditPlanFingerprint: '6961a94a032a2f40450e90582788a781dac7f17a6ac0c5cebb8a5ce0dadbd748',
    candidatePackagePath: 'artifacts/empire-omitted-v3/wells-fargo/phase2.3b-b017-candidate',
  };
  if (amendment?.schemaVersion !== 'phase2.3b-b017-factual-correction/1.0.0'
      || !equal(amendment.bindings, expectedAmendmentBindings)
      || !equal(amendment.affectedBeats?.map(item => item.beatId), REFRESHED_B017_CHANGED_BEATS)
      || amendment.replacement?.before !== 'One whistleblower described watching a colleague open 24 accounts in a single day for customers who had never set foot in the branch.'
      || amendment.replacement?.after !== 'The board’s investigation found a branch manager’s teenage daughter had 24 accounts, an adult daughter had 18, and the manager’s spouse had 21.') fail('ACTIVATION_REFRESHED_TIMING_B017_AMENDMENT_SCOPE_INVALID');
  const rebuiltScript = deepClone(parentScript);
  const originalAct3 = String(rebuiltScript?.acts?.act3?.voScript || '');
  if (!originalAct3 || originalAct3.split(amendment.replacement.before).length !== 2) fail('ACTIVATION_REFRESHED_TIMING_B017_SCRIPT_PARENT_AMBIGUOUS');
  rebuiltScript.acts.act3.voScript = originalAct3.replace(amendment.replacement.before, amendment.replacement.after);
  if (sha256(Buffer.from(`${JSON.stringify(rebuiltScript, null, 2)}\n`, 'utf8')) !== hashes.currentScriptSha256
      || sha256(Buffer.from(`${JSON.stringify(script, null, 2)}\n`, 'utf8')) !== hashes.currentScriptSha256) fail('ACTIVATION_REFRESHED_TIMING_B017_SCRIPT_TRANSFORM_MISMATCH');
  const revisionModule = require('./revision-lineage.cjs');
  const revision = revisionModule.validateRevisionChain({ shotDefs: shotDefinitions, revisionChain: lineageEvidence.revisionChain });
  if (revision.status !== 'PASS' || revision.errors.length || revision.reconstructedParentHashes.at(-1) !== hashes.parentShotDefinitionsSha256) fail('ACTIVATION_REFRESHED_TIMING_REVISION_CHAIN_INVALID');
  const parentScope = refreshedTimingOwnerProjection(parentShots, parentManifest);
  const currentScope = refreshedTimingOwnerProjection(shotDefinitions, productionManifest);
  if (!equal(parentScope, currentScope)) fail('ACTIVATION_REFRESHED_TIMING_OWNER_SCOPE_CHANGED');
  const preservedTimingScopeSha256 = canonicalJsonSha256(currentScope);
  const expectedProof = {
    schemaVersion: 'phase2.3b-p-timing-revision-lineage-proof/1.0.0',
    approvalProvenanceAmendmentSha256: hashes.parentAmendmentSha256,
    currentCandidateAmendmentSha256: hashes.childAmendmentSha256,
    revisionChainFileSha256s: hashes.revisionChainFileSha256s,
    parentCandidateScriptSha256: hashes.parentScriptSha256,
    currentCandidateScriptSha256: hashes.currentScriptSha256,
    parentShotDefinitionsSha256: hashes.parentShotDefinitionsSha256,
    currentShotDefinitionsSha256: hashes.currentShotDefinitionsSha256,
    reconstructedParentShotDefinitionsSha256: revision.reconstructedParentHashes.at(-1),
    parentProductionManifestSha256: hashes.parentProductionManifestSha256,
    currentProductionManifestSha256: hashes.currentProductionManifestSha256,
    changedBeatIds: [...REFRESHED_B017_CHANGED_BEATS],
    preservedTimingOwnerKeys: [...REFRESHED_TIMING_OWNER_KEYS],
    preservedTimingScopeSha256,
  };
  if (!equal(proof, expectedProof)) fail('ACTIVATION_REFRESHED_TIMING_REVISION_PROOF_MISMATCH');
  return expectedProof;
}

function verifyApprovedTimingExceptionPolicy({ policy, policyBytes, actualBindings, actualRefreshBindings, plan, script, shotDefinitions, productionManifest, approvedBoundaryPolicy, wordTimestamps, lineageEvidence, expectedPolicySha256 = APPROVED_TIMING_EXCEPTION_POLICY_SHA256 } = {}) {
  if (!Buffer.isBuffer(policyBytes)) throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_HASH_MISMATCH');
  const canonicalBytes = Buffer.from(policyBytes.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8');
  if (![APPROVED_TIMING_EXCEPTION_POLICY_SHA256, REFRESHED_TIMING_EXCEPTION_POLICY_SHA256].includes(expectedPolicySha256)
      || sha256(canonicalBytes) !== expectedPolicySha256) throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_HASH_MISMATCH');
  const refreshed = expectedPolicySha256 === REFRESHED_TIMING_EXCEPTION_POLICY_SHA256;
  let parsed;
  try { parsed = JSON.parse(canonicalBytes.toString('utf8')); } catch (_) { throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_JSON_INVALID'); }
  if (!equal(policy, parsed)) throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_OBJECT_MISMATCH');
  if (policy?.schemaVersion !== (refreshed ? 'phase2.3b-p-approved-timing-exceptions/5.0.0' : 'phase2.3b-p-approved-timing-exceptions/3.0.0') || policy.status !== 'USER_APPROVED'
      || !policy.approval || typeof policy.approval.approvedBy !== 'string' || !policy.approval.approvedBy.trim()
      || typeof policy.approval.approvalRef !== 'string' || !policy.approval.approvalRef.trim()
      || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(policy.approval.recordedDate || '')
      || policy.runId !== actualBindings?.runId || policy.episodeId !== actualBindings?.episodeId
      || policy.channelKey !== actualBindings?.channelKey || !plan || !script || !shotDefinitions || !productionManifest
      || approvedBoundaryPolicy?.verified !== true || approvedBoundaryPolicy.policySha256 !== (refreshed ? REFRESHED_BOUNDARY_POLICY_SHA256 : APPROVED_BOUNDARY_POLICY_SHA256)) {
    throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_APPROVAL_INVALID');
  }
  const requiredBindings = [
    'runId', 'episodeId', 'channelKey', 'lockedEditPlanSha256', 'candidatePreTimingEditPlanSha256',
    'candidateScriptSha256', 'retainedTranscriptSha256', 'alignmentProposalSha256', 'alignmentApprovalSha256',
    'approvedBoundaryPolicySha256', 'candidateAmendmentSha256', 'candidateHistorySha256',
    'candidateShotDefinitionsSha256', 'candidateProductionManifestSha256',
  ];
  if (!equal(Object.keys(policy.binding || {}).sort(), [...requiredBindings].sort())
      || !equal(Object.keys(actualBindings || {}).sort(), [...requiredBindings].sort())
      || !equal(policy.binding, actualBindings)
      || requiredBindings.filter(key => key.endsWith('Sha256')).some(key => !/^[a-f0-9]{64}$/u.test(policy.binding[key] || ''))
      || policy.binding.approvedBoundaryPolicySha256 !== (refreshed ? REFRESHED_BOUNDARY_POLICY_SHA256 : APPROVED_BOUNDARY_POLICY_SHA256)) {
    throw new Error('ACTIVATION_TIMING_EXCEPTION_BINDING_MISMATCH');
  }
  if (refreshed) {
    const expectedRefreshBindings = {
      packageIndexSha256: '4ad51af55f4686b60ceed7c5fecad5d6fa477b6151ec8dcad05f6d9334fa86c0',
      proposalSha256: '7e618440e80c7fe7314bbf48719ed90ff89dffac0ea669d88262074280ec637a',
      alignmentApprovalSha256: '32936b3c7279c8636c0b1ba9709c4ee8afe04a4a84eb3bea32579cf0a42bad42',
      boundaryApprovalSha256: '29c6d85046da6d1d136c617d1f75e77b62cdcc88e69753593dd0b2a5f1fc113f',
      boundaryPolicySha256: REFRESHED_BOUNDARY_POLICY_SHA256,
      timestampsSha256: 'e7c341bdde3cd0537bcb6a840dd130b185864ebc25d659b60f27362f9464dea0',
      audioManifestSha256: '1aeedf337e7b1356174472fe725ddc1e7755ec595e23e98b984cea8577196e4d',
      evidenceApprovalSha256: 'c0de5baef64e8a9ff6a612b58f2d5089cd6789562c3b367686d243ca72c0afb2',
      requestLedgerSha256: 'c8b6ad421c378081a6111c51151c4c73a87dadcf2c475194d522e5791407abaf',
      timingApprovalRecordSha256: 'fdbc2b00514772350c5b9acb1fafe771e18e8e7f52caa0778e84c67fd34a12b1',
    };
    const approval = policy.approval || {};
    if (!equal(policy.refreshBindings, expectedRefreshBindings)
        || !equal(actualRefreshBindings, expectedRefreshBindings)
        || policy.approvalProvenanceAmendmentSha256 !== REFRESHED_ORIGINAL_TIMING_AMENDMENT_SHA256
        || policy.currentCandidateAmendmentSha256 !== REFRESHED_B017_AMENDMENT_SHA256
        || policy.proposalSha256 !== expectedRefreshBindings.proposalSha256
        || policy.packageIndexSha256 !== expectedRefreshBindings.packageIndexSha256
        || policy.formalExceptionCount !== 9 || policy.editorialIntentMigrationCount !== 5
        || !equal(policy.excludedFormalExceptionIds, ['act3:ACT3_B025'])
        || approval.proposalSha256 !== expectedRefreshBindings.proposalSha256
        || !/^[a-f0-9]{64}$/u.test(approval.approvalRecordSha256 || '')
        || approval.approvedBy !== 'Yakubu Moshood'
        || approval.approvalRef !== 'phase2.3b-act3-refresh-timing-2026-09-28'
        || approval.decision !== 'APPROVED') throw new Error('ACTIVATION_REFRESHED_TIMING_APPROVAL_BINDING_MISMATCH');
  }
  const refreshedLineageProof = refreshed ? verifyRefreshedTimingRevisionLineage({
    policy, lineageEvidence, script, scriptSha256: actualBindings.candidateScriptSha256,
    shotDefinitions, productionManifest, actualBindings,
  }) : null;
  if (policy.tokenization?.sourcePlan !== 'edit-plan-schema/3.0.0-inclusive-word-indices'
      || policy.tokenization?.candidateScript !== 'js-trim-split-whitespace/1.0.0'
      || policy.tokenization?.retainedTranscript !== 'word-timestamps-array/zero-based-inclusive/1.0.0'
      || policy.tokenization?.timingBoundary !== 'next-word-start-or-act-terminal-boundary/1.0.0'
      || !Array.isArray(policy.exceptions) || policy.exceptions.length !== (refreshed ? 9 : 10)) {
    throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_CONTRACT_INVALID');
  }
  const expectedOwners = refreshed ? REFRESHED_TIMING_EXCEPTION_OWNERS : OLD_TIMING_EXCEPTION_OWNERS;
  if (!equal(policy.exceptions.map(item => `${item.actKey}:${item.beatId}`).sort(), [...expectedOwners].sort())) throw new Error('ACTIVATION_TIMING_EXCEPTION_SET_INVALID');
  const remediation = policy.resumeEligibility;
  const expectedRemediationKeys = ['failureError','completedActs','attemptsByAct','alignmentApprovalExceptionCount','expectedBoundaryCounts','expectedActiveBeatCounts','expectedTotalDurationSec','totalDurationToleranceSec'];
  if (!equal(Object.keys(remediation || {}).sort(), expectedRemediationKeys.sort())
      || typeof remediation.failureError !== 'string' || !remediation.failureError
      || !equal(remediation.completedActs, ['act1','act2','act3','act3b','act4','act5'])
      || !equal(remediation.attemptsByAct, { act1: 1, act2: 1, act3: 1, act3b: 1, act4: 2, act5: 1 })
      || remediation.alignmentApprovalExceptionCount !== (refreshed ? 18 : 19)
      || !equal(remediation.expectedBoundaryCounts, { act1: 60, act2: 52, act3: 58, act3b: 34, act4: 48, act5: 54 })
      || !equal(remediation.expectedActiveBeatCounts, { act1: 30, act2: 26, act3: 29, act3b: 17, act4: 24, act5: 27 })
      || remediation.failureError !== 'EDIT_PLAN_VALIDATION:BEAT_TOO_SHORT'
      || Math.abs(remediation.expectedTotalDurationSec - (refreshed ? 633.782449 : 629.054693)) > 1e-9
      || Math.abs(remediation.totalDurationToleranceSec - 0.001) > 1e-12) throw new Error('ACTIVATION_TIMING_REMEDIATION_CONTRACT_INVALID');
  const allPlanBeats = plan.sequences.flatMap(sequence => Array.isArray(sequence.beats) ? sequence.beats : []);
  const allShots = Array.isArray(shotDefinitions.allShots) ? shotDefinitions.allShots : [];
  const manifestShots = Array.isArray(productionManifest.shots) ? productionManifest.shots : [];
  const seenIds = new Set(), seenOwners = new Set();
  for (const item of policy.exceptions) {
    const key = `${item?.actKey}:${item?.beatId}`;
    if (!item || typeof item.exceptionId !== 'string' || !item.exceptionId || typeof item.actKey !== 'string' || typeof item.beatId !== 'string'
        || seenIds.has(item.exceptionId) || seenOwners.has(key)) throw new Error('ACTIVATION_TIMING_EXCEPTION_DUPLICATE_OR_INVALID');
    seenIds.add(item.exceptionId); seenOwners.add(key);
    const expectedKeys = ['exceptionId','actKey','beatId','sourcePlanWordRange','candidateScriptWordRange','approvedNarrationExcerpt','approvedNarrationSha256','sourcePlanNarrationExcerpt','sourcePlanNarrationSha256','mappedTranscriptWordRange','mappedTranscriptAnchors','approvedDurationSec','minimumAllowedDurationSec','maximumAllowedDurationSec','priorTimingExceptionReason','justification','productionMethod','productionObligations','productionObligationsSha256','revisionLineage','inputHashes'];
    if (refreshed) expectedKeys.push('approvalProvenanceAmendmentSha256','currentCandidateAmendmentSha256','revisionLineageProof','currentTimingBinding');
    const mappedTranscriptFields = ['mappedTranscriptNarrationExcerpt','mappedTranscriptNarrationSha256'];
    const hasMappedTranscriptNarration = mappedTranscriptFields.some(field => Object.hasOwn(item, field));
    if (hasMappedTranscriptNarration) expectedKeys.push(...mappedTranscriptFields);
    if (!equal(Object.keys(item).sort(), expectedKeys.sort())) throw new Error(`ACTIVATION_TIMING_EXCEPTION_FIELDS_INVALID:${key}`);
    const ranges = [item.sourcePlanWordRange, item.candidateScriptWordRange, item.mappedTranscriptWordRange];
    if (ranges.some(range => !Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.end) || range.start < 0 || range.end < range.start || range.indexConvention !== 'zero-based-inclusive-act-local-plan-word' && range.indexConvention !== 'zero-based-inclusive-whitespace-token' && range.indexConvention !== 'zero-based-inclusive-act-local-retained-transcript-word')
        || !Number.isFinite(item.approvedDurationSec) || !Number.isFinite(item.minimumAllowedDurationSec) || !Number.isFinite(item.maximumAllowedDurationSec)
        || item.minimumAllowedDurationSec > item.approvedDurationSec || item.maximumAllowedDurationSec < item.approvedDurationSec
        || Math.abs((item.approvedDurationSec - item.minimumAllowedDurationSec) - 0.001) > 0.000002
        || Math.abs((item.maximumAllowedDurationSec - item.approvedDurationSec) - 0.001) > 0.000002
        || typeof item.justification !== 'string' || !item.justification.trim()
        || !item.mappedTranscriptAnchors || typeof item.mappedTranscriptAnchors.start !== 'string' || !item.mappedTranscriptAnchors.start
        || typeof item.mappedTranscriptAnchors.end !== 'string' || !item.mappedTranscriptAnchors.end
        || !(item.priorTimingExceptionReason === null || typeof item.priorTimingExceptionReason === 'string' && item.priorTimingExceptionReason.trim())
        || !/^[a-f0-9]{64}$/u.test(item.approvedNarrationSha256 || '') || !/^[a-f0-9]{64}$/u.test(item.sourcePlanNarrationSha256 || '')
        || !/^[a-f0-9]{64}$/u.test(item.productionObligationsSha256 || '')
        || !equal(item.inputHashes, policy.binding)
        || !item.revisionLineage || item.revisionLineage.artifactSha256 !== (refreshed ? REFRESHED_ORIGINAL_TIMING_AMENDMENT_SHA256 : policy.binding.candidateAmendmentSha256)
        || typeof item.revisionLineage.entryId !== 'string' || !item.revisionLineage.entryId
        || !['approved-rewritten-range','retained-approved-plan-beat'].includes(item.revisionLineage.relationship)) {
      throw new Error(`ACTIVATION_TIMING_EXCEPTION_ENTRY_INVALID:${key}`);
    }
    if (refreshed) {
      const expectedCurrentTimingBinding = {
        packageIndexSha256: policy.refreshBindings.packageIndexSha256,
        transcriptSha256: policy.refreshBindings.timestampsSha256,
        audioManifestSha256: policy.refreshBindings.audioManifestSha256,
        alignmentApprovalSha256: policy.refreshBindings.alignmentApprovalSha256,
        boundaryApprovalSha256: policy.refreshBindings.boundaryApprovalSha256,
        timingProposalSha256: policy.refreshBindings.proposalSha256,
        timingApprovalRecordSha256: policy.approval.approvalRecordSha256,
        approvedDurationSec: item.approvedDurationSec,
        mappedTranscriptWordRange: item.mappedTranscriptWordRange,
        mappedTranscriptAnchors: item.mappedTranscriptAnchors,
      };
      if (item.approvalProvenanceAmendmentSha256 !== REFRESHED_ORIGINAL_TIMING_AMENDMENT_SHA256
          || item.currentCandidateAmendmentSha256 !== REFRESHED_B017_AMENDMENT_SHA256
          || item.currentCandidateAmendmentSha256 !== policy.binding.candidateAmendmentSha256
          || !equal(item.revisionLineageProof, refreshedLineageProof)
          || !equal(item.currentTimingBinding, expectedCurrentTimingBinding)) throw new Error(`ACTIVATION_REFRESHED_TIMING_ENTRY_PROVENANCE_MISMATCH:${key}`);
    }
    const sourceMatches = allPlanBeats.filter(beat => beat.beatId === item.beatId && beat.actKey === item.actKey);
    if (sourceMatches.length !== 1 || sourceMatches[0].startWordIndex !== item.sourcePlanWordRange.start || sourceMatches[0].endWordIndex !== item.sourcePlanWordRange.end
        || sourceMatches[0].narrationExcerpt !== item.sourcePlanNarrationExcerpt
        || sha256(Buffer.from(item.sourcePlanNarrationExcerpt, 'utf8')) !== item.sourcePlanNarrationSha256) throw new Error(`ACTIVATION_TIMING_EXCEPTION_SOURCE_BEAT_MISMATCH:${key}`);
    if (!Array.isArray(wordTimestamps)) throw new Error(`ACTIVATION_TIMING_EXCEPTION_TRANSCRIPT_MISSING:${key}`);
    const timingAct = (plan.timing?.acts || []).find(act => act.actKey === item.actKey);
    const actWords = wordTimestamps.filter(word => word.vo_file === timingAct?.voKey);
    const startWord = actWords[item.mappedTranscriptWordRange.start]?.word;
    const endWord = actWords[item.mappedTranscriptWordRange.end]?.word;
    if (!timingAct?.voKey || !startWord || !endWord
        || normalizeTimingAnchor(startWord) !== normalizeTimingAnchor(item.mappedTranscriptAnchors.start)
        || normalizeTimingAnchor(endWord) !== normalizeTimingAnchor(item.mappedTranscriptAnchors.end)) throw new Error(`ACTIVATION_TIMING_EXCEPTION_TRANSCRIPT_ANCHOR_MISMATCH:${key}`);
    if (hasMappedTranscriptNarration) {
      const excerpt = actWords.slice(item.mappedTranscriptWordRange.start, item.mappedTranscriptWordRange.end + 1).map(word => word.word).join(' ');
      if (typeof item.mappedTranscriptNarrationExcerpt !== 'string' || excerpt !== item.mappedTranscriptNarrationExcerpt
          || sha256(Buffer.from(excerpt, 'utf8')) !== item.mappedTranscriptNarrationSha256) throw new Error(`ACTIVATION_TIMING_EXCEPTION_TRANSCRIPT_MISMATCH:${key}`);
    }
    const scriptTokens = String(script.acts?.[item.actKey]?.voScript || '').trim().split(/\s+/u);
    const actualNarration = scriptTokens.slice(item.candidateScriptWordRange.start, item.candidateScriptWordRange.end + 1).join(' ');
    if (!actualNarration || actualNarration !== item.approvedNarrationExcerpt || sha256(Buffer.from(actualNarration, 'utf8')) !== item.approvedNarrationSha256) throw new Error(`ACTIVATION_TIMING_EXCEPTION_NARRATION_MISMATCH:${key}`);
    const allocations = approvedBoundaryPolicy.allocations.filter(allocation => allocation.actKey === item.actKey && allocation.beatId === item.beatId);
    if (item.revisionLineage.relationship === 'approved-rewritten-range') {
      if (allocations.length !== 1 || allocations[0].revisionLineageEntry !== item.revisionLineage.entryId
          || allocations[0].startTokenIndex !== item.candidateScriptWordRange.start || allocations[0].endTokenIndex !== item.candidateScriptWordRange.end
          || allocations[0].excerpt !== item.approvedNarrationExcerpt) throw new Error(`ACTIVATION_TIMING_EXCEPTION_LINEAGE_MISMATCH:${key}`);
    } else if (allocations.length || item.revisionLineage.entryId !== `locked-plan:${item.actKey}:${item.beatId}`) {
      throw new Error(`ACTIVATION_TIMING_EXCEPTION_LINEAGE_MISMATCH:${key}`);
    }
    const shots = allShots.filter(shot => shot.beatId === item.beatId && shot.actKey === item.actKey);
    const records = manifestShots.filter(record => record.shotId === item.beatId && record.actKey === item.actKey);
    if (shots.length !== 1 || records.length !== 1 || records[0].productionMethod !== item.productionMethod
        || !equal(approvedTimingProductionObligations({ shot: shots[0], manifestEntry: records[0] }), item.productionObligations)
        || canonicalJsonSha256(item.productionObligations) !== item.productionObligationsSha256) {
      throw new Error(`ACTIVATION_TIMING_EXCEPTION_PRODUCTION_BINDING_MISMATCH:${key}`);
    }
  }
  const migrationOwners = ['act2:ACT2_B026','act3b:ACT3B_B018','act5:ACT5_B022','act5:ACT5_B023','act5:ACT5_B027'];
  const migrations = policy.editorialIntentMigrations;
  if (!migrations || migrations.schemaVersion !== 'phase2.3b-p-editorial-intent-migrations/1.0.0' || migrations.status !== 'USER_APPROVED'
      || !Array.isArray(migrations.entries) || !equal(migrations.entries.map(item => `${item.actKey}:${item.beatId}`).sort(), migrationOwners.sort())) {
    throw new Error('ACTIVATION_EDITORIAL_INTENT_MIGRATION_SET_INVALID');
  }
  const migrationIds = new Set();
  for (const item of migrations.entries) {
    const key = `${item.actKey}:${item.beatId}`;
    const expectedKeys = ['migrationId','actKey','beatId','sourcePlanWordRange','candidateScriptWordRange','approvedNarrationExcerpt','approvedNarrationSha256','sourcePlanNarrationExcerpt','sourcePlanNarrationSha256','mappedTranscriptWordRange','mappedTranscriptAnchors','mappedTranscriptNarrationExcerpt','mappedTranscriptNarrationSha256','approvedDurationSec','existingTimingExceptionReason','postNarrationHoldSec','intentionalStillness','rhythmIntent','productionMethod','visualClass','productionObligations','productionObligationsSha256','revisionLineage','inputHashes'];
    if (refreshed) expectedKeys.push('approvalProvenanceAmendmentSha256','currentCandidateAmendmentSha256','revisionLineageProof','currentTimingBinding');
    const validRange = (range, convention) => range && equal(Object.keys(range).sort(), ['end','indexConvention','start'].sort())
      && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start && range.indexConvention === convention;
    if (!item || typeof item.migrationId !== 'string' || migrationIds.has(item.migrationId) || !equal(Object.keys(item).sort(), expectedKeys.sort())
        || !validRange(item.sourcePlanWordRange, 'zero-based-inclusive-act-local-plan-word')
        || !validRange(item.candidateScriptWordRange, 'zero-based-inclusive-whitespace-token')
        || !validRange(item.mappedTranscriptWordRange, 'zero-based-inclusive-act-local-retained-transcript-word')
        || !equal(item.inputHashes, policy.binding) || !Number.isFinite(item.approvedDurationSec) || item.approvedDurationSec < 2 || item.approvedDurationSec > 6
        || !Number.isFinite(item.postNarrationHoldSec) || item.postNarrationHoldSec < 0 || typeof item.intentionalStillness !== 'boolean'
        || typeof item.rhythmIntent !== 'string' || !item.rhythmIntent || typeof item.existingTimingExceptionReason !== 'string' || !item.existingTimingExceptionReason.trim()
        || typeof item.visualClass !== 'string' || !item.visualClass || !/^[a-f0-9]{64}$/u.test(item.approvedNarrationSha256 || '')
        || !/^[a-f0-9]{64}$/u.test(item.sourcePlanNarrationSha256 || '') || !/^[a-f0-9]{64}$/u.test(item.mappedTranscriptNarrationSha256 || '')
        || !/^[a-f0-9]{64}$/u.test(item.productionObligationsSha256 || '')
        || !equal(item.sourcePlanWordRange, { ...item.sourcePlanWordRange, indexConvention: 'zero-based-inclusive-act-local-plan-word' })
        || !equal(item.candidateScriptWordRange, { ...item.candidateScriptWordRange, indexConvention: 'zero-based-inclusive-whitespace-token' })
        || !equal(item.mappedTranscriptWordRange, { ...item.mappedTranscriptWordRange, indexConvention: 'zero-based-inclusive-act-local-retained-transcript-word' })
        || !item.mappedTranscriptAnchors?.start || !item.mappedTranscriptAnchors?.end
        || item.revisionLineage?.artifactSha256 !== (refreshed ? REFRESHED_ORIGINAL_TIMING_AMENDMENT_SHA256 : policy.binding.candidateAmendmentSha256)
        || item.revisionLineage?.entryId !== `locked-plan:${item.actKey}:${item.beatId}` || item.revisionLineage?.relationship !== 'retained-approved-plan-beat') {
      throw new Error(`ACTIVATION_EDITORIAL_INTENT_MIGRATION_ENTRY_INVALID:${key}`);
    }
    if (refreshed) {
      const expectedCurrentTimingBinding = {
        packageIndexSha256: policy.refreshBindings.packageIndexSha256,
        transcriptSha256: policy.refreshBindings.timestampsSha256,
        audioManifestSha256: policy.refreshBindings.audioManifestSha256,
        alignmentApprovalSha256: policy.refreshBindings.alignmentApprovalSha256,
        boundaryApprovalSha256: policy.refreshBindings.boundaryApprovalSha256,
        timingProposalSha256: policy.refreshBindings.proposalSha256,
        timingApprovalRecordSha256: policy.approval.approvalRecordSha256,
        approvedDurationSec: item.approvedDurationSec,
        mappedTranscriptWordRange: item.mappedTranscriptWordRange,
        mappedTranscriptAnchors: item.mappedTranscriptAnchors,
      };
      if (item.approvalProvenanceAmendmentSha256 !== REFRESHED_ORIGINAL_TIMING_AMENDMENT_SHA256
          || item.currentCandidateAmendmentSha256 !== REFRESHED_B017_AMENDMENT_SHA256
          || item.currentCandidateAmendmentSha256 !== policy.binding.candidateAmendmentSha256
          || !equal(item.revisionLineageProof, refreshedLineageProof)
          || !equal(item.currentTimingBinding, expectedCurrentTimingBinding)) throw new Error(`ACTIVATION_REFRESHED_TIMING_MIGRATION_PROVENANCE_MISMATCH:${key}`);
    }
    migrationIds.add(item.migrationId);
    const sourceMatches = allPlanBeats.filter(beat => beat.actKey === item.actKey && beat.beatId === item.beatId);
    if (sourceMatches.length !== 1 || sourceMatches[0].startWordIndex !== item.sourcePlanWordRange.start || sourceMatches[0].endWordIndex !== item.sourcePlanWordRange.end
        || sourceMatches[0].narrationExcerpt !== item.sourcePlanNarrationExcerpt
        || sha256(Buffer.from(item.sourcePlanNarrationExcerpt, 'utf8')) !== item.sourcePlanNarrationSha256
        || sourceMatches[0].timingExceptionReason !== item.existingTimingExceptionReason
        || (sourceMatches[0].postNarrationHoldSec ?? 0) !== item.postNarrationHoldSec
        || (sourceMatches[0].intentionalStillness === true) !== item.intentionalStillness || sourceMatches[0].rhythmIntent !== item.rhythmIntent
        || sourceMatches[0].visualClass !== item.visualClass) throw new Error(`ACTIVATION_EDITORIAL_INTENT_MIGRATION_SOURCE_MISMATCH:${key}`);
    const scriptTokens = String(script.acts?.[item.actKey]?.voScript || '').trim().split(/\s+/u);
    const excerpt = scriptTokens.slice(item.candidateScriptWordRange.start, item.candidateScriptWordRange.end + 1).join(' ');
    if (excerpt !== item.approvedNarrationExcerpt || sha256(Buffer.from(excerpt, 'utf8')) !== item.approvedNarrationSha256) throw new Error(`ACTIVATION_EDITORIAL_INTENT_MIGRATION_NARRATION_MISMATCH:${key}`);
    const timingAct = (plan.timing?.acts || []).find(act => act.actKey === item.actKey);
    const actWords = wordTimestamps.filter(word => word.vo_file === timingAct?.voKey);
    const startWord = actWords[item.mappedTranscriptWordRange.start]?.word, endWord = actWords[item.mappedTranscriptWordRange.end]?.word;
    if (!timingAct?.voKey || normalizeTimingAnchor(startWord) !== normalizeTimingAnchor(item.mappedTranscriptAnchors.start)
        || normalizeTimingAnchor(endWord) !== normalizeTimingAnchor(item.mappedTranscriptAnchors.end)) throw new Error(`ACTIVATION_EDITORIAL_INTENT_MIGRATION_ANCHOR_MISMATCH:${key}`);
    const transcriptExcerpt = actWords.slice(item.mappedTranscriptWordRange.start, item.mappedTranscriptWordRange.end + 1).map(word => word.word).join(' ');
    if (transcriptExcerpt !== item.mappedTranscriptNarrationExcerpt || sha256(Buffer.from(transcriptExcerpt, 'utf8')) !== item.mappedTranscriptNarrationSha256) throw new Error(`ACTIVATION_EDITORIAL_INTENT_MIGRATION_TRANSCRIPT_MISMATCH:${key}`);
    const shots = allShots.filter(shot => shot.actKey === item.actKey && shot.beatId === item.beatId), records = manifestShots.filter(record => record.actKey === item.actKey && record.shotId === item.beatId);
    if (shots.length !== 1 || records.length !== 1 || records[0].productionMethod !== item.productionMethod
        || !equal(approvedTimingProductionObligations({ shot: shots[0], manifestEntry: records[0] }), item.productionObligations)
        || canonicalJsonSha256(item.productionObligations) !== item.productionObligationsSha256) throw new Error(`ACTIVATION_EDITORIAL_INTENT_MIGRATION_PRODUCTION_MISMATCH:${key}`);
  }
  return deepFreeze({ ...deepClone(policy), verified: true, policySha256: expectedPolicySha256,
    byBeat: new Map(policy.exceptions.map(item => [`${item.actKey}:${item.beatId}`, item])),
    editorialIntentMigrations: { ...deepClone(migrations), verified: true, byBeat: new Map(migrations.entries.map(item => [`${item.actKey}:${item.beatId}`, item])) } });
}

function verifyTimingExceptionApplications({ plan, approvedTimingExceptions } = {}) {
  if (!approvedTimingExceptions) return { status: 'NOT_REQUESTED', entries: [] };
  if (!isVerifiedTimingExceptionPolicy(approvedTimingExceptions)) throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_UNVERIFIED');
  const expectedOwners = [...timingExceptionOwnersFor(approvedTimingExceptions.policySha256)].sort();
  if (!Array.isArray(approvedTimingExceptions.exceptions) || !equal(approvedTimingExceptions.exceptions.map(item => `${item.actKey}:${item.beatId}`).sort(), expectedOwners)) throw new Error('ACTIVATION_TIMING_EXCEPTION_APPROVED_SET_INVALID');
  const beats = plan.sequences.flatMap(sequence => Array.isArray(sequence.beats) ? sequence.beats : []);
  const owners = new Map(beats.map(beat => [`${beat.actKey}:${beat.beatId}`, beat]));
  if (owners.size !== beats.length) throw new Error('ACTIVATION_TIMING_EXCEPTION_PLAN_DUPLICATE_BEAT');
  const approved = approvedTimingExceptions.exceptions;
  const migrations = approvedTimingExceptions.editorialIntentMigrations?.entries || [];
  const excludedIds = approvedTimingExceptions.excludedFormalExceptionIds || [];
  if (migrations.length !== 5 || !Array.isArray(excludedIds)
      || (approvedTimingExceptions.policySha256 === REFRESHED_TIMING_EXCEPTION_POLICY_SHA256
        ? !equal(excludedIds, ['act3:ACT3_B025']) : excludedIds.length !== 0)) throw new Error('ACTIVATION_EDITORIAL_INTENT_MIGRATION_SET_INVALID');
  const excluded = new Set(excludedIds);
  const allowed = new Set([...approved, ...migrations].map(item => `${item.actKey}:${item.beatId}`));
  for (const key of excluded) allowed.add(key);
  for (const beat of beats) {
    const key = `${beat.actKey}:${beat.beatId}`;
    if (typeof beat.timingExceptionReason === 'string' && beat.timingExceptionReason.trim() && !allowed.has(key)) throw new Error(`ACTIVATION_TIMING_EXCEPTION_UNAPPROVED:${key}`);
  }
  const entries = approved.map(item => {
    const key = `${item.actKey}:${item.beatId}`, beat = owners.get(key);
    if (!beat || beat.timingExceptionReason !== item.justification
        || beat.startWordIndex !== item.mappedTranscriptWordRange.start || beat.endWordIndex !== item.mappedTranscriptWordRange.end
        || !Number.isFinite(beat.durationSec) || beat.durationSec < item.minimumAllowedDurationSec - 1e-9 || beat.durationSec > item.maximumAllowedDurationSec + 1e-9
        || Math.abs(beat.durationSec - item.approvedDurationSec) > 0.001) throw new Error(`ACTIVATION_TIMING_EXCEPTION_APPLICATION_MISMATCH:${key}`);
    return { exceptionId: item.exceptionId, actKey: item.actKey, beatId: item.beatId, status: 'VERIFIED', mappedTranscriptWordRange: deepClone(item.mappedTranscriptWordRange), durationSec: beat.durationSec, approvedDurationSec: item.approvedDurationSec, minimumAllowedDurationSec: item.minimumAllowedDurationSec, maximumAllowedDurationSec: item.maximumAllowedDurationSec, productionMethod: item.productionMethod, productionObligationsSha256: item.productionObligationsSha256 };
  });
  const migrationResults = migrations.map(item => {
    const key = `${item.actKey}:${item.beatId}`, beat = owners.get(key);
    if (!beat || beat.timingExceptionReason !== null || beat.startWordIndex !== item.mappedTranscriptWordRange.start
        || beat.endWordIndex !== item.mappedTranscriptWordRange.end || beat.narrationExcerpt !== item.mappedTranscriptNarrationExcerpt
        || !Number.isFinite(beat.durationSec) || beat.durationSec < 2 || beat.durationSec > 6
        || Math.abs(beat.durationSec - item.approvedDurationSec) > 1e-9
        || (beat.postNarrationHoldSec ?? 0) !== item.postNarrationHoldSec || (beat.intentionalStillness === true) !== item.intentionalStillness
        || beat.rhythmIntent !== item.rhythmIntent || beat.visualClass !== item.visualClass) throw new Error(`ACTIVATION_EDITORIAL_INTENT_MIGRATION_APPLICATION_MISMATCH:${key}`);
    return { migrationId: item.migrationId, actKey: item.actKey, beatId: item.beatId, status: 'VERIFIED', durationSec: beat.durationSec, postNarrationHoldSec: beat.postNarrationHoldSec ?? 0, intentionalStillness: beat.intentionalStillness === true, rhythmIntent: beat.rhythmIntent, productionMethod: item.productionMethod, productionObligationsSha256: item.productionObligationsSha256 };
  });
  const exclusionResults = [...excluded].map(key => {
    const beat = owners.get(key);
    if (!beat || beat.timingExceptionReason !== null || !Number.isFinite(beat.durationSec)
        || beat.durationSec < 2 || beat.durationSec > 6) throw new Error(`ACTIVATION_TIMING_EXCEPTION_EXCLUSION_APPLICATION_MISMATCH:${key}`);
    return { actKey: beat.actKey, beatId: beat.beatId, status: 'VERIFIED_NON_EXCEPTION', durationSec: beat.durationSec,
      intentionalStillness: beat.intentionalStillness === true, rhythmIntent: beat.rhythmIntent };
  });
  return { status: 'PASS', policySha256: approvedTimingExceptions.policySha256, entries, editorialIntentMigrations: migrationResults,
    excludedFormalExceptionClosures: exclusionResults };
}

function applyApprovedTimingExceptions(plan, approvedTimingExceptions) {
  if (!approvedTimingExceptions) return plan;
  if (!isVerifiedTimingExceptionPolicy(approvedTimingExceptions)) throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_UNVERIFIED');
  const expectedOwners = [...timingExceptionOwnersFor(approvedTimingExceptions.policySha256)].sort();
  if (!Array.isArray(approvedTimingExceptions.exceptions) || !equal(approvedTimingExceptions.exceptions.map(item => `${item.actKey}:${item.beatId}`).sort(), expectedOwners)) throw new Error('ACTIVATION_TIMING_EXCEPTION_APPROVED_SET_INVALID');
  const entries = new Map(approvedTimingExceptions.exceptions.map(item => [`${item.actKey}:${item.beatId}`, item]));
  const migrations = approvedTimingExceptions.editorialIntentMigrations?.entries || [];
  if (migrations.length !== 5) throw new Error('ACTIVATION_EDITORIAL_INTENT_MIGRATION_SET_INVALID');
  const excludedIds = approvedTimingExceptions.excludedFormalExceptionIds || [];
  if (!Array.isArray(excludedIds) || (approvedTimingExceptions.policySha256 === REFRESHED_TIMING_EXCEPTION_POLICY_SHA256
      ? !equal(excludedIds, ['act3:ACT3_B025']) : excludedIds.length !== 0)) throw new Error('ACTIVATION_TIMING_EXCEPTION_EXCLUSION_SET_INVALID');
  const excluded = new Set(excludedIds);
  for (const sequence of plan.sequences) for (const beat of sequence.beats) {
    const key = `${beat.actKey}:${beat.beatId}`;
    if (!excluded.has(key)) continue;
    if (!Number.isFinite(beat.durationSec) || beat.durationSec < 2 || beat.durationSec > 6
        || typeof beat.timingExceptionReason !== 'string' || !beat.timingExceptionReason.trim()) {
      throw new Error(`ACTIVATION_TIMING_EXCEPTION_EXCLUSION_SCOPE_MISMATCH:${key}`);
    }
    beat.timingExceptionReason = null;
  }
  if ([...excluded].some(key => plan.sequences.flatMap(sequence => sequence.beats).filter(beat => `${beat.actKey}:${beat.beatId}` === key).length !== 1)) {
    throw new Error('ACTIVATION_TIMING_EXCEPTION_EXCLUSION_BEAT_MISSING_OR_DUPLICATE');
  }
  const migrationOwners = new Set(migrations.map(item => `${item.actKey}:${item.beatId}`));
  for (const sequence of plan.sequences) for (const beat of sequence.beats) {
    const key = `${beat.actKey}:${beat.beatId}`, item = entries.get(key);
    if (!item) {
      if (migrationOwners.has(key)) continue;
      if (typeof beat.timingExceptionReason === 'string' && beat.timingExceptionReason.trim()) throw new Error(`ACTIVATION_TIMING_EXCEPTION_UNAPPROVED:${key}`);
      continue;
    }
    if (beat.timingExceptionReason !== null && beat.timingExceptionReason !== undefined
        && beat.timingExceptionReason !== item.justification && beat.timingExceptionReason !== item.priorTimingExceptionReason) throw new Error(`ACTIVATION_TIMING_EXCEPTION_REASON_CONFLICT:${key}`);
    if (beat.startWordIndex !== item.mappedTranscriptWordRange.start || beat.endWordIndex !== item.mappedTranscriptWordRange.end
        || !Number.isFinite(beat.durationSec) || beat.durationSec < item.minimumAllowedDurationSec - 1e-9 || beat.durationSec > item.maximumAllowedDurationSec + 1e-9
        || Math.abs(beat.durationSec - item.approvedDurationSec) > 0.001) throw new Error(`ACTIVATION_TIMING_EXCEPTION_SCOPE_MISMATCH:${key}`);
    beat.timingExceptionReason = item.justification;
  }
  const found = plan.sequences.flatMap(sequence => sequence.beats).filter(beat => entries.has(`${beat.actKey}:${beat.beatId}`)).length;
  if (found !== entries.size) throw new Error('ACTIVATION_TIMING_EXCEPTION_APPROVED_BEAT_MISSING');
  const migrationMap = new Map(migrations.map(item => [`${item.actKey}:${item.beatId}`, item]));
  let migrationFound = 0;
  for (const sequence of plan.sequences) for (const beat of sequence.beats) {
    const key = `${beat.actKey}:${beat.beatId}`, item = migrationMap.get(key);
    if (!item) continue;
    migrationFound++;
    if (beat.timingExceptionReason !== item.existingTimingExceptionReason
        || beat.startWordIndex !== item.mappedTranscriptWordRange.start || beat.endWordIndex !== item.mappedTranscriptWordRange.end
        || beat.narrationExcerpt !== item.mappedTranscriptNarrationExcerpt
        || !Number.isFinite(beat.durationSec) || beat.durationSec < 2 || beat.durationSec > 6
        || Math.abs(beat.durationSec - item.approvedDurationSec) > 1e-9
        || (beat.postNarrationHoldSec ?? 0) !== item.postNarrationHoldSec || (beat.intentionalStillness === true) !== item.intentionalStillness
        || beat.rhythmIntent !== item.rhythmIntent || beat.visualClass !== item.visualClass) throw new Error(`ACTIVATION_EDITORIAL_INTENT_MIGRATION_SCOPE_MISMATCH:${key}`);
    beat.timingExceptionReason = null;
  }
  if (migrationFound !== migrationMap.size) throw new Error('ACTIVATION_EDITORIAL_INTENT_MIGRATION_BEAT_MISSING');
  return plan;
}

function sourceBoundarySharesNormalizedUnit(sourceWords, leftWordIndex, rightWordIndex) {
  const text = sourceWords.join(' '), spans = sourceWordSpans(sourceWords);
  const lexicalToWord = lexicalSourceWordIndexes(text, spans);
  return normalizedUnits(text).units.some(unit => {
    const wordIndexes = new Set(lexicalToWord.slice(unit.tokenStart, unit.tokenEnd + 1));
    return wordIndexes.has(leftWordIndex) && wordIndexes.has(rightWordIndex);
  });
}

function updateProductionManifestForRetirements(manifest, retiredBeatIds) {
  const next = deepClone(manifest), retired = new Set(retiredBeatIds);
  if ([...retired].some(id => id !== 'ACT3B_B010') || retired.size !== retiredBeatIds.length) throw new Error('ACTIVATION_MANIFEST_RETIREMENT_NOT_APPROVED');
  for (const id of retired) if (!next.shots.some(item => item.shotId === id)) throw new Error(`ACTIVATION_MANIFEST_RETIREMENT_SOURCE_MISSING:${id}`);
  next.shots = next.shots.filter(item => !retired.has(item.shotId));
  next.totalShots = next.shots.length;
  next.methodCounts = Object.fromEntries(['ESSENTIAL_ANIMATION', 'CONTROLLED_STILL', 'GENERATED_STILL', 'EVIDENCE_REFERENCE', 'GRAPHIC_COMPILATION'].map(method => [method, next.shots.filter(item => item.productionMethod === method).length]));
  next.graphicSummary = {
    primaryGraphicAssetShots: next.shots.filter(item => item.productionMethod === 'GRAPHIC_COMPILATION').length,
    overlayGraphicShots: next.shots.filter(item => item.overlayGraphicRequirement === true).length,
    graphicBearingBeats: next.shots.filter(item => item.graphicObjectCount > 0).length,
    graphicObjectCount: next.shots.reduce((sum, item) => sum + (Number.isInteger(item.graphicObjectCount) ? item.graphicObjectCount : 0), 0),
    multiObjectBeatCount: next.shots.filter(item => item.graphicObjectCount > 1).length,
  };
  next.baseImageCount = next.shots.filter(item => ['ESSENTIAL_ANIMATION', 'CONTROLLED_STILL', 'GENERATED_STILL'].includes(item.productionMethod)).length;
  next.animationCallCount = next.shots.filter(item => item.productionMethod === 'ESSENTIAL_ANIMATION').length;
  return next;
}

function sequenceOccurrences(tokens, sequence) {
  const found = [];
  for (let index = 0; index <= tokens.length - sequence.length; index++) {
    if (sequence.every((item, offset) => tokens[index + offset] === item)) found.push(index);
  }
  return found;
}

function verifyPolicyBoundaryAuthorization({ authorization, source, scriptText, words, reviewedAct, scriptToTranscript, boundaryInputHashes, supersedesPolicySha256, actKey }) {
  const inputHashes = { ...(boundaryInputHashes || {}), previousApprovedBoundaryPolicySha256: supersedesPolicySha256 };
  const actualKeys = Object.keys(inputHashes).sort(), expectedKeys = Object.keys(authorization?.inputHashes || {}).sort();
  if (!equal(actualKeys, expectedKeys) || expectedKeys.some(key => inputHashes[key] !== authorization.inputHashes[key])) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_INPUT_HASH_MISMATCH:${actKey}:${authorization?.sourceBoundaryIndex}`);
  if (authorization.actKey !== actKey || authorization.sourceBeatRange.startWordIndex > authorization.sourceBoundaryIndex
      || authorization.sourceBeatRange.endWordIndex < authorization.sourceBoundaryIndex
      || (authorization.edge === 'start' && authorization.sourceBeatRange.startWordIndex !== authorization.sourceBoundaryIndex)
      || (authorization.edge === 'end' && authorization.sourceBeatRange.endWordIndex !== authorization.sourceBoundaryIndex)
      || authorization.sourceBeatRange.endWordIndex < authorization.sourceBeatRange.startWordIndex
      || authorization.approvedTranscriptSpan.startIndex > authorization.targetTranscriptIndex
      || authorization.approvedTranscriptSpan.endIndex < authorization.targetTranscriptIndex
      || authorization.approvedTranscriptSpan.endIndex >= words.length) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_RANGE_INVALID:${actKey}:${authorization.sourceBoundaryIndex}`);

  const sourceTokens = source.words.map(word => token(word));
  const candidateTokens = lexicalTokens(scriptText).map(item => item.text);
  const transcriptTokens = lexicalTokens(words.map(item => item.word).join(' ')).map(item => item.text);
  const transcriptWordIndexes = transcriptLexicalWordIndexes(words);
  const boundaryIndex = authorization.sourceBoundaryIndex;
  const owners = source.beats.filter(beat => beat[authorization.edge === 'start' ? 'startWordIndex' : 'endWordIndex'] === boundaryIndex);
  const namedBeat = source.beats.filter(beat => beat.beatId === authorization.beatId);
  if (owners.length !== 1 || namedBeat.length !== 1 || owners[0] !== namedBeat[0]
      || namedBeat[0].startWordIndex !== authorization.sourceBeatRange.startWordIndex
      || namedBeat[0].endWordIndex !== authorization.sourceBeatRange.endWordIndex) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_OWNER_MISMATCH:${actKey}:${boundaryIndex}`);

  const sourceAnchors = [...authorization.sourceAnchors].sort((a, b) => a.index - b.index);
  const candidateAnchors = [...authorization.candidateAnchors].sort((a, b) => a.index - b.index);
  const transcriptAnchors = [...authorization.transcriptAnchors].sort((a, b) => a.index - b.index);
  const anchorsValid = anchors => anchors.every((item, index) => Number.isSafeInteger(item.index) && item.index >= 0
      && (index === 0 || anchors[index - 1].index < item.index) && typeof item.token === 'string');
  if (!anchorsValid(sourceAnchors) || !anchorsValid(candidateAnchors) || !anchorsValid(transcriptAnchors)) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_ANCHORS_INVALID:${actKey}:${boundaryIndex}`);
  for (const item of sourceAnchors) if (sourceTokens[item.index] !== item.token) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_SOURCE_TOKEN_MISMATCH:${actKey}:${boundaryIndex}`);
  for (const item of candidateAnchors) {
    if (candidateTokens[item.index] !== item.token || !Number.isSafeInteger(item.sourceIndex)
        || !sourceAnchors.some(sourceAnchor => sourceAnchor.index === item.sourceIndex)) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_CANDIDATE_TOKEN_MISMATCH:${actKey}:${boundaryIndex}`);
  }
  if (candidateAnchors.some((item, index) => index > 0 && item.sourceIndex <= candidateAnchors[index - 1].sourceIndex)) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_SOURCE_ORDER_INVALID:${actKey}:${boundaryIndex}`);
  for (const item of transcriptAnchors) {
    if (transcriptTokens[item.index] !== item.token || !Number.isSafeInteger(item.candidateIndex)
        || !candidateAnchors.some(candidateAnchor => candidateAnchor.index === item.candidateIndex)) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_TRANSCRIPT_TOKEN_MISMATCH:${actKey}:${boundaryIndex}`);
    const mapped = scriptToTranscript[item.candidateIndex];
    if (!mapped || mapped.start !== item.index || mapped.end !== item.index) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_REVIEW_RELATION_MISMATCH:${actKey}:${boundaryIndex}`);
  }
  if (transcriptAnchors.some((item, index) => index > 0 && item.candidateIndex <= transcriptAnchors[index - 1].candidateIndex)) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_TRANSCRIPT_ORDER_INVALID:${actKey}:${boundaryIndex}`);
  const deleted = sourceAnchors.filter(item => item.role === 'deleted');
  const replacements = candidateAnchors.filter(item => item.role === 'replacement' || item.role === 'target');
  const targets = transcriptAnchors.filter(item => item.role === 'target');
  if (!deleted.length || replacements.length !== 1 || targets.length !== 1
      || deleted[0].index !== boundaryIndex
      || deleted.some((item, index) => index > 0 && item.index !== deleted[index - 1].index + 1)
      || replacements[0].sourceIndex <= deleted.at(-1).index
      || replacements[0].index !== targets[0].candidateIndex) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_TARGET_INVALID:${actKey}:${boundaryIndex}`);
  const targetCandidateIndex = replacements[0].index, targetTranscriptIndex = targets[0].index;
  const sequences = authorization.uniqueAnchorSequences;
  const locateUnique = (tokens, sequence, label) => {
    const occurrences = sequenceOccurrences(tokens, sequence);
    if (occurrences.length !== 1) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_ANCHOR_${label}_AMBIGUOUS:${actKey}:${boundaryIndex}`);
    return occurrences[0];
  };
  const sourceBefore = locateUnique(sourceTokens, sequences.sourcePreceding, 'SOURCE_PRECEDING');
  const sourceAfter = locateUnique(sourceTokens, sequences.sourceFollowing, 'SOURCE_FOLLOWING');
  const candidateBefore = locateUnique(candidateTokens, sequences.candidatePreceding, 'CANDIDATE_PRECEDING');
  const candidateAfter = locateUnique(candidateTokens, sequences.candidateFollowing, 'CANDIDATE_FOLLOWING');
  const transcriptBefore = locateUnique(transcriptTokens, sequences.transcriptPreceding, 'TRANSCRIPT_PRECEDING');
  const transcriptAfter = locateUnique(transcriptTokens, sequences.transcriptFollowing, 'TRANSCRIPT_FOLLOWING');
  if (sourceBefore + sequences.sourcePreceding.length !== boundaryIndex
      || sourceAfter <= boundaryIndex || candidateBefore + sequences.candidatePreceding.length !== targetCandidateIndex
      || candidateAfter !== targetCandidateIndex || transcriptBefore + sequences.transcriptPreceding.length !== targetTranscriptIndex
      || transcriptAfter !== targetTranscriptIndex || targetTranscriptIndex !== authorization.targetTranscriptIndex
      || transcriptWordIndexes[targetTranscriptIndex] !== targetTranscriptIndex) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_ANCHOR_ORDER_INVALID:${actKey}:${boundaryIndex}`);
  return { start: targetTranscriptIndex, end: targetTranscriptIndex };
}

function mapActBoundaryMappings({ source, scriptText, words, reviewedAct, actKey, approvedBoundaryPolicy, boundaryInputHashes }) {
  if (approvedBoundaryPolicy && (approvedBoundaryPolicy.verified !== true || ![APPROVED_BOUNDARY_POLICY_SHA256, REFRESHED_BOUNDARY_POLICY_SHA256].includes(approvedBoundaryPolicy.policySha256))) throw new Error('ACTIVATION_APPROVED_BOUNDARY_POLICY_UNVERIFIED');
  if (approvedBoundaryPolicy?.policySha256 === REFRESHED_BOUNDARY_POLICY_SHA256) {
    const expectedInputs = {
      lockedEditPlanSha256: REFRESHED_BOUNDARY_POLICY_BINDINGS.lockedEditPlanSha256,
      candidatePreTimingEditPlanSha256: REFRESHED_BOUNDARY_POLICY_BINDINGS.candidatePreTimingEditPlanSha256,
      candidateScriptSha256: REFRESHED_BOUNDARY_POLICY_BINDINGS.candidateScriptSha256,
      retainedTranscriptSha256: REFRESHED_BOUNDARY_POLICY_BINDINGS.combinedTranscriptSha256,
      alignmentProposalSha256: REFRESHED_BOUNDARY_POLICY_BINDINGS.alignmentProposalSha256,
      alignmentApprovalSha256: REFRESHED_BOUNDARY_POLICY_BINDINGS.alignmentApprovalSha256,
      candidateAmendmentSha256: REFRESHED_BOUNDARY_POLICY_BINDINGS.candidateAmendmentSha256,
    };
    if (!equal(boundaryInputHashes, expectedInputs)) throw new Error('ACTIVATION_REFRESHED_BOUNDARY_RUNTIME_INPUT_MISMATCH');
  }
  const retirements = approvedBoundaryPolicy?.retirements.filter(item => item.actKey === actKey) || [];
  const retiredIds = new Set(retirements.map(item => item.beatId));
  const sourceBeats = source.beats.filter(beat => !retiredIds.has(beat.beatId));
  const allocations = approvedBoundaryPolicy?.allocations.filter(item => item.actKey === actKey) || [];
  const byBeat = new Map(allocations.map(item => [item.beatId, item]));
  const boundaryIndexes = [...new Set(sourceBeats.flatMap(beat => [beat.startWordIndex, beat.endWordIndex]))];
  const scriptTokenCount = lexicalTokens(scriptText).length;
  let scriptToTranscript;
  try { scriptToTranscript = mapScriptToTranscriptWords({ scriptText, words, reviewedAct, actKey }); }
  catch (error) {
    const code = String(error.message || error);
    return { scriptToTranscript: null, mappedBoundaries: new Map(), mappedBeats: [], errors: [
      { code }, ...boundaryIndexes.map(boundaryIndex => ({ code: `ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${boundaryIndex}`, boundaryIndex })),
    ] };
  }
  const structuralStartVerified = source.beats[0]?.startWordIndex === 0
    && scriptToTranscript[0]?.start === 0
    && reviewedAct.matchedTokens?.some(item => item.scriptTokenIndex === 0 && item.transcriptTokenIndex === 0)
      || source.beats[0]?.startWordIndex === 0 && scriptToTranscript[0]?.start === 0
        && reviewedAct.approvedExceptions?.some(item => item.scriptTokenIndex === 0 && item.transcriptTokenIndex === 0);
  const structuralEndVerified = source.beats.at(-1)?.endWordIndex === source.words.length - 1
    && scriptToTranscript.at(-1)?.end === words.length - 1
    && ([...(reviewedAct.matchedTokens || []), ...(reviewedAct.approvedExceptions || [])]
      .some(item => item.scriptTokenEndIndex === scriptTokenCount - 1 && item.transcriptTokenEndIndex === transcriptLexicalWordIndexes(words).length - 1));
  const mappedBoundaries = new Map(), errors = [];
  const authorizedMappings = new Map();
  for (const authorization of approvedBoundaryPolicy?.boundaryAuthorizations || []) {
    if (authorization.actKey !== actKey) continue;
    const ownerNamed = source.beats.some(beat => beat.beatId === authorization.beatId);
    const ownerAtBoundary = source.beats.some(beat => beat[authorization.edge === 'start' ? 'startWordIndex' : 'endWordIndex'] === authorization.sourceBoundaryIndex);
    if (!ownerNamed && !ownerAtBoundary) continue;
    const mapped = verifyPolicyBoundaryAuthorization({ authorization, source, scriptText, words, reviewedAct, scriptToTranscript, boundaryInputHashes, supersedesPolicySha256: approvedBoundaryPolicy.supersedesPolicySha256, actKey });
    if (authorizedMappings.has(authorization.sourceBoundaryIndex)) throw new Error(`ACTIVATION_BOUNDARY_AUTHORIZATION_DUPLICATE:${actKey}:${authorization.sourceBoundaryIndex}`);
    authorizedMappings.set(authorization.sourceBoundaryIndex, mapped);
    mappedBoundaries.set(authorization.sourceBoundaryIndex, mapped);
  }
  const scriptLexical = lexicalTokens(scriptText);
  const whitespaceSpans = [];
  const whitespacePattern = /\S+/gu;
  for (const match of scriptText.matchAll(whitespacePattern)) whitespaceSpans.push({ start: match.index, end: match.index + match[0].length - 1 });
  const directAllocation = new Map();
  for (const allocation of allocations) {
    const startSpan = whitespaceSpans[allocation.startTokenIndex], endSpan = whitespaceSpans[allocation.endTokenIndex];
    const indexes = scriptLexical.flatMap((item, index) => item.offset >= startSpan.start && item.offset <= endSpan.end ? [index] : []);
    if (!indexes.length) { errors.push({ code: `ACTIVATION_APPROVED_BOUNDARY_RANGE_EMPTY:${actKey}:${allocation.beatId}` }); continue; }
    const mapped = indexes.map(index => scriptToTranscript[index]);
    if (mapped.some(item => !item)) { errors.push({ code: `ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${allocation.beatId}` }); continue; }
    directAllocation.set(allocation.beatId, { start: mapped[0].start, end: mapped.at(-1).end });
  }
  const skippedIndexes = new Set();
  const reviewedDeletedScriptTokens = (reviewedAct.approvedExceptions || [])
    .filter(item => item?.type === 'SCRIPT_DELETION')
    .flatMap(item => Array.from({ length: item.scriptTokenEndIndex - item.scriptTokenIndex + 1 }, (_, offset) => item.scriptTokenIndex + offset));
  for (const allocation of allocations) {
    const position = sourceBeats.findIndex(beat => beat.beatId === allocation.beatId);
    const previous = sourceBeats[position - 1], allocated = sourceBeats[position], next = sourceBeats[position + 1];
    if (!allocated) throw new Error(`ACTIVATION_APPROVED_BOUNDARY_BEAT_MISSING:${actKey}:${allocation.beatId}`);
    skippedIndexes.add(allocated.startWordIndex); skippedIndexes.add(allocated.endWordIndex);
    if (previous) skippedIndexes.add(previous.endWordIndex);
    if (next) skippedIndexes.add(next.startWordIndex);
  }
  for (const index of boundaryIndexes) {
    if (skippedIndexes.has(index)) continue;
    if (authorizedMappings.has(index)) continue;
    let sourceToScript = null, sourceToTranscript = null, sourceToScriptError = null, sourceToTranscriptError = null;
    try {
      sourceToScript = mapPlanSourceWordsToScript({ sourceWords: source.words, scriptText, boundaryIndexes: [index], actKey, structuralStartVerified, structuralEndVerified }).get(index) || null;
    } catch (error) { sourceToScriptError = error; }
    if (!skippedIndexes.has(index)) {
      try {
        sourceToTranscript = mapPlanSourceWordsToTranscript({ sourceWords: source.words, words, boundaryIndexes: [index], actKey, structuralStartVerified, structuralEndVerified }).get(index) || null;
      } catch (error) { sourceToTranscriptError = error; }
    }
    let throughScript = null;
    if (sourceToScript) {
      throughScript = { start: scriptToTranscript[sourceToScript.start]?.start, end: scriptToTranscript[sourceToScript.end]?.end };
      if (!Number.isSafeInteger(throughScript.start) || !Number.isSafeInteger(throughScript.end) || throughScript.start > throughScript.end) {
        errors.push({ code: `ACTIVATION_BOUNDARY_MAPPING_INVALID:${actKey}:${index}`, boundaryIndex: index });
        continue;
      }
    }
    if (sourceToScript && reviewedDeletedScriptTokens.some(deletedIndex => deletedIndex >= sourceToScript.start && deletedIndex <= sourceToScript.end)) {
      errors.push({ code: `ACTIVATION_BOUNDARY_AUTHORIZATION_REQUIRED:${actKey}:${index}`, boundaryIndex: index });
      continue;
    }
    if (sourceToTranscript) {
      try { verifyReviewedTranscriptRange(sourceToTranscript, scriptToTranscript, actKey, index); }
      catch (error) {
        errors.push({ code: String(error.message || error), boundaryIndex: index });
        continue;
      }
    }
    if (sourceToTranscript && throughScript && (sourceToTranscript.start !== throughScript.start || sourceToTranscript.end !== throughScript.end)) {
      errors.push({ code: `ACTIVATION_BOUNDARY_MAPPING_CONFLICT:${actKey}:${index}`, boundaryIndex: index });
      continue;
    }
    const mapped = sourceToTranscript || throughScript;
    if (!mapped) {
      const ambiguous = [sourceToScriptError, sourceToTranscriptError].find(error => /ACTIVATION_BOUNDARY_MAPPING_AMBIGUOUS:/u.test(String(error?.message || error)));
      errors.push({ code: ambiguous ? `ACTIVATION_BOUNDARY_MAPPING_AMBIGUOUS:${actKey}:${index}` : `ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${index}`, boundaryIndex: index });
      continue;
    }
    mappedBoundaries.set(index, mapped);
  }
  const mappedBeats = [], gaps = [], overlaps = [];
  let cursor = 0;
  for (let beatIndex = 0; beatIndex < sourceBeats.length; beatIndex++) {
    const beat = sourceBeats[beatIndex], allocation = byBeat.get(beat.beatId);
    let first, last;
    if (allocation) ({ start: first, end: last } = directAllocation.get(beat.beatId) || {});
    else {
      const precedingAllocation = byBeat.has(sourceBeats[beatIndex - 1]?.beatId) ? directAllocation.get(sourceBeats[beatIndex - 1].beatId) : null;
      const followingAllocation = byBeat.has(sourceBeats[beatIndex + 1]?.beatId) ? directAllocation.get(sourceBeats[beatIndex + 1].beatId) : null;
      const mappedStart = precedingAllocation ? { start: precedingAllocation.end + 1 } : mappedBoundaries.get(beat.startWordIndex);
      const mappedEnd = followingAllocation ? { end: followingAllocation.start - 1 } : mappedBoundaries.get(beat.endWordIndex);
      first = mappedStart?.start; last = mappedEnd?.end;
    }
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) {
      errors.push({ code: `ACTIVATION_BOUNDARY_MAPPING_MISSING:${actKey}:${allocation?.startTokenIndex ?? beat.startWordIndex}`, boundaryIndex: beat.startWordIndex });
      continue;
    }
    const previousBeat = sourceBeats[beatIndex - 1];
    if (first < cursor && previousBeat && previousBeat.endWordIndex + 1 === beat.startWordIndex
        && sourceBoundarySharesNormalizedUnit(source.words, previousBeat.endWordIndex, beat.startWordIndex) && last >= cursor) first = cursor;
    if (first > cursor) gaps.push({ beatId: beat.beatId, start: cursor, end: first - 1 });
    else if (first < cursor) overlaps.push({ beatId: beat.beatId, start: first, end: Math.min(cursor - 1, last) });
    if (first > last) {
      errors.push({ code: `ACTIVATION_BOUNDARY_MAPPING_INVALID:${actKey}:${beat.startWordIndex}`, boundaryIndex: beat.startWordIndex });
      continue;
    }
    mappedBeats.push({ beat, transcriptStart: first, transcriptEnd: last });
    mappedBoundaries.set(beat.startWordIndex, { start: first, end: first });
    mappedBoundaries.set(beat.endWordIndex, { start: last, end: last });
    cursor = last + 1;
  }
  if (mappedBeats.length === sourceBeats.length && cursor < words.length) gaps.push({ start: cursor, end: words.length - 1 });
  if (gaps.length || overlaps.length) errors.unshift({ code: `ACTIVATION_BOUNDARY_MAPPING_COVERAGE:${actKey}` });
  for (const gap of gaps) errors.push({ code: `ACTIVATION_BOUNDARY_MAPPING_GAP:${actKey}`, ...gap });
  for (const overlap of overlaps) errors.push({ code: `ACTIVATION_BOUNDARY_MAPPING_OVERLAP:${actKey}`, ...overlap });
  return { scriptToTranscript, mappedBoundaries, mappedBeats, errors, gaps, overlaps, boundaryIndexes, retiredBeatIds: [...retiredIds] };
}

function isBoundaryMappingUnavailable(error) {
  return /ACTIVATION_BOUNDARY_MAPPING_(?:MISSING|AMBIGUOUS):/u.test(String(error?.message || error));
}

function transcriptLexicalWordIndexes(words) {
  const text = words.map(item => item.word).join(' ');
  const spans = sourceWordSpans(words.map(item => item.word));
  const indexes = lexicalSourceWordIndexes(text, spans);
  if (new Set(indexes).size === 0 || words.some((_, index) => !indexes.includes(index))) throw new Error('ACTIVATION_TRANSCRIPT_TOKEN_MAPPING_INCOMPLETE');
  return indexes;
}

function mapScriptToTranscriptWords({ scriptText, words, reviewedAct, actKey }) {
  if (!reviewedAct || reviewedAct.status !== 'PASS' || (reviewedAct.unapprovedExceptions || []).length
      || (reviewedAct.uncoveredScriptTokenIndices || []).length) throw new Error(`ACTIVATION_REVIEWED_ALIGNMENT_NOT_PASS:${actKey}`);
  const scriptTokenCount = lexicalTokens(scriptText).length;
  const lexicalToWord = transcriptLexicalWordIndexes(words);
  const relationKeys = new Set();
  const deletionExceptions = (reviewedAct.approvedExceptions || []).filter(item => item?.type === 'SCRIPT_DELETION');
  const relations = [...(reviewedAct.matchedTokens || []), ...(reviewedAct.approvedExceptions || []).filter(item => item?.type !== 'SCRIPT_DELETION')]
    .map(item => ({ scriptStart: item.scriptTokenIndex, scriptEnd: item.scriptTokenEndIndex, transcriptStart: item.transcriptTokenIndex, transcriptEnd: item.transcriptTokenEndIndex }))
    .sort((a, b) => a.scriptStart - b.scriptStart || a.transcriptStart - b.transcriptStart)
    .filter(relation => {
      const key = `${relation.scriptStart}:${relation.scriptEnd}:${relation.transcriptStart}:${relation.transcriptEnd}`;
      if (relationKeys.has(key)) return false;
      relationKeys.add(key);
      return true;
    });
  const perScript = Array.from({ length: scriptTokenCount }, () => []), transcriptLexicalCounts = new Uint8Array(lexicalToWord.length);
  let previousScript = -1, previousTranscript = -1;
  for (const relation of relations) {
    if (![relation.scriptStart, relation.scriptEnd, relation.transcriptStart, relation.transcriptEnd].every(Number.isSafeInteger)
        || relation.scriptStart < 0 || relation.scriptEnd < relation.scriptStart || relation.scriptEnd >= scriptTokenCount
        || relation.transcriptStart < 0 || relation.transcriptEnd < relation.transcriptStart || relation.transcriptEnd >= lexicalToWord.length
        || relation.scriptStart < previousScript || relation.transcriptStart < previousTranscript) throw new Error(`ACTIVATION_REVIEWED_ALIGNMENT_RANGE_INVALID:${actKey}`);
    previousScript = relation.scriptStart; previousTranscript = relation.transcriptStart;
    const wordStart = lexicalToWord[relation.transcriptStart], wordEnd = lexicalToWord[relation.transcriptEnd];
    if (wordEnd < wordStart) throw new Error(`ACTIVATION_REVIEWED_ALIGNMENT_NON_MONOTONIC:${actKey}`);
    for (let index = relation.transcriptStart; index <= relation.transcriptEnd; index++) transcriptLexicalCounts[index]++;
    for (let index = relation.scriptStart; index <= relation.scriptEnd; index++) perScript[index].push([wordStart, wordEnd]);
  }
  for (const deletion of deletionExceptions) {
    if (![deletion.scriptTokenIndex, deletion.scriptTokenEndIndex, deletion.transcriptTokenBoundaryIndex].every(Number.isSafeInteger)
        || deletion.scriptTokenIndex < 0 || deletion.scriptTokenEndIndex < deletion.scriptTokenIndex || deletion.scriptTokenEndIndex >= scriptTokenCount
        || deletion.transcriptTokenBoundaryIndex < 0 || deletion.transcriptTokenBoundaryIndex > lexicalToWord.length) throw new Error(`ACTIVATION_REVIEWED_DELETION_RANGE_INVALID:${actKey}`);
    const anchor = deletion.transcriptTokenBoundaryIndex > 0 ? lexicalToWord[deletion.transcriptTokenBoundaryIndex - 1] : lexicalToWord[0];
    for (let index = deletion.scriptTokenIndex; index <= deletion.scriptTokenEndIndex; index++) {
      if (perScript[index].length) throw new Error(`ACTIVATION_REVIEWED_DELETION_CONFLICT:${actKey}`);
      perScript[index].push([anchor, anchor]);
    }
  }
  if (transcriptLexicalCounts.some(count => count !== 1) || perScript.some(ranges => ranges.length === 0)) throw new Error(`ACTIVATION_REVIEWED_ALIGNMENT_COVERAGE:${actKey}`);
  const mapping = perScript.map(ranges => {
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (!last || range[0] > last[1] + 1) merged.push([...range]);
      else if (range[0] <= last[1] && range[1] > last[1]) throw new Error(`ACTIVATION_REVIEWED_ALIGNMENT_OVERLAP:${actKey}`);
      else last[1] = Math.max(last[1], range[1]);
    }
    if (merged.length !== 1) throw new Error(`ACTIVATION_REVIEWED_ALIGNMENT_AMBIGUOUS:${actKey}`);
    return { start: merged[0][0], end: merged[0][1] };
  });
  return mapping;
}

function reviewedActFor(reviewedAlignment, actKey) {
  if (!reviewedAlignment || reviewedAlignment.status !== 'PASS' || reviewedAlignment.explicitRefusalOfUnlistedMismatches !== true || reviewedAlignment.unusedApprovalExceptionIds?.length) throw new Error('ACTIVATION_REVIEWED_ALIGNMENT_NOT_PASS');
  const matches = (reviewedAlignment.acts || []).filter(act => act.actKey === actKey);
  if (matches.length !== 1) throw new Error(`ACTIVATION_REVIEWED_ALIGNMENT_ACT_MISSING:${actKey}`);
  return matches[0];
}

function retimeEditPlanCore({ plan, wordTimestamps, actOrder, actBindings, actDurationsSec, script, reviewedAlignment, approvedBoundaryPolicy, boundaryInputHashes, approvedTimingExceptions }) {
  if (!Array.isArray(actOrder) || !actOrder.length || !actBindings || !actDurationsSec) throw new Error('ACTIVATION_TIMING_CONFIG_INVALID');
  if (new Set(actOrder).size !== actOrder.length) throw new Error('ACTIVATION_DUPLICATE_ACT');
  if (!plan || !Array.isArray(plan.sequences) || !plan.sequences.length) throw new Error('ACTIVATION_PLAN_INVALID');
  const next = deepClone(plan);
  const retiredBeatIds = new Set(approvedBoundaryPolicy?.retirements.map(item => item.beatId) || []);
  for (const sequence of next.sequences) sequence.beats = sequence.beats.filter(beat => !retiredBeatIds.has(beat.beatId));
  next.sequences = next.sequences.filter(sequence => sequence.beats.length > 0);
  const grouped = groupWordTimestamps(wordTimestamps, actBindings);
  const priorActs = plan.timing?.acts || [];
  if (!Array.isArray(priorActs) || new Set(priorActs.map(act => act.actKey)).size !== priorActs.length) throw new Error('ACTIVATION_PRIOR_TIMING_INVALID');
  const priorTiming = new Map(priorActs.map(act => [act.actKey, act]));
  const planActKeys = new Set(next.sequences.map(sequence => sequence.actKey));
  if (planActKeys.size !== actOrder.length || actOrder.some(actKey => !planActKeys.has(actKey))) throw new Error('ACTIVATION_PLAN_ACT_SET_MISMATCH');
  const allBeatIds = next.sequences.flatMap(sequence => sequence.beats.map(beat => beat.beatId));
  if (allBeatIds.some(id => typeof id !== 'string' || !id) || new Set(allBeatIds).size !== allBeatIds.length) throw new Error('ACTIVATION_PLAN_BEAT_IDS_INVALID');
  let episodeCursor = 0;
  const timingActs = [];
  for (const actKey of actOrder) {
    const voKey = actBindings[actKey];
    const words = grouped.get(voKey);
    const durationSec = actDurationsSec[actKey];
    if (!words?.length || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec + 0.001 < words.at(-1).end_seconds) throw new Error(`ACTIVATION_DURATION_INVALID:${actKey}`);
    const oldTiming = priorTiming.get(actKey);
    if (!oldTiming || oldTiming.voKey !== voKey || !Number.isSafeInteger(oldTiming.wordCount) || oldTiming.wordCount < 1) throw new Error(`ACTIVATION_WORD_ALIGNMENT_MISMATCH:${actKey}`);
    const scriptText = script?.acts?.[actKey]?.voScript;
    if (typeof scriptText !== 'string' || !scriptText.trim()) throw new Error(`ACTIVATION_SCRIPT_MISSING:${actKey}`);
    const reviewedAct = reviewedActFor(reviewedAlignment, actKey);
    const source = reconstructPlanSourceWords({ plan, actKey, priorTiming: oldTiming });
    const boundaryAudit = mapActBoundaryMappings({ source, scriptText, words, reviewedAct, actKey, approvedBoundaryPolicy, boundaryInputHashes });
    if (boundaryAudit.errors.length) throw new Error(boundaryAudit.errors[0].code);
    const mappedBeats = boundaryAudit.mappedBeats;
    if (mappedBeats.length !== source.beats.filter(beat => !retiredBeatIds.has(beat.beatId)).length || mappedBeats[0]?.transcriptStart !== 0 || mappedBeats.at(-1)?.transcriptEnd !== words.length - 1) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_COVERAGE:${actKey}`);
    let mappedCursor = 0;
    for (const item of mappedBeats) {
      if (item.transcriptStart !== mappedCursor) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_COVERAGE:${actKey}`);
      mappedCursor = item.transcriptEnd + 1;
    }
    if (mappedCursor !== words.length) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_COVERAGE:${actKey}`);
    const startSec = episodeCursor;
    const endSec = startSec + durationSec;
    timingActs.push({ actKey, voKey, startSec, endSec, durationSec, wordCount: words.length });
    const sequences = next.sequences.filter(sequence => sequence.actKey === actKey);
    if (!sequences.length) throw new Error(`ACTIVATION_PLAN_ACT_MISSING:${actKey}`);
    const mappedByBeat = new Map(mappedBeats.map(item => [item.beat.beatId, item]));
    for (const sequence of sequences) for (const beat of sequence.beats) {
      const mapped = mappedByBeat.get(beat.beatId);
      if (!mapped) throw new Error(`ACTIVATION_BOUNDARY_MAPPING_MISSING:${beat.beatId}`);
      const first = mapped.transcriptStart, last = mapped.transcriptEnd;
      beat.startWordIndex = first; beat.endWordIndex = last;
      beat.startSec = first === 0 ? startSec : startSec + words[first].start_seconds;
      beat.endSec = last === words.length - 1 ? endSec : startSec + words[last + 1].start_seconds;
      beat.durationSec = beat.endSec - beat.startSec;
      beat.narrationExcerpt = words.slice(first, last + 1).map(word => word.word).join(' ');
    }
    episodeCursor = endSec;
  }
  if (next.sequences.some(sequence => !actOrder.includes(sequence.actKey))) throw new Error('ACTIVATION_PLAN_HAS_UNKNOWN_ACT');
  next.timing = { basis: 'finished_vo_word_timestamps', totalDurationSec: episodeCursor, acts: timingActs };
  applyApprovedTimingExceptions(next, approvedTimingExceptions);
  const timingExceptionAudit = verifyTimingExceptionApplications({ plan: next, approvedTimingExceptions });
  return { plan: next, grouped, timingExceptionAudit };
}

function auditEditPlanBoundaries({ plan, wordTimestamps, actOrder, actBindings, actDurationsSec, script, reviewedAlignment, approvedBoundaryPolicy, boundaryInputHashes, approvedTimingExceptions } = {}) {
  const errors = [], acts = [];
  let grouped;
  try {
    if (!Array.isArray(actOrder) || !actOrder.length || !actBindings || !actDurationsSec) throw new Error('ACTIVATION_TIMING_CONFIG_INVALID');
    if (new Set(actOrder).size !== actOrder.length) throw new Error('ACTIVATION_DUPLICATE_ACT');
    if (!plan || !Array.isArray(plan.sequences) || !plan.sequences.length) throw new Error('ACTIVATION_PLAN_INVALID');
    grouped = groupWordTimestamps(wordTimestamps, actBindings);
    const planActKeys = new Set(plan.sequences.map(sequence => sequence.actKey));
    if (planActKeys.size !== actOrder.length || actOrder.some(actKey => !planActKeys.has(actKey))) throw new Error('ACTIVATION_PLAN_ACT_SET_MISMATCH');
  } catch (error) {
    const code = String(error.message || error);
    return { schemaVersion: 'phase2.3b-p-boundary-audit/1.0.0', status: 'BOUNDARY_AUDIT_FAIL', acts, errors: [{ code }], providerRequestsMade: 0, candidateWrites: 0, episodeRootWrites: 0 };
  }
  const priorTiming = new Map((plan.timing?.acts || []).map(act => [act.actKey, act]));
  for (const actKey of actOrder) {
    const voKey = actBindings[actKey], words = grouped.get(voKey);
    const sequences = plan.sequences.filter(sequence => sequence.actKey === actKey);
    const sourceBeatCount = sequences.reduce((sum, sequence) => sum + (Array.isArray(sequence.beats) ? sequence.beats.length : 0), 0);
    const entry = {
      actKey, beatCount: sourceBeatCount, sourceWordCount: 0, transcriptWordCount: words?.length || 0,
      mappedBoundaryCount: 0, boundaryCount: 0, firstMappedTranscriptIndex: null, lastMappedTranscriptIndex: null,
      gaps: [], overlaps: [], ambiguousMappings: [], unmappedBoundaries: [], errors: [],
    };
    try {
      const durationSec = actDurationsSec[actKey], oldTiming = priorTiming.get(actKey);
      if (!words?.length || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec + 0.001 < words.at(-1).end_seconds) throw new Error(`ACTIVATION_DURATION_INVALID:${actKey}`);
      if (!oldTiming || oldTiming.voKey !== voKey || !Number.isSafeInteger(oldTiming.wordCount) || oldTiming.wordCount < 1) throw new Error(`ACTIVATION_WORD_ALIGNMENT_MISMATCH:${actKey}`);
      const scriptText = script?.acts?.[actKey]?.voScript;
      if (typeof scriptText !== 'string' || !scriptText.trim()) throw new Error(`ACTIVATION_SCRIPT_MISSING:${actKey}`);
      const reviewedAct = reviewedActFor(reviewedAlignment, actKey);
      const source = reconstructPlanSourceWords({ plan, actKey, priorTiming: oldTiming });
      const retiredIds = new Set(approvedBoundaryPolicy?.retirements.filter(item => item.actKey === actKey).map(item => item.beatId) || []);
      const activeSourceBeats = source.beats.filter(beat => !retiredIds.has(beat.beatId));
      entry.sourceWordCount = source.words.length;
      entry.beatCount = activeSourceBeats.length;
      entry.boundaryCount = new Set(activeSourceBeats.flatMap(beat => [beat.startWordIndex, beat.endWordIndex])).size;
      const mapped = mapActBoundaryMappings({ source, scriptText, words, reviewedAct, actKey, approvedBoundaryPolicy, boundaryInputHashes });
      entry.mappedBoundaryCount = mapped.mappedBoundaries.size;
      entry.boundaryMappings = [...mapped.mappedBoundaries.entries()].map(([sourceIndex, target]) => ({ sourceIndex, ...target }));
      entry.firstMappedTranscriptIndex = mapped.mappedBeats[0]?.transcriptStart ?? null;
      entry.lastMappedTranscriptIndex = mapped.mappedBeats.at(-1)?.transcriptEnd ?? null;
      entry.gaps = mapped.gaps || [];
      entry.overlaps = mapped.overlaps || [];
      entry.errors = mapped.errors;
      entry.ambiguousMappings = mapped.errors.filter(item => /BOUNDARY_MAPPING_AMBIGUOUS/u.test(item.code));
      entry.unmappedBoundaries = mapped.errors.filter(item => /BOUNDARY_MAPPING_MISSING|BOUNDARY_MAPPING_INVALID/u.test(item.code));
      if (!mapped.errors.length && (mapped.mappedBeats.length !== activeSourceBeats.length || mapped.mappedBeats[0]?.transcriptStart !== 0 || mapped.mappedBeats.at(-1)?.transcriptEnd !== words.length - 1)) {
        entry.errors.push({ code: `ACTIVATION_BOUNDARY_MAPPING_COVERAGE:${actKey}` });
        entry.gaps.push({ start: mapped.mappedBeats.at(-1)?.transcriptEnd + 1 || 0, end: words.length - 1 });
      }
    } catch (error) {
      entry.errors.push({ code: String(error.message || error) });
    }
    acts.push(entry);
    for (const error of entry.errors) errors.push({ actKey, ...error });
  }
  let timingExceptionAudit = { status: approvedTimingExceptions ? 'FAIL' : 'NOT_REQUESTED', entries: [] };
  if (approvedTimingExceptions && !errors.length) {
    try {
      const retimed = retimeEditPlanCore({ plan, wordTimestamps, actOrder, actBindings, actDurationsSec, script, reviewedAlignment, approvedBoundaryPolicy, boundaryInputHashes, approvedTimingExceptions });
      timingExceptionAudit = retimed.timingExceptionAudit;
      for (const item of timingExceptionAudit.entries) {
        const act = acts.find(value => value.actKey === item.actKey);
        if (act) (act.timingExceptions ||= []).push(item);
      }
    } catch (error) {
      const code = String(error.message || error);
      errors.push({ code });
      const match = /^ACTIVATION_TIMING_EXCEPTION_[A-Z_]+:(act[0-9a-z]+):/u.exec(code);
      timingExceptionAudit = { status: 'FAIL', entries: [], error: code };
      if (match) acts.find(value => value.actKey === match[1])?.errors.push({ code });
    }
  }
  return {
    schemaVersion: 'phase2.3b-p-boundary-audit/1.0.0',
    status: errors.length ? 'BOUNDARY_AUDIT_FAIL' : 'BOUNDARY_AUDIT_PASS',
    acts, errors, timingExceptionAudit, providerRequestsMade: 0, candidateWrites: 0, episodeRootWrites: 0,
  };
}

function retimeEditPlan(input) {
  const audit = auditEditPlanBoundaries(input);
  if (audit.status !== 'BOUNDARY_AUDIT_PASS') {
    const preferred = audit.errors.find(item => /MAPPING_AMBIGUOUS|REVIEW_RELATION_AMBIGUOUS|BOUNDARY_AUTHORIZATION_REQUIRED/u.test(item.code));
    throw new Error(preferred?.code || audit.errors[0]?.code || 'ACTIVATION_BOUNDARY_AUDIT_FAILED');
  }
  return retimeEditPlanCore(input);
}

function assertOnlyApprovedActTextChanges(originalScript, candidateScript, correctedActKeys) {
  const approved = new Set(correctedActKeys);
  const oldActs = originalScript?.acts, newActs = candidateScript?.acts;
  if (!oldActs || !newActs || !equal(Object.keys(oldActs), Object.keys(newActs))) throw new Error('ACTIVATION_SCRIPT_ACT_SET_CHANGED');
  const before = deepClone(originalScript), after = deepClone(candidateScript);
  for (const actKey of approved) {
    if (!oldActs[actKey] || !newActs[actKey] || typeof oldActs[actKey].voScript !== 'string' || typeof newActs[actKey].voScript !== 'string') throw new Error(`ACTIVATION_APPROVED_ACT_INVALID:${actKey}`);
    before.acts[actKey].voScript = after.acts[actKey].voScript;
  }
  if (!equal(before, after)) throw new Error('ACTIVATION_UNAPPROVED_SCRIPT_CHANGE');
  for (const actKey of Object.keys(oldActs)) if (!approved.has(actKey) && oldActs[actKey].voScript !== newActs[actKey].voScript) throw new Error(`ACTIVATION_UNAPPROVED_NARRATION_CHANGE:${actKey}`);
  return true;
}

const CONTRACTIONS = Object.freeze({
  "can't": ['can', 'not'], "cannot": ['can', 'not'], "won't": ['will', 'not'], "couldn't": ['could', 'not'], "shouldn't": ['should', 'not'], "wouldn't": ['would', 'not'], "mustn't": ['must', 'not'],
  "don't": ['do', 'not'], "doesn't": ['does', 'not'], "didn't": ['did', 'not'],
  "isn't": ['is', 'not'], "aren't": ['are', 'not'], "wasn't": ['was', 'not'], "weren't": ['were', 'not'],
  "hasn't": ['has', 'not'], "haven't": ['have', 'not'], "hadn't": ['had', 'not'],
  "i'm": ['i', 'am'], "you're": ['you', 'are'], "we're": ['we', 'are'], "they're": ['they', 'are'],
  "it's": ['it', 'is'], "that's": ['that', 'is'], "there's": ['there', 'is'], "what's": ['what', 'is'],
  "i've": ['i', 'have'], "you've": ['you', 'have'], "we've": ['we', 'have'], "they've": ['they', 'have'],
  "i'll": ['i', 'will'], "you'll": ['you', 'will'], "we'll": ['we', 'will'], "they'll": ['they', 'will'],
  "i'd": ['i', 'would'], "you'd": ['you', 'would'], "we'd": ['we', 'would'], "they'd": ['they', 'would'],
  "he's": ['he', 'is'], "she's": ['she', 'is'], "who's": ['who', 'is'], "let's": ['let', 'us'],
});
const SMALL_NUMBERS = Object.freeze({ zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 });
const TENS = Object.freeze({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const MAGNITUDES = Object.freeze({ thousand: 1e3, million: 1e6, billion: 1e9 });
const CURRENCY = Object.freeze({ '$': 'USD', 'dollar': 'USD', 'dollars': 'USD', '£': 'GBP', 'pound': 'GBP', 'pounds': 'GBP', '€': 'EUR', 'euro': 'EUR', 'euros': 'EUR' });
const ORTHOGRAPHIC_EQUIVALENTS = Object.freeze({ cancelled: 'canceled' });

function lexicalTokens(value) {
  const text = String(value ?? '').normalize('NFKC').replace(/[’‘`]/gu, "'").replace(/[‐‑‒–—−]/gu, '-');
  const pattern = /\$|£|€|\b\d[\d,]*(?:\.\d+)?\b|[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*|-/gu;
  const out = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0] === '-') continue;
    out.push({ text: match[0].toLowerCase(), surface: match[0], offset: match.index });
  }
  return out;
}

function parseNumberWords(items, start) {
  let index = start, total = 0, current = 0, consumed = 0, sawNumber = false, decimal = null;
  while (index < items.length) {
    const word = items[index].text;
    if (word === 'and' && sawNumber) { index++; consumed++; continue; }
    if (word === 'point' && sawNumber && decimal === null) {
      decimal = ''; index++; consumed++;
      while (index < items.length && (Object.hasOwn(SMALL_NUMBERS, items[index].text) || /^\d$/u.test(items[index].text))) {
        const digit = Object.hasOwn(SMALL_NUMBERS, items[index].text) ? SMALL_NUMBERS[items[index].text] : Number(items[index].text);
        if (digit > 9) break;
        decimal += String(digit); index++; consumed++;
      }
      if (!decimal) return null;
      break;
    }
    if (Object.hasOwn(SMALL_NUMBERS, word)) { current += SMALL_NUMBERS[word]; sawNumber = true; }
    else if (Object.hasOwn(TENS, word)) { current += TENS[word]; sawNumber = true; }
    else if (word === 'hundred' && sawNumber) current = Math.max(1, current) * 100;
    else if (MAGNITUDES[word] && sawNumber) { total += Math.max(1, current) * MAGNITUDES[word]; current = 0; }
    else break;
    index++; consumed++;
  }
  if (!sawNumber) return null;
  const value = total + current;
  return { value: decimal === null ? value : Number(`${value}.${decimal}`), consumed };
}

function normalizedUnits(value) {
  const source = lexicalTokens(value), units = [];
  const push = (canonical, tokenStart, tokenEnd, surface) => units.push({ canonical, tokenStart, tokenEnd, surface });
  for (let i = 0; i < source.length;) {
    const item = source[i];
    if (Object.hasOwn(CURRENCY, item.text)) { push(`currency:${CURRENCY[item.text]}`, i, i, item.surface); i++; continue; }
    const contraction = CONTRACTIONS[item.text];
    if (contraction) { for (const part of contraction) push(`word:${part}`, i, i, item.surface); i++; continue; }
    if (item.text === "o'clock") { push('word:o', i, i, item.surface); push('word:clock', i, i, item.surface); i++; continue; }
    const possessive = item.text.match(/^(.+)'s$/u);
    if (possessive) { push(`word:${possessive[1]}`, i, i, item.surface); push('word:s', i, i, item.surface); i++; continue; }
    let numeric = null;
    if (/^\d[\d,]*(?:\.\d+)?$/u.test(item.text)) {
      const raw = item.text.replace(/,/gu, ''); numeric = { value: Number(raw), consumed: 1 };
    } else numeric = parseNumberWords(source, i);
    // Whisper may emit punctuation-separated numeric pieces as distinct
    // tokens. Rejoin only recognizable decimal-before-magnitude and
    // three-digit thousands groups; this is numeric normalization, not a
    // general token-count allowance.
    if (numeric?.consumed === 1 && /^\d{1,3}$/u.test(item.text) && /^\d$/u.test(source[i + 1]?.text || '') && MAGNITUDES[source[i + 2]?.text]) {
      numeric = { value: Number(`${item.text}.${source[i + 1].text}`), consumed: 2 };
    } else if (numeric?.consumed === 1 && /^\d{1,3}$/u.test(item.text) && /^\d{3}$/u.test(source[i + 1]?.text)) {
      numeric = { value: Number(`${item.text}${source[i + 1].text}`), consumed: 2 };
    }
    if (numeric) {
      let consumed = numeric.consumed, amount = numeric.value;
      const magnitude = source[i + consumed]?.text;
      if (MAGNITUDES[magnitude]) { amount *= MAGNITUDES[magnitude]; consumed++; }
      const prefixCurrency = i > 0 && Object.hasOwn(CURRENCY, source[i - 1].text) ? CURRENCY[source[i - 1].text] : null;
      const suffixCurrency = source[i + consumed] && Object.hasOwn(CURRENCY, source[i + consumed].text) ? CURRENCY[source[i + consumed].text] : null;
      const currency = prefixCurrency || suffixCurrency;
      const first = prefixCurrency ? i - 1 : i;
      const last = i + consumed - 1;
      if (currency) {
        if (prefixCurrency && units.at(-1)?.canonical === `currency:${prefixCurrency}`) units.pop();
        consumed += suffixCurrency ? 1 : 0;
        push(`money:${currency}:${Number(amount.toPrecision(12))}`, first, i + consumed - 1, source.slice(first, i + consumed).map(part => part.surface).join(' '));
      } else push(`number:${Number(amount.toPrecision(12))}`, i, last, source.slice(i, last + 1).map(part => part.surface).join(' '));
      i += consumed; continue;
    }
    push(`word:${ORTHOGRAPHIC_EQUIVALENTS[item.text] || item.text}`, i, i, item.surface); i++;
  }
  return { source, units };
}

function alignmentContext(tokensList, index, radius = 4) {
  const from = Math.max(0, index - radius), to = Math.min(tokensList.length, index + radius + 1);
  return { fromToken: from, toTokenExclusive: to, text: tokensList.slice(from, to).map(token => token.surface).join(' ') };
}

function alignActNarration(scriptText, transcriptWords, actKey, voKey) {
  const left = normalizedUnits(scriptText), right = normalizedUnits(transcriptWords.map(item => item.word).join(' '));
  const n = left.units.length, m = right.units.length, width = m + 1;
  const costs = new Uint32Array((n + 1) * width), ops = new Uint8Array((n + 1) * width);
  for (let i = 1; i <= n; i++) { costs[i * width] = i; ops[i * width] = 2; }
  for (let j = 1; j <= m; j++) { costs[j] = j; ops[j] = 3; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const at = i * width + j, same = left.units[i - 1].canonical === right.units[j - 1].canonical;
    const match = costs[(i - 1) * width + j - 1] + (same ? 0 : 1), deletion = costs[(i - 1) * width + j] + 1, insertion = costs[i * width + j - 1] + 1;
    if (match <= deletion && match <= insertion) { costs[at] = match; ops[at] = same ? 1 : 4; }
    else if (deletion <= insertion) { costs[at] = deletion; ops[at] = 2; }
    else { costs[at] = insertion; ops[at] = 3; }
  }
  const raw = []; let i = n, j = m;
  while (i || j) {
    const op = ops[i * width + j];
    if (op === 1 || op === 4) { raw.push({ type: op === 1 ? 'match' : 'substitution', left: left.units[i - 1], right: right.units[j - 1] }); i--; j--; }
    else if (op === 2) { raw.push({ type: 'deletion', left: left.units[i - 1] }); i--; }
    else { raw.push({ type: 'insertion', right: right.units[j - 1] }); j--; }
  }
  raw.reverse();
  const matchedScriptUnitIndexes = new Set(), matchedTranscriptUnitIndexes = new Set();
  const matches = [], normalizedEquivalents = [], substitutions = [], transcriptInsertions = [], scriptDeletions = [];
  let li = 0, ri = 0;
  for (const item of raw) {
    if (item.type === 'match') {
      matchedScriptUnitIndexes.add(li); matchedTranscriptUnitIndexes.add(ri);
      const record = { scriptToken: item.left.surface, transcriptToken: item.right.surface, normalizedToken: item.left.canonical, scriptTokenIndex: item.left.tokenStart, scriptTokenEndIndex: item.left.tokenEnd, transcriptTokenIndex: item.right.tokenStart, transcriptTokenEndIndex: item.right.tokenEnd };
      matches.push(record);
      if (item.left.surface.toLocaleLowerCase() !== item.right.surface.toLocaleLowerCase() || item.left.canonical !== `word:${item.left.surface.toLowerCase()}`) {
        record.normalizationClass = /^(?:number|money):/u.test(item.left.canonical)
          ? 'NUMERIC_TOKENIZATION'
          : (ORTHOGRAPHIC_EQUIVALENTS[item.left.surface.toLowerCase()] || item.left.surface.toLowerCase() === "o'clock" || item.right.surface.toLowerCase() === "o'clock")
            ? 'ORTHOGRAPHIC_VARIANT' : 'NORMALIZED_EQUIVALENT';
        normalizedEquivalents.push(record);
      }
      li++; ri++;
    } else if (item.type === 'substitution') {
      substitutions.push({ scriptToken: item.left.surface, transcriptToken: item.right.surface, scriptNormalizedToken: item.left.canonical, transcriptNormalizedToken: item.right.canonical, scriptTokenIndex: item.left.tokenStart, scriptTokenEndIndex: item.left.tokenEnd, transcriptTokenIndex: item.right.tokenStart, transcriptTokenEndIndex: item.right.tokenEnd, scriptContext: alignmentContext(left.source, item.left.tokenStart), transcriptContext: alignmentContext(right.source, item.right.tokenStart) }); li++; ri++;
    } else if (item.type === 'deletion') {
      scriptDeletions.push({ scriptToken: item.left.surface, scriptNormalizedToken: item.left.canonical, scriptTokenIndex: item.left.tokenStart, scriptTokenEndIndex: item.left.tokenEnd, transcriptTokenBoundaryIndex: ri < right.units.length ? right.units[ri].tokenStart : right.source.length, scriptContext: alignmentContext(left.source, item.left.tokenStart), transcriptBoundaryContext: alignmentContext(right.source, ri < right.units.length ? right.units[ri].tokenStart : right.source.length) }); li++;
    } else {
      transcriptInsertions.push({ transcriptToken: item.right.surface, transcriptNormalizedToken: item.right.canonical, transcriptTokenIndex: item.right.tokenStart, transcriptTokenEndIndex: item.right.tokenEnd, transcriptContext: alignmentContext(right.source, item.right.tokenStart) }); ri++;
    }
  }
  const sourceUnitCounts = new Map(), sourceMatchedUnitCounts = new Map();
  left.units.forEach((unit, unitIndex) => {
    for (let sourceIndex = unit.tokenStart; sourceIndex <= unit.tokenEnd; sourceIndex++) {
      sourceUnitCounts.set(sourceIndex, (sourceUnitCounts.get(sourceIndex) || 0) + 1);
      if (matchedScriptUnitIndexes.has(unitIndex)) sourceMatchedUnitCounts.set(sourceIndex, (sourceMatchedUnitCounts.get(sourceIndex) || 0) + 1);
    }
  });
  const sourceMatchCount = [...sourceUnitCounts.keys()].filter(index => sourceMatchedUnitCounts.get(index) === sourceUnitCounts.get(index)).length;
  const scriptTokenCount = left.source.length, transcriptTokenCount = right.source.length;
  const passed = substitutions.length === 0 && transcriptInsertions.length === 0 && scriptDeletions.length === 0;
  return { actKey, voKey, status: passed ? 'PASS' : 'FAIL', scriptTokenCount, transcriptTokenCount, matchedTokens: matches, matchedTokenCount: matches.length, normalizedEquivalents, substitutions, transcriptInsertions, scriptDeletions, alignmentCoverage: scriptTokenCount ? Number((sourceMatchCount / scriptTokenCount * 100).toFixed(3)) : 100, alignmentCoverageMatchedScriptTokens: sourceMatchCount, alignmentUnitCount: n, transcriptAlignmentUnitCount: m };
}

function analyzeScriptTimestampAlignment(script, wordTimestamps, actBindings) {
  const grouped = groupWordTimestamps(wordTimestamps, actBindings), acts = [];
  for (const [actKey, voKey] of Object.entries(actBindings)) acts.push(alignActNarration(script.acts?.[actKey]?.voScript, grouped.get(voKey), actKey, voKey));
  return { schemaVersion: 'phase2.3b-p-script-audio-alignment/1.0.0', status: acts.every(act => act.status === 'PASS') ? 'PASS' : 'FAIL', actOrder: Object.keys(actBindings), acts };
}

function assertScriptTimestampParity(script, wordTimestamps, actBindings) {
  const report = analyzeScriptTimestampAlignment(script, wordTimestamps, actBindings);
  const failed = report.acts.find(act => act.status !== 'PASS');
  if (failed) { const error = new Error(`ACTIVATION_SCRIPT_AUDIO_WORD_PARITY:${failed.actKey}`); error.alignmentReport = report; throw error; }
  return true;
}

const KNOWN_PHONETIC_VARIANTS = new Set(['word:stumpf>word:stump', 'number:8>word:aid', 'word:and>word:an', 'word:reckard>word:record', 'word:tolstedt>word:tolstead']);

function classifyReviewMismatch(mismatch) {
  if (!mismatch || !Number.isInteger(mismatch.scriptTokenIndex) || !Number.isInteger(mismatch.transcriptTokenIndex)) return 'UNAPPROVED_MISMATCH';
  const pair = `${mismatch.scriptNormalizedToken}>${mismatch.transcriptNormalizedToken}`;
  if (KNOWN_PHONETIC_VARIANTS.has(pair)) return 'ASR_PHONETIC_VARIANT';
  const money = /^money:USD:(\d+(?:\.\d+)?)$/u.exec(mismatch.scriptNormalizedToken || '');
  const number = /^number:(\d+(?:\.\d+)?)$/u.exec(mismatch.transcriptNormalizedToken || '');
  const sourceMentionsUsd = /\$|\bdollars?\b/iu.test(mismatch.scriptContext?.text || '');
  const transcriptOmitsUsd = !/\$|\bdollars?\b/iu.test(mismatch.transcriptContext?.text || '');
  // Classification is generic across amounts. The exact source/transcript
  // spans remain a proposal and still require a hash-bound human approval;
  // classification alone never changes alignment eligibility.
  if (money && number && Number(money[1]) === Number(number[1]) && sourceMentionsUsd && transcriptOmitsUsd) return 'ASR_CURRENCY_UNIT_OMISSION';
  return 'UNAPPROVED_MISMATCH';
}

function exactReviewException(actKey, classification, mismatch) {
  const record = {
    actKey, classification,
    scriptToken: mismatch.scriptToken, transcriptToken: mismatch.transcriptToken,
    scriptNormalizedToken: mismatch.scriptNormalizedToken, transcriptNormalizedToken: mismatch.transcriptNormalizedToken,
    scriptTokenIndex: mismatch.scriptTokenIndex, scriptTokenEndIndex: mismatch.scriptTokenEndIndex,
    transcriptTokenIndex: mismatch.transcriptTokenIndex, transcriptTokenEndIndex: mismatch.transcriptTokenEndIndex,
    scriptContext: mismatch.scriptContext, transcriptContext: mismatch.transcriptContext,
  };
  return { ...record, exceptionId: sha256(Buffer.from(JSON.stringify(record))) };
}

function exactReviewDeletionException(actKey, mismatch) {
  const record = {
    actKey, classification: 'SCRIPT_DELETION', type: 'SCRIPT_DELETION',
    scriptToken: mismatch.scriptToken, scriptNormalizedToken: mismatch.scriptNormalizedToken,
    scriptTokenIndex: mismatch.scriptTokenIndex, scriptTokenEndIndex: mismatch.scriptTokenEndIndex,
    transcriptTokenBoundaryIndex: mismatch.transcriptTokenBoundaryIndex,
    scriptContext: mismatch.scriptContext, transcriptBoundaryContext: mismatch.transcriptBoundaryContext,
  };
  return { ...record, exceptionId: sha256(Buffer.from(JSON.stringify(record))) };
}

function buildAlignmentReviewProposal({ runId, bindings, alignment } = {}) {
  if (!runId || !bindings || !alignment?.acts) throw new Error('ALIGNMENT_REVIEW_INPUT_INVALID');
  const proposedExceptions = [];
  for (const act of alignment.acts) for (const mismatch of act.substitutions || []) {
    const classification = classifyReviewMismatch(mismatch);
    if (classification !== 'UNAPPROVED_MISMATCH') proposedExceptions.push(exactReviewException(act.actKey, classification, mismatch));
  }
  for (const act of alignment.acts) for (const mismatch of act.scriptDeletions || []) proposedExceptions.push(exactReviewDeletionException(act.actKey, mismatch));
  return {
    schemaVersion: 'phase2.3b-p-alignment-review-proposal/1.0.0', status: 'PENDING_HUMAN_REVIEW', runId,
    episodeId: bindings.episodeId, channelKey: bindings.channelKey, bindings: structuredClone(bindings),
    proposedExceptions, unlistedMismatchPolicy: 'REFUSE',
  };
}

function applyAlignmentReviewApproval({ alignment, approvalArtifact, expectedBindings } = {}) {
  if (!alignment?.acts || !approvalArtifact || approvalArtifact.schemaVersion !== 'phase2.3b-p-alignment-review-approval/1.0.0' || approvalArtifact.status !== 'USER_APPROVED') throw new Error('ALIGNMENT_REVIEW_APPROVAL_INVALID');
  if (approvalArtifact.unlistedMismatchPolicy !== 'REFUSE' || JSON.stringify(approvalArtifact.bindings) !== JSON.stringify(expectedBindings) || approvalArtifact.runId !== expectedBindings?.runId || approvalArtifact.episodeId !== expectedBindings?.episodeId || approvalArtifact.channelKey !== expectedBindings?.channelKey || !approvalArtifact.humanApproval?.approvedBy || !approvalArtifact.humanApproval?.approvedAt || !approvalArtifact.humanApproval?.approvalRef || !/^[a-f0-9]{64}$/u.test(approvalArtifact.humanApproval?.sourceProposalSha256 || '')) throw new Error('ALIGNMENT_REVIEW_BINDING_MISMATCH');
  const entries = new Map((approvalArtifact.approvedExceptions || []).map(entry => [entry.exceptionId, entry]));
  if (entries.size !== (approvalArtifact.approvedExceptions || []).length) throw new Error('ALIGNMENT_REVIEW_DUPLICATE_EXCEPTION');
  const used = new Set(), acts = [];
  for (const act of alignment.acts) {
    const approvedExceptions = [], unapprovedExceptions = [], matchedScriptIndices = new Set();
    for (const match of act.matchedTokens || []) for (let index = match.scriptTokenIndex; index <= match.scriptTokenEndIndex; index++) matchedScriptIndices.add(index);
    for (const mismatch of act.substitutions || []) {
      const classification = classifyReviewMismatch(mismatch);
      const entry = exactReviewException(act.actKey, classification, mismatch);
      const approved = entries.get(entry.exceptionId);
      if (classification !== 'UNAPPROVED_MISMATCH' && approved && JSON.stringify(approved) === JSON.stringify(entry)) {
        used.add(entry.exceptionId); approvedExceptions.push(approved);
        for (let index = mismatch.scriptTokenIndex; index <= mismatch.scriptTokenEndIndex; index++) matchedScriptIndices.add(index);
      } else unapprovedExceptions.push({ classification: entry.classification, ...mismatch });
    }
    for (const mismatch of act.scriptDeletions || []) {
      const entry = exactReviewDeletionException(act.actKey, mismatch), approved = entries.get(entry.exceptionId);
      if (approved && JSON.stringify(approved) === JSON.stringify(entry)) {
        used.add(entry.exceptionId); approvedExceptions.push(approved);
        for (let index = mismatch.scriptTokenIndex; index <= mismatch.scriptTokenEndIndex; index++) matchedScriptIndices.add(index);
      } else unapprovedExceptions.push({ classification: 'SCRIPT_DELETION', ...mismatch });
    }
    for (const item of act.transcriptInsertions || []) unapprovedExceptions.push({ classification: 'TRANSCRIPT_INSERTION', ...item });
    const uncoveredScriptTokenIndices = Array.from({ length: act.scriptTokenCount }, (_, index) => index).filter(index => !matchedScriptIndices.has(index));
    const status = unapprovedExceptions.length === 0 && uncoveredScriptTokenIndices.length === 0 ? 'PASS' : 'FAIL';
    acts.push({ ...act, deterministicStatus: act.status, status, approvedExceptions, unapprovedExceptions, uncoveredScriptTokenIndices });
  }
  const unusedApprovalExceptionIds = [...entries.keys()].filter(id => !used.has(id));
  const status = acts.every(act => act.status === 'PASS') && unusedApprovalExceptionIds.length === 0 ? 'PASS' : 'FAIL';
  return { schemaVersion: 'phase2.3b-p-script-audio-reviewed-alignment/1.0.0', status, baseStatus: alignment.status, acts, unusedApprovalExceptionIds, explicitRefusalOfUnlistedMismatches: true };
}

function verifyCompletedTimingArtifacts({ timestamps, receipt, runId, expectedAudio, partial, actBindings }) {
  if (!receipt || receipt.schemaVersion !== 'phase2.3b-p-timing-source/1.0.0' || receipt.runId !== runId || !['TRANSCRIPTION_IN_PROGRESS', 'COMPLETE'].includes(receipt.state) || !Array.isArray(receipt.audio) || !equal(receipt.audio, expectedAudio)) throw new Error('TIMING_SOURCE_RECEIPT_MISMATCH');
  const grouped = groupWordTimestamps(timestamps, actBindings);
  if (receipt.wordTimestampsSha256 && receipt.wordTimestampsSha256 !== jsonHash(timestamps)) throw new Error('TIMING_SOURCE_TRANSCRIPT_HASH_MISMATCH');
  const partialActKeys = Object.keys(partial || {});
  const normalizedPartialKeys = partialActKeys.map(key => key.replace(/^VO_/u, '').replace(/\.mp3$/iu, '').toLowerCase());
  if (normalizedPartialKeys.some(key => !Object.hasOwn(actBindings, key)) || new Set(normalizedPartialKeys).size !== normalizedPartialKeys.length) throw new Error('TIMING_PARTIAL_UNKNOWN_ACT');
  if (partial && (normalizedPartialKeys.length !== Object.keys(actBindings).length || Object.keys(actBindings).some(key => !normalizedPartialKeys.includes(key)))) throw new Error('TIMING_PARTIAL_INCOMPLETE');
  for (const [actKey, voKey] of Object.entries(actBindings)) {
    const expectedWords = grouped.get(voKey);
    if (partial && Object.hasOwn(partial, voKey) && !equal(partial[voKey], expectedWords)) throw new Error(`TIMING_PARTIAL_MISMATCH:${actKey}`);
    if (partial && Object.hasOwn(partial, actKey) && !equal(partial[actKey], expectedWords)) throw new Error(`TIMING_PARTIAL_MISMATCH:${actKey}`);
  }
  return { status: 'VERIFIED', runId, wordCount: timestamps.length, wordTimestampsSha256: jsonHash(timestamps), acts: Object.fromEntries(Object.entries(actBindings).map(([actKey, voKey]) => [actKey, grouped.get(voKey).length])) };
}

async function chooseTimingTranscript({ resumeOnly = false, readExisting, transcribe } = {}) {
  if (typeof readExisting !== 'function' || typeof transcribe !== 'function') throw new Error('TIMING_TRANSCRIPT_SOURCE_INVALID');
  const existing = await readExisting();
  if (existing !== null && existing !== undefined) return existing;
  if (resumeOnly) throw new Error('COMPLETED_TRANSCRIPT_MISSING');
  return transcribe();
}

function applyApprovedB017AmendmentToPlan({ plan, sourcePlanSha256, amendmentLedgerBytes, approvedTimingExceptions } = {}) {
  if (!Buffer.isBuffer(amendmentLedgerBytes)
      || !isVerifiedTimingExceptionPolicy(approvedTimingExceptions)
      || approvedTimingExceptions.policySha256 !== REFRESHED_TIMING_EXCEPTION_POLICY_SHA256
      || sourcePlanSha256 !== approvedTimingExceptions.binding?.candidatePreTimingEditPlanSha256
      || !Array.isArray(plan?.sequences)) throw new Error('ACTIVATION_B017_PLAN_AMENDMENT_BINDING_INVALID');
  if (sha256(amendmentLedgerBytes) !== REFRESHED_B017_REVISION_LEDGER_SHA256) throw new Error('ACTIVATION_B017_PLAN_AMENDMENT_LEDGER_HASH_MISMATCH');
  let amendmentLedger;
  try { amendmentLedger = JSON.parse(amendmentLedgerBytes.toString('utf8')); }
  catch (_) { throw new Error('ACTIVATION_B017_PLAN_AMENDMENT_LEDGER_INVALID'); }
  if (!amendmentLedger || typeof amendmentLedger !== 'object' || Array.isArray(amendmentLedger)
      || amendmentLedger.revisionId !== 'phase2.3b-b017-factual-correction' || !Array.isArray(amendmentLedger.entries)) {
    throw new Error('ACTIVATION_B017_PLAN_AMENDMENT_LEDGER_INVALID');
  }
  const planFingerprint = value => sha256(Buffer.from(JSON.stringify(value), 'utf8'));
  const result = deepClone(plan);
  const beats = result.sequences.flatMap(sequence => sequence.beats || []);
  const sourceBeats = new Map(beats.map(beat => [beat.beatId, beat]));
  if (sourceBeats.size !== beats.length) throw new Error('ACTIVATION_B017_PLAN_AMENDMENT_BEAT_AMBIGUOUS');
  const expectedEntries = new Set([
    'ACT3_B016:endWordIndex', 'ACT3_B016:narrationExcerpt',
    'ACT3_B017:startWordIndex', 'ACT3_B017:narrationExcerpt', 'ACT3_B017:visualIntent',
    'ACT3_B017:visual.description', 'ACT3_B017:evidenceRequirement', 'ACT3_B017:sourceSearchInstruction',
    'ACT3_B018:endWordIndex', 'ACT3_B018:narrationExcerpt', 'ACT3_B018:visualIntent',
    'ACT3_B018:visual.description', 'ACT3_B018:graphics', 'ACT3_B018:overlaySpecification',
    'ACT3_B019:startWordIndex', 'ACT3_B019:narrationExcerpt',
  ]);
  const seen = new Set();
  const changes = [];
  const graphicsAfter = new Map();
  for (const entry of amendmentLedger.entries) {
    const key = `${entry.beatId}:${entry.fieldPath}`;
    if (!expectedEntries.has(key) || seen.has(key) || !['ACT3_B016','ACT3_B017','ACT3_B018','ACT3_B019'].includes(entry.beatId)) {
      throw new Error('ACTIVATION_B017_PLAN_AMENDMENT_SCOPE_INVALID');
    }
    seen.add(key);
    if (entry.beatId === 'ACT3_B018' && ['graphics','overlaySpecification'].includes(entry.fieldPath)) graphicsAfter.set(entry.fieldPath, entry.afterValue);
    if (entry.fieldPath === 'sourceSearchInstruction' || entry.fieldPath === 'overlaySpecification'
        || entry.fieldPath === 'narrationExcerpt') continue;
    const beat = sourceBeats.get(entry.beatId);
    const act = result.sequences.find(sequence => (sequence.actKey || sequence.act) === 'act3' && (sequence.beats || []).includes(beat));
    if (!beat || !act || (entry.fieldPath.includes('.') && entry.fieldPath.split('.').slice(0, -1).reduce((value, field) => value?.[field], beat) === undefined)) {
      throw new Error(`ACTIVATION_B017_PLAN_AMENDMENT_TARGET_INVALID:${key}`);
    }
    const parts = entry.fieldPath.split('.');
    const parent = parts.slice(0, -1).reduce((value, field) => value[field], beat);
    const field = parts.at(-1);
    const beforeValue = deepClone(parent[field]);
    if (!equal(parent[field], entry.afterValue)) {
      parent[field] = deepClone(entry.afterValue);
      changes.push({ beatId: entry.beatId, fieldPath: entry.fieldPath, beforeValue, afterValue: deepClone(entry.afterValue) });
    }
  }
  if (seen.size !== expectedEntries.size || !equal(graphicsAfter.get('graphics'), graphicsAfter.get('overlaySpecification')))
    throw new Error('ACTIVATION_B017_PLAN_AMENDMENT_ENTRIES_INCOMPLETE');
  const allowedPlanPaths = new Set([...expectedEntries].filter(key => !key.endsWith(':sourceSearchInstruction')
    && !key.endsWith(':overlaySpecification') && !key.endsWith(':narrationExcerpt')));
  const changed = [];
  for (const [beatId, beat] of sourceBeats) {
    const original = plan.sequences.flatMap(sequence => sequence.beats || []).find(item => item.beatId === beatId);
    for (const fieldPath of allowedPlanPaths) {
      const [owner, ...fieldParts] = fieldPath.split(':');
      if (owner !== beatId) continue;
      const get = value => fieldParts[0].split('.').reduce((current, field) => current?.[field], value);
      if (!equal(get(original), get(beat))) changed.push(`${beatId}:${fieldParts[0]}`);
    }
  }
  if (!equal(changed.sort(), changes.map(item => `${item.beatId}:${item.fieldPath}`).sort())) {
    throw new Error('ACTIVATION_B017_PLAN_AMENDMENT_UNRECORDED_CHANGE');
  }
  return {
    plan: result,
    proof: {
      schemaVersion: 'phase2.3b-b017-plan-amendment-proof/1.0.0',
      sourcePlanSha256,
      inputPlanFingerprint: planFingerprint(plan),
      childAmendmentSha256: REFRESHED_B017_AMENDMENT_SHA256,
      revisionLedgerSha256: sha256(amendmentLedgerBytes),
      outputPlanFingerprint: planFingerprint(result),
      changes,
      preservedCandidateNarrationExcerpts: true,
      status: 'PASS',
    },
  };
}

function updateShotDefinitions({ originalShotDefs, plan, revisionChain, revisionId, retiredBeatIds = [], retirementRecords = [], editorialIntentMigrations = null, approvedTimingExceptions = null }) {
  const shotDefs = deepClone(originalShotDefs);
  const retireSet = new Set(retiredBeatIds);
  if (retireSet.size !== retiredBeatIds.length || [...retireSet].some(id => id !== 'ACT3B_B010')) throw new Error('ACTIVATION_SHOT_RETIREMENT_NOT_APPROVED');
  const retirementById = new Map(retirementRecords.map(item => [item.beatId, item]));
  if (retireSet.size !== retirementById.size || [...retireSet].some(id => retirementById.get(id)?.actKey !== 'act3b' || retirementById.get(id)?.revisionLineageEntry !== `approved-retirement:act3b:${id}` || typeof retirementById.get(id)?.reason !== 'string' || !retirementById.get(id).reason.trim())) throw new Error('ACTIVATION_SHOT_RETIREMENT_APPROVAL_MISSING');
  const beatEntries = plan.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat]));
  const planBeats = new Map(beatEntries);
  if (planBeats.size !== beatEntries.length) throw new Error('ACTIVATION_PLAN_BEAT_IDS_INVALID');
  const retiredShots = [];
  const migrationOwners = ['act2:ACT2_B026','act3b:ACT3B_B018','act5:ACT5_B022','act5:ACT5_B023','act5:ACT5_B027'].sort();
  const migrations = editorialIntentMigrations === null ? [] : editorialIntentMigrations?.verified === true ? editorialIntentMigrations.entries : null;
  if (editorialIntentMigrations !== null && (!Array.isArray(migrations) || !equal(migrations.map(item => `${item.actKey}:${item.beatId}`).sort(), migrationOwners))) throw new Error('ACTIVATION_EDITORIAL_INTENT_MIGRATION_SET_INVALID');
  const migrationMap = new Map((migrations || []).map(item => [`${item.actKey}:${item.beatId}`, item]));
  const timingExceptionOwners = approvedTimingExceptions?.policySha256 ? timingExceptionOwnersFor(approvedTimingExceptions.policySha256) : null;
  const timingExceptions = approvedTimingExceptions === null ? [] : isVerifiedTimingExceptionPolicy(approvedTimingExceptions)
    && Array.isArray(approvedTimingExceptions.exceptions) ? approvedTimingExceptions.exceptions : null;
  if (approvedTimingExceptions !== null && (!timingExceptions
      || !equal(timingExceptions.map(item => `${item.actKey}:${item.beatId}`).sort(), [...timingExceptionOwners].sort()))) {
    throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_UNVERIFIED');
  }
  const timingExceptionMap = new Map((timingExceptions || []).map(item => [`${item.actKey}:${item.beatId}`, item]));
  if (timingExceptionMap.size !== (timingExceptions || []).length) throw new Error('ACTIVATION_TIMING_EXCEPTION_POLICY_DUPLICATE');
  for (const key of migrationMap.keys()) if (timingExceptionMap.has(key)) throw new Error(`ACTIVATION_TIMING_EXCEPTION_MIGRATION_CONFLICT:${key}`);
  const excludedFormalExceptionIds = approvedTimingExceptions?.excludedFormalExceptionIds || [];
  if (!Array.isArray(excludedFormalExceptionIds)
      || (approvedTimingExceptions?.policySha256 === REFRESHED_TIMING_EXCEPTION_POLICY_SHA256
        ? !equal(excludedFormalExceptionIds, ['act3:ACT3_B025']) : excludedFormalExceptionIds.length !== 0)) {
    throw new Error('ACTIVATION_TIMING_EXCEPTION_EXCLUSION_SET_INVALID');
  }
  const excludedFormalOwners = new Set(excludedFormalExceptionIds);
  if (excludedFormalOwners.size !== excludedFormalExceptionIds.length
      || [...excludedFormalOwners].some(key => migrationMap.has(key) || timingExceptionMap.has(key))) {
    throw new Error('ACTIVATION_TIMING_EXCEPTION_EXCLUSION_SCOPE_INVALID');
  }
  let excludedFormalClosuresApplied = 0;
  if (retireSet.size) {
    const originalShots = shotDefs.allShots;
    for (const beatId of retireSet) {
      const index = originalShots.findIndex(shot => shot.beatId === beatId);
      const shot = originalShots[index];
      const actKey = shot?.actKey;
      const actShots = shotDefs.acts?.[actKey];
      const actIndex = Array.isArray(actShots) ? actShots.findIndex(item => item.beatId === beatId) : -1;
      if (index < 0 || actIndex < 0 || !shot || !actShots[actIndex]) throw new Error(`ACTIVATION_RETIREMENT_SOURCE_MISSING:${beatId}`);
      retiredShots.push({ beatId, shotId: shot.shotId, actKey, allShotsIndex: index, actShotsIndex: actIndex, shot: deepClone(shot), actShot: deepClone(actShots[actIndex]), reason: retirementById.get(beatId).reason, revisionLineageEntry: retirementById.get(beatId).revisionLineageEntry, approvalStatus: 'APPROVED' });
      actShots.splice(actIndex, 1);
    }
    shotDefs.allShots = originalShots.filter(shot => !retireSet.has(shot.beatId));
    shotDefs.totalShots = shotDefs.allShots.length;
  }
  if (!Array.isArray(shotDefs.allShots) || shotDefs.allShots.length !== planBeats.size) throw new Error('ACTIVATION_SHOT_SET_MISMATCH');
  if (new Set(shotDefs.allShots.map(shot => shot.shotId)).size !== shotDefs.allShots.length || new Set(shotDefs.allShots.map(shot => shot.beatId)).size !== shotDefs.allShots.length) throw new Error('ACTIVATION_SHOT_IDS_INVALID');
  if (!Array.isArray(revisionChain) || revisionChain.length === 0 || !revisionChain.at(-1)?.resultArtifactSha256) throw new Error('ACTIVATION_REVISION_CHAIN_INVALID');
  const entries = [], permittedImmutablePaths = [];
  let timingExceptionReasonsApplied = 0;
  for (const shot of shotDefs.allShots) {
    const beat = planBeats.get(shot.beatId);
    const migration = migrationMap.get(`${shot.actKey}:${shot.beatId}`);
    const timingException = timingExceptionMap.get(`${shot.actKey}:${shot.beatId}`);
    if (migration) {
      if (shot.timingExceptionReason !== migration.existingTimingExceptionReason || beat?.timingExceptionReason !== null
          || beat?.durationSec < 2 || beat?.durationSec > 6 || Math.abs(beat?.durationSec - migration.approvedDurationSec) > 1e-9
          || (beat?.postNarrationHoldSec ?? 0) !== migration.postNarrationHoldSec
          || (beat?.intentionalStillness === true) !== migration.intentionalStillness || beat?.rhythmIntent !== migration.rhythmIntent) {
        throw new Error(`ACTIVATION_EDITORIAL_INTENT_SHOT_MIGRATION_MISMATCH:${shot.actKey}:${shot.beatId}`);
      }
      const beforeValue = shot.timingExceptionReason;
      shot.timingExceptionReason = null;
      const mirrored = shotDefs.acts?.[shot.actKey]?.find(item => item.beatId === shot.beatId);
      if (!mirrored || mirrored.timingExceptionReason !== migration.existingTimingExceptionReason) throw new Error(`ACTIVATION_EDITORIAL_INTENT_SHOT_MIRROR_MISMATCH:${shot.actKey}:${shot.beatId}`);
      mirrored.timingExceptionReason = null;
      entries.push({ shotId: shot.shotId, beatId: shot.beatId, mirrorActKey: shot.actKey, fieldPath: 'timingExceptionReason', beforeValue, afterValue: null, reason: 'Remove the exactly approved normal-duration editorial reason from shot metadata; dedicated hold, stillness, and rhythm fields remain intact.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-P-ACTIVATION' });
    }
    if (!beat || shot.sequenceId !== beat.sequenceId || shot.actKey !== beat.actKey) throw new Error(`ACTIVATION_SHOT_IDENTITY_MISMATCH:${shot.shotId}`);
    const excludedFormalKey = `${shot.actKey}:${shot.beatId}`;
    if (excludedFormalOwners.has(excludedFormalKey)) {
      const mirrors = [];
      for (const [actKey, actShots] of Object.entries(shotDefs.acts || {})) {
        if (!Array.isArray(actShots)) throw new Error(`ACTIVATION_TIMING_EXCEPTION_EXCLUSION_MIRROR_INVALID:${excludedFormalKey}`);
        for (const mirror of actShots) if (mirror?.shotId === shot.shotId || mirror?.beatId === shot.beatId) mirrors.push({ actKey, mirror });
      }
      const matching = mirrors.filter(item => item.actKey === shot.actKey && item.mirror?.actKey === shot.actKey
        && item.mirror?.shotId === shot.shotId && item.mirror?.beatId === shot.beatId);
      if (mirrors.length !== 1 || matching.length !== 1 || !shot.timingExceptionReason
          || matching[0].mirror.timingExceptionReason !== shot.timingExceptionReason
          || beat.timingExceptionReason !== null || !Number.isFinite(beat.durationSec)
          || beat.durationSec < 2 || beat.durationSec > 6
          || (shot.postNarrationHoldSec ?? 0) !== (beat.postNarrationHoldSec ?? 0)
          || (shot.intentionalStillness === true) !== (beat.intentionalStillness === true)
          || shot.rhythmIntent !== beat.rhythmIntent) {
        throw new Error(`ACTIVATION_TIMING_EXCEPTION_EXCLUSION_APPLICATION_MISMATCH:${excludedFormalKey}`);
      }
      const beforeValue = shot.timingExceptionReason;
      shot.timingExceptionReason = null;
      matching[0].mirror.timingExceptionReason = null;
      permittedImmutablePaths.push(`${shot.shotId}.timingExceptionReason`);
      entries.push({ shotId: shot.shotId, beatId: shot.beatId, mirrorActKey: shot.actKey,
        fieldPath: 'timingExceptionReason', beforeValue, afterValue: null,
        reason: 'Clear the prior formal-exception field only for the exact refreshed-policy exclusion after the beat returns within the unchanged global limits; hold, stillness, and rhythm remain bound and intact.',
        approvalStatus: 'APPROVED', revisionVersion: '2.3B-P-ACTIVATION' });
      excludedFormalClosuresApplied++;
    }
    if (timingException) {
      const key = `${timingException.actKey}:${timingException.beatId}`;
      if (timingException.actKey !== shot.actKey || timingException.beatId !== shot.beatId
          || typeof timingException.justification !== 'string' || !timingException.justification.trim()
          || beat.timingExceptionReason !== timingException.justification) {
        throw new Error(`ACTIVATION_TIMING_EXCEPTION_REASON_SCOPE_MISMATCH:${key}`);
      }
      const canonicalCopies = shotDefs.allShots.filter(item => item?.shotId === shot.shotId && item?.beatId === shot.beatId);
      const mirrorCopies = [];
      for (const [actKey, actShots] of Object.entries(shotDefs.acts || {})) {
        if (!Array.isArray(actShots)) throw new Error(`ACTIVATION_TIMING_EXCEPTION_MIRROR_INVALID:${key}`);
        for (const mirror of actShots) if (mirror?.shotId === shot.shotId || mirror?.beatId === shot.beatId) mirrorCopies.push({ actKey, shot: mirror });
      }
      const expectedMirrors = mirrorCopies.filter(item => item.actKey === shot.actKey && item.shot?.shotId === shot.shotId
        && item.shot?.beatId === shot.beatId && item.shot?.actKey === shot.actKey);
      if (canonicalCopies.length !== 1) throw new Error(`ACTIVATION_TIMING_EXCEPTION_SHOT_AMBIGUOUS:${key}`);
      if (expectedMirrors.length !== 1 || mirrorCopies.length !== 1) {
        throw new Error(`ACTIVATION_TIMING_EXCEPTION_MIRROR_MISSING_OR_AMBIGUOUS:${key}`);
      }
      const mirrored = expectedMirrors[0].shot;
      if (shot.timingExceptionReason !== timingException.priorTimingExceptionReason
          || mirrored.timingExceptionReason !== timingException.priorTimingExceptionReason) {
        throw new Error(`ACTIVATION_TIMING_EXCEPTION_PRIOR_REASON_MISMATCH:${key}`);
      }
      const beforeValue = shot.timingExceptionReason;
      shot.timingExceptionReason = timingException.justification;
      mirrored.timingExceptionReason = timingException.justification;
      permittedImmutablePaths.push(`${shot.shotId}.timingExceptionReason`);
      entries.push({ shotId: shot.shotId, beatId: shot.beatId, mirrorActKey: shot.actKey,
        fieldPath: 'timingExceptionReason', beforeValue, afterValue: timingException.justification,
        reason: 'Propagate the exact reason from the verified, hash-bound timing exception policy to canonical and mirrored shot metadata.',
        approvalStatus: 'APPROVED', revisionVersion: '2.3B-P-ACTIVATION' });
      timingExceptionReasonsApplied++;
    } else if (!migration && shot.timingExceptionReason !== beat.timingExceptionReason) {
      throw new Error(`ACTIVATION_SHOT_TIMING_REASON_UNAPPROVED:${shot.actKey}:${shot.beatId}`);
    }
    for (const field of SHOT_DYNAMIC_FIELDS) {
      const beforeValue = shot[field]; const afterValue = beat[field];
      if (!equal(beforeValue, afterValue)) {
        shot[field] = deepClone(afterValue);
        permittedImmutablePaths.push(`${shot.shotId}.${field}`);
        entries.push({ shotId: shot.shotId, beatId: shot.beatId, fieldPath: field, beforeValue, afterValue, reason: 'Deterministic timing propagation from the approved finished voiceover.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-P-ACTIVATION' });
      }
    }
  }
  if (timingExceptionReasonsApplied !== timingExceptionMap.size) throw new Error('ACTIVATION_TIMING_EXCEPTION_BEAT_MISSING');
  if (excludedFormalClosuresApplied !== excludedFormalOwners.size) throw new Error('ACTIVATION_TIMING_EXCEPTION_EXCLUSION_BEAT_MISSING');
  const planSha256 = require('./shot-definitions-validator.cjs').planFingerprint(plan);
  const beforePlanSha = shotDefs.sourceEditPlanSha256;
  shotDefs.sourceEditPlanSha256 = planSha256;
  const ledger = {
    ledgerVersion: '1.0.0', revisionId, revisionVersion: '2.3B-P-ACTIVATION', lineageRole: 'current', approvalStatus: 'APPROVED',
    approval: { status: 'APPROVED', basis: 'User-approved six-act narration and deterministic finished-VO retiming; creative fields remain frozen.' },
    parentArtifactSha256: revisionChain.at(-1).resultArtifactSha256,
    resultArtifactSha256: require('./revision-lineage.cjs').artifactSha256(shotDefs),
    permittedImmutablePaths, entries, ...(retiredShots.length ? { retirements: retiredShots } : {}),
    bindings: [{ fieldPath: 'sourceEditPlanSha256', beforeValue: beforePlanSha, afterValue: planSha256, reason: 'Bind shot definitions to the deterministically retimed approved edit plan.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-P-ACTIVATION' }],
  };
  return { shotDefs, revisionLedger: ledger, revisionChain: [...revisionChain, ledger], excludedFormalClosuresApplied };
}

function assertCreativePlanFieldsFrozen(before, after, { retiredBeatIds = [], approvedTimingExceptionBeatIds = [], editorialIntentMigrationBeatIds = [], excludedTimingExceptionBeatIds = [] } = {}) {
  if (!equal(Object.keys(before), Object.keys(after))) throw new Error('ACTIVATION_PLAN_TOP_LEVEL_KEYS_CHANGED');
  const beforeBeats = new Map(before.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat])));
  const afterBeats = new Map(after.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat])));
  const retired = new Set(retiredBeatIds);
  const timingExceptions = new Set(approvedTimingExceptionBeatIds);
  const editorialMigrations = new Set(editorialIntentMigrationBeatIds);
  const excludedTimingExceptions = new Set(excludedTimingExceptionBeatIds);
  if (timingExceptions.size !== approvedTimingExceptionBeatIds.length || editorialMigrations.size !== editorialIntentMigrationBeatIds.length
      || excludedTimingExceptions.size !== excludedTimingExceptionBeatIds.length
      || [...timingExceptions, ...editorialMigrations].some(id => typeof id !== 'string' || !id)
      || [...timingExceptions].some(id => editorialMigrations.has(id) || excludedTimingExceptions.has(id))
      || [...editorialMigrations].some(id => excludedTimingExceptions.has(id))) throw new Error('ACTIVATION_TIMING_EXCEPTION_ID_SET_INVALID');
  const permittedReasonChanges = new Set([...timingExceptions, ...editorialMigrations, ...excludedTimingExceptions]);
  if (!equal([...beforeBeats.keys()].filter(id => !retired.has(id)), [...afterBeats.keys()])) throw new Error('ACTIVATION_BEAT_SET_CHANGED');
  for (const [beatId, oldBeat] of beforeBeats) {
    if (retired.has(beatId)) continue;
    const newBeat = afterBeats.get(beatId);
    const a = deepClone(oldBeat), b = deepClone(newBeat);
    for (const field of PLAN_DYNAMIC_FIELDS) { delete a[field]; delete b[field]; }
    if (permittedReasonChanges.has(beatId)) { delete a.timingExceptionReason; delete b.timingExceptionReason; }
    if (!equal(a, b)) throw new Error(`ACTIVATION_CREATIVE_BEAT_FIELD_CHANGED:${beatId}`);
  }
  const stripDynamicBeat = beat => {
    const result = deepClone(beat);
    for (const field of PLAN_DYNAMIC_FIELDS) delete result[field];
    if (permittedReasonChanges.has(beat.beatId)) delete result.timingExceptionReason;
    return result;
  };
  const beforeSequences = before.sequences.map(sequence => ({ ...sequence, beats: sequence.beats.filter(beat => !retired.has(beat.beatId)).map(stripDynamicBeat) })).filter(sequence => sequence.beats.length);
  const afterSequences = after.sequences.map(sequence => ({ ...sequence, beats: sequence.beats.map(stripDynamicBeat) })).filter(sequence => sequence.beats.length);
  if (!equal(beforeSequences, afterSequences)) throw new Error('ACTIVATION_SEQUENCE_OR_CREATIVE_FIELD_CHANGED');
  return true;
}

function verifyReplacementSet(candidateDirectory, fileManifest) {
  if (!Array.isArray(fileManifest) || fileManifest.length !== TARGET_FILES.length || new Set(fileManifest.map(item => item.path)).size !== TARGET_FILES.length) throw new Error('ACTIVATION_REPLACEMENT_SET_INVALID');
  const expected = new Set(TARGET_FILES);
  for (const item of fileManifest) {
    assertSafeRelative(item.path);
    if (!expected.has(item.path)) throw new Error(`ACTIVATION_REPLACEMENT_UNKNOWN:${item.path}`);
    const file = path.resolve(candidateDirectory, item.path);
    if (!file.startsWith(`${path.resolve(candidateDirectory)}${path.sep}`) || !fs.existsSync(file)) throw new Error(`ACTIVATION_CANDIDATE_MISSING:${item.path}`);
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error(`ACTIVATION_CANDIDATE_HASH_MISMATCH:${item.path}`);
  }
  return true;
}

function makeBackup({ fs: fsImpl = fs, episodeDirectory, backupDirectory, targets = TARGET_FILES }) {
  const files = [];
  for (const relative of targets) {
    assertSafeRelative(relative);
    const source = path.join(episodeDirectory, relative);
    const existed = fsImpl.existsSync(source);
    if (!existed) { files.push({ path: relative, existed: false }); continue; }
    const bytes = fsImpl.readFileSync(source);
    const target = path.join(backupDirectory, relative);
    atomicWrite(fsImpl, target, bytes);
    files.push({ path: relative, existed: true, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { schemaVersion: 'phase2.3b-p-backup/1.0.0', createdAt: new Date().toISOString(), files };
}

function verifyBackup({ fs: fsImpl = fs, backupDirectory, manifest }) {
  if (manifest?.schemaVersion !== 'phase2.3b-p-backup/1.0.0' || !Array.isArray(manifest.files)) throw new Error('ACTIVATION_BACKUP_MANIFEST_INVALID');
  const seen = new Set();
  for (const item of manifest.files) {
    assertSafeRelative(item?.path);
    if (seen.has(item.path)) throw new Error(`ACTIVATION_BACKUP_DUPLICATE_PATH:${item.path}`);
    seen.add(item.path);
    const file = path.resolve(backupDirectory, item.path);
    if (!file.startsWith(`${path.resolve(backupDirectory)}${path.sep}`)) throw new Error(`ACTIVATION_BACKUP_PATH_INVALID:${item.path}`);
    const exists = fsImpl.existsSync(file);
    if (item.existed === true) {
      if (!exists) throw new Error(`ACTIVATION_BACKUP_MISSING:${item.path}`);
      const bytes = fsImpl.readFileSync(file);
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`ACTIVATION_BACKUP_HASH_MISMATCH:${item.path}`);
    } else if (item.existed === false && exists) throw new Error(`ACTIVATION_UNEXPECTED_BACKUP:${item.path}`);
    else if (item.existed !== true && item.existed !== false) throw new Error(`ACTIVATION_BACKUP_ENTRY_INVALID:${item.path}`);
  }
  return true;
}

function restoreBackup({ fs: fsImpl = fs, episodeDirectory, backupDirectory, manifest }) {
  verifyBackup({ fs: fsImpl, backupDirectory, manifest });
  for (const item of manifest.files) {
    const target = path.join(episodeDirectory, item.path);
    if (!item.existed) fsImpl.rmSync(target, { force: true });
    else atomicWrite(fsImpl, target, fsImpl.readFileSync(path.join(backupDirectory, item.path)));
  }
  return true;
}

module.exports = {
  PLAN_DYNAMIC_FIELDS, SHOT_DYNAMIC_FIELDS, TARGET_FILES, APPROVED_BOUNDARY_POLICY_SHA256, REFRESHED_BOUNDARY_POLICY_SHA256, REFRESHED_BOUNDARY_POLICY_BINDINGS, APPROVED_TIMING_EXCEPTION_POLICY_SHA256, sha256, jsonHash, tokens, lexicalTokens, reserveWhisperAttempt,
  verifyApprovedBoundaryPolicy, deriveRefreshedWhitespaceRange, approvedTimingProductionObligations, verifyApprovedTimingExceptionPolicy, verifyTimingExceptionApplications, updateProductionManifestForRetirements,
  REFRESHED_TIMING_EXCEPTION_POLICY_SHA256,
  groupWordTimestamps, auditEditPlanBoundaries, retimeEditPlan, assertOnlyApprovedActTextChanges, assertScriptTimestampParity,
  alignActNarration, analyzeScriptTimestampAlignment, verifyCompletedTimingArtifacts,
  classifyReviewMismatch, exactReviewException, buildAlignmentReviewProposal, applyAlignmentReviewApproval,
  chooseTimingTranscript,
  updateShotDefinitions, applyApprovedB017AmendmentToPlan, assertCreativePlanFieldsFrozen, verifyReplacementSet, makeBackup, verifyBackup, restoreBackup, atomicWrite,
};
