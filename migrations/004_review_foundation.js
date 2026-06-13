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
 *   act_versions is created empty. Iteration 0 records (originals)
 *   are written by the Sprint 2B regeneration dispatcher when it first
 *   regenerates an act — not during this migration. There is nothing
 *   Sprint 2A can usefully do with iteration 0 records (no version
 *   switcher, no comparison UI, no regeneration). Populating them now
 *   would produce ghost rows with null asset_path values.
 *
 * No existing tables are modified.
 * No existing data is affected.
 * Rollback: DROP TABLE revisions; DROP TABLE act_versions;
 */

async function up(db) {
  // ── revisions ──────────────────────────────────────────────────────────────
  // One row per revision request from the creator.
  // status: queued | cancelled
  //   Sprint 2B will add: running | complete | failed
  // iteration: null in Sprint 2A — set by Sprint 2B dispatcher when job fires
  // revision_type values: script | voice | image | anim | full_act
  await db.run(`
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

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_revisions_episode_id
    ON revisions(episode_id)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_revisions_episode_act
    ON revisions(episode_id, act)
  `);

  // ── act_versions ───────────────────────────────────────────────────────────
  // One row per versioned act render.
  // iteration 0 = original (written by Sprint 2B dispatcher, not here)
  // iteration 1+ = revisions produced by Sprint 2B regeneration jobs
  // asset_path: null in Sprint 2A — populated by Sprint 2B when render completes
  // approved: false by default — creator approves via Review workspace
  await db.run(`
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

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_act_versions_episode_id
    ON act_versions(episode_id)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_act_versions_episode_act
    ON act_versions(episode_id, act)
  `);

  console.log('[migration 004] revisions table created');
  console.log('[migration 004] act_versions table created');
  console.log('[migration 004] Iteration 0 strategy: lazy — Sprint 2B dispatcher writes originals');
}

module.exports = { up };
