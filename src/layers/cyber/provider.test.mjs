import test from 'node:test';
import assert from 'node:assert/strict';
import { cyberProxy } from '../../../server/providers/cyber.js';
import { createCyberEnrichmentProviders } from '../../../server/providers/cyber/enrichment.js';
import { createOtxProvider } from '../../../server/providers/cyber/otx.js';
import { createIodaProvider } from '../../../server/providers/cyber/ioda.js';
import { createCyberSource } from './source.js';

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status });
const windowMeta = {
  dateRange: [
    { startTime: '2026-09-19T00:00:00Z', endTime: '2026-09-20T00:00:00Z' },
  ],
};

test('IODA country events use a public bounded feed, cache snapshots, and keep reference geography explicit', async () => {
  const requests = [];
  let now = Date.parse('2026-09-23T13:00:00.000Z');
  const provider = createIodaProvider({
    now: () => now,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return jsonResponse({
        data: [
          {
            location: 'country/US',
            location_name: 'United States',
            start: Math.floor(Date.parse('2026-09-23T12:00:00Z') / 1000),
            duration: 3600,
            datasource: 'bgp',
            method: 'bgp',
            overlaps_window: true,
          },
        ],
      });
    },
  });
  const first = await provider.requestSnapshot();
  const cached = await provider.requestSnapshot();
  assert.equal(first, cached);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.hostname, 'api.ioda.inetintel.cc.gatech.edu');
  assert.equal(requests[0].url.pathname, '/v2/outages/events');
  assert.equal(requests[0].url.searchParams.get('entityType'), 'country');
  assert.equal(requests[0].url.searchParams.get('extendWindow'), '0');
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(first.value.events.length, 1);
  assert.equal(
    first.value.countries[0].geographicPrecision,
    'country-reference',
  );
  assert.equal(first.value.countries[0].latitude, 39.538479);
  assert.doesNotMatch(
    JSON.stringify(first.value),
    /score|api[_ -]?key|secret/i,
  );
  now += 6 * 60_000;
});

test('IODA serves a clearly stale last-good snapshot during an upstream outage', async () => {
  let currentTime = Date.parse('2026-09-23T13:00:00.000Z');
  let unavailable = false;
  const provider = createIodaProvider({
    now: () => currentTime,
    fetchImpl: async () => {
      if (unavailable)
        return jsonResponse({ error: 'temporarily unavailable' }, 503);
      return jsonResponse({
        data: [
          {
            location: 'country/CA',
            location_name: 'Canada',
            start: Math.floor(currentTime / 1000) - 120,
            duration: 90,
            datasource: 'active-probing',
            method: 'ping',
          },
        ],
      });
    },
  });
  await provider.requestSnapshot();
  currentTime += 6 * 60_000;
  unavailable = true;
  const stale = await provider.requestSnapshot();
  assert.equal(stale.value.stale, true);
  assert.equal(stale.value.events[0].countryCode, 'CA');
  currentTime += 6 * 60 * 60_000;
  await assert.rejects(provider.requestSnapshot(), {
    code: 'upstream_unavailable',
  });
});

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

test('CISA KEV catalog is validated, cached, stale-safe, and never geographic', async () => {
  let currentTime = Date.parse('2026-09-23T13:00:00Z');
  let requests = 0;
  let fail = false;
  const proxy = cyberProxy({
    now: () => currentTime,
    fetchImpl: async (url) => {
      requests++;
      assert.equal(
        String(url),
        'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
      );
      if (fail) throw new Error('fixture upstream outage');
      return jsonResponse({
        catalogVersion: '2026.09.23',
        dateReleased: '2026-09-23T12:51:35.821Z',
        count: 1,
        vulnerabilities: [
          {
            cveID: 'CVE-2024-12345',
            vendorProject: 'Example Vendor',
            product: 'Example Product',
            vulnerabilityName: 'Example vulnerability',
            dateAdded: '2026-09-22',
            shortDescription: 'A test vulnerability.',
            requiredAction: 'Apply the vendor update.',
            dueDate: '2026-10-01',
            knownRansomwareCampaignUse: 'Unknown',
            forensicTriage: 'Yes',
            notes: 'https://example.test/advisory',
            cwes: ['CWE-20'],
          },
        ],
      });
    },
  });
  const first = await proxy.requestKevSnapshot();
  const cached = await proxy.requestKevSnapshot();
  assert.equal(requests, 1);
  assert.equal(cached, first);
  assert.equal(first.value.provider, 'cisa-kev');
  assert.equal(first.value.vulnerabilities[0].cveId, 'CVE-2024-12345');
  assert.equal(first.value.vulnerabilities[0].ransomware, 'Unknown');
  assert.equal(first.value.vulnerabilities[0].forensicTriage, true);
  assert.equal('latitude' in first.value.vulnerabilities[0], false);
  assert.equal('longitude' in first.value.vulnerabilities[0], false);
  currentTime += 60 * 60_000 + 1;
  fail = true;
  const stale = await proxy.requestKevSnapshot();
  assert.equal(stale.value.stale, true);
  assert.equal(stale.value.count, 1);
  assert.doesNotMatch(JSON.stringify(stale.value), /API[_ -]?key|secret/i);
});

test('Cyber source fetches and normalizes the public CISA KEV snapshot', async () => {
  const requested = [];
  const source = createCyberSource({
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      return jsonResponse({
        provider: 'cisa-kev',
        attribution: 'CISA Known Exploited Vulnerabilities Catalog',
        catalogVersion: '2026.09.23',
        dateReleased: '2026-09-23T12:51:35.821Z',
        fetchedAt: '2026-09-23T13:00:00.000Z',
        stale: false,
        count: 1,
        vulnerabilities: [
          {
            cveId: 'CVE-2024-12345',
            vendor: 'Example Vendor',
            product: 'Example Product',
            name: 'Example vulnerability',
            dateAdded: '2026-09-22',
            shortDescription: 'A test vulnerability.',
            requiredAction: 'Apply the vendor update.',
            dueDate: '2026-10-01',
            ransomware: 'Known',
            forensicTriage: true,
            notes: null,
            cwes: ['CWE-20'],
          },
        ],
      });
    },
  });
  const snapshot = await source.getKevSnapshot();
  assert.equal(requested[0].url, '/api/cyber/kev');
  assert.equal(requested[0].options.method || 'GET', 'GET');
  assert.equal(snapshot.vulnerabilities[0].cveId, 'CVE-2024-12345');
  assert.equal(snapshot.vulnerabilities[0].forensicTriage, true);
});

test('Cyber source validates the same-origin IODA event snapshot', async () => {
  const requested = [];
  const source = createCyberSource({
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      return jsonResponse({
        provider: 'ioda',
        fetchedAt: '2026-09-23T13:00:00.000Z',
        stale: false,
        events: [
          {
            countryCode: 'US',
            countryName: 'United States',
            datasource: 'bgp',
            method: 'bgp',
            startedAt: '2026-09-23T12:00:00Z',
            durationSeconds: 3600,
          },
        ],
      });
    },
  });
  const snapshot = await source.getIodaSnapshot();
  assert.equal(requested[0].url, '/api/cyber/ioda');
  assert.equal(requested[0].options.method || 'GET', 'GET');
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.countries[0].countryCode, 'US');
  assert.equal(snapshot.countries[0].geographicPrecision, 'country-reference');
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
  let searchUrl;
  const api = createCyberEnrichmentProviders({
    now: () => Date.parse('2026-09-20T01:00:00Z'),
    fetchImpl: async (url) => {
      calls++;
      const parsed = new URL(url);
      if (parsed.pathname === '/api-info')
        return jsonResponse({ plan: 'membership', query_credits: 100 });
      if (parsed.pathname === '/shodan/host/search') {
        searchUrl = parsed;
        return jsonResponse({
          total: 1,
          matches: [
            {
              ip_str: '8.8.4.4',
              port: 443,
              product: 'HTTPS',
              vulns: { 'CVE-2024-12345': { cvss: 9.8 } },
              location: { latitude: null, longitude: null },
            },
          ],
        });
      }
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
    assert.deepEqual(search.matches[0].services[0].vulnerabilities, [
      'CVE-2024-12345',
    ]);
    assert.match(searchUrl.searchParams.get('fields'), /vulns/);
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

test('Shodan area search is bounded and fills missing locations with attributed approximate IP geolocation', async () => {
  const oldKey = process.env.SHODAN_API_KEY;
  process.env.SHODAN_API_KEY = 'fixture-secret-never-returned';
  const requests = [];
  const api = createCyberEnrichmentProviders({
    now: () => Date.parse('2026-09-20T01:00:00Z'),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed);
      if (
        parsed.hostname === 'api.shodan.io' &&
        parsed.pathname === '/shodan/host/search'
      )
        return jsonResponse({
          total: 1,
          matches: [
            {
              ip_str: '8.8.4.4',
              port: 443,
              product: 'HTTPS',
              location: { latitude: null, longitude: null },
            },
          ],
        });
      if (parsed.hostname === 'ipwho.is')
        return jsonResponse({
          success: true,
          latitude: 37.751,
          longitude: -97.822,
          city: 'Example City',
          region: 'Example Region',
          country: 'United States',
          country_code: 'US',
        });
      throw new Error('Unexpected provider endpoint');
    },
  });
  try {
    const result = await api.searchShodanArea(40, -74, 75, {
      query: 'port:443 country:US',
    });
    assert.equal(result.query, 'geo:40.0000,-74.0000,75 port:443 country:US');
    assert.equal(result.userQuery, 'port:443 country:US');
    assert.equal(result.matches[0].latitude, 37.751);
    assert.equal(result.matches[0].longitude, -97.822);
    assert.equal(result.matches[0].geographicPrecision, 'network-approximate');
    assert.equal(result.matches[0].geographicMethod, 'IPwho.is IP geolocation');
    assert.match(
      result.matches[0].geographicProvenance,
      /Approximate network geolocation/,
    );
    assert.equal(
      requests.filter((url) => url.hostname === 'ipwho.is').length,
      1,
    );
    assert.equal(
      requests[0].searchParams.get('query'),
      'geo:40.0000,-74.0000,75 port:443 country:US',
    );
    assert.equal(requests[0].searchParams.get('minify'), 'false');
    assert.equal(
      requests[0].searchParams.get('fields'),
      'ip_str,ip,port,transport,product,version,timestamp,org,isp,asn,hostnames,vulns,location,os',
    );
    await assert.rejects(api.searchShodanArea(40, -74, 1001), {
      code: 'invalid_area',
    });
    await assert.rejects(
      api.searchShodanArea(40, -74, 75, { query: 'geo:1,2,3 port:443' }),
      { code: 'invalid_query' },
    );
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  } finally {
    if (oldKey === undefined) delete process.env.SHODAN_API_KEY;
    else process.env.SHODAN_API_KEY = oldKey;
  }
});

test('Shodan area search keeps and maps all 100 unique first-page results', async () => {
  const oldKey = process.env.SHODAN_API_KEY;
  process.env.SHODAN_API_KEY = 'fixture-secret-never-returned';
  const api = createCyberEnrichmentProviders({
    now: () => Date.parse('2026-09-20T02:00:00Z'),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'api.shodan.io')
        throw new Error('Unexpected provider endpoint');
      return jsonResponse({
        total: 100,
        matches: Array.from({ length: 100 }, (_, index) => ({
          ip_str: `8.8.${Math.floor(index / 250)}.${index + 1}`,
          port: 443,
          location: { latitude: 40 + index / 1000, longitude: -74 },
        })),
      });
    },
  });
  try {
    const result = await api.searchShodanArea(40, -74, 75);
    assert.equal(result.matches.length, 100);
    assert.equal(result.pageSize, 100);
    assert.equal(result.matches[99].rank, 100);
    assert.equal(result.matches[99].latitude, 40.099);
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

test('OTX explicitly looks up supported indicators, bounds pulse context, and keeps its key server-side', async () => {
  const oldKey = process.env.ALIENVAULT_OTX_API_KEY;
  process.env.ALIENVAULT_OTX_API_KEY = 'fixture-otx-secret-never-returned';
  const requests = [];
  const api = createOtxProvider({
    now: () => Date.parse('2026-09-20T02:00:00Z'),
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (new URL(url).pathname.endsWith('/pulses/subscribed'))
        return jsonResponse({ results: [] });
      return jsonResponse({
        pulse_info: {
          count: 8,
          pulses: Array.from({ length: 8 }, (_, index) => ({
            id: `${index.toString(16).padStart(24, '0')}`,
            name: `Pulse ${index}`,
            description: 'Community intelligence context',
            author_name: 'Analyst',
            tags: ['phishing'],
            indicator_count: 12,
            TLP: 'white',
          })),
        },
        country: 'US',
        latitude: 40,
        longitude: -74,
      });
    },
  });
  try {
    const tested = await api.testConnection();
    assert.match(tested.message, /connection succeeded/);
    assert.equal(JSON.stringify(tested).includes('fixture-otx-secret'), false);
    const result = await api.lookupIndicator('8.8.8.8');
    assert.equal(result.provider, 'alienvault-otx');
    assert.equal(result.indicatorType, 'IPv4');
    assert.equal(result.pulseCount, 8);
    assert.equal(result.pulses.length, 5);
    assert.equal('latitude' in result, false);
    assert.equal('longitude' in result, false);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url.hostname, 'otx.alienvault.com');
    assert.equal(
      requests[0].options.headers['X-OTX-API-KEY'],
      'fixture-otx-secret-never-returned',
    );
    assert.equal(JSON.stringify(result).includes('fixture-otx-secret'), false);
    await api.lookupIndicator('8.8.8.8');
    assert.equal(requests.length, 2, 'repeat lookup uses server cache');
    await assert.rejects(api.lookupIndicator('not an indicator'), {
      code: 'invalid_indicator',
    });
    assert.equal(
      requests.length,
      2,
      'invalid indicators never leave the server',
    );
  } finally {
    if (oldKey === undefined) delete process.env.ALIENVAULT_OTX_API_KEY;
    else process.env.ALIENVAULT_OTX_API_KEY = oldKey;
  }
});

test('Cyber source posts normalized OTX indicators to its same-origin server endpoint', async () => {
  let call;
  const source = createCyberSource({
    fetchImpl: async (url, options) => {
      call = { url, options };
      return jsonResponse({
        schemaVersion: 1,
        provider: 'alienvault-otx',
        indicator: 'example.com',
        indicatorType: 'Domain',
        indicatorTypeLabel: 'Domain',
        fetchedAt: '2026-09-20T12:00:00Z',
        attribution: 'AlienVault Open Threat Exchange (OTX)',
        pulseCount: 0,
        pulses: [],
      });
    },
  });
  const result = await source.lookupOtxIndicator('example.com');
  assert.equal(call.url, '/api/cyber/otx/lookup');
  assert.deepEqual(JSON.parse(call.options.body), {
    indicator: 'example.com',
    type: 'auto',
  });
  assert.equal(result.indicatorType, 'Domain');
  assert.equal(result.pulses.length, 0);
  assert.equal('latitude' in result, false);
});
