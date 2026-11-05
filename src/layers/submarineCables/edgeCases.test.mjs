import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createCpuPicker } from '../../globe/cpuPicks.js';
import { createNavaraCables } from './render/navara.js';
import { CABLE_OVERLAY_SOURCE_ID } from './policy.js';

const FIJI = [178.44, -18.12];
// Cable A leaves Fiji eastwards across the antimeridian as ONE unsplit path
// and has no reference coordinates, so its reference comes from its geometry.
const cableA = {
  type: 'Feature',
  properties: { id: 'cable-a', name: 'Cable A' },
  geometry: {
    type: 'LineString',
    coordinates: [FIJI, [-170, -10]],
  },
};
// Cable B ends at the same landing point and runs south-west.
const cableB = {
  type: 'Feature',
  properties: { id: 'cable-b', name: 'Cable B', coordinates: [174, -24] },
  geometry: {
    type: 'LineString',
    coordinates: [FIJI, [170, -30]],
  },
};
const landing = {
  type: 'Feature',
  properties: { id: 'suva', name: 'Suva' },
  geometry: { type: 'Point', coordinates: FIJI },
};

function fixture() {
  const engine = createFakeEngine({ kind: 'navara' });
  engine.fake.setPose({
    longitude: geo.math.toRadians(FIJI[0]),
    latitude: geo.math.toRadians(FIJI[1]),
    height: 400000,
  });
  // The fake has no mesh pickers: arbitrate them as Navara's picking does.
  const meshPickers = new Set();
  engine.picker.registerMeshPicker = (pick) => {
    meshPickers.add(pick);
    return () => meshPickers.delete(pick);
  };
  const drill = createCpuPicker({
    projector: engine.projector,
    camera: engine.camera,
    movers: () => [],
    lines: () => [],
    meshes: (at) => [...meshPickers].flatMap((pick) => pick(at)),
  });
  engine.fake.script('pick', (at) => drill(at, 1)[0]);
  const sources = [];
  const native = {
    view: {
      addSource(options) {
        sources.push(options);
        return { delete() {} };
      },
      addLayer() {
        return { on() {}, forceUpdate() {}, delete() {} };
      },
      registerMesh() {},
      addMesh: () => ({ delete() {} }),
    },
    MeshDesc: class {},
    NavaraColor: class {
      setStyle() {
        return this;
      }
    },
  };
  const host = { setVisible() {}, setEntries() {}, clearSource() {} };
  const cables = createNavaraCables(engine, native, host);
  cables.show({
    cables: { type: 'FeatureCollection', features: [cableA, cableB] },
    landingPoints: { type: 'FeatureCollection', features: [landing] },
  });
  return { engine, cables, sources };
}

const screen = (engine, [lon, lat]) =>
  engine.projector.worldToWindow(geo.cartesian3.fromDegrees(lon, lat), {});

test('edge:telegeography-submarine-cables: an antimeridian crossing draws no segment across the whole map', () => {
  const { cables, sources } = fixture();
  try {
    const drawn = sources.at(-1).data.features;
    const paths = drawn.flatMap(({ geometry }) =>
      geometry.type === 'MultiLineString'
        ? geometry.coordinates
        : [geometry.coordinates],
    );
    assert.ok(paths.length >= 3, 'the crossing cable is split in two');
    for (const path of paths)
      for (let index = 1; index < path.length; index++)
        assert.ok(
          Math.abs(path[index][0] - path[index - 1][0]) <= 180,
          `segment ${JSON.stringify([path[index - 1], path[index]])} spans the map`,
        );
    // Both halves meet at the antimeridian at the same latitude.
    const [west, east] = drawn[0].geometry.coordinates;
    assert.equal(Math.abs(west.at(-1)[0]), 180);
    assert.equal(Math.abs(east[0][0]), 180);
    assert.equal(west.at(-1)[1], east[0][1]);
  } finally {
    cables.destroy();
  }
});

test('edge:telegeography-submarine-cables: a click on a cable beside its landing point returns that cable and flies to its own reference', () => {
  const { engine, cables } = fixture();
  try {
    const edgeLat = -18.12 + ((180 - 178.44) / (190 - 178.44)) * (-10 + 18.12);
    const from = screen(engine, FIJI);
    const to = screen(engine, [180, edgeLat]);
    // Halfway along cable A's first drawn segment, well clear of the landing point.
    const at = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    assert.ok(Math.hypot(at.x - from.x, at.y - from.y) > 20);
    const picked = engine.picker.pick(at);
    assert.equal(picked?.id, `${CABLE_OVERLAY_SOURCE_ID}:cable:0`);
    // The landing point itself still answers as the landing point.
    assert.equal(
      engine.picker.pick(from)?.id,
      `${CABLE_OVERLAY_SOURCE_ID}:landing-point:0`,
    );
    engine.fake.resetCalls();
    engine.fake.input('click', { position: at });
    const [flight] = engine.fake.callsOf('camera.flyTo');
    assert.ok(flight, 'the click flies to the cable');
    const target = geo.cartographic.fromCartesian(flight.args[0].destination);
    // The reference of a cable across the antimeridian stays beside it, not at 0°.
    assert.ok(
      Math.abs(geo.math.toDegrees(target.longitude)) > 170,
      `reference at ${geo.math.toDegrees(target.longitude)}°`,
    );
  } finally {
    cables.destroy();
  }
});
