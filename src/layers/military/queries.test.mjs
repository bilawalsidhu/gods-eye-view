import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createQueries } from './queries.js';

function describe(info) {
  const bb = {
    show: true,
    position: Cesium.Cartesian3.fromDegrees(-77, 39, 2000),
  };
  const flightState = {
    feed: {},
    _billboards: new Map([['ae1234', bb]]),
    _models: new Map(),
    _detectionObjects: new Map(),
    _scratchCarto: new Cesium.Cartographic(),
    records: { data: new Map([['ae1234', info]]), missingPolls: new Map() },
  };
  const services = {
    aircraftPresentation: {},
    labels: {},
    camera: {},
  };
  const parts = { motion: { _deadReckon: () => null } };
  return createQueries({
    flightState,
    services,
    parts,
  })._describeFlight('ae1234');
}

test('the military descriptor reports the barometric altitude, not the render height', () => {
  const described = describe({ altitudeFt: 10000, renderAltitudeM: 2000 });
  assert.equal(described.altitudeM, 3048);
  assert.equal(describe({ altitudeFt: null }).altitudeM, null);
});
