// GBFS PROXY — the frequency the allowlist never bounded.
//
// `/api/gbfs` already says WHERE it may go: an https allowlisted host, a
// station_information/station_status path, a 12 s timeout, a 5 MB body cap and
// no redirects. Nothing said HOW OFTEN, so the dev server would relay an
// unbounded stream of requests at a third-party bikeshare operator on any
// caller's behalf — one outbound fetch and one timeout timer each.
//
// These cases drive the real mounted middleware. `fetch` is stubbed per test
// and restored afterwards, so a case that reaches the network fails loudly,
// and the stub's call count is what proves a refused request costs nothing.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gbfsProxy, GBFS_RATE_PER_MIN } from '../../server/providers/gbfs.js';

const STATUS_URL = 'https://gbfs.lyft.com/gbfs/2.3/bay/en/station_status.json';
const STATION_BODY = '{"data":{"stations":[]}}';

/** Mount the proxy the way the dev server does; returns its route handler. */
function mount(options) {
  const routes = new Map();
  gbfsProxy(options).configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return routes.get('/api/gbfs');
}

function request(handler, { target = STATUS_URL, remoteAddress, method } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method: method || 'GET',
      // connect strips the mount prefix before the handler sees the URL.
      url: '/' + encodeURIComponent(target),
      headers: {},
      socket: remoteAddress ? { remoteAddress } : undefined,
    };
    let status = 200;
    let headers = {};
    const res = {
      writeHead(code, sent) {
        status = code;
        headers = sent || {};
        return res;
      },
      end(body = '') {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(String(body)) : null;
        } catch {
          parsed = String(body);
        }
        resolve({ status, headers, body: parsed });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/** Answer every allowlisted upstream, counting the calls that got through. */
function stubUpstream(t) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(STATION_BODY, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return asked;
}

test('a maximal real session is never throttled', async (t) => {
  const asked = stubUpstream(t);
  const handler = mount();

  // The bikeshare layer catalogues 15 systems and refreshes each one's status
  // once every 60 s, so a minute of the busiest possible session is ~15
  // requests. Run eight times that and expect every one of them served.
  let served = 0;
  for (let i = 0; i < 120; i += 1) {
    const res = await request(handler);
    if (res.status === 200) served += 1;
  }
  assert.equal(served, 120, 'the shipped ceiling leaves a real session alone');
  assert.equal(asked.length, 120);
  assert.equal(GBFS_RATE_PER_MIN, 120, 'the ceiling this case relies on');
});

test('an unbounded relay is refused, and refusal costs no outbound fetch', async (t) => {
  const asked = stubUpstream(t);
  const handler = mount({ ratePerMinute: 5 });

  const responses = [];
  for (let i = 0; i < 12; i += 1) responses.push(await request(handler));

  const served = responses.filter((r) => r.status === 200);
  const refused = responses.filter((r) => r.status === 429);
  assert.equal(served.length, 5, 'exactly the admitted budget is served');
  assert.equal(refused.length, 7);
  assert.equal(refused[0].body.error, 'Rate limit exceeded');
  assert.equal(refused[0].headers['Retry-After'], '10');
  assert.equal(refused[0].headers['Cache-Control'], 'no-store');
  assert.equal(
    asked.length,
    5,
    'a refused request never reaches the GBFS operator',
  );
});

test('a different client keeps its own budget', async (t) => {
  stubUpstream(t);
  const handler = mount({ ratePerMinute: 3 });

  for (let i = 0; i < 6; i += 1)
    await request(handler, { remoteAddress: '10.0.0.1' });
  const noisy = await request(handler, { remoteAddress: '10.0.0.1' });
  assert.equal(noisy.status, 429, 'the noisy client spent its own budget');

  const quiet = await request(handler, { remoteAddress: '10.0.0.2' });
  assert.equal(quiet.status, 200, 'a quiet client is not collateral');
});

test('the limiter does not displace the existing guards', async (t) => {
  const asked = stubUpstream(t);
  const handler = mount({ ratePerMinute: 10 });

  const wrongMethod = await request(handler, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);

  const offAllowlist = await request(handler, {
    target: 'https://example.com/gbfs/station_status.json',
  });
  assert.equal(offAllowlist.status, 403);
  assert.equal(offAllowlist.body.error, 'GBFS host not allowed');

  const wrongPath = await request(handler, {
    target: 'https://gbfs.lyft.com/gbfs/2.3/bay/en/system_regions.json',
  });
  assert.equal(wrongPath.status, 400);

  assert.equal(asked.length, 0, 'none of those reached upstream');
});
