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
 */

require('./startup-init');
require('dotenv').config();

'use strict';

const express = require('express');
const cors    = require('cors');

const { initSchema, runMigrations } = require('./db');

const authRoutes            = require('./routes/auth');
const episodeRoutes         = require('./routes/episodes');
const suggestionRoutes      = require('./routes/suggestions');
const blueprintRoutes       = require('./routes/blueprints');                     // Sprint 1A
const recommendationRoutes  = require('./routes/recommendations');                // Sprint 1C
const revisionsRouter       = require('./routes/revisions');                      // Sprint 2A Phase A
const previewRouter         = require('./routes/preview');                        // Sprint 2A Phase B

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
app.use('/api/episodes/recommend',                      recommendationRoutes);   // Sprint 1C
app.use('/api/episodes',                                episodeRoutes);
app.use('/api/episodes/:episodeId/revisions',           revisionsRouter);        // Sprint 2A Phase A
app.use('/api/episodes/:episodeId/preview',             previewRouter);          // Sprint 2A Phase B
app.use('/api/suggestions',                             suggestionRoutes);
app.use('/api/blueprints',                              blueprintRoutes);        // Sprint 1A

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
initSchema()
  .then(() => runMigrations())
  .then(() => {
    app.listen(PORT, () => {
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

module.exports = app;
