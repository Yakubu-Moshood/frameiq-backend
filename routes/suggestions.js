/**
 * routes/suggestions.js
 * Frameiq — AI topic suggestions via Claude
 *
 * POST /api/suggestions
 * Body: { channel: 'EmpireOmitted' }
 * Returns: { suggestions: [{ title, hook, why }] }
 */

const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const CHANNEL_BRIEFS = {
  EmpireOmitted: {
    name:    'Empire Omitted',
    niche:   'Corporate scandals, fraud, and business collapses',
    tone:    'Dark, dramatic, authoritative — BBC/Netflix documentary style',
    example: 'Enron, Theranos, WeWork, FTX, Wirecard',
  },
  TrueCrimeWeekly: {
    name:    'True Crime Weekly',
    niche:   'Unsolved cases, serial killers, heists, and criminal investigations',
    tone:    'Gripping, suspenseful, investigative journalist style',
    example: 'Zodiac Killer, DB Cooper, Silk Road, disappearances',
  },
  MoneyExplained: {
    name:    'Money Explained',
    niche:   'Finance education — how money, markets, and economics actually work',
    tone:    'Clear, insightful, slightly edgy — not boring textbook',
    example: 'How the Federal Reserve works, why inflation happens, hedge funds explained',
  },
  HistoryHidden: {
    name:    'History Hidden',
    niche:   'Suppressed, forgotten, or misrepresented historical events',
    tone:    'Revelatory, cinematic, thought-provoking',
    example: 'Operation Paperclip, the real story of Prohibition, forgotten wars',
  },
};

router.post('/', requireAuth, async (req, res) => {
  const { channel = 'EmpireOmitted' } = req.body || {};
  const brief = CHANNEL_BRIEFS[channel];

  if (!brief) return res.status(400).json({ error: 'Unknown channel' });

  const prompt = `You are a YouTube content strategist specialising in documentary channels.

Channel: ${brief.name}
Niche: ${brief.niche}
Tone: ${brief.tone}
Example topics: ${brief.example}

Generate 5 documentary episode topic suggestions for this channel that would perform extremely well on YouTube.

Each suggestion must:
- Have a compelling, specific title (not vague — name real companies, people, events)
- Target high search volume and strong emotional hooks
- Be suitable for a 12-15 minute faceless documentary
- Feel urgent, dramatic, or revelatory

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "title": "Full episode title as it would appear on YouTube",
    "hook": "One sentence — the most shocking or compelling fact about this topic",
    "why": "One sentence — why this will get YouTube views"
  }
]`;

  try {
    const message = await client.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw  = message.content[0]?.text || '[]';
    const clean = raw.replace(/```json|```/g, '').trim();
    const suggestions = JSON.parse(clean);

    return res.json({ suggestions, channel });
  } catch (err) {
    console.error('[suggestions] Error:', err.message);
    return res.status(500).json({ error: 'Failed to generate suggestions' });
  }
});

module.exports = router;
