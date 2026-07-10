/**
 * Migration 010 — Post-render QA stage columns
 *
 * Implements qa-stage-implementation-spec.md section 4.5, reconciled
 * against the existing `episodes.status` column's live usage:
 *
 * The spec asks to "extend the episode record's status field with two new
 * terminal states after render: READY_FOR_REVIEW / NEEDS_QA_REVIEW."
 * Taken literally, that would repurpose `status` away from 'complete' —
 * but `status === 'complete'` is already a load-bearing check elsewhere
 * (routes/episodes.js's /download and /short/generate endpoints gate on
 * it; the frontend's EpisodePage almost certainly does too). Overloading
 * it risks breaking those existing, working gates for a QA feature that's
 * supposed to be purely additive (spec Decision 3).
 *
 * Instead, this migration adds a SEPARATE `qa_status` field
 * ('ready_for_review' | 'needs_qa_review' | null-if-not-yet-QA'd or
 * unconfigured), plus `qa_results` (JSON: which specific check failed and
 * why, per spec section 4.5's requirement) and `qa_checked_at`. The
 * dashboard can render a QA badge off `qa_status` without any existing
 * `status === 'complete'` check anywhere in the app needing to change.
 * `episodes.status` itself is untouched by this migration.
 */

async function up({ run, all }) {
  const colInfo = await all(`PRAGMA table_info(episodes)`);
  const existing = new Set(colInfo.map(c => c.name));

  const newCols = [
    ['qa_status', 'TEXT'],
    ['qa_results', 'TEXT'],
    ['qa_checked_at', 'TEXT'],
  ];

  for (const [col, def] of newCols) {
    if (!existing.has(col)) {
      await run(`ALTER TABLE episodes ADD COLUMN ${col} ${def}`);
      console.log(`[migrations] Added column: episodes.${col}`);
    }
  }
}

module.exports = { up };
