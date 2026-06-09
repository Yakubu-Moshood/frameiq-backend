/**
 * jobs/runner.js
 * Frameiq — Pipeline job runner
 *
 * Wraps the existing Surface Pipeline v2 modules.
 * Instead of console.log + readline approval gates,
 * this runner emits SSE progress events and pauses at
 * approval gates waiting for an HTTP signal.
 *
 * Steps mirror surface-pipeline.cjs exactly:
 *   0A — script writer
 *   0B — VO generator
 *   0C — shot definitions
 *   0D — image generation
 *   0E — animation
 *   1  — render engine
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const { queries }                   = require('../db');
const sse                           = require('../sse');

// ── Pipeline root comes from startup-init ─────────────────────
// On Railway: /data/pipeline   (files uploaded to Volume)
// Locally:    ./local-data/pipeline
const { PIPELINE_DIR, EPISODES_DIR } = require('../startup-init');

// Map<episodeDbId, resolve_fn> — approval gate promises
const approvalGates = new Map();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start running the pipeline for an episode.
 * Fires and forgets — progress comes through SSE.
 */
function startJob(episodeDbId, channelKey, episodeId, topic) {
  runPipeline(episodeDbId, channelKey, episodeId, topic).catch(async err => {
    console.error(`[runner] Fatal error for ${episodeDbId}:`, err.message);
    await queries.updateEpisodeStatus('failed', episodeDbId);
    sse.close(episodeDbId, { step: 'fatal', status: 'failed', error: err.message });
  });
}

/**
 * Resolve an approval gate for a specific act.
 * Called by the episodes route when the user taps Approve/Reject.
 */
function resolveApproval(episodeDbId, act, approved) {
  const key     = `${episodeDbId}:${act}`;
  const resolve = approvalGates.get(key);
  if (resolve) {
    approvalGates.delete(key);
    resolve(approved);
  }
}

// ─── Main pipeline runner ─────────────────────────────────────────────────────

async function runPipeline(episodeDbId, channelKey, episodeId, topic) {

  if (!PIPELINE_DIR || !fs.existsSync(PIPELINE_DIR)) {
    throw new Error(
      `Pipeline directory not found at: ${PIPELINE_DIR}\n` +
      `On Railway: upload your .cjs files to /data/pipeline via the Railway CLI.\n` +
      `Locally: make sure local-data/pipeline/ exists and contains the .cjs files.`
    );
  }

  // Load channel config from the pipeline.config.json on the Volume
  const configPath = path.join(PIPELINE_DIR, 'pipeline.config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `pipeline.config.json not found at: ${configPath}\n` +
      `Upload it to /data/pipeline/ along with the .cjs files.`
    );
  }

  const CONFIG  = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const CHANNEL = CONFIG.channels[channelKey];

  if (!CHANNEL) throw new Error(`Channel "${channelKey}" not found in pipeline.config.json`);

  // ── Episode directories ───────────────────────────────────────
  // All episode output goes to the persistent EPISODES_DIR on the Volume.
  // On Railway: /data/episodes/EP7/...
  // Locally:    ./local-data/episodes/EP7/...
  const episodeDir = path.join(EPISODES_DIR, episodeId);
  const audioDir   = path.join(episodeDir, 'assets', 'audio');
  const stillsDir  = path.join(episodeDir, 'assets', 'stills');
  const clipsDir   = path.join(episodeDir, 'assets', 'clips');

  fs.mkdirSync(audioDir,  { recursive: true });
  fs.mkdirSync(stillsDir, { recursive: true });
  fs.mkdirSync(clipsDir,  { recursive: true });
  fs.mkdirSync(path.join(episodeDir, 'output'), { recursive: true });

  // ── Helpers ──
  const progress = (step, status, pct, detail) => {
    sse.emit(episodeDbId, { step, status, progress: pct, detail });
  };

  await queries.updateEpisodeStatus('running', episodeDbId);

  const jobs   = await queries.getJobsForEpisode(episodeDbId);
  const jobFor = (step) => jobs.find(j => j.step === step);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 0A — SCRIPT
  // ══════════════════════════════════════════════════════════════════════════

  let script;
  const scriptPath = path.join(episodeDir, 'script.json');
  const job0A      = jobFor('0A_script');

  await queries.updateJob(job0A.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });
  progress('0A_script', 'running', 0, 'Writing script via Claude API...');

  if (fs.existsSync(scriptPath)) {
    script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    await queries.updateJob(job0A.id, { status: 'complete', progress: 100, detail: 'loaded existing', finished_at: new Date().toISOString() });
    progress('0A_script', 'complete', 100, `Loaded existing script: "${script.title}"`);
  } else {
    const { writeScript } = require(path.join(PIPELINE_DIR, 'surface-script-writer.cjs'));
    script = await writeScript({ topic, channel: channelKey, outputDir: episodeDir });
    await queries.updateJob(job0A.id, { status: 'complete', progress: 100, detail: script.title, finished_at: new Date().toISOString() });
    progress('0A_script', 'complete', 100, `Script written: "${script.title}"`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 0B — VOICEOVER
  // ══════════════════════════════════════════════════════════════════════════

  const job0B   = jobFor('0B_vo');
  const voFiles = ['VO_Act1.mp3','VO_Act2.mp3','VO_Act3.mp3','VO_Act3B.mp3','VO_Act4.mp3','VO_Act5.mp3'];
  const voReady = voFiles.every(f => fs.existsSync(path.join(audioDir, f)));

  await queries.updateJob(job0B.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });
  progress('0B_vo', 'running', 0, 'Generating voiceover via ElevenLabs...');

  if (voReady) {
    await queries.updateJob(job0B.id, { status: 'complete', progress: 100, detail: 'existing VO files used', finished_at: new Date().toISOString() });
    progress('0B_vo', 'complete', 100, 'All VO files already exist');
  } else {
    const { generateVO } = require(path.join(PIPELINE_DIR, 'surface-vo-generator.cjs'));
    await generateVO({ script, outputDir: audioDir });
    await queries.updateJob(job0B.id, { status: 'complete', progress: 100, finished_at: new Date().toISOString() });
    progress('0B_vo', 'complete', 100, 'All 6 VO files generated');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 0C — SHOT DEFINITIONS
  // ══════════════════════════════════════════════════════════════════════════

  let shotDefs;
  const shotDefsPath = path.join(episodeDir, 'shot-definitions.json');
  const job0C        = jobFor('0C_shots');

  await queries.updateJob(job0C.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });
  progress('0C_shots', 'running', 0, 'Generating shot definitions via Claude API...');

  if (fs.existsSync(shotDefsPath)) {
    shotDefs = JSON.parse(fs.readFileSync(shotDefsPath, 'utf8'));
    await queries.updateJob(job0C.id, { status: 'complete', progress: 100, detail: `${shotDefs.totalShots} shots loaded`, finished_at: new Date().toISOString() });
    progress('0C_shots', 'complete', 100, `Loaded ${shotDefs.totalShots} existing shot definitions`);
  } else {
    const { generateShotDefinitions } = require(path.join(PIPELINE_DIR, 'surface-shot-definitions.cjs'));
    shotDefs = await generateShotDefinitions({ script, outputDir: episodeDir });
    await queries.updateJob(job0C.id, { status: 'complete', progress: 100, detail: `${shotDefs.totalShots} shots`, finished_at: new Date().toISOString() });
    progress('0C_shots', 'complete', 100, `${shotDefs.totalShots} shots defined`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 0D — IMAGE GENERATION
  // ══════════════════════════════════════════════════════════════════════════

  const job0D  = jobFor('0D_images');
  const needed = (shotDefs.allShots || [])
    .filter(s => !fs.existsSync(path.join(stillsDir, `${s.shotId}.png`)));

  await queries.updateJob(job0D.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });

  if (needed.length === 0) {
    progress('0D_images', 'complete', 100, 'All images already exist');
    await queries.updateJob(job0D.id, { status: 'complete', progress: 100, detail: 'all exist', finished_at: new Date().toISOString() });
  } else {
    progress('0D_images', 'running', 0, `Generating ${needed.length} images via gpt-image-1...`);

    const prompts     = needed.map(s => ({ shotId: s.shotId, filename: `${s.shotId}.png`, prompt: s.imagePrompt }));
    const promptsPath = path.join(stillsDir, 'pending-prompts.json');
    fs.writeFileSync(promptsPath, JSON.stringify(prompts, null, 2), 'utf8');

    const { generateImages } = require(path.join(PIPELINE_DIR, 'surface-image-generator.cjs'));
    await generateImages({ promptsFile: promptsPath, outputDir: stillsDir });

    await queries.updateJob(job0D.id, { status: 'complete', progress: 100, detail: `${needed.length} images`, finished_at: new Date().toISOString() });
    progress('0D_images', 'complete', 100, `${needed.length} images generated`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 0E — ANIMATION
  // ══════════════════════════════════════════════════════════════════════════

  const job0E     = jobFor('0E_anim');
  const clipShots = (shotDefs.allShots || []).filter(s => s.visualType === 'CLIP');
  const needsAnim = clipShots.filter(s => !fs.existsSync(path.join(clipsDir, `${s.shotId}.mp4`)));

  await queries.updateJob(job0E.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });

  if (needsAnim.length === 0) {
    progress('0E_anim', 'complete', 100, 'All animations already exist');
    await queries.updateJob(job0E.id, { status: 'complete', progress: 100, detail: 'all exist', finished_at: new Date().toISOString() });
  } else {
    progress('0E_anim', 'running', 0, `Animating ${needsAnim.length} clips via fal.ai Kling v1.6... (~60-90s each)`);
    const { animateClips } = require(path.join(PIPELINE_DIR, 'surface-animator.cjs'));
    const result = await animateClips({ shotDefs, episodeDir });
    await queries.updateJob(job0E.id, { status: 'complete', progress: 100, detail: `${result.completed} clips`, finished_at: new Date().toISOString() });
    progress('0E_anim', 'complete', 100, `${result.completed} clips animated`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1 — RENDER
  // ══════════════════════════════════════════════════════════════════════════

  const job1 = jobFor('1_render');
  await queries.updateJob(job1.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });
  progress('1_render', 'running', 0, 'Starting render engine...');

  await queries.updateEpisodeStatus('awaiting_approval', episodeDbId);

  async function approvalCallback(act, actVideoPath) {
    progress('1_render', 'awaiting_approval', null, `Review act: ${act}`);
    await queries.updateEpisodeStatus('awaiting_approval', episodeDbId);

    return new Promise((resolve) => {
      approvalGates.set(`${episodeDbId}:${act}`, resolve);
    });
  }

  const { renderEpisode } = require(path.join(PIPELINE_DIR, 'surface-renderer.cjs'));

  const renderResult = await renderEpisode({
    episodeDir,
    episodeId,
    channel:          channelKey,
    approvalCallback,
  });

  // ── Final result ──
  await queries.updateEpisodeResult(
    'complete',
    renderResult.title || script.title,
    renderResult.path,
    renderResult.durationSeconds,
    episodeDbId
  );

  await queries.updateJob(job1.id, {
    status:      'complete',
    progress:    100,
    detail:      `${(renderResult.durationSeconds / 60).toFixed(2)} min`,
    finished_at: new Date().toISOString(),
  });

  progress('1_render', 'complete', 100, `Render complete — ${(renderResult.durationSeconds / 60).toFixed(2)} min`);
  sse.close(episodeDbId, { step: 'done', status: 'complete', outputPath: renderResult.path });
}

module.exports = { startJob, resolveApproval };
