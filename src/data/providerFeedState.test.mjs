// MOVEMENT proxies report a structured provider status (server/providers/
// common/upstream.js → X-Provider-* headers → src/sources/live/contract.js
// providerStatusFromResponse → layer stats.providerStatus). The DATA LAYERS
// row must read LIVE / STALE / DEGRADED with an age whenever data exists, and
// never a raw upstream code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager, layerFeedState } from './manager.js';

const minuteAgo = () => Date.now() - 60_000;

test('an explicit provider status outranks the source-name heuristics', () => {
  assert.equal(
    layerFeedState({
      count: 120,
      lastUpdate: minuteAgo(),
      source: 'adsb.lol',
      providerStatus: 'degraded',
    }),
    'degraded',
    'a regional fallback feed reads DEGRADED, not FALLBACK',
  );
  assert.equal(
    layerFeedState({
      count: 120,
      lastUpdate: minuteAgo(),
      mode: 'sim',
      status: 'degraded',
      error: 'TOMTOM_API_KEY not set',
    }),
    'degraded',
    'keyless traffic simulation reads DEGRADED with its reason',
  );
  assert.equal(
    layerFeedState({
      count: 838,
      lastUpdate: minuteAgo(),
      source: 'CelesTrak',
      providerStatus: 'stale',
    }),
    'stale',
  );
  assert.equal(
    layerFeedState({
      count: 42,
      lastUpdate: minuteAgo(),
      source: 'OpenSky Network',
      providerStatus: 'live',
    }),
    'nominal',
  );
  // Prior data + an error is degraded, never unavailable.
  assert.equal(
    layerFeedState({
      count: 42,
      lastUpdate: minuteAgo(),
      error: 'OpenSky unreachable from this deployment',
    }),
    'degraded',
  );
  // The legacy mode:'sim' fallback presentation is untouched when nothing
  // explicit is reported.
  assert.equal(
    layerFeedState({ count: 120, lastUpdate: minuteAgo(), mode: 'sim' }),
    'fallback',
  );
});

test('layer metadata names LIVE / STALE / DEGRADED with the data age', () => {
  const mgr = new DataLayerManager({});
  assert.match(
    mgr._buildMetaText({
      source: 'OpenSky Network',
      stats: { count: 42, lastUpdate: minuteAgo(), providerStatus: 'live' },
    }),
    /^LIVE · OpenSky Network · 1m ago$/,
  );
  assert.match(
    mgr._buildMetaText({
      source: 'CelesTrak',
      stats: {
        count: 838,
        lastUpdate: minuteAgo(),
        providerStatus: 'stale',
        stale: true,
      },
    }),
    /^STALE · CelesTrak · 1m ago/,
  );
  assert.equal(
    mgr._buildMetaText({
      source: 'adsb.lol',
      stats: {
        count: 17,
        lastUpdate: minuteAgo(),
        providerStatus: 'degraded',
        providerError:
          'OpenSky unreachable from this deployment (connect timeout) — adsb.lol regional feed',
      },
    }),
    'DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) — adsb.lol regional feed',
  );
  assert.equal(
    mgr._buildMetaText({
      source: 'AISStream',
      stats: {
        count: 0,
        lastUpdate: null,
        status: 'empty',
        statusMessage: 'No vessels in scene',
      },
    }),
    'AISStream · No vessels in scene',
    'an honestly empty scene is guidance, not UNAVAILABLE',
  );
  assert.equal(
    mgr._buildMetaText({
      source: 'TomTom',
      stats: {
        count: 0,
        lastUpdate: null,
        loading: true,
        loadingLabel: 'SIMULATED — add TomTom key for live',
        providerStatus: 'degraded',
        providerError: 'TOMTOM_API_KEY not set — showing simulated flow on live OSM roads',
      },
    }),
    'DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads · SIMULATED — add TomTom key for live',
    'a keyless provider is named DEGRADED while its roads are still loading',
  );
  // No data at all still reads UNAVAILABLE — with the proxy's human reason.
  assert.equal(
    mgr._buildMetaText({
      source: 'AISStream',
      stats: {
        count: 0,
        lastUpdate: null,
        error: 'API key rejected — check AISSTREAM_API_KEY',
      },
    }),
    'UNAVAILABLE · AISStream · API key rejected — check AISSTREAM_API_KEY',
  );
});
