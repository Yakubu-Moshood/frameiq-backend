'use strict';

/**
 * providers/provider-router.cjs
 * Generalized provider-fallback router for images and animation.
 *
 * This is voice-router.cjs's circuit-breaker/retry/provider_events/locking
 * pattern, generalized so image and animation providers can share one
 * mechanism instead of each having none at all (confirmed during
 * investigation: write-image-generator.js and write-animator.js each had a
 * single-shot try/catch with no fallback whatsoever, despite channel_dna
 * already having image_primary/secondary/tertiary and
 * video_primary/secondary/tertiary columns sitting unused since migration
 * 005). The circuit breaker, retry-before-failover, and provider_events
 * logging logic below is carried over from the real voice-router.cjs
 * essentially unchanged -- only generalized to not assume voice's specific
 * {text, voiceId, voiceParams, outputPath} shape.
 *
 * Provider modules here export generate(input, providerConfig) where
 * `input` is passed through untouched (the router doesn't know or care
 * what's inside it -- images and animation each define their own shape)
 * and `providerConfig` carries whatever per-provider config the caller
 * resolved from channel_dna. Same success/failure contract voice's
 * providers use:
 *   success: { success: true, path, durationMs, provider, ...extra }
 *   failure: { success: false, statusCode, error }
 *
 * createRouter({ step, providers, estimateCost }) returns one router
 * instance per step ('image' or 'video'), each with its own isolated
 * circuit-breaker state and episode-provider-lock map -- a failing image
 * provider's circuit does not affect animation's, matching how
 * voice-router.cjs gets that isolation implicitly by being its own module.
 *
 * Episode-level provider locking is carried over from voice for the same
 * reason it exists there: switching providers mid-episode is visually
 * jarring for images/animation (different models render in different
 * styles) just as it would sound jarring for voice, so once a provider
 * succeeds for an episode's first shot, every subsequent shot in that
 * episode prefers the same provider first.
 */

const { v4: uuid } = require('uuid');

const DB_MODULE_PATH = process.env.DB_MODULE_PATH || '/app/db';
const { run } = require(DB_MODULE_PATH);

// ── Retry logic (identical to voice-router.cjs) ───────────────────────────────
const CIRCUIT_OPEN_THRESHOLD = 3;
const CIRCUIT_OPEN_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const CIRCUIT_WINDOW_MS = 10 * 60 * 1000;        // 10 minutes

function shouldRetry(statusCode) {
  return statusCode === 429 || statusCode === 500 || statusCode === 503 || statusCode === 0;
}
function retryDelay(statusCode) {
  if (statusCode === 429) return 30000;
  if (statusCode === 500 || statusCode === 503) return 10000;
  return 5000;
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── DB logging helpers ─────────────────────────────────────────────────────────
async function logProviderEvent({ episodeId, step, act, shotId, provider, tier, success, error, durationMs, costEstimate }) {
  try {
    await run(`
      INSERT INTO provider_events (id, episode_id, step, act, shot_id, provider, tier, success, error_message, duration_ms, cost_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uuid(), episodeId, step, act != null ? act : null, shotId != null ? shotId : null, provider, tier,
      success ? 1 : 0, error || null, durationMs || null, costEstimate || null,
    ]);
  } catch (err) {
    console.error(`[provider-router:${step}] provider_events log failed:`, err.message);
  }
}

// Generalizes voice-router.cjs's updateEpisodeProviderFields -- the target
// column is derived from step ('image' -> image_provider_used, 'video' ->
// video_provider_used), matching the episodes columns migration 005 already
// added specifically for this (previously unused -- see investigation
// report on the images/animation provider-fallback blind spot).
async function updateEpisodeProviderFields({ episodeId, step, provider, substituted }) {
  const columnMap = { image: 'image_provider_used', video: 'video_provider_used' };
  const column = columnMap[step];
  if (!column) return;
  try {
    await run(`
      UPDATE episodes
      SET ${column} = ?, provider_substituted = ?
      WHERE id = ?
    `, [provider, substituted ? 1 : 0, episodeId]);
  } catch (err) {
    console.error(`[provider-router:${step}] episode provider field update failed:`, err.message);
  }
}

function createRouter({ step, providers, estimateCost }) {
  const circuitBreaker = {};
  const episodeLocks = {};

  function getCircuit(provider) {
    if (!circuitBreaker[provider]) {
      circuitBreaker[provider] = { failures: [], openUntil: null };
    }
    return circuitBreaker[provider];
  }
  function isCircuitOpen(provider) {
    const circuit = getCircuit(provider);
    if (circuit.openUntil && Date.now() < circuit.openUntil) {
      console.log(`[provider-router:${step}] Circuit OPEN for ${provider} — skipping until ${new Date(circuit.openUntil).toISOString()}`);
      return true;
    }
    if (circuit.openUntil && Date.now() >= circuit.openUntil) {
      circuit.openUntil = null;
      console.log(`[provider-router:${step}] Circuit HALF-OPEN for ${provider} — testing`);
    }
    return false;
  }
  function recordFailure(provider) {
    const circuit = getCircuit(provider);
    const now = Date.now();
    circuit.failures = circuit.failures.filter(t => now - t < CIRCUIT_WINDOW_MS);
    circuit.failures.push(now);
    if (circuit.failures.length >= CIRCUIT_OPEN_THRESHOLD) {
      circuit.openUntil = now + CIRCUIT_OPEN_DURATION_MS;
      console.log(`[provider-router:${step}] Circuit OPENED for ${provider} after ${circuit.failures.length} failures`);
    }
  }
  function recordSuccess(provider) {
    const circuit = getCircuit(provider);
    circuit.failures = [];
    circuit.openUntil = null;
  }

  async function run_(priorityList, { input, providerConfig, episodeId, act, shotId, costUnits, lockToEpisode = true }) {
    const lockedProvider = lockToEpisode ? episodeLocks[episodeId] : null;
    const effectiveList = lockedProvider
      ? [lockedProvider, ...priorityList.filter(p => p !== lockedProvider)]
      : priorityList;

    if (lockedProvider) {
      console.log(`[provider-router:${step}] Episode ${episodeId} locked to provider: ${lockedProvider}`);
    }

    let lastError = null;
    let tier = 0;
    for (const providerName of effectiveList) {
      tier++;
      if (isCircuitOpen(providerName)) {
        console.log(`[provider-router:${step}] Skipping ${providerName} — circuit open`);
        continue;
      }
      const provider = providers[providerName];
      if (!provider) {
        console.warn(`[provider-router:${step}] Unknown provider: ${providerName} — skipping`);
        continue;
      }
      console.log(`[provider-router:${step}] Attempting ${providerName} (tier ${tier})...`);
      let result = await provider.generate(input, providerConfig);
      if (!result.success && shouldRetry(result.statusCode)) {
        const delay = retryDelay(result.statusCode);
        console.log(`[provider-router:${step}] ${providerName} returned ${result.statusCode} — retrying after ${delay}ms`);
        await sleep(delay);
        result = await provider.generate(input, providerConfig);
      }
      await logProviderEvent({
        episodeId, step, act, shotId,
        provider: providerName, tier,
        success: result.success,
        error: result.success ? null : result.error,
        durationMs: result.durationMs,
        costEstimate: result.success ? estimateCost(providerName, costUnits) : null,
      });
      if (result.success) {
        recordSuccess(providerName);
        const isSubstituted = tier > 1;
        if (lockToEpisode && !episodeLocks[episodeId]) {
          episodeLocks[episodeId] = providerName;
          await updateEpisodeProviderFields({ episodeId, step, provider: providerName, substituted: isSubstituted });
          console.log(`[provider-router:${step}] Episode ${episodeId} locked to ${providerName}${isSubstituted ? ' (SUBSTITUTED)' : ''}`);
        }
        return result;
      }
      recordFailure(providerName);
      lastError = result.error;
      console.warn(`[provider-router:${step}] ${providerName} failed: ${result.error}`);
      if (tier < effectiveList.length) {
        console.log(`[provider-router:${step}] Failing over to next provider...`);
      }
    }
    const errorMsg = `All ${step} providers failed. Last error: ${lastError}`;
    console.error(`[provider-router:${step}] HARD FAIL: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  function clearEpisodeLock(episodeId) { delete episodeLocks[episodeId]; }
  function getEpisodeLock(episodeId) { return episodeLocks[episodeId] || null; }

  return { run: run_, clearEpisodeLock, getEpisodeLock };
}

module.exports = { createRouter };
