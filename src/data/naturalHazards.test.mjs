import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHazardOverlayEntry,
  normalizeNwsHazards,
  normalizeSpcTornadoReports,
  normalizeHazardPayload,
} from './naturalHazards.js';

test('hazard labels use the shared earthquake-style ambient overlay contract', () => {
  const entry = createHazardOverlayEntry({
    id: 'spc:1',
    position: { x: 1, y: 2, z: 3 },
    title: 'TORNADO',
    accent: '#ff0000',
    priority: 1000,
  });
  assert.deepEqual(entry, {
    id: 'spc:1',
    position: { x: 1, y: 2, z: 3 },
    variant: 'label',
    title: 'TORNADO',
    accent: '#ff0000',
    priority: 1000,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  });
});

const feature = (event, id = 'urn:example:1') => ({
  id,
  geometry: { type: 'Polygon', coordinates: [[[-97, 35], [-96, 35], [-96, 36], [-97, 35]]] },
  properties: { event, headline: `${event} headline`, sent: '2026-09-13T00:00:00Z' },
});

test('NWS normalization keeps only the requested hazard family', () => {
  const result = normalizeNwsHazards(
    { features: [feature('Tornado Warning'), feature('Tsunami Warning', 'urn:example:2')] },
    new Set(['Tornado Warning']),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].event, 'Tornado Warning');
  assert.equal(result[0].source, 'NOAA NWS');
});

test('categorized NOAA alert layers keep their event families separate', () => {
  const alerts = { features: [
    feature('Severe Thunderstorm Warning', 'storm'),
    feature('Flood Warning', 'flood'),
    feature('Winter Weather Advisory', 'winter'),
    feature('Excessive Heat Warning', 'heat'),
    feature('High Wind Warning', 'wind'),
    feature('Red Flag Warning', 'fire'),
  ] };
  assert.equal(normalizeHazardPayload({ alerts, reportsCsv: '' }, 'severeThunderstorms').length, 1);
  assert.equal(normalizeHazardPayload({ alerts, reportsCsv: '' }, 'floods').length, 1);
  assert.equal(normalizeHazardPayload({ alerts, reportsCsv: '' }, 'winterWeather').length, 1);
  assert.equal(normalizeHazardPayload({ alerts, reportsCsv: '' }, 'excessiveHeat').length, 1);
  assert.equal(normalizeHazardPayload({ alerts, reportsCsv: '' }, 'highWind').length, 1);
  assert.equal(normalizeHazardPayload({ alerts, reportsCsv: '' }, 'fireWeather').length, 1);
});

test('SPC normalization parses preliminary tornado coordinates safely', () => {
  const csv = 'Time,F_Scale,Location,County,State,Lat,Lon,Comments\n1234,UNK,Example,County,OK,35.10,-97.50,Report text\nTime,Speed,Location,County,State,Lat,Lon,Comments';
  const result = normalizeSpcTornadoReports(csv);
  assert.equal(result.length, 1);
  assert.equal(result[0].lat, 35.1);
  assert.equal(result[0].lon, -97.5);
  assert.equal(result[0].preliminary, true);
});

test('hazard payload rejects malformed feeds before rendering', () => {
  assert.equal(normalizeHazardPayload({ alerts: {} }, 'tornado'), null);
});
