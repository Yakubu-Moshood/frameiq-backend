'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const base=path.resolve(__dirname,'..','..','..','..'), wf=path.join(base,'artifacts/empire-omitted-v3/wells-fargo'),out=path.join(wf,'phase2.3b-evidence');
const cand=JSON.parse(fs.readFileSync(path.join(wf,'phase2.3a/evidence-source-candidates.json'),'utf8'));
const defsPath=path.join(wf,'phase2.2d/shot-definitions.phase2.2d.json'),defs=JSON.parse(fs.readFileSync(defsPath,'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),cmap=new Map(cand.entries.map(x=>[x.shotId,x]));
const sources={
loc:['https://www.loc.gov/pictures/item/2002719065/','Wells Fargo express office, C Street, Virginia City, Nevada','Library of Congress','1866'],
doj:['https://www.justice.gov/archives/opa/pr/wells-fargo-agrees-pay-3-billion-resolve-criminal-and-civil-investigations-sales-practices','Wells Fargo Agrees to Pay $3 Billion to Resolve Criminal and Civil Investigations into Sales Practices','U.S. Department of Justice','2020-02-21'],
cfpb16:['https://files.consumerfinance.gov/f/documents/092016_cfpb_WFBconsentorder.pdf','Consent Order, In re Wells Fargo Bank, N.A.','CFPB','2016-09-08'],
cfpb16r:['https://www.consumerfinance.gov/archive/newsroom/consumer-financial-protection-bureau-fines-wells-fargo-100-million-widespread-illegal-practice-secretly-opening-unauthorized-accounts/','CFPB fines Wells Fargo; related OCC and Los Angeles actions','CFPB','2016-09-08'],
senate:['https://www.banking.senate.gov/hearings/an-examination-of-wells-fargos-unauthorized-accounts-and-the-regulatory-response','An Examination of Wells Fargo unauthorized accounts and regulatory response','U.S. Senate Banking Committee','2016-09-20'],
transcript:['https://www.congress.gov/114/chrg/CHRG-114shrg23001/CHRG-114shrg23001.pdf','Senate hearing transcript','U.S. Congress','2016-09-20'],
board:['https://www.sec.gov/Archives/edgar/data/72971/000119312517118654/d375947ddefa14a.htm','Independent Directors Sales Practices Investigation Report','Wells Fargo, SEC filing','2017-04-10'],
secq3:['https://www.sec.gov/Archives/edgar/data/72971/000007297116001300/wellsfargo3q16quarterlys.htm','Third Quarter 2016 Supplement','Wells Fargo, SEC filing','2016-10-14'],
secorder:['https://www.sec.gov/Archives/edgar/data/72971/000007297120000214/exhibit994secorder.htm','SEC Order: Wells Fargo sales practices and disclosure failures','SEC','2020-12-21'],
annual:['https://www.sec.gov/Archives/edgar/data/72971/000007297116001045/wfc-12312015xex13.htm','2015 Annual Report','Wells Fargo, SEC filing','2016-02-24'],
stumpf:['https://www.occ.gov/static/enforcement-actions/ea2020-004.pdf','OCC Consent Order, John Stumpf','OCC','2020-01-22'],
tolstedt:['https://www.occ.gov/static/enforcement-actions/ea2023-005.pdf','OCC Consent Order, Carrie Tolstedt','OCC','2023-05-11'],
secTol:['https://www.sec.gov/newsroom/press-releases/2023-99','Former Wells Fargo Executive to Pay Civil Penalty','SEC','2023-05-31'],
cfpb22:['https://files.consumerfinance.gov/f/documents/cfpb_wells-fargo-na-2022_consent-order_2022-12.pdf','Consent Order, In re Wells Fargo Bank, N.A.','CFPB','2022-12-20'],
cfpb22r:['https://www.consumerfinance.gov/archive/newsroom/cfpb-orders-wells-fargo-to-pay-37-billion-for-widespread-mismanagement-of-auto-loans-mortgages-and-deposit-accounts/','CFPB orders Wells Fargo to pay $3.7 billion','CFPB','2022-12-20'],
fed18:['https://www.federalreserve.gov/newsevents/pressreleases/enforcement20180202a.htm','Federal Reserve restricts Wells Fargo growth pending governance and control improvements','Federal Reserve','2018-02-02'],
fed25:['https://www.federalreserve.gov/newsevents/pressreleases/enforcement20250603a.htm','Federal Reserve removes Wells Fargo asset growth restriction','Federal Reserve','2025-06-03'],
fed26:['https://www.federalreserve.gov/newsevents/pressreleases/enforcement20260305a.htm','Federal Reserve terminates remaining Wells Fargo enforcement action','Federal Reserve','2026-03-05'],
latimes:['https://www.latimes.com/business/la-fi-1004-wells-fargo-firings-20131004-story.html','Wells Fargo accuses workers of opening fake accounts to meet goals','Los Angeles Times','2013-10-03'],
osha:['https://obis.osha.gov/as/opa/quicktakes/qt081517.html','Wells Fargo ordered to reinstate, pay Southern California whistleblower','OSHA','2017-08-15'],
dojTol:['https://www.justice.gov/usao-cdca/pr/former-wells-fargo-executive-agrees-plead-guilty-obstructing-bank-examination','Former Wells Fargo Executive Agrees to Plead Guilty to Obstructing Bank Examination','DOJ','2023-03-15'],
wach:['https://www.sec.gov/Archives/edgar/data/36995/000089882208000944/wellsfargo8k.htm','Wells Fargo and Wachovia merger filing','Wells Fargo, SEC filing','2008-10-09'],
occNotice:['https://www.occ.gov/static/enforcement-actions/eaN20-001.pdf','OCC Notice of Charges, Wells Fargo sales practices','OCC','2020-01-22']
};
const group={
ACT1_B003:['doj','DOJ announced a $3 billion resolution of criminal and civil investigations.','Press release, opening paragraphs','SUPPORTED_FACTUAL_LEAD'],
ACT1_B024:['senate','Hearing page identifies Stumpf as witness; the exact scapegoating clip is not cleared.','Hearing page; precise transcript/timecode not established','PENDING_EXACT_CLIP'],
ACT1_B025:['cfpb16','CFPB findings describe sales goals and unauthorized account practices.','Order findings; pinpoint paragraph requires review','SUPPORTED_FACTUAL_LEAD'],
ACT1_B029:['dojTol','DOJ says Tolstedt agreed to plead guilty to obstructing a bank examination.','Press release opening paragraphs','SUPPORTED_FACTUAL_LEAD'],
ACT2_B001:['loc','LOC catalog identifies Wells Fargo express office, C Street, Virginia City, Nevada.','LOC item 2002719065; image object retrieved','SUPPORTED_OBJECT; RIGHTS_REVIEW'],
ACT2_B007:['wach','Filing describes Wells Fargo-Wachovia stock-for-stock merger agreement.','Form 8-K merger section','FACTUAL_LEAD_ONLY; headline absent'],
ACT2_B008:['annual','2015 annual report ranks Wells Fargo first by market value of common stock among U.S. banks, not first by assets.','2015 annual report competition discussion; page pinpoint needed','SUPPORTED_WITH_WORDING_LIMIT'],
ACT2_B017:['transcript','Warren quotes Stumpf on cross-sell success as a reason to buy Wells Fargo stock.','Hearing transcript pp. 31-32','WORDS_SUPPORTED; requested video absent'],
ACT2_B019:['senate','Committee page records 2016-09-20 hearing and links witness materials.','Hearing page; matching video not downloaded','PENDING_VIDEO'],
ACT3_B009:['secorder','SEC findings describe sales-practice misconduct and record/signature falsification.','Factual findings; actual signature exhibit not located','FINDINGS_ONLY'],
ACT3B_B008:['secq3','Wells Fargo reported refunding $2.6m in fees associated with potentially unauthorized accounts.','Q3 2016 supplement, remediation discussion','SUPPORTED_BANK_ATTRIBUTION'],
ACT3B_B012:['board','Board report: approximately 5,300 terminations for sales-practice violations, 2011-Mar 2016.','Investigation report employee-discipline section','SUPPORTED_FACTUAL_LEAD'],
ACT4_B001:['latimes','Existing lead identifies E. Scott Reckard 2013 LA Times reporting; article text/exhibit not retrieved.','Article page; access and reuse unresolved','PENDING_ACCESS_RIGHTS'],
ACT4_B002:['latimes','Exact passage and image reuse rights were not cleared.','Article page; pinpoint excerpt unavailable','PENDING_ACCESS_RIGHTS'],
ACT4_B003:['occNotice','OCC notice is not the City of Los Angeles complaint specifically required.','No matching complaint pinpoint established','REJECT_WRONG_DOCUMENT'],
ACT4_B004:['cfpb16r','Combined announcement components: CFPB $100m, OCC $35m, Los Angeles $50m.','CFPB release settlement-breakdown paragraphs','SUPPORTED_AGGREGATE; three-source citation review'],
ACT4_B005:['senate','Committee page identifies hearing; room visual/video asset not captured.','Hearing page','PENDING_MEDIA'],
ACT4_B006:['transcript','Transcript includes Warren questioning Stumpf on compensation; exact clip timecode needed.','Hearing transcript compensation exchange; pinpoint review','PENDING_CLIP'],
ACT4_B007:['transcript','Stumpf response must be checked against transcript/audio before clip selection.','Hearing transcript compensation exchange','PENDING_EXACT_EXCHANGE'],
ACT4_B009:['board','Board report documents clawback decisions; exact amount/paragraph needs confirmation.','Compensation section; pinpoint review','SUPPORTED_LEAD_NOT_PINPOINTED'],
ACT4_B010:['board','Report records about $69m Stumpf compensation forfeiture/clawback.','Compensation section; pinpoint page/reuse review','SUPPORTED_FACT_RIGHTS'],
ACT4_B011:['board','$125m Tolstedt holdings claim was not verified in reviewed source.','No supporting pinpoint established','REJECT_UNSUPPORTED_CLAIM'],
ACT4_B012:['board','Report describes about $67m Tolstedt compensation consequences.','Compensation section; confirm precise breakdown','SUPPORTED_FACT_RIGHTS'],
ACT4_B013:['board','Board report states Tolstedt received no severance.','Compensation section; pinpoint/reuse review','SUPPORTED_FACT_RIGHTS'],
ACT4_B016:['cfpb22','Order covers payment-protection add-ons and auto-loan servicing/insurance practices.','Order auto-loan findings pp. 20-21','SUPPORTED_SCOPE; exact count review'],
ACT4_B017:['cfpb22','Order discusses repossessions; specific insurance-charge causal link needs verification.','Auto-loan findings pp. 20-21','PENDING_CAUSAL_LINK'],
ACT4_B018:['cfpb22','Order includes mortgage-servicing failures and fees across product lines.','Mortgage servicing findings; pinpoint review','SUPPORTED_SCOPE'],
ACT4_B019:['fed18','Fed imposed asset-growth restriction pending governance/control improvements.','Press release opening paragraphs and linked order','SUPPORTED_FACT'],
ACT4_B020:['fed18','Order requires governance, risk-management and controls improvements.','Press release and incorporated order','SUPPORTED_FACT'],
ACT4_B021:['fed25','Fed announced removal of asset cap June 3, 2025.','Press release opening paragraphs','SUPPORTED_FACT'],
ACT4_B022:['fed26','Fed announced termination of remaining 2018 enforcement action March 5, 2026.','Press release opening paragraphs','SUPPORTED_FACT'],
ACT4_B024:['cfpb22r','$3.7bn consists of >$2bn consumer redress plus $1.7bn civil penalty; not all penalties.','Press release opening paragraphs','REVISE_INACCURATE_GRAPHIC'],
ACT5_B001:['doj','DOJ announced a $3bn criminal and civil resolution.','Press release opening paragraphs','SUPPORTED_FACT'],
ACT5_B002:['stumpf','OCC order imposes $17.5m penalty and prohibition on Stumpf.','Ordering paragraphs','SUPPORTED_FACT; local download blocked'],
ACT5_B005:['dojTol','DOJ says Tolstedt agreed to plead guilty to obstructing bank examination.','Press release opening paragraphs','SUPPORTED_FACT'],
ACT5_B006:['dojTol','Plea announcement is not the sentencing judgment; probation source still required.','No sentencing order verified','REJECT_WRONG_STAGE'],
ACT5_B007:['tolstedt','OCC imposed $17m civil money penalty and prohibition on Tolstedt.','Ordering paragraphs','SUPPORTED_FACT; local download blocked'],
ACT5_B008:['secTol','SEC separately announced a $3m civil penalty against Tolstedt.','SEC release opening paragraphs','SUPPORTED_FACT'],
ACT5_B011:['osha','OSHA reports reinstatement and >$577,000 for whistleblower.','OSHA release opening paragraphs','SUPPORTED_FACT']
};
const overrides={
ACT1_B003:'doj',ACT1_B024:'senate',ACT1_B025:'cfpb16',ACT1_B029:'dojTol',
ACT2_B001:'loc',ACT2_B005:'wach',ACT2_B006:'loc',ACT2_B007:'wach',ACT2_B008:'annual',ACT2_B017:'transcript',ACT2_B018:'senate',ACT2_B019:'senate',
ACT3_B009:'secorder',ACT3_B017:'senate',ACT3_B024:'senate',
ACT3B_B008:'secq3',ACT3B_B012:'board',
ACT4_B001:'latimes',ACT4_B002:'latimes',ACT4_B003:'occNotice',ACT4_B004:'cfpb16r',ACT4_B005:'senate',ACT4_B006:'transcript',ACT4_B007:'transcript',ACT4_B008:'senate',ACT4_B009:'board',ACT4_B010:'board',ACT4_B011:'board',ACT4_B012:'board',ACT4_B013:'board',ACT4_B016:'cfpb22',ACT4_B017:'cfpb22',ACT4_B018:'cfpb22',ACT4_B019:'fed18',ACT4_B020:'fed18',ACT4_B021:'fed25',ACT4_B022:'fed26',ACT4_B024:'cfpb22r',
ACT5_B001:'doj',ACT5_B002:'stumpf',ACT5_B005:'dojTol',ACT5_B006:'dojTol',ACT5_B007:'tolstedt',ACT5_B008:'secTol',ACT5_B011:'osha'
};
const accessible=new Set(['loc','doj','cfpb16r','senate','transcript','board','secq3','secorder','annual','cfpb22r','fed18','fed25','fed26','dojTol']);
const localShot='ACT2_B001', localName='loc-wells-fargo-express-office-1866.jpg';
const assetPath=path.join(out,'assets',localName), entries=[],matrix=[];
for(const shot of defs.allShots.filter(x=>x.assetType==='evidence_reference')){
 const lead=cmap.get(shot.shotId); if(!lead) throw Error('CANDIDATE_MISSING:'+shot.shotId);
 const key=overrides[shot.shotId]||null,src=key?sources[key]:null,g=group[shot.shotId],local=shot.shotId===localShot;
 const url=src?.[0]||lead.selectedSourceUrl,title=src?.[1]||lead.sourceTitle,publisher=src?.[2]||lead.publisher,date=src?.[3]||lead.publicationDate||null;
 const mark=g?.[3]||'UNVERIFIED';
 const rejected=mark.startsWith('REJECT')||mark.startsWith('REVISE');
 const factual=mark.startsWith('SUPPORTED')||mark.startsWith('WORDS_SUPPORTED')||mark.startsWith('FINDINGS_ONLY');
 const rights=local||['board','secq3','annual','latimes'].includes(key)?'RIGHTS_UNCLEAR':'OFFICIAL_GOVERNMENT_SOURCE';
 const rightsNotes=local?'LOC states no known restrictions on publication but does not grant/deny rights; human asset-specific reuse decision required.':rights==='RIGHTS_UNCLEAR'?'No asset-specific reuse permission established; rights review or separately cleared replacement required.':'Government-origin record lead; confirm exact asset is government-authored and excludes third-party material before reuse.';
 const bytes=local?fs.readFileSync(assetPath):null, hash=bytes?sha(bytes):null;
 const access=local?'ACCESSIBLE':key&&accessible.has(key)?'ACCESSIBLE':'ACCESSIBILITY_UNCHECKED';
 const approval=rejected?'REJECTED':'REVIEW_REQUIRED';
 const factStatus=factual?'SUPPORTED':rejected?'UNSUPPORTED':'PENDING';
 const exp=g?.[1]||'Exact source passage, page, or timecode not verified; this candidate lead remains unresolved.';
 const page=g?.[2]||'No source-specific page/excerpt/timecode verified.';
 entries.push({shotId:shot.shotId,exactSourceRequirement:shot.evidenceRequirement.description,selectedSourceUrl:url,sourceTitle:title,publisher,publicationDate:date,assetType:local?'ARCHIVAL_PHOTOGRAPH':'SOURCE_LEAD_NOT_RETRIEVED',directAssetUrl:local?'https://cdn.loc.gov/service/pnp/ds/04400/04481v.jpg':null,retrievalDate:local?'2026-09-27':null,localFilename:local?localName:null,sha256:hash,mimeType:local?'image/jpeg':null,dimensionsOrDuration:local?'453079 bytes; pixel dimensions not verified':null,sourceAuthority:key==='loc'?'LOC catalog; archival object identified':key==='board'||key==='secq3'||key==='annual'?'Issuer-authored SEC-hosted filing':'Primary agency or official public record lead',rightsClassification:rights,rightsNotes,factualRelevance:exp,excerptOrTimecode:page,approvalStatus:approval,rejectionReason:rejected?mark:null,sourceAccessStatus:access,factualSupportStatus:factStatus});
 matrix.push({shotId:shot.shotId,actKey:shot.actKey,beatId:shot.beatId,exactClaim:shot.narrationExcerpt,visualRequirement:shot.evidenceRequirement.description,visualIntent:shot.visualIntent,selectedSource:{url,title,publisher,publicationDate:date},supportingExcerptOrPage:page,sourceAccessibility:access,selectedLocalAsset:local?localName:null,assetSha256:hash,factualSupportAssessment:exp,factualSupportStatus:factStatus,rightsBasis:rights,rightsRestriction:rightsNotes,recommendedDecision:rejected?'REJECT_OR_REVISE':factual?'HUMAN_APPROVAL_REQUIRED':'UNRESOLVED'});
}
const manifest={manifestVersion:'1.0.0',episodeId:defs.episodeId,shotDefinitionsSha256:sha(fs.readFileSync(defsPath)),sourceStatus:'HUMAN_REVIEW_REQUIRED_NOT_APPROVED',entries};
fs.writeFileSync(path.join(out,'evidence-source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(out,'evidence-matrix.v1.json'),JSON.stringify({schemaVersion:'phase2.3b-evidence-matrix/1.0.0',episodeId:defs.episodeId,shotDefinitionsSha256:manifest.shotDefinitionsSha256,entries:matrix},null,2)+'\n');
fs.writeFileSync(path.join(out,'asset-hashes.json'),JSON.stringify({schemaVersion:'phase2.3b-evidence-assets/1.0.0',assets:[{filename:localName,bytes:fs.statSync(assetPath).size,sha256:sha(fs.readFileSync(assetPath))}]},null,2)+'\n');
const req=matrix.filter(x=>x.recommendedDecision==='UNRESOLVED').map(x=>x.shotId),review=matrix.filter(x=>x.recommendedDecision==='HUMAN_APPROVAL_REQUIRED').map(x=>x.shotId),reject=matrix.filter(x=>x.recommendedDecision==='REJECT_OR_REVISE').map(x=>x.shotId);
let report='# Wells Fargo Phase 2.3B evidence review\n\nCandidate package only; no human approvals or rights clearances are asserted. Strict evidence and render gates are expected to fail until source-specific media, factual support, local assets, rights decisions, and human approvals are complete.\n\n';
report+='- Evidence-reference shots: '+matrix.length+'\n- Production-ready: 0\n- Rejected/revise recommendation: '+reject.length+'\n- Unresolved source/media/claim decisions: '+req.length+'\n- Human approval required for factually supported leads: '+review.length+'\n- Downloaded local assets: 1\n\n## Decisions requiring human review\n\n';
report+='**Reject or revise ('+reject.length+'):** '+reject.join(', ')+'.\n\n';
report+='**Unresolved source/media/claim ('+req.length+'):** '+req.join(', ')+'.\n\n';
report+='**Factually supported lead, but asset rights/approval outstanding ('+review.length+'):** '+review.join(', ')+'.\n\n';
report+='Specific red flags: ACT2_B008 supports largest by market value, not assets; ACT4_B003 lacks the specifically requested City complaint; ACT4_B011 $125m holdings unsupported; ACT4_B024 $3.7bn is redress plus civil penalty, not all penalties; ACT5_B006 plea announcement is not the sentence; ACT2_B017 transcript supports words but not requested footage. ACT3B_B008 $2.6m is Wells Fargo own-reported figure; CFPB order is not support for that figure. LOC image is downloaded but reuse is not cleared.\n\n';
report+='## Strict gate results\n\nRun strict validation using the exact locked shot definitions and local asset directory. The package intentionally has zero approved entries; failure is correct and must block rendering. See validation-report.json.\n';
fs.writeFileSync(path.join(out,'HUMAN_REVIEW.md'),report);
console.log(JSON.stringify({count:matrix.length,productionReady:0,rejected:reject.length,unresolved:req.length,humanApproval:review.length,manifestSha256:sha(fs.readFileSync(path.join(out,'evidence-source-manifest.json')))},null,2));
