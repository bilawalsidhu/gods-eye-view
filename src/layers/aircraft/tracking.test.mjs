import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createTracking as createFlightsTracking } from '../flights/tracking.js';
import { createTracking as createMilitaryTracking } from '../military/tracking.js';
import { RENDER_DELAY_SEC as FLIGHT_DELAY_SEC } from '../flights/policy.js';
import { RENDER_DELAY_SEC as MILITARY_DELAY_SEC } from '../military/policy.js';

// Both observed aircraft layers build their tracking from the shared aircraft
// tracking; each must still reach it with its own identity and rules.
const LAYERS = [
  {
    name: 'flights',
    delaySec: FLIGHT_DELAY_SEC,
    createTracking: createFlightsTracking,
    layerId: 'flights',
    layerName: 'Live Flights',
    focusId: 'flights',
    floorsTrail: false,
    backfillLeadAltM: 10000,
    thinsBackfill: false,
  },
  {
    name: 'military',
    delaySec: MILITARY_DELAY_SEC,
    createTracking: createMilitaryTracking,
    layerId: 'military',
    layerName: 'Military Flights',
    focusId: 'militaryFlights',
    floorsTrail: true,
    backfillLeadAltM: 50,
    thinsBackfill: true,
  },
];

const GROUND_M = 300;

function harness(layer, { groundM = null, track = [] } = {}) {
  const calls = { registered: [], focusCleared: [] };
  const flightState = {
    enabled: true,
    feed: {
      _lastSource: 'Fixture aircraft',
      _source: { getTrack: async () => ({ records: track }) },
    },
    records: { data: new Map(), missingPolls: new Map() },
    lifetime: new AbortController(),
    _billboards: new Map(),
    _trackedIcao: null,
    _trailPositions: [],
    _trailBackfillToken: 0,
    _renderer: {
      engine: createFakeEngine(),
      follow: { onChanged: () => () => {} },
    },
  };
  const services = {
    context: {},
    aircraftPresentation: { tr3bTypeLabel: (id, type) => type },
    geoid: { ensureGeoidReady: async () => {}, geoidHeight: () => 0 },
    groundFloor: {
      resolveGroundFloorCellsBounded: async () => {},
      cachedGroundFloor: () => groundM,
      // The production floor rule: lift onto a known floor, else pass through.
      floorAltitudeM: (altM, floorM) => {
        const hasAlt = Number.isFinite(altM);
        const hasFloor = Number.isFinite(floorM);
        if (hasAlt && hasFloor) return Math.max(altM, floorM);
        if (hasAlt) return altM;
        if (hasFloor) return floorM;
        return null;
      },
    },
    focus: { clearFocusTarget: (id) => calls.focusCleared.push(id) },
    militaryRegistry: {},
    readout: {},
    selection: {
      selectionDispatcherFor: () => ({
        register: (id) => {
          calls.registered.push(id);
          return () => {};
        },
      }),
    },
  };
  const parts = {
    queries: {
      _describeFlight: () => ({ callsign: 'ABC1', track: 90 }),
      _contactLabel: () => 'ABC1',
      _toCleanText: (value) => value || '',
      _formatAltitude: () => '',
    },
  };
  const tracking = layer.createTracking({
    flightState,
    services,
    parts,
    layer: {},
  });
  return { tracking, flightState, calls };
}

const heightOf = (position) => geo.cartographic.fromCartesian(position).height;

for (const layer of LAYERS) {
  test(`${layer.name} tracking publishes its own layer identity`, () => {
    const { tracking, calls } = harness(layer);
    const context = tracking._contextSubjectMetadata('abc123');
    assert.equal(context.layerId, layer.layerId);
    assert.equal(context.layerName, layer.layerName);
    // The route line is the civil layer's: military contexts carry none.
    assert.equal('route' in context.properties, layer.name === 'flights');
    tracking._installClickHandler();
    assert.deepEqual(calls.registered, [layer.layerId]);
    tracking._clearTracking();
    assert.deepEqual(calls.focusCleared, [layer.focusId]);
  });

  test(`${layer.name} trail ${layer.floorsTrail ? 'lifts' : 'keeps'} a fix below the warm ground`, () => {
    const { tracking, flightState } = harness(layer, { groundM: GROUND_M });
    assert.equal('_trailFloorPosition' in tracking, layer.floorsTrail);
    tracking._appendTrailFix(geo.cartesian3.fromDegrees(-106.6, 35.05, 10));
    const height = heightOf(flightState._trailPositions[0]);
    assert.ok(
      Math.abs(height - (layer.floorsTrail ? GROUND_M : 10)) < 0.01,
      `trail height ${height}`,
    );
  });

  test(`${layer.name} trail seeds only fixes behind its delayed layer clock`, () => {
    const { tracking, flightState } = harness(layer);
    const cutoffMs = Date.parse('2026-10-24T12:00:00Z');
    const history = [-1000, 0, 1000].map((offset, index) => ({
      timeMs: cutoffMs + offset,
      position: geo.cartesian3.fromDegrees(-97 + index * 0.01, 30, 1000),
    }));
    flightState.now = () => cutoffMs + layer.delaySec * 1000;
    flightState._positionHistory = new Map([['abc123', history]]);
    flightState._renderer = null;
    tracking._startTrail('abc123');
    assert.deepEqual(
      flightState._trailPositions,
      history.slice(0, 2).map((fix) => fix.position),
    );
    assert.notEqual(flightState._trailPositions[0], history[0].position);
    flightState.lifetime.abort();
  });

  test(`${layer.name} backfill places and thins history by its own rules`, async () => {
    const leading = harness(layer, {
      track: [{ observedAtMs: 1000, latitude: 35, longitude: -106 }],
    });
    leading.flightState._trackedIcao = 'abc123';
    await leading.tracking._backfillTrail('abc123', 0, Infinity);
    assert.equal(leading.flightState._trailPositions.length, 1);
    assert.ok(
      Math.abs(
        heightOf(leading.flightState._trailPositions[0]) -
          layer.backfillLeadAltM,
      ) < 0.01,
    );

    const long = harness(layer, {
      track: Array.from({ length: 1000 }, (_, index) => ({
        observedAtMs: 1000 + index * 1000,
        latitude: 35 + index * 0.001,
        longitude: -106,
        baroAltitudeM: 3000,
      })),
    });
    long.flightState._trackedIcao = 'abc123';
    await long.tracking._backfillTrail('abc123', 0, Infinity);
    // 1000 points into a 400-vertex trail: stride-thinned (every 3rd) or
    // only the newest 400 kept.
    assert.equal(
      long.flightState._trailPositions.length,
      layer.thinsBackfill ? 334 : 400,
    );
  });
}
