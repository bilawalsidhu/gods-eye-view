import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorldMonitorBriefing,
  intelligenceLink,
  intelligenceTime,
} from './worldMonitorBriefing.js';
import { railFixture } from './railTestFixture.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const json = (value, status = 200) => Response.json(value, { status });
const briefing = {
  status: 'partial',
  source: 'World Monitor (local)',
  countryCode: 'US',
  countryName: 'United States',
  retrievedAt: '2026-10-11T13:00:00Z',
  summary: 'A partial country snapshot.',
  risk: { status: 'unavailable', score: null, computedAt: null },
  headlineCoverage: { state: 'partial', feedCached: 3, feedTotal: 5 },
  headlines: [
    {
      title: '<img src=x onerror=alert(1)>',
      url: 'javascript:alert(1)',
      source: 'Example',
      publishedAt: null,
    },
    {
      title: 'A public headline',
      url: 'https://example.test/story',
      source: 'News',
      publishedAt: '2026-10-11T12:00:00Z',
    },
  ],
};
function fixture(options = {}) {
  const f = railFixture();
  const requests = [];
  const view = createWorldMonitorBriefing({
    container: f.container,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return json(briefing);
    },
    ...options,
  });
  const byId = (id) => f.find((node) => node.id === id);
  const named = (value) =>
    f.find((node) => node.tagName === 'BUTTON' && node.textContent === value);
  const contains = (value) =>
    f.find((node) => node.textContent.includes(value));
  return { ...f, view, requests, byId, named, contains };
}

test('feed links and missing timestamps cannot become unsafe links or fabricated dates', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,bad',
    '/relative',
    null,
    undefined,
  ])
    assert.equal(intelligenceLink(url), null);
  assert.equal(
    intelligenceLink('https://example.test/a'),
    'https://example.test/a',
  );
  assert.equal(intelligenceTime(null), 'Time unavailable');
  assert.equal(intelligenceTime('invalid'), 'Time unavailable');
  assert.equal(
    intelligenceTime('2026-10-11T12:00:00Z'),
    '2026-10-11 12:00 UTC',
  );
});

test('mount stays idle; opening focuses the country field and closing returns focus', () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  assert.equal(f.byId('world-monitor').hidden, true);
  f.view.open();
  assert.equal(f.byId('world-monitor').hidden, false);
  assert.equal(f.document.activeElement, f.byId('world-monitor-country-code'));
  assert.equal(f.requests.length, 0);
  f.view.close();
  assert.equal(f.document.activeElement, f.byId('world-monitor-toggle'));
  f.view.destroy();
  assert.equal(f.container.children.length, 0);
});

test('briefing preserves partial/missing coverage, provenance and text-only untrusted headlines', async () => {
  const f = fixture();
  await f.view.loadCountry('us');
  assert.equal(f.requests[0].url, '/api/worldmonitor/country-brief?country=US');
  assert.ok(
    f.contains(
      'World Monitor (local) · partial · Retrieved 2026-10-11 13:00 UTC',
    ),
  );
  assert.ok(f.contains('Risk score unavailable'));
  assert.ok(f.contains('3/5 feeds cached'));
  const malicious = f.contains('<img src=x onerror=alert(1)>');
  assert.equal(malicious.tagName, 'SPAN');
  assert.equal(
    f.find((node) => node.tagName === 'IMG'),
    null,
  );
  const link = f.find((node) => node.tagName === 'A');
  assert.equal(link.href, 'https://example.test/story');
  assert.equal(link.rel, 'noopener noreferrer');
  await f.view.loadCountry('bad code');
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.byId('world-monitor-country-code').getAttribute('aria-invalid'),
    'true',
  );
  f.view.destroy();
});

test('new country request aborts the older one; late responses never replace current country', async () => {
  const pending = [];
  const f = fixture({
    fetchImpl: (url, init) =>
      new Promise((resolve) => pending.push({ url, init, resolve })),
  });
  const old = f.view.loadCountry('US');
  const current = f.view.loadCountry('GB');
  assert.equal(pending[0].init.signal.aborted, true);
  pending[1].resolve(
    json({ ...briefing, countryName: 'United Kingdom', countryCode: 'GB' }),
  );
  await current;
  pending[0].resolve(json(briefing));
  await old;
  assert.ok(f.contains('United Kingdom'));
  assert.equal(f.contains('United States'), null);
  f.view.destroy();
});

test('news refresh acquires feeds before rereading the country cache', async () => {
  const f = fixture();
  await f.view.loadCountry('US', { refresh: true });
  assert.deepEqual(
    f.requests.map((request) => request.url),
    [
      '/api/worldmonitor/feed-digest?variant=full&limit=1',
      '/api/worldmonitor/country-brief?country=US',
    ],
  );
  assert.ok(f.contains('United States'));
  assert.equal(f.named('Refresh news').disabled, false);
  f.view.destroy();
});

test('failed news refresh reports unavailable and releases its controls', async () => {
  const f = fixture({
    fetchImpl: async () => json({ status: 'unavailable' }, 503),
  });
  await f.view.loadCountry('US', { refresh: true });
  assert.ok(
    f.contains('The local World Monitor service could not provide a briefing.'),
  );
  assert.equal(f.named('Refresh news').disabled, false);
  f.view.destroy();
});

test('service unavailable is visibly different from an empty successful country', async () => {
  const f = fixture({
    fetchImpl: async () =>
      json(
        {
          status: 'unavailable',
          source: 'World Monitor (local)',
          reason: 'Local service is not configured.',
        },
        503,
      ),
  });
  await f.view.loadCountry('US');
  assert.ok(f.contains('Local service is not configured.'));
  assert.ok(f.contains('Risk score unavailable'));
  assert.ok(
    f.contains(
      'No headlines returned. This does not establish that no events occurred.',
    ),
  );
  f.view.destroy();
});
