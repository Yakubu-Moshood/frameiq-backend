'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_DYNAMIC_FIELDS = new Set(['startSec', 'endSec', 'durationSec', 'narrationExcerpt']);
const SHOT_DYNAMIC_FIELDS = new Set(['startWordIndex', 'endWordIndex', 'startSec', 'endSec', 'durationSec', 'narrationExcerpt']);
const TARGET_FILES = [
  'script.json', 'assets/audio/VO_Act1.mp3', 'assets/audio/VO_Act2.mp3', 'assets/audio/VO_Act3.mp3',
  'assets/audio/VO_Act3B.mp3', 'assets/audio/VO_Act4.mp3', 'assets/audio/VO_Act5.mp3',
  'edit-plan.json', 'edit-plan-validation.json', 'edit-plan-shadow-status.json', 'shot-definitions.json',
  'production-manifest.json', 'evidence-source-manifest.json', 'proof-section-plan.json',
];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
const deepClone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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

function retimeEditPlan({ plan, wordTimestamps, actOrder, actBindings, actDurationsSec }) {
  if (!Array.isArray(actOrder) || !actOrder.length || !actBindings || !actDurationsSec) throw new Error('ACTIVATION_TIMING_CONFIG_INVALID');
  if (new Set(actOrder).size !== actOrder.length) throw new Error('ACTIVATION_DUPLICATE_ACT');
  if (!plan || !Array.isArray(plan.sequences) || !plan.sequences.length) throw new Error('ACTIVATION_PLAN_INVALID');
  const next = deepClone(plan);
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
    if (!oldTiming || oldTiming.voKey !== voKey || oldTiming.wordCount !== words.length) throw new Error(`ACTIVATION_WORD_ALIGNMENT_MISMATCH:${actKey}`);
    const startSec = episodeCursor;
    const endSec = startSec + durationSec;
    timingActs.push({ actKey, voKey, startSec, endSec, durationSec, wordCount: words.length });
    const sequences = next.sequences.filter(sequence => sequence.actKey === actKey);
    if (!sequences.length) throw new Error(`ACTIVATION_PLAN_ACT_MISSING:${actKey}`);
    for (const sequence of sequences) for (const beat of sequence.beats) {
      const first = beat.startWordIndex, last = beat.endWordIndex;
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || last >= words.length) throw new Error(`ACTIVATION_BEAT_RANGE_INVALID:${beat.beatId}`);
      beat.startSec = first === 0 ? startSec : startSec + words[first].start_seconds;
      beat.endSec = last === words.length - 1 ? endSec : startSec + words[last + 1].start_seconds;
      beat.durationSec = beat.endSec - beat.startSec;
      beat.narrationExcerpt = words.slice(first, last + 1).map(word => word.word).join(' ');
    }
    episodeCursor = endSec;
  }
  if (next.sequences.some(sequence => !actOrder.includes(sequence.actKey))) throw new Error('ACTIVATION_PLAN_HAS_UNKNOWN_ACT');
  next.timing = { basis: 'finished_vo_word_timestamps', totalDurationSec: episodeCursor, acts: timingActs };
  return { plan: next, grouped };
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
      scriptDeletions.push({ scriptToken: item.left.surface, scriptNormalizedToken: item.left.canonical, scriptTokenIndex: item.left.tokenStart, scriptTokenEndIndex: item.left.tokenEnd, scriptContext: alignmentContext(left.source, item.left.tokenStart) }); li++;
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

function buildAlignmentReviewProposal({ runId, bindings, alignment } = {}) {
  if (!runId || !bindings || !alignment?.acts) throw new Error('ALIGNMENT_REVIEW_INPUT_INVALID');
  const proposedExceptions = [];
  for (const act of alignment.acts) for (const mismatch of act.substitutions || []) {
    const classification = classifyReviewMismatch(mismatch);
    if (classification !== 'UNAPPROVED_MISMATCH') proposedExceptions.push(exactReviewException(act.actKey, classification, mismatch));
  }
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
    for (const item of act.scriptDeletions || []) unapprovedExceptions.push({ classification: 'SCRIPT_DELETION', ...item });
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

function updateShotDefinitions({ originalShotDefs, plan, revisionChain, revisionId }) {
  const shotDefs = deepClone(originalShotDefs);
  const beatEntries = plan.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat]));
  const planBeats = new Map(beatEntries);
  if (planBeats.size !== beatEntries.length) throw new Error('ACTIVATION_PLAN_BEAT_IDS_INVALID');
  if (!Array.isArray(shotDefs.allShots) || shotDefs.allShots.length !== planBeats.size) throw new Error('ACTIVATION_SHOT_SET_MISMATCH');
  if (new Set(shotDefs.allShots.map(shot => shot.shotId)).size !== shotDefs.allShots.length || new Set(shotDefs.allShots.map(shot => shot.beatId)).size !== shotDefs.allShots.length) throw new Error('ACTIVATION_SHOT_IDS_INVALID');
  if (!Array.isArray(revisionChain) || revisionChain.length === 0 || !revisionChain.at(-1)?.resultArtifactSha256) throw new Error('ACTIVATION_REVISION_CHAIN_INVALID');
  const entries = [], permittedImmutablePaths = [];
  for (const shot of shotDefs.allShots) {
    const beat = planBeats.get(shot.beatId);
    if (!beat || shot.sequenceId !== beat.sequenceId || shot.actKey !== beat.actKey) throw new Error(`ACTIVATION_SHOT_IDENTITY_MISMATCH:${shot.shotId}`);
    for (const field of SHOT_DYNAMIC_FIELDS) {
      const beforeValue = shot[field]; const afterValue = beat[field];
      if (!equal(beforeValue, afterValue)) {
        shot[field] = deepClone(afterValue);
        permittedImmutablePaths.push(`${shot.shotId}.${field}`);
        entries.push({ shotId: shot.shotId, beatId: shot.beatId, fieldPath: field, beforeValue, afterValue, reason: 'Deterministic timing propagation from the approved finished voiceover.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-P-ACTIVATION' });
      }
    }
  }
  const planSha256 = require('./shot-definitions-validator.cjs').planFingerprint(plan);
  const beforePlanSha = shotDefs.sourceEditPlanSha256;
  shotDefs.sourceEditPlanSha256 = planSha256;
  const ledger = {
    ledgerVersion: '1.0.0', revisionId, revisionVersion: '2.3B-P-ACTIVATION', lineageRole: 'current', approvalStatus: 'APPROVED',
    approval: { status: 'APPROVED', basis: 'User-approved six-act narration and deterministic finished-VO retiming; creative fields remain frozen.' },
    parentArtifactSha256: revisionChain.at(-1).resultArtifactSha256,
    resultArtifactSha256: require('./revision-lineage.cjs').artifactSha256(shotDefs),
    permittedImmutablePaths, entries,
    bindings: [{ fieldPath: 'sourceEditPlanSha256', beforeValue: beforePlanSha, afterValue: planSha256, reason: 'Bind shot definitions to the deterministically retimed approved edit plan.', approvalStatus: 'APPROVED', revisionVersion: '2.3B-P-ACTIVATION' }],
  };
  return { shotDefs, revisionLedger: ledger, revisionChain: [...revisionChain, ledger] };
}

function assertCreativePlanFieldsFrozen(before, after) {
  if (!equal(Object.keys(before), Object.keys(after))) throw new Error('ACTIVATION_PLAN_TOP_LEVEL_KEYS_CHANGED');
  const beforeBeats = new Map(before.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat])));
  const afterBeats = new Map(after.sequences.flatMap(sequence => sequence.beats.map(beat => [beat.beatId, beat])));
  if (!equal([...beforeBeats.keys()], [...afterBeats.keys()])) throw new Error('ACTIVATION_BEAT_SET_CHANGED');
  for (const [beatId, oldBeat] of beforeBeats) {
    const newBeat = afterBeats.get(beatId);
    const a = deepClone(oldBeat), b = deepClone(newBeat);
    for (const field of PLAN_DYNAMIC_FIELDS) { delete a[field]; delete b[field]; }
    if (!equal(a, b)) throw new Error(`ACTIVATION_CREATIVE_BEAT_FIELD_CHANGED:${beatId}`);
  }
  const beforeSequences = before.sequences.map(sequence => ({ ...sequence, beats: sequence.beats.map(({ startWordIndex, endWordIndex, startSec, endSec, durationSec, narrationExcerpt, ...beat }) => beat) }));
  const afterSequences = after.sequences.map(sequence => ({ ...sequence, beats: sequence.beats.map(({ startWordIndex, endWordIndex, startSec, endSec, durationSec, narrationExcerpt, ...beat }) => beat) }));
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
  PLAN_DYNAMIC_FIELDS, SHOT_DYNAMIC_FIELDS, TARGET_FILES, sha256, jsonHash, tokens, reserveWhisperAttempt,
  groupWordTimestamps, retimeEditPlan, assertOnlyApprovedActTextChanges, assertScriptTimestampParity,
  alignActNarration, analyzeScriptTimestampAlignment, verifyCompletedTimingArtifacts,
  classifyReviewMismatch, exactReviewException, buildAlignmentReviewProposal, applyAlignmentReviewApproval,
  chooseTimingTranscript,
  updateShotDefinitions, assertCreativePlanFieldsFrozen, verifyReplacementSet, makeBackup, verifyBackup, restoreBackup, atomicWrite,
};
