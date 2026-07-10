/**
 * migrations/011_served_cold_channel_row.js
 * Insert a real channel_dna row for Served Cold.
 *
 * Context: data/seed-006-channel-dna-v2.js already has a full v2 DNA entry
 * for id='ServedCold' (label 'Served Cold', ui_theme_color '#D2691E',
 * blueprint 'Revenge Comedy', etc.) but that seed only ever UPDATEs an
 * existing row -- it explicitly skips (by design, see its header comment)
 * creating one if missing. No other file in this codebase ever INSERTs a
 * base channel_dna row for Served Cold. The result: unless someone
 * inserted it by hand directly on the live Railway DB, Served Cold has
 * NO row at all, so any lookup by id returns nothing -- which is exactly
 * the "missing channel" case the BRANDS-consolidation fix needs to handle
 * (see pipeline-updates/surface-renderer.cjs and short-extractor.cjs).
 *
 * This migration inserts the missing base row (v1 schema columns, INSERT
 * OR IGNORE so it's a no-op if the row already exists from some other
 * path) using the same watermark/colour/voice conventions as the other 4
 * channels in data/seed-sprint1a.js, plus the v2 DNA fields already
 * defined for it in seed-006 (folded in directly here since seed-006 will
 * not re-run against an already-applied migration 006).
 *
 * Known limitation (flagged, not fixed by this migration): production's
 * pipeline.config.json lives on the Railway volume at
 * /data/pipeline/pipeline.config.json, is not git-tracked, and is not
 * accessible from this repo/sandbox. jobs/runner.js's
 * runFullRenderWorkflow() throws immediately if CONFIG.channels[channelKey]
 * is missing, regardless of what's in channel_dna. So this migration makes
 * Served Cold fully correct on the DB/branding side, but an actual Served
 * Cold episode will still need a corresponding manual entry added to that
 * file before it can run end-to-end. Flagging rather than assuming it
 * works -- verifying/fixing that file requires live Railway volume access
 * this sandbox does not have.
 */

const SERVED_COLD_ID = 'ServedCold';

async function up({ run, get }) {
  const existing = await get(`SELECT id FROM channel_dna WHERE id = ?`, [SERVED_COLD_ID]);
  if (existing) {
    console.log(`[011] channel_dna row for "${SERVED_COLD_ID}" already exists — skipping insert`);
    return;
  }

  await run(
    `INSERT INTO channel_dna
       (id, label, description, brand_voice, primary_colour, secondary_colour,
        background_colour, font_display, font_body, watermark_text, outro_file,
        elevenlabs_voice_id, voice_style_notes, default_blueprint_id,
        allowed_blueprints, target_audience, dna_extensions,
        channel_id, slug, active, blueprint_label, ui_theme_color,
        target_length_minutes, research_depth, narration_style, script_pacing,
        image_style, image_motion, animation_style, music_style, music_tempo,
        title_category_hints)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      SERVED_COLD_ID,
      'Served Cold',
      'Revenge-comedy story videos with a sharp, sardonic voice.',
      'Sardonic, sharp, comedic payback. Tone: petty-revenge Reddit thread narrated with relish. Funny because it is true.',
      '#D2691E',   // matches seed-006's ui_theme_color so v1/v2 colour fields agree
      '#3B1F0E',
      '#1A0E05',
      'Bebas Neue',
      'Barlow',
      'SERVED COLD',
      'outro_ServedCold.mp4',
      null,        // no elevenlabs_voice_id chosen yet -- flagged, not guessed
      'Voice not yet chosen -- needs a confirmed sardonic/comedic pick before this channel goes live.',
      'documentary', // placeholder default_blueprint_id; harmless until pipeline.config.json defines this channel's real blueprint set
      JSON.stringify(['documentary', 'custom']),
      'Adults 18-35 who enjoy r/ProRevenge / r/MaliciousCompliance style stories.',
      JSON.stringify({}),
      'served-cold',
      'served-cold',
      0, // active: 0 -- matches seed-006 (not yet launched), so it won't show in the live channel picker until deliberately flipped on
      'Revenge Comedy',
      '#D2691E',
      8,
      'standard',
      'sardonic',
      'steady',
      'reddit-meme-illustrated',
      'still',
      'none',
      'reddit-quirky',
      'upbeat',
      JSON.stringify(['r/ProRevenge', 'r/NuclearRevenge', 'r/MaliciousCompliance', 'r/pettyrevenge']),
    ]
  );

  console.log(`[011] Inserted channel_dna row for "${SERVED_COLD_ID}" (inactive until launched)`);
}

module.exports = { up };
