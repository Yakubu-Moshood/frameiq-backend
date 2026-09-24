'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshAttemptCounts, markPreReservationFailure, CHANNEL_KEY, EPISODE_ID, ACT_KEYS, TEXT, LIMITS } = require('../scripts/phase2.3b-sg-stage-a.cjs');

function status() {
  return {
    attemptsByAct: { act3b: 0, act4: 0 }, completedAttemptsByAct: { act3b: 0, act4: 0 },
    preReservationFailuresByAct: { act3b: 0, act4: 0 }, currentAct: 'act3b',
    actStates: { act3b: { state: 'ACT_INVOKED' }, act4: { state: 'NOT_STARTED' } },
  };
}
const attempt = (actKey, state) => ({ channel: CHANNEL_KEY, episodeId: EPISODE_ID, actKey, textSha256: TEXT[actKey].sha256, status: state });

test('Stage A uses the canonical channel key and limits exactly two acts and requests', () => {
  assert.equal(CHANNEL_KEY, 'EmpireOmitted');
  assert.deepEqual(ACT_KEYS, ['act3b', 'act4']);
  assert.equal(LIMITS.maximumProviderRequests, 2);
  assert.equal(LIMITS.maximumCharacters, 2457);
  assert.equal(Object.values(TEXT).reduce((sum, spec) => sum + spec.characters, 0), LIMITS.maximumCharacters);
});

test('zero-reservation preflight failure is an invocation failure with zero provider attempts', () => {
  const value = status();
  const state = markPreReservationFailure(value, 'act3b', { attempts: [] }, new Error('CHANNEL_CONFIG_NOT_FOUND'));
  assert.equal(state.state, 'PRE_RESERVATION_FAILURE');
  assert.equal(value.attemptsByAct.act3b, 0);
  assert.equal(value.completedAttemptsByAct.act3b, 0);
  assert.equal(value.preReservationFailuresByAct.act3b, 1);
  assert.equal(value.currentAct, null);
});

test('attempt count tracks only durable matching reservations and completed count tracks COMPLETE rows', () => {
  const value = status();
  const ledger = { attempts: [
    attempt('act3b', 'RESERVED'), attempt('act4', 'COMPLETE'),
    { ...attempt('act3b', 'COMPLETE'), channel: 'AnotherChannel' },
  ] };
  refreshAttemptCounts(value, ledger);
  assert.deepEqual(value.attemptsByAct, { act3b: 1, act4: 1 });
  assert.deepEqual(value.completedAttemptsByAct, { act3b: 0, act4: 1 });
});

test('post-reservation failure remains a consumed provider attempt', () => {
  const value = status();
  const state = markPreReservationFailure(value, 'act3b', { attempts: [attempt('act3b', 'FAILED')] }, new Error('PROVIDER_HTTP_ERROR'));
  assert.equal(value.attemptsByAct.act3b, 1);
  assert.equal(value.completedAttemptsByAct.act3b, 0);
  assert.equal(state.state, 'FAILED_AFTER_RESERVATION');
});
