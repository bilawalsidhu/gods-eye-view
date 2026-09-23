import test from 'node:test';
import assert from 'node:assert/strict';
import { cyberProxy } from '../../../server/providers/cyber.js';
import { createCyberEnrichmentProviders } from '../../../server/providers/cyber/enrichment.js';

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

test('Shodan host and manual search are normalized, bounded and cached without exposing credentials', async () => {
  const oldKey = process.env.SHODAN_API_KEY;
  process.env.SHODAN_API_KEY = 'fixture-secret-never-returned';
  let calls = 0;
  const api = createCyberEnrichmentProviders({
    now: () => Date.parse('2026-09-20T01:00:00Z'),
    fetchImpl: async (url) => {
      calls++;
      const parsed = new URL(url);
      if (parsed.pathname === '/api-info')
        return jsonResponse({ plan: 'membership', query_credits: 100 });
      if (parsed.pathname === '/shodan/host/search')
        return jsonResponse({
          total: 1,
          matches: [{ ip_str: '8.8.4.4', port: 443, product: 'HTTPS' }],
        });
      if (parsed.pathname.startsWith('/shodan/host/'))
        return jsonResponse({
          ip_str: '8.8.8.8',
          org: 'Example Org',
          ports: [53],
          data: [
            { port: 53, transport: 'udp', product: 'DNS', data: 'safe banner' },
          ],
          hostnames: ['dns.example'],
        });
      throw new Error('Unexpected provider endpoint');
    },
  });
  try {
    const test = await api.testShodanConnection();
    assert.match(test.message, /100 query credits/);
    const host = await api.lookupShodanHost('8.8.8.8');
    await api.lookupShodanHost('8.8.8.8');
    assert.equal(host.services[0].product, 'DNS');
    assert.equal(host.geographicPrecision, null);
    const search = await api.searchShodan('port:443', 1);
    assert.equal(await api.searchShodan('port:443', 1), search);
    assert.equal(search.matches.length, 1);
    assert.equal(search.matches[0].ip, '8.8.4.4');
    await assert.rejects(api.searchShodan('port:22', 1), {
      code: 'rate_limited',
    });
    assert.equal(
      JSON.stringify({ test, host, search }).includes('fixture-secret'),
      false,
    );
    assert.equal(calls, 3);
  } finally {
    if (oldKey === undefined) delete process.env.SHODAN_API_KEY;
    else process.env.SHODAN_API_KEY = oldKey;
  }
});

test('GreyNoise test discloses its one cached Community lookup and bad IPs never call upstream', async () => {
  const oldKey = process.env.GREYNOISE_API_KEY;
  process.env.GREYNOISE_API_KEY = 'fixture-grey-secret-never-returned';
  let calls = 0;
  const api = createCyberEnrichmentProviders({
    now: () => Date.parse('2026-09-20T01:00:00Z'),
    fetchImpl: async () => {
      calls++;
      return jsonResponse({
        ip: '1.1.1.1',
        noise: false,
        riot: true,
        classification: 'benign',
        name: 'Example',
        last_seen: '2026-09-19T12:00:00Z',
      });
    },
  });
  try {
    const tested = await api.testGreyNoiseConnection();
    assert.match(tested.message, /one Community lookup/);
    assert.match(tested.message, /counts toward/);
    assert.equal((await api.lookupGreyNoise('1.1.1.1')).riot, true);
    assert.equal(calls, 1);
    await assert.rejects(api.lookupGreyNoise('192.168.1.1'), {
      code: 'invalid_ip',
    });
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(tested).includes('fixture-grey-secret'), false);
  } finally {
    if (oldKey === undefined) delete process.env.GREYNOISE_API_KEY;
    else process.env.GREYNOISE_API_KEY = oldKey;
  }
});
