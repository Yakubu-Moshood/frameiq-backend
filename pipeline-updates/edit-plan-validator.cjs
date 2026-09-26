'use strict';

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./edit-plan.schema.json');

const EPSILON = 0.001;
const ACT_VO = { act1: 'VO_Act1', act2: 'VO_Act2', act3: 'VO_Act3', act3b: 'VO_Act3B', act4: 'VO_Act4', act5: 'VO_Act5' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const finite = Number.isFinite;
const array = value => Array.isArray(value) ? value : [];
const near = (a, b) => Math.abs(a - b) <= EPSILON;
const span = value => finite(value?.startSec) && finite(value?.endSec) && value.endSec > value.startSec;
const normalizeTokens = value => typeof value === 'string'
  ? value.split(/\s+/).map(token => token.toLowerCase().replace(/[^a-z0-9']/g, '')).filter(Boolean)
  : [];

// This private walker implements only the keywords used by our bundled schema,
// not a general JSON Schema engine. Unknown keywords fail loudly so future
// schema changes cannot silently bypass validation. No remote refs are loaded.
const KEYWORDS = new Set(['$schema', '$comment', 'title', 'description', '$defs', '$ref', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'uniqueItems', 'minimum', 'exclusiveMinimum', 'pattern']);
function checkSchema(value, rule, location, error) {
  for (const key of Object.keys(rule)) {
    if (!KEYWORDS.has(key)) throw new Error(`Unsupported bundled schema keyword: ${key}`);
  }
  if (rule.$ref) {
    const name = rule.$ref.replace('#/$defs/', '');
    if (rule.$ref !== `#/$defs/${name}` || !Object.hasOwn(schema.$defs, name)) throw new Error('Invalid bundled schema reference');
    return checkSchema(value, schema.$defs[name], location, error);
  }
  const matches = type => {
    if (type === 'object') return object(value);
    if (type === 'array') return Array.isArray(value);
    if (type === 'null') return value === null;
    if (type === 'integer') return Number.isSafeInteger(value);
    if (type === 'number') return finite(value);
    return typeof value === type;
  };
  if (rule.type && ![].concat(rule.type).some(matches)) {
    error('SCHEMA_TYPE', location, `Expected ${[].concat(rule.type).join(' or ')}.`);
    return;
  }
  if (Object.hasOwn(rule, 'const') && value !== rule.const) error('SCHEMA_CONST', location, `Expected ${JSON.stringify(rule.const)}.`);
  if (rule.enum && !rule.enum.includes(value)) error('SCHEMA_ENUM', location, 'Value is outside the approved vocabulary.');
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum) error('SCHEMA_MINIMUM', location, `Must be >= ${rule.minimum}.`);
    if (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) error('SCHEMA_MINIMUM', location, `Must be > ${rule.exclusiveMinimum}.`);
  }
  if (typeof value === 'string' && rule.pattern && !new RegExp(rule.pattern).test(value)) error('SCHEMA_TEXT', location, 'Must contain non-whitespace text.');
  if (object(value)) {
    for (const key of rule.required || []) {
      if (!Object.hasOwn(value, key)) error('SCHEMA_REQUIRED', `${location}/${key}`, 'Required field is missing.');
    }
    for (const key of Object.keys(value)) {
      const childPath = `${location}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (Object.hasOwn(rule.properties || {}, key)) checkSchema(value[key], rule.properties[key], childPath, error);
      else if (rule.additionalProperties === false) error('SCHEMA_PROPERTY', childPath, 'Field is not part of this contract version.');
    }
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) error('SCHEMA_MIN_ITEMS', location, `Requires at least ${rule.minItems} item(s).`);
    if (rule.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) error('SCHEMA_UNIQUE', location, 'Items must be unique.');
    if (rule.items) value.forEach((item, i) => checkSchema(item, rule.items, `${location}/${i}`, error));
  }
}

// Measure the union, missing regions, and multiply-covered regions of clipped
// half-open intervals. Words use [startIndex, endIndex + 1), seconds [start,end).
// Duplicate coverage never inflates the percentage. Touching regions are merged.
function coverage(intervals, start, end, epsilon = 0) {
  if (!finite(start) || !finite(end) || end <= start) return { covered: 0, gaps: 0, overlaps: 0 };
  const events = new Map([[start, 0], [end, 0]]);
  for (const [a, b] of intervals) {
    const lo = Math.max(start, a), hi = Math.min(end, b);
    if (!finite(lo) || !finite(hi) || hi <= lo) continue;
    events.set(lo, (events.get(lo) || 0) + 1);
    events.set(hi, (events.get(hi) || 0) - 1);
  }
  let previous = start, count = 0, covered = 0;
  const regions = [];
  for (const [position, change] of [...events].sort((a, b) => a[0] - b[0])) {
    if (position > previous) {
      const kind = count === 0 ? 'gap' : count > 1 ? 'overlap' : 'single';
      if (count > 0) covered += position - previous;
      const last = regions[regions.length - 1];
      if (last?.kind === kind) last.length += position - previous;
      else regions.push({ kind, length: position - previous });
    }
    count += change;
    previous = position;
  }
  return {
    covered,
    gaps: regions.filter(r => r.kind === 'gap' && r.length > epsilon).length,
    overlaps: regions.filter(r => r.kind === 'overlap' && r.length > epsilon).length,
  };
}

/**
 * Validate without mutating inputs or generating/transcribing anything.
 * wordTimestamps is the unchanged legacy array, in per-act transcription order.
 * Boundary policy is documented in edit-plan.schema.json; no guessed timings
 * are accepted. Audio duration is caller-supplied metadata, not verified here.
 * Counts of gaps/overlaps represent contiguous regions per act (including edges).
 * Coverage is unique covered words/seconds, not proof of a valid plan: inspect status.
 * Optional output writes only edit-plan-validation.json. Filesystem failures throw.
 */
function validateEditPlan({ plan, wordTimestamps, outputDir } = {}) {
  const errors = [], warnings = [];
  const error = (code, location, message) => errors.push({ code, path: location, message });
  const warn = (code, location, message) => warnings.push({ code, path: location, message });
  checkSchema(plan, schema, '', error);
  const timing = object(plan?.timing) ? plan.timing : {};
  const acts = array(timing.acts);
  const sequences = array(plan?.sequences);
  const metrics = {
    totalDurationSec: finite(timing.totalDurationSec) ? timing.totalDurationSec : 0,
    totalSequences: sequences.length, totalBeats: 0,
    averageBeatDurationSec: 0, longestBeatDurationSec: 0, longestNormalBeatDurationSec: 0,
    timingExceptionCount: 0, intentionalStillnessCount: 0,
    plannedEditorialHoldSec: 0, projectedCompiledDurationSec: finite(timing.totalDurationSec) ? timing.totalDurationSec : 0,
    averageSequenceDurationSec: 0, shortSequenceCount: 0, evidenceFunctionWithoutSourceCount: 0, missingStoryActionCount: 0,
    narrationCoveragePercent: 0, timelineCoveragePercent: 0,
    narrationGapCount: 0, narrationOverlapCount: 0, timelineGapCount: 0, timelineOverlapCount: 0,
    missingStoryFunctionCount: 0, missingNarrationExcerptCount: 0, unresolvedVisualIntentCount: 0,
    visualClassCounts: Object.fromEntries(schema.$defs.beat.properties.visualClass.enum.map(k => [k, 0])),
    storyFunctionCounts: Object.fromEntries(schema.$defs.beat.properties.storyFunction.enum.map(k => [k, 0])),
  };
  const durationCheck = (value, location) => {
    if (!span(value)) error('INVALID_TIME_RANGE', location, 'End must be later than start; both must be finite.');
    else if (!finite(value.durationSec) || !near(value.durationSec, value.endSec - value.startSec)) error('DURATION_MISMATCH', `${location}/durationSec`, 'Duration must equal endSec - startSec within 0.001 seconds.');
  };
  const wordsByVo = new Map();
  if (!Array.isArray(wordTimestamps) || wordTimestamps.length === 0) error('INVALID_WORD_TIMESTAMPS', '/wordTimestamps', 'A nonempty legacy word-timestamp array is required.');
  array(wordTimestamps).forEach((w, i) => {
    if (!object(w) || !text(w.vo_file)) {
      error('INVALID_WORD_TIMESTAMP', `/wordTimestamps/${i}`, 'Word must identify its vo_file.');
      return;
    }
    if (!wordsByVo.has(w.vo_file)) wordsByVo.set(w.vo_file, []);
    const words = wordsByVo.get(w.vo_file);
    const prev = words[words.length - 1];
    // Empty normalized word strings are possible in the legacy format; retain
    // their indices. Do not silently sort or discard any timestamp records.
    if (typeof w.word !== 'string' || !finite(w.start_seconds) || !finite(w.end_seconds) || w.start_seconds < 0 || w.end_seconds < w.start_seconds) {
      error('INVALID_WORD_TIMESTAMP', `/wordTimestamps/${i}`, 'Invalid legacy word text or timing.');
    } else if (prev && w.start_seconds < prev.end_seconds - EPSILON) {
      error('WORD_TIMESTAMP_ORDER', `/wordTimestamps/${i}`, 'Words must be chronological and non-overlapping within an act.');
    }
    words.push(w);
  });

  const actMap = new Map(), voKeys = new Set();
  let previousActEnd = 0;
  acts.forEach((act, i) => {
    const location = `/timing/acts/${i}`;
    if (!object(act)) return;
    durationCheck(act, location);
    if (actMap.has(act.actKey)) error('DUPLICATE_ACT', location, 'actKey must be unique.');
    else actMap.set(act.actKey, { act, index: i, beats: [] });
    if (voKeys.has(act.voKey)) error('DUPLICATE_VO_KEY', location, 'voKey must be unique.');
    voKeys.add(act.voKey);
    if (!Object.hasOwn(ACT_VO, act.actKey) || ACT_VO[act.actKey] !== act.voKey) error('ACT_VO_MISMATCH', location, 'actKey and voKey must identify the same act.');
    if (finite(act.startSec) && !near(act.startSec, previousActEnd)) error('ACT_TIMELINE_BOUNDARY', location, 'Ordered acts must meet, starting at episode second zero.');
    if (finite(act.endSec)) previousActEnd = act.endSec;
    const words = wordsByVo.get(act.voKey) || [];
    if (act.wordCount !== words.length || words.length === 0) error('WORD_COUNT_MISMATCH', `${location}/wordCount`, 'wordCount must match the nonempty timed-word list.');
    words.forEach((w, j) => {
      if (finite(w.end_seconds) && finite(act.durationSec) && w.end_seconds > act.durationSec + EPSILON) error('WORD_OUTSIDE_ACT', `${location}/wordCount`, `Word ${j} extends beyond the act duration.`);
    });
  });
  if (!near(previousActEnd, timing.totalDurationSec)) error('TOTAL_DURATION_MISMATCH', '/timing/totalDurationSec', 'Total duration must equal the final act end.');
  for (const voKey of wordsByVo.keys()) {
    if (!voKeys.has(voKey)) error('UNMAPPED_VO', '/timing/acts', `Timed narration ${voKey} has no act timing record.`);
  }

  const sequenceIds = new Set(), beatIds = new Set();
  let previousActIndex = -1, durationSum = 0, durationCount = 0;
  sequences.forEach((sequence, si) => {
    const location = `/sequences/${si}`;
    if (!object(sequence)) return;
    if (sequenceIds.has(sequence.sequenceId)) error('DUPLICATE_SEQUENCE_ID', location, 'sequenceId must be unique.');
    sequenceIds.add(sequence.sequenceId);
    const entry = actMap.get(sequence.actKey);
    if (!entry) error('UNKNOWN_ACT', location, 'Sequence references an act not present in timing.');
    else {
      if (entry.index < previousActIndex) error('SEQUENCE_ORDER', location, 'Sequences must follow act playback order.');
      previousActIndex = entry.index;
    }
    array(sequence.beats).forEach((beat, bi) => {
      const bp = `${location}/beats/${bi}`;
      metrics.totalBeats++;
      if (!object(beat)) return;
      if (beatIds.has(beat.beatId)) error('DUPLICATE_BEAT_ID', bp, 'beatId must be unique across the episode.');
      beatIds.add(beat.beatId);
      if (!actMap.has(beat.actKey)) error('UNKNOWN_ACT', bp, 'Beat references an unknown act.');
      if (beat.sequenceId !== sequence.sequenceId || beat.actKey !== sequence.actKey) error('BEAT_ASSIGNMENT', bp, 'Beat must reference its containing sequence and act.');
      durationCheck(beat, bp);
      if (!text(beat.narrationExcerpt)) { metrics.missingNarrationExcerptCount++; error('MISSING_NARRATION_EXCERPT', bp, 'Narration excerpt is required.'); }
      if (!text(beat.visualIntent)) { metrics.unresolvedVisualIntentCount++; error('MISSING_VISUAL_INTENT', bp, 'Visual intent is required.'); }
      if (!text(beat.storyFunction)) { metrics.missingStoryFunctionCount++; error('MISSING_STORY_FUNCTION', bp, 'Story function is required.'); }
      if (object(beat.visual) && object(beat.motionIntent) && text(beat.visual.motionType) && text(beat.motionIntent.type) && beat.visual.motionType !== beat.motionIntent.type) {
        error('VISUAL_MOTION_MISMATCH', bp, 'visual.motionType and motionIntent.type must match.');
      }
      if (Object.hasOwn(metrics.visualClassCounts, beat.visualClass)) metrics.visualClassCounts[beat.visualClass]++;
      if (Object.hasOwn(metrics.storyFunctionCounts, beat.storyFunction)) metrics.storyFunctionCounts[beat.storyFunction]++;
      const justified = text(beat.timingExceptionReason);
      const hold = finite(beat.postNarrationHoldSec) ? beat.postNarrationHoldSec : 0;
      metrics.plannedEditorialHoldSec += hold;
      if (hold > 3) warn('LONG_EDITORIAL_HOLD', bp, 'Editorial hold is unusually long.');
      if (beat.intentionalStillness === true) {
        metrics.intentionalStillnessCount++;
        if (beat.visual?.motionType !== 'static_locked') error('STILLNESS_MOTION_REQUIRED', bp, 'Intentional stillness requires static_locked motion.');
      }
      if (span(beat)) {
        const duration = beat.endSec - beat.startSec;
        durationSum += duration; durationCount++;
        metrics.longestBeatDurationSec = Math.max(metrics.longestBeatDurationSec, duration);
        const actualException = duration < 3.5 - EPSILON || duration > 5.5 + EPSILON || hold > EPSILON || beat.intentionalStillness === true;
        if (actualException && justified) metrics.timingExceptionCount++;
        if (duration > 6 + EPSILON) {
          if (!justified) error('BEAT_TOO_LONG', bp, 'A beat above 6 seconds needs an explicit timingExceptionReason.');
          else warn('TIMING_EXCEPTION', bp, 'Justified beat exceeds the normal 6-second maximum.');
        } else {
          metrics.longestNormalBeatDurationSec = Math.max(metrics.longestNormalBeatDurationSec, duration);
          if (duration < 2 - EPSILON) {
            if (!justified) error('BEAT_TOO_SHORT', bp, 'A beat below 2 seconds needs an explicit timingExceptionReason.');
          } else if ((duration < 3.5 - EPSILON || duration > 5.5 + EPSILON) && !justified) warn('TARGET_DURATION', bp, 'Beat is outside the normal 3.5–5.5 second target.');
        }
      }
      if (beat.storyFunction === 'evidence' && beat.visualClass !== 'EVIDENCE') metrics.evidenceFunctionWithoutSourceCount++, warn('EVIDENCE_FUNCTION_WITHOUT_SOURCE', bp, 'Evidence story function is not using an EVIDENCE visual class.');
      if (beat.visualClass === 'RECONSTRUCTION' && !['literal_supported', 'representative', 'atmospheric'].includes(beat.reconstructionMode)) error('RECONSTRUCTION_MODE_REQUIRED', bp, 'RECONSTRUCTION requires a supported reconstructionMode.');
      if (beat.visualClass !== 'RECONSTRUCTION' && beat.reconstructionMode !== null && beat.reconstructionMode !== undefined) error('RECONSTRUCTION_MODE_FORBIDDEN', bp, 'Only RECONSTRUCTION beats may set reconstructionMode.');
      const hasStoryAction = text(beat.visual?.secondaryAction) || text(beat.motionIntent?.secondaryAction) || (Array.isArray(beat.graphics) && beat.graphics.length > 0);
      if (beat.visualClass === 'RECONSTRUCTION' && beat.visual?.type === 'CLIP' && beat.reconstructionMode !== 'atmospheric' && beat.intentionalStillness !== true && !hasStoryAction) metrics.missingStoryActionCount++, warn('MISSING_STORY_ACTION', bp, 'Reconstruction should describe meaningful story action.');
      if (justified && !((span(beat) && ((beat.endSec - beat.startSec) < 3.5 - EPSILON || (beat.endSec - beat.startSec) > 5.5 + EPSILON)) || hold > EPSILON || beat.intentionalStillness === true)) warn('UNNECESSARY_TIMING_EXCEPTION', bp, 'Timing exception reason is not attached to an actual exception.');
      const evidence = beat.evidenceRequirement;
      if (beat.visualClass === 'EVIDENCE' && (!object(evidence) || evidence.required !== true || !text(evidence.evidenceType) || !text(evidence.description) || ['sourceStatus', 'rightsStatus', 'authenticityStatus'].some(k => !text(evidence[k]) || evidence[k] === 'not_applicable'))) {
        error('EVIDENCE_REQUIREMENT', bp, 'EVIDENCE needs a required source, meaningful subtype/description and applicable source, rights and authenticity statuses.');
      }
      if (entry && beat.actKey === sequence.actKey && beat.sequenceId === sequence.sequenceId) entry.beats.push({ beat, path: bp });
    });
    const sequenceDuration = array(sequence.beats).reduce((sum, beat) => sum + (finite(beat?.durationSec) ? beat.durationSec : 0), 0);
    const exemptThin = ['orientation', 'payoff', 'emotional_hold'].includes(sequence.beats?.[0]?.storyFunction)
      || sequence.beats?.some(beat => beat?.intentionalStillness === true || beat?.rhythmIntent === 'impact');
    if (!exemptThin && (sequence.beats?.length === 1 || sequenceDuration < 3.5 - EPSILON)) metrics.shortSequenceCount++, warn('SEQUENCE_TOO_THIN', location, 'Sequence is unusually short or structurally thin.');
    metrics._sequenceDurationSum = (metrics._sequenceDurationSum || 0) + sequenceDuration;
  });

  let coveredWords = 0;
  const episodeIntervals = [];
  for (const { act, index, beats } of actMap.values()) {
    const location = `/timing/acts/${index}`;
    const words = wordsByVo.get(act.voKey) || [];
    const wordIntervals = [], timeIntervals = [];
    let priorWord = -1, priorStart = -Infinity;
    for (const { beat, path: bp } of beats) {
      const { startWordIndex: first, endWordIndex: last } = beat;
      const validRange = Number.isSafeInteger(first) && Number.isSafeInteger(last) && first >= 0 && last >= first && last < words.length;
      if (!validRange) error('INVALID_WORD_RANGE', bp, 'Inclusive act-local word indices must be ordered and within the timed-word list.');
      else {
        wordIntervals.push([first, last + 1]);
        if (first <= priorWord) error('WORD_RANGE_ORDER', bp, 'Word ranges must follow playback order without overlap.');
        priorWord = last;
        const expectedStart = first === 0 ? act.startSec : act.startSec + words[first].start_seconds;
        const expectedEnd = last === words.length - 1 ? act.endSec : act.startSec + words[last + 1].start_seconds;
        if (!near(beat.startSec, expectedStart) || !near(beat.endSec, expectedEnd)) error('WORD_TIME_MISMATCH', bp, 'Beat seconds do not match the deterministic word-boundary policy.');
        if (text(beat.narrationExcerpt)) {
          const selectedTokens = words.slice(first, last + 1).flatMap(word => normalizeTokens(word.word));
          const excerptTokens = normalizeTokens(beat.narrationExcerpt);
          if (selectedTokens.length !== excerptTokens.length || selectedTokens.some((token, i) => token !== excerptTokens[i])) {
            error('NARRATION_EXCERPT_MISMATCH', bp, 'Narration excerpt must match the selected timed-word sequence after normalization.');
          }
        }
      }
      if (span(beat)) {
        if (beat.startSec < priorStart) error('BEAT_TIME_ORDER', bp, 'Beat times must follow playback order.');
        priorStart = beat.startSec;
        if (beat.startSec < act.startSec - EPSILON || beat.endSec > act.endSec + EPSILON) error('BEAT_OUTSIDE_ACT', bp, 'Beat extends outside its act timing.');
        timeIntervals.push([beat.startSec, beat.endSec]);
        if (span(act)) episodeIntervals.push([Math.max(act.startSec, beat.startSec), Math.min(act.endSec, beat.endSec)]);
      }
    }
    const wc = coverage(wordIntervals, 0, words.length);
    coveredWords += wc.covered;
    metrics.narrationGapCount += wc.gaps;
    metrics.narrationOverlapCount += wc.overlaps;
    if (wc.gaps) error('NARRATION_GAP', location, `${wc.gaps} uncovered narration range(s), including any missing first/final word.`);
    if (wc.overlaps) error('NARRATION_OVERLAP', location, `${wc.overlaps} duplicated narration range(s).`);
    const tc = coverage(timeIntervals, act.startSec, act.endSec, EPSILON);
    metrics.timelineGapCount += tc.gaps;
    metrics.timelineOverlapCount += tc.overlaps;
    if (tc.gaps) error('TIMELINE_GAP', location, `${tc.gaps} uncovered time range(s), including act edges and silence.`);
    if (tc.overlaps) error('TIMELINE_OVERLAP', location, `${tc.overlaps} overlapping time range(s).`);
  }
  const actCoverage = coverage(acts.filter(span).map(a => [a.startSec, a.endSec]), 0, timing.totalDurationSec, EPSILON);
  metrics.timelineGapCount += actCoverage.gaps;
  metrics.timelineOverlapCount += actCoverage.overlaps;
  const totalWords = array(wordTimestamps).length;
  metrics.narrationCoveragePercent = totalWords ? Math.min(100, coveredWords / totalWords * 100) : 0;
  const episodeCoverage = coverage(episodeIntervals, 0, timing.totalDurationSec, EPSILON);
  metrics.timelineCoveragePercent = timing.totalDurationSec > 0 && finite(timing.totalDurationSec) ? Math.min(100, episodeCoverage.covered / timing.totalDurationSec * 100) : 0;
  metrics.averageBeatDurationSec = durationCount ? durationSum / durationCount : 0;
  metrics.averageSequenceDurationSec = sequences.length ? (metrics._sequenceDurationSum || 0) / sequences.length : 0;
  delete metrics._sequenceDurationSum;
  metrics.projectedCompiledDurationSec = metrics.totalDurationSec + metrics.plannedEditorialHoldSec;
  const report = { status: errors.length ? 'FAIL' : 'PASS', errors, warnings, metrics };
  if (outputDir !== undefined) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'edit-plan-validation.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return report;
}

module.exports = { validateEditPlan };
