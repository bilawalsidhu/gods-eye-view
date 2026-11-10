import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFakeEngine } from '../../src/globe/testing/fakeEngine.js';
import { APPLICATION_LAYER_DIRECTORY } from '../../src/app/layers/directory.js';
import {
  COLD_START_GROUPS,
  coldStartUrl,
  compareProbe,
  compareColdStart,
  sessionExclusion,
  probeSnapshot,
  normalizeAllocations,
  coldStartReady,
} from './coldStart.mjs';

const snapshot = () => ({
  layers: {
    radio: {
      enabled: true,
      objects: [],
      selected: null,
      session: { selected: null, audioState: 'idle' },
      sessionState: ['selected', 'audioState'],
    },
  },
  ledger: [
    {
      family: 'movers',
      id: 'radio-selected',
      shown: true,
      count: 1,
      kind: 'point',
    },
  ],
  movers: [{ id: 'radio-selected', count: 1, kind: 'point', capacity: 1 }],
  following: null,
});
const options = {
  direction: 'cesium -> navara',
  owners: { 'movers:radio-selected': 'radio' },
};

test('groups cover every strict catalog layer once and are registered with flags', () => {
  const ids = Object.values(COLD_START_GROUPS).flatMap((group) => group.layers);
  assert.deepEqual(
    ids.sort(),
    APPLICATION_LAYER_DIRECTORY.map(({ id }) => id).sort(),
  );
  assert.ok(
    Object.values(COLD_START_GROUPS).every(({ layers }) => layers.length <= 4),
  );
  const runner = readFileSync(
    new URL('../qa-all-layer-switches.mjs', import.meta.url),
    'utf8',
  );
  const registered = JSON.parse(
    JSON.stringify(
      vm.runInNewContext(runner.match(/const runs = (\[[\s\S]*?\n\]);/)[1], {
        soakRuns: [],
        longRun: '',
      }),
    ),
  );
  for (const [group, { layers }] of Object.entries(COLD_START_GROUPS)) {
    assert.deepEqual(
      registered.find(
        ([label]) => label === `switch-equals-cold-start--${group}`,
      ),
      [
        `switch-equals-cold-start--${group}`,
        'switch-equals-cold-start',
        layers,
        [`--group=${group}`],
      ],
    );
  }
});

test('cold URL preserves the app-written hash, path and other query settings', () => {
  const from =
    'http://127.0.0.1:4309/share/ABC?engine=cesium&lang=de#v=2&l=f&lo=f.t.71be26';
  const result = new URL(coldStartUrl(from, 'navara'));
  assert.equal(result.pathname, '/share/ABC');
  assert.equal(result.hash, new URL(from).hash);
  assert.equal(result.searchParams.get('engine'), 'navara');
  assert.equal(result.searchParams.get('lang'), 'de');
});

test('probe comparison tolerates camera quantization but rejects lost objects and count changes', () => {
  const a = {
    objects: [
      {
        id: 'a',
        position: { x: 6378000, y: 0, z: 0 },
        screen: { x: 500, y: 400 },
      },
    ],
  };
  const b = structuredClone(a);
  b.objects[0].position.x += 0.5;
  b.objects[0].screen.x += 1.5;
  assert.deepEqual(compareProbe(a, b), []);
  b.objects[0].position.x += 1;
  assert.equal(compareProbe(a, b)[0].field, 'objects["a"].position.x');
  assert.ok(
    compareProbe(a, { objects: [] }).some(
      ({ field }) => field === 'objects["a"]',
    ),
  );
  assert.equal(compareProbe({ count: 1 }, { count: 1.0000001 }).length, 1);
  assert.equal(compareProbe({ selected: null }, {}).length, 1);
  assert.equal(
    compareProbe({ position: { x: NaN } }, { position: { x: 0 } }).length,
    1,
  );
});

test('probe arrays compare identities without hiding duplicate ids or reordered paths', () => {
  assert.deepEqual(
    compareProbe([{ id: 'b' }, { id: 'a' }], [{ id: 'a' }, { id: 'b' }]),
    [],
  );
  assert.ok(
    compareProbe([{ id: 'a' }, { id: 'a' }], [{ id: 'a' }, { id: 'a' }]).some(
      (row) => row.error === 'duplicate ids',
    ),
  );
  assert.equal(compareProbe([1, 2], [2, 1]).length, 2);
  assert.equal(
    compareProbe(
      { selected: { id: 'a' }, objects: [] },
      { selected: null, objects: [1] },
      { skip: ['selected'] },
    ).length,
    2,
  );
});

test('comparison returns every ledger family and field difference, with attribution', () => {
  const a = snapshot(),
    b = snapshot();
  b.ledger[0].count = 2;
  b.ledger[0].shown = false;
  b.ledger.push({ family: 'lines', id: 'extra', shown: true });
  b.layers.radio.objects = [{ id: 'new' }];
  b.following = { label: 'lost', native: null };
  const result = compareColdStart(a, b, { ...options, sessionState: false });
  assert.ok(
    result.differences.some(
      (row) => row.field === 'count' && row.layer === 'radio',
    ),
  );
  assert.ok(result.differences.some((row) => row.field === 'shown'));
  assert.ok(
    result.differences.some(
      (row) => row.family === 'lines' && row.id === 'extra',
    ),
  );
  assert.ok(result.differences.some((row) => row.id === 'following'));
  assert.ok(
    result.differences.some(
      (row) => row.field === 'objects["new"]' && row.id === 'new',
    ),
  );
  assert.equal(result.differences.length, 6);
});

test('declared session fields do not hide other probe fields or other layers', () => {
  const a = snapshot(),
    b = snapshot();
  a.layers.radio.session.selected = { id: 'station' };
  a.layers.radio.session.audioState = 'playing';
  b.movers[0].count = b.ledger[0].count = 0;
  b.layers.radio.enabled = false;
  const result = compareColdStart(a, b, options);
  assert.equal(result.skipped.length, 4);
  assert.deepEqual(
    result.differences.map((row) => row.field),
    ['enabled'],
  );
  b.layers.radio.sessionState.push('objects');
  assert.ok(
    compareColdStart(a, b, options).differences.some((row) =>
      row.field.startsWith('sessionState'),
    ),
  );
  assert.equal(
    sessionExclusion(
      { layer: 'wind', family: 'movers', id: 'radio-selected', field: 'count' },
      a,
    ),
    null,
  );
});

test('a lost session field still fails the source-to-switch retention check', () => {
  const a = snapshot(),
    b = snapshot();
  a.layers.radio.session.selected = { id: 'station' };
  b.movers[0].count = b.ledger[0].count = 0;
  const retention = compareColdStart(a, b, {
    ...options,
    sessionState: false,
  }).differences.filter((row) => sessionExclusion(row, a));
  assert.equal(retention.length, 3);
});

test('allowlisted absences keep their reason and never hide changed visibility or counts', () => {
  const a = snapshot(),
    b = snapshot();
  a.ledger.push({ family: 'lines', id: 'overlay', shown: true });
  b.ledger[0].shown = false;
  const result = compareColdStart(a, b, {
    ...options,
    sessionState: false,
    allow: [{ family: 'lines', id: 'overlay', reason: 'Engine overlay' }],
  });
  assert.equal(result.ledger.allowed[0].reason, 'Engine overlay');
  assert.deepEqual(
    result.differences.map((row) => row.field),
    ['shown'],
  );
});

test('the production probe captures all requested fields and releases its frame listeners', async () => {
  const engine = createFakeEngine();
  const position = { x: 6378137, y: 0, z: 0 };
  const dataManager = {
    layers: new Map([
      [
        'fixture',
        {
          enabled: true,
          module: {
            getAllPositions: () => [{ id: 'one', position }],
            getSelectedInfo: () => ({ id: 'one' }),
          },
        },
      ],
    ]),
  };
  const context = vm.createContext({
    window: { __godsEyeView: { engine, dataManager } },
  });
  const page = {
    evaluate: async (code) =>
      vm.runInContext(typeof code === 'string' ? code : `(${code})()`, context),
  };
  const listeners = engine.frames.postRender.numberOfListeners;
  const snapshot = await probeSnapshot(page, ['fixture']);
  assert.equal(snapshot.layers.fixture.objects[0].id, 'one');
  assert.equal(snapshot.layers.fixture.selected.id, 'one');
  assert.equal(snapshot.following, null);
  assert.equal(snapshot.movers.length, 0);
  assert.equal(snapshot.ledger.length, 0);
  assert.equal(engine.frames.postRender.numberOfListeners, listeners);
  engine.destroy();
});

test('display allocation counters do not become content identities or hide lost slots', () => {
  const a = snapshot(),
    b = snapshot();
  for (const [family, left, right, layer] of [
    ['imagery', 'weather-4', 'weather-1', 'weather-radar'],
    ['imagery', 'wind-field-2', 'wind-field-1', 'wind'],
    [
      'imagery',
      'bhote-koshi-imagery-2-left',
      'bhote-koshi-imagery-1-left',
      'bhote-koshi-2026',
    ],
    [
      'imagery',
      'bhote-koshi-imagery-2-right',
      'bhote-koshi-imagery-1-right',
      'bhote-koshi-2026',
    ],
    ['lines', 'satellites-orbit-5', 'satellites-orbit-4', 'satellites'],
    ['movers', 'satellites-points-4-4', 'satellites-points-5-4', 'satellites'],
  ]) {
    a.ledger.push({ family, id: left, layer, shown: true });
    b.ledger.push({ family, id: right, layer, shown: true });
    if (family === 'movers') {
      a.movers.push({ id: left, count: 10, capacity: 8192 });
      b.movers.push({ id: right, count: 10, capacity: 8192 });
    }
  }
  assert.deepEqual(compareColdStart(a, b, options).differences, []);
  assert.equal(
    a.ledger[1].id,
    'weather-4',
    'raw samples retain allocation IDs',
  );
  b.ledger.find((row) => row.id === 'weather-1').shown = false;
  b.ledger = b.ledger.filter((row) => row.id !== 'bhote-koshi-imagery-1-right');
  b.movers.at(-1).count--;
  const differences = compareColdStart(a, b, options).differences;
  assert.deepEqual(differences.map(({ field }) => field).sort(), [
    'count',
    'present',
    'shown',
  ]);
  assert.ok(differences.every(({ layer }) => layer !== '[page]'));
  a.ledger.push({
    family: 'lines',
    id: 'satellites-orbit-7',
    layer: 'satellites',
    shown: false,
  });
  assert.equal(
    compareColdStart(a, b, options).differences.filter(
      ({ family }) => family === 'lines',
    ).length,
    1,
  );
  assert.equal(
    normalizeAllocations(a).ledger.filter(({ family }) => family === 'lines')
      .length,
    2,
  );
});

test('asynchronously created CCTV lines are attributed even when absent at enable', async () => {
  const engine = createFakeEngine();
  engine.lines.createLine({
    id: 'cctv-camera-ray-tl',
    widthPx: 1,
    color: [1, 1, 1, 1],
  });
  const context = vm.createContext({
    window: {
      __godsEyeView: {
        engine,
        dataManager: { layers: new Map([['cctv', { module: {} }]]) },
      },
    },
  });
  const page = {
    evaluate: async (code) =>
      vm.runInContext(typeof code === 'string' ? code : `(${code})()`, context),
  };
  const capture = await probeSnapshot(page, ['cctv']);
  assert.equal(capture.ledger[0].layer, 'cctv');
  engine.destroy();
});

test('readiness waits for fixture publications, LOD and the locator reveal', () => {
  const engine = createFakeEngine();
  const dataManager = { layers: new Map() };
  const context = vm.createContext({
    window: { __godsEyeView: { engine, dataManager } },
  });
  const ready = (id) =>
    vm.runInContext(`(${coldStartReady})([${JSON.stringify(id)}])`, context);
  const entry = (id, extra = {}) =>
    dataManager.layers.set(id, {
      enabled: true,
      initialized: true,
      module: { getStats: () => ({ count: 10 }), ...extra },
    });
  entry('local-dams', { getLodDiagnostics: () => ({ computed: false }) });
  assert.equal(ready('local-dams'), false);
  dataManager.layers.get('local-dams').module.getLodDiagnostics = () => ({
    computed: true,
  });
  assert.equal(ready('local-dams'), true);
  entry('wildlife-sightings');
  const animals = engine.movers.createSet({
    id: 'wildlife-sightings',
    kind: 'point',
    capacity: 4,
    point: { sizePx: 4 },
  });
  animals.setCount(3);
  assert.equal(ready('wildlife-sightings'), false);
  animals.setCount(4);
  const density = engine.movers.createSet({
    id: 'wildlife-sightings-density',
    kind: 'point',
    capacity: 3,
    point: { sizePx: 4 },
  });
  density.setCount(3);
  assert.equal(ready('wildlife-sightings'), true);
  entry('bhote-koshi-locator');
  const halo = engine.movers.createSet({
    id: 'bhote-koshi-locator-bhote-koshi-incident-halo',
    kind: 'point',
    capacity: 1,
    point: { sizePx: 4 },
  });
  assert.equal(ready('bhote-koshi-locator'), false);
  halo.setCount(1);
  assert.equal(ready('bhote-koshi-locator'), true);
  entry('transit');
  const bus = engine.movers.createSet({
    id: 'transit-1',
    kind: 'point',
    capacity: 1,
    point: { sizePx: 4 },
  });
  bus.set(0, { show: false });
  bus.setCount(1);
  assert.equal(ready('transit'), false);
  bus.set(0, { show: true });
  assert.equal(ready('transit'), true);
  engine.destroy();
});
