// Disabling Satellites, or changing showOrbits, between detachRenderer and
// attachRenderer (an engine switch) must not throw on the dropped orbit rings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createApplicationSatellites } from '../../app/layers/satellites.js';
import { createSatellitesDisplay } from './render/display.js';
import { worldClock, worldTimeFor } from '../../time/worldClock.js';
import { createLifecycle } from './lifecycle.js';

const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`;
const EPOCH_MS = Date.UTC(2008, 8, 20, 12, 30, 0);

async function setup(t) {
  const previousDocument = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: () => null,
  });
  worldClock.seek(EPOCH_MS);
  const layer = createApplicationSatellites({
    source: {
      async readGroup(group) {
        return {
          ok: true,
          status: 200,
          text: group === 'stations' ? ISS_TLE : '',
          stale: false,
        };
      },
    },
    renderer: { create: ({ engine }) => createSatellitesDisplay(engine) },
  });
  t.after(() => {
    try {
      layer.destroy();
    } catch {}
    worldClock.goLive();
    globalThis.document = previousDocument;
  });
  await layer.init(null, { engine: createFakeEngine() });
  layer.enable();
  await layer.update();
  return layer;
}

test('satellites: disable between detach and attach does not throw', async (t) => {
  const layer = await setup(t);
  layer.detachRenderer();
  assert.doesNotThrow(() => layer.disable());
});

test('satellites: showOrbits between detach and attach does not throw', async (t) => {
  const layer = await setup(t);
  layer.detachRenderer();
  assert.doesNotThrow(() => layer.setParams({ showOrbits: false }));
});

test('restored orbit rings receive their current rotation before the first frame', () => {
  let rotated = 0;
  const path = { basePositions: [], color: {} };
  const state = {
    now: worldTimeFor('satellites'),
    _catalog: new Map(),
    _points: new Map(),
    _orbitPaths: new Map([[25544, path]]),
    _params: { showOrbits: true },
    _enabled: true,
  };
  const lifecycle = createLifecycle({
    state,
    services: {
      focus: {},
      render: {},
      picking: {},
      renderer: {
        create: () => ({
          createPoints: () => ({}),
          createOrbit: () => ({ modelMatrix: [] }),
        }),
      },
    },
    parts: {
      controls: { _issOrbitVisible: () => true },
      rendering: {
        _updateOrbitPathRotations(date) {
          rotated++;
          assert.ok(date instanceof Date);
          assert.ok(path.primitive);
        },
      },
    },
  });
  lifecycle.methods.attachRenderer(null, {
    engine: {},
    waitForCameraRestore: true,
  });
  assert.equal(rotated, 1);
  assert.equal(path.primitive.show, true);
});
