import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { coldStartFixtures } from './coldStartFixtures.mjs';
import { COLD_START_GROUPS } from './coldStart.mjs';

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
      location: { href: origin },
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
