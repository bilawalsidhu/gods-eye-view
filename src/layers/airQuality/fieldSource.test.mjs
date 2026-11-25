import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FIELD_IDS, sampleField } from './field.js';
import { createLocalAirQualityFieldSource } from './fieldSource.js';

// A 10° box of a CAMS run over northern Italy (global 0.4°, an inset 0.1°),
// steps 0 and 24, cut from baked grids in this format.
const FIXTURE = new URL('./fixtures/field/', import.meta.url);
const read = (name) => readFileSync(new URL(name, FIXTURE));

/** The local server's field routes, answered from the fixture folder. */
function fixtureFetch({ configured = true, sizes = {} } = {}) {
  const urls = [];
  const fetchImpl = async (url, options = {}) => {
    urls.push(url);
    assert.equal(options.redirect, 'error');
    const path = url.split('?')[0];
    if (path === '/api/air-quality/field/manifest') {
      const body = configured
        ? read('manifest.json')
        : JSON.stringify({
            unavailable: true,
            code: 'not_configured',
            reason: 'Model field not configured',
          });
      return new Response(body, {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const grid =
      /^\/api\/air-quality\/field\/grid\/(\w+)\/(\d{3})\/(\w+)\.u16$/.exec(
        path,
      );
    if (!grid) return new Response('{}', { status: 404 });
    const bytes = read(`${grid[1]}/${grid[2]}/${grid[3]}.u16`);
    const cut = sizes[`${grid[1]}/${grid[3]}`];
    return new Response(cut === undefined ? bytes : bytes.subarray(0, cut));
  };
  return { urls, fetchImpl };
}

test('the local field source reads the configured folder: its manifest, then every grid of a step', async () => {
  const { urls, fetchImpl } = fixtureFetch();
  const source = createLocalAirQualityFieldSource({ fetchImpl });
  const manifest = await source.getManifest();
  assert.equal(
    manifest.source,
    'CAMS forecast (Copernicus Atmosphere Monitoring Service)',
  );
  assert.equal(manifest.sourceShort, 'CAMS');
  assert.equal(manifest.run, '2026-11-20T00:00:00Z');
  assert.deepEqual(manifest.global.steps, [0, 24]);
  assert.equal(manifest.europe.blendDeg, 1);
  const step = await source.getStep(24, { run: manifest.run });
  assert.deepEqual(Object.keys(step.global), FIELD_IDS);
  assert.deepEqual(Object.keys(step.europe), FIELD_IDS);
  assert.equal(step.global.pm25.length, 26 * 26);
  assert.equal(step.europe.pm25.length, 50 * 50);
  // Each grid once, for the run the manifest names.
  const grids = urls.slice(1);
  assert.equal(grids.length, 14);
  assert.ok(
    grids.every((url) =>
      url.endsWith(`.u16?run=${encodeURIComponent(manifest.run)}`),
    ),
  );
  assert.ok(
    grids.includes(
      `/api/air-quality/field/grid/global/024/aqi.u16?run=${encodeURIComponent(manifest.run)}`,
    ),
  );
  // Read as the map reads it: a value inside the inset, one outside it.
  const milan = sampleField(manifest, step, 'pm25', 9.19, 45.46);
  const munich = sampleField(manifest, step, 'pm25', 11.58, 48.14);
  assert.ok(Number.isFinite(milan) && milan > 0, `Milan ${milan}`);
  assert.ok(Number.isFinite(munich) && munich > 0, `Munich ${munich}`);
});

test('a server with no field configured says so, and the source passes it on', async () => {
  const { urls, fetchImpl } = fixtureFetch({ configured: false });
  const source = createLocalAirQualityFieldSource({ fetchImpl });
  await assert.rejects(source.getManifest(), { code: 'not_configured' });
  assert.deepEqual(urls, ['/api/air-quality/field/manifest']);
  // A server without the route at all (another host's) has none either.
  const elsewhere = createLocalAirQualityFieldSource({
    fetchImpl: async () => new Response('{}', { status: 404 }),
  });
  await assert.rejects(elsewhere.getManifest(), { code: 'not_configured' });
});

test('before a manifest was ever read, a page means no field and transient failures can be retried', async () => {
  for (const [index, fetchImpl] of [
    // A static host answering every path with its page.
    async () =>
      new Response('<!doctype html><title>GEV</title>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    async () => new Response('{}', { status: 502 }),
    async () => {
      throw new TypeError('fetch failed');
    },
  ].entries()) {
    const source = createLocalAirQualityFieldSource({ fetchImpl });
    await assert.rejects(
      source.getManifest(),
      (error) => (error.code === 'not_configured') === (index === 0),
    );
  }
  // Once a manifest was read, a failure is a failure, tried again later.
  const { fetchImpl } = fixtureFetch();
  let down = false;
  const source = createLocalAirQualityFieldSource({
    fetchImpl: async (url, options) =>
      down ? new Response('{}', { status: down }) : fetchImpl(url, options),
  });
  await source.getManifest();
  for (const status of [502, 404]) {
    down = status;
    await assert.rejects(
      source.getManifest(),
      (error) => error.code !== 'not_configured',
    );
  }
});

test('a grid of the wrong size is refused', async () => {
  const { fetchImpl } = fixtureFetch({ sizes: { 'europe/no2': 100 } });
  const source = createLocalAirQualityFieldSource({ fetchImpl });
  const manifest = await source.getManifest();
  await assert.rejects(
    source.getStep(0, { run: manifest.run }),
    /Malformed air-quality field/,
  );
  // A step the manifest does not list is not asked for.
  await assert.rejects(source.getStep(3, { run: manifest.run }), /step/);
});

test('the CAMS fixture carries the full credit CAMS requires', async () => {
  const { fetchImpl } = fixtureFetch();
  const manifest = await createLocalAirQualityFieldSource({
    fetchImpl,
  }).getManifest();
  assert.equal(
    manifest.credit,
    'Contains modified Copernicus Atmosphere Monitoring Service information 2026. Neither the European Commission nor ECMWF is responsible for any use that may be made of the information it contains.',
  );
});

test('a step is given time for its bytes beyond the base deadline', async () => {
  const fixture = fixtureFetch();
  const source = createLocalAirQualityFieldSource({
    timeoutMs: 30,
    fetchImpl: async (url, options) => {
      if (url.includes('/grid/'))
        await new Promise((resolve) => setTimeout(resolve, 100));
      return fixture.fetchImpl(url, options);
    },
  });
  const { run } = await source.getManifest();
  assert.equal((await source.getStep(0, { run })).global.pm25.length, 26 * 26);
});
test('a grid of another run is refused and the next step reads the manifest again', async () => {
  const fixture = fixtureFetch();
  const source = createLocalAirQualityFieldSource({
    fetchImpl: (url, options) =>
      url.includes('/grid/')
        ? new Response('{}', { status: 409 })
        : fixture.fetchImpl(url, options),
  });
  const { run } = await source.getManifest();
  for (let i = 1; i <= 2; i++) {
    await assert.rejects(source.getStep(0, { run }), { code: 'run_changed' });
    assert.equal(
      fixture.urls.filter((url) => url.endsWith('/manifest')).length,
      i,
    );
  }
});
test('a step of a run the server has replaced is refused as a changed run', async () => {
  const fixture = fixtureFetch();
  let manifest = JSON.parse(read('manifest.json'));
  const source = createLocalAirQualityFieldSource({
    fetchImpl: (url, options) =>
      url.endsWith('/manifest')
        ? Response.json(manifest)
        : fixture.fetchImpl(url, options),
  });
  const { run } = await source.getManifest();
  manifest = { ...manifest, run: '2026-11-21T00:00:00Z' };
  await source.getManifest();
  await assert.rejects(source.getStep(0, { run }), { code: 'run_changed' });
});
