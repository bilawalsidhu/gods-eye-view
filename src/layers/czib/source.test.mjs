import assert from 'node:assert/strict';
import test from 'node:test';
import { createCzibSource } from './source.js';

const bulletin = {
  id: '20585',
  number: 'CZIB-2017-01R20',
  title: 'Airspace of Mali',
  area: 'Mali',
  partial: false,
  status: 'active',
  countries: ['Mali'],
  issuedMs: 1,
  revisedMs: 2,
  validUntilMs: 3,
  validity: '31/10/2026, unless reviewed earlier.',
  url: 'https://www.easa.europa.eu/en/domains/air-operations/czibs/czib-2017-01r20',
};

test('the source reads the same-origin proxy and passes its flags through', async () => {
  const calls = [];
  const source = createCzibSource({
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({
        fetchedAt: 5,
        bulletins: [bulletin, { id: 'bad' }],
        linksMissing: true,
        stale: true,
        staleAgeMs: 7_200_000,
      });
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(calls, ['/api/czib']);
  assert.deepEqual(snapshot, {
    bulletins: [bulletin],
    linksMissing: true,
    fetchedAt: 5,
    stale: true,
    staleAgeMs: 7_200_000,
  });
});

test('the source rejects failed, malformed and aborted reads', async () => {
  const reply = (body, init) => async () => Response.json(body, init);
  assert.deepEqual(
    await createCzibSource({
      fetchImpl: reply({ bulletins: [], fetchedAt: 'x' }),
    }).getSnapshot(),
    {
      bulletins: [],
      linksMissing: false,
      fetchedAt: null,
      stale: false,
      staleAgeMs: null,
    },
  );
  // An age only means something on a stale copy, and only when sane.
  for (const body of [
    { bulletins: [], stale: false, staleAgeMs: 5 },
    { bulletins: [], stale: true, staleAgeMs: -1 },
    { bulletins: [], stale: true, staleAgeMs: 'old' },
  ])
    assert.equal(
      (await createCzibSource({ fetchImpl: reply(body) }).getSnapshot())
        .staleAgeMs,
      null,
    );
  await assert.rejects(
    createCzibSource({
      fetchImpl: reply({ error: 'x' }, { status: 502 }),
    }).getSnapshot(),
    /EASA CZIB HTTP 502/,
  );
  await assert.rejects(
    createCzibSource({ fetchImpl: reply({ bulletins: 'no' }) }).getSnapshot(),
    /Malformed/,
  );
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  await assert.rejects(
    createCzibSource({
      fetchImpl: async () => {
        fetched = true;
        return Response.json({ bulletins: [] });
      },
    }).getSnapshot({ signal: controller.signal }),
  );
  assert.equal(fetched, false);
});
