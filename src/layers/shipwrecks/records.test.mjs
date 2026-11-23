import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeShipwreckRecords,
  normalizeEmodnetFeatures,
  normalizeShipwreckSnapshot,
  normalizeWikidataResults,
  parseYear,
  WIKIDATA_QUERY,
} from './records.js';

function feature(id, properties, coordinates = [-4.35, 54.13]) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates },
    properties,
  };
}

test('EMODnet wrecks keep ship facts and drop text that names people', () => {
  const [wreck, roman] = normalizeEmodnetFeatures({
    features: [
      feature('w.1', {
        name: 'MAINA-NUI',
        sink_yr: '1987',
        sink_context: 'Sank on 07/02/1987',
        obj_type: 'Pusher or tug',
        least_depth: 12.5,
        depth_prec: 'Least depth known',
        loc_prec: 50,
        country: 'France',
        source_inf: 'SHOM',
        statutory: 'n/a',
        website1: 'n/a',
      }),
      feature('w.2', {
        name: 'Lerici',
        sink_yr: '',
        dating: 'C1st-2nd AD',
        period: 'Roman Imperial',
        artefacts: 'Marble, Columns',
        obj_type: 'n/a',
        ship_char: 'Owned by J. Smith, master was A. Jones',
        sink_context: 'Wrecked here, reported by Mr Smith',
      }),
      feature('w.3', { name: 'Copied', source_inf: 'www.wrecksite.eu' }),
      feature('w.4', { name: 'Null island' }, [0, 0]),
    ],
  });
  const ids = normalizeEmodnetFeatures({
    features: [
      feature('w.3', { name: 'Copied', source_inf: 'www.wrecksite.eu' }),
      feature('w.5', {
        source_inf: `${'SHOM; '.repeat(20)}wrecksite.eu`,
      }),
      feature('w.6', { website1: 'https://www.wrecksite.eu/wreck.aspx?1' }),
      feature('w.7', { website1: 'wrecksite.eu/wreck/1' }),
      feature('w.8', { name: 'Kept', source_inf: 'SHOM' }),
    ],
  }).map((record) => record.id);
  assert.deepEqual(ids, ['emodnet:w.8'], 'wrecksite.eu rows are all skipped');
  assert.equal(wreck.id, 'emodnet:w.1');
  assert.equal(wreck.year, 1987);
  assert.equal(wreck.vesselType, 'Pusher or tug');
  assert.equal(wreck.cause, 'Sank on 07/02/1987');
  assert.equal(wreck.depth, 12.5);
  assert.equal(wreck.positionAccuracy, 50);
  assert.equal(wreck.url, null);
  assert.equal(roman.year, null);
  assert.equal(roman.ancient, true);
  assert.equal(roman.dating, 'C1st-2nd AD');
  assert.equal(roman.notes, 'Roman Imperial (C1st-2nd AD)');
  assert.equal(roman.cargo, 'Marble, Columns');
  assert.equal(roman.vesselType, null, 'a history naming people is no type');
  assert.equal(roman.cause, null, 'text naming a person is dropped');
});

test('Wikidata rows fold into one record per item', () => {
  const item = 'http://www.wikidata.org/entity/Q1471525';
  const records = normalizeWikidataResults({
    results: {
      bindings: [
        {
          item: { value: item },
          itemLabel: { value: 'HMS Havant' },
          itemDescription: { value: '1939 G and H-class destroyer' },
          coord: { value: 'Point(2.26 51.13)' },
          sunk: { value: '1940-06-01T00:00:00Z' },
          sunkPrecision: { value: '11' },
          enwiki: { value: 'https://en.wikipedia.org/wiki/HMS_Havant_(H32)' },
        },
        {
          item: { value: item },
          typeLabel: { value: 'destroyer' },
          deaths: { value: '8' },
          coord: { value: 'Point(2.26 51.13)' },
        },
        {
          item: { value: 'http://www.wikidata.org/entity/Q9' },
          itemLabel: { value: 'Q9' },
          coord: { value: 'Point(10 10)' },
        },
      ],
    },
  });
  assert.equal(records.length, 2);
  const [havant, unnamed] = records;
  assert.equal(havant.date, '1940-06-01');
  assert.equal(havant.year, 1940);
  assert.equal(havant.vesselType, 'destroyer');
  assert.equal(havant.casualties, 8);
  assert.equal(havant.url, 'https://en.wikipedia.org/wiki/HMS_Havant_(H32)');
  assert.equal(unnamed.name, null);
  assert.equal(unnamed.url, 'https://www.wikidata.org/wiki/Q9');
});

test('a wreck in both sources keeps Wikidata and takes EMODnet survey facts', () => {
  const wikidata = [
    {
      id: 'wikidata:Q1',
      source: 'wikidata',
      name: 'HMS Havant',
      lat: 51.13,
      lon: 2.26,
      year: null,
      depth: null,
    },
  ];
  const emodnet = [
    {
      id: 'emodnet:a',
      source: 'emodnet',
      name: 'Havant (HMS)',
      lat: 51.131,
      lon: 2.262,
      year: 1940,
      depth: 14.7,
    },
    {
      id: 'emodnet:b',
      source: 'emodnet',
      name: 'HMS Havant',
      lat: 45,
      lon: -10,
      year: 1950,
    },
  ];
  const merged = mergeShipwreckRecords(emodnet, wikidata);
  assert.deepEqual(
    merged.map((record) => record.id),
    ['wikidata:Q1', 'emodnet:b'],
  );
  assert.equal(merged[0].year, 1940);
  assert.equal(merged[0].depth, 14.7);
  assert.equal(merged[0].alsoIn, 'emodnet');
});

test('years and snapshots are validated', () => {
  assert.equal(parseYear('1917-1918'), 1917);
  assert.equal(parseYear('c. 1588'), 1588);
  assert.equal(parseYear(''), null);
  assert.equal(parseYear('3000'), null);
  assert.equal(normalizeShipwreckSnapshot({}), null);
  const rows = normalizeShipwreckSnapshot({
    records: [
      { id: 'a', source: 'emodnet', lat: 1, lon: 2, url: 'javascript:x' },
      { id: 'a', source: 'emodnet', lat: 1, lon: 2 },
      { id: 'b', source: 'other', lat: 1, lon: 2 },
      { id: 'c', source: 'wikidata', lat: 91, lon: 2 },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, null);
});

test('a sinking event folds into its ship; month-precise dates keep the year only', () => {
  const entity = (q) => ({ value: `http://www.wikidata.org/entity/${q}` });
  const records = normalizeWikidataResults({
    results: {
      bindings: [
        {
          item: entity('Q25173'),
          itemLabel: { value: 'Titanic' },
          coord: { value: 'Point(-49.9469 41.7325)' },
        },
        {
          item: entity('Q3018259'),
          itemLabel: { value: 'wreck of the RMS Titanic' },
          coord: { value: 'Point(-49.9469 41.7325)' },
        },
        {
          item: entity('Q2577588'),
          itemLabel: { value: 'sinking of the RMS Titanic' },
          coord: { value: 'Point(-49.9458 41.7319)' },
          event: { value: 'event' },
          sunk: { value: '1912-04-01T00:00:00Z' },
          sunkPrecision: { value: '10' },
          deaths: { value: '1501' },
          survivors: { value: '712' },
        },
        {
          item: entity('Q1245004'),
          itemLabel: { value: 'Costa Concordia disaster' },
          coord: { value: 'Point(10.92 42.37)' },
          event: { value: 'event' },
          sunk: { value: '2012-01-13T00:00:00Z' },
          sunkPrecision: { value: '11' },
          deaths: { value: '32' },
        },
      ],
    },
  });
  assert.deepEqual(
    records.map((record) => record.id),
    ['wikidata:Q25173', 'wikidata:Q1245004'],
  );
  const [titanic, concordia] = records;
  assert.equal(titanic.date, null);
  assert.equal(titanic.year, 1912);
  assert.equal(titanic.casualties, 1501);
  assert.equal(titanic.survivors, 712);
  assert.equal(concordia.name, 'Costa Concordia disaster');
  assert.equal(concordia.date, '2012-01-13');
  assert.equal('event' in concordia, false);
});

test('a date before AD 100 is kept as ancient text, never read as an AD year', () => {
  const entity = (q) => ({ value: `http://www.wikidata.org/entity/${q}` });
  const [bc, earlyAd, roman] = normalizeWikidataResults({
    results: {
      bindings: [
        {
          item: entity('Q1'),
          itemLabel: { value: 'Antikythera wreck' },
          coord: { value: 'Point(23.3 35.9)' },
          sunk: { value: '-0299-01-01T00:00:00Z' },
          sunkPrecision: { value: '11' },
        },
        {
          item: entity('Q2'),
          itemLabel: { value: 'Early wreck' },
          coord: { value: 'Point(12 40)' },
          sunk: { value: '0050-01-01T00:00:00Z' },
          sunkPrecision: { value: '9' },
        },
        {
          item: entity('Q3'),
          itemLabel: { value: 'Roman wreck' },
          coord: { value: 'Point(13 41)' },
          sunk: { value: '0300-01-01T00:00:00Z' },
          sunkPrecision: { value: '9' },
        },
      ],
    },
  });
  assert.equal(bc.year, null, '300 BC is not the year 300');
  assert.equal(bc.date, null, 'no day for a BC date');
  assert.equal(bc.dating, '300 BC');
  assert.equal(bc.ancient, true);
  assert.equal(earlyAd.year, null);
  assert.equal(earlyAd.dating, 'AD 50');
  assert.equal(earlyAd.ancient, true);
  assert.equal(roman.year, 300);
  assert.equal(roman.dating, null);
});

test('an end-of-service date keeps its precision: a year-only one is no day', () => {
  const entity = (q) => ({ value: `http://www.wikidata.org/entity/${q}` });
  const [yearOnly, dayPrecise, unknown] = normalizeWikidataResults({
    results: {
      bindings: [
        {
          item: entity('Q11'),
          itemLabel: { value: 'Year only' },
          coord: { value: 'Point(1 50)' },
          end: { value: '1917-01-01T00:00:00Z' },
          endPrecision: { value: '9' },
        },
        {
          item: entity('Q12'),
          itemLabel: { value: 'Day precise' },
          coord: { value: 'Point(2 50)' },
          end: { value: '1917-03-04T00:00:00Z' },
          endPrecision: { value: '11' },
        },
        {
          item: entity('Q13'),
          itemLabel: { value: 'No precision' },
          coord: { value: 'Point(3 50)' },
          end: { value: '1917-01-01T00:00:00Z' },
        },
      ],
    },
  });
  assert.equal(yearOnly.date, null, 'not shown as 1 Jan 1917');
  assert.equal(yearOnly.year, 1917);
  assert.equal(dayPrecise.date, '1917-03-04');
  assert.equal(unknown.date, null, 'an unknown precision is a year only');
  assert.equal(unknown.year, 1917);
});

test('the query reads the end of service with its precision', () => {
  assert.match(
    WIKIDATA_QUERY,
    /psv:P576 \[ wikibase:timeValue \?end ; wikibase:timePrecision \?endPrecision \]/,
  );
  assert.doesNotMatch(WIKIDATA_QUERY, /wdt:P576/);
});

test('labels and links do not default to one other language', () => {
  assert.doesNotMatch(WIKIDATA_QUERY, /ptwiki|pt\.wikipedia/);
  assert.match(WIKIDATA_QUERY, /wikibase:language "en,mul,/);
});
