import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flowSegmentsToRoads,
  resolveRoadMode,
  selectTrafficRoads,
} from './roadModes.js';
import { createTrafficSource } from './source.js';
import { createTrafficLayer } from './index.js';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
  serializeStoredLayerState,
  parseStoredLayerState,
} from '../../data/layerState.js';

const coordinates = [
  [-97.744, 30.267],
  [-97.742, 30.267],
];
const main = { coordinates, type: 'primary', oneway: 1 };
const side = {
  coordinates: [
    [-97.743, 30.267],
    [-97.743, 30.269],
  ],
  type: 'residential',
  oneway: 1,
};
const flow = {
  coords: coordinates,
  trafficLevel: 0.3,
  closure: false,
  roadType: 'Major road',
};
const box = { west: -97.75, east: -97.74, south: 30.26, north: 30.27 };

test('road modes have key-aware defaults, explicit overrides and keyless fallback', () => {
  assert.equal(resolveRoadMode(null, true), 'hybrid');
  assert.equal(resolveRoadMode(null, false), 'osm');
  assert.equal(resolveRoadMode('invalid', true), 'hybrid');
  for (const mode of ['tomtom', 'osm', 'hybrid']) {
    assert.equal(resolveRoadMode(mode, true), mode);
    assert.equal(resolveRoadMode(mode, false), 'osm');
  }
});
test('Hybrid keeps TomTom and the unmatched OSM side street, with simulated fill', () => {
  const roads = selectTrafficRoads([main, side], [flow], 'hybrid');
  assert.equal(roads.length, 2);
  assert.equal(roads[0].directFlow, true);
  assert.equal(roads[0].flow.level, 0.3);
  assert.equal(roads[1].simulatedOnly, true);
  assert.deepEqual(roads[1].coordinates, side.coordinates);
  assert.equal(selectTrafficRoads([main, side], [flow], 'tomtom').length, 1);
  assert.deepEqual(selectTrafficRoads([main, side], [flow], 'osm'), [
    main,
    side,
  ]);
});
test('opposite-direction carriageways and the reverse half of two-way roads survive', () => {
  for (const reverse of [
    { ...main, oneway: -1 },
    { ...main, coordinates: [...coordinates].reverse() },
  ]) {
    assert.equal(selectTrafficRoads([reverse], [flow], 'hybrid').length, 2);
  }
  const twoWay = selectTrafficRoads([{ ...main, oneway: 0 }], [flow], 'hybrid');
  assert.equal(twoWay.length, 2);
  assert.equal(twoWay[1].oneway, -1);
  assert.equal(twoWay[1].densityWeight, 0.5);
});
test('uncertain flow values still dedupe OSM; every TomTom road and closure survives', () => {
  const closed = { ...flow, trafficLevel: 0, closure: true };
  const roads = selectTrafficRoads([main], [flow, closed], 'hybrid');
  assert.equal(roads.length, 2);
  assert.ok(roads.every((road) => road.directFlow));
  assert.equal(roads[1].flow.closure, true);
});
test('a partly covered OSM road keeps only its uncovered stretch', () => {
  // 0.004° of longitude at 30.267° N is about 385 m; TomTom covers the west half.
  const long = {
    coordinates: [
      [-97.744, 30.267],
      [-97.74, 30.267],
    ],
    type: 'primary',
    oneway: 1,
  };
  const roads = selectTrafficRoads([long], [flow], 'hybrid');
  assert.equal(roads.length, 2);
  const [piece] = roads.slice(1);
  assert.equal(piece.simulatedOnly, true);
  // The kept stretch starts within one 35 m match radius of the TomTom end.
  assert.ok(piece.coordinates[0][0] > -97.742);
  assert.ok(piece.coordinates[0][0] < -97.741);
  assert.deepEqual(piece.coordinates.at(-1), [-97.74, 30.267]);
});
test('an uncovered sliver shorter than 40 m is dropped with its duplicate', () => {
  // About 67 m past the TomTom end: the last ~32 m is beyond the 35 m radius.
  const sliver = {
    coordinates: [
      [-97.744, 30.267],
      [-97.7413, 30.267],
    ],
    type: 'primary',
    oneway: 1,
  };
  assert.equal(selectTrafficRoads([sliver], [flow], 'hybrid').length, 1);
});
test('a full-coverage TomTom line is two-way and covers both OSM directions', () => {
  const both = { ...flow, coverage: 'full' };
  assert.equal(flowSegmentsToRoads([both])[0].oneway, 0);
  assert.equal(flowSegmentsToRoads([flow])[0].oneway, 1);
  const roads = selectTrafficRoads([{ ...main, oneway: 0 }], [both], 'hybrid');
  assert.equal(roads.length, 1);
  assert.equal(roads[0].directFlow, true);
});
test('bearing and distance reject nearby crossing and separate OSM roads', () => {
  const parallel = {
    ...main,
    coordinates: coordinates.map(([lon, lat]) => [lon, lat + 0.001]),
  };
  assert.equal(
    selectTrafficRoads([side, parallel], [flow], 'hybrid').length,
    3,
  );
});
function sourceFixture() {
  let requests = 0;
  const source = createTrafficSource({
    mapTiles: {
      async fetchBounds(bounds, { onTile }) {
        requests++;
        const tile = { roads: [main, side] };
        onTile?.(tile);
        return { tiles: [tile], partial: false };
      },
      clear() {},
    },
  });
  return { source, requests: () => requests };
}
test('TomTom-only skips OSM requests; keyless selection requests OSM and labels fallback', async () => {
  for (const hasKey of [true, false]) {
    const f = sourceFixture();
    const data = await (
      await f.source.requestRoads(box, {
        roadMode: 'tomtom',
        flowSnapshot: Promise.resolve({
          hasKey,
          segments: hasKey ? [flow] : [],
        }),
      })
    ).json();
    assert.equal(data.roadSource, hasKey ? 'TomTom' : 'OpenStreetMap');
    assert.equal(f.requests(), hasKey ? 0 : 1);
    assert.equal(data.roads.length, hasKey ? 1 : 2);
  }
});
test('Hybrid streams OSM before flow settles then replaces duplicates with TomTom', async () => {
  const f = sourceFixture();
  let resolve;
  const snapshots = [];
  const pending = f.source.requestRoads(box, {
    roadMode: 'hybrid',
    flowSnapshot: new Promise((done) => {
      resolve = done;
    }),
    onTile: (data) => snapshots.push(data),
  });
  await Promise.resolve();
  assert.equal(snapshots[0].roadSource, 'OpenStreetMap');
  assert.equal(snapshots[0].roads.length, 2);
  resolve({ hasKey: true, segments: [flow] });
  const final = await (await pending).json();
  assert.equal(final.roadSource, 'TomTom + OpenStreetMap');
  assert.equal(final.roads.length, 2);
  assert.ok(snapshots.at(-1).replace);
});
test('road-source params persist in existing layer-state lo field and local storage', () => {
  for (const mode of ['tomtom', 'osm', 'hybrid']) {
    const state = createDefaultLayerState();
    state.enabledLayerIds = ['traffic'];
    state.options.traffic.roadMode = mode;
    const params = new URLSearchParams('v=2');
    encodeLayerStateParams(params, state);
    assert.deepEqual([...params.keys()].sort(), ['l', 'lo', 'v']);
    assert.equal(decodeLayerStateParams(params).options.traffic.roadMode, mode);
    assert.equal(
      parseStoredLayerState(serializeStoredLayerState(state)).options.traffic
        .roadMode,
      mode,
    );
  }
});
test('row chips use real params; query overrides passive restore and user can change it', () => {
  const oldLocation = globalThis.location;
  globalThis.location = { search: '?trafficRoads=tomtom' };
  try {
    const layer = createTrafficLayer({
      services: { credits: {}, render: {} },
      source: {
        requestRoads() {},
        getStatus() {},
        fetchFlowForBounds() {},
        getFlowSessionStats: () => ({}),
        resetFlowTileCache() {},
      },
    });
    layer.setParams({ roadMode: 'osm' }, { origin: 'local-restore' });
    assert.equal(layer.getParams().roadMode, 'tomtom');
    const chips = layer.getRowControls().chips;
    assert.equal(chips.length, 3);
    assert.equal(chips[0].active, true);
    layer.setParams(chips[2].params, { origin: 'user' });
    assert.equal(layer.getParams().roadMode, 'hybrid');
    assert.match(layer.getStats().loadingLabel, /Hybrid needs a TomTom key/);
    assert.equal(layer.getStats().roadMode, 'osm');
  } finally {
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
  }
});

test('Hybrid retains TomTom on OSM outage with a named warning; TomTom failure never invents roads', async () => {
  const source = createTrafficSource({
    mapTiles: {
      fetchBounds: async () => {
        throw Object.assign(new Error('refused'), { status: 429 });
      },
    },
  });
  const data = await (
    await source.requestRoads(box, {
      roadMode: 'hybrid',
      flowSnapshot: Promise.resolve({ hasKey: true, segments: [flow] }),
    })
  ).json();
  assert.equal(data.roads.length, 1);
  assert.equal(data.roads[0].directFlow, true);
  assert.equal(data.partial, true);
  assert.equal(data.roadWarning, 'OpenFreeMap tiles rate-limited');
  await assert.rejects(
    source.requestRoads(box, {
      roadMode: 'tomtom',
      flowSnapshot: Promise.resolve({
        hasKey: true,
        segments: [],
        error: 'TomTom daily budget reached',
      }),
    }),
    /TomTom daily budget reached/,
  );
});

test('flow application preserves direct values and leaves Hybrid fill simulated', async () => {
  const { createFlow } = await import('./flow.js');
  const direct = {
    coords: coordinates,
    directFlow: true,
    flow: { level: 0.15, closure: true },
  };
  const fill = { coords: coordinates, simulatedOnly: true };
  const osm = { coords: coordinates };
  const state = {
    _enabled: true,
    _liveMode: true,
    _loadGeneration: 1,
    _flowPending: 0,
    _flowStatusPromise: Promise.resolve(),
  };
  const controller = createFlow({
    state,
    services: { credits: {} },
    parts: {},
    source: { fetchFlowForBounds: async () => [flow] },
  });
  await controller.applyFlowToRoads([direct, fill, osm], box, 1);
  assert.deepEqual(direct.flow, { level: 0.15, closure: true });
  assert.equal(fill.flow, null);
  assert.deepEqual(osm.flow, { level: 0.3, closure: false });
  assert.equal(state._flowPending, 0);
});

test('status names the drawn road source for each mode', async () => {
  const { createModel } = await import('./model.js');
  const { trafficFeedPresentation: present } = createModel({
    state: {},
    services: {},
    parts: {},
    source: {},
  });
  assert.equal(
    present({ liveMode: true, coveragePct: 100, roadSource: 'TomTom' })
      .loadingLabel,
    'LIVE · Roads: TomTom · Roads without flow hidden',
  );
  assert.equal(
    present({ liveMode: true, coveragePct: 0, roadSource: 'TomTom' })
      .loadingLabel,
    'LIVE · Roads: TomTom · No flow roads in view',
  );
  assert.equal(
    present({
      liveMode: true,
      coveragePct: 81,
      roadSource: 'TomTom + OpenStreetMap',
    }).loadingLabel,
    'LIVE · Roads: TomTom + OpenStreetMap · Flow 81%',
  );
  assert.match(
    present({ liveMode: true, coveragePct: 74 }).loadingLabel,
    /^LIVE · Roads: OpenStreetMap · Flow: TomTom · 74% cov/,
  );
});

test('only explicit origins clear the query override; restores keep it', () => {
  const oldLocation = globalThis.location;
  globalThis.location = { search: '?trafficRoads=osm' };
  try {
    const layer = createTrafficLayer({
      services: { credits: {}, render: {} },
      source: {
        requestRoads() {},
        getStatus() {},
        fetchFlowForBounds() {},
        getFlowSessionStats: () => ({}),
        resetFlowTileCache() {},
      },
    });
    for (const origin of ['share-restore', 'local-restore', 'programmatic']) {
      layer.setParams({ roadMode: 'tomtom' }, { origin });
      assert.equal(layer.getParams().roadMode, 'osm', origin);
    }
    layer.setParams({ roadMode: 'tomtom' }, { origin: 'voice' });
    assert.equal(layer.getParams().roadMode, 'tomtom');
    layer.setParams({ roadMode: null }, { origin: 'local-restore' });
    assert.equal(layer.getParams().roadMode, null);
  } finally {
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
  }
});

test('TomTom and Hybrid loads skip the OSM snapshot cache; TomTom skips the detail pass', async () => {
  const { createIngestion } = await import('./ingestion.js');
  for (const [roadMode, roadSource, perLoad] of [
    [null, 'TomTom + OpenStreetMap', [true, false]],
    ['tomtom', 'TomTom', [true]],
  ]) {
    const state = {
      _loadGeneration: 0,
      _tileCache: new Map(),
      _enabled: true,
      _liveMode: true,
      _roadMode: roadMode,
      _parseRoads: (data) => data.roads,
    };
    const passes = [];
    const ingestion = createIngestion({
      state,
      services: {},
      parts: {
        viewport: {
          clampBounds: (b) => b,
          getBoundsCenter: () => ({ lat: 30.267, lon: -97.744 }),
        },
        flow: {
          warmFlow: async () => [flow],
          applyFlowThenRender: async () => true,
        },
      },
      source: {
        requestRoads: async (_, options) => {
          passes.push(options.majorOnly);
          assert.equal(options.roadMode, roadMode);
          assert.equal((await options.flowSnapshot).hasKey, true);
          return {
            ok: true,
            json: async () => ({ roads: [main], roadSource }),
          };
        },
      },
    });
    await ingestion.loadRoadsForBounds(box, 350);
    await ingestion.loadRoadsForBounds(box, 350);
    assert.deepEqual(passes, [...perLoad, ...perLoad], roadSource);
    assert.equal(state._tileCache.size, 0);
    assert.equal(state._roadSource, roadSource);
  }
});

test('a first keyed load whose flow fails never caches simulated fill as OSM roads', async () => {
  const { createIngestion } = await import('./ingestion.js');
  // Status unknown at the start of the first load; the probe then reports a
  // key but flow fails, so Hybrid draws only simulated OpenStreetMap fill,
  // labelled OpenStreetMap.
  const state = {
    _loadGeneration: 0,
    _tileCache: new Map(),
    _enabled: true,
    _liveMode: false,
    _roadMode: null,
    _parseRoads: (data) => data.roads,
  };
  const requests = [];
  const ingestion = createIngestion({
    state,
    services: {},
    parts: {
      viewport: {
        clampBounds: (b) => b,
        getBoundsCenter: () => ({ lat: 30.267, lon: -97.744 }),
      },
      flow: {
        warmFlow: async () => {
          state._liveMode = true;
          state._flowStatusKnown = true;
          throw Object.assign(new Error('flow'), { status: 502 });
        },
        deriveTrafficFlowError: () => 'TomTom upstream unreachable',
        applyFlowThenRender: async () => true,
      },
    },
    source: {
      requestRoads: async (_, options) => {
        const live = await options.flowSnapshot;
        const mode = resolveRoadMode(options.roadMode, live.hasKey);
        requests.push(mode);
        const roads =
          mode === 'osm' ? [main] : [{ ...main, simulatedOnly: true }];
        return {
          ok: true,
          json: async () => ({
            roads,
            roadSource: 'OpenStreetMap',
            roadMode: mode,
          }),
        };
      },
    },
  });
  await ingestion.loadRoadsForBounds(box, 350);
  assert.deepEqual(requests, ['hybrid', 'hybrid']);
  assert.equal(state._tileCache.size, 0, 'Hybrid fill is never cached');
  // The user switches to OSM: fresh OpenStreetMap roads, not the fill.
  state._roadMode = 'osm';
  await ingestion.loadRoadsForBounds(box, 350);
  assert.deepEqual(requests.slice(2), ['osm', 'osm']);
  const [entry] = state._tileCache.values();
  assert.ok(entry.full.every((road) => !road.simulatedOnly));
  // ...and those plain OSM roads are what a revisit reuses.
  await ingestion.loadRoadsForBounds(box, 350);
  assert.equal(requests.length, 4);
});

test('a flow snapshot that misses the pass deadline cannot hold roads', async () => {
  const never = new Promise(() => {});
  const request = (roadMode, hasKey) =>
    sourceFixture().source.requestRoads(box, {
      roadMode,
      flowSnapshot: never,
      liveModeHint: () => hasKey,
      timeoutSec: 0.02,
    });
  const keyless = await (await request(null, false)).json();
  assert.equal(keyless.roadMode, 'osm');
  assert.equal(keyless.roads.length, 2);
  const hybrid = await (await request(null, true)).json();
  assert.equal(hybrid.roadMode, 'hybrid');
  assert.equal(hybrid.roadSource, 'OpenStreetMap');
  assert.ok(hybrid.roads.every((road) => road.simulatedOnly));
  await assert.rejects(request('tomtom', true), /TomTom flow timed out/);
});

test('frontage roads beside a TomTom motorway survive; same-class duplicates do not', () => {
  const offset = (road, metres, extra = {}) => ({
    ...road,
    ...extra,
    coordinates: road.coordinates.map(([lon, lat]) => [
      lon,
      lat + metres / 111320,
    ]),
  });
  const motorwayLine = { ...flow, roadType: 'Motorway' };
  const osmMotorway = { ...main, type: 'motorway' };
  const roads = selectTrafficRoads(
    [
      offset(osmMotorway, 4), // the same motorway: dropped
      offset(main, 25, { type: 'residential' }), // frontage, north side
      offset(main, -25, { type: 'tertiary' }), // frontage, south side
    ],
    [motorwayLine],
    'hybrid',
  );
  assert.equal(roads.length, 3);
  assert.equal(roads[0].directFlow, true);
  assert.deepEqual(
    roads.slice(1).map((road) => road.type),
    ['residential', 'tertiary'],
  );
  // A ramp beside the mainline compares as an ordinary road.
  assert.equal(
    selectTrafficRoads(
      [offset(osmMotorway, 25, { ramp: true })],
      [motorwayLine],
      'hybrid',
    ).length,
    2,
  );
  // Across a class mismatch a true duplicate (within 15 m) is still dropped.
  assert.equal(
    selectTrafficRoads(
      [offset(main, 6, { type: 'residential' })],
      [motorwayLine],
      'hybrid',
    ).length,
    1,
  );
  // Same class, uncertain 25 m overlap: the OpenStreetMap copy goes.
  assert.equal(
    selectTrafficRoads(
      [offset(main, 25, { type: 'residential' })],
      [{ ...flow, roadType: 'Local road' }],
      'hybrid',
    ).length,
    1,
  );
});
