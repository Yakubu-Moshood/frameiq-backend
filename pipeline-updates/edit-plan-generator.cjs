'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateEditPlan } = require('./edit-plan-validator.cjs');

const MODEL = 'claude-opus-4-5';
const MAX_TOKENS = 16000;
const TIMING_EPSILON = 0.001;
const CHECKPOINT_VERSION = 1;
const CHECKPOINT_FILE = 'edit-plan-drafts.partial.json';
const ACTS = [
  ['act1', 'VO_Act1'],
  ['act2', 'VO_Act2'],
  ['act3', 'VO_Act3'],
  ['act3b', 'VO_Act3B'],
  ['act4', 'VO_Act4'],
  ['act5', 'VO_Act5'],
];
const CREATIVE_DNA_FIELDS = [
  'label', 'description', 'brand_voice', 'primary_colour', 'secondary_colour',
  'background_colour', 'font_display', 'font_body', 'blueprint_label',
  'narration_style', 'script_pacing', 'research_depth', 'target_length_minutes',
];

const DIRECTOR_STANDARD = `You are the AI Director for Empire Omitted V3. Direct an investigative documentary; do not merely illustrate nouns.

Plan connected sequences in which every beat has a clear story function and changes what the audience knows or feels. Ask why the visual exists, what changes for the audience, what they know before and after it, whether evidence, reconstruction, or editorial illustration is strongest, whether human action is stronger than an empty symbolic object, and how the beat advances cause → mechanism → consequence.

Use only these story functions: establish, reveal, evidence, human_cost, cause, consequence, contrast, escalation, orientation, emotional_hold, transition, payoff, context.
Prioritise visual truth: real evidence, real archival material, editorial graphics, reconstruction, then abstract editorial illustration. Source retrieval is not available. When real material should be used, choose EVIDENCE and describe the requirement without inventing a source, URL, filing, quotation, photograph, or provenance. Use sourceStatus pending, rightsStatus unknown, authenticityStatus pending_review, and humanReviewRequired true unless supplied context establishes more.

Prefer connected human behaviour and mechanisms: an employee studies a target, a hand passes a document, a badge is placed on a desk, a customer waits, forms accumulate, a printer produces records, a manager watches a dashboard, an employee removes a personal item, elevator doors close, testimony begins, or a document clause is isolated. Avoid habitual filler such as empty boardrooms, calculators, money piles, scales, envelopes, closed doors, generic résumés, trash bins, and empty offices unless editorially motivated. Never present a fabricated synthetic document as authentic evidence.

Normal beats target 3.5–5.5 seconds and normally must not exceed about 6 seconds. Cover every indexed narration word exactly once, in order, with no gaps, repetitions, or overlaps. A longer beat is allowed only for a deliberate evidence read, emotional hold, significant silence, or major reveal and needs timingExceptionReason. Group multiple beats into sequences that express an editorial idea and audience transformation.

Keep people central: who benefits, knows, obeys, resists, and pays the price. Guide visual evolution by act: act1 polished and controlled; act2 warmer, confident, organised expansion; act3 colder, tighter, darker pressure and deception; act3b desaturated, intimate and restrained; act4 evidence-heavy exposure and urgency; act5 cleaner, distant, unresolved and reflective.

Preserve geometry: no morphing, warping, uncontrolled orbit, or unnecessary autonomous movement. Use one approved primary motion and, where useful, one meaningful secondary story action. Approved motion types: dolly_forward, dolly_back, lateral_track, crane_rise, crane_descend, tilt_reveal, rack_focus, foreground_parallax, controlled_handheld, static_locked, subject_micro_action, environmental_motion, document_reveal, object_action, silhouette_movement.

Use graphics selectively and only as: identity_lower_third, source_citation, impact_card, date_marker, data_graphic, direct_quote, document_callout, chapter_marker, takeaway. Reserve impact typography for major facts. Audio direction is creative intent only; it may express music, SFX, room tone, or meaningful silence, but never timeline automation.`;

function canonicalChannel(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[\s_-]/g, '') : '';
}

function assertEmpireOmitted(channelDna, channel) {
  const identifiers = [channel, channelDna?.id, channelDna?.label]
    .filter(value => typeof value === 'string' && value.trim());
  if (identifiers.length === 0 || identifiers.some(value => canonicalChannel(value) !== 'empireomitted')) {
    throw new Error('[edit-plan] Empire Omitted V3 generator cannot be used for another channel.');
  }
}

function creativeDna(channelDna) {
  const safe = {};
  for (const key of CREATIVE_DNA_FIELDS) {
    const value = channelDna?.[key];
    if (['string', 'number', 'boolean'].includes(typeof value) && value !== '') safe[key] = value;
  }
  return safe;
}

function groupWords(wordTimestamps) {
  const grouped = new Map(ACTS.map(([, voKey]) => [voKey, []]));
  if (!Array.isArray(wordTimestamps)) throw new Error('[edit-plan] wordTimestamps must be an array.');
  for (const word of wordTimestamps) {
    if (grouped.has(word?.vo_file)) grouped.get(word.vo_file).push(word);
  }
  return grouped;
}

function buildTiming(actDurationsSec, wordsByVo) {
  const acts = [];
  let cursor = 0;
  for (const [actKey, voKey] of ACTS) {
    const durationSec = actDurationsSec?.[actKey];
    const words = wordsByVo.get(voKey) || [];
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error(`[edit-plan] ${actKey} duration must be a positive finite number.`);
    }
    if (words.length === 0) throw new Error(`[edit-plan] ${actKey} has no timed words.`);
    const finalWordEnd = words[words.length - 1]?.end_seconds;
    if (!Number.isFinite(finalWordEnd) || durationSec < finalWordEnd) {
      throw new Error(`[edit-plan] ${actKey} duration must reach its final timed word.`);
    }
    const endSec = cursor + durationSec;
    acts.push({ actKey, voKey, startSec: cursor, endSec, durationSec, wordCount: words.length });
    cursor = endSec;
  }
  return { basis: 'finished_vo_word_timestamps', totalDurationSec: cursor, acts };
}

function timingMatchesCurrent(existingTiming, currentTiming) {
  if (!existingTiming || existingTiming.basis !== currentTiming.basis) return false;
  if (!Number.isFinite(existingTiming.totalDurationSec)
    || Math.abs(existingTiming.totalDurationSec - currentTiming.totalDurationSec) > TIMING_EPSILON) return false;
  if (!Array.isArray(existingTiming.acts) || existingTiming.acts.length !== currentTiming.acts.length) return false;
  return currentTiming.acts.every((current, index) => {
    const existing = existingTiming.acts[index];
    return existing
      && existing.actKey === current.actKey
      && existing.voKey === current.voKey
      && existing.wordCount === current.wordCount
      && Number.isFinite(existing.startSec)
      && Number.isFinite(existing.endSec)
      && Number.isFinite(existing.durationSec)
      && Math.abs(existing.startSec - current.startSec) <= TIMING_EPSILON
      && Math.abs(existing.endSec - current.endSec) <= TIMING_EPSILON
      && Math.abs(existing.durationSec - current.durationSec) <= TIMING_EPSILON;
  });
}

function stripJsonFences(raw) {
  return raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function requestFingerprint(prompt) {
  return crypto.createHash('sha256').update(JSON.stringify({
    model: MODEL,
    maxTokens: MAX_TOKENS,
    system: DIRECTOR_STANDARD,
    prompt,
  })).digest('hex');
}

function draftFingerprint(draft) {
  return crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
}

function freshCheckpoint(episodeId) {
  return { checkpointVersion: CHECKPOINT_VERSION, episodeId, channel: 'EmpireOmitted', acts: {} };
}

function loadCheckpoint(checkpointPath, episodeId) {
  if (!checkpointPath || !fs.existsSync(checkpointPath)) return freshCheckpoint(episodeId);
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (parsed?.checkpointVersion === CHECKPOINT_VERSION
      && parsed.episodeId === episodeId
      && parsed.channel === 'EmpireOmitted'
      && parsed.acts && typeof parsed.acts === 'object' && !Array.isArray(parsed.acts)) return parsed;
  } catch (error) {
    console.warn(`[edit-plan] Ignoring unreadable draft checkpoint: ${error.message}`);
  }
  return freshCheckpoint(episodeId);
}

function writeCheckpointAtomic(checkpointPath, checkpoint) {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const temporaryPath = `${checkpointPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(checkpoint, null, 2) + '\n', 'utf8');
    fs.renameSync(temporaryPath, checkpointPath);
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
  }
}

function parseModelJson(message, actKey) {
  const raw = Array.isArray(message?.content)
    ? message.content.filter(block => block?.type === 'text').map(block => block.text || '').join('')
    : '';
  try {
    return JSON.parse(stripJsonFences(raw));
  } catch (error) {
    throw new Error(`[edit-plan] ${actKey} model JSON parse failed: ${error.message}`);
  }
}

function actScript(script, actKey) {
  const act = script?.acts?.[actKey];
  if (!act || typeof act.voScript !== 'string' || !act.voScript.trim()) {
    throw new Error(`[edit-plan] Script is missing narration for ${actKey}.`);
  }
  return act;
}

function buildActPrompt({ script, actKey, words, durationSec, channelDna, previousContext }) {
  const act = actScript(script, actKey);
  const indexedWords = words.map((word, index) => ({
    index,
    word: word.word,
    start_seconds: word.start_seconds,
    end_seconds: word.end_seconds,
  }));
  return [
    `Plan only ${actKey} of this Empire Omitted documentary.`,
    `Episode title: ${script.title || script.topic || 'Untitled'}`,
    `Act label: ${act.label || actKey}`,
    `Finished act duration: ${durationSec} seconds`,
    `Narration:\n${act.voScript}`,
    `Indexed act-local timed words:\n${JSON.stringify(indexedWords)}`,
    `Safe creative Channel DNA:\n${JSON.stringify(creativeDna(channelDna))}`,
    previousContext ? `Previous-act continuity context:\n${previousContext}` : '',
    `Return JSON only in this exact draft shape:
{"sequences":[{"sequencePurpose":"...","directorIntent":"...","emotionalStateStart":"...","emotionalStateEnd":"...","knowledgeQuestion":null,"knowledgeAnswer":null,"createsQuestion":null,"motifRefs":[],"continuityRefs":[],"beats":[{"startWordIndex":0,"endWordIndex":1,"storyFunction":"establish","visualIntent":"...","visualClass":"RECONSTRUCTION","visual":{"type":"CLIP","description":"...","motionType":"lateral_track","secondaryAction":null},"rhythmIntent":"measured","intentionalStillness":false,"timingExceptionReason":null,"motionIntent":{"type":"lateral_track","secondaryAction":"..."},"graphics":null,"audioDirection":{"musicCue":null,"musicEvent":null,"musicLevelDb":null,"duckUnderVO":null,"sfx":[],"silenceIntent":null},"evidenceRequirement":{"required":false,"evidenceType":null,"description":null,"sourceStatus":"not_applicable","rightsStatus":"not_applicable","authenticityStatus":"not_applicable","citationLabel":null,"humanReviewRequired":false},"continuityRefs":[]}]}]}`,
    'Do not output startSec, endSec, durationSec, narrationExcerpt, beatId, sequenceId, actKey, tracks, filenames, FFmpeg, or DaVinci instructions. Cover every word index exactly once in playback order.',
  ].filter(Boolean).join('\n\n');
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) if (Object.hasOwn(source || {}, key)) result[key] = source[key];
  return result;
}

function projectBeatIntent(draft) {
  const intent = pick(draft, [
    'storyFunction', 'visualIntent', 'visualClass', 'rhythmIntent',
    'intentionalStillness', 'timingExceptionReason', 'continuityRefs',
  ]);
  if (Object.hasOwn(draft || {}, 'visual')) {
    intent.visual = pick(draft.visual, ['type', 'description', 'motionType', 'secondaryAction']);
  }
  if (Object.hasOwn(draft || {}, 'motionIntent')) {
    intent.motionIntent = pick(draft.motionIntent, ['type', 'secondaryAction']);
  }
  if (draft?.graphics === null) intent.graphics = null;
  else if (Array.isArray(draft?.graphics)) {
    intent.graphics = draft.graphics.map(graphic => pick(graphic, ['type', 'intent', 'text']));
  }
  if (draft?.audioDirection === null) intent.audioDirection = null;
  else if (Object.hasOwn(draft || {}, 'audioDirection')) {
    intent.audioDirection = pick(draft.audioDirection, [
      'musicCue', 'musicEvent', 'musicLevelDb', 'duckUnderVO', 'sfx', 'silenceIntent',
    ]);
  }
  if (Object.hasOwn(draft || {}, 'evidenceRequirement')) {
    intent.evidenceRequirement = pick(draft.evidenceRequirement, [
      'required', 'evidenceType', 'description', 'sourceStatus', 'rightsStatus',
      'authenticityStatus', 'citationLabel', 'humanReviewRequired',
    ]);
  }
  return intent;
}

function finaliseBeat({ draft, act, words, sequenceId, beatNumber }) {
  const first = draft?.startWordIndex;
  const last = draft?.endWordIndex;
  const validRange = Number.isSafeInteger(first) && Number.isSafeInteger(last)
    && first >= 0 && last >= first && last < words.length;
  const startSec = validRange
    ? (first === 0 ? act.startSec : act.startSec + words[first].start_seconds)
    : Number.NaN;
  const endSec = validRange
    ? (last === words.length - 1 ? act.endSec : act.startSec + words[last + 1].start_seconds)
    : Number.NaN;
  const beat = {
    beatId: `${act.actKey.toUpperCase()}_B${String(beatNumber).padStart(3, '0')}`,
    sequenceId,
    actKey: act.actKey,
    startWordIndex: first,
    endWordIndex: last,
    startSec,
    endSec,
    durationSec: endSec - startSec,
    narrationExcerpt: validRange ? words.slice(first, last + 1).map(word => word.word).join(' ') : '',
    ...projectBeatIntent(draft),
  };
  return beat;
}

function finaliseActDraft({ draft, act, words }) {
  const sequences = Array.isArray(draft?.sequences) ? draft.sequences : [];
  let beatNumber = 0;
  return sequences.map((sequence, sequenceIndex) => {
    const sequenceId = `SEQ_${act.actKey.toUpperCase()}_${String(sequenceIndex + 1).padStart(2, '0')}`;
    const final = {
      sequenceId,
      actKey: act.actKey,
      ...pick(sequence, [
        'sequencePurpose', 'directorIntent', 'emotionalStateStart', 'emotionalStateEnd',
        'knowledgeQuestion', 'knowledgeAnswer', 'createsQuestion', 'motifRefs', 'continuityRefs',
      ]),
      beats: [],
    };
    final.beats = (Array.isArray(sequence?.beats) ? sequence.beats : []).map(beat => {
      beatNumber++;
      return finaliseBeat({ draft: beat, act, words, sequenceId, beatNumber });
    });
    return final;
  });
}

function continuitySummary(actKey, draft) {
  const purposes = (Array.isArray(draft?.sequences) ? draft.sequences : [])
    .map(sequence => sequence?.sequencePurpose)
    .filter(value => typeof value === 'string' && value.trim());
  return `${actKey}: ${purposes.join(' | ')}`;
}

async function generateEditPlan({
  script,
  wordTimestamps,
  actDurationsSec,
  channelDna,
  episodeId,
  outputDir,
  client,
  channel,
} = {}) {
  assertEmpireOmitted(channelDna, channel);
  if (!script || typeof script !== 'object') throw new Error('[edit-plan] script is required.');
  if (typeof episodeId !== 'string' || !episodeId.trim()) throw new Error('[edit-plan] episodeId is required.');
  const wordsByVo = groupWords(wordTimestamps);
  const timing = buildTiming(actDurationsSec, wordsByVo);

  const existingPath = outputDir ? path.join(outputDir, 'edit-plan.json') : null;
  if (existingPath && fs.existsSync(existingPath)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(existingPath, 'utf8')); }
    catch (error) { throw new Error(`[edit-plan] Existing edit-plan.json is unreadable: ${error.message}`); }
    const validation = validateEditPlan({ plan: existing, wordTimestamps });
    const identityMatches = existing.episodeId === episodeId.trim();
    const timingMatches = timingMatchesCurrent(existing.timing, timing);
    if (validation.status === 'PASS' && identityMatches && timingMatches) return existing;
    throw new Error('[edit-plan] Existing edit-plan.json is stale: it does not match the current finished VO timing or episode identity; refusing to overwrite it.');
  }

  const checkpointPath = outputDir ? path.join(outputDir, CHECKPOINT_FILE) : null;
  const checkpoint = loadCheckpoint(checkpointPath, episodeId.trim());
  let anthropic = client;
  const getClient = () => {
    if (!anthropic) anthropic = new (require('@anthropic-ai/sdk'))();
    if (!anthropic?.messages || typeof anthropic.messages.create !== 'function') {
      throw new Error('[edit-plan] Anthropic client must provide messages.create().');
    }
    return anthropic;
  };
  const finalSequences = [];
  const priorContext = [];
  for (const [actKey, voKey] of ACTS) {
    const act = timing.acts.find(item => item.actKey === actKey);
    const words = wordsByVo.get(voKey);
    const prompt = buildActPrompt({
      script,
      actKey,
      words,
      durationSec: act.durationSec,
      channelDna,
      previousContext: priorContext.slice(-2).join('\n'),
    });
    const fingerprint = requestFingerprint(prompt);
    const saved = checkpoint.acts[actKey];
    let draft;
    const reusableDraft = saved?.fingerprint === fingerprint
      && saved.draft
      && typeof saved.draft === 'object'
      && !Array.isArray(saved.draft)
      && typeof saved.draftHash === 'string'
      && /^[a-f0-9]{64}$/.test(saved.draftHash)
      && draftFingerprint(saved.draft) === saved.draftHash;
    if (reusableDraft) {
      draft = saved.draft;
    } else {
      const message = await getClient().messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: DIRECTOR_STANDARD,
        messages: [{ role: 'user', content: prompt }],
      });
      draft = parseModelJson(message, actKey);
      if (checkpointPath) {
        checkpoint.acts[actKey] = { fingerprint, draftHash: draftFingerprint(draft), draft };
        writeCheckpointAtomic(checkpointPath, checkpoint);
      }
    }
    finalSequences.push(...finaliseActDraft({ draft, act, words }));
    priorContext.push(continuitySummary(actKey, draft));
  }

  const plan = {
    schemaVersion: '3.0.0',
    pipelineVersion: 3,
    channel: 'EmpireOmitted',
    episodeId: episodeId.trim(),
    title: String(script.title || script.topic || '').trim(),
    timing,
    sequences: finalSequences,
  };
  const validation = validateEditPlan({ plan, wordTimestamps, outputDir });
  if (validation.status !== 'PASS') {
    throw new Error(`[edit-plan] Generated plan failed validation (${validation.errors.length} error(s)): ${validation.errors.map(item => item.code).join(', ')}`);
  }
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'edit-plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
    fs.rmSync(checkpointPath, { force: true });
  }
  return plan;
}

module.exports = {
  generateEditPlan,
  MODEL,
};
