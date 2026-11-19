import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { PbfWriter } from 'pbf';
import { createViewport } from './viewport.js';
import { TRANSIT_POLL_MS } from './policy.js';
import { createTransitService } from '../../sources/transitService.js';
import { TRANSIT_ADMISSION_MAX_GLOBAL } from '../../data/transitProxy.js';

function realCamera(width, height) {
  const scene = {
    canvas: { clientWidth: width, clientHeight: height, width, height },
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    mapProjection: new Cesium.GeographicProjection(),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    preRender: new Cesium.Event(),
    postUpdate: new Cesium.Event(),
    screenSpaceCameraController: { maximumZoomDistance: Infinity },
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  return { scene, camera };
}

/** Feed ids the layer activates for a top-down view. */
function activatedFeeds({ width, height, lat, lon, km }) {
  const { scene, camera } = realCamera(width, height);
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, km * 1000),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  const polled = [];
  const state = {
    _enabled: true,
    _viewer: { camera, scene },
    _altitudeGateOpen: false,
    _activeFeeds: new Map(),
    _inFlight: new Map(),
    _feedStatus: new Map(),
    _generation: 0,
    _cameraRevision: 0,
  };
  createViewport({
    state,
    services: { render: { governorRequestRender() {} } },
    parts: {
      rendering: { requestVisibility() {}, syncRenderHold() {} },
      ingestion: {
        pollFeed: (feed) => polled.push(feed.id),
        removeFeedVehicles() {},
        sweepAgedVehicles() {},
      },
    },
  }).runProximityCheck();
  return polled;
}

function feedBytes(timestamp) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(2, 0);
  header.writeVarintField(3, timestamp);
  writer.writeBytesField(1, header.finish());
  return writer.finish();
}

function upstream() {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const view = feedBytes(Math.floor(Date.now() / 1000));
    return {
      status: 200,
      ok: true,
      url: '',
      headers: { get: () => null },
      body: null,
      async arrayBuffer() {
        return view.buffer.slice(
          view.byteOffset,
          view.byteOffset + view.byteLength,
        );
      },
    };
  };
  return { fetchImpl, count: () => calls };
}

async function simulate(t, feeds, clients, minutes, jitter = () => 0) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_789_000_000_000 });
  const t0 = Date.now();
  const up = upstream();
  const service = createTransitService({ fetchImpl: up.fetchImpl });
  t.after(() => service.close());
  const events = [];
  for (const [i, offset] of clients.entries()) {
    for (let k = 0; offset + k * TRANSIT_POLL_MS < minutes * 60_000; k++) {
      for (const id of feeds) {
        events.push({
          at: offset + k * TRANSIT_POLL_MS + jitter(),
          id,
          client: i,
        });
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  const tally = { MISS: 0, HIT: 0, 'STALE-ERROR': 0, other: 0, s503: 0 };
  for (const event of events) {
    t.mock.timers.setTime(t0 + event.at);
    const response = await service.handle({
      url: `https://example.test/api/transit/vehicles/${event.id}`,
      method: 'GET',
    });
    if (response.status === 503) tally.s503 += 1;
    const cache = response.headers.get('X-GEV-Cache');
    if (cache in tally) tally[cache] += 1;
    else tally.other += 1;
  }
  return { ...tally, upstream: up.count(), perMinute: up.count() / minutes };
}

/** A deterministic ±5 ms arrival jitter. */
function jitter(seed = 12345) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return Math.round((seed / 2 ** 31 - 0.5) * 10);
  };
}

// Top-down over the Great Lakes on a 1920×1080 screen, below the 2,850 km
// gate: nine Ontario feeds, MBTA, Metro Transit and CapMetro come into play.
const GREAT_LAKES = { width: 1920, height: 1080, lat: 41, lon: -84, km: 2850 };

test('the feeds one wide view activates fit the global admission budget', async (t) => {
  const feeds = activatedFeeds(GREAT_LAKES);
  // One poll per feed every TRANSIT_POLL_MS, each reaching the proxy once its
  // 15 s copy has expired — the "4/min" the admission comment budgets for.
  const result = await simulate(t, feeds, [1], 3);
  assert.ok(
    feeds.length * (60_000 / TRANSIT_POLL_MS) <= TRANSIT_ADMISSION_MAX_GLOBAL,
    `${feeds.length} feeds × ${60_000 / TRANSIT_POLL_MS}/min > ${TRANSIT_ADMISSION_MAX_GLOBAL}: ${feeds.join(', ')}`,
  );
  assert.equal(result['STALE-ERROR'] + result.s503, 0, JSON.stringify(result));
});

test('two clients of one proxy watching that view are not refused', async (t) => {
  // A second browser or device on the same server, half a poll out of phase.
  const feeds = activatedFeeds(GREAT_LAKES);
  const result = await simulate(t, feeds, [0, 7_500], 10, jitter());
  assert.equal(result['STALE-ERROR'] + result.s503, 0, JSON.stringify(result));
});

test('one tab watching that view is not refused', async (t) => {
  const feeds = activatedFeeds(GREAT_LAKES);
  const result = await simulate(t, feeds, [0], 10, jitter());
  assert.equal(result['STALE-ERROR'] + result.s503, 0, JSON.stringify(result));
});
