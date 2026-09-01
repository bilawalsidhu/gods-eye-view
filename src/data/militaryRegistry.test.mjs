/**
 * Military-registry active-transition tests (pre-ship audit M2).
 *
 * Locks the setMilitaryLayerActive contract the flights layer's immediate
 * suppression/restore sweep depends on: listeners fire only on TRANSITIONS
 * (never on same-value sets), after the new state is committed, and a broken
 * listener can't break the toggle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setMilitaryLayerActive,
  isMilitaryLayerActive,
  onMilitaryLayerActiveChange,
  isMilitaryIcao,
  isFeedMilitaryIcao,
  noteMilitaryCandidate,
  classifyMilitaryHeuristic,
  militaryHexInReservedRange,
  militaryTypeCode,
  militaryCallsignPrefix,
  registerMilitaryIcaos,
} from './militaryRegistry.js';

test('active-change listener fires on transitions only, with committed state', () => {
  const seen = [];
  const unsub = onMilitaryLayerActiveChange((active) => {
    seen.push({ active, committed: isMilitaryLayerActive() });
  });
  try {
    setMilitaryLayerActive(false); // same value (initial false) → no fire
    assert.equal(seen.length, 0);

    setMilitaryLayerActive(true); // transition → fire, state already committed
    assert.deepEqual(seen, [{ active: true, committed: true }]);

    setMilitaryLayerActive(true); // same value → no fire
    assert.equal(seen.length, 1);

    setMilitaryLayerActive(false); // transition back → fire
    assert.deepEqual(seen[1], { active: false, committed: false });
    assert.equal(seen.length, 2);
  } finally {
    unsub();
    setMilitaryLayerActive(false);
  }
});

test('unsubscribe stops delivery; throwing listeners never break the toggle', () => {
  let calls = 0;
  const unsubBroken = onMilitaryLayerActiveChange(() => { throw new Error('boom'); });
  const unsubCounter = onMilitaryLayerActiveChange(() => { calls++; });
  try {
    setMilitaryLayerActive(true); // broken listener swallowed, counter still runs
    assert.equal(calls, 1);
    assert.equal(isMilitaryLayerActive(), true);

    unsubCounter();
    setMilitaryLayerActive(false);
    assert.equal(calls, 1); // unsubscribed → no more deliveries
  } finally {
    unsubBroken();
    unsubCounter();
    setMilitaryLayerActive(false);
  }
});

test('onMilitaryLayerActiveChange tolerates non-function listeners', () => {
  const unsub = onMilitaryLayerActiveChange(null);
  assert.equal(typeof unsub, 'function');
  unsub(); // no-op, must not throw
  setMilitaryLayerActive(true);
  assert.equal(isMilitaryLayerActive(), true);
  setMilitaryLayerActive(false);
});

test('hex-range classifier: US military block in, civil registrations out', () => {
  assert.equal(militaryHexInReservedRange('AE1234'), true, 'US mil block');
  assert.equal(militaryHexInReservedRange('adfb1f'), true, 'lower-case, US mil block');
  assert.equal(militaryHexInReservedRange('43C123'), true, 'UK mil block');
  assert.equal(militaryHexInReservedRange('C21ABC'), true, 'Canada mil block');
  assert.equal(militaryHexInReservedRange('A12345'), false, 'US civil (N-reg)');
  assert.equal(militaryHexInReservedRange('4CA2D1'), false, 'Irish civil');
  assert.equal(militaryHexInReservedRange('nothex'), false);
  assert.equal(militaryHexInReservedRange(''), false);
});

test('type-code classifier: military-only designators in, shared/civil out', () => {
  assert.equal(militaryTypeCode('C130'), true);
  assert.equal(militaryTypeCode('f16'), true, 'case-insensitive');
  assert.equal(militaryTypeCode('KC135'), true);
  assert.equal(militaryTypeCode('H60'), true);
  assert.equal(militaryTypeCode('A320'), false);
  assert.equal(militaryTypeCode('GLF5'), false, 'business jet also flown by govt — not decisive');
  assert.equal(militaryTypeCode(''), false);
  assert.equal(militaryTypeCode(undefined), false);
});

test('callsign classifier: state air-arm prefix + digit in, lookalikes out', () => {
  assert.equal(militaryCallsignPrefix('RCH271'), true, 'Reach');
  assert.equal(militaryCallsignPrefix('PAT99 '), true, 'trailing space trimmed');
  assert.equal(militaryCallsignPrefix('rrr2145'), true, 'RAF Ascot, lower-case');
  assert.equal(militaryCallsignPrefix('RCH'), false, 'prefix alone, no flight number');
  assert.equal(militaryCallsignPrefix('PATRIOT1'), false, 'PAT must be followed by a digit');
  assert.equal(militaryCallsignPrefix('DAL1234'), false);
  assert.equal(militaryCallsignPrefix(''), false);
});

test('classifyMilitaryHeuristic: any one signal is sufficient', () => {
  assert.equal(classifyMilitaryHeuristic({ icao24: 'AE0001' }), true, 'hex only');
  assert.equal(classifyMilitaryHeuristic({ icao24: 'A12345', type: 'C17' }), true, 'type only');
  assert.equal(classifyMilitaryHeuristic({ icao24: 'A12345', callsign: 'RCH42' }), true, 'callsign only');
  assert.equal(classifyMilitaryHeuristic({ icao24: 'A12345', type: 'A320', callsign: 'UAL5' }), false);
  assert.equal(classifyMilitaryHeuristic({}), false);
});

test('noteMilitaryCandidate: styles heuristic hits without marking them feed-confirmed', () => {
  const hex = 'ae7f01';
  assert.equal(isMilitaryIcao(hex), false, 'unknown to start');
  assert.equal(noteMilitaryCandidate({ icao24: hex, callsign: 'DAL9' }), true, 'hex block classifies it');
  assert.equal(isMilitaryIcao(hex), true, 'now presented as military');
  assert.equal(isFeedMilitaryIcao(hex), false, 'but NOT feed-confirmed — no suppression');
  assert.equal(noteMilitaryCandidate({ icao24: hex }), false, 'second call is not a fresh classification');

  const civil = 'a98765';
  assert.equal(noteMilitaryCandidate({ icao24: civil, type: 'B738', callsign: 'SWA22' }), false);
  assert.equal(isMilitaryIcao(civil), false);
});

test('a feed-confirmed hex is never downgraded to heuristic-only', () => {
  const hex = 'ae5150';
  registerMilitaryIcaos([hex]);
  assert.equal(isFeedMilitaryIcao(hex), true);
  assert.equal(noteMilitaryCandidate({ icao24: hex }), false, 'already known — no reclassification');
  assert.equal(isFeedMilitaryIcao(hex), true, 'still feed-confirmed');
});
