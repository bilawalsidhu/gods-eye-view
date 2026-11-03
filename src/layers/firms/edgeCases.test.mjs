import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createFirmsHeatmapLayer } from './index.js';
import { createFirmsNavaraRenderer } from './render/navara.js';
import { unregisterSpriteCollection } from '../../data/spriteOrder.js';

const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
const FIRE = { lat: 38.5, lon: -121.5 };
// One cluster a few hundred metres across: one cell from orbit, sprites at the fire.
const records = Array.from({ length: 9 }, (_, i) => ({
  lat: FIRE.lat + (i % 3) * 0.002,
  lon: FIRE.lon + Math.floor(i / 3) * 0.002,
  frp: 10 + i * 7,
  confidence: 'h',
  brightness: 330,
  daynight: 'D',
  acqDate: '2026-01-01',
  acqTime: '1200',
  instrument: 'VIIRS',
}));

function installCanvasFakes() {
  const saved = { document: globalThis.document, Image: globalThis.Image };
  const context = {
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    drawImage() {},
  };
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL() {
        return `data:image/png;base64,${this.width}`;
      },
    }),
  };
  globalThis.Image = class {
    set src(url) {
      this.width = this.height = Number(url.split(',')[1]);
      queueMicrotask(() => this.onload?.());
    }
  };
  return () => Object.assign(globalThis, saved);
}

function fixture() {
  const restore = installCanvasFakes();
  const engine = createFakeEngine({ kind: 'navara' });
  const pose = (height) =>
    engine.fake.setPose({
      longitude: geo.math.toRadians(FIRE.lon + 0.002),
      latitude: geo.math.toRadians(FIRE.lat + 0.002),
      height,
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    });
  pose(12_000_000);
  const effects = [];
  const native = {
    view: {
      camera: {},
      registerEffect() {},
      addEffect(config) {
        const handle = { config, update() {}, delete() {} };
        effects.push(handle);
        return handle;
      },
    },
    EffectDesc: class {},
    NavaraEffect: class {},
  };
  // Cells the layer hands to the ground display for its current build.
  let cells = [];
  const noop = () => {};
  const layer = createFirmsHeatmapLayer({
    id: 'local-firms',
    name: 'Fires',
    feed: { getSnapshot: async () => ({ fires: records }) },
    services: {
      render: { governorRequestRender: noop },
      picking: {
        registerPickOwner: noop,
        unregisterPickOwner: noop,
        resolvePickId: () => null,
        isOwnedByOtherLayer: () => false,
      },
      focus: { requestWorldFocus: noop },
      context: {
        selectEntityContext: noop,
        clearSelectedEntityContextForLayer: noop,
        getContextStore: () => new Map(),
        registerEntityContext: noop,
      },
      anchors: {
        fireAnchorHeight: () => 0,
        warmFireAnchorFloors: async () => false,
      },
    },
    overlayHost: { setEntries: noop, setVisible: noop, clearSource: noop },
    renderer: {
      create: ({ engine: target, id }) => {
        const renderer = createFirmsNavaraRenderer(target, { ...native, id });
        const { addCell, clearCells } = renderer;
        renderer.addCell = (cell) => (cells.push(cell), addCell(cell));
        renderer.clearCells = () => ((cells = []), clearCells());
        return renderer;
      },
    },
  });
  layer.init(null, { engine });
  let clock = 0;
  const realNow = performance.now;
  performance.now = () => clock;
  return {
    engine,
    layer,
    pose,
    cells: () => cells,
    // Ground cells actually drawn by the shared display.
    drawnCells: () => effects[0]?.config.gevFirmsGround.owner.state.count ?? 0,
    // Fire sprites actually drawn (shown instances of the engine set).
    drawnSprites() {
      const set = engine.fake.moverSet('firms:local-firms');
      if (!set) return 0;
      let shown = 0;
      for (let i = 0; i < set.store.count; i++) shown += set.store.shows[i];
      return shown;
    },
    async step() {
      clock += 1000; // past the LOD throttle
      engine.fake.frame();
      await settle();
    },
    cleanup() {
      layer.destroy();
      unregisterSpriteCollection('local-firms');
      performance.now = realNow;
      restore();
    },
  };
}

test('edge:local-firms: orbit to the fire keeps the observation sum and never doubles a marker across LOD changes', async () => {
  const f = fixture();
  try {
    await f.layer.enable();
    await f.step();
    const sum = (list) => list.reduce((n, c) => n + c.properties.count, 0);
    assert.equal(
      sum(f.cells()),
      records.length,
      'orbit cells hold every observation',
    );
    assert.equal(f.drawnCells(), 1);
    assert.equal(f.drawnSprites(), 0);
    for (const round of [1, 2]) {
      // Down to the fire: detections replace the cell, one sprite per observation.
      f.pose(20_000);
      await f.step();
      assert.equal(
        f.drawnSprites(),
        records.length,
        `round ${round} at the fire`,
      );
      assert.equal(
        f.drawnCells(),
        0,
        `round ${round}: no cell under the sprites`,
      );
      // Back to orbit: the cell returns with the same sum, sprites go.
      f.pose(12_000_000);
      await f.step();
      assert.equal(sum(f.cells()), records.length);
      assert.equal(f.drawnCells(), 1, `round ${round} in orbit`);
      assert.equal(
        f.drawnSprites(),
        0,
        `round ${round}: no sprite over the cell`,
      );
    }
  } finally {
    f.cleanup();
  }
});
