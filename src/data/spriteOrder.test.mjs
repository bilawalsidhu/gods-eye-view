import test from 'node:test';
import assert from 'node:assert/strict';
import * as sprites from './spriteOrder.js';
import { SPRITE_LAYER_ORDER, spriteDrawOrder } from './spriteOrder.js';
import { createAircraftIcons } from './aircraftIconLayer.js';
import { createRendering as createBikeshareRendering } from '../layers/bikeshare/rendering.js';
import { createRendering as createCctvRendering } from '../layers/cctv/rendering.js';
import { createRendering as createFirmsRendering } from '../layers/firms/rendering.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';

test('each sprite layer draws at its place in the order, flights on top', () => {
  assert.deepEqual(
    SPRITE_LAYER_ORDER.map(spriteDrawOrder),
    SPRITE_LAYER_ORDER.map((_, i) => i - SPRITE_LAYER_ORDER.length),
  );
  assert.equal(
    Math.max(...SPRITE_LAYER_ORDER.map(spriteDrawOrder)),
    spriteDrawOrder('flights'),
  );
  assert.ok(spriteDrawOrder('military') > spriteDrawOrder('ais'));
  assert.ok(spriteDrawOrder('ais') > spriteDrawOrder('transit'));
  assert.ok(spriteDrawOrder('transit') > spriteDrawOrder('cctv'));
  // Any other layer stays at the default, over every sprite layer.
  assert.equal(spriteDrawOrder('flights'), -1);
  assert.equal(spriteDrawOrder('street-level:marker'), 0);
  assert.equal(spriteDrawOrder(undefined), 0);
});

/** A viewer double with a fake draw port, unbound after the test. */
function drawnViewer(t) {
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  t.after(unbind);
  return { viewer, draw };
}

test('flights and military make their icon sets at their draw orders', (t) => {
  const { viewer, draw } = drawnViewer(t);
  for (const layerId of ['flights', 'military']) {
    const icons = createAircraftIcons({
      state: {},
      services: { focus: { focusPassIsNeeded: () => false }, sprites },
      parts: {},
      layerId,
      renderDelaySec: 0,
      courseMaxDps: 1,
      cockpitContactSizePx: 4,
    });
    const id = icons._createIcons(viewer);
    assert.equal(draw.set(id).spec.drawOrder, spriteDrawOrder(layerId));
    icons._disposeIcons();
  }
});

test('CCTV, FIRMS and bikeshare make their sprite sets at their draw orders', (t) => {
  const { viewer, draw } = drawnViewer(t);
  const cctv = createCctvRendering({
    state: {},
    services: { focus: {}, sprites },
    parts: {},
    source: {},
  });
  const cctvId = cctv.createCameraIcons(viewer);
  assert.equal(draw.set(cctvId).spec.drawOrder, spriteDrawOrder('cctv'));
  cctv.destroyCameraIcons();

  const layerState = { _viewer: viewer, _enabled: true };
  const firms = createFirmsRendering({
    layerState,
    services: { anchors: {}, sprites },
    components: {},
    config: {
      overlayHost: { setVisible() {}, clearSource() {} },
    },
  });
  firms.ensureDetectionCollections();
  assert.equal(
    draw.set(layerState._icons.id).spec.drawOrder,
    spriteDrawOrder('firms'),
  );
  firms.removeDetectionCollections();

  const bikeState = {};
  const bikeshare = createBikeshareRendering({
    state: bikeState,
    services: { render: {}, sprites },
    parts: {},
    source: {},
  });
  bikeshare.attachSets(viewer);
  assert.equal(
    draw.set(bikeState._stationSet.id).spec.drawOrder,
    spriteDrawOrder('bikeshare'),
  );
  // The selected station's highlight is not a sprite layer.
  assert.equal(draw.set(bikeState._selectedSet.id).spec.drawOrder, undefined);
  bikeshare.detachSets();
});
