import test from 'node:test';
import assert from 'node:assert/strict';
import { createSatellitesLayer } from './index.js';
import { summarizeProviderStatus } from './ingestion.js';
import { CATALOG_GROUPS } from './policy.js';

/** A parseable TLE under an arbitrary catalog number (never the ISS). */
const tleFor = (satnum, name) =>
  [
    name,
    `1 ${satnum}U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927`,
    `2 ${satnum}  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`,
  ].join('\n');

const LIVE_AT = Date.parse('2026-09-18T12:00:00.000Z');
const SNAPSHOT_AT = Date.parse('2026-09-18T00:00:00.000Z');

const live = (overrides = {}) => ({
  status: 'live',
  source: 'CelesTrak',
  fetchedAtMs: LIVE_AT,
  ageSec: 0,
  error: null,
  count: 1,
  ...overrides,
});
const stale = (overrides = {}) =>
  live({
    status: 'stale',
    source: 'CelesTrak (bundled snapshot)',
    fetchedAtMs: SNAPSHOT_AT,
    error: 'CelesTrak HTTP 403',
    ...overrides,
  });

function services() {
  const stubs = Object.fromEntries(
    [
      'picking',
      'focus',
      'readout',
      'overlays',
      'context',
      'render',
      'layerState',
    ].map((key) => [key, {}]),
  );
  stubs.layerState.isExplicitLayerStateOrigin = () => false;
  return stubs;
}

const viewer = { scene: { primitives: { add: (p) => p, remove() {} } } };

/**
 * A layer over a scripted source. `script(group)` returns the readGroup
 * result for that CelesTrak group path (see CATALOG_GROUPS in policy.js).
 */
function layerOver(t, script) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let satnum = 40000;
  const layer = createSatellitesLayer({
    services: services(),
    source: {
      async readGroup(group) {
        const result = script(group);
        if (result.ok && result.text === undefined) {
          satnum += 1;
          result.text = tleFor(
            String(satnum),
            `${group.toUpperCase()}-${satnum}`,
          );
        }
        return {
          text: '',
          status: 200,
          provider: null,
          error: null,
          ...result,
        };
      },
    },
  });
  layer._setDenseCatalogStateForTest({});
  t.after(() => layer._clearDenseCatalogStateForTest());
  return layer;
}

test('summarizeProviderStatus: STALE if any loaded group is stale, oldest fetch time, first error (loaded groups first)', () => {
  assert.deepEqual(
    summarizeProviderStatus([
      { ok: true, provider: live() },
      { ok: true, provider: stale() },
      { ok: false, provider: null, error: 'CelesTrak HTTP 503' },
    ]),
    {
      status: 'stale',
      error: 'CelesTrak HTTP 403',
      fetchedAtMs: SNAPSHOT_AT,
      source: 'CelesTrak',
    },
  );
  assert.deepEqual(
    summarizeProviderStatus([
      { ok: true, provider: live() },
      {
        ok: false,
        provider: { status: 'unavailable', error: 'CelesTrak timed out' },
      },
    ]),
    {
      status: 'live',
      error: 'CelesTrak timed out',
      fetchedAtMs: LIVE_AT,
      source: 'CelesTrak',
    },
  );
  assert.equal(
    summarizeProviderStatus([
      { ok: true, provider: live() },
      { ok: true, provider: live({ status: 'degraded', error: 'demo feed' }) },
    ]).status,
    'degraded',
  );
  // A legacy proxy (no headers) reports nothing rather than pretending LIVE.
  assert.deepEqual(
    summarizeProviderStatus([
      { ok: true, provider: null },
      { ok: false, provider: null },
    ]),
    { status: null, error: null, fetchedAtMs: null, source: null },
  );
});

test('a catalog served live by every group reads LIVE with the data-fetch time as lastUpdate', async (t) => {
  const layer = layerOver(t, () => ({ ok: true, provider: live() }));
  await layer.update(viewer);
  const stats = layer.getStats();
  assert.equal(stats.status, 'nominal');
  assert.equal(stats.error, null);
  assert.equal(stats.providerStatus, 'live');
  assert.equal(stats.providerError, null);
  assert.equal(stats.providerSource, 'CelesTrak');
  assert.equal(stats.stale, false);
  assert.equal(
    stats.lastUpdate,
    LIVE_AT,
    'the age shown is the age of the DATA',
  );
  assert.equal(stats.providerFetchedAt, LIVE_AT);
});

test('one group from the bundled snapshot makes the whole catalog STALE, with the oldest fetch time and the proxy reason', async (t) => {
  const layer = layerOver(t, (group) => ({
    ok: true,
    provider: group === 'geo' ? stale() : live(),
  }));
  await layer.update(viewer);
  const stats = layer.getStats();
  assert.equal(
    stats.status,
    'nominal',
    'nothing FAILED — every group has data',
  );
  assert.equal(stats.error, null, 'a stale answer is not an outage');
  assert.equal(stats.providerStatus, 'stale');
  assert.equal(stats.stale, true);
  assert.equal(stats.providerError, 'CelesTrak HTTP 403');
  assert.equal(stats.lastUpdate, SNAPSHOT_AT);
  assert.equal(
    stats.providerSource,
    'CelesTrak',
    'first loaded group names the source',
  );
});

test('a partial outage stays DEGRADED with the group count, and names the proxy reason of the failed groups', async (t) => {
  const failing = new Set(['glo-ops', 'galileo']);
  const layer = layerOver(t, (group) =>
    failing.has(group)
      ? {
          ok: false,
          status: 503,
          provider: {
            status: 'unavailable',
            source: 'CelesTrak',
            fetchedAtMs: null,
            ageSec: null,
            error: 'CelesTrak timed out — no cached TLEs',
            count: null,
          },
          error: 'CelesTrak timed out — no cached TLEs',
        }
      : { ok: true, provider: live() },
  );
  await layer.update(viewer);
  const stats = layer.getStats();
  assert.equal(stats.status, 'degraded');
  assert.equal(stats.error, '2 CelesTrak groups unavailable');
  assert.equal(
    stats.providerStatus,
    'live',
    'the groups that DID load were live',
  );
  assert.equal(stats.stale, false);
  assert.equal(stats.providerError, 'CelesTrak timed out — no cached TLEs');
  assert.equal(stats.lastUpdate, LIVE_AT);
});

test('an all-groups failure keeps "CelesTrak unreachable" and the provider state of the catalog still on screen', async (t) => {
  let down = false;
  const layer = layerOver(t, () =>
    down
      ? {
          ok: false,
          status: 503,
          provider: {
            status: 'unavailable',
            error: 'CelesTrak HTTP 403 — no cached TLEs',
          },
          error: 'CelesTrak HTTP 403 — no cached TLEs',
        }
      : { ok: true, provider: live() },
  );
  await layer.update(viewer);
  assert.equal(layer.getStats().providerStatus, 'live');
  down = true;
  await layer.update(viewer);
  const stats = layer.getStats();
  assert.equal(stats.error, 'CelesTrak unreachable');
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.stale, false);
  assert.equal(
    stats.providerStatus,
    'live',
    'describes the catalog kept on screen',
  );
  assert.equal(
    stats.lastUpdate,
    LIVE_AT,
    'the outage never restamps the data age',
  );
  assert.equal(stats.providerError, 'CelesTrak HTTP 403 — no cached TLEs');
  assert.equal(CATALOG_GROUPS.length, 6);
});

test('a legacy proxy without provider headers reports no provider state and the client refresh time', async (t) => {
  const before = Date.now();
  const layer = layerOver(t, () => ({ ok: true }));
  await layer.update(viewer);
  const stats = layer.getStats();
  assert.equal(stats.providerStatus, null);
  assert.equal(stats.providerError, null);
  assert.equal(stats.stale, false);
  assert.equal(stats.status, 'nominal');
  assert.ok(stats.lastUpdate >= before);
});
