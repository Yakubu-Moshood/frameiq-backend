'use strict';

require('dotenv').config();

const fs2   = require('fs');
const path  = require('path');
const https = require('https');
const { getChannelConfigByLabel } = require('./config-reader.cjs');
const { createRouter } = require('./providers/provider-router.cjs');
const sdxl = require('./providers/image/sdxl.cjs');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SIZE       = '1536x1024';
const SLEEP_MS   = 2000;
const SLEEP_FAIL = 5000;

function log(msg) {
  const t = new Date().toISOString().substring(11, 19);
  console.log('[' + t + '] ' + msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withNegativePrompt(prompt, negativePrompt) {
  return negativePrompt ? `${prompt}\n\nAvoid these elements: ${negativePrompt}` : prompt;
}

function saveBase64(b64, filepath) {
  fs2.writeFileSync(filepath, Buffer.from(b64, 'base64'));
}

function downloadUrl(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs2.createWriteStream(filepath);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs2.unlink(filepath, () => {}); reject(err); });
  });
}

function generateImageOpenAI(prompt, quality) {
  return new Promise((resolve, reject) => {
    if (!OPENAI_KEY) { reject(new Error('OPENAI_API_KEY not set')); return; }
    const body = JSON.stringify({
      model: 'gpt-image-1', prompt, n: 1, size: SIZE, quality: quality || 'high',
    });
    const options = {
      hostname: 'api.openai.com', path: '/v1/images/generations', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { reject(new Error(json.error.message)); return; }
          const item = json.data[0];
          if (item.b64_json) resolve({ type: 'b64', value: item.b64_json });
          else if (item.url) resolve({ type: 'url', value: item.url });
          else reject(new Error('No image data in response'));
        } catch (e) {
          reject(new Error('Parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function generateImageFal(prompt, imageStyle) {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error('FAL_KEY not set');
  process.chdir('/data/pipeline');
  const { fal } = require('@fal-ai/client');
  fal.config({ credentials: falKey });
  const model = 'fal-ai/flux/dev';
  const result = await fal.subscribe(model, {
    input: {
      prompt: prompt,
      image_size: { width: 1536, height: 1024 },
      num_images: 1,
      enable_safety_checker: false,
    },
  });
  const url = result.data.images[0].url;
  return { type: 'url', value: url };
}

function makeOpenAIProvider(quality) {
  return {
    generate: async ({ prompt, negativePrompt, outputPath }) => {
      const startedAt = Date.now();
      try {
        const result = await generateImageOpenAI(withNegativePrompt(prompt, negativePrompt), quality);
        if (result.type === 'b64') saveBase64(result.value, outputPath);
        else await downloadUrl(result.value, outputPath);
        return { success: true, path: outputPath, provider: 'openai_images', durationMs: Date.now() - startedAt };
      } catch (err) {
        return { success: false, statusCode: 0, error: err.message };
      }
    },
  };
}

function makeFluxProvider(imageStyle) {
  return {
    generate: async ({ prompt, negativePrompt, outputPath }) => {
      const startedAt = Date.now();
      try {
        const result = await generateImageFal(withNegativePrompt(prompt, negativePrompt), imageStyle);
        await downloadUrl(result.value, outputPath);
        return { success: true, path: outputPath, provider: 'flux', durationMs: Date.now() - startedAt };
      } catch (err) {
        return { success: false, statusCode: 0, error: err.message };
      }
    },
  };
}

function estimateImageCost(provider) {
  if (provider === 'openai_images') return 0.08;
  if (provider === 'flux')          return 0.025;
  if (provider === 'sdxl')          return 0.0043;
  return null;
}

async function generateImages({ promptsFile, outputDir, channel, episodeId, routerFactory = createRouter }) {
  if (!fs2.existsSync(promptsFile)) throw new Error('[image-gen] prompts file not found: ' + promptsFile);

  const prompts = JSON.parse(fs2.readFileSync(promptsFile, 'utf8'));
  if (!Array.isArray(prompts)) throw new Error('[image-gen] prompts file must contain an array');
  const evidence = prompts.filter(item => item?.assetType === 'evidence_reference');
  if (evidence.length) throw new Error(`[image-gen] Refusing synthetic generation for ${evidence.length} EVIDENCE source reference(s).`);
  const graphics = prompts.filter(item => item?.assetType === 'graphic_compilation' || item?.requiresGraphicCompilation === true);
  if (graphics.length) throw new Error(`[image-gen] Refusing image generation for ${graphics.length} plan-native graphic treatment(s); graphic compilation is required.`);
  fs2.mkdirSync(outputDir, { recursive: true });

  let imagePrimary   = 'openai_images';
  let imageSecondary = 'flux';
  let imageTertiary  = null;
  let imageStyle = 'dark-moody';
  let quality = 'high';

  if (channel) {
    try {
      const dna = await getChannelConfigByLabel(channel);
      imagePrimary   = dna.image_primary   || 'openai_images';
      imageSecondary = dna.image_secondary || 'flux';
      imageTertiary  = dna.image_tertiary  || null;
      imageStyle = dna.image_style   || 'dark-moody';
      quality    = (dna.image_style && dna.image_style.includes('infographic')) ? 'medium' : 'high';
      log('[image-gen] Channel: ' + channel + ' | providers: ' + [imagePrimary, imageSecondary, imageTertiary].filter(Boolean).join(' -> ') + ' | style: ' + imageStyle);
    } catch (e) {
      log('[image-gen] WARNING: could not load channel DNA: ' + e.message + ' — using defaults');
    }
  }

  const priorityList = [imagePrimary, imageSecondary, imageTertiary].filter(Boolean);

  const providers = {
    openai_images: makeOpenAIProvider(quality),
    flux: makeFluxProvider(imageStyle),
    sdxl,
  };

  const imageRouter = routerFactory({ step: 'image', providers, estimateCost: estimateImageCost });

  log('');
  log('════════════════════════════════════════');
  log('GENERATING ' + prompts.length + ' IMAGES via ' + priorityList.join(' -> '));
  log('Output: ' + outputDir);
  log('════════════════════════════════════════');
  log('');

  let success = 0, skipped = 0, failed = 0;

  for (let i = 0; i < prompts.length; i++) {
    const item    = prompts[i];
    const outPath = path.join(outputDir, item.filename);

    if (fs2.existsSync(outPath)) {
      log('SKIP ' + item.shotId + ' — already exists');
      skipped++; continue;
    }

    log('[' + (i + 1) + '/' + prompts.length + '] ' + item.shotId);

    try {
      const result = await imageRouter.run(priorityList, {
        input: { prompt: item.prompt, negativePrompt: item.negativePrompt || '', width: 1536, height: 1024, outputPath: outPath },
        providerConfig: {},
        episodeId: episodeId || null,
        shotId: item.shotId,
        costUnits: null,
      });

      log('  OK: ' + item.filename + ' (via ' + result.provider + ')');
      success++;
      if (i < prompts.length - 1) await sleep(SLEEP_MS);
    } catch (err) {
      log('  FAILED ' + item.shotId + ': ' + err.message);
      failed++;
      await sleep(SLEEP_FAIL);
    }
  }

  log('');
  log('════════════════════════════════════════');
  log('COMPLETE — ' + success + ' generated | ' + skipped + ' skipped | ' + failed + ' failed');
  log('════════════════════════════════════════');
  return { success, skipped, failed };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let episode = null, promptsFile = null, outputDir = null, channel = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--episode')      episode     = args[++i];
    if (args[i] === '--prompts-file') promptsFile = args[++i];
    if (args[i] === '--output-dir')   outputDir   = args[++i];
    if (args[i] === '--channel')      channel     = args[++i];
  }
  if (episode && !promptsFile) {
    const episodeDir = path.join('/data/pipeline/episodes', episode);
    promptsFile = path.join(episodeDir, 'assets', 'stills', 'pending-prompts.json');
    outputDir   = path.join(episodeDir, 'assets', 'stills');
  }
  if (!promptsFile || !outputDir) {
    console.error('Usage: node surface-image-generator.cjs --episode EP4 --channel "Empire Omitted"');
    process.exit(1);
  }
  generateImages({ promptsFile, outputDir, channel })
    .catch(err => { console.error('[image-gen] FATAL:', err.message); process.exit(1); });
}

module.exports = { generateImages, withNegativePrompt };
