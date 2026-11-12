/**
 * Schedule packs are opt-in build output: the catalog lists a live feed
 * whose trains are named only through its pack (`routesFrom: 'schedule'`)
 * once the pack is built (as `hasSchedulePack`, the pack version or the
 * pack reader tells), every other feed always, and a failing probe never
 * hides a feed. Without any of them no such feed is listed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SCHEDULE_PACK_PROBE_TTL_MS,
  createRailService,
} from '../sources/railService.js';
import {
  getRegisteredRailFeed,
  publicRailCatalog,
  railFeedNeedsSchedulePack,
} from '../data/railFeeds.js';
import {
  createFsSchedulePackProbe,
  createFsSchedulePackVersion,
} from '../../server/providers/rail.js';

const request = (path) => ({
  url: `https://example.test${path}`,
  method: 'GET',
});

async function catalogIds(service) {
  const response = await service.handle(request('/api/rail/feeds'));
  assert.equal(response.status, 200);
  const { feeds } = await response.json();
  return new Set(feeds.map((feed) => feed.id));
}

test('which feeds need their schedule pack', () => {
  // Live GTFS-RT whose vehicles carry no route.
  for (const id of ['renfe-larga-distancia', 'ktmb'])
    assert.equal(railFeedNeedsSchedulePack(getRegisteredRailFeed(id)), true);
  // Live, with routes of its own.
  assert.equal(
    railFeedNeedsSchedulePack(getRegisteredRailFeed('mbta-rail')),
    false,
  );
  // Irish Rail's train codes classify its trains without a pack.
  assert.equal(
    railFeedNeedsSchedulePack(getRegisteredRailFeed('irish-rail')),
    false,
  );
});

test('pack-routed feeds wait for their pack; other feeds stay', async (t) => {
  const service = createRailService({
    fetchImpl: async () => {
      throw new Error('no network in tests');
    },
    hasSchedulePack: async (feedId) => feedId === 'ktmb',
  });
  t.after(() => service.close());
  const ids = await catalogIds(service);
  assert.ok(ids.has('ktmb'), 'a built pack-routed feed is listed');
  assert.ok(!ids.has('renfe-larga-distancia'), 'an unbuilt one waits');
  assert.ok(ids.has('mbta-rail'), 'live feed is listed');
  assert.ok(ids.has('irish-rail'), 'Irish Rail is listed');
});

test('with no way to tell, no feed that needs a pack is listed', async (t) => {
  let calls = 0;
  const service = createRailService({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('no network in tests');
    },
  });
  t.after(() => service.close());
  const ids = await catalogIds(service);
  assert.ok(!ids.has('ktmb'), 'a pack-routed feed waits for its pack');
  assert.ok(!ids.has('renfe-larga-distancia'), 'all of them');
  assert.ok(ids.has('mbta-rail'), 'live feed is listed');
  const packless = publicRailCatalog().filter(
    (feed) => !railFeedNeedsSchedulePack(getRegisteredRailFeed(feed.id)),
  );
  assert.equal(ids.size, packless.length);
  // Nor are its trains or trip updates served, and the operator is not
  // contacted for them.
  for (const path of [
    '/api/rail/trains/renfe-larga-distancia',
    '/api/rail/trains/ktmb',
    '/api/rail/updates/renfe-larga-distancia',
  ]) {
    const response = await service.handle(request(path));
    if (response.status === 404) continue; // no trip updates route
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('X-Rail-Backoff'), 'schedule');
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
    assert.equal((await response.json()).error, 'Rail schedule unavailable');
  }
  assert.equal(calls, 0);
});

test('a pack reader alone tells what is built, its answers kept for the TTL', async (t) => {
  let now = 1_000_000;
  const reads = [];
  let built = false;
  const service = createRailService({
    fetchImpl: async () => {
      throw new Error('no network in tests');
    },
    now: () => now,
    readSchedulePack: async (feedId) => {
      reads.push(feedId);
      if (feedId === 'ktmb') return '{}';
      if (feedId === 'renfe-larga-distancia' && built) {
        const error = new Error('pack is 30000000 bytes');
        error.code = 'PACK_TOO_LARGE';
        throw error;
      }
      return null;
    },
  });
  t.after(() => service.close());
  let ids = await catalogIds(service);
  assert.ok(ids.has('ktmb'), 'a pack the reader returns is built');
  assert.ok(
    !ids.has('renfe-larga-distancia'),
    'a reader answering null: not built',
  );
  assert.ok(ids.has('mbta-rail'));
  const firstReads = reads.length;
  built = true;
  ids = await catalogIds(service);
  assert.ok(!ids.has('renfe-larga-distancia'), 'kept for the TTL');
  assert.equal(reads.length, firstReads);
  now += SCHEDULE_PACK_PROBE_TTL_MS;
  ids = await catalogIds(service);
  assert.ok(
    ids.has('renfe-larga-distancia'),
    'an oversized pack is built, and refused',
  );
});

test('a pack version alone tells what is built, without reading packs', async (t) => {
  let reads = 0;
  const service = createRailService({
    fetchImpl: async () => {
      throw new Error('no network in tests');
    },
    readSchedulePack: async () => {
      reads += 1;
      return '{}';
    },
    schedulePackVersion: async (feedId) => (feedId === 'ktmb' ? 'v1' : null),
  });
  t.after(() => service.close());
  const ids = await catalogIds(service);
  assert.ok(ids.has('ktmb'));
  assert.ok(!ids.has('renfe-larga-distancia'));
  assert.equal(reads, 0);
});

test('a failing probe lists the feed; answers are kept for the TTL', async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  let now = 1_000_000;
  let calls = 0;
  let built = false;
  const service = createRailService({
    fetchImpl: async () => {
      throw new Error('no network in tests');
    },
    now: () => now,
    hasSchedulePack: async (feedId) => {
      if (feedId === 'renfe-larga-distancia') {
        calls += 1;
        return built;
      }
      if (feedId === 'ktmb') throw new Error('EACCES');
      return false;
    },
  });
  t.after(() => service.close());
  let ids = await catalogIds(service);
  assert.ok(ids.has('ktmb'), 'probe failure shows the feed');
  assert.ok(!ids.has('renfe-larga-distancia'));
  // Built meanwhile: still hidden within the TTL, listed after it.
  built = true;
  ids = await catalogIds(service);
  assert.ok(!ids.has('renfe-larga-distancia'));
  assert.equal(calls, 1);
  now += SCHEDULE_PACK_PROBE_TTL_MS;
  ids = await catalogIds(service);
  assert.ok(ids.has('renfe-larga-distancia'));
  assert.equal(calls, 2);
});

test('the fs probe sees only a schedule pack file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rail-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'ktmb.schedule.json'), '{}');
  await writeFile(path.join(dir, 'mbta-rail.json'), '{}');
  await mkdir(path.join(dir, 'mta-lirr.schedule.json'));
  const probe = createFsSchedulePackProbe(dir);
  assert.equal(await probe('ktmb'), true);
  assert.equal(
    await probe('mbta-rail'),
    false,
    'a path pack alone is not built',
  );
  assert.equal(await probe('mta-lirr'), false, 'a directory is not a pack');
  assert.equal(await probe('../ktmb'), false, 'ids never leave the dir');
});

test('the fs pack version changes when the pack is rebuilt', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rail-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const version = createFsSchedulePackVersion(dir);
  assert.equal(await version('ktmb'), null, 'no pack, no version');
  const file = path.join(dir, 'ktmb.schedule.json');
  await writeFile(file, '{}');
  await utimes(file, 1_000, 1_000);
  const first = await version('ktmb');
  assert.equal(typeof first, 'string');
  assert.equal(await version('ktmb'), first, 'stable while unchanged');
  await writeFile(file, '{"trips":{}}');
  await utimes(file, 2_000, 2_000);
  assert.notEqual(await version('ktmb'), first);
  assert.equal(await version('../ktmb'), null, 'ids never leave the dir');
});
