import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../i18n/index.js';
import { createWindLayer } from './index.js';

test('stale wind forecast is marked in the UI language', async () => {
  const rendering = Object.fromEntries(
    ['attach', 'start', 'stop', 'clear', 'destroy', 'setField'].map((n) => [
      n,
      () => {},
    ]),
  );
  rendering.getDiagnostics = () => ({});
  const layer = createWindLayer({
    feed: {
      getSnapshot: async () => ({
        model: 'gfs',
        grid: { nx: 2, ny: 2 },
        cycle: {
          runIso: '2026-09-14T12:00:00Z',
          validIso: '2026-09-14T18:00:00Z',
        },
        stale: true,
        reason: 'Wind upstream unavailable',
      }),
    },
    createRendering: () => rendering,
  });
  layer.init({ container: {} });
  layer.enable();
  await layer.update();
  try {
    assert.match(layer.getRowControls().info, / · STALE(\n|$)/);
    for (const [locale, word] of [
      ['es', 'DESACTUALIZADO'],
      ['ru', 'УСТАРЕЛ'],
    ]) {
      setLocale(locale);
      const info = layer.getRowControls().info;
      assert.doesNotMatch(info, /STALE/);
      assert.match(info, new RegExp(word));
    }
  } finally {
    setLocale('en');
    layer.destroy();
  }
});
