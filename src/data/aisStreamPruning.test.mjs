import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AISSTREAM_CACHE_MAX,
  AISSTREAM_STALE_MS,
  aisStreamRows,
  ingestAisStreamEnvelope,
  readAisTrack,
} from '../../server/providers/vessels/ais-store.js';

// Pruning runs on every AISStream position message, so it evicts from the
// front of an update-ordered cache instead of scanning or sorting it. These
// tests pin the observable contract that ordering must preserve: stale and
// over-cap eviction always removes the least recently updated vessels, even
// when a vessel inserted early keeps reporting.

const MINUTE = 60 * 1000;

const positionReport = (mmsi, { lat = 53.40879, epochSec }) => ({
  MessageType: 'PositionReport',
  Message: { PositionReport: { UserID: Number(mmsi), Sog: 10 } },
  MetaData: {
    MMSI: mmsi,
    latitude: lat,
    longitude: 6.19741,
    time_utc: new Date(epochSec * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace('Z', ' +0000 UTC'),
  },
});

const liveMmsis = () =>
  new Set(aisStreamRows(AISSTREAM_CACHE_MAX + 10).map((row) => row.mmsi));

test('stale vessels are evicted while an earlier-inserted vessel that keeps reporting survives', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30, 12) });
  const epoch = () => Math.floor(Date.now() / 1000);

  ingestAisStreamEnvelope(positionReport('211000001', { epochSec: epoch() }));
  t.mock.timers.tick(5 * MINUTE);
  ingestAisStreamEnvelope(positionReport('211000002', { epochSec: epoch() }));
  t.mock.timers.tick(MINUTE);
  ingestAisStreamEnvelope(
    positionReport('211000002', { lat: 53.41879, epochSec: epoch() }),
  );
  assert.equal(readAisTrack('211000002').length, 2);

  // The first vessel reports again, so it is now the most recently updated
  // even though it was inserted first.
  t.mock.timers.tick(20 * MINUTE);
  ingestAisStreamEnvelope(positionReport('211000001', { epochSec: epoch() }));

  // Past the stale window for vessel 2 only; any message triggers the prune.
  t.mock.timers.tick(AISSTREAM_STALE_MS - 15 * MINUTE);
  ingestAisStreamEnvelope(positionReport('211000003', { epochSec: epoch() }));

  const live = liveMmsis();
  assert.ok(live.has('211000001'));
  assert.ok(live.has('211000003'));
  assert.ok(!live.has('211000002'));
  assert.deepEqual(readAisTrack('211000002'), []);
});

test('over the cap, the least recently updated vessel is evicted, not the first inserted', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30, 18) });
  const epochSec = Math.floor(Date.now() / 1000);

  ingestAisStreamEnvelope(positionReport('300000000', { epochSec }));
  for (let i = 1; i < AISSTREAM_CACHE_MAX; i++) {
    t.mock.timers.tick(1);
    ingestAisStreamEnvelope(
      positionReport(String(300000000 + i), { epochSec }),
    );
  }
  t.mock.timers.tick(1);
  ingestAisStreamEnvelope(positionReport('300000000', { epochSec }));
  t.mock.timers.tick(1);
  ingestAisStreamEnvelope(
    positionReport(String(300000000 + AISSTREAM_CACHE_MAX), { epochSec }),
  );

  const live = liveMmsis();
  assert.equal(live.size, AISSTREAM_CACHE_MAX);
  assert.ok(live.has('300000000'));
  assert.ok(!live.has('300000001'));
  assert.ok(live.has(String(300000000 + AISSTREAM_CACHE_MAX)));
});
