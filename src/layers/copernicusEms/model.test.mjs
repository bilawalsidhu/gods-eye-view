import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCopernicusActivationCopy,
  copernicusActivationIdFromPick,
  copernicusCategoryColor,
  copernicusCategoryLabel,
  copernicusPhaseLabel,
  normalizeCopernicusActivations,
  mapCopernicusRecord,
  parseCentroid,
} from './model.js';

test('a WKT centroid is read longitude-first, as the upstream writes it', () => {
  const position = parseCentroid('POINT (0.022993090259437 38.81628901353977)');
  assert.equal(position.lon, 0.022993090259437);
  assert.equal(position.lat, 38.81628901353977);
});

test('an unparsable or out-of-range centroid is refused', () => {
  assert.equal(parseCentroid('POINT (9.105 40.3916)').lon, 9.105);
  assert.equal(parseCentroid('POINT (999 40)'), null);
  assert.equal(parseCentroid('LINESTRING (1 2)'), null);
  assert.equal(parseCentroid(null), null);
});

test('an activation payload is normalized into rows', () => {
  const result = normalizeCopernicusActivations({
    total: 2,
    activations: [
      {
        id: 'EMSR935',
        code: 'EMSR935',
        name: 'Flood in Alicante-Valencia Regions',
        category: 'flood',
        phase: 'response',
        country: 'Spain',
        lon: 0.022993090259437,
        lat: 38.81628901353977,
        closed: false,
      },
    ],
  });
  assert.equal(result.activations.length, 1);
  assert.equal(result.total, 2);
  assert.equal(result.activations[0].categoryLabel, 'Flood');
  assert.equal(result.activations[0].phaseLabel, 'Response');
  assert.equal(result.activations[0].color, '#4cc9f0');
});

test('a structurally broken payload is refused so the last good one is kept', () => {
  assert.equal(normalizeCopernicusActivations(null), null);
  assert.equal(normalizeCopernicusActivations({ activations: 'nope' }), null);
});

test('an activation without a usable position is skipped, not fatal', () => {
  const result = normalizeCopernicusActivations({
    activations: [{ id: 'a', lon: 1, lat: 2 }, { id: 'b' }],
  });
  assert.equal(result.activations.length, 1);
  assert.equal(result.activations[0].id, 'a');
});

test('an unknown category falls back to the neutral entry', () => {
  assert.equal(copernicusCategoryColor('meteorite'), '#adb5bd');
  assert.equal(copernicusCategoryLabel('meteorite'), 'Meteorite');
  assert.equal(copernicusCategoryColor('fire'), '#ff6b35');
  assert.equal(copernicusPhaseLabel('preparedness'), 'Preparedness');
  assert.equal(copernicusPhaseLabel('unknown-phase'), 'Unknown-phase');
});

test('an analyst record carries only JSON-safe values', () => {
  const record = mapCopernicusRecord({
    id: 'EMSR935',
    code: 'EMSR935',
    name: 'Flood',
    category: 'flood',
    phase: 'response',
    country: 'Spain',
    closed: false,
    lat: 38.8,
    lon: 0.02,
  });
  assert.equal(record.id, 'EMSR935');
  assert.equal(record.closed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

test('an activation card names the code, hazard, status and place', () => {
  const t = (key, params) =>
    params ? key.replace(/\{(\w+)\}/g, (_, name) => params[name]) : key;
  const [activation] = normalizeCopernicusActivations({
    activations: [
      {
        id: '1',
        code: 'EMSR900',
        name: 'Flood in Gard',
        category: 'flood',
        phase: 'response',
        country: 'France',
        lon: 4.1,
        lat: 43.9,
        activationTime: '2026-10-29T08:00:00Z',
        lastUpdate: '2026-10-30T09:00:00Z',
        aoiCount: 3,
        productCount: 5,
      },
    ],
  }).activations;
  const copy = buildCopernicusActivationCopy(
    activation,
    t,
    Date.parse('2026-10-30T12:00:00Z'),
  );
  assert.equal(copy.title, 'EMSR900 · Flood in Gard');
  assert.ok(copy.details.includes('Flood · New'));
  assert.ok(copy.details.includes('Response'));
  assert.ok(copy.details.includes('Activated 2026-10-29'));
  assert.ok(copy.details.includes('3 areas · 5 products'));
  assert.equal(copernicusActivationIdFromPick('copernicus-activation:1'), '1');
  assert.equal(copernicusActivationIdFromPick('x:1'), null);
});
