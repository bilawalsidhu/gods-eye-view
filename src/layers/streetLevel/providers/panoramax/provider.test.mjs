import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPanoramaxProvider,
  panoramaxZoomFor,
  passesCoverage,
  pictureTilesAround,
} from './index.js';
import {
  FILTERED_HINT,
  NO_COVERAGE_HINT,
  PICK_PREFIX,
  ZOOM_IN_HINT,
} from './policy.js';
import { validateProviders } from '../../registry.js';
import { tileBounds } from '../../tileMath.js';
import { fakeHost, until } from '../../../../testSupport/kartaViewFakes.mjs';
import {
  coverageViewer,
  tileCentre,
} from '../../../../testSupport/streetLevelFakes.mjs';
import {
  encodePanoramaxTile,
  stacItem,
} from '../../../../testSupport/panoramaxFixtures.mjs';

const ORIGIN = { lon: 2.3495, lat: 48.8874 };
/** A point `metres` east of ORIGIN. */
const east = (metres) => ({
  lon: ORIGIN.lon + metres / 73_300,
  lat: ORIGIN.lat,
});

/**
 * A sequence `seq` of `count` pictures 5 m apart heading east from ORIGIN
 * (`offset` m in), each linked to its neighbours.
 */
function sequence(seq, count, { offset = 0, pano = false } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const at = east(offset + i * 5);
    return stacItem({
      id: `${seq}-${i}`,
      sequenceId: seq,
      ...at,
      pano,
      prevId: i ? `${seq}-${i - 1}` : null,
      nextId: i < count - 1 ? `${seq}-${i + 1}` : null,
    });
  });
}

/** A source over `items`, answering nearest lookups by distance, recording calls. */
function fakeSource({ items = [], tiles = () => new Uint8Array(0) } = {}) {
  const calls = { nearest: [], items: [], tiles: [] };
  const metres = (a, b) =>
    Math.hypot((a.lon - b.lon) * 73_300, (a.lat - b.lat) * 111_200);
  return {
    calls,
    getTile: async (tile) => {
      calls.tiles.push(`${tile.z}/${tile.x}/${tile.y}`);
      return tiles(tile);
    },
    getItem: async (id) => {
      calls.items.push(id);
      return items.find((item) => item.id === id) ?? null;
    },
    nearestItems: async (query) => {
      calls.nearest.push(query);
      const at = { lon: query.lon, lat: query.lat };
      return items
        .filter(
          (item) => !query.collections || item.collection === query.collections,
        )
        .map((item) => ({
          item,
          d: metres(at, {
            lon: item.geometry.coordinates[0],
            lat: item.geometry.coordinates[1],
          }),
        }))
        .filter(({ d }) => d <= query.radius)
        .sort((a, b) => a.d - b.d)
        .slice(0, query.limit)
        .map(({ item }) => item);
    },
  };
}

function fakeContext({ filter = { pano: 'all', sinceMs: null } } = {}) {
  const actions = { opened: [], nearest: [], errors: [], instance: null };
  return {
    actions,
    context: {
      services: {},
      getFilter: () => filter,
      isActive: () => true,
      notify() {},
      actions: {
        openImage: async (id, options) => {
          actions.opened.push({ id, options });
          // As the core does, errors included (a test may not mount a viewer).
          await actions.instance?.viewer.open(id).catch((error) => {
            actions.errors.push(error.message);
          });
          return true;
        },
        openNearest: (point) => actions.nearest.push(point),
        reportError: (message) => actions.errors.push(message),
      },
    },
  };
}

function setup(sourceOptions, contextOptions) {
  const source = fakeSource(sourceOptions);
  const loads = [];
  const definition = createPanoramaxProvider({
    source,
    viewerOptions: {
      load: async (url) => {
        loads.push(url);
        return { src: url };
      },
      createRenderer: () => {
        throw new Error('no WebGL in Node');
      },
    },
  });
  const { context, actions } = fakeContext(contextOptions);
  const instance = definition.create(context);
  actions.instance = instance;
  return { definition, instance, source, actions, loads };
}

test('Panoramax registers keyless and off by default, with both filters and its own wording', () => {
  const { definition } = setup();
  assert.equal(definition.id, 'panoramax');
  assert.equal(definition.label, 'PANORAMAX');
  assert.equal(definition.requiresKeyId, null);
  assert.equal(definition.defaultOn, false);
  assert.equal(definition.filters, undefined, 'pano and since both apply');
  assert.notEqual(definition.highlightsSequence, false, 'lines are sequences');
  assert.match(definition.credit.html, /Panoramax<\/a> contributors/);
  assert.equal(
    definition.coverageLabel.action,
    'click a line for its nearest photo',
  );
  assert.doesNotThrow(() => validateProviders([definition]));
});

test('lines at z10–14 below 60 km, as Mapillary’s; nothing above', () => {
  assert.equal(panoramaxZoomFor(500), 14);
  assert.equal(panoramaxZoomFor(1_800), 14);
  assert.equal(panoramaxZoomFor(4_000), 13);
  assert.equal(panoramaxZoomFor(12_000), 12);
  assert.equal(panoramaxZoomFor(25_000), 11);
  assert.equal(panoramaxZoomFor(30_000), 11);
  assert.equal(panoramaxZoomFor(30_001), 10);
  assert.equal(panoramaxZoomFor(60_000), 10);
  assert.equal(panoramaxZoomFor(60_001), null);
  assert.equal(panoramaxZoomFor(20_000_000), null);
  assert.equal(panoramaxZoomFor(NaN), null);
});

test('a line with no camera type or no day passes the filters: a click finds out', () => {
  const filter = { pano: 'pano', sinceMs: Date.UTC(2024, 0, 1) };
  assert.equal(
    passesCoverage({ isPano: null, capturedAt: Date.UTC(2025, 0, 1) }, filter),
    true,
  );
  assert.equal(passesCoverage({ isPano: true, capturedAt: 0 }, filter), true);
  assert.equal(passesCoverage({ isPano: false, capturedAt: 0 }, filter), false);
  assert.equal(
    passesCoverage({ isPano: null, capturedAt: Date.UTC(2020, 0, 1) }, filter),
    false,
  );
});

test('the imagery filter: lines by type and day', () => {
  const old = Date.UTC(2020, 0, 1);
  const since = { pano: 'all', sinceMs: Date.UTC(2024, 0, 1) };
  assert.equal(
    passesCoverage({ isPano: false, capturedAt: old }, since),
    false,
  );
  assert.equal(
    passesCoverage(
      { isPano: true, capturedAt: Date.UTC(2025, 0, 1) },
      {
        pano: 'pano',
        sinceMs: null,
      },
    ),
    true,
  );
  assert.equal(passesCoverage({ isPano: false, capturedAt: old }, null), true);
});

test('cones read the z15 tile around a picture, and its neighbours near an edge', () => {
  const home = tileCentre(ORIGIN.lon, ORIGIN.lat, 15);
  assert.equal(pictureTilesAround(home).length, 1, 'mid-tile: one tile');
  const box = tileBounds(home.tile.x, home.tile.y, 15);
  const corner = { lon: box.west + 0.0002, lat: box.north - 0.0002 };
  const tiles = pictureTilesAround(corner).map((t) => `${t.x}/${t.y}`);
  const { x, y } = home.tile;
  assert.deepEqual(tiles, [
    `${x}/${y}`,
    `${x - 1}/${y}`,
    `${x}/${y - 1}`,
    `${x - 1}/${y - 1}`,
  ]);
  // Across the antimeridian the column wraps.
  const dateLine = pictureTilesAround({ lon: -179.9999, lat: 0.5 });
  assert.equal(dateLine[1].x, 2 ** 15 - 1);
});

test('the nearest picture within 50 m that passes the filter; filters go to the API', async () => {
  const items = [
    ...sequence('far', 1, { offset: 80 }),
    ...sequence('a', 3, { offset: 10 }),
  ];
  const { instance, source } = setup(
    { items },
    { filter: { pano: 'pano', sinceMs: 123 } },
  );
  const id = await instance.nearestImage(east(0));
  assert.equal(id, 'a-0');
  assert.equal(source.calls.nearest.length, 1);
  assert.equal(source.calls.nearest[0].pano, 'pano');
  assert.equal(source.calls.nearest[0].sinceMs, 123);
  assert.equal(source.calls.nearest[0].collections, null);
  assert.equal(await instance.nearestImage(east(300)), null, 'none near');
});

test('a click on a line opens that sequence’s picture nearest the click, not another’s', async () => {
  const items = [
    ...sequence('other', 2, { offset: 0 }),
    ...sequence('clicked', 4, { offset: 8 }),
  ];
  const { instance, actions, source } = setup({ items });
  assert.equal(
    instance.handlePick(`${PICK_PREFIX.sequence}clicked`, {
      groundPoint: () => east(1),
    }),
    true,
  );
  assert.deepEqual(actions.nearest, [east(1)]);
  // The core asks the provider for the nearest picture to that point.
  assert.equal(await instance.nearestImage(east(1)), 'clicked-0');
  assert.equal(source.calls.nearest[0].collections, 'clicked');
  // Only once: the next lookup (OPEN, another click) is any sequence's.
  assert.equal(await instance.nearestImage(east(1)), 'other-0');
});

test('a line click whose sequence has nothing near falls back to any picture there', async () => {
  const items = [
    ...sequence('near', 1),
    ...sequence('clicked', 1, { offset: 400 }),
  ];
  const { instance, source } = setup({ items });
  instance.handlePick(`${PICK_PREFIX.sequence}clicked`, {
    groundPoint: () => east(0),
  });
  assert.equal(await instance.nearestImage(east(0)), 'near-0');
  assert.deepEqual(
    source.calls.nearest.map((q) => q.collections),
    ['clicked', null],
  );
});

test('a cone opens its picture; foreign ids are not picked', () => {
  const { instance, actions } = setup();
  assert.equal(instance.handlePick(`${PICK_PREFIX.image}abc`), true);
  assert.equal(actions.opened[0].id, 'abc');
  assert.equal(instance.handlePick('kv:line:1'), false);
  assert.equal(instance.handlePick('pnx:other'), false);
});

/** A provider and its viewer mounted, opening pictures through the fake core. */
async function mounted(sourceOptions, contextOptions) {
  const env = setup(sourceOptions, contextOptions);
  const poses = [];
  env.instance.viewer.onPose((pose) => poses.push(pose.imageId));
  const host = fakeHost();
  await env.instance.viewer.mount(host);
  const [, , prev, next] = host.children[0].children;
  return { ...env, poses, prev, next };
}

test('› and ‹ step along the picture’s links without moving the camera, asking only for the next picture', async () => {
  const items = sequence('s', 3);
  const env = await mounted({ items });
  await env.instance.viewer.open('s-0');
  assert.ok(await until(() => env.prev.disabled), 'the first picture: no ‹');
  env.next.fire('click');
  assert.ok(await until(() => env.poses.at(-1) === 's-1'));
  assert.deepEqual(env.actions.opened.at(-1), {
    id: 's-1',
    options: { frame: false },
  });
  env.next.fire('click');
  assert.ok(await until(() => env.poses.at(-1) === 's-2'));
  assert.ok(await until(() => env.next.disabled), 'the last picture: no ›');
  assert.deepEqual(env.source.calls.items, ['s-0', 's-1', 's-2']);
  env.prev.fire('click');
  assert.ok(await until(() => env.poses.at(-1) === 's-1'));
  assert.equal(env.source.calls.items.length, 3, 's-1 came from the cache');
});

test('one lookup for a picture asked twice at once', async () => {
  const items = sequence('s', 1);
  const { instance, source } = setup({ items });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const getItem = source.getItem;
  source.getItem = async (id) => {
    await gate;
    return getItem(id);
  };
  const host = fakeHost();
  await instance.viewer.mount(host);
  const first = instance.viewer.open('s-0');
  const second = instance.viewer.open('s-0');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(source.calls.items, ['s-0']);
});

test('a picture Panoramax does not know, or an id it refuses, fails the open with a reason', async () => {
  const env = await mounted({ items: [] });
  await assert.rejects(
    env.instance.viewer.open('ghost'),
    /no longer available/,
  );
  env.source.getItem = async () => {
    throw Object.assign(new Error('Panoramax answered HTTP 400'), {
      status: 400,
    });
  };
  await assert.rejects(
    env.instance.viewer.open('not-a-uuid'),
    /no longer available/,
  );
  env.source.getItem = async () => {
    throw Object.assign(new Error('Panoramax is busy'), { status: 503 });
  };
  await assert.rejects(env.instance.viewer.open('busy'), /busy/);
});

/** Cones on a stand-in Cesium viewer; `count()` reads how many are drawn. */
async function withCones(t, env) {
  const Cesium = await import('cesium');
  // The cone glyph draws on a canvas: any drawing call is fine.
  const drawing = new Proxy({}, { get: () => () => {}, set: () => true });
  const saved = globalThis.document;
  globalThis.document = {
    createElement: () => ({ getContext: () => drawing }),
  };
  t.after(() => (globalThis.document = saved));
  let collection = null;
  env.instance.init({
    scene: {
      frameState: { mode: Cesium.SceneMode.SCENE3D },
      updateHeight: () => () => {},
      getHeight: () => undefined,
      primitives: { add: (c) => (collection = c), remove() {} },
      preRender: { addEventListener: () => () => {} },
    },
    camera: { positionWC: new Cesium.Cartesian3(0, 0, 1e8) },
  });
  return {
    count: () => collection?.length ?? 0,
    ids: () =>
      Array.from({ length: collection?.length ?? 0 }, (_, i) =>
        String(collection.get(i).id).replace(PICK_PREFIX.image, ''),
      ),
  };
}

/** z15 tiles holding every item of `items` as a picture. */
const pictureTiles = (items) => (tile) => {
  if (tile.z !== 15) return new Uint8Array(0);
  const box = tileBounds(tile.x, tile.y, tile.z);
  const inside = items.filter(
    ({
      geometry: {
        coordinates: [lon, lat],
      },
    }) =>
      lon >= box.west && lon < box.east && lat <= box.north && lat > box.south,
  );
  return encodePanoramaxTile(tile, {
    pictures: inside.map((item) => ({
      id: item.id,
      lon: item.geometry.coordinates[0],
      lat: item.geometry.coordinates[1],
      sequenceId: item.collection,
      ts: item.properties.datetime.replace('T', ' ').replace('+00:00', '+00'),
    })),
  });
};

test('once a picture is on screen its sequence’s cones load from the z15 tile around it', async (t) => {
  const items = [...sequence('s', 6), ...sequence('x', 3, { offset: 2 })];
  const env = await mounted({ items, tiles: pictureTiles(items) });
  const cones = await withCones(t, env);
  await env.instance.viewer.open('s-2');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  assert.equal(env.instance.sequenceStats().selectedId, 's');
  assert.equal(env.instance.sequenceStats().images, 6, 'only sequence s');
  assert.equal(cones.count(), 6);
  assert.ok(env.source.calls.tiles.every((key) => key.startsWith('15/')));
});

test('a click on a line with no ground under it changes nothing: the open sequence keeps its cones', async (t) => {
  const items = [...sequence('x', 6), ...sequence('y', 3, { offset: 3 })];
  const env = await mounted({ items, tiles: pictureTiles(items) });
  const cones = await withCones(t, env);
  await env.instance.viewer.open('x-1');
  await env.instance.selectSequence('x');
  assert.ok(await until(() => cones.count() === 6));
  const asked = env.source.calls.tiles.length;
  assert.equal(
    env.instance.handlePick(`${PICK_PREFIX.sequence}y`, {
      groundPoint: () => null,
    }),
    true,
    'the click is the provider’s, even with nothing to open',
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.instance.sequenceStats().selectedId, 'x');
  assert.equal(cones.count(), 6);
  assert.equal(env.source.calls.tiles.length, asked);
  assert.deepEqual(env.actions.nearest, []);
});

test('a sequence selected with nothing to centre on draws no cones, and a picture opening in it then does not throw', async (t) => {
  const items = sequence('s', 3);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  await withCones(t, env);
  await env.instance.selectSequence('s');
  assert.equal(env.instance.sequenceStats().images, 0);
  assert.deepEqual(env.source.calls.tiles, []);
  // Its first picture opens: the cones load around it.
  await env.instance.viewer.open('s-0');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => env.instance.sequenceStats().images === 3));
});

test('a line clicked from high up looks for its sequence further off; the radius grows with height, up to 400 m', async () => {
  const items = [
    ...sequence('near', 1),
    ...sequence('line', 1, { offset: 220 }),
  ];
  const { instance, source } = setup({ items });
  const height = (h) =>
    instance.init({
      camera: { positionCartographic: { height: h } },
      scene: {
        primitives: { add() {}, remove() {} },
        preRender: { addEventListener: () => () => {} },
      },
    });
  const click = () =>
    instance.handlePick(`${PICK_PREFIX.sequence}line`, {
      groundPoint: () => east(0),
    });
  height(25_000);
  click();
  assert.equal(
    await instance.nearestImage(east(0)),
    'line-0',
    '220 m off, from 25 km',
  );
  assert.equal(source.calls.nearest.at(-1).radius, 250);
  height(1_000);
  click();
  assert.equal(
    await instance.nearestImage(east(0)),
    'near-0',
    'from 1 km only 50 m: any sequence’s nearer picture',
  );
  height(900_000);
  click();
  await instance.nearestImage(east(0));
  assert.equal(
    source.calls.nearest.filter((q) => q.collections === 'line').at(-1).radius,
    400,
    'capped',
  );
});

test('a lookup at another point does not take a line click’s sequence', async () => {
  const items = [
    ...sequence('other', 1),
    ...sequence('clicked', 1, { offset: 8 }),
  ];
  const { instance, source } = setup({ items });
  instance.handlePick(`${PICK_PREFIX.sequence}clicked`, {
    groundPoint: () => east(1),
  });
  // OPEN at the view centre, a few metres away, overtakes the click.
  assert.equal(await instance.nearestImage(east(3)), 'other-0');
  assert.deepEqual(
    source.calls.nearest.map((q) => q.collections),
    [null],
  );
});

test('the cones come in capture order, and a broken neighbour tile only thins them', async (t) => {
  const items = sequence('s', 5).map((item, i) => ({
    ...item,
    properties: {
      ...item.properties,
      // Captured in reverse of their position along the street.
      datetime: `2025-06-01T10:00:0${9 - i}+00:00`,
    },
  }));
  const tiles = pictureTiles(items);
  const env = await mounted({ items, tiles });
  const cones = await withCones(t, env);
  await env.instance.viewer.open('s-0');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => cones.count() === 5));
  assert.deepEqual(cones.ids(), ['s-4', 's-3', 's-2', 's-1', 's-0']);
  // A neighbour answers with garbage: the home tile's cones still draw.
});

test('a broken neighbour z15 tile only thins the cones; an unreadable home tile reads as such', async (t) => {
  // At a tile corner: the home tile and three neighbours are asked.
  const home = tileCentre(ORIGIN.lon, ORIGIN.lat, 15);
  const box = tileBounds(home.tile.x, home.tile.y, 15);
  const at = { lon: box.west + 0.0003, lat: box.north - 0.0002 };
  const items = [0, 1, 2].map((i) =>
    stacItem({
      id: `c-${i}`,
      sequenceId: 'c',
      lon: at.lon + i * 0.00005,
      lat: at.lat,
    }),
  );
  const tiles = pictureTiles(items);
  const broken = new TextEncoder().encode('<html>oops</html>');
  const homeKey = `15/${home.tile.x}/${home.tile.y}`;
  const env = await mounted({
    items,
    tiles: (tile) =>
      `${tile.z}/${tile.x}/${tile.y}` === homeKey ? tiles(tile) : broken,
  });
  const cones = await withCones(t, env);
  await env.instance.viewer.open('c-0');
  await env.instance.selectSequence('c');
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  assert.equal(cones.count(), 3, 'the home tile’s cones draw');
  assert.ok(env.source.calls.tiles.length > 1, 'neighbours were asked');
  // Another sequence whose home tile is unreadable too.
  const env2 = await mounted({ items, tiles: () => broken });
  await withCones(t, env2);
  await env2.instance.viewer.open('c-0');
  await env2.instance.selectSequence('c');
  assert.ok(await until(() => env2.instance.sequenceStats().error));
  assert.match(env2.instance.sequenceStats().error, /could not be read/);
  assert.deepEqual(
    env2.actions.errors.filter(Boolean),
    [],
    'a sequence error is the sequence’s, not the viewer’s',
  );
});

test('cones re-centred into tiles already read do not read them again', async (t) => {
  const items = sequence('long', 400);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  await withCones(t, env);
  await env.instance.viewer.open('long-0');
  await env.instance.selectSequence('long');
  assert.ok(await until(() => env.instance.sequenceStats().images > 0));
  await env.instance.viewer.open('long-399');
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  const asked = env.source.calls.tiles.length;
  // Back to the start: its tiles are kept.
  await env.instance.viewer.open('long-0');
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(env.source.calls.tiles.length, asked);
  assert.ok(env.instance.sequenceStats().images > 0);
});

test('› within the tiles the cones came from reloads nothing', async (t) => {
  const items = sequence('s', 4);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  await withCones(t, env);
  await env.instance.viewer.open('s-0');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => env.instance.sequenceStats().images === 4));
  const asked = env.source.calls.tiles.length;
  env.next.fire('click');
  assert.ok(await until(() => env.poses.at(-1) === 's-1'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(env.source.calls.tiles.length, asked);
});

test('the cones re-centre when › walks into another z15 tile', async (t) => {
  // 400 pictures 5 m apart span 2 km: more than two z15 tiles (~800 m).
  const items = sequence('long', 400);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  await withCones(t, env);
  await env.instance.viewer.open('long-0');
  await env.instance.selectSequence('long');
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  const firstTiles = new Set(env.source.calls.tiles);
  const first = env.instance.sequenceStats().images;
  assert.ok(first > 0 && first < 400, `part of the sequence: ${first}`);
  // Jump to the far end: the cones follow.
  await env.instance.viewer.open('long-399');
  assert.ok(
    await until(() =>
      env.source.calls.tiles.some((key) => !firstTiles.has(key)),
    ),
    'a new tile was read',
  );
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  assert.ok(env.instance.sequenceStats().images > 0);
});

/** The provider drawing coverage on a stand-in viewer above one z14 tile. */
function coverageSetup(t, { sequences = [], filter, height = 900 } = {}) {
  const centre = tileCentre(ORIGIN.lon, ORIGIN.lat);
  let hold = null;
  const env = setup(
    {
      tiles: (tile) => {
        const bytes = encodePanoramaxTile(tile, { sequences });
        return hold ? hold.then(() => bytes) : bytes;
      },
    },
    { filter },
  );
  const viewer = coverageViewer({ ...centre, height }, t);
  env.instance.init(viewer);
  t.after(() => env.instance.destroy(viewer));
  return {
    ...env,
    viewer,
    centre,
    holdTiles() {
      let release;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

const line = (id, options = {}) => ({
  id,
  parts: [
    [
      [ORIGIN.lon - 0.001, ORIGIN.lat],
      [ORIGIN.lon + 0.001, ORIGIN.lat],
    ],
  ],
  ...options,
});

test('sequence lines draw near the ground, and the imagery filter thins them', async (t) => {
  const env = coverageSetup(t, {
    sequences: [
      line('new-pano', { type: 'equirectangular', date: '2025-06-01' }),
      line('old-flat', { date: '2019-06-01' }),
    ],
  });
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().count === 2));
  assert.equal(env.instance.coverageStats().keyRequired, false);
  assert.equal(env.instance.coverageStats().error, null);
  env.instance.deactivate();

  const filtered = coverageSetup(t, {
    filter: { pano: 'pano', sinceMs: null },
    sequences: [
      line('new-pano', { type: 'equirectangular' }),
      line('old-flat'),
    ],
  });
  filtered.instance.activate(filtered.viewer);
  assert.ok(await until(() => filtered.instance.coverageStats().count === 1));
});

test('the selected sequence’s line is drawn again over the coverage, and goes with it', async (t) => {
  const env = coverageSetup(t, { sequences: [line('a'), line('b')] });
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().count === 2));
  const ground = env.viewer.scene.groundPrimitives.items;
  const drawn = ground.size;
  await env.instance.selectSequence('a');
  assert.equal(ground.size, drawn + 1, 'one highlight over the lines');
  env.instance.clearSequence();
  assert.equal(ground.size, drawn);
});

test('coverage hints: nothing while loading, “no pictures” once an empty view has loaded', async (t) => {
  const env = coverageSetup(t);
  const release = env.holdTiles();
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().loading));
  assert.equal(env.instance.coverageStats().hint, '');
  release();
  assert.ok(await until(() => !env.instance.coverageStats().loading));
  assert.equal(env.instance.coverageStats().hint, NO_COVERAGE_HINT);
});

test('from high up nothing is drawn or fetched, and the panel says to zoom in', async (t) => {
  const env = coverageSetup(t, { height: 200_000, sequences: [line('a')] });
  env.instance.activate(env.viewer);
  assert.ok(
    await until(() => env.instance.coverageStats().hint === ZOOM_IN_HINT),
  );
  assert.equal(env.instance.coverageStats().count, 0);
  assert.equal(env.instance.coverageStats().loading, false);
  assert.deepEqual(env.source.calls.tiles, []);
  assert.equal(env.viewer.scene.groundPrimitives.items.size, 0);
});

test('switching off clears the cones and forgets a pending line click', async (t) => {
  const items = sequence('s', 3);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  const cones = await withCones(t, env);
  await env.instance.viewer.open('s-0');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => cones.count() === 3), 'cones to clear');
  env.instance.handlePick(`${PICK_PREFIX.sequence}s`, {
    groundPoint: () => east(0),
  });
  env.instance.deactivate();
  assert.equal(env.instance.sequenceStats().selectedId, null);
  assert.equal(cones.count(), 0, 'the cones are gone');
  // The click's preference is gone: a later lookup asks any sequence.
  await env.instance.nearestImage(east(0));
  assert.equal(env.source.calls.nearest.at(-1).collections, null);
});

test('lines in view that the filter hides all of say so, not that there is nothing here', async (t) => {
  const env = coverageSetup(t, {
    filter: { pano: 'pano', sinceMs: null },
    sequences: [line('flat-only')],
  });
  env.instance.activate(env.viewer);
  assert.ok(
    await until(() => env.instance.coverageStats().hint === FILTERED_HINT),
  );
  assert.equal(env.instance.coverageStats().count, 0);
});

test('Esc in the docked viewer clears the selected sequence before the panel can collapse', async (t) => {
  const items = sequence('s', 3);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  await withCones(t, env);
  await env.instance.viewer.open('s-0');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => env.instance.sequenceStats().images === 3));
  const root = env.next.parentNode;
  const flags = { stopped: false, prevented: false };
  root.fire('keydown', {
    key: 'Escape',
    stopPropagation: () => (flags.stopped = true),
    preventDefault: () => (flags.prevented = true),
  });
  assert.equal(env.instance.sequenceStats().selectedId, null);
  assert.deepEqual(
    flags,
    { stopped: true, prevented: true },
    'consumed: the panel never sees it',
  );
  // Nothing selected: Esc goes on to the panel.
  const again = { key: 'Escape', defaultPrevented: false };
  const result = { prevented: false };
  root.fire('keydown', {
    ...again,
    preventDefault() {
      result.prevented = true;
    },
  });
  assert.equal(result.prevented, false);
});

test('cones near the east and south edges read those neighbours; near both edges of a narrow tile, both sides', () => {
  const home = tileCentre(ORIGIN.lon, ORIGIN.lat, 15);
  const box = tileBounds(home.tile.x, home.tile.y, 15);
  const { x, y } = home.tile;
  const keys = (point) => pictureTilesAround(point).map((t) => `${t.x}/${t.y}`);
  assert.deepEqual(keys({ lon: box.east - 0.0002, lat: box.south + 0.0002 }), [
    `${x}/${y}`,
    `${x + 1}/${y}`,
    `${x}/${y + 1}`,
    `${x + 1}/${y + 1}`,
  ]);
  // Svalbard: a z15 tile is ~250 m wide, so its middle is near both sides.
  const north = tileCentre(15.6, 78.22, 15);
  const around = keys(north);
  for (const dx of [-1, 1])
    assert.ok(
      around.includes(`${north.tile.x + dx}/${north.tile.y}`),
      `${dx} in ${around}`,
    );
  assert.equal(around[0], `${north.tile.x}/${north.tile.y}`, 'its own first');
});

test('a search hit outside the radius (a bounding box’s corner) is not the nearest', async () => {
  const corner = stacItem({ id: 'corner', sequenceId: 'c', ...east(65) });
  const { instance, source } = setup({ items: [corner] });
  source.nearestItems = async () => [corner];
  assert.equal(await instance.nearestImage(east(0)), null);
});

test('a line clicked from low down still searches its own sequence within 50 m', async () => {
  const items = [
    ...sequence('other', 1, { offset: 2 }),
    ...sequence('clicked', 1, { offset: 30 }),
  ];
  const { instance, source } = setup({ items });
  instance.init({
    camera: { positionCartographic: { height: 300 } },
    scene: {
      primitives: { add() {}, remove() {} },
      preRender: { addEventListener: () => () => {} },
    },
  });
  instance.handlePick(`${PICK_PREFIX.sequence}clicked`, {
    groundPoint: () => east(0),
  });
  assert.equal(await instance.nearestImage(east(0)), 'clicked-0');
  assert.equal(source.calls.nearest[0].radius, 50);
});

test('cones re-centre on a picture that opens while they are still loading', async (t) => {
  const items = sequence('long', 400);
  const tiles = pictureTiles(items);
  let release = null;
  const env = await mounted({ items, tiles });
  await withCones(t, env);
  await env.instance.viewer.open('long-0');
  env.source.getTile = async (tile) => {
    env.source.calls.tiles.push(`${tile.z}/${tile.x}/${tile.y}`);
    if (release === null) await new Promise((go) => (release = go));
    return tiles(tile);
  };
  const first = env.instance.selectSequence('long');
  assert.ok(await until(() => release !== null), 'the first load is held');
  // The far end opens while the cones around long-0 still load.
  await env.instance.viewer.open('long-399');
  release();
  await first;
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  const [lon, lat] = items[399].geometry.coordinates;
  const [far] = pictureTilesAround({ lon, lat });
  assert.ok(
    env.source.calls.tiles.includes(`15/${far.x}/${far.y}`),
    `the far picture's tile was read: ${env.source.calls.tiles}`,
  );
});

test('lines keep the decoded (longest-first) order under a cap on points', async () => {
  const { COVERAGE_TUNING } = await import('./policy.js');
  assert.equal(COVERAGE_TUNING.keepOrder, true);
  assert.ok(COVERAGE_TUNING.maxPoints > 0);
});

test('a coverage tile decoded a moment ago is not fetched again; switched off, the tiles are let go', async (t) => {
  const env = coverageSetup(t, { sequences: [line('a')] });
  const asked = [];
  const getTile = env.source.getTile;
  env.source.getTile = (tile, options) => {
    asked.push(`${tile.z}/${tile.x}/${tile.y}`);
    return getTile(tile, options);
  };
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().count === 1));
  const z14 = asked.length;
  // Up a zoom band and back down: the z14 tile comes from memory.
  // (Activating again refreshes at once, without the camera debounce.)
  env.viewer.view.height = 3_000;
  env.instance.activate(env.viewer);
  assert.ok(await until(() => asked.some((key) => key.startsWith('13/'))));
  assert.ok(await until(() => env.instance.coverageStats().count === 1));
  const withZ13 = asked.length;
  env.viewer.view.height = 900;
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().count === 1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(asked.length, withZ13, 'nothing fetched again');
  assert.ok(z14 > 0);
  // Off and on: the memory went back, so the tile is fetched again.
  env.instance.deactivate();
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().count === 1));
  assert.ok(asked.length > withZ13);
});

test('a re-centre while the cones still load does not inherit the aborted load’s tiles', async (t) => {
  const items = sequence('long', 400);
  const tiles = pictureTiles(items);
  const env = await mounted({ items, tiles });
  const cones = await withCones(t, env);
  let hold = null;
  env.source.getTile = async (tile, { signal } = {}) => {
    env.source.calls.tiles.push(`${tile.z}/${tile.x}/${tile.y}`);
    if (hold) await hold.promise;
    signal?.throwIfAborted();
    return tiles(tile);
  };
  await env.instance.viewer.open('long-0');
  const tileOf = (item) => {
    const [lon, lat] = item.geometry.coordinates;
    return pictureTilesAround({ lon, lat })[0];
  };
  const first = new Set(
    pictureTilesAround({
      lon: items[0].geometry.coordinates[0],
      lat: items[0].geometry.coordinates[1],
    }).map((tile) => `${tile.x}/${tile.y}`),
  );
  const out = items.findIndex((item) => {
    const tile = tileOf(item);
    return !first.has(`${tile.x}/${tile.y}`);
  });
  hold = {};
  hold.promise = new Promise((resolve) => (hold.release = resolve));
  const loading = env.instance.selectSequence('long');
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The far picture opens while the first load is held: the cones re-centre.
  await env.instance.viewer.open(`long-${out}`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const release = hold.release;
  hold = null;
  release();
  await loading;
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  // Every picture in the tiles the second load covers has its cone.
  const [lon, lat] = items[out].geometry.coordinates;
  const second = new Set(
    pictureTilesAround({ lon, lat }).map((tile) => `${tile.x}/${tile.y}`),
  );
  const covered = items.filter((item) => {
    const tile = tileOf(item);
    return second.has(`${tile.x}/${tile.y}`);
  });
  assert.ok(covered.length > 0);
  // The neighbours join as they arrive: wait for them, then every picture
  // in the re-centred tiles has its cone (the shared ones too).
  const coneCount = () => {
    const ids = new Set(cones.ids());
    return covered.filter((item) => ids.has(item.id)).length;
  };
  assert.ok(
    await until(() => coneCount() === covered.length),
    `${coneCount()} of ${covered.length}`,
  );
});

test('after a GPU reset the viewer draws the same picture itself, leaving the core’s lookups alone; a failure is reported', async () => {
  const items = sequence('p', 2, { pano: true });
  let failLoads = false;
  const view = { yaw: 0, pitch: 0, fov: 90 };
  const definition = createPanoramaxProvider({
    source: fakeSource({ items }),
    viewerOptions: {
      load: async (url) => {
        if (failLoads)
          throw new Error('The Panoramax photo could not be loaded');
        return { src: url, width: 2048, height: 1024 };
      },
      createRenderer: () => ({
        setImage() {},
        setView: (next) => Object.assign(view, next),
        getView: () => ({ ...view }),
        resize() {},
        clear() {},
        destroy() {},
      }),
    },
  });
  const { context, actions } = fakeContext();
  const instance = definition.create(context);
  actions.instance = instance;
  const host = fakeHost();
  await instance.viewer.mount(host);
  const poses = [];
  instance.viewer.onPose((pose) => poses.push(pose.imageId));
  await instance.viewer.open('p-0');
  const canvas = () => host.children[0].children[1];
  const kind = () => host.children[0].dataset.kind;
  assert.equal(kind(), 'pano');
  canvas().fire('webglcontextlost');
  assert.ok(await until(() => kind() === 'pano'), 'drawn again');
  assert.deepEqual(poses, ['p-0', 'p-0']);
  assert.deepEqual(actions.opened, [], 'not through the core');
  failLoads = true;
  canvas().fire('webglcontextlost');
  assert.ok(await until(() => actions.errors.some(Boolean)));
  assert.match(actions.errors.filter(Boolean)[0], /could not be loaded/);
});

/** A source whose lookup of `heldId` waits for `release()` and ignores aborts. */
function holdLookup(source, heldId) {
  const held = { release: null, signals: [] };
  const getItem = source.getItem;
  source.getItem = async (id, options = {}) => {
    held.signals.push({ id, signal: options.signal });
    if (id === heldId) await new Promise((go) => (held.release = go));
    return getItem(id);
  };
  return held;
}

test('a lookup that comes back after the user moved on does not move the cones', async (t) => {
  const items = sequence('long', 400);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  await withCones(t, env);
  const held = holdLookup(env.source, 'long-0');
  const late = env.instance.viewer.open('long-0');
  assert.ok(await until(() => held.release !== null));
  await env.instance.viewer.open('long-399');
  await late;
  // The first lookup answers anyway (a source that ignores the abort).
  held.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await env.instance.selectSequence('long');
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  const [lon, lat] = items[399].geometry.coordinates;
  const [far] = pictureTilesAround({ lon, lat });
  const [lon0, lat0] = items[0].geometry.coordinates;
  const [near] = pictureTilesAround({ lon: lon0, lat: lat0 });
  assert.equal(env.source.calls.tiles[0], `15/${far.x}/${far.y}`);
  assert.ok(
    !env.source.calls.tiles.includes(`15/${near.x}/${near.y}`),
    'nothing around the picture the user left',
  );
});

test('a lookup nobody waits for any more is stopped; one still wanted is not', async () => {
  const items = sequence('s', 3);
  const env = await mounted({ items });
  const held = holdLookup(env.source, 's-0');
  const first = env.instance.viewer.open('s-0');
  assert.ok(await until(() => held.release !== null));
  const [{ signal }] = held.signals;
  assert.equal(signal.aborted, false);
  await env.instance.viewer.open('s-1');
  await first;
  await Promise.resolve();
  assert.equal(signal.aborted, true, 'the user moved on: its search stops');
  // The same picture asked again at once shares the lookup, which goes on.
  held.release = null;
  held.signals.length = 0;
  const again = env.instance.viewer.open('s-2');
  const twice = env.instance.viewer.open('s-2');
  await Promise.all([again, twice]);
  assert.equal(held.signals.length, 1);
  assert.equal(held.signals[0].signal.aborted, false);
  assert.equal(env.poses.at(-1), 's-2');
});

/**
 * Two pictures of sequence `e` either side of a z15 tile's west edge,
 * half-way down it: the cones around the first read its tile and the
 * west neighbour.
 */
function acrossWestEdge() {
  const home = tileCentre(ORIGIN.lon, ORIGIN.lat, 15);
  const box = tileBounds(home.tile.x, home.tile.y, 15);
  const lat = (box.north + box.south) / 2;
  const items = [
    stacItem({
      id: 'e-0',
      sequenceId: 'e',
      lon: box.west + 0.00005,
      lat,
      nextId: 'e-1',
    }),
    stacItem({
      id: 'e-1',
      sequenceId: 'e',
      lon: box.west - 0.00005,
      lat,
      prevId: 'e-0',
    }),
  ];
  const west = `15/${home.tile.x - 1}/${home.tile.y}`;
  return { items, west };
}

test(
  'the open picture’s own tile draws its cones at once; a neighbour’s join as it arrives',
  { timeout: 10_000 },
  async (t) => {
    const { items, west } = acrossWestEdge();
    const tiles = pictureTiles(items);
    let release = null;
    const env = await mounted({
      items,
      tiles: async (tile) => {
        if (`${tile.z}/${tile.x}/${tile.y}` === west)
          await new Promise((go) => (release = go));
        return tiles(tile);
      },
    });
    const cones = await withCones(t, env);
    await env.instance.viewer.open('e-0');
    const [lon, lat] = items[0].geometry.coordinates;
    assert.equal(
      pictureTilesAround({ lon, lat }).length,
      2,
      'the west neighbour is read too',
    );
    // Not awaited: a load that waited for the neighbour would hang here.
    env.instance.selectSequence('e');
    assert.ok(await until(() => release !== null), 'the neighbour is held');
    assert.ok(
      await until(() => cones.count() === 1),
      'the home tile’s cone shows',
    );
    assert.deepEqual(cones.ids(), ['e-0']);
    release();
    assert.ok(await until(() => cones.count() === 2), 'the neighbour’s joins');
  },
);

test('a neighbour tile that failed is not counted as shown: › into it re-centres the cones there', async (t) => {
  const { items, west } = acrossWestEdge();
  const tiles = pictureTiles(items);
  let failing = true;
  const env = await mounted({
    items,
    tiles: (tile) => {
      if (failing && `${tile.z}/${tile.x}/${tile.y}` === west)
        throw Object.assign(new Error('Panoramax is busy'), { status: 503 });
      return tiles(tile);
    },
  });
  const cones = await withCones(t, env);
  await env.instance.viewer.open('e-0');
  await env.instance.selectSequence('e');
  assert.ok(await until(() => cones.count() === 1));
  // Let the neighbour's failure land.
  assert.ok(await until(() => env.source.calls.tiles.includes(west)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  failing = false;
  const asked = env.source.calls.tiles.filter((key) => key === west).length;
  env.next.fire('click');
  assert.ok(await until(() => env.poses.at(-1) === 'e-1'));
  assert.ok(
    await until(
      () => env.source.calls.tiles.filter((key) => key === west).length > asked,
    ),
    'the failed tile is asked again',
  );
  assert.ok(await until(() => cones.count() === 2), 'e-1 has its cone');
});

test('a busy or timed-out tile keeps its own message; only a body that is not a tile reads as unreadable', async (t) => {
  const items = sequence('s', 3);
  const failures = [
    Object.assign(new Error('Panoramax is busy'), { status: 429 }),
    Object.assign(new Error('Panoramax did not answer in time — try again'), {
      status: 0,
    }),
  ];
  for (const failure of failures) {
    const env = await mounted({
      items,
      tiles: () => {
        throw failure;
      },
    });
    await withCones(t, env);
    await env.instance.viewer.open('s-0');
    await env.instance.selectSequence('s');
    assert.ok(await until(() => env.instance.sequenceStats().error));
    assert.equal(env.instance.sequenceStats().error, failure.message);
  }
});
