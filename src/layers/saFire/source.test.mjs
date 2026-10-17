import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSaFireSource } from './source.js';
import { normalizeSaIncidents } from './records.js';
import { saFireProxy } from '../../../server/providers/saFire.js';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../data/fixtures/sa-fire-incidents.synthetic.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const incidents = normalizeSaIncidents(fixture);
const envelope = {
  incidents,
  warnings: [],
  warningsAvailable: true,
  incidentsFetchedAt: 1,
  warningsFetchedAt: 2,
  upstreamModified: 3,
  stale: false,
};
const serve = (payload, init) => async () => Response.json(payload, init);

test('a valid envelope yields a validated snapshot from the same-origin route', async () => {
  let requested;
  const source = createSaFireSource({
    fetchImpl: async (url, options) => {
      requested = [String(url), options.signal];
      return Response.json(envelope);
    },
  });
  const controller = new AbortController();
  const snapshot = await source.getSnapshot({ signal: controller.signal });
  assert.equal(requested[0], '/api/sa-fire');
  assert.equal(requested[1], controller.signal);
  assert.equal(snapshot.incidents.length, 2);
  assert.equal(snapshot.warningsAvailable, true);
  assert.equal(snapshot.upstreamModified, 3);
});

test('malformed payloads and failing statuses are rejected, never turned into an empty list', async () => {
  for (const payload of [
    null,
    [],
    'File Unavailable',
    { error: 'sa_fire_unavailable' },
    { ...envelope, incidents: 'x' },
    { ...envelope, warnings: undefined },
    { ...envelope, warningsAvailable: undefined },
  ]) {
    await assert.rejects(
      createSaFireSource({ fetchImpl: serve(payload) }).getSnapshot(),
      /Malformed SA fire snapshot/,
    );
  }
  for (const status of [404, 429, 500, 502])
    await assert.rejects(
      createSaFireSource({
        fetchImpl: serve({ error: 'x' }, { status }),
      }).getSnapshot(),
      new RegExp(`HTTP ${status}`),
    );
  await assert.rejects(
    createSaFireSource({
      fetchImpl: async () => new Response('<html>File Unavailable</html>'),
    }).getSnapshot(),
    SyntaxError,
  );
});

test('an aborted request never reaches the network, and oversized bodies are capped', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createSaFireSource({
      fetchImpl: async () => {
        calls++;
        return Response.json(envelope);
      },
    }).getSnapshot({ signal: controller.signal }),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    createSaFireSource({
      fetchImpl: async () =>
        new Response('{}', {
          headers: { 'Content-Length': String(17 * 1024 * 1024) },
        }),
    }).getSnapshot(),
    /too large/,
  );
});

test('the browser source reads what the proxy produces end to end', async () => {
  let handler;
  saFireProxy({
    now: () => Date.UTC(2026, 9, 13, 3, 5),
    fetchImpl: async (url) =>
      String(url).includes('data.eso.sa.gov.au')
        ? new Response(JSON.stringify(fixture), {
            headers: {
              'Content-Type': 'application/json',
              'Last-Modified': 'Tue, 13 Oct 2026 03:00:00 GMT',
            },
          })
        : new Response('{"type":"FeatureCollection","features":[]}', {
            headers: { 'Content-Type': 'application/geo+json' },
          }),
  }).configureServer({
    middlewares: {
      use: (_path, callback) => {
        handler = callback;
      },
    },
  });
  const snapshot = await createSaFireSource({
    fetchImpl: async () => {
      let body;
      await handler(
        { url: '/', method: 'GET', socket: {} },
        { writeHead() {}, end: (text) => (body = text) },
      );
      return new Response(body);
    },
  }).getSnapshot();
  assert.equal(snapshot.incidents.length, 2);
  assert.equal(snapshot.warningsAvailable, true);
  assert.equal(snapshot.upstreamModified, Date.UTC(2026, 9, 13, 3, 0));
});
