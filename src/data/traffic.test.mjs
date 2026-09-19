// src/data/traffic.test.mjs
// Feed-state honesty for the traffic layer (roadmap L7).
//
// A launch-day stranger runs a keyless build. The layer then simulates
// traffic, and every surface it drives — the toggle chip, the panel meta
// line, the traffic sync chip — has to say so. The two pure helpers below own
// that contract; the layer's getStats() is a thin caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import trafficLayer, {
  deriveTrafficFlowError,
  trafficFeedPresentation,
} from './traffic.js';
import { DataLayerManager, layerFeedState } from './manager.js';
import {
  TRAFFIC_KEYLESS_REASON,
  TRAFFIC_STATUS_UNREACHABLE_REASON,
} from '../layers/traffic/model.js';
import { normalizeLayerLoading } from '../loadingFeedback.js';

const KEYLESS_META =
  'DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds)';

/**
 * The app's live markers. Case-SENSITIVE on purpose: uppercase LIVE/GPS is
 * how this UI asserts a real feed ("LIVE · TomTom flow", the old "initiating
 * global GPS sync"), while lowercase "add TomTom key for live" names the
 * remedy without claiming one.
 */
const LIVE_CLAIM = /\bLIVE\b|\bGPS\b|\breal[- ]?time\b/;

test('a superseded flow fetch is not an outage', () => {
  assert.equal(deriveTrafficFlowError({ name: 'AbortError', message: 'aborted' }), null);
  assert.equal(deriveTrafficFlowError(null), null);
  assert.equal(deriveTrafficFlowError(undefined), null);
});

test('flow failures map onto short, specific reasons', () => {
  const reason = (message) => deriveTrafficFlowError(new Error(message));
  assert.equal(reason('flow tile 12/1/1: HTTP 503'), 'TomTom key unavailable');
  assert.equal(reason('flow tile 12/1/1: HTTP 429'), 'TomTom daily budget reached');
  assert.equal(reason('flow tile 12/1/1: HTTP 502'), 'TomTom upstream unreachable');
  assert.equal(reason('flow tile 12/1/1: HTTP 504'), 'TomTom upstream unreachable');
  assert.equal(reason('flow tile 12/1/1: HTTP 418'), 'TomTom flow error (HTTP 418)');
  assert.equal(reason('flow fetch failed'), 'TomTom flow unavailable');
});

test('structured proxy failures name the real cause ahead of the HTTP code', () => {
  const structured = (code, status, providerError = null) =>
    deriveTrafficFlowError(
      Object.assign(new Error(`flow tile 12/1/1: HTTP ${status} ${code}`), {
        status,
        code,
        provider: providerError ? { status: 'unavailable', error: providerError } : null,
      }),
    );
  assert.equal(structured('bad_key', 503), 'TomTom rejected TOMTOM_API_KEY');
  assert.equal(structured('no_key', 503), 'TomTom key unavailable');
  assert.equal(structured('budget', 429), 'TomTom daily budget reached');
  assert.equal(
    structured('upstream', 503, 'TomTom flow tile unreachable (timed out after 10000 ms)'),
    'TomTom flow tile unreachable (timed out after 10000 ms)',
  );
  assert.equal(structured('upstream', 503), 'TomTom upstream unreachable');
  assert.equal(
    structured('rate_limited', 503, 'TomTom rate limited (retry in 30s)'),
    'TomTom rate limited (retry in 30s)',
  );
});

test('keyless traffic names the mode and the remedy, loading or idle', () => {
  const idle = trafficFeedPresentation({ liveMode: false, fetching: false });
  const loading = trafficFeedPresentation({ liveMode: false, fetching: true });
  assert.equal(idle.mode, 'sim');
  assert.equal(loading.mode, 'sim');
  // Keyless is a designed fallback, not a fault — `error` stays null, or every
  // keyless build would flash LOAD FAILED after each load
  // (src/loadingFeedback.js reads `stats.error` as a batch failure) and read
  // UNAVAILABLE before its first roads render (layerFeedState). The row still
  // reads DEGRADED: the reason travels in the structured provider fields.
  assert.equal(idle.error, null);
  assert.equal(loading.error, null);
  for (const feed of [idle, loading]) {
    assert.equal(feed.status, 'degraded');
    assert.equal(feed.degraded, true);
    assert.equal(feed.providerStatus, 'degraded');
    assert.equal(feed.providerSource, 'TomTom');
    assert.equal(feed.source, 'TomTom');
    assert.equal(feed.providerError, TRAFFIC_KEYLESS_REASON);
    assert.match(feed.providerError, /^TOMTOM_API_KEY not set — /);
  }
  // One terse line in both states; the chip's progress text carries "working".
  assert.equal(idle.loadingLabel, 'SIMULATED — add TomTom key for live');
  assert.equal(loading.loadingLabel, 'SIMULATED — add TomTom key for live');
});

test('before the status probe has answered, nothing is claimed about the key', () => {
  const unprobed = trafficFeedPresentation({ liveMode: false, statusResolved: false });
  assert.equal(unprobed.mode, 'sim');
  assert.equal(unprobed.error, null);
  assert.equal(unprobed.status, null);
  assert.equal(unprobed.providerStatus, null);
  assert.equal(unprobed.providerError, null);
  assert.equal(unprobed.loadingLabel, 'SIMULATED — add TomTom key for live');
  assert.equal(layerFeedState({ count: 0, lastUpdate: null, ...unprobed }), 'fallback');
});

test('no keyless label ever implies a live feed', () => {
  const labels = [
    trafficFeedPresentation({ liveMode: false, fetching: false }),
    trafficFeedPresentation({ liveMode: false, fetching: true }),
    trafficFeedPresentation({ statusUnavailable: true }),
    trafficFeedPresentation({ liveMode: true, flowError: 'TomTom flow unavailable' }),
    trafficFeedPresentation({ liveMode: true, fetching: true, flowError: 'TomTom flow unavailable' }),
  ].map((feed) => feed.loadingLabel);
  for (const label of labels) {
    assert.ok(!LIVE_CLAIM.test(label), `label implies live data: ${label}`);
    assert.ok(label.startsWith('SIMULATED'), `fallback label must lead with the mode: ${label}`);
  }
});

test('simulating because the status probe failed reads differently from keyless by design', () => {
  const probeDown = trafficFeedPresentation({ statusUnavailable: true });
  assert.equal(probeDown.mode, 'sim');
  assert.equal(probeDown.loadingLabel, 'SIMULATED — traffic service unreachable');
  // Unlike keyless, an unreachable status probe IS a fault: it carries `error`.
  assert.equal(probeDown.error, TRAFFIC_STATUS_UNREACHABLE_REASON);
  assert.equal(probeDown.error, 'TomTom status unreachable — simulated flow');
  assert.equal(probeDown.degraded, true);
  assert.equal(probeDown.status, 'degraded');
  assert.equal(probeDown.providerStatus, 'degraded');
  assert.equal(probeDown.providerError, probeDown.error);
});

test('a healthy keyed layer reports live flow with its real coverage', () => {
  const idle = trafficFeedPresentation({ liveMode: true, coveragePct: 87 });
  assert.equal(idle.mode, 'live');
  assert.equal(idle.error, null);
  assert.equal(idle.loadingLabel, 'LIVE · TomTom flow · 87% cov');
  assert.equal(idle.status, 'live');
  assert.equal(idle.providerStatus, 'live');
  assert.equal(idle.providerSource, 'TomTom');
  assert.equal(idle.providerError, null);
  assert.equal(idle.degraded, false);
  assert.equal(idle.stale, false);
  assert.equal(idle.coverage, '87% flow cov');
  assert.equal(
    trafficFeedPresentation({ liveMode: true, fetching: true }).loadingLabel,
    'syncing LIVE traffic flow',
  );
});

test('tiles served from the proxy last-good store read STALE, not LIVE', () => {
  const stale = trafficFeedPresentation({
    liveMode: true,
    coveragePct: 61,
    flowProviderStatus: 'stale',
  });
  assert.equal(stale.mode, 'live');
  assert.equal(stale.error, null);
  assert.equal(stale.stale, true);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.providerStatus, 'stale');
  assert.equal(stale.source, 'TomTom');
  assert.equal(layerFeedState({ count: 500, lastUpdate: Date.now(), ...stale }), 'stale');
  assert.match(
    new DataLayerManager({})._buildMetaText({
      source: 'OpenStreetMap',
      stats: { count: 500, lastUpdate: Date.now() - 60_000, ...stale },
    }),
    /^STALE · TomTom · 1m ago/,
  );
});

test('a rejected key degrades the keyed layer and names the variable', () => {
  const rejected = trafficFeedPresentation({
    liveMode: true,
    probeError: 'TomTom rejected TOMTOM_API_KEY',
  });
  assert.equal(rejected.mode, 'live');
  assert.equal(rejected.error, 'SIMULATED — TomTom rejected TOMTOM_API_KEY');
  assert.equal(rejected.providerError, 'TomTom rejected TOMTOM_API_KEY');
  assert.equal(rejected.degraded, true);
  assert.equal(rejected.providerStatus, 'degraded');
  // A real tile failure outranks the probe's early warning.
  assert.equal(
    trafficFeedPresentation({
      liveMode: true,
      probeError: 'TomTom rejected TOMTOM_API_KEY',
      flowError: 'TomTom daily budget reached',
    }).error,
    'SIMULATED — TomTom daily budget reached',
  );
});

test('a mid-session flow outage degrades instead of reporting stale live coverage', () => {
  const down = trafficFeedPresentation({
    liveMode: true,
    flowError: 'TomTom daily budget reached',
    coveragePct: 87, // last-good number — must not be presented as current
  });
  // error and loadingLabel are ONE string: the manager's error branch renders
  // `error` and drops `loadingLabel`, so the copy has to live in both.
  assert.equal(down.error, 'SIMULATED — TomTom daily budget reached');
  assert.equal(down.loadingLabel, down.error);
  assert.ok(!down.loadingLabel.includes('87'));
  const busy = trafficFeedPresentation({
    liveMode: true,
    fetching: true,
    flowError: 'TomTom daily budget reached',
  });
  assert.deepEqual(busy, down, 'the degraded state reads the same whether or not a load is in flight');
});

test('the rendered steady-state meta line names the TomTom key, not a silent FALLBACK', () => {
  const mgr = new DataLayerManager({});
  const stats = (feed) => ({ count: 544, lastUpdate: Date.now(), ...feed });
  assert.equal(
    mgr._buildMetaText({
      source: 'OpenStreetMap',
      stats: stats(trafficFeedPresentation({ liveMode: false })),
    }),
    KEYLESS_META,
  );
  // Before the first roads render the row already says why it is degraded —
  // never UNAVAILABLE, which the old `error` route would have produced.
  assert.equal(
    mgr._buildMetaText({
      source: 'OpenStreetMap',
      stats: { count: 0, lastUpdate: null, ...trafficFeedPresentation({ liveMode: false }) },
    }),
    KEYLESS_META,
  );
  assert.equal(
    mgr._buildMetaText({
      source: 'OpenStreetMap',
      stats: stats(trafficFeedPresentation({
        liveMode: true,
        flowError: 'TomTom daily budget reached',
      })),
    }),
    'DEGRADED · TomTom · SIMULATED — TomTom daily budget reached',
  );
  assert.equal(
    mgr._buildMetaText({
      source: 'OpenStreetMap',
      stats: stats(trafficFeedPresentation({ statusUnavailable: true })),
    }),
    'DEGRADED · TomTom · TomTom status unreachable — simulated flow',
  );
  // Live and healthy keeps the roads' source with the live label and coverage.
  assert.equal(
    mgr._buildMetaText({
      source: 'OpenStreetMap',
      stats: stats(trafficFeedPresentation({ liveMode: true, coveragePct: 87 })),
    }),
    'OpenStreetMap · LIVE · TomTom flow · 87% cov',
  );
});

test('the manager reads keyless as DEGRADED, an outage as DEGRADED and healthy live as ON', () => {
  const settled = { count: 4200, lastUpdate: Date.now() };
  const keyless = trafficFeedPresentation({ liveMode: false });
  assert.equal(layerFeedState({ ...settled, ...keyless }), 'degraded');
  // With no roads yet the row is still DEGRADED (not UNAVAILABLE), and a
  // running load still reads LOADING.
  assert.equal(layerFeedState({ count: 0, lastUpdate: null, ...keyless }), 'degraded');
  assert.equal(
    layerFeedState({ count: 0, lastUpdate: null, loading: true, ...keyless }),
    'loading',
  );
  assert.equal(
    layerFeedState({ ...settled, ...trafficFeedPresentation({ liveMode: true }) }),
    'nominal',
  );
  assert.equal(
    layerFeedState({
      ...settled,
      ...trafficFeedPresentation({ liveMode: true, flowError: 'TomTom flow unavailable' }),
    }),
    'degraded',
  );
  assert.equal(
    layerFeedState({ ...settled, ...trafficFeedPresentation({ statusUnavailable: true }) }),
    'degraded',
  );
});

test('keyless simulation never turns the global loading batch into LOAD FAILED', () => {
  const record = normalizeLayerLoading({
    id: 'traffic',
    name: 'Street Traffic',
    enabled: true,
    stats: { count: 544, lastUpdate: Date.now(), ...trafficFeedPresentation({ liveMode: false }) },
  });
  assert.equal(record.error, null);
  assert.equal(record.unavailable, false);
  assert.equal(record.keyRequired, false);
  assert.equal(record.degraded, true);
});

test('the shipped layer boots keyless-honest before any status check', () => {
  const stats = trafficLayer.getStats();
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.error, null);
  assert.ok(!LIVE_CLAIM.test(stats.loadingLabel), `boot label implies live data: ${stats.loadingLabel}`);
  assert.equal(layerFeedState(stats), 'fallback');
});

test('traffic can be destroyed before its first enable and destroyed repeatedly', async () => {
  const { default: traffic } = await import('./traffic.js');
  const viewer = { camera: { changed: { removeEventListener() {} } } };
  assert.doesNotThrow(() => traffic.destroy(viewer));
  assert.doesNotThrow(() => traffic.destroy(viewer));
  assert.equal(traffic.getStats().count, 0);
});

test('a refused or unreachable Overpass road fetch is named for the operator, not shown as a bare HTTP code', async () => {
  const { describeRoadError } = await import('../layers/traffic/ingestion.js');
  assert.match(
    describeRoadError(new Error('Overpass API returned 406')),
    /^OpenStreetMap roads unavailable — public Overpass mirrors refuse this deployment \(HTTP 406\)/,
  );
  assert.match(
    describeRoadError(new Error('Overpass API returned 502')),
    /Overpass mirrors unreachable \(HTTP 502\)/,
  );
  assert.equal(
    describeRoadError(new Error('Overpass API returned 429')),
    'OpenStreetMap roads unavailable — Overpass rate limited; retrying',
  );
  assert.match(
    describeRoadError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
    /timed out$/,
  );
  assert.equal(describeRoadError(new Error('Malformed road snapshot')), 'Road data temporarily unavailable');
});
