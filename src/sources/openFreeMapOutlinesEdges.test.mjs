// Tile fragments, holes and street extents for the OpenFreeMap outline rungs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildingFromTiles,
  decodeOpenFreeMapOutlineTile,
  enclosingAreaFromTiles,
  groundsClassesFor,
  streetFromTiles,
} from './openFreeMapOutlines.js';

const TILE = decodeOpenFreeMapOutlineTile(
  readFileSync(
    new URL(
      '../data/fixtures/ofm-outlines-austin-14-3743-6745.pbf',
      import.meta.url,
    ),
  ),
  14,
  3743,
  6745,
);
const CAPITOL = { lat: 30.27472, lon: -97.74035 };

const square = (lon, lat, d) => [
  [lon, lat],
  [lon + d, lat],
  [lon + d, lat + d],
  [lon, lat + d],
  [lon, lat],
];

test('decoded polygons keep identity and mark tile-cut fragments', () => {
  assert.ok(
    TILE.buildings.every((b) => b.tile === '14/3743/6745' && 'id' in b),
  );
  assert.ok(
    TILE.buildings.some((b) => b.clipped),
    'fragments at the cut line are marked',
  );
  assert.ok(
    buildingFromTiles([TILE], CAPITOL)?.contains,
    'the Capitol is complete',
  );
  const parts = [
    [square(0, 0, 0.001), square(0.0002, 0.0002, 0.0002)],
    [square(0.003, 0, 0.001)],
  ];
  const decode = (coordinates, cut = false) =>
    decodeOpenFreeMapOutlineTile(null, 0, 0, 0, {
      layers: {
        building: {
          length: 1,
          extent: 4096,
          feature: () => ({
            properties: { render_height: 20 },
            loadGeometry: () => [[{ x: cut ? -1 : 1, y: 1 }]],
            toGeoJSON: () => ({
              geometry: { type: 'MultiPolygon', coordinates },
            }),
          }),
        },
      },
    });
  const multipart = decode(parts);
  assert.equal(multipart.buildings[0].id, null);
  const picked = buildingFromTiles([multipart], { lon: 0.0035, lat: 0.0005 });
  assert.deepEqual(
    picked.polygons,
    [parts[1]],
    'an anonymous tile feature does not certify sibling building identity',
  );
  assert.deepEqual(
    buildingFromTiles([multipart], { lon: 0.0008, lat: 0.0008 }).polygons,
    [parts[0]],
    'the selected component retains its courtyard hole',
  );
  const clipped = decode(
    [parts[0], [square(-180 - 360 / 4096, 0, 0.001)]],
    true,
  );
  assert.equal(clipped.buildings[0].clipped, false);
  assert.equal(clipped.buildings[1].clipped, true);
  assert.deepEqual(
    buildingFromTiles([clipped], { lon: 0.0008, lat: 0.0008 }).polygons,
    [parts[0]],
    'a remote cut sibling cannot disqualify an intact component',
  );
  assert.equal(
    buildingFromTiles([clipped], {
      lon: -180 - 360 / 4096 + 0.0005,
      lat: 0.0005,
    }),
    null,
  );
  const malformed = decode([parts[0], [parts[1][0], null]]);
  const neighbor = {
    rings: [square(0.0041, 0, 0.001)],
    heightM: 20,
    clipped: false,
  };
  assert.deepEqual(
    buildingFromTiles([malformed], { lon: 0.0008, lat: 0.0008 }).polygons,
    [parts[0]],
    'a remote malformed sibling cannot disqualify an intact component',
  );
  assert.equal(
    buildingFromTiles(
      [{ ...malformed, buildings: [...malformed.buildings, neighbor] }],
      { lon: 0.0038, lat: 0.0008 },
    ),
    null,
    'a selected malformed component never substitutes its neighbour',
  );
});

test('a clipped fragment is never the building, and no neighbour stands in', () => {
  const fragment = {
    rings: [square(0, 0, 0.001)],
    clipped: true,
    heightM: null,
  };
  const neighbour = {
    rings: [square(0.0011, 0, 0.0002)],
    clipped: false,
    heightM: null,
  };
  const point = { lat: 0.0005, lon: 0.0008 };
  assert.equal(
    buildingFromTiles([{ buildings: [fragment, neighbour] }], point),
    null,
  );
  // A complete copy from the neighbouring tile's buffer is used.
  const complete = { ...fragment, clipped: false };
  assert.ok(
    buildingFromTiles(
      [{ buildings: [fragment, neighbour] }, { buildings: [complete] }],
      point,
    )?.contains,
  );
  const lawn = {
    rings: [square(0, 0, 0.01)],
    clipped: true,
    class: 'park',
    name: 'Test Park',
  };
  assert.equal(
    enclosingAreaFromTiles([{ areas: [lawn] }], {
      lat: 0.005,
      lon: 0.005,
      name: 'Test Park',
    }),
    null,
    'clipped grounds are not grounds',
  );
});

test('a nearer cut fragment stops a farther whole building standing in', () => {
  // About 110 m on a side, 2 m east of the point.
  const fragment = {
    rings: [square(0.00002, 0, 0.001)],
    clipped: true,
    heightM: null,
  };
  // Whole, about 30 m west of the point.
  const neighbour = {
    rings: [square(-0.0004, 0.00045, 0.0001)],
    clipped: false,
    heightM: null,
  };
  const point = { lat: 0.0005, lon: 0 };
  assert.equal(
    buildingFromTiles([{ buildings: [fragment, neighbour] }], point),
    null,
  );
  // The fragment's complete copy from the neighbouring tile is the answer.
  const complete = { ...fragment, clipped: false };
  assert.deepEqual(
    buildingFromTiles(
      [{ buildings: [fragment, neighbour] }, { buildings: [complete] }],
      point,
    )?.polygons,
    [fragment.rings],
  );
  // A fragment farther than the whole building does not block it.
  assert.ok(
    buildingFromTiles([{ buildings: [fragment, neighbour] }], {
      ...point,
      lon: -0.00028,
    }),
  );
});

test('grounds touching an unbuffered tile edge are cut, not complete', () => {
  // One tile at z0 whose park layer has no buffer: the cut is the edge itself.
  const decode = (coordinates) =>
    decodeOpenFreeMapOutlineTile(null, 0, 0, 0, {
      layers: {
        park: {
          length: 1,
          extent: 4096,
          feature: () => ({
            properties: { class: 'park', name: 'Edge Park' },
            loadGeometry: () => [[{ x: 0, y: 2048 }]],
            toGeoJSON: () => ({
              geometry: { type: 'Polygon', coordinates },
            }),
          }),
        },
      },
    });
  const ask = { lat: 0.005, lon: -179.995, name: 'Edge Park' };
  const cut = decode([square(-180, 0, 0.01)]);
  assert.equal(cut.areas[0].clipped, true);
  assert.equal(enclosingAreaFromTiles([cut], ask), null);
  const inside = decode([square(-179.999, 0, 0.01)]);
  assert.equal(inside.areas[0].clipped, false);
  assert.ok(enclosingAreaFromTiles([inside], ask));
  // A whole shape that only touches the edge at one corner is not cut.
  const tangent = decode([
    [
      [-180, 0.005],
      [-179.995, 0],
      [-179.99, 0.005],
      [-179.995, 0.01],
      [-180, 0.005],
    ],
  ]);
  assert.equal(tangent.areas[0].clipped, false);
});

test('a point in a courtyard is not inside the building', () => {
  const block = {
    rings: [square(0, 0, 0.001), square(0.0004, 0.0004, 0.0002).reverse()],
    clipped: false,
    heightM: 20,
  };
  const courtyard = { lat: 0.0005, lon: 0.0005 };
  assert.equal(
    buildingFromTiles([{ buildings: [block] }], {
      ...courtyard,
      maxDistanceM: 0,
    }),
    null,
  );
  const near = buildingFromTiles([{ buildings: [block] }], courtyard);
  assert.ok(near && !near.contains, 'near the courtyard walls, not inside');
});

test('named grounds require matching identity and filled containment', () => {
  const lawn = {
    rings: [square(0, 0, 0.004), square(0.0015, 0.0015, 0.001).reverse()],
    clipped: false,
    class: 'park',
    name: 'Capitol Park',
  };
  const grounds = enclosingAreaFromTiles([{ areas: [lawn] }], {
    lat: 0.002,
    lon: 0.002,
    name: 'Capitol Park',
  });
  assert.equal(grounds, null, 'a hole is not filled grounds');
  const filled = { lat: 0.0005, lon: 0.0005, name: 'the Capitol Park' };
  assert.ok(enclosingAreaFromTiles([{ areas: [lawn] }], filled));
  assert.equal(
    enclosingAreaFromTiles([{ areas: [lawn] }], {
      ...filled,
      name: 'Other Park',
    }),
    null,
  );
  assert.equal(
    enclosingAreaFromTiles([{ areas: [{ ...lawn, name: null }] }], filled),
    null,
    'an unlabeled enclosing feature has no exact named authority',
  );
});

test('street proximity uses segments and clips to the search extent', () => {
  // One straight 4 km piece whose vertices are both 2 km from the point.
  const through = {
    name: 'Long Road',
    coordinates: [
      [-0.018, 0],
      [0.018, 0],
    ],
  };
  const street = streetFromTiles([{ streets: [through] }], {
    name: 'Long Road',
    lat: 0,
    lon: 0,
    radiusM: 500,
  });
  assert.ok(street, 'a street passing through the point is found');
  for (const [lon] of street.lines.flat())
    assert.ok(Math.abs(lon) <= 500 / 111_320 + 1e-9, 'within the extent');
  const far = {
    name: 'Long Road',
    coordinates: [
      [-0.018, 0.02],
      [0.018, 0.02],
    ],
  };
  assert.equal(
    streetFromTiles([{ streets: [far] }], {
      name: 'Long Road',
      lat: 0,
      lon: 0,
      radiusM: 500,
    }),
    null,
  );
});

test('unnamed school, hospital and campus grounds answer only an ask of that kind', () => {
  assert.deepEqual(
    [...groundsClassesFor('Lincoln High School grounds')],
    ['school'],
  );
  assert.deepEqual(
    [...groundsClassesFor('Lincoln High School campus')],
    ['school'],
  );
  assert.deepEqual([...groundsClassesFor('City College campus site')].sort(), [
    'college',
    'university',
  ]);
  assert.deepEqual(
    [...groundsClassesFor('St. Mary Medical Center')],
    ['hospital'],
  );
  assert.deepEqual([...groundsClassesFor('Texas Capitol grounds')], []);
  assert.deepEqual(
    [...groundsClassesFor('University of Texas grounds')].sort(),
    ['college', 'university'],
  );
  for (const name of [
    'University Avenue Park grounds',
    'Zoo Lake grounds',
    'School Street Playground grounds',
    'Academy of Sciences grounds',
    'Stadium Station',
    'Google campus',
    'Mayo Clinic campus',
    'Google campus',
    'Mayo Clinic campus',
  ])
    assert.deepEqual([...groundsClassesFor(name)], [], name);
  // About 1.2 km on a side: grounds-sized.
  const school = {
    rings: [square(0, 0, 0.01)],
    clipped: false,
    class: 'school',
    name: null,
  };
  const otherSchool = {
    ...school,
    rings: [square(-0.001, -0.001, 0.02)],
    name: 'Other Academy',
  };
  const park = { ...school, class: 'park' };
  const at = { lat: 0.005, lon: 0.005, name: 'Lincoln High School' };
  const asked = {
    ...at,
    unnamedClasses: groundsClassesFor('Lincoln High School grounds'),
  };
  assert.deepEqual(
    enclosingAreaFromTiles([{ areas: [school] }], asked)?.class,
    'school',
  );
  assert.equal(
    enclosingAreaFromTiles([{ areas: [school] }], at),
    null,
    'no class from the ask, no unnamed answer',
  );
  assert.equal(
    enclosingAreaFromTiles([{ areas: [park] }], asked),
    null,
    'another class never answers',
  );
  assert.equal(
    enclosingAreaFromTiles([{ areas: [otherSchool] }], asked),
    null,
    'a differently named school never answers',
  );
  const named = {
    ...school,
    rings: [square(-0.002, -0.002, 0.03)],
    name: 'Lincoln High School',
  };
  assert.equal(
    enclosingAreaFromTiles([{ areas: [school, named] }], asked).name,
    'Lincoln High School',
    'a named match answers first',
  );
  assert.equal(
    enclosingAreaFromTiles([{ areas: [{ ...school, clipped: true }] }], asked),
    null,
    'clipped unnamed grounds are not grounds',
  );
});

test('an unnamed class match is only the part holding the point', () => {
  // A school feature with a second, distant part: only a name could tie them.
  const near = square(0, 0, 0.002); // about 49,000 m²
  const far = square(0.02, 0.02, 0.002);
  const tiny = square(0, 0, 0.0005); // about 3,000 m², below the floor
  const ask = {
    lat: 0.001,
    lon: 0.001,
    name: 'Lincoln High School',
    unnamedClasses: groundsClassesFor('Lincoln High School grounds'),
  };
  // As decoded: `rings` is the same array as its entry in `featureParts`.
  const area = (rings, others) => ({
    rings,
    featureParts: [rings, ...others],
    clipped: false,
    class: 'school',
    name: null,
  });
  const found = enclosingAreaFromTiles(
    [{ areas: [area([near], [[far]])] }],
    ask,
  );
  assert.deepEqual(
    found.polygons,
    [[near]],
    'the distant part is not included',
  );
  assert.equal(
    enclosingAreaFromTiles(
      [{ areas: [area([tiny], [[far], [square(-0.02, 0, 0.003)]])] }],
      { ...ask, lat: 0.0002, lon: 0.0002 },
    ),
    null,
    'other parts cannot lift a small part over the size floor',
  );
  const named = enclosingAreaFromTiles(
    [
      {
        areas: [{ ...area([near], [[far]]), name: 'Lincoln High School' }],
      },
    ],
    ask,
  );
  assert.equal(named.polygons.length, 2, 'a named feature keeps its parts');
});

test('grounds names keep their own grounds words; possessives and part cuts', () => {
  assert.deepEqual(
    [...groundsClassesFor("Lincoln School's grounds")],
    ['school'],
  );
  const complex = {
    rings: [square(0, 0, 0.002)],
    clipped: false,
    class: 'pitch',
    name: 'Mueller Sports Complex',
  };
  const named = (name) => ({
    rings: [square(0, 0, 0.002)],
    clipped: false,
    class: 'park',
    name,
  });
  const at = { lat: 0.001, lon: 0.001 };
  for (const [ask, area] of [
    ["Lincoln School's", 'Lincoln School'],
    ['Martius Park', 'Campus Martius Park'],
    ['Mueller Sports Field', 'Mueller Sports Complex Field'],
  ])
    assert.equal(
      enclosingAreaFromTiles([{ areas: [named(area)] }], { ...at, name: ask })
        ?.name,
      area,
      `${ask} → ${area}`,
    );
  assert.equal(
    enclosingAreaFromTiles([{ areas: [named('Lincoln Park Zoo')] }], {
      ...at,
      name: 'Lincoln Park',
    }),
    null,
    'a longer, different name never answers',
  );
  // The ask arrives with its grounds words cut by the rung.
  assert.equal(
    enclosingAreaFromTiles([{ areas: [complex] }], {
      lat: 0.001,
      lon: 0.001,
      name: 'Mueller Sports',
    })?.name,
    'Mueller Sports Complex',
  );
  // A sibling part cut at the tile edge does not refuse a class match's own part.
  const school = {
    rings: [square(0, 0, 0.002)],
    clipped: true,
    partClipped: false,
    class: 'school',
    name: null,
  };
  const ask = {
    lat: 0.001,
    lon: 0.001,
    name: 'Lincoln High School',
    unnamedClasses: groundsClassesFor('Lincoln High School grounds'),
  };
  assert.ok(enclosingAreaFromTiles([{ areas: [school] }], ask));
  assert.equal(
    enclosingAreaFromTiles(
      [{ areas: [{ ...school, partClipped: true }] }],
      ask,
    ),
    null,
    'its own cut part is still refused',
  );
});
