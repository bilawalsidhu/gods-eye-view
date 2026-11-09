// In the cockpit, far contacts switch their sprite to cockpitContactDotImage()
// (src/layers/flights/rendering.js, military/rendering.js). The sprite must
// then draw the dot, not keep the aircraft silhouette cell it had before.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { aircraftIcon } from '../../../data/aircraftIcons.js';
import { cockpitContactDotImage } from '../../../data/cockpitContactDot.js';
import { aircraftAtlasLayout, createAircraftDisplay } from './display.js';

// cockpitContactDotImage() draws on a canvas; a stub document gives it a stable data URL.
globalThis.document ??= {
  createElement: () => ({
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
    toDataURL: () => 'data:image/png;base64,COCKPITDOT',
  }),
};

const layout = aircraftAtlasLayout();
const drawAtlas = async () => ({
  canvas: { width: layout.width, height: layout.height },
  cells: layout.cells,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a cockpit contact draws the contact dot, not the aircraft silhouette', async () => {
  const engine = createFakeEngine();
  const display = createAircraftDisplay(engine, {
    layerId: 'flights',
    order: 8,
    headingOffsetDeg: 180,
    drawAtlas,
  });
  await display.whenReady();
  display.fleet.attach();
  const sprite = display.fleet.add({
    position: geo.cartesian3.fromDegrees(-97.7, 30.2, 3000),
    image: aircraftIcon('helicopter'),
    width: 20,
    height: 20,
    scale: 1,
    rotation: 0,
    color: { red: 1, green: 1, blue: 1, alpha: 1 },
    id: 'abc123',
    show: true,
  });
  await settle();
  const cellOf = () => {
    const { store } = engine.fake.moverSet(sprite.gevBank.set.id);
    return store.cellKeys[store.cells[0]];
  };
  assert.equal(cellOf(), 'helicopter@64');
  sprite.image = cockpitContactDotImage();
  sprite.width = 8;
  sprite.height = 8;
  engine.fake.frames(2);
  await settle();
  assert.equal(cellOf(), 'cockpit-dot');
  assert.equal(
    engine.fake.moverSet(sprite.gevBank.set.id).options.sprite.atlas.url,
    cockpitContactDotImage(),
  );
  sprite.image = aircraftIcon('helicopter');
  assert.equal(cellOf(), 'helicopter@64');
  display.destroy();
  engine.destroy();
});

// The dot bank, rebuilt for capacity after its first contact turned back
// into a silhouette, keeps the dot atlas.
test('a regrown cockpit-dot bank keeps the dot atlas', async () => {
  const engine = createFakeEngine();
  const display = createAircraftDisplay(engine, {
    layerId: 'flights',
    order: 8,
    headingOffsetDeg: 180,
    drawAtlas,
  });
  await display.whenReady();
  display.fleet.attach();
  const add = (i) =>
    display.fleet.add({
      position: geo.cartesian3.fromDegrees(-97.7 + i * 0.001, 30.2, 3000),
      image: aircraftIcon('airliner'),
      width: 20,
      height: 20,
      scale: 1,
      rotation: 0,
      color: { red: 1, green: 1, blue: 1, alpha: 1 },
      id: `c${i}`,
      show: true,
    });
  const first = add(0);
  await settle();
  first.image = cockpitContactDotImage(); // far: the dot bank is created from it
  const dotBank = first.gevBank;
  first.image = aircraftIcon('airliner'); // near again: back to the silhouette
  const others = [];
  for (let i = 1; i <= 1100; i++) {
    const s = add(i);
    s.image = cockpitContactDotImage();
    others.push(s);
  }
  engine.fake.frames(2);
  await settle();
  assert.equal(others[0].gevBank, dotBank);
  const url = engine.fake.moverSet(dotBank.set.id).options.sprite.atlas.url;
  assert.equal(
    url,
    cockpitContactDotImage(),
    'the regrown dot bank draws another image',
  );
  display.destroy();
  engine.destroy();
});
