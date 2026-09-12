import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FEED_STATE_SEVERITY,
  LAYER_FEED_STATE_LABELS,
  LAYER_FEED_STATES,
  SNAPSHOT_FEED_STATES,
  feedProvenanceEnvelope,
  feedProvenanceNote,
  layerFeedState,
  layerSnapshot,
  layerSnapshots,
  snapshotAgeLabel,
  snapshotAgeSec,
  viewStateLayerRow,
  worstFeedState,
} from './layerSnapshot.js';

const NOW = 1_700_000_000_000;

test('layerSnapshot stays Cesium-free so the HUD proxy can import it', () => {
  const src = readFileSync(new URL('./layerSnapshot.js', import.meta.url), 'utf8');
  assert.equal(src.includes("from './manager.js'"), false);
  assert.doesNotMatch(src, /from ['"]cesium['"]/i);
});

test('layerFeedState matches the chip classifier for every honesty class', () => {
  assert.equal(layerFeedState({ error: 'feed down', count: 0, lastUpdate: null }), 'unavailable');
  assert.equal(layerFeedState({
    status: 'unavailable',
    error: 'feed down',
    count: 50,
    lastUpdate: 1,
  }), 'unavailable');
  assert.equal(layerFeedState({ mode: 'sim', count: 100, lastUpdate: 1 }), 'fallback');
  assert.equal(layerFeedState({ source: 'adsb.lol', count: 10, lastUpdate: 1 }), 'fallback');
  assert.equal(layerFeedState({
    source: 'adsb.lol',
    fallback: false,
    count: 10,
    lastUpdate: 1,
  }), 'nominal');
  assert.equal(layerFeedState({ stale: true, count: 0, lastUpdate: 1 }), 'stale');
  assert.equal(layerFeedState({ error: 'partial group failure', count: 50, lastUpdate: 1 }), 'degraded');
  assert.equal(layerFeedState({ loading: true }), 'loading');
  assert.equal(layerFeedState({ count: 5, lastUpdate: 1 }), 'nominal');
  assert.equal(layerFeedState({ status: 'zoom-in', error: 'zoom in to search', count: 12 }), 'nominal');
  assert.equal(layerFeedState({ status: 'zoom-in', stale: true, count: 12 }), 'stale');
});

test('chip labels and severity cover every feed-state the envelope can emit', () => {
  assert.deepEqual([...LAYER_FEED_STATES], [
    'nominal', 'loading', 'degraded', 'stale', 'fallback', 'unavailable',
  ]);
  assert.deepEqual([...SNAPSHOT_FEED_STATES], [...LAYER_FEED_STATES, 'off']);
  for (const state of LAYER_FEED_STATES) {
    assert.equal(typeof LAYER_FEED_STATE_LABELS[state], 'string');
    assert.equal(typeof FEED_STATE_SEVERITY[state], 'number');
  }
  assert.equal(FEED_STATE_SEVERITY.unavailable < FEED_STATE_SEVERITY.stale, true);
  assert.equal(FEED_STATE_SEVERITY.stale < FEED_STATE_SEVERITY.fallback, true);
  assert.equal(worstFeedState(['nominal', 'stale', 'fallback']), 'stale');
  assert.equal(worstFeedState(['degraded', 'unavailable']), 'unavailable');
  assert.equal(worstFeedState([]), null);
});

test('a disabled layer is off even when leftover stats would read stale', () => {
  const snap = layerSnapshot({
    id: 'flights',
    name: 'Live Flights',
    enabled: false,
    source: 'OpenSky Network',
    stats: { stale: true, count: 12, lastUpdate: NOW - 240_000, source: 'OpenSky Network' },
  }, { now: NOW });
  assert.equal(snap.feedState, 'off');
  assert.equal(snap.enabled, false);
  assert.equal(snap.count, 12);
  assert.equal(snap.ageLabel, '4m ago');
});

test('an enabled stale layer carries age, source, and a mechanical note', () => {
  const snap = layerSnapshot({
    id: 'flights',
    name: 'Live Flights',
    enabled: true,
    stats: {
      stale: true,
      count: 12,
      lastUpdate: NOW - 240_000,
      source: 'OpenSky Network',
    },
  }, { now: NOW });
  assert.equal(snap.feedState, 'stale');
  assert.equal(snap.source, 'OpenSky Network');
  assert.equal(snap.ageSec, 240);
  assert.equal(snap.ageLabel, '4m ago');
  const envelope = feedProvenanceEnvelope([snap], { now: NOW });
  assert.equal(envelope.overall, 'stale');
  assert.match(envelope.note, /Live Flights is STALE/);
  assert.match(envelope.note, /OpenSky Network/);
  assert.match(envelope.note, /4m ago/);
  assert.match(envelope.note, /do not describe this as live/i);
});

test('degraded and unavailable envelopes outrank leftover nominal neighbours', () => {
  const layers = layerSnapshots([
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: true,
      stats: { count: 3, lastUpdate: NOW - 10_000 },
    },
    {
      id: 'local-firms',
      name: 'Active Fires',
      enabled: true,
      stats: { error: 'FIRMS key missing', count: 8, lastUpdate: NOW - 30_000 },
    },
  ], { now: NOW });
  const envelope = feedProvenanceEnvelope(layers, { now: NOW });
  assert.equal(envelope.overall, 'degraded');
  assert.match(envelope.note, /Active Fires is DEGRADED/);
  assert.match(envelope.note, /FIRMS key missing/);
});

test('an unavailable feed with no prior data does not become a confident zero', () => {
  const snap = layerSnapshot({
    id: 'ais-live-vessels',
    name: 'Live Vessels',
    enabled: true,
    stats: { error: 'AISStream down', count: 0, lastUpdate: null },
  }, { now: NOW });
  assert.equal(snap.feedState, 'unavailable');
  const envelope = feedProvenanceEnvelope([snap]);
  assert.equal(envelope.overall, 'unavailable');
  assert.match(envelope.note, /UNAVAILABLE/);
});

test('fallback provenance names the fallback source instead of calling it live', () => {
  const snap = layerSnapshot({
    id: 'flights',
    name: 'Live Flights',
    enabled: true,
    stats: { source: 'adsb.lol fallback', count: 40, lastUpdate: NOW - 8_000 },
  }, { now: NOW });
  assert.equal(snap.feedState, 'fallback');
  assert.match(feedProvenanceNote([snap], 'fallback'), /adsb\.lol fallback/);
});

test('view-state rows keep the existing identity fields and add feedState', () => {
  const row = viewStateLayerRow({
    id: 'flights',
    name: 'Live Flights',
    enabled: true,
    stats: { count: 9, lastUpdate: 42, error: null, source: 'OpenSky Network' },
  }, { now: NOW });
  assert.deepEqual(row, {
    id: 'flights',
    name: 'Live Flights',
    enabled: true,
    count: 9,
    error: null,
    feedState: 'nominal',
    source: 'OpenSky Network',
    lastUpdate: 42,
  });
});

test('empty roster envelope does not pretend to be nominal', () => {
  const envelope = feedProvenanceEnvelope([]);
  assert.equal(envelope.overall, null);
  assert.match(envelope.note, /Do not invent/);
});

test('age labels match the Data Layers meta clock', () => {
  assert.equal(snapshotAgeSec(null, NOW), null);
  assert.equal(snapshotAgeLabel(NOW - 3_000, NOW), 'just now');
  assert.equal(snapshotAgeLabel(NOW - 12_000, NOW), '12s ago');
  assert.equal(snapshotAgeLabel(NOW - 240_000, NOW), '4m ago');
  assert.equal(snapshotAgeLabel(NOW - 7_200_000, NOW), '2h ago');
});
