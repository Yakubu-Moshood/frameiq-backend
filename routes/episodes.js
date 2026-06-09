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
const { startJob, resolveApproval } = require('../jobs/runner');

// ── Episode output path uses EPISODES_DIR from startup-init ──
const { EPISODES_DIR } = require('../startup-init');

const router = express.Router();

const SECRET = process.env.JWT_SECRET || 'frameiq-dev-secret-change-in-production';

const STEPS = [
  { key: '0A_script', label: 'Write Script'       },
  { key: '0B_vo',     label: 'Generate Voiceover' },
  { key: '0C_shots',  label: 'Define Shots'       },
  { key: '0D_images', label: 'Generate Images'    },
  { key: '0E_anim',   label: 'Animate Clips'      },
  { key: '1_render',  label: 'Render Episode'     },
];

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
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ')
      ? header.slice(7)
      : req.query.token;

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
