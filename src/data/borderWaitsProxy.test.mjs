import test from 'node:test';
import assert from 'node:assert/strict';
import { borderWaitsProxy } from '../../server/providers/borderWaits.js';
import { cbpPort } from '../layers/borderWaits/fixture.mjs';

const CBSA_URL = 'https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv';
const CBSA_HEADER =
  '\uFEFFCustoms Office;; Location;; Last updated;; Commercial Flow - Canada bound;; Commercial Flow - U.S. bound;; Travellers Flow - Canada bound;; Travellers Flow - U.S. bound;;';
const cbsaCsv = (...rows) => [CBSA_HEADER, ...rows].join('\r\n');
const AMBASSADOR_CBSA =
  'Ambassador Bridge;; Windsor, ON/Detroit, MI;; 2026-10-13 11:18 EDT;; 5 minutes;; --;; No Delay;; --;; ';

// CBP requests go to `fetchImpl`, CBSA requests to `cbsaImpl` (unavailable
// unless a test supplies one), so each source can fail on its own.
function install(options = {}, hook = 'configureServer') {
  let handler;
  const { fetchImpl, cbsaImpl, ...rest } = options;
  const plugin = borderWaitsProxy({
    warn() {},
    ...rest,
    fetchImpl: async (url, init) =>
      url === CBSA_URL
        ? cbsaImpl
          ? cbsaImpl(url, init)
          : new Response('', { status: 404 })
        : fetchImpl(url, init),
  });
  assert.equal(plugin.name, 'border-waits');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/border-waits');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: 'local' } }, res);
    return res;
  };
}

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: fetches only CBP's document and serves normalized rows`, async () => {
    const calls = [];
    const request = install(
      {
        now: () => 1234,
        fetchImpl: async (url, options) => {
          calls.push(url);
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.redirect, 'error');
          return Response.json([cbpPort(), cbpPort({ port_number: '999901' })]);
        },
      },
      hook,
    );
    const res = await request('/?url=https://invalid.example');
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['https://bwt.cbp.gov/api/bwtnew']);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body.fetchedAt, 1234);
    assert.deepEqual(
      res.body.rows.map(({ id }) => id),
      ['380001'],
    );
    assert.deepEqual(res.body.unlocated, ['999901']);
    assert.equal(res.body.stale, undefined);
  });
}

test('one upstream request serves every viewer for five minutes', async () => {
  let clock = 0;
  let calls = 0;
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return Response.json([cbpPort()]);
    },
  });
  await Promise.all([request(), request(), request()]);
  assert.equal(calls, 1, 'concurrent requests share one fetch');
  clock = 299_999;
  await request();
  assert.equal(calls, 1);
  clock = 300_000;
  await request();
  assert.equal(calls, 2);
});

test('an unreachable or malformed CBP keeps serving the last snapshot, marked stale', async () => {
  let clock = 0;
  let mode = 'ok';
  const request = install({
    now: () => clock,
    fetchImpl: async () => {
      if (mode === 'down') throw new Error('connect ETIMEDOUT');
      if (mode === 'error') return new Response('busy', { status: 503 });
      if (mode === 'malformed') return Response.json({ ports: [] });
      return Response.json([cbpPort()]);
    },
  });
  assert.equal((await request()).status, 200);
  for (const failure of ['down', 'error', 'malformed']) {
    mode = failure;
    clock += 300_000;
    const res = await request();
    assert.equal(res.status, 200, failure);
    assert.equal(res.headers['X-Data-Stale'], 'true', failure);
    assert.equal(res.body.stale, true, failure);
    assert.equal(res.body.fetchedAt, 0, failure);
    assert.deepEqual(
      res.body.rows.map(({ id }) => id),
      ['380001'],
    );
  }
  mode = 'ok';
  clock += 300_000;
  const recovered = await request();
  assert.equal(recovered.body.stale, undefined);
  assert.equal(recovered.body.fetchedAt, clock);
});

test('without a snapshot a failure is a 502 that does not leak upstream detail', async () => {
  const request = install({
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND bwt.cbp.gov');
    },
  });
  const res = await request();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'border_waits_unavailable' });
});

test('only GET on the root route is served', async () => {
  let calls = 0;
  const request = install({
    fetchImpl: async () => {
      calls++;
      return Response.json([cbpPort()]);
    },
  });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/ports/380001')).status, 404);
  assert.equal(calls, 0);
});

test('a crossing without a location is logged once, not on every refresh', async () => {
  let clock = 0;
  const warnings = [];
  const request = install({
    now: () => clock,
    warn: (message) => warnings.push(message),
    fetchImpl: async () =>
      Response.json([cbpPort(), cbpPort({ port_number: '999901' })]),
  });
  await request();
  clock += 300_000;
  await request();
  assert.deepEqual(warnings, [
    '[BorderWaits] No location for CBP crossings: 999901',
  ]);
});

test('waits into Canada join the CBP crossing each CBSA office faces', async () => {
  const cbsaCalls = [];
  const request = install({
    fetchImpl: async () =>
      Response.json([cbpPort(), cbpPort({ port_number: '380002' })]),
    cbsaImpl: async (url, init) => {
      cbsaCalls.push(url);
      assert.equal(init.redirect, 'error');
      return new Response(cbsaCsv(AMBASSADOR_CBSA));
    },
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(cbsaCalls, [CBSA_URL]);
  assert.equal(res.body.canada.available, true);
  const [ambassador, tunnel] = res.body.rows;
  assert.deepEqual(ambassador.canada, {
    office: 'Ambassador Bridge',
    travellers: { status: 'no delay', delayMinutes: 0 },
    commercial: { status: 'delay', delayMinutes: 5 },
    updated: '2026-10-13 11:18 EDT',
  });
  assert.equal(tunnel.canada, null, 'CBSA did not report the tunnel');
});

test('CBP waits are served when CBSA fails, and CBSA serves stale on its own', async () => {
  let clock = 0;
  let cbsaUp = true;
  const request = install({
    now: () => clock,
    fetchImpl: async () => Response.json([cbpPort()]),
    cbsaImpl: async () =>
      cbsaUp
        ? new Response(cbsaCsv(AMBASSADOR_CBSA))
        : new Response('<html>maintenance</html>'),
  });
  assert.equal((await request()).body.canada.available, true);
  cbsaUp = false;
  clock += 300_000;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], undefined, 'CBP is current');
  assert.deepEqual(stale.body.canada, {
    available: true,
    fetchedAt: 0,
    stale: true,
  });
  assert.equal(stale.body.rows[0].canada.office, 'Ambassador Bridge');

  const fresh = install({
    fetchImpl: async () => Response.json([cbpPort()]),
    cbsaImpl: async () => {
      throw new Error('connect ETIMEDOUT');
    },
  });
  const res = await fresh();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.canada, { available: false });
  assert.equal(res.body.rows[0].canada, null);
});

test('a CBSA office with no CBP crossing is logged once', async () => {
  let clock = 0;
  const warnings = [];
  const request = install({
    now: () => clock,
    warn: (message) => warnings.push(message),
    fetchImpl: async () => Response.json([cbpPort()]),
    cbsaImpl: async () =>
      new Response(
        cbsaCsv(
          AMBASSADOR_CBSA,
          'North Portal;; North Portal, SK/Portal, ND;; 2026-10-13 09:00 CDT;; No Delay;; --;; No Delay;; --;; ',
        ),
      ),
  });
  await request();
  clock += 300_000;
  await request();
  assert.deepEqual(warnings, [
    '[BorderWaits] No CBP crossing for CBSA offices: North Portal',
  ]);
});
