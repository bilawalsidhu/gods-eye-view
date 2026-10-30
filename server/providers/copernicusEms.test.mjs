import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
  const position = parseEmCentroid('POINT (0.022993090259437 38.81628901353977)');
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
