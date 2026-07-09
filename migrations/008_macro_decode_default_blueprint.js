/**
 * Migration 008 — Macro Decode default_blueprint_id correction
 *
 * Macro Decode's channel_dna row has always listed 'finance_explainer'
 * as an *allowed* blueprint (allowed_blueprints includes it), but its
 * *default* (default_blueprint_id) was left at 'documentary' — the
 * generic value every channel row got when that column was introduced.
 * NewEpisodePage.jsx's blueprint picker will start reading this column
 * per-channel (see routes/channels.js toChannelResponse()), so Macro
 * Decode should default to the blueprint that actually matches its own
 * DNA rather than the generic documentary one.
 *
 * Matches on the stable `id` primary key ('MoneyExplained'), same as
 * migration 007 — NOT on `label`, per the label-matching bug documented
 * there.
 *
 * Does not touch any other channel's row, any other column on this
 * row, or EmpireOmitted-Pipeline / Empire Omitted's own DNA values.
 */

const MACRO_DECODE_ID = 'MoneyExplained'; // stable PK, unchanged
const NEW_DEFAULT_BLUEPRINT = 'finance_explainer';

async function up({ run, get }) {
  const existing = await get(`SELECT id, default_blueprint_id FROM channel_dna WHERE id = ?`, [MACRO_DECODE_ID]);

  if (!existing) {
    console.log(`[008] No channel_dna row found for id "${MACRO_DECODE_ID}" — skipping (nothing to correct)`);
    return;
  }

  await run(
    `UPDATE channel_dna SET default_blueprint_id = ?, updated_at = datetime('now') WHERE id = ?`,
    [NEW_DEFAULT_BLUEPRINT, MACRO_DECODE_ID]
  );

  console.log(
    `[008] channel_dna.default_blueprint_id for "${MACRO_DECODE_ID}" corrected: ` +
    `"${existing.default_blueprint_id}" -> "${NEW_DEFAULT_BLUEPRINT}"`
  );
}

module.exports = { up };
