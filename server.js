/**
 * server.js
 * Frameiq — Express server entry point
 *
 * Sprint 1A additions:
 *   - blueprintRoutes mounted at /api/blueprints
 *   - runMigrations() called after initSchema(), before app.listen()
 *
 * Sprint 1C additions:
 *   - recommendationsRouter at /api/episodes/recommend (BEFORE /api/episodes)
 *
 * Sprint 2A Phase A additions:
 *   - revisionsRouter at /api/episodes/:episodeId/revisions
 *
 * Sprint 2A Phase B additions:
 *   - previewRouter at /api/episodes/:episodeId/preview
 *
 * Channel DNA v2 additions:
 *   - channelRoutes mounted at /api/channels
 *
 * Standalone Macro Decode adapter (disconnected, not deleted):
 *   - /api/episodes and /api/channels must always point at the live,
 *     jobs/runner.js-backed routes (./routes/episodes, ./routes/channels).
 *     A prior in-progress swap pointed episodeRoutes at ./src/routes/episodes
 *     (a JSON-file-backed draft CRUD with no startJob/SSE/approve/retry/
 *     download/short support) which would have silently broken Empire
 *     Omitted's live production flow if pushed. Reverted.
 *   - handoffRoutes/jobRoutes/pipelineStatusRoutes/sourceReviewRoutes are
 *     the standalone adapter's own non-colliding paths (/api/handoffs,
 *     /api/jobs, /api/pipeline-status, /api/source-review). Left mounted
 *     since they don't collide with anything live — but note the adapter
 *     is retired as a production engine (jobs/runner.js is now the single
 *     shared engine for all channels). See macro-decode-session-outline.md
 *     Section 6. frameiq-frontend's ChannelPage.jsx still has a live "Run
 *     Production" button wired to these paths — flagged separately, not
 *     removed here (frontend was out of scope for this fix).
 */

require('./startup-init');
require('dotenv').config();

'use strict';

const express = require('express');
const cors    = require('cors');

const { initSchema, runMigrations, db } = require('./db');
const { recoverOrphanedEpisodes }       = require('./jobs/recovery');
const { getActiveEpisodeIds }           = require('./jobs/runner');

const authRoutes            = require('./routes/auth');
const episodeRoutes         = require('./routes/episodes');
const suggestionRoutes      = require('./routes/suggestions');
const blueprintRoutes       = require('./routes/blueprints');
const recommendationRoutes  = require('./routes/recommendations');
const revisionsRouter       = require('./routes/revisions');
const previewRouter         = require('./routes/preview');
const channelRoutes         = require('./routes/channels');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
      'http://localhost:5176',
    ].filter(Boolean);
    if (allowed.includes(origin)) return callback(null, true);
    return callback(null, true);
  },
  credentials: true,
}));

app.use(express.json());

// ── Routes ────────────────────────────────────────────────────
// IMPORTANT: /api/episodes/recommend must remain BEFORE /api/episodes
app.use('/api/auth',                                    authRoutes);
app.use('/api/channels',                                channelRoutes);
app.use('/api/episodes/recommend',                      recommendationRoutes);
app.use('/api/episodes',                                episodeRoutes);
app.use('/api/episodes/:episodeId/revisions',           revisionsRouter);
app.use('/api/episodes/:episodeId/preview',             previewRouter);
app.use('/api/suggestions',                             suggestionRoutes);
app.use('/api/blueprints',                              blueprintRoutes);

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    ok:      true,
    service: 'frameiq-backend',
    env:     process.env.RAILWAY_ENVIRONMENT || 'local',
    ts:      new Date().toISOString(),
  });
});

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Boot sequence ─────────────────────────────────────────────
// job-queue-resilience-spec.md section 3.4: recovery scan runs after
// migrations, before the port opens, so no new episode-creation request
// can race a requeue for the same channel/episode.
let httpServer;

initSchema()
  .then(() => runMigrations())
  .then(() => recoverOrphanedEpisodes())
  .then(() => {
    httpServer = app.listen(PORT, () => {
      console.log('');
      console.log('╔══════════════════════════════════════════════╗');
      console.log('║         FRAMEIQ BACKEND — RUNNING            ║');
      console.log('╠══════════════════════════════════════════════╣');
      console.log(`║  Port:     ${String(PORT).padEnd(33)}║`);
      console.log(`║  Env:      ${(process.env.RAILWAY_ENVIRONMENT || 'local').padEnd(33)}║`);
      console.log(`║  Frontend: ${(process.env.FRONTEND_URL || 'http://localhost:5173').padEnd(33)}║`);
      console.log('╚══════════════════════════════════════════════╝');
      console.log('');
    });
  })
  .catch(err => {
    console.error('[server] Failed to initialise database:', err);
    process.exit(1);
  });

// ── Graceful shutdown (job-queue-resilience-spec.md section 3.3) ──────────
// Railway sends SIGTERM before killing a container for a deploy/restart.
// This process has no separate worker — renders run in-process — so there
// is no distinct "mark in-flight jobs as gracefully interrupted" state to
// set: any episode still 'running'/'awaiting_approval' when this process
// exits, whether via SIGTERM or a hard crash, is picked up uniformly by
// the boot-time recoverOrphanedEpisodes() scan on next start (see
// jobs/recovery.js — it doesn't distinguish graceful vs. crashed, since
// activeEpisodes is empty either way at boot). What SIGTERM handling adds
// here is avoiding a hard kill mid-write: closing the HTTP server and the
// SQLite handle cleanly reduces the chance of a torn WAL write versus
// Railway escalating to SIGKILL while a query is in flight.
let shuttingDown = false;

process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;

  const active = getActiveEpisodeIds();
  console.log(`[server] SIGTERM received — ${active.length} episode(s) in flight: ${active.join(', ') || 'none'}`);
  console.log('[server] These will be recovered by the boot-time scan on next start.');

  const finish = () => {
    db.close(err => {
      if (err) console.error('[server] Error closing DB:', err.message);
      else console.log('[server] DB closed cleanly');
      process.exit(0);
    });
  };

  if (httpServer) {
    httpServer.close(finish);
    // Don't hang forever waiting for in-flight HTTP requests (e.g. an SSE
    // connection) to drain — Railway gives a limited grace period.
    setTimeout(finish, 5000).unref();
  } else {
    finish();
  }
});

module.exports = app;
