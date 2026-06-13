'use strict';

/**
 * recommendations.js
 * Sprint 1C Phase B — Recommendation API route.
 *
 * Registers: POST /api/episodes/recommend
 *
 * Request body:  { topic: string }
 * Response:      { blueprint_id, confidence, reason, all_scores }
 *
 * Protected by requireAuth middleware (passed in from app.js).
 * Pure read — no database writes.
 */

const express = require('express');
const { recommend } = require('../recommendation/engine.js');

const MIN_TOPIC_LENGTH = 3;

function createRecommendationsRouter(requireAuth) {
  const router = express.Router();

  router.post('/', requireAuth, (req, res) => {
    const { topic } = req.body;

    if (
      !topic ||
      typeof topic !== 'string' ||
      topic.trim().length < MIN_TOPIC_LENGTH
    ) {
      console.log('[recommend] rejected — topic too short or missing:', topic);
      return res.status(400).json({
        error: 'topic is required and must be at least 3 characters',
      });
    }

    try {
      const trimmed = topic.trim();

      console.log(`[recommend] topic="${trimmed}"`);

      const result = recommend(trimmed);

      if (!result.blueprint_id || result.confidence < 40) {
        console.log(`[recommend] no recommendation — confidence=${result.confidence}% all_scores=${JSON.stringify(result.all_scores)}`);
        return res.json({
          blueprint_id: null,
          confidence:   0,
          reason:       'No strong recommendation',
          all_scores:   result.all_scores,
        });
      }

      console.log(`[recommend] result blueprint_id=${result.blueprint_id} confidence=${result.confidence}% reason="${result.reason}"`);

      return res.json(result);

    } catch (err) {
      console.error('[recommend] engine error:', err);
      return res.status(500).json({ error: 'Recommendation failed' });
    }
  });

  return router;
}

module.exports = { createRecommendationsRouter };
