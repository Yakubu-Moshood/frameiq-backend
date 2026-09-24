'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GRAPHIC_TEMPLATES, deterministicGraphicFilename, compileGraphic, compileShotGraphics, validateGraphicAssetManifest } = require('../pipeline-updates/graphic-compiler.cjs');
const palette = { background: '#181614', foreground: '#f5f1e8', accent: '#c9a34a', muted: '#9a9489' };
const brandConfig = { width: 1920, height: 1080, fontFamily: 'Inter, sans-serif', palette };
function graphic(type, text = 'EXACT APPROVED TEXT') { return { type, intent: 'Test template behavior.', text }; }
test('every census type dispatches to a deterministic compiler template', () => {
  for (const type of Object.keys(GRAPHIC_TEMPLATES)) {
    const a = compileGraphic({ shotId: 'ACT1_B001', graphicIndex: 0, graphic: graphic(type), role: 'PRIMARY', brandConfig, durationSec: 4.25 });
    const b = compileGraphic({ shotId: 'ACT1_B001', graphic: graphic(type), graphicIndex: 0, role: 'PRIMARY', brandConfig, durationSec: 4.25 });
    assert.equal(a.filename, 'ACT1_B001__g00.svg'); assert.equal(a.sha256, b.sha256); assert.equal(a.width, 1920); assert.equal(a.height, 1080); assert.equal(a.durationSec, 4.25);
  }
});
test('filenames are deterministic, shot-bound, and index-bound', () => {
  assert.equal(deterministicGraphicFilename('ACT3B_B008', 2), 'ACT3B_B008__g02.svg');
  assert.throws(() => deterministicGraphicFilename('../unsafe', 0), /GRAPHIC_FILENAME_INPUT_INVALID/);
  assert.throws(() => deterministicGraphicFilename('ACT1_B1', -1), /GRAPHIC_FILENAME_INPUT_INVALID/);
});
test('locked text is preserved exactly as accessible SVG text and XML-escaped', () => {
  const exact = '“$3.7 BILLION & CUSTOMER REDRESS”';
  const out = compileGraphic({ shotId: 'ACT1_B001', graphicIndex: 0, graphic: graphic('impact_card', exact), role: 'PRIMARY', brandConfig });
  assert.match(out.bytes.toString(), /“\$3.7 BILLION &amp; CUSTOMER REDRESS”/);
  assert.equal(out.sourceGraphic.text, exact);
});
test('primary graphics are full-frame while overlay graphics retain transparency', () => {
  const primary = compileGraphic({ shotId: 'ACT1_B001', graphicIndex: 0, graphic: graphic('impact_card'), role: 'PRIMARY', brandConfig }).bytes.toString();
  const overlay = compileGraphic({ shotId: 'ACT1_B001', graphicIndex: 1, graphic: graphic('date_marker'), role: 'OVERLAY', brandConfig }).bytes.toString();
  assert.match(primary, /<rect x="0" y="0" width="1920" height="1080"/);
  assert.doesNotMatch(overlay, /<rect x="0" y="0" width="1920" height="1080"/);
  assert.match(overlay, /data-role="OVERLAY"/);
});
test('unsupported types, missing locked text, intent, and channel brand config fail clearly', () => {
  assert.throws(() => compileGraphic({ shotId: 'A', graphicIndex: 0, graphic: graphic('made_up'), role: 'PRIMARY', brandConfig }), /GRAPHIC_TYPE_UNSUPPORTED/);
  assert.throws(() => compileGraphic({ shotId: 'A', graphicIndex: 0, graphic: { type: 'impact_card', text: '  ', intent: 'x' }, role: 'PRIMARY', brandConfig }), /GRAPHIC_TEXT_MISSING/);
  assert.throws(() => compileGraphic({ shotId: 'A', graphicIndex: 0, graphic: { type: 'impact_card', text: 'x', intent: '' }, role: 'PRIMARY', brandConfig }), /GRAPHIC_INTENT_MISSING/);
  assert.throws(() => compileGraphic({ shotId: 'A', graphicIndex: 0, graphic: graphic('impact_card'), role: 'PRIMARY' }), /GRAPHIC_BRAND_CONFIG_REQUIRED/);
});
test('data and timeline-like graphics carry deterministic renderer instructions, never image prompts', () => {
  for (const type of ['data_graphic', 'date_marker']) {
    const out = compileGraphic({ shotId: 'ACT1_B001', graphicIndex: 0, graphic: graphic(type), role: 'PRIMARY', brandConfig, durationSec: 5 });
    assert.equal(out.renderInstructions.deterministic, true);
    assert.ok(out.renderInstructions.animation);
    assert.equal(out.renderInstructions.textIsBurnedFromLockedGraphicObject, true);
  }
});
test('asset manifest verifies exact overlay membership and every output hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphic-compiler-'));
  const shots = [{ shotId: 'ACT1_B001', assetType: 'generated_clip', durationSec: 4, graphics: [graphic('date_marker'), graphic('identity_lower_third')] }];
  const entries = compileShotGraphics({ shot: shots[0], outputDir: dir, brandConfig });
  assert.equal(entries[0].role, 'OVERLAY'); assert.equal(entries.length, 2);
  const sourceShotDefinitionsSha256 = 'a'.repeat(64);
  assert.equal(validateGraphicAssetManifest({ manifest: { manifestVersion: '1.0.0', episodeId: 'e1', sourceShotDefinitionsSha256, entries }, shotDefs: { episodeId: 'e1', allShots: shots }, graphicAssetDir: dir }).status, 'PASS');
  fs.appendFileSync(path.join(dir, entries[0].filename), 'tamper');
  assert.ok(validateGraphicAssetManifest({ manifest: { manifestVersion: '1.0.0', episodeId: 'e1', sourceShotDefinitionsSha256, entries }, shotDefs: { episodeId: 'e1', allShots: shots }, graphicAssetDir: dir }).errors.some(error => error.code === 'GRAPHIC_HASH_MISMATCH'));
  fs.rmSync(dir, { recursive: true, force: true });
});
test('a multi-object full-frame graphic uses one opaque primary and transparent remaining overlays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphic-stack-'));
  const shot = { shotId: 'ACT4_B001', assetType: 'graphic_compilation', durationSec: 5, graphics: [graphic('impact_card', '$185 MILLION'), graphic('date_marker', '2016')] };
  const entries = compileShotGraphics({ shot, outputDir: dir, brandConfig });
  assert.deepEqual(entries.map(entry => entry.role), ['PRIMARY', 'OVERLAY']);
  assert.match(fs.readFileSync(path.join(dir, entries[0].filename), 'utf8'), /<rect x="0" y="0" width="1920" height="1080"/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, entries[1].filename), 'utf8'), /<rect x="0" y="0" width="1920" height="1080"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('no external provider request is performed while compiling graphic fixtures', () => {
  let calls = 0; const oldFetch = global.fetch; global.fetch = async () => { calls++; throw new Error('network disabled'); };
  try { compileGraphic({ shotId: 'ACT1_B001', graphicIndex: 0, graphic: graphic('impact_card'), role: 'PRIMARY', brandConfig }); }
  finally { global.fetch = oldFetch; }
  assert.equal(calls, 0);
});
