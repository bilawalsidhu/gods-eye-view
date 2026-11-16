import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASN_RECORD_URL,
  WIKIDATA_PLACED_QUERY,
  WIKIDATA_QUERY,
  mergeAirAccidentRecords,
  normalizeAirAccidentSnapshot,
  spreadStackedRecords,
  normalizeWikidataResults,
} from './records.js';

const row = (qid, extra = {}) => ({
  item: { value: `http://www.wikidata.org/entity/${qid}` },
  coord: { value: 'Point(9.18 47.77)' },
  ...extra,
});

test('the queries read the event only, never people', () => {
  for (const query of [WIKIDATA_QUERY, WIKIDATA_PLACED_QUERY]) {
    assert.match(query, /wd:Q744913/);
    // P1120 is the death toll; no property pointing at persons is read
    // (P710 participant, P1050 victim, P1344 crew…).
    for (const property of ['P710', 'P1050', 'P1344', 'P3342', 'P50'])
      assert.doesNotMatch(query, new RegExp(`wdt:${property}\\b`));
  }
  assert.match(WIKIDATA_QUERY, /wdt:P625 \?coord/);
  assert.match(WIKIDATA_PLACED_QUERY, /FILTER NOT EXISTS \{ \?item wdt:P625/);
  assert.match(WIKIDATA_PLACED_QUERY, /\?place wdt:P625 \?coord/);
});

test('Wikidata items become one record each, with only safe article links', () => {
  const records = normalizeWikidataResults({
    results: {
      bindings: [
        row('Q163107', {
          itemLabel: { value: 'Überlingen mid-air collision' },
          date: { value: '2002-07-01T00:00:00Z' },
          deaths: { value: '71' },
          vehicleLabel: { value: 'Tupolev Tu-154' },
          placeLabel: { value: 'Überlingen' },
          countryLabel: { value: 'Germany' },
          flight: { value: 'BTC 2937' },
          enwiki: { value: 'https://en.wikipedia.org/wiki/Uberlingen' },
        }),
        // A second row carries another aircraft of the same item.
        row('Q163107', { vehicleLabel: { value: 'Boeing 757' } }),
        // A shorter name of the same aircraft is folded into the longer one.
        row('Q163107', { vehicleLabel: { value: 'Tupolev Tu-154M' } }),
        row('Q9', {
          itemLabel: { value: 'Q9' },
          asn: { value: '20020701-0' },
          enwiki: { value: 'https://evil.example/wiki/x' },
        }),
        row('Q10', { coord: { value: 'Point(500 2)' } }),
        { item: { value: 'not-an-entity' } },
      ],
    },
  });
  assert.equal(records.length, 2);
  const [first, second] = records;
  assert.deepEqual(
    {
      id: first.id,
      name: first.name,
      date: first.date,
      fatalities: first.fatalities,
      aircraft: first.aircraft,
      place: first.place,
      country: first.country,
      approximate: first.approximate,
      url: first.url,
    },
    {
      id: 'wikidata:Q163107',
      name: 'Überlingen mid-air collision',
      date: '2002-07-01',
      fatalities: 71,
      aircraft: 'Boeing 757 / Tupolev Tu-154M',
      place: 'Überlingen',
      country: 'Germany',
      approximate: false,
      url: 'https://en.wikipedia.org/wiki/Uberlingen',
    },
  );
  // An unlabelled item has no name; a foreign link falls back to ASN.
  assert.equal(second.name, null);
  assert.equal(second.url, `${ASN_RECORD_URL}20020701-0`);
  const [placed] = normalizeWikidataResults(
    { results: { bindings: [row('Q5')] } },
    { approximate: true },
  );
  assert.equal(placed.approximate, true);
  assert.equal(placed.url, 'https://www.wikidata.org/wiki/Q5');
});

test('an item in both queries keeps its own coordinate', () => {
  const own = [{ id: 'wikidata:Q1', approximate: false }];
  const placed = [
    { id: 'wikidata:Q1', approximate: true },
    { id: 'wikidata:Q2', approximate: true },
  ];
  assert.deepEqual(mergeAirAccidentRecords(own, placed), [
    { id: 'wikidata:Q1', approximate: false },
    { id: 'wikidata:Q2', approximate: true },
  ]);
});

test('the browser drops malformed rows and rejects a malformed payload', () => {
  assert.equal(normalizeAirAccidentSnapshot({}), null);
  assert.equal(normalizeAirAccidentSnapshot({ records: 'x' }), null);
  const rows = normalizeAirAccidentSnapshot({
    records: [
      {
        id: 'wikidata:Q1',
        lat: 1,
        lon: 2,
        fatalities: 3,
        name: 'A',
        url: 'https://en.wikipedia.org/wiki/A',
      },
      { id: 'wikidata:Q1', lat: 1, lon: 2 },
      { id: 'cenipa:1', lat: 1, lon: 2 },
      { id: 'wikidata:Q2', lat: 91, lon: 2 },
      {
        id: 'wikidata:Q3',
        lat: 1,
        lon: 2,
        approximate: true,
        fatalities: -1,
        name: 7,
        url: 'javascript:alert(1)',
      },
    ],
  });
  assert.deepEqual(
    rows.map(({ id, fatalities, name, url, approximate }) => ({
      id,
      fatalities,
      name,
      url,
      approximate,
    })),
    [
      {
        id: 'wikidata:Q1',
        fatalities: 3,
        name: 'A',
        url: 'https://en.wikipedia.org/wiki/A',
        approximate: false,
      },
      {
        id: 'wikidata:Q3',
        fatalities: null,
        name: null,
        url: null,
        approximate: true,
      },
    ],
  );
});

test('accidents stacked on one point are spread so each can be clicked', () => {
  const at = (id, approximate) => ({ id, lat: 60, lon: 40, approximate });
  const records = spreadStackedRecords([
    at('placed-1', true),
    at('own', false),
    { id: 'near', lat: 60.0002, lon: 40.0003, approximate: true },
    at('placed-2', true),
    { id: 'alone', lat: 10, lon: 179.99, approximate: true },
  ]);
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  // The one with its own coordinate stays put.
  assert.deepEqual([byId.own.lat, byId.own.lon], [60, 40]);
  assert.deepEqual([byId.alone.lat, byId.alone.lon], [10, 179.99]);
  const points = new Set(records.map((r) => `${r.lat},${r.lon}`));
  assert.equal(points.size, 5);
  for (const id of ['placed-1', 'placed-2', 'near']) {
    const km = Math.hypot(
      (byId[id].lat - 60) * 111,
      (byId[id].lon - 40) * 111 * Math.cos(Math.PI / 3),
    );
    assert.ok(km > 2 && km < 6, `${id} moved ${km} km`);
  }
});
