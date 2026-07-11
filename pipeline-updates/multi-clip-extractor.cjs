/**
 * multi-clip-extractor.cjs
 * Frameiq — Step 7 replacement: Multi-Clip Smart Extraction
 *
 * Replaces short-extractor.cjs (single 59s "act 4" clip) with content-aware
 * selection of up to 5 clips per episode, split into two shapes:
 *   - 3 short/punchy clips  (15-30s, 9:16, dense captions, no CTA)      -- Reels-formatted
 *   - 2 longer teaser clips (60-90s, 9:16, sparser captions, "watch the
 *     full episode on YouTube" CTA burned in near the end)             -- direct feed posts
 *     (Instagram/TikTok/Facebook feed, not Reels-formatted, per the
 *     channel owner's explicit clarification)
 *
 * Moment selection reuses data the render stage already produced --
 * shot-definitions.json (triggerWord, colorGrade, stat/lower overlay
 * fields) and word-timestamps.json (real Whisper output from Step 1 of
 * the render) -- and makes ZERO new Whisper/paid-API calls. Per-act
 * shot/word timestamps are converted to absolute episode position using
 * the same "sum durations of every VO file before this act" technique
 * short-extractor.cjs already used for act4 alone, generalized here to
 * all 6 acts.
 *
 * "Drama" signal: shot-definitions.json's colorGrade values ARE the
 * red_alert/gold_emphasis-style tags referenced in the build brief --
 * see surface-shot-definitions.cjs's two VISUAL_PROFILES. red_alert
 * (documentary-style channels) and gold_emphasis / amber_alert (Macro
 * Decode's profile) are each that profile's own "this is a big moment"
 * colour grade. A shot carrying a stat/lower overlay is also treated as
 * a candidate moment, since surface-shot-definitions.cjs's own authoring
 * rules only attach those sparingly, to shots the script considers
 * notable (stat reveals, source citations, hook/contrarian-claim lines,
 * takeaways) -- not every shot gets one.
 *
 * Usage from runner.js:
 *   const { extractClips } = require(path.join(PIPELINE_DIR, 'multi-clip-extractor.cjs'));
 *   const result = await extractClips({
 *     episodeDir, episodeId, channel, brand, finalVideoPath, onProgress
 *   });
 *   // result.clips: [{ path, kind: 'short'|'teaser', durationSeconds, startedAt, captions }, ...]
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────

const FFMPEG  = process.env.FFMPEG_PATH  || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// Output canvas for every extracted clip -- same rationale as
// short-extractor.cjs's CLIP_WIDTH/CLIP_HEIGHT (single source of truth for
// both the crop filter and the ASS header).
const CLIP_WIDTH  = 1080;
const CLIP_HEIGHT = 1920;

const OUTRO_SECONDS = 10; // branded outro appended by Step 6 — never bleed into it

const SHORT_COUNT   = 3;
const SHORT_MIN_SEC = 15;
const SHORT_MAX_SEC = 30;

const TEASER_COUNT   = 2;
const TEASER_MIN_SEC = 60;
const TEASER_MAX_SEC = 90;

// Minimum gap (seconds, absolute episode time) between two selected
// candidates' centre points, so the 5 clips don't cluster inside one act.
const MIN_CLIP_SPACING_SEC = 45;

const ACT_ORDER = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];
const ACT_VO_FILENAME = {
  act1: 'VO_Act1.mp3', act2: 'VO_Act2.mp3', act3: 'VO_Act3.mp3',
  act3b: 'VO_Act3B.mp3', act4: 'VO_Act4.mp3', act5: 'VO_Act5.mp3',
};
const VOKEY_TO_ACTKEY = Object.fromEntries(
  Object.entries(ACT_VO_FILENAME).map(([act, file]) => [file.replace('.mp3', ''), act])
);

// "Big moment" colour grades across BOTH VISUAL_PROFILES in
// surface-shot-definitions.cjs -- documentary-style channels use
// red_alert; Macro Decode's profile uses gold_emphasis (stat reveal/turn/
// contrarian claim) and amber_alert (personal-stakes moments).
const HIGH_DRAMA_GRADES = new Set(['red_alert', 'gold_emphasis', 'amber_alert']);

// Channel branding — same pattern as surface-renderer.cjs/short-extractor.cjs:
// brand is always resolved by the caller (jobs/runner.js's resolveBrand(),
// reading channel_dna) and passed in. This fallback only fires for a caller
// that omits it.
function deriveFallbackBrand(channelKey) {
  const display = String(channelKey || 'CHANNEL')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toUpperCase();
  return { display, accent: 'FFFFFF' };
}

// ── Small helpers (same conventions as short-extractor.cjs) ───────────────

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${label || cmd} failed: ${(stderr || err.message).slice(-1500)}`));
      resolve(stdout);
    });
  });
}

async function probeDuration(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 'ffprobe duration');
  const d = parseFloat(String(out).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Could not read duration of ${file}`);
  return d;
}

// "RRGGBB" hex -> ASS "&H00BBGGRR" (ASS colours are BGR)
function hexToAss(hex) {
  const h = (hex || 'FFFFFF').replace('#', '');
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

function escAss(text) {
  return String(text ?? '').replace(/[{}\\]/g, '').trim();
}

function tAss(seconds) {
  const s  = Math.max(0, seconds);
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const p  = (n, w = 2) => String(n).padStart(w, '0');
  return `${h}:${p(m)}:${p(ss)}.${p(cs)}`;
}

// ── Act absolute-offset computation ────────────────────────────────────────
// Generalizes short-extractor.cjs's ACTS_BEFORE_ACT4 technique (sum VO
// durations of every act before the target) to all 6 acts, so ANY act's
// shots/words can be placed at their real absolute position in the final
// episode, not just act4's.
async function computeActOffsets(audioDir) {
  const offsets = {};
  let cursor = 0;
  for (const act of ACT_ORDER) {
    offsets[act] = cursor;
    const voPath = path.join(audioDir, ACT_VO_FILENAME[act]);
    if (fs.existsSync(voPath)) {
      cursor += await probeDuration(voPath);
    }
    // Missing act VO (e.g. a shorter blueprint without act3b) — treat as
    // zero-duration and keep going, matching the render pipeline's own
    // tolerance for optional acts.
  }
  return offsets;
}

// ── Deterministic shot-timing re-resolution ────────────────────────────────
// Faithful, simplified re-implementation of surface-renderer.cjs's
// resolveTimestamps() sequential trigger-word matching. Reads ONLY the two
// artifacts Step 1 of the render already persisted to disk
// (shot-definitions.json, word-timestamps.json) -- no new API calls, no
// re-transcription. Because it's a pure function over the same two inputs
// the real render used, it reproduces the same match results.
function resolveShotStarts(shotDefs, wordTimestamps) {
  const wordsByAct = {};
  for (const w of wordTimestamps) {
    if (!wordsByAct[w.vo_file]) wordsByAct[w.vo_file] = [];
    wordsByAct[w.vo_file].push(w);
  }

  const shotsByAct = {};
  for (const shot of (shotDefs.allShots || [])) {
    if (!shot.actKey) continue;
    const voKey = `VO_${shot.actKey.charAt(0).toUpperCase() + shot.actKey.slice(1)}`.replace('Act3b', 'Act3B');
    if (!shotsByAct[voKey]) shotsByAct[voKey] = [];
    shotsByAct[voKey].push(shot);
  }

  const resolved = [];
  for (const [voKey, actShots] of Object.entries(shotsByAct)) {
    const actWords = wordsByAct[voKey] || [];
    let cursor = 0;
    for (const shot of actShots) {
      const target = String(shot.triggerWord || '').toLowerCase().trim();
      let startSec;
      if (typeof shot.hardcodedSec === 'number') {
        startSec = shot.hardcodedSec;
      } else {
        const match = actWords.find(w => w.start_seconds > cursor && w.word === target);
        const fuzzy = !match && target
          ? actWords.find(w => w.start_seconds > cursor && w.word.includes(target.slice(0, 4)))
          : null;
        startSec = match ? match.start_seconds : fuzzy ? fuzzy.start_seconds : cursor;
      }
      resolved.push({ ...shot, voKey, startSec });
      cursor = startSec + 0.1;
    }
  }
  return resolved;
}

// ── Moment selection ────────────────────────────────────────────────────────
// Scores every shot that looks like a "moment" (high-drama colour grade,
// and/or a stat/lower overlay present), converts each to an absolute
// episode-time position, then greedily picks up to `count` candidates that
// are spaced at least MIN_CLIP_SPACING_SEC apart -- highest-scoring first,
// so this doesn't cluster inside a single act. If there aren't enough
// high-scoring candidates, backfills with evenly-spread shots from the
// whole episode so the default mix is never starved down to fewer than 5
// clips just because one episode is light on drama-tagged shots.
function selectCandidates(resolvedShots, actOffsets, count) {
  const withAbs = (s) => ({ ...s, absoluteSec: (actOffsets[s.actKey] || 0) + s.startSec });

  const scored = resolvedShots
    .map(withAbs)
    .map(s => ({
      ...s,
      score: (HIGH_DRAMA_GRADES.has(s.colorGrade) ? 2 : 0) + (s.stat ? 1 : 0) + (s.lower ? 1 : 0),
    }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.absoluteSec - b.absoluteSec);

  const selected = [];
  const isFarEnough = (candidate) =>
    selected.every(s => Math.abs(s.absoluteSec - candidate.absoluteSec) >= MIN_CLIP_SPACING_SEC);

  for (const c of scored) {
    if (selected.length >= count) break;
    if (isFarEnough(c)) selected.push(c);
  }

  if (selected.length < count) {
    const allByTime = resolvedShots.map(withAbs).sort((a, b) => a.absoluteSec - b.absoluteSec);
    for (const c of allByTime) {
      if (selected.length >= count) break;
      if (isFarEnough(c)) selected.push(c);
    }
  }

  selected.sort((a, b) => a.absoluteSec - b.absoluteSec);
  return selected;
}

// ── Word slicing (reuses Stage 1's persisted Whisper output) ──────────────
// Converts every word to an absolute episode-time position once, then a
// clip just filters that one array down to its own [start, start+dur]
// window and re-bases each word to clip-relative time. No Whisper call for
// any clip, ever -- this is the whole point of the fix.
function wordsToAbsolute(wordTimestamps, actOffsets) {
  return wordTimestamps
    .map(w => {
      const actKey = VOKEY_TO_ACTKEY[w.vo_file];
      if (actKey === undefined) return null;
      return { ...w, absStart: (actOffsets[actKey] || 0) + w.start_seconds, absEnd: (actOffsets[actKey] || 0) + w.end_seconds };
    })
    .filter(Boolean)
    .sort((a, b) => a.absStart - b.absStart);
}

function sliceWordsForClip(absoluteWords, clipAbsStart, clipDurSec) {
  const clipAbsEnd = clipAbsStart + clipDurSec;
  return absoluteWords
    .filter(w => w.absStart >= clipAbsStart && w.absStart < clipAbsEnd)
    .map(w => ({
      word: w.word,
      start_seconds: Math.max(0, w.absStart - clipAbsStart),
      end_seconds:   Math.min(clipDurSec, w.absEnd - clipAbsStart),
    }));
}

// ── Caption builder ─────────────────────────────────────────────────────────
// Same channel-branded ASS convention as short-extractor.cjs's buildAssFile
// (adaptive WrapStyle/sizing fix included), extended with:
//   - captionDensity: 'dense' (2-3 words/chunk, short-punchy clips) vs
//     'sparse' (5-7 words/chunk, teaser clips) — a deliberate readability
//     tradeoff for the longer, slower-paced teaser format.
//   - an optional CTA line ("watch the full episode on YouTube"), shown
//     only in the final few seconds of teaser clips, in the channel accent
//     colour, same visual language as the outro's closing-CTA overlay
//     (Step 4) for a consistent brand voice across every touchpoint.
function buildAssFile({ words, brand, clipDuration, outPath, captionDensity = 'dense', showCTA = false, width = CLIP_WIDTH, height = CLIP_HEIGHT }) {
  const accent = hexToAss(brand.accent);
  const maxWordsPerChunk = captionDensity === 'sparse' ? 6 : 3;
  const pauseBreakSec    = captionDensity === 'sparse' ? 1.1 : 0.7;

  const chunks = [];
  let current  = [];

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      start: current[0].start_seconds,
      end:   current[current.length - 1].end_seconds + 0.08,
      text:  current.map(w => escAss(w.word)).join(' ').toUpperCase(),
    });
    current = [];
  };

  for (const w of words) {
    if (current.length) {
      const gap = w.start_seconds - current[current.length - 1].end_seconds;
      if (gap > pauseBreakSec || current.length >= maxWordsPerChunk) flush();
    }
    current.push(w);
  }
  flush();

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.end - c.start < 0.35) c.end = c.start + 0.35;
    if (i + 1 < chunks.length && c.end > chunks[i + 1].start) c.end = chunks[i + 1].start;
    c.end = Math.min(c.end, clipDuration);
  }

  const captionFontsize = Math.round(height * 0.0427);
  const brandFontsize   = Math.round(height * 0.0240);
  const ctaFontsize     = Math.round(height * 0.0350);
  const captionMarginV  = Math.round(height * 0.2188);
  const brandMarginV    = Math.round(height * 0.0573);
  const ctaMarginV      = Math.round(height * 0.35);
  const marginL         = Math.round(width  * 0.0556);
  const marginR         = marginL;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0', // adaptive-subtitles fix carried over — see short-extractor.cjs
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,DejaVu Sans,${captionFontsize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,1,0,1,5,2,2,${marginL},${marginR},${captionMarginV},1`,
    `Style: Brand,DejaVu Sans,${brandFontsize},${accent},${accent},&H00000000,&H96000000,1,0,0,0,100,100,4,0,1,3,1,8,${marginL},${marginR},${brandMarginV},1`,
    `Style: CTA,DejaVu Sans,${ctaFontsize},${accent},${accent},&H00000000,&H96000000,1,0,0,0,100,100,2,0,1,4,2,2,${marginL},${marginR},${ctaMarginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = [];
  events.push(`Dialogue: 0,${tAss(0)},${tAss(clipDuration)},Brand,,0,0,0,,${escAss(brand.display)}`);

  if (showCTA) {
    const ctaLead = Math.min(6, clipDuration * 0.3); // CTA appears for roughly the last 6s (or 30% of a short clip)
    const ctaStart = Math.max(0, clipDuration - ctaLead);
    events.push(`Dialogue: 1,${tAss(ctaStart)},${tAss(clipDuration)},CTA,,0,0,0,,${escAss('WATCH THE FULL EPISODE ON YOUTUBE')}`);
  }

  for (const c of chunks) {
    if (c.end <= c.start) continue;
    events.push(`Dialogue: 0,${tAss(c.start)},${tAss(c.end)},Caption,,0,0,0,,${c.text}`);
  }

  fs.writeFileSync(outPath, [...header, ...events].join('\n'), 'utf8');
  return chunks.length;
}

// ── Shared per-clip render helper ──────────────────────────────────────────
// Point 1 of the Step 5 build: short-extractor.cjs's ffmpeg/caption/
// watermark logic, extracted into one reusable function parameterized by
// start time, duration, output path, and channel/brand -- used by BOTH the
// short-clip loop and the teaser-clip loop below, so there's exactly one
// place that owns "how a clip gets cut, captioned, and branded."
async function renderOneClip({ finalVideoPath, absStart, durSec, outPath, tempDir, brand, absoluteWords, captionDensity, showCTA, onProgress }) {
  fs.mkdirSync(tempDir, { recursive: true });
  const noCapsPath = path.join(tempDir, `${path.basename(outPath, '.mp4')}_nocaps.mp4`);
  const fadeOutAt  = Math.max(0, durSec - 0.8);

  onProgress?.(`Cutting ${durSec.toFixed(1)}s clip @ ${absStart.toFixed(1)}s...`);
  await run(FFMPEG, [
    '-y',
    '-ss', absStart.toFixed(3),
    '-i', finalVideoPath,
    '-t', durSec.toFixed(3),
    '-vf', `scale=-2:${CLIP_HEIGHT},crop=${CLIP_WIDTH}:${CLIP_HEIGHT},fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOutAt.toFixed(2)}:d=0.8`,
    '-af', `afade=t=in:st=0:d=0.4,afade=t=out:st=${fadeOutAt.toFixed(2)}:d=0.8`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    noCapsPath,
  ], 'cutting clip');

  let captionCount = 0;
  try {
    onProgress?.('Building captions from persisted Whisper data...');
    const words = sliceWordsForClip(absoluteWords, absStart, durSec);
    if (!words.length) throw new Error('No persisted words fall within this clip window');

    const assPath = path.join(tempDir, `${path.basename(outPath, '.mp4')}.ass`);
    captionCount = buildAssFile({ words, brand, clipDuration: durSec, outPath: assPath, captionDensity, showCTA });

    onProgress?.('Burning in captions and branding...');
    await run(FFMPEG, [
      '-y', '-i', noCapsPath, '-vf', `ass=${assPath}`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart',
      outPath,
    ], 'burning captions');
  } catch (capErr) {
    console.warn(`[multi-clip] Captions failed for ${path.basename(outPath)} (${capErr.message}) — shipping without captions`);
    fs.copyFileSync(noCapsPath, outPath);
    captionCount = 0;
  }

  const finalDur = await probeDuration(outPath);
  return { path: outPath, durationSeconds: finalDur, startedAt: absStart, captions: captionCount };
}

// ── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.episodeDir      Episode root
 * @param {string} opts.episodeId       e.g. "EP7"
 * @param {string} opts.channel         Channel key, e.g. "EmpireOmitted"
 * @param {object} [opts.brand]         { display, accent } resolved by the caller from channel_dna
 * @param {string} opts.finalVideoPath  Path to the rendered final MP4 (with outro)
 * @param {function} [opts.onProgress]  (pct, detail) => void
 * @returns {Promise<{ clips: Array, warnings: string[] }>}
 */
async function extractClips({ episodeDir, episodeId, channel, brand = null, finalVideoPath, onProgress }) {
  brand = brand || deriveFallbackBrand(channel);
  const report = (pct, detail) => { if (onProgress) onProgress(pct, detail); };
  const warnings = [];

  if (!finalVideoPath || !fs.existsSync(finalVideoPath)) {
    throw new Error(`Final video not found at: ${finalVideoPath}`);
  }

  const audioDir      = path.join(episodeDir, 'assets', 'audio');
  const tempDir        = path.join(episodeDir, 'temp_clips');
  const shotDefsPath  = path.join(episodeDir, 'shot-definitions.json');
  const wordTsPath    = path.join(episodeDir, 'word-timestamps.json');

  if (!fs.existsSync(shotDefsPath)) throw new Error(`shot-definitions.json not found at ${shotDefsPath}`);
  if (!fs.existsSync(wordTsPath))   throw new Error(`word-timestamps.json not found at ${wordTsPath} — Step 1's Whisper data must exist for multi-clip extraction to reuse it`);

  const shotDefs       = JSON.parse(fs.readFileSync(shotDefsPath, 'utf8'));
  const wordTimestamps = JSON.parse(fs.readFileSync(wordTsPath, 'utf8'));

  report(5, 'Computing act offsets...');
  const actOffsets = await computeActOffsets(audioDir);

  report(10, 'Re-resolving shot timing from persisted Whisper data (no new transcription)...');
  const resolvedShots  = resolveShotStarts(shotDefs, wordTimestamps);
  const absoluteWords  = wordsToAbsolute(wordTimestamps, actOffsets);

  const videoDuration = await probeDuration(finalVideoPath);
  const usableEnd      = videoDuration - OUTRO_SECONDS - 0.5; // never bleed into the branded outro

  report(15, 'Selecting candidate moments...');
  const candidates = selectCandidates(resolvedShots, actOffsets, SHORT_COUNT + TEASER_COUNT);

  if (candidates.length === 0) {
    throw new Error('No candidate shots found (episode has no resolvable shot timing) — cannot select any clips');
  }
  if (candidates.length < SHORT_COUNT + TEASER_COUNT) {
    warnings.push(`Only ${candidates.length} well-spaced candidate moment(s) found — expected ${SHORT_COUNT + TEASER_COUNT}. Producing fewer clips than the default mix.`);
  }

  // First (up to) SHORT_COUNT candidates -> short punchy clips; the rest
  // (up to TEASER_COUNT) -> teasers. Candidates are already sorted
  // chronologically by selectCandidates(), so "first N" = earliest-in-episode,
  // which is a reasonable default (earlier hooks tend to need less context
  // to land as a standalone short; later/bigger reveals suit the longer
  // teaser format, which has room to build up to them).
  const shortSource  = candidates.slice(0, SHORT_COUNT);
  const teaserSource = candidates.slice(SHORT_COUNT, SHORT_COUNT + TEASER_COUNT);

  const clips = [];
  let doneCount = 0;
  const totalCount = shortSource.length + teaserSource.length;
  const progressFor = (label) => {
    doneCount += 1;
    report(15 + Math.round((doneCount / Math.max(1, totalCount)) * 80), label);
  };

  for (let i = 0; i < shortSource.length; i++) {
    const c = shortSource[i];
    const durSec  = Math.min(SHORT_MAX_SEC, Math.max(SHORT_MIN_SEC, SHORT_MAX_SEC));
    // Centre the window slightly ahead of the trigger word (a short natural
    // lead-in), clamp so it never runs past the usable (pre-outro) end.
    let absStart = Math.max(0, c.absoluteSec - 1.0);
    if (absStart + durSec > usableEnd) absStart = Math.max(0, usableEnd - durSec);

    const outPath = path.join(episodeDir, `short_${i + 1}.mp4`);
    onProgress && report(15, `Building short ${i + 1}/${shortSource.length} (${c.actKey} @ ${c.absoluteSec.toFixed(1)}s)...`);
    const result = await renderOneClip({
      finalVideoPath, absStart, durSec: Math.min(durSec, usableEnd - absStart), outPath, tempDir, brand,
      absoluteWords, captionDensity: 'dense', showCTA: false,
      onProgress: (msg) => report(15, msg),
    });
    clips.push({ ...result, kind: 'short', platform: 'reels' });
    progressFor(`Short ${i + 1}/${shortSource.length} ready`);
  }

  for (let i = 0; i < teaserSource.length; i++) {
    const c = teaserSource[i];
    let durSec = TEASER_MAX_SEC;
    let absStart = Math.max(0, c.absoluteSec - 5.0); // more lead-in room for a teaser to build context

    // Try to end the teaser on (or just after) another high-drama beat
    // within the max window, for a cliffhanger-style cutoff rather than an
    // arbitrary mid-sentence stop.
    const windowEnd = Math.min(usableEnd, absStart + TEASER_MAX_SEC);
    const cliffhangerCandidates = resolvedShots
      .map(s => ({ ...s, absoluteSec: (actOffsets[s.actKey] || 0) + s.startSec }))
      .filter(s => HIGH_DRAMA_GRADES.has(s.colorGrade) && s.absoluteSec > absStart + TEASER_MIN_SEC && s.absoluteSec <= windowEnd)
      .sort((a, b) => a.absoluteSec - b.absoluteSec);

    if (cliffhangerCandidates.length) {
      const cliff = cliffhangerCandidates[0];
      durSec = Math.max(TEASER_MIN_SEC, Math.min(TEASER_MAX_SEC, (cliff.absoluteSec + 1.5) - absStart));
    } else {
      durSec = Math.min(TEASER_MAX_SEC, Math.max(TEASER_MIN_SEC, TEASER_MAX_SEC));
    }
    if (absStart + durSec > usableEnd) {
      durSec = Math.max(TEASER_MIN_SEC, usableEnd - absStart);
    }

    const outPath = path.join(episodeDir, `teaser_${i + 1}.mp4`);
    onProgress && report(15, `Building teaser ${i + 1}/${teaserSource.length} (${c.actKey} @ ${c.absoluteSec.toFixed(1)}s)...`);
    const result = await renderOneClip({
      finalVideoPath, absStart, durSec, outPath, tempDir, brand,
      absoluteWords, captionDensity: 'sparse', showCTA: true,
      onProgress: (msg) => report(15, msg),
    });
    clips.push({ ...result, kind: 'teaser', platform: 'feed' });
    progressFor(`Teaser ${i + 1}/${teaserSource.length} ready`);
  }

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

  report(100, `${clips.length} clip(s) ready (${shortSource.length} short, ${teaserSource.length} teaser)`);

  return { clips, warnings };
}

module.exports = { extractClips, selectCandidates, resolveShotStarts, computeActOffsets, wordsToAbsolute, sliceWordsForClip, buildAssFile };
