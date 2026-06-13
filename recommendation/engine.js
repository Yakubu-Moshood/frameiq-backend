'use strict';

/**
 * engine.js
 * Sprint 1C — Blueprint Recommendation Engine, Level 1.
 *
 * Pure function architecture.
 * No DB access. No Express. No side effects. No network. No file writes.
 *
 * Pipeline:
 *   classify(topic)  → signal array
 *   score(signals)   → { blueprintId: rawScore, ... }
 *   resolve(scores)  → { blueprint_id, confidence, reason, all_scores }
 *
 * Public API:
 *   recommend(topic) → { blueprint_id, confidence, reason, all_scores }
 *                    | { blueprint_id: null, confidence: 0, reason: null, all_scores: {} }
 */

const {
  SIGNALS,
  BANDS,
  AMBIGUITY_GAP,
  WEIGHTS,
  MIN_TOPIC_LENGTH,
} = require('./signals.js');

/* ─────────────────────────────────────────────
   STEP 1 — CLASSIFIER
   Normalises the topic string and extracts
   candidate signals: unigrams, bigrams, trigrams.
───────────────────────────────────────────── */

function classify(topic) {
  const normalised = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalised.split(' ').filter(Boolean);

  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }

  const trigrams = [];
  for (let i = 0; i < words.length - 2; i++) {
    trigrams.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }

  return { normalised, unigrams: words, bigrams, trigrams };
}

/* ─────────────────────────────────────────────
   STEP 2 — SCORER
   For each blueprint, counts weighted matches
   across all three tiers, then normalises to
   a 0–100 scale using the blueprint's maxScore.
───────────────────────────────────────────── */

function score(signals) {
  const { unigrams, bigrams, trigrams } = signals;
  const scores = {};

  for (const [blueprintId, def] of Object.entries(SIGNALS)) {
    let raw = 0;

    for (const phrase of def.trigrams) {
      if (trigrams.includes(phrase)) raw += WEIGHTS.TRIGRAM;
    }
    for (const phrase of def.bigrams) {
      if (bigrams.includes(phrase)) raw += WEIGHTS.BIGRAM;
    }
    for (const word of def.keywords) {
      if (unigrams.includes(word)) raw += WEIGHTS.KEYWORD;
    }

    scores[blueprintId] = def.maxScore > 0
      ? Math.min(100, Math.round((raw / def.maxScore) * 100))
      : 0;
  }

  return scores;
}

/* ─────────────────────────────────────────────
   STEP 3 — RESOLVER
   Ranks blueprints by score. Checks ambiguity
   first (gap check runs before WEAK threshold
   so cross-genre partial matches are caught).
   Maps score to confidence band. Selects reason.
───────────────────────────────────────────── */

// Minimum score either blueprint must reach for ambiguity to trigger.
// Prevents noise-level scores (1–5%) from being flagged as ambiguous.
const AMBIGUITY_FLOOR = 15;

function resolve(scores) {
  const ranked = Object.entries(scores).sort(([, a], [, b]) => b - a);

  const [topId, topScore]   = ranked[0] || [null, 0];
  const [, secondScore]     = ranked[1] || [null, 0];

  // Nothing detected at all
  if (topScore === 0) {
    return { blueprint_id: null, confidence: 0, reason: null, all_scores: scores };
  }

  // Ambiguity check — runs BEFORE the WEAK threshold guard.
  // Triggers when:
  //   - the top score meets the minimum floor (not pure noise)
  //   - the gap between top two is within AMBIGUITY_GAP
  const gap = topScore - secondScore;
  if (topScore >= AMBIGUITY_FLOOR && gap < AMBIGUITY_GAP) {
    const def = SIGNALS[topId];
    return {
      blueprint_id: topId,
      confidence:   Math.min(topScore, BANDS.GOOD - 1),
      reason:       def ? def.reasons.ambiguous : null,
      all_scores:   scores,
    };
  }

  // Below WEAK threshold — no recommendation
  if (topScore < BANDS.WEAK) {
    return { blueprint_id: null, confidence: 0, reason: null, all_scores: scores };
  }

  // Clear winner — select reason by band
  let reasonKey;
  if (topScore >= BANDS.STRONG)     reasonKey = 'strong';
  else if (topScore >= BANDS.GOOD)  reasonKey = 'good';
  else                              reasonKey = 'weak';

  const def = SIGNALS[topId];
  return {
    blueprint_id: topId,
    confidence:   topScore,
    reason:       def ? def.reasons[reasonKey] : null,
    all_scores:   scores,
  };
}

/* ─────────────────────────────────────────────
   PUBLIC API
───────────────────────────────────────────── */

/**
 * recommend(topic)
 * @param  {string} topic
 * @returns {{ blueprint_id: string|null, confidence: number, reason: string|null, all_scores: object }}
 */
function recommend(topic) {
  if (typeof topic !== 'string' || topic.trim().length < MIN_TOPIC_LENGTH) {
    return { blueprint_id: null, confidence: 0, reason: null, all_scores: {} };
  }

  const signals = classify(topic);
  const scores  = score(signals);
  return resolve(scores);
}

module.exports = { recommend };
