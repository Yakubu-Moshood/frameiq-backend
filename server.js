/**
 * server.js
 * Frameiq — Express server entry point
 */

// ── Startup checks (MUST be first) ───────────────────────────
// Creates /data subdirs on Railway Volume, validates env vars.
// Exits with a clear error message if anything is missing.
require('./startup-init');

require('dotenv').config();
'use strict';

const express = require('express');
const cors    = require('cors');

const { initSchema } = require('./db');
const authRoutes        = require('./routes/auth');
const episodeRoutes     = require('./routes/episodes');
const suggestionRoutes  = require('./routes/suggestions');

const app  = express();
const PORT = process.env.PORT || 3001;

// Allow any localhost port in dev, plus the configured FRONTEND_URL in prod
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // non-browser requests
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

app.use('/api/auth',        authRoutes);
app.use('/api/episodes',    episodeRoutes);
app.use('/api/suggestions', suggestionRoutes);

// ── Health check — Railway uses this to confirm the app is up ─
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

initSchema().then(() => {
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
}).catch(err => {
  console.error('[server] Failed to initialise database:', err);
  process.exit(1);
});

module.exports = app;
