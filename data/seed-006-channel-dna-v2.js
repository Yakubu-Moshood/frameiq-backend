/**
 * seed-006-channel-dna-v2.js
 * Populates all Channel DNA v2 fields for all 5 channels.
 *
 * Matches on the stable `id` primary key, NOT on the free-text `label`
 * column. This was previously a label match (`WHERE label = ?`) and it
 * silently matched zero rows for every channel, because these seed
 * entries used no-space PascalCase label values ('EmpireOmitted',
 * 'MoneyExplained', ...) while the real channel_dna.label values have
 * spaces ('Empire Omitted', 'Money Explained', ...) — set once at
 * row-creation time in data/seed-sprint1a.js. `id` has no such
 * typo/formatting risk, so every entry below now carries an explicit
 * `id` and the query matches on that instead.
 *
 * NOTE: as of migration 007, the Money Explained row's `label` has been
 * renamed to "Macro Decode" and its DNA fields are owned by
 * migrations/007_macro_decode_rename.js, not this file. The entry below
 * is kept in sync for documentation/re-seed purposes but migration 007
 * is the actual enforcement point for that channel.
 *
 * Safe to re-run (UPDATE only, no INSERT).
 */

const channelSeeds = [
  {
    id:                     'EmpireOmitted',
    label:                  'EmpireOmitted',
    channel_id:             'empire-omitted',
    slug:                   'empire-omitted',
    active:                 1,
    blueprint_label:        'Investigative',
    ui_theme_color:         '#B8860B',
    target_length_minutes:  10,
    research_depth:         'deep',
    narration_style:        'dramatic-investigative',
    script_pacing:          'slow-build',
    image_style:            'dark-moody-cinematic',
    image_motion:           'subtle-ken-burns',
    animation_style:        'minimal',
    music_style:            'corporate-tension',
    music_tempo:            'slow',
    title_category_hints:   JSON.stringify([
      'corporate-fraud', 'executive-misconduct',
      'financial-scandal', 'cover-up', 'whistleblower'
    ]),
  },
  {
    // Renamed from "Money Explained" to "Macro Decode" (SEO decision).
    // DNA below matches migrations/007_macro_decode_rename.js, which is
    // the actual enforcement point — kept in sync here for re-seed use.
    id:                     'MoneyExplained',
    label:                  'MoneyExplained', // historical/documentation only — see renameLabelTo below
    renameLabelTo:          'Macro Decode',
    channel_id:             'macro-decode',
    slug:                   'macro-decode',
    active:                 1,
    blueprint_label:        'Educational',
    ui_theme_color:         '#0F2A4A',
    target_length_minutes:  12,
    research_depth:         'standard',
    narration_style:        'crisp-analytical-direct',
    script_pacing:          'fast-dense',
    image_style:            'clean-infographic',
    image_motion:           'animated-data-viz',
    animation_style:        'motion-graphics-only',
    music_style:            'electronic-rhythmic',
    music_tempo:            'fast',
    title_category_hints:   JSON.stringify([
      'financial-systems-explained', 'money-investigations',
      'economic-deep-dives', 'personal-finance-mechanics'
    ]),
  },
  {
    id:                     'TrueCrimeWeekly',
    label:                  'TrueCrimeWeekly',
    channel_id:             'true-crime-weekly',
    slug:                   'true-crime-weekly',
    active:                 1,
    blueprint_label:        'Dark Thriller',
    ui_theme_color:         '#8B0000',
    target_length_minutes:  10,
    research_depth:         'deep',
    narration_style:        'suspenseful',
    script_pacing:          'fast-cut',
    image_style:            'cinematic-crime',
    image_motion:           'dramatic',
    animation_style:        'dramatic',
    music_style:            'true-crime-ambient',
    music_tempo:            'slow',
    title_category_hints:   JSON.stringify([
      'unsolved-cases', 'cold-cases', 'criminal-investigations',
      'missing-persons', 'serial-crimes'
    ]),
  },
  {
    id:                     'HistoryHidden',
    label:                  'HistoryHidden',
    channel_id:             'history-hidden',
    slug:                   'history-hidden',
    active:                 1,
    blueprint_label:        'Archival',
    ui_theme_color:         '#8B6914',
    target_length_minutes:  10,
    research_depth:         'deep',
    narration_style:        'reflective-historical',
    script_pacing:          'slow-build',
    image_style:            'archival-sepia',
    image_motion:           'subtle-ken-burns',
    animation_style:        'minimal',
    music_style:            'historical-orchestral',
    music_tempo:            'slow',
    title_category_hints:   JSON.stringify([
      'suppressed-history', 'forgotten-events',
      'hidden-figures', 'lost-civilisations', 'declassified'
    ]),
  },
  {
    id:                     'ServedCold',
    label:                  'ServedCold',
    channel_id:             'served-cold',
    slug:                   'served-cold',
    active:                 0,
    blueprint_label:        'Revenge Comedy',
    ui_theme_color:         '#D2691E',
    target_length_minutes:  8,
    research_depth:         'standard',
    narration_style:        'sardonic',
    script_pacing:          'steady',
    image_style:            'reddit-meme-illustrated',
    image_motion:           'still',
    animation_style:        'none',
    music_style:            'reddit-quirky',
    music_tempo:            'upbeat',
    title_category_hints:   JSON.stringify([
      'r/ProRevenge', 'r/NuclearRevenge',
      'r/MaliciousCompliance', 'r/pettyrevenge'
    ]),
  },
];

async function seedChannelDnaV2(dbRun, dbAll) {
  console.log('[seed-006] Seeding Channel DNA v2 values...');

  for (const ch of channelSeeds) {
    const existing = await dbAll(
      `SELECT id FROM channel_dna WHERE id = ?`, [ch.id]
    );

    if (existing.length === 0) {
      console.log(`[seed-006] No row found for id "${ch.id}" — skipping`);
      continue;
    }

    await dbRun(`
      UPDATE channel_dna SET
        channel_id            = ?,
        slug                  = ?,
        active                = ?,
        blueprint_label       = ?,
        ui_theme_color        = ?,
        target_length_minutes = ?,
        research_depth        = ?,
        narration_style       = ?,
        script_pacing         = ?,
        image_style           = ?,
        image_motion          = ?,
        animation_style       = ?,
        music_style           = ?,
        music_tempo           = ?,
        title_category_hints  = ?,
        updated_at            = datetime('now')
      WHERE id = ?
    `, [
      ch.channel_id,
      ch.slug,
      ch.active,
      ch.blueprint_label,
      ch.ui_theme_color,
      ch.target_length_minutes,
      ch.research_depth,
      ch.narration_style,
      ch.script_pacing,
      ch.image_style,
      ch.image_motion,
      ch.animation_style,
      ch.music_style,
      ch.music_tempo,
      ch.title_category_hints,
      ch.id,
    ]);

    // Only rename the label when this seed entry explicitly asks for it
    // (Macro Decode). Other channels' `label` field here is a leftover
    // no-space identifier used only for historical/documentation
    // purposes and must NOT overwrite their real (space-containing)
    // channel_dna.label values — that would be an unrequested rename of
    // channels outside this task's scope, Empire Omitted included.
    if (ch.renameLabelTo) {
      await dbRun(`UPDATE channel_dna SET label = ?, updated_at = datetime('now') WHERE id = ?`, [ch.renameLabelTo, ch.id]);
      console.log(`[seed-006] Renamed label for id "${ch.id}" -> "${ch.renameLabelTo}"`);
    }

    console.log(`[seed-006] Updated DNA fields for id: ${ch.id} (active: ${ch.active})`);
  }

  console.log('[seed-006] Done.');
}

module.exports = { seedChannelDnaV2 };
