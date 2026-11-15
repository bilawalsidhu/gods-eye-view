// GRID REFERENCES AND PLUS CODES — UTM, MGRS and full Open Location Codes read
// as coordinates. Each is exact or refused, like a decimal pair: a misread
// reference flies the operator somewhere else and looks like success.
//
// The UTM and MGRS points are one per latitude band (and the zone edges) from
// pyproj and the mgrs package; the plus codes are from the Open Location Code
// project's test data (decoding.csv, validityTests.csv).
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGridReference } from './gridReference.js';
import { parsePlusCode } from './plusCode.js';
import { parseCoordinateQuery } from './coordinateParser.js';

/** Metres between two points, near enough for sub-metre checks. */
function metres(a, b) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) *
      Math.cos(b.lat * r) *
      Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

// [MGRS, its latitude, its longitude, UTM, its latitude, its longitude]
const GRID = [
  [
    '18TWL8565011369',
    40.7488215,
    -73.9854319,
    '18T 585651 4511369',
    40.748817,
    -73.985428,
  ],
  [
    '56HLH3490052290',
    -33.8567842,
    151.2152996,
    '56H 334900 6252291',
    -33.856784,
    151.215297,
  ],
  [
    '33XWG1427883355',
    78.2232003,
    15.6266906,
    '33X 514279 8683355',
    78.2232,
    15.6267,
  ],
  [
    '32VKN9747700830',
    60.392994,
    5.3241531,
    '32V 297477 6700830',
    60.39299,
    5.32415,
  ],
  [
    '17MQV8185780012',
    -0.1806554,
    -78.4678355,
    '17M 781858 9980013',
    -0.180653,
    -78.467834,
  ],
  [
    '60KXF1292941202',
    -17.713404,
    178.0649977,
    '60K 612930 8041203',
    -17.7134,
    178.065,
  ],
  [
    '03WVM8047852917',
    64.5010996,
    -165.4064093,
    '3W 480479 7152918',
    64.5011,
    -165.4064,
  ],
  ['31NAA6603200011', 0.0001039, 9.92e-5, '31N 166033 11', 0.0001, 0.0001],
  [
    '01CDM4324728161',
    -79.8999987,
    -179.9000186,
    '1C 443248 1128161',
    -79.9,
    -179.9,
  ],
  [
    '19FEV4500027239',
    -54.7999989,
    -68.2999931,
    '19F 545000 3927239',
    -54.8,
    -68.3,
  ],
  [
    '54SUD1748374870',
    34.9999987,
    138.9999956,
    '54S 317484 3874871',
    35.0,
    139.0,
  ],
  ['30UXC9988909362', 51.500002, -0.1200043, '30U 699890 5709362', 51.5, -0.12],
  [
    '10JBR3890542412',
    -26.7152573,
    -125.6244681,
    '10J 238906 7042412',
    -26.7152593,
    -125.6244672,
  ],
  [
    '05RMK1662242662',
    26.6023189,
    -153.8374266,
    '5R 416623 2942663',
    26.6023191,
    -153.8374241,
  ],
  [
    '31DDC8763628944',
    -70.046176,
    2.6753849,
    '31D 487636 2228945',
    -70.0461753,
    2.6753768,
  ],
  [
    '50LNP6584960983',
    -10.3033721,
    117.601397,
    '50L 565849 8860983',
    -10.3033722,
    117.6013945,
  ],
  [
    '14EMV6706624140',
    -59.3202819,
    -99.5786192,
    '14E 467066 3424141',
    -59.3202803,
    -99.5786205,
  ],
  [
    '57QYF1413419747',
    22.7716198,
    161.0856759,
    '57Q 714135 2519747',
    22.7716153,
    161.0856775,
  ],
  [
    '24PXB9668711309',
    14.5677772,
    -37.1743636,
    '24P 696687 1611310',
    14.5677806,
    -37.1743652,
  ],
  [
    '30GTV9870806681',
    -41.4662188,
    -5.4104109,
    '30G 298709 5406682',
    -41.4662184,
    -5.4104096,
  ],
  [
    '60XWU3439017795',
    83.8999979,
    179.899971,
    '60X 534391 9317796',
    83.9,
    179.9,
  ],
  ['32VJH3227421798', 55.9999999, 3.1000066, '32V 132274 6221799', 56.0, 3.1],
  [
    '60RWP4163073757',
    25.9820077,
    177.4159163,
    '60R 541631 2873757',
    25.9820033,
    177.415919,
  ],
  [
    '60VWL2412126400',
    58.8767223,
    177.4183599,
    '60V 524121 6526400',
    58.876719,
    177.4183593,
  ],
  [
    '60UUD2978050375',
    52.7763309,
    174.4763915,
    '60U 329781 5850376',
    52.7763332,
    174.476393,
  ],
  [
    '32GKT8210286690',
    -42.5414587,
    6.3464153,
    '32G 282102 5286690',
    -42.5414631,
    6.346413,
  ],
];

test('MGRS and UTM references read to within a metre in every latitude band', () => {
  for (const [mgrs, mgrsLat, mgrsLon, utm, utmLat, utmLon] of GRID) {
    const fromMgrs = parseGridReference(mgrs);
    assert.ok(fromMgrs, mgrs);
    assert.ok(metres(fromMgrs, { lat: mgrsLat, lon: mgrsLon }) < 1, mgrs);
    const fromUtm = parseGridReference(utm);
    assert.ok(fromUtm, utm);
    assert.ok(metres(fromUtm, { lat: utmLat, lon: utmLon }) < 1, utm);
  }
});

test('MGRS reads spaced and unspaced, to 100 m or finer', () => {
  const times = { lat: 40.74882, lon: -73.98543 };
  for (const text of [
    '18TWL8565011369',
    '18T WL 8565011369',
    '18T WL 85650 11369',
    '18twl8565011369',
  ])
    assert.ok(metres(parseGridReference(text), times) < 1, text);
  // Coarser references name the centre of their square.
  assert.ok(metres(parseGridReference('18TWL856113'), times) < 71, '100 m');
  assert.ok(metres(parseGridReference('18T WL 856 113'), times) < 71, '100 m');
  assert.ok(metres(parseGridReference('18TWL85651136'), times) < 8, '10 m');
  // 1 km and 10 km squares, and a square alone, read too much ordinary text.
  for (const text of ['18TWL8511', '18T WL 85 11', '18TWL81', '18TWL'])
    assert.equal(parseGridReference(text), null, text);
});

test('MGRS squares across a zone edge, Norway and Svalbard', () => {
  // Paris, the Eiffel Tower.
  assert.ok(
    metres(parseGridReference('31U DQ 48251 11932'), {
      lat: 48.85819,
      lon: 2.29449,
    }) < 1,
  );
  // 32V is widened to 3°E–12°E, 33X to 9°E–21°E.
  assert.ok(parseGridReference('32V NM 12345 54321'));
  assert.ok(parseGridReference('33X VG 12345 67890'));
  // A square that lands outside its zone's longitudes.
  assert.equal(parseGridReference('18T SL 50000 50000'), null);
  // Squares touching the antimeridian, from either side.
  for (const text of ['1HBD1970044714', '60TYQ364873', '1QAC860142'])
    assert.ok(parseGridReference(text), text);
});

test('a UTM N is the northern hemisphere where band N does not fit', () => {
  const point = parseGridReference('33N 500000 4500000');
  assert.ok(
    Math.abs(point.lon - 15) < 1e-9 && point.lat > 40 && point.lat < 41,
  );
  // Within 0°–8°N it is band N, the same projection.
  assert.ok(parseGridReference('33N 500000 500000').lat < 5);
});

test('a UTM S is the 32°N–40°N band where it fits, else the southern hemisphere', () => {
  const tokyo = parseGridReference('54S 383000 3950000');
  assert.ok(
    tokyo.lat > 35 && tokyo.lat < 36 && tokyo.lon > 139 && tokyo.lon < 140,
  );
  const sydney = parseGridReference('56S 334900 6252291');
  assert.ok(metres(sydney, { lat: -33.856784, lon: 151.215297 }) < 1);
});

test('malformed grid references are refused', () => {
  for (const text of [
    '18TWL856501136', // odd digit count
    '18T WL 8565 11369', // easting and northing of different lengths
    '18IWL8565011369', // no band I
    '18TIL8565011369', // no column I
    '18TAL8565011369', // column A is not in zone 18's set
    '61T WL 85650 11369', // no zone 61
    '0T WL 85650 11369',
    '18Z WL 85650 11369', // polar bands are UPS, not UTM
    '18A 585651 4511369',
    '18T 58565 4511369', // a five-digit easting
    '18T 585651 4511369 extra',
    '18T WL 85650 11369 N',
    'WL 85650 11369',
    '18T',
    'ATL',
    // Ordinary text that spells a square in lower case.
    '1 jan',
    '7 feb',
    '3 usa',
    '1 jan 2023',
    '4 cat 12',
    '1the12',
    '60 jun 202311',
    '18t wl 85650 11369',
    // The same text in capitals, as dates and units are often written.
    '1 JAN 2023',
    '01 JAN 2023',
    '1JAN2023',
    '31 DEC 1999',
    '25 DEC 2025',
    '1 JAN 2023 1200',
    '15 SEP 2024 0630',
    '3 USA 12',
    '4 GAS 12',
    '33 UTC 12',
    '20 KPH 1000',
    // Zones Svalbard does not use.
    '32X 500000 8700000',
    '34X NG 12 34',
    '36XNG1234',
  ])
    assert.equal(parseGridReference(text), null, text);
});

// [code, latitude, longitude] of each code's centre.
const PLUS_CODES = [
  ['7FG49Q00+', 20.375, 2.775],
  ['7FG49QCJ+2V', 20.370062500000003, 2.7821875],
  ['7FG49QCJ+2VX', 20.3701125, 2.782234375],
  ['7FG49QCJ+2VXGJ', 20.370113500000002, 2.7822353515650002],
  ['CR4389W6+MV36X2V', 72.34663418, 141.3621622924805],
  ['4V44CC8J+XR', -47.5825625, 162.4320625],
  ['7G2394VR+3RXCXV', 10.392739899999999, 21.1421003417965],
  ['94GG6QPW+', 60.23625, -129.20375],
  ['CP9C0000+', 77.5, 108.5],
  ['549QX497+9X', -22.0315625, -124.8850625],
  ['979V23X2+V97C6Q', 57.0496617, -62.949092041015504],
  ['7G6MCJCM+58', 14.4204375, 33.6333125],
  ['7VHJGH8G+', 21.51625, 172.57625],
  ['423726P5+P72', -48.963237500000005, -174.791859375],
  ['2JH70000+', -78.5, 65.5],
  ['58P6PP00+', -15.275, -55.275],
  ['2Q3P6CPJ+Q3H7HQ7', -88.76306733999999, 134.430234069824],
  ['9R000000+', 60.0, 150.0],
  ['6FPW3600+', 4.074999999999999, 18.225],
  ['C55GR473+C5732', 73.8135255, -109.89708496093749],
  ['CV25MQ00+', 70.67500000000001, 163.775],
  ['4J86FVGW+9449', -43.5241175, 64.89533984375],
  ['8V2H837Q+44', 30.3128125, 171.08781249999998],
  ['C8C35800+', 78.17500000000001, -58.675],
  ['62M5653J+Q3', 3.2044375, -176.8198125],
  ['8H8VW72V+9GXV5', 36.9009955, 57.2938583984375],
];

test('full plus codes read to the centre of their area', () => {
  for (const [code, lat, lon] of PLUS_CODES) {
    const point = parsePlusCode(code);
    assert.ok(point, code);
    assert.ok(
      Math.abs(point.lat - lat) < 1e-9 && Math.abs(point.lon - lon) < 1e-9,
      code,
    );
  }
  assert.deepEqual(
    parsePlusCode(' 849vcwc8+r9 '),
    parsePlusCode('849VCWC8+R9'),
  );
});

// [code, isValid, isShort, isFull]
const VALIDITY = [
  ['8FWC2345+G6', 'true', 'false', 'true'],
  ['8FWC2345+G6G', 'true', 'false', 'true'],
  ['8fwc2345+', 'true', 'false', 'true'],
  ['8FWCX400+', 'true', 'false', 'true'],
  ['84000000+', 'true', 'false', 'true'],
  ['WC2345+G6g', 'true', 'true', 'false'],
  ['2345+G6', 'true', 'true', 'false'],
  ['45+G6', 'true', 'true', 'false'],
  ['+G6', 'true', 'true', 'false'],
  ['G+', 'false', 'false', 'false'],
  ['+', 'false', 'false', 'false'],
  ['8FWC2345+G', 'false', 'false', 'false'],
  ['8FWC2_45+G6', 'false', 'false', 'false'],
  ['8FWC2\u03b745+G6', 'false', 'false', 'false'],
  ['8FWC2345+G6+', 'false', 'false', 'false'],
  ['8FWC2345G6+', 'false', 'false', 'false'],
  ['8FWC2300+G6', 'false', 'false', 'false'],
  ['WC2300+G6g', 'false', 'false', 'false'],
  ['WC2345+G', 'false', 'false', 'false'],
  ['WC2300+', 'false', 'false', 'false'],
  ['84900000+', 'false', 'false', 'false'],
  ['849VGJQF+VX7QR3J', 'true', 'false', 'true'],
  ['849VGJQF+VX7QR3U', 'false', 'false', 'false'],
  ['849VGJQF+VX7QR3JW', 'true', 'false', 'true'],
  ['849VGJQF+VX7QR3JU', 'false', 'false', 'false'],
];

test('only valid full plus codes are read; short and invalid ones are refused', () => {
  for (const [code, , , isFull] of VALIDITY)
    assert.equal(parsePlusCode(code) !== null, isFull === 'true', code);
});

test('the search box reads degrees-minutes-seconds, grid references and plus codes', () => {
  const near = (query, lat, lon, within) => {
    const point = parseCoordinateQuery(query);
    assert.ok(point, query);
    assert.ok(metres(point, { lat, lon }) < within, query);
    assert.match(point.label, /° [NS], .*° [EW]$/, query);
  };
  near('40°26\'46"N, 79°58\'56"W', 40.446111, -79.982222, 1);
  near('40° 26′ 46″ N 79° 58′ 56″ W', 40.446111, -79.982222, 1);
  near("N 40°26.767' W 79°58.933'", 40.446117, -79.982217, 1);
  near('-33°51\'24", 151°12\'55"', -33.856667, 151.215278, 1);
  near('33UXP0500444998', 48.249493, 16.414495, 1);
  near('18T 585651 4511369', 40.748817, -73.985428, 1);
  near('849VCWC8+R9', 37.4220625, -122.0840625, 1);
  for (const query of [
    '40°26\'46"N', // one component
    '40°60\'0"N, 79°0\'0"W', // 60 minutes
    '40°26\'60"N, 79°0\'0"W', // 60 seconds
    '40°26.5\'46"N, 79°0\'0"W', // a decimal before the last number
    '-40°26\'46"N, 79°0\'0"W', // a sign and a letter
    'N 40°26\'46"N, 79°0\'0"W', // two letters
    '91°0\'0"N, 79°0\'0"W', // out of range
    '40°26\'46"N, 40°26\'46"S', // both latitude
    'CWC8+R9', // a short plus code needs a place
    'CWC8+R9 Mountain View',
  ])
    assert.equal(parseCoordinateQuery(query), null, query);
});
