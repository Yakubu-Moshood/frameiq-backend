'use strict';

/**
 * routes/preview.js
 * Sprint 2A Phase B — Preview System
 *
 * Endpoints:
 *   GET /api/episodes/:id/preview/seek-map
 *     Returns act start times derived from VO_Act*.mp3 audio durations.
 *     Uses ffprobe (same binary used by the Short Extractor pipeline).
 *     Returns warnings instead of throwing for missing VO files.
 *
 * No regeneration. No pipeline changes. No renderer changes.
 * Protected by requireAuth.
 */

const express         = require('express');
const path            = require('path');
const fs              = require('fs');
const { execFile }    = require('child_process');
const { queries }     = require('../db');
const { requireAuth } = require('../middleware/auth');
const { EPISODES_DIR } = require('../startup-init');

const router = express.Router({ mergeParams: true });

// ffprobe binary — matches Short Extractor pattern exactly
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// VO filenames in playback order — matches Short Extractor's ACTS_BEFORE_ACT4 pattern
// VO_Act3B.mp3 is optional (not all episodes have a 3b split)
const VO_FILES = [
  { act: 1, filename: 'VO_Act1.mp3',  required: true  },
  { act: 2, filename: 'VO_Act2.mp3',  required: true  },
  { act: 3, filename: 'VO_Act3.mp3',  required: true  },
  { act: 3, filename: 'VO_Act3B.mp3', required: false },  // optional 3b split
  { act: 4, filename: 'VO_Act4.mp3',  required: true  },
  { act: 5, filename: 'VO_Act5.mp3',  required: true  },
];

/**
 * Get audio duration in seconds using ffprobe.
 * Returns null (with a warning) if the file cannot be probed.
 */
function probeDuration(filePath) {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        filePath,
      ],
      { maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const duration = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
      }
    );
  });
}

// ─── GET /api/episodes/:id/preview/seek-map ───────────────────────────────────

router.get('/seek-map', requireAuth, async (req, res) => {
  const { id: episodeId } = req.params;

  // Resolve episode and verify ownership
  let episode;
  try {
    episode = await queries.getEpisode(episodeId);
  } catch (err) {
    console.error('[preview] getEpisode error:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }

  if (!episode) return res.status(404).json({ error: 'Episode not found' });
  if (episode.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });

  // Episode must be complete for preview to be meaningful
  if (episode.status !== 'complete') {
    return res.json({
      acts:     [],
      warnings: ['Episode is not yet complete — no preview available'],
      ready:    false,
    });
  }

  // Resolve episode directory on the Railway Volume
  const episodeDir = path.join(
    EPISODES_DIR,
    `${episode.channel}_${episode.episode_id}`
  );
  const audioDir = path.join(episodeDir, 'assets', 'audio');

  if (!fs.existsSync(audioDir)) {
    return res.json({
      acts:     [],
      warnings: [`Audio directory not found: ${audioDir}`],
      ready:    false,
    });
  }

  // Probe each VO file — collect durations and warnings
  const acts   = [];
  const warnings = [];
  let cumulative = 0;  // running total of seconds — act start position in FINAL.mp4
  let actIndex  = 0;

  for (const vo of VO_FILES) {
    const filePath = path.join(audioDir, vo.filename);

    if (!fs.existsSync(filePath)) {
      if (vo.required) {
        warnings.push(`Missing required VO file: ${vo.filename}`);
      }
      // Optional files (VO_Act3B.mp3) — silently skip
      continue;
    }

    const duration = await probeDuration(filePath);

    if (duration === null) {
      warnings.push(`Could not read duration of ${vo.filename} — ffprobe returned no data`);
      continue;
    }

    // If this is act 3b (same act number as act 3), merge into a combined act 3 entry
    const existingAct = acts.find(a => a.act === vo.act);
    if (existingAct) {
      // Act 3b — extend the duration of the act 3 entry
      existingAct.durationSeconds = Math.round((existingAct.durationSeconds + duration) * 10) / 10;
    } else {
      acts.push({
        act:             vo.act,
        label:           `Act ${vo.act}`,
        startSeconds:    Math.round(cumulative * 10) / 10,
        durationSeconds: Math.round(duration * 10) / 10,
      });
    }

    cumulative += duration;
    actIndex++;
  }

  // Also confirm FINAL.mp4 exists — the player needs it
  const finalVideoPath = episode.output_path;
  if (!finalVideoPath || !fs.existsSync(finalVideoPath)) {
    warnings.push('FINAL.mp4 not found — video player cannot load');
  }

  const ready = acts.length > 0 && (!finalVideoPath || fs.existsSync(finalVideoPath));

  console.log(
    `[preview] seek-map episode=${episodeId} acts=${acts.length} warnings=${warnings.length} ready=${ready}`
  );

  return res.json({
    acts,
    warnings,
    ready,
    // Include the download URL so the frontend can load the video
    videoUrl: ready
      ? `${process.env.BACKEND_URL || ''}/api/episodes/${episodeId}/download`
      : null,
  });
});

module.exports = router;
