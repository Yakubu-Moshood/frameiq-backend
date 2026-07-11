'use strict';

/**
 * migrations/013_video_secondary_svd.js
 * Repoints channel_dna.video_secondary from its migration-005 seeded
 * default ('wan_2_1') to 'svd' (Stable Video Diffusion via Replicate) --
 * the actual working fallback tier this change implements. video_tertiary
 * ('ltx_video') is left untouched: it remains an unimplemented placeholder,
 * same as before, and providers/provider-router.cjs already skips any
 * provider name it doesn't have a registered module for.
 *
 * Why this is needed (not just a code fix like the images side got):
 * write-image-generator.js's bug was a pure key mismatch -- it checked for
 * 'fal' instead of the real seeded 'flux' value, so fixing the code alone
 * (using 'flux' as the registry key) was enough, no data change required.
 * Animation has no equivalent existing value to align with: neither
 * 'wan_2_1' nor 'ltx_video' is being implemented this pass, so without
 * this migration, providers/video/svd.cjs's 'svd' key would never appear
 * anywhere in any channel's actual video_primary/secondary/tertiary chain
 * and would never be reached no matter how the router is wired.
 *
 * Only updates rows that still hold the original seeded placeholder
 * ('wan_2_1') -- any channel a human already reconfigured away from that
 * default is left alone.
 *
 * No existing columns are added or removed. Safe to run against any DB
 * state that already has migration 005 applied.
 */

async function up({ run, all }) {
  const before = await all(`SELECT id, video_secondary FROM channel_dna WHERE video_secondary = 'wan_2_1'`, []);

  if (before.length === 0) {
    console.log('[migration 013] No channel_dna rows have video_secondary = \'wan_2_1\' — nothing to update');
    return;
  }

  await run(`UPDATE channel_dna SET video_secondary = 'svd' WHERE video_secondary = 'wan_2_1'`);
  console.log(`[migration 013] channel_dna.video_secondary: 'wan_2_1' -> 'svd' for ${before.length} channel(s): ${before.map(r => r.id).join(', ')}`);
}

module.exports = { up };
