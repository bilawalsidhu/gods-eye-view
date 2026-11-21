import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INPE_10MIN_URL,
  inpeSatellite,
  parseInpeCsv,
  parseInpeListing,
} from './inpeQueimadasCsv.js';
import { satelliteShortName } from './firmsLabels.js';

// Header and rows as served on 2026-10-29.
const CSV = [
  'lat,lon,satelite,data',
  '  -5.599180, -39.971750,AQUA_M-T,2026-10-29 18:47:00',
  '-16.687000,-49.264800,NOAA-20,2026-10-29 17:05:00',
  '',
].join('\n');

test('a 10-minute file parses into firmsCsv-shaped records with unknown FRP and confidence', () => {
  const records = parseInpeCsv(CSV);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    lat: -5.59918,
    lon: -39.97175,
    frp: null,
    confidence: null,
    brightness: null,
    brightnessTi5: null,
    daynight: '',
    acqDate: '2026-10-29',
    acqTime: '1847',
    satellite: 'Aqua',
    instrument: 'MODIS',
    provider: 'inpe',
  });
  assert.equal(records[1].satellite, 'N20');
  assert.equal(records[1].instrument, 'VIIRS');
});

test('a header-only file is no fires, and anything else is not an INPE file', () => {
  assert.deepEqual(parseInpeCsv('lat,lon,satelite,data\n'), []);
  assert.equal(parseInpeCsv('<html><body>404</body></html>'), null);
  assert.equal(
    parseInpeCsv('latitude,longitude,acq_date,acq_time\n1,2,3,4'),
    null,
  );
  assert.equal(parseInpeCsv(''), null);
  assert.equal(parseInpeCsv(undefined), null);
});

test('rows without a usable position or pass time are skipped, never read as zero', () => {
  const records = parseInpeCsv(
    [
      'lat,lon,satelite,data',
      ',-49.2,NOAA-20,2026-10-29 17:05:00',
      '-16.6,,NOAA-20,2026-10-29 17:05:00',
      '-95,-49.2,NOAA-20,2026-10-29 17:05:00',
      '-16.6,-49.2,NOAA-20,yesterday',
      '-16.6,-49.2,NOAA-20',
      '-16.6,-49.2,NOAA-20,2026-10-29 17:05:00',
    ].join('\n'),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].lat, -16.6);
});

test('every satellite seen on 2026-10-29 maps to a short name the card can show', () => {
  const seen = {
    'NOAA-20': ['N20', 'VIIRS', 'N20'],
    'NOAA-21': ['N21', 'VIIRS', 'N21'],
    'NPP-375': ['N', 'VIIRS', 'SNPP'],
    'NPP-375D': ['N', 'VIIRS', 'SNPP'],
    'AQUA_M-T': ['Aqua', 'MODIS', 'AQUA'],
    'AQUA_M-M': ['Aqua', 'MODIS', 'AQUA'],
    'TERRA_M-T': ['Terra', 'MODIS', 'TERRA'],
    'TERRA_M-M': ['Terra', 'MODIS', 'TERRA'],
    'GOES-19': ['G19', 'ABI', 'G19'],
    'MSG-03': ['MSG3', 'SEVIRI', 'MSG3'],
    'METOP-B': ['MetOpB', 'AVHRR', 'METOPB'],
    'METOP-C': ['MetOpC', 'AVHRR', 'METOPC'],
  };
  for (const [name, [satellite, instrument, short]] of Object.entries(seen)) {
    assert.deepEqual(inpeSatellite(name), { satellite, instrument }, name);
    assert.equal(satelliteShortName(satellite), short, `${name} on a card`);
  }
  // A satellite INPE adds later keeps its own name rather than vanishing.
  assert.deepEqual(inpeSatellite('SENTINEL-3A'), {
    satellite: 'SENTINEL-3A',
    instrument: '',
  });
});

test('the directory listing yields each file once, oldest first, timed in UTC', () => {
  const html = [
    '<a href="focos_10min_20261029_2010.csv">focos_10min_20261029_2010.csv</a>',
    '<a href="focos_10min_20261026_0000.csv">focos_10min_20261026_0000.csv</a>',
    '<a href="?C=M;O=A">Last modified</a>',
  ].join('\n');
  assert.deepEqual(parseInpeListing(html), [
    { name: 'focos_10min_20261026_0000.csv', at: Date.UTC(2026, 9, 26, 0, 0) },
    {
      name: 'focos_10min_20261029_2010.csv',
      at: Date.UTC(2026, 9, 29, 20, 10),
    },
  ]);
  assert.deepEqual(parseInpeListing(null), []);
  assert.match(
    INPE_10MIN_URL,
    /^https:\/\/dataserver-coids\.inpe\.br\/.+\/10min\/$/,
  );
});
