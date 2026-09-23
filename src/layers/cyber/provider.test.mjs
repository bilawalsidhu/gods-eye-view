import test from 'node:test';
import assert from 'node:assert/strict';
import { cyberProxy } from '../../../server/providers/cyber.js';

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status });
const windowMeta = {
  dateRange: [
    { startTime: '2026-09-19T00:00:00Z', endTime: '2026-09-20T00:00:00Z' },
  ],
};

test('Radar uses a fixed same-purpose upstream request and returns country aggregates only', async () => {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push({ url: new URL(url), options });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/origin'))
      return jsonResponse({
        success: true,
        result: {
          meta: windowMeta,
          top_0: [
            {
              originCountryAlpha2: 'US',
              originCountryName: 'United States',
              value: '12.5',
              rank: '1',
            },
          ],
        },
      });
    if (parsed.pathname.endsWith('/target'))
      return jsonResponse({
        success: true,
        result: {
          meta: windowMeta,
          top_0: [
            {
              targetCountryAlpha2: 'CA',
              targetCountryName: 'Canada',
              value: '3.2',
              rank: '1',
            },
          ],
        },
      });
    if (parsed.pathname.endsWith('/attacks'))
      return jsonResponse({
        success: true,
        result: {
          meta: windowMeta,
          top_0: [
            {
              originCountryAlpha2: 'US',
              originCountryName: 'United States',
              targetCountryAlpha2: 'CA',
              targetCountryName: 'Canada',
              value: '2.4',
              rank: 1,
            },
          ],
        },
      });
    if (parsed.pathname.endsWith('/locations'))
      return jsonResponse({
        success: true,
        result: {
          locations: [
            {
              alpha2: 'US',
              name: 'United States',
              latitude: 39.8,
              longitude: -98.6,
            },
            { alpha2: 'CA', name: 'Canada', latitude: 56.1, longitude: -106.3 },
          ],
        },
      });
    throw new Error('Unexpected upstream URL');
  };
  const proxy = cyberProxy({
    fetchImpl,
    now: () => Date.parse('2026-09-20T01:00:00Z'),
  });
  const entry = await proxy.requestRadarSnapshot({ token: 'unit-test-secret' });
  assert.equal(entry.value.observations.length, 2);
  assert.equal(entry.value.flows.length, 1);
  assert.equal(entry.value.flows[0].origin.name, 'United States');
  assert.equal(entry.value.flows[0].target.name, 'Canada');
  assert.equal(entry.value.flows[0].share, 2.4);
  assert.deepEqual(
    entry.value.observations.map((row) => row.geographicPrecision),
    ['country', 'country'],
  );
  assert.ok(
    entry.value.observations.every((row) =>
      row.geographicProvenance.includes('country-level'),
    ),
  );
  assert.equal(urls.length, 4);
  assert.ok(urls.some(({ url }) => url.pathname.endsWith('/top/attacks')));
  assert.ok(
    urls.every(
      ({ url, options }) =>
        url.protocol === 'https:' &&
        url.hostname === 'api.cloudflare.com' &&
        options.headers.Authorization === 'Bearer unit-test-secret',
    ),
  );
  assert.ok(urls.every(({ url }) => !url.href.includes('unit-test-secret')));
});

test('DShield is cached, normalized and non-geographic', async () => {
  let requests = 0;
  const proxy = cyberProxy({
    now: () => Date.parse('2026-09-20T01:00:00Z'),
    fetchImpl: async (url) => {
      requests++;
      if (String(url).includes('topips'))
        return new Response('192.0.2.1\texample.test\n203.0.113.4\t\n');
      return new Response('443 tcp https\n22 tcp ssh\n');
    },
  });
  const first = await proxy.requestDshieldSnapshot();
  const second = await proxy.requestDshieldSnapshot();
  assert.equal(requests, 2);
  assert.equal(first, second);
  assert.equal(first.value.observations.length, 2);
  assert.ok(
    first.value.observations.every(
      (row) => row.latitude === null && row.longitude === null,
    ),
  );
  assert.equal(first.value.ports[0].port, 443);
  assert.match(first.value.notice, /not a blocklist/);
});

test('Radar missing/invalid credentials produce safe machine errors and test never echoes key', async () => {
  const proxy = cyberProxy({ fetchImpl: async () => jsonResponse({}, 401) });
  await assert.rejects(proxy.requestRadarSnapshot({ token: '' }), {
    code: 'missing_credentials',
  });
  await assert.rejects(
    proxy.testRadarConnection({ token: 'sensitive-token' }),
    { code: 'invalid_credentials' },
  );
});
