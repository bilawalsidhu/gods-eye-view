import assert from 'node:assert/strict';
import test from 'node:test';
import { FIREBALL_API_URL, fireballsProxy } from './fireballs.js';

const PAYLOAD = {
  count: '1',
  fields: [
    'date',
    'energy',
    'impact-e',
    'lat',
    'lat-dir',
    'lon',
    'lon-dir',
    'alt',
    'vel',
  ],
  data: [
    [
      '2026-10-04 03:14:45',
      '5.4',
      '0.18',
      '41.8',
      'S',
      '173.1',
      'W',
      '26.9',
      '13.8',
    ],
  ],
};

function harness({ respond, start = 1_000_000 } = {}) {
  let clock = start;
  const calls = [];
  const plugin = fireballsProxy({
    now: () => clock,
    warn: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(calls.length);
    },
  });
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/fireballs');
        handler = fn;
      },
    },
  });
  async function get(url = '/events', method = 'GET') {
    const req = {
      url,
      method,
      headers: { host: 'localhost:4173', 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    return new Promise((resolve) => {
      const res = {
        destroyed: false,
        statusCode: 200,
        headers: {},
        writeHead(status, headers) {
          this.statusCode = status;
          this.headers = headers;
        },
        setHeader(name, value) {
          this.headers[name] = value;
        },
        end(body) {
          resolve({
            status: this.statusCode,
            headers: this.headers,
            body: body ? JSON.parse(body) : null,
          });
        },
      };
      handler(req, res);
    });
  }
  return {
    get,
    calls,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('the proxy normalizes JPL once an hour and serves the copy stale while JPL is down', async () => {
  let down = false;
  const proxy = harness({
    respond: () =>
      down ? new Response('nope', { status: 503 }) : Response.json(PAYLOAD),
  });
  const first = await proxy.get();
  assert.equal(first.status, 200);
  assert.equal(proxy.calls[0].url, FIREBALL_API_URL);
  assert.equal(proxy.calls[0].init.redirect, 'error');
  assert.equal(first.body.rows.length, 1);
  assert.equal(first.body.rows[0].lat, -41.8);
  // Within the hour: from cache.
  proxy.advance(30 * 60_000);
  await proxy.get();
  assert.equal(proxy.calls.length, 1);
  // Past it with JPL down: the last copy, marked stale.
  down = true;
  proxy.advance(40 * 60_000);
  const stale = await proxy.get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(proxy.calls.length, 2);
});

test('the proxy answers only GET /events and reports an outage with nothing cached', async () => {
  const proxy = harness({
    respond: () => Response.json({ unexpected: true }),
  });
  assert.equal((await proxy.get('/other')).status, 404);
  assert.equal((await proxy.get('/events', 'POST')).status, 405);
  const failed = await proxy.get();
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: 'fireballs_unavailable' });
  assert.ok(Number(failed.headers['Retry-After']) >= 1);
});
