import '../../../testSupport/registerDom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import {
  drawImportedSource,
  measureImportImages,
  planImportedSource,
} from './navaraStory.js';

// happy-dom has no 2D canvas; the circle atlas only needs to draw.
globalThis.HTMLCanvasElement.prototype.getContext = () => ({
  beginPath() {},
  arc() {},
  fill() {},
  stroke() {},
});

const degrees = (...pairs) => Cesium.Cartesian3.fromDegreesArray(pairs.flat());

/** A file's data source as Cesium's loaders build one. */
function importedSource() {
  const source = new Cesium.CustomDataSource('file');
  const amber = Cesium.Color.fromCssColorString('#ffb547');
  source.entities.add({
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(
        degrees([0, 0], [1, 0], [1, 1], [0, 1]),
        [
          new Cesium.PolygonHierarchy(
            degrees([0.2, 0.2], [0.4, 0.2], [0.4, 0.4]),
          ),
        ],
      ),
      material: amber.withAlpha(0.25),
    },
  });
  source.entities.add({
    polyline: { positions: degrees([0, 0], [2, 2]), width: 3, material: amber },
  });
  source.entities.add({
    polyline: { positions: degrees([1, 0], [2, 1]), width: 3, material: amber },
  });
  source.entities.add({
    position: Cesium.Cartesian3.fromDegrees(0.5, 0.5),
    point: { pixelSize: 10, color: Cesium.Color.RED },
  });
  // Two pins sharing one image, one with a label Navara cannot draw.
  for (const lon of [3, 4])
    source.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, 0),
      billboard: { image: 'data:image/png;base64,AAAA', scale: 0.5 },
      ...(lon === 3 ? { label: { text: 'Pin' } } : {}),
    });
  source.entities.add({
    position: Cesium.Cartesian3.fromDegrees(5, 0),
    model: { uri: 'model.glb' },
  });
  source.entities.add({
    show: false,
    position: Cesium.Cartesian3.fromDegrees(6, 0),
    point: { pixelSize: 4 },
  });
  return source;
}

function fakeView() {
  const sources = [];
  const layers = [];
  return {
    sources,
    layers,
    view: {
      addSource(config) {
        const source = {
          config,
          deleted: false,
          delete: () => (source.deleted = true),
        };
        sources.push(source);
        return source;
      },
      addLayer(config) {
        const layer = {
          config,
          updates: [],
          deleted: false,
          update: (next) => layer.updates.push(next),
          delete: () => (layer.deleted = true),
        };
        layers.push(layer);
        return layer;
      },
    },
  };
}

test('an imported file plans fills, lines, points and pins, and counts what Navara leaves out', () => {
  const plan = planImportedSource(importedSource());
  assert.equal(plan.fills.size, 1);
  const [fill] = plan.fills.values();
  assert.equal(fill.color, '#ffb547');
  assert.ok(Math.abs(fill.opacity - 0.25) < 1e-6);
  const [polygon] = fill.features;
  assert.equal(polygon.geometry.coordinates.length, 2, 'outer ring and hole');
  assert.deepEqual(
    polygon.geometry.coordinates[0][0].map((v) => Math.round(v)),
    polygon.geometry.coordinates[0].at(-1).map((v) => Math.round(v)),
    'rings close',
  );
  assert.equal(plan.lines.size, 1, 'lines of one paint share a group');
  assert.equal([...plan.lines.values()][0].features.length, 2);
  assert.equal(plan.points.length, 1);
  assert.equal(plan.images.size, 1, 'pins sharing an image share a set');
  assert.equal([...plan.images.values()][0].features.length, 2);
  assert.deepEqual(plan.undrawn, { label: 1, model: 1 });
  assert.equal(plan.drawn, 6, 'the hidden point is not drawn');
});

test('the Navara drawing builds vector layers and sprite sets, follows the row and lets go', () => {
  const engine = createFakeEngine({ kind: 'navara' });
  const { view, sources, layers } = fakeView();
  const drawing = drawImportedSource(engine, { view }, importedSource());
  assert.deepEqual(drawing.report, {
    drawn: 6,
    undrawn: 2,
    kinds: { label: 1, model: 1 },
  });
  assert.equal(sources.length, 2);
  assert.deepEqual(
    layers.map((layer) =>
      Object.keys(layer.config).filter((k) => k !== 'type' && k !== 'source'),
    ),
    [['polygon'], ['polyline']],
  );
  assert.equal(layers[0].config.polygon.clampToGround, true);
  assert.equal(layers[0].config.polygon.color, 0xffb547);
  assert.equal(layers[1].config.polyline.width, 3);
  const sets = engine.movers.list();
  assert.deepEqual(
    sets.map(({ count }) => count).sort(),
    [1, 2],
    'one point (no outline) and two pins',
  );
  drawing.setShow(false);
  assert.equal(layers[0].updates.at(-1).polygon.show, false);
  assert.ok(engine.movers.list().every(({ count }) => count === 0));
  drawing.setShow(true);
  assert.deepEqual(
    engine.movers
      .list()
      .map(({ count }) => count)
      .sort(),
    [1, 2],
  );
  drawing.refresh();
  drawing.destroy();
  assert.ok(sources.every((s) => s.deleted) && layers.every((l) => l.deleted));
  assert.equal(engine.movers.list().length, 0);
});

test('pin images are measured from the file itself, never fetched from elsewhere', async () => {
  const source = new Cesium.CustomDataSource('file');
  for (const image of [
    'data:image/png;base64,AAAA',
    'blob:http://127.0.0.1/abc',
    'https://example.invalid/icon.png',
  ])
    source.entities.add({
      position: Cesium.Cartesian3.fromDegrees(0, 0),
      billboard: { image },
    });
  const loaded = [];
  const sizes = await measureImportImages(source, {
    createImage: () => {
      const image = {
        naturalWidth: 12,
        naturalHeight: 20,
        decode: async () => loaded.push(image.src),
      };
      return image;
    },
  });
  assert.deepEqual(loaded.sort(), [
    'blob:http://127.0.0.1/abc',
    'data:image/png;base64,AAAA',
  ]);
  const plan = planImportedSource(source, { sizes });
  assert.equal(plan.images.get('data:image/png;base64,AAAA').sizePx, 20);
  assert.equal(plan.images.get('https://example.invalid/icon.png').sizePx, 32);
});
