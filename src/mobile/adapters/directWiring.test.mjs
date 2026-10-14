import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselDirectLayerSource } from './heavyLayerSources.js';
import { createTomtomFetchShim } from './meteredDirect.js';
import { createFirePerimeterDirectSource } from './staticFeedsDirect.js';
import { LiveSourceError } from '../../sources/live/contract.js';

/** Wrap a payload in a real Response so adapter body readers stay honest. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  return { calls, fetchImpl };
}

/** Abort-then-resolve: the adapter must discard the late body. */
async function assertDiscardsLateResponse(invoke) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchImpl = async () => {
    await gate;
    return jsonResponse({ unexpected: true });
  };
  const controller = new AbortController();
  const pending = invoke(fetchImpl, controller.signal);
  controller.abort();
  release();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
}

// ---------------------------------------------------------------------------
// vessels direct layer source
// ---------------------------------------------------------------------------

const VESSEL_ENVELOPE = {
  MessageType: 'PositionReport',
  Message: {
    PositionReport: {
      UserID: 123456789,
      Latitude: 48.85,
      Longitude: 2.35,
      Sog: 12.5,
      Cog: 90,
      TrueHeading: 91,
    },
  },
  MetaData: { MMSI: 123456789, ShipName: 'TEST SHIP', time_utc: '2026-10-14T03:00:00.000Z' },
};

/** Fake live handle capturing the onVessel hook for frame injection. */
function fakeLive() {
  const state = { frames: [], connected: 0, rings: new Map() };
  const handle = {
    async connect() {
      state.connected += 1;
      return { status: 'live' };
    },
    tick() {},
    snapshot() {
      return { status: 'live', silentForMs: 0, attempts: 0 };
    },
    getTrack(mmsi) {
      return state.rings.get(String(mmsi)) || [];
    },
  };
  const createLive = (options) => {
    state.options = options;
    return handle;
  };
  return { state, createLive };
}

function feedFrame(live, mmsi, envelope) {
  live.state.options.onVessel({ mmsi, envelope });
}

/** Construct the live handle (captures onVessel) with a throwaway poll. */
async function primeLive(source) {
  await source.getSnapshot({ maxRows: 0 });
}

test('vessels direct returns normalized poll rows in the legacy shape', async () => {
  const live = fakeLive();
  const source = createVesselDirectLayerSource({
    getKey: async () => 'k',
    createLive: live.createLive,
  });
  assert.equal(source.label, 'Vessels');
  await primeLive(source);
  feedFrame(live, 123456789, VESSEL_ENVELOPE);
  const snapshot = await source.getSnapshot({ maxRows: 12000 });
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].id, '123456789');
  assert.equal(snapshot.records[0].name, 'TEST SHIP');
  assert.equal(snapshot.transportStatus, 'live');
});

test('vessels direct honors maxRows, area, and staleness', async () => {
  let at = 1_000_000;
  const live = fakeLive();
  const source = createVesselDirectLayerSource({
    getKey: async () => 'k',
    createLive: live.createLive,
    clock: () => at,
  });
  await primeLive(source);
  const near = { ...VESSEL_ENVELOPE };
  const far = {
    MessageType: 'PositionReport',
    Message: {
      PositionReport: { UserID: 987654321, Latitude: -33.86, Longitude: 151.2 },
    },
    MetaData: { MMSI: 987654321 },
  };
  feedFrame(live, 123456789, near);
  feedFrame(live, 987654321, far);
  const capped = await source.getSnapshot({ maxRows: 1 });
  assert.equal(capped.records.length, 1);
  const area = await source.getSnapshot({
    area: { lat: 48.85, lon: 2.35, radiusKm: 50 },
  });
  assert.equal(area.records.length, 1);
  assert.equal(area.records[0].id, '123456789');
  at += 31 * 60 * 1000;
  const stale = await source.getSnapshot({});
  assert.equal(stale.records.length, 0);
});

test('vessels direct keyless throws the legacy missing-key error', async () => {
  const live = fakeLive();
  const source = createVesselDirectLayerSource({
    getKey: async () => null,
    createLive: (options) => {
      const handle = live.createLive(options);
      const origConnect = handle.connect;
      handle.connect = async () => ({ unavailable: 'KEY_REQUIRED' });
      void origConnect;
      return handle;
    },
  });
  await assert.rejects(source.getSnapshot({}), (error) => {
    assert.ok(error instanceof LiveSourceError);
    assert.equal(error.code, 'missing-key');
    assert.match(error.message, /AISSTREAM_API_KEY/);
    return true;
  });
});

test('vessels direct maps rings through the legacy track shape', async () => {
  const live = fakeLive();
  live.state.rings.set('123456789', [
    { latitude: 48.85, longitude: 2.35, at: 1_700_000_000_000 },
    { latitude: 48.86, longitude: 2.36, at: 1_700_000_060_000 },
  ]);
  const source = createVesselDirectLayerSource({
    getKey: async () => 'k',
    createLive: live.createLive,
  });
  const track = await source.getTrack('123456789');
  assert.equal(track.complete, false);
  assert.equal(track.records.length, 2);
  assert.equal(track.records[0].latitude, 48.85);
  assert.ok(Number.isFinite(track.records[0].observedAtMs));
});

test('vessels direct discards a late snapshot after abort', async () => {
  const live = fakeLive();
  const source = createVesselDirectLayerSource({
    getKey: async () => 'k',
    createLive: live.createLive,
  });
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = (async () => {
    controller.abort();
    await gate;
    return source.getSnapshot({}, { signal: controller.signal });
  })();
  release();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
});

// ---------------------------------------------------------------------------
// TomTom fetch shim
// ---------------------------------------------------------------------------

test('tomtom shim answers status from the vault key', async () => {
  const { fetchImpl } = stubFetch(async () => jsonResponse({ ok: true }));
  const withKey = createTomtomFetchShim({
    fetchImpl,
    getKey: async () => 'k',
  });
  const keyed = await (await withKey('https://localhost/api/tomtom/status')).json();
  assert.equal(keyed.hasKey, true);
  const keyless = createTomtomFetchShim({ fetchImpl, getKey: async () => null });
  const empty = await (await keyless('https://localhost/api/tomtom/status')).json();
  assert.equal(empty.hasKey, false);
});

test('tomtom shim serves flow tiles from upstream with the key', async () => {
  const { calls, fetchImpl } = stubFetch(async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'application/x-protobuf' },
    }),
  );
  const spent = [];
  const shim = createTomtomFetchShim({
    fetchImpl,
    getKey: async () => 'k',
    budget: { trySpend: async () => (spent.push(true), true) },
  });
  const response = await shim('https://localhost/api/tomtom/flow/12/935/1685.pbf');
  assert.equal(response.status, 200);
  assert.match(calls[0].url, /^https:\/\/api\.tomtom\.com\/traffic\/map\/4\/tile\/flow\/relative\/12\/935\/1685\.pbf\?key=/);
  assert.equal(spent.length, 1);
});

test('tomtom shim refuses exhausted budget without fetching', async () => {
  const { calls, fetchImpl } = stubFetch(async () => jsonResponse({}));
  const shim = createTomtomFetchShim({
    fetchImpl,
    getKey: async () => 'k',
    budget: { remaining: async () => 0, trySpend: async () => false },
  });
  const response = await shim('https://localhost/api/tomtom/flow/12/935/1685.pbf');
  assert.equal(response.status, 429);
  assert.equal(calls.length, 0);
});

test('tomtom shim passes non-tomtom URLs straight through', async () => {
  const { calls, fetchImpl } = stubFetch(async () => jsonResponse({ ok: true }));
  const shim = createTomtomFetchShim({ fetchImpl, getKey: async () => 'k' });
  const response = await shim('https://localhost/api/flights');
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, 'https://localhost/api/flights');
});

test('tomtom shim rejects malformed tile coordinates', async () => {
  const { fetchImpl } = stubFetch(async () => jsonResponse({}));
  const shim = createTomtomFetchShim({ fetchImpl, getKey: async () => 'k' });
  const response = await shim('https://localhost/api/tomtom/flow/12/935/evil.pbf');
  assert.equal(response.status, 400);
});

// ---------------------------------------------------------------------------
// fire perimeters wiring
// ---------------------------------------------------------------------------

const WFIGS_FEATURE = {
  type: 'Feature',
  id: 1,
  properties: {
    attr_UniqueFireIdentifier: 'FIRE-1',
    poly_IncidentName: 'Test Fire',
    attr_IncidentSize: 100,
    attr_PercentContained: 50,
    attr_POOState: 'CA',
  },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-120, 38],
        [-119, 38],
        [-119, 39],
        [-120, 39],
        [-120, 38],
      ],
    ],
  },
};

test('perimeters direct pages NIFC and returns normalized rows', async () => {
  const { calls, fetchImpl } = stubFetch((url) => {
    if (url.includes('resultOffset=1')) {
      return jsonResponse({ features: [], exceededTransferLimit: false });
    }
    return jsonResponse({ features: [WFIGS_FEATURE], exceededTransferLimit: true });
  });
  const { createFirePerimeterDirectSource } = await import('./staticFeedsDirect.js');
  const source = createFirePerimeterDirectSource({ fetchImpl });
  const rows = await source.getSnapshot({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'FIRE-1');
  assert.equal(rows[0].name, 'Test Fire');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/services3\.arcgis\.com\//);
});

test('perimeters direct throws the legacy message on malformed payloads', async () => {
  const { fetchImpl } = stubFetch(async () => jsonResponse({ nope: true }));
  const { createFirePerimeterDirectSource } = await import('./staticFeedsDirect.js');
  const source = createFirePerimeterDirectSource({ fetchImpl });
  await assert.rejects(source.getSnapshot({}), /invalid_snapshot/);
});

test('perimeters direct discards a late snapshot after abort', async () => {
  const { createFirePerimeterDirectSource } = await import('./staticFeedsDirect.js');
  await assertDiscardsLateResponse((fetchImpl, signal) =>
    createFirePerimeterDirectSource({ fetchImpl }).getSnapshot({ signal }),
  );
});
