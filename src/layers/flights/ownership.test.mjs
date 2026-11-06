import test from 'node:test';
import assert from 'node:assert/strict';
import { createCivilFlightLayer } from './index.js';
import { createFlightState } from './state.js';
import { createEnrichment } from './enrichment.js';
import { createTracking } from './tracking.js';

function services() {
  const names = [
    'picking',
    'selection',
    'renderer',
    'aircraftPresentation',
    'camera',
    'militaryRegistry',
    'labels',
    'groundFloor',
    'meshFloor',
    'geoid',
    'focus',
    'readout',
    'context',
    'render',
    'recession',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, {}])),
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
  };
}

test('constructing independent flight layers performs no source request and isolates selection', () => {
  let requests = 0;
  const source = {
    label: 'Fixture aircraft',
    getSnapshot() {
      requests++;
    },
  };
  const first = createCivilFlightLayer({ source, services: services() });
  const second = createCivilFlightLayer({ source, services: services() });
  first.testing._armFlightTrackingRestoreForTest('abc123');
  assert.equal(first.testing._pendingFlightTrackingRestoreForTest(), 'abc123');
  assert.equal(second.testing._pendingFlightTrackingRestoreForTest(), null);
  first.testing._setFlightTrackingRefreshOutcomeForTest({ ids: ['abc123'] });
  assert.notEqual(first.testing, second.testing);
  assert.equal(first.getStats().source, 'Fixture aircraft');
  assert.equal(requests, 0);
});

test('a layer without a source fails before touching the viewer', () => {
  const layer = createCivilFlightLayer({ services: services() });
  assert.throws(() => layer.init({}), /snapshot source/);
});

test('flight state owns distinct mutable records, scratch objects and floor samplers', () => {
  const first = createFlightState({ services: services() });
  const second = createFlightState({ services: services() });
  for (const key of [
    'records',
    'feed',
    '_billboards',
    '_positionHistory',
    '_displayFloorState',
    '_groundSnap',
    '_scratchCarto',
    '_models',
    'lifetime',
  ]) {
    assert.notEqual(first[key], second[key], key);
  }
  assert.notEqual(first.records.data, second.records.data);
  assert.notEqual(first.records.missingPolls, second.records.missingPolls);
  assert.notEqual(first.records.geoidNCache, second.records.geoidNCache);
  assert.notEqual(
    first.feed._activeUpdateControllers,
    second.feed._activeUpdateControllers,
  );
});

test('aborted enrichment cannot write into a later lifecycle or decrement its active count', async () => {
  let resolve;
  let signal;
  const source = {
    getEnrichment(query, options) {
      signal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  const flightState = createFlightState({ source, services: services() });
  const enrichment = createEnrichment({ flightState, services: {}, parts: {} });
  let writes = 0;
  enrichment._enqueueEnrich(
    'test',
    { kind: 'type', id: 'abc123' },
    () => writes++,
  );
  await Promise.resolve();
  assert.equal(flightState._enrichActive, 1);
  flightState.lifetime.abort();
  flightState.lifetime = new AbortController();
  flightState._enrichActive = 0;
  resolve({ found: true });
  await new Promise((done) => setImmediate(done));
  assert.equal(signal.aborted, true);
  assert.equal(writes, 0);
  assert.equal(flightState._enrichActive, 0);
});

test('a synchronous enrichment failure stays bounded and releases its slot', async () => {
  const flightState = createFlightState({
    services: services(),
    source: {
      getEnrichment() {
        throw new Error('fixture failure');
      },
    },
  });
  const enrichment = createEnrichment({ flightState, services: {}, parts: {} });
  assert.doesNotThrow(() =>
    enrichment._enqueueEnrich('test', {}, () => assert.fail()),
  );
  await new Promise((done) => setImmediate(done));
  assert.equal(flightState._enrichActive, 0);
});

test('voice context reads a track that rounds to north as 0°, not 360°', () => {
  const tracking = createTracking({
    flightState: {
      feed: { _lastSource: 'Fixture aircraft' },
      records: { data: new Map() },
    },
    services: services(),
    parts: {
      queries: {
        _describeFlight: () => ({ track: 359.6, altitudeM: 9000 }),
        _contactLabel: () => 'AAL1',
      },
    },
    layer: {},
  });
  assert.equal(
    tracking._contextSubjectMetadata('abc123').properties.heading,
    '0°',
  );
});

test('a live flight keeps observations, selection and freshness across renderer lifetimes', async () => {
  const { createFakeEngine } =
    await import('../../globe/testing/fakeEngine.js');
  const { aircraftAtlasLayout, createAircraftDisplay } =
    await import('../aircraft/render/display.js');
  const { createApplicationFlights } =
    await import('../../app/layers/flights.js');
  const first = createFakeEngine();
  const second = createFakeEngine();
  const epoch = Date.now();
  let polls = 0;
  const atl = aircraftAtlasLayout();
  const source = {
    label: 'QA',
    async getSnapshot() {
      polls++;
      return {
        source: 'QA',
        observedAtMs: epoch + polls * 1000,
        ageMs: 0,
        complete: true,
        records: [
          {
            id: '71be26',
            callsign: 'QA',
            latitude: 40.25,
            longitude: -125.58 + polls / 1000,
            ellipsoidAltitudeM: 9000,
            baroAltitudeM: 8800,
            courseDeg: 90,
            speedMps: 200,
            positionTimeMs: epoch + polls * 1000,
          },
        ],
      };
    },
  };
  const layer = createApplicationFlights({
    source,
    surface: {
      groundSnap: { createGroundSnap: () => ({ clear() {}, forget() {} }) },
      groundFloor: {
        cachedGroundFloor: () => null,
        warmGroundFloor() {},
        floorAltitudeM: (h) => h,
      },
      meshFloor: { sampleMeshFloorCells() {} },
    },
    militaryRegistry: {
      isMilitaryIcao: () => false,
      isMilitaryLayerActive: () => false,
      refreshMilitaryRegistryIfStale() {},
      onMilitaryLayerActiveChange: () => () => {},
    },
    renderer: {
      create: ({ engine }) =>
        createAircraftDisplay(engine, {
          layerId: 'flights',
          order: 1,
          headingOffsetDeg: 180,
          drawAtlas: async () => ({
            canvas: { width: atl.width, height: atl.height },
            cells: atl.cells,
          }),
        }),
    },
  });
  try {
    layer.init(null);
    layer.enable();
    await layer.update(null);
    assert.equal(layer.hasContact('71BE26'), true);
    assert.equal(layer.getAnalystRecords().length, 1);
    assert.equal(layer.findByQuery('QA').icao24, '71be26');
    layer.attachRenderer(null, { engine: first });
    assert.equal(layer.qaDrawn().length, 1);
    assert.equal(layer.trackById('71be26'), true);
    layer.detachRenderer();
    assert.equal(first.camera.following(), null);
    assert.equal(layer.getTrackedInfo().icao24, '71be26');
    await layer.update(null);
    assert.equal(layer.getStats().lastUpdate, epoch + 2000);
    layer.attachRenderer(null, { engine: second });
    assert.equal(second.camera.following()?.label.id, 'flights:71be26');
    assert.equal(layer.qaDrawn().length, 1);
    assert.equal(polls, 2, 'attaching either renderer performs no source poll');
    layer.disable();
    assert.equal(layer.hasContact('71be26'), null);
    assert.deepEqual(layer.getAnalystRecords(), []);
  } finally {
    layer.destroy(null);
    first.destroy();
    second.destroy();
  }
});
