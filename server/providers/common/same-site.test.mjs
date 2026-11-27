import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { admitSameSite } from './same-site.js';

function requestThroughGate(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path: '/', method: 'POST', headers },
      (res) => {
        res.resume();
        res.once('end', () => {
          resolve({
            status: res.statusCode,
            cacheControl: res.headers['cache-control'],
          });
        });
        res.once('error', reject);
      },
    );
    req.once('error', reject);
    req.end();
  });
}

test('trusted proxy allowance is applied at the HTTP socket boundary', async () => {
  const previous = process.env.GEV_TRUSTED_PROXY_IPS;
  const server = createServer((req, res) => {
    if (admitSameSite(req, res)) return;
    res.writeHead(204);
    res.end();
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const proxied = {
      origin: 'https://127.0.0.1:' + port,
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.25',
    };

    delete process.env.GEV_TRUSTED_PROXY_IPS;
    const direct = {
      origin: 'http://127.0.0.1:' + port,
      'sec-fetch-site': 'same-origin',
    };
    assert.equal((await requestThroughGate(port, direct)).status, 204);

    const defaultDenied = await requestThroughGate(port, proxied);
    assert.equal(defaultDenied.status, 403, 'proxy headers remain blocked by default');
    assert.equal(defaultDenied.cacheControl, 'no-store');

    process.env.GEV_TRUSTED_PROXY_IPS = '10.0.0.0/8';
    assert.equal(
      (await requestThroughGate(port, proxied)).status,
      403,
      'a nonmatching allowlist cannot trust the loopback socket',
    );

    process.env.GEV_TRUSTED_PROXY_IPS = '127.0.0.1';
    assert.equal(
      (await requestThroughGate(port, proxied)).status,
      204,
      'an exact trusted socket peer permits one-hop HTTPS forwarding',
    );

    process.env.GEV_TRUSTED_PROXY_IPS = '127.0.0.0/8';
    assert.equal(
      (await requestThroughGate(port, proxied)).status,
      204,
      'a matching IPv4 CIDR permits the same trusted socket peer',
    );

    process.env.GEV_TRUSTED_PROXY_IPS = '127.0.0.1';
    for (const [caseName, overrides] of [
      ['multi-hop client IP', { 'x-forwarded-for': '203.0.113.25, 198.51.100.8' }],
      ['multi-hop scheme', { 'x-forwarded-proto': 'https, http' }],
      ['unexpected CDN signal', { 'cf-ray': 'test-ray' }],
      ['foreign Origin', { origin: 'https://elsewhere.example' }],
      ['cross-site browser', { 'sec-fetch-site': 'cross-site' }],
    ]) {
      assert.equal(
        (await requestThroughGate(port, { ...proxied, ...overrides })).status,
        403,
        caseName,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.GEV_TRUSTED_PROXY_IPS;
    else process.env.GEV_TRUSTED_PROXY_IPS = previous;

    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});
