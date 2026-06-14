'use strict';

/**
 * routes/revisions.js
 * Sprint 2A Phase A — Revision request CRUD
 *
 * Fix (Sprint 2A Phase C): use run/get/all promise helpers from db.js
 * instead of queries.db.run/all/get which are callback-based.
 */

const express         = require('express');
const { v4: uuid }    = require('uuid');
const { queries, run, get, all } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const VALID_TYPES = ['script', 'voice', 'image', 'anim', 'full_act'];
const VALID_ACTS  = [1, 2, 3, 4, 5];

async function resolveEpisode(episodeId, userId, res) {
  const episode = await queries.getEpisode(episodeId);
  if (!episode) {
    res.status(404).json({ error: 'Episode not found' });
    return null;
  }
  if (episode.user_id !== userId) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return episode;
}

router.post('/', requireAuth, async (req, res) => {
  const episodeId = req.params.episodeId || req.params.id;
  const { act, comment, revision_type } = req.body || {};

  const episode = await resolveEpisode(episodeId, req.userId, res);
  if (!episode) return;

  if (act === undefined || act === null)
    return res.status(400).json({ error: 'act is required' });
  if (!VALID_ACTS.includes(Number(act)))
    return res.status(400).json({ error: `act must be one of: ${VALID_ACTS.join(', ')}` });
  if (!comment || typeof comment !== 'string' || comment.trim().length === 0)
    return res.status(400).json({ error: 'comment is required' });
  if (!revision_type || !VALID_TYPES.includes(revision_type))
    return res.status(400).json({ error: `revision_type must be one of: ${VALID_TYPES.join(', ')}` });

  const id  = uuid();
  const now = new Date().toISOString();

  try {
    await run(
      `INSERT INTO revisions (id, episode_id, act, comment, revision_type, status, iteration, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, ?)`,
      [id, episodeId, Number(act), comment.trim(), revision_type, now, now]
    );
    console.log(`[revisions] created id=${id} episode=${episodeId} act=${act} type=${revision_type}`);
    return res.status(201).json({
      id, episode_id: episodeId, act: Number(act),
      comment: comment.trim(), revision_type,
      status: 'queued', iteration: null,
      created_at: now, updated_at: now,
    });
  } catch (err) {
    console.error('[revisions] create error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.get('/', requireAuth, async (req, res) => {
  const episodeId = req.params.episodeId || req.params.id;
  const episode = await resolveEpisode(episodeId, req.userId, res);
  if (!episode) return;
  try {
    const revisions = await all(
      `SELECT * FROM revisions WHERE episode_id = ? ORDER BY created_at DESC`,
      [episodeId]
    );
    // Prevent browser caching so fresh data is always returned
    res.set('Cache-Control', 'no-store');
    return res.json(revisions);
  } catch (err) {
    console.error('[revisions] list error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:revId', requireAuth, async (req, res) => {
  const episodeId = req.params.episodeId || req.params.id;
  const { revId } = req.params;
  const episode = await resolveEpisode(episodeId, req.userId, res);
  if (!episode) return;
  try {
    const revision = await get(
      `SELECT * FROM revisions WHERE id = ? AND episode_id = ?`,
      [revId, episodeId]
    );
    if (!revision) return res.status(404).json({ error: 'Revision not found' });
    return res.json(revision);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/:revId', requireAuth, async (req, res) => {
  const episodeId = req.params.episodeId || req.params.id;
  const { revId } = req.params;
  const { status } = req.body || {};
  const episode = await resolveEpisode(episodeId, req.userId, res);
  if (!episode) return;
  if (status !== 'cancelled')
    return res.status(400).json({ error: "status must be 'cancelled' in Sprint 2A" });
  try {
    const revision = await get(
      `SELECT * FROM revisions WHERE id = ? AND episode_id = ?`,
      [revId, episodeId]
    );
    if (!revision) return res.status(404).json({ error: 'Revision not found' });
    if (revision.status !== 'queued')
      return res.status(400).json({ error: `Cannot cancel revision with status '${revision.status}'` });
    const now = new Date().toISOString();
    await run(
      `UPDATE revisions SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      [now, revId]
    );
    console.log(`[revisions] cancelled id=${revId}`);
    return res.json({ id: revId, status: 'cancelled', updated_at: now });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
