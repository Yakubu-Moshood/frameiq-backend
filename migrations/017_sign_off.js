'use strict';

/**
 * Adds an explicit opt-in for the fixed narration sign-off.
 *
 * Disabled by default so existing final-act narration remains unchanged for
 * every channel. Empire Omitted is the only channel enabled here.
 */
async function up({ run, all }) {
  const cols = await all(`PRAGMA table_info(channel_dna)`, []);
  const names = new Set(cols.map(c => c.name));

  if (!names.has('sign_off_enabled')) {
    await run(
      `ALTER TABLE channel_dna
       ADD COLUMN sign_off_enabled INTEGER NOT NULL DEFAULT 0`
    );
    console.log('[migration 017] channel_dna.sign_off_enabled added');
  } else {
    console.log('[migration 017] channel_dna.sign_off_enabled already exists — skipping column');
  }

  await run(
    `UPDATE channel_dna
     SET sign_off_enabled = 1,
         updated_at = datetime('now')
     WHERE id = 'EmpireOmitted'`
  );
  console.log('[migration 017] EmpireOmitted sign-off enabled');
}

module.exports = { up };
