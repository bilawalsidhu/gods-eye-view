import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OCM_EXCLUDED_PROVIDER_IDS,
  OCM_MAX_RESULTS,
  ocmLicenceLabel,
  ocmPoiUrl,
  ocmProviderIsOpen,
  indexReferenceData,
  openChargeMapProxy,
  quantizeOcmBox,
  trimOcmSite,
  validOcmBox,
} from './openChargeMap.js';
import { localProviderPlugins } from './local.js';
import {
  OCM_FIXTURE_POIS,
  OCM_FIXTURE_REFERENCE,
} from './openChargeMapFixture.mjs';

const KEY = 'ocm-fixture-key-7f3a';
/** Central Oslo, as the EV layer would ask for it. */
const OSLO = 'south=59.905&west=10.735&north=59.918&east=10.755';
const clone = (value) => JSON.parse(JSON.stringify(value));

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.deepEqual([...routes.keys()], ['/api/ocm']);
  return async (url = '/', { method = 'GET', headers = {} } = {}) => {
    const res = {
      headersSent: false,
      headers: {},
      set statusCode(status) {
        this.status = status;
      },
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get('/api/ocm')({ url, method, headers, socket: {} }, res);
    return { status: res.status, body: JSON.parse(res.body), raw: res.body };
  };
}

/** Set (or clear) the key for one test and silence the proxy's warnings. */
function withKey(t, key) {
  const previous = process.env.OPEN_CHARGE_MAP_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.OPEN_CHARGE_MAP_API_KEY;
    else process.env.OPEN_CHARGE_MAP_API_KEY = previous;
  });
  if (key === null) delete process.env.OPEN_CHARGE_MAP_API_KEY;
  else process.env.OPEN_CHARGE_MAP_API_KEY = key;
  t.mock.method(console, 'warn', () => {});
}

/** A stub upstream over the fixtures; `poi(url)` may replace the POI answer. */
function upstream({ pois = OCM_FIXTURE_POIS, poi } = {}) {
  const calls = [];
  const fetchImpl = async (raw, init) => {
    const url = new URL(raw);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://api.openchargemap.io');
    if (url.pathname === '/v3/referencedata/')
      return Response.json(OCM_FIXTURE_REFERENCE);
    assert.equal(url.pathname, '/v3/poi/');
    return poi ? poi(url) : Response.json(pois);
  };
  return {
    fetchImpl,
    calls,
    poiCalls: () => calls.filter(({ url }) => url.pathname === '/v3/poi/'),
  };
}

test('the POI URL is built only from the snapped box, never with the key', () => {
  const box = quantizeOcmBox({
    south: 59.9051,
    west: 10.7349,
    north: 59.9179,
    east: 10.7551,
  });
  assert.deepEqual(box, {
    south: 59.9,
    west: 10.73,
    north: 59.92,
    east: 10.76,
  });
  const url = new URL(ocmPoiUrl(box));
  assert.equal(
    url.origin + url.pathname,
    'https://api.openchargemap.io/v3/poi/',
  );
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    output: 'json',
    boundingbox: '(59.92,10.73),(59.9,10.76)',
    maxresults: String(OCM_MAX_RESULTS),
    compact: 'true',
    verbose: 'false',
    opendata: 'true',
  });
  assert.ok(!/key/i.test(url.search));
});

test('bbox numbers are validated strictly', () => {
  const ok = validOcmBox(new URLSearchParams(OSLO));
  assert.deepEqual(ok, {
    south: 59.905,
    west: 10.735,
    north: 59.918,
    east: 10.755,
  });
  for (const query of [
    '',
    'south=59.9&west=10.7&north=59.92',
    'south=&west=10.7&north=59.92&east=10.8',
    'south=abc&west=10.7&north=59.92&east=10.8',
    'south=Infinity&west=10.7&north=59.92&east=10.8',
    'south=59.92&west=10.7&north=59.9&east=10.8',
    'south=59.9&west=10.8&north=59.92&east=10.8',
    'south=-91&west=10.7&north=59.92&east=10.8',
    'south=59.9&west=10.7&north=59.92&east=181',
  ])
    assert.equal(validOcmBox(new URLSearchParams(query)), null, query);
});

test('without a key: status says so, POI reads answer no_key, upstream is untouched', async (t) => {
  withKey(t, null);
  const stub = upstream();
  const request = install(openChargeMapProxy({ fetchImpl: stub.fetchImpl }));
  assert.deepEqual((await request('/status')).body, { hasKey: false });
  const poi = await request(`/poi?${OSLO}`);
  assert.equal(poi.status, 503);
  assert.deepEqual(poi.body, { error: 'no_key' });
  withKey(t, '   ');
  assert.deepEqual((await request('/status')).body, { hasKey: false });
  assert.equal((await request(`/poi?${OSLO}`)).status, 503);
  assert.equal(stub.calls.length, 0);
});

test('bad boxes, wide boxes, other methods and other paths fail before upstream', async (t) => {
  withKey(t, KEY);
  const stub = upstream();
  const request = install(openChargeMapProxy({ fetchImpl: stub.fetchImpl }));
  assert.deepEqual(await request('/poi?south=1&west=2'), {
    status: 400,
    body: { error: 'invalid_bbox' },
    raw: '{"error":"invalid_bbox"}',
  });
  const wide = await request('/poi?south=59.5&west=10.5&north=60.1&east=10.8');
  assert.equal(wide.status, 400);
  assert.deepEqual(wide.body, { error: 'bbox_too_large' });
  assert.equal((await request(`/poi?${OSLO}`, { method: 'POST' })).status, 405);
  assert.equal((await request('/poi/../../v3/poi')).status, 404);
  assert.equal(
    (await request(`/poi?${OSLO}&url=https://evil.example/`)).status,
    200,
  );
  // The stray `url` parameter was not forwarded: only the fixed URL was read.
  for (const { url } of stub.calls)
    assert.equal(url.origin, 'https://api.openchargemap.io');
  assert.equal(stub.poiCalls().length, 1);
});

test('a cross-site browser request is refused before anything else', async (t) => {
  withKey(t, KEY);
  const stub = upstream();
  const request = install(openChargeMapProxy({ fetchImpl: stub.fetchImpl }));
  const refused = await request(`/poi?${OSLO}`, {
    headers: {
      host: 'localhost:5173',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    },
  });
  assert.equal(refused.status, 403);
  assert.equal(stub.calls.length, 0);
});

test('a keyed read sends the key only as a header, keeps open records and never echoes the key', async (t) => {
  withKey(t, KEY);
  const stub = upstream();
  const request = install(openChargeMapProxy({ fetchImpl: stub.fetchImpl }));
  const read = await request(`/poi?${OSLO}`);
  assert.equal(read.status, 200);
  for (const { url, init } of stub.calls) {
    assert.equal(init.headers['X-API-Key'], KEY);
    assert.ok(!url.href.includes(KEY));
  }
  assert.ok(!read.raw.includes(KEY));
  assert.ok(!JSON.stringify((await request('/status')).body).includes(KEY));
  // Six fixture POIs: provider 26 (Oplaadpalen.nl) is dropped.
  assert.deepEqual(
    read.body.sites.map((site) => site.id),
    [46230, 68766, 46188, 97830, 37737],
  );
  assert.equal(read.body.count, 5);
  assert.equal(read.body.stale, false);
  assert.equal(read.body.saturated, false);
  const onePark = read.body.sites.find((site) => site.id === 68766);
  assert.deepEqual(onePark, {
    id: 68766,
    latitude: 59.9108058,
    longitude: 10.750935600000048,
    title: 'OnePark Oslo S',
    operator: 'Charge & Drive (Fortum - NO)',
    address: 'Jernbanetorget 1, Oslo',
    status: { id: 50, operational: true },
    lastStatusUpdate: Date.parse('2016-06-22T03:26:00Z'),
    connections: [
      {
        type: 'Type 2 (Socket Only)',
        powerKw: 12,
        quantity: 2,
        status: { id: 50, operational: true },
      },
      {
        type: 'Type 2 (Socket Only)',
        powerKw: 36,
        quantity: 4,
        status: { id: 50, operational: true },
      },
      {
        type: 'Type 2 (Socket Only)',
        powerKw: 7,
        quantity: 2,
        status: { id: 50, operational: true },
      },
    ],
    numberOfPoints: 8,
    usageCost: null,
    provider: {
      id: 1,
      name: 'Open Charge Map Contributors',
      licence: 'CC BY 4.0',
      licenceText:
        'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)',
      url: 'http://openchargemap.org/',
    },
  });
  const nobil = read.body.sites.find((site) => site.id === 46188);
  assert.equal(nobil.provider.name, 'NOBIL');
  assert.equal(nobil.provider.licence, 'CC BY 4.0');
  assert.equal(nobil.status, null);
  // The "(Unknown Operator)" placeholder is no operator.
  assert.equal(nobil.operator, null);
});

test('the licence filter keeps only open, non-excluded providers', () => {
  const refs = indexReferenceData(OCM_FIXTURE_REFERENCE);
  const byId = (id) => refs.providers.get(id);
  assert.equal(ocmProviderIsOpen(byId(1)), true);
  assert.equal(ocmProviderIsOpen(byId(19)), true);
  // Oplaadpalen.nl is flagged open upstream but is CC BY-NC-SA.
  assert.equal(byId(26).IsOpenDataLicensed, true);
  assert.equal(OCM_EXCLUDED_PROVIDER_IDS.has(26), true);
  assert.equal(ocmProviderIsOpen(byId(26)), false);
  // Mobie.pt is flagged open, but only "redistributed by agreement" with OCM.
  assert.equal(byId(7).IsOpenDataLicensed, true);
  assert.equal(ocmProviderIsOpen(byId(7)), false);
  // CarStations.com (false) and e-Laad (null) are not open data.
  assert.equal(byId(15).IsOpenDataLicensed, false);
  assert.equal(ocmProviderIsOpen(byId(15)), false);
  assert.equal(byId(14).IsOpenDataLicensed, null);
  assert.equal(ocmProviderIsOpen(byId(14)), false);
  assert.equal(
    ocmProviderIsOpen({ ID: 99, IsOpenDataLicensed: 'true' }),
    false,
  );
  assert.equal(ocmProviderIsOpen(undefined), false);

  const [base] = OCM_FIXTURE_POIS;
  const as = (DataProviderID) => trimOcmSite({ ...base, DataProviderID }, refs);
  assert.equal(as(1)?.id, 46230);
  assert.equal(as(19)?.provider.name, 'NOBIL');
  for (const id of [7, 26, 15, 14, 999, undefined, null])
    assert.equal(as(id), null, `provider ${id}`);
});

test('the proxy drops every non-open provider it is sent, whatever the upstream filter did', async (t) => {
  withKey(t, KEY);
  const [base] = OCM_FIXTURE_POIS;
  const pois = [1, 14, 15, 19, 26, 999].map((DataProviderID, index) => ({
    ...clone(base),
    ID: 1000 + index,
    DataProviderID,
  }));
  const stub = upstream({ pois });
  const request = install(openChargeMapProxy({ fetchImpl: stub.fetchImpl }));
  const read = await request(`/poi?${OSLO}`);
  assert.deepEqual(
    read.body.sites.map((site) => [site.id, site.provider.id]),
    [
      [1000, 1],
      [1003, 19],
    ],
  );
});

test('a trimmed site carries no comments, media, contact or reference fields', () => {
  const refs = indexReferenceData(OCM_FIXTURE_REFERENCE);
  const poi = {
    ...clone(OCM_FIXTURE_POIS[4]),
    UserComments: [{ UserName: 'someone', Comment: 'hi' }],
    MediaItems: [{ ItemURL: 'https://media.example/x.jpg' }],
    GeneralComments: 'free text',
  };
  poi.AddressInfo.ContactTelephone1 = '22 55 54 24';
  const site = trimOcmSite(poi, refs);
  assert.equal(site.usageCost, '0.00 jaarabonnement');
  const textOut = JSON.stringify(site);
  for (const leaked of ['someone', 'media.example', 'free text', '22 55'])
    assert.ok(!textOut.includes(leaked), leaked);
  // A removed listing is history, not a station.
  assert.equal(trimOcmSite({ ...poi, StatusTypeID: 200 }, refs), null);
  assert.equal(
    trimOcmSite({ ...poi, AddressInfo: { Latitude: 91, Longitude: 4 } }, refs),
    null,
  );
});

test('licence labels are short only when the licence text is recognised', () => {
  for (const [text, label] of [
    [
      'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)',
      'CC BY 4.0',
    ],
    [
      'Provided by Bundesnetzagentur.de under the CC-BY 4.0 license',
      'CC BY 4.0',
    ],
    ['http://creativecommons.org/licenses/by/3.0', 'CC BY 3.0'],
    ['CC-0', 'CC0'],
    ['Licensed under CC0 by data sharing agreement', 'CC0'],
    ['CC-BY', 'CC BY'],
    [
      'Contains public sector information licensed under the Open Government Licence v2.0.',
      'OGL v2.0',
    ],
    ['Public Data redistributed by agreement', null],
    [null, null],
  ])
    assert.equal(ocmLicenceLabel(text), label, String(text));
});

test('answers are cached per snapped box; a failed refresh serves the last one as stale', async (t) => {
  withKey(t, KEY);
  let now = Date.UTC(2026, 9, 24, 12);
  let failing = false;
  const stub = upstream({
    poi: () =>
      failing
        ? new Response('upstream says no', { status: 500 })
        : Response.json(OCM_FIXTURE_POIS),
  });
  const request = install(
    openChargeMapProxy({ fetchImpl: stub.fetchImpl, now: () => now }),
  );
  await request(`/poi?${OSLO}`);
  // A nearby view inside the same 0.01° cells shares the answer.
  await request('/poi?south=59.906&west=10.736&north=59.917&east=10.754');
  assert.equal(stub.poiCalls().length, 1);
  // Concurrent reads of a new box share one refresh.
  const other = 'south=59.93&west=10.70&north=59.94&east=10.71';
  await Promise.all([request(`/poi?${other}`), request(`/poi?${other}`)]);
  assert.equal(stub.poiCalls().length, 2);
  // Reference data is read once for every box.
  assert.equal(stub.calls.length - stub.poiCalls().length, 1);
  now += 11 * 60_000;
  failing = true;
  const stale = await request(`/poi?${OSLO}`);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.count, 5);
  assert.equal(stub.poiCalls().length, 3);
  failing = false;
  const fresh = await request(`/poi?${OSLO}`);
  assert.equal(fresh.body.stale, false);
  assert.equal(stub.poiCalls().length, 4);
});

test('upstream failures become fixed bodies with no upstream text', async (t) => {
  withKey(t, KEY);
  const cases = [
    [
      () => new Response('You must specify an API key', { status: 403 }),
      502,
      { error: 'upstream', upstreamStatus: 403 },
    ],
    [
      () => new Response('slow down', { status: 429 }),
      429,
      { error: 'rate_limited' },
    ],
    [
      () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
      504,
      { error: 'timeout' },
    ],
    [
      () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND');
      },
      502,
      { error: 'network' },
    ],
    [() => new Response('<html>oops</html>'), 502, { error: 'malformed' }],
    [() => Response.json({ not: 'a list' }), 502, { error: 'malformed' }],
  ];
  for (const [answer, status, body] of cases) {
    const stub = upstream({ poi: answer });
    const request = install(openChargeMapProxy({ fetchImpl: stub.fetchImpl }));
    const read = await request(`/poi?${OSLO}`);
    assert.equal(read.status, status);
    assert.deepEqual(read.body, body);
    assert.ok(!/API key|slow|timed out|ENOTFOUND|oops/.test(read.raw));
  }
});

test('a 403 on the reference data fails the read in the same fixed form', async (t) => {
  withKey(t, KEY);
  const request = install(
    openChargeMapProxy({
      fetchImpl: async () => new Response('bad key', { status: 403 }),
    }),
  );
  const read = await request(`/poi?${OSLO}`);
  assert.equal(read.status, 502);
  assert.deepEqual(read.body, { error: 'upstream', upstreamStatus: 403 });
});

test('the process asks upstream for at most 30 boxes a minute', async (t) => {
  withKey(t, KEY);
  let now = Date.UTC(2026, 9, 24, 12);
  const stub = upstream();
  const request = install(
    openChargeMapProxy({ fetchImpl: stub.fetchImpl, now: () => now }),
  );
  const box = (i) =>
    `/poi?south=${50 + i * 0.1}&west=10&north=${50.05 + i * 0.1}&east=10.05`;
  for (let i = 0; i < 30; i++)
    assert.equal((await request(box(i))).status, 200);
  const over = await request(box(30));
  assert.equal(over.status, 429);
  assert.deepEqual(over.body, { error: 'rate_limited' });
  assert.equal(stub.poiCalls().length, 30);
  now += 61_000;
  assert.equal((await request(box(30))).status, 200);
});

test('a saturated read says so', async (t) => {
  withKey(t, KEY);
  const [base] = OCM_FIXTURE_POIS;
  const pois = Array.from({ length: OCM_MAX_RESULTS }, (_, index) => ({
    ...clone(base),
    ID: 5000 + index,
  }));
  const request = install(
    openChargeMapProxy({ fetchImpl: upstream({ pois }).fetchImpl }),
  );
  const read = await request(`/poi?${OSLO}`);
  assert.equal(read.body.saturated, true);
  assert.equal(read.body.count, OCM_MAX_RESULTS);
});

test('the local server mounts the proxy and constructing it fetches nothing', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.equal(
    names.filter((name) => name === 'open-charge-map-proxy').length,
    1,
  );
});

test('placeholder operators, unknown connector types and home addresses are not passed on', () => {
  const reference = clone(OCM_FIXTURE_REFERENCE);
  reference.Operators.push(
    {
      ID: 44,
      Title: '(Private Residence/Individual)',
      IsPrivateIndividual: true,
    },
    {
      ID: 45,
      Title: '(Business Owner at Location)',
      IsPrivateIndividual: false,
    },
  );
  reference.ConnectionTypes.push({
    ID: 0,
    Title: 'Unknown',
    FormalName: 'Not Specified',
  });
  const refs = indexReferenceData(reference);
  const base = clone(OCM_FIXTURE_POIS[1]);
  const home = trimOcmSite({ ...base, OperatorID: 44 }, refs);
  assert.equal(home.operator, null);
  assert.equal(home.address, null);
  const business = trimOcmSite({ ...base, OperatorID: 45 }, refs);
  assert.equal(business.operator, null);
  assert.equal(business.address, 'Jernbanetorget 1, Oslo');
  base.Connections[0].ConnectionTypeID = 0;
  const unknown = trimOcmSite(base, refs);
  assert.equal(unknown.connections[0].type, null);
  assert.equal(unknown.connections[1].type, 'Type 2 (Socket Only)');
});
