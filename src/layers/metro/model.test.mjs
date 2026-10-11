import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCitiesQuery,
  buildLineSegments,
  buildStationsQuery,
  isViewQueryable,
  mergeStations,
  normalizeLineColor,
  parseCities,
  parseStations,
  parseWktPoint,
  qidFromEntity,
  snapCityBox,
  summarizeLines,
} from './model.js';

const uri = (id) => ({ value: `http://www.wikidata.org/entity/${id}` });
const lit = (value) => ({ value: String(value) });

test('extracts Q-ids and rejects anything else', () => {
  assert.equal(qidFromEntity('http://www.wikidata.org/entity/Q90'), 'Q90');
  assert.equal(qidFromEntity('Q60'), 'Q60');
  assert.equal(qidFromEntity('P31'), null);
  assert.equal(qidFromEntity('Q60 } ; DROP'), null);
  assert.equal(qidFromEntity(''), null);
});

test('parses WKT points and colours defensively', () => {
  assert.deepEqual(parseWktPoint('Point(2.35 48.85)'), { lon: 2.35, lat: 48.85 });
  assert.deepEqual(parseWktPoint('Point(-73.9 4.0E1)'), { lon: -73.9, lat: 40 });
  assert.equal(parseWktPoint('Point(2 95)'), null);
  assert.equal(parseWktPoint('LINESTRING(1 2, 3 4)'), null);
  assert.equal(normalizeLineColor('0055C8'), '#0055c8');
  assert.equal(normalizeLineColor('#FF82B4'), '#ff82b4');
  assert.equal(normalizeLineColor('red'), null);
});

test('gates and snaps view boxes', () => {
  assert.equal(isViewQueryable({ west: 2, south: 48, east: 3, north: 49 }), true);
  assert.equal(isViewQueryable({ west: 0, south: 40, east: 5, north: 49 }), false);
  assert.equal(isViewQueryable({ west: 3, south: 48, east: 2, north: 49 }), false);
  assert.deepEqual(snapCityBox({ west: 2.31, south: 48.8, east: 2.4, north: 48.9 }), {
    west: 2.25,
    south: 48.75,
    east: 2.5,
    north: 49,
  });
});

test('builds bounded queries with only validated ids', () => {
  const cities = buildCitiesQuery({ west: 2, south: 48, east: 3, north: 49 });
  assert.match(cities, /wikibase:box/);
  assert.match(cities, /Point\(2 48\)/);
  assert.match(cities, /Point\(3 49\)/);
  assert.match(cities, /wd:Q515/);
  assert.match(cities, /LIMIT 6/);
  assert.throws(() => buildCitiesQuery({ west: NaN }), TypeError);

  const stations = buildStationsQuery(['Q90', 'bogus', 'http://www.wikidata.org/entity/Q60', 'Q90']);
  assert.match(stations, /VALUES \?city \{ wd:Q90 wd:Q60 \}/);
  assert.match(stations, /wd:Q928830/);
  assert.match(stations, /wdt:P81/);
  assert.match(stations, /wdt:P465/);
  assert.match(stations, /p:P197/);
  assert.match(stations, /pq:P81/);
  assert.throws(() => buildStationsQuery(['nope']), TypeError);
});

test('parses cities, de-duplicating repeated items', () => {
  const cities = parseCities({
    results: {
      bindings: [
        { city: uri('Q90'), name: lit('Paris'), population: lit(2103778), location: lit('Point(2.35 48.85)') },
        { city: uri('Q90'), name: lit('Paris'), population: lit(1) },
        { city: uri('Q172455'), population: lit('119019') },
        { city: lit('garbage') },
      ],
    },
  });
  assert.deepEqual(cities, [
    { id: 'Q90', name: 'Paris', population: 2103778, lon: 2.35, lat: 48.85 },
    { id: 'Q172455', name: 'Q172455', population: 119019, lon: null, lat: null },
  ]);
  assert.throws(() => parseCities({}), /Malformed/);
});

test('parses stations per city with line refs and adjacency', () => {
  const byCity = parseStations(
    {
      results: {
        bindings: [
          {
            station: uri('Q1'),
            stationLabel: lit('Ménilmontant'),
            coord: lit('Point(2.38 48.86)'),
            city: uri('Q90'),
            lineData: lit('Q50~0055C8~Paris Métro Line 2|Q50~~|bad~ff0000~X'),
            adjacent: lit('Q2~Q50|Q2~Q50|Q3~|Q1~Q50'),
          },
          { station: uri('Q2'), stationLabel: lit('Q2'), coord: lit('Point(2.3 48.8)'), city: uri('Q90'), lineData: lit('Q51~~A~B|Q50~~') },
          { station: uri('Q3'), coord: lit('bad'), city: uri('Q90') },
        ],
      },
    },
    ['Q90', 'Q172455'],
  );
  assert.deepEqual([...byCity.keys()], ['Q90', 'Q172455']);
  assert.equal(byCity.get('Q172455').length, 0);
  const [first, second] = byCity.get('Q90');
  assert.equal(first.name, 'Ménilmontant');
  assert.equal(first.color, '#0055c8');
  assert.deepEqual(first.lineRefs, [{ id: 'Q50', name: 'Paris Métro Line 2', color: '#0055c8' }]);
  assert.deepEqual(first.lines, ['Paris Métro Line 2']);
  assert.deepEqual(first.adjacent, [
    { id: 'Q2', lineId: 'Q50' },
    { id: 'Q3', lineId: null },
  ]);
  assert.match(first.url, /^https:\/\/www\.wikidata\.org\/wiki\/Q1\b/);
  assert.equal(second.name, 'Unnamed station');
  assert.deepEqual(second.lines, ['A~B', 'Q50']);
  assert.equal(second.color, null);
  assert.deepEqual(second.adjacent, []);
  assert.equal(byCity.get('Q90').length, 2);
});

const station = (id, lon, lineRefs, adjacent = []) => ({
  id,
  lon,
  lat: 48.85,
  lineRefs,
  lines: lineRefs.map((line) => line.name),
  color: lineRefs.find((line) => line.color)?.color || null,
  adjacent,
});
const L1 = { id: 'Q10', name: 'L1', color: '#111111' };
const L2 = { id: 'Q20', name: 'L2', color: '#222222' };

test('merges overlapping city station lists and summarizes lines by line colour', () => {
  const a = station('Q1', 2.30, [L1]);
  const b = station('Q2', 2.31, [{ ...L1, color: null }, L2]);
  const c = station('Q3', 2.32, [L2]);
  const merged = mergeStations([[a, b], [b, c], undefined]);
  assert.deepEqual(merged.map((s) => s.id), ['Q1', 'Q2', 'Q3']);
  assert.deepEqual(summarizeLines(merged), [
    { name: 'L1', color: '#111111', count: 2 },
    { name: 'L2', color: '#222222', count: 2 },
  ]);
});

test('builds one coloured segment per adjacent pair and line', () => {
  const stations = [
    // Both ends list the same link: drawn once.
    station('Q1', 2.30, [L1], [{ id: 'Q2', lineId: 'Q10' }]),
    station('Q2', 2.31, [L1, L2], [
      { id: 'Q1', lineId: 'Q10' },
      { id: 'Q3', lineId: null }, // unqualified: takes the shared line L2
      { id: 'Q9', lineId: 'Q20' }, // neighbour not loaded
      { id: 'Q4', lineId: 'Q20' }, // implausibly far
    ]),
    station('Q3', 2.32, [L2], [{ id: 'Q2', lineId: 'Q20' }]),
    station('Q4', 4.0, [L2]),
  ];
  const segments = buildLineSegments(stations);
  assert.deepEqual(
    segments.map(({ id, color }) => [id, color]),
    [
      ['Q1-Q2~Q10', '#111111'],
      ['Q2-Q3~Q20', '#222222'],
    ],
  );
  assert.equal(segments[0].from.id, 'Q1');
  assert.equal(segments[0].to.id, 'Q2');
  // An unqualified link with no shared line falls back to a station colour.
  const loose = buildLineSegments([
    station('Q5', 2.3, [L1], [{ id: 'Q6', lineId: null }]),
    station('Q6', 2.31, [L2]),
  ]);
  assert.deepEqual(loose.map(({ id, color }) => [id, color]), [['Q5-Q6~', '#111111']]);
  assert.deepEqual(buildLineSegments(undefined), []);
});
