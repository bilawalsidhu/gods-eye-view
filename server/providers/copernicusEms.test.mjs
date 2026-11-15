import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMS_MAX_PAGE_BYTES,
  createCopernicusEmsService,
  emsCategoryColor,
  emsPhaseLabel,
  normalizeEmActivation,
  normalizeEmActivationsPage,
  parseEmCentroid,
} from './copernicusEms.js';

const jsonResponse = (payload, init = {}) =>
  new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });

const ACTIVATION = {
  code: 'EMSR935',
  countries: [{ short_name: 'Spain' }],
  category: { slug: 'flood', name: 'Flood' },
  name: 'Flood in Alicante-Valencia Regions, Spain',
  centroid: 'POINT (0.022993090259437 38.81628901353977)',
  activationTime: '2026-10-19T16:03:00',
  lastUpdate: '2026-10-21T03:55:11.352969',
  drmPhase: 'response',
  closed: false,
  n_aois: 2,
  n_products: 2,
};

test('a WKT centroid is read longitude-first, as the upstream writes it', () => {
  const position = parseEmCentroid(
    'POINT (0.022993090259437 38.81628901353977)',
  );
  assert.equal(position.lon, 0.022993090259437);
  assert.equal(position.lat, 38.81628901353977);
});

test('an unparsable centroid is refused', () => {
  assert.equal(parseEmCentroid('POINT (999 40)'), null);
  assert.equal(parseEmCentroid('LINESTRING (1 2)'), null);
  assert.equal(parseEmCentroid(null), null);
});

test('an activation is normalized into a row', () => {
  const row = normalizeEmActivation(ACTIVATION);
  assert.equal(row.id, 'EMSR935');
  assert.equal(row.category, 'flood');
  assert.equal(row.categoryLabel, 'Flood');
  assert.equal(row.phase, 'response');
  assert.equal(row.phaseLabel, 'Response');
  assert.equal(row.country, 'Spain');
  assert.equal(row.closed, false);
  assert.equal(row.aoiCount, 2);
  assert.equal(row.lon, 0.022993090259437);
});

test('an activation without a usable centroid is refused', () => {
  assert.equal(normalizeEmActivation({ code: 'X' }), null);
});

test('a page is normalized, dropping the unusable rows', () => {
  const page = normalizeEmActivationsPage({
    count: 2,
    results: [ACTIVATION, { code: 'broken' }],
  });
  assert.equal(page.count, 2);
  assert.equal(page.rows.length, 1);
});

test('an unknown category falls back to neutral', () => {
  assert.equal(emsCategoryColor('meteorite'), '#adb5bd');
  assert.equal(emsCategoryColor('flood'), '#4cc9f0');
  assert.equal(emsPhaseLabel('preparedness'), 'Preparedness');
});

test('the service answers the active activations from the upstream', async () => {
  const seen = [];
  const service = createCopernicusEmsService({
    fetchImpl: async (url) => {
      seen.push(String(url));
      return jsonResponse({ count: 1, next: null, results: [ACTIVATION] });
    },
  });
  const response = await service.handle({
    url: 'http://localhost/api/copernicus-ems/active',
    method: 'GET',
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.activations[0].id, 'EMSR935');
  assert.ok(
    seen[0].includes('mapping.emergency.copernicus.eu'),
    'the upstream is the Copernicus activation API',
  );
  assert.ok(seen[0].includes('closed=false'));
  service.close();
});

test('an oversized page is refused while it streams, not buffered', async () => {
  const padding = 'x'.repeat(EMS_MAX_PAGE_BYTES);
  let read = 0;
  const service = createCopernicusEmsService({
    fetchImpl: async () => {
      // A valid page that carries one huge extra field, and no
      // Content-Length: only the streaming cap can catch it.
      const body = JSON.stringify({
        count: 1,
        next: null,
        results: [ACTIVATION],
        padding,
      });
      const bytes = new TextEncoder().encode(body);
      const stream = new ReadableStream({
        pull(controller) {
          if (read >= bytes.length) return controller.close();
          const end = Math.min(read + 65_536, bytes.length);
          controller.enqueue(bytes.slice(read, end));
          read = end;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const response = await service.handle({
    url: 'http://localhost/api/copernicus-ems/active',
    method: 'GET',
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'RESPONSE_TOO_LARGE');
  assert.ok(
    read < EMS_MAX_PAGE_BYTES + 200_000,
    'the body was cancelled shortly after the cap, not read to the end',
  );
  service.close();
});
