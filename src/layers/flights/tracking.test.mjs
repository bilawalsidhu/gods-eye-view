import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracking } from './tracking.js';
import { createIngestion, createFlightFeed } from './ingestion.js';
import { createController } from './controller.js';

function handoffTracking(flightState, layer) {
  const services = Object.fromEntries(
    [
      'context',
      'aircraftPresentation',
      'trails',
      'geoid',
      'groundFloor',
      'focus',
      'militaryRegistry',
      'readout',
      'camera',
      'picking',
    ].map((name) => [name, {}]),
  );
  return createTracking({ flightState, layer, services, parts: {} });
}

test('military handoff refresh settles cancellation without publishing a late snapshot', async (t) => {
  let release;
  let accepted = 0;
  let restored = 0;
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const feed = createFlightFeed({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const flightState = {
    feed,
    _viewer: {},
    _icons: { show: true },
  };
  const { methods: layer } = createIngestion({
    feed,
    getQuery: () => ({}),
    applySnapshot: () => {
      accepted += 1;
      return { count: 0, ids: new Set() };
    },
    setSourceLabel: () => {},
    applyPendingTrackingRestore: () => {
      restored += 1;
    },
  });
  const tracking = handoffTracking(flightState, layer);
  const controller = createController({ flightState });

  tracking._onMilitaryActiveChange(false);
  assert.equal(feed._activeUpdateControllers.size, 1);
  controller._abortActiveUpdates();
  release({ records: [] });
  // Flush the background rejection; node:test also fails on unhandled promises.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(feed._activeUpdateControllers.size, 0);
  assert.equal(accepted, 0);
  assert.equal(restored, 0);
  assert.deepEqual(warnings, []);
});

test('military handoff refresh reports unexpected background failures', async (t) => {
  const failure = new Error('Unexpected handoff failure');
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const tracking = handoffTracking(
    { _viewer: {}, _icons: { show: true } },
    {
      update: async () => {
        throw failure;
      },
    },
  );

  tracking._onMilitaryActiveChange(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings, [
    ['[Data:Flights] Military handoff refresh error:', failure],
  ]);
});
