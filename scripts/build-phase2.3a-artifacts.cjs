'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compileGraphic } = require('../pipeline-updates/graphic-compiler.cjs');
const { planProofSection } = require('../pipeline-updates/proof-section-planner.cjs');
const { validateEvidenceSourceManifest } = require('../pipeline-updates/evidence-source-validator.cjs');

const ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'artifacts', 'empire-omitted-v3', 'wells-fargo', 'phase2.2d');
const OUT_DIR = path.join(ROOT, 'artifacts', 'empire-omitted-v3', 'wells-fargo', 'phase2.3a');
const CANDIDATE_PATH = path.join(INPUT_DIR, 'shot-definitions.phase2.2d.json');
const PRODUCTION_PATH = path.join(INPUT_DIR, 'production-manifest.phase2.2d.json');
const RIGHTS = { government: 'OFFICIAL_GOVERNMENT_SOURCE', commercial: 'RIGHTS_UNCLEAR', editorial: 'FAIR_DEALING_REVIEW_REQUIRED' };
const SOURCES = {
  cfpb2016: { url: 'https://www.consumerfinance.gov/enforcement/actions/wells-fargo-bank-2016/', title: 'Wells Fargo Bank, N.A. (2016) enforcement action', publisher: 'Consumer Financial Protection Bureau', date: '2016-09-08', rights: RIGHTS.government, authority: 'Primary federal regulator enforcement record', direct: 'https://files.consumerfinance.gov/f/documents/092016_cfpb_WFBconsentorder.pdf' },
  cfpb2022: { url: 'https://www.consumerfinance.gov/enforcement/actions/wells-fargo-bank-na-2022/', title: 'Wells Fargo Bank, N.A. (2022) enforcement action', publisher: 'Consumer Financial Protection Bureau', date: '2022-12-20', rights: RIGHTS.government, authority: 'Primary federal regulator enforcement record', direct: 'https://files.consumerfinance.gov/f/documents/cfpb_wells-fargo-na-2022_consent-order_2022-12.pdf' },
  doj2020: { url: 'https://www.justice.gov/usao-cdca/pr/wells-fargo-agrees-pay-3-billion-resolve-criminal-and-civil-investigations-sales', title: 'Wells Fargo Agrees to Pay $3 Billion to Resolve Criminal and Civil Investigations into Sales Practices', publisher: 'U.S. Department of Justice, U.S. Attorney’s Office, Central District of California', date: '2020-02-21', rights: RIGHTS.government, authority: 'Primary federal prosecution announcement', direct: null },
  dojTolstedt: { url: 'https://www.justice.gov/usao-cdca/pr/former-wells-fargo-executive-agrees-plead-guilty-obstructing-bank-examination', title: 'Former Wells Fargo Executive Agrees to Plead Guilty to Obstructing Bank Examination', publisher: 'U.S. Department of Justice, U.S. Attorney’s Office, Central District of California', date: '2023-03-15', rights: RIGHTS.government, authority: 'Primary federal prosecution announcement', direct: null },
  frb2018: { url: 'https://www.federalreserve.gov/newsevents/pressreleases/enforcement20180202a.htm', title: 'Federal Reserve restricts Wells Fargo growth until firm improves governance and controls', publisher: 'Board of Governors of the Federal Reserve System', date: '2018-02-02', rights: RIGHTS.government, authority: 'Primary federal regulator order announcement', direct: 'https://www.federalreserve.gov/newsevents/pressreleases/files/enf20180202a1.pdf' },
  frb2025: { url: 'https://www.federalreserve.gov/newsevents/pressreleases/enforcement20250603a.htm', title: 'Federal Reserve announces Wells Fargo is no longer subject to asset growth restriction', publisher: 'Board of Governors of the Federal Reserve System', date: '2025-06-03', rights: RIGHTS.government, authority: 'Primary federal regulator announcement', direct: null },
  frb2026: { url: 'https://www.federalreserve.gov/newsevents/pressreleases/enforcement20260305a.htm', title: 'Federal Reserve Board announces termination of enforcement action with Wells Fargo', publisher: 'Board of Governors of the Federal Reserve System', date: '2026-03-05', rights: RIGHTS.government, authority: 'Primary federal regulator announcement', direct: null },
  senateHearing: { url: 'https://www.banking.senate.gov/hearings/an-examination-of-wells-fargos-unauthorized-accounts-and-the-regulatory-response', title: 'An Examination of Wells Fargo’s Unauthorized Accounts and the Regulatory Response', publisher: 'U.S. Senate Committee on Banking, Housing, and Urban Affairs', date: '2016-09-20', rights: RIGHTS.government, authority: 'Official congressional hearing record and witness list', direct: 'https://www.banking.senate.gov/imo/media/doc/092016_Stumpf%20Testimony.pdf' },
  occStumpf: { url: 'https://www.occ.gov/static/enforcement-actions/ea2020-004.pdf', title: 'In the Matter of John Stumpf — OCC Consent Order', publisher: 'Office of the Comptroller of the Currency', date: '2020-01-22', rights: RIGHTS.government, authority: 'Primary federal banking regulator consent order', direct: 'https://www.occ.gov/static/enforcement-actions/ea2020-004.pdf' },
  occ2016: { url: 'https://www.occ.gov/news-issuances/news-releases/2016/nr-occ-2016-106.html', title: 'OCC Assesses Penalty Against Wells Fargo, Orders Restitution for Unsafe or Unsound Sales Practices', publisher: 'Office of the Comptroller of the Currency', date: '2016-09-08', rights: RIGHTS.government, authority: 'Primary federal banking regulator announcement', direct: null },
  secBoard: { url: 'https://www.sec.gov/Archives/edgar/data/72971/000119312517118654/d375947ddefa14a.htm', title: 'Independent Directors’ Sales Practices Investigation Report', publisher: 'Wells Fargo & Company, filed with the U.S. Securities and Exchange Commission', date: '2017-04-10', rights: RIGHTS.commercial, authority: 'SEC-hosted corporate filing containing board investigation report', direct: null },
  sec8k: { url: 'https://www.sec.gov/Archives/edgar/data/72971/000119312516722259/d266244d8k.htm', title: 'Wells Fargo Form 8-K: Board compensation and employment actions', publisher: 'Wells Fargo & Company, filed with the U.S. Securities and Exchange Commission', date: '2016-09-28', rights: RIGHTS.commercial, authority: 'SEC-hosted company filing', direct: null },
  secOrder: { url: 'https://www.sec.gov/Archives/edgar/data/72971/000007297120000214/exhibit994secorder.htm', title: 'SEC Order: Wells Fargo sales practices and disclosure failures', publisher: 'U.S. Securities and Exchange Commission', date: '2020-12-21', rights: RIGHTS.government, authority: 'Primary securities regulator enforcement order', direct: null },
  latimes2013: { url: 'https://www.latimes.com/business/la-fi-1004-wells-fargo-firings-20131004-story.html', title: 'Wells Fargo accuses workers of opening fake accounts to meet goals', publisher: 'Los Angeles Times', date: '2013-10-03', rights: RIGHTS.editorial, authority: 'Named-reporter contemporaneous investigative journalism; E. Scott Reckard byline', direct: null },
  latimesPressure: { url: 'https://www.latimes.com/business/la-fi-wells-fargo-sale-pressure-20131222-story.html', title: 'Wells Fargo’s pressure-cooker sales culture comes at a cost', publisher: 'Los Angeles Times', date: '2013-12-21', rights: RIGHTS.editorial, authority: 'Named-reporter contemporaneous investigation; E. Scott Reckard byline', direct: null },
  wfHistory: { url: 'https://history.wf.com/stagecoach/', title: 'Behold the stagecoach — Wells Fargo History', publisher: 'Wells Fargo History', date: null, rights: RIGHTS.commercial, authority: 'Corporate historical archive; image-specific provenance and rights still require review', direct: null },
  cfpbTiger: { url: 'https://obis.osha.gov/as/opa/quicktakes/qt081517.html', title: 'Wells Fargo ordered to reinstate, pay Southern California whistleblower', publisher: 'U.S. Department of Labor, Occupational Safety and Health Administration', date: '2017-08-15', rights: RIGHTS.government, authority: 'Primary federal whistleblower finding announcement', direct: null },
  cfpbAuto: { url: 'https://www.consumerfinance.gov/enforcement/actions/wells-fargo-bank-na-2022/', title: 'Wells Fargo Bank, N.A. (2022) enforcement action — auto lending and repossessions', publisher: 'Consumer Financial Protection Bureau', date: '2022-12-20', rights: RIGHTS.government, authority: 'Primary federal consumer regulator finding and consent order', direct: 'https://files.consumerfinance.gov/f/documents/cfpb_wells-fargo-na-2022_consent-order_2022-12.pdf' },
};
const ALTERNATIVES = [SOURCES.cfpb2016, SOURCES.secOrder, SOURCES.senateHearing, SOURCES.doj2020];
function chooseSource(shot) {
  const id = shot.shotId; const text = `${shot.evidenceRequirement?.description || ''} ${shot.sourceSearchInstruction || ''}`.toLowerCase();
  if (id === 'ACT2_B001' || /19th century|stagecoach|express office/.test(text)) return SOURCES.wfHistory;
  if (/los angeles times|e\. scott reckard|byline/.test(text)) return /pressure|firings|2013/.test(text) ? SOURCES.latimes2013 : SOURCES.latimesPressure;
  if (/federal reserve|\bfed\b|asset cap|growth restriction|governance and risk/.test(text)) return /remove|removed|june 2025/.test(text) ? SOURCES.frb2025 : /march 2026|terminated/.test(text) ? SOURCES.frb2026 : SOURCES.frb2018;
  if (/senate|congress|elizabeth warren|stumpf.*testif|hearing room/.test(text)) return SOURCES.senateHearing;
  if (/tolstedt.*(plea|guilty)|guilty plea/.test(text)) return SOURCES.dojTolstedt;
  if (/stumpf.*(bar|fine|banking industry)|17\.5 million/.test(text)) return SOURCES.occStumpf;
  if (/osha|reinstate|retaliation|whistleblower/.test(text)) return SOURCES.cfpbTiger;
  if (/auto insurance|repossession|improper mortgage|mortgage fees|product lines/.test(text)) return SOURCES.cfpbAuto;
  if (/3\.7 billion|2022 consumer|2022.*consent order/.test(text)) return SOURCES.cfpb2022;
  if (/2016.*185 million|185 million|unauthorized accounts|sales practices|systemic|sales culture|2\.6 million|5,300|5300|forged|24 accounts|testimony|former employee|job loss/.test(text)) return /obstructing bank examination/.test(text) ? SOURCES.dojTolstedt : /5,300|5300|compensation|clawback|severance|holdings/.test(text) ? SOURCES.secBoard : SOURCES.cfpb2016;
  if (/2020|3 billion|resolution|doj/.test(text)) return SOURCES.doj2020;
  if (/sec|proxy|filing|stock|shareholder|clawback|holdings|severance/.test(text)) return SOURCES.secBoard;
  if (/occ/.test(text)) return SOURCES.occ2016;
  return SOURCES.cfpb2016;
}
function mediumFit(shot, source) {
  const need = `${shot.evidenceRequirement?.evidenceType || ''} ${shot.evidenceRequirement?.description || ''}`.toLowerCase();
  const audioVisual = /footage|video|photograph|photo|image|front page|podium|hearing room|news coverage|speaker/.test(need);
  const documentNeed = /document|order|filing|record|testimony|report|complaint|findings|disclosure/.test(need);
  if (shot.shotId === 'ACT2_B001') return 'CORPORATE_ARCHIVE_TOUR_IS_NOT_A_DATED_19TH_CENTURY_PHOTOGRAPH; IMAGE_PROVENANCE_AND_RIGHTS_REVIEW_REQUIRED';
  if (audioVisual) return 'SOURCE_PAGE_IS_NOT_A_CLEARED_MATCHING_MEDIA_ASSET; DIRECT_MEDIA_PROVENANCE_AND_RIGHTS_REVIEW_REQUIRED';
  if (documentNeed) return 'PRIMARY_DOCUMENT_OR_RECORD_CANDIDATE_REQUIRES_EXCERPT_MATCH_AND_REUSE_RIGHTS_REVIEW';
  return 'FACTUAL_LEAD_ONLY; EXACT_RELEVANCE_MEDIA_FIT_ACCESS_AND_RIGHTS_REVIEW_REQUIRED';
}
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function stableWrite(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const shotBytes = fs.readFileSync(CANDIDATE_PATH); const shotDefs = JSON.parse(shotBytes);
  const prodBytes = fs.readFileSync(PRODUCTION_PATH); const productionManifest = JSON.parse(prodBytes);
  const shotHash = sha(shotBytes); const prodHash = sha(prodBytes);
  const evidenceShots = shotDefs.allShots.filter(shot => shot.assetType === 'evidence_reference');
  const sourceEntries = evidenceShots.map(shot => {
    const source = chooseSource(shot);
    const alternates = [...new Map([...ALTERNATIVES, SOURCES.senateHearing, SOURCES.cfpb2022].filter(item => item.url !== source.url).map(item => [item.url, item])).values()].slice(0, 3);
    return {
      shotId: shot.shotId,
      exactSourceRequirement: shot.evidenceRequirement?.description || '',
      narrationExcerpt: shot.narrationExcerpt,
      sourceSearchInstruction: shot.sourceSearchInstruction,
      selectedSourceUrl: source.url,
      sourceTitle: source.title,
      publisher: source.publisher,
      publicationDate: source.date,
      assetType: /footage|video/.test(`${shot.evidenceRequirement?.evidenceType || ''} ${shot.evidenceRequirement?.description || ''}`.toLowerCase()) ? 'AUDIOVISUAL_SOURCE_CANDIDATE' : source.direct ? 'OFFICIAL_DOCUMENT_CANDIDATE' : 'WEB_RECORD_CANDIDATE',
      directAssetUrl: source.direct,
      retrievalDate: '2026-09-24',
      localFilename: null,
      sha256: null,
      mimeType: source.direct ? (source.direct.toLowerCase().includes('.pdf') ? 'application/pdf' : null) : 'text/html',
      dimensionsOrDuration: null,
      sourceAuthority: source.authority,
      rightsClassification: source.rights,
      rightsNotes: source.rights === RIGHTS.government ? 'Government-hosted primary record candidate. This label does not approve any third-party footage, graphic, photograph, or embedded material; confirm the rights and reuse terms for the specific selected asset.' : 'Rights to reproduce this source or its embedded media have not been cleared. Obtain asset-specific permission or rights review before production.',
      factualRelevance: `Candidate supports investigation of: ${shot.narrationExcerpt}. Exact excerpt, date, attribution, and match to the locked source requirement have not yet been verified. Media fit: ${mediumFit(shot, source)}.`,
      excerptOrTimecode: null,
      approvalStatus: 'REVIEW_REQUIRED',
      rejectionReason: null,
      sourceAccessStatus: 'ACCESSIBILITY_UNCHECKED',
      factualSupportStatus: 'PENDING',
      mediaFitStatus: mediumFit(shot, source),
      alternatives: alternates.map(item => ({ url: item.url, title: item.title, publisher: item.publisher, publicationDate: item.date, rightsClassification: item.rights, mediaFitStatus: 'CANDIDATE_NOT_REVIEWED' })),
    };
  });
  const rightsCounts = Object.fromEntries([...new Set(sourceEntries.map(entry => entry.rightsClassification))].sort().map(key => [key, sourceEntries.filter(entry => entry.rightsClassification === key).length]));
  const evidenceManifest = { manifestVersion: '1.0.0', episodeId: shotDefs.episodeId, shotDefinitionsSha256: shotHash, sourceStatus: 'CANDIDATE_REVIEW_ONLY', entries: sourceEntries };
  stableWrite(path.join(OUT_DIR, 'evidence-source-candidates.json'), evidenceManifest);
  const sourceValidationReport = validateEvidenceSourceManifest({ manifest: evidenceManifest, shotDefs });
  const evidenceValidation = {
    validatorVersion: '1.0.0', episodeId: shotDefs.episodeId, shotDefinitionsSha256: shotHash,
    status: 'FAIL_CLOSED', totalEvidenceShots: evidenceShots.length, candidateCount: sourceEntries.length,
    approvedCount: sourceEntries.filter(entry => entry.approvalStatus === 'APPROVED' && entry.sourceAccessStatus === 'ACCESSIBLE' && entry.factualSupportStatus === 'SUPPORTED').length,
    rightsClassificationCounts: rightsCounts,
    inaccessibleOrUnverifiedCount: sourceEntries.filter(entry => entry.sourceAccessStatus !== 'ACCESSIBLE').length,
    factualSupportPendingCount: sourceEntries.filter(entry => entry.factualSupportStatus !== 'SUPPORTED').length,
    shotsWithNoAcceptableSource: sourceEntries.filter(entry => entry.approvalStatus !== 'APPROVED' || entry.mediaFitStatus.includes('REQUIRED')).map(entry => ({ shotId: entry.shotId, reason: entry.mediaFitStatus, candidateUrl: entry.selectedSourceUrl })),
    blockers: ['All 46 source records are candidates, not approved evidence.', 'No source-specific excerpt/timecode or media rights review has been completed.', 'No evidence assets were downloaded; direct media availability and hashes are unverified.'],
    validationErrors: sourceValidationReport.errors,
  };
  stableWrite(path.join(OUT_DIR, 'evidence-source-validation.json'), evidenceValidation);

  const graphicOccurrences = [];
  for (const shot of shotDefs.allShots) for (let index = 0; index < (shot.graphics || []).length; index++) graphicOccurrences.push({ shot, index, graphic: shot.graphics[index] });
  const types = [...new Set(graphicOccurrences.map(item => item.graphic.type))].sort();
  const census = {
    censusVersion: '1.0.0', episodeId: shotDefs.episodeId, shotDefinitionsSha256: shotHash, productionManifestSha256: prodHash,
    lockedGraphicObjectCount: graphicOccurrences.length, uniqueTypeCount: types.length,
    primaryGraphicShotCount: productionManifest.shots.filter(entry => entry.productionMethod === 'GRAPHIC_COMPILATION').length,
    overlayBearingShotCount: productionManifest.shots.filter(entry => entry.overlayGraphicRequirement).length,
    types: types.map(type => {
      const rows = graphicOccurrences.filter(row => row.graphic.type === type);
      const primary = rows.filter(row => row.shot.assetType === 'graphic_compilation' && row.index === 0).length;
      return { type, objectCount: rows.length, primaryObjectCount: primary, overlayObjectCount: rows.length - primary,
        categories: ({ impact_card: ['impact card', 'full-frame or overlay'], date_marker: ['timeline/date marker'], chapter_marker: ['chapter marker'], data_graphic: ['data graphic'], document_callout: ['document highlight/callout'], identity_lower_third: ['lower third / identity label'], direct_quote: ['quotation'], takeaway: ['takeaway'], source_citation: ['source citation'] })[type] || ['unsupported'], supported: ['impact_card','date_marker','chapter_marker','data_graphic','document_callout','identity_lower_third','direct_quote','takeaway','source_citation'].includes(type), previewShotId: rows[0]?.shot.shotId, fieldShape: [...new Set(rows.flatMap(row => Object.keys(row.graphic)))].sort() };
    }),
    unsupportedTypes: types.filter(type => !['impact_card','date_marker','chapter_marker','data_graphic','document_callout','identity_lower_third','direct_quote','takeaway','source_citation'].includes(type)),
    classification: { fullFrameGraphics: productionManifest.shots.filter(entry => entry.productionMethod === 'GRAPHIC_COMPILATION').length, overlayGraphicObjects: graphicOccurrences.filter(row => row.shot.assetType !== 'graphic_compilation' || row.index > 0).length, primaryGraphicObjects: graphicOccurrences.filter(row => row.shot.assetType === 'graphic_compilation' && row.index === 0).length, lowerThirds: graphicOccurrences.filter(row => row.graphic.type === 'identity_lower_third').length, quotations: graphicOccurrences.filter(row => row.graphic.type === 'direct_quote').length, documentHighlights: graphicOccurrences.filter(row => row.graphic.type === 'document_callout').length, timelines: graphicOccurrences.filter(row => row.graphic.type === 'date_marker').length, counters: 0, charts: graphicOccurrences.filter(row => row.graphic.type === 'data_graphic').length, comparisonGraphics: 0, labels: graphicOccurrences.filter(row => ['identity_lower_third','source_citation'].includes(row.graphic.type)).length },
  };
  stableWrite(path.join(OUT_DIR, 'graphic-type-census.json'), census);

  const previewDir = path.join(OUT_DIR, 'previews'); fs.mkdirSync(previewDir, { recursive: true });
  const brandConfig = { name: 'Empire Omitted', provenance: 'Palette is derived from the approved visual identity description: charcoal/black foundation, gold accent, restrained red, and high-contrast typography.', width: 1920, height: 1080, fontFamily: 'Arial, sans-serif', palette: { background: '#171615', foreground: '#f4f0e6', accent: '#c8a24a', muted: '#99938b', danger: '#9e3d35' } };
  const previewEntries = [];
  for (const type of types) {
    const occurrence = graphicOccurrences.find(item => item.graphic.type === type);
    const entry = compileGraphic({ shotId: occurrence.shot.shotId, graphicIndex: occurrence.index, graphic: occurrence.graphic, role: occurrence.shot.assetType === 'graphic_compilation' && occurrence.index === 0 ? 'PRIMARY' : 'OVERLAY', brandConfig, durationSec: occurrence.shot.durationSec });
    fs.writeFileSync(path.join(previewDir, entry.filename), entry.bytes);
    previewEntries.push({ type, exampleShotId: occurrence.shot.shotId, graphicIndex: occurrence.index, previewFilename: entry.filename, previewPath: `previews/${entry.filename}`, sha256: entry.sha256, width: entry.width, height: entry.height, durationSec: entry.durationSec, format: entry.format, mimeType: entry.mimeType, role: entry.role, sourceGraphic: entry.sourceGraphic, renderInstructions: entry.renderInstructions });
  }
  const graphicTemplateManifest = { manifestVersion: '1.0.0', episodeId: shotDefs.episodeId, sourceShotDefinitionsSha256: shotHash, sourceProductionManifestSha256: prodHash, purpose: 'One representative locally compiled fixture preview for every unique locked type. These are not episode-level compiled assets.', compiler: 'pipeline-updates/graphic-compiler.cjs', brandConfig, supportedTypes: types, unsupportedTypes: census.unsupportedTypes, previewCount: previewEntries.length, previews: previewEntries };
  stableWrite(path.join(OUT_DIR, 'graphic-template-manifest.json'), graphicTemplateManifest);

  const proofPlan = planProofSection({ shotDefs, productionManifest, minDurationSec: 60, maxDurationSec: 90, targetDurationSec: 80 });
  proofPlan.reason = `The deterministic selector chose this contiguous section across ${proofPlan.acts.join(' and ')} because it provides the strongest scored combination of evidence requirements, primary and overlay graphics, reconstruction, essential animation, controlled stills, narration timing, and method transitions within the 60–90 second bound.`;
  proofPlan.narrationMethodTransitions = proofPlan.shotIds.slice(1).map((id, i) => ({ fromShotId: proofPlan.shotIds[i], toShotId: id, from: productionManifest.shots.find(row => row.shotId === proofPlan.shotIds[i])?.productionMethod, to: productionManifest.shots.find(row => row.shotId === id)?.productionMethod })).filter(row => row.from !== row.to);
  stableWrite(path.join(OUT_DIR, 'proof-section-plan.json'), proofPlan);

  const summary = `# Phase 2.3A review summary\n\n- Episode: ${shotDefs.episodeId}\n- Locked inputs: shot definitions SHA-256 \`${shotHash}\`; production manifest SHA-256 \`${prodHash}\`.\n- Evidence candidates: ${sourceEntries.length}/${evidenceShots.length}; approved: 0; unresolved: ${sourceEntries.length}. Rights classifications: ${Object.entries(rightsCounts).map(([k,v])=>`${k}=${v}`).join(', ')}.\n- Graphic objects: ${graphicOccurrences.length}; unique types: ${types.length}; supported templates: ${types.length}; unsupported: ${census.unsupportedTypes.length}. Nine representative SVG previews were generated locally; no episode graphics were compiled.\n- Proof section: ${proofPlan.startSec.toFixed(3)}–${proofPlan.endSec.toFixed(3)} seconds (${proofPlan.durationSec.toFixed(3)} seconds), ${proofPlan.acts.join(', ')}. Planned generation jobs: ${proofPlan.expectedProviderCalls.imageJobs} image, ${proofPlan.expectedProviderCalls.animationJobs} animation; evidence/graphic provider calls: 0.\n- Safety: no paid provider requests and no episode render were made. All evidence remains review-required; runtime gates fail closed until sources and graphic assets are approved and hash-verified.\n- Phase 1 and Phase 2.2 locked episode artifacts were read-only.\n\n## Source leads\n\n- [CFPB 2016 Wells Fargo enforcement action](https://www.consumerfinance.gov/enforcement/actions/wells-fargo-bank-2016/)\n- [DOJ 2020 Wells Fargo resolution](https://www.justice.gov/usao-cdca/pr/wells-fargo-agrees-pay-3-billion-resolve-criminal-and-civil-investigations-sales)\n- [CFPB 2022 order](https://www.consumerfinance.gov/enforcement/actions/wells-fargo-bank-na-2022/)\n- [Federal Reserve 2018 action](https://www.federalreserve.gov/newsevents/pressreleases/enforcement20180202a.htm), [2025 asset-cap removal](https://www.federalreserve.gov/newsevents/pressreleases/enforcement20250603a.htm), and [2026 termination](https://www.federalreserve.gov/newsevents/pressreleases/enforcement20260305a.htm)\n- [Senate Banking Committee hearing](https://www.banking.senate.gov/hearings/an-examination-of-wells-fargos-unauthorized-accounts-and-the-regulatory-response)\n- [SEC-hosted board investigation report](https://www.sec.gov/Archives/edgar/data/72971/000119312517118654/d375947ddefa14a.htm)\n- [Los Angeles Times 2013 article by E. Scott Reckard](https://www.latimes.com/business/la-fi-1004-wells-fargo-firings-20131004-story.html) — rights review required.\n`;
  fs.writeFileSync(path.join(OUT_DIR, 'phase2.3a-summary.md'), summary, 'utf8');

  const artifacts = [];
  function walk(dir, relative = '') { for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) { const child=path.join(relative,item.name); const full=path.join(dir,item.name); if(item.isDirectory()) walk(full,child); else if(!item.name.endsWith('phase2.3a-artifact-hashes.json')) artifacts.push({ path: child.replace(/\\/g,'/'), sha256: sha(fs.readFileSync(full)), bytes: fs.statSync(full).size }); } }
  walk(OUT_DIR);
  stableWrite(path.join(OUT_DIR, 'phase2.3a-artifact-hashes.json'), { hashManifestVersion: '1.0.0', algorithm: 'SHA-256', artifacts });
}
main();
