import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkZoneSource } from './source.js';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';

const event = (id, extra = {}) => ({
  id,
  feed: 'mn',
  type: 'work-zone',
  roads: ['I-94'],
  direction: 'eastbound',
  description: 'Bridge work',
  start: 1,
  end: 2,
  impact: 'some-lanes-closed',
  workers: null,
  updated: 3,
  anchor: [-93.1, 45.0],
  lines: [
    [
      [-93.1, 45.0],
      [-93.2, 45.1],
    ],
  ],
  ...extra,
});

const reply = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    headers: { 'x-snapshot-age': '30000', ...(init.headers || {}) },
    status: init.status ?? 200,
  });

test('reads the fixed route and checks every record again', async () => {
  const calls = [];
  const source = createWorkZoneSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return reply({
        builtAt: 1_000_000,
        linesDropped: 2,
        feeds: [
          {
            id: 'mn',
            name: 'Minnesota',
            publisher: 'Minnesota DOT',
            status: 'live',
            fetchedAt: 1_000_000,
            count: 2,
            version: '4.0',
          },
          {
            id: 'ks',
            name: 'Kansas',
            publisher: 'Kansas DOT',
            status: 'stale',
            fetchedAt: 700_000,
            count: 0,
          },
          { id: 'bad', status: 'exploded' },
        ],
        events: [
          event('mn:1'),
          event('mn:2', { anchor: [500, 0] }),
          event('mn:3', { type: 'restriction' }),
          event('mn:4', {
            lines: [
              [
                [-93, 45],
                [-93, 'x'],
              ],
            ],
          }),
        ],
      });
    },
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(calls, ['/api/wzdx/events']);
  assert.deepEqual(
    snapshot.events.map(({ id }) => id),
    ['mn:1', 'mn:4'],
  );
  assert.equal(snapshot.events[1].lines.length, 0, 'bad line dropped');
  assert.deepEqual(
    snapshot.feeds.map(({ id, status, ageMs }) => [id, status, ageMs]),
    [
      ['mn', 'live', 30_000],
      ['ks', 'stale', 330_000],
    ],
  );
  assert.equal(snapshot.linesDropped, 2);
});

test('failures are fixed English shapes the panel translates', async (t) => {
  const failing = (impl) => createWorkZoneSource({ fetchImpl: impl });
  const cases = [
    [
      async () =>
        new Response('{}', { status: 503, headers: { 'retry-after': '42' } }),
      'WZDx HTTP 503',
    ],
    [async () => new Response('{}', { status: 429 }), 'WZDx rate limited'],
    [
      async () => {
        throw new TypeError('connect ECONNREFUSED 10.0.0.1:443');
      },
      'WZDx network error',
    ],
    [async () => new Response('<html>'), 'Malformed WZDx response'],
    [async () => reply({ events: {} }), 'Malformed WZDx response'],
  ];
  for (const [impl, message] of cases) {
    const error = await failing(impl)
      .getSnapshot()
      .then(
        () => null,
        (failure) => failure,
      );
    assert.equal(error?.message, message);
  }
  const limited = await failing(cases[0][0])
    .getSnapshot()
    .catch((error) => error);
  assert.equal(limited.retryAfterMs, 42_000);
  t.after(() => setLocale('en'));
  setLocale('es');
  for (const [, message] of cases)
    assert.notEqual(translateFeedError(message), message, message);
});

test('an aborted read rejects as an abort, not a network error', async () => {
  const controller = new AbortController();
  const source = createWorkZoneSource({
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      ),
  });
  const pending = source.getSnapshot({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
