'use strict';

/**
 * routes/revisions.js
 * Sprint 2A Phase A — Revision request CRUD
 *
 * Endpoints:
 *   POST   /api/episodes/:id/revisions          — create revision request
 *   GET    /api/episodes/:id/revisions          — list all revisions for episode
 *   GET    /api/episodes/:id/revisions/:revId   — get single revision
 *   PATCH  /api/episodes/:id/revisions/:revId   — cancel a revision
 *
 * No regeneration. No dispatch. No Sprint 2B logic.
 * All routes protected by requireAuth (imported from middleware/auth).
 */

const express         = require('express');
const { v4: uuid }    = require('uuid');
const { queries }     = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// Valid revision types — Sprint 2B dispatcher will act on these
const VALID_TYPES = ['script', 'voice', 'image', 'anim', 'full_act'];

// Valid act numbers — acts 1–5, with 3 covering any 3b split internally
const VALID_ACTS = [1, 2, 3, 4, 5];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Verify the episode exists and belongs to the requesting user.
 * Returns the episode row or throws with the appropriate HTTP status.
 */
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

// ─── POST /api/episodes/:id/revisions ────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const { id: episodeId } = req.params;
  const { act, comment, revision_type } = req.body || {};

  // Validate episode ownership
  const episode = await resolveEpisode(episodeId, req.userId, res);
  if (!episode) return;

  // Validate required fields
  if (act === undefined || act === null) {
    return res.status(400).json({ error: 'act is required' });
  }
  if (!VALID_ACTS.includes(Number(act))) {
    return res.status(400).json({ error: `act must be one of: ${VALID_ACTS.join(', ')}` });
  }
  if (!comment || typeof comment !== 'string' || comment.trim().length === 0) {
    return res.status(400).json({ error: 'comment is required' });
  }
  if (!revision_type || !VALID_TYPES.includes(revision_type)) {
    return res.status(400).json({ error: `revision_type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  const id  = uuid();
  const now = new Date().toISOString();

  try {
    await queries.db.run(
      `INSERT INTO revisions (id, episode_id, act, comment, revision_type, status, iteration, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, ?)`,
      [id, episodeId, Number(act), comment.trim(), revision_type, now, now]
    );

    console.log(`[revisions] created id=${id} episode=${episodeId} act=${act} type=${revision_type}`);

    return res.status(201).json({
      id,
      episode_id:    episodeId,
      act:           Number(act),
      comment:       comment.trim(),
      revision_type,
      status:        'queued',
      iteration:     null,
      created_at:    now,
      updated_at:    now,
    });
  } catch (err) {
    console.error('[revisions] create error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes/:id/revisions ─────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  const { id: episodeId } = req.params;

  const episode = await resolveEpisode(episodeId, req.userId, res);
  if (!episode) return;

  try {
    const revisions = await queries.db.all(
      `SELECT * FROM revisions WHERE episode_id = ? ORDER BY created_at DESC`,
      [episodeId]
    );
    return res.json(revisions);
  } catch (err) {
    console.error('[revisions] list error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/episodes/:id/revisions/:revId ───────────────────────────────────

router.get('/:revId', requireAuth, async (req, res) => {
  const { id: episodeId, revId } = req.params;

  const episode = await resolveEpisode(episodeId, req.userId, res);
  if (!episode) return;

  try {
    const revision = await queries.db.get(
      `SELECT * FROM revisions WHERE id = ? AND episode_id = ?`,
      [revId, episodeId]
    );
    if (!revision) return res.status(404).json({ error: 'Revision not found' });
    return res.json(revision);
  } catch (err) {
    console.error('[revisions] get error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/episodes/:id/revisions/:revId ────────────────────────────────
// Sprint 2A supports cancellation only.
// Sprint 2B will extend this to approve / mark complete / etc.

router.patch('/:revId', requireAuth, async (req, res) => {
  const { id: episodeId, revId } = req.params;
  const { status } = req.body || {};

  const episode = await resolveEpisode(episodeId, req.userId, res);
  if (!episode) return;

  // Sprint 2A: only 'cancelled' is a valid target status
  if (status !== 'cancelled') {
    return res.status(400).json({ error: "status must be 'cancelled' in Sprint 2A" });
  }

  try {
    const revision = await queries.db.get(
      `SELECT * FROM revisions WHERE id = ? AND episode_id = ?`,
      [revId, episodeId]
    );
    if (!revision) return res.status(404).json({ error: 'Revision not found' });

    if (revision.status !== 'queued') {
      return res.status(400).json({
        error: `Cannot cancel revision with status '${revision.status}'`,
      });
    }

    const now = new Date().toISOString();
    await queries.db.run(
      `UPDATE revisions SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      [now, revId]
    );

    console.log(`[revisions] cancelled id=${revId}`);

    return res.json({ id: revId, status: 'cancelled', updated_at: now });
  } catch (err) {
    console.error('[revisions] cancel error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
