import test from 'node:test';
import assert from 'node:assert/strict';
import { tileToBBox } from '../../data/tomtomTiles.js';
import { encodePoiTile } from './poiTileFixture.mjs';
import { createChargingSource } from './source.js';
import { createOpenChargeMapClient } from './openChargeMap.js';
import {
  OCM_MATCH_DISTANCE_M,
  groundDistanceM,
  mergeOcmSites,
} from './merge.js';

const TEMPLATE =
  'https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf';
/** Central Oslo: a few z14 tiles. */
const OSLO = { south: 59.905, west: 10.73, north: 59.92, east: 10.77 };
/** Degrees of latitude per metre. */
const LAT_M = 1 / 111_195;

const station = (id, latitude, longitude) => ({
  id: `ev-charging:${id}`,
  name: id,
  latitude,
  longitude,
});
/** A trimmed proxy site `north` / `east` metres from a point. */
function site(id, from, north = 0, east = 0, extra = {}) {
  return {
    id,
    latitude: from.latitude + north * LAT_M,
    longitude:
      from.longitude +
      (east * LAT_M) / Math.cos((from.latitude * Math.PI) / 180),
    title: `OCM ${id}`,
    operator: 'Charge & Drive (Fortum - NO)',
    address: null,
    status: { id: 50, operational: true },
    lastStatusUpdate: Date.UTC(2026, 5, 1),
    connections: [
      {
        type: 'Type 2 (Socket Only)',
        powerKw: 22,
        quantity: 2,
        status: null,
      },
    ],
    numberOfPoints: 2,
    usageCost: null,
    provider: {
      id: 1,
      name: 'Open Charge Map Contributors',
      licence: 'CC BY 4.0',
      licenceText: 'CC BY 4.0',
      url: 'http://openchargemap.org/',
    },
    ...extra,
  };
}

test('a site within the match distance enriches the station; one beyond it is added', () => {
  const a = station('a', 59.91, 10.75);
  const near = site(1, a, 30);
  const far = site(2, a, 0, 60);
  assert.ok(groundDistanceM(a, near) < OCM_MATCH_DISTANCE_M);
  assert.ok(groundDistanceM(a, far) > OCM_MATCH_DISTANCE_M);
  const merged = mergeOcmSites([a], [far, near]);
  assert.equal(merged.matched, 1);
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.records[0], { ...a, ocm: near });
  assert.deepEqual(merged.records[1], {
    id: 'ev-charging:ocm:2',
    name: 'OCM 2',
    latitude: far.latitude,
    longitude: far.longitude,
    origin: 'ocm',
    ocm: far,
  });
  // The station keeps its OpenStreetMap id, name and position.
  assert.equal(merged.records[0].latitude, a.latitude);
});

test('matching is one-to-one and the nearest pair wins', () => {
  const a = station('a', 59.91, 10.75);
  const b = station('b', a.latitude + 70 * LAT_M, a.longitude);
  // s1 is 20 m from a and 50 m from b; s2 is 45 m from a and 25 m from b.
  const s1 = site(1, a, 20);
  const s2 = site(2, a, 45);
  const merged = mergeOcmSites([a, b], [s1, s2]);
  assert.equal(merged.records[0].ocm.id, 1);
  assert.equal(merged.records[1].ocm.id, 2);
  assert.equal(merged.added, 0);
  // Two sites next to one station: the nearer enriches, the other is added.
  const crowded = mergeOcmSites([a], [site(3, a, 40), site(4, a, 10)]);
  assert.equal(crowded.records[0].ocm.id, 4);
  assert.deepEqual(
    crowded.records.slice(1).map((record) => record.id),
    ['ev-charging:ocm:3'],
  );
  // Two stations next to one site: only the nearer one gets it.
  const c = station('c', a.latitude, a.longitude + 0.0006);
  const shared = mergeOcmSites([a, c], [site(5, a, 0, 5)]);
  assert.equal(shared.records[0].ocm?.id, 5);
  assert.equal(shared.records[1].ocm, undefined);
});

test('matching works across latitude band edges and with no sites at all', () => {
  const a = station('a', 59.91, 10.75);
  for (let north = -48; north <= 48; north += 4) {
    const merged = mergeOcmSites([a], [site(1, a, north)]);
    assert.equal(merged.matched, 1, `${north} m north`);
  }
  assert.deepEqual(mergeOcmSites([a], []), {
    records: [a],
    matched: 0,
    added: 0,
  });
});

/** One unnamed station in the middle of whichever tile is asked for. */
function stationTile(url) {
  const [z, x, y] = url
    .match(/(\d+)\/(\d+)\/(\d+)\.pbf$/)
    .slice(1)
    .map(Number);
  const box = tileToBBox(z, x, y);
  return encodePoiTile({ z, x, y }, [
    {
      lon: (box.west + box.east) / 2,
      lat: (box.south + box.north) / 2,
      class: 'fuel',
      subclass: 'charging_station',
    },
  ]);
}

/**
 * The real source over injected tiles and an injected local server. `api`
 * answers `/api/ocm/*`; every call is recorded.
 */
function harness(api) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (url === 'https://tiles.openfreemap.org/planet')
      return Response.json({ tiles: [TEMPLATE] });
    if (String(url).startsWith('/api/ocm/')) return api(String(url), init);
    return new Response(stationTile(url));
  };
  return {
    calls,
    ocmCalls: () => calls.filter((url) => url.startsWith('/api/ocm/')),
    plain: () => createChargingSource({ tileFetchImpl: fetchImpl }),
    enriched: () =>
      createChargingSource({
        tileFetchImpl: fetchImpl,
        ocm: createOpenChargeMapClient({ fetchImpl }),
      }),
  };
}

const keyless = (url) =>
  url === '/api/ocm/status'
    ? Response.json({ hasKey: false })
    : new Response('{"error":"no_key"}', { status: 503 });

test('without a key a read is exactly the OpenStreetMap read', async () => {
  for (const status of [
    keyless,
    // A static host without the route.
    () => Response.json({ error: 'Unknown API route' }, { status: 404 }),
    // A local server that cannot be reached.
    () => {
      throw new TypeError('fetch failed');
    },
    () => new Response('', { status: 500 }),
  ]) {
    const h = harness(status);
    const expected = await h.plain().getStations(OSLO);
    const read = await h.enriched().getStations(OSLO);
    assert.deepEqual(read, expected);
    assert.equal(Object.hasOwn(read, 'enrichment'), false);
    assert.ok(read.records.every((record) => !('ocm' in record)));
    assert.deepEqual(h.ocmCalls(), ['/api/ocm/status']);
  }
  // A definitive "no" is kept for the session: no further status requests.
  const h = harness(keyless);
  const source = h.enriched();
  await source.getStations(OSLO);
  await source.getStations(OSLO);
  assert.deepEqual(h.ocmCalls(), ['/api/ocm/status']);
});

test('a wide view asks neither OpenFreeMap nor the local server', async () => {
  const h = harness(() => Response.json({ hasKey: true }));
  const wide = { south: 59.8, west: 10.5, north: 60.0, east: 11.0 };
  assert.equal((await h.enriched().getStations(wide)).zoomIn, true);
  assert.equal(h.calls.length, 0);
});

/** A keyed local server answering `sites(box)` for each POI read. */
function keyed(sites, { saturated = false } = {}) {
  return (url) => {
    if (url === '/api/ocm/status') return Response.json({ hasKey: true });
    const params = new URL(url, 'http://localhost').searchParams;
    const box = Object.fromEntries(
      ['south', 'west', 'north', 'east'].map((name) => [
        name,
        Number(params.get(name)),
      ]),
    );
    return Response.json({
      fetchedAt: 1,
      stale: false,
      saturated,
      count: 0,
      sites: sites(box),
    });
  };
}

test('with a key, sites enrich their stations and unmatched ones are added', async () => {
  const h = harness(() => null);
  const osm = await h.plain().getStations(OSLO);
  const [first] = osm.records;
  const centre = {
    latitude: (OSLO.south + OSLO.north) / 2,
    longitude: (OSLO.west + OSLO.east) / 2,
  };
  assert.ok(
    osm.records.every(
      (record) => groundDistanceM(record, centre) > OCM_MATCH_DISTANCE_M,
    ),
  );
  const outside = { latitude: OSLO.north + 0.01, longitude: OSLO.east };
  const k = harness(
    keyed(() => [
      site(11, first, 25),
      site(12, centre),
      // The proxy answers a snapped, larger box; sites outside the view stay out.
      site(13, outside),
    ]),
  );
  const read = await k.enriched().getStations(OSLO);
  assert.equal(read.records.length, osm.records.length + 1);
  assert.equal(read.records[0].id, first.id);
  assert.equal(read.records[0].ocm.id, 11);
  assert.equal(read.records[1].ocm, undefined);
  assert.equal(read.records.at(-1).id, 'ev-charging:ocm:12');
  assert.equal(read.records.at(-1).origin, 'ocm');
  assert.deepEqual(read.enrichment, {
    source: 'ocm',
    error: null,
    matched: 1,
    added: 1,
    saturated: false,
    stale: false,
  });
  // The query names the view box itself; the proxy snaps it.
  const [poi] = k.ocmCalls().filter((url) => url.startsWith('/api/ocm/poi'));
  assert.equal(
    poi,
    '/api/ocm/poi?south=59.90500&west=10.73000&north=59.92000&east=10.77000',
  );
});

test('an Open Charge Map failure keeps the OpenStreetMap read, named in a fixed form', async () => {
  const forms = [
    [
      () =>
        Response.json(
          { error: 'upstream', upstreamStatus: 403 },
          { status: 502 },
        ),
      'Open Charge Map HTTP 403',
    ],
    [
      () => Response.json({ error: 'rate_limited' }, { status: 429 }),
      'Open Charge Map rate limited',
    ],
    [
      () => Response.json({ error: 'timeout' }, { status: 504 }),
      'Open Charge Map network error',
    ],
    [
      () => {
        throw new TypeError('connect ECONNREFUSED 127.0.0.1:5173');
      },
      'Open Charge Map network error',
    ],
    [
      () => Response.json({ error: 'malformed' }, { status: 502 }),
      'Malformed Open Charge Map response',
    ],
    [() => new Response('<html>'), 'Malformed Open Charge Map response'],
    [() => Response.json({ sites: 'x' }), 'Malformed Open Charge Map response'],
    [
      () => Response.json({ error: 'proxy' }, { status: 500 }),
      'Open Charge Map HTTP 500',
    ],
  ];
  const osm = await harness(() => null)
    .plain()
    .getStations(OSLO);
  for (const [answer, message] of forms) {
    const h = harness((url) =>
      url === '/api/ocm/status' ? Response.json({ hasKey: true }) : answer(),
    );
    const read = await h.enriched().getStations(OSLO);
    assert.deepEqual(read.records, osm.records, message);
    assert.equal(read.enrichment.error, message);
    assert.equal(read.enrichment.matched, 0);
    assert.ok(!/ECONNREFUSED|html/.test(read.enrichment.error));
  }
});

test('an OpenStreetMap failure still fails the read, whatever OCM answers', async () => {
  const source = createChargingSource({
    tileFetchImpl: async () => new Response('', { status: 503 }),
    ocm: createOpenChargeMapClient({
      fetchImpl: keyed(() => [site(1, { latitude: 59.91, longitude: 10.75 })]),
    }),
  });
  await assert.rejects(source.getStations(OSLO), {
    message: 'OpenFreeMap HTTP 503',
  });
});

test('a key removed while running turns enrichment off without an error', async () => {
  let removed = false;
  const h = harness((url) =>
    url === '/api/ocm/status'
      ? Response.json({ hasKey: true })
      : removed
        ? Response.json({ error: 'no_key' }, { status: 503 })
        : keyed(() => [])(url),
  );
  const source = h.enriched();
  assert.equal((await source.getStations(OSLO)).enrichment.error, null);
  removed = true;
  const read = await source.getStations(OSLO);
  assert.equal(Object.hasOwn(read, 'enrichment'), false);
  const asked = h.ocmCalls().length;
  await source.getStations(OSLO);
  assert.equal(h.ocmCalls().length, asked, 'no more OCM requests');
});

test('cancellation during the Open Charge Map read stays an abort', async () => {
  const abort = new AbortController();
  const h = harness((url) => {
    if (url === '/api/ocm/status') return Response.json({ hasKey: true });
    abort.abort();
    throw new DOMException('aborted', 'AbortError');
  });
  await assert.rejects(
    h.enriched().getStations(OSLO, { signal: abort.signal }),
    { name: 'AbortError' },
  );
});

test('a transient status failure is asked again a minute later', async () => {
  let now = 0;
  let calls = 0;
  const client = createOpenChargeMapClient({
    now: () => now,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return Response.json({ hasKey: true });
    },
  });
  assert.equal(await client.isConfigured(), false);
  assert.equal(await client.isConfigured(), false);
  assert.equal(calls, 1);
  now += 61_000;
  assert.equal(await client.isConfigured(), true);
  assert.equal(await client.isConfigured(), true);
  assert.equal(calls, 2);
});
