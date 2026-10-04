'use strict';

// Reproducible local-only compiler for the already approved ACT5_B009 and
// ACT5_B015 specifications. It performs no network or provider operations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const EXPECTED = Object.freeze({
  b009Amendment: 'f6f50f516f89ed9f27724e994e890cde65513747054a40f16360a9dc1eb46ba8',
  b009Approval: '6d3e88e24a23777baa38da3325d9fb81f833943fb8b2a8eb6b106b2ce27c516f',
  b009ReviewSvg: 'a72adf75844089197e1e15bd4c24cb8b008ab922f7e64f4988e795525b4439ab',
  b015VisualApproval: '76a7fef0ffc0ebe0f93d763395c1f667d87f78798f0f5c160b770e2a5c18773f',
  b015TimingApproval: 'ece9be52468fdd5c73882736c28f4c4acb2bed44c7662a9494ef0aeded29a909',
  b015Spec: '3acacb5642c058265278d4befbaaa57c3e4d7056076d1cac5faf7c30c230b6e5',
  b015ReviewSvg: '1292f492d448414af0e8aee1cb0feb1efed6af0a4a9aa1df41d1709927839c72',
  b015Font: 'e8f4e3baf6cc35fed6fcce3a540e8b39e8f6cda1d22a28f2ec8f526fef7a43f5',
  b009ColorSource: '3f7e9921f0feca9abccf5c56a77a32e709a566732429d6b76c3ae3c4d7bbe0a0',
});

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function mustHash(file, expected, label) {
  const bytes = fs.readFileSync(file);
  const actual = sha(bytes);
  if (actual !== expected) throw new Error(`${label}_SHA256_MISMATCH:${actual}`);
  return bytes;
}
function parseArgs() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i]?.startsWith('--')) throw new Error('ARGUMENT_INVALID');
    out[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  for (const key of ['wellsFargoRoot', 'outputDir']) if (!out[key]) throw new Error(`ARGUMENT_REQUIRED:${key}`);
  return out;
}
function stripReviewOnly(svg, beatId) {
  let value = svg;
  value = value.replace(/\saria-label="[^"]*"/u, '');
  value = value.replace(/\sdata-review-status="[^"]*"/u, '');
  value = value.replace(/\sdata-classification="[^"]*"/u, '');
  value = value.replace(/<metadata>[\s\S]*?<\/metadata>/u, `<metadata>{"beatId":"${beatId}","classification":"PRODUCTION_CANDIDATE_PENDING_FINAL_HUMAN_REVIEW"}</metadata>`);
  if (/REVIEW_ONLY|review-only/iu.test(value)) throw new Error(`${beatId}_REVIEW_MARKER_REMAINS`);
  return value;
}
function validateB009(svg) {
  if (!/^<\?xml[^>]*encoding="UTF-8"[^>]*\?>\n<svg\b/u.test(svg)) throw new Error('B009_XML_HEADER_INVALID');
  if (!/<svg[^>]*width="1280"[^>]*height="720"[^>]*viewBox="0 0 1280 720"/u.test(svg)) throw new Error('B009_DIMENSIONS_INVALID');
  const withoutNamespace = svg.replace(/\sxmlns="https?:\/\/www\.w3\.org\/2000\/svg"/u, '');
  if (/<(?:script|foreignObject|image|use|style|animate|animateTransform|set)\b|\bhref\s*=|https?:\/\//iu.test(withoutNamespace)) throw new Error('B009_UNSAFE_SVG_CONTENT');
  const allowedElements = new Set(['svg', 'metadata', 'rect', 'circle', 'text']);
  for (const match of svg.matchAll(/<\/?([A-Za-z][\w:-]*)\b/gu)) if (!allowedElements.has(match[1])) throw new Error(`B009_DISALLOWED_ELEMENT:${match[1]}`);
  const labels = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/gu)].map(m => m[1]);
  const expected = Array.from({ length: 11 }, (_, i) => String(2013 + i));
  if (JSON.stringify(labels) !== JSON.stringify(expected)) throw new Error(`B009_LABELS_INVALID:${JSON.stringify(labels)}`);
  if (/<(?:title|desc)\b|>\s*(?!201[3-9]|202[0-3])[^<]*[A-Za-z]{2,}[^<]*<\/text>/iu.test(svg)) throw new Error('B009_ADDITIONAL_READABLE_TEXT');
}
async function main() {
  const args = parseArgs();
  const base = path.resolve(args.wellsFargoRoot);
  const out = path.resolve(args.outputDir);
  fs.mkdirSync(out, { recursive: true });
  const b009Dir = path.join(base, 'phase3-act5-b009-b016-human-review-20261004-v2', 'b009');
  const b015Dir = path.join(base, 'phase3-act5-b015-human-review-20261004-v1');
  const candidateDir = path.join(base, 'phase3-consolidated-act5-production-candidate-20261004-v3', 'candidate');
  const b009Approval = mustHash(path.join(base, 'phase3-act5-b009-human-approval-20261004.v1.json'), EXPECTED.b009Approval, 'B009_APPROVAL');
  const b009Amendment = mustHash(path.join(b009Dir, 'amendment-proposal.v1.json'), EXPECTED.b009Amendment, 'B009_AMENDMENT');
  const b009Spec = JSON.parse(fs.readFileSync(path.join(b009Dir, 'controlled-graphic-spec.v1.json'), 'utf8'));
  if (b009Spec.canvas.widthPx !== 1280 || b009Spec.canvas.heightPx !== 720 || b009Spec.providerRequests !== 0
      || JSON.stringify(b009Spec.content.exactLabels) !== JSON.stringify(Array.from({ length: 11 }, (_, i) => String(2013 + i)))) throw new Error('B009_APPROVED_SPEC_BINDING_INVALID');
  const b009Color = mustHash(path.join(candidateDir, 'assets', 'graphics', 'ACT1_B002__g00.svg'), EXPECTED.b009ColorSource, 'B009_PALETTE_SOURCE');
  const b009ReviewBytes = mustHash(path.join(b009Dir, 'ACT5_B009-year-pages.review-only.svg'), EXPECTED.b009ReviewSvg, 'B009_APPROVED_LAYOUT_REFERENCE');
  const b009Svg = stripReviewOnly(b009ReviewBytes.toString('utf8'), 'ACT5_B009');
  validateB009(b009Svg);
  const b009SvgBytes = Buffer.from(b009Svg, 'utf8');
  const b009PngBytes = await sharp(b009SvgBytes, { density: 72 }).png().toBuffer();
  if (sha(b009SvgBytes).length !== 64 || b009PngBytes[0] !== 0x89 || b009PngBytes.toString('ascii', 1, 4) !== 'PNG'
      || b009PngBytes.readUInt32BE(16) !== 1280 || b009PngBytes.readUInt32BE(20) !== 720) throw new Error('B009_RASTER_VALIDATION_FAILED');

  mustHash(path.join(base, 'phase3-act5-b015-visual-specification-approval-20261004.v1.json'), EXPECTED.b015VisualApproval, 'B015_VISUAL_APPROVAL');
  mustHash(path.join(base, 'phase3-act5-b015-timing-approval-20261004.v1.json'), EXPECTED.b015TimingApproval, 'B015_TIMING_APPROVAL');
  const b015SpecBytes = mustHash(path.join(b015Dir, 'act5-b015-graphic-spec.v1.json'), EXPECTED.b015Spec, 'B015_APPROVED_SPEC');
  const b015Spec = JSON.parse(b015SpecBytes.toString('utf8'));
  if (b015Spec.beatId !== 'ACT5_B015' || b015Spec.timingReview.editPlan.startSec !== 571.9558705585937
      || b015Spec.timingReview.editPlan.endSec !== 577.515875746582 || b015Spec.reviewGraphicProposal.dimensions.width !== 1920
      || b015Spec.reviewGraphicProposal.dimensions.height !== 1080) throw new Error('B015_APPROVED_SCOPE_INVALID');
  const b015Review = mustHash(path.join(b015Dir, 'ACT5_B015-graphic.review-only.svg'), EXPECTED.b015ReviewSvg, 'B015_APPROVED_LAYOUT_REFERENCE');
  const b015Svg = stripReviewOnly(b015Review.toString('utf8'), 'ACT5_B015');
  if (!/width="1920" height="1080" viewBox="0 0 1920 1080"/u.test(b015Svg)
      || (b015Svg.match(/<text\b/gu) || []).length !== 1 || !b015Svg.includes('REGULATORS PUNISHED THE BANK')
      || /REVIEW_ONLY|review-only/iu.test(b015Svg)) throw new Error('B015_PRODUCTION_SVG_VALIDATION_FAILED');
  const b015Font = mustHash('C:/Windows/Fonts/arialbd.ttf', EXPECTED.b015Font, 'B015_FONT');
  if (b015Font.length !== 989780) throw new Error('B015_FONT_SIZE_INVALID');

  for (const [name, bytes] of [['ACT5_B009__g00.svg', b009SvgBytes], ['ACT5_B009__g00.png', b009PngBytes], ['ACT5_B015__g00.svg', Buffer.from(b015Svg, 'utf8')]]) {
    fs.writeFileSync(path.join(out, name), bytes, { flag: 'wx' });
  }
  const details = {
    schemaVersion: 'phase3-approved-act5-graphic-build/1.0.0',
    outputs: [
      { beatId: 'ACT5_B009', path: 'ACT5_B009__g00.svg', bytes: b009SvgBytes.length, sha256: sha(b009SvgBytes), width: 1280, height: 720, format: 'svg' },
      { beatId: 'ACT5_B009', path: 'ACT5_B009__g00.png', bytes: b009PngBytes.length, sha256: sha(b009PngBytes), width: 1280, height: 720, format: 'png' },
      { beatId: 'ACT5_B015', path: 'ACT5_B015__g00.svg', bytes: Buffer.byteLength(b015Svg), sha256: sha(Buffer.from(b015Svg)), width: 1920, height: 1080, format: 'svg' },
    ],
    approvedInputs: {
      b009AmendmentSha256: sha(b009Amendment), b009ApprovalSha256: sha(b009Approval), b009SpecSha256: sha(fs.readFileSync(path.join(b009Dir, 'controlled-graphic-spec.v1.json'))),
      b009LayoutReferenceSha256: sha(b009ReviewBytes), b009PaletteSourceSha256: sha(b009Color),
      b015SpecSha256: sha(b015SpecBytes), b015VisualApprovalSha256: EXPECTED.b015VisualApproval, b015TimingApprovalSha256: EXPECTED.b015TimingApproval,
      b015LayoutReferenceSha256: sha(b015Review), b015ArialBoldSha256: sha(b015Font), sharpVersion: sharp.versions.sharp, libvipsVersion: sharp.versions.vips,
    },
  };
  fs.writeFileSync(path.join(out, 'build-details.json'), `${JSON.stringify(details, null, 2)}\n`, { flag: 'wx' });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
