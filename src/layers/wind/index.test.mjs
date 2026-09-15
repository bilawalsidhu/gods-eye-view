import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindLayer, formatWindValidTime, windStats } from './index.js';

test('formatWindValidTime formats UTC dates and falls back for invalid/missing input', () => {
  assert.equal(
    formatWindValidTime('2026-09-14T12:00:00.000Z'),
    '2026-09-14 12:00 UTC',
  );
  assert.equal(
    formatWindValidTime('2026-01-05T06:30:00.000Z'),
    '2026-01-05 06:30 UTC',
  );
  assert.equal(formatWindValidTime(null), null);
  assert.equal(formatWindValidTime(undefined), null);
  assert.equal(formatWindValidTime('invalid-date'), null);
});

test('wind layer provides row controls with active model and valid timestamp', async () => {
  let manifest = {
    model: 'gfs',
    cycle: {
      validIso: '2026-09-14T18:00:00.000Z',
      runIso: '2026-09-14T12:00:00.000Z',
    },
    grid: { nx: 2, ny: 2 },
    unavailable: false,
  };
  const feed = {
    getSnapshot: async ({ model }) => ({ ...manifest, model }),
  };

  const container = { clientWidth: 800, clientHeight: 600, appendChild() {} };
  const canvas = {
    style: {},
    dataset: {},
    getContext: () => ({
      clearRect() {},
      setTransform() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
    }),
    remove() {},
  };
  globalThis.document = { createElement: () => canvas };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  const viewer = {
    container,
    scene: { canvas, camera: { positionWC: {} } },
    isDestroyed: () => false,
  };
  const cesium = {
    Cartesian3: { fromDegrees: () => ({}) },
    Ellipsoid: { WGS84: {} },
    EllipsoidalOccluder: class {
      isPointVisible() {
        return true;
      }
    },
    SceneTransforms: { worldToWindowCoordinates: () => ({ x: 10, y: 10 }) },
  };

  const layer = createWindLayer({ feed, cesium, container });
  layer.init(viewer);

  // Before update / while unavailable
  const initialControls = layer.getRowControls();
  assert.equal(initialControls.chips.length, 2);
  assert.equal(initialControls.chips[0].active, true);
  assert.equal(initialControls.chips[1].active, false);
  assert.match(initialControls.info, /GFS · Valid: Unavailable/);

  // After enable and update
  layer.enable();
  await layer.update(viewer);

  const activeControls = layer.getRowControls();
  assert.equal(activeControls.chips[0].active, true);
  assert.match(activeControls.info, /GFS · Valid: 2026-09-14 18:00 UTC/);
  assert.ok(activeControls.legend.length >= 7);

  const stats = layer.getStats();
  assert.equal(stats.model, 'GFS');
  assert.equal(stats.validTime, '2026-09-14 18:00 UTC');
  assert.equal(stats.source, 'NOAA GFS');

  // Switch model to IFS
  layer.setParams({ model: 'ifs' });
  const ifsControls = layer.getRowControls();
  assert.equal(ifsControls.chips[1].active, true);
  assert.match(ifsControls.info, /IFS · Valid: Unavailable/); // manifest pending for ifs

  manifest = {
    model: 'ifs',
    cycle: {
      validIso: '2026-09-14T21:00:00.000Z',
      runIso: '2026-09-14T12:00:00.000Z',
    },
    grid: { nx: 2, ny: 2 },
    unavailable: false,
  };
  await layer.update(viewer);

  const updatedIfsControls = layer.getRowControls();
  assert.match(updatedIfsControls.info, /IFS · Valid: 2026-09-14 21:00 UTC/);

  const ifsStats = layer.getStats();
  assert.equal(ifsStats.model, 'IFS');
  assert.equal(ifsStats.validTime, '2026-09-14 21:00 UTC');
  assert.equal(ifsStats.source, 'ECMWF IFS');

  // Unavailable manifest fallback
  manifest = {
    model: 'ifs',
    unavailable: true,
    reason: 'ECMWF upstream outage',
  };
  await layer.update(viewer);
  const unavailControls = layer.getRowControls();
  assert.match(unavailControls.info, /IFS · Valid: Unavailable/);

  layer.disable();
  layer.destroy();
});
