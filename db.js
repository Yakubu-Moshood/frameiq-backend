/**
 * db.js
 * Frameiq — SQLite database setup
 * Uses sqlite3 (async) with a promise wrapper for clean usage
 */

require('dotenv').config();
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

// ─── Query helpers ────────────────────────────────────────────────────────────

const queries = {

  // Users
  createUser: (id, email, password) =>
    run(`INSERT INTO users (id, email, password) VALUES (?, ?, ?)`, [id, email, password]),

  getUserByEmail: (email) =>
    get(`SELECT * FROM users WHERE email = ?`, [email]),

  getUserById: (id) =>
    get(`SELECT * FROM users WHERE id = ?`, [id]),

  // Episodes
  createEpisode: (id, userId, channel, episodeId, topic) =>
    run(
      `INSERT INTO episodes (id, user_id, channel, episode_id, topic, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
      [id, userId, channel, episodeId, topic]
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

  // Jobs
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
};

module.exports = { db, queries, run, get, all, initSchema };
