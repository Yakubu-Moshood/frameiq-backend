'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GRAPHIC_TEMPLATES = Object.freeze({
  impact_card: { role: 'primary-or-overlay', animation: 'opacity-fade-and-scale' },
  date_marker: { role: 'primary-or-overlay', animation: 'timeline-marker-reveal' },
  chapter_marker: { role: 'primary-or-overlay', animation: 'chapter-title-reveal' },
  data_graphic: { role: 'primary-or-overlay', animation: 'deterministic-data-reveal' },
  document_callout: { role: 'primary-or-overlay', animation: 'document-highlight-reveal' },
  identity_lower_third: { role: 'primary-or-overlay', animation: 'lower-third-slide-in' },
  direct_quote: { role: 'primary-or-overlay', animation: 'quote-reveal' },
  takeaway: { role: 'primary-or-overlay', animation: 'takeaway-reveal' },
  source_citation: { role: 'primary-or-overlay', animation: 'citation-fade-in' },
});

function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function escapeXml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]); }
function deterministicGraphicFilename(shotId, graphicIndex) {
  if (!/^[A-Za-z0-9_-]+$/.test(shotId || '') || !Number.isInteger(graphicIndex) || graphicIndex < 0) throw new Error('[graphics][GRAPHIC_FILENAME_INPUT_INVALID] shotId and zero-based graphicIndex are required.');
  return `${shotId}__g${String(graphicIndex).padStart(2, '0')}.svg`;
}
function splitForDisplay(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
function compileGraphic({ shotId, graphicIndex, graphic, role, brandConfig, durationSec = null, width, height }) {
  if (!graphic || typeof graphic !== 'object' || Array.isArray(graphic)) throw new Error('[graphics][GRAPHIC_OBJECT_INVALID] Graphic object is required.');
  const template = GRAPHIC_TEMPLATES[graphic.type];
  if (!template) throw new Error(`[graphics][GRAPHIC_TYPE_UNSUPPORTED] Unsupported graphic type ${graphic.type || '(missing)'}.`);
  if (typeof graphic.text !== 'string' || !graphic.text.trim()) throw new Error(`[graphics][GRAPHIC_TEXT_MISSING] ${graphic.type} requires non-empty exact text.`);
  if (typeof graphic.intent !== 'string' || !graphic.intent.trim()) throw new Error(`[graphics][GRAPHIC_INTENT_MISSING] ${graphic.type} requires a non-empty intent.`);
  if (!brandConfig || typeof brandConfig !== 'object' || Array.isArray(brandConfig)) throw new Error('[graphics][GRAPHIC_BRAND_CONFIG_REQUIRED] Supply channel brand configuration.');
  if (!['PRIMARY', 'OVERLAY'].includes(role)) throw new Error('[graphics][GRAPHIC_ROLE_INVALID] role must be PRIMARY or OVERLAY.');
  const w = width || brandConfig.width || 1920;
  const h = height || brandConfig.height || 1080;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error('[graphics][GRAPHIC_DIMENSIONS_INVALID] Width and height must be positive integers.');
  const palette = brandConfig.palette || {};
  for (const key of ['background', 'foreground', 'accent', 'muted']) if (typeof palette[key] !== 'string' || !palette[key]) throw new Error(`[graphics][GRAPHIC_BRAND_COLOR_MISSING] brandConfig.palette.${key} is required.`);
  const filename = deterministicGraphicFilename(shotId, graphicIndex);
  const lines = splitForDisplay(graphic.text, Math.max(18, Math.floor(w / 28)));
  const font = escapeXml(brandConfig.fontFamily || 'sans-serif');
  const fontSize = Math.min(Number(brandConfig.fontSize) || 72, Math.floor(w / 14));
  const center = graphic.type !== 'identity_lower_third' && graphic.type !== 'source_citation';
  const y0 = center ? h * 0.5 - ((lines.length - 1) * fontSize * 0.62) / 2 : h * 0.84;
  const x = center ? w / 2 : w * 0.08;
  const anchors = lines.map((line, i) => `<text x="${x}" y="${y0 + i * fontSize * 1.24}" text-anchor="${center ? 'middle' : 'start'}" font-family="${font}" font-size="${fontSize}" font-weight="700" fill="${escapeXml(palette.foreground)}">${escapeXml(line)}</text>`).join('');
  const backdrop = role === 'PRIMARY'
    ? `<rect x="0" y="0" width="${w}" height="${h}" fill="${escapeXml(palette.background)}"/>`
    : '';
  const accent = `<rect x="${center ? w * 0.38 : w * 0.08}" y="${y0 - fontSize * 0.55}" width="${center ? w * 0.24 : w * 0.12}" height="8" fill="${escapeXml(palette.accent)}"/>`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(graphic.text)}" data-graphic-type="${escapeXml(graphic.type)}" data-role="${role}">${backdrop}${accent}${anchors}</svg>\n`;
  const bytes = Buffer.from(svg, 'utf8');
  return {
    shotId, graphicIndex, filename, relativePath: filename, role, format: 'svg', mimeType: 'image/svg+xml',
    width: w, height: h, durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
    sha256: digest(bytes), sourceGraphic: JSON.parse(JSON.stringify(graphic)), sourceGraphicSha256: digest(JSON.stringify(graphic)),
    renderInstructions: { animation: template.animation, deterministic: true, durationSec: Number.isFinite(durationSec) ? durationSec : null, textIsBurnedFromLockedGraphicObject: true },
    bytes,
  };
}
function compileShotGraphics({ shot, outputDir, brandConfig }) {
  if (!shot || !Array.isArray(shot.graphics)) throw new Error('[graphics][GRAPHIC_SHOT_INVALID] shot.graphics must be an array.');
  fs.mkdirSync(outputDir, { recursive: true });
  return shot.graphics.map((graphic, graphicIndex) => {
    const role = shot.assetType === 'graphic_compilation' && graphicIndex === 0 ? 'PRIMARY' : 'OVERLAY';
    const compiled = compileGraphic({ shotId: shot.shotId, graphicIndex, graphic, role, brandConfig, durationSec: shot.durationSec });
    const filePath = path.join(outputDir, compiled.filename);
    fs.writeFileSync(filePath, compiled.bytes);
    const { bytes, ...entry } = compiled;
    entry.relativePath = compiled.filename;
    return entry;
  });
}
function compilePreviewSet({ graphicFixtures, outputDir, brandConfig }) {
  const entries = [];
  for (const fixture of graphicFixtures) {
    entries.push(...compileShotGraphics({ shot: fixture, outputDir, brandConfig }));
  }
  return { manifestVersion: '1.0.0', entries };
}
function validateGraphicAssetManifest({ manifest, shotDefs, graphicAssetDir, shotDefinitionsSha256 = null, fsImpl = fs }) {
  const errors = [];
  const fail = (code, shotId, detail) => errors.push({ code, shotId: shotId || null, detail });
  if (!manifest || manifest.manifestVersion !== '1.0.0' || !Array.isArray(manifest.entries)) return { status: 'FAIL', errors: [{ code: 'GRAPHIC_MANIFEST_INVALID', shotId: null, detail: 'Graphic asset manifest version or entries are invalid.' }] };
  if (!/^[a-f0-9]{64}$/i.test(manifest.sourceShotDefinitionsSha256 || '')) fail('GRAPHIC_SHOT_HASH_INVALID', null, 'sourceShotDefinitionsSha256 must be a SHA-256 digest.');
  if (shotDefinitionsSha256 && manifest.sourceShotDefinitionsSha256 !== shotDefinitionsSha256) fail('GRAPHIC_SHOT_HASH_MISMATCH', null, 'Graphic assets were compiled from different shot definitions.');
  if (manifest.episodeId !== shotDefs?.episodeId) fail('GRAPHIC_EPISODE_MISMATCH', null, 'Graphic asset manifest episodeId does not match shot definitions.');
  const expected = [];
  for (const shot of shotDefs?.allShots || []) for (let i = 0; i < (shot.graphics || []).length; i++) expected.push({ shot, index: i, graphic: shot.graphics[i] });
  const byKey = new Map(manifest.entries.map(entry => [`${entry?.shotId}:${entry?.graphicIndex}`, entry]));
  for (const item of expected) {
    const key = `${item.shot.shotId}:${item.index}`;
    const entry = byKey.get(key);
    if (!entry) { fail('GRAPHIC_ASSET_MISSING', item.shot.shotId, `No compiled asset exists for graphic object ${item.index}.`); continue; }
    if (entry.filename !== deterministicGraphicFilename(item.shot.shotId, item.index)) fail('GRAPHIC_FILENAME_MISMATCH', item.shot.shotId, `Graphic ${item.index} filename is not deterministic.`);
    const expectedRole = item.shot.assetType === 'graphic_compilation' && item.index === 0 ? 'PRIMARY' : 'OVERLAY';
    if (entry.role !== expectedRole) fail('GRAPHIC_ROLE_MISMATCH', item.shot.shotId, `Graphic ${item.index} must be ${expectedRole}.`);
    if (JSON.stringify(entry.sourceGraphic) !== JSON.stringify(item.graphic)) fail('GRAPHIC_SOURCE_MISMATCH', item.shot.shotId, `Graphic ${item.index} does not preserve its locked source object.`);
    const filePath = path.resolve(graphicAssetDir, entry.filename);
    const root = path.resolve(graphicAssetDir);
    if (!filePath.startsWith(root + path.sep)) { fail('GRAPHIC_PATH_UNSAFE', item.shot.shotId, `Graphic path escapes asset directory.`); continue; }
    if (!fsImpl.existsSync(filePath)) { fail('GRAPHIC_FILE_MISSING', item.shot.shotId, `Compiled graphic ${entry.filename} is missing.`); continue; }
    if (digest(fsImpl.readFileSync(filePath)) !== entry.sha256) fail('GRAPHIC_HASH_MISMATCH', item.shot.shotId, `Compiled graphic ${entry.filename} hash does not match.`);
  }
  for (const entry of manifest.entries) if (!expected.some(item => item.shot.shotId === entry?.shotId && item.index === entry?.graphicIndex)) fail('GRAPHIC_ASSET_STALE', entry?.shotId, `Unexpected graphic asset entry ${entry?.graphicIndex}.`);
  return errors.length ? { status: 'FAIL', errors } : { status: 'PASS', errors: [] };
}
module.exports = { GRAPHIC_TEMPLATES, deterministicGraphicFilename, compileGraphic, compileShotGraphics, compilePreviewSet, validateGraphicAssetManifest };
