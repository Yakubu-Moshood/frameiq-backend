'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertV3EvidenceReady, assertV3GraphicsReady, assertV3AssetsReadyForRender } = require('../pipeline-updates/v3-asset-readiness.cjs');
test('V3 gates fail with stage-specific codes when evidence or graphic manifests are missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-assets-'));
  const defs = { episodeId: 'e1', allShots: [{ shotId: 'A', assetType: 'evidence_reference', evidenceRequirement: { description: 'source' }, graphics: [{ type: 'impact_card', text: 'ONE', intent: 'impact' }] }] };
  const shotDefsPath = path.join(dir, 'shot-definitions.json'); fs.writeFileSync(shotDefsPath, JSON.stringify(defs));
  assert.throws(() => assertV3EvidenceReady({ episodeDir: dir, shotDefsPath, shotDefs: defs }), /EVIDENCE_MANIFEST_MISSING/);
  assert.throws(() => assertV3GraphicsReady({ episodeDir: dir, shotDefsPath, shotDefs: defs }), /GRAPHIC_MANIFEST_MISSING/);
  assert.throws(() => assertV3AssetsReadyForRender({ episodeDir: dir, shotDefsPath, shotDefs: defs }), /EVIDENCE_MANIFEST_MISSING/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('no provider endpoints or network requests are touched by asset readiness checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-assets-net-')); let calls = 0; const oldFetch = global.fetch;
  global.fetch = async () => { calls++; throw new Error('network disabled'); };
  const defs = { episodeId: 'e1', allShots: [] }; const shotDefsPath = path.join(dir, 'shot-definitions.json'); fs.writeFileSync(shotDefsPath, JSON.stringify(defs));
  try { assert.throws(() => assertV3EvidenceReady({ episodeDir: dir, shotDefsPath, shotDefs: defs }), /EVIDENCE_MANIFEST_MISSING/); }
  finally { global.fetch = oldFetch; fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(calls, 0);
});
