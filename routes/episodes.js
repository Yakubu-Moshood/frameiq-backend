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
    return res.json({ ...episode, jobs });
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
    res.write(`data: ${JSON.stringify({ type: 'snapshot', episode, jobs })}\n\n`);

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
