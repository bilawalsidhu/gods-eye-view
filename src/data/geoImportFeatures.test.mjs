import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import {
  readGeoJsonFeatures,
  readKmlFeatures,
  rhumbPath,
} from './geoImportFeatures.js';

const { DOMParser } = new Window();

/** A KML document around `body`, parsed. */
const kml = (body) =>
  new DOMParser().parseFromString(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">' +
      `<Document>${body}</Document></kml>`,
    'application/xml',
  );

const point = (coordinates = '1,2,0', extra = '') =>
  `<Point>${extra}<coordinates>${coordinates}</coordinates></Point>`;

test('a placemark takes its last inline style over its shared one, property by property', () => {
  const { features } = readKmlFeatures(
    kml(`
      <Style id="shared">
        <IconStyle><scale>2</scale><color>ff0000ff</color>
          <Icon><href>data:image/png;base64,AAAA</href></Icon></IconStyle>
      </Style>
      <StyleMap id="map">
        <Pair><key>normal</key><styleUrl>#shared</styleUrl></Pair>
        <Pair><key>highlight</key><styleUrl>#other</styleUrl></Pair>
      </StyleMap>
      <Placemark><name>shared</name><styleUrl>#map</styleUrl>${point()}</Placemark>
      <Placemark><name>inline</name><styleUrl>#shared</styleUrl>
        <Style><IconStyle><color>ff00ff00</color></IconStyle></Style>
        <Style><IconStyle><scale>0.5</scale></IconStyle></Style>
        ${point()}</Placemark>
      <Placemark><name>none</name><Style><IconStyle><Icon/></IconStyle></Style>${point()}</Placemark>
      <Placemark><name>default</name>${point()}</Placemark>`),
  );
  const [shared, inline, none, fallback] = features;
  assert.equal(shared.image, 'data:image/png;base64,AAAA');
  assert.equal(shared.scale, 2);
  assert.deepEqual(shared.color, [1, 0, 0, 1], 'aabbggrr is red');
  // Only the last inline style counts; the shared one fills what it leaves.
  assert.equal(inline.scale, 0.5);
  assert.deepEqual(inline.color, [1, 0, 0, 1]);
  assert.equal(inline.image, 'data:image/png;base64,AAAA');
  assert.equal(none.image, null, 'an empty Icon draws no icon');
  assert.match(fallback.image.svg, /rgba\(255,255,0,1\)/, 'the yellow pin');
  for (const f of features) {
    assert.deepEqual(f.size, [32, 32]);
    assert.deepEqual(f.scaleByDistance, {
      near: 2414016,
      nearValue: 1,
      far: 1.6093e7,
      farValue: 0.1,
    });
    assert.equal(f.offsetScalesByDistance, true, 'its offset shrinks too');
  }
});

test('an icon hot spot and heading place and turn the icon', () => {
  const { features } = readKmlFeatures(
    kml(`
      <Placemark><Style><IconStyle><scale>0.8</scale><heading>90</heading>
        <hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/>
      </IconStyle></Style>${point()}</Placemark>
      <Placemark><Style><IconStyle><heading>0</heading>
        <hotSpot x="4" y="8" xunits="pixels" yunits="insetPixels"/>
      </IconStyle></Style>${point()}</Placemark>`),
  );
  // Standing on its bottom centre: up by half its 25.6 px height.
  assert.deepEqual(features[0].pixelOffset, { x: 0, y: -12.8 });
  assert.equal(features[0].course, 90);
  assert.deepEqual(features[1].pixelOffset, { x: 12, y: 8 });
  assert.equal(features[1].course, undefined, 'heading 0 is no heading');
});

test('points, paths and polygons keep their altitude modes', () => {
  const { features } = readKmlFeatures(
    kml(`
      <Style id="s"><LineStyle><color>ff00ffff</color><width>6</width></LineStyle>
        <PolyStyle><color>66ff0000</color></PolyStyle></Style>
      <Placemark>${point('1,2,30')}</Placemark>
      <Placemark>${point('1,2,30', '<altitudeMode>relativeToGround</altitudeMode>')}</Placemark>
      <Placemark>${point('1,2,30', '<altitudeMode>absolute</altitudeMode>')}</Placemark>
      <Placemark><styleUrl>#s</styleUrl><LineString><tessellate>1</tessellate>
        <coordinates>1,2 3,4</coordinates></LineString></Placemark>
      <Placemark><styleUrl>#s</styleUrl><LineString><tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode><coordinates>1,2,600 3,4,900</coordinates></LineString></Placemark>
      <Placemark><styleUrl>#s</styleUrl><LineString><extrude>1</extrude>
        <altitudeMode>relativeToGround</altitudeMode><coordinates>1,2,150 3,4,150</coordinates></LineString></Placemark>
      <Placemark><styleUrl>#s</styleUrl><Polygon><outerBoundaryIs><LinearRing>
        <coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs>
        <innerBoundaryIs><LinearRing><coordinates>0.1,0.1 0.2,0.1 0.2,0.2 0.1,0.1</coordinates></LinearRing></innerBoundaryIs>
      </Polygon></Placemark>
      <Placemark><Polygon><extrude>1</extrude><altitudeMode>absolute</altitudeMode>
        <outerBoundaryIs><LinearRing><coordinates>0,0,200 1,0,200 1,1,200 0,0,200</coordinates></LinearRing></outerBoundaryIs>
      </Polygon></Placemark>
      <Placemark><Style><PolyStyle><fill>0</fill><outline>0</outline></PolyStyle></Style>
        <Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`),
  );
  const [
    clamped,
    relative,
    absolute,
    draped,
    inAir,
    wall,
    ground,
    block,
    bare,
  ] = features;
  assert.deepEqual(
    [clamped.mode, relative.mode, absolute.mode],
    ['clamp', 'relative', 'absolute'],
  );
  assert.equal(relative.height, 30);
  assert.deepEqual(
    [draped.mode, draped.width, draped.color],
    ['draped', 6, [1, 1, 0, 1]],
  );
  assert.deepEqual([inAir.mode, inAir.coords[1]], ['3d', [3, 4, 900]]);
  assert.equal(wall.kind, 'wall');
  assert.deepEqual(wall.fill, [0, 0, 1, 0x66 / 255]);
  assert.deepEqual(wall.outline, [1, 1, 0, 1], 'outlined in its line colour');
  assert.equal(wall.outlineWidth, 6);
  assert.equal(ground.clamp, true);
  assert.equal(ground.rings.length, 2, 'with its hole');
  assert.deepEqual(ground.fill, [0, 0, 1, 0x66 / 255]);
  assert.equal(block.clamp, false);
  assert.equal(block.extrude, true);
  assert.deepEqual(block.fill, [1, 1, 1, 1], 'white by default');
  assert.deepEqual(block.outline, [1, 1, 1, 1]);
  assert.equal(bare.fill, null);
  assert.equal(bare.outline, null);
});

test('ground overlays are boxes turned by their rotation, or quads', () => {
  const { features, drawable } = readKmlFeatures(
    kml(`
      <GroundOverlay><name>box</name><Icon><href>blob:packed</href></Icon>
        <altitudeMode>absolute</altitudeMode><altitude>120</altitude>
        <LatLonBox><north>2</north><south>1</south><east>200</east><west>-10</west>
          <rotation>20</rotation></LatLonBox></GroundOverlay>
      <GroundOverlay><color>80ff0000</color>
        <gx:LatLonQuad><coordinates>0,0 1,0 1,1 0,1</coordinates></gx:LatLonQuad></GroundOverlay>`),
  );
  const [box, quad] = features;
  assert.equal(drawable, true);
  assert.deepEqual(box.rect, { west: -10, south: 1, east: -160, north: 2 });
  assert.ok(Math.abs(box.rotation - (20 * Math.PI) / 180) < 1e-12);
  assert.equal(box.image, 'blob:packed');
  assert.equal(box.color, undefined, 'an image is drawn untinted');
  assert.equal(box.height, 120);
  assert.equal(quad.quad.length, 4);
  assert.deepEqual(quad.color, [0, 0, 1, 128 / 255]);
  assert.equal(quad.height, undefined, 'on the ground');
});

test('map objects are counted as before: folders, placemarks and each part', () => {
  const read = readKmlFeatures(
    kml(`
      <Folder><name>f</name>
        <Placemark><MultiGeometry>${point()}<LineString><coordinates>1,2 3,4</coordinates></LineString>
          <MultiGeometry>${point()}</MultiGeometry></MultiGeometry></Placemark>
        <Placemark><name>only the first geometry</name>${point()}${point('5,6')}</Placemark>
      </Folder>
      <Placemark><name>nowhere</name></Placemark>`),
  );
  // Folder, two placemarks and the empty one, three parts and one nested.
  assert.equal(read.entityCount, 8);
  assert.deepEqual(
    read.features.map((f) => f.kind),
    ['pin', 'line', 'pin', 'pin'],
  );
  assert.deepEqual([read.features[3].lon, read.features[3].lat], [1, 2]);
  assert.equal(read.drawable, true);
  assert.equal(
    readKmlFeatures(
      kml(
        '<Placemark><Style><IconStyle><Icon/></IconStyle></Style></Placemark>',
      ),
    ).drawable,
    false,
    'a placemark with no icon and nowhere to stand draws nothing',
  );
});

test('GeoJSON draws in one colour: pins on the ground, draped lines, quarter fills', () => {
  const read = readGeoJsonFeatures(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'a' },
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
        },
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
        },
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
              [
                [
                  [2, 2],
                  [3, 2],
                  [3, 3],
                  [2, 2],
                ],
              ],
            ],
          },
        },
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'GeometryCollection',
            geometries: [{ type: 'Point', coordinates: [5, 6] }],
          },
        },
        { type: 'Feature', properties: {}, geometry: null },
      ],
    },
    '#39d0ff',
  );
  assert.equal(read.entityCount, 7);
  const [a, b, line, p1, p2, gc] = read.features;
  assert.equal(a.name, 'a');
  assert.deepEqual([a.mode, a.anchor, a.size], ['clamp', 'bottom', [48, 48]]);
  assert.equal(a.image, b.image, 'one pin image for the file');
  assert.deepEqual([line.mode, line.width], ['draped', 3]);
  assert.deepEqual(line.color, [0x39 / 255, 0xd0 / 255, 1, 1]);
  assert.deepEqual(p1.fill, [0x39 / 255, 0xd0 / 255, 1, 0.25]);
  assert.equal(p1.outline, null);
  assert.equal(p2.clamp, true);
  assert.equal(gc.kind, 'pin');
  assert.equal(read.drawable, true);
});

test('a ground overlay without bounds, or upside down, draws nowhere', () => {
  const { features, drawable } = readKmlFeatures(
    kml(`
      <GroundOverlay><color>ff00ff00</color></GroundOverlay>
      <GroundOverlay><color>ff00ff00</color>
        <LatLonBox><north>1</north><south>2</south><east>3</east><west>4</west></LatLonBox></GroundOverlay>`),
  );
  assert.deepEqual(
    features.map((f) => [f.kind, f.rect, f.quad]),
    [
      ['overlay', null, undefined],
      ['overlay', null, undefined],
    ],
  );
  assert.equal(drawable, true, 'counted as before');
});

test('a hot spot without units is a fraction', () => {
  const { features } = readKmlFeatures(
    kml(
      `<Placemark><Style><IconStyle><hotSpot x="0.5" y="0"/></IconStyle></Style>${point()}</Placemark>`,
    ),
  );
  assert.deepEqual(features[0].pixelOffset, { x: 0, y: -16 });
});

test('GeoJSON lines and rings follow rhumb lines, as they were drawn', () => {
  const path = rhumbPath([
    [0, 60, 0],
    [10, 60, 0],
  ]);
  assert.equal(path.length, 21, 'half a degree apart');
  assert.ok(
    path.every(([, lat]) => Math.abs(lat - 60) < 1e-9),
    'along the parallel',
  );
  const across = rhumbPath([
    [179, 0, 0],
    [-179, 0, 0],
  ]);
  assert.deepEqual(
    across.map(([lon]) => lon),
    [179, 179.5, 180, -179.5, -179],
    'the short way over the antimeridian',
  );
  const short = rhumbPath([
    [0, 0, 0],
    [0.2, 0.2, 0],
  ]);
  assert.equal(short.length, 2, 'short steps are left alone');
  const { features } = readGeoJsonFeatures(
    {
      type: 'LineString',
      coordinates: [
        [0, 60],
        [10, 60],
      ],
    },
    '#39d0ff',
  );
  assert.equal(features[0].coords.length, 21);
});

test('rhumb steps stop once a file has added as many points as it may hold', () => {
  const budget = { left: 30 };
  const zigzag = Array.from({ length: 6 }, (_, i) => [i % 2 ? 10 : 0, 0, 0]);
  const path = rhumbPath(zigzag, budget);
  // Each 10-degree step adds 19 points: one fits, the rest are drawn as given.
  assert.equal(path.length, 6 + 19);
  assert.equal(budget.left, 11);
});
