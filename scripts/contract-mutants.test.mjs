import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../src/globe/testing/fakeEngine.js';
import { fakeContractOptions } from '../src/globe/testing/contractFixtures.js';
import {
  createContractSuite,
  runContractSuite,
} from '../src/globe/testing/contractSuite/index.mjs';

const replace = (object, member, wrap) => {
  object[member] = wrap(object[member].bind(object));
};
const handle = (engine, area, factory, mutate) =>
  replace(engine[area], factory, (create) => (...args) => {
    const value = create(...args);
    mutate(value);
    return value;
  });

const mutants = [
  [
    'field of view changes are ignored',
    'camera.setFovy: changes projection',
    (e) => { e.camera.setFovy = () => {}; },
  ],
  [
    'optical fields below one degree are ignored',
    'camera.setFovy: changes projection',
    (e) => {
      replace(e.camera, 'setFovy', (set) => (radians) => {
        if (radians >= Math.PI / 180) set(radians);
      });
    },
  ],
  [
    'retarget omits followChanged',
    'camera.following: set, retarget',
    (e) => {
      let previous;
      replace(e.camera.followChanged, 'raiseEvent', (raise) => (value) => {
        if (value !== previous) raise(value);
        previous = value;
      });
    },
  ],
  [
    'pointer cancels an active flight',
    'camera.flyTo: a pointer gesture',
    (e) => {
      replace(e.fake, 'input', (input) => (type, event) => {
        if (type === 'down') e.camera.cancelFlight();
        input(type, event);
      });
    },
  ],
  [
    'terrain errors are labelled as tiles',
    'maps.errors: terrain failures',
    (e) => {
      replace(
        e.maps.errors,
        'raiseEvent',
        (raise) => (error) => raise({ ...error, kind: 'tile' }),
      );
    },
  ],
  [
    'interrupted flight omits cancel',
    'camera.flyTo: a newer flight',
    (e) => {
      replace(
        e.camera,
        'flyTo',
        (fly) => (options) => fly({ ...options, cancel: undefined }),
      );
    },
  ],
  [
    'pure rotation omits changed',
    'camera.changed: a pure heading',
    (e) => {
      let previous = e.camera.pose().position;
      replace(e.camera.changed, 'raiseEvent', (raise) => (...args) => {
        const position = e.camera.pose().position;
        const moved =
          Math.hypot(
            position.x - previous.x,
            position.y - previous.y,
            position.z - previous.z,
          ) > 0.01;
        previous = position;
        if (moved) raise(...args);
      });
    },
  ],
  [
    'request during render is lost',
    'render.request: a request inside',
    (e) => {
      let inFrame = false;
      e.frames.preRender.addEventListener(() => {
        inFrame = true;
      });
      e.frames.postRender.addEventListener(() => {
        inFrame = false;
      });
      replace(e.render, 'request', (request) => (...args) => {
        if (!inFrame) request(...args);
      });
    },
  ],
  [
    'terrain revision stays fixed',
    'maps.terrainRevision: changes when setTerrain',
    (e) => {
      e.maps.terrainRevision = () => 0;
    },
  ],
  [
    'removed mover remains listed',
    'movers.list: shown follows',
    (e) => {
      const removed = [];
      const list = e.movers.list;
      handle(e, 'movers', 'createSet', (set) => {
        replace(set, 'destroy', (destroy) => () => {
          const row = list().find(({ id }) => id === set.id);
          if (row) removed.push(row);
          destroy();
        });
      });
      e.movers.list = () => [...list(), ...removed];
    },
  ],
  [
    'stop omits followChanged',
    'camera.following: set, retarget',
    (e) => {
      replace(e.camera.followChanged, 'raiseEvent', (raise) => (value) => {
        if (value !== null) raise(value);
      });
    },
  ],
  [
    'following forgets the handle',
    'camera.following: set, retarget',
    (e) => {
      e.camera.following = () => null;
    },
  ],
  [
    'retarget keeps the old target',
    'camera.following: set, retarget',
    (e) => {
      handle(e, 'camera', 'follow', (follow) => {
        follow.retarget = () => {};
      });
    },
  ],
  [
    'texture limit is not a power of two',
    'render.maxTextureSize:',
    (e) => {
      e.render.maxTextureSize = () => 3;
    },
  ],
  [
    'continuous mode never changes',
    'render.setContinuous: continuous',
    (e) => {
      e.render.setContinuous = () => {};
    },
  ],
  [
    'clock is never latched',
    'clock.frameTime: advances before',
    (e) => {
      e.clock.frameTime = () => 0;
    },
  ],
  [
    'terrain samples are reversed',
    'surface.sampleTerrainMostDetailed: preserves',
    (e) => {
      replace(
        e.surface,
        'sampleTerrainMostDetailed',
        (sample) =>
          async (...args) =>
            (await sample(...args)).reverse(),
      );
    },
  ],
  [
    'unknown terrain becomes zero',
    'surface.sampleTerrainMostDetailed: preserves',
    (e) => {
      replace(
        e.surface,
        'sampleTerrainMostDetailed',
        (sample) =>
          async (...args) =>
            (await sample(...args)).map((height) => height ?? 0),
      );
    },
  ],
  [
    'terrain rejection is swallowed',
    'surface.sampleTerrainMostDetailed: passes',
    (e) => {
      replace(
        e.surface,
        'sampleTerrainMostDetailed',
        (sample) =>
          async (...args) => {
            try {
              return await sample(...args);
            } catch {
              return [];
            }
          },
      );
    },
  ],
  [
    'failed model reports no failure',
    'movers.createSet: failed model retries',
    (e) => {
      handle(e, 'movers', 'createSet', (set) => {
        set.failed = () => false;
      });
    },
  ],
  [
    'failed model reports ready',
    'movers.createSet: failed model retries',
    (e) => {
      handle(e, 'movers', 'createSet', (set) => {
        set.ready = () => true;
      });
    },
  ],
  [
    'failed model never retries',
    'movers.createSet: failed model retries',
    (e) => {
      handle(e, 'movers', 'createSet', (set) => {
        replace(set, 'commit', (commit) => () => {
          const schedule = globalThis.setTimeout;
          globalThis.setTimeout = () => null;
          try {
            commit();
          } finally {
            globalThis.setTimeout = schedule;
          }
        });
      });
    },
  ],
  [
    'hidden mover reports shown',
    'movers.list: shown follows',
    (e) => {
      replace(
        e.movers,
        'list',
        (list) => () => list().map((row) => ({ ...row, shown: true })),
      );
    },
  ],
  [
    'map error loses HTTP status',
    'maps.errors: forwards source',
    (e) => {
      replace(
        e.maps.errors,
        'raiseEvent',
        (raise) => (error) => raise({ ...error, status: undefined }),
      );
    },
  ],
  [
    'map errors are swallowed',
    'maps.errors: forwards source',
    (e) => {
      e.maps.errors.raiseEvent = () => {};
    },
  ],
  [
    'old map providers keep reporting',
    'maps.errors: forwards source',
    (e) => {
      replace(e.maps, 'setBaseImagery', (set) => async (source) => {
        await set(source);
        source.provider?.errorEvent?.addEventListener((error) => {
          e.maps.errors.raiseEvent({
            source,
            kind: 'tile',
            status: error?.statusCode,
          });
        });
      });
    },
  ],
  [
    'flight remains active after completion',
    'camera.flyTo: duration 0',
    (e) => {
      e.camera.flightActive = () => true;
    },
  ],
  [
    'setView leaves the flight running',
    'camera.setView: cancels an active',
    (e) => {
      e.camera.setView = ({ destination, orientation }) =>
        e.fake.setPose({ position: destination, ...orientation });
    },
  ],
  [
    'instant flight omits complete',
    'camera.flyTo: duration 0',
    (e) => {
      replace(
        e.camera,
        'flyTo',
        (fly) => (options) => fly({ ...options, complete: undefined }),
      );
    },
  ],
  [
    'hidden meshes remain shown',
    'meshes.createMesh: picks use',
    (e) => {
      handle(e, 'meshes', 'createMesh', (mesh) => {
        replace(
          mesh,
          'show',
          (show) => (value) => show(value === false ? true : value),
        );
      });
    },
  ],
  [
    'imagery ignores alpha changes',
    'imagery.createLayer: layers are',
    (e) => {
      handle(e, 'imagery', 'createLayer', (layer) => {
        layer.setAlpha = () => {};
      });
    },
  ],
  [
    'clearing tiles forgets base imagery',
    'maps.setBaseImagery: setPhotorealTiles',
    (e) => {
      replace(e.maps, 'setPhotorealTiles', (set) => async (source) => {
        await set(source);
        if (source === null) e.fake.maps.imagery = null;
      });
    },
  ],
  [
    'tiles-only ground also draws on terrain',
    'ground.createSet: tiles drape',
    (e) => {
      replace(
        e.ground,
        'createSet',
        (create) => (options) =>
          create({
            ...options,
            drape: options.drape === 'tiles' ? 'both' : options.drape,
          }),
      );
    },
  ],
  [
    'released photoreal tiles still answer surface queries',
    'surface.sampleHeightDetailed: leaving photoreal',
    (e) => {
      replace(e.maps, 'setPhotorealTiles', (set) => async (source) => {
        await set(source);
        if (source === null)
          e.fake.script('sampleHeightDetailed', () => ({
            height: 50,
            source: 'tiles',
          }));
      });
    },
  ],
];

for (const [name, killedBy, mutate] of mutants) {
  test(`${name} — killed by ${killedBy}`, async () => {
    const engine = createFakeEngine();
    try {
      mutate(engine);
      const results = await runContractSuite(engine, {
        ...fakeContractOptions(engine),
        maxWaitFrames: 160,
      });
      const check = results.find(({ name }) => name.startsWith(killedBy));
      assert.ok(check, `No check named ${killedBy}`);
      assert.equal(check.ok, false, `Surviving mutant: ${name}`);
      assert.ok(
        check.error.name === 'ContractError' ||
          check.error.message === 'No frame requested',
        `Unexpected failure: ${check.error.stack}`,
      );
    } finally {
      engine.destroy();
    }
  });
}

test('released tile surface check runs without a tileset fixture', async () => {
  const engine = createFakeEngine();
  try {
    const check = createContractSuite(engine, {
      ...fakeContractOptions(engine),
      fixtures: null,
      mapSources: null,
    }).find(({ name }) =>
      name.startsWith('surface.sampleHeightDetailed: leaving photoreal'),
    );
    assert.ok(check);
    await check.run();
    engine.fake.script('sampleHeightDetailed', () => ({
      height: 50,
      source: 'tiles',
    }));
    await assert.rejects(check.run(), /released photoreal tiles/);
  } finally {
    engine.destroy();
  }
});

test('tiles-only ground pixels on terrain are detected without a tileset fixture or a picking defect', async () => {
  for (const drawsOnTerrain of [false, true]) {
    const engine = createFakeEngine();
    try {
      const check = createContractSuite(engine, {
        ...fakeContractOptions(engine),
        fixtures: null,
        mapSources: null,
        readRegion(x, y, width, height) {
          const shown = engine.ground
            .list()
            .some((set) => set.id === 'contract-tiles-drape' && set.shown);
          const color =
            drawsOnTerrain && shown
              ? [255, 0, 255, 255]
              : [50, 100, 150, 255];
          return Uint8Array.from(
            { length: width * height * 4 },
            (_, i) => color[i % 4],
          );
        },
      }).find(({ name }) => name.startsWith('ground.createSet: tiles drape'));
      assert.ok(check, 'tiles drape check runs without a tileset fixture');
      if (drawsOnTerrain)
        await assert.rejects(check.run(), /tiles drape changed terrain pixels/);
      else await check.run();
    } finally {
      engine.destroy();
    }
  }
});
