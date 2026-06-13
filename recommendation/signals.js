'use strict';

/**
 * signals.js
 * Sprint 1C — Level 1 signal definitions.
 *
 * Structure per blueprint:
 *   trigrams  — 3-word phrases. Weight 3.0 each match.
 *   bigrams   — 2-word phrases. Weight 2.0 each match.
 *   keywords  — single words.  Weight 1.0 each match.
 *   maxScore  — calibrated ceiling for normalisation.
 *               Set so a strong on-topic 5-7 word title
 *               scores 85–95%. Derived empirically from
 *               real topic examples — see Phase A notes.
 *   reasons   — template strings used by the resolver.
 *
 * Level 2 expansion: add script_patterns[] per blueprint.
 * Level 3 expansion: engine.js swaps scorer internals only —
 *   this file's structure does not change.
 */

const SIGNALS = {

  documentary: {
    trigrams: [
      'rise and fall',
      'dark side of',
      'inside the world',
      'birth of an',
      'fall of an',
      'the making of',
      'untold story of',
      'empire and fall',
      'story of the',
      'history of the',
    ],
    bigrams: [
      'corporate empire',
      'secret history',
      'dark history',
      'untold story',
      'rise fall',
      'behind the',
      'inside story',
      'power struggle',
      'rise empire',
      'downfall of',
      'real story',
      'hidden history',
      'shocking truth',
    ],
    keywords: [
      'rise',
      'fall',
      'empire',
      'history',
      'story',
      'scandal',
      'expose',
      'revealed',
      'documentary',
      'legacy',
      'downfall',
      'secrets',
      'truth',
      'behind',
      'inside',
      'forgotten',
      'hidden',
      'dynasty',
      'corruption',
      'cover',
    ],
    maxScore: 6,
    reasons: {
      strong:   'Historical rise-and-fall narrative with investigative storytelling characteristics.',
      good:     'Rise-and-fall or documentary narrative patterns detected.',
      weak:     'Some documentary signals present.',
      ambiguous:'Documentary and competing signals detected — multiple formats may apply.',
    },
  },

  finance_explainer: {
    trigrams: [
      'how does money',
      'compound interest works',
      'how compound interest',
      'what is inflation',
      'how inflation works',
      'how the stock',
      'stock market works',
      'how banks work',
      'what is investing',
      'how to invest',
      'what is a',
      'explained for beginners',
    ],
    bigrams: [
      'compound interest',
      'interest rate',
      'stock market',
      'how money',
      'money works',
      'financial explained',
      'investing explained',
      'budget explained',
      'debt explained',
      'how investing',
      'passive income',
      'net worth',
      'credit score',
      'tax explained',
      'inflation explained',
      'interest explained',
      'money supply',
      'bank explained',
    ],
    keywords: [
      'money',
      'finance',
      'financial',
      'investing',
      'investment',
      'interest',
      'inflation',
      'budget',
      'debt',
      'credit',
      'savings',
      'stocks',
      'shares',
      'bonds',
      'returns',
      'wealth',
      'compound',
      'dividend',
      'portfolio',
      'tax',
      'income',
      'explained',
      'works',
      'explainer',
      'guide',
      'beginners',
      'understand',
    ],
    maxScore: 12,
    reasons: {
      strong:   'Educational finance topic focused on concepts and visual explanation.',
      good:     'Financial education or money concept patterns detected.',
      weak:     'Some financial signals present.',
      ambiguous:'Financial and competing signals detected — multiple formats may apply.',
    },
  },

  investigative: {
    trigrams: [
      'who really killed',
      'unsolved mystery of',
      'inside the crime',
      'the real killer',
      'what really happened',
      'crime that shocked',
      'case that changed',
      'heist that shocked',
      'biggest bank heist',
      'million dollar heist',
      'stolen from the',
    ],
    bigrams: [
      'bank heist',
      'unsolved case',
      'cold case',
      'true crime',
      'murder mystery',
      'missing person',
      'crime investigation',
      'criminal empire',
      'money laundering',
      'drug cartel',
      'organised crime',
      'crime boss',
      'federal investigation',
      'secret investigation',
      'inside job',
      'robbery heist',
      'crime syndicate',
      'cartel boss',
    ],
    keywords: [
      'heist',
      'robbery',
      'murder',
      'killed',
      'crime',
      'criminal',
      'investigation',
      'detective',
      'suspect',
      'evidence',
      'unsolved',
      'mystery',
      'fraud',
      'stolen',
      'victim',
      'witness',
      'cartel',
      'gang',
      'conspiracy',
      'laundering',
      'kidnap',
      'hitman',
      'assassin',
      'smuggling',
    ],
    maxScore: 7,
    reasons: {
      strong:   'Crime and investigative storytelling patterns detected.',
      good:     'Criminal investigation or mystery narrative patterns detected.',
      weak:     'Some investigative signals present.',
      ambiguous:'Investigative and competing signals detected — multiple formats may apply.',
    },
  },

};

/**
 * Confidence band thresholds.
 * All configurable here — engine.js reads these constants.
 */
const BANDS = {
  STRONG: 85,
  GOOD:   66,
  WEAK:   41,
  NONE:    0,
};

/**
 * Ambiguity threshold.
 * If gap between top two blueprint scores is less than this,
 * confidence is capped at GOOD and reason reflects ambiguity.
 */
const AMBIGUITY_GAP = 10;

/**
 * Tier weights.
 */
const WEIGHTS = {
  TRIGRAM: 3.0,
  BIGRAM:  2.0,
  KEYWORD: 1.0,
};

/**
 * Minimum topic length (characters).
 */
const MIN_TOPIC_LENGTH = 3;

module.exports = { SIGNALS, BANDS, AMBIGUITY_GAP, WEIGHTS, MIN_TOPIC_LENGTH };
