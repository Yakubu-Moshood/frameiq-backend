/**
 * surface-shot-definitions.cjs
 * Surface Pipeline v2 — Module 0C
 *
 * Takes a script and returns shot-definitions.json with:
 *   - triggerWord (single word, verbatim from script)
 *   - visualType, imagePrompt, animationPrompt, colorGrade, sfx
 *   - overlay data (auto-generated, per-channel visual language)
 *
 * Macro Decode onboarding (build report, see commit message for full detail):
 *   This module is now channel-aware, following the same pattern already
 *   used by surface-script-writer.cjs (getChannelConfigByLabel + a style
 *   profile selected by channel_dna.narration_style). Previously this file
 *   hardcoded Empire Omitted's identity/visual-language directly with no
 *   channel parameter at all.
 *
 *   Empire Omitted's original hardcoded content has been moved verbatim
 *   into VISUAL_PROFILES['dramatic-investigative'] — its prompt output,
 *   overlay shape ("cinematic" field), and behaviour are UNCHANGED. Any
 *   channel with an unrecognised/missing narration_style also falls back
 *   to this profile, matching prior behaviour when no channel was passed.
 *
 *   Macro Decode gets a new profile under 'crisp-analytical-direct'
 *   (channel_dna.narration_style for Macro Decode as of migration 007),
 *   built from macro-decode-channel-dna-v2.md. It introduces a new
 *   overlay shape — "stat" (data-callout stat card) and "lower" (source
 *   citation lower-third) — instead of Empire Omitted's dollar-stamp
 *   "cinematic" field, and a new "DATA_VIZ" visual type for animated
 *   charts/counting numbers.
 *
 *   IMPORTANT CAVEAT: "DATA_VIZ" is a new label in the shot schema, but
 *   no module downstream (surface-image-generator.cjs, surface-animator.cjs,
 *   surface-renderer.cjs) has a rendering path that actually produces
 *   animated/building charts or counting numbers today. Until that is
 *   built, DATA_VIZ shots are handled exactly like STILL shots by the
 *   rest of the pipeline (a static image is generated and held for the
 *   shot's duration) — the label is forward-looking, not a working
 *   feature yet. See the build report for what real support would need.
 *
 * Render-fix follow-up (pacing + motion pass, this session):
 *   Empire Omitted's profile below was flagged as "UNCHANGED from the
 *   original hardcoded version" -- true, but that also meant it never got
 *   the pacing discipline Macro Decode's profile was written with from day
 *   one (Macro Decode's shotCountRule/pacingNote explicitly target a cut
 *   every 4-8 seconds; Empire Omitted's just said "8-10 shots maximum,
 *   keep it tight," with no per-shot duration target at all). On a ~10min
 *   episode that produced ~48 shots total -- an average hold of ~12.7s per
 *   shot, which reads as static/slow even after the zoom-motion fix, since
 *   the zoom is still bounded by a single shot's hold time. Confirmed this
 *   was NOT cross-channel contamination (Macro Decode's profile is a
 *   separate dict entry, selected per-channel via narration_style, and
 *   never shared) -- it was a pre-existing gap in Empire Omitted's own
 *   profile that simply hadn't been noticed yet. shotCountRule and
 *   pacingNote below now target the same 4-8s cut rhythm Macro Decode
 *   already uses. Separately, visualTypes' CLIP description was purely
 *   descriptive ("best for establishing shots, movement, atmosphere")
 *   with no concrete trigger telling the model when to actually choose it
 *   over STILL -- confirmed via a real render that zero shots ever got
 *   tagged CLIP, so Kling motion was never once invoked despite being
 *   fully wired up. Now explicitly REQUIRED for any shot depicting a
 *   person or moving object.
 */
require('dotenv').config();
'use strict';
const fs        = require('fs');
const path      = require('path');
const crypto    = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { getChannelConfigByLabel } = require('./config-reader.cjs');
const { validateEditPlan } = require('./edit-plan-validator.cjs');
const { validateShotDefinitions, planFingerprint } = require('./shot-definitions-validator.cjs');
// ─── Config ───────────────────────────────────────────────────────────────────
const MODEL      = 'claude-opus-4-5';
function log(msg) { console.log(msg); }
const MAX_TOKENS = 16000;
// Each profile is a self-contained visual language for one channel "voice".
// Selected by channel_dna.narration_style — see generateShotDefinitions().
const VISUAL_PROFILES = {
  // ── Empire Omitted — pacing/motion pass applied this session (see header) ──
  'dramatic-investigative': {
    overlayFieldName: 'cinematic',
    channelIdentityLine:
      'You are a visual director for Empire Omitted, a faceless YouTube documentary channel.',
    visualTypes: `
CLIP          - animated MP4 clip, best for establishing shots, movement, atmosphere
STILL         - static PNG, best for impact moments, reveals, text overlays
STILL_ZOOM    - slow Ken Burns zoom on PNG, best for portrait holds (max 10 seconds)
`.trim(),
    colorGrades: `
cold_blue     — opening, corporate offices, neutral exposition
gold_warm     — rise, success, money, early optimism
deep_shadow   — deception, secrets, boardroom betrayal, courtroom
red_alert     — collapse, fraud revealed, panic, arrest
neutral       — general purpose, transitions
desaturated   — human cost, grief, victims (act3b only)
`.trim(),
    imageStyleSuffix:
      `Cinematic 16:9 ultra-realistic dark documentary. Deep blacks, charcoal, gold accents (#C9A84C). No text or logos. No real people. Moody dramatic lighting. RED camera aesthetic. High contrast.`,
    overlayRules: `
CINEMATIC OVERLAY RULES (these are permanent defaults — never deviate):
Each shot may have a "cinematic" field for text overlays. Use these rules exactly:
NAMES and TITLES (when a person is first introduced):
  style: "slide_in", colour: "#C9A84C", size: 58, y: "h-text_h-80"
  Format: "FIRSTNAME LASTNAME — ROLE"
  Example: "KENNETH LAY — CEO"
DOLLAR AMOUNTS (any specific dollar figure mentioned in the narration):
  style: "stamp", colour: "#8B0000", size: 88, y: "(h-text_h)/2"
  Format: "$XX BILLION" or "$XX MILLION" etc
  Example: "$63 BILLION GONE"
IMPACT WORDS (single powerful words: FRAUD, GUILTY, BANKRUPT, GONE, LIES etc):
  style: "stamp", colour: "#8B0000", size: 100, y: "(h-text_h)/2"
  Example: "GUILTY. ON ALL COUNTS."
DATES (specific dates mentioned in narration):
  style: "stamp", colour: "#8B0000", size: 88, y: "(h-text_h)/2"
  Format: "MONTH DDth YEAR"
  Example: "OCTOBER 16TH 2001"
FACTUAL STATEMENTS (key facts from narration — 1 sentence max):
  style: "slide_in", colour: "#FFFFFF", size: 48, y: "h-text_h-80"
  Example: "SERVED 12 YEARS. RELEASED 2019."
INSTITUTIONS and ORGANISATIONS (companies, agencies, courts):
  style: "slide_in", colour: "#8B0000", size: 52, y: "h-text_h-80"
  Example: "ARTHUR ANDERSEN — SIGNED OFF. EVERY YEAR."
OUTRO / SUBSCRIBE shots:
  style: "slide_in", colour: "#C9A84C", size: 42, y: "h-text_h-80"
  Example: "EMPIRE OMITTED — THE STORIES THEY PAID TO KEEP QUIET"
NO OVERLAY: set cinematic to null for establishing shots, B-roll, and
  atmospheric shots where text would distract from the visual.
OVERLAY TEXT RULES:
  - UPPERCASE only
  - No double quotes in text (they break FFmpeg)
  - No commas in text (they break FFmpeg filter chains)
  - Max 60 characters per line
  - Be punchy — shorter is better
`.trim(),
    shotCountRule: 'Every act: 8-10 shots maximum (keep it tight - quality over quantity)',
    personalStakesNote: 'Act3b (human cost): desaturated grade and STILL or STILL_ZOOM only',
    pacingNote: 'estimatedDuration: seconds you estimate this shot will hold based on narration pacing.',
    sfxOptions: 'cash_register keyboard_typing gavel_bang phone_buzz alarm crowd_murmur paper_shred door_slam typing_fast news_alert',
    overlaySchema: `"cinematic": {
          "text": "OVERLAY TEXT IN UPPERCASE",
          "style": "slide_in|stamp",
          "colour": "#C9A84C|#8B0000|#FFFFFF",
          "size": <number>,
          "y": "h-text_h-80|(h-text_h)/2"
        }`,
  },
  // ── Macro Decode — new profile, per macro-decode-channel-dna-v2.md ───────
  'crisp-analytical-direct': {
    overlayFieldName: 'stat / lower',
    channelIdentityLine:
      'You are a motion-graphics director for Macro Decode, a premium faceless finance/macro explainer channel. Macro Decode explains the RULES of the economic game, not people breaking rules — no boardroom villains, no rise-and-fall arc, no dark-documentary tone.',
    visualTypes: `
DATA_VIZ      — animated chart/graph or counting-number graphic. Charts build dynamically, numbers count up on screen — static graphs are never used. Use this for every stat, trend, or comparison shot.
STILL         — clean static graphic or B-roll still, for context/transition moments only (not for a shot whose whole point is a number or trend — that must be DATA_VIZ)
STILL_ZOOM    — slow, subtle zoom on a still, for establishing/context shots only (max 8 seconds)
Do NOT use CLIP. Macro Decode does not use fal.ai-style cinematic camera-movement clips.
`.trim(),
    colorGrades: `
navy_base      — default background/context grade, deep navy (#0F2A4A)
gold_emphasis  — key stat reveal, the "turn" moment, contrarian claim
white_clean    — neutral exposition, factual explanation
amber_alert    — personal-stakes / "why this matters to you" moments
neutral        — general purpose, transitions
`.trim(),
    imageStyleSuffix:
      `Clean geometric motion-graphics style. Deep navy blue (#0F2A4A) background with gold/amber (#E8B34C) and white accent colors. Premium data-visualization aesthetic — modern finance-broadcast graphics, not photorealism. No dark documentary lighting, no cinematic RED-camera look, no scandal/courtroom imagery, no real people's faces. No text baked into the image — all text is added as a separate overlay.`,
    overlayRules: `
DATA-CALLOUT OVERLAY RULES (finance-explainer conventions — never deviate):
Each shot may have a "stat" field (a clean centred stat card: big value +
label + optional sub-caption) and/or a "lower" field (a name/title
lower-third, used for source citations). Do NOT invent a dollar-stamp or
impact-word "stamp" style — that is Empire Omitted's convention, not this
channel's. Set a field to null when this shot doesn't need it.
KEY STATISTIC (the number the shot is built around):
  "stat": { "value": "63%", "label": "OF RENTERS", "sub": "cannot afford a median 1BR (2025)" }
SOURCE / CITATION (data provenance — build trust, not drama):
  "lower": { "name": "Bureau of Labor Statistics", "title": "2025 Consumer Price Index" }
CONTRARIAN CLAIM / HOOK TEXT (the pattern-interrupt line — hook shots only):
  "stat": { "value": "MOSTLY RIGHT.", "label": "THE INDEX-FUND ADVICE YOU'VE HEARD IS", "sub": null }
TAKEAWAY (closing line, final shot only):
  "lower": { "name": "MACRO DECODE", "title": "The data behind the headline." }
NO OVERLAY: set both "stat" and "lower" to null for pure establishing/context shots.
OVERLAY TEXT RULES:
  - No double quotes in any text field (they break FFmpeg)
  - No commas within a single text field (they break FFmpeg filter chains)
  - Max 60 characters per line
  - Numbers/stats should read like a broadcast chyron, not a movie stamp — no ALL CAPS requirement
`.trim(),
    shotCountRule: 'As many shots as needed to keep the visual stimulus changing every 4–8 seconds (Macro Decode\'s editing-rhythm spec) — do not pad or under-cut this by forcing a fixed count per act.',
    personalStakesNote: '"Why it matters for you" segment (the personal-stakes beat in the Curiosity Loop): amber_alert grade, STILL or STILL_ZOOM only, direct-address framing',
    pacingNote: 'estimatedDuration: should generally fall within 4-8 seconds per shot, matching the "visual stimulus change every 4-8 seconds" pacing rule. Longer holds are only acceptable for a genuinely complex chart reveal.',
    sfxOptions: 'chart_tick number_blip whoosh_transition soft_alert page_turn keyboard_typing null',
    overlaySchema: `"stat": { "value": "...", "label": "...", "sub": "... or null" } | null,
        "lower": { "name": "...", "title": "..." } | null`,
  },
};
const DEFAULT_PROFILE_KEY = 'dramatic-investigative';
function pickProfile(narrationStyle) {
  if (narrationStyle && VISUAL_PROFILES[narrationStyle]) return narrationStyle;
  return DEFAULT_PROFILE_KEY;
}
// V3 production prompts enrich the locked plan; they never author its editorial
// structure. Six calls are made in the plan's fixed act order. A model response
// is accepted only when its beat IDs match the supplied list exactly.
const V3_COLOR_GRADES = new Set(['cold_blue', 'gold_warm', 'deep_shadow', 'red_alert', 'neutral', 'desaturated']);
const ACT_ORDER = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
const V3_SYSTEM_PROMPT = `You are the visual production breakdown writer for Empire Omitted.
The supplied edit-plan beats are locked editorial decisions. Do not create, remove,
reorder, merge, split, retime, rename, or reinterpret beats. Return exactly one
enrichment object for every supplied beat, in the same order, with its beatId
copied exactly. The beatId is only a join key; all other editorial fields are
owned by the supplied plan.

For EVIDENCE, imagePrompt must be null and sourceSearchInstruction must describe
the authentic source material to locate. Never fabricate documentary evidence,
documents, quotations, people, or provenance. For RECONSTRUCTION, imagePrompt
must describe an explicitly illustrative, non-identifiable reconstruction and
reconstructionSafeguards must say how it will avoid impersonating evidence.
For EDITORIAL_ILLUSTRATION, create explanatory imagery that does not claim to be
authentic source material. EVIDENCE beats must use an empty animationPrompt.
Generated CLIP beats need a concrete motion prompt; generated stills use an empty
animationPrompt. Use only these color grades: cold_blue, gold_warm,
deep_shadow, red_alert, neutral, desaturated.

When a beat contains a non-empty graphics specification, preserve it as locked
context. Do not create an image or animation prompt for it: graphics are compiled
separately. Return imagePrompt null and an empty animationPrompt for that beat.

Return JSON only, with this shape:
{"beats":[{"beatId":"...","imagePrompt":"... or null","negativePrompt":"...","sourceSearchInstruction":"... or null","animationPrompt":"... or empty string","reconstructionSafeguards":"... or null","colorGrade":"..."}]}`;

function atomicWriteFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(tempPath, filePath); }
  catch (error) { try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {} throw error; }
}

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function jsonSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateV3Act({ editPlan, episodeId, actKey, shots }) {
  const plan = { ...editPlan, timing: { ...editPlan.timing, acts: editPlan.timing.acts.filter(act => act.actKey === actKey) }, sequences: editPlan.sequences.filter(sequence => sequence.actKey === actKey) };
  const shotDefs = { shotDefinitionVersion: '1.0.0', mode: 'empire-omitted-v3', sourceEditPlanSha256: planFingerprint(plan), episodeId, title: editPlan.title, acts: { [actKey]: shots }, allShots: shots, totalShots: shots.length };
  return validateShotDefinitions({ plan, shotDefs });
}

function buildV3Audit({ editPlan, shotDefs }) {
  const shots = shotDefs.allShots || [];
  const countBy = key => Object.fromEntries([...new Set(shots.map(shot => String(shot[key] ?? 'null')))].sort().map(value => [value, shots.filter(shot => String(shot[key] ?? 'null') === value).length]));
  const promptEntries = shots.flatMap(shot => [['imagePrompt', shot.imagePrompt], ['negativePrompt', shot.negativePrompt], ['animationPrompt', shot.animationPrompt], ['sourceSearchInstruction', shot.sourceSearchInstruction], ['reconstructionSafeguards', shot.reconstructionSafeguards]].filter(([, value]) => typeof value === 'string' && value.trim()).map(([field, value]) => ({ beatId: shot.beatId, field, value })));
  const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nearDuplicatePromptGroups = [];
  for (let i = 0; i < promptEntries.length; i++) for (let j = i + 1; j < promptEntries.length; j++) {
    const a = new Set(normalize(promptEntries[i].value).split(/\s+/).filter(Boolean));
    const b = new Set(normalize(promptEntries[j].value).split(/\s+/).filter(Boolean));
    const union = new Set([...a, ...b]);
    const similarity = [...a].filter(word => b.has(word)).length / (union.size || 1);
    if (similarity >= 0.85) nearDuplicatePromptGroups.push({ beatIds: [promptEntries[i].beatId, promptEntries[j].beatId], similarity: Number(similarity.toFixed(3)) });
  }
  const malformedOrExcessivePrompts = promptEntries.filter(item => item.value.length > 1200 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(item.value)).map(({ beatId, field, value }) => ({ beatId, field, length: value.length }));
  const lockedText = shots.map(shot => `${shot.narrationExcerpt} ${shot.visualIntent} ${shot.visual?.description || ''} ${JSON.stringify(shot.graphics || [])} ${shot.evidenceRequirement?.description || ''}`).join(' ').toLowerCase();
  const factualClaimsIntroduced = shots.flatMap(shot => [shot.imagePrompt, shot.animationPrompt].filter(Boolean).flatMap(prompt => [...prompt.matchAll(/\b(?:19|20)\d{2}\b|\$\s?\d[\d,.]*(?:\s?(?:million|billion))?/gi)].map(match => ({ beatId: shot.beatId, claim: match[0] }))).filter(item => !lockedText.includes(item.claim.toLowerCase())));
  return {
    episodeId: editPlan.episodeId,
    definitionsByAct: countBy('actKey'), definitionsByVisualClass: countBy('visualClass'), definitionsByAssetType: countBy('assetType'),
    evidenceCount: shots.filter(s => s.visualClass === 'EVIDENCE').length,
    reconstructionCount: shots.filter(s => s.visualClass === 'RECONSTRUCTION').length,
    editorialIllustrationCount: shots.filter(s => s.visualClass === 'EDITORIAL_ILLUSTRATION').length,
    graphicTreatmentCount: shots.filter(s => s.requiresGraphicCompilation).length,
    intentionalStillnessCount: shots.filter(s => s.intentionalStillness === true).length,
    animationCandidateCount: shots.filter(s => s.assetType === 'generated_clip').length,
    sourcedAssetCount: 0,
    syntheticStillCount: shots.filter(s => s.assetType === 'generated_image').length,
    nearDuplicatePromptGroups, malformedOrExcessivePrompts,
    unresolvedProductionIntents: shots.filter(s => (s.assetType === 'evidence_reference' && !s.sourceSearchInstruction?.trim()) || (s.assetType === 'generated_image' && !s.imagePrompt?.trim()) || (s.assetType === 'generated_clip' && (!s.imagePrompt?.trim() || !s.animationPrompt?.trim())) || (s.assetType === 'graphic_compilation' && (s.imagePrompt !== null || !s.requiresGraphicCompilation))).map(s => s.beatId),
    unresolvedSourceRequirements: shots.filter(s => s.assetType === 'evidence_reference' && !s.sourceSearchInstruction?.trim()).map(s => s.beatId),
    unsupportedProviderHints: shots.filter(s => Object.keys(s).some(key => /provider|modelhint/i.test(key))).map(s => s.beatId),
    potentiallyMisleadingReconstruction: shots.filter(s => s.visualClass === 'RECONSTRUCTION' && !s.reconstructionSafeguards?.trim()).map(s => s.beatId),
    factualClaimsIntroduced,
  };
}

function v3BeatsForAct(editPlan, actKey) {
  return editPlan.sequences
    .filter(sequence => sequence.actKey === actKey)
    .flatMap(sequence => sequence.beats);
}

function projectV3Shot({ beat, enrichment }) {
  const requiresGraphicCompilation = Array.isArray(beat.graphics) && beat.graphics.length > 0;
  const assetType = beat.visualClass === 'EVIDENCE'
    ? 'evidence_reference'
    : requiresGraphicCompilation ? 'graphic_compilation'
      : beat.visual.type === 'CLIP' ? 'generated_clip' : 'generated_image';
  const firstNarrationWord = beat.narrationExcerpt.trim().split(/\s+/)[0];
  return {
    shotId: beat.beatId,
    beatId: beat.beatId,
    sequenceId: beat.sequenceId,
    actKey: beat.actKey,
    startWordIndex: beat.startWordIndex,
    endWordIndex: beat.endWordIndex,
    startSec: beat.startSec,
    endSec: beat.endSec,
    durationSec: beat.durationSec,
    narrationExcerpt: beat.narrationExcerpt,
    storyFunction: beat.storyFunction,
    visualIntent: beat.visualIntent,
    visualClass: beat.visualClass,
    rhythmIntent: beat.rhythmIntent,
    visual: structuredClone(beat.visual),
    visualType: beat.visual.type,
    motionIntent: structuredClone(beat.motionIntent),
    motionTreatment: structuredClone(beat.motionIntent),
    intentionalStillness: beat.intentionalStillness,
    timingExceptionReason: beat.timingExceptionReason,
    postNarrationHoldSec: beat.postNarrationHoldSec,
    reconstructionMode: beat.reconstructionMode,
    continuityRefs: structuredClone(beat.continuityRefs),
    evidenceRequirement: structuredClone(beat.evidenceRequirement),
    graphics: structuredClone(beat.graphics),
    overlaySpecification: structuredClone(beat.graphics),
    audioDirection: structuredClone(beat.audioDirection),
    triggerWord: firstNarrationWord,
    hardcodedSec: null,
    estimatedDuration: beat.durationSec,
    assetType,
    requiresGraphicCompilation,
    imagePrompt: enrichment.imagePrompt,
    negativePrompt: enrichment.negativePrompt,
    sourceSearchInstruction: enrichment.sourceSearchInstruction,
    animationPrompt: enrichment.animationPrompt,
    reconstructionSafeguards: enrichment.reconstructionSafeguards,
    colorGrade: enrichment.colorGrade,
    sfx: null,
  };
}

async function generateV3ShotDefinitions({
  script, outputDir = null, channel = null, editPlan, editPlanValidation,
  wordTimestamps, client: injectedClient, createClient, sourceManifest = null,
}) {
  if (channel !== 'EmpireOmitted') {
    throw new Error('[shot-defs] V3 shot planning is restricted to EmpireOmitted.');
  }
  if (!script?.acts) throw new Error('[shot-defs] script.acts is required');
  if (!editPlan || editPlan.channel !== 'EmpireOmitted' || editPlanValidation?.status !== 'PASS') {
    throw new Error('[shot-defs] V3 requires an edit plan with PASS validation; script-only generation is prohibited.');
  }
  const planValidation = validateEditPlan({ plan: editPlan, wordTimestamps });
  if (planValidation.status !== 'PASS') {
    const first = planValidation.errors[0];
    throw new Error(`[shot-defs] V3 edit plan failed deterministic validation: ${first.code} ${first.path}`);
  }

  const actKeys = editPlan.timing.acts.map(act => act.actKey);
  if (actKeys.length !== 6 || actKeys.some((actKey, index) => actKey !== ACT_ORDER[index])) {
    throw new Error('[shot-defs] V3 edit plan must contain all six acts in playback order.');
  }

  const candidatePath = outputDir ? path.join(outputDir, 'shot-definitions.json') : null;
  if (candidatePath && fs.existsSync(candidatePath)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(candidatePath, 'utf8')); }
    catch (error) { throw new Error(`[shot-defs] Existing candidate is invalid JSON and will not be overwritten: ${error.message}`); }
    const existingReport = validateShotDefinitions({ plan: editPlan, shotDefs: existing });
    if (existingReport.status !== 'PASS') throw new Error(`[shot-defs] Existing candidate is invalid and will not be overwritten: ${existingReport.errors[0].code} ${existingReport.errors[0].path}`);
    return existing;
  }

  let client = injectedClient || null;
  const getClient = () => {
    if (!client) client = typeof createClient === 'function' ? createClient() : new Anthropic();
    return client;
  };
  const checkpointPath = outputDir ? path.join(outputDir, '.shot-definitions-checkpoint.json') : null;
  const fullPlanFingerprint = planFingerprint(editPlan);
  const checkpointVersion = 1;
  let checkpoint = { checkpointVersion, episodeId: editPlan.episodeId, channel, planFingerprint: fullPlanFingerprint, providerCalls: 0, spendReservedUsd: 0, acts: {} };
  if (checkpointPath && fs.existsSync(checkpointPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      if (saved?.checkpointVersion === checkpointVersion && saved.episodeId === editPlan.episodeId
        && saved.channel === channel && saved.planFingerprint === fullPlanFingerprint
        && saved.acts && typeof saved.acts === 'object' && !Array.isArray(saved.acts)) checkpoint = saved;
    } catch (_) { /* Invalid checkpoint ignored; successful new acts replace it atomically. */ }
  }
  if (outputDir && sourceManifest) atomicWriteJson(path.join(outputDir, 'candidate-source-manifest.json'), sourceManifest);
  if (!Number.isInteger(checkpoint.providerCalls) || checkpoint.providerCalls < 0) checkpoint.providerCalls = 0;
  const requestByAct = {};
  const reusableByAct = {};
  for (const actKey of ACT_ORDER) {
    const beats = v3BeatsForAct(editPlan, actKey);
    if (!beats.length) throw new Error(`[shot-defs] V3 edit plan has no beats for ${actKey}.`);
    const requestBeats = beats.map(beat => ({
      beatId: beat.beatId, sequenceId: beat.sequenceId, narrationExcerpt: beat.narrationExcerpt,
      storyFunction: beat.storyFunction, visualIntent: beat.visualIntent, visualClass: beat.visualClass,
      visual: beat.visual, motionIntent: beat.motionIntent, intentionalStillness: beat.intentionalStillness,
      timingExceptionReason: beat.timingExceptionReason, reconstructionMode: beat.reconstructionMode,
      evidenceRequirement: beat.evidenceRequirement, graphics: beat.graphics,
    }));
    const prompt = `Create production enrichment for ${actKey}. Treat every supplied beat as locked.
Return one enrichment object per input beat, in input order, with each beatId unchanged.
Prompt detail must be sufficient for a visual asset team. Do not add words, names,
documents, or facts beyond the supplied context. Color grade must be from the
allowlist in the system prompt. EVIDENCE gets a source-search instruction and no
image-generation prompt. Other classes get image and negative prompts. A generated
CLIP gets an animation prompt; stills and EVIDENCE get an empty animationPrompt.
If graphics is non-empty, set imagePrompt to null and animationPrompt to an empty
string; it requires graphic compilation and must not be treated as a generated image.

LOCKED BEATS:\n${JSON.stringify(requestBeats)}`;
    const request = { model: MODEL, max_tokens: MAX_TOKENS, system: V3_SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] };
    requestByAct[actKey] = request;
    const savedAct = checkpoint.acts[actKey];
    reusableByAct[actKey] = Boolean(savedAct?.requestFingerprint === jsonSha256(request)
      && Array.isArray(savedAct?.shots) && savedAct.shotsSha256 === jsonSha256(savedAct.shots)
      && validateV3Act({ editPlan, episodeId: editPlan.episodeId, actKey, shots: savedAct.shots }).status === 'PASS');
  }
  const missingActs = ACT_ORDER.filter(actKey => !reusableByAct[actKey]);
  const estimatedInputTokens = missingActs.reduce((sum, actKey) => {
    const request = requestByAct[actKey];
    return sum + Math.ceil(Buffer.byteLength(`${request.system}\n${request.messages[0].content}`, 'utf8') / 3);
  }, 0);
  const estimatedMaximumCost = (estimatedInputTokens * 3 + missingActs.length * MAX_TOKENS * 15) / 1_000_000;
  if (estimatedMaximumCost > 5) throw new Error(`[shot-defs] Preflight estimate $${estimatedMaximumCost.toFixed(2)} exceeds the authorized $5 ceiling; no model calls made.`);
  if (!Number.isFinite(checkpoint.spendReservedUsd) || checkpoint.spendReservedUsd < 0) checkpoint.spendReservedUsd = 0;
  if (checkpoint.spendReservedUsd + estimatedMaximumCost > 5) throw new Error(`[shot-defs] Preflight estimate $${(checkpoint.spendReservedUsd + estimatedMaximumCost).toFixed(2)} exceeds the authorized $5 ceiling; no model calls made.`);
  const acts = {};
  const allShots = [];
  const usageByAct = {};
  for (const actKey of ACT_ORDER) {
    const beats = v3BeatsForAct(editPlan, actKey);
    const request = requestByAct[actKey];
    const requestFingerprint = jsonSha256(request);
    let actShots = null;
    const savedAct = checkpoint.acts[actKey];
    if (reusableByAct[actKey]) {
      actShots = savedAct.shots;
      usageByAct[actKey] = savedAct.usage || null;
    }
    if (!actShots) {
      const requestTokensEstimate = Math.ceil(Buffer.byteLength(`${request.system}\n${request.messages[0].content}`, 'utf8') / 3);
      const reservedCallCost = (requestTokensEstimate * 3 + MAX_TOKENS * 15) / 1_000_000;
      if (checkpoint.spendReservedUsd + reservedCallCost > 5) throw new Error('[shot-defs] The next request could exceed the authorized $5 ceiling; stopped before the model call.');
      const activeClient = getClient();
      checkpoint.providerCalls += 1;
      checkpoint.spendReservedUsd += reservedCallCost;
      if (checkpointPath) atomicWriteJson(checkpointPath, checkpoint);
      const response = await activeClient.messages.create(request);
      const raw = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
      let parsed;
      try { parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim()); }
      catch (error) { throw new Error(`[shot-defs] V3 ${actKey} enrichment returned malformed JSON: ${error.message}`); }
      if (!Array.isArray(parsed?.beats) || parsed.beats.length !== beats.length) {
        throw new Error(`[shot-defs] V3 ${actKey} enrichment must return exactly ${beats.length} beat(s).`);
      }
      const byId = new Map();
      for (const [index, enrichment] of parsed.beats.entries()) {
        if (!enrichment || typeof enrichment.beatId !== 'string') throw new Error(`[shot-defs] V3 ${actKey} enrichment is missing beatId at index ${index}.`);
        if (byId.has(enrichment.beatId)) throw new Error(`[shot-defs] V3 ${actKey} enrichment duplicated beatId ${enrichment.beatId}.`);
        if (enrichment.beatId !== beats[index].beatId) throw new Error(`[shot-defs] V3 ${actKey} enrichment order/identity mismatch at ${beats[index].beatId}.`);
        byId.set(enrichment.beatId, enrichment);
      }
      actShots = beats.map(beat => projectV3Shot({ beat, enrichment: byId.get(beat.beatId) }));
      const actReport = validateV3Act({ editPlan, episodeId: editPlan.episodeId, actKey, shots: actShots });
      if (actReport.status !== 'PASS') throw new Error(`[shot-defs] V3 ${actKey} failed act validation: ${actReport.errors[0].code} ${actReport.errors[0].path}`);
      usageByAct[actKey] = response.usage ? { inputTokens: response.usage.input_tokens ?? null, outputTokens: response.usage.output_tokens ?? null } : null;
      checkpoint.acts[actKey] = { requestFingerprint, shots: actShots, shotsSha256: jsonSha256(actShots), usage: usageByAct[actKey] };
      if (checkpointPath) atomicWriteJson(checkpointPath, checkpoint);
    }
    acts[actKey] = actShots;
    allShots.push(...actShots);
  }

  const shotDefs = {
    shotDefinitionVersion: '1.0.0',
    mode: 'empire-omitted-v3',
    sourceEditPlanSha256: fullPlanFingerprint,
    episodeId: editPlan.episodeId,
    topic: script.topic,
    title: editPlan.title,
    acts,
    allShots,
    totalShots: allShots.length,
  };
  const report = validateShotDefinitions({ plan: editPlan, shotDefs });
  if (report.status !== 'PASS') {
    const first = report.errors[0];
    throw new Error(`[shot-defs] V3 shot-definition validation failed: ${first.code} ${first.path}`);
  }
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    atomicWriteJson(path.join(outputDir, 'shot-definitions.json'), shotDefs);
    atomicWriteFile(path.join(outputDir, 'shot-definitions-summary.txt'), buildSummaryText(shotDefs));
    atomicWriteJson(path.join(outputDir, 'shot-definitions-audit.json'), buildV3Audit({ editPlan, shotDefs }));
    atomicWriteJson(path.join(outputDir, 'shot-definitions-usage.json'), {
      model: MODEL, calls: checkpoint.providerCalls, usageByAct,
      inputTokens: Object.values(usageByAct).reduce((sum, usage) => sum + (usage?.inputTokens || 0), 0),
      outputTokens: Object.values(usageByAct).reduce((sum, usage) => sum + (usage?.outputTokens || 0), 0),
    });
  }
  return shotDefs;
}

// Mode is explicit at the runner boundary. The default retains direct-call
// compatibility for the legacy, non-V3 command-line workflow.
async function generateShotDefinitions(options = {}) {
  const mode = options.mode || 'legacy';
  if (mode === 'v3') return generateV3ShotDefinitions(options);
  if (mode !== 'legacy') throw new Error(`[shot-defs] Unsupported generation mode: ${mode}`);
  return generateLegacyShotDefinitions(options);
}

// ─── Legacy, script-only generator for non-V3 jobs ───────────────────────────
async function generateLegacyShotDefinitions({ script, outputDir = null, channel = null, client: injectedClient }) {
  if (!script?.acts) throw new Error('[shot-defs] script.acts is required');
  let profileKey = DEFAULT_PROFILE_KEY;
  if (channel) {
    try {
      const dna = await getChannelConfigByLabel(channel);
      profileKey = pickProfile(dna.narration_style);
      log(`[shot-defs] Channel: ${channel} | narration_style: ${dna.narration_style || '(none)'} | profile: ${profileKey}`);
    } catch (e) {
      log(`[shot-defs] WARNING: could not load channel DNA: ${e.message} — using default profile (${DEFAULT_PROFILE_KEY})`);
    }
  }
  const profile = VISUAL_PROFILES[profileKey];
  const client = injectedClient || new Anthropic();
  console.log(`[shot-defs] Generating shot definitions for: "${script.topic}" (profile: ${profileKey})`);
  const systemPrompt = `${profile.channelIdentityLine}
Your job is to read a script and create a complete shot map with overlays.
VISUAL TYPES:
${profile.visualTypes}
COLOUR GRADES:
${profile.colorGrades}
${profile.overlayRules}
TRIGGER WORD RULES (CRITICAL):
- triggerWord must be a SINGLE word that appears VERBATIM in the voScript
- Choose words that are distinctive and unlikely to repeat in the same act
- Numbers: use the digit form — "24" not "twenty-four" — because Whisper transcribes spoken numbers as digits
- Dollar amounts: use just the number — "63" not "$63" — Whisper strips the dollar sign
- Hyphenated words: use just the first part — "sarbanes" not "sarbanes-oxley"
- Multi-word phrases: pick just ONE word from them
SHOT RULES:
- ${profile.shotCountRule}
- ${profile.personalStakesNote}
- shotId format: ACT1_001 ACT2_001 ACT3_001 ACT3B_001 ACT4_001 ACT5_001
- ${profile.pacingNote}
- animationPrompt: only relevant if your VISUAL TYPES list above includes CLIP. Leave as an empty string for every other visual type.
- sfx: null or one of: ${profile.sfxOptions}
RESPONSE FORMAT — ONLY valid JSON no markdown no preamble:
{
  "topic": "<topic>",
  "totalShots": <number>,
  "acts": {
    "act1": [
      {
        "shotId": "ACT1_001",
        "actKey": "act1",
        "triggerWord": "single word from script",
        "visualType": "<one of the VISUAL TYPES listed above>",
        "estimatedDuration": <seconds>,
        "imagePrompt": "Detailed prompt... ${profile.imageStyleSuffix}",
        "animationPrompt": "Camera movement description — only if this channel's VISUAL TYPES include CLIP. Empty string otherwise.",
        "colorGrade": "<one of the COLOUR GRADES listed above>",
        "sfx": null,
        ${profile.overlaySchema},
        "notes": "Director note"
      }
    ],
    "act2": [...],
    "act3": [...],
    "act3b": [...],
    "act4": [...],
    "act5": [...]
  }
}
For shots with NO overlay, set the overlay field(s) shown above to null`;
  // ── Split generation: acts 1-3 first, then 3b-5 ──────────────────────────
  // Each call generates half the shots to avoid JSON truncation
  const actsFirstHalf  = ['act1', 'act2', 'act3'];
  const actsSecondHalf = ['act3b', 'act4', 'act5'];
  const firstHalfSummary = Object.entries(script.acts)
    .filter(([key]) => actsFirstHalf.includes(key))
    .map(([key, act]) => `## ${key.toUpperCase()} — ${act.label}\n${act.voScript}`)
    .join('\n\n');
  const secondHalfSummary = Object.entries(script.acts)
    .filter(([key]) => actsSecondHalf.includes(key))
    .map(([key, act]) => `## ${key.toUpperCase()} — ${act.label}\n${act.voScript}`)
    .join('\n\n');
  const makePrompt = (actSummary, actsToGenerate) => `Create shot definitions with overlays for:
TOPIC: ${script.topic}
TITLE: ${script.title}
GENERATE ONLY THESE ACTS: ${actsToGenerate.join(', ')}
SCRIPTS:
${actSummary}
IMAGE STYLE SUFFIX to append to every imagePrompt:
"${profile.imageStyleSuffix}"
Remember: triggerWord must be a SINGLE word in digit form for numbers.
Return only JSON with just the acts listed above. No markdown. No preamble.
Format:
{
  "acts": {
    "${actsToGenerate[0]}": [...],
    "${actsToGenerate[1]}": [...],
    "${actsToGenerate[2]}": [...]
  }
}`;
  const callClaude = async (prompt, label) => {
    const msg = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: prompt }],
    });
    const raw   = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      return JSON.parse(clean);
    } catch (err) {
      log(`[shot-defs] ${label} JSON truncated — retrying...`);
      const retryMsg = await client.messages.create({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     systemPrompt,
        messages:   [
          { role: 'user',      content: prompt },
          { role: 'assistant', content: clean },
          { role: 'user',      content: 'The JSON was truncated. Please restart with a maximum of 7 shots per act. Return only complete valid JSON.' },
        ],
      });
      const retryRaw   = retryMsg.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const retryClean = retryRaw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
      try {
        return JSON.parse(retryClean);
      } catch (err2) {
        throw new Error(`[shot-defs] ${label} JSON parse failed after retry.\nError: ${err2.message}\nRaw: ${retryClean.slice(0,300)}`);
      }
    }
  };
  log('[shot-defs] Generating acts 1-3...');
  const firstHalf  = await callClaude(makePrompt(firstHalfSummary,  actsFirstHalf),  'acts1-3');
  log('[shot-defs] Generating acts 3b-5...');
  const secondHalf = await callClaude(makePrompt(secondHalfSummary, actsSecondHalf), 'acts3b-5');
  // Merge both halves into one shotDefs object
  let shotDefs = {
    topic: script.topic,
    acts: {
      ...firstHalf.acts,
      ...secondHalf.acts,
    }
  };
  // Validate
  const requiredActs = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  for (const act of requiredActs) {
    if (!Array.isArray(shotDefs.acts?.[act])) {
      throw new Error(`[shot-defs] Missing shots array for ${act}`);
    }
  }
  // Sanitise overlay text — strip chars that break FFmpeg. Handles both
  // Empire Omitted's legacy "cinematic" field and the new "stat"/"lower"
  // fields, since which one is present depends on the channel's profile.
  const cleanText = (value, { forceUpper = false } = {}) => {
    if (typeof value !== 'string') return value;
    let out = value.replace(/"/g, '').replace(/,/g, '').trim();
    if (forceUpper) out = out.toUpperCase();
    return out;
  };
  for (const act of requiredActs) {
    for (const shot of shotDefs.acts[act]) {
      if (shot.cinematic?.text) {
        shot.cinematic.text = cleanText(shot.cinematic.text, { forceUpper: true });
      }
      if (shot.stat) {
        if (shot.stat.value) shot.stat.value = cleanText(shot.stat.value);
        if (shot.stat.label) shot.stat.label = cleanText(shot.stat.label);
        if (shot.stat.sub)   shot.stat.sub   = cleanText(shot.stat.sub);
      }
      if (shot.lower) {
        if (shot.lower.name)  shot.lower.name  = cleanText(shot.lower.name);
        if (shot.lower.title) shot.lower.title = cleanText(shot.lower.title);
      }
    }
  }
  // Build flat allShots array
  const allShots = [];
  for (const actKey of requiredActs) {
    for (const shot of shotDefs.acts[actKey]) {
      allShots.push(shot);
    }
  }
  shotDefs.allShots    = allShots;
  shotDefs.totalShots  = allShots.length;
  const withOverlays = allShots.filter(s => s.cinematic || s.stat || s.lower).length;
  console.log(`[shot-defs] Complete — ${shotDefs.totalShots} shots | ${withOverlays} with overlays`);
  for (const actKey of requiredActs) {
    console.log(`  ${actKey}: ${shotDefs.acts[actKey].length} shots`);
  }
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    const jsonPath    = path.join(outputDir, 'shot-definitions.json');
    const summaryPath = path.join(outputDir, 'shot-definitions-summary.txt');
    fs.writeFileSync(jsonPath,    JSON.stringify(shotDefs, null, 2), 'utf8');
    fs.writeFileSync(summaryPath, buildSummaryText(shotDefs),        'utf8');
    console.log(`[shot-defs] Saved → ${jsonPath}`);
  }
  return shotDefs;
}
function describeOverlay(s) {
  if (s.cinematic) return `[${s.cinematic.style}]: ${s.cinematic.text}`;
  if (s.stat)      return `[stat]: ${s.stat.value} — ${s.stat.label}`;
  if (s.lower)     return `[lower]: ${s.lower.name} — ${s.lower.title}`;
  return null;
}
function buildSummaryText(shotDefs) {
  const lines = [
    `SHOT DEFINITIONS — ${shotDefs.topic}`,
    `Total: ${shotDefs.totalShots} shots`,
    '='.repeat(60), '',
  ];
  for (const actKey of ['act1','act2','act3','act3b','act4','act5']) {
    const shots = shotDefs.acts[actKey];
    if (!shots) continue;
    lines.push(`--- ${actKey.toUpperCase()} (${shots.length} shots) ---`);
    for (const s of shots) {
      lines.push(`  ${s.shotId}  [${s.visualType}]  TRIGGER:"${s.triggerWord}"  GRADE:${s.colorGrade}  ~${s.estimatedDuration}s`);
      const overlayDesc = describeOverlay(s);
      if (overlayDesc) lines.push(`    OVERLAY ${overlayDesc}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
if (require.main === module) {
  const scriptPath = process.argv[2];
  const outputDir  = process.argv[3] || null;
  const channel    = process.argv[4] || null;
  const mode       = process.argv[5] || 'legacy';
  const candidateArg = process.argv.indexOf('--candidate-output-dir');
  const candidateOutputDir = candidateArg >= 0 ? process.argv[candidateArg + 1] : null;
  if (!scriptPath) {
    console.error('Usage: node surface-shot-definitions.cjs <script.json> [outputDir] [channel]');
    process.exit(1);
  }
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const planInput = mode === 'v3'
    ? require('./shot-definitions-validator.cjs').loadValidatedV3Plan({ episodeDir: outputDir })
    : {};
  const hashFile = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const sourceManifest = mode === 'v3' ? {
    sourceEpisodeDir: path.resolve(outputDir),
    scriptPath: path.resolve(scriptPath), scriptSha256: hashFile(scriptPath),
    editPlanPath: path.join(path.resolve(outputDir), 'edit-plan.json'), editPlanSha256: hashFile(path.join(outputDir, 'edit-plan.json')),
    validationPath: path.join(path.resolve(outputDir), 'edit-plan-validation.json'), validationSha256: hashFile(path.join(outputDir, 'edit-plan-validation.json')),
  } : null;
  generateShotDefinitions({ script, outputDir: candidateOutputDir || outputDir, channel, mode, sourceManifest, ...planInput })
    .catch(err => { console.error('[shot-defs] FATAL:', err.message); process.exit(1); });
}
module.exports = { generateShotDefinitions, generateV3ShotDefinitions, generateLegacyShotDefinitions };
