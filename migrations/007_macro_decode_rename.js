/**
 * Migration 007 — Rename "Money Explained" to "Macro Decode"
 *
 * The "Money Explained" channel_dna row is being renamed to Macro Decode
 * (SEO decision) and its creative DNA populated per the authoritative
 * brief: macro-decode-channel-dna-v2.md.
 *
 * IMPORTANT: matches on the stable `id` primary key, NOT on `label`.
 * data/seed-006-channel-dna-v2.js previously tried to match on
 * `label = 'MoneyExplained'` (no space) against a row whose real label
 * was `'Money Explained'` (with a space) — that mismatch meant the
 * update silently affected zero rows, for every channel it seeded, not
 * just this one. `id` was set once at row-creation time
 * (data/seed-sprint1a.js) and has no free-text-typo risk, so this
 * migration — and the fixed seed-006 script — both match on it instead.
 *
 * Does not touch any other channel's row, and does not touch
 * EmpireOmitted-Pipeline or Empire Omitted's own DNA values.
 *
 * Open items intentionally NOT resolved by this migration (see the
 * accompanying build report):
 *   - `elevenlabs_voice_id` is left as-is (TxGEqnHWrfWFTfGW9XjX / "Josh").
 *     The DNA doc asks that this be confirmed crisp/confident/analytical
 *     by ear before being trusted under the new name — that needs a
 *     human listen, not a code change.
 *   - `ui_theme_color` below is a provisional navy hex, NOT a confirmed
 *     brand value — the DNA doc explicitly says not to assume one.
 *   - `animation_style: 'motion-graphics-only'` is a new value this
 *     migration introduces. surface-animator.cjs now recognises it and
 *     skips fal.ai Kling cinematic animation for it, but no module in
 *     this pipeline yet renders the animated-chart / counting-number
 *     visuals the DNA doc requires — that is unbuilt, not just
 *     unconfigured.
 */

const MACRO_DECODE_ID = 'MoneyExplained'; // stable PK — intentionally NOT renamed, only label/DNA fields change

async function up({ run, get }) {
  const existing = await get(`SELECT id FROM channel_dna WHERE id = ?`, [MACRO_DECODE_ID]);

  if (!existing) {
    console.log(`[007] No channel_dna row found for id "${MACRO_DECODE_ID}" — skipping (nothing to rename)`);
    return;
  }

  await run(`
    UPDATE channel_dna SET
      label                  = ?,
      channel_id             = ?,
      slug                   = ?,
      watermark_text         = ?,
      outro_file             = ?,
      blueprint_label        = ?,
      ui_theme_color         = ?,
      target_length_minutes  = ?,
      research_depth         = ?,
      narration_style        = ?,
      script_pacing          = ?,
      image_style            = ?,
      image_motion           = ?,
      animation_style        = ?,
      music_style            = ?,
      music_tempo            = ?,
      title_category_hints   = ?,
      updated_at             = datetime('now')
    WHERE id = ?
  `, [
    'Macro Decode',
    'macro-decode',
    'macro-decode',
    'MACRO DECODE',
    'outro_MacroDecode.mp4',
    'Educational',
    '#0F2A4A',                  // provisional navy — confirm against real brand hex before locking
    12,                          // DNA doc: 10-15 min, tighter than documentary channels
    'standard',
    'crisp-analytical-direct',   // replaces placeholder 'calm-explainer'
    'fast-dense',                // Curiosity Loop timestamp structure, not five-act rise/fall
    'clean-infographic',
    'animated-data-viz',         // charts must build/animate, numbers must count up — static graphs disallowed
    'motion-graphics-only',      // NOT 'none' — see caveats above and build report
    'electronic-rhythmic',
    'fast',
    JSON.stringify([
      'financial-systems-explained', 'money-investigations',
      'economic-deep-dives', 'personal-finance-mechanics'
    ]),
    MACRO_DECODE_ID,
  ]);

  console.log('[007] channel_dna row renamed: id "MoneyExplained" -> label "Macro Decode", DNA fields populated');
}

module.exports = { up };
