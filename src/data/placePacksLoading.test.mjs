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
  assert.equal(await load(), 1);
  assert.deepEqual(place.placePacksStatus(), { loading: false, failed: false });
});
