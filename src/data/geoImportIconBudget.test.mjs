import test from 'node:test';
import assert from 'node:assert/strict';
import { drawImportedFile } from './geoImportDisplay.js';
import { emptyRecords } from './geoImportRecords.js';
// A globe engine double that records what drawImportedFile asks of it.
function recordingEngine() {
  const calls = { groundSets: [], lines: [], layers: [], moverSets: [] };
  const handle = (extra = {}) => ({
    destroy() {},
    show() {},
    commit() {},
    ...extra,
  });
  const engine = {
    calls,
    render: { request() {} },
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

test('icon variants of one file stay within a canvas budget', async () => {
  const engine = recordingEngine();
  const points = [];
  for (let i = 0; i < 2000; i++)
    points.push({
      position: [1, 2, 0],
      altitude: 'ground',
      icon: { image: { url: 'blob:icon' }, scale: 10 + i / 1000 },
    });
  let bytes = 0;
  await draw(
    engine,
    { ...emptyRecords(), points },
    {
      createCanvas: () => {
        const c = createCanvas();
        return new Proxy(c, {
          set(target, key, value) {
            if (key === 'height') bytes += target.width * value * 4;
            target[key] = value;
            return true;
          },
        });
      },
    },
  );
  assert.ok(bytes <= 256 * 2 ** 20, `canvas bytes ${bytes / 2 ** 20} MiB`);
});
