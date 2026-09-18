import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIngestion,
  createVesselFeed,
  isEmptySceneSnapshot,
  vesselSceneBbox,
} from './ingestion.js';
function setup(source) {
  const feed = createVesselFeed();
  feed.enabled = true;
  feed.sessionId = 1;
  const applied = [];
  const labels = [];
  let count = 0;
  const ingestion = createIngestion({
    feed,
    readSource: () => source,
    readViewer: () => ({}),
    getRowLimit: () => 500,
    readCount: () => count,
    now: () => 9999,
    setSourceLabel: (value) => labels.push(value),
    applyRows: (_, rows) => {
      applied.push(rows);
      count = rows.length;
    },
    classifySnapshot: (payload) => ({
      acceptedRows: payload.rows,
      acceptedRowCount: payload.rows.length,
      rawRowCount: payload.rows.length,
      transportStatus: payload.status,
      lastMessageAt: payload.lastMessageAt,
      error: payload.rows.length ? null : 'No accepted positions',
    }),
    isDefinitiveTransportFailure: () => false,
    isGraceEligibleTransport: () => false,
    markUnavailable: (error) => {
      feed.error = error;
    },
    settleFirstConnect: (phase) => {
      feed.firstConnectPhase = phase;
    },
  });
  return { feed, applied, labels, ...ingestion };
}

test('an old vessel request cannot publish or clear the loading state of a newer enable session', async () => {
  let release;
  const probe = setup({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const request = probe.methods.update();
  const old = probe.feed.abort;
  probe.feed.sessionId++;
  probe.feed.abort = new AbortController();
  probe.feed.loading = true;
  release({ records: [], source: 'Old session' });
  await request;
  assert.equal(probe.applied.length, 0);
  assert.equal(probe.labels.length, 0);
  assert.equal(probe.feed.loading, true);
  assert.notEqual(probe.feed.abort, old);
});

test('vessel ingestion converts source units once and retains warm records on a zero-row snapshot', async () => {
  let snapshot = {
    records: [
      {
        id: '111',
        reference: '111',
        latitude: 51.93,
        longitude: 4.05,
        speedMps: 5.14444,
        courseDeg: 90,
        headingDeg: 100,
        observedAtMs: 1700000000000,
      },
    ],
    source: 'Fixture',
    observedAtMs: null,
    freshness: 'unknown',
    complete: false,
    transportStatus: 'live',
  };
  const probe = setup({
    async getSnapshot(query) {
      assert.equal(query.maxRows, 500);
      return snapshot;
    },
  });
  await probe.methods.update();
  const record = probe.applied[0][0];
  assert.equal(record.speed, 5.14444 / 0.514444);
  assert.equal(record.last_position_epoch, 1700000000);
  assert.equal(record.last_position_UTC, new Date(1700000000000).toISOString());
  assert.equal(probe.feed.lastUpdate, null);
  assert.equal(probe.feed.stale, true);
  assert.equal(probe.feed.count, 1);
  snapshot = { ...snapshot, records: [] };
  await probe.methods.update();
  assert.equal(probe.applied.length, 1);
  assert.equal(probe.feed.count, 1);
  assert.equal(probe.feed.stale, true);
  assert.equal(probe.feed.error, 'No accepted positions');
  assert.equal(probe.feed.loading, false);
  assert.equal(probe.feed.abort, null);
});

test('the scene bbox is derived from the camera in degrees (± 1.5°, clamped) without the renderer', () => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  assert.deepEqual(
    vesselSceneBbox({
      camera: {
        positionCartographic: {
          latitude: toRad(29.3),
          longitude: toRad(-94.8),
        },
      },
    }),
    { lamin: 27.8, lamax: 30.8, lomin: -96.3, lomax: -93.3 },
  );
  assert.deepEqual(
    vesselSceneBbox({
      camera: {
        positionCartographic: {
          latitude: toRad(89.5),
          longitude: toRad(179.5),
        },
      },
    }),
    { lamin: 88, lamax: 90, lomin: 178, lomax: 180 },
  );
  assert.equal(vesselSceneBbox({}), null);
  assert.equal(vesselSceneBbox(null), null);
  assert.equal(
    vesselSceneBbox({
      camera: { positionCartographic: { latitude: NaN, longitude: 0 } },
    }),
    null,
  );
});

test('a zero-row poll is an empty scene only for an explicit empty status or a non-fault status with guidance', () => {
  assert.equal(isEmptySceneSnapshot({}, 'empty'), true);
  assert.equal(
    isEmptySceneSnapshot({ statusMessage: 'No vessels in scene' }, 'live'),
    true,
  );
  assert.equal(
    isEmptySceneSnapshot({ statusMessage: 'No vessels in scene' }, 'degraded'),
    true,
  );
  assert.equal(isEmptySceneSnapshot({}, 'live'), false);
  assert.equal(isEmptySceneSnapshot({}, 'degraded'), false);
  assert.equal(
    isEmptySceneSnapshot({ statusMessage: 'x' }, 'auth-failed'),
    false,
  );
  assert.equal(isEmptySceneSnapshot({ statusMessage: 'x' }, 'closed'), false);
});

test('vessel ingestion sends the scene bbox, surfaces provider status, and turns an empty scene into guidance', async () => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const viewer = {
    camera: {
      positionCartographic: {
        latitude: toRad(30.27),
        longitude: toRad(-97.74),
      },
    },
  };
  const queries = [];
  let snapshot = {
    records: [],
    source: 'Demo replay',
    observedAtMs: null,
    freshness: 'unknown',
    complete: true,
    transportStatus: 'empty',
    statusMessage:
      'No vessels in scene (demo replay covers the Texas Gulf coast)',
    providerStatus: 'degraded',
    providerError: 'AISSTREAM_API_KEY not set - demo replay, not live AIS',
    collectorMode: 'demo',
  };
  const probe = setup({
    async getSnapshot(query) {
      queries.push(query);
      return snapshot;
    },
  });
  probe.feed.firstConnectPhase = 'loading';
  await probe.methods.update(viewer);
  assert.deepEqual(queries[0], {
    maxRows: 500,
    bbox: { lamin: 28.77, lamax: 31.77, lomin: -99.24, lomax: -96.24 },
  });
  assert.equal(probe.feed.sceneEmpty, true);
  assert.equal(
    probe.feed.statusMessage,
    'No vessels in scene (demo replay covers the Texas Gulf coast)',
  );
  assert.equal(probe.feed.error, null);
  assert.equal(probe.feed.firstConnectPhase, 'ready');
  assert.equal(probe.feed.providerStatus, 'degraded');
  assert.equal(probe.feed.source, 'Demo replay');
  assert.equal(probe.feed.collectorMode, 'demo');
  assert.deepEqual(probe.labels, ['Demo replay']);

  // Rows arrive (the camera moved to the coast): guidance clears and the
  // provider's degraded reason is kept alongside the drawable vessels.
  snapshot = {
    ...snapshot,
    records: [
      {
        id: '999000001',
        reference: '999000001',
        latitude: 29.3,
        longitude: -94.7,
        speedMps: 5,
        courseDeg: 90,
        headingDeg: 90,
        observedAtMs: 1700000000000,
      },
    ],
    transportStatus: 'degraded',
    statusMessage: null,
  };
  await probe.methods.update(viewer);
  assert.equal(probe.feed.sceneEmpty, false);
  assert.equal(probe.feed.statusMessage, null);
  assert.equal(probe.feed.count, 1);
  assert.equal(
    probe.feed.error,
    'AISSTREAM_API_KEY not set - demo replay, not live AIS',
  );

  // A zero-row poll with a definitive failure still marks the feed unavailable.
  snapshot = {
    ...snapshot,
    records: [],
    transportStatus: 'closed',
    statusMessage: null,
    providerStatus: null,
    providerError: null,
  };
  const failing = setup({
    async getSnapshot() {
      return snapshot;
    },
  });
  const strict = createIngestion({
    feed: failing.feed,
    readSource: () => ({
      async getSnapshot() {
        return snapshot;
      },
    }),
    readViewer: () => viewer,
    getRowLimit: () => 500,
    readCount: () => 0,
    now: () => 1,
    setSourceLabel: () => {},
    applyRows: () => {},
    classifySnapshot: (payload) => ({
      acceptedRows: payload.rows,
      acceptedRowCount: payload.rows.length,
      rawRowCount: payload.rows.length,
      transportStatus: payload.status,
      lastMessageAt: null,
      error: 'feed disconnected',
    }),
    isDefinitiveTransportFailure: (status) => status === 'closed',
    isGraceEligibleTransport: () => false,
    markUnavailable: (error) => {
      failing.feed.error = error;
    },
    settleFirstConnect: () => {},
  });
  await strict.methods.update(viewer);
  assert.equal(failing.feed.sceneEmpty, false);
  assert.equal(failing.feed.error, 'feed disconnected');
});
