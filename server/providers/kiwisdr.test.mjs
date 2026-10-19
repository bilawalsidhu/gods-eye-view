import test from 'node:test';
import assert from 'node:assert/strict';
import { kiwiSdrDirectory } from './kiwisdr.js';

const row = (i, over = {}) => ({
  id: `id${String(i).padStart(6, '0')}`,
  status: 'active',
  offline: 'no',
  name: `Rx ${i}`,
  bands: '0-30000000',
  users: '1',
  users_max: '4',
  gps: `(${10 + (i % 50)}.5, ${20 + (i % 100)}.25)`,
  loc: 'Somewhere',
  antenna: 'Loop',
  snr: '30,30',
  url: `http://rx${i}.example.com:8073`,
  ...over,
});
const script = (n) =>
  `var kiwisdr_com =\n${JSON.stringify(Array.from({ length: n }, (_, i) => row(i)))}\n;`;
const response = (text, status = 200) =>
  new Response(text, {
    status,
    headers: { 'content-type': 'text/javascript' },
  });
function call(mw, { method = 'GET', url = '/' } = {}) {
  return new Promise((resolve) => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: JSON.parse(body),
        });
      },
    };
    mw({ method, url }, res, () => resolve({ passedThrough: true }));
  });
}

test('serves normalized stations and only fetches the fixed URL', async () => {
  const urls = [];
  const mw = kiwiSdrDirectory({
    fetchImpl: async (url) => (urls.push(url), response(script(30))),
  });
  const out = await call(mw);
  assert.equal(out.status, 200);
  assert.equal(out.body.stations.length, 30);
  assert.equal(out.headers['Cache-Control'], 'no-store');
  assert.deepEqual(urls, ['http://rx.linkfanel.net/kiwisdr_com.js']);
});

test('caches and shares one upstream fetch', async () => {
  let calls = 0;
  const mw = kiwiSdrDirectory({
    fetchImpl: async () => (calls++, response(script(30))),
  });
  await Promise.all([call(mw), call(mw), call(mw)]);
  await call(mw);
  assert.equal(calls, 1);
});

test('serves the stale snapshot when the upstream later fails', async () => {
  let t = 0;
  let fail = false;
  const mw = kiwiSdrDirectory({
    now: () => t,
    fetchImpl: async () => (fail ? response('x', 500) : response(script(30))),
  });
  assert.equal((await call(mw)).status, 200);
  fail = true;
  t = 11 * 60_000;
  const out = await call(mw);
  assert.equal(out.status, 200);
  assert.equal(out.body.stations.length, 30);
});

test('refuses an implausibly small directory and bad methods', async () => {
  const mw = kiwiSdrDirectory({ fetchImpl: async () => response(script(3)) });
  assert.equal((await call(mw)).status, 502);
  assert.equal((await call(mw, { method: 'POST' })).status, 405);
});

test('ignores other paths', async () => {
  const mw = kiwiSdrDirectory({ fetchImpl: async () => response(script(30)) });
  assert.equal((await call(mw, { url: '/other' })).passedThrough, true);
});

test('a failed refresh tells the UI why, with a fixed vocabulary only', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const net = kiwiSdrDirectory({
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ENOTFOUND' },
        });
      },
    });
    const a = await call(net);
    assert.equal(a.status, 502);
    assert.equal(a.body.reason, 'kiwisdr_fetch_failed');
    assert.ok(
      !JSON.stringify(a.body).includes('ENOTFOUND'),
      'no raw detail leaks',
    );

    const http = kiwiSdrDirectory({
      fetchImpl: async () => response('x', 503),
    });
    assert.equal((await call(http)).body.reason, 'kiwisdr_upstream_http_503');

    const junk = kiwiSdrDirectory({
      fetchImpl: async () => response('no array here'),
    });
    assert.equal((await call(junk)).body.reason, 'kiwisdr_directory_invalid');
  } finally {
    console.warn = warn;
  }
});
