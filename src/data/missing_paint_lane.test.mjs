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

test('without registerPaintLane, grouped data centres are still drawn', async (t) => {
  const sites = [0, 1, 2, 3, 4].map((i) => ({
    id: `dc-${i}`,
    lon: LON + i * 0.004,
    lat: LAT,
  }));
  // The services of the docs/INFRASTRUCTURE-LAYERS.md example: no registerPaintLane.
  const env = await clustered(t, {
    eye: { lon: LON, lat: LAT, height: 50_000 },
    features: sites.map(footprint),
  });
  env.settle();
  const drawn =
    shown(env.fake, 'markers').length + shown(env.fake, 'fills').length;
  assert.ok(
    drawn > 0,
    'grouped sites have no painted count, so they must show some other way',
  );
});
