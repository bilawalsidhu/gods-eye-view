import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { coldStartFixtures } from './coldStartFixtures.mjs';
import { COLD_START_GROUPS } from './coldStart.mjs';
import { createSatelliteSource } from '../../src/layers/satellites/source.js';
import { parseSatcatCsv } from '../../src/layers/satellites/classes.js';
import { createFakeEngine } from '../../src/globe/testing/fakeEngine.js';
import { createTrafficDisplay } from '../../src/layers/traffic/render/display.js';
import { createAnimation } from '../../src/layers/traffic/animation.js';
import { createRecentImagerySource } from '../../src/layers/recentImagery/source.js';
import { createThumbnailLoader } from '../../src/layers/recentImagery/thumbnails.js';

const origin = 'http://127.0.0.1:4309';
test('every group has valid strict fixture routes', async () => {
  for (const group of Object.keys(COLD_START_GROUPS)) {
    const fixture = await coldStartFixtures(origin, group);
    assert.ok(Number.isFinite(fixture.epoch));
    for (const { pattern } of fixture.routes)
      assert.ok(new URLPattern(pattern));
    for (const pattern of fixture.fixtures) assert.ok(new URLPattern(pattern));
  }
});

test('imagery fixtures answer catalog, thumbnails and every GIBS tile subdomain', async () => {
  const { routes } = await coldStartFixtures(origin, 'imagery');
  for (const host of ['cmr', 'wvs', 'gibs-a', 'gibs-b', 'gibs-c']) {
    const url = `https://${host}.earthdata.nasa.gov/fixture`;
    const route = routes.find(({ pattern }) =>
      new URLPattern(pattern).test(url),
    );
    assert.ok(route, host);
    const response = await route.respond({ url });
    assert.equal(
      response.contentType,
      host === 'cmr' ? 'application/json' : 'image/png',
    );
    assert.ok(response.body.length);
  }
});

test('wind fixture supplies the declared grid dimensions and uniform vectors', async () => {
  const { routes } = await coldStartFixtures(origin, 'wind');
  const manifest = JSON.parse(
    routes[0].respond({
      url: origin + '/api/wind/manifest?model=gfs&overlay=temperature',
    }).body,
  );
  const response = routes[0].respond({ url: origin + manifest.gridUrl });
  const values = new Float32Array(
    response.body.buffer,
    response.body.byteOffset,
    response.body.length / 4,
  );
  const count = manifest.grid.nx * manifest.grid.ny;
  assert.equal(values.length, count * 3);
  assert.ok(values.slice(0, count).every((value) => value === 8));
  assert.ok(values.slice(count, count * 2).every((value) => value === 6));
});

test('independent pages receive identical stationary aircraft and timestamps through fetch', async () => {
  const fixture = await coldStartFixtures(origin, 'aircraft');
  const scripts = [];
  await fixture.install({
    evaluateOnNewDocument: async (fn, args) => scripts.push({ fn, args }),
  });
  const page = () => {
    const context = vm.createContext({
      URL,
      Response,
      EventTarget,
      performance: { now: () => 0 },
      location: { href: origin, origin },
      localStorage: { setItem() {} },
      window: {
        EventSource: class {},
        fetch() {
          throw new Error('Unstubbed network request');
        },
      },
    });
    for (const { fn, args } of scripts)
      vm.runInContext(`(${fn})(${JSON.stringify(args)})`, context);
    return context;
  };
  const a = page(),
    b = page();
  for (const path of ['/api/flights', '/api/military', '/api/flights/track']) {
    const read = async (context) =>
      (
        await vm.runInContext(`window.fetch(${JSON.stringify(path)})`, context)
      ).json();
    assert.deepEqual(await read(a), await read(b));
  }
  assert.equal(vm.runInContext('Date.now()', a), fixture.epoch);
  assert.equal(vm.runInContext('+new Date()', b), fixture.epoch);
  await assert.rejects(
    vm.runInContext("window.fetch('/api/unexpected-feed')", a),
    /No cold-start fixture/,
  );
  assert.equal(
    vm.runInContext('window.__coldStartUnexpectedApi[0]', a),
    '/api/unexpected-feed',
  );
});

async function installedPage(group) {
  const fixture = await coldStartFixtures(origin, group);
  const scripts = [];
  await fixture.install({
    evaluateOnNewDocument: async (fn, args) => scripts.push({ fn, args }),
  });
  let elapsed = 0;
  const forwarded = [];
  const context = vm.createContext({
    URL,
    Response,
    EventTarget,
    performance: { now: () => elapsed },
    location: { href: origin, origin },
    localStorage: { setItem() {} },
    window: {
      EventSource: class {},
      async fetch(input) {
        const url = new URL(input.url ?? input, origin).href;
        forwarded.push(url);
        const route = fixture.routes.find(({ pattern }) =>
          new URLPattern(pattern).test(url),
        );
        assert.ok(route, url);
        const response = await route.respond({ url });
        return new Response(response.body, {
          status: response.status ?? 200,
          headers: { 'content-type': response.contentType },
        });
      },
    },
  });
  for (const { fn, args } of scripts)
    vm.runInContext(`(${fn})(${JSON.stringify(args)})`, context);
  return {
    fixture,
    context,
    forwarded,
    advance: (ms) => {
      elapsed += ms;
    },
    fetch: (url) =>
      vm.runInContext(`window.fetch(${JSON.stringify(url)})`, context),
  };
}

test('the page fetch guard delegates NASA snapshot APIs to their image fixture', async () => {
  const page = await installedPage('imagery');
  const response = await page.fetch(
    'https://wvs.earthdata.nasa.gov/api/v1/snapshot?WIDTH=256',
  );
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.ok((await response.arrayBuffer()).byteLength > 0);
  assert.equal(page.context.window.__coldStartUnexpectedApi.length, 0);
  await assert.rejects(page.fetch('/api/v1/snapshot'), /No cold-start fixture/);
});

test('every TLE group has matching deterministic SATCAT records on both pages', async () => {
  const a = await installedPage('space'),
    b = await installedPage('space');
  for (const group of [
    'stations',
    'visual',
    'gps-ops',
    'glo-ops',
    'galileo',
    'geo',
    'starlink',
    'resource',
    'weather',
    'planet',
    'sar',
    'science',
  ]) {
    const source = createSatelliteSource({ fetchImpl: a.fetch });
    const catalog = await source.readSatcat(group);
    assert.equal(catalog.ok, true);
    assert.equal(
      catalog.text,
      await (await b.fetch(`/api/celestrak-satcat/${group}`)).text(),
    );
    const tle = (await source.readGroup(group)).text;
    assert.equal(
      parseSatcatCsv(catalog.text).size,
      tle.trim().split('\n').length / 3,
    );
  }
  assert.equal(a.context.window.__coldStartUnexpectedApi.length, 0);
});

test('wall time advances for fades and visibility while the orbit epoch stays fixed', async () => {
  for (const group of ['aircraft', 'traffic', 'space']) {
    const page = await installedPage(group);
    const before = vm.runInContext('Date.now()', page.context);
    page.advance(2000);
    assert.equal(
      vm.runInContext('Date.now()', page.context) - before,
      group === 'space' ? 0 : 2000,
    );
    assert.equal(
      vm.runInContext('+new Date()', page.context),
      vm.runInContext('Date.now()', page.context),
    );
  }
});

test('traffic uses deterministic road and flow tiles', async () => {
  const page = await installedPage('traffic');
  assert.equal(
    (await (await page.fetch('/api/tomtom/status')).json()).hasKey,
    true,
  );
  for (const url of [
    'https://tiles.openfreemap.org/qa-traffic/14/3743/6745.pbf',
    '/api/tomtom/flow/12/935/1686.pbf',
  ])
    assert.ok((await (await page.fetch(url)).arrayBuffer()).byteLength > 0);
});

test('imagery fixtures admit a recent S30 scene through the real thumbnail loader', async (t) => {
  const page = await installedPage('imagery');
  const source = createRecentImagerySource({ fetchImpl: page.fetch });
  const box = { west: -97.77, east: -97.71, south: 30.25, north: 30.29 };
  const now = new Date(page.fixture.epoch);
  const { candidates } = await source.searchHls({ box, now });
  const candidate = candidates.find((row) => row.product === 'S30');
  assert.ok(candidate);
  assert.ok(now - Date.parse(candidate.day) < 3 * 86_400_000);
  const loader = createThumbnailLoader({
    requestThumbnail: source.getThumbnail,
    createObjectUrl: () => 'blob:fixture',
    revokeObjectUrl() {},
  });
  t.after(() => loader.destroy());
  const finished = new Promise((resolve) => {
    loader.subscribe((key) => {
      const state = loader.get(key);
      if (!state.loading && state.status !== 'unknown') resolve(state);
    });
  });
  loader.request(candidate, box);
  const state = await finished;
  assert.equal(state.status, 'present');
  assert.equal(state.objectUrl, 'blob:fixture');
});

test('traffic fixture dots finish their birth fade and stay visible during comparison', async (t) => {
  const page = await installedPage('traffic');
  t.mock.method(Date, 'now', () => vm.runInContext('Date.now()', page.context));
  t.mock.method(Math, 'random', () =>
    vm.runInContext('Math.random()', page.context),
  );
  const engine = createFakeEngine({ altitude: 1800 });
  const display = createTrafficDisplay(engine);
  t.after(() => {
    display.destroy();
    engine.destroy();
  });
  const animation = createAnimation({
    state: {
      _enabled: true,
      _renderHeld: true,
      _engine: engine,
      _display: display,
      _dots: [],
      _scratchLerp: {},
      _nextDotId: 1,
      _speedScale: 1,
      _fadeScaleFar: 100000,
      _fadeTransFar: 100000,
      _bucketCounts: { sim: 0 },
      _motion: { added: 0, recycled: 0 },
      _lastAnimTime: Date.now(),
      _animFrame: 0,
    },
    services: {},
    parts: {
      rendering: {},
      retention: { easeHeights() {} },
      style: { baseDotSize: () => 6, activeSizeDelta: () => 0 },
    },
  });
  animation.spawnDotsForRoad(
    {
      type: 'primary',
      segmentDist: [10000],
      waypoints: [
        { x: 6378137, y: 0, z: 0 },
        { x: 6378137, y: 10000, z: 0 },
      ],
    },
    1800,
    10,
  );
  animation.animate();
  animation.drawDots();
  assert.equal(
    engine.movers.list().find(({ id }) => id === 'traffic-fill').count,
    0,
  );
  page.advance(200);
  animation.animate();
  animation.drawDots();
  assert.equal(
    engine.movers.list().find(({ id }) => id === 'traffic-fill').count,
    10,
  );
  for (let i = 0; i < 300; i++) {
    page.advance(100);
    animation.animate();
    animation.drawDots();
    assert.equal(
      engine.movers.list().find(({ id }) => id === 'traffic-fill').count,
      10,
    );
  }
});
