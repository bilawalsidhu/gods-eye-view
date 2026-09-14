import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLikelyNdbc, mmOrNull, parseNdbcLatestObs, parseActiveStationsXml } from './ndbcText.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ndbc-latest-obs-sample.txt'),
  'utf8',
);

const HEADER_LINES =
  '#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE\n' +
  '#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft\n';

test('mmOrNull maps the NDBC missing sentinel to null and numbers to numbers', () => {
  assert.equal(mmOrNull('MM'), null);
  assert.equal(mmOrNull(''), null);
  assert.equal(mmOrNull('7.7'), 7.7);
  assert.equal(mmOrNull('-118.314'), -118.314);
  assert.equal(mmOrNull('bogus'), null);
});

test('parseNdbcLatestObs parses every complete fixture row with exact first-row values', () => {
  const records = parseNdbcLatestObs(FIXTURE);
  assert.ok(Array.isArray(records));
  assert.equal(records.length, 184);

  const first = records[0];
  assert.equal(first.stationId, '14049');
  assert.equal(typeof first.stationId, 'string');
  assert.equal(first.lat, -12);
  assert.equal(first.lon, 65);
  assert.equal(first.timeMs, Date.UTC(2026, 7, 29, 1, 0));
  assert.equal(first.windDirDeg, 153);
  assert.equal(first.windSpeedMs, 7.7);
  assert.equal(first.gustMs, 9.5);
  assert.equal(first.waveHeightM, null);
  assert.equal(first.dominantPeriodS, null);
  assert.equal(first.avgPeriodS, null);
  assert.equal(first.waveDirDeg, null);
  assert.equal(first.pressureHpa, 1016.2);
  assert.equal(first.pressureTendencyHpa, null);
  assert.equal(first.airTempC, 14.4);
  assert.equal(first.sstC, 26.6);
  assert.equal(first.dewPointC, null);
  assert.equal(first.visibilityNmi, null);
  assert.equal(first.tideFt, null);
});

test('parseNdbcLatestObs handles a sparse wave-only station (46222, Catalina area)', () => {
  const records = parseNdbcLatestObs(FIXTURE);
  const rec = records.find((r) => r.stationId === '46222');
  assert.ok(rec, 'fixture must contain station 46222');
  assert.equal(rec.lat, 33.614);
  assert.equal(rec.lon, -118.314);
  assert.equal(rec.timeMs, Date.UTC(2026, 7, 29, 2, 56));
  assert.equal(rec.waveHeightM, 0.8);
  assert.equal(rec.dominantPeriodS, 8);
  assert.equal(rec.avgPeriodS, 5.5);
  assert.equal(rec.waveDirDeg, 215);
  assert.equal(rec.sstC, 24.5);
  assert.equal(rec.windDirDeg, null);
  assert.equal(rec.windSpeedMs, null);
  assert.equal(rec.gustMs, null);
  assert.equal(rec.pressureHpa, null);
});

test('parsed records are JSON-safe: null, never NaN, and survive a round trip', () => {
  const records = parseNdbcLatestObs(FIXTURE);
  for (const rec of records) {
    for (const [key, value] of Object.entries(rec)) {
      assert.ok(!Number.isNaN(value), `${rec.stationId}.${key} must not be NaN`);
    }
  }
  const roundTrip = JSON.parse(JSON.stringify(records));
  assert.deepEqual(roundTrip, records);
});

test('parseNdbcLatestObs returns null for HTML and non-NDBC payloads (broken feed)', () => {
  assert.equal(parseNdbcLatestObs('<html><body>503 upstream error</body></html>'), null);
  assert.equal(parseNdbcLatestObs(''), null);
  assert.equal(parseNdbcLatestObs('not,a,ndbc,file\n1,2,3,4\n'), null);
});

test('parseNdbcLatestObs rejects a units row that is not metric m/s', () => {
  const knotsHeader = HEADER_LINES.replace(' m/s   m/s ', '  kt    kt  ');
  const row = '46222    33.614 -118.314 2026 08 29 02 56  MM   5.0    MM  0.8   8 5.5 215     MM    MM    MM  24.5    MM   MM     MM\n';
  assert.equal(parseNdbcLatestObs(knotsHeader + row), null);
});

test('parseNdbcLatestObs returns [] for a header-only payload (feed genuinely empty)', () => {
  assert.deepEqual(parseNdbcLatestObs(HEADER_LINES), []);
});

test('parseNdbcLatestObs resolves columns by header name, not position', () => {
  const swapped =
    '#STN       LAT      LON  YYYY MM DD hh mm WVHT WDIR WSPD   GST  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE\n' +
    '#text      deg      deg   yr mo day hr mn   m  degT  m/s   m/s  sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft\n' +
    '46222    33.614 -118.314 2026 08 29 02 56  0.8  180   5.0   7.0   8 5.5 215     MM    MM    MM  24.5    MM   MM     MM\n';
  const records = parseNdbcLatestObs(swapped);
  assert.equal(records.length, 1);
  assert.equal(records[0].waveHeightM, 0.8);
  assert.equal(records[0].windDirDeg, 180);
  assert.equal(records[0].windSpeedMs, 5);
  assert.equal(records[0].gustMs, 7);
});

test('parseNdbcLatestObs drops rows with unparseable station, position, or time', () => {
  const rows =
    'MM       33.614 -118.314 2026 08 29 02 56  MM    MM    MM  0.8   8 5.5 215     MM    MM    MM  24.5    MM   MM     MM\n' +
    '46222        MM -118.314 2026 08 29 02 56  MM    MM    MM  0.8   8 5.5 215     MM    MM    MM  24.5    MM   MM     MM\n' +
    '46223    33.614 -118.314 2026 MM 29 02 56  MM    MM    MM  0.8   8 5.5 215     MM    MM    MM  24.5    MM   MM     MM\n' +
    '46224    33.178 -117.472 2026 08 29 02 26  MM    MM    MM  1.0  20 8.3 198     MM    MM    MM  25.7    MM   MM     MM\n' +
    '46225    32.933\n';
  const records = parseNdbcLatestObs(HEADER_LINES + rows);
  assert.equal(records.length, 1);
  assert.equal(records[0].stationId, '46224');
});

test('isLikelyNdbc gates on the #STN header and metric units row', () => {
  assert.equal(isLikelyNdbc(FIXTURE), true);
  assert.equal(isLikelyNdbc('<html></html>'), false);
  assert.equal(isLikelyNdbc(''), false);
});

test('parseActiveStationsXml extracts id, position, name, type, and capability flags', () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<stations count="2">\n' +
    '<station id="46222" lat="33.614" lon="-118.314" elev="0" name="San Pedro, CA" ' +
    'owner="CDIP" pgm="IOOS Partners" type="buoy" met="n" currents="n" waterquality="n" dart="n"/>\n' +
    '<station id="AAMC1" lat="37.772" lon="-122.3" name="Alameda &amp; Oakland" type="fixed" met="y" currents="n" waterquality="n" dart="n"/>\n' +
    '</stations>\n';
  const stations = parseActiveStationsXml(xml);
  assert.ok(stations instanceof Map);
  assert.equal(stations.size, 2);
  const buoy = stations.get('46222');
  assert.deepEqual(buoy, {
    id: '46222', lat: 33.614, lon: -118.314, name: 'San Pedro, CA', type: 'buoy', met: false, currents: false,
  });
  const fixed = stations.get('AAMC1');
  assert.equal(fixed.name, 'Alameda & Oakland');
  assert.equal(fixed.type, 'fixed');
  assert.equal(fixed.met, true);
});

test('parseActiveStationsXml returns an empty Map on garbage (enrichment is non-fatal)', () => {
  const stations = parseActiveStationsXml('<html>not stations</html>');
  assert.ok(stations instanceof Map);
  assert.equal(stations.size, 0);
});
