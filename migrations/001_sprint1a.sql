-- ── FrameIQ Sprint 1A migration — 001_sprint1a.sql ──────────────────────────
-- Adds: platforms, blueprints, channel_dna, blueprint_recommendations tables
-- episodes column additions are handled in JS (SQLite has no ADD COLUMN IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platforms (
  id                   TEXT PRIMARY KEY,
  label                TEXT NOT NULL,
  max_duration_sec     INTEGER,
  preferred_aspect     TEXT,
  preferred_resolution TEXT,
  notes                TEXT
);

CREATE TABLE IF NOT EXISTS blueprints (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  description       TEXT,
  workflow_type     TEXT NOT NULL,
  act_structure     TEXT NOT NULL,
  asset_strategy    TEXT NOT NULL,
  platform_strategy TEXT NOT NULL,
  step_config       TEXT NOT NULL,
  is_custom         INTEGER DEFAULT 0,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_dna (
  id                         TEXT PRIMARY KEY,
  label                      TEXT NOT NULL,
  description                TEXT,
  brand_voice                TEXT,
  primary_colour             TEXT,
  secondary_colour           TEXT,
  background_colour          TEXT,
  font_display               TEXT,
  font_body                  TEXT,
  watermark_text             TEXT,
  outro_file                 TEXT,
  elevenlabs_voice_id        TEXT,
  voice_style_notes          TEXT,
  default_blueprint_id       TEXT,
  allowed_blueprints         TEXT,
  youtube_channel_id         TEXT,
  youtube_credentials        TEXT,
  default_publish_visibility TEXT DEFAULT 'private',
  publish_schedule           TEXT,
  target_audience            TEXT,
  content_warnings           TEXT,
  monetisation_enabled       INTEGER DEFAULT 0,
  credits_per_episode        INTEGER DEFAULT 1,
  dna_extensions             TEXT DEFAULT '{}',
  created_at                 TEXT DEFAULT (datetime('now')),
  updated_at                 TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blueprint_recommendations (
  id                    TEXT PRIMARY KEY,
  episode_id            TEXT NOT NULL,
  recommended_blueprint TEXT NOT NULL,
  confidence            REAL,
  reasoning             TEXT,
  alternatives          TEXT,
  tier_used             INTEGER,
  was_accepted          INTEGER,
  created_at            TEXT DEFAULT (datetime('now'))
);
