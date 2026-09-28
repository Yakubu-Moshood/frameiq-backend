'use strict';

const crypto = require('node:crypto');
const util = require('node:util');
const { CANONICAL_SHOT_FIELDS } = require('./shot-definitions-production-contract.cjs');

const HASH = /^[a-f0-9]{64}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => util.isDeepStrictEqual(left, right);

function artifactSha256(value) {
  return crypto.createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex');
}

function shotsById(shotDefs) {
  const result = new Map();
  for (const shot of shotDefs?.allShots || []) {
    if (shot && typeof shot.shotId === 'string') {
      if (!result.has(shot.shotId)) result.set(shot.shotId, []);
      result.get(shot.shotId).push(shot);
    }
  }
  return result;
}

function locateRevisionCopies(shotDefs, entry, location, error) {
  const canonical = (Array.isArray(shotDefs?.allShots) ? shotDefs.allShots : [])
    .filter(shot => shot?.shotId === entry.shotId);
  if (canonical.length !== 1) {
    error(canonical.length ? 'REVISION_SHOT_AMBIGUOUS' : 'REVISION_SHOT_UNKNOWN', `${location}/shotId`,
      `Expected exactly one canonical shot for ${entry.shotId}; found ${canonical.length}.`);
    return null;
  }
  const shot = canonical[0];
  if (shot.beatId !== entry.beatId || typeof shot.actKey !== 'string' || !shot.actKey) {
    error('REVISION_SHOT_IDENTITY_MISMATCH', `${location}/beatId`, 'The canonical shot must match the recorded beat and have an act owner.');
    return null;
  }
  // Older approved ledgers changed only the canonical allShots collection.
  // A mirror is required only when the ledger explicitly records that the
  // forward revision changed that structural copy too.
  if (entry.mirrorActKey === undefined) return { canonical: shot, mirror: null };
  if (entry.mirrorActKey !== shot.actKey) {
    error('REVISION_MIRROR_WRONG_ACT', `${location}/mirrorActKey`, 'The recorded mirror owner must equal the canonical shot act.');
    return null;
  }
  if (shotDefs.acts === undefined) {
    error('REVISION_MIRROR_MISSING', `${location}/shotId`, 'A mirrored revision requires an acts collection.');
    return null;
  }
  if (!object(shotDefs.acts)) {
    error('REVISION_MIRROR_COLLECTION_INVALID', `${location}/shotId`, 'acts must be an object when structural act mirrors are present.');
    return null;
  }
  const allActMatches = [];
  for (const [actKey, shots] of Object.entries(shotDefs.acts)) {
    if (!Array.isArray(shots)) {
      error('REVISION_MIRROR_COLLECTION_INVALID', `${location}/acts/${actKey}`, 'Each structural act mirror must be an array.');
      continue;
    }
    for (const mirror of shots) {
      if (mirror?.shotId === entry.shotId || mirror?.beatId === entry.beatId) allActMatches.push({ actKey, shot: mirror });
    }
  }
  const expected = allActMatches.filter(item => item.actKey === entry.mirrorActKey
    && item.shot?.shotId === entry.shotId && item.shot?.beatId === entry.beatId
    && item.shot?.actKey === entry.mirrorActKey);
  if (allActMatches.some(item => item.actKey !== entry.mirrorActKey || item.shot?.actKey !== entry.mirrorActKey)) {
    error('REVISION_MIRROR_WRONG_ACT', `${location}/shotId`, 'A structural mirror for this shot exists under the wrong act owner.');
    return null;
  }
  if (expected.length !== 1 || allActMatches.length !== 1) {
    error(expected.length || allActMatches.length ? 'REVISION_MIRROR_AMBIGUOUS' : 'REVISION_MIRROR_MISSING', `${location}/shotId`,
      `Expected exactly one mirror for ${shot.actKey}/${entry.beatId}; found ${allActMatches.length}.`);
    return null;
  }
  return { canonical: shot, mirror: expected[0].shot };
}

function pathValue(value, fieldPath) {
  const segments = fieldPath.split('.');
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !own(current, segment)) return { exists: false, value: undefined };
    current = current[segment];
  }
  return { exists: true, value: current };
}

function setPath(value, fieldPath, next) {
  const segments = fieldPath.split('.');
  let current = value;
  for (const segment of segments.slice(0, -1)) current = current[segment];
  current[segments.at(-1)] = structuredClone(next);
}

function validBinding(binding) {
  return object(binding) && binding.fieldPath === 'sourceEditPlanSha256'
    && HASH.test(binding.beforeValue || '') && HASH.test(binding.afterValue || '')
    && typeof binding.reason === 'string' && binding.reason.trim()
    && binding.approvalStatus === 'APPROVED' && typeof binding.revisionVersion === 'string' && binding.revisionVersion.trim();
}

function validFieldPath(fieldPath) {
  if (typeof fieldPath !== 'string' || !fieldPath.trim()) return false;
  const segments = fieldPath.split('.');
  if (!CANONICAL_SHOT_FIELDS.includes(segments[0])) return false;
  return segments.every(segment => /^[A-Za-z][A-Za-z0-9_-]*$/.test(segment) || /^\d+$/.test(segment));
}

function validateRevisionChain({ shotDefs, revisionChain } = {}) {
  const errors = [];
  const error = (code, path, message) => errors.push({ code, path, message });
  const chain = revisionChain === undefined ? [] : revisionChain;
  if (!Array.isArray(chain)) return { status: 'FAIL', errors: [{ code: 'REVISION_CHAIN_INVALID', path: '/revisionChain', message: 'revisionChain must be an explicitly supplied array.' }], approvedPlanDifferences: new Map(), counts: { historical: 0, amendments: 0 } };

  const targetShots = shotsById(shotDefs);
  const current = structuredClone(shotDefs);
  let priorResultHash = null;
  const normalized = [];
  const reconstructedParentHashes = [];

  for (let index = 0; index < chain.length; index++) {
    const ledger = chain[index];
    const location = `/revisionChain/${index}`;
    if (!object(ledger)) { error('REVISION_LEDGER_INVALID', location, 'Each revision ledger must be an object.'); continue; }
    for (const [field, predicate, description] of [
      ['ledgerVersion', value => value === '1.0.0', 'ledgerVersion must be 1.0.0.'],
      ['revisionId', value => typeof value === 'string' && value.trim(), 'revisionId is required.'],
      ['revisionVersion', value => typeof value === 'string' && value.trim(), 'revisionVersion is required.'],
      ['approvalStatus', value => value === 'APPROVED', 'Ledger approvalStatus must be APPROVED.'],
      ['lineageRole', value => ['historical', 'current'].includes(value), 'lineageRole must be historical or current.'],
      ['parentArtifactSha256', value => typeof value === 'string' && HASH.test(value), 'parentArtifactSha256 must be a lowercase SHA-256.'],
      ['resultArtifactSha256', value => typeof value === 'string' && HASH.test(value), 'resultArtifactSha256 must be a lowercase SHA-256.'],
    ]) if (!predicate(ledger[field])) error('REVISION_LEDGER_METADATA', `${location}/${field}`, description);
    if (priorResultHash && ledger.parentArtifactSha256 !== priorResultHash) error('REVISION_CHAIN_LINK', `${location}/parentArtifactSha256`, 'Each ledger parent must equal the previous ledger result hash.');
    if (!Array.isArray(ledger.entries)) { error('REVISION_ENTRIES_INVALID', `${location}/entries`, 'entries must be an array.'); continue; }
    if (ledger.retirements !== undefined && !Array.isArray(ledger.retirements)) error('REVISION_RETIREMENTS_INVALID', `${location}/retirements`, 'retirements must be an array when supplied.');
    for (const [retirementIndex, retirement] of (Array.isArray(ledger.retirements) ? ledger.retirements : []).entries()) {
      const retirementPath = `${location}/retirements/${retirementIndex}`;
      if (!object(retirement) || retirement.approvalStatus !== 'APPROVED' || !['ACT3B_B010'].includes(retirement.beatId)
          || retirement.shotId !== retirement.beatId || retirement.actKey !== 'act3b'
          || !Number.isSafeInteger(retirement.allShotsIndex) || retirement.allShotsIndex < 0
          || !Number.isSafeInteger(retirement.actShotsIndex) || retirement.actShotsIndex < 0
          || !object(retirement.shot) || retirement.shot.beatId !== retirement.beatId || retirement.shot.shotId !== retirement.shotId
          || retirement.shot.actKey !== retirement.actKey || typeof retirement.reason !== 'string' || !retirement.reason.trim()) {
        error('REVISION_RETIREMENT_INVALID', retirementPath, 'Only the approved ACT3B_B010 retirement with its exact shot snapshot and positions is allowed.');
      }
      if (retirement.actShot !== undefined && (!object(retirement.actShot) || retirement.actShot.beatId !== retirement.beatId || retirement.actShot.shotId !== retirement.shotId || retirement.actShot.actKey !== retirement.actKey)) error('REVISION_RETIREMENT_ACT_SNAPSHOT_INVALID', retirementPath, 'Optional per-act snapshot must preserve the retired shot identity.');
      if (retirement.revisionLineageEntry !== `approved-retirement:act3b:${retirement.beatId}`) error('REVISION_RETIREMENT_LINEAGE_ENTRY', retirementPath, 'Retirement must cite its exact approved lineage entry.');
    }
    if (ledger.bindings !== undefined && !Array.isArray(ledger.bindings)) error('REVISION_BINDINGS_INVALID', `${location}/bindings`, 'bindings must be an array when supplied.');
    const bindings = Array.isArray(ledger.bindings) ? ledger.bindings : [];
    for (let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex++) {
      const binding = bindings[bindingIndex];
      if (!validBinding(binding) || binding.revisionVersion !== ledger.revisionVersion) error('REVISION_BINDING_INVALID', `${location}/bindings/${bindingIndex}`, 'Only an approved sourceEditPlanSha256 binding with exact hashes and matching revision version is permitted.');
    }
    const seen = new Set();
    const entries = [];
    for (let entryIndex = 0; entryIndex < ledger.entries.length; entryIndex++) {
      const entry = ledger.entries[entryIndex];
      const entryPath = `${location}/entries/${entryIndex}`;
      if (!object(entry)) { error('REVISION_ENTRY_INVALID', entryPath, 'Revision entries must be objects.'); continue; }
      for (const field of ['shotId', 'beatId', 'fieldPath', 'reason', 'revisionVersion']) {
        if (typeof entry[field] !== 'string' || !entry[field].trim()) error('REVISION_ENTRY_FIELD', `${entryPath}/${field}`, `${field} is required.`);
      }
      if (!own(entry, 'beforeValue') && !HASH.test(entry.beforeSha256 || '')) error('REVISION_ENTRY_BEFORE', `${entryPath}/beforeValue`, 'Entry needs beforeValue or beforeSha256.');
      if (!own(entry, 'afterValue') && !HASH.test(entry.afterSha256 || '')) error('REVISION_ENTRY_AFTER', `${entryPath}/afterValue`, 'Entry needs afterValue or afterSha256.');
      if (entry.approvalStatus !== 'APPROVED') error('REVISION_ENTRY_APPROVAL', `${entryPath}/approvalStatus`, 'Every entry must be explicitly APPROVED.');
      if (entry.revisionVersion !== ledger.revisionVersion) error('REVISION_ENTRY_VERSION', `${entryPath}/revisionVersion`, 'Entry revisionVersion must match its ledger.');
      if (!validFieldPath(entry.fieldPath)) error('REVISION_FIELD_UNKNOWN', `${entryPath}/fieldPath`, 'fieldPath must identify a known canonical shot field.');
      const key = `${entry.shotId}\0${entry.fieldPath}`;
      if (seen.has(key)) error('REVISION_ENTRY_DUPLICATE', entryPath, 'A ledger cannot revise the same shot field twice.');
      seen.add(key);
      const approvedRetirement = entry.shotId === 'ACT3B_B010'
        ? chain.flatMap(item => Array.isArray(item?.retirements) ? item.retirements : []).find(item => item?.shotId === entry.shotId && item?.beatId === entry.beatId && item?.actKey === 'act3b' && item?.approvalStatus === 'APPROVED' && item?.shot?.shotId === entry.shotId && item?.shot?.beatId === entry.beatId)
        : null;
      const copies = targetShots.get(entry.shotId) || (approvedRetirement ? [approvedRetirement.shot] : null);
      if (!copies?.length) error('REVISION_SHOT_UNKNOWN', `${entryPath}/shotId`, 'Ledger references a shot absent from the artifact.');
      else if (copies.length !== 1) error('REVISION_SHOT_AMBIGUOUS', `${entryPath}/shotId`, 'A canonical shot ID must occur exactly once.');
      else if (entry.beatId !== copies[0].beatId) error('REVISION_BEAT_MISMATCH', `${entryPath}/beatId`, 'beatId must identify the supplied shot.');
      if (!Array.isArray(ledger.permittedImmutablePaths)) error('REVISION_PERMISSIONS_INVALID', `${location}/permittedImmutablePaths`, 'permittedImmutablePaths must be an explicit array.');
      const rootField = entry.fieldPath?.split('.')[0];
      const immutable = new Set(['shotId', 'beatId', 'sequenceId', 'actKey', 'startWordIndex', 'endWordIndex', 'startSec', 'endSec', 'durationSec', 'narrationExcerpt', 'triggerWord', 'graphics', 'overlaySpecification']);
      if (immutable.has(rootField) && !ledger.permittedImmutablePaths?.includes(`${entry.shotId}.${entry.fieldPath}`)) {
        error('REVISION_IMMUTABLE_FIELD', `${entryPath}/fieldPath`, 'This field requires an exact shot-and-field permission in the applicable ledger.');
      }
      entries.push(entry);
    }

    if (ledger.approval?.status !== 'APPROVED' || typeof ledger.approval?.basis !== 'string' || !ledger.approval.basis.trim()) error('REVISION_ATTESTATION', `${location}/approval`, 'Ledger needs an explicit approval attestation and basis.');
    normalized.push({ ...ledger, entries, bindings });
    priorResultHash = ledger.resultArtifactSha256;
  }

  // Walk from the supplied final artifact back through the chain. Each layer's
  // result hash is checked before its exact approved changes are reversed.
  for (let index = normalized.length - 1; index >= 0; index--) {
    const ledger = normalized[index];
    const location = `/revisionChain/${index}`;
    const currentHash = artifactSha256(current);
    if (currentHash !== ledger.resultArtifactSha256) error('REVISION_RESULT_HASH', `${location}/resultArtifactSha256`, `Current artifact hash ${currentHash} does not match this ledger result.`);
    for (const entry of [...ledger.entries].reverse()) {
      const entryIndex = ledger.entries.indexOf(entry);
      const copies = locateRevisionCopies(current, entry, `${location}/entries/${entryIndex}`, error);
      if (!copies) continue;
      const targets = copies.mirror ? [copies.canonical, copies.mirror] : [copies.canonical];
      const values = [];
      for (const copy of targets) {
        const activeValue = pathValue(copy, entry.fieldPath);
        if (!activeValue.exists) {
          error('REVISION_FIELD_UNKNOWN', `${location}/entries/${entryIndex}/fieldPath`, 'fieldPath does not exist on the referenced shot.');
          values.push({ exists: false, value: undefined });
        } else {
          values.push(activeValue);
        }
      }
      if (values.some(item => !item.exists)) continue;
      if (copies.mirror && !same(values[0].value, values[1].value)) {
        error('REVISION_MIRROR_VALUE_MISMATCH', `${location}/entries/${entryIndex}/afterValue`, 'Canonical and mirrored child values must agree before reversal.');
        continue;
      }
      if (!own(entry, 'beforeValue') || !own(entry, 'afterValue')
          || !same(values[0].value, entry.afterValue)
          || (copies.mirror && !same(values[1].value, entry.afterValue))) {
        error('REVISION_AFTER_VALUE', `${location}/entries/${entryIndex}/afterValue`, 'Every canonical and mirrored child value must equal the exact approved afterValue.');
        continue;
      }
      // Validate every copy before changing any copy, so a revision is reversed
      // atomically across the canonical shot and all of its required mirrors.
      for (const copy of targets) setPath(copy, entry.fieldPath, entry.beforeValue);
    }
    for (const binding of [...ledger.bindings].reverse()) {
      if (!same(current.sourceEditPlanSha256, binding.afterValue)) {
        error('REVISION_BINDING_AFTER_VALUE', `${location}/bindings`, 'Active source edit-plan binding does not match the exact approved afterValue.');
      } else current.sourceEditPlanSha256 = binding.beforeValue;
    }
    for (const retirement of [...(ledger.retirements || [])].reverse()) {
      if (shotsById(current).has(retirement.shotId)) {
        error('REVISION_RETIREMENT_STILL_ACTIVE', `${location}/retirements`, 'A retired shot must be absent from the active artifact.');
        continue;
      }
      current.allShots.splice(retirement.allShotsIndex, 0, structuredClone(retirement.shot));
      const actShots = current.acts?.[retirement.actKey];
      if (!Array.isArray(actShots)) error('REVISION_RETIREMENT_ACT_MISSING', `${location}/retirements`, 'Retired shot act collection is missing.');
      else actShots.splice(retirement.actShotsIndex, 0, structuredClone(retirement.actShot || retirement.shot));
      if (current.totalShots !== undefined) current.totalShots++;
    }
    const parentHash = artifactSha256(current);
    reconstructedParentHashes[index] = parentHash;
    if (parentHash !== ledger.parentArtifactSha256) error('REVISION_PARENT_HASH', `${location}/parentArtifactSha256`, `Reconstructed parent hash ${parentHash} does not match the declared parent.`);
  }

  const approvedPlanDifferences = new Map();
  if (!errors.length) {
    const byField = new Map();
    for (const ledger of normalized) for (const entry of ledger.entries) {
      const key = `${entry.shotId}\0${entry.fieldPath}`;
      if (!byField.has(key)) byField.set(key, []);
      byField.get(key).push({ entry, lineageRole: ledger.lineageRole });
    }
    for (const [key, revisions] of byField) approvedPlanDifferences.set(key, revisions);
  }
  return {
    status: errors.length ? 'FAIL' : 'PASS', errors, approvedPlanDifferences,
    reconstructedParentHashes,
    counts: { historical: normalized.filter(ledger => ledger.lineageRole === 'historical').reduce((sum, ledger) => sum + ledger.entries.length, 0), amendments: normalized.filter(ledger => ledger.lineageRole === 'current').reduce((sum, ledger) => sum + ledger.entries.length, 0) },
  };
}

function collectDifferences(expected, actual, prefix) {
  if (same(expected, actual)) return [];
  if (object(expected) && object(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap(key => collectDifferences(expected[key], actual[key], prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

function differenceIsApproved({ beatId, fieldPath, expected, actual, approvedPlanDifferences }) {
  const revisions = approvedPlanDifferences.get(`${beatId}\0${fieldPath}`);
  if (!revisions?.length) return null;
  let value = expected;
  for (const { entry } of revisions) {
    if (!same(value, entry.beforeValue)) return null;
    value = entry.afterValue;
  }
  return same(value, actual) ? { lineageRole: revisions.at(-1).lineageRole } : null;
}

function revisionAuthorizesCurrentValue({ beatId, fieldPath, actual, approvedPlanDifferences }) {
  const revisions = approvedPlanDifferences.get(`${beatId}\0${fieldPath}`);
  if (!revisions?.length) return false;
  let value = revisions[0].entry.beforeValue;
  for (const { entry } of revisions) {
    if (!same(value, entry.beforeValue)) return false;
    value = entry.afterValue;
  }
  return same(value, actual);
}

module.exports = { artifactSha256, validateRevisionChain, collectDifferences, differenceIsApproved, revisionAuthorizesCurrentValue };
