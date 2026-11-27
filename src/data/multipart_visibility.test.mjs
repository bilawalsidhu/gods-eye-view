import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalGeoJsonLayer } from './localGeojsonCore.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';

const LON = -77.488;
const LAT = 39.03;
const D = 0.0005;
const square = (lon, lat) => [
  [
    [lon - D, lat - D],
    [lon + D, lat - D],
    [lon + D, lat + D],
    [lon - D, lat + D],
    [lon - D, lat - D],
  ],
];
const footprint = ({ id, lon, lat }) => ({
  type: 'Feature',
  id,
  properties: { name: `Site ${id}` },
  geometry: { type: 'Polygon', coordinates: square(lon, lat) },
});

function stubDocument(t) {
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        measureText: (s) => ({
          width: s.length * 7,
          actualBoundingBoxAscent: 4,
          actualBoundingBoxDescent: 4,
        }),
      }),
    }),
  };
  t.after(() => delete globalThis.document);
}
const paintLane = () => ({
  requestPaint() {},
  setActive() {},
  unregister() {},
});
const baseServices = {
  overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
  registerEntityContext() {},
  selectEntityContext() {},
  clearSelectedEntityContextForLayer() {},
  removeEntityContextsForLayer() {},
  governorRequestRender() {},
};

/** A clustered Datacenters layer over the fake renderer, enabled. */
async function clustered(
  t,
  { eye, canvas, features, services = {}, fakeOptions = {} },
) {
  stubDocument(t);
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, { eye, canvas, ...fakeOptions });
  t.after(fake.unbind);
  let click = null;
  const layer = createLocalGeoJsonLayer(
    {
      id: 'local-datacenters',
      name: 'Datacenters',
      color: '#00ffff',
      markers: 'clusters',
      loadFeatures: async () => features,
      projectToWindow: () => ({ x: 400, y: 300 }),
      inputFor: () => ({
        onClick: (fn) => {
          click = fn;
          return () => {};
        },
        suspendCamera: () => () => {},
      }),
    },
    { ...baseServices, ...services },
  );
  await layer.enable(viewer);
  t.after(() => layer.destroy(viewer));
  const settle = () => {
    fake.moveEnd.raise();
    fake.preRender.raise();
  };
  return { layer, fake, settle, click: (event) => click(event) };
}
const shown = (fake, role) =>
  [...fake.set(role).items.values()]
    .filter((item) => item.show)
    .map((item) => item.id)
    .sort();

test('a multipart data centre shows when only its second polygon is in view', async (t) => {
  const env = await clustered(t, {
    eye: { lon: LON + 0.008, lat: LAT, height: 300 },
    canvas: { width: 1440, height: 860 },
    // Two polygons about 690 m apart, as bundled feature -9474864.
    features: [
      {
        type: 'Feature',
        id: 'mp',
        properties: { name: 'MP' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [square(LON, LAT), square(LON + 0.008, LAT)],
        },
      },
    ],
    services: { registerPaintLane: paintLane },
  });
  env.settle();
  assert.ok(
    Math.abs(env.fake.set('markers').items.get('mp').pos.lon - (LON + 0.008)) <
      1e-6,
  );
  assert.ok(
    shown(env.fake, 'fills').length > 0,
    'the polygon under the camera is drawn',
  );
  assert.equal(env.layer.getLodDiagnostics().lone, 1);
});
