/**
 * routes/channels.js
 * FraymIQ — Active channels endpoint
 *
 * GET /api/channels
 * Returns all active channels for the frontend channel picker.
 *
 * Production/Railway can use the pipeline config reader.
 * Local development falls back to the seeded channel_dna table.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { queries } = require('../db');
const { getAllChannelConfigs } = require('./config-reader-proxy');

const router = express.Router();

function toChannelResponse(ch) {
  return {
    key:            ch.id || ch.channel_id,
    name:           ch.label,
    slug:           ch.slug,
    blueprint_label: ch.blueprint_label,
    ui_theme_color: ch.ui_theme_color,
    tagline:        ch.description || ch.blueprint_label,
    target_length_minutes: ch.target_length_minutes,
    narration_style: ch.narration_style,
  };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    let rows = [];

    try {
      const all = await getAllChannelConfigs();
      rows = Object.values(all || {});
    } catch (configErr) {
      console.warn('[channels] Config reader unavailable, using local channel_dna fallback:', configErr.message);
      rows = await queries.listChannelDna();
    }

    const active = rows
      .filter(ch => ch.active === 1 || ch.active === true)
      .map(toChannelResponse)
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ channels: active });
  } catch (err) {
    console.error('[channels] Error:', err.message);
    res.status(500).json({ error: 'Failed to load channels' });
  }
});

module.exports = router;
