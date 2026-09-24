'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadEvidenceSourceManifest } = require('./evidence-source-validator.cjs');
const { validateGraphicAssetManifest } = require('./graphic-compiler.cjs');

function throwFirst(prefix, report) {
  if (report.status === 'PASS') return;
  const first = report.errors[0];
  throw new Error(`[${prefix}][${first.code}] ${first.shotId ? `${first.shotId}: ` : ''}${first.detail}`);
}
function loadGraphicAssetManifest({ manifestPath, shotDefsPath, shotDefs = null, graphicAssetDir, fsImpl = fs }) {
  if (!manifestPath || !fsImpl.existsSync(manifestPath)) throw new Error('[graphics][GRAPHIC_MANIFEST_MISSING] Required graphic-asset-manifest.json is missing.');
  if (!shotDefs && (!shotDefsPath || !fsImpl.existsSync(shotDefsPath))) throw new Error('[graphics][SHOT_DEFINITIONS_MISSING] V3 shot definitions are required.');
  const definitions = shotDefs || JSON.parse(fsImpl.readFileSync(shotDefsPath, 'utf8'));
  const shotBytes = shotDefsPath ? fsImpl.readFileSync(shotDefsPath) : null;
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  const shotDefinitionsSha256 = shotBytes ? crypto.createHash('sha256').update(shotBytes).digest('hex') : null;
  const report = validateGraphicAssetManifest({ manifest, shotDefs: definitions, graphicAssetDir, shotDefinitionsSha256, fsImpl });
  throwFirst('graphics', report);
  return manifest;
}
function assertV3EvidenceReady({ episodeDir, shotDefsPath, shotDefs = null, fsImpl = fs }) {
  const evidencePath = path.join(episodeDir, 'evidence-source-manifest.json');
  const assetDir = path.join(episodeDir, 'assets', 'evidence');
  const manifest = loadEvidenceSourceManifest({ manifestPath: evidencePath, shotDefsPath, shotDefs, evidenceAssetDir: assetDir, fsImpl });
  return manifest;
}
function assertV3GraphicsReady({ episodeDir, shotDefsPath, shotDefs = null, fsImpl = fs }) {
  const graphicsPath = path.join(episodeDir, 'graphic-asset-manifest.json');
  const assetDir = path.join(episodeDir, 'assets', 'graphics');
  return loadGraphicAssetManifest({ manifestPath: graphicsPath, shotDefsPath, shotDefs, graphicAssetDir: assetDir, fsImpl });
}
function assertV3AssetsReadyForRender({ episodeDir, shotDefsPath, shotDefs = null, fsImpl = fs }) {
  const evidenceManifest = assertV3EvidenceReady({ episodeDir, shotDefsPath, shotDefs, fsImpl });
  const graphicAssetManifest = assertV3GraphicsReady({ episodeDir, shotDefsPath, shotDefs, fsImpl });
  return { evidenceManifest, graphicAssetManifest };
}
module.exports = { loadGraphicAssetManifest, assertV3EvidenceReady, assertV3GraphicsReady, assertV3AssetsReadyForRender };
