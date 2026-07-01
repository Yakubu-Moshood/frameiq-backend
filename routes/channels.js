/**
 * routes/channels.js
 * FraymIQ — Active channels endpoint
 *
 * GET /api/channels
 * Returns all active channels from channel_dna
 * Used by the frontend channel picker in NewEpisodePage
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getAllChannelConfigs } = require('../data/config-reader-proxy');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const all = await getAllChannelConfigs();

    const active = Object.values(all)
      .filter(ch => ch.active === 1)
      .map(ch => ({
        key:            ch.label,
        name:           ch.label,
        slug:           ch.slug,
        blueprint_label: ch.blueprint_label,
        ui_theme_color: ch.ui_theme_color,
        tagline:        ch.description || ch.blueprint_label,
        target_length_minutes: ch.target_length_minutes,
        narration_style: ch.narration_style,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ channels: active });
  } catch (err) {
    console.error('[channels] Error:', err.message);
    res.status(500).json({ error: 'Failed to load channels' });
  }
});

module.exports = router;
