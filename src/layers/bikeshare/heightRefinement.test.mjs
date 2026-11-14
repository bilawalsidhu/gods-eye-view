// Station ground heights. A city's stations are all drawn at once at the
// fallback height; their ground heights are found afterwards a few
// milliseconds at a time, so a city of hundreds of docks never holds the main
// thread for the length of hundreds of depth renders. Each case drives the
// real rendering part (and the real lifecycle where it tears down) over a
// scene whose height reads are counted and timed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createState } from './state.js';
import { createModel } from './model.js';
import { createRendering } from './rendering.js';
import { createLifecycle } from './lifecycle.js';
import { POINT_HEIGHT_OFFSET_M } from './policy.js';
import { createTerrainSurface } from '../../services/terrainSurface.js';

globalThis.document ??= {
  addEventListener() {},
  removeEventListener() {},
};

/** Milliseconds one fake depth render holds the thread. */
const SAMPLE_COST_MS = 1;
/** The ground under a point, as the fake scene and globe both report it. */
const groundAt = (lat, lon) => 100 + (lat - 42) * 1000 + (lon + 71) * 10;

function busyWait(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

/** `count` stations on a line through Boston. */
function stations(count, prefix = 's') {
  return {
    data: {
      stations: Array.from({ length: count }, (_, i) => ({
        station_id: `${prefix}${i}`,
        name: `Dock ${i}`,
        lat: 42.3 + i * 1e-4,
        lon: -71.1 + i * 1e-4,
        capacity: 10,
      })),
    },
  };
}

/**
 * The rendering part over a scene that counts its height reads.
 * @param {{terrainGlobe?: boolean, shared?: boolean, unloaded?: (lat: number) => boolean}} options
 *   `terrainGlobe`: the globe is showing (else photorealistic tiles hide it);
 *   `shared`: the application's terrain surface is supplied;
 *   `unloaded`: latitudes whose terrain tile is not drawn.
 */
function makeLayer({
  terrainGlobe = false,
  shared = false,
  unloaded = () => false,
} = {}) {
  const calls = { sampleHeight: 0, getHeight: 0, sharedHeight: 0, render: 0 };
  // sampleHeight calls in this turn of the event loop, and the most in any
  // turn so far. Two numbers, not a list: a slow run has a great many turns.
  let thisTurn = 0;
  let mostInATurn = 0;
  let ticking = true;
  const tick = () => {
    if (!ticking) return;
    thisTurn = 0;
    setImmediate(tick);
  };
  setImmediate(tick);

  const degrees = (carto) => [
    Cesium.Math.toDegrees(carto.latitude),
    Cesium.Math.toDegrees(carto.longitude),
  ];
  const viewer = {
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(-71, 42.3, 12000),
      changed: { addEventListener() {}, removeEventListener() {} },
    },
    scene: {
      sampleHeightSupported: true,
      sampleHeight(carto) {
        calls.sampleHeight += 1;
        thisTurn += 1;
        if (thisTurn > mostInATurn) mostInATurn = thisTurn;
        busyWait(SAMPLE_COST_MS);
        return groundAt(...degrees(carto));
      },
      globe: {
        show: terrainGlobe,
        tilesLoaded: true,
        getHeight(carto) {
          calls.getHeight += 1;
          const [lat, lon] = degrees(carto);
          return unloaded(lat) ? undefined : groundAt(lat, lon);
        },
      },
      primitives: { add() {}, remove() {} },
    },
  };

  const surface = createTerrainSurface();
  const services = {
    render: {
      governorRequestRender() {
        calls.render += 1;
      },
    },
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
    sprites: { registerSpriteCollection() {}, restoreSpriteOrder() {} },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
  };
  if (shared) {
    services.ground = {
      terrainSurface: {
        ...surface,
        height(...args) {
          calls.sharedHeight += 1;
          return surface.height(...args);
        },
      },
    };
  }
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source: {} };
  parts.model = createModel(context);
  parts.rendering = createRendering(context);
  parts.selection = {
    _installClickHandler() {},
    _clearSelection() {},
    _onKeyDown() {},
  };
  parts.ingestion = { abortAllInFlight() {} };
  // Leaves the points alone, so a test of disable() sees what disable() stops.
  parts.viewport = {
    onCameraChanged() {},
    deactivateAllCities() {},
    runProximityCheck: async () => {},
  };
  parts.lifecycle = createLifecycle(context);
  parts.lifecycle.methods.init(viewer);
  state._pointCollection = {
    show: true,
    add: (options) => ({ ...options }),
    remove() {},
  };

  const heightOf = (key) =>
    Cesium.Cartographic.fromCartesian(
      state._stationRenderMap.get(key).point.position,
    ).height;

  return {
    state,
    parts,
    viewer,
    calls,
    rendering: parts.rendering,
    lifecycle: parts.lifecycle.methods,
    heightOf,
    add(cityId, count) {
      const info = parts.model.parseStationInformation(stations(count, cityId));
      parts.rendering.ensureCityPoints(cityId, info);
      return info;
    },
    /** Wait until every queued station has its height, or fail. */
    async refined() {
      const deadline = performance.now() + 20_000;
      while (parts.rendering.pendingHeightCount() > 0) {
        assert.ok(performance.now() < deadline, 'refinement finished');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    /** The most sampleHeight calls made without yielding to the loop. */
    longestBurst() {
      return mostInATurn;
    },
    done() {
      ticking = false;
      parts.rendering.stopHeightRefinement();
    },
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a city of stations is drawn at once without sampling heights', (t) => {
  const layer = makeLayer();
  t.after(layer.done);
  const started = performance.now();
  layer.add('boston', 300);
  const spent = performance.now() - started;

  assert.equal(layer.state._stationRenderMap.size, 300, 'every station drawn');
  assert.equal(layer.calls.sampleHeight, 0, 'no depth render while drawing');
  assert.ok(spent < 100, `drawing took ${spent.toFixed(1)} ms`);
  assert.ok(
    Math.abs(layer.heightOf('boston:boston0') - POINT_HEIGHT_OFFSET_M) < 1e-3,
    'drawn at the fallback height',
  );
  assert.equal(layer.rendering.pendingHeightCount(), 300);
});

test('heights arrive afterwards in short steps and match a direct sample', async (t) => {
  const layer = makeLayer();
  t.after(layer.done);
  const info = layer.add('boston', 120);
  const rendersBefore = layer.calls.render;
  await layer.refined();

  assert.equal(layer.calls.sampleHeight, 120, 'one sample per station');
  // 120 ms of samples in one go is the stall; a step is a few milliseconds.
  assert.ok(
    layer.longestBurst() <= 10,
    `longest burst was ${layer.longestBurst()} samples`,
  );
  for (const station of info.values()) {
    const expected = groundAt(station.lat, station.lon) + POINT_HEIGHT_OFFSET_M;
    const actual = layer.heightOf(`boston:${station.stationId}`);
    assert.ok(
      Math.abs(actual - expected) < 1e-3,
      `${station.stationId}: ${actual} vs ${expected}`,
    );
  }
  assert.ok(layer.calls.render > rendersBefore, 'moved points ask for a frame');
});

test('on a terrain globe the shared terrain surface answers, not a depth render', async (t) => {
  const layer = makeLayer({ terrainGlobe: true, shared: true });
  t.after(layer.done);
  const info = layer.add('boston', 200);
  assert.equal(layer.calls.getHeight, 0, 'nothing read while drawing');
  await layer.refined();

  assert.equal(layer.calls.sampleHeight, 0);
  assert.equal(layer.calls.sharedHeight, 200, 'asked the shared surface');
  assert.equal(layer.calls.getHeight, 200);
  for (const station of info.values()) {
    const expected = groundAt(station.lat, station.lon) + POINT_HEIGHT_OFFSET_M;
    const actual = layer.heightOf(`boston:${station.stationId}`);
    assert.ok(Math.abs(actual - expected) < 1e-3, station.stationId);
  }
});

test('without a shared surface the layer reads the terrain globe itself', async (t) => {
  const layer = makeLayer({ terrainGlobe: true });
  t.after(layer.done);
  layer.add('boston', 50);
  await layer.refined();
  assert.equal(layer.calls.sampleHeight, 0);
  assert.equal(layer.calls.getHeight, 50);
  assert.ok(
    Math.abs(
      layer.heightOf('boston:boston7') -
        (groundAt(42.3007, -71.0993) + POINT_HEIGHT_OFFSET_M),
    ) < 1e-3,
  );
});

test('a station whose terrain tile is not drawn falls back to a depth render', async (t) => {
  // Stations 10 and up lie on a tile the globe is not drawing.
  const layer = makeLayer({
    terrainGlobe: true,
    shared: true,
    unloaded: (lat) => lat > 42.30095,
  });
  t.after(layer.done);
  layer.add('boston', 20);
  await layer.refined();
  assert.equal(layer.calls.sampleHeight, 10);
  assert.ok(
    Math.abs(
      layer.heightOf('boston:boston15') -
        (groundAt(42.3015, -71.0985) + POINT_HEIGHT_OFFSET_M),
    ) < 1e-3,
  );
});

test('removing a city stops its refinement and leaves the other running', async (t) => {
  const layer = makeLayer();
  t.after(layer.done);
  layer.add('boston', 40);
  layer.add('toronto', 40);
  layer.rendering.removeCityPoints('boston');
  assert.equal(layer.rendering.pendingHeightCount(), 40);
  await layer.refined();
  assert.equal(layer.calls.sampleHeight, 40, 'only the remaining city');
  assert.ok(layer.heightOf('toronto:toronto3') > 50);

  layer.add('boston', 40);
  layer.rendering.removeCityPoints('boston');
  layer.rendering.removeCityPoints('toronto');
  assert.equal(layer.rendering.pendingHeightCount(), 0);
  assert.equal(layer.rendering.heightRefinementScheduled(), false);
  await pause(60);
  assert.equal(layer.calls.sampleHeight, 40, 'nothing sampled after removal');
});

test('disabling the layer stops refinement and leaves no timer', async (t) => {
  const layer = makeLayer();
  t.after(layer.done);
  layer.lifecycle.enable(layer.viewer);
  layer.add('boston', 200);
  await pause(30);
  const partWay = layer.calls.sampleHeight;
  assert.ok(partWay < 200, 'still refining');
  layer.lifecycle.disable(layer.viewer);

  assert.equal(layer.rendering.pendingHeightCount(), 0);
  assert.equal(layer.rendering.heightRefinementScheduled(), false);
  await pause(60);
  assert.equal(layer.calls.sampleHeight, partWay, 'no sample after disable');
});

test('a station selected before its height arrives is re-selected at it', async (t) => {
  const layer = makeLayer();
  t.after(layer.done);
  layer.add('boston', 3);
  const reselected = [];
  layer.state._selectedKey = 'boston:boston1';
  // The selection part's select path; here it records the key.
  layer.parts.selection._selectStation = (key) => reselected.push(key);
  await layer.refined();
  assert.deepEqual(reselected, ['boston:boston1']);
});
