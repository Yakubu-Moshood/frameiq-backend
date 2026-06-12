/**
 * data/seed-sprint1a.js
 * FrameIQ Sprint 1A — seed blueprints, platforms, channel DNA
 *
 * Uses INSERT OR IGNORE — safe to re-run at any time.
 * Called by the migration runner in startup-init.js after 001_sprint1a.sql.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Platform definitions ───────────────────────────────────────────────────

const PLATFORMS = [
  {
    id:                   'youtube_longform',
    label:                'YouTube Long-form',
    max_duration_sec:     null,
    preferred_aspect:     '16:9',
    preferred_resolution: '1920x1080',
    notes:                'Primary platform for documentary and investigative content',
  },
  {
    id:                   'youtube_shorts',
    label:                'YouTube Shorts',
    max_duration_sec:     60,
    preferred_aspect:     '9:16',
    preferred_resolution: '1080x1920',
    notes:                'Auto-generated from Step 7 short extractor',
  },
  {
    id:                   'tiktok',
    label:                'TikTok',
    max_duration_sec:     60,
    preferred_aspect:     '9:16',
    preferred_resolution: '1080x1920',
    notes:                null,
  },
  {
    id:                   'instagram_reels',
    label:                'Instagram Reels',
    max_duration_sec:     90,
    preferred_aspect:     '9:16',
    preferred_resolution: '1080x1920',
    notes:                null,
  },
  {
    id:                   'instagram_carousel',
    label:                'Instagram Carousel',
    max_duration_sec:     null,
    preferred_aspect:     '1:1',
    preferred_resolution: '1080x1080',
    notes:                'Static slides, no video',
  },
  {
    id:                   'linkedin',
    label:                'LinkedIn',
    max_duration_sec:     600,
    preferred_aspect:     '16:9',
    preferred_resolution: '1920x1080',
    notes:                'Also supports carousel posts',
  },
  {
    id:                   'podcast',
    label:                'Podcast / Audio',
    max_duration_sec:     null,
    preferred_aspect:     null,
    preferred_resolution: null,
    notes:                'Audio-first output for commentary blueprint',
  },
];

// ── Asset strategy objects ─────────────────────────────────────────────────

const ASSET_STRATEGIES = {
  full_cinematic: {
    primary_visuals:      'ai_images',
    animation_method:     'fal_kling',
    generation_apis:      ['openai_images', 'fal_ai'],
    ratios:               { clips_pct: 60, stills_pct: 35, motion_graphics_pct: 5 },
    image_style:          'photorealistic',
    supports_charts:      false,
    supports_infographics: false,
    supports_slides:      false,
    max_shots_per_act:    8,
  },
  motion_graphics: {
    primary_visuals:      'motion_graphics',
    animation_method:     'css_motion',
    generation_apis:      ['openai_images'],
    ratios:               { clips_pct: 20, stills_pct: 30, motion_graphics_pct: 50 },
    image_style:          'illustrated',
    supports_charts:      true,
    supports_infographics: true,
    supports_slides:      false,
    max_shots_per_act:    6,
  },
  data_viz: {
    primary_visuals:      'chart_templates',
    animation_method:     'css_motion',
    generation_apis:      ['openai_images'],
    ratios:               { clips_pct: 10, stills_pct: 20, motion_graphics_pct: 70 },
    image_style:          'data_viz',
    supports_charts:      true,
    supports_infographics: true,
    supports_slides:      false,
    max_shots_per_act:    5,
  },
  stills_fast: {
    primary_visuals:      'ai_images',
    animation_method:     'none',
    generation_apis:      ['openai_images'],
    ratios:               { clips_pct: 0, stills_pct: 80, motion_graphics_pct: 20 },
    image_style:          'photorealistic',
    supports_charts:      false,
    supports_infographics: false,
    supports_slides:      false,
    max_shots_per_act:    4,
  },
  stills_minimal: {
    primary_visuals:      'stills_only',
    animation_method:     'none',
    generation_apis:      ['openai_images'],
    ratios:               { clips_pct: 0, stills_pct: 100, motion_graphics_pct: 0 },
    image_style:          'minimal',
    supports_charts:      false,
    supports_infographics: false,
    supports_slides:      false,
    max_shots_per_act:    5,
  },
  slides: {
    primary_visuals:      'slide_templates',
    animation_method:     'none',
    generation_apis:      ['openai_images'],
    ratios:               { clips_pct: 0, stills_pct: 0, motion_graphics_pct: 0 },
    image_style:          'minimal',
    supports_charts:      true,
    supports_infographics: true,
    supports_slides:      true,
    max_shots_per_act:    0,
  },
};

// ── Platform strategy objects ──────────────────────────────────────────────

function makePlatformStrategy(primary, secondary, autoShort, durationMin, formats) {
  return { primary_platform: primary, secondary_platforms: secondary, auto_generate_short: autoShort, default_duration_min: durationMin, output_formats: formats };
}

const LANDSCAPE_FORMAT = { format_id: 'landscape_1080p', resolution: '1920x1080', aspect_ratio: '16:9', max_duration_sec: null,  codec: 'h264', is_primary: true  };
const VERTICAL_FORMAT  = { format_id: 'vertical_1080p',  resolution: '1080x1920', aspect_ratio: '9:16', max_duration_sec: 59,    codec: 'h264', is_primary: false };
const SQUARE_FORMAT    = { format_id: 'square_1080p',    resolution: '1080x1080', aspect_ratio: '1:1',  max_duration_sec: null,  codec: 'h264', is_primary: false };

// ── Blueprint definitions ──────────────────────────────────────────────────

const BLUEPRINTS = [
  {
    id:           'documentary',
    label:        'Documentary',
    description:  'Dark cinematic long-form documentary. Photorealistic imagery, cinematic clips, rich narration. The current default workflow.',
    workflow_type: 'full_render',
    act_structure: JSON.stringify(['act1', 'act2', 'act3', 'act3b', 'act4', 'act5']),
    asset_strategy: JSON.stringify(ASSET_STRATEGIES.full_cinematic),
    platform_strategy: JSON.stringify(makePlatformStrategy(
      'youtube_longform', ['youtube_shorts', 'tiktok'], true, 12,
      [LANDSCAPE_FORMAT, VERTICAL_FORMAT]
    )),
    step_config: JSON.stringify(['0A_script', '0B_vo', '0C_shots', '0D_images', '0E_anim', '1_render', '7_short']),
    is_custom: 0,
  },
  {
    id:           'investigative',
    label:        'Investigative',
    description:  'Crime and scandal deep-dives. Similar to documentary but heavier on stills and text overlays, lighter on animation.',
    workflow_type: 'full_render',
    act_structure: JSON.stringify(['act1', 'act2', 'act3', 'act3b', 'act4', 'act5']),
    asset_strategy: JSON.stringify({ ...ASSET_STRATEGIES.full_cinematic, ratios: { clips_pct: 40, stills_pct: 55, motion_graphics_pct: 5 } }),
    platform_strategy: JSON.stringify(makePlatformStrategy(
      'youtube_longform', ['youtube_shorts'], true, 12,
      [LANDSCAPE_FORMAT, VERTICAL_FORMAT]
    )),
    step_config: JSON.stringify(['0A_script', '0B_vo', '0C_shots', '0D_images', '0E_anim', '1_render', '7_short']),
    is_custom: 0,
  },
  {
    id:           'educational',
    label:        'Educational',
    description:  'Explainer content with motion graphics, illustrated visuals, and clear structured narration.',
    workflow_type: 'motion_graphics',
    act_structure: JSON.stringify(['act1', 'act2', 'act3', 'act4', 'act5']),
    asset_strategy: JSON.stringify(ASSET_STRATEGIES.motion_graphics),
    platform_strategy: JSON.stringify(makePlatformStrategy(
      'youtube_longform', ['linkedin', 'instagram_reels'], true, 8,
      [LANDSCAPE_FORMAT, VERTICAL_FORMAT]
    )),
    step_config: JSON.stringify(['0A_script', '0B_vo', '0C_graphic', '0D_graphic', '1_graphic', '7_short']),
    is_custom: 0,
  },
  {
    id:           'finance_explainer',
    label:        'Finance Explainer',
    description:  'Charts, graphs, data visualisation, and financial analysis. Clean data-driven presentation.',
    workflow_type: 'motion_graphics',
    act_structure: JSON.stringify(['act1', 'act2', 'act3', 'act4', 'act5']),
    asset_strategy: JSON.stringify(ASSET_STRATEGIES.data_viz),
    platform_strategy: JSON.stringify(makePlatformStrategy(
      'youtube_longform', ['linkedin', 'tiktok'], true, 8,
      [LANDSCAPE_FORMAT, VERTICAL_FORMAT]
    )),
    step_config: JSON.stringify(['0A_script', '0B_vo', '0C_graphic', '0D_graphic', '1_graphic', '7_short']),
    is_custom: 0,
  },
  {
    id:           'news',
    label:        'News Brief',
    description:  'Short punchy news summary. 3-act structure, no animation, direct to short-form output.',
    workflow_type: 'short_render',
    act_structure: JSON.stringify(['act1', 'act2', 'act3']),
    asset_strategy: JSON.stringify(ASSET_STRATEGIES.stills_fast),
    platform_strategy: JSON.stringify(makePlatformStrategy(
      'youtube_shorts', ['tiktok', 'instagram_reels'], false, 1,
      [VERTICAL_FORMAT]
    )),
    step_config: JSON.stringify(['0A_short', '0B_vo', '0D_images', '1_short', '7_short']),
    is_custom: 0,
  },
  {
    id:           'commentary',
    label:        'Commentary',
    description:  'Opinion and analysis. Voiceover-led with minimal visuals. Suitable for podcast-style content.',
    workflow_type: 'vo_only',
    act_structure: JSON.stringify(['act1', 'act2', 'act3', 'act4']),
    asset_strategy: JSON.stringify(ASSET_STRATEGIES.stills_minimal),
    platform_strategy: JSON.stringify(makePlatformStrategy(
      'youtube_longform', ['podcast'], false, 10,
      [LANDSCAPE_FORMAT]
    )),
    step_config: JSON.stringify(['0A_script', '0B_vo', '0D_stills', '1_simple']),
    is_custom: 0,
  },
  {
    id:           'carousel',
    label:        'Carousel',
    description:  'Slide-based content for social platforms. Static graphics, minimal animation, no documentary workflow.',
    workflow_type: 'carousel',
    act_structure: JSON.stringify([]),
    asset_strategy: JSON.stringify(ASSET_STRATEGIES.slides),
    platform_strategy: JSON.stringify(makePlatformStrategy(
      'instagram_carousel', ['linkedin'], false, null,
      [SQUARE_FORMAT]
    )),
    step_config: JSON.stringify(['0A_carousel', '0D_slides', '1_export']),
    is_custom: 0,
  },
  {
    id:           'motivation',
    label:        'Motivation',
    description:  'Short inspirational content. Bold typography, powerful stills, 30–60 seconds.',
    workflow_type: 'short_render',
    act_structure: JSON.stringify(['act1', 'act2', 'act3']),
    asset_strategy: JSON.stringify(ASSET_STRATEGIES.stills_fast),
    platform_strategy: JSON.stringify(makePlatformStrategy(
      'tiktok', ['instagram_reels', 'youtube_shorts'], false, 1,
      [VERTICAL_FORMAT]
    )),
    step_config: JSON.stringify(['0A_short', '0B_vo', '0D_images', '1_short']),
    is_custom: 0,
  },
  {
    id:           'custom',
    label:        'Custom',
    description:  'User-defined blueprint. All settings configurable.',
    workflow_type: 'configurable',
    act_structure: JSON.stringify([]),
    asset_strategy: JSON.stringify(ASSET_STRATEGIES.full_cinematic),
    platform_strategy: JSON.stringify(makePlatformStrategy(
      'youtube_longform', [], false, null,
      [LANDSCAPE_FORMAT]
    )),
    step_config: JSON.stringify([]),
    is_custom: 1,
  },
];

// ── Channel DNA ────────────────────────────────────────────────────────────
// Migrated from pipeline.config.json — this is the same data,
// now stored in the DB for future management via the API.

const CHANNEL_DNA = [
  {
    id:                   'EmpireOmitted',
    label:                'Empire Omitted',
    description:          'Corporate scandals, financial fraud, and the stories they paid to keep quiet.',
    brand_voice:          'Dark, authoritative, cinematic. Tone: BBC documentary meets true crime. Never sensational — devastating through facts alone.',
    primary_colour:       '#C9A84C',
    secondary_colour:     '#8B0000',
    background_colour:    '#000000',
    font_display:         'Bebas Neue',
    font_body:            'Barlow',
    watermark_text:       'EMPIRE OMITTED',
    outro_file:           'outro_EmpireOmitted.mp4',
    elevenlabs_voice_id:  'pNInz6obpgDQGcFmaJgB',
    voice_style_notes:    'Adam voice. Deep, measured, authoritative. Slight British gravitas.',
    default_blueprint_id: 'documentary',
    allowed_blueprints:   JSON.stringify(['documentary', 'investigative', 'custom']),
    target_audience:      'Adults 25-45 interested in business, finance, and corporate corruption.',
    dna_extensions:       JSON.stringify({}),
  },
  {
    id:                   'MoneyExplained',
    label:                'Money Explained',
    description:          'Financial education. How money really works — markets, systems, and the people who control them.',
    brand_voice:          'Sharp, intelligent, accessible. Tone: Vox meets Bloomberg. Complex ideas made simple without dumbing down.',
    primary_colour:       '#2E9BFF',
    secondary_colour:     '#C9A84C',
    background_colour:    '#0A0F1E',
    font_display:         'Bebas Neue',
    font_body:            'Barlow',
    watermark_text:       'MONEY EXPLAINED',
    outro_file:           'outro_MoneyExplained.mp4',
    elevenlabs_voice_id:  'TxGEqnHWrfWFTfGW9XjX',
    voice_style_notes:    'Josh voice. Confident, clear, conversational. Financial authority without the stuffiness.',
    default_blueprint_id: 'documentary',
    allowed_blueprints:   JSON.stringify(['documentary', 'finance_explainer', 'educational', 'custom']),
    target_audience:      'Adults 22-40 interested in personal finance, economics, and financial literacy.',
    dna_extensions:       JSON.stringify({}),
  },
  {
    id:                   'HistoryHidden',
    label:                'History Hidden',
    description:          'The historical events they glossed over in school. Archival documentary style.',
    brand_voice:          'Warm, scholarly, narrative. Tone: Ken Burns documentary. Lets the weight of history speak.',
    primary_colour:       '#D8C49A',
    secondary_colour:     '#5C3D1E',
    background_colour:    '#1A1208',
    font_display:         'Bebas Neue',
    font_body:            'Barlow',
    watermark_text:       'HISTORY HIDDEN',
    outro_file:           'outro_HistoryHidden.mp4',
    elevenlabs_voice_id:  'JBFqnCBsd6RMkjVDRZzb',
    voice_style_notes:    'George voice. Measured, warm, British. The voice of a trusted historian.',
    default_blueprint_id: 'documentary',
    allowed_blueprints:   JSON.stringify(['documentary', 'investigative', 'educational', 'custom']),
    target_audience:      'Adults 30-55 interested in history, hidden narratives, and alternative perspectives.',
    dna_extensions:       JSON.stringify({}),
  },
  {
    id:                   'TrueCrimeWeekly',
    label:                'True Crime Weekly',
    description:          'Unsolved cases, cold cases, and the crimes that defined generations.',
    brand_voice:          'Tense, gripping, methodical. Tone: Serial podcast meets Forensic Files. Every detail matters.',
    primary_colour:       '#C41E1E',
    secondary_colour:     '#1A0A0A',
    background_colour:    '#000000',
    font_display:         'Bebas Neue',
    font_body:            'Barlow',
    watermark_text:       'TRUE CRIME WEEKLY',
    outro_file:           'outro_TrueCrimeWeekly.mp4',
    elevenlabs_voice_id:  '2EiwWnXFnvU5JabPnv8n',
    voice_style_notes:    'Clyde voice. Intense, deliberate, unsettling pauses.',
    default_blueprint_id: 'investigative',
    allowed_blueprints:   JSON.stringify(['investigative', 'documentary', 'custom']),
    target_audience:      'Adults 25-45 interested in true crime, criminal justice, and cold cases.',
    dna_extensions:       JSON.stringify({}),
  },
];

// ── Seeder ─────────────────────────────────────────────────────────────────

async function seedSprint1A(db) {
  console.log('[seed] Seeding platforms...');
  for (const p of PLATFORMS) {
    await db.run(
      `INSERT OR IGNORE INTO platforms (id, label, max_duration_sec, preferred_aspect, preferred_resolution, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [p.id, p.label, p.max_duration_sec ?? null, p.preferred_aspect ?? null,
       p.preferred_resolution ?? null, p.notes ?? null]
    );
  }

  console.log('[seed] Seeding blueprints...');
  for (const b of BLUEPRINTS) {
    await db.run(
      `INSERT OR IGNORE INTO blueprints
         (id, label, description, workflow_type, act_structure, asset_strategy,
          platform_strategy, step_config, is_custom)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.id, b.label, b.description, b.workflow_type, b.act_structure,
       b.asset_strategy, b.platform_strategy, b.step_config, b.is_custom]
    );
  }

  console.log('[seed] Seeding channel DNA...');
  for (const c of CHANNEL_DNA) {
    await db.run(
      `INSERT OR IGNORE INTO channel_dna
         (id, label, description, brand_voice, primary_colour, secondary_colour,
          background_colour, font_display, font_body, watermark_text, outro_file,
          elevenlabs_voice_id, voice_style_notes, default_blueprint_id,
          allowed_blueprints, target_audience, dna_extensions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.label, c.description, c.brand_voice, c.primary_colour,
       c.secondary_colour, c.background_colour, c.font_display, c.font_body,
       c.watermark_text, c.outro_file, c.elevenlabs_voice_id, c.voice_style_notes,
       c.default_blueprint_id, c.allowed_blueprints, c.target_audience,
       c.dna_extensions]
    );
  }

  console.log('[seed] Sprint 1A seed complete');
}

module.exports = { seedSprint1A };
