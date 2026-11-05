import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  CYAN,
  Rgba,
  WHITE,
  constantRgba,
  nearFarScale,
  rgbaFromCss,
} from './color.js';

const fields = (color) => [color.red, color.green, color.blue, color.alpha];

test('css colours equal Cesium.Color.fromCssColorString bit for bit', () => {
  for (const css of ['#FFB800', '#DCEEFF', '#00d4ff', '#39d0ff', '#ffd16680']) {
    assert.deepEqual(
      fields(rgbaFromCss(css)),
      fields(Cesium.Color.fromCssColorString(css)),
      css,
    );
  }
  assert.throws(() => rgbaFromCss('teal'), /Unsupported colour/);
});

test('the named constants equal Cesium.Color.WHITE and CYAN', () => {
  assert.deepEqual(fields(WHITE), fields(Cesium.Color.WHITE));
  assert.deepEqual(fields(CYAN), fields(Cesium.Color.CYAN));
  assert.ok(Object.isFrozen(WHITE) && Object.isFrozen(CYAN));
  assert.ok(CYAN.equals(Cesium.Color.CYAN));
});

test('withAlpha, clone and equals behave as Cesium.Color', () => {
  const amber = rgbaFromCss('#FFB800');
  const cesium = Cesium.Color.fromCssColorString('#FFB800');
  assert.deepEqual(
    fields(amber.withAlpha(0.45)),
    fields(cesium.withAlpha(0.45)),
  );
  const scratch = new Rgba();
  assert.equal(amber.withAlpha(0.2, scratch), scratch);
  assert.deepEqual(fields(scratch), fields(cesium.withAlpha(0.2)));
  assert.deepEqual(
    fields(CYAN.withAlpha(0)),
    fields(Cesium.Color.CYAN.withAlpha(0)),
  );
  assert.ok(amber.clone().equals(amber));
  assert.notEqual(amber.clone(), amber);
  assert.deepEqual(amber.rgba(), fields(cesium));
  assert.ok(Object.isFrozen(constantRgba(1, 0, 0)));
});

test('Cesium billboards and models take an Rgba as their colour', () => {
  const collection = new Cesium.BillboardCollection();
  const billboard = collection.add({
    position: Cesium.Cartesian3.fromDegrees(0, 0, 10),
    color: rgbaFromCss('#FFB800').withAlpha(0.5),
    scaleByDistance: nearFarScale(1000, 3, 8_000_000, 0.5),
  });
  assert.ok(billboard.color instanceof Cesium.Color);
  assert.ok(
    billboard.color.equals(
      Cesium.Color.fromCssColorString('#FFB800').withAlpha(0.5),
    ),
  );
  assert.ok(billboard.scaleByDistance instanceof Cesium.NearFarScalar);
  assert.ok(
    Cesium.NearFarScalar.equals(
      billboard.scaleByDistance,
      new Cesium.NearFarScalar(1000, 3, 8_000_000, 0.5),
    ),
  );
  billboard.color = CYAN;
  assert.ok(billboard.color.equals(Cesium.Color.CYAN));
  assert.notEqual(billboard.color, CYAN, 'the billboard keeps its own copy');
  collection.destroy();
});

test('CSS serialization keeps native byte rounding and alpha formatting', async () => {
  const { constantRgba } = await import('./color.js');
  for (const values of [
    [0.1, 0.5, 1, 1],
    [1, 0, 0.3, 0.42],
    [0, 0, 0, 0],
  ])
    assert.equal(
      constantRgba(...values).toCssColorString(),
      new Cesium.Color(...values).toCssColorString(),
    );
});
