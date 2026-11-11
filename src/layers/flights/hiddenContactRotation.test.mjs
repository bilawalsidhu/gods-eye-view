import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFlightState } from './state.js';
import { createRendering } from './rendering.js';
import { fleetTickFixture } from '../../testSupport/fleetTickFixture.mjs';
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

// The real fleet tick and horizon culling, with motion and presentation injected.
const fleetFixture = () =>
  fleetTickFixture({ createFlightState, createRendering });
// The next tick is not this contact's turn in the hidden rotation.
const offTurn = (f) => {
  f.flightState._fleetTickSeq =
    (hiddenContactDrPhase(f.id) + 1) % HIDDEN_CONTACT_DR_TICKS;
};

test('the fleet tick dead-reckons a hidden contact once per complete rotation', () => {
  const f = fleetFixture();
  for (let i = 0; i < HIDDEN_CONTACT_DR_TICKS; i++) f.tick();
  assert.equal(f.reckonings(), 1);
  assert.equal(f.billboard.show, false);
});

test('a camera reveal bypasses the hidden rotation on the same fleet tick', () => {
  const f = fleetFixture();
  offTurn(f);
  f.tick();
  assert.equal(f.reckonings(), 0);
  f.camera.positionWC = Cesium.Cartesian3.fromDegrees(1, 0, 100);
  offTurn(f);
  f.tick();
  assert.equal(f.reckonings(), 1);
  assert.equal(f.billboard.show, true);
});

test('a hidden contact with a retained fleet model is never rotation-skipped', () => {
  const f = fleetFixture();
  f.flightState._models3dEnabled = true;
  const model = { ready: true, show: true };
  f.flightState._models.set(f.id, model);
  offTurn(f);
  f.tick();
  assert.equal(f.reckonings(), 1);
  assert.equal(
    f.flightState._models.get(f.id),
    model,
    'model remains in keep range',
  );
  assert.equal(
    model.show,
    false,
    'the full pass hides its model beyond the horizon',
  );
});
