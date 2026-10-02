// GPX reading: tracks, routes and waypoints become raw line and pin features.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpx } from './pathGpx.js';
import { PathImportError } from './pathXml.js';

const gpx = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

test('a track segment becomes one line in lon/lat order', () => {
  const features = parseGpx(
    gpx(`<trk><name>Ridge walk</name><trkseg>
      <trkpt lat="46.5" lon="8.1"><ele>2100</ele><time>2026-07-01T08:00:00Z</time></trkpt>
      <trkpt lat="46.6" lon="8.2"><ele>2200</ele></trkpt>
    </trkseg></trk>`),
  );
  assert.deepEqual(features, [
    {
      kind: 'line',
      name: 'Ridge walk',
      points: [
        [8.1, 46.5],
        [8.2, 46.6],
      ],
    },
  ]);
});

test('a paused track keeps its segments as separate, numbered lines', () => {
  const features = parseGpx(
    gpx(`<trk><name>Day 1</name>
      <trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg>
      <trkseg></trkseg>
      <trkseg><trkpt lat="5" lon="5"/><trkpt lat="6" lon="6"/></trkseg>
    </trk>`),
  );
  assert.deepEqual(
    features.map((feature) => [feature.name, feature.points.length]),
    [
      ['Day 1', 2],
      ['Day 1 (2)', 2],
    ],
  );
});

test('routes are lines and waypoints are pins', () => {
  const features = parseGpx(
    gpx(`<wpt lat="10" lon="20"><name>Hut</name></wpt>
      <rte><name>Plan</name><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte>`),
  );
  assert.deepEqual(features, [
    {
      kind: 'line',
      name: 'Plan',
      points: [
        [2, 1],
        [4, 3],
      ],
    },
    { kind: 'pin', name: 'Hut', points: [[20, 10]] },
  ]);
});

test('an unnamed feature has an empty name for the importer to fill', () => {
  const [feature] = parseGpx(
    gpx(
      '<trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk>',
    ),
  );
  assert.equal(feature.name, '');
});

test('a missing or non-numeric coordinate is NaN, never zero', () => {
  const [feature] = parseGpx(
    gpx(
      '<trk><trkseg><trkpt lat="1"/><trkpt lat="x" lon="2"/><trkpt lat="" lon="3"/></trkseg></trk>',
    ),
  );
  assert.ok(Number.isNaN(feature.points[0][0]));
  assert.ok(Number.isNaN(feature.points[1][1]));
  assert.ok(Number.isNaN(feature.points[2][1]));
});

test('a namespace-prefixed document is read the same way', () => {
  const features = parseGpx(
    '<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"><g:wpt lat="1" lon="2"><g:name>A</g:name></g:wpt></g:gpx>',
  );
  assert.deepEqual(features, [{ kind: 'pin', name: 'A', points: [[2, 1]] }]);
});

test('an empty GPX yields no features and a non-GPX document is refused', () => {
  assert.deepEqual(parseGpx(gpx('')), []);
  assert.throws(
    () => parseGpx('<kml><Document/></kml>'),
    (error) => error instanceof PathImportError && error.code === 'not-gpx',
  );
});
