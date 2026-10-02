'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const productionMethods = require('./production-method-manifest.cjs');

function fail(condition, code) { if (!condition) throw new Error(code); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function assertRegularFile(filePath, root, fsImpl) {
  fail(typeof filePath === 'string' && inside(root, filePath), 'PHASE3_MEDIA_PATH_OUTSIDE_ASSETS');
  fail(fsImpl.existsSync(filePath), `PHASE3_MEDIA_FILE_MISSING:${path.basename(filePath || '')}`);
  let current = path.resolve(filePath);
  const stop = path.resolve(root);
  const chain = [];
  while (inside(stop, current)) {
    chain.push(current);
    if (current === stop) break;
    current = path.dirname(current);
  }
  fail(chain.at(-1) === stop, 'PHASE3_MEDIA_PATH_OUTSIDE_ASSETS');
  for (const item of chain.reverse()) {
    const stat = fsImpl.lstatSync(item);
    fail(!stat.isSymbolicLink(), `PHASE3_MEDIA_SYMLINK_FORBIDDEN:${path.relative(stop, item)}`);
  }
  const stat = fsImpl.lstatSync(filePath);
  fail(stat.isFile(), `PHASE3_MEDIA_NOT_REGULAR_FILE:${path.basename(filePath)}`);
  return fsImpl.readFileSync(filePath);
}
function has(buffer, signature) { return buffer.subarray(0, signature.length).equals(signature); }
function classifyMedia({ filePath, bytes, expectedMimeType = null, approvedSvg = false }) {
  const ext = path.extname(filePath).toLowerCase();
  let mediaType, strategy;
  if (ext === '.html' && /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/iu.test(bytes.toString('utf8').slice(0, 4096))) {
    mediaType = 'text/html'; strategy = 'DOCUMENT_CARD';
  } else if (ext === '.pdf' && has(bytes, Buffer.from('%PDF-'))) {
    mediaType = 'application/pdf'; strategy = 'DOCUMENT_CARD';
  } else if (ext === '.svg' && approvedSvg && /<svg\b/iu.test(bytes.toString('utf8').slice(0, 8192))) {
    mediaType = 'image/svg+xml'; strategy = 'RASTERIZE_APPROVED_SVG';
  } else if (ext === '.png' && has(bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    mediaType = 'image/png'; strategy = 'STILL_IMAGE';
  } else if (['.jpg', '.jpeg'].includes(ext) && has(bytes, Buffer.from([0xff, 0xd8, 0xff]))) {
    mediaType = 'image/jpeg'; strategy = 'STILL_IMAGE';
  } else if (ext === '.webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    mediaType = 'image/webp'; strategy = 'STILL_IMAGE';
  } else if (['.mp4', '.m4v', '.mov'].includes(ext) && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    mediaType = ext === '.mov' ? 'video/quicktime' : 'video/mp4'; strategy = 'VIDEO_CLIP';
  } else if (['.webm', '.mkv'].includes(ext) && has(bytes, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    mediaType = ext === '.webm' ? 'video/webm' : 'video/x-matroska'; strategy = 'VIDEO_CLIP';
  } else {
    throw new Error(`PHASE3_MEDIA_TYPE_UNSUPPORTED:${ext || '(no extension)'}`);
  }
  if (expectedMimeType && expectedMimeType !== mediaType) {
    throw new Error(`PHASE3_MEDIA_MIME_EXTENSION_MISMATCH:${expectedMimeType}:${mediaType}`);
  }
  return { mediaType, strategy, extension: ext };
}
function wrapText(value, maxChars) {
  const words = String(value || '').replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
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
function xml(value) {
  return String(value || '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}
function buildDocumentCardSvg(entry) {
  fail(entry && typeof entry.sourceTitle === 'string' && entry.sourceTitle.trim()
    && typeof entry.publisher === 'string' && entry.publisher.trim()
    && typeof entry.excerptOrTimecode === 'string' && entry.excerptOrTimecode.trim(),
  `PHASE3_DOCUMENT_CARD_METADATA_MISSING:${entry?.shotId || ''}`);
  const titleLines = wrapText(entry.sourceTitle, 46);
  const excerptLines = wrapText(entry.excerptOrTimecode, 76);
  fail(titleLines.length <= 2, `PHASE3_DOCUMENT_CARD_TITLE_OVERFLOW:${entry.shotId || ''}`);
  fail(excerptLines.length <= 8, `PHASE3_DOCUMENT_CARD_EXCERPT_OVERFLOW:${entry.shotId || ''}`);
  const lines = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">',
    '<rect width="1920" height="1080" fill="#101820"/>',
    '<rect x="96" y="88" width="1728" height="904" rx="18" fill="#f7f5ef"/>',
    '<text x="160" y="180" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#9b6a16">APPROVED SOURCE DOCUMENT</text>',
    '<line x1="160" y1="218" x2="1760" y2="218" stroke="#c5b99f" stroke-width="3"/>',
  ];
  titleLines.forEach((line, index) => lines.push(`<text x="160" y="${300 + index * 66}" font-family="Arial,sans-serif" font-size="52" font-weight="700" fill="#17212b">${xml(line)}</text>`));
  const publisherY = 300 + titleLines.length * 66 + 22;
  lines.push(`<text x="160" y="${publisherY}" font-family="Arial,sans-serif" font-size="30" fill="#43515e">${xml(entry.publisher)}${entry.publicationDate ? ` · ${xml(entry.publicationDate)}` : ''}</text>`);
  lines.push('<text x="160" y="500" font-family="Arial,sans-serif" font-size="29" font-weight="700" fill="#17212b">APPROVED EXCERPT</text>');
  excerptLines.forEach((line, index) => lines.push(`<text x="160" y="${556 + index * 48}" font-family="Arial,sans-serif" font-size="29" fill="#273541">${xml(line)}</text>`));
  lines.push(`<text x="160" y="930" font-family="Arial,sans-serif" font-size="23" fill="#697783">${xml(entry.sourceTitle)} — ${xml(entry.publisher)}</text>`);
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}
function expectedStrategyForMissingAsset(method, evidence, primary) {
  if (method === 'CONTROLLED_STILL' || method === 'GENERATED_STILL') return 'STILL_IMAGE';
  if (method === 'ESSENTIAL_ANIMATION') return 'VIDEO_CLIP';
  const mime = evidence?.mimeType || primary?.mimeType;
  if (mime === 'text/html' || mime === 'application/pdf') return 'DOCUMENT_CARD';
  if (mime === 'image/svg+xml') return 'RASTERIZE_APPROVED_SVG';
  if (mime?.startsWith('image/')) return 'STILL_IMAGE';
  if (mime?.startsWith('video/')) return 'VIDEO_CLIP';
  return null;
}
function censusPhase3RenderInputs({ resolvedShots, assetsDir, approvedFiles = null,
  requireApprovedBindings = false, fsImpl = fs }) {
  fail(Array.isArray(resolvedShots) && resolvedShots.length === 153, 'PHASE3_RENDER_CENSUS_SHOT_COUNT_INVALID');
  const seen = new Set();
  const entries = resolvedShots.map(shot => {
    fail(shot?.shotId && shot?.beatId && !seen.has(shot.shotId), `PHASE3_RENDER_CENSUS_SHOT_DUPLICATE:${shot?.shotId || ''}`);
    seen.add(shot.shotId);
    const sourcePath = shot.phase3BaseAssetPath;
    const method = shot.productionMethod;
    const evidence = shot.phase3EvidenceEntry || null;
    const primary = (shot.graphicAssetEntries || []).find(item => item.role === 'PRIMARY') || null;
    const supportingAssets = [];
    for (const graphic of shot.graphicAssetEntries || []) {
      const graphicPath = path.resolve(assetsDir, 'graphics', graphic.filename);
      const graphicBytes = assertRegularFile(graphicPath, path.join(assetsDir, 'graphics'), fsImpl);
      fail(sha256(graphicBytes) === graphic.sha256, `PHASE3_MEDIA_GRAPHIC_HASH_MISMATCH:${shot.beatId}:${graphic.graphicIndex}`);
      if (requireApprovedBindings) {
        const indexed = approvedFiles?.find(item => item.path === `assets/graphics/${graphic.filename}`);
        fail(indexed && indexed.bytes === graphicBytes.length && indexed.sha256 === sha256(graphicBytes),
          `PHASE3_MEDIA_GRAPHIC_NOT_BOUND_TO_PROMOTED_INDEX:${shot.beatId}:${graphic.graphicIndex}`);
      }
      const graphicType = classifyMedia({ filePath: graphicPath, bytes: graphicBytes,
        expectedMimeType: graphic.mimeType || 'image/svg+xml', approvedSvg: true });
      fail(graphicType.strategy === 'RASTERIZE_APPROVED_SVG', `PHASE3_MEDIA_GRAPHIC_STRATEGY_INVALID:${shot.beatId}:${graphic.graphicIndex}`);
      supportingAssets.push({ role: graphic.role, path: `assets/graphics/${path.basename(graphicPath)}`,
        sha256: graphic.sha256, mediaType: graphicType.mediaType, strategy: graphicType.strategy });
    }
    if (!sourcePath) {
      const location = productionMethods.resolveProductionAssetLocation(method);
      const outputKind = location?.directory === 'clips' ? 'clip' : location?.directory === 'stills' ? 'still' : null;
      return { actKey: shot.actKey, beatId: shot.beatId, shotId: shot.shotId,
      productionMethod: method, sourcePath: null, sourceSha256: null, mediaType: null,
      strategy: expectedStrategyForMissingAsset(method, evidence, primary), status: 'MISSING_BASE_ASSET', outputKind,
      expectedPaths: location ? location.extensions.map(extension => `assets/${location.directory}/${shot.shotId}${extension}`) : [],
      supportingAssets };
    }
    const bytes = assertRegularFile(sourcePath, assetsDir, fsImpl);
    const expectedHash = evidence?.sha256 || (method === 'GRAPHIC_COMPILATION' ? primary?.sha256 : null);
    fail(!expectedHash || sha256(bytes) === expectedHash,
      `PHASE3_MEDIA_APPROVED_ASSET_HASH_MISMATCH:${shot.beatId}`);
    const classification = classifyMedia({ filePath: sourcePath, bytes,
      expectedMimeType: evidence?.mimeType || (method === 'GRAPHIC_COMPILATION' ? primary?.mimeType : null),
      approvedSvg: Boolean(evidence || primary) });
    if (['text/html', 'application/pdf'].includes(classification.mediaType)) {
      fail(Boolean(evidence), `PHASE3_DOCUMENT_CARD_NOT_APPROVED_EVIDENCE:${shot.beatId}`);
      buildDocumentCardSvg({ ...evidence, shotId: shot.shotId });
    }
    const relativePath = `assets/${path.relative(assetsDir, sourcePath).split(path.sep).join('/')}`;
    const indexedBinding = Array.isArray(approvedFiles) ? approvedFiles.find(item => item.path === relativePath) : null;
    const bindingMatches = !requireApprovedBindings || Boolean(indexedBinding
      && indexedBinding.bytes === bytes.length && indexedBinding.sha256 === sha256(bytes));
    return { actKey: shot.actKey, beatId: shot.beatId, shotId: shot.shotId, productionMethod: method,
      sourcePath: `assets/${path.relative(assetsDir, sourcePath).split(path.sep).join('/')}`,
      sourceSha256: sha256(bytes), mediaType: classification.mediaType, strategy: classification.strategy,
      status: bindingMatches ? 'READY' : 'UNBOUND_OR_HASH_MISMATCH',
      ...(!bindingMatches ? { bindingError: 'NOT_BOUND_TO_PROMOTED_CANDIDATE_INDEX' } : {}), supportingAssets,
      ...(evidence ? { evidenceTitle: evidence.sourceTitle, evidencePublisher: evidence.publisher,
        evidenceExcerpt: evidence.excerptOrTimecode } : {}) };
  });
  const strategyNames = ['DOCUMENT_CARD', 'RASTERIZE_APPROVED_SVG', 'STILL_IMAGE', 'VIDEO_CLIP'];
  const ready = entries.filter(item => item.status === 'READY');
  const unresolved = entries.filter(item => item.status !== 'READY');
  const countsByFinalStrategy = Object.fromEntries(strategyNames.map(strategy => [strategy,
    entries.filter(item => item.strategy === strategy).length]));
  const resolvedCountsByFinalStrategy = Object.fromEntries(strategyNames.map(strategy => [strategy,
    ready.filter(item => item.strategy === strategy).length]));
  const strategies = Object.fromEntries(Object.entries(resolvedCountsByFinalStrategy).filter(([, count]) => count > 0));
  const mediaInputsByBinding = new Map();
  for (const item of ready) {
    mediaInputsByBinding.set(`${item.sourcePath}:${item.sourceSha256}`, { mediaType: item.mediaType, strategy: item.strategy });
    for (const asset of item.supportingAssets) mediaInputsByBinding.set(`${asset.path}:${asset.sha256}`, asset);
  }
  const mediaInputs = [...mediaInputsByBinding.values()];
  const missingStillOutputs = unresolved.filter(item => item.outputKind === 'still');
  const missingClipOutputs = unresolved.filter(item => item.outputKind === 'clip');
  const summary = {
    totalShotsChecked: entries.length, countsByFinalStrategy, resolvedCountsByFinalStrategy,
    documentCards: ready.filter(item => item.strategy === 'DOCUMENT_CARD').length,
    htmlDocuments: ready.filter(item => item.mediaType === 'text/html').length,
    pdfDocuments: ready.filter(item => item.mediaType === 'application/pdf').length,
    svgAssets: mediaInputs.filter(item => item.mediaType === 'image/svg+xml').length,
    graphicSvgAssets: new Set(entries.flatMap(item => item.supportingAssets
      .filter(asset => asset.mediaType === 'image/svg+xml').map(asset => `${asset.path}:${asset.sha256}`))).size,
    evidenceSvgAssets: new Set(ready.filter(item => item.mediaType === 'image/svg+xml'
      && item.productionMethod === 'EVIDENCE_REFERENCE').map(item => `${item.sourcePath}:${item.sourceSha256}`)).size,
    rasterStillAssets: ready.filter(item => ['STILL_IMAGE'].includes(item.strategy)).length,
    videoClipAssets: ready.filter(item => item.strategy === 'VIDEO_CLIP').length,
    missingStillOutputs: missingStillOutputs.length, missingClipOutputs: missingClipOutputs.length,
    unboundMediaAssets: unresolved.filter(item => item.status === 'UNBOUND_OR_HASH_MISMATCH').length,
    missingStillOutputsByMethod: Object.fromEntries(['CONTROLLED_STILL', 'GENERATED_STILL'].map(method =>
      [method, missingStillOutputs.filter(item => item.productionMethod === method).length])),
    missingStillBeatIds: missingStillOutputs.map(item => item.beatId),
    missingClipBeatIds: missingClipOutputs.map(item => item.beatId),
    resolvedCount: ready.length, unresolvedCount: unresolved.length,
    unresolvedBeatIds: unresolved.map(item => item.beatId),
  };
  return { activeShotCount: entries.length, entries, strategies, summary,
    readyCount: ready.length, unresolved };
}

function resolvePhase3RenderShots({ resolvedShots, assetsDir, evidenceManifest, graphicAssetManifest,
  resolveAssetPath, fsImpl = fs }) {
  fail(typeof resolveAssetPath === 'function', 'PHASE3_MEDIA_RESOLVER_REQUIRED');
  const evidenceEntries = evidenceManifest?.entries;
  const graphicEntries = graphicAssetManifest?.entries;
  fail(Array.isArray(evidenceEntries) && evidenceEntries.length === 46,
    'PHASE3_MEDIA_EVIDENCE_MANIFEST_INVALID');
  fail(Array.isArray(graphicEntries) && graphicEntries.length === 76,
    'PHASE3_MEDIA_GRAPHIC_MANIFEST_INVALID');
  const shotById = new Map(resolvedShots.map(shot => [shot.shotId, shot]));
  fail(shotById.size === 153 && Array.isArray(resolvedShots) && resolvedShots.length === 153,
    'PHASE3_MEDIA_ACTIVE_SHOT_SET_INVALID');
  const evidenceByShot = new Map();
  for (const entry of evidenceEntries) {
    const shot = shotById.get(entry.shotId);
    fail(shot && !evidenceByShot.has(entry.shotId) && shot.assetType === 'evidence_reference'
      && typeof entry.localFilename === 'string'
      && /^[a-f0-9]{64}$/u.test(entry.sha256 || ''),
    `PHASE3_MEDIA_EVIDENCE_OWNER_INVALID:${entry?.shotId || ''}`);
    evidenceByShot.set(entry.shotId, entry);
  }
  const graphicsByShot = new Map();
  const graphicIds = new Set();
  for (const entry of graphicEntries) {
    const shot = shotById.get(entry.shotId);
    const key = `${entry.shotId}:${entry.graphicIndex}`;
    fail(shot && entry.beatId === shot.beatId && entry.actKey === shot.actKey
      && !graphicIds.has(key) && typeof entry.filename === 'string'
      && /^[a-f0-9]{64}$/u.test(entry.sha256 || ''),
    `PHASE3_MEDIA_GRAPHIC_OWNER_INVALID:${key}`);
    graphicIds.add(key);
    if (!graphicsByShot.has(entry.shotId)) graphicsByShot.set(entry.shotId, []);
    graphicsByShot.get(entry.shotId).push(entry);
  }
  return resolvedShots.map(shot => {
    const evidence = evidenceByShot.get(shot.shotId) || null;
    const graphics = graphicsByShot.get(shot.shotId) || [];
    const withManifests = { ...shot,
      ...(evidence ? { evidenceAssetPath: path.join(assetsDir, 'evidence', evidence.localFilename),
        phase3EvidenceEntry: evidence } : {}),
      ...(graphics.length ? { graphicAssetEntries: graphics } : {}),
    };
    const location = productionMethods.resolveProductionAssetLocation(shot.productionMethod);
    if (location && ['stills', 'clips'].includes(location.directory)) {
      const candidates = location.extensions.map(extension => path.join(assetsDir, location.directory,
        `${shot.shotId}${extension}`)).filter(candidate => fsImpl.existsSync(candidate));
      fail(candidates.length <= 1, `PHASE3_MEDIA_ASSET_AMBIGUOUS:${shot.beatId}`);
    }
    const basePath = resolveAssetPath(withManifests, assetsDir);
    if (location && ['stills', 'clips'].includes(location.directory) && basePath) {
      const allowed = location.extensions.map(extension => path.resolve(assetsDir, location.directory,
        `${shot.shotId}${extension}`));
      fail(allowed.includes(path.resolve(basePath)), `PHASE3_MEDIA_ASSET_PATH_UNEXPECTED:${shot.beatId}`);
    }
    if (basePath) assertRegularFile(basePath, assetsDir, fsImpl);
    return { ...withManifests, phase3BaseAssetPath: basePath || null };
  });
}
function preparePhase3RenderInputs({ resolvedShots, assetsDir, derivedAssetDir, isolatedRunDirectory,
  approvedFiles = null, requireApprovedBindings = false, fsImpl = fs }) {
  const census = censusPhase3RenderInputs({ resolvedShots, assetsDir, approvedFiles,
    requireApprovedBindings, fsImpl });
  fail(census.unresolved.length === 0, `PHASE3_RENDER_INPUTS_UNRESOLVED:${census.unresolved.map(item => item.beatId).join(',')}`);
  fail(isolatedRunDirectory && inside(isolatedRunDirectory, derivedAssetDir)
    && path.resolve(derivedAssetDir) !== path.resolve(isolatedRunDirectory), 'PHASE3_DERIVED_ASSET_DIRECTORY_OUTSIDE_RUN');
  const resolvedById = new Map(resolvedShots.map(shot => [shot.shotId, shot]));
  const preparedCensus = [];
  let documentIndex = 0;
  for (const entry of census.entries) {
    const shot = resolvedById.get(entry.shotId);
    const prepared = { ...shot, phase3PreviewAsset: true, phase3MediaStrategy: entry.strategy };
    if (entry.strategy === 'DOCUMENT_CARD') {
      const original = shot.phase3EvidenceEntry;
      const bytes = assertRegularFile(shot.phase3BaseAssetPath, assetsDir, fsImpl);
      fail(sha256(bytes) === original.sha256, `PHASE3_MEDIA_APPROVED_ASSET_HASH_MISMATCH:${shot.beatId}`);
      const svg = Buffer.from(buildDocumentCardSvg(original), 'utf8');
      if (documentIndex === 0) {
        fsImpl.mkdirSync(path.dirname(derivedAssetDir), { recursive: true });
        fsImpl.mkdirSync(derivedAssetDir, { recursive: false });
      }
      const filename = `${shot.shotId}__approved-source-card.svg`;
      const target = path.join(derivedAssetDir, filename);
      fsImpl.writeFileSync(target, svg, { flag: 'wx', mode: 0o600 });
      prepared.evidenceAssetPath = target;
      prepared.phase3StillInput = true;
      entry.derivedAssetPath = path.relative(isolatedRunDirectory, target).split(path.sep).join('/');
      entry.derivedAssetSha256 = sha256(svg);
      documentIndex += 1;
    } else {
      prepared.evidenceAssetPath = shot.phase3BaseAssetPath;
      prepared.phase3StillInput = ['STILL_IMAGE', 'RASTERIZE_APPROVED_SVG'].includes(entry.strategy);
    }
    preparedCensus.push(entry);
    resolvedById.set(shot.shotId, prepared);
  }
  return { shots: resolvedShots.map(shot => resolvedById.get(shot.shotId)), census: {
    activeShotCount: census.activeShotCount, resolvedAssetCount: census.readyCount,
    strategies: Object.fromEntries([...new Set(census.entries.map(item => item.strategy))].sort()
      .map(strategy => [strategy, census.entries.filter(item => item.strategy === strategy).length])),
    entries: preparedCensus,
  } };
}

module.exports = { classifyMedia, buildDocumentCardSvg, censusPhase3RenderInputs, resolvePhase3RenderShots,
  preparePhase3RenderInputs, sha256 };
