'use strict';

/**
 * migrations/004_review_foundation.js
 * Sprint 2A Phase A — Review Foundation
 *
 * Creates two new tables:
 *   revisions    — stores creator revision requests per act
 *   act_versions — stores versioned act assets (populated by Sprint 2B)
 *
 * Iteration 0 strategy: LAZY (Sprint 2B)
 *   act_versions starts empty. Sprint 2B writes iteration 0 (original)
 *   and iteration 1 (first revision) when regeneration first runs.
 *
 * Receives { run, all } helpers from db.js — no direct DB dependency.
 */

async function up({ run, all }) {
  await run(`
    CREATE TABLE IF NOT EXISTS revisions (
      id            TEXT    PRIMARY KEY,
      episode_id    TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      act           INTEGER NOT NULL,
      comment       TEXT    NOT NULL,
      revision_type TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'queued',
      iteration     INTEGER,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_revisions_episode_id ON revisions(episode_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_revisions_episode_act ON revisions(episode_id, act)`);

  await run(`
    CREATE TABLE IF NOT EXISTS act_versions (
      id          TEXT    PRIMARY KEY,
      episode_id  TEXT    NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      act         INTEGER NOT NULL,
      iteration   INTEGER NOT NULL DEFAULT 0,
      asset_path  TEXT,
      revision_id TEXT    REFERENCES revisions(id) ON DELETE SET NULL,
      approved    INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(episode_id, act, iteration)
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_act_versions_episode_id ON act_versions(episode_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_act_versions_episode_act ON act_versions(episode_id, act)`);

  console.log('[migration 004] revisions table created');
  console.log('[migration 004] act_versions table created');
  console.log('[migration 004] Iteration 0 strategy: lazy — Sprint 2B dispatcher writes originals');
}

module.exports = { up };
