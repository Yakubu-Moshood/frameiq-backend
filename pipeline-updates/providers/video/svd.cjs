'use strict';

/**
 * providers/video/svd.cjs
 * Stable Video Diffusion (via Replicate) -- fallback tier for animation,
 * used by write-animator.js through providers/provider-router.cjs, behind
 * fal.ai Kling (the current sole/primary provider, hardcoded, no fallback
 * before this change -- see investigation report).
 *
 * generate({ sourceImagePath, animationStyle, outputPath }, providerConfig)
 *   -> { success: true, path, durationMs, provider: 'svd' }
 *   -> { success: false, statusCode, error }
 *
 * IMPORTANT capability gap, not fixable, flagged plainly: unlike Kling
 * (which accepts a text animationPrompt, see write-animator.js's
 * ANIMATION_DEFAULTS / shot.animationPrompt), Stable Video Diffusion is
 * image-conditioned only -- it has no text-prompt input at all. There is
 * no way to carry the channel's animation-style *wording* into this
 * fallback tier. The best available substitute is motion_bucket_id (an
 * integer motion-intensity dial), which this module derives from
 * animationStyle via a small heuristic map (ANIMATION_STYLE_TO_MOTION
 * below) -- documented as a judgment call, not a real equivalence.
 *
 * Model: christophy/stable-video-diffusion, version
 * 92a0c9a9cb1fd93ea0361d15e499dc879b35095077b2feed47315ccab4524036 --
 * confirmed live at investigation time (replicate.com/christophy/
 * stable-video-diffusion/versions). Chosen over the official
 * stability-ai/stable-video-diffusion because pricing/run-count/version
 * hash were concretely confirmed live for this one; flagging that the
 * official model (or CogVideoX, which the handoff also named -- and
 * which does accept a text prompt, unlike SVD) may be worth reconsidering
 * once real account access exists, given this model's low run count
 * (31.6K) and missing readme.
 * Input field names (input_image, video_length, sizing_strategy,
 * frames_per_second, motion_bucket_id, cond_aug, decoding_t) are this
 * family's long-stable, widely-documented Replicate schema -- confirmed
 * live via search results referencing this model's actual API reference
 * page, not a fresh predict.py fetch (repeated live fetches of cog-svd's
 * predict.py timed out in this sandbox). Output is a single mp4 URL.
 * Pricing confirmed live: ~$0.18/run on Nvidia L40S, varies by input;
 * "predictions typically complete within 4 minutes" per the model page --
 * MAX_WAIT_MS below is set generously longer than Kling's own budget to
 * account for that.
 */

const fs = require('fs');
const https = require('https');

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION = '92a0c9a9cb1fd93ea0361d15e499dc879b35095077b2feed47315ccab4524036';
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 300000; // README: "predictions typically complete within 4 minutes" -- generous margin

// Overridable only for local testing (a mocked http server instead of
// api.replicate.com) -- never set in production.
const API_HOSTNAME = process.env.SVD_TEST_API_HOSTNAME || 'api.replicate.com';
const API_PORT = process.env.SVD_TEST_API_PORT ? Number(process.env.SVD_TEST_API_PORT) : 443;
const httpsOrHttp = process.env.SVD_TEST_API_PORT ? require('http') : https;

// Judgment call (see header comment): SVD has no text-prompt input, so
// animationStyle can only steer motion intensity, not content/wording.
const ANIMATION_STYLE_TO_MOTION = {
  dramatic: 180,
  minimal: 100,
  'subtle-ken-burns': 40,
};
const DEFAULT_MOTION_BUCKET_ID = 127; // SVD's own documented default

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function replicateRequest(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: API_HOSTNAME,
      port: API_PORT,
      path: reqPath,
      method,
      headers: {
        'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = httpsOrHttp.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (e) {
          reject({ statusCode: res.statusCode, message: `Non-JSON response: ${e.message}` });
          return;
        }
        resolve({ statusCode: res.statusCode, body: json });
      });
    });
    req.on('error', err => reject({ statusCode: 0, message: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    httpsOrHttp.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function imageToDataUri(imagePath) {
  const ext = (imagePath.split('.').pop() || 'png').toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  const b64 = fs.readFileSync(imagePath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

async function generate({ sourceImagePath, animationStyle, outputPath }) {
  const startedAt = Date.now();

  if (!REPLICATE_API_TOKEN) {
    return { success: false, statusCode: 401, error: 'REPLICATE_API_TOKEN not set' };
  }
  if (!sourceImagePath || !fs.existsSync(sourceImagePath)) {
    return { success: false, statusCode: 422, error: `svd requires an existing sourceImagePath (got: ${sourceImagePath})` };
  }

  const motionBucketId = ANIMATION_STYLE_TO_MOTION[animationStyle] ?? DEFAULT_MOTION_BUCKET_ID;

  try {
    const inputImage = imageToDataUri(sourceImagePath);

    const create = await replicateRequest('POST', '/v1/predictions', {
      version: MODEL_VERSION,
      input: {
        input_image: inputImage,
        video_length: '14_frames_with_svd',
        sizing_strategy: 'maintain_aspect_ratio',
        frames_per_second: 6,
        motion_bucket_id: motionBucketId,
        cond_aug: 0.02,
        decoding_t: 7,
      },
    });

    if (create.statusCode >= 400) {
      return {
        success: false,
        statusCode: create.statusCode,
        error: (create.body && (create.body.detail || create.body.title)) || `Replicate returned HTTP ${create.statusCode}`,
      };
    }

    const predictionId = create.body.id;
    let prediction = create.body;
    const deadline = Date.now() + MAX_WAIT_MS;

    while (prediction.status === 'starting' || prediction.status === 'processing') {
      if (Date.now() > deadline) {
        return { success: false, statusCode: 0, error: `svd prediction ${predictionId} timed out after ${MAX_WAIT_MS}ms` };
      }
      await sleep(POLL_INTERVAL_MS);
      const poll = await replicateRequest('GET', `/v1/predictions/${predictionId}`);
      if (poll.statusCode >= 400) {
        return { success: false, statusCode: poll.statusCode, error: `Poll failed: HTTP ${poll.statusCode}` };
      }
      prediction = poll.body;
    }

    if (prediction.status !== 'succeeded') {
      return {
        success: false,
        statusCode: 500,
        error: (prediction.error && String(prediction.error)) || `Prediction ended with status "${prediction.status}"`,
      };
    }

    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!outputUrl) {
      return { success: false, statusCode: 500, error: 'Prediction succeeded but returned no output URL' };
    }

    await downloadFile(outputUrl, outputPath);

    return {
      success: true,
      path: outputPath,
      provider: 'svd',
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const statusCode = (err && typeof err.statusCode === 'number') ? err.statusCode : 0;
    const message = (err && err.message) || String(err);
    return { success: false, statusCode, error: message };
  }
}

module.exports = { generate };
