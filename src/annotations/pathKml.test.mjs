// KML reading: placemark geometry becomes raw line, area and pin features.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinates, parseKml } from './pathKml.js';
import { PathImportError } from './pathXml.js';

const kml = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>${body}</Document></kml>`;

test('coordinates are lon,lat[,alt] tuples separated by any whitespace', () => {
  assert.deepEqual(parseCoordinates(' 8.1,46.5,2100\n8.2,46.6  8.3,46.7,0 '), [
    [8.1, 46.5],
    [8.2, 46.6],
    [8.3, 46.7],
  ]);
  assert.deepEqual(parseCoordinates(''), []);
  assert.ok(Number.isNaN(parseCoordinates('8.1')[0][1]));
});

test('a LineString placemark is a named line', () => {
  const features = parseKml(
    kml(`<Placemark><name>Trail</name><description>ignored</description>
      <LineString><tessellate>1</tessellate><coordinates>1,2,0 3,4,0</coordinates></LineString>
    </Placemark>`),
  );
  assert.deepEqual(features, [
    {
      kind: 'line',
      name: 'Trail',
      points: [
        [1, 2],
        [3, 4],
      ],
    },
  ]);
});

test('a Polygon is an area from its outer boundary only', () => {
  const [feature] = parseKml(
    kml(`<Placemark><name>Lake</name><Polygon>
      <outerBoundaryIs><LinearRing><coordinates>0,0 0,1 1,1 0,0</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>0.2,0.2 0.2,0.4 0.4,0.4 0.2,0.2</coordinates></LinearRing></innerBoundaryIs>
    </Polygon></Placemark>`),
  );
  assert.equal(feature.kind, 'area');
  assert.deepEqual(feature.points, [
    [0, 0],
    [0, 1],
    [1, 1],
    [0, 0],
  ]);
});

test('a Point is a pin', () => {
  assert.deepEqual(
    parseKml(
      kml(
        '<Placemark><name>Summit</name><Point><coordinates>7.5,45.9,4478</coordinates></Point></Placemark>',
      ),
    ),
    [{ kind: 'pin', name: 'Summit', points: [[7.5, 45.9]] }],
  );
});

test('a gx:Track is a line through its space-separated coords', () => {
  const [feature] = parseKml(
    kml(`<Placemark><name>Logged</name><gx:Track>
      <when>2026-07-01T08:00:00Z</when><gx:coord>8.1 46.5 2100</gx:coord>
      <when>2026-07-01T08:01:00Z</when><gx:coord>8.2 46.6 2110</gx:coord>
    </gx:Track></Placemark>`),
  );
  assert.deepEqual(feature, {
    kind: 'line',
    name: 'Logged',
    points: [
      [8.1, 46.5],
      [8.2, 46.6],
    ],
  });
});

test('MultiGeometry and gx:MultiTrack contribute every member under one name', () => {
  const features = parseKml(
    kml(`<Placemark><name>Mixed</name><MultiGeometry>
        <Point><coordinates>1,1</coordinates></Point>
        <LineString><coordinates>1,1 2,2</coordinates></LineString>
        <MultiGeometry><LineString><coordinates>3,3 4,4</coordinates></LineString></MultiGeometry>
      </MultiGeometry></Placemark>
      <Placemark><name>Two legs</name><gx:MultiTrack>
        <gx:Track><gx:coord>1 1 0</gx:coord><gx:coord>2 2 0</gx:coord></gx:Track>
        <gx:Track><gx:coord>5 5 0</gx:coord><gx:coord>6 6 0</gx:coord></gx:Track>
      </gx:MultiTrack></Placemark>`),
  );
  assert.deepEqual(
    features.map((feature) => [feature.kind, feature.name]),
    [
      ['pin', 'Mixed'],
      ['line', 'Mixed'],
      ['line', 'Mixed'],
      ['line', 'Two legs'],
      ['line', 'Two legs'],
    ],
  );
});

test('placemarks are found at any folder depth, in document order', () => {
  const features = parseKml(
    kml(`<Folder><name>Outer</name>
      <Placemark><name>A</name><Point><coordinates>1,1</coordinates></Point></Placemark>
      <Folder><Placemark><name>B</name><Point><coordinates>2,2</coordinates></Point></Placemark></Folder>
    </Folder>
    <Placemark><name>C</name><Point><coordinates>3,3</coordinates></Point></Placemark>`),
  );
  assert.deepEqual(
    features.map((feature) => feature.name),
    ['A', 'B', 'C'],
  );
});

test('a placemark with no geometry, or styling only, adds nothing', () => {
  assert.deepEqual(
    parseKml(
      kml(
        '<Style id="s"/><Placemark><name>Note</name><styleUrl>#s</styleUrl></Placemark>',
      ),
    ),
    [],
  );
});

test('a Polygon without an outer boundary yields an empty area for the validator', () => {
  const [feature] = parseKml(kml('<Placemark><Polygon/></Placemark>'));
  assert.deepEqual(feature, { kind: 'area', name: '', points: [] });
});

test('a non-KML document is refused', () => {
  assert.throws(
    () => parseKml('<gpx><wpt lat="1" lon="1"/></gpx>'),
    (error) => error instanceof PathImportError && error.code === 'not-kml',
  );
});
