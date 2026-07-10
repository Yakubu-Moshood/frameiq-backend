/**
 * jobs/recovery.js
 * Frameiq — Boot-time orphaned-episode recovery
 *
 * Implements job-queue-resilience-spec.md section 3.4, reconciled against
 * the actual runner architecture:
 *
 * The spec's pseudocode thresholds on last_heartbeat_at staleness to
 * distinguish "still working, just slow" from "process died." That
 * distinction matters for a multi-worker pool where some workers are
 * alive and others aren't. This app has exactly one worker (the single
 * server.js process) and activeEpisodes (jobs/runner.js's in-memory set)
 * is unconditionally empty the instant this module runs at boot — nothing
 * is running yet, by construction. So every episode found in 'running' or
 * 'awaiting_approval' at boot is orphaned, full stop; no staleness window
 * is needed to tell them apart from a live job.
 *
 * Recovery action deliberately mirrors, rather than reimplements, the
 * existing POST /:id/retry and PATCH /:id/cancel logic already proven in
 * routes/episodes.js:
 *   - retry_count < MAX_RETRIES  -> reset non-complete jobs to pending,
 *     increment retry_count, call startJob() again. Per the resilience
 *     spec's design (section 3.4/3.5) this is safe to call blindly: every
 *     paid-API stage (0A-0E) already skips regeneration via existing
 *     fs.existsSync() checks, and Step 1 (render) independently skips
 *     already-rendered segments/acts (surface-renderer.cjs) and an
 *     already-transcribed Whisper pass. A "retry" is therefore a resume
 *     from whatever's already on disk, not a from-scratch redo.
 *   - retry_count >= MAX_RETRIES -> mark the episode (and its non-terminal
 *     jobs) failed, same shape as the existing /cancel endpoint, with a
 *     detail string that distinguishes this from a manual cancel.
 *
 * Called once from server.js, after runMigrations() and before the server
 * starts accepting new episode-creation requests.
 */

const { v4: uuid } = require('uuid');
const { queries } = require('../db');
const { startJob, isRunning } = require('./runner');

const MAX_RETRIES = 2; // per spec Thread C

const STEPS = [
  '0A_script', '0B_vo', '0C_shots', '0D_images', '0E_anim', '1_render', '7_short', '8_qa',
];

async function recoverOrphanedEpisodes() {
  let orphans;
  try {
    orphans = await queries.getOrphanedEpisodes();
  } catch (e) {
    console.error('[recovery] Failed to query orphaned episodes — skipping recovery scan:', e.message);
    return { recovered: 0, failed: 0, skipped: 0 };
  }

  if (!orphans.length) {
    console.log('[recovery] No orphaned episodes found at boot');
    return { recovered: 0, failed: 0, skipped: 0 };
  }

  console.log(`[recovery] Found ${orphans.length} orphaned episode(s) at boot: ${orphans.map(e => e.id).join(', ')}`);

  let recovered = 0, failed = 0, skipped = 0;

  for (const episode of orphans) {
    try {
      // Guard against a boot-order race: if something has already picked
      // this episode up (shouldn't happen this early, but cheap to check).
      if (isRunning(episode.id)) {
        console.log(`[recovery] ${episode.id} already running — skipping`);
        skipped++;
        continue;
      }

      const retryCount = episode.retry_count || 0;

      if (retryCount >= MAX_RETRIES) {
        await failEpisode(episode);
        console.warn(`[recovery] ${episode.id} exceeded MAX_RETRIES (${MAX_RETRIES}) — marked failed, needs manual review`);
        failed++;
        continue;
      }

      await requeueEpisode(episode);
      console.log(`[recovery] ${episode.id} requeued (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      recovered++;
    } catch (e) {
      console.error(`[recovery] Error recovering episode ${episode.id}:`, e.message);
      failed++;
    }
  }

  console.log(`[recovery] Boot recovery complete: ${recovered} requeued, ${failed} marked failed, ${skipped} skipped`);
  return { recovered, failed, skipped };
}

// Mirrors POST /:id/retry in routes/episodes.js.
async function requeueEpisode(episode) {
  const existingJobs = await queries.getJobsForEpisode(episode.id);
  const existingKeys = new Set(existingJobs.map(j => j.step));
  for (const step of STEPS) {
    if (!existingKeys.has(step)) {
      await queries.createJob(uuid(), episode.id, step);
    }
  }

  const jobs = await queries.getJobsForEpisode(episode.id);
  for (const job of jobs) {
    if (job.status !== 'complete') {
      await queries.updateJob(job.id, { status: 'pending', progress: 0, detail: null, started_at: null, finished_at: null });
    }
  }

  await queries.incrementEpisodeRetryCount(episode.id);
  await queries.updateEpisodeStatus('queued', episode.id);
  startJob(episode.id, episode.channel, episode.episode_id, episode.topic);
}

// Mirrors PATCH /:id/cancel in routes/episodes.js, with a detail string
// that identifies this as an automated exhausted-retry failure rather
// than a manual cancel.
async function failEpisode(episode) {
  await queries.updateEpisodeStatus('failed', episode.id);

  const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
  const jobs = await queries.getJobsForEpisode(episode.id);
  for (const job of jobs) {
    if (!TERMINAL.has(job.status)) {
      await queries.updateJob(job.id, {
        status:      'failed',
        progress:    job.progress,
        detail:      'exceeded_retry_limit_after_orphan',
        finished_at: new Date().toISOString(),
      });
    }
  }
}

module.exports = { recoverOrphanedEpisodes, MAX_RETRIES };
