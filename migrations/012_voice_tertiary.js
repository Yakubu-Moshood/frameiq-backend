'use strict';

/**
 * migrations/012_voice_tertiary.js
 * Adds the third voice-provider tier (Coqui XTTS-v2, via Replicate) to
 * channel_dna, alongside the existing voice_primary/voice_secondary pair
 * from migration 005.
 *
 * channel_dna.voice_tertiary  -- TEXT, defaults to 'coqui_xtts' for every
 *   existing channel, same seeding convention migration 005 used for
 *   voice_primary ('elevenlabs') / voice_secondary ('openai_tts') and for
 *   image_tertiary/video_tertiary (both seeded immediately for all
 *   channels, not opt-in). voice-router.cjs's generateVoice() reads this
 *   the same way it already reads voice_primary/voice_secondary.
 *
 * channel_dna.voice_id_coqui  -- TEXT, nullable, no default. Unlike
 *   voice_id_elevenlabs/voice_id_openai (simple provider voice-ID strings),
 *   Coqui XTTS-v2 is reference-audio voice cloning -- this column holds a
 *   path or public URL to a >=6s reference audio clip, not a literal ID.
 *   Named voice_id_coqui rather than something like voice_ref_audio_coqui
 *   only to keep the column-naming convention consistent with its two
 *   siblings; see providers/voice/coqui-xtts.cjs's header comment and
 *   voice-router.cjs's voiceId-resolution branch for where this distinction
 *   actually matters. Left NULL for every channel here -- no channel has a
 *   real reference-audio clip recorded yet, and fabricating one would be
 *   worse than leaving it genuinely empty until a real clip is chosen.
 *
 * No existing columns are modified or removed. No existing data is
 * affected. Safe to run against any DB state that already has migration
 * 005 applied (channel_dna must already have voice_primary/voice_secondary
 * for this to be a meaningful sibling addition, though the ALTER itself
 * doesn't technically depend on it).
 */

async function up({ run, all }) {
  const channelCols = await all(`PRAGMA table_info(channel_dna)`, []);
  const channelColNames = new Set(channelCols.map(c => c.name));

  const additions = [
    ['voice_tertiary', "TEXT DEFAULT 'coqui_xtts'"],
    ['voice_id_coqui', 'TEXT'],
  ];

  for (const [col, def] of additions) {
    if (!channelColNames.has(col)) {
      await run(`ALTER TABLE channel_dna ADD COLUMN ${col} ${def}`);
      console.log(`[migration 012] channel_dna.${col} added`);
    } else {
      console.log(`[migration 012] channel_dna.${col} already exists — skipping`);
    }
  }

  console.log(`[migration 012] voice_tertiary complete`);
}

module.exports = { up };
