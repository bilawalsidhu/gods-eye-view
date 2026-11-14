// src/data/placePacksLoading.test.mjs — the loading status hears the place
// packs while they are on their way.
import test from 'node:test';
import assert from 'node:assert/strict';

test('a place pack load is reported from its start to its end', async () => {
  // A module of its own, so no other test has loaded the packs yet.
  const place = await import('./placeBelow.js?loading-status');
  const heard = [];
  const stop = place.onPlacePacksLoadingChange(() =>
    heard.push(place.placePacksStatus().loading),
  );
  assert.equal(place.placePacksStatus().loading, false);
  const lookup = place.nearPlace(48.86, 2.35, 50);
  assert.equal(place.placePacksStatus().loading, true, 'on its way');
  assert.equal(await lookup, 'Paris');
  assert.equal(place.placePacksStatus().loading, false, 'loaded');
  assert.deepEqual(heard, [true, false]);
  // Loaded once: a later lookup is not reported again.
  await place.nearPlace(48.86, 2.35, 50);
  assert.deepEqual(heard, [true, false]);
  stop();
});

test('a pack that would not load stays failed until it loads', async () => {
  const place = await import('./placeBelow.js?failed-status');
  let fail = true;
  const load = place.reportedPlacePackLoad('test', async () => {
    if (fail) throw new Error('offline');
    return 1;
  });
  await assert.rejects(load(), /offline/);
  assert.deepEqual(place.placePacksStatus(), { loading: false, failed: true });
  fail = false;
  const retry = load();
  assert.deepEqual(
    place.placePacksStatus(),
    { loading: true, failed: false },
    'a retry is not a failure until it fails',
  );
  assert.equal(await retry, 1);
  assert.deepEqual(place.placePacksStatus(), { loading: false, failed: false });
});

test('one lookup that loads several packs reads as one load', async () => {
  const place = await import('./placeBelow.js?one-lookup');
  const heard = [];
  const stop = place.onPlacePacksLoadingChange(() => {
    const { loading } = place.placePacksStatus();
    if (heard.at(-1) !== loading) heard.push(loading);
  });
  // On land with a radius: countries and seas, then divisions, then places.
  const found = await place.placeBelow(48.86, 2.35, { nearKm: 50 });
  assert.equal(found.near, 'Paris');
  assert.deepEqual(heard, [true, false], 'no gap between the packs');
  stop();
});

/** Two stand-in packs (not real pack names) that fail while named in `fail`. */
function standInPacks(place, fail) {
  const pack = (name) =>
    place.reportedPlacePackLoad(name, async () => {
      if (fail.has(name)) throw new Error('offline');
      return name;
    });
  return { first: pack('stand-in-first'), second: pack('stand-in-second') };
}

/** The statuses one lookup that loads both stand-ins reports, start to end. */
async function lookupStatuses(place, { first, second }) {
  const statuses = [];
  const stop = place.onPlacePacksLoadingChange(() =>
    statuses.push(place.placePacksStatus()),
  );
  await place.placeBelow(48.86, 2.35, {
    detail: { division: async () => first(), near: async () => second() },
  });
  stop();
  return statuses;
}

test('a load is not blamed for packs that failed in an earlier one', async () => {
  const place = await import('./placeBelow.js?two-failed');
  const fail = new Set(['stand-in-first', 'stand-in-second']);
  const packs = standInPacks(place, fail);
  await assert.rejects(packs.first());
  await assert.rejects(packs.second());
  assert.equal(place.placePacksStatus().failed, true);
  fail.clear();
  const statuses = await lookupStatuses(place, packs);
  assert.deepEqual(statuses[0], { loading: true, failed: false });
  assert.ok(
    statuses.every((status) => status.failed === false),
    'the earlier failures do not colour this load',
  );
  assert.deepEqual(place.placePacksStatus(), {
    loading: false,
    failed: false,
  });
});

test('a pack that fails in a load keeps it failed when the next one lands', async () => {
  const place = await import('./placeBelow.js?mixed');
  const packs = standInPacks(place, new Set(['stand-in-first']));
  const statuses = await lookupStatuses(place, packs);
  assert.deepEqual(statuses.at(-1), { loading: false, failed: true });
  assert.deepEqual(place.placePacksStatus(), {
    loading: false,
    failed: true,
  });
});
