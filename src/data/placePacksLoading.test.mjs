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

test('a load is not blamed for packs that failed in an earlier one', async () => {
  const place = await import('./placeBelow.js?two-failed');
  let fail = true;
  const pack = (name) =>
    place.reportedPlacePackLoad(name, async () => {
      if (fail) throw new Error('offline');
      return name;
    });
  const divisions = pack('divisions');
  const places = pack('places');
  await assert.rejects(divisions());
  await assert.rejects(places());
  assert.equal(place.placePacksStatus().failed, true);
  fail = false;
  // One lookup retries both, one after the other.
  const lookup = place.placeBelow(48.86, 2.35, {
    detail: {
      division: async () => divisions(),
      near: async () => places(),
    },
  });
  const statuses = [];
  const stop = place.onPlacePacksLoadingChange(() =>
    statuses.push(place.placePacksStatus()),
  );
  await lookup;
  stop();
  assert.ok(statuses.length > 0);
  assert.ok(
    statuses.every((status) => status.failed === false),
    'the earlier failures do not colour this load',
  );
});
