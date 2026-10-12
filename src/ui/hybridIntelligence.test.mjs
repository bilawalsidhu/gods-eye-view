import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHybridIntelligence,
  intelligenceLink,
  intelligenceTime,
} from './hybridIntelligence.js';
import { railFixture } from './railTestFixture.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const json = (value, status = 200) => Response.json(value, { status });
const ready = {
  selected: true,
  configured: true,
  model: 'openrouter/openrouter/free',
};
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
  const view = createHybridIntelligence({
    container: f.container,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return json(url.includes('/status') ? ready : briefing);
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

test('mount stays idle; opening checks local configuration and closing returns focus', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  assert.equal(f.byId('hybrid-intelligence').hidden, true);
  assert.equal(f.named('Send').disabled, true);
  f.view.open();
  await flush();
  assert.equal(f.requests[0].url, '/api/local-model/status');
  assert.equal(f.named('Send').disabled, false);
  assert.equal(
    f.byId('hybrid-intelligence-toggle').getAttribute('aria-expanded'),
    'true',
  );
  f.view.close();
  assert.equal(f.document.activeElement, f.byId('hybrid-intelligence-toggle'));
  f.view.open();
  await flush();
  assert.equal(f.requests.length, 1);
  f.view.destroy();
  assert.equal(f.container.children.length, 0);
});

test('unselected or missing local inference disables chat without cloud fallback', async () => {
  for (const state of [
    { configured: true, selected: false },
    { configured: false, selected: true },
  ]) {
    const calls = [];
    const f = fixture({
      fetchImpl: async (url) => {
        calls.push(url);
        return json(state);
      },
    });
    f.view.open();
    await flush();
    assert.equal(f.named('Send').disabled, true);
    assert.ok(f.contains('Model gateway unavailable'));
    assert.deepEqual(calls, ['/api/local-model/status']);
    f.view.destroy();
  }
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
    f.byId('hybrid-country-code').getAttribute('aria-invalid'),
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

test('news refresh acquires feeds before rereading the country cache without requiring a model', async () => {
  const f = fixture();
  assert.equal(f.named('Send').disabled, true);
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

test('text chat reuses its session, includes source state and renders all turns without HTML', async () => {
  const contexts = [];
  const runAction = async () => ({ ok: true });
  let options;
  let starts = 0;
  const f = fixture({
    runAction,
    createSession: (value) => {
      options = value;
      return {
        start() {
          starts++;
        },
        stop() {},
        sendMapEvent(context) {
          contexts.push(context);
        },
        async sendText(message) {
          value.emit({
            type: 'transcript',
            role: 'user',
            text: message,
            final: true,
          });
          value.emit({
            type: 'transcript',
            role: 'assistant',
            text: '<script>bad()</script>',
            model: 'fixture/served-free-model',
            final: true,
          });
          return '<script>bad()</script>';
        },
      };
    },
  });
  f.view.open();
  await flush();
  await f.view.loadCountry('US');
  const form = f.find((node) => node.className === 'hybrid-chat-form');
  for (const message of ['First question', 'Second question']) {
    f.byId('hybrid-chat-question').value = message;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
  }
  assert.equal(starts, 2);
  assert.equal(options.allowTools, true);
  assert.equal(options.runAction, runAction);
  assert.equal(contexts[1].briefing.status, 'partial');
  assert.equal(contexts[1].briefing.headlines[0].url, null);
  const transcript = f.find(
    (node) => node.className === 'hybrid-chat-transcript',
  );
  assert.equal(transcript.children.length, 4);
  assert.equal(
    f.find((node) => node.tagName === 'SCRIPT'),
    null,
  );
  assert.ok(f.contains('<script>bad()</script>'));
  assert.ok(f.contains('Assistant · fixture/served-free-model'));
  assert.ok(
    f.contains('Model gateway configured · openrouter/openrouter/free'),
  );
  f.view.destroy();
});

test('stop and lifetime disposal silence late model events and cancel requests', async () => {
  const lifetime = new AbortController();
  let options;
  let finish;
  let stops = 0;
  const f = fixture({
    signal: lifetime.signal,
    createSession: (value) => {
      options = value;
      return {
        start() {},
        sendMapEvent() {},
        stop() {
          stops++;
        },
        sendText() {
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      };
    },
  });
  f.view.open();
  await flush();
  f.byId('hybrid-chat-question').value = 'Question';
  f.find((node) => node.className === 'hybrid-chat-form').dispatchEvent(
    new Event('submit'),
  );
  await flush();
  assert.equal(options.allowTools, false);
  f.named('Stop').click();
  options.emit({
    type: 'transcript',
    role: 'assistant',
    text: 'Late answer',
    final: true,
  });
  finish('Late answer');
  await flush();
  assert.equal(stops, 1);
  assert.equal(f.contains('Late answer'), null);
  assert.ok(f.contains('Stopped.'));
  lifetime.abort();
  assert.equal(options.signal.aborted, true);
  assert.equal(f.container.children.length, 0);
});

test('a throttled assistant keeps the sanitized gateway error visible without retry', async () => {
  const requests = [];
  const f = fixture({
    fetchImpl: async (url) => {
      requests.push(url);
      return url.endsWith('/status')
        ? json(ready)
        : json({ error: 'Model route is rate limited. Try again later.' }, 429);
    },
  });
  f.view.open();
  await flush();
  f.byId('hybrid-chat-question').value = 'A fixture question';
  f.find((node) => node.className === 'hybrid-chat-form').dispatchEvent(
    new Event('submit', { cancelable: true }),
  );
  await flush();
  assert.ok(f.contains('Model route is rate limited. Try again later.'));
  assert.deepEqual(requests, [
    '/api/local-model/status',
    '/api/local-model/chat',
  ]);
  assert.equal(f.named('Send').disabled, false);
  f.view.destroy();
});
