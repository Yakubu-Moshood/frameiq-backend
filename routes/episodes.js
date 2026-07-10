/**
 * routes/episodes.js
 * Frameiq — Episode routes
 *
 * Sprint 1A changes:
 *   1. POST /api/episodes accepts optional blueprint_id (default: 'documentary')
 *   2. Episode folder paths in /short and /preview use channel-namespaced dirs
 *      to match the runner.js folder fix: ${channel}_${episodeId}
 *   3. /download made auth-flexible (header OR ?token=) to fix the blank-page bug
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const { v4: uuid } = require('uuid');

const { queries }      = require('../db');
const { requireAuth }  = require('../middleware/auth');
const sse              = require('../sse');
const { startJob, resolveApproval, isRunning, getActPreview, syncPipelineUpdates } = require('../jobs/runner');
const { EPISODES_DIR } = require('../startup-init');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'frameiq-dev-secret-change-in-production';

// Auth helper that accepts header OR ?token= query param
// Required for EventSource (SSE) and video/download endpoints where
// the browser cannot set custom headers.
function authFlexible(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ')
    ? header.slice(7)
    : (req.query.token || null);
}

const STEPS = [
  { key: '0A_script', label: 'Write Script'       },
  { key: '0B_vo',     label: 'Generate Voiceover' },
  { key: '0C_shots',  label: 'Define Shots'       },
  { key: '0D_images', label: 'Generate Images'    },
  { key: '0E_anim',   label: 'Animate Clips'      },
  { key: '1_render',  label: 'Render Episode'     },
  { key: '7_short',   label: 'Extract Short'      },
  { key: '8_qa',       label: 'QA Check'          },
];

// ─── POST /api/episodes ───────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const {
    channel      = 'EmpireOmitted',
    episodeId,
    topic,
    blueprint_id = 'documentary',   // Sprint 1A: accept blueprint, default documentary
  } = req.body || {};

  if (!episodeId || !topic)
    return res.status(400).json({ error: 'episodeId and topic are required' });

  // episodeId flows directly, unmodified (aside from the frontend's
  // .trim().toUpperCase()), into a filesystem folder name
  // (jobs/runner.js: `${channel}_${episodeId}`) and from there into every
  // ffmpeg command the render pipeline shells out to, including the
  // -f concat demuxer's file-list quoting. Apostrophes, quotes, and shell
  // metacharacters break that quoting (confirmed root cause of a repeatable
  // "Impossible to open" render failure) and could similarly break other
  // shell-constructed ffmpeg invocations. Restrict to characters that are
  // safe everywhere in that chain: letters, numbers, spaces, hyphens,
  // underscores.
  if (!/^[A-Za-z0-9 _-]+$/.test(episodeId)) {
    return res.status(400).json({
      error: 'Episode ID can only contain letters, numbers, spaces, hyphens, and underscores (no apostrophes, quotes, or other special characters).',
    });
  }

  // Validate blueprint exists
  try {
    const blueprint = await queries.getBlueprint(blueprint_id);
    if (!blueprint)
      return res.status(400).json({ error: `Unknown blueprint: ${blueprint_id}` });
  } catch (e) {
    return res.status(500).json({ error: 'Blueprint lookup failed: ' + e.message });
  }

  const dbId = uuid();
  try {
    await queries.createEpisodeV2(dbId, req.userId, channel, episodeId, topic, blueprint_id);
    for (const step of STEPS) {
      await queries.createJob(uuid(), dbId, step.key);
    }
    startJob(dbId, channel, episodeId, topic);
    return res.status(201).json({ id: dbId, episodeId, topic, blueprint_id, status: 'queued' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes ────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const list = await queries.listEpisodes(req.userId);
    return res.json(list);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes/:id ────────────────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const jobs = await queries.getJobsForEpisode(episode.id);
    // pipelineRunning distinguishes "pause requested" (episode.status ===
    // 'paused', written instantly by PATCH /:id/pause) from "pipeline has
    // actually stopped" (activeEpisodes no longer holds this episode --
    // only true once the in-flight stage at pause time genuinely finishes
    // and checkPaused() catches it at the next boundary). Without this,
    // the frontend has no way to tell those two states apart and will
    // offer a Resume button that fails with 409 "already running" if the
    // in-flight stage hasn't actually finished yet. See the resume-race
    // investigation this session.
    return res.json({ ...episode, jobs, pipelineRunning: isRunning(episode.id) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes/:id/progress — SSE ────────────────────────────────────

router.get('/:id/progress', async (req, res) => {
  let userId;
  try {
    const token = authFlexible(req);
    if (!token) return res.status(401).json({ error: 'No token' });
    const payload = jwt.verify(token, SECRET);
    userId = payload.sub;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const jobs = await queries.getJobsForEpisode(episode.id);
    // Same pipelineRunning field as GET /:id, and for the same reason --
    // see the comment there. The SSE snapshot is only sent once at
    // connect time (subsequent messages are step-level deltas from
    // sse.emit(), which don't carry episode-level fields), so this alone
    // doesn't make pipelineRunning live-update over an open connection --
    // the frontend polls GET /:id while in the interim "pausing" state to
    // pick up the transition once it actually happens.
    res.write(`data: ${JSON.stringify({ type: 'snapshot', episode: { ...episode, pipelineRunning: isRunning(episode.id) }, jobs })}\n\n`);

    sse.subscribe(episode.id, res);
    req.on('close', () => sse.unsubscribe(episode.id, res));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/episodes/:id/approve ──────────────────────────────────────────

router.post('/:id/approve', requireAuth, async (req, res) => {
  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });

    const { act, approved } = req.body || {};
    if (!act || typeof approved !== 'boolean')
      return res.status(400).json({ error: 'act (string) and approved (boolean) required' });

    resolveApproval(episode.id, act, approved);
    return res.json({ ok: true, act, approved });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/episodes/:id/cancel ──────────────────────────────────────────
// Marks an orphaned/dead episode as terminated so it stops showing as
// running/queued on the dashboard. Sets the episode row to 'failed' and
// force-fails any of its job rows that aren't already in a terminal state
// (complete/failed/cancelled).
//
// Note: this only updates DB state. It does NOT interrupt an actively
// running render — jobs/runner.js has no kill-switch for an in-flight
// pipeline, and this endpoint doesn't add one. It's intended for episodes
// that are already dead (e.g. orphaned by a server/deploy restart, or
// permanently stuck on an unresumable failure) where nothing is actually
// still writing to these rows.

router.patch('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (episode.status === 'complete')
      return res.status(400).json({ error: 'Cannot cancel a completed episode' });

    await queries.updateEpisodeStatus('failed', episode.id);

    const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
    const jobs = await queries.getJobsForEpisode(episode.id);
    for (const job of jobs) {
      if (!TERMINAL.has(job.status)) {
        await queries.updateJob(job.id, {
          status:      'failed',
          progress:    job.progress,
          detail:      'manually terminated - orphaned',
          finished_at: new Date().toISOString(),
        });
      }
    }

    return res.json({ ok: true, id: episode.id, status: 'failed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/episodes/:id/pause ───────────────────────────────────────────
// Requests a pause. Distinct from /cancel (permanent) and /retry (used
// after a failure/orphan). Does NOT interrupt anything itself -- it only
// flips episodes.status to 'paused'. jobs/runner.js's checkPaused() reads
// this same status field at each of the 8 top-level stage boundaries
// (0A/0B/0C/0D/0E/1_render/7_short/8_qa) and stops cleanly there. Per this
// session's pause investigation, v1 deliberately has no mid-stage pause
// point -- a pause requested while a long stage (e.g. image generation) is
// in flight takes effect only once that stage finishes, not immediately.
// Job rows are left untouched here; the currently-running stage's job row
// will still reach its own natural 'complete' before the pipeline notices
// the pause and stops.
//
// awaiting_approval is explicitly rejected, not just "delayed like any
// other in-flight stage" -- confirmed via live testing + code trace that
// it's a genuine deadlock, not a slow case. Step 1 (render)'s approval
// gate is a single unbroken `await renderEpisode(...)` in jobs/runner.js
// with no checkPaused() call anywhere inside it; the gate's Promise (in
// approvalGates) only resolves via POST /:id/approve, which a user who
// just paused specifically to avoid making a decision has no reason to
// call. Without this guard, pipelineRunning would stay true forever --
// not "for a while" -- until someone approves or rejects anyway, making
// the pause request itself pointless. Since nothing is actively computing
// while awaiting_approval (the pipeline is already stopped, just waiting
// on the same human who'd click Resume), pause is also redundant here,
// not just unsafe -- approve/reject is the correct action instead.

router.patch('/:id/pause', requireAuth, async (req, res) => {
  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (episode.status === 'complete')
      return res.status(400).json({ error: 'Cannot pause a completed episode' });
    if (episode.status === 'failed')
      return res.status(400).json({ error: 'Cannot pause a failed episode' });
    if (episode.status === 'paused')
      return res.status(400).json({ error: 'Episode is already paused' });
    if (episode.status === 'awaiting_approval')
      return res.status(400).json({ error: 'Cannot pause while waiting for your review — please approve or reject the pending act first.' });

    await queries.updateEpisodeStatus('paused', episode.id);
    return res.json({ ok: true, id: episode.id, status: 'paused' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/episodes/:id/resume ───────────────────────────────────────────
// Resumes a paused episode. Deliberately a separate endpoint from /retry,
// not a call to it, even though the body is nearly identical -- retry is
// semantically "something failed or was orphaned, try again" (and the
// automatic boot-time recovery path in jobs/recovery.js DOES increment
// episodes.retry_count for that reason); resume is "the user chose to
// stop, now they've chosen to continue" and must NOT consume a resilience
// retry attempt. This handler intentionally never calls
// queries.incrementEpisodeRetryCount.
//
// Reuses the same mechanics as /retry (backfill any missing job rows,
// reset non-complete jobs to pending, call startJob() again) because every
// stage already knows how to skip work it's already done -- resuming from
// a stage boundary needs no special-cased "resume from here" logic, the
// same way retrying an orphaned episode doesn't.

router.post('/:id/resume', async (req, res) => {
  let userId;
  try {
    const token = authFlexible(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });
    userId = jwt.verify(token, SECRET).sub;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });
    if (episode.status !== 'paused')
      return res.status(400).json({ error: 'Episode is not paused' });
    if (isRunning(episode.id)) return res.status(409).json({ error: 'Episode pipeline is already running' });

    // Backfill any job rows that may be missing (e.g. 8_qa on older episodes)
    const existingJobs = await queries.getJobsForEpisode(episode.id);
    const existingKeys = new Set(existingJobs.map(j => j.step));
    for (const step of STEPS) {
      if (!existingKeys.has(step.key)) {
        await queries.createJob(uuid(), episode.id, step.key);
      }
    }

    // Reset non-complete jobs to pending -- same as /retry. The stage that
    // was interrupted by the pause (if any) may already show 'complete'
    // for a sub-step it finished before the pause check fired; that's
    // fine, it stays complete and won't be redone.
    const jobs = await queries.getJobsForEpisode(episode.id);
    for (const job of jobs) {
      if (job.status !== 'complete') {
        await queries.updateJob(job.id, { status: 'pending', progress: 0, detail: null, started_at: null, finished_at: null });
      }
    }

    // No incrementEpisodeRetryCount call -- see the handler comment above.
    await queries.updateEpisodeStatus('queued', episode.id);
    startJob(episode.id, episode.channel, episode.episode_id, episode.topic);
    return res.json({ message: 'Resumed', id: episode.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/episodes/:id/retry ────────────────────────────────────────────

router.post('/:id/retry', async (req, res) => {
  let userId;
  try {
    const token = authFlexible(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });
    userId = jwt.verify(token, SECRET).sub;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });
    if (episode.status === 'complete') return res.status(400).json({ error: 'Episode already complete' });
    if (isRunning(episode.id)) return res.status(409).json({ error: 'Episode pipeline is already running' });

    // Backfill any job rows that may be missing (e.g. 7_short on older episodes)
    const existingJobs = await queries.getJobsForEpisode(episode.id);
    const existingKeys = new Set(existingJobs.map(j => j.step));
    for (const step of STEPS) {
      if (!existingKeys.has(step.key)) {
        await queries.createJob(uuid(), episode.id, step.key);
      }
    }

    // Reset non-complete jobs to pending
    const jobs = await queries.getJobsForEpisode(episode.id);
    for (const job of jobs) {
      if (job.status !== 'complete') {
        await queries.updateJob(job.id, { status: 'pending', progress: 0, detail: null, started_at: null, finished_at: null });
      }
    }

    await queries.updateEpisodeStatus('queued', episode.id);
    startJob(episode.id, episode.channel, episode.episode_id, episode.topic);
    return res.json({ message: 'Retry started', id: episode.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes/:id/preview/:act ──────────────────────────────────────

router.get('/:id/preview/:act', async (req, res) => {
  let userId;
  try {
    const token = authFlexible(req);
    if (!token) return res.status(401).json({ error: 'No token' });
    userId = jwt.verify(token, SECRET).sub;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    const previewPath = getActPreview(episode.id, req.params.act);
    if (!previewPath || !fs.existsSync(previewPath))
      return res.status(404).json({ error: 'Preview not available' });

    // Path containment check — prevent directory traversal
    const resolved = path.resolve(previewPath);
    const epDir    = path.resolve(path.join(EPISODES_DIR, `${episode.channel}_${episode.episode_id}`));
    if (!resolved.startsWith(epDir))
      return res.status(403).json({ error: 'Forbidden path' });

    const stat = fs.statSync(resolved);
    const range = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Content-Type':   'video/mp4',
      });
      fs.createReadStream(resolved, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
      fs.createReadStream(resolved).pipe(res);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes/:id/download ──────────────────────────────────────────
// Sprint 1A fix: now accepts ?token= so the browser Download button works
// without requiring JS fetch + blob workaround.

router.get('/:id/download', async (req, res) => {
  let userId;
  try {
    const token = authFlexible(req);
    if (!token) return res.status(401).json({ error: 'No token provided' });
    userId = jwt.verify(token, SECRET).sub;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });
    if (episode.status !== 'complete') return res.status(400).json({ error: 'Episode not yet complete' });
    if (!episode.output_path || !fs.existsSync(episode.output_path))
      return res.status(404).json({ error: 'Output file not found on disk' });

    const filename = path.basename(episode.output_path);
    res.setHeader('Content-Type',        'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(episode.output_path).pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes/:id/short ─────────────────────────────────────────────

router.get('/:id/short', async (req, res) => {
  let userId;
  try {
    const token = authFlexible(req);
    if (!token) return res.status(401).json({ error: 'No token' });
    userId = jwt.verify(token, SECRET).sub;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    // Sprint 1A fix: use channel-namespaced episode dir
    const episodeDir = path.join(EPISODES_DIR, `${episode.channel}_${episode.episode_id}`);
    const shortPath  = path.join(episodeDir, 'short.mp4');

    if (!fs.existsSync(shortPath))
      return res.status(404).json({ error: 'Short not yet generated for this episode' });

    res.setHeader('Content-Type',        'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${episode.channel}_${episode.episode_id}_short.mp4"`);
    fs.createReadStream(shortPath).pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/episodes/:id/short/generate ───────────────────────────────────
// Retroactively generate a short for a completed episode.

router.post('/:id/short/generate', async (req, res) => {
  let userId;
  try {
    const token = authFlexible(req);
    if (!token) return res.status(401).json({ error: 'No token' });
    userId = jwt.verify(token, SECRET).sub;
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });
    if (episode.status !== 'complete') return res.status(400).json({ error: 'Episode must be complete first' });
    if (!episode.output_path || !fs.existsSync(episode.output_path))
      return res.status(404).json({ error: 'Main episode video not found' });

    res.json({ message: 'Short generation started' });

    // Sprint 1A fix: channel-namespaced dir
    const episodeDir = path.join(EPISODES_DIR, `${episode.channel}_${episode.episode_id}`);

    // Ensure pipeline updates are synced first
    syncPipelineUpdates();

    const { PIPELINE_DIR } = require('../startup-init');
    const { extractShort } = require(path.join(PIPELINE_DIR, 'short-extractor.cjs'));

    // Upsert the 7_short job row
    const jobs    = await queries.getJobsForEpisode(episode.id);
    let job7      = jobs.find(j => j.step === '7_short');
    if (!job7) {
      const newId = uuid();
      await queries.createJob(newId, episode.id, '7_short');
      job7 = { id: newId };
    }
    await queries.updateJob(job7.id, { status: 'running', progress: 0, started_at: new Date().toISOString() });

    try {
      const result = await extractShort({
        episodeDir,
        episodeId:      episode.episode_id,
        channel:        episode.channel,
        finalVideoPath: episode.output_path,
        onProgress:     () => {},
      });
      await queries.updateJob(job7.id, {
        status:      'complete',
        progress:    100,
        detail:      `${result.durationSeconds.toFixed(0)}s`,
        finished_at: new Date().toISOString(),
      });
    } catch (e) {
      await queries.updateJob(job7.id, {
        status:      'failed',
        detail:      e.message.slice(0, 200),
        finished_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('[episodes] short/generate error:', err.message);
  }
});

module.exports = router;
