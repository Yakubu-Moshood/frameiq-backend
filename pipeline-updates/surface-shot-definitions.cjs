/**
 * surface-shot-definitions.cjs
 * Surface Pipeline v2 — Module 0C
 *
 * Takes a script and returns shot-definitions.json with:
 *   - triggerWord (single word, verbatim from script)
 *   - visualType, imagePrompt, animationPrompt, colorGrade, sfx
 *   - cinematic overlay (auto-generated, EP4-approved style)
 *
 * OVERLAY STYLE RULES (locked from EP4 approval):
 *   Names/titles     → slide_in  gold  #C9A84C  size 58  bottom left
 *   Dollar amounts   → stamp     red   #8B0000  size 88  centre
 *   Impact words     → stamp     red   #8B0000  size 100 centre
 *   Dates            → stamp     red   #8B0000  size 88  centre
 *   Factual lines    → slide_in  white #FFFFFF  size 48  bottom left
 *   Institutions     → slide_in  red   #8B0000  size 52  bottom left
 *   Outro/subscribe  → slide_in  gold  #C9A84C  size 42  bottom left
 *   No overlay       → null
 */

require('dotenv').config();
'use strict';

const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Config ───────────────────────────────────────────────────────────────────

const MODEL      = 'claude-opus-4-5';
function log(msg) { console.log(msg); }
const MAX_TOKENS = 16000;

const VISUAL_TYPES = `
CLIP          — animated MP4 clip, best for establishing shots, movement, atmosphere
STILL         — static PNG, best for impact moments, reveals, text overlays
STILL_ZOOM    — slow Ken Burns zoom on PNG, best for portrait holds (max 10 seconds)
`.trim();

const COLOR_GRADES = `
cold_blue     — opening, corporate offices, neutral exposition
gold_warm     — rise, success, money, early optimism
deep_shadow   — deception, secrets, boardroom betrayal, courtroom
red_alert     — collapse, fraud revealed, panic, arrest
neutral       — general purpose, transitions
desaturated   — human cost, grief, victims (act3b only)
`.trim();

const IMAGE_STYLE_SUFFIX = `Cinematic 16:9 ultra-realistic dark documentary. Deep blacks, charcoal, gold accents (#C9A84C). No text or logos. No real people. Moody dramatic lighting. RED camera aesthetic. High contrast.`;

// EP4-approved overlay style rules — locked permanently
const OVERLAY_STYLE_RULES = `
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
`.trim();

// ─── Main export ──────────────────────────────────────────────────────────────

async function generateShotDefinitions({ script, outputDir = null }) {
  if (!script?.acts) throw new Error('[shot-defs] script.acts is required');

  const client = new Anthropic();
  console.log(`[shot-defs] Generating shot definitions for: "${script.topic}"`);

  const systemPrompt = `You are a visual director for Empire Omitted, a faceless YouTube documentary channel.
Your job is to read a documentary script and create a complete shot map with cinematic overlays.

VISUAL TYPES:
${VISUAL_TYPES}

COLOUR GRADES:
${COLOR_GRADES}

${OVERLAY_STYLE_RULES}

TRIGGER WORD RULES (CRITICAL):
- triggerWord must be a SINGLE word that appears VERBATIM in the voScript
- Choose words that are distinctive and unlikely to repeat in the same act
- Numbers: use the digit form — "24" not "twenty-four" — because Whisper transcribes spoken numbers as digits
- Dollar amounts: use just the number — "63" not "$63" — Whisper strips the dollar sign
- Hyphenated words: use just the first part — "sarbanes" not "sarbanes-oxley"
- Multi-word phrases: pick just ONE word from them

SHOT RULES:
- Every act: 8–10 shots maximum (keep it tight — quality over quantity)
- Act3b (human cost): desaturated grade and STILL or STILL_ZOOM only
- shotId format: ACT1_001 ACT2_001 ACT3_001 ACT3B_001 ACT4_001 ACT5_001
- estimatedDuration: seconds you estimate this shot will hold based on narration pacing
- animationPrompt: for CLIP shots only — describe camera movement for fal.ai Kling
- sfx: null or one of: cash_register keyboard_typing gavel_bang phone_buzz alarm crowd_murmur paper_shred door_slam typing_fast news_alert

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
        "visualType": "CLIP|STILL|STILL_ZOOM",
        "estimatedDuration": <seconds>,
        "imagePrompt": "Detailed cinematic prompt... ${IMAGE_STYLE_SUFFIX}",
        "animationPrompt": "Camera movement description for CLIP shots. Empty string for STILL/STILL_ZOOM.",
        "colorGrade": "cold_blue|gold_warm|deep_shadow|red_alert|neutral|desaturated",
        "sfx": null,
        "cinematic": {
          "text": "OVERLAY TEXT IN UPPERCASE",
          "style": "slide_in|stamp",
          "colour": "#C9A84C|#8B0000|#FFFFFF",
          "size": <number>,
          "y": "h-text_h-80|(h-text_h)/2"
        },
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

For shots with NO overlay set "cinematic": null`;

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

  const makePrompt = (actSummary, actsToGenerate) => `Create shot definitions with cinematic overlays for:

TOPIC: ${script.topic}
TITLE: ${script.title}

GENERATE ONLY THESE ACTS: ${actsToGenerate.join(', ')}

SCRIPTS:
${actSummary}

IMAGE STYLE SUFFIX to append to every imagePrompt:
"${IMAGE_STYLE_SUFFIX}"

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

  // Sanitise overlay text — strip chars that break FFmpeg
  for (const act of requiredActs) {
    for (const shot of shotDefs.acts[act]) {
      if (shot.cinematic?.text) {
        shot.cinematic.text = shot.cinematic.text
          .replace(/"/g, '')
          .replace(/,/g, '')
          .toUpperCase()
          .trim();
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

  const withOverlays = allShots.filter(s => s.cinematic).length;
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
      if (s.cinematic) lines.push(`    OVERLAY [${s.cinematic.style}]: ${s.cinematic.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (require.main === module) {
  const scriptPath = process.argv[2];
  const outputDir  = process.argv[3] || null;
  if (!scriptPath) {
    console.error('Usage: node surface-shot-definitions.cjs <script.json> [outputDir]');
    process.exit(1);
  }
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  generateShotDefinitions({ script, outputDir })
    .catch(err => { console.error('[shot-defs] FATAL:', err.message); process.exit(1); });
}

module.exports = { generateShotDefinitions };
