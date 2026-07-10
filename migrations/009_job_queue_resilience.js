/**
 * Migration 009 — Job queue resilience (heartbeat + retry tracking)
 *
 * Implements job-queue-resilience-spec.md section 3.1, reconciled against
 * the ACTUAL schema rather than the spec's proposed one:
 *
 * The spec proposes a brand-new `jobs` table keyed by episode_id with a
 * heartbeat/checkpoint/retry_count shape. That collides with the existing
 * `jobs` table (see db.js), which already exists and is keyed per
 * PIPELINE STEP (one row per episode+step, e.g. '0A_script', '1_render'),
 * not per in-flight run. Recreating/renaming it would break every existing
 * query in routes/episodes.js and jobs/runner.js.
 *
 * The runner's actual unit of "an in-flight job" is an EPISODE (tracked via
 * the in-memory `activeEpisodes` Set in jobs/runner.js, one render at a
 * time per episode). So this migration adds the spec's heartbeat/retry
 * fields to the `episodes` table instead — same information the spec
 * wants, attached to the row that actually matches the runner's concept of
 * a "job."
 *
 * `checkpoint_data` from the spec's proposed schema is deliberately NOT
 * added here — investigation of pipeline-updates/surface-renderer.cjs
 * confirmed steps already checkpoint via filesystem existence checks
 * (per-segment, per-act, and Whisper-transcript files are all skipped on
 * re-run if already present — see surface-renderer.cjs lines 274, 288,
 * 595, 717), and jobs/runner.js's 0A-0E steps do the same at a batch
 * level. A DB-tracked checkpoint JSON blob would duplicate a resume
 * mechanism that already exists and is arguably more robust (it survives
 * even if a DB row were lost, since it's keyed off real output files).
 *
 * Does not touch EmpireOmitted-Pipeline, any existing column, or the
 * `jobs` table.
 */

async function up({ run, all }) {
  const colInfo = await all(`PRAGMA table_info(episodes)`);
  const existing = new Set(colInfo.map(c => c.name));

  const newCols = [
    ['last_heartbeat_at', 'TEXT'],
    ['retry_count', 'INTEGER DEFAULT 0'],
  ];

  for (const [col, def] of newCols) {
    if (!existing.has(col)) {
      await run(`ALTER TABLE episodes ADD COLUMN ${col} ${def}`);
      console.log(`[migrations] Added column: episodes.${col}`);
    }
  }
}

module.exports = { up };
