/**
 * Migration 006 — Channel DNA v2
 * Adds full pipeline-awareness columns to channel_dna:
 * channel_id, slug, active, blueprint_label, ui_theme_color,
 * target_length_minutes, research_depth, narration_style,
 * script_pacing, image_style, image_motion, animation_style,
 * music_style, music_tempo, title_category_hints
 */

async function up({ run, all }) {
  const colInfo  = await all(`PRAGMA table_info(channel_dna)`);
  const existing = new Set(colInfo.map(c => c.name));

  const newCols = [
    ['channel_id',             "TEXT DEFAULT ''"],
    ['slug',                   "TEXT DEFAULT ''"],
    ['active',                 'INTEGER DEFAULT 1'],
    ['blueprint_label',        "TEXT DEFAULT 'Investigative'"],
    ['ui_theme_color',         "TEXT DEFAULT '#B8860B'"],
    ['target_length_minutes',  'INTEGER DEFAULT 10'],
    ['research_depth',         "TEXT DEFAULT 'standard'"],
    ['narration_style',        "TEXT DEFAULT 'dramatic-investigative'"],
    ['script_pacing',          "TEXT DEFAULT 'slow-build'"],
    ['image_style',            "TEXT DEFAULT 'dark-moody'"],
    ['image_motion',           "TEXT DEFAULT 'subtle-ken-burns'"],
    ['animation_style',        "TEXT DEFAULT 'minimal'"],
    ['music_style',            "TEXT DEFAULT 'corporate-tension'"],
    ['music_tempo',            "TEXT DEFAULT 'slow'"],
    ['title_category_hints',   "TEXT DEFAULT '[]'"],
  ];

  for (const [col, def] of newCols) {
    if (!existing.has(col)) {
      await run(`ALTER TABLE channel_dna ADD COLUMN ${col} ${def}`);
      console.log(`[006] Added column: channel_dna.${col}`);
    } else {
      console.log(`[006] Column already exists, skipping: ${col}`);
    }
  }

  console.log('[006] channel_dna_v2 complete');
}

module.exports = { up };
