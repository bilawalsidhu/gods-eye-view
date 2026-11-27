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

test('data centres on high ground split apart when the camera is close above them', async (t) => {
  // Two sites 10 m apart on ground 1,600 m above the ellipsoid; the eye is 100 m above that ground.
  const sites = [
    { id: 'a', lon: LON, lat: LAT },
    { id: 'b', lon: LON + 0.0001, lat: LAT },
  ];
  const env = await clustered(t, {
    eye: { lon: LON, lat: LAT, height: 1_700 },
    canvas: { width: 1440, height: 860 },
    features: sites.map((s) => ({
      type: 'Feature',
      id: s.id,
      properties: { name: s.id },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
    services: { registerPaintLane: paintLane },
    fakeOptions: { sampleHeight: true, surface: () => 1_600 },
  });
  env.fake.globe.terrain = () => 1_600;
  env.settle();
  env.settle();
  const diagnostics = env.layer.getLodDiagnostics();
  assert.equal(diagnostics.counts, 0, 'no count marker 100 m above the sites');
  assert.deepEqual(shown(env.fake, 'markers'), ['a', 'b']);
});
