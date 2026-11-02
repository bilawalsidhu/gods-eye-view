// src/ui/cockpitRollingValue.test.mjs — which glyphs a Cockpit odometer
// readout shows, and which of them roll.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceRollingValue,
  createRollingState,
} from './cockpitRollingValue.js';

const glyphs = (state) =>
  state.tokens.map((token) => token.text ?? token.track.join('>')).join('|');

test('the first reading draws flat, one glyph per character', () => {
  const state = advanceRollingValue(createRollingState(), '1,250', 1250, {
    nowMs: 1000,
  });
  assert.equal(state.text, '1,250');
  assert.equal(glyphs(state), '1|,|2|5|0');
  assert.deepEqual(
    state.tokens.map((token) => token.className),
    [
      'cockpit-roll-token',
      'cockpit-roll-token is-separator',
      'cockpit-roll-token',
      'cockpit-roll-token',
      'cockpit-roll-token',
    ],
  );
});

test('a changed reading rolls only the digits that differ, upward when rising', () => {
  const first = advanceRollingValue(createRollingState(), '248', 248, {
    nowMs: 1000,
  });
  const next = advanceRollingValue(first, '251', 251, { nowMs: 1300 });
  assert.equal(next === first, false);
  assert.equal(next.generation, first.generation + 1);
  assert.equal(glyphs(next), '2|4>5|8>1');
  assert.equal(
    next.tokens[1].className,
    'cockpit-roll-token is-rolling roll-up',
  );
  assert.equal(next.tokens[0].className, 'cockpit-roll-token');
});

test('a falling reading rolls down, and a longer one pads its new columns', () => {
  const first = advanceRollingValue(createRollingState(), '99', 99, {
    nowMs: 1000,
  });
  const down = advanceRollingValue(first, '98', 98, { nowMs: 1300 });
  assert.equal(glyphs(down), '9|8>9');
  assert.match(down.tokens[1].className, /roll-down$/);
  const wider = advanceRollingValue(down, '100', 100, { nowMs: 1600 });
  assert.equal(glyphs(wider), '1|9>0|8>0');
  const narrower = advanceRollingValue(wider, '7', 7, { nowMs: 1900 });
  assert.equal(glyphs(narrower), '\u00a0|\u00a0|7>0');
});

test('heading wraps the short way round the circle', () => {
  const first = advanceRollingValue(createRollingState(), '359', 359, {
    circularRange: 360,
    nowMs: 1000,
  });
  const next = advanceRollingValue(first, '001', 1, {
    circularRange: 360,
    nowMs: 1300,
  });
  assert.match(next.tokens[1].className, /roll-up$/);
});

test('a change inside the throttle is dropped; any accepted reading restamps it', () => {
  const first = advanceRollingValue(createRollingState(), '100', 100, {
    nowMs: 1000,
  });
  // The same reading 150 ms later is accepted and restamps the readout.
  const same = advanceRollingValue(first, '100', 100, { nowMs: 1150 });
  assert.equal(same === first, true);
  assert.equal(same.at, 1150);
  // So a change 200 ms after the first reading is still inside the throttle.
  const early = advanceRollingValue(same, '110', 110, { nowMs: 1200 });
  assert.equal(early === same, true);
  assert.equal(early.text, '100');
  assert.equal(early.at, 1150);
  const late = advanceRollingValue(early, '110', 110, { nowMs: 1370 });
  assert.equal(late.text, '110');
});

test('an immediate reading skips the throttle and draws flat', () => {
  const first = advanceRollingValue(createRollingState(), '100', 100, {
    nowMs: 1000,
  });
  const next = advanceRollingValue(first, '120', 120, {
    immediate: true,
    nowMs: 1010,
  });
  assert.equal(glyphs(next), '1|2|0');
  assert.equal(
    next.tokens.every((token) => token.track === null),
    true,
  );
});

test('a reading with no value keeps rolling upward', () => {
  const first = advanceRollingValue(createRollingState(), '---', null, {
    nowMs: 1000,
  });
  assert.equal(Number.isNaN(first.value), true);
  const next = advanceRollingValue(first, '120', 120, { nowMs: 1300 });
  // Dashes are not digits, so nothing rolls.
  assert.equal(glyphs(next), '1|2|0');
});
