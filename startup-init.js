/**
 * startup-init.js
 * Frameiq — Boot checks for Railway deployment
 *
 * 1. Decides where /data lives (Railway Volume vs local fallback)
 * 2. Creates all required subdirectories
 * 3. Validates required environment variables
 * 4. Exports resolved paths used throughout the app
 *
 * Required by server.js as the very first require().
 * If anything is wrong it exits immediately with a clear message.
 */

const fs   = require('fs');
const path = require('path');

// ── Where is the data root? ───────────────────────────────────
// On Railway: the Volume is mounted at /data
// Locally:    falls back to ./local-data (created automatically)
const DATA_ROOT = process.env.RAILWAY_ENVIRONMENT
  ? '/data'
  : path.join(__dirname, 'local-data');

// ── Subdirectories to create on boot ─────────────────────────
const DATA_DIRS = [
  'pipeline',   // .cjs pipeline scripts (uploaded once via Railway CLI)
  'episodes',   // rendered MP4 output files
  'public',     // outro MP4, logos, static assets
  'db',         // SQLite database file lives here
];

// ── Required environment variables ───────────────────────────
// The app will not start if any of these are missing on Railway.
// Locally they can come from .env (dotenv is loaded in server.js).
const REQUIRED_VARS = [
  'JWT_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'FAL_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'FRONTEND_URL',
];

// ── Run checks ────────────────────────────────────────────────

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  FRAMEIQ — startup checks');
console.log(`  Environment : ${process.env.RAILWAY_ENVIRONMENT || 'local'}`);
console.log(`  Data root   : ${DATA_ROOT}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 1. Create data directories
let dirFailed = false;
for (const dir of DATA_DIRS) {
  const full = path.join(DATA_ROOT, dir);
  try {
    fs.mkdirSync(full, { recursive: true });
    console.log(`  ✓ ${full}`);
  } catch (err) {
    console.error(`  ✗ Could not create ${full}: ${err.message}`);
    dirFailed = true;
  }
}

if (dirFailed) {
  console.error('');
  console.error('  ✗ Directory creation failed.');
  console.error('    On Railway: make sure the Volume is mounted at /data.');
  console.error('    Dashboard → your service → Volumes → mount path: /data');
  console.error('');
  process.exit(1);
}

// 2. Validate env vars (only enforce on Railway — locally .env handles it)
if (process.env.RAILWAY_ENVIRONMENT) {
  const missing = REQUIRED_VARS.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('');
    console.error('  ✗ Missing required environment variables:');
    missing.forEach(k => console.error(`    – ${k}`));
    console.error('');
    console.error('    Set these in Railway dashboard → your service → Variables');
    console.error('');
    process.exit(1);
  }
}

// 3. Warn if YouTube credentials path is missing
if (!process.env.YOUTUBE_CREDENTIALS_PATH) {
  console.log('  ⚠  YOUTUBE_CREDENTIALS_PATH not set — YouTube upload disabled');
}

console.log('  ✓ All checks passed');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// ── Export resolved paths ─────────────────────────────────────
// Import these in any file that needs a data path:
//   const { PIPELINE_DIR, EPISODES_DIR, DB_PATH } = require('./startup-init');

module.exports = {
  DATA_ROOT,
  PIPELINE_DIR : path.join(DATA_ROOT, 'pipeline'),
  EPISODES_DIR : path.join(DATA_ROOT, 'episodes'),
  PUBLIC_DIR   : path.join(DATA_ROOT, 'public'),
  DB_PATH      : path.join(DATA_ROOT, 'db', 'frameiq.db'),
};
