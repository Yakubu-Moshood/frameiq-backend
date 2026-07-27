'use strict';

/**
 * Adds an explicit opt-in for the fixed episode-opening structure.
 *
 * Disabled by default so existing script generation remains unchanged for
 * every channel. Empire Omitted is the only channel enabled here.
 */
async function up({ run, all }) {
  const cols = await all(`PRAGMA table_info(channel_dna)`, []);
  const names = new Set(cols.map(c => c.name));

  if (!names.has('episode_opening_enabled')) {
    await run(
      `ALTER TABLE channel_dna
       ADD COLUMN episode_opening_enabled INTEGER NOT NULL DEFAULT 0`
    );
    console.log('[migration 016] channel_dna.episode_opening_enabled added');
  } else {
    console.log('[migration 016] channel_dna.episode_opening_enabled already exists — skipping column');
  }

  await run(
    `UPDATE channel_dna
     SET episode_opening_enabled = 1,
         updated_at = datetime('now')
     WHERE id = 'EmpireOmitted'`
  );
  console.log('[migration 016] EmpireOmitted episode opening enabled');
}

module.exports = { up };
