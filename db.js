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

  // ── Migration 009_job_queue_resilience ──────────────────────────────────
  // Adds episodes.last_heartbeat_at + episodes.retry_count for orphaned-job
  // detection/recovery. See migrations/009_job_queue_resilience.js for why
  // this targets `episodes` rather than the spec's proposed new `jobs` table.
  const m009 = await get(`SELECT id FROM schema_migrations WHERE id = '009_job_queue_resilience'`);
  if (m009) {
    console.log('[migrations] 009_job_queue_resilience already applied — skipping');
  } else {
    console.log('[migrations] Applying 009_job_queue_resilience...');

    const { up: up009 } = require('./migrations/009_job_queue_resilience');
    await up009({ run, all });
    await run(`INSERT INTO schema_migrations (id) VALUES ('009_job_queue_resilience')`);
    console.log('[migrations] 009_job_queue_resilience complete');
  }

  // ── Migration 010_qa_stage ────────────────────────────────────────────────
  // Adds episodes.qa_status / qa_results / qa_checked_at for the automated
  // post-render QA stage. See migrations/010_qa_stage.js for why this uses
  // a separate qa_status field rather than repurposing episodes.status.
  const m010 = await get(`SELECT id FROM schema_migrations WHERE id = '010_qa_stage'`);
  if (m010) {
    console.log('[migrations] 010_qa_stage already applied — skipping');
  } else {
    console.log('[migrations] Applying 010_qa_stage...');

    const { up: up010 } = require('./migrations/010_qa_stage');
    await up010({ run, all });
    await run(`INSERT INTO schema_migrations (id) VALUES ('010_qa_stage')`);
    console.log('[migrations] 010_qa_stage complete');
  }

  // ── Migration 011_served_cold_channel_row ─────────────────────────────────
  // Inserts the missing base channel_dna row for Served Cold (id=
  // 'ServedCold'). Previously no INSERT existed anywhere for this channel
  // — only an UPDATE-only seed that skips if the row is absent — so a
  // channel_dna lookup for it returned nothing. Part of the BRANDS
  // consolidation fix: this is the concrete "missing channel" case that
  // fix needs to handle correctly. See migrations/011_served_cold_channel_row.js
  // for the known pipeline.config.json caveat (Railway-volume-only file,
  // not fixed by this migration).
  const m011 = await get(`SELECT id FROM schema_migrations WHERE id = '011_served_cold_channel_row'`);
  if (m011) {
    console.log('[migrations] 011_served_cold_channel_row already applied — skipping');
  } else {
    console.log('[migrations] Applying 011_served_cold_channel_row...');

    const { up: up011 } = require('./migrations/011_served_cold_channel_row');
    await up011({ run, get });
    await run(`INSERT INTO schema_migrations (id) VALUES ('011_served_cold_channel_row')`);
    console.log('[migrations] 011_served_cold_channel_row complete');
  }

  // ── Migration 012_voice_tertiary ──────────────────────────────────────────
  // Adds channel_dna.voice_tertiary (defaults to 'coqui_xtts' for every
  // channel) and channel_dna.voice_id_coqui (nullable reference-audio
  // path/URL, not a simple ID) — the third voice-provider tier for
  // voice-router.cjs's failover chain. See migrations/012_voice_tertiary.js.
  const m012 = await get(`SELECT id FROM schema_migrations WHERE id = '012_voice_tertiary'`);
  if (m012) {
    console.log('[migrations] 012_voice_tertiary already applied — skipping');
  } else {
    console.log('[migrations] Applying 012_voice_tertiary...');

    const { up: up012 } = require('./migrations/012_voice_tertiary');
    await up012({ run, all });
    await run(`INSERT INTO schema_migrations (id) VALUES ('012_voice_tertiary')`);
    console.log('[migrations] 012_voice_tertiary complete');
  }

  // ── Migration 013_video_secondary_svd ─────────────────────────────────────
  // Repoints channel_dna.video_secondary from the unimplemented 'wan_2_1'
  // placeholder to 'svd' (Stable Video Diffusion), the real animation
  // fallback tier this change implements. See migrations/013_video_secondary_svd.js.
  const m013 = await get(`SELECT id FROM schema_migrations WHERE id = '013_video_secondary_svd'`);
  if (m013) {
    console.log('[migrations] 013_video_secondary_svd already applied — skipping');
  } else {
    console.log('[migrations] Applying 013_video_secondary_svd...');

    const { up: up013 } = require('./migrations/013_video_secondary_svd');
    await up013({ run, all });
    await run(`INSERT INTO schema_migrations (id) VALUES ('013_video_secondary_svd')`);
    console.log('[migrations] 013_video_secondary_svd complete');
  }

  // ── Migration 014_revision_dispatch_result ────────────────────────────────
  // Adds revisions.result_detail (nullable TEXT) so the frontend can show
  // why a dispatched revision succeeded or failed, not just its status
  // pill. See migrations/014_revision_dispatch_result.js and
  // jobs/revision-dispatcher.js.
  const m014 = await get(`SELECT id FROM schema_migrations WHERE id = '014_revision_dispatch_result'`);
  if (m014) {
    console.log('[migrations] 014_revision_dispatch_result already applied — skipping');
  } else {
    console.log('[migrations] Applying 014_revision_dispatch_result...');

    const { up: up014 } = require('./migrations/014_revision_dispatch_result');
    await up014({ run, all });
    await run(`INSERT INTO schema_migrations (id) VALUES ('014_revision_dispatch_result')`);
    console.log('[migrations] 014_revision_dispatch_result complete');
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
      LEFT JOIN channel_dna c ON e.channel = c.id
      WHERE e.user_id = ?
      ORDER BY e.created_at DESC
    `, [userId]),

  // Suggestions topic-awareness: existing topics for this channel (scoped to
  // the requesting user, same as listEpisodes) so routes/suggestions.js can
  // tell the AI what's already covered and avoid repeats/near-duplicates.
  // Statuses deliberately excluded: 'failed' and 'cancelled' -- neither one
  // actually produced or is producing content, so a good topic that failed
  // for an unrelated technical reason (or was cancelled as a dead episode,
  // see PATCH /:id/cancel) should still be suggestible again. Every other
  // status (complete, queued, running, awaiting_approval, paused) represents
  // a topic that either exists or is actively on its way to existing.
  getChannelTopics: (channel, userId) =>
    all(
      `SELECT topic, status FROM episodes
       WHERE channel = ? AND user_id = ?
         AND status IN ('complete', 'queued', 'running', 'awaiting_approval', 'paused')
       ORDER BY created_at DESC`,
      [channel, userId]
    ),

  updateEpisodeStatus: (status, id) =>
    run(`UPDATE episodes SET status = ?, updated_at = datetime('now') WHERE id = ?`, [status, id]),

  updateEpisodeResult: (status, title, outputPath, durationS, id) =>
    run(
      `UPDATE episodes SET status=?, title=?, output_path=?, duration_s=?, updated_at=datetime('now') WHERE id=?`,
      [status, title, outputPath, durationS, id]
    ),

  // ── Job queue resilience (migration 009) ────────────────────────────────────

  touchEpisodeHeartbeat: (id) =>
    run(`UPDATE episodes SET last_heartbeat_at = datetime('now') WHERE id = ?`, [id]),

  incrementEpisodeRetryCount: (id) =>
    run(`UPDATE episodes SET retry_count = retry_count + 1, updated_at = datetime('now') WHERE id = ?`, [id]),

  resetEpisodeRetryCount: (id) =>
    run(`UPDATE episodes SET retry_count = 0 WHERE id = ?`, [id]),

  // Boot-time orphan scan. Every episode left in 'running' or
  // 'awaiting_approval' at boot is, by definition, orphaned — activeEpisodes
  // (in-memory) is guaranteed empty on a fresh process, so there is no
  // "still working, just slow" case to distinguish here the way the spec's
  // heartbeat-staleness-window design assumes for a multi-worker setup.
  // last_heartbeat_at is still recorded (see jobs/runner.js) so it's
  // available for observability/debugging even though boot-time recovery
  // doesn't need to threshold on it.
  getOrphanedEpisodes: () =>
    all(`SELECT * FROM episodes WHERE status IN ('running', 'awaiting_approval')`),

  // ── QA stage (migration 010) ────────────────────────────────────────────────

  updateEpisodeQAResult: (id, qaStatus, resultsObj) =>
    run(
      `UPDATE episodes SET qa_status = ?, qa_results = ?, qa_checked_at = datetime('now') WHERE id = ?`,
      [qaStatus, JSON.stringify(resultsObj), id]
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
