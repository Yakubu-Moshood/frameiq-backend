'use strict';

require('dotenv').config();

const fs2   = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const { getChannelConfigByLabel } = require('./config-reader.cjs');
const { createRouter } = require('./providers/provider-router.cjs');
const svd = require('./providers/video/svd.cjs');
const { loadProductionMethodManifest, essentialAnimationShotIds, selectShotsByIds } = require('./production-method-manifest.cjs');

const KLING_MODEL   = 'fal-ai/kling-video/v1.6/standard/image-to-video';
const CLIP_DURATION = '5';
const ASPECT_RATIO  = '16:9';
const SLEEP_BETWEEN = 3000;
const SLEEP_FAIL    = 8000;

const ANIMATION_DEFAULTS = {
  'minimal':  'Slow cinematic push in, subtle camera movement, documentary atmosphere, dark moody lighting, shallow depth of field',
  'dramatic': 'Dynamic camera movement, fast zoom, high contrast lighting, intense atmosphere, cinematic thriller style',
  'none':     '',
  'subtle-ken-burns': 'Very slow pan across the image, archival documentary style, gentle zoom, warm lighting',
};

function log(msg) { console.log(msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs2.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, response => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs2.unlink(dest, () => {}); reject(err); });
  });
}

function makeKlingProvider(animPromptFor) {
  return {
    generate: async ({ sourceImagePath, outputPath, shotId }) => {
      const startedAt = Date.now();
      try {
        const falKey = process.env.FAL_KEY;
        if (!falKey) return { success: false, statusCode: 401, error: '[animator] FAL_KEY not set' };

        process.chdir('/data/pipeline');
        const { fal } = require('@fal-ai/client');
        fal.config({ credentials: falKey });

        const imageBuffer = fs2.readFileSync(sourceImagePath);
        const imageBlob   = new Blob([imageBuffer], { type: 'image/png' });
        const uploadedUrl = await fal.storage.upload(imageBlob);
        log('    Uploaded to fal.ai storage');

        const result = await fal.subscribe(KLING_MODEL, {
          input: {
            image_url:    uploadedUrl,
            prompt:       animPromptFor(shotId),
            duration:     CLIP_DURATION,
            aspect_ratio: ASPECT_RATIO,
          },
          logs: false,
          onQueueUpdate: (update) => {
            if (update.status === 'IN_PROGRESS') process.stdout.write('.');
          },
        });
        process.stdout.write('\n');

        const videoUrl = result.data.video.url;
        await downloadFile(videoUrl, outputPath);
        return { success: true, path: outputPath, provider: 'kling', durationMs: Date.now() - startedAt };
      } catch (err) {
        return { success: false, statusCode: 0, error: err.message };
      }
    },
  };
}

function estimateVideoCost(provider) {
  if (provider === 'kling') return 0.35;
  if (provider === 'svd')   return 0.18;
  return null;
}

async function animateClips({ shotDefs, episodeDir, channel, episodeId, shotDefsPath = null, productionManifestPath = null, routerFactory = createRouter, channelConfigLoader = getChannelConfigByLabel, sleepFn = sleep }) {
  let productionManifest = null;
  if (shotDefs?.mode === 'empire-omitted-v3') {
    shotDefsPath = shotDefsPath || path.join(episodeDir, 'shot-definitions.json');
    productionManifestPath = productionManifestPath || path.join(episodeDir, 'production-manifest.json');
    productionManifest = loadProductionMethodManifest({ manifestPath: productionManifestPath, shotDefsPath, shotDefs });
  } else if (productionManifestPath || shotDefsPath) {
    throw new Error('[animator] Production manifests are only accepted for V3 shot definitions.');
  }
  let animationStyle = 'minimal';
  let imageMotion    = 'subtle-ken-burns';
  let videoPrimary   = 'kling';
  let videoSecondary = null;
  let videoTertiary  = null;

  if (channel) {
    try {
      const dna = await channelConfigLoader(channel);
      animationStyle = dna.animation_style || 'minimal';
      imageMotion    = dna.image_motion    || 'subtle-ken-burns';
      videoPrimary   = dna.video_primary   || 'kling';
      videoSecondary = dna.video_secondary || null;
      videoTertiary  = dna.video_tertiary  || null;
      log('[animator] Channel: ' + channel + ' | animation_style: ' + animationStyle + ' | image_motion: ' + imageMotion);
    } catch (e) {
      log('[animator] WARNING: could not load channel DNA: ' + e.message);
    }
  }

  if (animationStyle === 'none' || imageMotion === 'still') {
    if (productionManifest && essentialAnimationShotIds(productionManifest).length) {
      throw new Error('[animator] V3 production manifest requires essential animation but Channel DNA disables animation.');
    }
    log('[animator] Channel DNA says no animation — skipping animator entirely');
    return { completed: 0, skipped: 0, failed: 0 };
  }

  if (animationStyle === 'motion-graphics-only') {
    if (productionManifest && essentialAnimationShotIds(productionManifest).length) {
      throw new Error('[animator] V3 production manifest requires essential animation but Channel DNA is motion-graphics-only.');
    }
    log('[animator] Channel DNA says motion-graphics-only — skipping fal.ai Kling cinematic clip animation.');
    log('[animator] NOTE: this does NOT produce animated charts / counting numbers.');
    log('[animator] No module in this pipeline currently renders that — it needs new build work,');
    log('[animator] not just this config value. See build report for details.');
    return { completed: 0, skipped: 0, failed: 0, motionGraphicsPending: true };
  }

  const stillsDir = path.join(episodeDir, 'assets', 'stills');
  const clipsDir  = path.join(episodeDir, 'assets', 'clips');
  fs2.mkdirSync(clipsDir, { recursive: true });

  const defaultPrompt = ANIMATION_DEFAULTS[animationStyle] || ANIMATION_DEFAULTS['minimal'];

  const clipShots = productionManifest
    ? selectShotsByIds(shotDefs, essentialAnimationShotIds(productionManifest))
    : (shotDefs.allShots || []).filter(s => s.visualType === 'CLIP');

  if (clipShots.length === 0) {
    log('[animator] No CLIP shots found — nothing to animate');
    return { completed: 0, skipped: 0, failed: 0 };
  }

  const channelSlug = String(channel || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const isEmpireOmitted = channelSlug === 'empireomitted';
  const eoMotionRestraint = 'Single controlled camera movement only. The camera moves; the scene remains physically stable. Preserve subject and object geometry. No unnecessary autonomous subject movement. No sweeping lateral pan, orbit or aggressive parallax unless explicitly requested. No morphing, warping or deformation. Minimal environmental movement. Restrained cinematic documentary motion.';

  const shotPromptById = {};
  for (const shot of clipShots) {
    const basePrompt = shot.animationPrompt || defaultPrompt;
    const separator = /[.!?]\s*$/.test(basePrompt) ? ' ' : '. ';
    shotPromptById[shot.shotId] = isEmpireOmitted ? (basePrompt + separator + eoMotionRestraint) : basePrompt;
  }
  if (isEmpireOmitted) log('[animator] Empire Omitted motion restraint: ENABLED');

  const providers = {
    kling: makeKlingProvider((shotId) => shotPromptById[shotId]),
    svd,
  };
  const priorityList = [videoPrimary, videoSecondary, videoTertiary].filter(Boolean);
  const videoRouter = routerFactory({ step: 'video', providers, estimateCost: estimateVideoCost });

  log('');
  log('[animator] ════════════════════════════════════════');
  log('[animator] ANIMATING ' + clipShots.length + ' CLIPS via ' + priorityList.join(' -> '));
  log('[animator] Style: ' + animationStyle);
  log('[animator] ════════════════════════════════════════');
  log('');

  let completed = 0, skipped = 0, failed = 0;

  for (let i = 0; i < clipShots.length; i++) {
    const shot        = clipShots[i];
    const clipFile    = path.join(clipsDir, shot.shotId + '.mp4');
    const sourceImage = path.join(stillsDir, shot.shotId + '.png');

    if (fs2.existsSync(clipFile)) {
      log('  SKIP [' + shot.shotId + '] — clip already exists');
      skipped++; continue;
    }
    if (!fs2.existsSync(sourceImage)) {
      log('  SKIP [' + shot.shotId + '] — source image not found');
      skipped++; continue;
    }

    log('  [' + (i + 1) + '/' + clipShots.length + '] Animating ' + shot.shotId + '...');

    try {
      const result = await videoRouter.run(priorityList, {
        input: { sourceImagePath: sourceImage, animationStyle, outputPath: clipFile, shotId: shot.shotId },
        providerConfig: {},
        episodeId: episodeId || null,
        shotId: shot.shotId,
        costUnits: null,
      });
      completed++;
      log('    OK: ' + path.basename(clipFile) + ' (' + completed + '/' + clipShots.length + ', via ' + result.provider + ')');
      if (i < clipShots.length - 1) await sleepFn(SLEEP_BETWEEN);
    } catch (err) {
      failed++;
      log('    FAILED [' + shot.shotId + ']: ' + err.message);
      await sleepFn(SLEEP_FAIL);
    }
  }

  log('');
  log('[animator] COMPLETE — ' + completed + ' animated | ' + skipped + ' skipped | ' + failed + ' failed');
  return { completed, skipped, failed };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let episode = null, channel = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--episode') episode = args[++i];
    if (args[i] === '--channel') channel = args[++i];
  }
  if (!episode) {
    console.error('Usage: node surface-animator.cjs --episode EP4 --channel "Empire Omitted"');
    process.exit(1);
  }
  const episodeDir   = path.join('/data/pipeline/episodes', episode);
  const shotDefsPath = path.join(episodeDir, 'shot-definitions.json');
  if (!fs2.existsSync(shotDefsPath)) {
    console.error('[animator] shot-definitions.json not found at ' + shotDefsPath);
    process.exit(1);
  }
  const shotDefs = JSON.parse(fs2.readFileSync(shotDefsPath, 'utf8'));
  animateClips({ shotDefs, episodeDir, channel, shotDefsPath, productionManifestPath: path.join(episodeDir, 'production-manifest.json') })
    .catch(err => { console.error('[animator] FATAL:', err.message); process.exit(1); });
}

module.exports = { animateClips };
