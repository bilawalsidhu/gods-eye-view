import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { firmsProxy } from './firms.js';

const NOW = Date.parse('2026-10-15T04:00:00Z');
function install(t, { key = '', enabled = '1', fails = [] } = {}) {
  for (const [name, value] of Object.entries({ FIRMS_MAP_KEY: key, CONAE_GOES_ENABLED: enabled })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(fs, 'readFile', async () => { throw new Error('no disk cache'); });
  t.mock.method(fs, 'mkdir', async () => {});
  t.mock.method(fs, 'writeFile', async () => {});
  t.mock.method(console, 'warn', () => {});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const url = new URL(raw);
    const conae = url.hostname === 'geoservicios.conae.gov.ar';
    calls.push(conae ? 'conae' : 'firms');
    if (fails.includes(conae ? 'conae' : 'firms')) throw new Error('offline');
    if (conae) return Response.json({
      type: 'FeatureCollection', features: [{
        type: 'Feature', geometry: { type: 'Point', coordinates: [-60, -30] },
        properties: { 'Fecha_Local_UTC-3': '2026-10-15 00:50:00', Satelite: 'GOES19', Fire_Radiative_Power: 12 },
      }],
    });
    return new Response('latitude,longitude,acq_date,acq_time,confidence,frp\n-30,-60,2026-10-15,0350,n,12\n');
  });
  let handler;
  firmsProxy().configureServer({ middlewares: { use(path, callback) { assert.equal(path, '/api/firms'); handler = callback; } } });
  return {
    calls,
    async request(url = '/') {
      let result;
      const response = {
        headersSent: false,
        writeHead(status) { result = { status }; this.headersSent = true; },
        end(body) { result.body = JSON.parse(body); },
      };
      await handler({ url, method: 'GET' }, response);
      return result;
    },
  };
}

test('opt-out remains keyless and touches neither upstream', async (t) => {
  const app = install(t, { enabled: '' });
  assert.equal((await app.request()).status, 503);
  assert.equal((await app.request('/status')).body.hasKey, false);
  assert.deepEqual(app.calls, []);
});

test('CONAE alone is usable without pretending that a NASA key is configured', async (t) => {
  const app = install(t);
  const before = await app.request('/status');
  assert.equal(before.body.hasKey, false);
  assert.equal(before.body.conae.fetchedAt, null);
  assert.deepEqual(app.calls, []);
  const result = await app.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 1);
  assert.equal(result.body.sourceLabel, 'CONAE GOES');
  assert.equal(result.body.fires[0].provider, 'conae-goes');
  assert.equal((await app.request('/status')).body.conae.count, 1);
  await app.request();
  assert.deepEqual(app.calls, ['conae']);
});

test('combined snapshots retain both independent observations without duplicating upstream requests', async (t) => {
  const app = install(t, { key: 'synthetic-key' });
  const results = await Promise.all([app.request(), app.request()]);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 5);
    assert.equal(result.body.sourceLabel, 'NASA FIRMS + CONAE GOES');
    assert.equal(result.body.sources.length, 5);
  }
  assert.equal(app.calls.filter((s) => s === 'firms').length, 4);
  assert.equal(app.calls.filter((s) => s === 'conae').length, 1);
});

test('one failed provider preserves the other and total failure is not healthy empty coverage', async (t) => {
  for (const failure of ['conae', 'firms', 'both']) {
    await t.test(failure, async (child) => {
      const app = install(child, { key: 'synthetic-key', fails: failure === 'both' ? ['conae', 'firms'] : [failure] });
      const result = await app.request();
      assert.equal(result.status, failure === 'both' ? 502 : 200);
      assert.ok(result.body.sources.some((s) => s.ok === false));
      if (failure === 'conae') assert.equal(result.body.sourceLabel, 'NASA FIRMS');
      if (failure === 'firms') assert.equal(result.body.sourceLabel, 'CONAE GOES');
    });
  }
});
