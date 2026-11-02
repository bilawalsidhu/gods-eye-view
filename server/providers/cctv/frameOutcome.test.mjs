import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCctvImageFromUpstream,
  fetchTxdotSnapshot,
  isTransientStatus,
} from './media.js';

// Why a frame fetch returned null: temporary (retry later) or definitive.

test('isTransientStatus: 408, 429 and 5xx only', () => {
  for (const s of [408, 429, 500, 503, 599]) assert.equal(isTransientStatus(s), true, String(s));
  for (const s of [200, 301, 400, 401, 403, 404, 410, 600, NaN, undefined])
    assert.equal(isTransientStatus(s), false, String(s));
});

const IMG = 'https://cams.upstream.invalid/a.jpg';
const TX =
  'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId?icd_Id=1';
const reply = (status) => async () => new Response(null, { status });
const boom = async () => {
  throw new TypeError('fetch failed');
};

for (const [name, fn, url] of [
  ['generic', fetchCctvImageFromUpstream, IMG],
  ['TxDOT', fetchTxdotSnapshot, TX],
]) {
  test(`${name}: 503 and 429 and a thrown error are temporary; 404 is not`, async () => {
    for (const [fetchImpl, expected] of [
      [reply(503), true],
      [reply(429), true],
      [boom, true],
      [reply(404), false],
    ]) {
      const outcome = {};
      assert.equal(await fn(url, { fetchImpl, outcome }), null);
      assert.equal(outcome.transient, expected);
    }
  });

  test(`${name}: a fetch that never answers times out as temporary`, async () => {
    const outcome = {};
    const hang = (_u, init) =>
      new Promise((_r, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      );
    assert.equal(await fn(url, { fetchImpl: hang, timeoutMs: 20, outcome }), null);
    assert.equal(outcome.transient, true);
  });
}

test('generic: a 200 that is not an image is definitive', async () => {
  const outcome = {};
  const fetchImpl = async () =>
    new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
  assert.equal(await fetchCctvImageFromUpstream(IMG, { fetchImpl, outcome }), null);
  assert.notEqual(outcome.transient, true);
});
