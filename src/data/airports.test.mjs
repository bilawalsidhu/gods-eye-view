// src/data/airports.test.mjs — the bundled OurAirports pack: its rows, the
// lookups by place and by code or name, a missing pack, and the build
// script's reading of OurAirports' CSV files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setAirportsFetchForTest,
  airportByCodeIn,
  airportCode,
  airportsNear,
  airportsWithin,
  findAirport,
  findAirportIn,
  foldName,
  indexAirports,
  isAirportCode,
  isAirportCountryCode,
  namesAirport,
  readAirportsPack,
} from './airports.js';
import {
  airportRows,
  isPlaceholderAirport,
  parseCsv,
} from '../../scripts/build-ourairports.mjs';

const ROWS = [
  [
    'KAUS',
    'AUS',
    'Austin–Bergstrom International Airport',
    30.1945,
    -97.6699,
    'large',
    'Austin',
    'US',
    542,
    2,
  ],
  [
    'KEDC',
    'EDC',
    'Austin Executive Airport',
    30.3975,
    -97.5664,
    'medium',
    'Austin',
    'US',
    620,
    1,
  ],
  [
    'EGLL',
    'LHR',
    'London Heathrow Airport',
    51.4706,
    -0.4619,
    'large',
    'London',
    'GB',
    83,
    2,
  ],
  [
    'NZCH',
    'CHC',
    'Christchurch International Airport',
    -43.4894,
    172.5322,
    'large',
    'Christchurch',
    'NZ',
    123,
    3,
  ],
  [
    'NFFN',
    'NAN',
    'Nadi International Airport',
    -17.7554,
    177.4431,
    'large',
    'Nadi',
    'FJ',
    59,
    2,
  ],
  ['bad row'],
];
const index = indexAirports(ROWS);

test('rows read as airports; a row without a position is left out', () => {
  assert.equal(index.airports.length, 5);
  const aus = index.codes.get('AUS');
  assert.equal(aus.ident, 'KAUS');
  assert.equal(aus.runways, 2);
  assert.equal(aus.elevationFt, 542);
  assert.equal(index.codes.get('KAUS'), aus, 'by ICAO too');
  assert.equal(airportCode(aus), 'AUS');
  assert.equal(airportCode({ ident: 'XYZW', iata: '' }), 'XYZW');
});

test('airports within a radius, nearest first, across cells and the antimeridian', () => {
  const near = airportsWithin(index, 30.21, -97.68, 5);
  assert.deepEqual(
    near.map((a) => a.ident),
    ['KAUS'],
  );
  assert.ok(near[0].distanceKm > 1 && near[0].distanceKm < 3);
  assert.deepEqual(
    airportsWithin(index, 30.3, -97.62, 40).map((a) => a.ident),
    ['KEDC', 'KAUS'],
  );
  assert.deepEqual(
    airportsWithin(index, -17.75, -179.9, 300).map((a) => a.ident),
    ['NFFN'],
    'across 180°',
  );
  const pole = indexAirports([['NZSP', '', 'South Pole', -90, 0]]);
  assert.equal(airportsWithin(pole, -89.995, 90, 2)[0]?.ident, 'NZSP');
  assert.deepEqual(airportsWithin(index, 0, 0, 50), []);
  assert.deepEqual(airportsWithin(index, Number.NaN, 0, 50), []);
});

test('a line names an airport by its code, or by name with "airport"', () => {
  assert.equal(findAirportIn(index, 'AUS')?.ident, 'KAUS');
  assert.equal(
    findAirportIn(index, 'aus'),
    null,
    'a code typed as a word is a place',
  );
  assert.equal(foldName('Zürich'), 'zurich');
  assert.notEqual(foldName('กา'), foldName('ก่า'), 'Thai marks stay');
  assert.notEqual(foldName('का'), foldName('क'), 'Hindi marks stay');
  assert.equal(findAirportIn(index, 'KAUS')?.ident, 'KAUS');
  assert.equal(
    findAirportIn(index, 'Austin airport')?.ident,
    'KAUS',
    'the larger of two',
  );
  assert.equal(findAirportIn(index, 'heathrow airport')?.ident, 'EGLL');
  assert.equal(
    findAirportIn(index, 'Austin'),
    null,
    'a city is not its airport',
  );
  assert.equal(findAirportIn(index, 'Paris airport'), null);
  assert.equal(findAirportIn(index, ''), null);
});

test('without the pack every lookup answers none, and nothing fails', async (t) => {
  t.after(() => _setAirportsFetchForTest(null));
  const missing = await readAirportsPack(
    async () => new Response('', { status: 404 }),
    'x',
  );
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.airports, []);
  await assert.rejects(
    readAirportsPack(async () => new Response('', { status: 503 }), 'x'),
    /HTTP 503/,
  );
  _setAirportsFetchForTest(async () => new Response('', { status: 404 }));
  assert.deepEqual(await airportsNear(30.19, -97.67), []);
  assert.equal(await findAirport('AUS'), null);
  _setAirportsFetchForTest(
    async () =>
      new Response(JSON.stringify({ meta: { count: 5 }, rows: ROWS }), {
        status: 200,
      }),
  );
  assert.equal((await findAirport('AUS'))?.ident, 'KAUS');
  assert.deepEqual(
    (await airportsNear(30.2, -97.67)).map((a) => a.ident),
    ['KAUS'],
  );
});

test('the build script checks CSV row width before projecting pack fields', () => {
  const header = 'ident,unused,name';
  assert.deepEqual(parseCsv(`${header}\nTEST,ignored,"Field, East"`), [
    { ident: 'TEST', name: 'Field, East' },
  ]);
  for (const row of ['TEST,Field', 'TEST,,Field,extra'])
    assert.throws(() => parseCsv(`${header}\n${row}`), /expected 3 fields/);
});

test('the build script reads OurAirports CSV: large and medium airports, small ones with service, open runways', () => {
  const airports = parseCsv(
    [
      'id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code',
      '1,KAUS,large_airport,"Austin–Bergstrom International Airport",30.194499969482422,-97.6698989868164,542,NA,US,US-TX,Austin,yes,KAUS,AUS',
      '2,KEDC,medium_airport,"Austin Executive, ""EDC""",30.3975,-97.5664,620,NA,US,US-TX,Austin,no,KEDC,EDC',
      '3,XS01,small_airport,Farm Strip,30.1,-97.1,,NA,US,US-TX,,no,,',
      '4,KS02,small_airport,Island Hop,30.2,-97.2,10,NA,US,US-TX,Isle,yes,,ISL',
      '5,TX99,heliport,Hospital Pad,30.3,-97.3,,NA,US,US-TX,,no,,',
      '6,KOLD,closed,Old Field,30.4,-97.4,,NA,US,US-TX,,no,,',
    ].join('\n'),
  );
  const runways = parseCsv(
    [
      'id,airport_ident,closed,le_ident,he_ident',
      '1,KAUS,0,08L,26R',
      '2,KAUS,0,08R,26L',
      '3,KAUS,1,17,35',
      '4,KEDC,0,,',
      '5,KAUS,0,H-NORTH,',
      '6,KAUS,0,26R,8L',
    ].join('\r\n'),
  );
  const rows = airportRows(airports, runways);
  assert.deepEqual(
    rows.map((row) => row[0]),
    ['KAUS', 'KEDC', 'KS02'],
  );
  assert.deepEqual(rows[0], [
    'KAUS',
    'AUS',
    'Austin–Bergstrom International Airport',
    30.1945,
    -97.6699,
    'large',
    'Austin',
    'US',
    542,
    2,
  ]);
  assert.equal(rows[1][2], 'Austin Executive, "EDC"', 'quoted fields');
  assert.equal(rows[2][8], 10);
  assert.equal(
    indexAirports(rows).airports.length,
    3,
    'the app reads what the script writes',
  );
});

test('a name matches whole words, and among the same size the airport nearest where the search landed', () => {
  const rows = [
    [
      'KJFK',
      'JFK',
      'John F. Kennedy International Airport',
      40.64,
      -73.78,
      'large',
      'New York',
      'US',
      13,
      4,
    ],
    [
      'KCMH',
      'CMH',
      'John Glenn Columbus International Airport',
      39.998,
      -82.892,
      'medium',
      'Columbus',
      'US',
      815,
      2,
    ],
    [
      'KCSG',
      'CSG',
      'Columbus Airport',
      32.516,
      -84.939,
      'medium',
      'Columbus',
      'US',
      397,
      2,
    ],
  ];
  const airports = indexAirports(rows);
  assert.equal(
    findAirportIn(airports, 'York airport'),
    null,
    '"york" is not New York',
  );
  // Landed in Georgia: Columbus, Georgia; landed in Ohio: Columbus, Ohio.
  assert.equal(
    findAirportIn(airports, 'Columbus airport', { lat: 32.46, lon: -84.99 })
      ?.ident,
    'KCSG',
  );
  assert.equal(
    findAirportIn(airports, 'Columbus airport', { lat: 39.96, lon: -83.0 })
      ?.ident,
    'KCMH',
  );
});

test('the bundled pack: exact codes and names find the right airport; place names find none', async () => {
  const { readFile } = await import('node:fs/promises');
  const pack = JSON.parse(
    await readFile(
      new URL('./local_data/ourairports/airports.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(pack.meta.license, 'Public domain');
  const airports = indexAirports(pack.rows);
  const austin = { lat: 30.27, lon: -97.74 };
  const sf = { lat: 37.77, lon: -122.42 };
  const find = (line, near) =>
    findAirportIn(airports, line, near)?.ident ?? null;
  for (const ident of ['EHAM', 'VOBL', 'KBWI', 'KDAL']) {
    const airport = airports.codes.get(ident);
    assert.equal(find(airport.name, airport), ident);
  }
  assert.equal(find('Amsterdam Schiphol airport'), 'EHAM');
  assert.equal(find('Columbus airport', { lat: 32.46, lon: -84.99 }), 'KCSG');
  assert.equal(find('Columbus airport', { lat: 39.96, lon: -83 }), 'KCMH');
  assert.equal(find('London airport', { lat: 43.03, lon: -81.15 }), 'CYXU');
  assert.equal(find('Flughafen Stuttgart'), 'EDDS');
  const paris = { lat: 49.0097, lon: 2.5479 };
  assert.equal(find('Aéroport de Paris-Charles-de-Gaulle', paris), 'LFPG');
  assert.equal(find('Roissy-en-France', paris), null);
  assert.ok(namesAirport('Aéroport de Paris-Charles-de-Gaulle'));
  assert.equal(find('Tromso airport'), 'ENTC');
  assert.equal(find('Lodz airport'), 'EPLL');
  assert.equal(find('AUS', austin), 'KAUS');
  assert.equal(find('KAUS', austin), 'KAUS');
  // Austin–Bergstrom ahead of Austin, Nevada and the other Austins.
  assert.equal(find('Austin airport', austin), 'KAUS');
  assert.equal(find('SFO', sf), 'KSFO');
  assert.equal(find('KSFO', sf), 'KSFO');
  assert.equal(find('LAX', sf), 'KLAX');
  assert.equal(find('JFK'), 'KJFK');
  // A place search stays a place search: no airport is named.
  assert.equal(find('NYC'), null);
  assert.equal(find('Austin', austin), null);
  assert.equal(find('New York'), null);
  assert.equal(find('sfo'), null, 'a code only in capitals');
});

test('a line that is exactly a code: any airport in capitals, only a large one in lower case', async () => {
  const { readFile } = await import('node:fs/promises');
  const airports = indexAirports(
    JSON.parse(
      await readFile(
        new URL('./local_data/ourairports/airports.json', import.meta.url),
        'utf8',
      ),
    ).rows,
  );
  const code = (line) => airportByCodeIn(airports, line)?.ident ?? null;
  assert.equal(code('sfo'), 'KSFO');
  assert.equal(code('SFO'), 'KSFO');
  assert.equal(code('ksfo'), 'KSFO');
  assert.equal(code('aus'), 'KAUS');
  assert.equal(code(' AUS '), 'KAUS');
  // Ely is a town in England and in Nevada; ELY is Nevada's airport.
  assert.equal(code('ELY'), 'KELY');
  assert.equal(code('ely'), null, 'a medium airport only in capitals');
  assert.equal(code('usa'), null);
  assert.equal(code('USA'), 'KJQF');
  assert.equal(code('San Francisco'), null);
  assert.equal(code('VANM'), 'IN-0276');
  assert.equal(code('NMI'), 'IN-0276');
  assert.equal(code('SPJC'), 'SPIM');
  assert.equal(code('CNC3'), 'CNC3');
  assert.equal(isAirportCode(' CNC3 '), true);
  assert.equal(isAirportCode('1234'), false);
  assert.equal(isAirportCountryCode('esb'), false);
  assert.equal(isAirportCountryCode('AUS'), true);
  assert.equal(code('SF0'), null);
  assert.equal(code(''), null);
  assert.equal(airportByCodeIn(null, 'SFO'), null);
});

// OurAirports keeps placeholder rows beside real airports: a "(Duplicate)YEG"
// at Edmonton International's exact spot, a second "YEG" in Saskatchewan,
// "[Duplicate] …", "(Misplaced duplicate?) …" and "[CLOSED]" entries. Left
// in, they win a name or nearest-airport lookup over the real airport.
test('the bundled pack has no placeholder rows, so "Edmonton airport" is Edmonton International', async () => {
  const { readFile } = await import('node:fs/promises');
  const pack = JSON.parse(
    await readFile(
      new URL('./local_data/ourairports/airports.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(pack.meta.count, pack.rows.length);
  const placeholders = pack.rows.filter(
    ([, iata, name, , , size, , , , runways]) =>
      isPlaceholderAirport({ name, iata, size, runways }),
  );
  assert.deepEqual(
    placeholders.map((row) => row[2]),
    [],
  );
  const index = indexAirports(pack.rows);
  assert.equal(findAirportIn(index, 'Edmonton airport')?.ident, 'CYEG');
  assert.equal(
    airportsWithin(index, 53.3097, -113.58, 2)[0]?.ident,
    'CYEG',
    'the nearest-airport link names the real airport',
  );
});

test('the build script leaves placeholder rows out', () => {
  const airports = parseCsv(
    [
      'ident,type,name,latitude_deg,longitude_deg,elevation_ft,iso_country,municipality,scheduled_service,iata_code',
      'CYEG,large_airport,Edmonton International Airport,53.3097,-113.58,2373,CA,Edmonton,yes,YEG',
      'CA-1291,large_airport,(Duplicate)YEG,53.3097,-113.58,2371,CA,Edmonton,no,',
      'CA-1292,large_airport,YEG,50.3417,-106.6992,2373,CA,Edmonton,no,',
      'AR-0768,medium_airport,[Duplicate] Aeropuerto Pergamino,-33.896,-60.5748,,AR,,no,',
      'UKON,medium_airport,Mykolaiv International Airport [CLOSED],47.0579,31.9198,184,UA,Mykolaiv,no,NLV',
      'ZZ-0001,medium_airport,Sas Al Nakheel Air Base,24.4413,54.517,14,AE,Sas Al Nakheel,no,',
    ].join('\n'),
  );
  const runways = parseCsv('airport_ident,closed\nCYEG,0\nCYEG,0\n');
  assert.deepEqual(
    airportRows(airports, runways).map((row) => row[0]),
    ['CYEG', 'ZZ-0001'],
    'a medium base with no IATA code and no runway on file is still an airport',
  );
});

// Airports named in a search, with the bundled pack: a city matches by its
// leading words ("Paris (Roissy-en-France, Val-d'Oise)" is Paris), and words
// inside a name count only near where the search landed.
test('"Paris airport" is the Paris airport where the search landed, and "York airport" is never New York’s', async () => {
  const { readFile } = await import('node:fs/promises');
  const { placeForSearch } = await import('../ui/placePick.js');
  const pack = JSON.parse(
    await readFile(
      new URL('./local_data/ourairports/airports.json', import.meta.url),
      'utf8',
    ),
  );
  const index = indexAirports(pack.rows);
  const atCdg = { lat: 49.0097, lon: 2.5479 };
  assert.equal(findAirportIn(index, 'Paris airport', atCdg)?.iata, 'CDG');
  const atYork = { lat: 53.959, lon: -1.08 };
  assert.notEqual(findAirportIn(index, 'York airport', atYork)?.iata, 'SWF');
  const lookUp = async (query, near) => findAirportIn(index, query, near);
  const paris = await placeForSearch(
    {
      query: 'Paris airport',
      label: 'Paris Charles de Gaulle Airport',
      ...atCdg,
    },
    { findAirport: lookUp },
  );
  assert.equal(paris?.identity.place.airport.iata, 'CDG');
  const york = await placeForSearch(
    { query: 'York airport', label: 'York Airport, England', ...atYork },
    { findAirport: lookUp },
  );
  assert.notEqual(york?.identity.place?.airport?.iata, 'SWF');
});

test('a Japanese, Chinese or Korean airport label opens the airport it landed at', async () => {
  const { readFile } = await import('node:fs/promises');
  const { rows } = JSON.parse(
    await readFile(
      new URL('./local_data/ourairports/airports.json', import.meta.url),
      'utf8',
    ),
  );
  const airports = indexAirports(rows);
  const find = (label, at) => findAirportIn(airports, label, at)?.ident ?? null;
  const haneda = { lat: 35.5523, lon: 139.7798 };
  assert.equal(find('羽田空港', haneda), 'RJTT');
  assert.equal(find('羽田机场', haneda), 'RJTT');
  assert.equal(find('羽田機場', haneda), 'RJTT');
  assert.equal(find('인천국제공항', { lat: 37.4602, lon: 126.4407 }), 'RKSI');
  assert.equal(find('羽田空港, 東京都', haneda), 'RJTT');
  assert.equal(find('羽田空港 第3ターミナル駅', haneda), null);
  assert.equal(find('羽田', haneda), null);
  assert.equal(namesAirport('羽田空港'), true);
  assert.equal(namesAirport('東京タワー'), false);
});
