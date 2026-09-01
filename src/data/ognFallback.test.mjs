import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOgnMarker, normalizeOgnXmlResponse, OGN_AIRCRAFT_TYPES } from './ognFallback.js';

// A real marker tuple captured 2026-09-01 near Vienna (OE-KHI, a Cessna 172).
const REAL_FIELDS = '48.425282,10.859750,KHI,OE-KHI,1279,23:32:18,3,29,193,-0.7,8,EDMQ,4409FD,68026f99'.split(',');

test('normalizes a real captured marker tuple field-for-field', () => {
  const marker = normalizeOgnMarker(REAL_FIELDS);
  assert.equal(marker.id, '4409FD');
  assert.equal(marker.lat, 48.425282);
  assert.equal(marker.lon, 10.85975);
  assert.equal(marker.callsign, 'KHI');
  assert.equal(marker.registration, 'OE-KHI');
  assert.equal(marker.altitudeM, 1279);
  assert.equal(marker.ageSeconds, 3);
  assert.equal(marker.headingDeg, 29);
  assert.ok(Math.abs(marker.speedMps - 193 / 3.6) < 0.001, 'km/h converted to m/s');
  assert.equal(marker.climbMps, -0.7);
  assert.equal(marker.typeCode, 8);
  assert.equal(marker.typeLabel, 'plane');
  assert.equal(marker.receiver, 'EDMQ');
  assert.equal(marker.flarmId, '4409FD');
});

test('every OGN_AIRCRAFT_TYPES code resolves to a non-"unknown" label except its own reserved slots', () => {
  const reserved = new Set([0, 14, 15]);
  for (const [code, label] of Object.entries(OGN_AIRCRAFT_TYPES)) {
    if (reserved.has(Number(code))) continue;
    assert.notEqual(label, 'unknown', `code ${code}`);
  }
});

test('falls back to registration then a lat/lon key when no FLARM id is present', () => {
  const noFlarm = normalizeOgnMarker([
    '48.1', '16.3', 'CS', 'OE-ABC', '500', '00:00:00', '1', '0', '0', '0', '1', 'RX', '',
  ]);
  assert.equal(noFlarm.id, 'OE-ABC');

  const anonymous = normalizeOgnMarker([
    '48.1', '16.3', '', '', '500', '00:00:00', '1', '0', '0', '0', '1', 'RX', '',
  ]);
  assert.equal(anonymous.id, '48.1000,16.3000');
});

test('treats a "0" FLARM id as absent and falls through to registration (real 2026-09-01 Austria data bug)', () => {
  // Two distinct anonymous contacts, both privacy-mode (flarmId sentinel
  // "0"), each with its own distinct registration/device hex — the exact
  // shape a live 543-aircraft Austria snapshot produced 371 of.
  const first = normalizeOgnMarker([
    '48.1', '16.1', '_a1', '8072616b', '600', '00:00:00', '5', '10', '20', '0', '1', 'RX', '0', 'h1',
  ]);
  const second = normalizeOgnMarker([
    '48.2', '16.2', '_a2', 'eab68905', '700', '00:00:01', '5', '11', '21', '0', '1', 'RX', '0', 'h2',
  ]);
  assert.equal(first.flarmId, null, 'the "0" sentinel is not a real id');
  assert.equal(second.flarmId, null);
  assert.equal(first.id, '8072616b');
  assert.equal(second.id, 'eab68905');
  assert.notEqual(first.id, second.id, 'two distinct contacts must not collapse to one id');
});

test('a genuinely nonzero FLARM id (which happens to start with "0") is kept, not sanitized', () => {
  const marker = normalizeOgnMarker([
    '48.1', '16.1', 'CS', 'OE-ABC', '500', '00:00:00', '1', '0', '0', '0', '1', 'RX', '0123AB',
  ]);
  assert.equal(marker.flarmId, '0123AB');
  assert.equal(marker.id, '0123AB');
});

test('rejects short or positionless field lists rather than throwing', () => {
  assert.equal(normalizeOgnMarker(null), null);
  assert.equal(normalizeOgnMarker(['1', '2']), null);
  assert.equal(normalizeOgnMarker(['', '16.3', 'a', 'b', '1', '1', '1', '1', '1', '1', '1']), null);
});

test('extracts every <m a="..."/> element from a real captured lxml.php response', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<markers>\n<m a="${REAL_FIELDS.join(',')}"/>\n<m a="47.5,10.1,,,300,00:00:00,1,0,0,0,7,RX,,"/>\n</markers>`;
  const out = normalizeOgnXmlResponse(xml);
  assert.equal(out.aircraft.length, 2);
  assert.equal(out.aircraft[0].registration, 'OE-KHI');
  assert.equal(out.aircraft[1].typeLabel, 'paraglider');
  assert.ok(Number.isFinite(out.time));
});

test('decodes XML entities inside an attribute value (a registration with a literal &)', () => {
  const xml = '<m a="48.1,16.3,A&amp;B,OE-A&amp;B,500,00:00:00,1,0,0,0,1,RX,ABCDEF,"/>';
  const out = normalizeOgnXmlResponse(xml);
  assert.equal(out.aircraft[0].registration, 'OE-A&B');
});

test('malformed or empty XML yields an empty array, never a throw', () => {
  assert.deepEqual(normalizeOgnXmlResponse('').aircraft, []);
  assert.deepEqual(normalizeOgnXmlResponse(null).aircraft, []);
  assert.deepEqual(normalizeOgnXmlResponse('<markers></markers>').aircraft, []);
  assert.deepEqual(normalizeOgnXmlResponse('not xml at all').aircraft, []);
});
