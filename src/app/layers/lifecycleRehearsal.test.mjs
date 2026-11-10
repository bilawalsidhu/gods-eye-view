import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationCatalog } from '../constructCatalog.js';
import { createSurfaceServices } from '../surfaceServices.js';
import { CATALOG_SOURCE_CONTRACTS } from '../sourceComposition.js';
import { loadLayerRenderers, rendererFor } from './renderers.js';
import {
  BHOTE_KOSHI_CREDIT,
  BHOTE_KOSHI_LOCATOR_CREDIT,
  transitFeedCredit,
} from '../../data/dataCredits.js';
import { TRANSIT_ENABLED_FEEDS } from '../../data/transitFeeds.js';
import { createMapillaryProvider } from '../../layers/streetLevel/providers/mapillary/index.js';
import { sceneServicesFor } from '../../data/sceneServices.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { aircraftAtlasLayout } from '../../layers/aircraft/render/display.js';
import { vesselAtlasLayout } from '../../layers/vessels/render/display.js';
import { transitTestAtlas } from '../../layers/transit/render/testAtlas.mjs';
import {
  installLifecycleEnvironment,
  flushLifecycleTasks,
} from '../../testSupport/lifecycleEnvironment.mjs';

const retainedCredits = {
  'bhote-koshi-2026': BHOTE_KOSHI_CREDIT, // Conditional attribution is permanent in the scene's credit popover.
  transit: transitFeedCredit(
    TRANSIT_ENABLED_FEEDS.find((feed) => feed.id === 'capmetro-austin'),
  ), // Transit feed attribution is permanent in the scene's credit popover.
  'bhote-koshi-locator': BHOTE_KOSHI_LOCATOR_CREDIT, // Conditional attribution is permanent in the scene's credit popover.
};

const primitives = ['movers', 'lines', 'ground', 'imagery', 'meshes'];
const expectedReaders = {
  'bhote-koshi-2026': ['scene'], // The imagery split control still reads the native scene.
  'ais-live-vessels': ['isDestroyed'], // Sprite ordering still accepts the native viewer.
};

function sourceFixtures(calls) {
  return Object.fromEntries(
    Object.entries(CATALOG_SOURCE_CONTRACTS).map(([id, { methods }]) => [
      id,
      {
        label: id,
        ...Object.fromEntries(
          methods.map((method) => [
            method,
            () => {
              calls.push({ id, method });
              if (method === 'getFlowSessionStats') return {};
              if (method === 'getStatus')
                return Promise.resolve({ hasKey: false });
              if (id === 'wildlife-sightings') return Promise.resolve([]);
              if (method === 'requestSnapshot')
                return Promise.resolve({
                  ok: true,
                  headers: new Headers(),
                  json: async () => ({ vehicles: [], fetchedAt: Date.now() }),
                });
              if (method === 'requestRoads')
                return Promise.resolve({
                  ok: true,
                  headers: new Headers(),
                  json: async () => ({ roads: [], roadMode: 'osm' }),
                });
              if (method === 'getStations')
                return Promise.resolve({ data: { stations: [] } });
              if (method === 'resetFlowTileCache') return;
              if (method === 'fetch') return Promise.resolve([]);
              if (method === 'getSnapshot')
                return Promise.resolve({
                  records: [],
                  features: [],
                  rows: [],
                  unavailable: true,
                });
              return Promise.resolve([]);
            },
          ]),
        ),
      },
    ]),
  );
}

function strictEngine() {
  const engine = createFakeEngine({
    kind: 'rehearsal',
    longitude: (-97.74 * Math.PI) / 180,
    latitude: (30.27 * Math.PI) / 180,
    altitude: 5000,
    container: document.createElement('div'),
    canvas: document.createElement('canvas'),
  });
  engine.extensions = {};
  engine.fake.script('sampleHeight', 0);
  engine.fake.script('terrainHeight', 0);
  const violations = [];
  const inputs = new Set();
  const suspensions = new Set();
  const suspend = engine.input.suspendCameraInputs;
  engine.input.suspendCameraInputs = () => {
    const resume = suspend();
    const token = {};
    suspensions.add(token);
    return () => {
      suspensions.delete(token);
      resume();
    };
  };
  const on = engine.input.on;
  engine.input.on = (...args) => {
    const off = on(...args);
    const token = {};
    inputs.add(token);
    return () => {
      inputs.delete(token);
      off();
    };
  };
  for (const family of primitives) {
    for (const [name, create] of Object.entries(engine[family])) {
      if (!name.startsWith('create')) continue;
      engine[family][name] = (...args) => {
        if (engine.isDestroyed()) {
          const message = `${family}.${name} on destroyed engine`;
          violations.push(message);
          throw new Error(message);
        }
        const handle = create(...args);
        let removed = false;
        const destroy = handle.destroy;
        handle.destroy = () => {
          removed = true;
          return destroy();
        };
        for (const method of Object.keys(handle).filter((name) =>
          /^(set|update|replace|commit|reveal|show)/.test(name),
        )) {
          const write = handle[method];
          handle[method] = (...values) => {
            if (
              (removed || engine.isDestroyed()) &&
              (method !== 'show' || values.length)
            ) {
              const message = `${family} ${handle.id}.${method} after removal`;
              violations.push(message);
              throw new Error(message);
            }
            return write(...values);
          };
        }
        return handle;
      };
    }
  }
  const services = sceneServicesFor(engine);
  services.render.install();
  const resources = () => ({
    lists: Object.fromEntries(
      primitives.map((name) => [name, engine[name].list()]),
    ),
    listeners: [engine.camera, engine.frames, engine.clock].flatMap((part) =>
      Object.values(part)
        .filter((value) => typeof value?.addEventListener === 'function')
        .map((event) => event.numberOfListeners),
    ),
    inputs: inputs.size,
    credits: [...engine.fake.credits],
    cameraInputs: engine.input.cameraInputsEnabled(),
    suspensions: suspensions.size,
    continuous: engine.render.isContinuous(),
    holds: services.render.getRenderGovernorDiagnostics().holds,
    following: engine.camera.following(),
    owners: services.picking.owners(),
  });
  const snapshot = () => ({
    calls: [...engine.fake.calls],
    renderRequests: engine.fake.renderRequests,
    resources: resources(),
    violations: [...violations],
  });
  return { engine, services, resources, snapshot, violations };
}

function assertHidden(engine) {
  for (const { id } of engine.movers.list()) {
    const { store } = engine.fake.moverSet(id);
    assert.ok(
      [...store.shows.slice(0, store.count)].every((shown) => !shown),
      `disabled movers ${id} must be hidden`,
    );
  }
  for (const family of ['lines', 'ground', 'imagery']) {
    for (const item of engine[family].list()) {
      if (item.count === 0) continue;
      assert.equal(
        item.shown,
        false,
        `disabled ${family} ${item.id} must be hidden`,
      );
    }
  }
  for (const id of engine.meshes.list())
    assert.equal(
      engine.fake.mesh(id).show,
      false,
      `disabled mesh ${id} must be hidden`,
    );
}

test('every catalog layer releases its scene and attaches to another engine', async (t) => {
  await loadLayerRenderers('rehearsal');
  const buildCatalog = (lifetime, calls, visibility) =>
    createApplicationCatalog({
      signal: lifetime.signal,
      sources: sourceFixtures(calls),
      surface: createSurfaceServices({
        terrainSource: { getHeights: async () => [] },
        signal: lifetime.signal,
        eventTarget: null,
      }),
      streetLevelProviders: [
        createMapillaryProvider({
          source: {
            hasToken: () => true,
            getStatus: async () => {
              calls.push({ id: 'mapillary', method: 'getStatus' });
              return { configured: true };
            },
            getTile: async () => {
              calls.push({ id: 'mapillary', method: 'getTile' });
              return new Uint8Array(0);
            },
            getSequenceImages: async () => {
              calls.push({ id: 'mapillary', method: 'getSequenceImages' });
              return [];
            },
          },
        }),
      ],
      nepalBoundaryResolver: async () => [],
      createDisplay(id, engine, options = {}) {
        const services = sceneServicesFor(engine);
        const layout =
          id === 'ais-live-vessels'
            ? vesselAtlasLayout()
            : aircraftAtlasLayout();
        const display = rendererFor(id, engine, {
          ...options,
          services: {
            ...options.services,
            picking: services.picking,
            render: services.render,
          },
          drawAtlas:
            id === 'transit'
              ? transitTestAtlas
              : async () => ({
                  canvas: { width: layout.width, height: layout.height },
                  cells: layout.cells,
                }),
        });
        if (id === 'cctv') {
          visibility.set(engine, true);
          const setVisible = display.setMarkersVisible;
          display.setMarkersVisible = (value) => {
            visibility.set(engine, value);
            return setVisible(value);
          };
        }
        return display;
      },
    });
  const discoveryLifetime = new AbortController();
  const discovery = buildCatalog(discoveryLifetime, [], new Map());
  t.after(() => discoveryLifetime.abort());
  const seenReaders = [];
  const seenCredits = new Set();
  for (const { id } of discovery.layers) {
    await t.test(id, async (t) => {
      const environment = installLifecycleEnvironment(t);
      const lifetime = new AbortController();
      const calls = [];
      const visibility = new Map();
      const catalog = buildCatalog(lifetime, calls, visibility);
      const layer = catalog.get(id);
      const a = strictEngine();
      const b = strictEngine();
      const beforeA = a.resources();
      const beforeB = b.resources();
      const reads = new Set();
      const poisoned = new Proxy(
        {},
        {
          get(_target, property) {
            reads.add(String(property));
            throw new Error(`viewer read: ${String(property)}`);
          },
        },
      );
      const drive = async (scene) => {
        scene.engine.fake.emit('camera.moveStart');
        scene.engine.fake.emit('camera.changed');
        scene.engine.fake.frame();
        scene.engine.fake.emit('camera.moveEnd');
        window.dispatchEvent(new CustomEvent('gev:map-stack-changed'));
        await flushLifecycleTasks(t, 1000);
      };
      try {
        if (
          [
            'flights',
            'military',
            'earthquakes',
            'air-quality',
            'fire-perimeters',
            'gnss-integrity',
            'drone-airspace',
            'osm-places',
          ].includes(layer.id)
        )
          await layer.init(null);
        const attach = async (engine, options = {}) => {
          try {
            await layer.attachRenderer(poisoned, { engine, ...options });
          } catch (error) {
            if (
              !expectedReaders[layer.id]?.includes([...reads].at(-1)) ||
              !error.message.startsWith('viewer read:')
            )
              throw error;
            await layer.detachRenderer();
            await layer.attachRenderer(null, { engine, ...options });
          }
        };
        await attach(a.engine);
        await flushLifecycleTasks(t);
        if (layer.id === 'cctv')
          assert.equal(
            visibility.get(a.engine),
            false,
            'disabled CCTV markers must be hidden after attach',
          );
        assertHidden(a.engine);
        await layer.enable();
        await drive(a);
        await layer.detachRenderer();
        if (retainedCredits[id]) {
          beforeA.credits = [
            { html: retainedCredits[id].html, onScreen: false },
          ];
          seenCredits.add(id);
        }
        assert.deepEqual(
          a.resources(),
          beforeA,
          'A resources released before engine destruction',
        );
        const detached = a.snapshot();
        await flushLifecycleTasks(t, 60_000);
        assert.deepEqual(a.snapshot(), detached, 'no writes to detached A');
        a.engine.destroy();
        const destroyed = a.snapshot();
        const sourceCount = calls.length;
        const networkCount = environment.network.length;
        await attach(b.engine, { waitForCameraRestore: true });
        await drive(b);
        if (layer.resumeViewport) {
          assert.deepEqual(
            calls.slice(sourceCount),
            [],
            'no source requests before resumeViewport',
          );
          assert.deepEqual(
            environment.network.slice(networkCount),
            [],
            'no transport requests before resumeViewport',
          );
        }
        await layer.resumeViewport?.();
        await drive(b);
        if (id === 'local-firms')
          assert.ok(
            calls.slice(sourceCount).some((call) => call.id === 'firms'),
            'empty FIRMS cache is fetched after camera restoration',
          );
        await layer.disable();
        await drive(b);
        assertHidden(b.engine);
        await layer.detachRenderer();
        if (retainedCredits[id])
          beforeB.credits = [
            { html: retainedCredits[id].html, onScreen: false },
          ];
        assert.deepEqual(b.resources(), beforeB, 'B resources released');
        const detachedB = b.snapshot();
        await flushLifecycleTasks(t, 60_000);
        assert.deepEqual(b.snapshot(), detachedB, 'no writes to detached B');
        await layer.destroy?.();
        assert.deepEqual(
          a.snapshot(),
          destroyed,
          'no writes to destroyed A while driving B',
        );
        assert.deepEqual(a.violations, []);
        assert.deepEqual(b.violations, []);
        assert.deepEqual(
          [...reads].sort(),
          expectedReaders[layer.id] ?? [],
          'viewer reader table must only shrink',
        );
        if (reads.size) seenReaders.push(id);
      } finally {
        lifetime.abort();
        for (const entry of catalog.layers) await entry.destroy?.();
        a.services.destroy();
        b.services.destroy();
        if (!a.engine.isDestroyed()) a.engine.destroy();
        b.engine.destroy();
      }
    });
  }
  assert.deepEqual(
    seenReaders.sort(),
    Object.keys(expectedReaders).sort(),
    'remove stale viewer reader entries',
  );
  assert.deepEqual(
    [...seenCredits].sort(),
    Object.keys(retainedCredits).sort(),
    'remove stale retained-credit entries',
  );
});
