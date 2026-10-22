import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fetchPinnedRadioResponse } from '../../server/providers/radio/transport.js';
import {
  createRadioProxyMiddleware,
  isPublicRadioAddress,
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from '../../vite.config.js';
import { rankRadioStationsForRequest } from './radio.js';

const UUID = '12345678-1234-4234-8234-123456789abc';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function createProxy(options = {}) {
  return createRadioProxyMiddleware({ lookupImpl: publicLookup, ...options });
}

function station(overrides = {}) {
  return {
    stationuuid: UUID,
    name: 'Test Radio',
    url_resolved: 'https://stream.example.org/live.mp3',
    homepage: 'https://station.example.org/',
    favicon: 'https://station.example.org/logo.png',
    tags: 'news,jazz',
    language: 'English',
    country: 'United States',
    countrycode: 'US',
    state: 'Texas',
    codec: 'MP3',
    bitrate: 128,
    hls: 0,
    lastcheckok: 1,
    geo_lat: 30.2672,
    geo_long: -97.7431,
    clickcount: 42,
    ...overrides,
  };
}

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function queryTag(url) {
  return new URL(String(url)).searchParams.get('tag');
}

function catalogRows(prefix, tags = 'news,jazz', count = 400) {
  return Array.from({ length: count }, (_, index) => station({
    stationuuid: `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    name: `${prefix} Station ${index}`,
    tags,
    clickcount: 1000 - index,
  }));
}

function healthyRowsForQuery(url, prefix = '30000000') {
  return catalogRows(prefix, queryTag(url) || 'news');
}

function invoke(middleware, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const result = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, headers = {}) { result.status = status; result.headers = headers; },
      end(body = '') { result.body = String(body); resolve(result); },
    };
    Promise.resolve(middleware({ url, method }, res)).catch(reject);
  });
}

test('normalization keeps only healthy geolocated public HTTPS MP3/AAC streams', () => {
  const normalized = normalizeRadioBrowserStation(station());
  assert.equal(normalized.id, UUID);
  assert.equal(normalized.streamUrl, 'https://stream.example.org/live.mp3');
  assert.equal(normalized.country, 'United States');
  assert.equal(normalized.countryCode, 'US');
  assert.equal(normalized.metadataTrust, 'untrusted-community');
  const franceByName = normalizeRadioBrowserStation(station({ country: 'France', countrycode: '' }));
  assert.equal(franceByName.country, 'France');
  assert.equal(franceByName.countryCode, 'FR');
  const invalidCountryCode = normalizeRadioBrowserStation(station({ country: 'Atlantis', countrycode: 'ZZ' }));
  assert.equal(invalidCountryCode.country, 'Atlantis');
  assert.equal(invalidCountryCode.countryCode, '');
  assert.equal('favicon' in normalized, false);
  assert.equal(normalizeRadioBrowserStation(station({ url_resolved: 'http://stream.example.org/live.mp3' })), null);
  assert.equal(normalizeRadioBrowserStation(station({ url_resolved: 'https://127.0.0.1/live.mp3' })), null);
  assert.equal(normalizeRadioBrowserStation(station({ url_resolved: 'https://[::ffff:127.0.0.1]/live.mp3' })), null);
  assert.equal(normalizeRadioBrowserStation(station({ lastcheckok: 0 })), null);
  assert.equal(normalizeRadioBrowserStation(station({ hls: 1 })), null);
  assert.equal(publicRadioHttpsUrl('https://[::1]/stream'), null);
});

test('catalog endpoint stations are reconstructed from the public field allowlist', () => {
  const stationRecord = {
    ...normalizeRadioBrowserStation(station()),
    internalExtension: { shouldNotCrossBoundary: true },
  };
  const publicStation = publicRadioStation(stationRecord);
  assert.deepEqual(Object.keys(publicStation), [
    'id', 'name', 'lat', 'lon', 'streamUrl', 'homepage', 'tags', 'languages',
    'state', 'country', 'countryCode', 'metadataTrust', 'codec', 'bitrate',
  ]);
  assert.equal('clickCount' in publicStation, false);
  assert.equal('internalExtension' in publicStation, false);
  assert.equal(publicStation.metadataTrust, 'untrusted-community');
});

test('proxy coalesces refreshes, omits favicons, and counts known stations only', async () => {
  let fetchCount = 0;
  const fetchImpl = async (url) => {
    fetchCount += 1;
    if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
    if (String(url).includes('/json/stations/search')) return responseJson([station()]);
    if (String(url).includes(`/json/url/${UUID}`)) return responseJson({ ok: 'true' });
    return responseJson({}, 404);
  };
  const middleware = createProxy({ fetchImpl });
  const [first, second] = await Promise.all([
    invoke(middleware, '/stations'),
    invoke(middleware, '/stations'),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const body = JSON.parse(first.body);
  assert.equal(body.stations.length, 1);
  assert.equal(body.acceptedGeneration, null);
  assert.equal('favicon' in body.stations[0], false);
  assert.equal(fetchCount, 10, 'one discovery plus nine shared catalog queries');

  const unknown = await invoke(middleware, '/click/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'POST');
  assert.equal(unknown.status, 404);
  const known = await invoke(middleware, `/click/${UUID}`, 'POST');
  assert.equal(known.status, 204);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCount, 11);
});

test('method and route validation happen before any upstream refresh', async () => {
  let fetchCount = 0;
  const middleware = createProxy({
    fetchImpl: async () => { fetchCount += 1; return responseJson([]); },
  });
  assert.equal((await invoke(middleware, '/stations', 'POST')).status, 405);
  assert.equal((await invoke(middleware, '/click/not-a-uuid', 'POST')).status, 404);
  assert.equal((await invoke(middleware, '/anything')).status, 404);
  assert.equal(fetchCount, 0);
});

test('a failed refresh serves the bounded previous catalog as stale', async () => {
  let clock = 1_000_000;
  let fail = false;
  const fetchImpl = async (url) => {
    if (fail) throw new Error('offline');
    if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
    return responseJson(healthyRowsForQuery(url));
  };
  const middleware = createProxy({ fetchImpl, now: () => clock });
  assert.equal((await invoke(middleware, '/stations')).status, 200);
  clock += 46 * 60 * 1000;
  fail = true;
  const stale = await invoke(middleware, '/stations');
  assert.equal(stale.status, 200);
  assert.equal(JSON.parse(stale.body).stale, true);
});

test('malformed successful specialist payloads cannot replace a healthy warm catalog', async () => {
  let clock = 3_000_000;
  let malformed = false;
  const replacementRows = catalogRows('40000000');
  const middleware = createProxy({
    now: () => clock,
    fetchImpl: async (url) => {
      if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
      const parsed = new URL(String(url));
      if (!malformed) return responseJson(healthyRowsForQuery(url));
      if (!parsed.searchParams.has('tag')) return responseJson(replacementRows);
      return responseJson({ error: 'partial outage' });
    },
  });
  const healthy = JSON.parse((await invoke(middleware, '/stations')).body);
  clock += 46 * 60 * 1000;
  malformed = true;
  const retained = JSON.parse((await invoke(middleware, '/stations')).body);
  assert.equal(retained.coverage.successfulQueries, 1);
  assert.equal(retained.degraded, true);
  assert.equal(retained.stale, true);
  assert.equal(retained.updatedAt, healthy.updatedAt);
  assert.equal(healthy.acceptedGeneration, 1);
  assert.equal(retained.acceptedGeneration, healthy.acceptedGeneration);
  assert.equal(retained.stations[0].id, healthy.stations[0].id);
});

test('each middleware instance scopes its generation sequence with a stable unique token', async () => {
  const fetchImpl = async (url) => String(url).includes('/json/servers')
    ? responseJson([{ name: 'de1.api.radio-browser.info' }])
    : responseJson(healthyRowsForQuery(url));
  const first = createProxy({ fetchImpl, now: () => 4_000_000 });
  const second = createProxy({ fetchImpl, now: () => 4_000_000 });
  const a1 = JSON.parse((await invoke(first, '/stations')).body);
  const a2 = JSON.parse((await invoke(first, '/stations')).body);
  const b1 = JSON.parse((await invoke(second, '/stations')).body);
  assert.equal(typeof a1.catalogInstance, 'string');
  assert.ok(a1.catalogInstance.length > 0);
  assert.equal(a1.catalogInstance, a2.catalogInstance, 'token is stable within one instance');
  assert.notEqual(a1.catalogInstance, b1.catalogInstance, 'a restarted producer presents a new token');
  assert.equal(a1.acceptedGeneration, 1);
  assert.equal(b1.acceptedGeneration, 1);
});

test('schema-valid specialist rows rejected by normalization do not count toward warm-cache replacement', async () => {
  let clock = 3_500_000;
  let unhealthy = false;
  const replacementRows = catalogRows('40000000');
  const middleware = createProxy({
    now: () => clock,
    fetchImpl: async (url) => {
      if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
      const parsed = new URL(String(url));
      if (!unhealthy) return responseJson(healthyRowsForQuery(url));
      if (!parsed.searchParams.has('tag')) return responseJson(replacementRows);
      // The row is structurally valid but fails the product's accepted-row
      // policy, so these specialist responses must count as failed coverage.
      return responseJson([station({ lastcheckok: 0 })]);
    },
  });
  const healthy = JSON.parse((await invoke(middleware, '/stations')).body);
  clock += 46 * 60 * 1000;
  unhealthy = true;
  const retained = JSON.parse((await invoke(middleware, '/stations')).body);
  assert.equal(retained.coverage.successfulQueries, 1);
  assert.equal(retained.degraded, true);
  assert.equal(retained.stale, true);
  assert.equal(retained.updatedAt, healthy.updatedAt);
  assert.equal(retained.stations[0].id, healthy.stations[0].id);
});

test('accepted music-only specialist responses cannot replace a healthy warm catalog', async () => {
  let clock = 3_750_000;
  let mismatched = false;
  const replacementRows = catalogRows('40000000', 'music,pop');
  const middleware = createProxy({
    now: () => clock,
    fetchImpl: async (url) => {
      if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
      if (!mismatched) return responseJson(healthyRowsForQuery(url));
      return responseJson(replacementRows);
    },
  });
  const healthy = JSON.parse((await invoke(middleware, '/stations')).body);
  assert.equal(healthy.degraded, false);
  assert.equal(healthy.coverage.successfulQueries, 9);

  clock += 46 * 60 * 1000;
  mismatched = true;
  const retained = JSON.parse((await invoke(middleware, '/stations')).body);
  assert.equal(retained.coverage.successfulQueries, 1);
  assert.equal(retained.degraded, true);
  assert.equal(retained.stale, true);
  assert.equal(retained.updatedAt, healthy.updatedAt);
  assert.equal(retained.stations[0].id, healthy.stations[0].id);
});

test('specialist health credit requires matching tags rather than a matching station name', async () => {
  const middleware = createProxy({
    fetchImpl: async (url) => {
      if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
      const tag = queryTag(url);
      return responseJson(catalogRows('50000000', 'music,pop').map((row) => ({
        ...row,
        name: tag ? `${tag} Radio ${row.name}` : row.name,
      })));
    },
  });
  const result = await invoke(middleware, '/stations');
  const body = JSON.parse(result.body);
  assert.equal(result.status, 200);
  assert.equal(body.coverage.successfulQueries, 1);
  assert.equal(body.degraded, true);
  assert.match(body.degradedReason, /query-coverage-below-policy/);
});

test('specialist health credit follows normalized embedded-tag category semantics', async () => {
  const embeddedTags = {
    news: 'Local_NEWS_Update',
    talk: 'Community-TALK-Show',
    weather: 'Severe WEATHER Alerts',
    emergency: 'Emergency_Dispatch',
    scanner: 'Police-Scanner-Radio',
    aviation: 'Civil AVIATION Radio',
    marine: 'Coastal-Marine-Radio',
    traffic: 'Daily_TRAFFIC_Reports',
  };
  const middleware = createProxy({
    fetchImpl: async (url) => {
      if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
      const tag = queryTag(url);
      return responseJson(catalogRows('60000000', tag ? embeddedTags[tag] : 'music'));
    },
  });
  const result = await invoke(middleware, '/stations');
  const body = JSON.parse(result.body);
  assert.equal(result.status, 200);
  assert.equal(body.coverage.successfulQueries, 9);
  assert.equal(body.coverage.stationCount, 400);
  assert.equal(body.degraded, false);
});

test('a cold partial catalog is explicit degraded data while zero usable rows are unavailable', async () => {
  const partial = createProxy({
    fetchImpl: async (url) => {
      if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
      const parsed = new URL(String(url));
      if (!parsed.searchParams.has('tag')) return responseJson([station()]);
      throw new Error('specialist query unavailable');
    },
  });
  const partialResult = await invoke(partial, '/stations');
  const partialBody = JSON.parse(partialResult.body);
  assert.equal(partialResult.status, 200);
  assert.equal(partialBody.stations.length, 1);
  assert.equal(partialBody.stale, false);
  assert.equal(partialBody.degraded, true);
  assert.equal(partialBody.acceptedGeneration, null);
  assert.match(partialBody.degradedReason, /query-coverage-below-policy/);

  const empty = createProxy({
    fetchImpl: async (url) => String(url).includes('/json/servers')
      ? responseJson([{ name: 'de1.api.radio-browser.info' }])
      : responseJson([]),
  });
  const emptyResult = await invoke(empty, '/stations');
  assert.equal(emptyResult.status, 503);
  assert.equal(JSON.parse(emptyResult.body).degraded, true);
});

test('production normalization supports country-name and ISO request filtering', () => {
  const france = normalizeRadioBrowserStation(station({ country: 'France', countrycode: 'FR' }));
  assert.equal(rankRadioStationsForRequest([france], { country: 'FR' })[0].id, UUID);
  assert.equal(rankRadioStationsForRequest([france], { country: ' france ' })[0].id, UUID);
});

test('catalog generations advance only after healthy admission and survive degraded refreshes', async () => {
  let clock = 5_000_000;
  let mode = 'healthy-a';
  const middleware = createProxy({
    now: () => clock,
    fetchImpl: async (url) => {
      if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
      if (mode === 'degraded') return responseJson(queryTag(url) ? [] : catalogRows('70000000'));
      return responseJson(healthyRowsForQuery(url, mode === 'healthy-a' ? '71000000' : '72000000'));
    },
  });
  const first = JSON.parse((await invoke(middleware, '/stations')).body);
  assert.equal(first.acceptedGeneration, 1);
  assert.equal(first.degraded, false);

  clock += 46 * 60 * 1000;
  mode = 'degraded';
  const retained = JSON.parse((await invoke(middleware, '/stations')).body);
  assert.equal(retained.acceptedGeneration, 1);
  assert.equal(retained.stale, true);
  assert.equal(retained.stations[0].id, first.stations[0].id);

  clock += 46 * 60 * 1000;
  mode = 'healthy-b';
  const recovered = JSON.parse((await invoke(middleware, '/stations')).body);
  assert.equal(recovered.acceptedGeneration, 2);
  assert.notEqual(recovered.stations[0].id, first.stations[0].id);
});

test('catalog response is hard-capped at 750 normalized stations', async () => {
  const rows = Array.from({ length: 810 }, (_, index) => station({
    stationuuid: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    name: `Station ${index}`,
    geo_lat: -70 + (index % 140),
    geo_long: -175 + (index % 350),
    clickcount: 1000 - index,
  }));
  const middleware = createProxy({
    fetchImpl: async (url) => String(url).includes('/json/servers')
      ? responseJson([{ name: 'de1.api.radio-browser.info' }])
      : responseJson(rows),
  });
  const result = await invoke(middleware, '/stations');
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).stations.length, 750);
});

test('resolved Radio Browser addresses reject local, private, link-local, metadata, and IPv6-local forms', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '192.0.2.9',
    '192.88.99.9',
    '198.51.100.9',
    '203.0.113.9',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    '64:ff9b::c0a8:101',
    '100::1',
    '2001:2::1',
    '2001:db8::1',
    '2002:c0a8:101::',
    '3fff::1',
  ]) {
    assert.equal(isPublicRadioAddress(address), false, address);
  }
  assert.equal(isPublicRadioAddress('93.184.216.34'), true);
  assert.equal(isPublicRadioAddress('2606:2800:220:1:248:1893:25c8:1946'), true);
  assert.equal(publicRadioHttpsUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/stream'), null);
});

test('proxy refuses redirects before following every forbidden and off-policy target class', async () => {
  const targets = [
    'http://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/private',
    'https://10.0.0.1/private',
    'https://192.168.1.1/private',
    'https://[::1]/private',
    'https://public.example.org/off-policy',
    'https://de1.api.radio-browser.info/not-an-allowed-path',
  ];
  for (const location of targets) {
    let fetchCount = 0;
    const middleware = createProxy({
      fetchImpl: async (_url, options) => {
        fetchCount += 1;
        assert.equal(options.redirect, 'manual');
        return new Response('', { status: 302, headers: { Location: location } });
      },
    });
    const result = await invoke(middleware, '/stations');
    assert.equal(result.status, 503, location);
    assert.ok(fetchCount > 0, location);
  }
});

test('proxy rejects any hostname resolution containing a forbidden address before fetch', async () => {
  let fetchCount = 0;
  for (const addresses of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '198.51.100.9', family: 4 }],
    [{ address: '203.0.113.9', family: 4 }],
    [{ address: '2001:db8::1', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: 'fd00::1', family: 6 }],
  ]) {
    const middleware = createRadioProxyMiddleware({
      lookupImpl: async () => addresses,
      fetchImpl: async () => {
        fetchCount += 1;
        return responseJson([]);
      },
    });
    assert.equal((await invoke(middleware, '/stations')).status, 503);
  }
  assert.equal(fetchCount, 0);
});

// Answer every pinned request with `status`, invoking the response callback
// asynchronously as `https.request` does, outside the caller's promise.
// The returned promise rejects on an uncaught exception, so a regression fails
// the race at once instead of leaving the fetch pending.
function mockMirrorStatus(t, status, statusMessage = '') {
  let crash;
  const crashed = new Promise((_resolve, reject) => (crash = reject));
  const onUncaught = (error) =>
    crash(new Error(`uncaught exception: ${error.message}`));
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  t.mock.method(https, 'request', (_url, _options, callback) => {
    const request = new EventEmitter();
    request.end = () =>
      setImmediate(() =>
        callback(
          Object.assign(Readable.from([]), {
            statusCode: status,
            statusMessage,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
    return request;
  });
  return crashed;
}

function fetchMirror() {
  return fetchPinnedRadioResponse(
    new URL('https://de1.api.radio-browser.info/json/servers'),
    { headers: {} },
    [{ address: '93.184.216.34', family: 4 }],
  );
}

for (const status of [204, 205, 304]) {
  test(`a mirror answering null-body status ${status} resolves with a null body instead of crashing`, async (t) => {
    const crashed = mockMirrorStatus(t, status);
    const response = await Promise.race([fetchMirror(), crashed]);
    assert.equal(response.status, status);
    assert.equal(response.body, null);
  });
}

for (const status of [600, 999]) {
  test(`a mirror answering out-of-range status ${status} rejects instead of crashing`, async (t) => {
    const crashed = mockMirrorStatus(t, status);
    await assert.rejects(
      Promise.race([fetchMirror(), crashed]),
      new RegExp(`unsupported status ${status}`),
    );
  });
}

test('a mirror answering an invalid reason phrase rejects instead of crashing', async (t) => {
  const crashed = mockMirrorStatus(t, 200, 'OK\x7f');
  await assert.rejects(Promise.race([fetchMirror(), crashed]), TypeError);
});

test('priority-country configuration is bounded, normalized and validated before requests', async () => {
  const { parseRadioPriorityCountries } = await import('../../server/providers/radio/catalog.js');
  assert.deepEqual(parseRadioPriorityCountries(' in, PL,in, '), ['IN', 'PL']);
  assert.deepEqual(parseRadioPriorityCountries(''), []);
  for (const value of ['ZZ', 'India', 'IN&limit=9999', 'US,CA,IN,PL,DE,FR,GB,JP,AU']) {
    assert.throws(() => createProxy({ priorityCountries: value }), /RADIO_PRIORITY_COUNTRIES/);
  }
});

test('low-click country stations survive a full global catalog, with bounded cached queries and deduplication', async () => {
  const calls = [];
  let active = 0;
  let peak = 0;
  const middleware = createProxy({
    priorityCountries: 'IN,PL',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname === '/json/servers') return responseJson([{ name: 'de1.api.radio-browser.info' }]);
      if (parsed.pathname.startsWith('/json/url/')) return responseJson({ ok: true });
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      const country = parsed.searchParams.get('countrycode');
      if (country) {
        assert.equal(parsed.searchParams.get('limit'), '200');
        assert.equal(parsed.searchParams.get('is_https'), 'true');
        const rows = catalogRows(country === 'IN' ? '10000000' : '20000000', 'community', 60)
          .map((row) => ({ ...row, countrycode: country, clickcount: 0 }));
        return responseJson([rows[0], ...rows]);
      }
      return responseJson(catalogRows('30000000', queryTag(url) || 'news', 900));
    },
  });
  const responses = await Promise.all([invoke(middleware, '/stations'), invoke(middleware, '/stations')]);
  const body = JSON.parse(responses[0].body);
  assert.equal(body.degraded, false);
  assert.equal(body.stations.length, 750);
  assert.equal(new Set(body.stations.map((row) => row.id)).size, 750);
  for (const country of ['IN', 'PL'])
    assert.ok(body.stations.filter((row) => row.countryCode === country).length >= 40);
  assert.ok(body.stations.some((row) => row.countryCode === 'US'));
  assert.equal(calls.filter((url) => url.pathname.includes('/stations/')).length, 11);
  assert.ok(peak <= 3);
  const count = calls.length;
  await invoke(middleware, '/stations');
  assert.equal(calls.length, count, 'country queries share the 45-minute cache');
  const id = body.stations.find((row) => row.countryCode === 'IN').id;
  assert.equal((await invoke(middleware, `/click/${id}`, 'POST')).status, 204);
});

test('country failures never block cold or warm global catalog admission, even after seven days', async () => {
  for (const coldFailure of [false, true]) {
    let clock = 4_000_000;
    let fail = coldFailure;
    let calls = 0;
    const middleware = createProxy({
      priorityCountries: ['IN'], now: () => clock,
      fetchImpl: async (url) => {
        calls++;
        if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
        if (new URL(url).searchParams.has('countrycode')) {
          if (fail) throw new Error('offline');
          return responseJson([station({ countrycode: 'IN', country: 'India', tags: 'community' })]);
        }
        return responseJson(healthyRowsForQuery(url));
      },
    });
    let generation = 0;
    for (const elapsed of [0, 46 * 60 * 1000, 8 * 24 * 60 * 60 * 1000]) {
      clock += elapsed;
      if (elapsed) fail = true;
      const response = await invoke(middleware, '/stations');
      const body = JSON.parse(response.body);
      assert.equal(response.status, 200);
      assert.equal(body.stale, false);
      assert.equal(body.degraded, false);
      assert.ok(body.acceptedGeneration > generation);
      generation = body.acceptedGeneration;
      assert.equal(body.coverage.priorityCountries[0].succeeded, !fail);
      assert.equal(body.coverage.priorityCountries[0].stationCount, fail ? 0 : 1);
      const count = calls;
      clock += 60_001;
      assert.deepEqual(JSON.parse((await invoke(middleware, '/stations')).body), body);
      assert.equal(calls, count, 'country failure does not shorten the healthy cache');
    }
  }
});

test('valid countries with no eligible stations are accepted and cached; malformed country responses stay isolated', async () => {
  for (const mode of ['wrong', 'oversized', 'empty', 'ineligible', 'malformed']) {
    let clock = 4_000_000;
    let calls = 0;
    const middleware = createProxy({
      priorityCountries: ['IN'], now: () => clock,
      fetchImpl: async (url) => {
        calls++;
        if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
        if (new URL(url).searchParams.has('countrycode')) {
          const rows = {
            empty: [], wrong: [station()], malformed: [{ name: 'missing fields' }],
            oversized: catalogRows('10000000', 'community', 201).map((row) => ({ ...row, countrycode: 'IN' })),
            ineligible: [{ hls: 1 }, { codec: 'OGG' }, { codec: 'OPUS' }, { url_resolved: 'https://127.0.0.1/live.mp3' }]
              .map((overrides) => station({ countrycode: 'IN', ...overrides })),
          };
          return responseJson(rows[mode]);
        }
        return responseJson(healthyRowsForQuery(url));
      },
    });
    const response = await invoke(middleware, '/stations');
    const body = JSON.parse(response.body);
    assert.equal(response.status, 200, mode);
    assert.equal(body.degraded, false, mode);
    assert.ok(body.acceptedGeneration > 0, mode);
    assert.equal(body.coverage.priorityCountries[0].stationCount, 0, mode);
    assert.equal(body.coverage.priorityCountries[0].succeeded, !['oversized', 'malformed'].includes(mode), mode);
    const count = calls;
    clock += 44 * 60 * 1000;
    assert.deepEqual(JSON.parse((await invoke(middleware, '/stations')).body), body);
    assert.equal(calls, count, `${mode} country response preserves the 45-minute cache`);
  }
});

for (const priorityCountries of ['', 'IN']) {
  test(`cold failures coalesce, bound mirrors and back off with priority countries ${priorityCountries || 'unset'}`, async () => {
    let clock = Date.UTC(2026, 0, 1);
    let calls = 0;
    let offline = true;
    const middleware = createProxy({
      priorityCountries, now: () => clock,
      fetchImpl: async (url) => {
        calls++;
        if (String(url).includes('/json/servers')) return responseJson([{ name: 'de1.api.radio-browser.info' }]);
        if (offline) throw new Error('offline');
        if (new URL(url).searchParams.has('countrycode')) return responseJson([]);
        return responseJson(healthyRowsForQuery(url));
      },
    });
    const responses = await Promise.all([invoke(middleware, '/stations'), invoke(middleware, '/stations')]);
    assert.ok(responses.every((response) => response.status === 503));
    const initial = calls;
    assert.equal(initial, 1 + (priorityCountries ? 10 : 9) * 3, 'one discovery and at most three mirrors per query');
    offline = false;
    clock += 59_999;
    assert.equal((await invoke(middleware, '/stations')).status, 503);
    assert.equal(calls, initial);
    clock += 2;
    const recovered = await invoke(middleware, '/stations');
    assert.equal(recovered.status, 200);
    assert.equal(JSON.parse(recovered.body).degraded, false);
    assert.ok(calls > initial);
    const afterRecovery = calls;
    await invoke(middleware, '/stations');
    assert.equal(calls, afterRecovery);
  });
}
