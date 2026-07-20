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
const Anthropic = require('@anthropic-ai/sdk');
const { getChannelConfigByLabel } = require('./config-reader.cjs');
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
CLIP          — animated MP4 clip via Kling motion. REQUIRED for any shot depicting a
                person performing an action, a moving object (hands signing documents,
                money changing hands, cars, crowds, walking, gesturing), or anything that
                would look dead/static as a photo. Do not default to STILL for these.
STILL         — static PNG, best for symbolic imagery, text-heavy reveals, and impact
                moments where the shot's own held tension sells the beat.
STILL_ZOOM    — slow Ken Burns zoom on PNG, best for portrait holds (max 10 seconds)
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
    shotCountRule: 'Every act: 12-20 shots — favour MORE shots over fewer. Each visual should hold on screen roughly 4-8 seconds, matching a cut every 4-8 seconds; a shot running past 10 seconds should be a rare, deliberate exception (e.g. a STILL_ZOOM carrying a slow reveal), not the norm.',
    personalStakesNote: 'Act3b (human cost): desaturated grade and STILL or STILL_ZOOM only',
    pacingNote: 'estimatedDuration: MUST generally fall within 4-8 seconds per shot, matching the "visual stimulus change every 4-8 seconds" pacing rule used elsewhere in this pipeline. Only exceed 8s for a genuinely deliberate slow reveal, and never exceed 10s.',
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
// ─── Main export ──────────────────────────────────────────────────────────────
async function generateShotDefinitions({ script, outputDir = null, channel = null }) {
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
  const client = new Anthropic();
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
  if (!scriptPath) {
    console.error('Usage: node surface-shot-definitions.cjs <script.json> [outputDir] [channel]');
    process.exit(1);
  }
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  generateShotDefinitions({ script, outputDir, channel })
    .catch(err => { console.error('[shot-defs] FATAL:', err.message); process.exit(1); });
}
module.exports = { generateShotDefinitions };
