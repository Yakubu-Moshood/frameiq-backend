'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getChannelConfigByLabel } = require('./config-reader.cjs');

const MODEL = 'claude-opus-4-5';
const MAX_TOKENS = 16000;
const FIXED_EPISODE_OPENING_LINE =
  "This is Empire Omitted, bringing you the story they didn't want told.";

const EPISODE_OPENING_INSTRUCTIONS = `EPISODE OPEN — REQUIRED:
Return an "episode_open" object containing exactly two fields:
- "setupSentenceA": one sentence establishing the subject at its peak or high point. It must name a specific timeframe and a specific figure or concrete achievement.
- "setupSentenceB": one sentence establishing the fall. It must use a later timeframe described relative to sentence A (for example, "Nine months later" or "Four years later"), state the collapsed condition, and state the consequence for the key figure after an em dash.

The two sentences must form a concise peak-then-fall pair. They are continuous narration, not captions, stamps, headings, labels, or fragments. End each field with sentence punctuation. Do not repeat them in act1. Act1 must begin with the existing cold-open content that follows this separate episode opening.

Use this exact shape:
"episode_open": {
  "setupSentenceA": "<timeframe + subject + peak state with a specific figure or achievement>",
  "setupSentenceB": "<relative later timeframe + fallen state — and key figure + consequence>"
}

Worked examples:

WeWork
"episode_open": {
  "setupSentenceA": "In January of 2019, WeWork was worth 47 billion dollars.",
  "setupSentenceB": "Nine months later, it was worth almost nothing — and the man who built it was gone."
}

Theranos
"episode_open": {
  "setupSentenceA": "In 2014, Theranos was worth 9 billion dollars.",
  "setupSentenceB": "Four years later, it was worth nothing — and the woman who built it was facing criminal charges."
}

Generate only these two subject-specific setup sentences. Do not generate, quote, paraphrase, or include a channel-identification line; the application inserts that fixed line after these fields.`;

function buildScriptConfig(dna) {
  const mins = dna.target_length_minutes || 10;
  const totalWords = Math.round(mins * 120);
  const channelLabel = dna.label || 'FraymIQ';
  const styleMap = {
    'dramatic-investigative': [
      'Tone: Authoritative, dramatic, measured. Like a serious BBC/Netflix documentary narrator.',
      'Sentence rhythm: Short punches. Long builds. Then a short punch again.',
      'Use ellipsis (...) for dramatic pauses within sentences.',
      'Each act ends on a cliffhanger or pivot that pulls the viewer forward.',
      'No filler phrases. No first-person narrator opinion. Let the facts do the work.',
      'Numbers always written with commas and currency symbols.',
      'Avoid passive voice where possible. Make it visceral.',
    ],
    'calm-explainer': [
      'Tone: Friendly, clear, authoritative. Like a trusted finance teacher explaining to a smart friend.',
      'Sentence rhythm: Short and clear. No jargon without explanation.',
      'No ellipsis. No cliffhangers. Just clarity and insight.',
      'Each section builds logically on the last.',
      'Use relatable analogies to explain abstract concepts.',
      'Conversational but precise. Never condescending.',
    ],
    'suspenseful': [
      'Tone: Dark, tense, gripping. Like a true crime podcast at its most intense.',
      'Sentence rhythm: Short. Abrupt. Then silence. Then the reveal.',
      'Use pauses and rhetorical questions to build dread.',
      'Each act ends on a disturbing revelation or unanswered question.',
      'Names, dates, locations — be specific. Specificity creates horror.',
      'Never let the listener feel safe.',
    ],
    'reflective-historical': [
      'Tone: Measured, scholarly, reverent. Like a historian uncovering a forgotten truth.',
      'Sentence rhythm: Long builds with careful detail. Let history breathe.',
      'Use archival language where appropriate.',
      'Each act reveals a layer of history that recontextualises what came before.',
      'Emphasise what was lost, hidden, or suppressed.',
      'End with the weight of what this history means today.',
    ],
    'sardonic': [
      'Tone: Dry, witty, incredulous. Like reading the best revenge story on Reddit out loud.',
      'Sentence rhythm: Build-up then punchline. Let the irony land.',
      'Use sarcasm sparingly but devastatingly.',
      'Each act escalates the absurdity of the situation.',
      'The narrator is clearly on the side of the person getting revenge.',
      'End with satisfaction. Justice served.',
    ],
  };
  const style = styleMap[dna.narration_style] || styleMap['dramatic-investigative'];
  const pacing = dna.script_pacing || 'slow-build';

  return {
    mins,
    totalWords,
    channelLabel,
    styleText: style.map(s => '- ' + s).join('\n'),
    act1Min: Math.round(totalWords * 0.17),
    act2Min: Math.round(totalWords * 0.20),
    act3Min: Math.round(totalWords * 0.20),
    act3bMin: Math.round(totalWords * 0.12),
    act4Min: Math.round(totalWords * 0.20),
    act5Min: Math.round(totalWords * 0.11),
    pacingNote: pacing === 'fast-cut'
      ? 'PACING: Fast. Cut quickly between revelations. Keep momentum high throughout.'
      : pacing === 'steady'
        ? 'PACING: Steady and measured. Each section flows naturally into the next.'
        : 'PACING: Slow build. Each act increases tension toward a climax.',
    episodeOpeningEnabled: dna.episode_opening_enabled === true,
    outroLine: 'Subscribe to ' + channelLabel + ' — new episodes every week.',
  };
}

function buildSystemPrompt(dna) {
  const cfg = buildScriptConfig(dna);
  const openingSchema = cfg.episodeOpeningEnabled
    ? '  "episode_open": {\n' +
      '    "setupSentenceA": "<peak setup sentence>",\n' +
      '    "setupSentenceB": "<fall setup sentence>"\n' +
      '  },\n'
    : '';
  const openingInstructions = cfg.episodeOpeningEnabled
    ? EPISODE_OPENING_INSTRUCTIONS + '\n\n'
    : '';

  return 'You are an expert scriptwriter for ' + cfg.channelLabel + ', a ' + dna.blueprint_label + ' YouTube channel.\n\n' +
    'CHANNEL STYLE:\n' + cfg.styleText + '\n\n' +
    cfg.pacingNote + '\n\n' +
    openingInstructions +
    'You will return a complete 5-act script as a JSON object.\n\n' +
    'RESPONSE FORMAT — return ONLY valid JSON, no markdown fences, no preamble:\n' +
    '{\n' +
    '  "title": "Full YouTube title including | ' + cfg.channelLabel + '",\n' +
    '  "topic": "The topic as given",\n' +
    '  "totalEstimatedSeconds": <number>,\n' +
    openingSchema +
    '  "acts": {\n' +
    '    "act1": { "label": "THE HOOK", "estimatedSeconds": <number>, "voScript": "<narration>" },\n' +
    '    "act2": { "label": "THE RISE", "estimatedSeconds": <number>, "voScript": "<narration>" },\n' +
    '    "act3": { "label": "THE TRUTH", "estimatedSeconds": <number>, "voScript": "<narration>" },\n' +
    '    "act3b": { "label": "THE COST", "estimatedSeconds": <number>, "voScript": "<narration>" },\n' +
    '    "act4": { "label": "THE FALL", "estimatedSeconds": <number>, "voScript": "<narration>" },\n' +
    '    "act5": { "label": "THE VERDICT", "estimatedSeconds": <number>, "voScript": "<narration>" }\n' +
    '  },\n' +
    '  "youtubeDetails": {\n' +
    '    "description": "<2-3 paragraph description>",\n' +
    '    "tags": ["tag1", "tag2"],\n' +
    '    "chapters": [{ "time": "0:00", "label": "Intro" }]\n' +
    '  }\n' +
    '}\n\n' +
    'WORD COUNT — MANDATORY:\n' +
    'act1: minimum ' + cfg.act1Min + ' words\n' +
    'act2: minimum ' + cfg.act2Min + ' words\n' +
    'act3: minimum ' + cfg.act3Min + ' words\n' +
    'act3b: minimum ' + cfg.act3bMin + ' words\n' +
    'act4: minimum ' + cfg.act4Min + ' words\n' +
    'act5: minimum ' + cfg.act5Min + ' words\n' +
    'TOTAL minimum: ' + cfg.totalWords + ' words. Target runtime: ' + cfg.mins + ' minutes.\n' +
    'End act5 with: "' + cfg.outroLine + '"';
}

function applyEpisodeOpening(script) {
  const opening = script.episode_open;
  for (const field of ['setupSentenceA', 'setupSentenceB']) {
    if (typeof opening?.[field] !== 'string' || !opening[field].trim()) {
      throw new Error('[script-writer] Missing episode_open.' + field);
    }
  }

  const setupSentenceA = opening.setupSentenceA.trim();
  const setupSentenceB = opening.setupSentenceB.trim();
  script.episode_open = {
    setupSentenceA,
    setupSentenceB,
    fixedClosingLine: FIXED_EPISODE_OPENING_LINE,
  };
  script.acts.act1.voScript = [
    setupSentenceA,
    setupSentenceB,
    FIXED_EPISODE_OPENING_LINE,
    '',
    script.acts.act1.voScript.trimStart(),
  ].join('\n');
}

async function writeScript({ topic, channel = 'Empire Omitted', outputDir = null }) {
  if (!topic) throw new Error('surface-script-writer: topic is required');

  const dna = await getChannelConfigByLabel(channel);
  const cfg = buildScriptConfig(dna);
  const client = new Anthropic();

  console.log('[script-writer] Channel: ' + channel);
  console.log('[script-writer] Blueprint: ' + dna.blueprint_label);
  console.log('[script-writer] Target length: ' + cfg.mins + ' min / ' + cfg.totalWords + ' words');
  console.log('[script-writer] Writing script for: "' + topic + '"');

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(dna),
    messages: [{
      role: 'user',
      content: 'Write a complete 5-act script about:\n\n' + topic +
        '\n\nReturn only the JSON object. No markdown. No preamble.',
    }],
  });
  const rawText = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();

  let script;
  try {
    script = JSON.parse(clean);
  } catch (err) {
    throw new Error('[script-writer] JSON parse failed: ' + err.message);
  }

  for (const act of ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5']) {
    if (!script.acts?.[act]?.voScript) {
      throw new Error('[script-writer] Missing voScript for ' + act);
    }
  }
  if (cfg.episodeOpeningEnabled) applyEpisodeOpening(script);

  console.log('[script-writer] Script complete — ' + script.totalEstimatedSeconds + 's estimated');
  console.log('[script-writer] Title: ' + script.title);

  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'script.json'), JSON.stringify(script, null, 2), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'script-plain.txt'), buildPlainText(script), 'utf8');
    console.log('[script-writer] Saved to ' + outputDir);
  }
  return script;
}

function buildPlainText(script) {
  const lines = [script.title, '='.repeat(60), ''];
  for (const [key, act] of Object.entries(script.acts)) {
    lines.push('--- ' + key.toUpperCase() + ' — ' + act.label + ' (~' + act.estimatedSeconds + 's) ---');
    lines.push('', act.voScript, '');
  }
  lines.push('--- YOUTUBE DETAILS ---', '', 'DESCRIPTION:', script.youtubeDetails.description, '');
  lines.push('TAGS: ' + script.youtubeDetails.tags.join(', '));
  return lines.join('\n');
}

if (require.main === module) {
  const topic = process.argv[2];
  const channel = process.argv[3] || 'Empire Omitted';
  const outputDir = process.argv[4] || null;
  if (!topic) {
    console.error('Usage: node surface-script-writer.cjs "<topic>" "<channel>" [outputDir]');
    process.exit(1);
  }
  writeScript({ topic, channel, outputDir })
    .then(script => { if (!outputDir) console.log(buildPlainText(script)); })
    .catch(err => { console.error('[script-writer] FATAL:', err.message); process.exit(1); });
}

module.exports = {
  writeScript,
  buildPlainText,
  buildSystemPrompt,
  applyEpisodeOpening,
  FIXED_EPISODE_OPENING_LINE,
  EPISODE_OPENING_INSTRUCTIONS,
};
