'use strict';

const fs = require('fs');
const DB_MODULE_PATH = process.env.DB_MODULE_PATH || '/app/db';
const { get, all } = require(DB_MODULE_PATH);
const PIPELINE_CONFIG_PATH =
  process.env.PIPELINE_CONFIG_PATH || '/data/pipeline/pipeline.config.json';

let configFileCache = null;
let dbCache = {};
let labelCache = {};

function loadConfigFile() {
  if (configFileCache) return configFileCache;
  if (!fs.existsSync(PIPELINE_CONFIG_PATH)) {
    throw new Error('[config-reader] pipeline.config.json not found');
  }
  configFileCache = JSON.parse(fs.readFileSync(PIPELINE_CONFIG_PATH, 'utf8'));
  return configFileCache;
}

function buildMerged(dbRecord, fileRecord, channelKey) {
  return {
    id: dbRecord.id,
    label: dbRecord.label,
    channel_id: dbRecord.channel_id,
    slug: dbRecord.slug,
    active: dbRecord.active,
    description: dbRecord.description,
    brand_voice: dbRecord.brand_voice,
    primary_colour: dbRecord.primary_colour,
    secondary_colour: dbRecord.secondary_colour,
    background_colour: dbRecord.background_colour,
    watermark_text: dbRecord.watermark_text,
    ui_theme_color: dbRecord.ui_theme_color,
    blueprint_label: dbRecord.blueprint_label,
    target_length_minutes: dbRecord.target_length_minutes || 10,
    research_depth: dbRecord.research_depth || 'standard',
    narration_style: dbRecord.narration_style || 'dramatic-investigative',
    script_pacing: dbRecord.script_pacing || 'slow-build',
    title_category_hints: (() => {
      try {
        return JSON.parse(dbRecord.title_category_hints || '[]');
      } catch {
        return [];
      }
    })(),
    image_style: dbRecord.image_style || 'dark-moody',
    image_motion: dbRecord.image_motion || 'subtle-ken-burns',
    image_primary: dbRecord.image_primary || 'openai_images',
    image_secondary: dbRecord.image_secondary || 'flux',
    image_tertiary: dbRecord.image_tertiary || 'sdxl',
    animation_style: dbRecord.animation_style || 'minimal',
    max_shot_duration_sec:
      dbRecord.max_shot_duration_sec == null
        ? null
        : Number(dbRecord.max_shot_duration_sec),
    episode_opening_enabled: Number(dbRecord.episode_opening_enabled) === 1,
    music_style: dbRecord.music_style || 'corporate-tension',
    music_tempo: dbRecord.music_tempo || 'slow',
    voice_primary: dbRecord.voice_primary || 'elevenlabs',
    voice_secondary: dbRecord.voice_secondary || 'openai_tts',
    voice_id_elevenlabs:
      dbRecord.voice_id_elevenlabs || dbRecord.elevenlabs_voice_id,
    voice_id_openai: dbRecord.voice_id_openai,
    elevenlabs_voice_id:
      dbRecord.voice_id_elevenlabs || dbRecord.elevenlabs_voice_id,
    video_primary: dbRecord.video_primary || 'kling',
    video_secondary: dbRecord.video_secondary || 'wan_2_1',
    video_tertiary: dbRecord.video_tertiary || 'ltx_video',
    default_blueprint_id: dbRecord.default_blueprint_id,
    voice_params: fileRecord
      ? {
          speed: fileRecord.voice.speed,
          stability: fileRecord.voice.stability,
          similarity: fileRecord.voice.similarity,
          style: fileRecord.voice.style,
          model: fileRecord.voice.model,
          outputFormat: fileRecord.voice.outputFormat,
        }
      : null,
    image_params: fileRecord
      ? {
          model: fileRecord.image.model,
          size: fileRecord.image.size,
          quality: fileRecord.image.quality,
          output: fileRecord.image.output,
          styleSuffix: fileRecord.image.styleSuffix,
        }
      : null,
    render_params: fileRecord ? fileRecord.render : null,
    paths: fileRecord
      ? fileRecord.paths
      : {
          pipelineRoot: '/data/pipeline',
          episodesDir: '/data/episodes',
          publicDir: '/data/public',
          musicFile: '/data/public/background_music.mp3',
          watermarkFile:
            '/data/pipeline/assets/' + channelKey + '_Watermark_Transparent.png',
        },
    music_volume_curve: fileRecord ? fileRecord.musicVolumeCurve : null,
    color_grades: fileRecord ? fileRecord.colorGrades : null,
    script_style: fileRecord ? fileRecord.scriptStyle : null,
  };
}

async function getChannelConfig(channelId) {
  if (!channelId) throw new Error('[config-reader] channelId is required');
  if (dbCache[channelId]) return dbCache[channelId];
  const dbRecord = await get('SELECT * FROM channel_dna WHERE id = ?', [channelId]);
  if (!dbRecord) {
    throw new Error('[config-reader] Channel not found by id: ' + channelId);
  }
  const configFile = loadConfigFile();
  const fileRecord = configFile.channels && configFile.channels[channelId];
  if (!fileRecord) {
    console.warn('[config-reader] WARNING: ' + channelId + ' not in pipeline.config.json');
  }
  const merged = buildMerged(dbRecord, fileRecord, channelId);
  dbCache[channelId] = merged;
  return merged;
}

async function getChannelConfigByLabel(label) {
  if (!label) throw new Error('[config-reader] label is required');
  if (labelCache[label]) return labelCache[label];
  const dbRecord = await get('SELECT * FROM channel_dna WHERE id = ?', [label]);
  if (!dbRecord) {
    throw new Error('[config-reader] Channel not found by id: ' + label);
  }
  const configFile = loadConfigFile();
  const fileRecord =
    (configFile.channels &&
      (configFile.channels[dbRecord.channel_id] ||
        configFile.channels[dbRecord.id])) ||
    null;
  if (!fileRecord) {
    console.warn('[config-reader] WARNING: ' + label + ' not in pipeline.config.json');
  }
  const merged = buildMerged(
    dbRecord,
    fileRecord,
    dbRecord.channel_id || label
  );
  labelCache[label] = merged;
  dbCache[dbRecord.id] = merged;
  return merged;
}

async function getAllChannelConfigs() {
  const channels = await all('SELECT id FROM channel_dna ORDER BY id ASC', []);
  const configs = {};
  for (const channel of channels) {
    configs[channel.id] = await getChannelConfig(channel.id);
  }
  return configs;
}

function clearCache(channelId) {
  if (channelId) {
    delete dbCache[channelId];
    for (const key of Object.keys(labelCache)) {
      if (labelCache[key].id === channelId) delete labelCache[key];
    }
  } else {
    dbCache = {};
    labelCache = {};
    configFileCache = null;
  }
}

module.exports = {
  getChannelConfig,
  getChannelConfigByLabel,
  getAllChannelConfigs,
  clearCache,
};
