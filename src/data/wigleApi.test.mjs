import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIGLE_MAX_VIEWPORT_DEGREES,
  isValidWigleViewport,
  normalizeWigleNetwork,
  wigleNetworkFreshness,
  wiglePacificDayKey,
  wigleRetryDelayMs,
} from './wigleApi.js';

// Real example shape from the WiGLE v2 network/search API.
const SAMPLE_RESULT = {
  trilat: 40.57993698,
  trilong: -73.9818573,
  ssid: 'ValeriyaNetwork',
  qos: 0,
  transid: '20220117-00000',
  firsttime: '2021-11-02T19:00:00.000Z',
  lasttime: '2022-01-17T18:00:00.000Z',
  lastupdt: '2022-01-17T18:00:00.000Z',
  netid: '00:00:85:F5:B4:B1',
  channel: 6,
  encryption: 'wpa2',
  type: 'infra',
};

test('isValidWigleViewport: accepts a small bbox, rejects an oversized or malformed one', () => {
  assert.equal(isValidWigleViewport({ south: 30, west: -98, north: 30.1, east: -97.9 }), true);
  assert.equal(isValidWigleViewport(null), false);
  assert.equal(isValidWigleViewport({ south: 30, west: -98, north: 30, east: -97.9 }), false); // north<=south
  assert.equal(isValidWigleViewport({
    south: 30, west: -98, north: 30 + WIGLE_MAX_VIEWPORT_DEGREES + 1, east: -97.9,
  }), false);
});

test('normalizeWigleNetwork: maps a real result shape to a plain record', () => {
  const record = normalizeWigleNetwork(SAMPLE_RESULT);
  assert.deepEqual(record, {
    id: '00:00:85:F5:B4:B1',
    netid: '00:00:85:F5:B4:B1',
    ssid: 'ValeriyaNetwork',
    encryption: 'wpa2',
    type: 'infra',
    channel: 6,
    qos: 0,
    firstSeen: '2021-11-02T19:00:00.000Z',
    lastSeen: '2022-01-17T18:00:00.000Z',
    latitude: 40.57993698,
    longitude: -73.9818573,
  });
});

test('normalizeWigleNetwork: rejects untriangulated (0,0) or missing coordinates', () => {
  assert.equal(normalizeWigleNetwork({ ...SAMPLE_RESULT, trilat: 0, trilong: 0 }), null);
  assert.equal(normalizeWigleNetwork({ ...SAMPLE_RESULT, trilat: null, trilong: null }), null);
  assert.equal(normalizeWigleNetwork(null), null);
});

test('normalizeWigleNetwork: a present-but-blank channel/qos reads as missing, not zero', () => {
  const record = normalizeWigleNetwork({ ...SAMPLE_RESULT, channel: '', qos: '' });
  assert.equal(record.channel, null);
  assert.equal(record.qos, null);
});

test('wigleNetworkFreshness: buckets by age in days', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z');
  assert.equal(wigleNetworkFreshness('2026-08-01T00:00:00.000Z', now), 'recent');
  assert.equal(wigleNetworkFreshness('2026-01-01T00:00:00.000Z', now), 'aged');
  assert.equal(wigleNetworkFreshness('2020-01-01T00:00:00.000Z', now), 'old');
  assert.equal(wigleNetworkFreshness(null, now), 'unknown');
  assert.equal(wigleNetworkFreshness('not a date', now), 'unknown');
});

test('wiglePacificDayKey: renders a stable YYYY-MM-DD in America/Los_Angeles', () => {
  // 07:30 UTC on Jan 1 is still Dec 31 in US/Pacific (UTC-8 in January).
  assert.equal(wiglePacificDayKey(Date.parse('2026-01-01T07:30:00.000Z')), '2025-12-31');
  assert.equal(wiglePacificDayKey(Date.parse('2026-01-01T09:00:00.000Z')), '2026-01-01');
});

test('wigleRetryDelayMs: doubles from a 30s floor to a 240s ceiling', () => {
  assert.equal(wigleRetryDelayMs(0), 30000);
  assert.equal(wigleRetryDelayMs(30000), 60000);
  assert.equal(wigleRetryDelayMs(200000), 240000);
  assert.equal(wigleRetryDelayMs(240000), 240000);
});
