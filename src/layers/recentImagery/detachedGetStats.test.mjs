import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createRecentImageryLayer } from './index.js';
import {
  fakeCatalog,
  fakeRenderer,
  fakeThumbnails,
  manualTimers,
  BOX,
  CANDIDATES,
  settle,
} from './testDoubles.mjs';

test('getStats between detachRenderer and attachRenderer does not throw', async () => {
  const engine = createFakeEngine();
  engine.camera.viewRectangle = () => undefined;
  const timers = manualTimers();
  const catalog = fakeCatalog();
  const rendererFactory = () => {
    const r = fakeRenderer();
    r.resolveHost = () => ({ collection: {}, kind: 'globe' });
    r.viewCentre = () => undefined;
    r.zoomToFit = () => {};
    return r;
  };
  const layer = createRecentImageryLayer({
    catalog,
    rendererFactory,
    thumbnails: fakeThumbnails(),
    now: () => new Date('2026-09-21T15:00:00Z'),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  layer.init(null, { engine });
  layer.enable();
  layer.setBox(BOX);
  catalog.resolveLast(CANDIDATES);
  await settle();
  assert.doesNotThrow(() => layer.getStats(), 'attached');
  await layer.detachRenderer();
  assert.doesNotThrow(
    () => layer.getStats(),
    'detached: stats poll during an engine switch',
  );
});
