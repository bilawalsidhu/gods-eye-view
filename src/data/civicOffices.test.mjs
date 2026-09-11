// CIVIC OFFICES — the layer whose gaps look like facts.
//
// A missing aircraft is obviously missing. A missing police station is not: an
// unmapped district renders identically to a district with no station, so a
// reader takes the absence for a fact about the world rather than about
// OpenStreetMap. The repo's own ground rules forbid presenting public-data
// inference as authoritative intelligence, and for this layer that obligation
// lands almost entirely on one string — the line under the layer name.
//
// So these tests pin the honesty of that line, and the two measurements behind
// it. Both come from the response itself rather than from a disclaimer:
//
//   1. `out count` is the number in view. When it exceeds what was drawn, BOTH
//      numbers appear — a silently truncated list reads as a complete one.
//   2. `osm3s.timestamp_osm_base` is the answering mirror's snapshot date.
//      Mirrors lag, sometimes by months, so the row shows the date it got.
//
// And the claim is always "in view", never a total: no count is accumulated
// across viewports, and a viewport too wide to ask about says so rather than
// leaving the last city's offices floating over a continent.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsTooWide,
  civicOfficesLabel,
  civicOfficesQuery,
  classifyCivicOffice,
  readCivicOfficesPayload,
} from './civicOffices.js';

const HANOI = { south: 20.98, west: 105.78, north: 21.08, east: 105.90 };

// ── The disclosure ───────────────────────────────────────────────────────────

test('a truncated result shows both numbers, never just the drawn one', () => {
  // Measured over Hanoi: 437 in view, 400 returned under the query cap.
  assert.equal(
    civicOfficesLabel({ rendered: 400, total: 437, dataDate: '2026-05-06', outOfRange: false }),
    '400 of 437 in view · mapped to 2026-05-06',
  );
});

test('the count is always about the view, and never claims to be a total', () => {
  const label = civicOfficesLabel({ rendered: 137, total: 137, dataDate: '2026-05-06', outOfRange: false });

  assert.equal(label, '137 in view · mapped to 2026-05-06');
  assert.match(label, /in view/);
  for (const overclaim of [/\btotal\b/i, /\ball\b/i, /\bcomplete\b/i, /\bevery\b/i]) {
    assert.doesNotMatch(label, overclaim, `the row must not read as a register: ${overclaim}`);
  }
});

test('an unknown count is not silently replaced by the drawn one', () => {
  // Without `out count` the honest statement is "here is what was drawn", not
  // "there are this many" — the second would invent the number it lacks.
  assert.equal(
    civicOfficesLabel({ rendered: 12, total: null, dataDate: '2026-05-06', outOfRange: false }),
    '12 in view · mapped to 2026-05-06',
  );
  // A mirror that reports no snapshot date simply omits the claim.
  assert.equal(
    civicOfficesLabel({ rendered: 12, total: null, dataDate: null, outOfRange: false }),
    '12 in view',
  );
});

test('a viewport too wide to ask about says so instead of reporting zero', () => {
  // "0 in view" over a continent is a false statement about the world; this is
  // a statement about the layer.
  assert.equal(
    civicOfficesLabel({ rendered: 0, total: null, dataDate: null, outOfRange: true }),
    'zoom in to load — too wide to map',
  );
});

// ── Reading the response ─────────────────────────────────────────────────────

test('the count element is read as the total and never drawn as a feature', () => {
  const parsed = readCivicOfficesPayload({
    osm3s: { timestamp_osm_base: '2026-05-06T03:25:00Z' },
    elements: [
      { type: 'count', id: 0, tags: { total: '437', nodes: '300' } },
      { type: 'node', id: 1, lat: 21.03, lon: 105.85, tags: { amenity: 'police', name: 'Công an phường Giảng Võ' } },
    ],
  });

  assert.equal(parsed.total, 437);
  assert.equal(parsed.dataDate, '2026-05-06');
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0].name, 'Công an phường Giảng Võ');
});

test('a response without a count reports that it has none', () => {
  const parsed = readCivicOfficesPayload({
    elements: [{ type: 'node', id: 1, lat: 21.03, lon: 105.85, tags: { amenity: 'townhall' } }],
  });

  assert.equal(parsed.total, null, 'a missing count must not become the rendered length');
  assert.equal(parsed.dataDate, null);
  assert.equal(parsed.features.length, 1);
});

test('a way or relation is placed at its center, and a feature without one is dropped', () => {
  const parsed = readCivicOfficesPayload({
    elements: [
      { type: 'way', id: 2, center: { lat: 21.04, lon: 105.83 }, tags: { amenity: 'townhall', name: 'UBND phường Yên Phụ' } },
      // Geometry the query asked for but Overpass could not centre: drawing it
      // at 0,0 would put a Hanoi office in the Gulf of Guinea.
      { type: 'relation', id: 3, tags: { office: 'government', name: 'no geometry' } },
    ],
  });

  assert.deepEqual(parsed.features.map((feature) => feature.name), ['UBND phường Yên Phụ']);
  assert.equal(parsed.features[0].lat, 21.04);
});

test('an untagged or unrelated feature is dropped rather than defaulted into a class', () => {
  const parsed = readCivicOfficesPayload({
    elements: [
      { type: 'node', id: 4, lat: 1, lon: 1, tags: { amenity: 'cafe', name: 'not a civic office' } },
      { type: 'node', id: 5, lat: 1, lon: 1 },
    ],
  });

  assert.deepEqual(parsed.features, []);
});

test('malformed payloads yield nothing rather than throwing', () => {
  for (const payload of [undefined, null, {}, { elements: 'nope' }]) {
    const parsed = readCivicOfficesPayload(payload);
    assert.deepEqual(parsed.features, []);
    assert.equal(parsed.total, null);
  }
});

// ── Classification ───────────────────────────────────────────────────────────

test('the more specific tag wins, by declared order rather than by luck', () => {
  // A station tagged both ways is a police station, not a generic office.
  assert.equal(classifyCivicOffice({ amenity: 'police', office: 'government' }).id, 'police');
  assert.equal(classifyCivicOffice({ amenity: 'townhall', office: 'government' }).id, 'townhall');
  assert.equal(classifyCivicOffice({ office: 'government' }).id, 'government');
  assert.equal(classifyCivicOffice({ amenity: 'cafe' }), null);
  assert.equal(classifyCivicOffice(null), null);
});

// ── The query ────────────────────────────────────────────────────────────────

test('the query asks for the count and the features from one result set', () => {
  const query = civicOfficesQuery(HANOI);

  assert.match(query, /out count;/, 'without this the row cannot report a total it did not draw');
  assert.match(query, /out center tags \d+;/);
  // Every selector carries the bbox: the proxy rejects an unbounded statement,
  // and an unbounded one would ask a public mirror for the planet.
  const selectors = query.match(/nwr\[[^\]]+\]\([^)]+\)/g) || [];
  assert.equal(selectors.length, 3, 'police, town halls and government offices');
  for (const selector of selectors) {
    assert.ok(selector.includes('20.98,105.78,21.08,105.9'), `unbounded selector: ${selector}`);
  }
});

test('a viewport wider than the layer will ask about is refused before the request', () => {
  assert.equal(boundsTooWide(HANOI), false);
  assert.equal(boundsTooWide({ south: 8, west: 102, north: 23.5, east: 110 }), true, 'a country');
  assert.equal(boundsTooWide({ south: 20, west: 100, north: 21, east: 110 }), true, 'wide but short');
  assert.equal(boundsTooWide(null), true, 'no readable rectangle is not a reason to ask for one');
});
