import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGfwClient,
  createBarentsWatchClient,
  normalizeVesselMatches,
  normalizeEvents,
  normalizeBarentsWatchRows,
  GFW_DATASETS,
} from './ais-partners.js';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('an unconfigured GFW client is inert, not broken', async () => {
  const gfw = createGfwClient({ token: '' });
  assert.equal(gfw.configured, false);
  const result = await gfw.searchVessel('431449000');
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/);
  assert.equal(gfw.status().nonCommercialOnly, true);
});

test('GFW search sends the bearer token and identity dataset', async () => {
  let seenUrl = '';
  let seenHeaders = null;
  const gfw = createGfwClient({
    token: 'tok123',
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return jsonResponse({ entries: [] });
    },
  });
  await gfw.searchVessel('431449000');
  assert.match(seenUrl, /\/vessels\/search/);
  assert.match(seenUrl, /query=431449000/);
  assert.ok(seenUrl.includes(encodeURIComponent(GFW_DATASETS.identity)));
  assert.equal(seenHeaders.Authorization, 'Bearer tok123');
});

test('GFW HTTP failures surface as errors, never as empty success', async () => {
  const gfw = createGfwClient({
    token: 'tok',
    fetchImpl: async () => jsonResponse({}, false, 401),
  });
  const result = await gfw.searchVessel('431449000');
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('a thrown fetch is caught rather than propagated', async () => {
  const gfw = createGfwClient({
    token: 'tok',
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
  });
  const result = await gfw.searchVessel('x');
  assert.equal(result.ok, false);
  assert.match(result.error, /socket hang up/);
});

test('GFW registry entries flatten to displayable identity', () => {
  const matches = normalizeVesselMatches({
    entries: [
      {
        selfReportedInfo: [{ id: 'gfw-1', ssvid: '431449000', shipname: 'CAPE BRITANNIA' }],
        registryInfo: [{ imo: '9409065', flag: 'JPN', callsign: '7JYW', shipname: 'CAPE BRITANNIA' }],
      },
    ],
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].vesselId, 'gfw-1');
  assert.equal(matches[0].imo, '9409065');
  assert.equal(matches[0].flag, 'JPN');
});

test('malformed GFW payloads normalize to an empty list', () => {
  assert.deepEqual(normalizeVesselMatches(null), []);
  assert.deepEqual(normalizeVesselMatches({ entries: 'nope' }), []);
  assert.deepEqual(normalizeEvents(undefined), []);
});

test('gap events keep duration and position', () => {
  const events = normalizeEvents({
    entries: [
      {
        id: 'e1',
        type: 'GAP',
        start: '2026-09-01T00:00:00Z',
        end: '2026-09-02T00:00:00Z',
        position: { lat: 10, lon: 20 },
        gap: { durationHours: 24, distanceKm: 400 },
      },
    ],
  });
  assert.equal(events[0].durationHours, 24);
  assert.equal(events[0].lat, 10);
});

test('BarentsWatch requests a token with the ais scope', async () => {
  let seenBody = '';
  const bw = createBarentsWatchClient({
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl: async (url, init) => {
      if (String(url).includes('connect/token')) {
        seenBody = init.body.toString();
        return jsonResponse({ access_token: 'bwtok', expires_in: 3600 });
      }
      return jsonResponse([]);
    },
  });
  const token = await bw.accessToken();
  assert.equal(token, 'bwtok');
  assert.match(seenBody, /grant_type=client_credentials/);
  assert.match(seenBody, /scope=ais/);
});

test('the BarentsWatch token is cached until near expiry', async () => {
  let tokenCalls = 0;
  let clock = 1_000_000;
  const bw = createBarentsWatchClient({
    clientId: 'id',
    clientSecret: 'secret',
    now: () => clock,
    fetchImpl: async (url) => {
      if (String(url).includes('connect/token')) {
        tokenCalls += 1;
        return jsonResponse({ access_token: `tok${tokenCalls}`, expires_in: 3600 });
      }
      return jsonResponse([]);
    },
  });
  assert.equal(await bw.accessToken(), 'tok1');
  assert.equal(await bw.accessToken(), 'tok1', 'reused');
  assert.equal(tokenCalls, 1);
  clock += 3600 * 1000; // past expiry
  assert.equal(await bw.accessToken(), 'tok2');
});

test('an unconfigured BarentsWatch client never calls the network', async () => {
  let called = false;
  const bw = createBarentsWatchClient({
    clientId: '',
    clientSecret: '',
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  const result = await bw.latestPositions();
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('BarentsWatch rows map onto the AIS ingest shape', () => {
  const rows = normalizeBarentsWatchRows([
    {
      mmsi: 257123456,
      latitude: 60.4,
      longitude: 5.3,
      name: 'NORDLYS',
      speedOverGround: 12.5,
      courseOverGround: 180,
      trueHeading: 179,
      navigationalStatus: 0,
      msgtime: '2026-09-19T08:00:00Z',
    },
    { mmsi: '', latitude: 1, longitude: 2 },
    { mmsi: '123', latitude: 'x', longitude: 2 },
  ]);
  assert.equal(rows.length, 1, 'rows without an identity or position are dropped');
  assert.equal(rows[0].mmsi, '257123456');
  assert.equal(rows[0].speed, 12.5);
  assert.equal(rows[0].nav_status, 0);
  assert.equal(rows[0].source, 'BarentsWatch');
});
