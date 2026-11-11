import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createFirmsHeatmapLayer } from './index.js';
import { createFirmsDisplay } from './render/display.js';

const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
const FIRE = { lat: 38.5, lon: -121.5 };
// One cluster a few hundred metres across: one heat spot and one card from
// orbit, sprites at the fire.
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
      create: ({ engine: target, id }) => createFirmsDisplay(target, { id }),
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
    // The heatmap as drawn: its raster's alpha at the fire times the
    // layer's, 0 when the imagery layer is hidden, faded out or unpainted.
    drawnHeat() {
      const heat = engine.fake.imageryLayer('local-firms:heat');
      if (!heat?.shown || !(heat.alpha > 0)) return 0;
      const { data, width, height } = heat.source.image;
      const x = Math.floor(((FIRE.lon + 180) / 360) * width);
      const y = Math.floor(((90 - FIRE.lat) / 180) * height);
      return (data[(y * width + x) * 4 + 3] / 255) * heat.alpha;
    },
    cards: () => layer.getStats().cells,
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
      performance.now = realNow;
      restore();
    },
  };
}

test('edge:local-firms: orbit to the fire hands over between heatmap and markers and never shows both', async () => {
  const f = fixture();
  try {
    await f.layer.enable();
    await f.step();
    assert.ok(f.drawnHeat() > 0, 'orbit: the heatmap glows at the fire');
    assert.equal(f.cards(), 1, 'orbit: one card holds the cluster');
    assert.equal(f.drawnSprites(), 0);
    for (const round of [1, 2]) {
      // Down to the fire: markers replace the heatmap, one per observation.
      f.pose(20_000);
      await f.step();
      assert.equal(
        f.drawnSprites(),
        records.length,
        `round ${round} at the fire`,
      );
      assert.equal(
        f.drawnHeat(),
        0,
        `round ${round}: no heat under the markers`,
      );
      // Back to orbit: the heatmap returns, the markers go.
      f.pose(12_000_000);
      await f.step();
      assert.ok(f.drawnHeat() > 0, `round ${round} in orbit`);
      assert.equal(
        f.drawnSprites(),
        0,
        `round ${round}: no marker over the heatmap`,
      );
    }
  } finally {
    f.cleanup();
  }
});
