import test from 'node:test';
import assert from 'node:assert/strict';
import { createCivilFlightLayer } from './index.js';
import { createFlightState } from './state.js';
import { createEnrichment } from './enrichment.js';

function services() {
  const names = [
    'picking',
    'sprites',
    'trails',
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
