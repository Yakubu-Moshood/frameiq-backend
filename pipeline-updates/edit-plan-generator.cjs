'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateEditPlan } = require('./edit-plan-validator.cjs');
const schema = require('./edit-plan.schema.json');

const MODEL = 'claude-opus-4-5';
const MAX_TOKENS = 16000;
const TIMING_EPSILON = 0.001;
const CHECKPOINT_VERSION = 3;
const CHECKPOINT_FILE = 'edit-plan-drafts.partial.json';
const MAX_REPAIR_ATTEMPTS_PER_ACT = 2;
const REPAIR_POLICY_VERSION = 5;
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
// The Director chooses semantic editorial units, not mechanical word slices.
const DIRECTOR_CALIBRATION = `A beat is one coherent editorial idea, reveal, action, contrast, or emotional turn. Keep adjacent list items and short clauses that belong to one idea in one beat; do not create a new beat for every comma or noun fragment. A sequence is a sustained editorial idea with related beats and an audience transformation. Decide what changes inside the frame before choosing camera motion; story action, human behaviour, object interaction, document behaviour, environmental change, and graphic transformation outrank decorative camera movement. When narration presents a quantitative, legal, regulatory, official, documentary, quoted, historically recorded, or otherwise externally provable claim, FIRST ask: "Should authentic material prove this claim?" If yes, use visualClass EVIDENCE and provide evidenceRequirement. Never use EDITORIAL_ILLUSTRATION to fabricate an official memo, filing, termination document, report, newspaper front page, financial terminal, testimony record, quote card, regulatory document, or court document when the purpose is to prove the claim. Editorial graphics may explain or contextualise evidence but must not impersonate authentic source material. Never invent URLs, quotations, source names, publication names, filing numbers, provenance, or document wording unless supplied in source context. literal_supported means the specific physical action, object, interaction, location or procedure is explicitly supported by narration or supplied source context; do not use it merely because the reconstruction looks plausible. representative means the underlying situation is supported but exact staging is unknown, so communicate it generically without implying the precise action, person, location, procedure, object or interface is verified. atmospheric means human or location atmosphere only and does not assert a specific factual action. Never default mentally to representative; choose reconstructionMode from what the available source context actually supports, and do not upgrade unsupported action to literal_supported. intentionalStillness=true means absence of visual movement is itself the editorial decision, suitable for emotional aftermath, evidence reading, major reveal, final impact, or breathing room; it requires static_locked and a meaningful timingExceptionReason. static_locked alone does not mean intentionalStillness: locked framing may contain human, object, environmental, or graphic/document action. postNarrationHoldSec may coexist with intentionalStillness and represents future silence after narration; it never changes the narration clock.`;

const REPAIR_STANDARD = `${DIRECTOR_STANDARD}
${DIRECTOR_CALIBRATION}

Repair only the reported editorial planning errors. Return the complete replacement compact MODEL DRAFT for the specified act as JSON only, never a patch. Preserve strong valid choices. Supply only creative planning fields and narration word indices; omit mechanical defaults when unused. Do not output motionIntent, final timestamps, durations, narrationExcerpt, sequenceId, beatId, actKey, renderer tracks, filenames, FFmpeg, or DaVinci instructions. For overlong narration beats, repartition narration at meaningful semantic boundaries unless continuous duration is genuinely necessary for an evidence read, major reveal, payoff, or other defensible editorial exception. postNarrationHoldSec does not shorten narration and is never a fix for an overlong narration beat. Never invent evidence URLs, sources, quotations, or provenance.`;

const REPAIRABLE_CODES = new Set([
  'MISSING_VISUAL_INTENT', 'MISSING_STORY_FUNCTION',
  'VISUAL_MOTION_MISMATCH', 'STILLNESS_REASON_REQUIRED', 'STILLNESS_MOTION_REQUIRED', 'BEAT_TOO_LONG', 'BEAT_TOO_SHORT', 'HOLD_REASON_REQUIRED', 'RECONSTRUCTION_MODE_REQUIRED', 'RECONSTRUCTION_MODE_FORBIDDEN',
  'EVIDENCE_REQUIREMENT', 'INVALID_WORD_RANGE', 'WORD_RANGE_ORDER',
  'NARRATION_GAP', 'NARRATION_OVERLAP', 'BEAT_TIME_ORDER',
  'TIMELINE_GAP', 'TIMELINE_OVERLAP',
]);
const REPAIRABLE_SCHEMA_CODES = new Set([
  'SCHEMA_REQUIRED', 'SCHEMA_TYPE', 'SCHEMA_ENUM', 'SCHEMA_TEXT',
  'SCHEMA_MINIMUM', 'SCHEMA_MIN_ITEMS', 'SCHEMA_UNIQUE',
]);
const MODEL_SEQUENCE_FIELDS = new Set([
  'sequencePurpose', 'directorIntent', 'emotionalStateStart', 'emotionalStateEnd',
  'knowledgeQuestion', 'knowledgeAnswer', 'createsQuestion', 'motifRefs',
  'continuityRefs', 'beats',
]);
const MODEL_BEAT_FIELDS = new Set([
  'startWordIndex', 'endWordIndex', 'storyFunction', 'visualIntent', 'visualClass',
  'visual', 'rhythmIntent', 'intentionalStillness', 'timingExceptionReason', 'postNarrationHoldSec', 'reconstructionMode',
  'motionIntent', 'graphics', 'audioDirection', 'evidenceRequirement', 'continuityRefs',
]);
const DETERMINISTIC_BEAT_FIELDS = new Set([
  'beatId', 'sequenceId', 'actKey', 'startSec', 'endSec', 'durationSec', 'narrationExcerpt',
]);
const RANGE_SECONDARY_CODES = new Set([
  'MISSING_NARRATION_EXCERPT', 'INVALID_TIME_RANGE', 'DURATION_MISMATCH',
]);
const APPROVED_VOCABULARIES = {
  visualClass: schema.$defs.beat.properties.visualClass.enum,
  visualType: schema.$defs.beat.properties.visual.properties.type.enum,
  rhythmIntent: schema.$defs.beat.properties.rhythmIntent.enum,
  storyFunction: schema.$defs.beat.properties.storyFunction.enum,
  motionType: schema.$defs.motionType.enum,
  graphicsType: schema.$defs.beat.properties.graphics.items.properties.type.enum,
  musicEvent: schema.$defs.beat.properties.audioDirection.properties.musicEvent.enum,
  reconstructionMode: ['literal_supported', 'representative', 'atmospheric'],
};

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

function repairAttemptScopeFingerprint({ generationFingerprint, repairStandard = REPAIR_STANDARD, repairPolicyVersion = REPAIR_POLICY_VERSION } = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({ generationFingerprint, repairStandard, repairPolicyVersion, maxRepairAttempts: MAX_REPAIR_ATTEMPTS_PER_ACT })).digest('hex');
}

function freshCheckpoint(episodeId) {
  return { checkpointVersion: CHECKPOINT_VERSION, episodeId, channel: 'EmpireOmitted', acts: {}, repairAttempts: {}, repairAttemptFingerprints: {} };
}

function loadCheckpoint(checkpointPath, episodeId) {
  if (!checkpointPath || !fs.existsSync(checkpointPath)) return freshCheckpoint(episodeId);
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (parsed?.checkpointVersion === CHECKPOINT_VERSION
      && parsed.episodeId === episodeId
      && parsed.channel === 'EmpireOmitted'
      && parsed.acts && typeof parsed.acts === 'object' && !Array.isArray(parsed.acts)) {
      if (!parsed.repairAttempts || typeof parsed.repairAttempts !== 'object' || Array.isArray(parsed.repairAttempts)) parsed.repairAttempts = {};
      if (!parsed.repairAttemptFingerprints || typeof parsed.repairAttemptFingerprints !== 'object' || Array.isArray(parsed.repairAttemptFingerprints)) parsed.repairAttemptFingerprints = {};
      return parsed;
    }
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
  const diagnostics = {
    stopReason: typeof message?.stop_reason === 'string' ? message.stop_reason : null,
    outputTokens: Number.isFinite(message?.usage?.output_tokens) ? message.usage.output_tokens : null,
    textChars: raw.length,
  };
  const fail = (failureType, detail) => {
    const error = new Error(`[edit-plan] ${actKey} model ${failureType}; stop_reason=${diagnostics.stopReason || 'unknown'}; output_tokens=${diagnostics.outputTokens ?? 'unknown'}; text_chars=${diagnostics.textChars}.`);
    error.failureType = failureType;
    error.diagnostics = diagnostics;
    error.safeDetail = detail;
    throw error;
  };
  if (diagnostics.stopReason === 'max_tokens') fail('output truncated');
  try {
    return JSON.parse(stripJsonFences(raw));
  } catch (error) {
    fail('JSON parse failed', error.message);
  }
}

function draftBeatBudget(durationSec) {
  const target = Math.max(1, Math.round(durationSec / 4.5));
  const minimum = Math.max(1, Math.ceil(durationSec / 5.5));
  const maximum = Math.max(minimum, Math.ceil(durationSec / 3.5));
  return { target, minimum, maximum };
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
  const budget = draftBeatBudget(durationSec);
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
    `Editorial beat budget: target about ${budget.target} beats; acceptable approximate range ${budget.minimum}–${budget.maximum}. Normal beats are approximately 3.5–5.5 seconds and normally no more than 6 seconds.`,
    `Narration:\n${act.voScript}`,
    `Indexed act-local timed words:\n${JSON.stringify(indexedWords)}`,
    `Safe creative Channel DNA:\n${JSON.stringify(creativeDna(channelDna))}`,
    `Approved vocabularies (do not invent synonyms): ${JSON.stringify(APPROVED_VOCABULARIES)}`,
    DIRECTOR_CALIBRATION,
    previousContext ? `Previous-act continuity context:\n${previousContext}` : '',
    `Return JSON only as a compact model draft. Example:
{"sequences":[{"sequencePurpose":"Establish the mechanism.","directorIntent":"Show how pressure reaches an employee.","beats":[{"startWordIndex":0,"endWordIndex":12,"storyFunction":"establish","visualIntent":"An employee studies a target board.","visualClass":"RECONSTRUCTION","reconstructionMode":"representative","visual":{"type":"CLIP","description":"An employee studies a target board.","motionType":"dolly_forward","secondaryAction":"The employee marks the target."},"rhythmIntent":"measured"}]}]}
For an EVIDENCE beat, optionally add only creative source-request fields such as evidenceRequirement:{"evidenceType":"regulatory filing","description":"The authenticated filing to retrieve","citationLabel":"Filing"}. Include optional creative fields only when meaningful. Do not output defaults, workflow states, motionIntent, IDs, timestamps, durations, narrationExcerpt, renderer fields, or empty graphics/audio objects unless creatively needed.`,
    'ARCHIVAL, BROLL, STOCK, GRAPHIC, DOCUMENT and similar invented synonyms are invalid. Use EVIDENCE for evidence planning and EDITORIAL_ILLUSTRATION for editorial graphics while keeping visual.type within the approved list. Omit optional values instead of inventing them. Do not output motionIntent. Only emit postNarrationHoldSec or reconstructionMode when relevant. Keep visualIntent and visual.description to one concise sentence; keep sequencePurpose, directorIntent, and emotional fields concise; keep secondaryAction a short phrase or null; do not repeat information across fields. Do not output startSec, endSec, durationSec, narrationExcerpt, beatId, sequenceId, actKey, tracks, filenames, FFmpeg, or DaVinci instructions. Cover every word index exactly once in playback order.',
  ].filter(Boolean).join('\n\n');
}

function buildDraftRetryPrompt({ actKey, originalPrompt, durationSec }) {
  const budget = draftBeatBudget(durationSec);
  return [
    `Regenerate the complete ${actKey} model draft JSON. The previous answer was incomplete or malformed.`,
    `Return JSON only, with no markdown fences. Return the compact model-draft contract: creative fields and word indices only. Do not expand omitted optional fields into null/default/workflow values.`,
    `Use concise one-sentence visualIntent and visual.description, concise sequencePurpose/directorIntent/emotional fields, short secondaryAction or null, and do not repeat information. Cover every word index exactly once; do not duplicate narration. Target about ${budget.target} beats, with an approximate range of ${budget.minimum}–${budget.maximum}.`,
    `Approved vocabularies: ${JSON.stringify(APPROVED_VOCABULARIES)}. Do not invent synonyms; omit optional values when unused; never output motionIntent, evidence workflow states, or deterministic timing fields.`,
    `Original act instructions and indexed words:\n${originalPrompt}`,
  ].join('\n\n');
}

function validateActDraft({ draft, act, words, episodeId }) {
  const localAct = {
    actKey: act.actKey, voKey: act.voKey, startSec: 0,
    endSec: act.durationSec, durationSec: act.durationSec, wordCount: words.length,
  };
  const plan = {
    schemaVersion: '3.1.0', pipelineVersion: 3, channel: 'EmpireOmitted',
    episodeId, title: 'Act validation',
    timing: { basis: 'finished_vo_word_timestamps', totalDurationSec: act.durationSec, acts: [localAct] },
    sequences: finaliseActDraft({ draft, act: { ...act, startSec: 0, endSec: act.durationSec }, words }),
  };
  return { plan, report: validateEditPlan({ plan, wordTimestamps: words }) };
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) if (Object.hasOwn(source || {}, key)) result[key] = source[key];
  return result;
}

function projectBeatIntent(draft) {
  const intent = pick(draft, [
    'storyFunction', 'visualIntent', 'visualClass', 'rhythmIntent',
    'intentionalStillness', 'timingExceptionReason', 'postNarrationHoldSec', 'reconstructionMode', 'continuityRefs',
  ]);
  if (Object.hasOwn(draft || {}, 'visual')) {
    intent.visual = pick(draft.visual, ['type', 'description', 'motionType', 'secondaryAction']);
    if (!Object.hasOwn(intent.visual, 'secondaryAction')) intent.visual.secondaryAction = null;
  }
  if (typeof draft?.visual?.motionType === 'string') {
    intent.motionIntent = { type: draft.visual.motionType };
    if (typeof draft.visual.secondaryAction === 'string' && draft.visual.secondaryAction.trim()) {
      intent.motionIntent.secondaryAction = draft.visual.secondaryAction;
    }
  }
  if (draft?.graphics === null) intent.graphics = null;
  else if (Array.isArray(draft?.graphics)) {
    intent.graphics = draft.graphics.map(graphic => pick(graphic, ['type', 'intent', 'text']));
  } else intent.graphics = null;
  if (!Object.hasOwn(draft || {}, 'audioDirection')) intent.audioDirection = null;
  else if (draft.audioDirection === null) intent.audioDirection = null;
  else intent.audioDirection = {
    musicCue: draft.audioDirection.musicCue ?? null,
    musicEvent: Object.hasOwn(draft.audioDirection, 'musicEvent') ? draft.audioDirection.musicEvent : null,
    musicLevelDb: draft.audioDirection.musicLevelDb ?? null,
    duckUnderVO: draft.audioDirection.duckUnderVO ?? null,
    sfx: Array.isArray(draft.audioDirection.sfx) ? draft.audioDirection.sfx : [],
    silenceIntent: draft.audioDirection.silenceIntent ?? null,
  };
  if (draft?.visualClass === 'EVIDENCE') {
    const evidence = draft.evidenceRequirement || {};
    intent.evidenceRequirement = {
      required: true, evidenceType: evidence.evidenceType ?? null,
      description: evidence.description ?? null, sourceStatus: 'pending',
      rightsStatus: 'unknown', authenticityStatus: 'pending_review',
      citationLabel: evidence.citationLabel ?? null, humanReviewRequired: true,
    };
  } else intent.evidenceRequirement = {
    required: false, evidenceType: null, description: null, sourceStatus: 'not_applicable',
    rightsStatus: 'not_applicable', authenticityStatus: 'not_applicable', citationLabel: null,
    humanReviewRequired: false,
  };
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
    intentionalStillness: draft.intentionalStillness ?? false,
    timingExceptionReason: draft.timingExceptionReason ?? null,
    postNarrationHoldSec: Object.hasOwn(draft || {}, 'postNarrationHoldSec') ? draft.postNarrationHoldSec : 0,
    reconstructionMode: Object.hasOwn(draft || {}, 'reconstructionMode') ? draft.reconstructionMode : null,
    continuityRefs: Array.isArray(draft.continuityRefs) ? draft.continuityRefs : [],
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
      knowledgeQuestion: sequence.knowledgeQuestion ?? null,
      knowledgeAnswer: sequence.knowledgeAnswer ?? null,
      createsQuestion: sequence.createsQuestion ?? null,
      motifRefs: Array.isArray(sequence.motifRefs) ? sequence.motifRefs : [],
      continuityRefs: Array.isArray(sequence.continuityRefs) ? sequence.continuityRefs : [],
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

function attributeErrorToAct(error, plan) {
  let match = /^\/sequences\/(\d+)(?:\/|$)/.exec(error.path || '');
  if (match) return plan.sequences[Number(match[1])]?.actKey || null;
  match = /^\/timing\/acts\/(\d+)(?:\/|$)/.exec(error.path || '');
  if (match) return plan.timing.acts[Number(match[1])]?.actKey || null;
  return null;
}

function schemaFieldOwnership(error) {
  if (!REPAIRABLE_SCHEMA_CODES.has(error.code)) return null;
  const parts = (error.path || '').split('/').slice(1);
  if (parts[0] !== 'sequences' || !/^\d+$/.test(parts[1] || '')) return null;
  if (parts.length < 3) return null;
  const sequenceField = parts[2];
  if (sequenceField !== 'beats') {
    return MODEL_SEQUENCE_FIELDS.has(sequenceField) ? 'model' : 'deterministic';
  }
  if (parts.length === 3) return 'model';
  if (!/^\d+$/.test(parts[3] || '')) return null;
  if (parts.length < 5) return null;
  const beatField = parts[4];
  if (MODEL_BEAT_FIELDS.has(beatField)) return 'model';
  if (DETERMINISTIC_BEAT_FIELDS.has(beatField)) return 'deterministic';
  return null;
}

function classifyRepairErrors(report, plan) {
  const attributed = new Map();
  const preliminary = report.errors.map(error => ({ error, actKey: attributeErrorToAct(error, plan) }));
  const rangeFaultActs = new Set(preliminary.filter(item => item.actKey && ['INVALID_WORD_RANGE', 'WORD_RANGE_ORDER'].includes(item.error.code)).map(item => item.actKey));
  for (const item of preliminary) {
    const { error, actKey } = item;
    const ownership = schemaFieldOwnership(error);
    const deterministicSchemaSymptom = ownership === 'deterministic'
      && actKey && rangeFaultActs.has(actKey)
      && /^\/sequences\/\d+\/beats\/\d+\/(?:startSec|endSec|durationSec|narrationExcerpt)(?:\/|$)/.test(error.path || '');
    const deterministicCodeSymptom = RANGE_SECONDARY_CODES.has(error.code)
      && actKey && rangeFaultActs.has(actKey) && /^\/sequences\//.test(error.path || '');
    if (deterministicSchemaSymptom || deterministicCodeSymptom) continue;
    const repairable = REPAIRABLE_CODES.has(error.code) || ownership === 'model';
    if (!actKey || !repairable) {
      return { nonrepairable: error, byAct: attributed };
    }
    if (!attributed.has(actKey)) attributed.set(actKey, []);
    attributed.get(actKey).push(error);
  }
  return { nonrepairable: null, byAct: attributed };
}

function beatTimingDiagnostic(beat) {
  return {
    durationSec: beat.durationSec,
    startWordIndex: beat.startWordIndex,
    endWordIndex: beat.endWordIndex,
    narrationExcerpt: beat.narrationExcerpt,
  };
}

function localBeatSeconds(words, start, end, durationSec) {
  const startSec = start === 0 ? 0 : words[start].start_seconds;
  const endSec = end === words.length - 1 ? durationSec : words[end + 1].start_seconds;
  return { startSec, endSec, durationSec: endSec - startSec };
}

function buildTimingRepairClusters({ errors = [], validationPlan, words = [], durationSec } = {}) {
  const flattened = [];
  (validationPlan?.sequences || []).forEach((sequence, sequenceIndex) => (sequence.beats || []).forEach((beat, beatIndex) => {
    flattened.push({ sequenceIndex, beatIndex, beat });
  }));
  const faultIndexes = flattened.map((item, index) => errors.some(error => {
    const match = /^\/sequences\/(\d+)\/beats\/(\d+)/.exec(error.path || '');
    return match && Number(match[1]) === item.sequenceIndex && Number(match[2]) === item.beatIndex
      && ['BEAT_TOO_SHORT', 'BEAT_TOO_LONG'].includes(error.code);
  })).map((fault, index) => fault ? index : -1).filter(index => index >= 0);
  const windows = faultIndexes.map(index => ({ start: Math.max(0, index - 1), end: Math.min(flattened.length - 1, index + 1) }));
  const merged = [];
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end + 1) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  function candidatesFor(start, end) {
    const first = flattened[start].beat;
    const last = flattened[end].beat;
    const clusterStartWordIndex = first.startWordIndex;
    const clusterEndWordIndex = last.endWordIndex;
    const existingBeatCount = end - start + 1;
    const clusterWords = words.slice(clusterStartWordIndex, clusterEndWordIndex + 1);
    const validBoundaryIndexes = new Set(flattened.slice(start, end + 1).slice(0, -1).filter(item => {
      const duration = item.beat.durationSec;
      return duration >= 2 && duration <= 6;
    }).map(item => item.beat.endWordIndex));
    const makeOption = ranges => ({ resultingRanges: ranges.map(range => ({
      ...range, ...localBeatSeconds(words, range.startWordIndex, range.endWordIndex, durationSec),
      narrationExcerpt: words.slice(range.startWordIndex, range.endWordIndex + 1).map(word => word.word).join(' '),
    })) });
    const score = ranges => {
      const outsideTarget = ranges.reduce((n, range) => n + (range.durationSec < 3.5 || range.durationSec > 5.5 ? 1 : 0), 0);
      const distance = ranges.reduce((n, range) => n + Math.abs(range.durationSec - 4.5), 0);
      const candidateBoundaries = new Set(ranges.slice(0, -1).map(range => range.endWordIndex));
      const movement = [...validBoundaryIndexes].filter(boundary => !candidateBoundaries.has(boundary)).length
        + [...candidateBoundaries].filter(boundary => !validBoundaryIndexes.has(boundary)).length;
      return [outsideTarget, distance, movement, Math.abs(ranges.length - existingBeatCount), JSON.stringify(ranges.map(range => [range.startWordIndex, range.endWordIndex]))];
    };
    const compareRanges = (a, b) => {
      const sa = score(a); const sb = score(b);
      for (let i = 0; i < 4; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
      return sa[4].localeCompare(sb[4]);
    };
    const keepBestFive = candidates => candidates.sort(compareRanges).slice(0, 5);
    const counts = [...new Set([existingBeatCount - 1, existingBeatCount, existingBeatCount + 1].filter(count => count > 0 && count <= clusterWords.length))];
    const ranked = [];
    for (const count of counts) {
      const memo = new Map();
      const bestFrom = (offset, left) => {
        const key = `${offset}:${left}`;
        if (memo.has(key)) return memo.get(key);
        if (left === 1) {
          const range = { startWordIndex: clusterStartWordIndex + offset, endWordIndex: clusterEndWordIndex };
          const timing = localBeatSeconds(words, range.startWordIndex, range.endWordIndex, durationSec);
          const result = timing.durationSec >= 2 && timing.durationSec <= 6 ? [[{ ...range, ...timing }]] : [];
          memo.set(key, result);
          return result;
        }
        let best = [];
        for (let endOffset = offset; endOffset < clusterWords.length - left + 1; endOffset++) {
          const range = { startWordIndex: clusterStartWordIndex + offset, endWordIndex: clusterStartWordIndex + endOffset };
          const timing = localBeatSeconds(words, range.startWordIndex, range.endWordIndex, durationSec);
          if (timing.durationSec < 2 || timing.durationSec > 6) continue;
          for (const suffix of bestFrom(endOffset + 1, left - 1)) {
            best.push([{ ...range, ...timing }, ...suffix]);
            if (best.length > 5) best = keepBestFive(best);
          }
        }
        best = keepBestFive(best);
        memo.set(key, best);
        return best;
      };
      ranked.push(...bestFrom(0, count));
    }
    const options = keepBestFive(ranked).map(makeOption);
    return { clusterStartWordIndex, clusterEndWordIndex, existingBeatCount, options };
  }
  return merged.map(window => {
    const queue = [{ start: window.start, end: window.end }];
    const visited = new Set();
    while (queue.length) {
      const depth = Math.max(window.start - queue[0].start, queue[0].end - window.end);
      const layer = [];
      while (queue.length) {
        const state = queue[0];
        const stateDepth = Math.max(window.start - state.start, state.end - window.end);
        if (stateDepth !== depth) break;
        layer.push(queue.shift());
      }
      const successes = [];
      for (const state of layer) {
        const key = `${state.start}:${state.end}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const result = candidatesFor(state.start, state.end);
        if (result.options.length) successes.push({ state, result });
      }
      if (successes.length) {
        successes.sort((a, b) => JSON.stringify(a.result.options).localeCompare(JSON.stringify(b.result.options)) || a.state.start - b.state.start || a.state.end - b.state.end);
        return { ...successes[0].result, strictPartitionAvailable: true };
      }
      for (const state of layer) {
        if (state.end - state.start + 1 >= 5) continue;
        const expansions = [];
        if (state.start > 0) expansions.push({ start: state.start - 1, end: state.end });
        if (state.end < flattened.length - 1) expansions.push({ start: state.start, end: state.end + 1 });
        expansions.sort((a, b) => a.start - b.start || a.end - b.end);
        queue.push(...expansions);
      }
    }
    const fallback = candidatesFor(window.start, window.end);
    return { ...fallback, options: [], strictPartitionAvailable: false };
  });
}

function buildTimingDiagnostics(errors, validationPlan) {
  if (!validationPlan?.sequences) return [];
  const flattened = [];
  validationPlan.sequences.forEach((sequence, sequenceIndex) => {
    (sequence.beats || []).forEach((beat, beatIndex) => flattened.push({ sequenceIndex, beatIndex, beat }));
  });
  const diagnostics = [];
  for (const error of errors) {
    if (!['BEAT_TOO_SHORT', 'BEAT_TOO_LONG'].includes(error.code)) continue;
    const match = /^\/sequences\/(\d+)\/beats\/(\d+)/.exec(error.path || '');
    if (!match) continue;
    const sequenceIndex = Number(match[1]);
    const beatIndex = Number(match[2]);
    const flatIndex = flattened.findIndex(item => item.sequenceIndex === sequenceIndex && item.beatIndex === beatIndex);
    const current = flattened[flatIndex];
    if (!current) continue;
    const beat = current.beat;
    diagnostics.push({
      code: error.code, sequenceIndex, beatIndex, ...beatTimingDiagnostic(beat),
      previous: flatIndex > 0 ? beatTimingDiagnostic(flattened[flatIndex - 1].beat) : undefined,
      next: flatIndex + 1 < flattened.length ? beatTimingDiagnostic(flattened[flatIndex + 1].beat) : undefined,
    });
  }
  return diagnostics;
}

function buildRepairPrompt({ actKey, originalPrompt, draft, errors, attempt, validationPlan, words, durationSec, previousRejection }) {
  const codes = errors.map(error => error.code);
  const hasShort = codes.includes('BEAT_TOO_SHORT');
  const hasLong = codes.includes('BEAT_TOO_LONG');
  const hasMixedTiming = hasShort && hasLong;
  const shortBeatGuidance = hasShort && !hasMixedTiming ? `
SHORT-BEAT REPAIR: repair semantic fragmentation first. For each BEAT_TOO_SHORT error, merge the short narration fragment into an adjacent semantically related beat whenever possible. Adjust word-index boundaries while preserving every narration word exactly once, playback order, no gaps, no overlaps, and coherent sequence meaning. Short noun lists, clauses, connective phrases, and sentence tails normally belong inside the neighbouring editorial idea. You may merge adjacent beats, redistribute boundaries, collapse a thin sequence, and rewrite the surviving visual intent. Do not solve ordinary short beats merely by adding timingExceptionReason. Keep a sub-2-second beat separate only for a genuinely intentional impact such as a major payoff, decisive reveal, single-word/statistical impact, or emotional punctuation, with a meaningful timingExceptionReason and, where appropriate, postNarrationHoldSec. Example: merge "credit cards", "checking accounts", "savings accounts", and "all fake" into one coherent beat with internal progression.` : '';
  const mixedTimingGuidance = hasMixedTiming ? `
MIXED TIMING REBALANCE:
This draft contains both overlong and underlength beats. Treat neighbouring timing faults as one local editorial cluster rather than fixing each beat in isolation.
First rebalance narration word boundaries across the affected neighbouring beats.
Prefer redistributing word boundaries between adjacent beats; absorbing a fragment and then re-splitting the combined material at a meaningful semantic boundary; converting several badly sized beats into a smaller or larger set of coherent editorial beats; and preserving sequence meaning while restructuring local beat boundaries.
Target approximately 3.5-5.5 seconds per ordinary beat.
Hard guardrails remain: ordinary beat must not remain below 2 seconds; ordinary beat must not exceed 6 seconds; every narration word exactly once; original playback order; no narration gaps; no narration overlaps.
Do not split a long beat mechanically if that simply creates another short fragment. Do not merge a short beat blindly into an already overlong neighbour. Do not alternate between splitting and merging the same material. Do not use timingExceptionReason simply to silence the validator.
Timing exceptions remain only for genuine editorial impact, evidence reading, major reveal, emotional punctuation, intentional stillness, or deliberate hold.
When one long beat sits beside one or more short beats, consider the combined narration span first, then repartition the whole span into coherent editorial units.` : '';
  const longBeatGuidance = hasLong && !hasShort ? `
LONG-BEAT REPARTITION:
First decide whether each overlong narration beat is an ordinary beat that should be repartitioned or a genuinely justified editorial exception. For an ordinary beat, inspect the indexed word timestamps in the ORIGINAL GENERATION PROMPT; do not estimate duration from word count. Identify meaningful semantic boundaries and split or redistribute coverage so ordinary beats are preferably 3.5-5.5 seconds, with no resulting ordinary beat below 2 seconds or above 6 seconds. Preserve every narration word exactly once, original playback order, no gaps, no overlaps, sequence meaning, and rewrite creative intent where needed so each resulting beat is a complete editorial idea. Restructure the local sequence when necessary rather than mechanically cutting one beat in half.
For an overlong EVIDENCE beat, first decide whether the audience must consume the source as one continuous unit. If yes, preserve evidence metadata and provide a meaningful reason describing why continuous duration is editorially necessary. If no, repartition at meaningful claim/source boundaries and preserve evidence-first semantics and required metadata on each resulting EVIDENCE beat.
Do not cut at the midpoint or arbitrary word counts, create a short fragment, split an incoherent sentence or evidentiary idea, duplicate or drop narration, or add timingExceptionReason merely to silence BEAT_TOO_LONG. postNarrationHoldSec is not a fix for BEAT_TOO_LONG, and intentionalStillness is not automatically a justification. Genuine exceptions require a meaningful reason for an evidence read, major reveal, major payoff, emotional punctuation, or other defensible editorial necessity.` : '';
  const timingDiagnostics = buildTimingDiagnostics(errors, validationPlan);
  const timingClusters = buildTimingRepairClusters({ errors, validationPlan, words, durationSec });
  const timingOnly = errors.every(error => error.code === 'BEAT_TOO_SHORT' || error.code === 'BEAT_TOO_LONG');
  const timingPatchProtocol = timingOnly ? `
TIMING PATCH PROTOCOL:
Return only a JSON timing patch object: {"repairType":"TIMING_CLUSTER_PATCH","clusters":[{"clusterStartWordIndex":number,"clusterEndWordIndex":number,"resolution":{"type":"candidate","optionIndex":number},"replacementBeats":[{"targetSequenceIndex":number, creative fields...}]}]}. Return one entry for every authorized cluster. For candidate resolution, do not provide startWordIndex or endWordIndex; code supplies exact deterministic geometry. Target sequences must be among the sequences intersected by that cluster and in playback order. A genuine exception may use resolution.type="exception" with the current boundaries and a meaningful timingExceptionReason. Do not address unrelated beats or sequences. Return only the timing repair patch JSON object.` : '';
  const constrainedTiming = timingClusters.length ? `
CONSTRAINED LOCAL TIMING OPTIONS:
The listed clusters are the only narration regions requiring timing restructuring. Preserve word-index boundaries outside these clusters and do not globally repartition the act, reopen valid timing regions, or move a timing fault elsewhere. Choose a deterministic candidate only when it preserves coherent language and editorial meaning; the options are facts, not mechanical instructions. Preserve evidence semantics and rewrite creative fields inside affected clusters as needed.
${JSON.stringify(timingClusters)}` : '';
  return [
    timingOnly ? `Repair only the authorized timing cluster(s) for ${actKey}.` : `Repair the complete model draft for ${actKey}.`,
    `Repair attempt: ${attempt}`,
    `ORIGINAL GENERATION PROMPT:\n${originalPrompt}`,
    `CURRENT MODEL DRAFT:\n${JSON.stringify(draft)}`,
    `VALIDATOR HARD ERRORS:\n${JSON.stringify(errors.map(({ code, path: errorPath, message }) => ({ code, path: errorPath, message })))}`,
    previousRejection ? `PREVIOUS TIMING PATCH REJECTED:\n${previousRejection}` : '',
    shortBeatGuidance,
    mixedTimingGuidance,
    longBeatGuidance,
    timingDiagnostics.length ? `TIMING REPAIR DIAGNOSTICS:\n${JSON.stringify(timingDiagnostics)}` : '',
    constrainedTiming,
    timingPatchProtocol,
    timingOnly ? 'For candidate resolution, optionIndex is ZERO-BASED: 0 is the first deterministic option, 1 the second, 2 the third.' : '',
    timingOnly ? 'Return only the TIMING_CLUSTER_PATCH JSON object. Do not return markdown or a complete act draft.' : 'Return only the complete replacement model-draft JSON object. Do not return markdown or a JSON patch.',
  ].join('\n\n');
}

function applyTimingRepairPatch({ draft, validationPlan, clusters, patch }) {
  if (!patch || patch.repairType !== 'TIMING_CLUSTER_PATCH' || !Array.isArray(patch.clusters) || patch.clusters.length !== clusters.length) throw new Error('[edit-plan] Invalid timing repair patch shape.');
  const next = JSON.parse(JSON.stringify(draft));
  const expected = new Set(clusters.map(cluster => `${cluster.clusterStartWordIndex}:${cluster.clusterEndWordIndex}`));
  const seen = new Set();
  for (const entry of patch.clusters) {
    const key = `${entry.clusterStartWordIndex}:${entry.clusterEndWordIndex}`;
    const cluster = clusters.find(item => `${item.clusterStartWordIndex}:${item.clusterEndWordIndex}` === key);
    if (!cluster || seen.has(key) || !entry.resolution || !Array.isArray(entry.replacementBeats)) throw new Error('[edit-plan] Timing patch cluster is outside the authorized scope.');
    seen.add(key);
    const currentBeats = [];
    validationPlan.sequences.forEach((sequence, sequenceIndex) => sequence.beats.forEach((beat, beatIndex) => {
      if (beat.startWordIndex >= cluster.clusterStartWordIndex && beat.endWordIndex <= cluster.clusterEndWordIndex) currentBeats.push({ sequenceIndex, beatIndex, beat });
    }));
    if (entry.resolution.type === 'candidate') {
      const option = cluster.options[entry.resolution.optionIndex];
      if (!option || entry.replacementBeats.length !== option.resultingRanges.length) throw new Error('[edit-plan] Timing patch candidate is invalid.');
      if (entry.replacementBeats.some(beat => Object.hasOwn(beat, 'startWordIndex') || Object.hasOwn(beat, 'endWordIndex'))) throw new Error('[edit-plan] Timing patch may not provide candidate geometry.');
    } else if (entry.resolution.type === 'exception') {
      if (entry.replacementBeats.length !== currentBeats.length) throw new Error('[edit-plan] Timing exception must preserve current beat count.');
    } else throw new Error('[edit-plan] Timing patch resolution is invalid.');
    const affected = new Set();
    next.sequences.forEach((sequence, sequenceIndex) => {
      sequence.beats = sequence.beats.filter(beat => {
        const inside = beat.startWordIndex >= cluster.clusterStartWordIndex && beat.endWordIndex <= cluster.clusterEndWordIndex;
        if (inside) affected.add(sequenceIndex);
        return !inside;
      });
    });
    const targetIndexes = entry.replacementBeats.map(beat => beat.targetSequenceIndex);
    if (targetIndexes.some(index => !Number.isInteger(index)) || targetIndexes.some((index, indexInArray) => indexInArray && index < targetIndexes[indexInArray - 1])) throw new Error('[edit-plan] Timing patch target sequences must be non-decreasing.');
    if (targetIndexes.some(index => !affected.has(index))) throw new Error('[edit-plan] Timing patch targets an unrelated sequence.');
    const ranges = entry.resolution.type === 'candidate' ? cluster.options[entry.resolution.optionIndex].resultingRanges : currentBeats.map(item => ({ startWordIndex: item.beat.startWordIndex, endWordIndex: item.beat.endWordIndex }));
    ranges.forEach((range, index) => {
      const { targetSequenceIndex, startWordIndex, endWordIndex, ...creativeFields } = entry.replacementBeats[index];
      next.sequences[targetIndexes[index]].beats.push({ ...creativeFields, ...range });
    });
  }
  const affectedSequenceIndexes = new Set(patch.clusters.flatMap(entry => entry.replacementBeats.map(beat => beat.targetSequenceIndex)));
  next.sequences.forEach((sequence, index) => { if (affectedSequenceIndexes.has(index)) sequence.beats.sort((a, b) => a.startWordIndex - b.startWordIndex); });
  if (seen.size !== expected.size) throw new Error('[edit-plan] Timing patch omitted an authorized cluster.');
  return next;
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
  const generateDraftWithRetry = async ({ actKey, prompt, durationSec, system = DIRECTOR_STANDARD }) => {
    let lastFailure;
    for (let attempt = 0; attempt < 2; attempt++) {
      const requestPrompt = attempt === 0
        ? prompt
        : buildDraftRetryPrompt({ actKey, originalPrompt: prompt, durationSec });
      const message = await getClient().messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: requestPrompt }],
      });
      try {
        return parseModelJson(message, actKey);
      } catch (error) {
        lastFailure = error;
        if (attempt === 0 && error.failureType) continue;
        throw error;
      }
    }
    throw lastFailure;
  };
  const assembleCandidate = async () => {
    const finalSequences = [], priorContext = [], prompts = new Map();
    for (const [actKey, voKey] of ACTS) {
      const act = timing.acts.find(item => item.actKey === actKey);
      const words = wordsByVo.get(voKey);
      const prompt = buildActPrompt({ script, actKey, words, durationSec: act.durationSec, channelDna, previousContext: priorContext.slice(-2).join('\n') });
      const fingerprint = requestFingerprint(prompt);
      const scopeFingerprint = repairAttemptScopeFingerprint({ generationFingerprint: fingerprint });
      const scopedFingerprint = checkpoint.repairAttemptFingerprints[actKey];
      if (scopedFingerprint !== scopeFingerprint) {
        checkpoint.repairAttempts[actKey] = 0;
        checkpoint.repairAttemptFingerprints[actKey] = scopeFingerprint;
      }
      const saved = checkpoint.acts[actKey];
      const reusableDraft = saved?.fingerprint === fingerprint && saved.draft && typeof saved.draft === 'object'
        && !Array.isArray(saved.draft) && typeof saved.draftHash === 'string' && /^[a-f0-9]{64}$/.test(saved.draftHash)
        && draftFingerprint(saved.draft) === saved.draftHash;
      let draft = reusableDraft ? saved.draft : await generateDraftWithRetry({ actKey, prompt, durationSec: act.durationSec });
      let actValidation = validateActDraft({ draft, act, words, episodeId: episodeId.trim() });
      let previousRejection = '';
      while (actValidation.report.status !== 'PASS') {
        const classification = classifyRepairErrors(actValidation.report, actValidation.plan);
        if (classification.nonrepairable) {
          throw new Error(`[edit-plan] Nonrepairable validation error ${classification.nonrepairable.code} at ${classification.nonrepairable.path}: ${classification.nonrepairable.message}`);
        }
        const errors = classification.byAct.get(actKey) || [...actValidation.report.errors];
        const attempts = Number.isSafeInteger(checkpoint.repairAttempts[actKey]) && checkpoint.repairAttempts[actKey] >= 0
          ? checkpoint.repairAttempts[actKey] : (Number.isSafeInteger(saved?.repairAttempts) ? saved.repairAttempts : 0);
        if (attempts >= MAX_REPAIR_ATTEMPTS_PER_ACT) {
          throw new Error(`[edit-plan] Repair limit reached for ${actKey}: ${attempts} attempt(s) consumed; remaining errors: ${errors.map(error => error.code).join(', ')}`);
        }
        const nextAttempt = attempts + 1;
        const repairPrompt = buildRepairPrompt({ actKey, originalPrompt: prompt, draft, errors, attempt: nextAttempt, validationPlan: actValidation.plan, words, durationSec: act.durationSec, previousRejection });
        const repaired = await generateDraftWithRetry({ actKey: `${actKey} repair`, prompt: repairPrompt, durationSec: act.durationSec, system: REPAIR_STANDARD });
        checkpoint.repairAttempts[actKey] = nextAttempt;
        checkpoint.repairAttemptFingerprints[actKey] = scopeFingerprint;
        if (checkpointPath) writeCheckpointAtomic(checkpointPath, checkpoint);
        if (draftFingerprint(repaired) === draftFingerprint(draft)) {
          throw new Error(`[edit-plan] Repair made no progress for ${actKey} after attempt ${nextAttempt}.`);
        }
        const timingOnly = errors.every(error => error.code === 'BEAT_TOO_SHORT' || error.code === 'BEAT_TOO_LONG');
        if (timingOnly) {
          try {
            if (repaired?.repairType !== 'TIMING_CLUSTER_PATCH') throw new Error('Timing-only repair must return TIMING_CLUSTER_PATCH.');
            draft = applyTimingRepairPatch({ draft, validationPlan: actValidation.plan, clusters: buildTimingRepairClusters({ errors, validationPlan: actValidation.plan, words, durationSec: act.durationSec }), patch: repaired });
          } catch (error) {
            previousRejection = error.message;
            continue;
          }
        } else draft = repaired;
        actValidation = validateActDraft({ draft, act, words, episodeId: episodeId.trim() });
      }
      checkpoint.acts[actKey] = {
        fingerprint, draftHash: draftFingerprint(draft), draft,
        repairAttempts: checkpoint.repairAttempts[actKey] || 0,
      };
      if (checkpointPath) writeCheckpointAtomic(checkpointPath, checkpoint);
      prompts.set(actKey, prompt);
      finalSequences.push(...finaliseActDraft({ draft, act, words }));
      priorContext.push(continuitySummary(actKey, draft));
    }
    return {
      plan: { schemaVersion: '3.1.0', pipelineVersion: 3, channel: 'EmpireOmitted', episodeId: episodeId.trim(), title: String(script.title || script.topic || '').trim(), timing, sequences: finalSequences },
      prompts,
    };
  };

  const candidate = await assembleCandidate();
  const validation = validateEditPlan({ plan: candidate.plan, wordTimestamps, outputDir });
  if (validation.status !== 'PASS') {
    const error = validation.errors[0];
    throw new Error(`[edit-plan] Final validation failed ${error?.code || 'UNKNOWN'} at ${error?.path || '/'}: ${error?.message || 'unknown error'}`);
  }
  const plan = candidate.plan;
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
  _classifyRepairErrors: classifyRepairErrors,
  _repairAttemptScopeFingerprint: repairAttemptScopeFingerprint,
  _requestFingerprint: requestFingerprint,
  _buildTimingDiagnostics: buildTimingDiagnostics,
  _buildTimingRepairClusters: buildTimingRepairClusters,
  _applyTimingRepairPatch: applyTimingRepairPatch,
  _repairPolicyVersion: REPAIR_POLICY_VERSION,
};
