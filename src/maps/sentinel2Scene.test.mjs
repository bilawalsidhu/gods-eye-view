import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_LOOKUP_MAX_HEIGHT_M,
  attachSentinel2SceneReadout,
  fetchSentinelHubConfigured,
  formatSentinel2Readout,
} from './sentinel2Scene.js';

const respond = (status, body) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('the stack unlocks only on an explicit hasKey:true from the local server', async () => {
  const calls = [];
  const configured = await fetchSentinelHubConfigured({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(200, { hasKey: true })();
    },
  });
  assert.equal(configured, true);
  assert.equal(calls[0].url, '/api/sentinel2/status');
  assert.equal(calls[0].init.cache, 'no-store');
  for (const fetchImpl of [
    respond(200, { hasKey: false }),
    respond(200, { hasKey: 'true' }),
    respond(404, { hasKey: true }), // a static build without the server
    async () => {
      throw new TypeError('offline');
    },
    async () => new Response('<html>', { status: 200 }),
  ])
    assert.equal(await fetchSentinelHubConfigured({ fetchImpl }), false);
});

test('every readout says the imagery is an archive mosaic, not live', () => {
  const readings = [
    { kind: 'scene', scene: { date: '2026-09-28', cloudCover: 4.1 } },
    { kind: 'scene', scene: { date: null } },
    { kind: 'zoom' },
    { kind: 'budget' },
    { kind: 'unknown' },
  ];
  for (const reading of readings)
    assert.match(formatSentinel2Readout(reading), /not live/);
  assert.equal(
    formatSentinel2Readout(readings[0]),
    'Sentinel-2 · acquired 2026-09-28 (4.1 % cloud) at screen centre · least-cloudy of the last 30 days · not live',
  );
  assert.match(formatSentinel2Readout(readings[1]), /no scene ≤20 % cloud/);
  assert.match(formatSentinel2Readout(readings[3]), /daily free quota reached/);
  // Markup is built from validated fields only.
  const hostile = formatSentinel2Readout({
    kind: 'scene',
    scene: { date: '<img src=x onerror=alert(1)>', cloudCover: '<b>' },
  });
  assert.doesNotMatch(hostile, /<img|<b>/);
});

function fakeScene({ height = 20_000, lon = 0.5, lat = 0.5 } = {}) {
  const listeners = new Set();
  const subscribers = new Set();
  const shown = [];
  const radians = Math.PI / 180;
  const viewer = {
    camera: {
      positionCartographic: {
        longitude: lon * radians,
        latitude: lat * radians,
        height,
      },
      moveEnd: {
        addEventListener(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    },
    scene: {},
  };
  let activeId = 'esri-imagery';
  const controller = {
    getActiveId: () => activeId,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    switchTo(id) {
      activeId = id;
      for (const fn of subscribers) fn({ activeId: id });
    },
  };
  const credits = {
    show: (html) => shown.push(html),
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  return {
    viewer,
    controller,
    credits,
    shown,
    listeners,
    subscribers,
    move(next) {
      Object.assign(viewer.camera.positionCartographic, next);
      for (const fn of listeners) fn();
    },
  };
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the readout looks up nothing until Sentinel-2 Latest is the active map', async () => {
  const env = fakeScene();
  const urls = [];
  const dispose = attachSentinel2SceneReadout({
    viewer: env.viewer,
    controller: env.controller,
    credits: env.credits,
    debounceMs: 0,
    fetchImpl: async (url) => {
      urls.push(url);
      return respond(200, { date: '2026-09-28', cloudCover: 4.1 })();
    },
  });
  await wait();
  assert.deepEqual(urls, []);
  assert.deepEqual(env.shown, []);
  assert.equal(env.listeners.size, 0);

  env.controller.switchTo('sentinel2-latest');
  await wait();
  assert.deepEqual(urls, ['/api/sentinel2/scene?lon=0.55&lat=0.55']);
  assert.match(env.shown.at(-1), /acquired 2026-09-28/);

  // A move inside the same 0.1° cell reuses the reading.
  env.move({ longitude: (0.52 * Math.PI) / 180 });
  await wait();
  assert.equal(urls.length, 1);

  // Leaving the stack clears the credit and stops listening.
  env.controller.switchTo('osm');
  assert.equal(env.shown.at(-1), null);
  assert.equal(env.listeners.size, 0);
  env.move({ longitude: (5 * Math.PI) / 180 });
  await wait();
  assert.equal(urls.length, 1);

  dispose();
  assert.equal(env.subscribers.size, 0);
  assert.equal(env.credits.destroyed, true);
});

test('a view too high to show Sentinel-2 spends no lookup', async () => {
  const env = fakeScene({ height: SCENE_LOOKUP_MAX_HEIGHT_M + 1 });
  env.controller.switchTo('sentinel2-latest');
  let calls = 0;
  const dispose = attachSentinel2SceneReadout({
    viewer: env.viewer,
    controller: env.controller,
    credits: env.credits,
    debounceMs: 0,
    fetchImpl: async () => {
      calls++;
      return respond(200, {})();
    },
  });
  await wait();
  assert.equal(calls, 0);
  assert.match(env.shown.at(-1), /zoom in to see 10 m imagery/);
  dispose();
});

test('a spent daily quota is reported, and retried on the next move', async () => {
  const env = fakeScene();
  env.controller.switchTo('sentinel2-latest');
  let calls = 0;
  const dispose = attachSentinel2SceneReadout({
    viewer: env.viewer,
    controller: env.controller,
    credits: env.credits,
    debounceMs: 0,
    fetchImpl: async () => {
      calls++;
      return respond(429, { error: 'budget' })();
    },
  });
  await wait();
  assert.match(env.shown.at(-1), /daily free quota reached/);
  env.move({});
  await wait();
  assert.equal(calls, 2);
  dispose();
});

test('a controller without settled-state events is ignored safely', () => {
  const dispose = attachSentinel2SceneReadout({
    viewer: {},
    controller: {},
    credits: { show() {}, destroy() {} },
  });
  assert.doesNotThrow(dispose);
});
