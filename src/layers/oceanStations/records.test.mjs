import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNdbcLatestObs, normalizeOceanStationSnapshot } from './records.js';

const SAMPLE_NDBC_TEXT = `#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE
#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft
15009     0.000   -3.051 2026 10 14 00 00 193   5.8    MM   MM  MM   MM  MM 1013.3    MM  26.0  26.5    MM   MM     MM
41002    31.759  -74.836 2026 10 14 01 50  90   8.0  10.0  2.1   8  6.5  95 1018.5  +1.2  22.4  24.1  18.0  10.0     MM
INVALID   999.0   999.0  2026 10 14 01 00  MM    MM    MM   MM  MM   MM  MM     MM    MM    MM    MM    MM   MM     MM
41002    31.759  -74.836 2026 10 14 01 50  90   8.0  10.0  2.1   8  6.5  95 1018.5  +1.2  22.4  24.1  18.0  10.0     MM
`;

test('parseNdbcLatestObs parses valid stations and converts MM to null', () => {
  const records = parseNdbcLatestObs(SAMPLE_NDBC_TEXT);
  assert.ok(Array.isArray(records));
  assert.equal(records.length, 2, 'skips invalid coords and deduplicates duplicate station id');

  const stn1 = records.find((r) => r.id === '15009');
  assert.ok(stn1);
  assert.equal(stn1.lat, 0);
  assert.equal(stn1.lon, -3.051);
  assert.equal(stn1.windDirDeg, 193);
  assert.equal(stn1.windSpeedMps, 5.8);
  assert.equal(stn1.windGustMps, null);
  assert.equal(stn1.waveHeightM, null);
  assert.equal(stn1.pressureHpa, 1013.3);
  assert.equal(stn1.airTempC, 26.0);
  assert.equal(stn1.waterTempC, 26.5);
  assert.equal(stn1.timeIso, '2026-10-14T00:00:00.000Z');

  const stn2 = records.find((r) => r.id === '41002');
  assert.ok(stn2);
  assert.equal(stn2.lat, 31.759);
  assert.equal(stn2.lon, -74.836);
  assert.equal(stn2.windDirDeg, 90);
  assert.equal(stn2.windSpeedMps, 8.0);
  assert.equal(stn2.windGustMps, 10.0);
  assert.equal(stn2.waveHeightM, 2.1);
  assert.equal(stn2.wavePeriodSec, 8);
  assert.equal(stn2.avgWavePeriodSec, 6.5);
  assert.equal(stn2.waveDirDeg, 95);
  assert.equal(stn2.pressureHpa, 1018.5);
  assert.equal(stn2.pressureTendencyHpa, 1.2);
  assert.equal(stn2.airTempC, 22.4);
  assert.equal(stn2.waterTempC, 24.1);
  assert.equal(stn2.dewpointC, 18.0);
  assert.equal(stn2.visibilityNmi, 10.0);
  assert.equal(stn2.tideFt, null);
});

test('parseNdbcLatestObs returns null for invalid input or non-header text', () => {
  assert.equal(parseNdbcLatestObs(null), null);
  assert.equal(parseNdbcLatestObs(''), null);
  assert.equal(parseNdbcLatestObs('hello world'), null);
  assert.equal(parseNdbcLatestObs('line1\nline2'), null);
});

test('normalizeOceanStationSnapshot validates parsed stations payload', () => {
  const input = {
    stations: [
      { id: 'STN-1', lat: 10.5, lon: -20.2, waveHeightM: 1.5, waterTempC: 22.0 },
      { id: 'BAD-LAT', lat: 100, lon: 0 },
      { id: 'STN-1', lat: 10.5, lon: -20.2 },
    ],
  };
  const result = normalizeOceanStationSnapshot(input);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'STN-1');
  assert.equal(result[0].waveHeightM, 1.5);
  assert.equal(result[0].waterTempC, 22.0);
});
