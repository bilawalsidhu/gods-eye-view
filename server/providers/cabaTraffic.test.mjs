import test from 'node:test';
import assert from 'node:assert/strict';
import { cabaTrafficProxy } from './cabaTraffic.js';
import { CABA_CSV_URL } from '../../src/layers/trafficEnforcement/records.js';

const csv =
  'tipo_de_fiscalizador;ubicación;latitud;longitud\n' +
  'Cinemómetro;AV. TEST;-34,6;-58,4\n';

function harness(options, preview = false) {
  let handler;
  const plugin = cabaTrafficProxy(options);
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/caba-traffic-enforcement');
        handler = fn;
      },
    },
  });
  return async (url = '/', method = 'GET') => {
    let status;
    let headers;
    let body;
    await handler(
      { url, method, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      {
        writeHead(code, values) {
          status = code;
          headers = values;
        },
        end(text) {
          body = JSON.parse(text);
        },
      },
    );
    return { status, headers, body };
  };
}

test('dev and preview use the fixed CSV and daily cache', async () => {
  for (const preview of [false, true]) {
    let calls = 0;
    let time = Date.UTC(2026, 9, 14);
    const request = harness(
      {
        now: () => time,
        fetchImpl: async (url, options) => {
          calls++;
          assert.equal(url, CABA_CSV_URL);
          assert.equal(options.redirect, 'manual');
          assert.ok(options.signal);
          return new Response(csv);
        },
      },
      preview,
    );
    assert.equal((await request()).body.rows.length, 1);
    assert.equal((await request()).body.fetchedAt, time);
    assert.equal(calls, 1);
    time += 24 * 60 * 60 * 1000;
    assert.equal((await request()).status, 200);
    assert.equal(calls, 2);
  }
});

test('concurrent callers coalesce one upstream request', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const request = harness({
    fetchImpl: async () => {
      calls++;
      await gate;
      return new Response(csv);
    },
  });
  const first = request();
  const second = request();
  release();
  assert.deepEqual(
    (await Promise.all([first, second])).map((x) => x.status),
    [200, 200],
  );
  assert.equal(calls, 1);
});

test('the official legacy-encoded CSV preserves accented headers and values', async () => {
  const request = harness({
    fetchImpl: async () => new Response(Buffer.from(csv, 'latin1')),
  });
  const result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.body.rows[0].type, 'Cinemómetro');
  assert.equal(result.body.rows[0].latitude, -34.6);
});

test('only official HTTPS redirects are followed', async () => {
  for (const location of [
    'http://data.buenosaires.gob.ar/file.csv',
    'https://example.com/file.csv',
    'https://127.0.0.1/file.csv',
    'https://user:pass@cdn.buenosaires.gob.ar/file.csv',
    'https://cdn.buenosaires.gob.ar:444/file.csv',
  ]) {
    let calls = 0;
    const request = harness({
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      },
    });
    assert.equal((await request()).status, 502);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const request = harness({
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.buenosaires.gob.ar/file.csv' },
          })
        : new Response(csv);
    },
  });
  assert.equal((await request()).status, 200);
  assert.equal(calls, 2);
});

test('unsupported requests never reach upstream', async () => {
  let calls = 0;
  const request = harness({
    fetchImpl: async () => {
      calls++;
      return new Response(csv);
    },
  });
  assert.equal((await request('/?url=https://example.com')).status, 404);
  assert.equal((await request('/other')).status, 404);
  assert.equal((await request('/', 'POST')).status, 405);
  assert.equal(calls, 0);
});

test('failed downloads remain unavailable and can recover', async () => {
  for (const response of [
    new Response('<html>maintenance</html>'),
    new Response('x', {
      headers: { 'content-length': String(3 * 1024 * 1024) },
    }),
    new Response('failed', { status: 503 }),
  ]) {
    const request = harness({ fetchImpl: async () => response });
    const result = await request();
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { error: 'caba_inventory_unavailable' });
  }
  let time = Date.UTC(2026, 9, 14);
  let fail = false;
  const request = harness({
    now: () => time,
    fetchImpl: async () =>
      fail ? new Response('failed', { status: 503 }) : new Response(csv),
  });
  assert.equal((await request()).status, 200);
  time += 24 * 60 * 60 * 1000;
  fail = true;
  assert.equal((await request()).status, 502);
  fail = false;
  assert.equal((await request()).status, 200);
});
