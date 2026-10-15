import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { getSanAntonioDataset } from './config.js';
import { createSanAntonioRenderer } from './renderer.js';

// Cesium normally obtains these values while creating a WebGL Context.
// These ownership tests instantiate primitives without a browser context;
// the separate browser gate validates actual rendering and picking.
let lineWidthLimits;
let terrainHeights;
test.before(() => {
  lineWidthLimits = [
    Cesium.ContextLimits._minimumAliasedLineWidth,
    Cesium.ContextLimits._maximumAliasedLineWidth,
  ];
  Cesium.ContextLimits._minimumAliasedLineWidth = 1;
  Cesium.ContextLimits._maximumAliasedLineWidth = 1;
  terrainHeights = Cesium.ApproximateTerrainHeights._terrainHeights;
  // Exercise the real CPU geometry worker path with Cesium's bundled height
  // table, without introducing a network request into these unit tests.
  Cesium.ApproximateTerrainHeights._terrainHeights = JSON.parse(
    readFileSync(
      new URL(
        './Source/Assets/approximateTerrainHeights.json',
        import.meta.resolve('@cesium/engine'),
      ),
      'utf8',
    ),
  );
});
test.after(() => {
  [
    Cesium.ContextLimits._minimumAliasedLineWidth,
    Cesium.ContextLimits._maximumAliasedLineWidth,
  ] = lineWidthLimits;
  Cesium.ApproximateTerrainHeights._terrainHeights = terrainHeights;
});

const dataset = (kind) => getSanAntonioDataset('san-antonio-' + kind);
const point = (id = 1) => ({
  id: 'san-antonio-trailheads:' + id,
  name: 'Trailhead ' + id,
  geometry: { type: 'Point', coordinates: [-98.5, 29.4] },
});
const line = (id = 1) => ({
  id: 'san-antonio-trails:' + id,
  geometry: {
    type: 'LineString',
    coordinates: [
      [-98.5, 29.4],
      [-98.49, 29.4],
    ],
  },
});
function viewer(dataSources = new Cesium.DataSourceCollection()) {
  return {
    scene: {
      groundPrimitives: new Cesium.PrimitiveCollection(),
      requestRender() {},
    },
    dataSources,
  };
}
function deferredSources() {
  const items = new Set();
  const pending = [];
  return {
    items,
    pending,
    add(source) {
      return new Promise((resolve) => {
        pending.push(() => {
          items.add(source);
          resolve(source);
        });
      });
    },
    remove(source) {
      return items.delete(source);
    },
  };
}

test('4976 static segments share one ground batch and never create entity visualizers', async () => {
  const host = viewer();
  const renderer = createSanAntonioRenderer({
    viewer: host,
    dataset: dataset('trails'),
  });
  await renderer.replace(Array.from({ length: 4976 }, (_, i) => line(i)));
  assert.equal(host.scene.groundPrimitives.length, 1);
  assert.equal(host.dataSources.length, 0);
  const primitive = host.scene.groundPrimitives.get(0);
  assert.ok(primitive instanceof Cesium.GroundPolylinePrimitive);
  assert.equal(primitive.id, 'san-antonio-trails');
  assert.equal(primitive.geometryInstances.length, 4976);
  assert.deepEqual(primitive.geometryInstances[12].id, {
    id: 'san-antonio-trails:12',
    part: 0,
  });
  assert.equal(primitive.show, false);
  renderer.setVisible(true);
  assert.equal(primitive.show, true);
  renderer.destroy();
  assert.equal(host.scene.groundPrimitives.length, 0);
  assert.equal(primitive.isDestroyed(), true);
  renderer.destroy();
});

test('multipart parks keep both islands, the hole hierarchy, and boundary lines', async () => {
  const square = (lon, lat, size) => [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ];
  const host = viewer();
  const renderer = createSanAntonioRenderer({
    viewer: host,
    dataset: dataset('parks'),
  });
  const outer = square(-98.5, 29.4, 0.02);
  // Repeating a closing vertex is valid input. Cesium's loop miter requires
  // all redundant closing copies to be removed, not merely the final one.
  outer.push(outer[0].slice(), outer[0].slice());
  await renderer.replace([
    {
      id: 'san-antonio-parks:7',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [outer, square(-98.494, 29.406, 0.008)],
          [square(-98.45, 29.4, 0.005)],
        ],
      },
    },
  ]);
  assert.equal(host.scene.groundPrimitives.length, 2);
  const fill = host.scene.groundPrimitives.get(0);
  const boundary = host.scene.groundPrimitives.get(1);
  assert.equal(fill.geometryInstances.length, 2);
  assert.equal(boundary.geometryInstances.length, 3);
  // Check the actual Cesium geometry handed to its triangulator, not just
  // the normalized input: omitting holes here would paint excluded land.
  assert.equal(
    fill.geometryInstances[0].geometry._polygonHierarchy.holes.length,
    1,
  );
  assert.equal(
    fill.geometryInstances[0].geometry._polygonHierarchy.positions.length,
    7,
    'the fill hierarchy retains the complete input ring',
  );
  assert.equal(outer.length, 7, 'renderer must not mutate source geometry');
  for (const instance of [
    ...fill.geometryInstances,
    ...boundary.geometryInstances,
  ])
    assert.equal(instance.id.id, 'san-antonio-parks:7');
  for (const instance of boundary.geometryInstances) {
    // Closed GeoJSON rings must be converted to looped paths without a
    // repeated terminal vertex. Constructor-only tests miss the zero miter
    // that used to stop the real render loop in createGroundPolylineGeometry.
    const geometry = Cesium.GroundPolylineGeometry.createGeometry(
      instance.geometry,
    );
    assert.ok(geometry.indices.length > 0);
    for (const attribute of Object.values(geometry.attributes))
      if (attribute?.values) assert.ok(attribute.values.every(Number.isFinite));
  }
  renderer.destroy();
});

test('trailhead points are clamped, pickable by row id, and fully removed on destroy', async () => {
  const host = viewer();
  const renderer = createSanAntonioRenderer({
    viewer: host,
    dataset: dataset('trailheads'),
  });
  await renderer.replace([point()]);
  assert.equal(host.scene.groundPrimitives.length, 0);
  assert.equal(host.dataSources.length, 1);
  const source = host.dataSources.get(0);
  assert.equal(source.name, 'san-antonio-trailheads');
  const entity = source.entities.getById('san-antonio-trailheads:1');
  assert.equal(
    entity.point.heightReference.getValue(),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.equal(source.show, false);
  renderer.setVisible(true);
  assert.equal(source.show, true);
  renderer.setVisible(false);
  assert.equal(source.show, false);
  renderer.destroy();
  assert.equal(host.dataSources.length, 0);
  assert.equal(source.entities.values.length, 0);
});

test('destroy during Cesium deferred add compensates after the late insertion', async () => {
  const sources = deferredSources();
  const host = viewer(sources);
  const renderer = createSanAntonioRenderer({
    viewer: host,
    dataset: dataset('trailheads'),
  });
  const loading = renderer.replace([point()]);
  renderer.destroy();
  sources.pending[0]();
  assert.equal(await loading, false);
  assert.equal(sources.items.size, 0);
  assert.equal(renderer.getStats().count, 0);
});

test('a superseded point replacement cannot clear or overwrite the successor', async () => {
  const sources = deferredSources();
  const renderer = createSanAntonioRenderer({
    viewer: viewer(sources),
    dataset: dataset('trailheads'),
  });
  const oldLoad = renderer.replace([point(1)]);
  const newLoad = renderer.replace([point(2), point(3)]);
  sources.pending[1]();
  assert.equal(await newLoad, true);
  sources.pending[0]();
  assert.equal(await oldLoad, false);
  assert.equal(sources.items.size, 1);
  assert.equal(renderer.getStats().count, 2);
  assert.equal(
    [...sources.items][0].entities.values[0].id,
    'san-antonio-trailheads:2',
  );
  renderer.destroy();
  assert.equal(sources.items.size, 0);
});

test('a failed primitive replacement releases its partial add and keeps the prior display', async () => {
  const host = viewer();
  const renderer = createSanAntonioRenderer({
    viewer: host,
    dataset: dataset('trails'),
  });
  await renderer.replace([line(1)]);
  const previous = host.scene.groundPrimitives.get(0);
  const add = host.scene.groundPrimitives.add.bind(host.scene.groundPrimitives);
  host.scene.groundPrimitives.add = (primitive) => {
    add(primitive);
    throw new Error('host add listener failed');
  };
  await assert.rejects(renderer.replace([line(2)]), /host add listener failed/);
  assert.equal(host.scene.groundPrimitives.length, 1);
  assert.equal(host.scene.groundPrimitives.get(0), previous);
  assert.equal(previous.isDestroyed(), false);
  renderer.destroy();
});
