import test from 'node:test';
import assert from 'node:assert/strict';
import { drawImportedFile } from './geoImportDisplay.js';
import { emptyRecords } from './geoImportRecords.js';
// A globe engine double that records what drawImportedFile asks of it.
function recordingEngine() {
  const calls = {
    meshes: [],
    groundSets: [],
    lines: [],
    layers: [],
    moverSets: [],
  };
  const handle = (extra = {}) => ({
    destroy() {},
    show() {},
    commit() {},
    ...extra,
  });
  const engine = {
    calls,
    render: { request() {} },
    meshes: {
      createMesh(options) {
        calls.meshes.push(options);
        return handle();
      },
    },
    ground: {
      createSet(options) {
        const rec = { options, items: [] };
        calls.groundSets.push(rec);
        return handle({ replace: (items) => (rec.items = items) });
      },
    },
    lines: {
      createLine(options) {
        const rec = { options, positions: null };
        calls.lines.push(rec);
        return handle({ setPositions: (p) => (rec.positions = p) });
      },
    },
    imagery: {
      surface: () => 'globe',
      createLayer(options) {
        calls.layers.push(options);
        return handle();
      },
    },
    movers: {
      createSet(options) {
        const rec = { options, items: [] };
        calls.moverSets.push(rec);
        return handle({
          set: (i, f) => (rec.items[i] = { ...rec.items[i], ...f }),
          setCount() {},
        });
      },
    },
    surface: { terrainHeightSupported: false, clampToHeightSupported: false },
    camera: { height: () => 1e7, livePosition: { x: 1, y: 0, z: 0 } },
    projector: { horizonVisible: () => true },
    frames: { preRender: { addEventListener: () => () => {} } },
  };
  return engine;
}
const createCanvas = () => ({
  width: 0,
  height: 0,
  getContext: () =>
    new Proxy({}, { get: (_, key) => (key in {} ? undefined : () => {}) }),
});
const draw = (engine, records, extra = {}) =>
  drawImportedFile(engine, records, {
    createCanvas,
    loadImage: async () => ({ width: 32, height: 32 }),
    pixelRatio: 2,
    ...extra,
  });
const box = { west: 10, south: 10, east: 11, north: 11 };

test('a raised polygon fill keeps its heights (not a ground fill)', async () => {
  const engine = recordingEngine();
  await draw(engine, {
    ...emptyRecords(),
    polygons: [
      {
        rings: [
          [
            [0, 0, 1000],
            [1, 0, 1000],
            [1, 1, 1000],
          ],
        ],
        raised: true,
        fill: [1, 0, 0, 1],
        outline: { color: [1, 1, 1, 1], widthPx: 1 },
      },
    ],
  });
  const groundFills = engine.calls.groundSets
    .filter((s) => s.options.kind === 'polygon')
    .flatMap((s) => s.items);
  assert.equal(
    groundFills.length,
    0,
    'the 1000 m fill is draped on the ground',
  );
  assert.equal(engine.calls.meshes.length, 1);
  assert.equal(engine.calls.meshes[0].positions[0], 6379137);
  assert.equal(engine.calls.meshes[0].indices.length, 3);
});
