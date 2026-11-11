import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../geo/index.js';
import { createMarker } from './marker.js';
import { MARKER_SPRITE_ORDER, POSITION_PICK_ID } from './policy.js';
import { STREET_LEVEL_MAPS } from '../../testSupport/streetLevelFakes.mjs';

const SET = 'street-level:marker';

/** The marker on the display of `harness` (an engine looking down on Sacramento). */
function setup(harness) {
  const state = {
    services: {},
    map: harness.map,
    marker: { collection: null, billboard: null, look: null },
  };
  const marker = createMarker({ state });
  marker.ensure(harness.map);
  /** The marker's drawn instance after a frame, or undefined. */
  const drawn = () => {
    harness.frame();
    return harness.spritesShown(SET)[0];
  };
  return { state, marker, drawn };
}

const degreesOf = (position) => {
  const carto = geo.cartographic.fromCartesian(position);
  return {
    lon: geo.math.toDegrees(carto.longitude),
    lat: geo.math.toDegrees(carto.latitude),
    height: carto.height,
  };
};

for (const create of STREET_LEVEL_MAPS) {
  const name = create().name;

  test(`the photo marker is hidden behind the globe, and shows from its side (${name})`, () => {
    const harness = create();
    const { marker, drawn } = setup(harness);
    // Placed on the far side of the Earth from the camera.
    marker.set({ lon: 58.51, lat: -38.58 }, 90);
    assert.equal(drawn(), undefined, 'not drawn through the globe');
    assert.equal(harness.moverSets(SET).length, 1, 'but placed');
    // Moved to the camera's side: it shows.
    marker.set({ lon: -121.4944, lat: 38.5816 }, 0);
    assert.ok(drawn());
    marker.clear();
    assert.equal(drawn(), undefined);
    marker.destroy();
    assert.equal(harness.moverSets(SET).length, 0, 'nothing left drawn');
  });

  test(`the marker sits on the ground, over the scene, turned to the bearing (${name})`, () => {
    const harness = create();
    const { state, marker, drawn } = setup(harness);
    marker.set({ lon: -121.4944, lat: 38.5816 }, 90);
    let sprite = drawn();
    const [set] = harness.moverSets(SET);
    assert.equal(set.options.kind, 'sprite');
    assert.equal(set.options.depthTest, 'always');
    assert.equal(set.options.order, MARKER_SPRITE_ORDER);
    assert.equal(set.options.pickable, true);
    assert.equal(set.options.sprite.sizePx, 40);
    assert.equal(sprite.pickId, POSITION_PICK_ID);
    const placed = degreesOf(sprite.position);
    assert.ok(Math.abs(placed.lon + 121.4944) < 1e-9);
    assert.ok(Math.abs(placed.height) < 1e-6, 'on the terrain (0 m here)');
    // Looking straight down, north up: east is a quarter turn clockwise.
    assert.ok(Math.abs(sprite.rotation + Math.PI / 2) < 1e-6);
    // Moving it keeps the same sprite.
    const row = state.marker.billboard;
    marker.set({ lon: -121.4945, lat: 38.5817 }, 180);
    assert.equal(state.marker.billboard, row);
    sprite = drawn();
    assert.ok(Math.abs(degreesOf(sprite.position).lon + 121.4945) < 1e-9);
    assert.ok(Math.abs(Math.abs(sprite.rotation) - Math.PI) < 1e-4);
    marker.setVisible(false);
    assert.equal(drawn(), undefined, 'hidden with the layer');
    marker.setVisible(true);
    assert.ok(drawn());
  });
}

test('a Street View photo gets a blue view cone; a Mapillary photo GEV’s pin', () => {
  const harness = STREET_LEVEL_MAPS[0]();
  const { state, marker, drawn } = setup(harness);
  const streetView = { kind: 'view-cone', color: '#4285f4' };
  marker.set({ lon: -121.4944, lat: 38.5816 }, 45, streetView);
  const cone = state.marker.billboard;
  assert.equal(cone.imageKey, 'sl-position:view-cone:#4285f4');
  assert.equal(cone.sizePx, 48);
  assert.ok(
    Math.abs(drawn().rotation + Math.PI / 4) < 1e-6,
    'it turns with the view',
  );
  // Dragging the panorama keeps the look and the sprite.
  marker.set({ lon: -121.4944, lat: 38.5816 }, 90, streetView);
  assert.equal(state.marker.billboard, cone);
  // A Mapillary photo next (its provider has no marker): the pin.
  marker.set({ lon: -121.4944, lat: 38.5816 }, 90, undefined);
  assert.equal(state.marker.billboard.imageKey, 'sl-position:pin');
  drawn();
  assert.deepEqual(
    harness.moverSets(SET).map((set) => set.id),
    [`${SET}:sl-position:pin`],
    'the cone is gone',
  );
});

test('without a display the marker draws nothing and does not throw', () => {
  const state = {
    services: {},
    map: null,
    marker: { collection: null, billboard: null, look: null },
  };
  const marker = createMarker({ state });
  marker.ensure(null);
  marker.set({ lon: 0, lat: 0 }, 0);
  marker.setVisible(true);
  marker.destroy();
  assert.equal(state.marker.collection, null);
});
