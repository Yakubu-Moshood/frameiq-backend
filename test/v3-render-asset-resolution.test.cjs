'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAssetPath } = require('../pipeline-updates/surface-renderer.cjs');
const { resolveProductionAssetLocation } = require('../pipeline-updates/production-method-manifest.cjs');

test('V3 renderer resolves only manifest-selected evidence and primary graphic files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-render-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = path.join(root, 'verified-source.png');
  fs.writeFileSync(evidence, 'approved evidence fixture');
  const graphicsDir = path.join(root, 'graphics');
  fs.mkdirSync(graphicsDir);
  const primary = path.join(graphicsDir, 'ACT1_001__g00.svg');
  fs.writeFileSync(primary, '<svg/>');
  const assetsDir = root;

  assert.equal(resolveAssetPath({
    shotId: 'ACT1_001',
    productionMethod: 'EVIDENCE_REFERENCE',
    evidenceAssetPath: evidence,
  }, assetsDir), evidence);
  assert.equal(resolveAssetPath({
    shotId: 'ACT1_001',
    productionMethod: 'GRAPHIC_COMPILATION',
    graphicAssetEntries: [{ shotId: 'ACT1_001', graphicIndex: 0, filename: 'ACT1_001__g00.svg', role: 'PRIMARY' }],
  }, assetsDir), primary);
  assert.deepEqual(resolveProductionAssetLocation('GRAPHIC_COMPILATION').extensions, ['.mp4', '.png', '.jpg', '.svg']);
});

test('V3 renderer does not guess an evidence or graphic asset when verified manifest attachment is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-render-assets-empty-'));
  try {
    assert.equal(resolveAssetPath({ shotId: 'ACT1_001', productionMethod: 'EVIDENCE_REFERENCE' }, root), null);
    assert.equal(resolveAssetPath({ shotId: 'ACT1_001', productionMethod: 'GRAPHIC_COMPILATION', graphicAssetEntries: [] }, root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
