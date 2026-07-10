/**
 * routes/suggestions.js
 * FraymIQ — AI topic suggestions via Claude
 * Updated: Channel DNA v2 — prompts built dynamically from DB
 *
 * POST /api/suggestions
 * Body: { channel: 'Empire Omitted' }
 * Returns: { suggestions: [{ title, hook, why }] }
 */

const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');
const { getChannelConfigByLabel } = require('./config-reader-proxy');
const { get } = require('../db');

const router = express.Router();
const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildPrompt(dna) {
  const mins    = dna.target_length_minutes || 10;
  const hints   = dna.title_category_hints || [];
  const label   = dna.label;
  const blueprint = dna.blueprint_label || 'Documentary';

  const hintText = hints.length > 0
    ? 'Topic categories to draw from: ' + hints.join(', ')
    : '';

  const lengthNote = mins <= 5
    ? 'Each topic must suit a concise ' + mins + '-minute explainer video — focused, single-concept topics only.'
    : 'Each topic must suit a ' + mins + '-minute documentary episode — complex stories with multiple layers.';

  const styleMap = {
    'dramatic-investigative': 'Dark, dramatic, authoritative — BBC/Netflix documentary style. Name real companies, people, and dollar amounts.',
    'calm-explainer':         'Clear, insightful, accessible — explain complex concepts in plain language. Use relatable analogies.',
    'suspenseful':            'Gripping, tense, investigative — name real cases, real victims, real locations. Make the viewer feel dread.',
    'reflective-historical':  'Revelatory, cinematic, scholarly — uncover forgotten or suppressed history. Make the viewer feel the weight of what was lost.',
    'sardonic':               'Dry, witty, satisfying — the narrator is clearly on the side of justice. The irony must land perfectly.',
  };

  const toneNote = styleMap[dna.narration_style] || styleMap['dramatic-investigative'];

  const redditNote = dna.narration_style === 'sardonic'
    ? '\nIMPORTANT: Research real stories from r/ProRevenge, r/NuclearRevenge, r/MaliciousCompliance, and r/pettyrevenge. Base suggestions on real story archetypes found on these platforms. Titles should feel like anthology episode names, not Reddit post titles.\n'
    : '';

  return `You are a YouTube content strategist specialising in the ${blueprint} channel "${label}".

Channel: ${label}
Blueprint: ${blueprint}
Tone: ${toneNote}
${hintText}
${redditNote}
${lengthNote}

Generate 6 episode topic suggestions for this channel that would perform extremely well on YouTube.

Each suggestion must:
- Have a compelling, specific title (not vague — name real companies, people, events, or story archetypes)
- Target high search volume and strong emotional hooks
- Be suitable for a ${mins}-minute video
- Feel urgent, dramatic, revelatory, or satisfying depending on the channel tone
- Include the channel name at the end: "| ${label}"

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "title": "Full episode title as it would appear on YouTube | ${label}",
    "hook": "One sentence — the most compelling fact or moment about this topic",
    "why": "One sentence — why this will get YouTube views on ${label}"
  }
]`;
}

router.post('/', requireAuth, async (req, res) => {
  const { channel } = req.body || {};

  if (!channel) {
    return res.status(400).json({ error: 'channel is required' });
  }

  // Resolve the incoming value to the channel's stable id before calling
  // getChannelConfigByLabel. NewEpisodePage.jsx sends selectedChannel.name,
  // which is routes/channels.js's `name: ch.label` -- the free-text label
  // ("Empire Omitted", "Macro Decode"), not the id ("EmpireOmitted",
  // "MoneyExplained"). getChannelConfigByLabel (config-reader.cjs, see
  // write-config-reader.js's "Fix 1/3" commit) now queries WHERE id = ?,
  // matching its other two callers (surface-shot-definitions.cjs,
  // surface-animator.cjs), which already pass the id -- this route was the
  // one caller still passing a label, which broke after that fix. Resolve
  // label -> id here rather than touching the shared config-reader
  // contract again.
  let channelId = channel;
  try {
    const row = await get('SELECT id FROM channel_dna WHERE label = ?', [channel]);
    if (row) channelId = row.id;
    // No match: fall through with channelId unchanged. Covers callers that
    // already pass a valid id directly (backward compatible), and truly
    // unknown channels either way -- both hit the same 400 below via
    // getChannelConfigByLabel's own not-found error.
  } catch (err) {
    console.error('[suggestions] Label resolution query failed:', channel, err.message);
    // Non-fatal -- fall through and let the id-based lookup below fail
    // with its existing 'Unknown channel' 400 instead of a 500 here.
  }

  let dna;
  try {
    dna = await getChannelConfigByLabel(channelId);
  } catch (err) {
    console.error('[suggestions] Channel not found:', channel, err.message);
    return res.status(400).json({ error: 'Unknown channel: ' + channel });
  }

  const prompt = buildPrompt(dna);

  try {
    const message = await client.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw   = message.content[0]?.text || '[]';
    const clean = raw.replace(/```json|```/g, '').trim();
    const suggestions = JSON.parse(clean);

    return res.json({ suggestions, channel });
  } catch (err) {
    console.error('[suggestions] Error:', err.message);
    return res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

module.exports = router;
