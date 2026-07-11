'use strict';

/**
 * migrations/014_revision_dispatch_result.js
 * Revision dispatcher — Sprint 2B
 *
 * Adds one column so the frontend can show *why* a revision succeeded or
 * failed, not just its status pill:
 *
 *   revisions.result_detail  TEXT, nullable.
 *     - On successful dispatch: a short human-readable summary of what was
 *       regenerated (e.g. "Regenerated 3 image(s) for Act 1: shot_012,
 *       shot_014, shot_015").
 *     - On failed dispatch: the error message.
 *     - NULL while status is 'queued' or 'cancelled' (nothing has run yet).
 *
 * No other schema change needed for the dispatcher:
 *   - revisions.status already has no CHECK constraint (plain TEXT), so
 *     'running'/'complete'/'failed' need no migration -- only
 *     routes/revisions.js's application-level PATCH guard needs loosening
 *     (done in the same commit as this migration, not in this file).
 *   - act_versions (migration 004) already has every column the dispatcher
 *     needs for its audit-log row per applied revision (iteration,
 *     asset_path, revision_id, approved) -- see revision-dispatcher.js's
 *     header comment for why it's used as a history log rather than the
 *     pipeline's live asset source.
 *
 * Idempotency pattern matches migrations 011/012/013: check
 * PRAGMA table_info(revisions) before ALTER TABLE.
 */

async function up({ run, all }) {
  const revisionCols = await all(`PRAGMA table_info(revisions)`, []);
  const colNames = new Set(revisionCols.map(c => c.name));

  if (colNames.has('result_detail')) {
    console.log('[migration 014] revisions.result_detail already exists — skipping');
    return;
  }

  await run(`ALTER TABLE revisions ADD COLUMN result_detail TEXT`);
  console.log('[migration 014] revisions.result_detail added');
}

module.exports = { up };
