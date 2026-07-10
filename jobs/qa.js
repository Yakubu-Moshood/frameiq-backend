/**
 * jobs/qa.js
 * Frameiq — Automated post-render QA stage
 *
 * Implements qa-stage-implementation-spec.md sections 4.2-4.4, reconciled
 * against what's actually available in this repo/runtime:
 *
 * - No image-processing npm package (sharp/jimp/pillow) is installed, and
 *   this repo has no network access to safely add one from this sandbox.
 *   Loop detection is implemented with ffmpeg alone: frames are extracted
 *   as tiny (16x16) raw grayscale pixel data directly via ffmpeg's own
 *   filtergraph (`fps=1,scale=16:16,format=gray`, `-f rawvideo`), then
 *   hashed in plain JS (a simple average-hash / aHash: threshold each
 *   frame's 256 pixels against that frame's own mean) and compared via
 *   Hamming distance. This matches spec decision 4 ("reuse proven
 *   ffmpeg-based logic, don't invent a new detection approach") while
 *   staying inside "same language as the rest of the runner, no new
 *   dependency" per spec section 7's tool-knowledge note.
 * - Subtitle positioning is NOT automated, per the spec's own v1
 *   recommendation (section 4.3): always flagged for manual review, never
 *   factored into pass/fail.
 * - Config: reads channelConfig.qa (silenceThresholdDb,
 *   minSilenceDurationSeconds, loopHashThreshold,
 *   expectedDurationToleranceSeconds) and channelConfig.exportSpecs
 *   (width/height) if present. Per spec section 6, a channel with no `qa`
 *   block does NOT block the pipeline -- see runQAStage's early return.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_QA_CONFIG = {
  silenceThresholdDb: -30,
  minSilenceDurationSeconds: 1.5,
  loopHashThreshold: 2,
  expectedDurationToleranceSeconds: 30,
};

function run(cmd) {
  try {
    return { ok: true, output: execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    // ffmpeg/ffprobe write useful diagnostics to stderr even on a
    // "successful" run (e.g. silencedetect always exits via -f null -
    // with output on stderr) -- execSync only captures stdout in `output`
    // on success, so callers that need stderr use run() below for exec
    // failures and runCaptureAll() for tools that report via stderr.
    return { ok: false, output: (e.stdout || '') + (e.stderr || ''), error: e.message };
  }
}

// ─── Check 1: Integrity ─────────────────────────────────────────────────────

function checkIntegrity(filePath, expectedDurationSeconds, toleranceSeconds) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { pass: false, reason: 'output_file_missing', filePath };
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { pass: false, reason: 'output_file_empty', filePath };
  }

  const probe = run(`ffprobe -v error -show_entries format=duration,size -of json "${filePath}"`);
  if (!probe.ok) {
    return { pass: false, reason: 'ffprobe_failed', detail: probe.error };
  }

  let duration = null;
  try {
    const parsed = JSON.parse(probe.output);
    duration = parseFloat(parsed.format && parsed.format.duration);
  } catch (e) {
    return { pass: false, reason: 'ffprobe_output_unparseable', detail: e.message };
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    return { pass: false, reason: 'zero_or_invalid_duration', duration };
  }

  if (Number.isFinite(expectedDurationSeconds) && expectedDurationSeconds > 0) {
    const off = Math.abs(duration - expectedDurationSeconds);
    if (off > toleranceSeconds) {
      return { pass: false, reason: 'duration_mismatch', duration, expectedDurationSeconds, offBy: off };
    }
  }

  return { pass: true, duration, sizeBytes: Number(JSON.parse(probe.output).format.size || stat.size) };
}

// ─── Check 2: Silence gaps ──────────────────────────────────────────────────

function checkSilenceGaps(filePath, thresholdDb, minDurationSeconds) {
  const cmd = `ffmpeg -i "${filePath}" -af silencedetect=noise=${thresholdDb}dB:d=${minDurationSeconds} -f null - 2>&1`;
  let output;
  try {
    output = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    // ffmpeg with `-f null -` frequently exits non-zero even on success
    // depending on build/platform; the actual detection output is on
    // stdout/stderr either way, captured via e.stdout/e.stderr.
    output = (e.stdout || '') + (e.stderr || '');
  }

  const silences = [];
  const startRe = /silence_start:\s*([\d.]+)/g;
  const durRe   = /silence_duration:\s*([\d.]+)/g;
  const starts  = [...output.matchAll(startRe)].map(m => parseFloat(m[1]));
  const durs    = [...output.matchAll(durRe)].map(m => parseFloat(m[1]));
  for (let i = 0; i < Math.min(starts.length, durs.length); i++) {
    silences.push({ start: starts[i], durationSeconds: durs[i] });
  }

  return {
    flagged: silences.length > 0,
    silences,
    thresholdDb,
    minDurationSeconds,
  };
}

// ─── Check 3: Loop / repeated clip detection (aHash, ffmpeg-only) ──────────

const HASH_SIZE = 16; // 16x16 grayscale = 256-bit hash

function extractHashFrames(filePath, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const rawPath = path.join(tmpDir, 'frames.raw');
  const cmd = `ffmpeg -y -i "${filePath}" -vf "fps=1,scale=${HASH_SIZE}:${HASH_SIZE}:flags=area,format=gray" -f rawvideo "${rawPath}" 2>&1`;
  try {
    execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    // Same non-zero-exit-on-success caveat as above; check the file itself.
  }
  if (!fs.existsSync(rawPath)) return { frames: [], rawPath: null };

  const buf = fs.readFileSync(rawPath);
  const frameBytes = HASH_SIZE * HASH_SIZE;
  const frames = [];
  for (let off = 0; off + frameBytes <= buf.length; off += frameBytes) {
    frames.push(buf.subarray(off, off + frameBytes));
  }
  return { frames, rawPath };
}

function averageHash(frameBuf) {
  let sum = 0;
  for (let i = 0; i < frameBuf.length; i++) sum += frameBuf[i];
  const mean = sum / frameBuf.length;
  // Pack into a plain array of 0/1 bits — 256 elements, one per pixel.
  const bits = new Uint8Array(frameBuf.length);
  for (let i = 0; i < frameBuf.length; i++) bits[i] = frameBuf[i] > mean ? 1 : 0;
  return bits;
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function checkForLoops(filePath, hashThreshold, tmpDir) {
  let frames, rawPath;
  try {
    ({ frames, rawPath } = extractHashFrames(filePath, tmpDir));
  } catch (e) {
    return { flagged: false, error: e.message, skipped: true };
  }

  if (frames.length < 5) {
    // Too short to meaningfully loop-check (or extraction failed) —
    // don't fail the episode over a QA-mechanics limitation.
    if (rawPath && fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
    return { flagged: false, skipped: true, reason: 'insufficient_frames', frameCount: frames.length };
  }

  const hashes = frames.map(averageHash);
  const MIN_GAP_SECONDS = 4; // frames are 1-per-second; skip naturally-similar near neighbors
  const matches = [];

  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + MIN_GAP_SECONDS; j < hashes.length; j++) {
      const dist = hammingDistance(hashes[i], hashes[j]);
      if (dist <= hashThreshold) {
        matches.push({ frameA: i, frameB: j, secondsApart: j - i, hammingDistance: dist });
        if (matches.length >= 20) break; // cap — this is a flag, not a full report
      }
    }
    if (matches.length >= 20) break;
  }

  if (rawPath && fs.existsSync(rawPath)) fs.unlinkSync(rawPath);

  return {
    flagged: matches.length > 0,
    matches,
    frameCount: frames.length,
    hashThreshold,
  };
}

// ─── Check 4: Aspect ratio / export dimensions ─────────────────────────────

function checkAspectRatio(filePath, exportSpecs) {
  if (!exportSpecs || !exportSpecs.width || !exportSpecs.height) {
    return { pass: true, skipped: true, reason: 'no_export_specs_configured' };
  }
  const probe = run(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`);
  if (!probe.ok) return { pass: false, reason: 'ffprobe_failed', detail: probe.error };

  const [w, h] = probe.output.trim().split(',').map(n => parseInt(n, 10));
  if (!w || !h) return { pass: false, reason: 'could_not_read_dimensions', raw: probe.output };

  const pass = w === exportSpecs.width && h === exportSpecs.height;
  return { pass, width: w, height: h, expected: { width: exportSpecs.width, height: exportSpecs.height } };
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.renderedFilePath - final episode MP4 to QA
 * @param {number} [opts.expectedDurationSeconds]
 * @param {object} [opts.channelConfig] - CONFIG.channels[channelKey] from
 *   pipeline.config.json, if available. May be undefined for channels
 *   without a `qa` block configured yet (see spec section 6).
 * @param {string} opts.tmpDir - scratch dir for frame extraction, cleaned
 *   up by the caller (episodeDir/temp is reused).
 * @returns {{ qaStatus: 'ready_for_review'|'needs_qa_review', results: object, failReasons: string[] }}
 */
async function runQAStage({ renderedFilePath, expectedDurationSeconds, channelConfig, tmpDir }) {
  const qaConfig = (channelConfig && channelConfig.qa) || null;

  if (!qaConfig) {
    // Spec section 6: unconfigured channels must not be blocked — safe
    // no-op, marked ready with a note rather than crashing the pipeline.
    return {
      qaStatus: 'ready_for_review',
      results: { skipped: true, reason: 'no_qa_config_for_channel' },
      failReasons: [],
    };
  }

  const cfg = { ...DEFAULT_QA_CONFIG, ...qaConfig };
  const results = {
    integrity: null,
    silence: null,
    loopDetection: null,
    subtitlePositioning: { checked: false, requiresManualReview: true }, // spec 4.3: always flag, never automate in v1
    aspectRatio: null,
  };

  results.integrity = checkIntegrity(renderedFilePath, expectedDurationSeconds, cfg.expectedDurationToleranceSeconds);
  if (!results.integrity.pass) {
    return { qaStatus: 'needs_qa_review', results, failReasons: ['FAILED_INTEGRITY'] };
  }

  results.silence = checkSilenceGaps(renderedFilePath, cfg.silenceThresholdDb, cfg.minSilenceDurationSeconds);
  results.loopDetection = checkForLoops(renderedFilePath, cfg.loopHashThreshold, tmpDir);
  results.aspectRatio = checkAspectRatio(renderedFilePath, channelConfig && channelConfig.exportSpecs);

  const failReasons = [];
  if (results.silence.flagged) failReasons.push('SILENCE_GAP_DETECTED');
  if (results.loopDetection.flagged) failReasons.push('LOOP_DETECTED');
  if (results.aspectRatio && results.aspectRatio.pass === false) failReasons.push('ASPECT_RATIO_MISMATCH');

  return {
    qaStatus: failReasons.length > 0 ? 'needs_qa_review' : 'ready_for_review',
    results,
    failReasons,
  };
}

module.exports = { runQAStage, checkIntegrity, checkSilenceGaps, checkForLoops, checkAspectRatio };
