require('dotenv').config();
const { fal } = require('@fal-ai/client');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
fal.config({ credentials: process.env.FAL_KEY });

const args = process.argv.slice(2);
const MODE = args[0] || '--full';
const EPISODE = process.env.EPISODE || 'EP4';
const EPISODE_FOLDER = `episodes/${EPISODE}`;

console.log('');
console.log('████████████████████████████████████████');
console.log('EMPIRE OMITTED — PIPELINE V2');
console.log(`MODE: ${MODE} | EPISODE: ${EPISODE}`);
console.log('████████████████████████████████████████');
console.log('');

const FOLDERS = {
  audio:  `${EPISODE_FOLDER}/audio`,
  images: `${EPISODE_FOLDER}/images`,
  clips:  `${EPISODE_FOLDER}/clips`,
  logs:   `${EPISODE_FOLDER}/logs`,
};

for (const folder of Object.values(FOLDERS)) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
}

function log(message) {
  const timestamp = new Date().toISOString().substring(11, 19);
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(FOLDERS.logs, 'pipeline.log'), line + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function alreadyDone(filePath) {
  return fs.existsSync(filePath);
}

function measureAudio(filePath) {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8' }
    ).trim();
    const seconds = parseFloat(result);
    const frames = Math.round(seconds * 30);
    return { seconds, frames };
  } catch (e) {
    return { seconds: 0, frames: 0 };
  }
}

function loadEpisodeConfig() {
  const configPath = `${EPISODE_FOLDER}/config.json`;
  if (!fs.existsSync(configPath)) {
    console.log('');
    console.log('❌ No episode config found at: ' + configPath);
    console.log('Run: node create-episode.cjs ' + EPISODE);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

async function generateVoiceovers(config) {
  log('');
  log('════════════════════════════════════════');
  log('STEP 1 — GENERATING VOICEOVER FILES');
  log('════════════════════════════════════════');

  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (const vo of config.voiceovers) {
    const filename = `${vo.id}.mp3`;
    const filePath = path.join(FOLDERS.audio, filename);

    if (alreadyDone(filePath)) {
      log(`⏭  SKIP — ${filename} already exists`);
      skipped++;
      continue;
    }

    try {
      log(`🎙  Generating ${vo.id}...`);

      const audioStream = await elevenlabs.textToSpeech.convert(
        process.env.ELEVENLABS_VOICE_ID,
        {
          text: vo.text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.70,
            similarity_boost: 0.75,
            style: 0.55,
            use_speaker_boost: true,
          },
        }
      );

      const chunks = [];
      for await (const chunk of audioStream) {
        chunks.push(chunk);
      }

      fs.writeFileSync(filePath, Buffer.concat(chunks));
      completed++;
      log(`✅ SAVED — ${filename}`);
      await sleep(2000);

    } catch (error) {
      failed++;
      log(`❌ FAILED — ${vo.id}: ${error.message}`);
      await sleep(3000);
    }
  }

  log('');
  log(`STEP 1 COMPLETE — Generated: ${completed} | Skipped: ${skipped} | Failed: ${failed}`);

  log('');
  log('════════════════════════════════════════');
  log('MEASURING VO DURATIONS');
  log('════════════════════════════════════════');

  const measurements = {};
  let totalFrames = 0;

  for (const vo of config.voiceovers) {
    const filePath = path.join(FOLDERS.audio, `${vo.id}.mp3`);
    if (!fs.existsSync(filePath)) continue;
    const { seconds, frames } = measureAudio(filePath);
    measurements[vo.id] = { seconds, frames };
    totalFrames += frames;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    log(`✅ ${vo.id}: ${mins}m ${secs}s = ${frames} frames`);
  }

  log('');
  log(`TOTAL DOCUMENTARY DURATION: ${Math.round(totalFrames / 30 / 60)} minutes`);

  log('');
  log('════════════════════════════════════════');
  log('SCENE PLAN — IMAGES NEEDED PER ACT');
  log('════════════════════════════════════════');

  const TARGET_SCENE_DURATION = 350;
  let totalImages = 0;
  const scenePlan = {};

  for (const vo of config.voiceovers) {
    if (!measurements[vo.id]) continue;
    const frames = measurements[vo.id].frames;
    const scenesNeeded = Math.ceil(frames / TARGET_SCENE_DURATION);
    const imagesNeeded = Math.ceil(scenesNeeded / 2);
    scenePlan[vo.id] = { frames, scenesNeeded, imagesNeeded };
    totalImages += imagesNeeded;
    log(`${vo.id}: ${frames} frames → ${scenesNeeded} scenes → ${imagesNeeded} images`);
  }

  log('');
  log(`TOTAL IMAGES TO GENERATE: ${totalImages}`);
  log(`TOTAL CLIPS TO ANIMATE:   ${totalImages * 2}`);
  log('');
  log('════════════════════════════════════════');
  log('VO COMPLETE — REVIEW SCENE PLAN ABOVE');
  log('Next: node pipeline-v2.cjs --images-only');
  log('════════════════════════════════════════');

  fs.writeFileSync(
    `${EPISODE_FOLDER}/scene-plan.json`,
    JSON.stringify({ measurements, scenePlan, totalImages, totalFrames }, null, 2)
  );

  log('Scene plan saved to: ' + `${EPISODE_FOLDER}/scene-plan.json`);
  return { measurements, scenePlan, totalImages };
}

async function generateImages(config) {
  log('');
  log('════════════════════════════════════════');
  log(`STEP 2 — GENERATING ${config.images.length} IMAGES`);
  log('════════════════════════════════════════');

  const STYLE = 'Cinematic 16:9 composition. Ultra realistic. Dark documentary aesthetic. Colour palette: black, deep charcoal, gold accents, occasional deep red. No text in image. No real people depicted. Moody dramatic lighting. Shallow depth of field.';

  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (const image of config.images) {
    const filename = `${image.id}_${image.name}.png`;
    const filePath = path.join(FOLDERS.images, filename);

    if (alreadyDone(filePath)) {
      log(`⏭  SKIP — ${filename}`);
      skipped++;
      continue;
    }

    try {
      log(`🎨 Generating ${image.id} — ${image.name}...`);

      const response = await openai.images.generate({
        model: 'gpt-image-1',
        prompt: `${image.prompt} ${STYLE}`,
        n: 1,
        size: '1536x1024',
        quality: 'medium',
      });

      const imageData = response.data[0].b64_json;
      fs.writeFileSync(filePath, Buffer.from(imageData, 'base64'));
      completed++;
      log(`✅ SAVED — ${filename} (${completed} of ${config.images.length})`);
      await sleep(3000);

    } catch (error) {
      failed++;
      log(`❌ FAILED — ${image.id}: ${error.message}`);
      await sleep(5000);
    }
  }

  log('');
  log(`STEP 2 COMPLETE — Generated: ${completed} | Skipped: ${skipped} | Failed: ${failed}`);
}

async function animateImages(config) {
  log('');
  log('════════════════════════════════════════');
  log('STEP 3 — ANIMATING IMAGES');
  log('════════════════════════════════════════');

  let completed = 0;
  let skipped = 0;
  let failed = 0;

  for (const image of config.images) {
    const imageFilename = `${image.id}_${image.name}.png`;
    const imagePath = path.join(FOLDERS.images, imageFilename);

    if (!fs.existsSync(imagePath)) {
      log(`⚠️  SKIP — Image not found: ${imageFilename}`);
      continue;
    }

    const animations = image.animations || [];

    for (let i = 0; i < animations.length; i++) {
      const clipLetter = String.fromCharCode(65 + i);
      const clipFilename = `${image.id}${clipLetter}_${image.name}.mp4`;
      const clipPath = path.join(FOLDERS.clips, clipFilename);

      if (alreadyDone(clipPath)) {
        log(`⏭  SKIP — ${clipFilename}`);
        skipped++;
        continue;
      }

      try {
        log(`🎬 Animating ${image.id}${clipLetter} — ${image.name}...`);

        const imageBuffer = fs.readFileSync(imagePath);
        const imageBlob = new Blob([imageBuffer], { type: 'image/png' });
        const uploadedUrl = await fal.storage.upload(imageBlob);

        const result = await fal.subscribe('fal-ai/kling-video/v1.6/standard/image-to-video', {
          input: {
            image_url: uploadedUrl,
            prompt: animations[i],
            duration: '5',
            aspect_ratio: '16:9',
          },
          logs: false,
          onQueueUpdate: (update) => {
            if (update.status === 'IN_PROGRESS') process.stdout.write('.');
          },
        });

        process.stdout.write('\n');
        await downloadFile(result.data.video.url, clipPath);
        completed++;
        log(`✅ SAVED — ${clipFilename} (${completed} clips done)`);
        await sleep(2000);

      } catch (error) {
        failed++;
        log(`❌ FAILED — ${image.id}${clipLetter}: ${error.message}`);
        await sleep(5000);
      }
    }
  }

  log('');
  log(`STEP 3 COMPLETE — Animated: ${completed} | Skipped: ${skipped} | Failed: ${failed}`);
}

async function run() {
  const config = loadEpisodeConfig();
  log(`Episode: ${config.episode} — ${config.title}`);
  log('');

  const startTime = Date.now();

  if (MODE === '--vo-only') {
    await generateVoiceovers(config);
  } else if (MODE === '--images-only') {
    await generateImages(config);
  } else if (MODE === '--animate-only') {
    await animateImages(config);
  } else {
    await generateVoiceovers(config);
    await generateImages(config);
    await animateImages(config);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000 / 60);
  log('');
  log(`Pipeline finished in ${elapsed} minutes`);
}

run().catch(error => {
  console.error('FATAL ERROR:', error.message);
  process.exit(1);
});