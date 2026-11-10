import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createQaProbe } from './qaProbe.js';

function fakeManager(modules) {
  const enabled = new Set();
  return {
    layers: new Map(modules.map((module) => [module.id, { module }])),
    getAll: () =>
      modules.map(({ id, name }) => ({ id, name, enabled: enabled.has(id) })),
    isEnabled: (id) => enabled.has(id),
    async setEnabled(id, value) {
      if (value) enabled.add(id);
      else enabled.delete(id);
      return true;
    },
  };
}

test('the probe lists, toggles and reads layers through the engine', async () => {
  const engine = createFakeEngine({ kind: 'navara' });
  const position = geo.cartesian3.fromDegrees(-73.78, 40.64, 1000);
  const flights = {
    id: 'flights',
    name: 'Live Flights',
    getAllPositions: () => [{ id: 'ae01ce', label: 'UAL1', position }],
    getTrackedInfo: () => ({ icao24: 'ae01ce' }),
  };
  const manager = fakeManager([flights]);
  const probe = createQaProbe({
    engine,
    dataManager: manager,
  });
  assert.deepEqual(probe.list(), [
    { id: 'flights', name: 'Live Flights', enabled: false, available: true },
  ]);
  assert.equal(probe.available('flights'), true);
  assert.equal(probe.available('satellites'), false);
  assert.deepEqual(
    probe
      .unavailable()
      .map(({ id }) => id)
      .includes('satellites'),
    false,
  );
  assert.equal(await probe.enable('flights'), true);
  assert.equal(manager.isEnabled('flights'), true);
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(-73.78, 40.64, 50_000),
  });
  engine.fake.script('worldToWindow', () => ({ x: 640, y: 400 }));
  const [object] = probe.objects('flights');
  assert.equal(object.id, 'ae01ce');
  assert.deepEqual(
    [object.position.x, object.position.y, object.position.z],
    [position.x, position.y, position.z],
  );
  assert.deepEqual(object.screen, { x: 640, y: 400 });
  assert.deepEqual(probe.screenOf('flights', 'ae01ce'), { x: 640, y: 400 });
  assert.equal(probe.screenOf('flights', 'nope'), null);
  assert.deepEqual(probe.selected('flights'), { icao24: 'ae01ce' });
  assert.deepEqual(probe.objects('unknown'), []);
  // Follow, movers and frames come from the engine.
  assert.equal(probe.following(), null);
  engine.camera.follow({
    position: () => position,
    viewFrom: { x: 0, y: -1000, z: 300 },
    label: {
      id: 'flights:ae01ce',
      model: { title: 'UAL1' },
      position: () => position,
    },
  });
  assert.deepEqual(probe.following(), {
    label: 'flights:ae01ce',
    native: null,
  });
  engine.movers.createSet({
    id: 'fleet',
    kind: 'point',
    capacity: 4,
    point: { sizePx: 4 },
  });
  assert.deepEqual(probe.movers(), [
    { id: 'fleet', kind: 'point', count: 0, capacity: 4, shown: false },
  ]);
  const before = probe.framesDrawn();
  engine.fake.frame();
  engine.fake.frame();
  assert.equal(probe.framesDrawn() - before, 2);
  assert.equal(await probe.disable('flights'), true);
  assert.equal(manager.isEnabled('flights'), false);
  probe.destroy();
});
