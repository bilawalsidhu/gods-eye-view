import test from 'node:test';
import assert from 'node:assert/strict';
import { propagate } from 'satellite.js';
import {
  elementsCatalogNumber,
  elementsLaunchYear,
  parseOrbitalElements,
  satrecFromElements,
} from './orbitalElements.js';

const ISS_OMM = {
  OBJECT_NAME: 'ISS (ZARYA)',
  OBJECT_ID: '1998-067A',
  EPOCH: '2026-10-16T18:57:11.728512',
  MEAN_MOTION: 15.48899044,
  ECCENTRICITY: 0.00067481,
  INCLINATION: 51.6326,
  RA_OF_ASC_NODE: 58.3278,
  ARG_OF_PERICENTER: 271.9059,
  MEAN_ANOMALY: 88.1156,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 59060,
  BSTAR: 0.0001501181,
  MEAN_MOTION_DOT: 0.00007803,
  MEAN_MOTION_DDOT: 0,
};
// Docked to the ISS, so it shares the station's elements; CelesTrak serves
// it as OMM only.
const DRAGON_OMM = {
  ...ISS_OMM,
  OBJECT_NAME: 'DRAGON CRS-35',
  OBJECT_ID: '2026-233A',
  NORAD_CAT_ID: 101031,
  REV_AT_EPOCH: 32,
};
const ISS_TLE = [
  'ISS (ZARYA)             ',
  '1 25544U 98067A   26289.78971908  .00007803  00000+0  15012-3 0  9995',
  '2 25544  51.6326  58.3278 0006748 271.9059  88.1156 15.48899044590607',
].join('\n');

test('OMM JSON keeps six-digit catalog numbers that TLE cannot carry', () => {
  const entries = parseOrbitalElements(JSON.stringify([ISS_OMM, DRAGON_OMM]));
  assert.deepEqual(
    entries.map((entry) => [entry.name, elementsCatalogNumber(entry)]),
    [
      ['ISS (ZARYA)', 25544],
      ['DRAGON CRS-35', 101031],
    ],
  );
  const satrec = satrecFromElements(entries[1]);
  assert.equal(satrec.error, 0);
  assert.equal(Number(satrec.satnum), 101031);
  assert.deepEqual(entries.map(elementsLaunchYear), [1998, 2026]);
});

test('OMM and TLE for the same element set propagate to the same position', () => {
  const [omm] = parseOrbitalElements(JSON.stringify([ISS_OMM]));
  const [tle] = parseOrbitalElements(ISS_TLE);
  assert.equal(elementsCatalogNumber(tle), 25544);
  assert.equal(elementsLaunchYear(tle), 1998);
  const at = new Date('2026-10-17T00:00:00Z');
  const a = propagate(satrecFromElements(omm), at).position;
  const b = propagate(satrecFromElements(tle), at).position;
  // OMM epochs carry more precision than TLE; the difference stays at metres.
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.05);
});

test('malformed OMM records are skipped and error bodies parse to nothing', () => {
  const { EPOCH, ...noEpoch } = ISS_OMM;
  const entries = parseOrbitalElements(
    JSON.stringify([
      null,
      noEpoch,
      { ...ISS_OMM, NORAD_CAT_ID: '25544' },
      DRAGON_OMM,
    ]),
  );
  assert.deepEqual(entries.map(elementsCatalogNumber), [101031]);
  assert.deepEqual(parseOrbitalElements('[{"NORAD_CAT_ID": 1'), []);
  assert.deepEqual(parseOrbitalElements('{"error": "throttled"}'), []);
  assert.deepEqual(parseOrbitalElements('<html>503</html>'), []);
  assert.deepEqual(parseOrbitalElements(''), []);
});
