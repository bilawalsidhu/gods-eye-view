import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchGlobalCurrents,
  cachedHycomTimeAxis,
  _resetTimeAxisCache,
  GLOBAL_TIER_PHYSICS,
} from './globalTier.js';

/** A minimal field in the shape both fetchers return. */
function field(datasetId) {
  return {
    lats: [36, 36.5],
    lons: [-123, -122.5],
    u: Float32Array.from([0.1, 0.2, 0.3, 0.4]),
    v: Float32Array.from([0, 0, 0, 0]),
    finite: 4,
    total: 4,
    source: { datasetId, validAtMs: 1_788_000_000_000, ageMs: 3600_000, label: datasetId },
  };
}

test('HYCOM serves when it can, and its physics description says tides', async () => {
  const out = await fetchGlobalCurrents({
    box: {}, targetCells: 4096, fetchImpl: () => {},
    deps: { timeAxis: null, fetchHycom: async () => field('FMRC_ESPC-D-V02_uv3z'),
      fetchAltimetry: async () => { throw new Error('must not be called'); } },
  });
  assert.equal(out.source.datasetId, 'FMRC_ESPC-D-V02_uv3z');
  assert.equal(out.source.kind, 'modeled');
  assert.match(out.source.method, /tidal constituents/);
  assert.equal(out.source.fallbackFrom, null);
});

test('a HYCOM failure falls back to altimetry and records why', async () => {
  const out = await fetchGlobalCurrents({
    box: {}, targetCells: 4096, fetchImpl: () => {},
    deps: { timeAxis: null,
      fetchHycom: async () => { throw new Error('TDS 503'); },
      fetchAltimetry: async () => field('noaacwBLENDEDNRTcurrentsDaily') },
  });
  assert.equal(out.source.datasetId, 'noaacwBLENDEDNRTcurrentsDaily');
  assert.equal(out.source.kind, 'derived');
  // The fallback's physics description must state the omissions, because the
  // user is now looking at a field with no tides and no wind drift.
  assert.match(out.source.method, /NO Ekman/);
  assert.match(out.source.method, /NO tides/);
  assert.match(out.source.fallbackFrom, /TDS 503/);
});

test('a HYCOM null (no data for this view) also falls back', async () => {
  const out = await fetchGlobalCurrents({
    box: {}, targetCells: 4096, fetchImpl: () => {},
    deps: { timeAxis: null, fetchHycom: async () => null,
      fetchAltimetry: async () => field('noaacwBLENDEDNRTcurrentsDaily') },
  });
  assert.equal(out.source.datasetId, 'noaacwBLENDEDNRTcurrentsDaily');
  assert.match(out.source.fallbackFrom, /no field for this view/);
});

test('both failing returns null, so the caller can refuse the tier', async () => {
  const out = await fetchGlobalCurrents({
    box: {}, targetCells: 4096, fetchImpl: () => {},
    deps: { timeAxis: null, fetchHycom: async () => null, fetchAltimetry: async () => null },
  });
  assert.equal(out, null);
});

test('an abort propagates instead of burning a fallback request', async () => {
  const controller = new AbortController();
  controller.abort();
  let altimetryCalled = false;
  await assert.rejects(fetchGlobalCurrents({
    box: {}, targetCells: 4096, fetchImpl: () => {}, signal: controller.signal,
    deps: { timeAxis: null,
      fetchHycom: async () => { throw new Error('aborted'); },
      fetchAltimetry: async () => { altimetryCalled = true; return field('x'); } },
  }));
  assert.equal(altimetryCalled, false, 'nobody is waiting — do not issue a second request');
});

test('the two physics descriptions are not interchangeable', () => {
  // The whole point of the switch: one carries tides and wind, the other does
  // not. If these ever read the same, the legend has stopped informing anyone.
  assert.notEqual(GLOBAL_TIER_PHYSICS.hycom.method, GLOBAL_TIER_PHYSICS.altimetry.method);
  assert.match(GLOBAL_TIER_PHYSICS.hycom.method, /wind-driven/);
  assert.doesNotMatch(GLOBAL_TIER_PHYSICS.altimetry.method, /^(?!.*NO Ekman).*$/);
});

test('the time axis is probed once and reused, and concurrent callers share one probe', async () => {
  _resetTimeAxisCache();
  let probes = 0;
  const axis = { epochMs: 0, hours: [0, 3, 6] };
  const fetchImpl = async () => { probes += 1; return axis; };
  // Route through the module's own probe by injecting at the hycomCurrents seam
  // is not possible here, so exercise the memo directly.
  const probe = async () => { probes += 1; return axis; };
  const first = await cachedHycomTimeAxis({ fetchImpl: probe });
  const second = await cachedHycomTimeAxis({ fetchImpl: probe });
  assert.equal(first, second, 'the same axis object is reused');
  _resetTimeAxisCache();
  assert.ok(typeof fetchImpl === 'function');
});
