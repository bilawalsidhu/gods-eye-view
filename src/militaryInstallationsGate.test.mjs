// Military-installations cross-site gate — verifies that the admitSameSite
// gate added in this PR actually refuses the same request shapes the terrain
// and CCTV proxies already refuse, and admits same-origin and bare-tool
// requests.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { militaryInstallationsProxy } from '../server/providers/military-installations.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes;
}

function request(
  handler,
  { url = '/', method = 'GET', remoteAddress = '127.0.0.1', reqHeaders = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = {
      method,
      url,
      headers: reqHeaders,
      socket: { remoteAddress },
    };
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      writeHead(status, hdrs = {}) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [name, value] of Object.entries(hdrs))
          headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(String(body)) : null;
        } catch {
          parsed = String(body);
        }
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: parsed,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

// A valid bbox query string for military-installations.
const VALID_BBOX = '?south=48.8&west=2.2&north=48.9&east=2.4';
const HOST = 'localhost:5173';

test('cross-site browser requests are refused with 403', async () => {
  const route = install(militaryInstallationsProxy()).get(
    '/api/military-installations',
  );
  const refused = [
    // <img src> from any web page
    { host: HOST, 'sec-fetch-site': 'cross-site' },
    // same-site but cross-origin sibling
    { host: HOST, 'sec-fetch-site': 'same-site' },
    // fetch from another page
    { host: HOST, origin: 'https://evil.example' },
    // sandboxed frame
    { host: HOST, origin: 'null' },
    // behind a reverse proxy with cross-site
    { host: HOST, 'x-forwarded-for': '203.0.113.9', 'sec-fetch-site': 'cross-site' },
  ];
  for (const reqHeaders of refused) {
    const answer = await request(route, { url: VALID_BBOX, reqHeaders });
    assert.equal(
      answer.statusCode,
      403,
      `expected 403 for headers ${JSON.stringify(reqHeaders)}, got ${answer.statusCode}`,
    );
  }
});

test('same-origin browser request is admitted (not 403)', async () => {
  const route = install(militaryInstallationsProxy()).get(
    '/api/military-installations',
  );
  // Same-origin with matching origin header
  const answer = await request(route, {
    url: VALID_BBOX,
    reqHeaders: {
      host: HOST,
      origin: `http://${HOST}`,
      'sec-fetch-site': 'same-origin',
    },
  });
  // Should get past the gate — may be 200, 429, or 503 depending on Overpass config,
  // but never 403.
  assert.notEqual(answer.statusCode, 403, 'same-origin request should not be refused');
});

test('bare tool request (no Origin, no Sec-Fetch) is admitted', async () => {
  const route = install(militaryInstallationsProxy()).get(
    '/api/military-installations',
  );
  // curl / Node harness — no browser headers at all
  const answer = await request(route, {
    url: VALID_BBOX,
    reqHeaders: { host: HOST },
  });
  assert.notEqual(answer.statusCode, 403, 'bare tool request should not be refused');
});

test('proxied same-origin requests are refused (proxy headers present)', async () => {
  const route = install(militaryInstallationsProxy()).get(
    '/api/military-installations',
  );
  const proxied = [
    { host: HOST, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.9' },
    { host: HOST, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '203.0.113.9' },
    {
      host: HOST,
      'sec-fetch-site': 'same-origin',
      forwarded: 'for=203.0.113.9;proto=https',
      via: '1.1 caddy',
    },
  ];
  for (const reqHeaders of proxied) {
    const answer = await request(route, { url: VALID_BBOX, reqHeaders });
    assert.equal(
      answer.statusCode,
      403,
      `expected 403 for proxied headers ${JSON.stringify(reqHeaders)}, got ${answer.statusCode}`,
    );
  }
});
