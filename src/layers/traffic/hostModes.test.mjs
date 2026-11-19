// A host's road-source offer (createTrafficSource `roadModes`) and the
// Street Traffic Lines / Dots row toggles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRoadModes,
  resolveRoadMode,
  roadModesSimulate,
  TRAFFIC_ROAD_MODES,
} from './roadModes.js';
import { createTrafficSource } from './source.js';
import { createTrafficLayer } from './index.js';
import {
  createDefaultLayerState,
  decodeLayerStateParams,
  encodeLayerStateParams,
  parseStoredLayerState,
  serializeStoredLayerState,
} from '../../data/layerState.js';

const box = { west: -97.75, east: -97.74, south: 30.26, north: 30.27 };
const flow = {
  coords: [
    [-97.744, 30.267],
    [-97.742, 30.267],
  ],
  trafficLevel: 0.3,
  closure: false,
  roadType: 'Major road',
};

function tomtomOnlySource() {
  let requests = 0;
  const source = createTrafficSource({
    roadModes: ['tomtom'],
    mapTiles: {
      async fetchBounds() {
        requests++;
        return { tiles: [], partial: false };
      },
      async getMetadata() {
        requests++;
      },
      clear() {},
    },
  });
  return { source, requests: () => requests };
}

test('host road modes are a non-empty subset in canonical order', () => {
  assert.equal(normalizeRoadModes(undefined), TRAFFIC_ROAD_MODES);
  assert.deepEqual(normalizeRoadModes(['hybrid', 'tomtom']), [
    'tomtom',
    'hybrid',
  ]);
  assert.ok(Object.isFrozen(normalizeRoadModes(['tomtom'])));
  for (const bad of [[], ['bogus'], ['tomtom', 'tomtom'], 'tomtom', null])
    assert.throws(() => normalizeRoadModes(bad), TypeError, String(bad));
  assert.throws(() => createTrafficSource({ roadModes: [] }), TypeError);
  assert.equal(roadModesSimulate(), true);
  assert.equal(roadModesSimulate(['tomtom', 'hybrid']), false);
});

test('a TomTom-only host resolves every request to TomTom, keyed or not', () => {
  for (const value of [null, 'osm', 'hybrid', 'tomtom'])
    for (const hasKey of [true, false])
      assert.equal(resolveRoadMode(value, hasKey, ['tomtom']), 'tomtom');
  // Without Hybrid the default is the first offered mode.
  assert.equal(resolveRoadMode(null, true, ['tomtom', 'osm']), 'tomtom');
  assert.equal(resolveRoadMode(null, false, ['tomtom', 'osm']), 'osm');
});

test('a TomTom-only source draws TomTom roads and never requests OpenStreetMap', async () => {
  const f = tomtomOnlySource();
  assert.deepEqual(f.source.roadModes, ['tomtom']);
  for (const roadMode of [null, 'osm', 'hybrid']) {
    const data = await (
      await f.source.requestRoads(box, {
        roadMode,
        flowSnapshot: Promise.resolve({ hasKey: true, segments: [flow] }),
      })
    ).json();
    assert.equal(data.roadSource, 'TomTom', String(roadMode));
    assert.equal(data.roads.length, 1);
    assert.equal(data.roads[0].directFlow, true);
  }
  assert.equal(f.requests(), 0);
  await assert.rejects(f.source.requestRoads(box, {}), TypeError);
});

test('a TomTom-only source never simulates: keyless or unreachable loads fail with the reason', async () => {
  const f = tomtomOnlySource();
  const failure = (snapshot) =>
    f.source
      .requestRoads(box, { flowSnapshot: Promise.resolve(snapshot) })
      .then(
        () => assert.fail('a keyless load drew roads'),
        (error) => error,
      );
  const keyless = await failure({ hasKey: false, segments: [] });
  assert.equal(keyless.message, 'TomTom roads need a TomTom key');
  assert.equal(keyless.retryable, false);
  const unreachable = await failure({
    hasKey: false,
    segments: [],
    statusUnavailable: true,
  });
  assert.equal(
    unreachable.message,
    'TomTom roads unavailable while the traffic service is unreachable',
  );
  assert.equal(unreachable.retryable, true);
  const late = await failure({
    hasKey: false,
    segments: [],
    error: 'TomTom flow timed out',
  });
  assert.equal(late.message, 'TomTom flow timed out');
  assert.equal(f.requests(), 0);
});

test('a TomTom-only layer offers no road chips and ignores other road choices', () => {
  const oldLocation = globalThis.location;
  globalThis.location = { search: '?trafficRoads=osm' };
  try {
    const { source } = tomtomOnlySource();
    const layer = createTrafficLayer({
      services: { credits: {}, render: {} },
      source,
    });
    assert.equal(layer.getParams().roadMode, null);
    for (const origin of ['user', 'local-restore', 'share-restore'])
      layer.setParams({ roadMode: 'osm' }, { origin });
    assert.equal(layer.getParams().roadMode, null);
    assert.deepEqual(layer.getRowControls().chips, []);
    const stats = layer.getStats();
    assert.equal(stats.roadMode, 'tomtom');
    // No key verdict before the status probe settles.
    assert.doesNotMatch(stats.loadingLabel, /need a TomTom key/);
  } finally {
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
  }
});

test('Lines and Dots are boolean params that only appear as chips with live flow', () => {
  const layer = createTrafficLayer({
    services: { credits: {}, render: {} },
    source: tomtomOnlySource().source,
  });
  assert.equal(layer.getParams().lines, false);
  assert.equal(layer.getParams().dots, true);
  // Keyless (the status probe has not reported a key): nothing to color.
  assert.deepEqual(layer.getRowControls().chips, []);
  layer.setParams({ lines: true });
  assert.equal(layer.getParams().lines, true);
  layer.setParams({ lines: 'no', dots: 0 });
  assert.equal(layer.getParams().lines, true, 'non-boolean ignored');
  assert.equal(layer.getParams().dots, true, 'non-boolean ignored');
  layer.setParams({ lines: false, dots: false });
  assert.deepEqual(
    [layer.getParams().lines, layer.getParams().dots],
    [false, false],
  );
  assert.deepEqual(layer.getDetectableObjects(), []);
  // Hidden dots stay recoverable without live flow (restore, share link).
  assert.deepEqual(
    layer.getRowControls().chips.map((chip) => [chip.id, chip.title]),
    [['dots', 'Moving dots']],
  );
  layer.setParams(layer.getRowControls().chips[0].params, { origin: 'user' });
  assert.equal(layer.getParams().dots, true);
  assert.deepEqual(layer.getRowControls().chips, []);
});

test('live chips toggle each control without touching the other', async () => {
  const { createState } = await import('./state.js');
  const { createControls } = await import('./controls.js');
  const state = createState({
    services: {},
    source: { roadModes: ['tomtom'] },
  });
  state._liveMode = true;
  const controls = createControls({
    state,
    services: {},
    source: { getFlowSessionStats: () => ({}) },
    parts: {
      animation: { syncRenderDemand() {} },
      rendering: {},
    },
  }).methods;
  const chip = (id) =>
    controls.getRowControls().chips.find((entry) => entry.id === id);
  assert.deepEqual(
    controls.getRowControls().chips.map((entry) => entry.id),
    ['lines', 'dots'],
  );
  assert.equal(chip('lines').active, false);
  assert.equal(chip('dots').active, true);
  controls.setParams(chip('lines').params, { origin: 'user' });
  assert.equal(chip('lines').active, true);
  assert.equal(chip('dots').active, true);
  controls.setParams(chip('dots').params, { origin: 'user' });
  assert.equal(chip('dots').active, false);
  assert.equal(chip('lines').active, true);
  // Every mode keeps its road chips beside the toggles.
  const all = createState({ services: {}, source: {} });
  all._liveMode = true;
  assert.deepEqual(
    createControls({
      state: all,
      services: {},
      source: { getFlowSessionStats: () => ({}) },
      parts: {},
    })
      .methods.getRowControls()
      .chips.map((entry) => entry.id),
    ['roads-tomtom', 'roads-osm', 'roads-hybrid', 'lines', 'dots'],
  );
});

test('hiding dots hides the dots set of an enabled layer', async () => {
  const { createState } = await import('./state.js');
  const { createControls } = await import('./controls.js');
  const state = createState({ services: {}, source: {} });
  let demand = 0;
  state._enabled = true;
  state._dotSet = { show: true };
  const controls = createControls({
    state,
    services: {},
    source: { getFlowSessionStats: () => ({}) },
    parts: { animation: { syncRenderDemand: () => demand++ } },
  }).methods;
  controls.setParams({ dots: false });
  assert.equal(state._dotSet.show, false);
  controls.setParams({ dots: true });
  assert.equal(state._dotSet.show, true);
  assert.equal(demand, 2);
});

test('Lines and Dots persist in layer state and local storage', () => {
  const state = createDefaultLayerState();
  assert.equal(state.options.traffic.lines, false);
  assert.equal(state.options.traffic.dots, true);
  state.enabledLayerIds = ['traffic'];
  state.options.traffic.lines = true;
  state.options.traffic.dots = false;
  const params = new URLSearchParams('v=2');
  encodeLayerStateParams(params, state);
  const decoded = decodeLayerStateParams(params).options.traffic;
  assert.equal(decoded.lines, true);
  assert.equal(decoded.dots, false);
  const stored = parseStoredLayerState(serializeStoredLayerState(state)).options
    .traffic;
  assert.equal(stored.lines, true);
  assert.equal(stored.dots, false);
});

test('rebuilt lines replace the drawn ones in one set write', async () => {
  const { createRendering } = await import('./rendering.js');
  const writes = [];
  const road = (level) => ({
    flow: { level, closure: false },
    segmentDist: [10],
    waypoints: [
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
    ],
  });
  const state = {
    _viewer: {},
    _liveMode: true,
    _showLines: true,
    _heatLineCount: 0,
    _heatSet: {
      set: (items) => writes.push(['set', items]),
      clear: () => writes.push(['clear']),
    },
  };
  const parts = {
    style: { heatlineOn: () => true },
    animation: { syncRenderDemand() {} },
  };
  const rendering = createRendering({ state, services: {}, parts, source: {} });
  // The set swaps its lines atomically: no old line outlives a rebuild and
  // none is missing while the new geometry builds.
  rendering.rebuildHeatLines([road(0.1), road(0.9)]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'set');
  assert.equal(writes[0][1].length, 2);
  assert.ok(writes[0][1].every((item) => item.clampTo === 'both'));
  // Steady flow lines never pulse.
  assert.equal(rendering.heatPulsing(), false);
  // Leaving live roads takes the lines away.
  state._liveMode = false;
  rendering.rebuildHeatLines([road(0.1)]);
  assert.notEqual(writes.at(-1)[0], 'set');
});

test('steady lines hold no frames with dots hidden; pulsing jam lines hold them', async () => {
  const { createAnimation } = await import('./animation.js');
  const calls = [];
  let pulsing = false;
  const state = {
    _enabled: true,
    _dots: [{}],
    _showDots: false,
    _showLines: true,
    _motion: { rebuilds: 0 },
  };
  const animation = createAnimation({
    state,
    services: {
      render: {
        holdContinuousRender: () => calls.push('hold'),
        releaseContinuousRender: () => calls.push('release'),
      },
    },
    parts: { rendering: { heatPulsing: () => pulsing } },
  });
  animation.syncRenderDemand();
  assert.deepEqual(calls, []);
  pulsing = true;
  animation.syncRenderDemand();
  assert.deepEqual(calls, ['hold']);
  pulsing = false;
  animation.syncRenderDemand();
  assert.deepEqual(calls, ['hold', 'release']);
});
