import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTleText } from '../../sources/tle.js';
import { createIngestion } from './ingestion.js';

// The ISS set (1 January 2024) with its catalog field swapped per satellite.
const ISS_LINE1 =
  '1 25544U 98067A   24001.50000000  .00016717  00000-0  30370-3 0  9993';
const ISS_LINE2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579432323';

function tleSet(name, field) {
  return [
    name,
    ISS_LINE1.replace('25544', field),
    ISS_LINE2.replace('25544', field),
  ].join('\n');
}

function ingestionFor(catalogText) {
  const state = {
    _trackingRefreshEpoch: 0,
    _activeUpdateControllers: new Set(),
    _pointCollection: {
      removeAll() {},
      add: (point) => point,
    },
    _points: new Map(),
    _orbitPaths: new Map(),
    _catalog: new Map(),
    _detectionObjects: new Map(),
    _denseLoadToken: 0,
    _catalogRevision: 0,
    _params: { catalog: 'core', showOrbits: false },
  };
  const parts = {
    orbits: {
      parseTLE: parseTleText,
      propagatePosition: () => ({ longitude: 0, latitude: 0, altitude: 4e5 }),
    },
    labels: { _syncIssOverlay() {} },
    controls: { _pointStyleFor: () => ({}) },
    rendering: { _showOrbitPath() {} },
    tracking: {
      async _reconcileTrackedSubjectContext() {},
      _applyPendingTrackingRestore() {},
    },
    catalog: {},
  };
  const source = {
    async readGroup() {
      return { ok: true, text: catalogText };
    },
  };
  const { methods } = createIngestion({ state, services: {}, parts, source });
  return { state, update: () => methods.update({ scene: {} }) };
}

test('every Alpha-5 satellite keeps its own catalog entry through dedupe', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { state, update } = ingestionFor(
    [
      tleSet('FIRST', 'A0000'),
      tleSet('SECOND', 'B0001'),
      tleSet('THIRD', 'Z9999'),
    ].join('\n'),
  );
  await update();
  assert.deepEqual(
    [...state._catalog].map(([id, entry]) => [id, entry.name]),
    [
      [100000, 'FIRST'],
      [110001, 'SECOND'],
      [339999, 'THIRD'],
    ],
  );
  assert.deepEqual([...state._points.keys()], [100000, 110001, 339999]);
  assert.equal(state._count, 3);
});
