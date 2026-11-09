// src/layers/satellites/nearestPositions.test.mjs — the satellites nearest a
// position: bounded to the nearest few, nearest first, hidden classes,
// dense extras and asked-for exclusions left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createControls } from './controls.js';

function controlsWith(satellites, { classes, dense = [] } = {}) {
  const state = {
    _points: new Map(),
    _catalog: new Map(),
    _denseIds: dense,
    _params: classes ? { classes } : {},
  };
  for (const sat of satellites) {
    state._points.set(sat.id, {
      position: Cesium.Cartesian3.fromDegrees(sat.lon, sat.lat, sat.alt),
    });
    state._catalog.set(sat.id, {
      name: `${sat.name} `,
      satelliteClass: sat.cls,
      group: sat.group,
    });
  }
  return createControls({
    state,
    services: { layerState: { isExplicitLayerStateOrigin: () => false } },
    parts: {},
  }).methods;
}

const SATELLITES = [
  { id: 1, name: 'NEAR', lat: 30.5, lon: -97, alt: 500_000, cls: 'imaging' },
  { id: 2, name: 'MID', lat: 33, lon: -97, alt: 500_000, cls: 'stations' },
  { id: 3, name: 'FAR', lat: -40, lon: 80, alt: 500_000, cls: 'imaging' },
  { id: 4, name: 'DEB', lat: 30.1, lon: -97, alt: 500_000, cls: 'debris' },
  { id: 5, name: 'TELECOM', lat: 30.2, lon: -97, alt: 500_000, cls: 'telecom' },
  { id: 6, name: 'SELF', lat: 30, lon: -97, alt: 420_000, cls: 'stations' },
  { id: 7, name: 'EXTRA', lat: 30.3, lon: -97, alt: 500_000, cls: 'imaging', group: 'dense' },
];

const CENTRE = Cesium.Cartesian3.fromDegrees(-97, 30, 420_000);

test('the nearest shown satellites come first, bounded, with their distance', () => {
  const methods = controlsWith(SATELLITES, {
    classes: { stations: true, imaging: true, debris: true, telecom: false },
    dense: [7],
  });
  const nearest = methods.getNearestPositions(CENTRE, 3, {
    excludeIds: [6],
    excludeClasses: ['debris'],
  });
  assert.deepEqual(
    nearest.map((entry) => entry.label),
    ['NEAR', 'MID', 'FAR'],
    'no self, debris, hidden telecom or dense extra',
  );
  for (let i = 1; i < nearest.length; i += 1)
    assert.ok(nearest[i].distanceM >= nearest[i - 1].distanceM);
  const exact = Cesium.Cartesian3.distance(CENTRE, nearest[0].position);
  assert.ok(Math.abs(nearest[0].distanceM - exact) < 1e-6);
  assert.ok(Math.abs(nearest[0].latitude - 30.5) < 1e-6);
  assert.equal(nearest[0].satelliteClass, 'imaging');
  assert.equal(methods.getNearestPositions(CENTRE, 1, { excludeIds: [6] })[0].label, 'DEB');
  assert.deepEqual(methods.getNearestPositions(null, 3), []);
  assert.deepEqual(methods.getNearestPositions(CENTRE, 0), []);
  assert.deepEqual(methods.getNearestPositions(CENTRE, 0.5), []);
  assert.equal(methods.getNearestPositions(CENTRE, 2.5).length, 2);
});
