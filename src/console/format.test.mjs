import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACEHOLDER,
  compassPoint,
  formatAge,
  formatBearing,
  formatCount,
  formatElevation,
  formatGridReference,
  formatLatitude,
  formatLongitude,
  formatPitch,
  formatUtcDate,
  formatUtcTime,
  normalizeBearing,
  titleizeIdentifier,
} from './format.js';

test('coordinates read with a hemisphere and refuse impossible values', () => {
  assert.equal(formatLatitude(37.7749), '37.7749°N');
  assert.equal(formatLatitude(-33.8688, 2), '33.87°S');
  assert.equal(formatLongitude(139.6917), '139.6917°E');
  assert.equal(formatLongitude(-122.4194), '122.4194°W');
  // Out of range is a telemetry fault, not a coordinate to render.
  for (const value of [91, -90.1, Number.NaN, undefined, 'north'])
    assert.equal(formatLatitude(value), PLACEHOLDER);
  for (const value of [181, -180.5, Number.POSITIVE_INFINITY, null])
    assert.equal(formatLongitude(value), PLACEHOLDER);
});

test('elevation switches unit with the altitude band', () => {
  assert.equal(formatElevation(0), '0 m');
  assert.equal(formatElevation(842.4), '842 m');
  assert.equal(formatElevation(12_500), '12.5 km');
  assert.equal(formatElevation(25_000_000), '25.00 Mm');
  assert.equal(formatElevation(Number.NaN), PLACEHOLDER);
});

test('bearings fold into one turn and keep a fixed column width', () => {
  assert.equal(normalizeBearing(-90), 270);
  assert.equal(normalizeBearing(725), 5);
  assert.equal(normalizeBearing('north'), null);
  assert.equal(formatBearing(7), '007°');
  assert.equal(formatBearing(-90), '270°');
  // 359.6 rounds to a full turn, which reads as north rather than 360.
  assert.equal(formatBearing(359.6), '000°');
  assert.equal(formatBearing(undefined), PLACEHOLDER);
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(226), 'SW');
  assert.equal(compassPoint(359), 'N');
});

test('pitch is signed so a downward look is unambiguous', () => {
  assert.equal(formatPitch(-42.3), '-42°');
  assert.equal(formatPitch(12.6), '+13°');
  assert.equal(formatPitch(0), '0°');
  assert.equal(formatPitch(null), PLACEHOLDER);
});

test('grid references are spaced, and undefined outside the UTM bands', () => {
  const project = () => '18SUJ23370716';
  assert.equal(formatGridReference(38.8895, -77.0353, project), '18S UJ 2337 0716');
  // Outside the UTM bands the projection is undefined, so it is never asked.
  let asked = 0;
  const counting = () => {
    asked += 1;
    return '18SUJ23370716';
  };
  assert.equal(formatGridReference(89.9, 0, counting), PLACEHOLDER);
  assert.equal(formatGridReference(-85, 10, counting), PLACEHOLDER);
  assert.equal(formatGridReference(Number.NaN, 0, counting), PLACEHOLDER);
  assert.equal(asked, 0);
  // A projector that throws or answers with something unexpected degrades the
  // readout rather than the frame.
  assert.equal(
    formatGridReference(38.9, -77, () => {
      throw new Error('out of range');
    }),
    PLACEHOLDER,
  );
  assert.equal(formatGridReference(38.9, -77, () => ''), PLACEHOLDER);
  assert.equal(formatGridReference(38.9, -77, () => 'unparsed'), 'unparsed');
  assert.equal(formatGridReference(38.9, -77, undefined), PLACEHOLDER);
});

test('counts abbreviate without losing the small numbers', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1K');
  assert.equal(formatCount(12_400), '12.4K');
  assert.equal(formatCount(3_200_000), '3.2M');
  assert.equal(formatCount(undefined), PLACEHOLDER);
});

test('ages collapse to one coarse unit', () => {
  assert.equal(formatAge(4200), '4s');
  assert.equal(formatAge(90_000), '2m');
  assert.equal(formatAge(7_200_000), '2h');
  assert.equal(formatAge(172_800_000), '2d');
  assert.equal(formatAge(-1), PLACEHOLDER);
});

test('the clock is UTC and survives an invalid date', () => {
  const moment = new Date(Date.UTC(2026, 8, 20, 4, 7, 9));
  assert.equal(formatUtcTime(moment), '04:07:09');
  assert.equal(formatUtcDate(moment), '2026-09-20 UTC');
  assert.equal(formatUtcTime(new Date('nope')), '--:--:--');
  assert.equal(formatUtcDate(new Date('nope')), 'UTC');
});

test('identifiers fall back to a readable title', () => {
  assert.equal(titleizeIdentifier('ais-live-vessels'), 'Ais Live Vessels');
  assert.equal(titleizeIdentifier('local_datacenters'), 'Local Datacenters');
  assert.equal(titleizeIdentifier(''), '');
});
