import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdsbGnssSource } from './source.js';

test('the source asks the same-origin proxy for the view anchor', async () => {
  const calls = [];
  const source = createAdsbGnssSource({
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({
        fetchedAt: 5,
        ageMs: 0,
        classifier: 'gev-nic-nacp-v2',
        rows: [{ hex: 'abc123' }],
      });
    },
  });
  const snapshot = await source.getSnapshot(
    { latitude: 50.06143, longitude: 19.93658 },
    { signal: new AbortController().signal },
  );
  assert.deepEqual(calls, ['/api/gnss-integrity?lat=50&lon=20']);
  assert.deepEqual(snapshot, {
    rows: [{ hex: 'abc123' }],
    ageMs: 0,
    fetchedAt: 5,
    stale: false,
    classifier: 'gev-nic-nacp-v2',
  });
});

test('the source reports stale proxy data and rejects bad input or responses', async () => {
  const reply = (body, init) => async () => Response.json(body, init);
  const stale = await createAdsbGnssSource({
    fetchImpl: reply({ rows: [], fetchedAt: 7, ageMs: 90_000, stale: true }),
  }).getSnapshot({ latitude: 1, longitude: 2 });
  assert.equal(stale.stale, true);
  assert.equal(stale.ageMs, 90_000, 'a stale reply keeps its observation age');
  assert.equal(stale.fetchedAt, 7);
  assert.equal(stale.classifier, null);
  // Without an observation age the rows could only be dated as new.
  for (const ageMs of [undefined, null, '7', -1, Number.NaN])
    await assert.rejects(
      createAdsbGnssSource({
        fetchImpl: reply({ rows: [], fetchedAt: 7, ageMs }),
      }).getSnapshot({ latitude: 1, longitude: 2 }),
      /no observation time/,
    );

  await assert.rejects(
    createAdsbGnssSource({ fetchImpl: reply({}) }).getSnapshot({}),
    /view anchor/,
  );
  await assert.rejects(
    createAdsbGnssSource({
      fetchImpl: reply({ error: 'x' }, { status: 502 }),
    }).getSnapshot({ latitude: 1, longitude: 2 }),
    /HTTP 502/,
  );
  await assert.rejects(
    createAdsbGnssSource({ fetchImpl: reply({ rows: 'no' }) }).getSnapshot({
      latitude: 1,
      longitude: 2,
    }),
    /Malformed/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createAdsbGnssSource({ fetchImpl: reply({ rows: [] }) }).getSnapshot(
      { latitude: 1, longitude: 2 },
      { signal: controller.signal },
    ),
  );
});

test('HTTP failures distinguish rate limiting, preserve Retry-After and classify retryability', async () => {
  const at = Date.UTC(2026, 9, 13, 12);
  for (const [status, header, delay, retryable] of [
    [429, '3600', 3600000, true],
    [429, new Date(at + 3600000).toUTCString(), 3600000, true],
    [429, null, 60000, true],
    [429, 'Infinity', 60000, true],
    [502, '5', 5000, true],
    [502, null, null, true],
    [400, null, null, false],
  ]) {
    const source = createAdsbGnssSource({
      now: () => at,
      fetchImpl: async () =>
        Response.json(
          {},
          { status, headers: header ? { 'Retry-After': header } : {} },
        ),
    });
    await assert.rejects(
      source.getSnapshot({ latitude: 50, longitude: 20 }),
      (e) => {
        assert.equal(e.status, status);
        assert.equal(e.retryAfterMs, delay);
        assert.equal(e.retryable, retryable);
        assert.match(
          e.message,
          status === 429 ? /rate limited/ : /feed unavailable/,
        );
        return true;
      },
    );
  }
});
