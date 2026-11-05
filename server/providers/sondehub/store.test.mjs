import test from 'node:test';
import assert from 'node:assert/strict';
import { createSondeStore } from './store.js';
import {
  SONDE_RETAIN_MS,
  SONDE_TRACK_MAX_POINTS,
  SONDE_MAX_SERIALS,
} from '../../../src/layers/radiosondes/records.js';
const start = 1_800_000_000_000;
const raw = (serial, timeMs, alt = 1000) => ({
  serial,
  datetime: timeMs,
  lat: 50,
  lon: 10,
  alt,
  uploader_callsign: 'PRIVATE',
});
test('duplicates/older data rejected and rolling tracks append at 10 s or 100 m', () => {
  let now = start;
  const store = createSondeStore({ now: () => now });
  assert.ok(store.ingest(raw('TEST123', now)));
  assert.equal(store.ingest(raw('TEST123', now)), null);
  assert.equal(store.ingest(raw('TEST123', now - 1)), null);
  now += 9000;
  store.ingest(raw('TEST123', now, 1099));
  assert.equal(store.track('TEST123').length, 1);
  now++;
  store.ingest(raw('TEST123', now, 1100));
  assert.equal(store.track('TEST123').length, 2);
  now += 10000;
  store.ingest(raw('TEST123', now, 1101));
  assert.equal(store.track('TEST123').length, 3);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /uploader|PRIVATE/);
  now += SONDE_RETAIN_MS + 1;
  assert.deepEqual(store.snapshot(), []);
});
test('track and serial caps evict oldest entries without retaining receiver fields', () => {
  let now = start;
  const store = createSondeStore({ now: () => now });
  for (let i = 0; i < SONDE_TRACK_MAX_POINTS + 3; i++) {
    now++;
    store.ingest(raw('TEST123', now, i % 2 ? 1000 : 1200));
  }
  assert.equal(store.track('TEST123').length, SONDE_TRACK_MAX_POINTS);
  for (let i = 0; i < SONDE_MAX_SERIALS; i++) {
    now++;
    store.ingest(raw(`NEW${i}`, now));
  }
  assert.equal(store.snapshot().length, SONDE_MAX_SERIALS);
  assert.equal(
    store.snapshot().some((f) => f.serial === 'TEST123'),
    false,
  );
  assert.deepEqual(store.track('TEST123'), []);
});
