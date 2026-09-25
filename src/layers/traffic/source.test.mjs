import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { tilesForBounds, tileToBBox } from '../../data/tomtomTiles.js';
import { decodeFlowTile } from './flowDecode.js';
import { decodeOpenFreeMapTile } from '../../sources/openFreeMap.js';
import {
  RoadRequestError,
  roadRequestError,
  trafficDetailBounds,
  createTrafficSource,
} from './source.js';
import { clampBoundsAroundCenter } from '../../data/trafficBounds.js';
const bounds = { south: 30.267, west: -97.744, north: 30.268, east: -97.743 };
const fixture = readFileSync(
  new URL(
    '../../data/fixtures/tomtom-flow-austin-12-935-1686.pbf',
    import.meta.url,
  ),
);
test('flow caches and diagnostics belong to their constructed source', async () => {
  let requestsA = 0,
    requestsB = 0;
  const a = createTrafficSource({
    fetchImpl: async () => {
      requestsA++;
      return new Response(fixture);
    },
  });
  const b = createTrafficSource({
    fetchImpl: async () => {
      requestsB++;
      return new Response(fixture);
    },
  });
  const first = await a.fetchFlowForBounds(bounds);
  assert.ok(first.length > 0);
  await a.fetchFlowForBounds(bounds);
  assert.equal(requestsA, 1);
  assert.equal(b.getFlowSessionStats().tilesFetched, 0);
  b.resetFlowTileCache();
  await a.fetchFlowForBounds(bounds);
  assert.equal(requestsA, 1);
  await b.fetchFlowForBounds(bounds);
  assert.equal(requestsB, 1);
});
test('a cancelled flow body cannot refill its source cache', async () => {
  const controller = new AbortController();
  let calls = 0;
  const source = createTrafficSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => {
        calls++;
        if (calls === 1) controller.abort();
        return fixture;
      },
    }),
  });
  await assert.rejects(
    source.fetchFlowForBounds(bounds, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  await source.fetchFlowForBounds(bounds);
  assert.equal(
    calls,
    2,
    'cancelled bytes were not admitted to the decode cache',
  );
});
test('road requests validate bounds and select z12/z14 immutable tile passes', async () => {
  const calls = [];
  const source = createTrafficSource({
    mapTiles: {
      async fetchBounds(box, options) {
        calls.push({ box, ...options });
        return { tiles: [{ roads: [] }], partial: false };
      },
      clear() {},
    },
  });
  await assert.rejects(
    source.requestRoads({ ...bounds, north: Infinity }),
    /bounded road viewport/,
  );
  assert.equal(calls.length, 0);
  await source.requestRoads(bounds, { majorOnly: true });
  await source.requestRoads(bounds);
  assert.deepEqual(
    calls.map((c) => c.zoom),
    [12, 14],
  );
  for (const centerLon of [179.99, -179.99]) {
    const clamped = clampBoundsAroundCenter(
      { south: -0.02, north: 0.02, west: 179.98, east: -179.98 },
      { lat: 0, lon: centerLon },
    );
    await source.requestRoads(clamped);
  }
  assert.equal(calls.length, 4);
});
test('malformed availability is an unavailable source rather than a keyless response', async () => {
  const source = createTrafficSource({
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(source.getStatus(), /Malformed traffic status/);
});

test('traffic construction is inert and parameters belong to each layer', async () => {
  const { createTrafficLayer } = await import('./index.js');
  const source = createTrafficSource({
    fetchImpl: () => assert.fail('construction fetched data'),
  });
  const services = { credits: {}, render: {} };
  const a = createTrafficLayer({ services, source });
  const b = createTrafficLayer({ services, source });
  a.setParams({ densityScale: 2, speedScale: 3, uncoveredRoads: 'hide' });
  assert.equal(a.getParams().densityScale, 2);
  assert.equal(b.getParams().densityScale, 1);
  assert.equal(b.getParams().speedScale, 1);
  assert.equal(b.getParams().uncoveredRoads, 'sim');
});

test('road tile replies respect cancellation even when the tile source ignores it', async () => {
  const abort = new AbortController();
  const source = createTrafficSource({
    mapTiles: {
      async fetchBounds() {
        abort.abort();
        return { tiles: [{ roads: [] }], partial: false };
      },
    },
  });
  await assert.rejects(source.requestRoads(bounds, { signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('keyed and keyless geometry is identical OpenFreeMap data, independent of TomTom failures', async () => {
  const tile = decodeOpenFreeMapTile(
    readFileSync(
      new URL(
        '../../data/fixtures/ofm-austin-14-3743-6745.pbf',
        import.meta.url,
      ),
    ),
    14,
    3743,
    6745,
  );
  const box = tileToBBox(14, 3743, 6745);
  const calls = [];
  const source = createTrafficSource({
    fetchImpl: async () => {
      throw new Error('HTTP 429');
    },
    mapTiles: {
      fetchBounds: async (_, options) => {
        calls.push(options.zoom);
        return { tiles: [tile], partial: false };
      },
    },
  });
  const keyed = await (await source.requestRoads(box, { live: true })).json();
  const keyless = await (
    await source.requestRoads(box, { live: false })
  ).json();
  assert.deepEqual(keyed, keyless);
  assert.equal(keyed.roadSource, 'OpenStreetMap');
  assert.ok(keyed.roads.length > 0);
  assert.ok(keyed.roads.every((road) => !road.flow));
  assert.deepEqual(calls, [14, 14]);
  await assert.rejects(source.fetchFlowForBounds(bounds), /HTTP 429/);
  assert.deepEqual(await (await source.requestRoads(box)).json(), keyless);
});

test('traffic status is session-cached after settlement, but cancelled discovery can restart', async () => {
  const { createFlow } = await import('./flow.js');
  let calls = 0;
  const state = {};
  const flow = createFlow({
    state,
    services: { credits: { registerDynamicCredit() {} } },
    parts: {},
    source: {
      async getStatus({ signal }) {
        calls++;
        signal?.throwIfAborted();
        return { hasKey: false };
      },
    },
  });
  const first = new AbortController();
  await flow.ensureFlowStatus(first.signal);
  first.abort();
  await flow.ensureFlowStatus(new AbortController().signal);
  assert.equal(calls, 1);
  const retryState = {};
  const retryFlow = createFlow({
    state: retryState,
    services: { credits: {} },
    parts: {},
    source: {
      async getStatus({ signal }) {
        calls++;
        signal.throwIfAborted();
        return { hasKey: false };
      },
    },
  });
  await assert.rejects(retryFlow.ensureFlowStatus(first.signal), {
    name: 'AbortError',
  });
  await retryFlow.ensureFlowStatus(new AbortController().signal);
  assert.equal(calls, 3);
});

test('road parsing defers surface reads to the cancellable preparation pass', async () => {
  const { createModel } = await import('./model.js');
  let lookups = 0;
  const model = createModel({
    state: {
      _viewer: {
        scene: {
          sampleHeightSupported: true,
          sampleHeight() {
            assert.fail('offscreen 3D height probe on keyless globe');
          },
          globe: {
            show: true,
            getHeight() {
              lookups++;
              return 0;
            },
          },
        },
      },
    },
    services: {},
    parts: {},
    source: {},
  });
  const roads = model.parseRoads({
    roads: [
      {
        coordinates: [
          [-97.74, 30.27],
          [-97.741, 30.271],
        ],
        type: 'residential',
        oneway: 0,
      },
    ],
  });
  assert.equal(roads.length, 2);
  assert.deepEqual(
    roads.map((r) => r.oneway),
    [1, -1],
  );
  assert.equal(roads[0].waypoints.length, 2);
  assert.equal(lookups, 0);
});

test('parsed road cache evicts old views by byte budget and never retains partial snapshots', async () => {
  const { cacheRoadSnapshot } = await import('./ingestion.js');
  const entries = new Map();
  const entry = () => ({
    major: [
      {
        coords: [
          [1, 2],
          [3, 4],
        ],
      },
    ],
    full: null,
  });
  const first = entry();
  cacheRoadSnapshot(entries, 'old', first);
  cacheRoadSnapshot(entries, 'new', entry(), {
    maxBytes: first.cacheBytes + 1,
  });
  assert.deepEqual([...entries.keys()], ['new']);
  cacheRoadSnapshot(entries, 'new', entry(), { retain: false });
  assert.equal(entries.size, 0);
  cacheRoadSnapshot(entries, 'oversized', entry(), { maxBytes: 1 });
  assert.equal(entries.size, 0);
});

for (const lat of [51.5, 60])
  test(`z14 detail at ${lat} stays centered within the sixteen-tile cap`, async () => {
    const box = {
      south: lat - 0.025,
      north: lat + 0.025,
      west: -0.155,
      east: -0.105,
    };
    assert.ok(tilesForBounds(box, 14).length > 16);
    const detail = trafficDetailBounds(box);
    assert.ok(tilesForBounds(detail, 14).length <= 16);
    assert.ok(Math.abs((detail.south + detail.north) / 2 - lat) < 1e-10);
    const source = createTrafficSource({
      mapTiles: { fetchBounds: async () => ({ tiles: [], partial: false }) },
    });
    const data = await (await source.requestRoads(box)).json();
    assert.equal(data.detailLimited, true);
    assert.deepEqual(data.detailBounds, detail);
  });
test('TomTom buffers are clipped before caching and preserve direction and flow attributes', async () => {
  const core = tileToBBox(12, 935, 1686);
  const source = createTrafficSource({
    fetchImpl: async () => new Response(fixture),
  });
  const result = await source.fetchFlowForBounds({
    ...core,
    east: core.east - 1e-9,
    south: core.south + 1e-9,
  });
  const decoded = decodeFlowTile(fixture, 12, 935, 1686);
  assert.ok(
    decoded.some((r) =>
      r.coords.some(
        ([x, y]) =>
          x < core.west || x > core.east || y < core.south || y > core.north,
      ),
    ),
  );
  assert.ok(
    result.every((r) =>
      r.coords.every(
        ([x, y]) =>
          x >= core.west - 1e-10 &&
          x <= core.east + 1e-10 &&
          y >= core.south - 1e-10 &&
          y <= core.north + 1e-10,
      ),
    ),
  );
  assert.ok(result.some((r) => r.closure));
});

test('a failed detail pass keeps major roads and exposes separate degraded status', async () => {
  const { createIngestion } = await import('./ingestion.js');
  const state = {
    _loadGeneration: 0,
    _tileCache: new Map(),
    _enabled: true,
    _parseRoads: (data) => data.roads,
  };
  let paints = 0;
  const ingestion = createIngestion({
    state,
    services: {},
    parts: {
      viewport: {
        clampBounds: (b) => b,
        getBoundsCenter: (b) => ({
          lat: (b.north + b.south) / 2,
          lon: (b.east + b.west) / 2,
        }),
      },
      flow: {
        warmFlow: async () => {},
        applyFlowThenRender: async () => {
          paints++;
          return true;
        },
      },
    },
    source: {
      requestRoads: async (_, opts) => {
        if (!opts.majorOnly) throw new Error('tile request failed');
        return {
          ok: true,
          json: async () => ({
            roads: [],
            roadSource: 'OpenStreetMap tiles',
            partial: false,
          }),
        };
      },
    },
  });
  await ingestion.loadRoadsForBounds(bounds, 350);
  assert.equal(paints, 1);
  assert.equal(state._roadError, null);
  assert.equal(
    state._detailError,
    'Detailed roads unavailable — OpenFreeMap tiles unavailable',
  );
  assert.equal(state._roadPartial, true);
  assert.equal(state._fetching, false);
});

const ofmDetail = decodeOpenFreeMapTile(
  readFileSync(
    new URL('../../data/fixtures/ofm-austin-14-3743-6745.pbf', import.meta.url),
  ),
  14,
  3743,
  6745,
);

async function matchingContext(fetchFlowForBounds) {
  const { createState } = await import('./state.js');
  const { createModel } = await import('./model.js');
  const { createFlow } = await import('./flow.js');
  const { createControls } = await import('./controls.js');
  const state = createState({ services: {} });
  Object.assign(state, {
    _liveMode: true,
    _enabled: true,
    _flowStatusPromise: Promise.resolve(),
  });
  const source = {
    fetchFlowForBounds,
    getFlowSessionStats: () => ({ tilesFetched: 1 }),
  };
  const parts = {
    style: {
      presetProfileActive: () => false,
      jamDensityOn: () => false,
      baseDotSize: () => 2,
      activeSizeDelta: () => 0,
    },
    rendering: {
      rebuildHeatLines() {},
      visibleRoadsForAltitude: (roads) => roads,
    },
  };
  const context = { state, source, parts, services: { credits: {} } };
  parts.model = createModel(context);
  return {
    state,
    model: parts.model,
    flow: createFlow(context),
    controls: createControls(context).methods,
  };
}

test('Austin TomTom fixture matches congestion onto OFM detail roads without changing geometry', async () => {
  const source = createTrafficSource({
    fetchImpl: async () => new Response(fixture),
  });
  const context = await matchingContext(source.fetchFlowForBounds);
  const roads = context.model.parseRoads({ roads: ofmDetail.roads });
  const coordinates = structuredClone(roads.map((r) => r.coords));
  await context.flow.applyFlowToRoads(roads, tileToBBox(14, 3743, 6745), 0);
  const matched = roads.filter((r) => r.flow);
  assert.ok(matched.length > 0);
  assert.ok(roads.length >= 94);
  assert.ok(roads.every((r) => [1, -1].includes(r.oneway)));
  assert.ok(matched.some((r) => r.flow.level < 0.8 && r.flow.level > 0));
  assert.deepEqual(
    roads.map((r) => r.coords),
    coordinates,
    'flow never substitutes its own polylines',
  );
  assert.equal(context.state._flowPending, 0);

  // Inject closure attributes on the same checked-in TomTom geometry: the
  // Austin detail snapshot has no real closures on its matched roads.
  const segments = await source.fetchFlowForBounds(tileToBBox(14, 3743, 6745));
  const closed = await matchingContext(async () =>
    segments.map((s) => ({ ...s, closure: true })),
  );
  await closed.flow.applyFlowToRoads(roads, bounds, 0);
  assert.equal(roads.filter((r) => r.flow?.closure).length, matched.length);
  assert.ok(
    roads
      .filter((r) => r.flow)
      .every((r) => closed.model.computeDotCount(r, 350) === 0),
  );
});

test('late closures hide and stop dots; coverage counts shown matched dots, and reopening restores them', async () => {
  const C = await import('cesium');
  const { state, model, controls } = await matchingContext(async () => []);
  const matched = { flow: { level: 1, closure: false }, type: 'primary' };
  const sim = { flow: null, type: 'residential' };
  const closed = { flow: { level: 0, closure: true }, type: 'primary' };
  state._roads = [matched, sim, closed];
  state._dots = [matched, matched, matched, sim, closed].map((road) => ({
    road,
    baseMps: 10,
    mps: 10,
    point: { show: true, color: C.Color.WHITE },
  }));
  model.recolorDotsInPlace('fixture');
  assert.equal(state._dots[4].point.show, false);
  assert.equal(state._dots[4].mps, 0);
  assert.equal(controls.getStats().count, 4);
  assert.equal(controls.getStats().flowCoveragePct, 75);
  assert.equal(
    state._dots[3].mps,
    10,
    'unmatched roads retain simulated speed',
  );
  assert.equal(state._dots[3].bucket, null);
  closed.flow = { level: 1, closure: false };
  model.recolorDotsInPlace('reopened');
  assert.equal(state._dots[4].point.show, true);
  assert.equal(state._dots[4].mps, 10);
  assert.equal(controls.getStats().count, 5);
  assert.equal(controls.getStats().flowCoveragePct, 80);
});

test('refresh failure removes cached matches and reports simulated flow', async () => {
  const { flow, state, model, controls } = await matchingContext(async () => {
    throw new Error('HTTP 429');
  });
  const roads = model.parseRoads({ roads: ofmDetail.roads });
  roads[0].flow = { level: 0.1, closure: true };
  await flow.applyFlowToRoads(roads, bounds, 0);
  assert.ok(roads.every((r) => r.flow === null));
  assert.equal(controls.getStats().flowCoveragePct, 0);
  assert.match(
    controls.getStats().loadingLabel,
    /SIMULATED — TomTom daily budget reached/,
  );
  assert.equal(state._flowPending, 0);
});

test('superseded flow cannot apply matches after a camera move or disable', async () => {
  let finish;
  const { flow, state, model } = await matchingContext(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const roads = model.parseRoads({ roads: ofmDetail.roads });
  const pending = flow.applyFlowToRoads(roads, bounds, 0);
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
  state._loadGeneration++;
  state._flowPending = 0;
  state._enabled = false;
  finish(decodeFlowTile(fixture, 12, 935, 1686));
  await pending;
  assert.ok(roads.every((r) => r.flow === null));
  assert.equal(state._flowPending, 0);
});

test('OSM keyed loads run z12 then z14 and reuse road snapshots while refreshing flow', async () => {
  const { createIngestion } = await import('./ingestion.js');
  const state = {
    _loadGeneration: 0,
    _tileCache: new Map(),
    _enabled: true,
    _liveMode: true,
    _roadMode: 'osm',
    _parseRoads: (data) => data.roads,
  };
  const passes = [],
    paints = [];
  const ingestion = createIngestion({
    state,
    services: {},
    parts: {
      viewport: {
        clampBounds: (b) => b,
        getBoundsCenter: () => ({ lat: 30.267, lon: -97.744 }),
      },
      flow: {
        warmFlow: async () => {},
        applyFlowThenRender: async (roads) => {
          paints.push(roads);
          return true;
        },
      },
    },
    source: {
      requestRoads: async (_, options) => {
        passes.push(options.majorOnly);
        return {
          ok: true,
          json: async () => ({
            roads: ofmDetail.roads,
            roadSource: 'OpenStreetMap',
          }),
        };
      },
    },
  });
  await ingestion.loadRoadsForBounds(bounds, 350);
  assert.deepEqual(passes, [true, false]);
  await ingestion.loadRoadsForBounds(bounds, 350);
  assert.deepEqual(
    passes,
    [true, false],
    'repeat view does not fetch road geometry',
  );
  assert.equal(
    paints.length,
    3,
    'cached roads still pass through flow refresh',
  );
});

test('an OpenFreeMap refusal is named by status, and keeps the status beside the words', () => {
  assert.equal(roadRequestError(429).message, 'OpenFreeMap tiles rate-limited');
  assert.equal(roadRequestError(504).message, 'OpenFreeMap tiles timed out');
  assert.equal(
    roadRequestError(406).message,
    'OpenFreeMap tiles unavailable (HTTP 406)',
  );
  assert.equal(
    roadRequestError(500).message,
    'OpenFreeMap tiles unavailable (HTTP 500)',
  );

  assert.equal(
    roadRequestError(502).message,
    'OpenFreeMap tiles unavailable (HTTP 502)',
  );
  assert.equal(
    roadRequestError(503).message,
    'OpenFreeMap tiles unavailable (HTTP 503)',
  );
  assert.equal(roadRequestError(503).status, 503);

  for (const missing of [undefined, null, NaN, 'four-oh-six']) {
    const vague = roadRequestError(missing);
    assert.equal(vague.message, 'OpenFreeMap tiles unavailable');
    assert.equal(vague.status, null, 'an unreadable code is absent, not zero');
  }

  const refused = roadRequestError(406);
  assert.ok(refused instanceof RoadRequestError);
  assert.ok(refused instanceof Error);
  assert.equal(refused.name, 'RoadRequestError');
  assert.equal(
    refused.status,
    406,
    'a caller must be able to branch on the code without parsing English',
  );
});

for (const phase of ['metadata', 'tile']) {
  for (const failure of [406, 429, 503, 504, 'network', 'timeout']) {
    test(`OpenFreeMap ${phase} ${failure} retains its reason through the road source`, async () => {
      const source = createTrafficSource({
        fetchImpl: async (url) => {
          if (phase === 'tile' && url.endsWith('/planet'))
            return Response.json({
              tiles: ['https://tiles.openfreemap.org/test/{z}/{x}/{y}.pbf'],
            });
          if (failure === 'network') throw new TypeError('Failed to fetch');
          if (failure === 'timeout')
            throw new DOMException('deadline', 'TimeoutError');
          return new Response('', { status: failure });
        },
      });
      await assert.rejects(source.requestRoads(bounds), (error) => {
        assert.ok(error instanceof RoadRequestError);
        assert.equal(
          error.status,
          typeof failure === 'number' ? failure : null,
        );
        assert.equal(
          error.message,
          roadRequestError(
            error.status,
            failure === 'timeout' ? { name: 'TimeoutError' } : undefined,
          ).message,
        );
        assert.equal(error.retryable, true);
        return true;
      });
    });
  }
}

test('permanent metadata failures remain non-retryable through the road error wrapper', async () => {
  const source = createTrafficSource({
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(source.requestRoads(bounds), (error) => {
    assert.ok(error instanceof RoadRequestError);
    assert.equal(error.retryable, false);
    assert.equal(error.status, null);
    return true;
  });
});
