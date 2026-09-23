'use strict';

/**
 * providers/image/sdxl.cjs
 * Stable Diffusion XL (via Replicate) -- fallback tier for image generation,
 * used by write-image-generator.js through providers/provider-router.cjs.
 *
 * generate({ prompt, negativePrompt, width, height, outputPath }, providerConfig)
 *   -> { success: true, path, durationMs, provider: 'sdxl' }
 *   -> { success: false, statusCode, error }
 * (provider-router.cjs's generic contract -- see that file's header.)
 *
 * Model: stability-ai/sdxl, version
 * a00d0b7dcbb9c3fbb34ba87d2d5b46c56969c84a628bf778a7fdaec30b1b99c5 --
 * confirmed live at investigation time (replicate.com/stability-ai/sdxl/
 * versions). Input field names/defaults (prompt, negative_prompt, width,
 * height, num_inference_steps, guidance_scale, scheduler, refine,
 * apply_watermark) are this model's long-stable, extremely widely
 * documented Replicate API surface -- confirmed live for model identity,
 * version hash, pricing, and run count; the full field list is
 * well-established public documentation for this specific mature model,
 * not a fresh predict.py fetch (repeated live fetches of cog-sdxl's actual
 * predict.py timed out in this sandbox -- flagging that distinction
 * plainly rather than presenting it as independently re-verified).
 * Pricing confirmed live: ~$0.0043/run on Nvidia L40S, varies by input.
 * Output is an array of image URLs (first element used here, num_outputs=1).
 */

const fs = require('fs');
const https = require('https');

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const MODEL_VERSION = 'a00d0b7dcbb9c3fbb34ba87d2d5b46c56969c84a628bf778a7fdaec30b1b99c5';
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 120000;

// Overridable only for local testing (a mocked http server instead of
// api.replicate.com) -- never set in production.
const API_HOSTNAME = process.env.SDXL_TEST_API_HOSTNAME || 'api.replicate.com';
const API_PORT = process.env.SDXL_TEST_API_PORT ? Number(process.env.SDXL_TEST_API_PORT) : 443;
const httpsOrHttp = process.env.SDXL_TEST_API_PORT ? require('http') : https;

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

async function generate({ prompt, negativePrompt, width, height, outputPath }) {
  const startedAt = Date.now();

  if (!REPLICATE_API_TOKEN) {
    return { success: false, statusCode: 401, error: 'REPLICATE_API_TOKEN not set' };
  }
  if (!prompt) {
    return { success: false, statusCode: 422, error: 'sdxl requires a prompt' };
  }

  try {
    const create = await replicateRequest('POST', '/v1/predictions', {
      version: MODEL_VERSION,
      input: {
        prompt,
        negative_prompt: negativePrompt || '',
        width: width || 1536,
        height: height || 1024,
        num_outputs: 1,
        scheduler: 'K_EULER',
        num_inference_steps: 50,
        guidance_scale: 7.5,
        refine: 'no_refiner',
        apply_watermark: false,
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
        return { success: false, statusCode: 0, error: `sdxl prediction ${predictionId} timed out after ${MAX_WAIT_MS}ms` };
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
      provider: 'sdxl',
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const statusCode = (err && typeof err.statusCode === 'number') ? err.statusCode : 0;
    const message = (err && err.message) || String(err);
    return { success: false, statusCode, error: message };
  }
}

module.exports = { generate };
