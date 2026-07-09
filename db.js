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
 *
 * Sprint 2A additions:
 *   - runMigrations() refactored — removed early return after 001
 *     Each migration now checked independently so 004 always runs
 *   - Migration 004_review_foundation wired in
 *
 * Sprint 1.5 Phase A additions:
 *   - Migration 005_sprint15_phase_a wired in
 *     provider columns on channel_dna + episodes, provider_events table
 *
 * Migration 006 additions:
 *   - Migration 006_channel_dna_v2 wired in
 *     Full pipeline-awareness columns on channel_dna
 *   - listEpisodes query updated to LEFT JOIN channel_dna
 *     returning ui_theme_color + blueprint_label per episode
 */

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const sqlite3 = require('sqlite3').verbose();

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

// ─── Migration runner ─────────────────────────────────────────────────────────
// Called from server.js immediately after initSchema().
// Idempotent: tracks applied migrations in schema_migrations table.
// Each migration is checked independently — no early return.
// Safe to call on every boot.

async function runMigrations() {
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
  } else {
    console.log('[migrations] Applying 001_sprint1a...');

    const sqlPath = path.join(__dirname, 'migrations', '001_sprint1a.sql');
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`[migrations] Migration file not found: ${sqlPath}`);
    }
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await exec(sql);

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

    await run(`INSERT INTO schema_migrations (id) VALUES ('001_sprint1a')`);
    console.log('[migrations] 001_sprint1a complete');

    const { seedSprint1A } = require('./data/seed-sprint1a');
    await seedSprint1A(db);
  }

  // ── Migration 004_review_foundation ───────────────────────────────────────
  // Sprint 2A: creates revisions and act_versions tables.
  // Iteration 0 strategy: LAZY — act_versions populated by Sprint 2B dispatcher.
  const m004 = await get(`SELECT id FROM schema_migrations WHERE id = '004_review_foundation'`);
  if (m004) {
    console.log('[migrations] 004_review_foundation already applied — skipping');
  } else {
    console.log('[migrations] Applying 004_review_foundation...');
    const { up } = require('./migrations/004_review_foundation');
    await up({ run, all });
    await run(`INSERT INTO schema_migrations (id) VALUES ('004_review_foundation')`);
    console.log('[migrations] 004_review_foundation complete');
  }

  // ── Migration 005_sprint15_phase_a ────────────────────────────────────────
  // Sprint 1.5 Phase A: provider columns on channel_dna + episodes,
  // provider_events table.
  const m005 = await get(`SELECT id FROM schema_migrations WHERE id = '005_sprint15_phase_a'`);
  if (m005) {
    console.log('[migrations] 005_sprint15_phase_a already applied — skipping');
  } else {
    console.log('[migrations] Applying 005_sprint15_phase_a...');
    const { up: up005 } = require('./migrations/005_sprint15_phase_a');
    await up005({ run, all });
    await run(`INSERT INTO schema_migrations (id) VALUES ('005_sprint15_phase_a')`);
    console.log('[migrations] 005_sprint15_phase_a complete');
  }

  // ── Migration 006_channel_dna_v2 ──────────────────────────────────────────
  // Channel DNA v2: full pipeline-awareness columns + seed all 5 channels.
  const m006 = await get(`SELECT id FROM schema_migrations WHERE id = '006_channel_dna_v2'`);
  if (m006) {
    console.log('[migrations] 006_channel_dna_v2 already applied — skipping');
  } else {
    console.log('[migrations] Applying 006_channel_dna_v2...');
    const { up: up006 } = require('./migrations/006_channel_dna_v2');
    await up006({ run, all });
    const { seedChannelDnaV2 } = require('./data/seed-006-channel-dna-v2');
    await seedChannelDnaV2(run, all);
    await run(`INSERT INTO schema_migrations (id) VALUES ('006_channel_dna_v2')`);
    console.log('[migrations] 006_channel_dna_v2 complete');
  }

  // ── Migration 007_macro_decode_rename ─────────────────────────────────────
  // Renames the "Money Explained" channel_dna row to Macro Decode and
  // populates its creative DNA per macro-decode-channel-dna-v2.md.
  const m007 = await get(`SELECT id FROM schema_migrations WHERE id = '007_macro_decode_rename'`);
  if (m007) {
    console.log('[migrations] 007_macro_decode_rename already applied — skipping');
  } else {
    console.log('[migrations] Applying 007_macro_decode_rename...');
    const { up: up007 } = require('./migrations/007_macro_decode_rename');
    await up007({ run, get });
    await run(`INSERT INTO schema_migrations (id) VALUES ('007_macro_decode_rename')`);
    console.log('[migrations] 007_macro_decode_rename complete');
  }

  // ── Migration 008_macro_decode_default_blueprint ──────────────────────────
  // Corrects Macro Decode's default_blueprint_id from the generic
  // 'documentary' to 'finance_explainer' (already an allowed blueprint
  // for this channel, just never set as the default).
  const m008 = await get(`SELECT id FROM schema_migrations WHERE id = '008_macro_decode_default_blueprint'`);
  if (m008) {
    console.log('[migrations] 008_macro_decode_default_blueprint already applied — skipping');
  } else {
    console.log('[migrations] Applying 008_macro_decode_default_blueprint...');
    const { up: up008 } = require('./migrations/008_macro_decode_default_blueprint');
    await up008({ run, get });
    await run(`INSERT INTO schema_migrations (id) VALUES ('008_macro_decode_default_blueprint')`);
    console.log('[migrations] 008_macro_decode_default_blueprint complete');
  }
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

  createEpisode: (id, userId, channel, episodeId, topic) =>
    run(
      `INSERT INTO episodes (id, user_id, channel, episode_id, topic, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
      [id, userId, channel, episodeId, topic]
    ),

  createEpisodeV2: (id, userId, channel, episodeId, topic, blueprintId) =>
    run(
      `INSERT INTO episodes (id, user_id, channel, episode_id, topic, status, blueprint_id, content_mode)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, 'ai_generated')`,
      [id, userId, channel, episodeId, topic, blueprintId || 'documentary']
    ),

  getEpisode: (id) =>
    get(`SELECT * FROM episodes WHERE id = ?`, [id]),

  listEpisodes: (userId) =>
    all(`
      SELECT
        e.*,
        c.ui_theme_color,
        c.blueprint_label,
        c.channel_id      AS dna_channel_id,
        c.slug            AS channel_slug,
        c.active          AS channel_active
      FROM episodes e
      LEFT JOIN channel_dna c ON e.channel = c.label
      WHERE e.user_id = ?
      ORDER BY e.created_at DESC
    `, [userId]),

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

  getBlueprint: (id) =>
    get(`SELECT * FROM blueprints WHERE id = ?`, [id]),

  listBlueprints: () =>
    all(`SELECT * FROM blueprints ORDER BY is_custom ASC, label ASC`),

  // ── Channel DNA (Sprint 1A) ────────────────────────────────────────────────

  getChannelDna: (id) =>
    get(`SELECT * FROM channel_dna WHERE id = ?`, [id]),

  listChannelDna: () =>
    all(`SELECT * FROM channel_dna ORDER BY label ASC`),

  // expose db for routes that need raw access (Sprint 2A revisions)
  db,
};

module.exports = { db, queries, run, get, all, exec, initSchema, runMigrations };
