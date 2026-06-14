'use strict';

/**
 * migrations/005_sprint15_phase_a.js
 * Sprint 1.5 Phase A — Channel DNA Consolidation
 *
 * Changes:
 *   1. channel_dna — add 10 provider priority columns
 *   2. episodes    — add 4 provider tracking columns
 *   3. provider_events — new table (logs every provider API call)
 *
 * Iteration 0 strategy for provider columns: SEED
 *   Values populated by seed-provider-config.cjs immediately after migration.
 *   All new columns are nullable with safe defaults so no existing rows break.
 *
 * No existing columns are modified or removed.
 * No existing data is affected.
 * Rollback: see rollback section in Sprint 1.5 implementation plan.
 */

async function up({ run, all }) {
  // ── channel_dna: provider priority columns ────────────────────────────────
  // Check existing columns to avoid re-adding (SQLite has no ADD IF NOT EXISTS)
  const channelCols = await all(`PRAGMA table_info(channel_dna)`, []);
  const channelColNames = new Set(channelCols.map(c => c.name));

  const channelDnaAdditions = [
    ['voice_primary',        "TEXT DEFAULT 'elevenlabs'"],
    ['voice_secondary',      "TEXT DEFAULT 'openai_tts'"],
    ['voice_id_elevenlabs',  'TEXT'],
    ['voice_id_openai',      'TEXT'],
    ['image_primary',        "TEXT DEFAULT 'openai_images'"],
    ['image_secondary',      "TEXT DEFAULT 'flux'"],
    ['image_tertiary',       "TEXT DEFAULT 'sdxl'"],
    ['video_primary',        "TEXT DEFAULT 'kling'"],
    ['video_secondary',      "TEXT DEFAULT 'wan_2_1'"],
    ['video_tertiary',       "TEXT DEFAULT 'ltx_video'"],
  ];

  for (const [col, def] of channelDnaAdditions) {
    if (!channelColNames.has(col)) {
      await run(`ALTER TABLE channel_dna ADD COLUMN ${col} ${def}`);
      console.log(`[migration 005] channel_dna.${col} added`);
    } else {
      console.log(`[migration 005] channel_dna.${col} already exists — skipping`);
    }
  }

  // ── episodes: provider tracking columns ───────────────────────────────────
  const episodeCols = await all(`PRAGMA table_info(episodes)`, []);
  const episodeColNames = new Set(episodeCols.map(c => c.name));

  const episodeAdditions = [
    ['provider_substituted', 'INTEGER DEFAULT 0'],
    ['voice_provider_used',  'TEXT'],
    ['image_provider_used',  'TEXT'],
    ['video_provider_used',  'TEXT'],
  ];

  for (const [col, def] of episodeAdditions) {
    if (!episodeColNames.has(col)) {
      await run(`ALTER TABLE episodes ADD COLUMN ${col} ${def}`);
      console.log(`[migration 005] episodes.${col} added`);
    } else {
      console.log(`[migration 005] episodes.${col} already exists — skipping`);
    }
  }

  // ── provider_events: new table ────────────────────────────────────────────
  // Logs every provider API call for cost attribution and failover visibility.
  // Populated by Sprint 1.5 Phase B provider router.
  await run(`
    CREATE TABLE IF NOT EXISTS provider_events (
      id            TEXT     PRIMARY KEY,
      episode_id    TEXT     REFERENCES episodes(id) ON DELETE CASCADE,
      step          TEXT     NOT NULL,
      act           INTEGER,
      shot_id       TEXT,
      provider      TEXT     NOT NULL,
      tier          INTEGER  NOT NULL DEFAULT 1,
      success       INTEGER  NOT NULL DEFAULT 0,
      error_message TEXT,
      duration_ms   INTEGER,
      cost_estimate REAL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log(`[migration 005] provider_events table created`);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_provider_events_episode_id
    ON provider_events(episode_id)
  `);
  console.log(`[migration 005] provider_events index created`);

  console.log(`[migration 005] Phase A complete`);
}

module.exports = { up };
