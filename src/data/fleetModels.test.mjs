import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLEET_MODEL_BASE,
  aircraftModelSpec,
  aisShipTypeCode,
  emitterCategory,
  fleetModelSet,
  fleetModelSpec,
  hullBeam,
  hullLength,
  loadFleetModelSet,
  namedFleetModels,
  placeScale,
  resetFleetModelSet,
  resolveAircraft,
  resolveTransit,
  resolveVessel,
  transitModelSpec,
  vesselModelSpec,
} from './fleetModels.js';
import { FLEET_TRAIL_ANCHORS } from './fleetTrailAnchors.js';
import {
  centrelineSegments,
  distanceToSurface,
  fleetMesh,
  measuredTrailAnchor,
  readGlb,
  vertexBounds,
} from '../testSupport/fleetGlb.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const DIR = path.join(ROOT, 'public', 'models', 'fleet');
const json = (name) =>
  JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const catalog = json('catalog.json');
const types = json('types.json');
const set = { catalog, types };

// A slice of the set's types.json and catalog.json, as the resolver's own
// reference tests use, so these read independently of later model changes.
const sliceTypes = {
  aircraft: {
    A320: ['a320', 37.57],
    A21N: ['a320', 44.51],
    A319: ['a320', 33.84],
    B38M: ['b738', 39.52],
    ZVEH: ['car', 4.61],
    GRND: ['radio_mast', 1.9],
  },
  helicopters: { EC35: ['ec35', 10.2] },
  aircraft_callsign: {
    ZVEH: [
      { prefixes: ['FIRE'], model: 'fire_truck', length: 11.01 },
      { prefixes: ['PUSH', 'TUG'], model: 'pushback', length: 6 },
      { prefixes: ['DEICER', 'SQUID', 'SQB'], model: 'van', length: 5.51 },
    ],
  },
  categories: { A1: ['c172', 8.3] },
  vessels: [
    {
      types: [70, 79],
      typical_len: 300,
      rules: [
        { min_len: 70, max_len: 140, max_bl: 0.12, model: 'inland_cargo' },
        {
          name_re: '\\b(LEADER|HIGHWAY|ACE|GLOVIS|HOEGH|SPIRIT OF)\\b',
          min_len: 150,
          model: 'car_carrier',
        },
        { min_len: 250, model: 'container_ship' },
        { model: 'general_cargo' },
      ],
    },
    { types: [31, 32], rules: [{ model: 'tug' }] },
    { types: [52, 52], rules: [{ model: 'tug' }] },
    { types: [0, 99], rules: [{ model: 'generic_vessel' }] },
  ],
  default_aircraft: ['generic_plane', 36],
  default_vessel: 'generic_vessel',
};
const model = (category, file, length, beam, clearance) => ({
  category,
  file,
  min: [0, 0, 0],
  max: [0, 0, 0],
  length,
  beam,
  clearance,
  tris: 1,
  icon: 'jet',
});
const sliceCatalog = {
  a320: model('aircraft', 'aircraft/a320.glb', 37.57, 35.6, 3.063),
  container_ship: model('ships', 'ships/container_ship.glb', 309.9, 48, 13.9),
};

test('aircraft resolve by type, then emitter category, then the generic plane', () => {
  assert.deepEqual(resolveAircraft(sliceTypes, 'A320'), {
    model: 'a320',
    length: 37.57,
  });
  assert.deepEqual(resolveAircraft(sliceTypes, ' b38m '), {
    model: 'b738',
    length: 39.52,
  });
  assert.equal(resolveAircraft(sliceTypes, 'EC35').model, 'ec35');
  assert.deepEqual(resolveAircraft(sliceTypes, 'ZZZZ', 'A1'), {
    model: 'c172',
    length: 8.3,
  });
  assert.deepEqual(resolveAircraft(sliceTypes, undefined, 'Q9'), {
    model: 'generic_plane',
    length: 36,
  });
});

test('airport vehicles (ZVEH) by callsign, first rule wins, else the type: spaces and case ignored', () => {
  const zveh = (callsign) =>
    resolveAircraft(sliceTypes, 'ZVEH', undefined, callsign);
  assert.deepEqual(zveh('FIRE 2'), { model: 'fire_truck', length: 11.01 });
  assert.deepEqual(resolveAircraft(sliceTypes, 'zveh', undefined, ' fire2 '), {
    model: 'fire_truck',
    length: 11.01,
  });
  assert.equal(zveh('PUSH 14').model, 'pushback');
  assert.equal(zveh('TUG3').model, 'pushback');
  assert.deepEqual(zveh('DEICER 4'), { model: 'van', length: 5.51 });
  assert.equal(zveh('SQUID20').model, 'van');
  assert.equal(zveh('SQB9').model, 'van');
  assert.equal(zveh('S Q B 9').model, 'van');
  assert.deepEqual(zveh('LEADER 7'), { model: 'car', length: 4.61 });
  assert.deepEqual(zveh(undefined), { model: 'car', length: 4.61 });
  // Callsign rules belong to their type: a fire-named airliner is still an airliner.
  assert.equal(
    resolveAircraft(sliceTypes, 'A320', undefined, 'FIRE1').model,
    'a320',
  );
  assert.deepEqual(resolveAircraft(sliceTypes, 'GRND', undefined, 'RX5'), {
    model: 'radio_mast',
    length: 1.9,
  });
});

test('vessels: the first matching rule of the first type range with one, else the generic vessel', () => {
  assert.equal(resolveVessel(sliceTypes, 70, 366, 51).model, 'container_ship');
  assert.equal(
    resolveVessel(sliceTypes, 71, 199, 32, 'GLOVIS SPIRIT').model,
    'car_carrier',
  );
  assert.equal(resolveVessel(sliceTypes, 79, 110, 11.4).model, 'inland_cargo');
  assert.equal(resolveVessel(sliceTypes, 70, 90, 15).model, 'general_cargo');
  assert.deepEqual(resolveVessel(sliceTypes, 52, 30, 10), {
    model: 'tug',
    length: 30,
  });
  assert.deepEqual(resolveVessel(sliceTypes, undefined, 50), {
    model: 'generic_vessel',
    length: 50,
  });
  assert.deepEqual(resolveVessel(sliceTypes, 0), {
    model: 'generic_vessel',
    length: null,
  });
});

test("vessels of unknown length are chosen and drawn at their range's typical length", () => {
  assert.deepEqual(resolveVessel(sliceTypes, 70), {
    model: 'container_ship',
    length: 300,
  });
  assert.deepEqual(resolveVessel(sliceTypes, 70, 511, 126), {
    model: 'container_ship',
    length: 300,
  });
  assert.deepEqual(resolveVessel(sliceTypes, 70, 90, 15), {
    model: 'general_cargo',
    length: 90,
  });
  assert.deepEqual(resolveVessel(sliceTypes, 31), {
    model: 'tug',
    length: null,
  });
  // Every passenger, cargo and tanker range of the set has one.
  for (const code of [60, 70, 80]) {
    assert.ok(resolveVessel(types, code).length > 100, String(code));
  }
});

test("vessels: AIS's out-of-range sizes (511 m long, 126 m abeam) are unknown, drawn as built", () => {
  assert.deepEqual(resolveVessel(sliceTypes, 52, 511), {
    model: 'tug',
    length: null,
  });
  assert.equal(hullLength(511), undefined);
  assert.equal(hullLength(0), undefined);
  assert.equal(hullBeam(126), undefined);
  assert.equal(hullBeam(32), 32);
  const ship = sliceCatalog.container_ship;
  assert.deepEqual(placeScale(ship, ship.length, 126), [1, 1, 1]);
});

test('scale: aircraft by the type length, vessels by length and beam', () => {
  const a320 = sliceCatalog.a320;
  const [sx, sy, sz] = placeScale(a320, 44.51);
  assert.ok(Math.abs(sx - 44.51 / 37.57) < 1e-12);
  assert.equal(sy, sx);
  assert.equal(sz, sx);
  const ship = sliceCatalog.container_ship;
  assert.deepEqual(placeScale(ship, ship.length / 2, 24), [0.5, 0.5, 0.5]);
  assert.deepEqual(placeScale(ship, null), [1, 1, 1]);
});

test('every model the type map names is in the catalog, and its file is a GLB on disk', () => {
  for (const name of namedFleetModels(types))
    assert.ok(
      catalog[name],
      `${name}: named by types.json but not in the catalog`,
    );
  assert.equal(catalog.generic_plane?.category, 'aircraft');
  assert.equal(catalog.generic_vessel?.category, 'ships');
  assert.equal(catalog.city_bus?.category, 'transit');
  for (const [name, metres] of Object.entries(types.transit.elevation)) {
    assert.ok(catalog[name], name);
    assert.ok(metres > 0, name);
  }
  let total = 0;
  for (const [name, entry] of Object.entries(catalog)) {
    const file = path.join(DIR, entry.file);
    assert.ok(fs.existsSync(file), `${name}: ${entry.file} is missing`);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'glTF', name);
    assert.ok(entry.length > 0, name);
    assert.ok(entry.tris <= 50_000, name);
    total += bytes.length;
  }
  // The set ships with the repository and loads up front: keep it small.
  assert.ok(total < 3 * 1024 * 1024, `fleet GLBs total ${total} bytes`);
});

test('transit bodies mark the share of the route colour they take; other models mark none', () => {
  for (const [name, entry] of Object.entries(catalog)) {
    const { json: gltf } = readGlb(path.join(DIR, entry.file));
    for (const mesh of gltf.meshes)
      for (const primitive of mesh.primitives)
        assert.equal(
          '_TINT' in primitive.attributes,
          entry.category === 'transit',
          name,
        );
    assert.equal(
      fleetModelSpec(set, name, null).tinted,
      entry.category === 'transit',
    );
  }
});

test('aircraft specs: airport vehicles by callsign, ground stations as a mast, as the set says', () => {
  const zveh = (callsign) =>
    aircraftModelSpec(set, { typeCode: 'ZVEH', category: 'UNKNOWN', callsign })
      .model;
  assert.equal(zveh('FIRE 2'), 'fire_truck');
  assert.equal(zveh('PUSHBACK1'), 'pushback');
  assert.equal(zveh('TUG 4'), 'pushback');
  assert.equal(zveh('DEICER 4'), 'van');
  assert.equal(zveh('SQUID20'), 'van');
  assert.equal(zveh('SQB9'), 'van');
  assert.equal(zveh('LEADER 7'), 'car');
  assert.equal(zveh('AOPS'), 'car');
  assert.equal(zveh(null), 'car');
  const mast = aircraftModelSpec(set, { typeCode: 'GRND', callsign: 'RX5' });
  assert.equal(mast.model, 'radio_mast');
  assert.equal(mast.scale, 1);
});

test('a callsign rule outranks the class model of a type the map lacks', () => {
  const ruled = {
    ...set,
    types: {
      ...set.types,
      aircraft_callsign: {
        ...set.types.aircraft_callsign,
        PUMA: [{ prefixes: ['FIRE'], model: 'fire_truck', length: 11.01 }],
      },
    },
  };
  assert.equal(
    aircraftModelSpec(ruled, { typeCode: 'PUMA', callsign: 'FIRE 1' }).model,
    'fire_truck',
  );
  // No rule matched: the class model, as before.
  assert.equal(
    aircraftModelSpec(ruled, { typeCode: 'PUMA', callsign: 'RESCUE1' }).model,
    'generic_heli',
  );
});

test('aircraft specs: by type, then class for an unlisted type, then emitter category', () => {
  assert.equal(aircraftModelSpec(set, { typeCode: 'A320' }).model, 'a320');
  assert.equal(aircraftModelSpec(set, { type: 'b744' }).model, 'b744');
  // An unlisted fast jet is still a fast jet, not the generic airliner.
  assert.equal(
    aircraftModelSpec(set, { typeCode: 'FA18', category: 'A3' }).model,
    't38',
  );
  assert.equal(aircraftModelSpec(set, { typeCode: 'MQ9' }).model, 'mq9');
  assert.equal(
    aircraftModelSpec(set, { typeCode: 'PUMA' }).model,
    'generic_heli',
  );
  // An unlisted type of no special class falls to its category.
  assert.equal(
    aircraftModelSpec(set, { typeCode: 'ZZZZ', category: 'A5' }).model,
    'b77w',
  );
  // OpenSky's integer category: 8 is rotorcraft (A7), 2 light (A1).
  assert.equal(emitterCategory(8), 'A7');
  assert.equal(emitterCategory('a3'), 'A3');
  assert.equal(emitterCategory(1), undefined);
  assert.equal(aircraftModelSpec(set, { category: 8 }).model, 'generic_heli');
  assert.equal(aircraftModelSpec(set, { category: 2 }).model, 'c172');
  assert.equal(aircraftModelSpec(set, {}).model, types.default_aircraft[0]);
});

test('aircraft specs are life size, standing on their scaled clearance', () => {
  const spec = aircraftModelSpec(set, { typeCode: 'A21N' });
  const [, length] = types.aircraft.A21N;
  assert.equal(spec.model, types.aircraft.A21N[0]);
  assert.ok(Math.abs(spec.length - length) < 1e-9);
  assert.ok(Math.abs(spec.scale - length / catalog[spec.model].length) < 1e-12);
  assert.ok(
    Math.abs(spec.clearanceM - catalog[spec.model].clearance * spec.scale) <
      1e-12,
  );
  assert.equal(spec.url, `${FLEET_MODEL_BASE}${catalog[spec.model].file}`);
  assert.equal(spec.tinted, false);
  assert.equal(spec.elevationM, 0);
  assert.ok(
    spec.nativeRadiusM * spec.scale > 25 &&
      spec.nativeRadiusM * spec.scale < 60,
  );
  assert.deepEqual(spec.trailAnchorNative, FLEET_TRAIL_ANCHORS[spec.model]);
  // A grounded service vehicle and an obstacle are drawn as built: the
  // tower's 60 m is its height, not a length to stretch it to.
  const tower = aircraftModelSpec(set, { category: 'C3' });
  assert.equal(tower.model, 'tower');
  assert.equal(tower.scale, 1);
  assert.equal(aircraftModelSpec(set, { category: 'C1' }).scale, 1);
});

test('vessel specs read AIS codes and text families, stretched to the reported beam', () => {
  assert.equal(aisShipTypeCode('70'), 70);
  assert.equal(aisShipTypeCode(' Cargo '), 70);
  assert.equal(aisShipTypeCode('Tanker'), 80);
  assert.equal(aisShipTypeCode('Tug'), 52);
  assert.equal(aisShipTypeCode('0'), undefined);
  assert.equal(aisShipTypeCode(''), undefined);
  const box = vesselModelSpec(set, { type: '71', length: 366, beam: 51 });
  assert.equal(box.model, 'container_ship');
  assert.ok(Math.abs(box.length - 366) < 1e-9);
  const [sx, sy, sz] = box.scaleXYZ;
  assert.ok(Math.abs(sy - 51 / catalog.container_ship.beam) < 1e-12);
  assert.ok(Math.abs(sz - (sx + sy) / 2) < 1e-12);
  // A beam with no reported length: the type's typical length, in the model's
  // own proportions, not a typical-length hull squeezed to that beam.
  const unsized = vesselModelSpec(set, { type: '70', length: 0, beam: 14 });
  assert.equal(unsized.model, 'container_ship');
  const [ux, uy, uz] = unsized.scaleXYZ;
  assert.ok(Math.abs(uy - ux) < 1e-12 && Math.abs(uz - ux) < 1e-12);
  assert.equal(vesselModelSpec(set, { type: 'Tug', length: 30 }).model, 'tug');
  assert.equal(vesselModelSpec(set, { type: '36' }).model, 'sailboat');
  // No type, no size: the generic vessel as built.
  const unknown = vesselModelSpec(set, {});
  assert.equal(unknown.model, types.default_vessel);
  assert.equal(unknown.scale, 1);
});

test('transit specs: rail category and mode, then route type, then mode, then the default', () => {
  assert.deepEqual(resolveTransit(types, { railCategory: 'national' }), {
    model: 'intercity',
    length: types.transit.rail.national.rail[1],
  });
  assert.equal(
    resolveTransit(types, { railCategory: 'transit', railMode: 'metro' }).model,
    'metro',
  );
  assert.equal(
    resolveTransit(types, { railCategory: 'regional', railMode: 'tram' }).model,
    'light_rail',
  );
  assert.equal(resolveTransit(types, { routeType: 3 }).model, 'city_bus');
  assert.equal(resolveTransit(types, { routeType: '0' }).model, 'tram');
  assert.equal(resolveTransit(types, { routeType: 109 }).model, 'commuter_emu');
  assert.equal(resolveTransit(types, { mode: 'subway' }).model, 'metro');
  assert.equal(resolveTransit(types, { mode: 'ferry' }).model, 'fast_ferry');
  assert.equal(
    resolveTransit(types, { mode: 'unknown' }).model,
    types.transit.default[0],
  );
  const tram = transitModelSpec(set, { mode: 'tram' });
  assert.equal(tram.tinted, true);
  assert.equal(tram.clearanceM, 0);
  assert.ok(Math.abs(tram.length - types.transit.modes.tram[1]) < 1e-9);
  assert.equal(
    transitModelSpec(set, { routeType: 12 }).elevationM,
    types.transit.elevation.monorail,
  );
  assert.equal(
    transitModelSpec(set, { mode: 'gondola' }).elevationM,
    types.transit.elevation.gondola,
  );
  assert.equal(transitModelSpec(set, { mode: 'ferry' }).tinted, false);
});

test('a model missing from the catalog falls back to the default of its kind', () => {
  const thin = {
    catalog: { ...catalog },
    types: {
      ...types,
      aircraft: { ...types.aircraft, XXXX: ['no_such_model', 20] },
    },
  };
  assert.equal(
    aircraftModelSpec(thin, { typeCode: 'XXXX' }).model,
    types.default_aircraft[0],
  );
});

const ANCHORED = Object.entries(catalog).filter(([, entry]) =>
  ['aircraft', 'helicopters', 'other'].includes(entry.category),
);

test('every aircraft-layer model has a trail anchor on its real aft-belly hull', async () => {
  assert.deepEqual(
    new Set(Object.keys(FLEET_TRAIL_ANCHORS)),
    new Set(ANCHORED.map(([name]) => name)),
    're-run scripts/measure-fleet-trail-anchors.mjs',
  );
  for (const [name, entry] of ANCHORED) {
    const mesh = await fleetMesh(path.join(DIR, entry.file));
    const { min, max } = vertexBounds(mesh.verts);
    const anchor = FLEET_TRAIL_ANCHORS[name];
    // On the hull, not in the air beside it.
    const offHull = distanceToSurface(anchor, mesh.verts, mesh.tris);
    assert.ok(
      offHull <= 1e-3,
      `${name}: trail anchor is ${offHull.toFixed(4)} m off the hull`,
    );
    // Aft of the middle, so the head segment does not run into the body.
    assert.ok(
      anchor[0] > (min[0] + max[0]) / 2,
      `${name}: trail anchor is not aft`,
    );
    // Nothing of the centreline hangs lower at or behind its station.
    const lowest = centrelineSegments(mesh.verts, mesh.tris)
      .flat()
      .filter((p) => p[0] >= anchor[0] - 1e-3)
      .reduce((low, p) => Math.min(low, p[1]), Infinity);
    assert.ok(
      anchor[1] <= lowest + 1e-3,
      `${name}: trail anchor is above the hull aft of it`,
    );
    assert.equal(anchor[2], 0, `${name}: trail anchor is off the centreline`);
    // And it is the construction, re-derived.
    const measured = measuredTrailAnchor(mesh);
    for (const axis of [0, 1])
      assert.ok(
        Math.abs(anchor[axis] - measured[axis]) <= 1e-3,
        `${name} axis ${axis}: table ${anchor[axis]} vs measured ${measured[axis].toFixed(4)}`,
      );
  }
});

test('catalog bounds match the GLBs they describe', async () => {
  for (const [name, entry] of Object.entries(catalog)) {
    const { min, max } = vertexBounds(
      (await fleetMesh(path.join(DIR, entry.file))).verts,
    );
    // The catalog is Z up (glTF Y), glTF Z across.
    const tolerance = 0.01 * Math.max(1, entry.length);
    assert.ok(Math.abs(min[0] - entry.min[0]) <= tolerance, `${name} min x`);
    assert.ok(Math.abs(max[0] - entry.max[0]) <= tolerance, `${name} max x`);
    assert.ok(Math.abs(min[1] - entry.min[2]) <= tolerance, `${name} min up`);
    assert.ok(
      Math.abs(-min[1] - entry.clearance) <= tolerance,
      `${name} clearance`,
    );
    assert.ok(
      Math.abs(max[2] - min[2] - (entry.max[1] - entry.min[1])) <= tolerance,
      `${name} beam`,
    );
  }
});

test('the model set loads once, every GLB up front, shared by every layer', async () => {
  resetFleetModelSet();
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const file = path.join(ROOT, 'public', url.replace(/^\/app/, ''));
    if (!fs.existsSync(file)) return { ok: false, status: 404 };
    const bytes = fs.readFileSync(file);
    return {
      ok: true,
      json: async () => JSON.parse(bytes.toString('utf8')),
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
    };
  };
  const resolveAsset = (url) => `/app${url}`;
  const [first, second] = await Promise.all([
    loadFleetModelSet({ resolveAsset, fetchImpl }),
    loadFleetModelSet({ resolveAsset, fetchImpl }),
  ]);
  assert.equal(first, second);
  assert.equal(fleetModelSet(), first);
  assert.equal(first.bytes.size, Object.keys(catalog).length);
  assert.equal(requested.length, Object.keys(catalog).length + 2);
  assert.ok(requested.every((url) => url.startsWith('/app/models/fleet/')));
  assert.ok(first.totalBytes > 0 && Number.isFinite(first.loadMs));
  await loadFleetModelSet({ resolveAsset, fetchImpl });
  assert.equal(requested.length, Object.keys(catalog).length + 2);
  resetFleetModelSet();
});
