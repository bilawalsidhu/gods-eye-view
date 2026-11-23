// Bike Share's covered cities on the globe (HAL-921): above the height
// stations draw at, every system in the registry has a marker, so the globe
// says where bike share is, and a click on one flies down into its city.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GBFS_CITY_REGISTRY } from './registry.js';
import { createState } from './state.js';
import { createIngestion } from './ingestion.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createLifecycle } from './lifecycle.js';
import { COVERAGE_FLY_HEIGHT_M } from './policy.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeInput } from '../../input/testDoubles.mjs';

globalThis.document ??= {
  addEventListener() {},
  removeEventListener() {},
};

function makeLayer() {
  const owners = new Map();
  const services = {
    render: { governorRequestRender() {} },
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
    sprites: { registerSpriteCollection() {}, restoreSpriteOrder() {} },
    picking: {
      registerPickOwner: (id, owns) => owners.set(id, owns),
      unregisterPickOwner: (id) => owners.delete(id),
    },
  };
  const source = { getStations: async () => ({ data: { stations: [] } }) };
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.ingestion = createIngestion(context);
  parts.model = createModel(context);
  parts.viewport = createViewport(context);
  parts.rendering = createRendering(context);
  parts.selection = createSelection(context);
  parts.queries = { collectDetectableStations: () => [] };
  parts.lifecycle = createLifecycle(context);

  const camera = { lat: 20, lon: 0, height: 18_000_000 };
  const flights = [];
  const viewer = { scene: { pick: () => undefined, canvas: {} } };
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      pose: () => ({ ...camera }),
      viewRectangle: () => null,
      on: () => () => {},
      flyTo: (destination, options) => flights.push({ destination, options }),
    },
  });
  // The layer's click subscription, called with a hit as the dispatcher gives it.
  const fake = fakeInput(viewer);
  const clicks = [];
  const subscribe = fake.input.onClick;
  fake.input.onClick = (fn) => {
    clicks.push(fn);
    return subscribe.call(fake.input, () => {});
  };
  parts.lifecycle.methods.init(viewer);
  const coverage = () =>
    draw.find('bikeshare:') &&
    [...draw.sets.values()].find(
      (set) => !set.disposed && set.spec.id.endsWith(':coverage'),
    );
  return {
    state,
    parts,
    owners,
    flights,
    coverage,
    click: (hit) => clicks.at(-1)({ drawHit: hit }),
    async moveTo(height) {
      camera.height = height;
      await parts.viewport.runProximityCheck();
    },
    enable: () => parts.lifecycle.methods.enable(viewer),
    disable: () => parts.lifecycle.methods.disable(),
  };
}

test('every covered city has a marker, shown only while the layer is on and too high for stations', async () => {
  const layer = makeLayer();
  const set = layer.coverage();
  assert.equal(set.items.size, GBFS_CITY_REGISTRY.length);
  assert.equal(set.show, false, 'hidden while the layer is off');
  layer.enable();
  await layer.moveTo(18_000_000);
  assert.equal(set.show, true, 'the globe shows where bike share is');
  await layer.moveTo(20_000);
  assert.equal(
    set.show,
    false,
    'stations take over below the activation height',
  );
  await layer.moveTo(18_000_000);
  assert.equal(set.show, true);
  layer.disable();
  assert.equal(set.show, false, 'gone with the layer');
});

test('a marker belongs to the layer and its click flies straight down into the city', async () => {
  const layer = makeLayer();
  layer.enable();
  await layer.moveTo(18_000_000);
  const city = GBFS_CITY_REGISTRY.find(
    (each) => each.id === 'boston-bluebikes',
  );
  const id = `city:${city.id}`;
  assert.equal(layer.owners.get('bikeshare')(id), true);
  assert.equal(layer.owners.get('bikeshare')('city:nowhere'), false);
  const navigated = [];
  layer.parts.lifecycle.methods.attachShellServices({
    runNavigation: (navigate) => {
      navigated.push('explicit');
      return navigate();
    },
  });
  layer.click({ set: layer.coverage().spec.id, id });
  assert.deepEqual(navigated, ['explicit'], 'an explicit camera action');
  assert.equal(layer.flights.length, 1);
  const { destination, options } = layer.flights[0];
  assert.deepEqual(destination, {
    lon: city.centerLon,
    lat: city.centerLat,
    height: COVERAGE_FLY_HEIGHT_M,
  });
  assert.equal(options.orientation.pitch, -Math.PI / 2);
  assert.ok(COVERAGE_FLY_HEIGHT_M < 48_000, 'below the activation height');
});
