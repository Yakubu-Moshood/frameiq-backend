/**
 * routes/episodes.js
 * Frameiq — Episode routes (async sqlite3 version)
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

// ── Episode output path uses EPISODES_DIR from startup-init ──
const { EPISODES_DIR, PIPELINE_DIR } = require('../startup-init');

const router = express.Router();

const SECRET = process.env.JWT_SECRET || 'frameiq-dev-secret-change-in-production';

const STEPS = [
  { key: '0A_script', label: 'Write Script'       },
  { key: '0B_vo',     label: 'Generate Voiceover' },
  { key: '0C_shots',  label: 'Define Shots'       },
  { key: '0D_images', label: 'Generate Images'    },
  { key: '0E_anim',   label: 'Animate Clips'      },
  { key: '1_render',  label: 'Render Episode'     },
  { key: '7_short',   label: 'Extract Short'      },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Authenticate from EITHER the Authorization header OR a ?token= query
 * param. Query tokens exist because <video> tags and EventSource cannot
 * send headers (same lesson as the SSE route). Returns userId or null.
 */
function authFlexible(req) {
  try {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ')
      ? header.slice(7)
      : req.query.token;
    if (!token) return null;
    const payload = jwt.verify(token, SECRET);
    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * Stream a video file with HTTP Range support so <video> elements can
 * seek. Plain createReadStream().pipe() works for downloads but makes
 * in-browser players unable to scrub.
 */
function streamVideo(req, res, filePath) {
  const stat  = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end   = match && match[2] ? parseInt(match[2], 10) : total - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end) { start = 0; end = total - 1; }

    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   'video/mp4',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type':   'video/mp4',
      'Accept-Ranges':  'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

/** Is this path inside one of our data roots? (defence in depth) */
function isInsideDataRoots(filePath) {
  const resolved = path.resolve(filePath);
  const roots    = [EPISODES_DIR, PIPELINE_DIR].filter(Boolean).map(r => path.resolve(r));
  return roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

// ─── POST /api/episodes ───────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const { channel = 'EmpireOmitted', episodeId, topic } = req.body || {};
  if (!episodeId || !topic)
    return res.status(400).json({ error: 'episodeId and topic are required' });

  const dbId = uuid();
  try {
    await queries.createEpisode(dbId, req.userId, channel, episodeId, topic);
    for (const step of STEPS) {
      await queries.createJob(uuid(), dbId, step.key);
    }
    startJob(dbId, channel, episodeId, topic);
    return res.status(201).json({ id: dbId, episodeId, topic, status: 'queued' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/episodes/:id/retry ─────────────────────────────────────────────
// Re-kick a stuck or failed episode. Safe because the pipeline skips
// every asset that already exists on the Volume — no API cost is
// re-spent. Refuses if the pipeline for this episode is genuinely
// still running in this process.
// Accepts header OR ?token= auth so it can be triggered without the UI.

router.post('/:id/retry', async (req, res) => {
  const userId = authFlexible(req);
  if (!userId) return res.status(401).json({ error: 'Invalid or missing token' });

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    if (episode.status === 'complete')
      return res.status(400).json({ error: 'Episode is already complete' });

    if (isRunning(episode.id))
      return res.status(409).json({ error: 'Episode pipeline is already running — nothing to retry' });

    // Backfill any job rows added since this episode was created
    // (e.g. 7_short for episodes that predate the Short Extractor)
    const jobs = await queries.getJobsForEpisode(episode.id);
    for (const step of STEPS) {
      if (!jobs.find(j => j.step === step.key)) {
        await queries.createJob(uuid(), episode.id, step.key);
      }
    }

    const channelKey = episode.channel    || episode.channel_key || 'EmpireOmitted';
    const episodeId  = episode.episode_id || episode.episodeId;
    const topic      = episode.topic;

    if (!episodeId)
      return res.status(500).json({ error: 'Could not determine episodeId from episode record' });

    const started = startJob(episode.id, channelKey, episodeId, topic);
    if (!started)
      return res.status(409).json({ error: 'Episode pipeline is already running' });

    return res.json({ ok: true, retried: true, episodeId, message: 'Pipeline restarted — existing assets will be reused' });
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
  const userId = authFlexible(req);
  if (!userId) return res.status(401).json({ error: 'Invalid or missing token' });

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

// ─── GET /api/episodes/:id/preview/:act ──────────────────────────────────────
// Streams the act video currently awaiting approval, with Range
// support so the in-browser player can scrub. Accepts ?token= auth
// because <video> tags cannot send Authorization headers.

router.get('/:id/preview/:act', async (req, res) => {
  const userId = authFlexible(req);
  if (!userId) return res.status(401).json({ error: 'Invalid or missing token' });

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    const previewPath = getActPreview(episode.id, req.params.act);
    if (!previewPath || !fs.existsSync(previewPath))
      return res.status(404).json({ error: 'No preview available for this act (the approval gate may have been resolved or the server restarted)' });

    if (!isInsideDataRoots(previewPath))
      return res.status(403).json({ error: 'Preview path outside data roots' });

    streamVideo(req, res, previewPath);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/episodes/:id/short/generate ───────────────────────────────────
// Generate (or regenerate) the 59s short for an episode that has
// already completed — e.g. episodes finished before Step 7 existed.
// Takes 1-3 minutes; the response waits for the result. Even if the
// HTTP request times out, the short still gets written to the Volume
// and becomes downloadable via GET /:id/short.

router.post('/:id/short/generate', async (req, res) => {
  const userId = authFlexible(req);
  if (!userId) return res.status(401).json({ error: 'Invalid or missing token' });

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    if (episode.status !== 'complete')
      return res.status(400).json({ error: 'Episode must be complete before generating a short' });
    if (isRunning(episode.id))
      return res.status(409).json({ error: 'Episode pipeline is currently running' });
    if (!episode.output_path || !fs.existsSync(episode.output_path))
      return res.status(404).json({ error: 'Final video not found on disk' });

    // Make sure the latest short-extractor.cjs is on the Volume
    syncPipelineUpdates();

    const epFolder   = episode.episode_id || episode.episodeId;
    const channelKey = episode.channel    || episode.channel_key || 'EmpireOmitted';

    const { extractShort } = require(path.join(PIPELINE_DIR, 'short-extractor.cjs'));
    const result = await extractShort({
      episodeDir:     path.join(EPISODES_DIR, epFolder),
      episodeId:      epFolder,
      channel:        channelKey,
      finalVideoPath: episode.output_path,
    });

    // Reflect the result in the 7_short job row (create it if missing)
    const jobs = await queries.getJobsForEpisode(episode.id);
    let job7   = jobs.find(j => j.step === '7_short');
    if (!job7) {
      const newId = uuid();
      await queries.createJob(newId, episode.id, '7_short');
      job7 = { id: newId };
    }
    await queries.updateJob(job7.id, {
      status:      'complete',
      progress:    100,
      detail:      `${result.durationSeconds.toFixed(0)}s, ${result.captions} captions`,
      finished_at: new Date().toISOString(),
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes/:id/short ─────────────────────────────────────────────
// Download the 59s vertical short produced by Step 7.
// Accepts ?token= auth so a plain link/anchor tag can trigger it.

router.get('/:id/short', async (req, res) => {
  const userId = authFlexible(req);
  if (!userId) return res.status(401).json({ error: 'Invalid or missing token' });

  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    const epFolder  = episode.episode_id || episode.episodeId;
    const shortPath = path.join(EPISODES_DIR, epFolder, 'short.mp4');
    if (!fs.existsSync(shortPath))
      return res.status(404).json({ error: 'Short not found — Step 7 may not have run for this episode yet' });

    res.setHeader('Content-Type',        'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${epFolder}-short.mp4"`);
    fs.createReadStream(shortPath).pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes/:id/download ──────────────────────────────────────────
// Uses EPISODES_DIR so the path works on Railway Volume

router.get('/:id/download', requireAuth, async (req, res) => {
  try {
    const episode = await queries.getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    if (episode.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
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

module.exports = router;
