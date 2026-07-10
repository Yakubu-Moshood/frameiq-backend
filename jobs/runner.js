/**
 * jobs/runner.js
 * Frameiq — Pipeline job runner
 *
 * Sprint 1A changes:
 *   1. Episode folder namespaced by channel: ${channel}_${episodeId}
 *   2. runPipeline() dispatcher reads blueprint_id, routes to workflow
 *   3. runFullRenderWorkflow() = exact prior pipeline body
 *   4. Unknown workflow types fall back to full_render safely
 *
 * TEST_MODE (Sprint 1A validation only):
 *   Set TEST_MODE=true in Railway Variables to run without paid APIs.
 *   Stubs are Option B: only generated when files do not already exist.
 *   KEY FIX: VO stubs are written BEFORE writeScript is called because
 *   surface-script-writer.cjs chains directly into vo-generator internally.
 *   Writing silent VO files first causes the internal chain to skip them.
 *   Remove TEST_MODE variable after Sprint 1A validation is complete.
 *
 * Sprint 1.5 Phase B changes:
 *   - generateVO() call now passes channel and episodeId for provider tracking
 */

require('dotenv').config();

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');

const { queries }                    = require('../db');
const sse                            = require('../sse');
const { PIPELINE_DIR, EPISODES_DIR } = require('../startup-init');

const approvalGates  = new Map();
const activeEpisodes = new Set();
const actPreviews    = new Map();

// ── Job queue resilience (heartbeat) ──────────────────────────────────────────
// Per job-queue-resilience-spec.md section 3.2. Keyed by episodeDbId so
// startJob's .finally() can always find and clear its own interval, even
// if multiple episodes are rendering concurrently across channels.
const heartbeatIntervals = new Map();
const HEARTBEAT_INTERVAL_MS = 20_000; // spec suggests 15-30s

// ── Per-stage idempotency (spec section 3.5) — current state ─────────────────
// The spec asks for a checkpoint_data JSON blob tracking exactly which
// sub-items within a stage are already done, checked before every paid-API
// call. That mechanism largely already exists here, just filesystem-based
// instead of DB-based:
//   - Steps 0A-0E below each skip regeneration via a batch-level
//     fs.existsSync() check (script.json, all 6 VO files, per-shot images,
//     per-clip animations) before calling out to a generator script.
//   - Step 1 (render, surface-renderer.cjs) is MORE fine-grained than the
//     batch checks above: it independently skips an already-run Whisper
//     transcription (word-timestamps.json exists), skips already-rendered
//     per-segment clips, and skips already-built per-act videos
//     (act_<key>.mp4 exists) — see surface-renderer.cjs lines ~274, ~595,
//     ~717. A retry therefore resumes from whatever's on disk, not from
//     stage 1, even without any DB checkpoint column.
// What's NOT covered, and can't be added from this repo: fine-grained
// per-sub-item idempotency *inside* surface-vo-generator.cjs,
// surface-image-generator.cjs, and surface-animator.cjs — those files are
// Railway-volume-only (uploaded via Railway CLI, not git-tracked; see
// startup-init.js's PIPELINE_DIR comment and pipeline-updates/ vs the
// missing generator scripts). If any of those three ever loops over
// multiple items and calls a paid API per item without its own
// existsSync-style guard, a resume could re-bill that stage's remaining
// items. This can only be verified/fixed by someone with direct access to
// the Railway volume's copy of those files.

// ── Pipeline auto-sync ────────────────────────────────────────────────────────
const PIPELINE_UPDATES_DIR = path.join(__dirname, '..', 'pipeline-updates');

function syncPipelineUpdates() {
  try {
    if (!PIPELINE_DIR || !fs.existsSync(PIPELINE_UPDATES_DIR)) return [];
    const copied = [];
    for (const f of fs.readdirSync(PIPELINE_UPDATES_DIR)) {
      if (!f.endsWith('.cjs') && !f.endsWith('.json')) continue;
      fs.copyFileSync(path.join(PIPELINE_UPDATES_DIR, f), path.join(PIPELINE_DIR, f));
      copied.push(f);
    }
    if (copied.length) console.log(`[runner] Synced pipeline updates: ${copied.join(', ')}`);
    return copied;
  } catch (e) {
    console.warn('[runner] pipeline-updates sync failed:', e.message);
    return [];
  }
}

// ── TEST_MODE helpers ─────────────────────────────────────────────────────────

function isTestMode() {
  return process.env.TEST_MODE === 'true';
}

function testStubScript(episodeDir, topic) {
  const actKeys = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  const labels  = ['The Setup', 'The Rise', 'The Fracture', 'The Human Cost', 'The Collapse', 'The Verdict'];
  const acts    = {};
  actKeys.forEach((k, i) => {
    acts[k] = {
      label:    labels[i],
      voScript: `This is a FrameIQ Sprint 1A validation episode. Act ${i + 1} placeholder narration for pipeline testing only.`,
    };
  });
  const script = {
    topic,
    title:   `Sprint 1A Validation — ${topic}`,
    channel: 'EmpireOmitted',
    acts,
  };
  fs.writeFileSync(path.join(episodeDir, 'script.json'), JSON.stringify(script, null, 2), 'utf8');
  console.log('[TEST_MODE] Wrote stub script.json');
  return script;
}

function testStubVO(audioDir, voFiles) {
  let written = 0;
  for (const f of voFiles) {
    const outPath = path.join(audioDir, f);
    if (fs.existsSync(outPath)) continue;
    execSync(
      `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 3 -q:a 9 -acodec libmp3lame "${outPath}"`,
      { stdio: 'pipe' }
    );
    written++;
    console.log(`[TEST_MODE] Wrote silent VO: ${f}`);
  }
  return written;
}

function testStubShotDefs(episodeDir) {
  const actKeys  = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
  const acts     = {};
  const allShots = [];
  actKeys.forEach(actKey => {
    const prefix = actKey.toUpperCase().replace('ACT', 'ACT').replace('3B', '3B');
    const shots  = [1, 2].map(n => {
      const shotId = `${prefix}_00${n}`;
      return {
        shotId,
        actKey,
        triggerWord:       'validation',
        visualType:        'STILL',
        estimatedDuration: 5,
        imagePrompt:       `Sprint 1A validation placeholder ${shotId}`,
        animationPrompt:   '',
        colorGrade:        'cold_blue',
        sfx:               null,
        cinematic:         null,
      };
    });
    acts[actKey] = shots;
    allShots.push(...shots);
  });
  const shotDefs = { topic: 'Sprint 1A Validation', totalShots: allShots.length, acts, allShots };
  fs.writeFileSync(path.join(episodeDir, 'shot-definitions.json'), JSON.stringify(shotDefs, null, 2), 'utf8');
  console.log(`[TEST_MODE] Wrote stub shot-definitions.json (${allShots.length} shots)`);
  return shotDefs;
}

function testStubImages(stillsDir, shots) {
  let written = 0;
  for (const shot of shots) {
    const outPath = path.join(stillsDir, `${shot.shotId}.png`);
    if (fs.existsSync(outPath)) continue;
    execSync(
      `ffmpeg -y -f lavfi -i color=c=black:size=1920x1080:rate=1 -frames:v 1 "${outPath}"`,
      { stdio: 'pipe' }
    );
    written++;
  }
  if (written) console.log(`[TEST_MODE] Wrote ${written} stub images`);
  return written;
}

function testStubClips(stillsDir, clipsDir, shots) {
  let written = 0;
  for (const shot of shots) {
    const outPath = path.join(clipsDir, `${shot.shotId}.mp4`);
    if (fs.existsSync(outPath)) continue;
    const imgPath = path.join(stillsDir, `${shot.shotId}.png`);
    if (!fs.existsSync(imgPath)) continue;
    execSync(
      `ffmpeg -y -loop 1 -i "${imgPath}" -f lavfi -i anullsrc=r=44100:cl=stereo -c:v libx264 -tune stillimage -c:a aac -b:a 8k -t 5 -pix_fmt yuv420p "${outPath}"`,
      { stdio: 'pipe' }
    );
    written++;
  }
  if (written) console.log(`[TEST_MODE] Wrote ${written} stub clips`);
  return written;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function startJob(episodeDbId, channelKey, episodeId, topic) {
  if (activeEpisodes.has(episodeDbId)) {
    console.warn(`[runner] Refusing to double-start ${episodeDbId} — already running`);
    return false;
  }
  activeEpisodes.add(episodeDbId);

  // Heartbeat: while this episode is actively processing, touch
  // last_heartbeat_at on an interval. This is purely a liveness signal for
  // observability/debugging today — boot-time recovery (jobs/recovery.js)
  // doesn't need to threshold on staleness because activeEpisodes is
  // guaranteed empty on a fresh process (see getOrphanedEpisodes in db.js),
  // but recording it costs nothing and matches spec section 3.2.
  const heartbeat = setInterval(() => {
    queries.touchEpisodeHeartbeat(episodeDbId).catch(e =>
      console.warn(`[runner] heartbeat write failed for ${episodeDbId}:`, e.message)
    );
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatIntervals.set(episodeDbId, heartbeat);
  queries.touchEpisodeHeartbeat(episodeDbId).catch(() => {}); // immediate first beat

  runPipeline(episodeDbId, channelKey, episodeId, topic)
    .then(async () => {
      // Successful completion — clear retry_count so a later, unrelated
      // failure on this same episode (e.g. a manual re-render) doesn't
      // inherit an inflated count from a past orphan/recovery cycle.
      await queries.resetEpisodeRetryCount(episodeDbId).catch(() => {});
    })
    .catch(async err => {
      console.error(`[runner] Fatal error for ${episodeDbId}:`, err.message);
      await queries.updateEpisodeStatus('failed', episodeDbId);
      sse.close(episodeDbId, { step: 'fatal', status: 'failed', error: err.message });
    })
    .finally(() => {
      activeEpisodes.delete(episodeDbId);
      const hb = heartbeatIntervals.get(episodeDbId);
      if (hb) { clearInterval(hb); heartbeatIntervals.delete(episodeDbId); }
      for (const key of actPreviews.keys()) {
        if (key.startsWith(`${episodeDbId}:`)) actPreviews.delete(key);
      }
    });
  return true;
}

function isRunning(episodeDbId)          { return activeEpisodes.has(episodeDbId); }
function getActPreview(episodeDbId, act) { return actPreviews.get(`${episodeDbId}:${act}`) || null; }
function getActiveEpisodeIds()           { return Array.from(activeEpisodes); }

function resolveApproval(episodeDbId, act, approved) {
  const key     = `${episodeDbId}:${act}`;
  const resolve = approvalGates.get(key);
  if (resolve) { approvalGates.delete(key); actPreviews.delete(key); resolve(approved); }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function runPipeline(episodeDbId, channelKey, episodeId, topic) {
  let workflowType = 'full_render';
  try {
    const ep = await queries.getEpisode(episodeDbId);
    if (ep && ep.blueprint_id) {
      const bp = await queries.getBlueprint(ep.blueprint_id);
      if (bp && bp.workflow_type) workflowType = bp.workflow_type;
    }
  } catch (e) {
    console.warn('[runner] Could not load blueprint, defaulting to full_render:', e.message);
  }

  if (isTestMode()) console.log(`[TEST_MODE] Active — workflow: ${workflowType}`);

  switch (workflowType) {
    case 'full_render': return runFullRenderWorkflow(episodeDbId, channelKey, episodeId, topic);
    default:
      console.warn(`[runner] Workflow "${workflowType}" not implemented — falling back to full_render`);
      return runFullRenderWorkflow(episodeDbId, channelKey, episodeId, topic);
  }
}

// ─── Full render workflow ─────────────────────────────────────────────────────

async function runFullRenderWorkflow(episodeDbId, channelKey, episodeId, topic) {

  if (!PIPELINE_DIR || !fs.existsSync(PIPELINE_DIR))
    throw new Error(`Pipeline directory not found at: ${PIPELINE_DIR}`);

  const configPath = path.join(PIPELINE_DIR, 'pipeline.config.json');
  if (!fs.existsSync(configPath))
    throw new Error(`pipeline.config.json not found at: ${configPath}`);

  const CONFIG  = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const CHANNEL = CONFIG.channels[channelKey];
  if (!CHANNEL) throw new Error(`Channel "${channelKey}" not found in pipeline.config.json`);

  syncPipelineUpdates();

  const episodeDir = path.join(EPISODES_DIR, `${channelKey}_${episodeId}`);
  const audioDir   = path.join(episodeDir, 'assets', 'audio');
  const stillsDir  = path.join(episodeDir, 'assets', 'stills');
  const clipsDir   = path.join(episodeDir, 'assets', 'clips');

  fs.mkdirSync(audioDir,  { recursive: true });
  fs.mkdirSync(stillsDir, { recursive: true });
  fs.mkdirSync(clipsDir,  { recursive: true });
  fs.mkdirSync(path.join(episodeDir, 'output'), { recursive: true });

  const progress = (step, status, pct, detail) => sse.emit(episodeDbId, { step, status, progress: pct, detail });

  await queries.updateEpisodeStatus('running', episodeDbId);

  const jobs   = await queries.getJobsForEpisode(episodeDbId);
  const jobFor = (step) => jobs.find(j => j.step === step);

  const voFiles = ['VO_Act1.mp3','VO_Act2.mp3','VO_Act3.mp3','VO_Act3B.mp3','VO_Act4.mp3','VO_Act5.mp3'];
  if (isTestMode()) {
    const written = testStubVO(audioDir, voFiles);
    if (written > 0) console.log(`[TEST_MODE] Pre-flight: wrote ${written} silent VO files`);
    const tsPath = path.join(episodeDir, 'word-timestamps.json');
    if (!fs.existsSync(tsPath)) {
      fs.writeFileSync(tsPath, '[]', 'utf8');
      console.log('[TEST_MODE] Pre-flight: wrote dummy word-timestamps.json — Whisper will be skipped');
    }
  }

  // ── STEP 0A — SCRIPT ──────────────────────────────────────────────────────

  let script;
  const scriptPath = path.join(episodeDir, 'script.json');
  const job0A      = jobFor('0A_script');

  await queries.updateJob(job0A.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });
  progress('0A_script', 'running', 0, 'Writing script...');

  if (fs.existsSync(scriptPath)) {
    script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    await queries.updateJob(job0A.id, { status: 'complete', progress: 100, detail: 'loaded existing', finished_at: new Date().toISOString() });
    progress('0A_script', 'complete', 100, `Loaded existing script: "${script.title}"`);
  } else if (isTestMode()) {
    script = testStubScript(episodeDir, topic);
    await queries.updateJob(job0A.id, { status: 'complete', progress: 100, detail: '[TEST] stub script', finished_at: new Date().toISOString() });
    progress('0A_script', 'complete', 100, `[TEST] Stub script: "${script.title}"`);
  } else {
    const { writeScript } = require(path.join(PIPELINE_DIR, 'surface-script-writer.cjs'));
    script = await writeScript({ topic, channel: channelKey, outputDir: episodeDir });
    await queries.updateJob(job0A.id, { status: 'complete', progress: 100, detail: script.title, finished_at: new Date().toISOString() });
    progress('0A_script', 'complete', 100, `Script written: "${script.title}"`);
  }

  // ── STEP 0B — VOICEOVER ───────────────────────────────────────────────────

  const job0B   = jobFor('0B_vo');
  const voReady = voFiles.every(f => fs.existsSync(path.join(audioDir, f)));

  await queries.updateJob(job0B.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });
  progress('0B_vo', 'running', 0, 'Generating voiceover...');

  if (voReady) {
    await queries.updateJob(job0B.id, { status: 'complete', progress: 100, detail: isTestMode() ? '[TEST] silent VO files' : 'existing VO files used', finished_at: new Date().toISOString() });
    progress('0B_vo', 'complete', 100, isTestMode() ? '[TEST] Silent VO files ready' : 'All VO files already exist');
  } else if (isTestMode()) {
    testStubVO(audioDir, voFiles);
    await queries.updateJob(job0B.id, { status: 'complete', progress: 100, detail: '[TEST] silent VO files', finished_at: new Date().toISOString() });
    progress('0B_vo', 'complete', 100, '[TEST] Silent VO files written');
  } else {
    const { generateVO } = require(path.join(PIPELINE_DIR, 'surface-vo-generator.cjs'));
    // Sprint 1.5 Phase B: pass channel and episodeId for provider tracking
    await generateVO({ script, outputDir: audioDir, channel: channelKey, episodeId: episodeDbId });
    await queries.updateJob(job0B.id, { status: 'complete', progress: 100, finished_at: new Date().toISOString() });
    progress('0B_vo', 'complete', 100, 'All 6 VO files generated');
  }

  // ── STEP 0C — SHOT DEFINITIONS ────────────────────────────────────────────

  let shotDefs;
  const shotDefsPath = path.join(episodeDir, 'shot-definitions.json');
  const job0C        = jobFor('0C_shots');

  await queries.updateJob(job0C.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });
  progress('0C_shots', 'running', 0, 'Generating shot definitions...');

  if (fs.existsSync(shotDefsPath)) {
    shotDefs = JSON.parse(fs.readFileSync(shotDefsPath, 'utf8'));
    await queries.updateJob(job0C.id, { status: 'complete', progress: 100, detail: `${shotDefs.totalShots} shots loaded`, finished_at: new Date().toISOString() });
    progress('0C_shots', 'complete', 100, `Loaded ${shotDefs.totalShots} existing shot definitions`);
  } else if (isTestMode()) {
    shotDefs = testStubShotDefs(episodeDir);
    await queries.updateJob(job0C.id, { status: 'complete', progress: 100, detail: `[TEST] ${shotDefs.totalShots} stub shots`, finished_at: new Date().toISOString() });
    progress('0C_shots', 'complete', 100, `[TEST] ${shotDefs.totalShots} stub shot definitions`);
  } else {
    const { generateShotDefinitions } = require(path.join(PIPELINE_DIR, 'surface-shot-definitions.cjs'));
    shotDefs = await generateShotDefinitions({ script, outputDir: episodeDir, channel: channelKey });
    await queries.updateJob(job0C.id, { status: 'complete', progress: 100, detail: `${shotDefs.totalShots} shots`, finished_at: new Date().toISOString() });
    progress('0C_shots', 'complete', 100, `${shotDefs.totalShots} shots defined`);
  }

  // ── STEP 0D — IMAGE GENERATION ────────────────────────────────────────────

  const job0D  = jobFor('0D_images');
  const needed = (shotDefs.allShots || []).filter(s => !fs.existsSync(path.join(stillsDir, `${s.shotId}.png`)));

  await queries.updateJob(job0D.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });

  if (needed.length === 0) {
    progress('0D_images', 'complete', 100, 'All images already exist');
    await queries.updateJob(job0D.id, { status: 'complete', progress: 100, detail: 'all exist', finished_at: new Date().toISOString() });
  } else if (isTestMode()) {
    progress('0D_images', 'running', 0, `[TEST] Generating ${needed.length} placeholder images...`);
    testStubImages(stillsDir, needed);
    await queries.updateJob(job0D.id, { status: 'complete', progress: 100, detail: `[TEST] ${needed.length} stub images`, finished_at: new Date().toISOString() });
    progress('0D_images', 'complete', 100, `[TEST] ${needed.length} placeholder images written`);
  } else {
    progress('0D_images', 'running', 0, `Generating ${needed.length} images via gpt-image-1...`);
    const prompts     = needed.map(s => ({ shotId: s.shotId, filename: `${s.shotId}.png`, prompt: s.imagePrompt }));
    const promptsPath = path.join(stillsDir, 'pending-prompts.json');
    fs.writeFileSync(promptsPath, JSON.stringify(prompts, null, 2), 'utf8');
    const { generateImages } = require(path.join(PIPELINE_DIR, 'surface-image-generator.cjs'));
    await generateImages({ promptsFile: promptsPath, outputDir: stillsDir, channel: channelKey });
    await queries.updateJob(job0D.id, { status: 'complete', progress: 100, detail: `${needed.length} images`, finished_at: new Date().toISOString() });
    progress('0D_images', 'complete', 100, `${needed.length} images generated`);
  }

  // ── STEP 0E — ANIMATION ───────────────────────────────────────────────────

  const job0E     = jobFor('0E_anim');
  const clipShots = (shotDefs.allShots || []).filter(s => s.visualType === 'CLIP');
  const needsAnim = clipShots.filter(s => !fs.existsSync(path.join(clipsDir, `${s.shotId}.mp4`)));

  await queries.updateJob(job0E.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });

  if (needsAnim.length === 0) {
    progress('0E_anim', 'complete', 100, 'All animations already exist');
    await queries.updateJob(job0E.id, { status: 'complete', progress: 100, detail: 'all exist', finished_at: new Date().toISOString() });
  } else if (isTestMode()) {
    progress('0E_anim', 'running', 0, `[TEST] Wrapping ${needsAnim.length} images as stub clips...`);
    testStubClips(stillsDir, clipsDir, needsAnim);
    await queries.updateJob(job0E.id, { status: 'complete', progress: 100, detail: `[TEST] ${needsAnim.length} stub clips`, finished_at: new Date().toISOString() });
    progress('0E_anim', 'complete', 100, `[TEST] ${needsAnim.length} stub clips written`);
  } else {
    progress('0E_anim', 'running', 0, `Animating ${needsAnim.length} clips via fal.ai Kling v1.6...`);
    const { animateClips } = require(path.join(PIPELINE_DIR, 'surface-animator.cjs'));
    const result = await animateClips({ shotDefs, episodeDir, channel: channelKey });
    await queries.updateJob(job0E.id, { status: 'complete', progress: 100, detail: `${result.completed} clips`, finished_at: new Date().toISOString() });
    progress('0E_anim', 'complete', 100, `${result.completed} clips animated`);
  }

  // ── STEP 1 — RENDER ───────────────────────────────────────────────────────

  const job1 = jobFor('1_render');
  await queries.updateJob(job1.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });
  progress('1_render', 'running', 0, 'Starting render engine...');
  await queries.updateEpisodeStatus('awaiting_approval', episodeDbId);

  async function approvalCallback(act, actVideoPath) {
    if (actVideoPath && fs.existsSync(actVideoPath)) {
      actPreviews.set(`${episodeDbId}:${act}`, actVideoPath);
    }
    sse.emit(episodeDbId, {
      step: '1_render', status: 'awaiting_approval', progress: null,
      detail: `Review act: ${act}`, act,
      previewAvailable: actPreviews.has(`${episodeDbId}:${act}`),
    });
    // Fix: persist the act identity to the job row itself, not just the
    // one-time SSE event. Previously only the episode's overall status
    // was updated here, so the frontend's initial page-load snapshot and
    // its polling fallback (useProgress.js) had no durable way to learn
    // which act was actually pending -- only a browser tab that was
    // live-connected via SSE at this exact moment ever saw the real act.
    // Any reload, reconnect, or later poll fell back to the hardcoded
    // placeholder string 'act', which is what showed on both episodes
    // stuck in review ("Act act has been rendered").
    await queries.updateJob(job1.id, { status: 'awaiting_approval', detail: `Review act: ${act}` });
    await queries.updateEpisodeStatus('awaiting_approval', episodeDbId);
    return new Promise(resolve => { approvalGates.set(`${episodeDbId}:${act}`, resolve); });
  }

  const { renderEpisode } = require(path.join(PIPELINE_DIR, 'surface-renderer.cjs'));
  const renderResult = await renderEpisode({ episodeDir, episodeId, channel: channelKey, approvalCallback });

  await queries.updateEpisodeResult('complete', renderResult.title || script.title, renderResult.path, renderResult.durationSeconds, episodeDbId);
  await queries.updateJob(job1.id, { status: 'complete', progress: 100, detail: `${(renderResult.durationSeconds / 60).toFixed(2)} min`, finished_at: new Date().toISOString() });
  progress('1_render', 'complete', 100, `Render complete — ${(renderResult.durationSeconds / 60).toFixed(2)} min`);

  // ── STEP 7 — SHORT EXTRACTOR ──────────────────────────────────────────────

  const job7 = jobFor('7_short');
  let shortResult = null;

  try {
    if (job7) await queries.updateJob(job7.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });
    progress('7_short', 'running', 0, 'Extracting 59s vertical short...');
    const { extractShort } = require(path.join(PIPELINE_DIR, 'short-extractor.cjs'));
    shortResult = await extractShort({
      episodeDir, episodeId, channel: channelKey,
      finalVideoPath: renderResult.path,
      onProgress: (pct, detail) => progress('7_short', 'running', pct, detail),
    });
    if (job7) await queries.updateJob(job7.id, { status: 'complete', progress: 100, detail: `${shortResult.durationSeconds.toFixed(0)}s`, finished_at: new Date().toISOString() });
    progress('7_short', 'complete', 100, `Short ready — ${shortResult.durationSeconds.toFixed(0)}s`);
  } catch (shortErr) {
    console.error(`[runner] Step 7 failed for ${episodeId}:`, shortErr.message);
    if (job7) await queries.updateJob(job7.id, { status: 'failed', detail: shortErr.message.slice(0, 200), finished_at: new Date().toISOString() });
    progress('7_short', 'failed', null, `Short extraction failed: ${shortErr.message.slice(0, 200)}`);
  }

  sse.close(episodeDbId, { step: 'done', status: 'complete', outputPath: renderResult.path, shortPath: shortResult ? shortResult.path : null });
}

module.exports = { startJob, resolveApproval, isRunning, getActPreview, getActiveEpisodeIds, syncPipelineUpdates };
