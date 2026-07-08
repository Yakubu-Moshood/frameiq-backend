/**
 * short-extractor.cjs
 * Frameiq — Step 7: Short Extractor
 *
 * After an episode renders, extract the most dramatic 59 seconds
 * (act 4 — the reveal/collapse) from the final MP4, crop it to
 * 9:16 vertical (1080x1920), burn in word-timed captions via
 * Whisper, add channel branding, and save as short.mp4 in the
 * episode folder.
 *
 * Wraps the existing pipeline — never rebuilds it. Reads:
 *   {episodeDir}/shot-definitions.json        (act structure)
 *   {episodeDir}/assets/audio/VO_Act*.mp3     (act timing via ffprobe)
 *   final rendered MP4                        (passed in from runner)
 *
 * Output: {episodeDir}/short.mp4
 *
 * Usage from runner.js:
 *   const { extractShort } = require(path.join(PIPELINE_DIR, 'short-extractor.cjs'));
 *   const result = await extractShort({
 *     episodeDir, episodeId, channel, finalVideoPath, onProgress
 *   });
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────

const FFMPEG  = process.env.FFMPEG_PATH  || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const SHORT_SECONDS = 59;   // max length for Shorts / TikTok / Reels
const OUTRO_SECONDS = 10;   // branded outro appended by Step 6 — never include it
const LEAD_IN       = 1.0;  // start slightly before act4 for a natural breath

// VO files in render order — act4's absolute start = sum of everything before it
const ACTS_BEFORE_ACT4 = ['VO_Act1.mp3', 'VO_Act2.mp3', 'VO_Act3.mp3', 'VO_Act3B.mp3'];

// Channel branding (self-contained so this module has zero config dependencies)
// NOTE (Macro Decode onboarding): renamed from MoneyExplained. Accent hex
// is provisional navy/gold — confirm against final brand work, and keep
// this in sync with the BRANDS map in surface-renderer.cjs.
const BRANDS = {
  EmpireOmitted:   { display: 'EMPIRE OMITTED',    accent: 'C9A84C' }, // gold
  MacroDecode:     { display: 'MACRO DECODE',      accent: 'E8B34C' }, // amber/gold
  HistoryHidden:   { display: 'HISTORY HIDDEN',    accent: 'D8C49A' }, // sepia cream
  TrueCrimeWeekly: { display: 'TRUE CRIME WEEKLY', accent: 'C41E1E' }, // red
};
const DEFAULT_BRAND = { display: 'FRAMEIQ', accent: 'C9A84C' };

// ── Small helpers ─────────────────────────────────────────────────────────

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${(stderr || err.message).slice(-1500)}`));
      resolve(stdout);
    });
  });
}

async function probeDuration(file) {
  const out = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ]);
  const d = parseFloat(String(out).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`Could not read duration of ${file}`);
  return d;
}

// "RRGGBB" hex -> ASS "&H00BBGGRR" (ASS colours are BGR)
function hexToAss(hex) {
  const h = hex.replace('#', '');
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

// seconds -> ASS timestamp H:MM:SS.cc
function tAss(sec) {
  const s  = Math.max(0, sec);
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100));
  const p  = (n, w = 2) => String(n).padStart(w, '0');
  return `${h}:${p(m)}:${p(ss)}.${p(cs)}`;
}

// Strip characters that have meaning in ASS subtitle markup
function escAss(text) {
  return String(text).replace(/[{}\\]/g, '').trim();
}

// ── Whisper transcription (word-level timestamps) ─────────────────────────

async function transcribeAudio(audioPath) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const result = await client.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
  });

  // [{ word, start, end }, ...] — times relative to the clip itself
  return Array.isArray(result.words) ? result.words : [];
}

// ── Caption builder ───────────────────────────────────────────────────────

/**
 * Group whisper words into short punchy chunks (max 3 words),
 * breaking early on pauses, and emit an .ass subtitle file with
 * channel-branded styling.
 */
function buildAssFile({ words, brand, clipDuration, outPath }) {
  const accent = hexToAss(brand.accent);
  const chunks = [];
  let current  = [];

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      start: current[0].start,
      end:   current[current.length - 1].end + 0.08,
      text:  current.map(w => escAss(w.word)).join(' ').toUpperCase(),
    });
    current = [];
  };

  for (const w of words) {
    if (current.length) {
      const gap = w.start - current[current.length - 1].end;
      if (gap > 0.7 || current.length >= 3) flush();
    }
    current.push(w);
  }
  flush();

  // Enforce a minimum on-screen time and no overlaps
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.end - c.start < 0.35) c.end = c.start + 0.35;
    if (i + 1 < chunks.length && c.end > chunks[i + 1].start) {
      c.end = chunks[i + 1].start;
    }
    c.end = Math.min(c.end, clipDuration);
  }

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Big bold captions, bottom-center but lifted above platform UI
    `Style: Caption,DejaVu Sans,82,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,1,0,1,5,2,2,60,60,420,1`,
    // Channel name strip, top-center, accent colour
    `Style: Brand,DejaVu Sans,46,${accent},${accent},&H00000000,&H96000000,1,0,0,0,100,100,4,0,1,3,1,8,60,60,110,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = [];

  // Persistent channel branding across the whole short
  events.push(
    `Dialogue: 0,${tAss(0)},${tAss(clipDuration)},Brand,,0,0,0,,${escAss(brand.display)}`
  );

  for (const c of chunks) {
    if (c.end <= c.start) continue;
    events.push(
      `Dialogue: 0,${tAss(c.start)},${tAss(c.end)},Caption,,0,0,0,,${c.text}`
    );
  }

  fs.writeFileSync(outPath, header.concat(events).join('\n'), 'utf8');
  return chunks.length;
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.episodeDir      Episode root, e.g. /data/episodes/EP7
 * @param {string} opts.episodeId       e.g. "EP7"
 * @param {string} opts.channel         Channel key, e.g. "EmpireOmitted"
 * @param {string} opts.finalVideoPath  Path to the rendered final MP4 (with outro)
 * @param {function} [opts.onProgress]  (pct, detail) => void
 * @returns {Promise<{ path: string, durationSeconds: number, startedAt: number, captions: number }>}
 */
async function extractShort({ episodeDir, episodeId, channel, finalVideoPath, onProgress }) {
  const report = (pct, detail) => { if (onProgress) onProgress(pct, detail); };

  if (!finalVideoPath || !fs.existsSync(finalVideoPath)) {
    throw new Error(`Final video not found at: ${finalVideoPath}`);
  }

  const audioDir = path.join(episodeDir, 'assets', 'audio');
  const tempDir  = path.join(episodeDir, 'temp_short');
  fs.mkdirSync(tempDir, { recursive: true });

  const shortPath = path.join(episodeDir, 'short.mp4');

  // ── 1. Work out where act4 starts in the final video ──
  report(5, 'Measuring act timings...');

  let act4Start = 0;
  for (const voFile of ACTS_BEFORE_ACT4) {
    const p = path.join(audioDir, voFile);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing VO file needed for timing: ${p}`);
    }
    act4Start += await probeDuration(p);
  }

  const videoDuration  = await probeDuration(finalVideoPath);
  const usableEnd      = videoDuration - OUTRO_SECONDS - 0.5; // never bleed into the outro
  let   start          = Math.max(0, act4Start - LEAD_IN);

  // Clamp so a full 59s window fits before the outro
  if (start + SHORT_SECONDS > usableEnd) {
    start = Math.max(0, usableEnd - SHORT_SECONDS);
  }
  const clipDuration = Math.min(SHORT_SECONDS, usableEnd - start);
  if (clipDuration < 15) {
    throw new Error(`Could not find a usable window (video ${videoDuration.toFixed(1)}s, act4 at ${act4Start.toFixed(1)}s)`);
  }

  report(15, `Window locked: ${start.toFixed(1)}s → ${(start + clipDuration).toFixed(1)}s (act4)`);

  // ── 2. Extract + crop to 9:16 vertical with fades ──
  report(20, 'Extracting and cropping to 9:16 vertical...');

  const noCapsPath = path.join(tempDir, 'short_nocaptions.mp4');
  const fadeOutAt  = Math.max(0, clipDuration - 0.8);

  await run(FFMPEG, [
    '-y',
    '-ss', start.toFixed(3),
    '-i', finalVideoPath,
    '-t', clipDuration.toFixed(3),
    '-vf', `scale=-2:1920,crop=1080:1920,fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOutAt.toFixed(2)}:d=0.8`,
    '-af', `afade=t=in:st=0:d=0.4,afade=t=out:st=${fadeOutAt.toFixed(2)}:d=0.8`,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '21',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    noCapsPath,
  ]);

  // ── 3. Captions (Whisper word timestamps -> ASS -> burn in) ──
  // If anything in this stage fails, ship the short without captions
  // rather than failing the whole step.
  let captionCount = 0;
  try {
    report(45, 'Transcribing clip audio via Whisper...');

    const clipAudioPath = path.join(tempDir, 'short_audio.mp3');
    await run(FFMPEG, ['-y', '-i', noCapsPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', clipAudioPath]);

    const words = await transcribeAudio(clipAudioPath);
    if (!words.length) throw new Error('Whisper returned no word timestamps');

    report(65, `Building ${'captions'} (${words.length} words)...`);

    const brand   = BRANDS[channel] || DEFAULT_BRAND;
    const assPath = path.join(tempDir, 'captions.ass');
    captionCount  = buildAssFile({ words, brand, clipDuration, outPath: assPath });

    report(75, 'Burning in captions and branding...');

    await run(FFMPEG, [
      '-y',
      '-i', noCapsPath,
      '-vf', `ass=${assPath}`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '21',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      shortPath,
    ]);
  } catch (capErr) {
    console.warn(`[short-extractor] Captions failed (${capErr.message}) — shipping short without captions`);
    fs.copyFileSync(noCapsPath, shortPath);
    captionCount = 0;
  }

  // ── 4. Clean up temp files ──
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

  const finalShortDuration = await probeDuration(shortPath);
  report(100, `Short ready: ${finalShortDuration.toFixed(1)}s, ${captionCount} captions`);

  return {
    path: shortPath,
    durationSeconds: finalShortDuration,
    startedAt: start,
    captions: captionCount,
  };
}

module.exports = { extractShort };
