import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftRenderPixelRatio,
  aircraftModelPixelSize,
  selectAircraftIconRaster,
} from './aircraftPixels.js';

test('aircraft pixels follow the actual framebuffer, including low mode and capped Retina', () => {
  for (const ratio of [0.6, 1, 1.25, 1.5, 2]) {
    const scene = {
      canvas: { clientWidth: 1440 },
      drawingBufferWidth: 1440 * ratio,
    };
    assert.equal(aircraftRenderPixelRatio(scene), ratio);
    assert.equal(
      aircraftModelPixelSize(scene, 24) / ratio,
      24,
      'fleet minimum keeps its CSS footprint',
    );
    assert.equal(
      aircraftModelPixelSize(scene, 40) / ratio,
      40,
      'tracked minimum keeps its CSS footprint',
    );
  }
  assert.equal(aircraftRenderPixelRatio(), 1);
  assert.equal(
    aircraftRenderPixelRatio({
      canvas: { clientWidth: 0 },
      drawingBufferWidth: 0,
    }),
    1,
  );
});

test('SVG atlas tiers match rendered size and keep hysteresis around zoom boundaries', () => {
  assert.equal(selectAircraftIconRaster(24), 32);
  assert.equal(selectAircraftIconRaster(48), 64);
  assert.equal(selectAircraftIconRaster(90), 96);
  assert.equal(selectAircraftIconRaster(150), 192);
  assert.equal(selectAircraftIconRaster(70, 96), 96);
  assert.equal(selectAircraftIconRaster(55, 96), 64);
  assert.equal(selectAircraftIconRaster(34, 32), 32);
  assert.equal(selectAircraftIconRaster(37, 32), 64);
  assert.equal(selectAircraftIconRaster(110, 192), 192);
  assert.equal(selectAircraftIconRaster(95, 192), 96);
  assert.equal(selectAircraftIconRaster(NaN, 96), 96);
});

test('class enrichment preserves a fleet icon tier instead of resetting it to a small texture', async () => {
  const { createRendering: civil } =
    await import('../layers/flights/rendering.js');
  const { createRendering: military } =
    await import('../layers/military/rendering.js');
  const { aircraftIcon } = await import('./aircraftIcons.js');
  for (const createRendering of [civil, military]) {
    const state = {
      records: { data: new Map([['abc123', { klass: 'widebody' }]]) },
      _billboardLimbScale: new WeakMap(),
    };
    const services = {
      militaryRegistry: { isMilitaryIcao: () => false },
      aircraftPresentation: { tr3bIconKind: (_id, klass) => klass },
      camera: {},
      focus: {},
      recession: {},
    };
    const rendering = createRendering({
      flightState: state,
      services,
      parts: {},
    });
    const billboard = { _gevIconPx: 96 };
    rendering._applyFleetBillboardPresentation('abc123', billboard);
    assert.equal(billboard.image, aircraftIcon('widebody', 96));
    assert.equal(
      billboard.width,
      20,
      'raster size does not change the CSS footprint',
    );
  }
});
