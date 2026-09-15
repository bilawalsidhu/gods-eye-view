import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestion, createVesselFeed } from './ingestion.js';
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
