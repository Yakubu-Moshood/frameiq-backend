/**
 * surface-renderer.cjs
 * Surface Pipeline v2 — Module 1 (The Render Engine) — CLOUD-NATIVE BUILD
 *
 * EP3-proven audio-as-master-clock architecture, ported to run on
 * Railway (Linux) as well as Windows:
 *
 *   - Fonts resolved at runtime (DejaVu on Linux, Arial/Impact on Windows).
 *     If no font is found, text overlays are skipped instead of crashing.
 *   - Approval gates accept an approvalCallback (used by the Frameiq
 *     backend runner). Falls back to keyboard YES/NO when run from CLI.
 *   - No process.exit() inside library code, no Media Player spawn.
 *   - Channel-aware watermark, output filename, and outro selection.
 *   - Memory-hardened FFmpeg: inputs pre-scaled before zoompan,
 *     quiet stderr, large exec buffers.
 *   - Outro module properly imported (was previously an undefined
 *     reference that silently failed).
 *
 * THE GOLDEN RULE — NEVER BREAK:
 *   Every visual cut is hardcoded to the EXACT SECOND the trigger word
 *   is spoken in the VO audio. Cursor step is 0.1s (NOT 0.5s).
 */

require('dotenv').config();
'use strict';

const fs            = require('fs');
const path          = require('path');
const readline      = require('readline');
const { execSync }  = require('child_process');
const https         = require('https');
const FormData      = require('form-data');

// ─── Constants ────────────────────────────────────────────────────────────────

const W   = 1920;
const H   = 1080;
const FPS = 30;

// ── Channel branding ──────────────────────────────────────────────
// BRANDS consolidation fix: branding used to be a hardcoded map here, keyed
// by ad-hoc strings (e.g. 'MacroDecode') that never actually matched the
// real channel key used at runtime (channel_dna.id, e.g. 'MoneyExplained'
// for Macro Decode -- deliberately never renamed, see
// migrations/007_macro_decode_rename.js). That mismatch meant Macro Decode
// episodes always fell through to DEFAULT_BRAND (Empire Omitted's gold
// accent + watermark text). Branding now comes from the caller (jobs/
// runner.js's resolveBrand(), reading channel_dna directly -- the single
// source of truth) via the `brand` param on renderEpisode(). This module no
// longer owns or guesses branding at all.
//
// FALLBACK_BRAND below is only used if a caller invokes renderEpisode()
// without a `brand` (e.g. an old CLI script) -- it derives a channel's own
// name from its key rather than silently borrowing another channel's
// identity or printing a literal "FRAMEIQ".
function deriveFallbackBrand(channelKey) {
  const display = String(channelKey || 'CHANNEL')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toUpperCase();
  return { display, accent: 'FFFFFF' };
}

// ── Font resolution — Linux first, Windows fallback ───────────────
// If nothing is found, TEXT overlays are skipped (render never crashes).
function findFont(candidates) {
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

const FONT_BOLD_PATH = findFont([
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
]);

const FONT_IMPACT_PATH = findFont([
  'C:/Windows/Fonts/impact.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
]);

const TEXT_ENABLED = !!(FONT_BOLD_PATH && FONT_IMPACT_PATH);

// drawtext needs ':' escaped inside fontfile paths (Windows drives)
function fontParam(p) { return p.replace(/:/g, '\\:'); }
const FONT_BOLD   = TEXT_ENABLED ? fontParam(FONT_BOLD_PATH)   : null;
const FONT_IMPACT = TEXT_ENABLED ? fontParam(FONT_IMPACT_PATH) : null;

const SCALE = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;

const GRADE = {
  cold_blue:   'eq=contrast=1.05:saturation=0.85:brightness=0.18',
  gold_warm:   'eq=contrast=1.05:saturation=1.05:brightness=0.22',
  deep_shadow: 'eq=contrast=1.08:saturation=0.80:brightness=0.14',
  red_alert:   'eq=contrast=1.10:saturation=1.10:brightness=0.16',
  neutral:     'eq=contrast=1.02:saturation=0.95:brightness=0.18',
  desaturated: 'eq=contrast=1.05:saturation=0.40:brightness=0.14',
};

const MUSIC_VOL = {
  act1:  0.05,
  act2:  0.10,
  act3:  0.08,
  act3b: 0.06,
  act4:  0.12,
  act5:  0.05,
};

const ACT_VO_FILES = ['VO_Act1.mp3', 'VO_Act2.mp3', 'VO_Act3.mp3', 'VO_Act3B.mp3', 'VO_Act4.mp3', 'VO_Act5.mp3'];
const ACT_KEYS     = ['act1', 'act2', 'act3', 'act3b', 'act4', 'act5'];

const ACT_LABELS = {
  act1:  'ACT 1 — THE HOOK & PROMISE',
  act2:  'ACT 2 — THE RISE',
  act3:  'ACT 3 — THE DECEPTION',
  act3b: 'ACT 3B — THE HUMAN COST',
  act4:  'ACT 4 — THE COLLAPSE',
  act5:  'ACT 5 — THE VERDICT',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(msg); }

function run(cmd, label) {
  log(`  → ${label}`);
  try {
    execSync(cmd, {
      stdio:     ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = err.stderr?.toString() || '';
    throw new Error(`FFmpeg failed [${label}]:\n${stderr.slice(-800)}`);
  }
}

// Quiet flags keep FFmpeg's stderr small (prevents giant exec buffers)
const FF = 'ffmpeg -y -v error -hide_banner -nostats';

// FFmpeg's -f concat demuxer parses `file '<path>'` lines using the same
// single-quote escaping convention as POSIX shell: a literal `'` inside a
// quoted string must be written as `'\''` (close-quote, escaped-quote,
// reopen-quote). Without this, any path containing an apostrophe (e.g. an
// episode folder like "MCKINSEY'S OPIOID SCANDAL") causes ffmpeg to see an
// early closing quote, mis-parse the path, and fail with
// "Impossible to open" on a truncated/garbled filename.
function concatFileEntry(p) {
  const normalized = path.resolve(p).replace(/\\/g, '/');
  const escaped    = normalized.replace(/'/g, `'\\''`);
  return `file '${escaped}'`;
}

function getAudioDuration(filePath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
    { maxBuffer: 8 * 1024 * 1024 }
  ).toString().trim();
  return parseFloat(out);
}

// Closing-CTA fix: detects the outro clip's actual resolution rather than
// assuming it matches the main episode's W x H constants -- outro assets
// live on the Railway volume (not in this git repo), so their real
// dimensions can't be confirmed from here. Probing at runtime and sizing
// the CTA overlay off the result keeps this correct regardless.
function getVideoDimensions(filePath) {
  const out = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${filePath}"`,
    { maxBuffer: 8 * 1024 * 1024 }
  ).toString().trim();
  const [w, h] = out.split('x').map(Number);
  if (!w || !h) throw new Error(`Could not read video dimensions from ffprobe output: "${out}"`);
  return { width: w, height: h };
}

function logDiskSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    const freeGB  = (s.bavail * s.bsize / 1e9).toFixed(2);
    const totalGB = (s.blocks * s.bsize / 1e9).toFixed(2);
    log(`[disk] ${dir}: ${freeGB} GB free of ${totalGB} GB`);
    if (s.bavail * s.bsize < 2e9) {
      log(`[disk] ⚠️  WARNING: under 2 GB free — renders may fail on large episodes`);
    }
  } catch (_) { /* statfs unavailable on this platform — skip */ }
}

function esc(text) {
  // Strip characters that break FFmpeg drawtext filter
  return (text || '')
    .replace(/"/g, '')        // remove double quotes
    .replace(/'/g, "\\'")   // escape single quotes
    .replace(/:/g, '\\:')   // escape colons
    .replace(/,/g, '');       // remove commas
}

// Closing-CTA fix: separate escaper that ESCAPES commas (\,) instead of
// stripping them, since the CTA's approved wording ("...subscribe, follow,
// comment, and share.") reads noticeably worse with commas removed. esc()
// above strips commas because it's only ever used for short channel/name
// labels where that's a fine tradeoff -- left unchanged for those callers
// to avoid touching unrelated watermark/lower-third rendering.
function escCta(text) {
  return (text || '')
    .replace(/"/g, '')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,');
}

// ─── APPROVAL GATE (CLI fallback only) ───────────────────────────────────────

function askApprovalCLI(actKey, actOutput) {
  return new Promise((resolve) => {
    const label = ACT_LABELS[actKey] || actKey.toUpperCase();
    log('');
    log(`✋ APPROVAL REQUIRED — ${label}`);
    log(`   File: ${actOutput}`);
    log('   Type YES to continue, NO to stop.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => {
      rl.question('  Your decision (YES / NO): ', (answer) => {
        const cleaned = answer.trim().toUpperCase();
        if (cleaned === 'YES' || cleaned === 'Y') { rl.close(); resolve(true); }
        else if (cleaned === 'NO' || cleaned === 'N') { rl.close(); resolve(false); }
        else { log('  Please type YES or NO'); ask(); }
      });
    };
    ask();
  });
}

// ─── Overlay builders ─────────────────────────────────────────────────────────
// Every builder returns null when fonts are unavailable — callers skip nulls.

function overlayFilter(text, colour, size, totalFrames) {
  if (!TEXT_ENABLED) return null;
  const fi    = 12;
  const fo    = 10;
  const col   = (colour || '#C9A84C').replace('#', '');
  const sz    = size || 52;
  const alpha = `if(lt(n\\,${fi})\\,n/${fi}\\,if(gt(n\\,${totalFrames - fo})\\,(${totalFrames}-n)/${fo}\\,1))`;
  return `drawtext=fontfile='${FONT_BOLD}':text='${esc(text)}':fontcolor=0x${col}:fontsize=${sz}:x=60:y=h-text_h-80:shadowcolor=black:shadowx=3:shadowy=3:alpha='${alpha}'`;
}

// CINEMATIC OVERLAY — slide in from left
function slideInFilter(text, colour, size, totalFrames, yPos) {
  if (!TEXT_ENABLED) return null;
  const col      = (colour || '#C9A84C').replace('#', '');
  const sz       = size || 58;
  const slideIn  = 18;
  const holdEnd  = totalFrames - 14;
  const fadeOut  = 14;
  const xExpr    = `if(lt(n\\,${slideIn})\\,(-500+n*(560/${slideIn}))\\,60)`;
  const alphaExp = `if(gt(n\\,${holdEnd})\\,(${totalFrames}-n)/${fadeOut}\\,1)`;
  const y        = yPos || `h-text_h-80`;
  return `drawtext=fontfile='${FONT_IMPACT}':text='${esc(text)}':fontcolor=0x${col}:fontsize=${sz}:x='${xExpr}':y=${y}:shadowcolor=black:shadowx=4:shadowy=4:alpha='${alphaExp}'`;
}

// CINEMATIC OVERLAY — stamp burn onto screen
function stampFilter(text, colour, size, totalFrames, yPos) {
  if (!TEXT_ENABLED) return null;
  const col     = (colour || '#8B0000').replace('#', '');
  const sz      = size || 88;
  const holdEnd = totalFrames - 16;
  const fadeOut = 16;
  const alphaExp = `if(lt(n\\,2)\\,0\\,if(gt(n\\,${holdEnd})\\,(${totalFrames}-n)/${fadeOut}\\,1))`;
  const y        = yPos || `(h-text_h)/2`;
  return `drawtext=fontfile='${FONT_IMPACT}':text='${esc(text)}':fontcolor=0x${col}:fontsize=${sz}:x=(w-text_w)/2:y=${y}:shadowcolor=black:shadowx=6:shadowy=6:alpha='${alphaExp}'`;
}

function cinematicOverlay(cinematic, totalFrames) {
  if (!cinematic?.text) return null;
  const style = cinematic.style || 'slide_in';
  const col   = cinematic.colour || '#C9A84C';
  const sz    = cinematic.size   || 58;
  const y     = cinematic.y      || null;

  if (style === 'stamp')    return stampFilter(cinematic.text, col, sz, totalFrames, y);
  if (style === 'slide_in') return slideInFilter(cinematic.text, col, sz, totalFrames, y);
  return overlayFilter(cinematic.text, col, sz, totalFrames);
}

function lowerThirdFilter(name, title, durSec, accent = 'C9A84C') {
  if (!TEXT_ENABLED) return null;
  const totalFrames = Math.round(durSec * FPS);
  const holdEnd     = totalFrames - 12;
  const alpha       = `if(lt(n\\,8)\\,n/8\\,if(gt(n\\,${holdEnd})\\,(${totalFrames}-n)/12\\,1))`;
  const nameF = `drawtext=fontfile='${FONT_IMPACT}':text='${esc(name)}':fontcolor=0x${accent}:fontsize=48:x=60:y=h-120:shadowcolor=black:shadowx=3:shadowy=3:alpha='${alpha}'`;
  const titlF = `drawtext=fontfile='${FONT_BOLD}':text='${esc(title)}':fontcolor=0xFFFFFF:fontsize=28:x=60:y=h-70:shadowcolor=black:shadowx=2:shadowy=2:alpha='${alpha}'`;
  return `${nameF},${titlF}`;
}

// Closing-CTA fix (Step 4): burns the approved subscribe/follow/comment/share
// ask onto the channel's outro segment, in that channel's own accent colour
// -- reuses the exact same per-channel `brand` object the watermark already
// uses (BRANDS consolidation, Step 1), so this needed zero new branding
// plumbing. Two lines, matching the lowerThird/statCard convention elsewhere
// in this file (plain white body text + accent-coloured emphasis line, both
// shadowed for readability against whatever the outro's background is)
// rather than a boxed banner. Sized as a proportion of the outro's own
// detected height (see getVideoDimensions()) so this holds up correctly
// regardless of the outro's actual resolution -- not assumed to match the
// main episode's W/H constants, since outro assets live on the Railway
// volume and can't be inspected from this repo.
//
// Fades in over the last ~1s and holds through the end of the clip; no
// fade-out needed since the outro (and therefore this overlay) simply ends
// with the video.
function closingCtaFilter(brand, width, height, durSec) {
  if (!TEXT_ENABLED) return null;
  const totalFrames = Math.round(durSec * FPS);
  const fadeInFrames = Math.min(30, Math.round(FPS * 1)); // ~1s fade-in
  const alpha = `if(lt(n\\,${fadeInFrames})\\,n/${fadeInFrames}\\,1)`;

  const line1Size = Math.round(height * 0.045);
  const line2Size = Math.round(height * 0.058);
  const line1Y    = Math.round(height * 0.80);
  const line2Y    = Math.round(height * 0.87);

  const line1 = `drawtext=fontfile='${FONT_BOLD}':text='${escCta('If you want more stories like this,')}':fontcolor=0xFFFFFF:fontsize=${line1Size}:x=(w-text_w)/2:y=${line1Y}:shadowcolor=black:shadowx=2:shadowy=2:alpha='${alpha}'`;
  const line2 = `drawtext=fontfile='${FONT_IMPACT}':text='${escCta('subscribe, follow, comment, and share.')}':fontcolor=0x${brand.accent}:fontsize=${line2Size}:x=(w-text_w)/2:y=${line2Y}:shadowcolor=black:shadowx=3:shadowy=3:alpha='${alpha}'`;

  return `${line1},${line2}`;
}

// Closing-CTA fix: burns closingCtaFilter() onto a copy of the channel's
// outro clip, writing the result to a temp path and returning that path
// instead of mutating the original outro asset (which lives on the Railway
// volume, outside this repo, and is shared across every episode for that
// channel -- must never be edited in place). Re-encodes only the video
// stream (drawtext requires it); audio is stream-copied straight through
// unchanged. On any failure (missing ffprobe data, TEXT_ENABLED false because
// no font was found, ffmpeg error, etc.) this falls back to the original,
// un-overlaid outro path and logs why -- matching the same "never fail the
// whole render over the outro" defensiveness as the try/catch around
// appendOutro() itself.
function applyClosingCta(outroPath, brand, tempDir) {
  if (!TEXT_ENABLED) {
    log('[cta] TEXT_ENABLED is false (no font found) — shipping outro without the CTA overlay');
    return outroPath;
  }
  try {
    const { width, height } = getVideoDimensions(outroPath);
    const durSec = getAudioDuration(outroPath);
    const filter = closingCtaFilter(brand, width, height, durSec);
    if (!filter) return outroPath;

    fs.mkdirSync(tempDir, { recursive: true });
    const outPath = path.join(tempDir, 'outro_with_cta.mp4');

    run(
      `${FF} -i "${outroPath}" -vf "${filter}" -c:v libx264 -preset fast -pix_fmt yuv420p -c:a copy "${outPath}"`,
      'burning closing CTA onto outro'
    );

    return outPath;
  } catch (ctaErr) {
    log(`[cta] ⚠ Could not overlay closing CTA onto outro: ${ctaErr.message}`);
    log(`[cta]   Using outro without the CTA overlay.`);
    return outroPath;
  }
}

// NOTE (Macro Decode onboarding): `accent` now defaults to Empire Omitted's
// gold for backward compatibility, but callers should pass brand.accent so
// each channel's stat-card / data-callout overlay uses its own identity
// colour instead of silently inheriting Empire Omitted's.
function statCardFilter(label, value, sub, durSec, accent = 'C9A84C') {
  if (!TEXT_ENABLED) return null;
  const totalFrames = Math.round(durSec * FPS);
  const holdEnd     = totalFrames - 12;
  const alpha       = `if(lt(n\\,8)\\,n/8\\,if(gt(n\\,${holdEnd})\\,(${totalFrames}-n)/12\\,1))`;
  const valF  = `drawtext=fontfile='${FONT_IMPACT}':text='${esc(value)}':fontcolor=0x${accent}:fontsize=88:x=(w-text_w)/2:y=(h-text_h)/2-30:shadowcolor=black:shadowx=4:shadowy=4:alpha='${alpha}'`;
  const labF  = `drawtext=fontfile='${FONT_BOLD}':text='${esc(label)}':fontcolor=0xFFFFFF:fontsize=32:x=(w-text_w)/2:y=(h/2)+50:shadowcolor=black:shadowx=2:shadowy=2:alpha='${alpha}'`;
  const subF  = sub
    ? `,drawtext=fontfile='${FONT_BOLD}':text='${esc(sub)}':fontcolor=0xAAAAAA:fontsize=24:x=(w-text_w)/2:y=(h/2)+92:alpha='${alpha}'`
    : '';
  return `${valF},${labF}${subF}`;
}

function watermarkFilter(brand) {
  if (!TEXT_ENABLED) return null;
  return `drawtext=fontfile='${FONT_BOLD}':text='${esc(brand.display)}':fontcolor=0x${brand.accent}@0.7:fontsize=20:x=w-text_w-30:y=h-text_h-30:shadowcolor=black:shadowx=2:shadowy=2`;
}

// ─── Step 1: Whisper ──────────────────────────────────────────────────────────

async function runWhisper({ audioDir, episodeDir }) {
  const tsFile = path.join(episodeDir, 'word-timestamps.json');

  if (fs.existsSync(tsFile)) {
    log('[whisper] word-timestamps.json already exists — skipping transcription');
    return JSON.parse(fs.readFileSync(tsFile, 'utf8'));
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('[whisper] OPENAI_API_KEY not set');

  log('[whisper] Transcribing all VO files...');

  const allWords = [];

  for (const filename of ACT_VO_FILES) {
    const voPath = path.join(audioDir, filename);
    if (!fs.existsSync(voPath)) {
      log(`[whisper] SKIP ${filename} — not found`);
      continue;
    }

    log(`[whisper] Transcribing ${filename}...`);
    const voKey = filename.replace('.mp3', '');

    const words = await whisperTranscribeFile(voPath, apiKey, voKey);
    allWords.push(...words);
    log(`[whisper] ${filename} → ${words.length} words`);
  }

  fs.writeFileSync(tsFile, JSON.stringify(allWords, null, 2), 'utf8');
  log(`[whisper] Saved ${allWords.length} total words → ${tsFile}`);
  return allWords;
}

function whisperTranscribeFile(filePath, apiKey, voKey) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');

    const headers = {
      ...form.getHeaders(),
      'Authorization': `Bearer ${apiKey}`,
    };

    const options = {
      hostname: 'api.openai.com',
      path:     '/v1/audio/transcriptions',
      method:   'POST',
      headers,
    };

    let body = '';
    const req = https.request(options, (res) => {
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`[whisper] API error ${res.statusCode}: ${body}`));
        }
        try {
          const data  = JSON.parse(body);
          const words = (data.words || []).map(w => ({
            vo_file:       voKey,
            word:          w.word.toLowerCase().replace(/[^a-z0-9']/g, ''),
            start_seconds: w.start,
            end_seconds:   w.end,
          }));
          resolve(words);
        } catch (err) {
          reject(new Error(`[whisper] Parse error: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    form.pipe(req);
  });
}

// ─── Step 1B: Auto-fix trigger words against Whisper data ───────────────────

function autoFixTriggerWords({ shotDefs, wordTimestamps, shotDefsPath }) {
  log('');
  log('[auto-fix] Checking trigger words against Whisper transcript...');

  const wordsByAct = {};
  for (const w of wordTimestamps) {
    if (!wordsByAct[w.vo_file]) wordsByAct[w.vo_file] = [];
    wordsByAct[w.vo_file].push(w);
  }

  const ACT_VOICE_MAP = {
    act1:  'VO_Act1',
    act2:  'VO_Act2',
    act3:  'VO_Act3',
    act3b: 'VO_Act3B',
    act4:  'VO_Act4',
    act5:  'VO_Act5',
  };

  let fixed = 0;
  let alreadyGood = 0;

  for (const [actKey, voKey] of Object.entries(ACT_VOICE_MAP)) {
    const shots    = shotDefs.acts[actKey] || [];
    const actWords = wordsByAct[voKey]     || [];

    if (actWords.length === 0) continue;

    let cursor = 0;

    for (let i = 0; i < shots.length; i++) {
      const shot   = shots[i];
      const target = shot.triggerWord.toLowerCase().trim();

      if (typeof shot.hardcodedSec === 'number') {
        alreadyGood++;
        cursor = shot.hardcodedSec + 0.1;
        continue;
      }

      const exactMatch = actWords.find(w => w.start_seconds > cursor && w.word === target);

      if (exactMatch) {
        shot.hardcodedSec = exactMatch.start_seconds;
        const flatShot = shotDefs.allShots.find(s => s.shotId === shot.shotId);
        if (flatShot) flatShot.hardcodedSec = exactMatch.start_seconds;
        alreadyGood++;
        cursor = exactMatch.start_seconds + 0.1;
        continue;
      }

      const windowEnd   = cursor + 30;
      const windowWords = actWords.filter(w => w.start_seconds > cursor && w.start_seconds < windowEnd);

      let bestWord  = null;
      let bestScore = 0;

      for (const w of windowWords) {
        let score = 0;
        const ww = w.word;

        const digitMap = {
          'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,
          'eight':8,'nine':9,'ten':10,'eleven':11,'twelve':12,'thirteen':13,
          'fourteen':14,'fifteen':15,'sixteen':16,'seventeen':17,'eighteen':18,
          'nineteen':19,'twenty':20,'twenty-four':24,'twenty-five':25,
          'thirty':30,'forty':40,'forty-five':45,'fifty':50,'sixty':60,
          'seventy':70,'eighty':80,'eighty-nine':89,'ninety':90,'hundred':100,
        };
        const targetDigit = digitMap[target];
        if (targetDigit && ww === String(targetDigit)) { score = 90; }

        if (score === 0 && target.startsWith(ww)) score = 85;
        if (score === 0 && ww.startsWith(target.slice(0, 5))) score = 75;
        if (score === 0 && ww.startsWith(target.slice(0, 4))) score = 60;
        if (score === 0 && target.startsWith('$') && ww === target.slice(1)) score = 95;

        if (score === 0 && target.includes(' ')) {
          const firstWord = target.split(' ')[0];
          if (ww === firstWord) score = 80;
        }

        if (score > bestScore) { bestScore = score; bestWord = w; }
      }

      if (bestWord && bestScore >= 60) {
        const oldTrigger = shot.triggerWord;
        shot.triggerWord  = bestWord.word;
        shot.hardcodedSec = bestWord.start_seconds;

        const flatShot = shotDefs.allShots.find(s => s.shotId === shot.shotId);
        if (flatShot) { flatShot.triggerWord = bestWord.word; flatShot.hardcodedSec = bestWord.start_seconds; }

        log(`  🔧 ${shot.shotId}: "${oldTrigger}" → "${bestWord.word}" @ ${bestWord.start_seconds.toFixed(2)}s (score ${bestScore})`);
        fixed++;
        cursor = bestWord.start_seconds + 0.1;
      } else {
        const fallback = actWords.find(w => w.start_seconds > cursor);
        if (fallback) {
          const oldTrigger = shot.triggerWord;
          shot.triggerWord  = fallback.word;
          shot.hardcodedSec = fallback.start_seconds;

          const flatShot = shotDefs.allShots.find(s => s.shotId === shot.shotId);
          if (flatShot) { flatShot.triggerWord = fallback.word; flatShot.hardcodedSec = fallback.start_seconds; }

          log(`  ⚡ ${shot.shotId}: "${oldTrigger}" → "${fallback.word}" @ ${fallback.start_seconds.toFixed(2)}s (fallback)`);
          fixed++;
          cursor = fallback.start_seconds + 0.1;
        }
      }
    }
  }

  log('');
  log(`[auto-fix] ${alreadyGood} already matched | ${fixed} auto-fixed`);

  if (shotDefsPath && fs.existsSync(shotDefsPath)) {
    fs.writeFileSync(shotDefsPath, JSON.stringify(shotDefs, null, 2), 'utf8');
    log(`[auto-fix] Saved updated trigger words → ${shotDefsPath}`);
  }

  return shotDefs;
}

// ─── Step 2: Resolve trigger words ────────────────────────────────────────────

function resolveTimestamps({ shotDefs, wordTimestamps }) {
  log('');
  log('[resolve] Matching trigger words to Whisper timestamps...');
  log('[resolve] Cursor step: 0.1s (never 0.5s)');
  log('');

  const wordsByAct = {};
  for (const w of wordTimestamps) {
    if (!wordsByAct[w.vo_file]) wordsByAct[w.vo_file] = [];
    wordsByAct[w.vo_file].push(w);
  }

  const shotsByAct = {};
  for (const shot of shotDefs.allShots) {
    const voKey = `VO_${shot.actKey.charAt(0).toUpperCase() + shot.actKey.slice(1)}`
                    .replace('Act3b', 'Act3B');
    if (!shotsByAct[voKey]) shotsByAct[voKey] = [];
    shotsByAct[voKey].push(shot);
  }

  const resolved = [];

  for (const [voKey, actShots] of Object.entries(shotsByAct)) {
    const actWords = wordsByAct[voKey] || [];
    const voDur    = actWords.length > 0 ? actWords[actWords.length - 1].end_seconds : 0;
    let cursor     = 0;

    for (let i = 0; i < actShots.length; i++) {
      const shot     = actShots[i];
      const nextShot = actShots[i + 1];
      const target   = shot.triggerWord.toLowerCase().trim();

      let startSec;
      let matchType;

      if (typeof shot.hardcodedSec === 'number') {
        startSec  = shot.hardcodedSec;
        matchType = 'HARDCODED';
      } else {
        const match = actWords.find(w => w.start_seconds > cursor && w.word === target);
        const fuzzyMatch = !match && actWords.find(w =>
          w.start_seconds > cursor && w.word.includes(target.slice(0, 4))
        );
        startSec  = match ? match.start_seconds : fuzzyMatch ? fuzzyMatch.start_seconds : cursor;
        matchType = match ? 'exact' : fuzzyMatch ? 'fuzzy' : 'fallback';
      }

      const nextMatch = nextShot
        ? actWords.find(w =>
            w.start_seconds > (startSec + 0.1) &&
            w.word === nextShot.triggerWord.toLowerCase().trim()
          )
        : null;

      const endSec = nextMatch
        ? nextMatch.start_seconds
        : voDur || (startSec + (shot.estimatedDuration || 5));

      const durSec = Math.max(endSec - startSec, 0.5);

      const effectiveType = (shot.visualType === 'STILL_ZOOM' && durSec > 10) ? 'STILL' : shot.visualType;

      if (effectiveType !== shot.visualType) {
        log(`[resolve] DOWNGRADE ${shot.shotId}: STILL_ZOOM → STILL (${durSec.toFixed(1)}s > 10s limit)`);
      }

      const status = matchType === 'HARDCODED' ? '📌' : matchType === 'exact' ? '✅' : matchType === 'fuzzy' ? '⚠️' : '❌';
      log(`  ${status} [${shot.shotId}] "${target}" @ ${startSec.toFixed(2)}s → ${endSec.toFixed(2)}s (${durSec.toFixed(2)}s) [${effectiveType}]`);

      resolved.push({ ...shot, voKey, startSec, endSec, durSec, visualType: effectiveType, matched: matchType !== 'fallback' });
      cursor = startSec + 0.1;
    }
  }

  const unmatched = resolved.filter(r => !r.matched).length;
  log('');
  log(`[resolve] ${resolved.length} shots resolved — ${unmatched} unmatched (used fallback timing)`);
  if (unmatched > 0) {
    log(`[resolve] WARNING: ${unmatched} shots fell back — check trigger words`);
  }

  return resolved;
}

// ─── Step 3: Render segments ──────────────────────────────────────────────────

function renderSegments({ resolved, episodeDir, assetsDir, brand }) {
  log('');
  log('[render] Rendering FFmpeg segments...');
  log(`[render] Text overlays: ${TEXT_ENABLED ? `ENABLED (${FONT_BOLD_PATH})` : 'DISABLED — no usable font found on this system'}`);
  log('');

  const byAct = {};
  for (const shot of resolved) {
    if (!byAct[shot.voKey]) byAct[shot.voKey] = [];
    byAct[shot.voKey].push(shot);
  }

  const actSegFiles = {};
  const WM = watermarkFilter(brand);

  for (const [voKey, shots] of Object.entries(byAct)) {
    const tempDir  = path.join(episodeDir, 'temp', voKey);
    fs.mkdirSync(tempDir, { recursive: true });
    const segFiles = [];

    log(`[render] Act: ${voKey} — ${shots.length} segments`);

    for (let i = 0; i < shots.length; i++) {
      const shot    = shots[i];
      const segFile = path.join(tempDir, `seg_${String(i).padStart(3, '0')}.mp4`);
      segFiles.push(segFile);

      if (fs.existsSync(segFile)) {
        log(`  SKIP ${shot.shotId} [${shot.triggerWord}]`);
        continue;
      }

      const assetPath = resolveAssetPath(shot, assetsDir);

      if (!assetPath) {
        log(`  ⚠️  MISSING ${shot.shotId} — black frame placeholder`);
        run(
          `${FF} -f lavfi -i "color=black:size=${W}x${H}:rate=${FPS}" -t ${shot.durSec.toFixed(3)} -c:v libx264 -pix_fmt yuv420p "${segFile}"`,
          `black placeholder ${shot.shotId}`
        );
        continue;
      }

      const grade       = GRADE[shot.colorGrade] || GRADE.neutral;
      const isImg       = assetPath.endsWith('.png') || assetPath.endsWith('.jpg');
      const isZoom      = shot.visualType === 'STILL_ZOOM';
      const totalFrames = Math.round(shot.durSec * FPS);
      const filterParts = [];

      if (isImg && isZoom) {
        // MEMORY SAFETY: pre-scale the source image down BEFORE zoompan.
        // zoompan on huge AI-generated PNGs is the classic FFmpeg RAM bomb;
        // feeding it a modest 1.1x-of-output frame keeps memory flat.
        filterParts.push(
          `scale=2112:-2`,
          `zoompan=z='min(zoom+0.0005,1.03)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${W}x${H}:fps=${FPS}`
        );
      } else {
        filterParts.push(SCALE);
      }

      filterParts.push(grade);

      // Overlay builders return null when fonts are unavailable — filter them out
      if (shot.overlay?.text) filterParts.push(overlayFilter(shot.overlay.text, shot.overlay.colour, shot.overlay.size, totalFrames));
      const cinOverlay = cinematicOverlay(shot.cinematic, totalFrames);
      if (cinOverlay) filterParts.push(cinOverlay);
      if (shot.stat)  filterParts.push(statCardFilter(shot.stat.label, shot.stat.value, shot.stat.sub, shot.durSec, brand.accent));
      if (shot.lower) filterParts.push(lowerThirdFilter(shot.lower.name, shot.lower.title, shot.durSec, brand.accent));
      if (WM)         filterParts.push(WM);

      const vf = filterParts.filter(Boolean).join(',');
      let cmd;

      if (isImg) {
        cmd = `${FF} -loop 1 -i "${assetPath}" -t ${shot.durSec.toFixed(3)} -vf "${vf}" -c:v libx264 -preset fast -pix_fmt yuv420p -r ${FPS} "${segFile}"`;
      } else {
        cmd = `${FF} -stream_loop -1 -i "${assetPath}" -t ${shot.durSec.toFixed(3)} -vf "${vf}" -c:v libx264 -preset fast -pix_fmt yuv420p -r ${FPS} "${segFile}"`;
      }

      run(cmd, `${shot.shotId} [${shot.triggerWord}] ${shot.visualType} ${shot.durSec.toFixed(1)}s`);
    }

    actSegFiles[voKey] = segFiles;
  }

  return actSegFiles;
}

function resolveAssetPath(shot, assetsDir) {
  const stillsDir = path.join(assetsDir, 'stills');
  const clipsDir  = path.join(assetsDir, 'clips');

  if (shot.asset) {
    for (const dir of [stillsDir, clipsDir, assetsDir]) {
      const candidate = path.join(dir, shot.asset);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (path.isAbsolute(shot.asset) && fs.existsSync(shot.asset)) return shot.asset;
  }

  if (shot.visualType === 'CLIP') {
    const clipMp4 = path.join(clipsDir, `${shot.shotId}.mp4`);
    if (fs.existsSync(clipMp4)) return clipMp4;
    const clipPng = path.join(stillsDir, `${shot.shotId}.png`);
    if (fs.existsSync(clipPng)) {
      log(`  ⚠️  ${shot.shotId}: no MP4 found — using static PNG fallback`);
      return clipPng;
    }
    return null;
  }

  for (const ext of ['.png', '.jpg']) {
    const byId = path.join(stillsDir, `${shot.shotId}${ext}`);
    if (fs.existsSync(byId)) return byId;
  }

  return null;
}

// ─── Step 4: Build acts with APPROVAL GATE ────────────────────────────────────

async function buildActVideos({ actSegFiles, episodeDir, audioDir, musicFile, approvalCallback }) {
  log('');
  log('[build-acts] Building acts with per-act approval gates...');
  log('');

  const actVideos = [];

  for (const actKey of ACT_KEYS) {
    const voFilename = `VO_${actKey.charAt(0).toUpperCase() + actKey.slice(1)}.mp3`
                        .replace('Act3b', 'Act3B');
    const voKey      = voFilename.replace('.mp3', '');
    const segFiles   = actSegFiles[voKey];
    const voPath     = path.join(audioDir, voFilename);
    const actOutput  = path.join(episodeDir, 'output', `act_${actKey}.mp4`);
    const tempDir    = path.join(episodeDir, 'temp', voKey);

    if (!segFiles || segFiles.length === 0) {
      log(`[build-acts] SKIP ${actKey} — no segments`);
      continue;
    }

    if (!fs.existsSync(voPath)) {
      log(`[build-acts] SKIP ${actKey} — VO file not found`);
      continue;
    }

    // If act already approved and output exists — skip
    if (fs.existsSync(actOutput)) {
      log(`[build-acts] SKIP ${actKey} — already approved and built`);
      actVideos.push({ actKey, path: actOutput });
      continue;
    }

    log(`[build-acts] ══════════════════════════════════════`);
    log(`[build-acts] Building ${ACT_LABELS[actKey] || actKey}...`);
    log(`[build-acts] ══════════════════════════════════════`);

    // Concat segments → silent video
    const concatFile  = path.join(tempDir, 'concat.txt');
    const silentVideo = path.join(tempDir, 'silent.mp4');

    fs.writeFileSync(
      concatFile,
      segFiles.map(concatFileEntry).join('\n')
    );

    run(
      `${FF} -f concat -safe 0 -i "${concatFile}" -c:v copy "${silentVideo}"`,
      `${actKey} — concatenating ${segFiles.length} segments`
    );

    // Duration check
    const silentDur = getAudioDuration(silentVideo);
    const voDur     = getAudioDuration(voPath);
    const drift     = Math.abs(silentDur - voDur);

    log('');
    log(`[check] ${actKey}: visual=${silentDur.toFixed(2)}s  VO=${voDur.toFixed(2)}s  drift=${drift.toFixed(2)}s`);

    if (drift > 1.0) {
      log(`[check] ⚠️  DRIFT WARNING: ${drift.toFixed(2)}s — some shots may be on wrong words`);
    } else {
      log(`[check] ✅ Sync OK`);
    }

    // Mix audio
    const musicVol   = MUSIC_VOL[actKey] || 0.08;
    const mixedAudio = path.join(tempDir, 'audio_mixed.aac');
    fs.mkdirSync(path.dirname(actOutput), { recursive: true });

    if (musicFile && fs.existsSync(musicFile)) {
      run(
        `${FF} -stream_loop -1 -i "${musicFile}" -i "${voPath}" -filter_complex "[0:a]volume=${musicVol}[music];[1:a]volume=1.0[vo];[music][vo]amix=inputs=2:duration=shortest:normalize=0[aout]" -map "[aout]" -c:a aac -b:a 192k "${mixedAudio}"`,
        `${actKey} — mixing VO + music (vol ${musicVol})`
      );
      run(
        `${FF} -i "${silentVideo}" -i "${mixedAudio}" -c:v copy -c:a copy -shortest "${actOutput}"`,
        `${actKey} — locking audio to video`
      );
    } else {
      run(
        `${FF} -i "${silentVideo}" -i "${voPath}" -c:v copy -c:a aac -b:a 192k -shortest "${actOutput}"`,
        `${actKey} — locking VO to video`
      );
    }

    log(`[build-acts] ✅ ${actKey} rendered → ${actOutput}`);

    // ── APPROVAL GATE ──────────────────────────────────────────────────────
    // Cloud mode: ask the Frameiq backend (which asks the user via the web UI).
    // CLI mode:   fall back to keyboard YES/NO.
    const approved = approvalCallback
      ? await approvalCallback(actKey, actOutput)
      : await askApprovalCLI(actKey, actOutput);

    if (!approved) {
      // Clear this act's output and segments so a retry rebuilds it fresh
      log(`[build-acts] 🛑 ${actKey} rejected — clearing its output and segments for re-render`);
      try { fs.rmSync(actOutput, { force: true }); } catch (_) {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      throw new Error(
        `Act ${actKey} was rejected. Its segments have been cleared — ` +
        `edit shot-definitions.json if needed, then hit Retry to re-render from this act.`
      );
    }

    actVideos.push({ actKey, path: actOutput });
  }

  return actVideos;
}

// ─── Step 5: Join final ───────────────────────────────────────────────────────

function joinAllActs({ actVideos, episodeDir, episodeId, channel }) {
  log('');
  log('[join] All acts approved. Joining into final documentary...');

  const finalOutput = path.join(episodeDir, 'output', `${channel}_${episodeId}_FINAL.mp4`);

  if (actVideos.length === 0) throw new Error('[join] No act videos to join');

  const concatFile = path.join(episodeDir, 'temp', 'final_concat.txt');
  fs.mkdirSync(path.dirname(concatFile), { recursive: true });
  fs.writeFileSync(
    concatFile,
    actVideos.map(a => concatFileEntry(a.path)).join('\n')
  );

  run(
    `${FF} -f concat -safe 0 -i "${concatFile}" -c:v copy -c:a copy "${finalOutput}"`,
    `Joining ${actVideos.length} acts`
  );

  const totalDur = getAudioDuration(finalOutput);
  log('');
  log(`[join] ✅ FINAL DOCUMENTARY: ${finalOutput}`);
  log(`[join]    Runtime: ${(totalDur / 60).toFixed(2)} minutes (${totalDur.toFixed(0)}s)`);

  return { path: finalOutput, durationSeconds: totalDur };
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function renderEpisode({ episodeDir, episodeId, channel = 'EmpireOmitted', brand = null, approvalCallback = null }) {
  const audioDir     = path.join(episodeDir, 'assets', 'audio');
  const assetsDir    = path.join(episodeDir, 'assets');
  const publicDir    = path.join(episodeDir, '..', '..', 'public');
  const musicFile    = path.join(publicDir, 'background_music.mp3');
  const shotDefsPath = path.join(episodeDir, 'shot-definitions.json');
  brand = brand || deriveFallbackBrand(channel);

  log('');
  log('╔══════════════════════════════════════════════════════╗');
  log('║   SURFACE RENDERER — AUDIO-AS-MASTER-CLOCK (CLOUD)    ║');
  log(`║   Episode: ${episodeId.padEnd(43)}║`);
  log(`║   Channel: ${channel.padEnd(43)}║`);
  log('╚══════════════════════════════════════════════════════╝');
  log('');

  logDiskSpace(episodeDir);

  if (!fs.existsSync(shotDefsPath)) {
    throw new Error(`[renderer] shot-definitions.json not found at ${shotDefsPath}`);
  }

  const shotDefs = JSON.parse(fs.readFileSync(shotDefsPath, 'utf8'));
  if (!shotDefs.allShots?.length) {
    throw new Error('[renderer] shot-definitions.json has no shots in allShots array');
  }

  log(`[renderer] Loaded ${shotDefs.allShots.length} shots`);

  // Step 1 — Whisper
  log('');
  log('══════════════════════════════════════════');
  log('STEP 1 — WHISPER TRANSCRIPTION');
  log('══════════════════════════════════════════');
  const wordTimestamps = await runWhisper({ audioDir, episodeDir });

  // Step 1B — Auto-fix trigger words
  log('');
  log('══════════════════════════════════════════');
  log('STEP 1B — AUTO-FIX TRIGGER WORDS');
  log('══════════════════════════════════════════');
  autoFixTriggerWords({ shotDefs, wordTimestamps, shotDefsPath });

  // Step 2 — Resolve
  log('');
  log('══════════════════════════════════════════');
  log('STEP 2 — TIMESTAMP RESOLUTION');
  log('══════════════════════════════════════════');
  const resolved = resolveTimestamps({ shotDefs, wordTimestamps });

  // Step 3 — Render segments
  log('');
  log('══════════════════════════════════════════');
  log('STEP 3 — RENDERING SEGMENTS');
  log('══════════════════════════════════════════');
  const actSegFiles = renderSegments({ resolved, episodeDir, assetsDir, brand });

  // Step 4 — Build acts + approval gates
  log('');
  log('══════════════════════════════════════════');
  log('STEP 4 — BUILDING ACTS (WITH YOUR APPROVAL)');
  log('══════════════════════════════════════════');
  const actVideos = await buildActVideos({
    actSegFiles, episodeDir, audioDir,
    musicFile: fs.existsSync(musicFile) ? musicFile : null,
    approvalCallback,
  });

  // Step 5 — Join
  log('');
  log('══════════════════════════════════════════');
  log('STEP 5 — JOINING FINAL DOCUMENTARY');
  log('══════════════════════════════════════════');
  const result = joinAllActs({ actVideos, episodeDir, episodeId, channel });

  // Step 6 — Append branded outro
  log('');
  log('══════════════════════════════════════════');
  log('STEP 6 — APPENDING BRANDED OUTRO');
  log('══════════════════════════════════════════');

  let finalResult = result;
  try {
    // FIX: appendOutro was previously referenced without ever being
    // imported — Step 6 silently failed on every cloud render.
    const { appendOutro } = require(path.join(__dirname, 'append-outro.cjs'));

    // Channel-specific outro if it exists, else the EmpireOmitted default
    const channelOutro = path.join(publicDir, `outro_${channel}.mp4`);
    const defaultOutro = path.join(publicDir, 'outro_EmpireOmitted.mp4');
    const outroPath    = fs.existsSync(channelOutro) ? channelOutro : defaultOutro;

    // Closing-CTA fix (Step 4): burn the subscribe/follow/comment/share ask
    // onto this channel's outro, in this channel's own accent colour, before
    // appending it. Non-destructive -- writes to a temp file, never touches
    // the shared outro asset itself.
    const ctaOutroPath = applyClosingCta(outroPath, brand, path.join(episodeDir, 'temp'));

    const withOutro = await appendOutro({
      episodePath: result.path,
      outroPath:   ctaOutroPath,
    });
    const finalDur = getAudioDuration(withOutro);
    finalResult = { path: withOutro, durationSeconds: finalDur, title: result.title };
    log(`[outro] ✅ Outro appended → ${path.basename(withOutro)}`);
    log(`[outro]    Final runtime: ${(finalDur / 60).toFixed(2)} minutes`);
  } catch (outroErr) {
    log(`[outro] ⚠ Could not append outro: ${outroErr.message}`);
    log(`[outro]   Returning episode without outro.`);
  }

  log('');
  log('╔══════════════════════════════════════════════════════╗');
  log('║  RENDER COMPLETE                                      ║');
  log(`║  Runtime: ${(finalResult.durationSeconds / 60).toFixed(2)} minutes`.padEnd(55) + '║');
  log('╚══════════════════════════════════════════════════════╝');

  return finalResult;
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = { episode: null, channel: 'EmpireOmitted' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--episode') opts.episode = args[++i];
    if (args[i] === '--channel') opts.channel = args[++i];
  }

  if (!opts.episode) {
    console.error('Usage: node surface-renderer.cjs --episode EP4');
    process.exit(1);
  }

  const episodeDir = path.join(__dirname, 'episodes', opts.episode);
  renderEpisode({ episodeDir, episodeId: opts.episode, channel: opts.channel })
    .catch(err => {
      console.error('[renderer] FATAL:', err.message);
      process.exit(1);
    });
}

module.exports = { renderEpisode };
