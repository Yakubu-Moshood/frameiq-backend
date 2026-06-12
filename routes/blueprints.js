/**
 * routes/blueprints.js
 * FrameIQ Sprint 1A — Blueprint routes
 *
 * GET /api/blueprints       — list all blueprints
 * GET /api/blueprints/:id   — get single blueprint
 *
 * JSON fields (act_structure, asset_strategy, platform_strategy, step_config)
 * are parsed from stored strings before returning so the client receives
 * proper objects, not escaped JSON strings.
 */

'use strict';

const express        = require('express');
const { queries }    = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function parseBlueprint(bp) {
  if (!bp) return null;
  return {
    ...bp,
    act_structure:     safeParseJson(bp.act_structure,     []),
    asset_strategy:    safeParseJson(bp.asset_strategy,    {}),
    platform_strategy: safeParseJson(bp.platform_strategy, {}),
    step_config:       safeParseJson(bp.step_config,       []),
  };
}

function safeParseJson(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ─── GET /api/blueprints ──────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const list = await queries.listBlueprints();
    return res.json(list.map(parseBlueprint));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/blueprints/:id ──────────────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const bp = await queries.getBlueprint(req.params.id);
    if (!bp) return res.status(404).json({ error: `Blueprint not found: ${req.params.id}` });
    return res.json(parseBlueprint(bp));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
