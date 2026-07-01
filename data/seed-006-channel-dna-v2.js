/**
 * seed-006-channel-dna-v2.js
 * Populates all Channel DNA v2 fields for all 5 channels.
 * Matches on existing label column — safe to re-run (UPDATE only, no INSERT).
 */

const channelSeeds = [
  {
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
    label:                  'MoneyExplained',
    channel_id:             'money-explained',
    slug:                   'money-explained',
    active:                 1,
    blueprint_label:        'Educational',
    ui_theme_color:         '#1B3A6B',
    target_length_minutes:  5,
    research_depth:         'standard',
    narration_style:        'calm-explainer',
    script_pacing:          'steady',
    image_style:            'clean-infographic',
    image_motion:           'still',
    animation_style:        'none',
    music_style:            'finance-clean',
    music_tempo:            'medium',
    title_category_hints:   JSON.stringify([
      'money-systems', 'personal-finance', 'economic-concepts',
      'financial-history', 'how-money-works'
    ]),
  },
  {
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
      `SELECT id FROM channel_dna WHERE label = ?`, [ch.label]
    );

    if (existing.length === 0) {
      console.log(`[seed-006] No row found for label "${ch.label}" — skipping`);
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
      WHERE label = ?
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
      ch.label,
    ]);

    console.log(`[seed-006] Updated: ${ch.label} (active: ${ch.active})`);
  }

  console.log('[seed-006] Done.');
}

module.exports = { seedChannelDnaV2 };
