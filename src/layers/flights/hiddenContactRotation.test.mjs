import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLEET_DR_INTERVAL_MS,
  HIDDEN_CONTACT_DR_INTERVAL_MS,
  HIDDEN_CONTACT_DR_TICKS,
  hiddenContactDrPhase,
} from './policy.js';

// Contacts hidden behind the horizon re-reckon on one fleet tick per rotation
// instead of every tick. Their positions still feed hidden-inclusive proximity
// queries, so the rotation must reach every contact about once a second, and
// it must spread them across ticks so no single tick carries the whole fleet.

const icao = (n) => n.toString(16).padStart(6, '0');

test('the rotation revisits each hidden contact about once a second', () => {
  const periodMs = HIDDEN_CONTACT_DR_TICKS * FLEET_DR_INTERVAL_MS;
  assert.ok(HIDDEN_CONTACT_DR_TICKS > 1);
  assert.ok(
    Math.abs(periodMs - HIDDEN_CONTACT_DR_INTERVAL_MS) <= FLEET_DR_INTERVAL_MS,
  );
});

test('a contact keeps the same slot, inside the rotation', () => {
  for (let n = 0; n < 500; n++) {
    const phase = hiddenContactDrPhase(icao(n * 7919));
    assert.ok(Number.isInteger(phase));
    assert.ok(phase >= 0 && phase < HIDDEN_CONTACT_DR_TICKS);
    assert.equal(hiddenContactDrPhase(icao(n * 7919)), phase);
  }
});

test('a worldwide fleet is spread evenly enough that no tick carries a burst', () => {
  const fleet = 13000;
  const perSlot = new Array(HIDDEN_CONTACT_DR_TICKS).fill(0);
  // Real ICAO24 addresses cluster by national block; sample several blocks.
  for (let n = 0; n < fleet; n++)
    perSlot[hiddenContactDrPhase(icao(0x0a0000 + n * 53))]++;
  const fair = fleet / HIDDEN_CONTACT_DR_TICKS;
  for (const count of perSlot) assert.ok(count < fair * 1.5, `${count} > 1.5×`);
});
