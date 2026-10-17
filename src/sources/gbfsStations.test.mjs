import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStationInformation } from './gbfsStations.js';

const station = (fields = {}) => ({
  station_id: 's1',
  lat: 30.2681,
  lon: -97.7469,
  capacity: 13,
  ...fields,
});
const parseName = (fields, version) =>
  parseStationInformation({
    version,
    data: { stations: [station(fields)] },
  }).get('s1').name;

const parseCapacity = (fields) =>
  parseStationInformation({ data: { stations: [station(fields)] } }).get('s1')
    .capacity;

test('capacity counts docks, not the geofenced area PBSC adds to it', () => {
  // Bilbao Bizi, BiciMAD and Dbizi as published on 2026-10-17.
  assert.equal(parseCapacity({ capacity: 839, geofenced_capacity: 800 }), 39);
  assert.equal(parseCapacity({ capacity: 43, geofenced_capacity: 20 }), 23);
  assert.equal(parseCapacity({ capacity: 19, geofenced_capacity: 0 }), 19);
});

test('capacity is read as given without a usable geofenced_capacity', () => {
  assert.equal(parseCapacity({ capacity: 27 }), 27);
  assert.equal(parseCapacity({ capacity: 27, geofenced_capacity: null }), 27);
  assert.equal(parseCapacity({ capacity: 27, geofenced_capacity: 'n/a' }), 27);
  assert.equal(parseCapacity({ capacity: 10, geofenced_capacity: 30 }), 10);
  assert.equal(parseCapacity({ capacity: null, geofenced_capacity: 5 }), null);
});

test('GBFS v2 station names remain trimmed strings', () => {
  assert.equal(
    parseName({ name: ' Republic Square ', short_name: 'Short' }, '2.3'),
    'Republic Square',
  );
});

test('underscores in station names read as word breaks', () => {
  // As published by JCDecaux's Spanish contracts (checked 2026-10-17).
  for (const [published, shown] of [
    ['_PLAZA_MUSICO_LOPEZ_CHAVARRI', 'PLAZA MUSICO LOPEZ CHAVARRI'],
    ['_GLORIETA OLIMPICA', 'GLORIETA OLIMPICA'],
    ['_CAMPAMENTO_81', 'CAMPAMENTO 81'],
    ['Plaza__Mayor_ ', 'Plaza Mayor'],
  ]) {
    assert.equal(parseName({ name: published }), shown);
  }
});

test('spacing without underscores stays as the operator published it', () => {
  assert.equal(parseName({ name: 'C/  NÀPOLS, 82' }), 'C/  NÀPOLS, 82');
});

test('a name of only underscores falls back to short_name, then to empty', () => {
  assert.equal(parseName({ name: '_', short_name: '_S_1_' }), 'S 1');
  assert.equal(parseName({ name: '__', short_name: '_' }), '');
});

test('underscores are read the same in GBFS v3 localized names', () => {
  assert.equal(
    parseName(
      {
        name: [
          { language: 'es', text: '_' },
          { language: 'en', text: '_COLON_I' },
        ],
      },
      '3.0',
    ),
    'COLON I',
  );
});

test('GBFS v3 station names prefer English over the first translation', () => {
  assert.equal(
    parseName(
      {
        name: [
          { language: 'hu', text: 'Köztársaság tér' },
          { language: 'en', text: ' Republic Square ' },
        ],
      },
      '3.0',
    ),
    'Republic Square',
  );
});

test('English preference accepts case differences and regional language tags', () => {
  for (const language of ['EN', 'en-GB', 'En-US']) {
    assert.equal(
      parseName({
        name: [
          { language: 'hu', text: 'Hungarian' },
          { language, text: 'English' },
        ],
      }),
      'English',
    );
  }
});

test('without usable English text the first usable translation wins', () => {
  assert.equal(
    parseName({
      name: [
        null,
        { language: 'en', text: '  ' },
        { language: 'en', text: 42 },
        { language: 'hu', text: ' Első ' },
        { language: 'fr', text: 'Deuxième' },
      ],
    }),
    'Első',
  );
});

test('malformed language fields cannot abort translation selection', () => {
  const name = [
    null,
    false,
    'bad',
    {},
    { language: 42, text: 'Fallback' },
    { language: { unexpected: true }, text: 'Other' },
    { language: 'en', text: 'English' },
  ];
  assert.equal(parseName({ name }), 'English');
  assert.equal(
    parseName({ name: [{ text: ' Usable text without a locale ' }] }),
    'Usable text without a locale',
  );
});

test('a usable name takes precedence over an English short name', () => {
  assert.equal(
    parseName({
      name: [{ language: 'hu', text: 'Full name' }],
      short_name: [{ language: 'en', text: 'Short name' }],
    }),
    'Full name',
  );
});

test('missing, empty and malformed names fall back to localized short_name', () => {
  for (const name of [
    undefined,
    null,
    '',
    '  ',
    [],
    {},
    0,
    42,
    false,
    [null, {}, { language: 'en', text: [] }, { language: 'hu', text: ' ' }],
  ]) {
    assert.equal(
      parseName({
        name,
        short_name: [
          { language: 'hu', text: 'Rövid' },
          { language: 'en', text: ' Short ' },
        ],
      }),
      'Short',
    );
  }
});

test('localized names can fall back to legacy short_name strings', () => {
  assert.equal(parseName({ name: [], short_name: ' Short ' }), 'Short');
});

test('no usable name leaves the station available with an empty name', () => {
  for (const value of [
    undefined,
    null,
    '',
    [],
    {},
    42,
    true,
    [null, { text: false }, { language: 'en', text: ' ' }],
  ]) {
    assert.equal(parseName({ name: value, short_name: value }), '');
  }
});

test('name shape is normalized even when a feed omits or misstates its version', () => {
  const name = [{ language: 'en', text: 'Republic Square' }];
  for (const version of [undefined, '2.3', '3.0', '3.1', 'unknown']) {
    assert.equal(parseName({ name }, version), 'Republic Square');
    assert.equal(parseName({ name: 'Legacy name' }, version), 'Legacy name');
  }
});

test('bad names do not lose valid stations or their metadata', () => {
  const information = parseStationInformation({
    version: '3.0',
    data: {
      stations: [
        station({ station_id: 'bad', name: [null, {}] }),
        station({
          station_id: 'short',
          name: [],
          short_name: [{ language: 'en', text: 'Short' }],
        }),
        station({
          station_id: 'good',
          name: [{ language: 'en', text: 'Republic Square' }],
        }),
      ],
    },
  });
  assert.equal(information.size, 3);
  assert.equal(information.get('bad').name, '');
  assert.equal(information.get('short').name, 'Short');
  assert.deepEqual(information.get('good'), {
    stationId: 'good',
    name: 'Republic Square',
    lat: 30.2681,
    lon: -97.7469,
    capacity: 13,
    isInstalled: true,
    isRenting: true,
    isReturning: true,
  });
});

test('normalizing a localized name leaves the feed document unchanged', () => {
  const payload = {
    version: '3.0',
    data: {
      stations: [
        station({
          name: [
            { language: 'hu', text: 'Magyar' },
            { language: 'en', text: ' English ' },
          ],
        }),
      ],
    },
  };
  const original = structuredClone(payload);
  parseStationInformation(payload);
  assert.deepEqual(payload, original);
});
