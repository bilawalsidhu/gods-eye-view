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

import {
  registerEntityContext,
  selectEntityContext,
  clearSelectedEntityContextForLayer,
  removeEntityContextsForLayer,
  getSelectedEntityContext,
} from './contextStore.js';

globalThis.window ??= { dispatchEvent() {} };

test('a lone data centre picked close in stays selected and drawn after its fly-to', async (t) => {
  // Five sites about 130 m apart: alone at 1.5 km, grouped at the 5 km fly-to height.
  const sites = [0, 1, 2, 3, 4].map((i) => ({
    id: `dc-${i}`,
    lon: LON + i * 0.0015,
    lat: LAT,
  }));
  const env = await clustered(t, {
    eye: { lon: sites[2].lon, lat: LAT, height: 1_500 },
    features: sites.map(footprint),
    services: {
      registerEntityContext,
      selectEntityContext,
      clearSelectedEntityContextForLayer,
      removeEntityContextsForLayer,
      registerPaintLane: paintLane,
    },
  });
  env.settle();
  assert.ok(shown(env.fake, 'markers').includes('dc-2'));
  env.click({
    screenPosition: { x: 400, y: 300 },
    drawHit: { set: env.fake.set('markers').spec.id, id: 'dc-2' },
    topHit: {},
  });
  assert.equal(getSelectedEntityContext()?.id, 'local-datacenters:dc-2');
  // Land the click's flight and let the layer group again.
  const flight = env.fake.flights.at(-1);
  if (flight.destination)
    env.fake.setEye(
      flight.destination.lon,
      flight.destination.lat,
      flight.destination.height,
    );
  flight.options.onComplete?.();
  env.settle();
  assert.ok(
    shown(env.fake, 'markers').includes('dc-2'),
    'the picked site is still drawn alone',
  );
  assert.equal(
    getSelectedEntityContext()?.id ?? null,
    'local-datacenters:dc-2',
    'the selection survives the flight',
  );
});
