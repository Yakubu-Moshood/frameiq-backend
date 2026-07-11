'use strict';

/**
 * jobs/revision-dispatcher.js
 * Revision dispatcher -- Sprint 2B
 *
 * Reads a single queued `revisions` row for one act, regenerates exactly
 * the assets that revision asks for, and marks it running -> complete/failed.
 * Does NOT re-render the episode itself -- per this pass's explicit design
 * decision, this module only prepares assets; the creator (or a future
 * automated step) triggers the actual re-render via the existing
 * POST /:id/retry endpoint once the revision shows 'complete'. Retry
 * already resumes correctly from whatever's on disk (see jobs/runner.js's
 * own header comment on per-stage idempotency), so nothing here duplicates
 * that logic -- it only makes sure the right files are missing/updated
 * before Retry runs.
 *
 * Design decisions made after investigation, confirmed with the user:
 *   - Multiple queued revisions on the same (episode, act): applied ONE AT
 *     A TIME, oldest queued first. applyRevision() enforces this
 *     server-side -- attempting to apply anything but the oldest queued
 *     revision for that act returns 409 naming the correct id.
 *   - revision_type coverage this pass: image, anim, voice, full_act, AND
 *     script (all five) -- script is the newest, riskiest piece; see
 *     applyScriptRevision()'s comment for exactly what it does and does
 *     NOT cascade into.
 *   - Re-render trigger: NOT automatic. This module's job ends once assets
 *     are regenerated and the revision is marked complete/failed. Hitting
 *     Retry is a separate, explicit, already-existing action.
 *
 * Where results are written:
 *   - The regenerated files themselves REPLACE the originals in place, at
 *     the same fixed paths every other pipeline module already expects
 *     (assets/stills/<shotId>.png, assets/audio/VO_ActN.mp3,
 *     assets/clips/<shotId>.mp4). act_versions (migration 004, previously
 *     unused) is NOT used as the pipeline's live asset source -- every
 *     consuming module (renderSegments, buildActVideos, resolveAssetPath,
 *     the 0D/0E existence checks in jobs/runner.js) assumes exactly one
 *     current file per fixed path, with no iteration-awareness anywhere.
 *     Making the whole render pipeline iteration-aware is a much larger,
 *     separate change. Instead, act_versions is used as an audit/history
 *     log: one row per successfully-applied revision, iteration = previous
 *     max + 1 for that (episode, act), asset_path = a human-readable
 *     summary of what was touched, revision_id = the revision that caused
 *     it, approved = 0 (it hasn't been through the approval gate yet).
 *     This matches migration 004's own stated intent ("iteration 1+ =
 *     revisions produced by Sprint 2B regeneration jobs") without taking on
 *     a full versioned-asset-storage rewrite.
 *
 * Known, deliberately NOT auto-cascaded gap: 'script' revisions rewrite
 * only that act's narration text and regenerate its voiceover -- they do
 * NOT regenerate that act's shot-definitions (image/animation prompts,
 * trigger words). surface-shot-definitions.cjs is a single whole-episode
 * generator call with no per-act mode (confirmed by reading its real
 * source this session), so rebuilding it wholesale risks reshuffling every
 * OTHER already-approved act's shots too. See applyScriptRevision()'s
 * comment for the full reasoning.
 *
 * Known, pre-existing (not introduced by this file) limitation inherited
 * as-is: revisions.act is a plain integer 1-5 (routes/revisions.js's
 * VALID_ACTS), but the render pipeline has SIX independent act segments
 * (act1, act2, act3, act3b, act4, act5 -- see surface-renderer.cjs's
 * ACT_KEYS). EpisodePage.jsx (frontend) already documents that a note left
 * during the act3b approval gate gets tagged "Act 3". This dispatcher
 * inherits that same collapse: actKeyFor(3) always resolves to 'act3',
 * never 'act3b'.
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const Anthropic     = require('@anthropic-ai/sdk');

const { queries, run, get }          = require('../db');
const { PIPELINE_DIR, EPISODES_DIR } = require('../startup-init');
const sse                            = require('../sse');

// Lazily required to avoid a require-cycle: jobs/runner.js does not require
// this file, so requiring it here is safe, but done inline in
// applyRevision() rather than at module load time to keep this file
// loadable (e.g. for unit tests) without pulling in the entire runner.
function getRunner() { return require('./runner'); }

class DispatchError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// In-memory guard against two concurrent dispatch calls for the same
// episode racing each other (e.g. a double-click on "Apply"). Mirrors the
// activeEpisodes Set jobs/runner.js already uses for full pipeline runs --
// same reasoning, smaller scope.
const dispatching = new Set();

// ── Act-key helpers ───────────────────────────────────────────────────────────

function actKeyFor(actNumber) {
  return `act${actNumber}`;
}

function voFilenameFor(actKey) {
  const upper = actKey.charAt(0).toUpperCase() + actKey.slice(1);
  return `VO_${upper}.mp3`.replace('Act3b', 'Act3B');
}

function shotsForAct(shotDefs, actKey) {
  return (shotDefs.allShots || []).filter(s => s.actKey === actKey);
}

function loadShotDefs(episodeDir) {
  const p = path.join(episodeDir, 'shot-definitions.json');
  if (!fs.existsSync(p)) throw new Error(`shot-definitions.json not found at ${p}`);
  return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

function loadScript(episodeDir) {
  const p = path.join(episodeDir, 'script.json');
  if (!fs.existsSync(p)) throw new Error(`script.json not found at ${p}`);
  return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

// Same clearing the reject-flow in surface-renderer.cjs's buildActVideos()
// already does on a rejected act (act_<key>.mp4 + temp/VO_<Key>/), applied
// here after ANY revision type so the next Retry rebuilds this act fresh
// instead of skipping it (buildActVideos skips any act whose output file
// already exists).
function clearActBuildArtifacts(episodeDir, actKey) {
  const voKey     = voFilenameFor(actKey).replace('.mp3', '');
  const actOutput = path.join(episodeDir, 'output', `act_${actKey}.mp4`);
  const tempDir   = path.join(episodeDir, 'temp', voKey);
  try { fs.rmSync(actOutput, { force: true }); } catch (_) {}
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function claimRevision(episodeId, revId) {
  const revision = await get(`SELECT * FROM revisions WHERE id = ? AND episode_id = ?`, [revId, episodeId]);
  if (!revision) throw new DispatchError(404, 'Revision not found');
  if (revision.status !== 'queued') {
    throw new DispatchError(400, `Cannot apply revision with status '${revision.status}' -- only 'queued' revisions can be applied`);
  }

  const oldest = await get(
    `SELECT id FROM revisions WHERE episode_id = ? AND act = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    [episodeId, revision.act]
  );
  if (oldest && oldest.id !== revId) {
    throw new DispatchError(409, `Apply the oldest queued revision for Act ${revision.act} first: ${oldest.id}`);
  }

  const now = new Date().toISOString();
  const claim = await run(
    `UPDATE revisions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'`,
    [now, revId]
  );
  if (claim.changes !== 1) {
    throw new DispatchError(409, 'This revision was just claimed by another request -- refresh and try again');
  }

  return { ...revision, status: 'running', updated_at: now };
}

async function finishRevision(revId, status, resultDetail) {
  const now = new Date().toISOString();
  await run(
    `UPDATE revisions SET status = ?, result_detail = ?, updated_at = ? WHERE id = ?`,
    [status, resultDetail, now, revId]
  );
}

async function recordActVersion({ episodeId, act, revisionId, assetSummary }) {
  const row = await get(
    `SELECT MAX(iteration) as maxIter FROM act_versions WHERE episode_id = ? AND act = ?`,
    [episodeId, act]
  );
  const nextIteration = (row && row.maxIter != null ? row.maxIter : 0) + 1;
  await run(
    `INSERT INTO act_versions (id, episode_id, act, iteration, asset_path, revision_id, approved)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [uuid(), episodeId, act, nextIteration, assetSummary, revisionId]
  );
}

// ── Per-type asset regeneration ────────────────────────────────────────────────

async function applyImageRevision({ episodeDir, episode, revision, actKey }) {
  const { path: shotDefsPath, data: shotDefs } = loadShotDefs(episodeDir);
  const shots = shotsForAct(shotDefs, actKey);
  if (shots.length === 0) throw new Error(`No shots found for ${actKey} in shot-definitions.json`);

  const stillsDir = path.join(episodeDir, 'assets', 'stills');
  const clipsDir  = path.join(episodeDir, 'assets', 'clips');

  const touched = [];
  for (const shot of shots) {
    try { fs.rmSync(path.join(stillsDir, `${shot.shotId}.png`), { force: true }); } catch (_) {}
    if (shot.visualType === 'CLIP') {
      // CLIP shots animate FROM the still image -- once it's stale, the
      // clip built from it is stale too. Delete it so Step 0E regenerates.
      try { fs.rmSync(path.join(clipsDir, `${shot.shotId}.mp4`), { force: true }); } catch (_) {}
    }
    // shotDefs.allShots and shotDefs.acts[actKey] share the same object
    // references (surface-shot-definitions.cjs builds allShots by pushing
    // each act array's own shot objects, not copies) -- mutating here is
    // visible from both views once written back to disk below.
    shot.imagePrompt = `${shot.imagePrompt}\n\nAdditional guidance from creator revision note: ${revision.comment}`;
    touched.push(shot.shotId);
  }
  fs.writeFileSync(shotDefsPath, JSON.stringify(shotDefs, null, 2), 'utf8');

  const prompts = shots.map(s => ({ shotId: s.shotId, filename: `${s.shotId}.png`, prompt: s.imagePrompt }));
  const promptsPath = path.join(stillsDir, `revision-prompts-${revision.id}.json`);
  fs.writeFileSync(promptsPath, JSON.stringify(prompts, null, 2), 'utf8');

  const { generateImages } = require(path.join(PIPELINE_DIR, 'surface-image-generator.cjs'));
  await generateImages({
    promptsFile: promptsPath, outputDir: stillsDir,
    channel: episode.channel, episodeId: episode.id,
  });

  return `Regenerated ${touched.length} image(s) for Act ${revision.act}: ${touched.join(', ')}`;
}

async function applyAnimRevision({ episodeDir, episode, revision, actKey }) {
  const { path: shotDefsPath, data: shotDefs } = loadShotDefs(episodeDir);
  const shots = shotsForAct(shotDefs, actKey).filter(s => s.visualType === 'CLIP');
  if (shots.length === 0) {
    throw new Error(`No CLIP-type shots found for ${actKey} -- 'anim' revisions only apply to shots animated via fal.ai Kling/SVD, not static images`);
  }

  const clipsDir = path.join(episodeDir, 'assets', 'clips');
  const touched = [];
  for (const shot of shots) {
    try { fs.rmSync(path.join(clipsDir, `${shot.shotId}.mp4`), { force: true }); } catch (_) {}
    shot.animationPrompt = `${shot.animationPrompt || ''}\n\nAdditional guidance from creator revision note: ${revision.comment}`;
    touched.push(shot.shotId);
  }
  fs.writeFileSync(shotDefsPath, JSON.stringify(shotDefs, null, 2), 'utf8');

  const { animateClips } = require(path.join(PIPELINE_DIR, 'surface-animator.cjs'));
  await animateClips({ shotDefs, episodeDir, channel: episode.channel, episodeId: episode.id });

  return `Regenerated ${touched.length} animated clip(s) for Act ${revision.act}: ${touched.join(', ')}`;
}

async function applyVoiceRevision({ episodeDir, episode, revision, actKey }) {
  const voFilename = voFilenameFor(actKey);
  const voPath      = path.join(episodeDir, 'assets', 'audio', voFilename);
  const { data: script } = loadScript(episodeDir);

  if (!script.acts || !script.acts[actKey]) {
    throw new Error(`No script.acts.${actKey} found in script.json`);
  }

  // 'voice' revisions re-record the SAME words -- if the words themselves
  // need to change, that's revision_type 'script' (a materially different,
  // larger change; see applyScriptRevision()). Neither ElevenLabs nor
  // OpenAI TTS's APIs (voice-router.cjs's two current tiers) accept a
  // "delivery note" -- the revision comment is preserved on the revision
  // row / act_versions for a human to read, but there is no lever to feed
  // it into the TTS call itself. Flagged rather than silently ignored.
  try { fs.rmSync(voPath, { force: true }); } catch (_) {}

  // word-timestamps.json covers ALL SIX acts in one file (see
  // surface-renderer.cjs's runWhisper(), which skips transcription
  // entirely if this single file already exists). Regenerating only this
  // act's VO file without also invalidating word-timestamps.json would
  // leave stale per-word timing for the revised act mixed with fresh
  // timing for the other five -- deleting it forces a full
  // re-transcription on the next render, the only safe option given this
  // file's whole-episode (not per-act) grain. The other five acts' audio
  // is unchanged, so re-transcribing them should return materially the
  // same words/timings -- a real but minor cost (5 unnecessary Whisper
  // calls on the next Retry), not a correctness risk.
  try { fs.rmSync(path.join(episodeDir, 'word-timestamps.json'), { force: true }); } catch (_) {}

  // ASSUMPTION, flagged explicitly (see this change's commit message):
  // surface-vo-generator.cjs's real source is Railway-volume-only and was
  // never read this session (no write-vo-generator.js exists to
  // reconstruct it from, unlike surface-script-writer.cjs). jobs/runner.js
  // only ever calls generateVO() when ALL 6 VO files are missing (a fresh
  // episode) -- this is the first caller to exercise "1 of 6 missing"
  // specifically. If generateVO() isn't internally idempotent per-file,
  // this call could regenerate all 6 VO files instead of just this act's
  // (added cost; the other 5 acts' script text is unchanged so their new
  // audio should still match their already-approved content).
  const { generateVO } = require(path.join(PIPELINE_DIR, 'surface-vo-generator.cjs'));
  await generateVO({
    script, outputDir: path.join(episodeDir, 'assets', 'audio'),
    channel: episode.channel, episodeId: episode.id,
  });

  return `Regenerated voiceover for Act ${revision.act} (${voFilename}) and cleared word-timestamps.json for re-transcription`;
}

async function rewriteActNarration({ script, actKey, comment }) {
  const client    = new Anthropic();
  const actScript = script.acts[actKey];

  const otherActsContext = Object.entries(script.acts)
    .filter(([k]) => k !== actKey)
    .map(([k, a]) => `${k.toUpperCase()} (${a.label}): ${(a.voScript || '').slice(0, 300)}...`)
    .join('\n\n');

  const systemPrompt =
    'You are revising ONE act of an existing documentary-style YouTube script. ' +
    "Rewrite ONLY the requested act's narration (voScript) based on the creator's note below. " +
    'Keep the same act label, roughly the same length/pacing as the original, and match the ' +
    'tone/continuity of the surrounding acts (shown for context only -- do not rewrite them). ' +
    'Return ONLY the new voScript text for this act. No JSON, no markdown fences, no preamble, ' +
    'no act label -- just the narration text itself.';

  const userPrompt =
    `SURROUNDING ACTS (context only, do not rewrite):\n${otherActsContext}\n\n` +
    `ACT TO REWRITE: ${actKey.toUpperCase()} (${actScript.label})\n` +
    `CURRENT NARRATION:\n${actScript.voScript}\n\n` +
    `CREATOR'S REVISION NOTE:\n${comment}\n\n` +
    "Rewrite this act's narration to address the note above.";

  const message = await client.messages.create({
    model:      'claude-opus-4-5',
    max_tokens: 4000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!text) throw new Error('Claude returned an empty rewrite');
  return text;
}

async function applyScriptRevision({ episodeDir, episode, revision, actKey }) {
  const { path: scriptPath, data: script } = loadScript(episodeDir);
  if (!script.acts || !script.acts[actKey]) {
    throw new Error(`No script.acts.${actKey} found in script.json`);
  }

  const newVoScript = await rewriteActNarration({ script, actKey, comment: revision.comment });
  const oldLength = script.acts[actKey].voScript.length;
  script.acts[actKey].voScript = newVoScript;
  fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2), 'utf8');

  // Cascade: the recorded VO no longer matches the new words, so it (and
  // the whole-episode word-timestamps.json -- see applyVoiceRevision's
  // comment) must be regenerated too. Re-load script.json inside
  // applyVoiceRevision isn't necessary since we already have the patched
  // object in memory; reuse it directly.
  const voiceSummary = await applyVoiceRevision({
    episodeDir, episode, revision: { ...revision }, actKey,
  });

  // Deliberately NOT auto-cascaded, flagged plainly rather than silently
  // skipped: shot-definitions.json's per-shot triggerWord/imagePrompt
  // fields for this act were written against the OLD narration text.
  // surface-shot-definitions.cjs is a single whole-episode generator call
  // with no per-act mode (confirmed by reading its real source this
  // session, reconstructed from write-script-writer.js's embedded content
  // the same way -- both generators share this whole-episode-only shape).
  // Rebuilding shot-definitions.json wholesale risks reshuffling shot
  // IDs/prompts for the OTHER, already-approved acts too, which is worse
  // than leaving this act's shots referencing slightly-stale wording.
  // surface-renderer.cjs's own autoFixTriggerWords() step will still try
  // to re-match each shot's triggerWord against the new transcript on the
  // next render and fall back to the nearest available word if the exact
  // one is gone -- imperfect, but safe (shots won't crash, they may just
  // land slightly off from the ideal cue point). A true fix (an act-scoped
  // shot-definition regenerator) is real follow-up work, not built here.
  return (
    `Rewrote Act ${revision.act}'s narration (${oldLength} -> ${newVoScript.length} chars). ${voiceSummary}. ` +
    `NOTE: shot definitions/images for this act were NOT automatically regenerated to match the new wording -- ` +
    `surface-renderer.cjs's trigger-word auto-fix will best-effort re-align on the next render, but a full shot ` +
    `re-sync for a script-only revision is not yet implemented.`
  );
}

async function applyFullActRevision({ episodeDir, episode, revision, actKey }) {
  const parts = [];
  parts.push(await applyVoiceRevision({ episodeDir, episode, revision, actKey }));
  parts.push(await applyImageRevision({ episodeDir, episode, revision, actKey }));
  try {
    parts.push(await applyAnimRevision({ episodeDir, episode, revision, actKey }));
  } catch (err) {
    // Benign/expected when the act has no CLIP-type shots at all (some
    // acts are entirely STILL_ZOOM) -- not a real failure of the revision,
    // so it doesn't propagate and fail the whole dispatch.
    parts.push(`Animation: skipped (${err.message})`);
  }
  return `Full-act revision for Act ${revision.act}:\n- ${parts.join('\n- ')}`;
}

// ── Main entry point ────────────────────────────────────────────────────────────

async function applyRevision(episodeDbId, revId) {
  const episode = await queries.getEpisode(episodeDbId);
  if (!episode) throw new DispatchError(404, 'Episode not found');

  const runner = getRunner();
  if (runner.isRunning(episodeDbId)) {
    throw new DispatchError(409, 'Episode pipeline is currently running -- wait for it to finish or pause first');
  }
  if (dispatching.has(episodeDbId)) {
    throw new DispatchError(409, 'A revision is already being applied for this episode');
  }

  const revision = await claimRevision(episodeDbId, revId);
  dispatching.add(episodeDbId);

  // Fire-and-forget: mirrors startJob()'s own pattern in jobs/runner.js so
  // the HTTP request returns immediately. Asset regeneration can take
  // anywhere from ~10s (one image) to well over a minute (clip animation,
  // or voice + a full 6-file Whisper re-transcription) -- too long/
  // variable to hold an HTTP connection open reliably, and every other
  // long-running operation in this app already uses this same
  // fire-and-forget + poll/SSE pattern (see startJob() itself).
  doApply(episode, revision)
    .catch(err => console.error(`[revision-dispatcher] Unhandled error for revision ${revId}:`, err.message))
    .finally(() => dispatching.delete(episodeDbId));

  return revision; // status: 'running'
}

async function doApply(episode, revision) {
  const episodeDbId = episode.id;
  const episodeDir  = path.join(EPISODES_DIR, `${episode.channel}_${episode.episode_id}`);
  const actKey       = actKeyFor(revision.act);

  try {
    getRunner().syncPipelineUpdates();

    let summary;
    switch (revision.revision_type) {
      case 'image':    summary = await applyImageRevision({ episodeDir, episode, revision, actKey }); break;
      case 'anim':     summary = await applyAnimRevision({ episodeDir, episode, revision, actKey }); break;
      case 'voice':    summary = await applyVoiceRevision({ episodeDir, episode, revision, actKey }); break;
      case 'full_act': summary = await applyFullActRevision({ episodeDir, episode, revision, actKey }); break;
      case 'script':   summary = await applyScriptRevision({ episodeDir, episode, revision, actKey }); break;
      default: throw new Error(`Unknown revision_type '${revision.revision_type}'`);
    }

    clearActBuildArtifacts(episodeDir, actKey);
    await recordActVersion({
      episodeId: episodeDbId, act: revision.act, revisionId: revision.id,
      assetSummary: summary,
    });
    await finishRevision(revision.id, 'complete', summary);

    sse.emit(episodeDbId, {
      step: 'revision', status: 'complete', progress: null,
      detail: summary, revisionId: revision.id, act: revision.act,
    });
    console.log(`[revision-dispatcher] Revision ${revision.id} complete: ${summary}`);
  } catch (err) {
    console.error(`[revision-dispatcher] Revision ${revision.id} failed:`, err.message);
    await finishRevision(revision.id, 'failed', err.message).catch(() => {});
    sse.emit(episodeDbId, {
      step: 'revision', status: 'failed', progress: null,
      detail: err.message, revisionId: revision.id, act: revision.act,
    });
  }
}

module.exports = { applyRevision, DispatchError };
