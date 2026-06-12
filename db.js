/**
 * db.js
 * Frameiq — SQLite database setup
 * Uses sqlite3 (async) with a promise wrapper for clean usage
 *
 * Sprint 1A additions:
 *   - runMigrations()   — idempotent schema migration runner
 *   - createEpisodeV2   — episode creation with blueprint_id
 *   - getBlueprint      — fetch single blueprint by id
 *   - listBlueprints    — fetch all blueprints
 *   - getChannelDna     — fetch single channel DNA record
 *   - listChannelDna    — fetch all channel DNA records
 *   - exec added to module.exports (needed by runMigrations in server.js)
 */

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const sqlite3 = require('sqlite3').verbose();

// ── DB path comes from startup-init ──────────────────────────
// On Railway: /data/db/frameiq.db  (persists on Volume)
// Locally:    ./local-data/db/frameiq.db
const { DB_PATH } = require('./startup-init');

const db = new sqlite3.Database(DB_PATH);

// ─── Promise helpers ──────────────────────────────────────────────────────────

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ─── Schema ───────────────────────────────────────────────────────────────────

async function initSchema() {
  await exec(`PRAGMA journal_mode = WAL;`);
  await exec(`PRAGMA foreign_keys = ON;`);

  await exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      channel     TEXT NOT NULL DEFAULT 'EmpireOmitted',
      episode_id  TEXT NOT NULL,
      topic       TEXT NOT NULL,
      title       TEXT,
      status      TEXT NOT NULL DEFAULT 'queued',
      output_path TEXT,
      duration_s  REAL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      episode_id  TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      step        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      progress    INTEGER DEFAULT 0,
      detail      TEXT,
      error       TEXT,
      started_at  TEXT,
      finished_at TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_user   ON episodes(user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_episode    ON jobs(episode_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
  `);
}

// ─── Sprint 1A migration runner ───────────────────────────────────────────────
// Called from server.js immediately after initSchema().
// Idempotent: tracks applied migrations in schema_migrations table.
// Safe to call on every boot — skips instantly if already applied.

async function runMigrations() {
  // Ensure migrations tracking table exists
  await run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ── Migration 001_sprint1a ─────────────────────────────────────────────────
  const m001 = await get(`SELECT id FROM schema_migrations WHERE id = '001_sprint1a'`);
  if (m001) {
    console.log('[migrations] 001_sprint1a already applied — skipping');
    return;
  }

  console.log('[migrations] Applying 001_sprint1a...');

  // Run the SQL file (creates platforms, blueprints, channel_dna, blueprint_recommendations)
  const sqlPath = path.join(__dirname, 'migrations', '001_sprint1a.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`[migrations] Migration file not found: ${sqlPath}`);
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await exec(sql);

  // Add new columns to episodes table.
  // SQLite has no ADD COLUMN IF NOT EXISTS — check via PRAGMA first.
  const colInfo  = await all(`PRAGMA table_info(episodes)`);
  const existing = new Set(colInfo.map(c => c.name));

  const newCols = [
    ['blueprint_id',              "TEXT DEFAULT 'documentary'"],
    ['blueprint_config',          'TEXT'],
    ['recommended_blueprint',     'TEXT'],
    ['recommendation_confidence', 'REAL'],
    ['content_mode',              "TEXT DEFAULT 'ai_generated'"],
    ['script_approved_at',        'TEXT'],
    ['script_source',             'TEXT'],
  ];

  for (const [col, def] of newCols) {
    if (!existing.has(col)) {
      await run(`ALTER TABLE episodes ADD COLUMN ${col} ${def}`);
      console.log(`[migrations] Added column: episodes.${col}`);
    }
  }

  // Record migration as applied
  await run(`INSERT INTO schema_migrations (id) VALUES ('001_sprint1a')`);
  console.log('[migrations] 001_sprint1a complete');

  // Run the seeder
  const { seedSprint1A } = require('./data/seed-sprint1a');
  await seedSprint1A(db);
}

// ─── Query helpers ────────────────────────────────────────────────────────────

const queries = {

  // ── Users ──────────────────────────────────────────────────────────────────

  createUser: (id, email, password) =>
    run(`INSERT INTO users (id, email, password) VALUES (?, ?, ?)`, [id, email, password]),

  getUserByEmail: (email) =>
    get(`SELECT * FROM users WHERE email = ?`, [email]),

  getUserById: (id) =>
    get(`SELECT * FROM users WHERE id = ?`, [id]),

  // ── Episodes ───────────────────────────────────────────────────────────────

  // Original — kept for backward compatibility
  createEpisode: (id, userId, channel, episodeId, topic) =>
    run(
      `INSERT INTO episodes (id, user_id, channel, episode_id, topic, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
      [id, userId, channel, episodeId, topic]
    ),

  // Sprint 1A — includes blueprint_id and content_mode
  createEpisodeV2: (id, userId, channel, episodeId, topic, blueprintId) =>
    run(
      `INSERT INTO episodes (id, user_id, channel, episode_id, topic, status, blueprint_id, content_mode)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, 'ai_generated')`,
      [id, userId, channel, episodeId, topic, blueprintId || 'documentary']
    ),

  getEpisode: (id) =>
    get(`SELECT * FROM episodes WHERE id = ?`, [id]),

  listEpisodes: (userId) =>
    all(`SELECT * FROM episodes WHERE user_id = ? ORDER BY created_at DESC`, [userId]),

  updateEpisodeStatus: (status, id) =>
    run(`UPDATE episodes SET status = ?, updated_at = datetime('now') WHERE id = ?`, [status, id]),

  updateEpisodeResult: (status, title, outputPath, durationS, id) =>
    run(
      `UPDATE episodes SET status=?, title=?, output_path=?, duration_s=?, updated_at=datetime('now') WHERE id=?`,
      [status, title, outputPath, durationS, id]
    ),

  // ── Jobs ───────────────────────────────────────────────────────────────────

  createJob: (id, episodeId, step) =>
    run(
      `INSERT INTO jobs (id, episode_id, step, status, progress) VALUES (?, ?, ?, 'pending', 0)`,
      [id, episodeId, step]
    ),

  getJobsForEpisode: (episodeId) =>
    all(`SELECT * FROM jobs WHERE episode_id = ? ORDER BY rowid ASC`, [episodeId]),

  updateJob: (jobId, { status, progress = 0, detail = null, error = null, started_at = null, finished_at = null }) =>
    run(
      `UPDATE jobs
       SET status=?, progress=?, detail=?, error=?,
           started_at  = CASE WHEN ? IS NOT NULL THEN ? ELSE started_at END,
           finished_at = CASE WHEN ? IS NOT NULL THEN ? ELSE finished_at END,
           updated_at  = datetime('now')
       WHERE id=?`,
      [status, progress, detail, error, started_at, started_at, finished_at, finished_at, jobId]
    ),

  // ── Blueprints (Sprint 1A) ─────────────────────────────────────────────────

  // Fetch a single blueprint by id
  getBlueprint: (id) =>
    get(`SELECT * FROM blueprints WHERE id = ?`, [id]),

  // Fetch all blueprints ordered by custom flag then label
  listBlueprints: () =>
    all(`SELECT * FROM blueprints ORDER BY is_custom ASC, label ASC`),

  // ── Channel DNA (Sprint 1A) ────────────────────────────────────────────────

  // Fetch a single channel DNA record by id
  getChannelDna: (id) =>
    get(`SELECT * FROM channel_dna WHERE id = ?`, [id]),

  // Fetch all channel DNA records
  listChannelDna: () =>
    all(`SELECT * FROM channel_dna ORDER BY label ASC`),
};

module.exports = { db, queries, run, get, all, exec, initSchema, runMigrations };
