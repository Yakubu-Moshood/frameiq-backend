'use strict';

/**
 * Adds an optional per-channel shot motion cap.
 *
 * NULL preserves the existing render behaviour. Empire Omitted opts in at
 * seven seconds; other channels remain unchanged until they set a value.
 */
async function up({ run, all }) {
  const cols = await all(`PRAGMA table_info(channel_dna)`, []);
  const names = new Set(cols.map(c => c.name));

  if (!names.has('max_shot_duration_sec')) {
    await run(`ALTER TABLE channel_dna ADD COLUMN max_shot_duration_sec REAL`);
    console.log('[migration 015] channel_dna.max_shot_duration_sec added');
  } else {
    console.log('[migration 015] channel_dna.max_shot_duration_sec already exists — skipping column');
  }

  await run(
    `UPDATE channel_dna
     SET max_shot_duration_sec = 7,
         updated_at = datetime('now')
     WHERE id = 'EmpireOmitted'
       AND max_shot_duration_sec IS NULL`
  );
  console.log('[migration 015] EmpireOmitted max shot duration set to 7s when unset');
}

module.exports = { up };
