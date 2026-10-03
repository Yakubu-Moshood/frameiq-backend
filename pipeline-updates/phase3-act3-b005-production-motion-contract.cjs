'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTRACT_PATH = path.join(__dirname, 'phase3-act3-b005-production-motion-contract.v1.json');
const APPROVAL_PATH = path.join(__dirname, 'phase3-act3-b005-production-motion-approval.v1.json');
const CONTRACT_SHA256 = '3de05198dbc264595643dd1054b2f27ddca7baa372064b1ec5378c50d25f8979';
const APPROVAL_SHA256 = '2b48bcd255d60db4bfd554eb2c482ed32c6f80debd2441290b9266d7770a3b0f';
const PRODUCTION_REQUEST_KEY = 'cc2927c051bdff21bec411f3110d0f248797ac431e68e4ad3e0296a668b9fb14';
const PILOT_REQUEST_KEYS = new Set([
  'a74eaf05273a5de26cb8b442beab03a929f4af957730ca7502dc802c3d968130',
  'bd8e80547f1d5371644540aa5d0ceb20e05a16845f1ea28dbd29449172c59d10',
  'd49253e9ff98d254350a13929d56488a05b7a3b2a28a76b8c8b75d0b9ab318b1',
]);

const EXPECTED_BINDINGS = Object.freeze({
  finalizedPilotReceiptSha256: '7799de961366d32a3ce9e47923b1a2ee25453186a6dc13365501443ef6d2fc02',
  finalizedOutputIndexSha256: 'a3f67bbf6cab9290b5f4c6285ff8e5631f786df99df08f5c86f8909fbfeaa11f',
  productionMotionProposalSha256: 'aa6b65ae45ae4f43502df5ee6b81c41e9e47938db0790c7f374ee5051bcca431',
  pilotHumanValidationApprovalSha256: '0ee2ce8916225eb13c061cd360d59c25a8127e7bd908ae85b06cc679f3845e2c',
  approvedStillSha256: '34dbcf51e05f01eee0f4801202044b026a9b96c1ce07ee8efc15b45cbee57ac6',
  rawPilotAnimationSha256: 'a1e5d7cbc54a85f5dff0295633776ddb4870ca70c07a6b3c2ad6516e3bb77f2b',
  fittedPilotAnimationSha256: '80f0df569ede30486c9fdc8b7f338e05eb36d25d3f53f20bf02ecf2b4bb909f0',
  animationReceiptSha256: 'cbc771f2badafe8cdaa0e5985d18f5223df9449b0a6c8d0c91736dc8c9c24275',
  pilotLedgerSha256: '0e62704de96f16d690f58fc5a9b9c53671c8902a20be12985c58970467f42d83',
  animationAuthorizationSha256: 'ac03ac82fd6efedbd9efaf1b4118ee523d33bf4f999196e574749b9ddba6e796',
  animationExtensionPackageIndexSha256: '00969089236256818908bc82174f6263e690958e65769e3afead39ce1e6bec26',
  animationExtensionPlanningApprovalSha256: '4b2a72062a0defd1c945a413995c5108d0a2d5fd8ea64af1f5b3f7927e312047',
});

const POSITIVE_REQUIREMENT = 'The customer slides the card horizontally across the desk. The card remains flat, face-up and in continuous contact with the wood surface throughout the movement. It must not be lifted, carried, tilted, flipped or allowed to hover. The customer’s fingertips guide the card along the desk while the banker begins typing. Camera position and framing remain locked.';
const NEGATIVE_CONSTRAINTS = Object.freeze([
  'card visibly separating from the desk', 'carrying rather than sliding', 'hovering', 'flipping', 'material tilting',
  'card design changing during the shot', 'text, numbers, logos or personal information',
  'deformed hands or implausible contact', 'unclear banker typing', 'revealed face', 'camera movement',
  'flicker', 'duplication', 'morphing',
]);
const REJECTION_CONDITIONS = Object.freeze([
  'The card visibly separates from the desk.', 'The customer carries rather than slides the card.',
  'The card hovers.', 'The card flips.', 'The card materially tilts.', 'The card design changes during the shot.',
  'Text, numbers, logos or personal information appear.', 'Hands deform or lose plausible contact.',
  'The banker’s typing becomes unclear.', 'A face is revealed.', 'Camera movement occurs.',
  'Flicker, duplication or morphing occurs.',
]);
const FALLBACK_POLICY = 'If a generative animation cannot satisfy the surface-contact requirement, route ACT3_B005 to deterministic/keyframed animation. Do not repeatedly regenerate it in an attempt to force compliance.';

function fail(code) { throw new Error(`[act3-b005-motion] ${code}`); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function isPilotPath(value) { return typeof value !== 'string' || /(?:^|[\\/])\.review[\\/]phase3-media-pilots(?:[\\/]|$)/i.test(value); }

function verifyAct3B005ProductionMotionContract({ contractBytes = fs.readFileSync(CONTRACT_PATH), approvalBytes } = {}) {
  if (!Buffer.isBuffer(contractBytes) || sha256(contractBytes) !== CONTRACT_SHA256) fail('CONTRACT_HASH_MISMATCH');
  if (!Buffer.isBuffer(approvalBytes) || sha256(approvalBytes) !== APPROVAL_SHA256) fail('APPROVAL_HASH_MISMATCH');
  let contract, approval;
  try { contract = JSON.parse(contractBytes.toString('utf8')); approval = JSON.parse(approvalBytes.toString('utf8')); }
  catch { fail('JSON_INVALID'); }
  if (contract.schemaVersion !== 'phase3-production-motion-contract/1.0.0'
      || contract.status !== 'APPROVED_FOR_FUTURE_PRODUCTION_PLANNING_ONLY'
      || contract.beatId !== 'ACT3_B005' || contract.actKey !== 'act3'
      || contract.approvalRecord?.sha256 !== APPROVAL_SHA256
      || contract.productionRequest?.requestKey !== PRODUCTION_REQUEST_KEY
      || contract.productionRequest?.derivation !== `sha256('phase3-production-motion-request/v1|ACT3_B005|' + approvalRecord.sha256 + '|' + sourceCandidate.packageIndexSha256)`
      || JSON.stringify(contract.productionRequest?.mustNotEqualPilotRequestKeys) !== JSON.stringify([...PILOT_REQUEST_KEYS])
      || contract.sourceCandidate?.packageIndexSha256 !== '8ff011db727b1cf6ac47acff010f15d9559aa9dcfc763dc6830cbcba7916deac'
      || contract.sourceCandidate?.shotDefinitionsSha256 !== '315e0133e49fee61f5625601e4c4d434b04e1db6c6ac943809592229980da2a7'
      || contract.sourceCandidate?.productionManifestSha256 !== '0caef389bd517c5a0898377dc304708fe83666c51205fbdeeddfb365d5ec531e'
      || contract.sourceCandidate?.editPlanSha256 !== '9c2efb64c6cacfde55c4fb5492fdc9b5cff448bb907aa8aad629b3cd3f2ad02d'
      || contract.approvedMotionRequirement !== POSITIVE_REQUIREMENT
      || JSON.stringify(contract.productionPromptNegativeConstraints) !== JSON.stringify(NEGATIVE_CONSTRAINTS)
      || JSON.stringify(contract.rejectionConditions) !== JSON.stringify(REJECTION_CONDITIONS)
      || contract.fallback?.route !== 'DETERMINISTIC_KEYFRAMED_ANIMATION'
      || contract.fallback?.regenerate !== false
      || contract.productionRequest?.requestKeyReuseProhibited !== true
      || contract.unchangedApprovedFields?.approvedFrameAllocation !== 110
      || contract.unchangedApprovedFields?.durationSeconds !== 3.6599998474121094
      || contract.pilotMedia?.classification !== 'NON_PRODUCTION_DISPOSABLE_PILOT'
      || contract.pilotMedia?.productionReadiness !== 'REJECTED'
      || contract.pilotMedia?.candidateUse !== false) fail('CONTRACT_CONTENT_MISMATCH');
  if (approval.schemaVersion !== 'phase3-production-motion-human-approval/1.0.0' || approval.status !== 'APPROVED'
      || approval.approvedBy !== 'Yakubu Moshood' || approval.decision !== 'APPROVED'
      || approval.beatId !== 'ACT3_B005' || approval.scope !== 'ACT3_B005 production motion and review policy only'
      || approval.productionMotionRequirement !== POSITIVE_REQUIREMENT
      || JSON.stringify(approval.rejectionConditions) !== JSON.stringify(REJECTION_CONDITIONS)
      || approval.fallbackPolicy !== FALLBACK_POLICY
      || approval.productionAuthorization !== null || approval.providerAuthorization !== null
      || approval.mediaGenerationAuthorized !== false
      || JSON.stringify(approval.bindings) !== JSON.stringify(EXPECTED_BINDINGS)) fail('APPROVAL_CONTENT_MISMATCH');
  return { contract, approval, contractSha256: CONTRACT_SHA256, approvalSha256: APPROVAL_SHA256,
    productionRequestKey: PRODUCTION_REQUEST_KEY };
}

function resolveAct3B005ProductionMotion({ shot, manifestEntry, requestKey = PRODUCTION_REQUEST_KEY,
  sourceImagePath, outputPath, approvalBytes } = {}) {
  const verified = verifyAct3B005ProductionMotionContract({ approvalBytes });
  if (shot?.shotId !== 'ACT3_B005' || shot?.beatId !== 'ACT3_B005' || shot?.actKey !== 'act3'
      || shot?.assetType !== 'generated_clip' || manifestEntry?.shotId !== 'ACT3_B005'
      || manifestEntry?.productionMethod !== 'ESSENTIAL_ANIMATION') fail('BEAT_OWNERSHIP_MISMATCH');
  if (requestKey !== PRODUCTION_REQUEST_KEY || PILOT_REQUEST_KEYS.has(requestKey)) fail('PRODUCTION_REQUEST_KEY_INVALID');
  if (isPilotPath(sourceImagePath) || isPilotPath(outputPath)) fail('PILOT_MEDIA_PATH_FORBIDDEN');
  if (shot.durationSec !== 3.6599998474121094) fail('APPROVED_DURATION_MISMATCH');
  return Object.freeze({
    shot: { ...shot, animationPrompt: POSITIVE_REQUIREMENT },
    requestKey: verified.productionRequestKey,
    negativeConstraints: NEGATIVE_CONSTRAINTS,
    fallback: 'DETERMINISTIC_KEYFRAMED_ANIMATION',
    regenerateAfterFailedGenerativeResult: false,
    pilotMediaProductionReadiness: 'REJECTED',
  });
}

module.exports = { CONTRACT_PATH, APPROVAL_PATH, CONTRACT_SHA256, APPROVAL_SHA256, PRODUCTION_REQUEST_KEY,
  PILOT_REQUEST_KEYS, EXPECTED_BINDINGS, POSITIVE_REQUIREMENT, NEGATIVE_CONSTRAINTS, REJECTION_CONDITIONS, FALLBACK_POLICY,
  verifyAct3B005ProductionMotionContract, resolveAct3B005ProductionMotion };
