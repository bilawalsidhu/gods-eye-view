import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { dimEntityColors } from './sceneOpacity.js';

const RED = Cesium.Color.RED;

/** A data source with a polygon (material + outline) and a point entity. */
function build() {
  const dataSource = new Cesium.CustomDataSource('opacity-test');
  const polygon = dataSource.entities.add(
    new Cesium.Entity({
      id: 'zone',
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray([0, 0, 1, 0, 1, 1]),
        ),
        material: new Cesium.ColorMaterialProperty(RED.withAlpha(0.5)),
        outlineColor: Cesium.Color.BLUE.withAlpha(0.8),
      },
    }),
  );
  const point = dataSource.entities.add(
    new Cesium.Entity({
      id: 'dot',
      position: Cesium.Cartesian3.fromDegrees(0, 0),
      point: { color: Cesium.Color.LIME, pixelSize: 6 },
    }),
  );
  return { dataSource, polygon, point };
}

const alphaOf = (property) => property.getValue().alpha;
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !~ ${expected}`);

test('dims the colour of a material, an outline and a point', () => {
  const { dataSource, polygon, point } = build();
  assert.ok(dimEntityColors(dataSource, 0.4) > 0);
  near(alphaOf(polygon.polygon.material.color), 0.2);
  near(alphaOf(polygon.polygon.outlineColor), 0.32);
  near(alphaOf(point.point.color), 0.4);
  // Hue is untouched.
  assert.equal(point.point.color.getValue().green, 1);
});

test('repeated passes scale the original, not the dimmed colour', () => {
  const { dataSource, polygon } = build();
  dimEntityColors(dataSource, 0.5);
  dimEntityColors(dataSource, 0.5);
  dimEntityColors(dataSource, 0.8);
  near(alphaOf(polygon.polygon.material.color), 0.4);
  dimEntityColors(dataSource, 0.2);
  near(alphaOf(polygon.polygon.material.color), 0.1);
});

test('a pass at the same opacity writes nothing', () => {
  const { dataSource } = build();
  assert.ok(dimEntityColors(dataSource, 0.6) > 0);
  assert.equal(dimEntityColors(dataSource, 0.6), 0);
});

test('1 restores the colours the layer drew; a layer at 1 is untouched', () => {
  const { dataSource, polygon, point } = build();
  assert.equal(dimEntityColors(dataSource, 1), 0);
  dimEntityColors(dataSource, 0.3);
  assert.ok(dimEntityColors(dataSource, 1) > 0);
  assert.equal(alphaOf(polygon.polygon.material.color), 0.5);
  assert.equal(alphaOf(polygon.polygon.outlineColor), 0.8);
  assert.equal(alphaOf(point.point.color), 1);
  assert.equal(dimEntityColors(dataSource, 1), 0);
});

test('a colour the layer rewrites becomes the new base', () => {
  const { dataSource, polygon } = build();
  dimEntityColors(dataSource, 0.5);
  // The layer recolours in place while dimmed.
  polygon.polygon.material.color.setValue(RED.withAlpha(0.9));
  dimEntityColors(dataSource, 0.5);
  near(alphaOf(polygon.polygon.material.color), 0.45);
  dimEntityColors(dataSource, 1);
  assert.equal(alphaOf(polygon.polygon.material.color), 0.9);
});

test('entities added after a pass are dimmed by the next pass', () => {
  const { dataSource } = build();
  dimEntityColors(dataSource, 0.5);
  const late = dataSource.entities.add(
    new Cesium.Entity({
      id: 'late',
      position: Cesium.Cartesian3.fromDegrees(1, 1),
      point: { color: Cesium.Color.WHITE },
    }),
  );
  assert.equal(alphaOf(late.point.color), 1);
  dimEntityColors(dataSource, 0.5);
  assert.equal(alphaOf(late.point.color), 0.5);
});

test('clamps the fraction and treats a non-number as 1', () => {
  const { dataSource, point } = build();
  dimEntityColors(dataSource, -4);
  assert.equal(alphaOf(point.point.color), 0);
  dimEntityColors(dataSource, 9);
  assert.equal(alphaOf(point.point.color), 1);
  dimEntityColors(dataSource, 0.5);
  dimEntityColors(dataSource, Number.NaN);
  assert.equal(alphaOf(point.point.color), 1);
});

test('leaves dynamic colours, colourless graphics and non-sources alone', () => {
  const dataSource = new Cesium.CustomDataSource('opacity-skip');
  const dynamic = dataSource.entities.add(
    new Cesium.Entity({
      id: 'dynamic',
      position: Cesium.Cartesian3.fromDegrees(0, 0),
      point: {
        color: new Cesium.CallbackProperty(() => {
          throw new Error('must not be evaluated');
        }, false),
      },
      billboard: { image: 'x.png' },
    }),
  );
  assert.equal(dimEntityColors(dataSource, 0.5), 0);
  assert.equal(dynamic.billboard.color, undefined);
  assert.equal(dimEntityColors({}, 0.5), 0);
  assert.equal(dimEntityColors(null, 0.5), 0);
  assert.equal(dimEntityColors(undefined, 0.5), 0);
});

test('one change notification covers the whole pass', () => {
  const { dataSource } = build();
  let changes = 0;
  dataSource.entities.collectionChanged.addEventListener(() => changes++);
  dimEntityColors(dataSource, 0.5);
  assert.ok(changes <= 1, `collectionChanged fired ${changes} times`);
});

test('events resume when a colour write throws', () => {
  const { dataSource, point } = build();
  const store = dataSource.entities;
  let resumed = 0;
  const original = store.resumeEvents.bind(store);
  store.resumeEvents = () => {
    resumed++;
    original();
  };
  point.point.color.setValue = () => {
    throw new Error('write failed');
  };
  assert.throws(() => dimEntityColors(dataSource, 0.5), /write failed/);
  assert.equal(resumed, 1);
});
