// src/layers/flights/rendering.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRendering as createFlightsRendering } from './rendering.js';
import { createRendering as createMilitaryRendering } from '../military/rendering.js';

function rendering(create) {
  const data = new Map([
    ['light', { klass: 'light' }],
    ['quadjet', { klass: 'quadjet' }],
    ['vehicle', { klass: 'vehicle' }],
    ['parked', { klass: 'quadjet', onGround: true }],
  ]);
  return create({
    flightState: { records: { data } },
    services: {
      militaryRegistry: { isMilitaryIcao: () => false },
      aircraftPresentation: { tr3bIconKind: () => null },
      focus: { focusNowMs: () => 0, getFocusTarget: () => null },
    },
    parts: {},
    layer: {},
    resolveAsset: (url) => url,
  });
}

test('Flights draws every class at one size, smaller on the ground', () => {
  const r = rendering(createFlightsRendering);
  for (const id of ['light', 'quadjet', 'vehicle']) {
    assert.equal(r._fleetBillboardScale(id), 1, id);
  }
  assert.equal(r._fleetBillboardScale('parked'), 0.8);
});

test('Military draws every class at its one size, smaller on the ground', () => {
  const r = rendering(createMilitaryRendering);
  const size = r._fleetBillboardScale('light');
  for (const id of ['quadjet', 'vehicle']) {
    assert.equal(r._fleetBillboardScale(id), size, id);
  }
  assert.ok(Math.abs(r._fleetBillboardScale('parked') - size * 0.8) < 1e-12);
});
