const fs = require('fs');
const p = '/data/pipeline/surface-script-writer.cjs';

const content = `'use strict';

require('dotenv').config();

const fs2 = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getChannelConfigByLabel } = require('./config-reader.cjs');

const MODEL      = 'claude-opus-4-5';
const MAX_TOKENS = 16000;

function buildScriptConfig(dna) {
  const mins = dna.target_length_minutes || 10;
  const wordsPerMin = 120;
  const totalWords = Math.round(mins * wordsPerMin);
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
  const styleText = style.map(s => '- ' + s).join('\n');

  const act1Min = Math.round(totalWords * 0.17);
  const act2Min = Math.round(totalWords * 0.20);
  const act3Min = Math.round(totalWords * 0.20);
  const act3bMin = Math.round(totalWords * 0.12);
  const act4Min = Math.round(totalWords * 0.20);
  const act5Min = Math.round(totalWords * 0.11);

  const pacing = dna.script_pacing || 'slow-build';
  const pacingNote = pacing === 'fast-cut'
    ? 'PACING: Fast. Cut quickly between revelations. Keep momentum high throughout.'
    : pacing === 'steady'
    ? 'PACING: Steady and measured. Each section flows naturally into the next.'
    : 'PACING: Slow build. Each act increases tension toward a climax.';

  return {
    styleText,
    totalWords,
    mins,
    act1Min, act2Min, act3Min, act3bMin, act4Min, act5Min,
    pacingNote,
    channelLabel,
    outroLine: 'Subscribe to ' + channelLabel + ' — new episodes every week.',
  };
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

  const systemPrompt = 'You are an expert scriptwriter for ' + cfg.channelLabel + ', a ' + dna.blueprint_label + ' YouTube channel.\n\n' +
    'CHANNEL STYLE:\n' + cfg.styleText + '\n\n' +
    cfg.pacingNote + '\n\n' +
    'You will return a complete 5-act script as a JSON object.\n\n' +
    'RESPONSE FORMAT — return ONLY valid JSON, no markdown fences, no preamble:\n' +
    '{\n' +
    '  "title": "Full YouTube title including | ' + cfg.channelLabel + '",\n' +
    '  "topic": "The topic as given",\n' +
    '  "totalEstimatedSeconds": <number>,\n' +
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

  const userPrompt = 'Write a complete 5-act script about:\n\n' + topic + '\n\nReturn only the JSON object. No markdown. No preamble.';

  const message = await client.messages.create({
    model:    MODEL,
    max_tokens: MAX_TOKENS,
    system:   systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const rawText = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = rawText.replace(/^\`\`\`json\s*/i, '').replace(/\s*\`\`\`$/, '').trim();

  let script;
  try {
    script = JSON.parse(clean);
  } catch (err) {
    throw new Error('[script-writer] JSON parse failed: ' + err.message);
  }

  const requiredActs = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  for (const act of requiredActs) {
    if (!script.acts?.[act]?.voScript) throw new Error('[script-writer] Missing voScript for ' + act);
  }

  console.log('[script-writer] Script complete — ' + script.totalEstimatedSeconds + 's estimated');
  console.log('[script-writer] Title: ' + script.title);

  if (outputDir) {
    fs2.mkdirSync(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, 'script.json');
    const txtPath  = path.join(outputDir, 'script-plain.txt');
    fs2.writeFileSync(jsonPath, JSON.stringify(script, null, 2), 'utf8');
    fs2.writeFileSync(txtPath, buildPlainText(script), 'utf8');
    console.log('[script-writer] Saved to ' + outputDir);
  }

  return script;
}

function buildPlainText(script) {
  const lines = [script.title, '='.repeat(60), ''];
  for (const [key, act] of Object.entries(script.acts)) {
    lines.push('--- ' + key.toUpperCase() + ' — ' + act.label + ' (~' + act.estimatedSeconds + 's) ---');
    lines.push('');
    lines.push(act.voScript);
    lines.push('');
  }
  lines.push('--- YOUTUBE DETAILS ---');
  lines.push('');
  lines.push('DESCRIPTION:');
  lines.push(script.youtubeDetails.description);
  lines.push('');
  lines.push('TAGS: ' + script.youtubeDetails.tags.join(', '));
  return lines.join('\n');
}

if (require.main === module) {
  const topic     = process.argv[2];
  const channel   = process.argv[3] || 'Empire Omitted';
  const outputDir = process.argv[4] || null;
  if (!topic) {
    console.error('Usage: node surface-script-writer.cjs "<topic>" "<channel>" [outputDir]');
    process.exit(1);
  }
  writeScript({ topic, channel, outputDir })
    .then(script => { if (!outputDir) console.log(buildPlainText(script)); })
    .catch(err => { console.error('[script-writer] FATAL:', err.message); process.exit(1); });
}

module.exports = { writeScript };
`;

fs.writeFileSync(p, content, 'utf8');
console.log('surface-script-writer.cjs written — lines: ' + content.split('\n').length);
