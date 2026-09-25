'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');
function log(msg) { console.log(msg); }
const ACT_VO_FILES = ['VO_Act1.mp3', 'VO_Act2.mp3', 'VO_Act3.mp3', 'VO_Act3B.mp3', 'VO_Act4.mp3', 'VO_Act5.mp3'];
// ─── Step 1: Whisper ──────────────────────────────────────────────────────────
// Render-stage hardening (audit finding #6): this used to have no request
// timeout (a stalled connection could hang the whole render indefinitely)
// and no retry on a transient failure. It also only wrote word-timestamps.json
// once, at the very end of the loop over all 6 VO files -- a failure on
// file 5 of 6 lost the whole batch, and a retry re-transcribed (re-billed)
// files 1-4 all over again. WHISPER_TIMEOUT_MS/WHISPER_MAX_RETRIES below
// address the first two; the partial-checkpoint file below addresses the
// third, keyed by voKey so a retry can skip whatever already succeeded.
const WHISPER_TIMEOUT_MS   = 2 * 60 * 1000; // 2 min per file -- generous for one VO segment
const WHISPER_MAX_RETRIES  = 2;
async function runWhisper({ audioDir, episodeDir, onProgress }) {
  const progress = event => { if (typeof onProgress === 'function') onProgress(event); };
  const tsFile      = path.join(episodeDir, 'word-timestamps.json');
  const partialFile = path.join(episodeDir, 'word-timestamps.partial.json');
  if (fs.existsSync(tsFile)) {
    log('[whisper] word-timestamps.json already exists — skipping transcription');
    return JSON.parse(fs.readFileSync(tsFile, 'utf8'));
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('[whisper] OPENAI_API_KEY not set');
  let partial = {}; // voKey -> words[], persisted to partialFile after each file
  if (fs.existsSync(partialFile)) {
    try {
      partial = JSON.parse(fs.readFileSync(partialFile, 'utf8'));
      log(`[whisper] Found partial transcript checkpoint — ${Object.keys(partial).length}/${ACT_VO_FILES.length} file(s) already done`);
    } catch (e) {
      log(`[whisper] Partial checkpoint unreadable (${e.message}) — starting fresh`);
      partial = {};
    }
  }
  log('[whisper] Transcribing VO files...');
  for (const filename of ACT_VO_FILES) {
    const voKey = filename.replace('.mp3', '');
    if (partial[voKey]) {
      log(`[whisper] SKIP ${filename} — already transcribed (checkpoint)`);
      progress({ type: 'checkpoint-reused', voKey, filename, words: partial[voKey].length });
      continue;
    }
    const voPath = path.join(audioDir, filename);
    if (!fs.existsSync(voPath)) {
      log(`[whisper] SKIP ${filename} — not found`);
      continue;
    }
    log(`[whisper] Transcribing ${filename}...`);
    progress({ type: 'file-start', voKey, filename });
    const words = await whisperTranscribeFileWithRetry(voPath, apiKey, voKey, attempt => progress({ type: 'attempt-start', voKey, filename, attempt }));
    partial[voKey] = words;
    fs.writeFileSync(partialFile, JSON.stringify(partial, null, 2), 'utf8');
    log(`[whisper] ${filename} → ${words.length} words (checkpoint saved)`);
    progress({ type: 'file-complete', voKey, filename, words: words.length });
  }
  const allWords = ACT_VO_FILES
    .map(f => f.replace('.mp3', ''))
    .filter(voKey => partial[voKey])
    .flatMap(voKey => partial[voKey]);
  fs.writeFileSync(tsFile, JSON.stringify(allWords, null, 2), 'utf8');
  log(`[whisper] Saved ${allWords.length} total words → ${tsFile}`);
  // Cleanup only -- tsFile's existence (checked at the top of this function)
  // is what actually gates a future skip; leaving the partial file around
  // would be harmless but pointless clutter once the real output exists.
  try { fs.rmSync(partialFile, { force: true }); } catch (_) {}
  return allWords;
}
async function whisperTranscribeFileWithRetry(filePath, apiKey, voKey, onAttempt) {
  let lastErr;
  for (let attempt = 1; attempt <= WHISPER_MAX_RETRIES + 1; attempt++) {
    try {
      if (typeof onAttempt === 'function') onAttempt(attempt);
      return await whisperTranscribeFile(filePath, apiKey, voKey);
    } catch (err) {
      lastErr = err;
      if (attempt <= WHISPER_MAX_RETRIES) {
        const delayMs = attempt * 2000;
        log(`[whisper] ${voKey}: attempt ${attempt} failed (${err.message}) — retrying in ${(delayMs / 1000).toFixed(0)}s`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw new Error(`[whisper] ${voKey}: failed after ${WHISPER_MAX_RETRIES + 1} attempt(s): ${lastErr.message}`);
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
    let settled = false;
    let body = '';
    const req = https.request(options, (res) => {
      res.on('data', d => body += d);
      res.on('end', () => {
        if (settled) return;
        settled = true;
        if (res.statusCode !== 200) {
          return reject(new Error(`[whisper] API error ${res.statusCode}: ${body.slice(0, 300)}`));
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
    // Render-stage hardening (finding #6): previously no timeout at all --
    // a stalled connection to OpenAI would hang this promise, and therefore
    // the whole render, forever.
    //
    // reject() is called directly here, synchronously, rather than relying
    // on req.destroy(err) to trigger the 'error' handler below -- caught by
    // testing against a real synthetic timeout, not assumed: destroy()'s
    // resulting 'error' event fires on a LATER tick, by which point this
    // handler has already set `settled = true` (to guard against a data/
    // error race), so the 'error' handler's own `if (settled) return` would
    // silently swallow it and the promise would never settle at all --
    // exactly the same "hangs forever" failure mode this fix exists to
    // close. req.destroy(err) is still called, purely to actually tear down
    // the underlying socket; its later 'error' event correctly no-ops
    // against the same settled guard now that reject() has already fired.
    req.setTimeout(WHISPER_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      const timeoutErr = new Error(`[whisper] Request timed out after ${WHISPER_TIMEOUT_MS / 1000}s`);
      req.destroy(timeoutErr);
      reject(timeoutErr);
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    form.pipe(req);
  });
}

module.exports = { runWhisper };
