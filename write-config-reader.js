const fs = require('fs');
const p = '/data/pipeline/config-reader.cjs';

const content = `'use strict';

const path = require('path');
const fs2 = require('fs');
const DB_MODULE_PATH = process.env.DB_MODULE_PATH || '/app/db';
const { get, all } = require(DB_MODULE_PATH);
const PIPELINE_CONFIG_PATH = process.env.PIPELINE_CONFIG_PATH || '/data/pipeline/pipeline.config.json';

let _configFileCache = null;
let _dbCache = {};
let _labelCache = {};

function loadConfigFile() {
  if (_configFileCache) return _configFileCache;
  const exists = fs2.existsSync(PIPELINE_CONFIG_PATH);
  if (exists === false) throw new Error('[config-reader] pipeline.config.json not found');
  _configFileCache = JSON.parse(fs2.readFileSync(PIPELINE_CONFIG_PATH, 'utf8'));
  return _configFileCache;
}

function buildMerged(dbRecord, fileRecord, channelKey) {
  return {
    id:               dbRecord.id,
    label:            dbRecord.label,
    channel_id:       dbRecord.channel_id,
    slug:             dbRecord.slug,
    active:           dbRecord.active,
    description:      dbRecord.description,
    brand_voice:      dbRecord.brand_voice,
    primary_colour:   dbRecord.primary_colour,
    secondary_colour: dbRecord.secondary_colour,
    background_colour:dbRecord.background_colour,
    watermark_text:   dbRecord.watermark_text,
    ui_theme_color:   dbRecord.ui_theme_color,
    blueprint_label:       dbRecord.blueprint_label,
    target_length_minutes: dbRecord.target_length_minutes || 10,
    research_depth:        dbRecord.research_depth        || 'standard',
    narration_style:       dbRecord.narration_style       || 'dramatic-investigative',
    script_pacing:         dbRecord.script_pacing         || 'slow-build',
    title_category_hints:  (function() { try { return JSON.parse(dbRecord.title_category_hints || '[]'); } catch(e) { return []; } })(),
    image_style:     dbRecord.image_style     || 'dark-moody',
    image_motion:    dbRecord.image_motion    || 'subtle-ken-burns',
    image_primary:   dbRecord.image_primary   || 'openai_images',
    image_secondary: dbRecord.image_secondary || 'flux',
    image_tertiary:  dbRecord.image_tertiary  || 'sdxl',
    animation_style: dbRecord.animation_style || 'minimal',
    max_shot_duration_sec: dbRecord.max_shot_duration_sec == null ? null : Number(dbRecord.max_shot_duration_sec),
    music_style:     dbRecord.music_style     || 'corporate-tension',
    music_tempo:     dbRecord.music_tempo     || 'slow',
    voice_primary:       dbRecord.voice_primary       || 'elevenlabs',
    voice_secondary:     dbRecord.voice_secondary     || 'openai_tts',
    voice_id_elevenlabs: dbRecord.voice_id_elevenlabs || dbRecord.elevenlabs_voice_id,
    voice_id_openai:     dbRecord.voice_id_openai,
    elevenlabs_voice_id: dbRecord.voice_id_elevenlabs || dbRecord.elevenlabs_voice_id,
    video_primary:   dbRecord.video_primary   || 'kling',
    video_secondary: dbRecord.video_secondary || 'wan_2_1',
    video_tertiary:  dbRecord.video_tertiary  || 'ltx_video',
    default_blueprint_id: dbRecord.default_blueprint_id,
    voice_params: fileRecord ? { speed: fileRecord.voice.speed, stability: fileRecord.voice.stability, similarity: fileRecord.voice.similarity, style: fileRecord.voice.style, model: fileRecord.voice.model, outputFormat: fileRecord.voice.outputFormat } : null,
    image_params: fileRecord ? { model: fileRecord.image.model, size: fileRecord.image.size, quality: fileRecord.image.quality, output: fileRecord.image.output, styleSuffix: fileRecord.image.styleSuffix } : null,
    render_params: fileRecord ? fileRecord.render : null,
    paths: fileRecord ? fileRecord.paths : { pipelineRoot: '/data/pipeline', episodesDir: '/data/episodes', publicDir: '/data/public', musicFile: '/data/public/background_music.mp3', watermarkFile: '/data/pipeline/assets/' + channelKey + '_Watermark_Transparent.png' },
    music_volume_curve: fileRecord ? fileRecord.musicVolumeCurve : null,
    color_grades:       fileRecord ? fileRecord.colorGrades       : null,
    script_style:       fileRecord ? fileRecord.scriptStyle       : null,
  };
}

async function getChannelConfig(channelId) {
  if (!channelId) throw new Error('[config-reader] channelId is required');
  if (_dbCache[channelId]) return _dbCache[channelId];
  const dbRecord = await get('SELECT * FROM channel_dna WHERE id = ?', [channelId]);
  if (!dbRecord) throw new Error('[config-reader] Channel not found by id: ' + channelId);
  const configFile = loadConfigFile();
  const fileRecord = configFile.channels && configFile.channels[channelId];
  if (!fileRecord) console.warn('[config-reader] WARNING: ' + channelId + ' not in pipeline.config.json');
  const merged = buildMerged(dbRecord, fileRecord, channelId);
  _dbCache[channelId] = merged;
  return merged;
}

async function getChannelConfigByLabel(label) {
  // NOTE: despite the name (kept for backward compatibility with existing
  // callers — surface-shot-definitions.cjs, surface-animator.cjs — do not
  // rename), every real caller actually passes the channel's stable \`id\`
  // (e.g. 'MoneyExplained'), not its free-text \`label\` (e.g. 'Macro
  // Decode'). This previously queried WHERE label = ?, which silently
  // threw 'Channel not found by label' for any channel whose label
  // differs from its id — including Macro Decode after migration 007
  // renamed its label. Both callers caught that error and fell back to
  // wrong defaults (Empire Omitted's dramatic-investigative shot profile,
  // and animationStyle 'minimal' instead of 'motion-graphics-only'),
  // which is why a live Macro Decode episode got real fal.ai Kling clips.
  // Fixed to query by id, matching the sibling getChannelConfig() above —
  // same lookup key callers actually use, just under this function's
  // existing name/signature.
  if (!label) throw new Error('[config-reader] label is required');
  if (_labelCache[label]) return _labelCache[label];
  const dbRecord = await get('SELECT * FROM channel_dna WHERE id = ?', [label]);
  if (!dbRecord) throw new Error('[config-reader] Channel not found by id: ' + label);
  const configFile = loadConfigFile();
  const fileRecord = (configFile.channels && (configFile.channels[dbRecord.channel_id] || configFile.channels[dbRecord.id])) || null;
  if (!fileRecord) console.warn('[config-reader] WARNING: ' + label + ' not in pipeline.config.json');
  const merged = buildMerged(dbRecord, fileRecord, dbRecord.channel_id || label);
  _labelCache[label] = merged;
  _dbCache[dbRecord.id] = merged;
  return merged;
}

async function getAllChannelConfigs() {
  const channels = await all('SELECT id FROM channel_dna ORDER BY id ASC', []);
  const configs = {};
  for (const ch of channels) {
    configs[ch.id] = await getChannelConfig(ch.id);
  }
  return configs;
}

function clearCache(channelId) {
  if (channelId) {
    delete _dbCache[channelId];
    for (const k of Object.keys(_labelCache)) {
      if (_labelCache[k].id === channelId) delete _labelCache[k];
    }
  } else {
    _dbCache = {};
    _labelCache = {};
    _configFileCache = null;
  }
}

module.exports = { getChannelConfig, getChannelConfigByLabel, getAllChannelConfigs, clearCache };
`;

fs.writeFileSync(p, content, 'utf8');
console.log('config-reader.cjs written successfully');
console.log('Lines: ' + content.split('\n').length);
