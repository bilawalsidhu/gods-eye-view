import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFlightSnapshotRenderer } from '../flights/snapshotRenderer.js';
import { createMilitarySnapshotRenderer } from '../military/snapshotRenderer.js';

for (const create of [
  createFlightSnapshotRenderer,
  createMilitarySnapshotRenderer,
]) {
  test(`${create.name} restores ground contact horizon positions`, () => {
    const records = {
      data: new Map([
        [
          'abc123',
          { rawLon: 0, rawLat: 0, renderAltitudeM: -30, klass: 'airliner' },
        ],
      ]),
    };
    const flightState = {
      records,
      _billboards: new Map(),
      _cullPositions: new Map(),
      _renderer: { fleet: { add: (spec) => spec } },
    };
    const rendering = new Proxy({}, { get: () => () => ({}) });
    const snapshots = create({
      flightState,
      records,
      groundFloor: {},
      meshFloor: {},
      militaryRegistry: {},
      rendering,
      tracking: {},
      motion: { _deadReckon: () => null },
      queries: {},
    });
    snapshots.presentRecords();
    const position = flightState._cullPositions.get('abc123');
    assert.ok(position);
    assert.ok(
      Math.abs(geo.cartographic.fromCartesian(position).height - 12) < 0.01,
    );
  });
}
