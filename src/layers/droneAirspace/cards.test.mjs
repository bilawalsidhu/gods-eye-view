import test from 'node:test';
import assert from 'node:assert/strict';
import {
  droneAirspaceAnchorDegrees,
  droneAirspaceAccent,
  buildDroneAirspaceCard,
} from './cards.js';

const square = [
  [-77.2, 38.8],
  [-77.0, 38.8],
  [-77.0, 39.0],
  [-77.2, 39.0],
  [-77.2, 38.8],
];
const tiny = [
  [-76.01, 38.0],
  [-76.0, 38.0],
  [-76.0, 38.01],
  [-76.01, 38.0],
];

test('the card anchors at the centroid of the largest polygon', () => {
  const anchor = droneAirspaceAnchorDegrees([[tiny], [square]]);
  assert.ok(Math.abs(anchor.lon - -77.1) < 1e-9);
  assert.ok(Math.abs(anchor.lat - 38.9) < 1e-9);
});

test('a prohibited zone card names the type, altitudes and the disclaimer', () => {
  const card = buildDroneAirspaceCard({
    stableId: '310',
    name: 'P-56',
    typeCode: 'P',
    type: 'Prohibited',
    lowerDesc: 'SFC',
    upperDesc: 'TNI',
    timesOfUse: 'CONTINUOUS',
    agency: 'WASHINGTON CENTER',
    city: 'WASHINGTON',
    state: 'DC',
  });
  assert.equal(card.id, 'drone-airspace-card:310');
  assert.equal(card.title, 'PROHIBITED · P-56');
  assert.deepEqual(card.details, [
    'Prohibited · SFC – TNI · CONTINUOUS',
    'WASHINGTON, DC',
    'WASHINGTON CENTER',
    'Informational only · not for flight planning',
  ]);
  assert.equal(card.accent, droneAirspaceAccent('P'));
  assert.equal(card.interactive, false);
  assert.equal(card.selected, true);
});

test('missing attributes degrade to available facts instead of placeholders', () => {
  const card = buildDroneAirspaceCard({
    stableId: 'x',
    name: null,
    typeCode: 'R',
    type: 'Restricted',
    lowerDesc: null,
    upperDesc: null,
    timesOfUse: null,
    agency: null,
    city: null,
    state: null,
  });
  assert.equal(card.title, 'RESTRICTED · Unnamed zone');
  assert.deepEqual(card.details, [
    'Restricted',
    'Informational only · not for flight planning',
  ]);
  assert.equal(card.accent, droneAirspaceAccent('R'));
});
