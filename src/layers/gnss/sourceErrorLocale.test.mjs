// The GNSS source's own failures are English data (source.js); the
// card's info line shows them in the UI language, the HTTP form included.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { setLocale } from '../../i18n/index.js';
import { createGnssIntegrityLayer } from './index.js';

async function failedLayer(message) {
  const layer = createGnssIntegrityLayer({
    source: {
      async getSnapshot() {
        throw Object.assign(new Error(message), {
          retryable: true,
          retryAfterMs: 60_000,
        });
      },
    },
    viewAnchor: () => ({ latitude: 50, longitude: 30 }),
    now: () => 1_000,
    monotonicNow: () => 1_000,
  });
  layer.init({
    camera: { moveEnd: new Cesium.Event(), changed: new Cesium.Event() },
    scene: {
      globe: { show: true },
      groundPrimitives: { add() {}, remove() {} },
    },
  });
  layer.enable();
  await layer.update();
  return layer;
}

for (const locale of ['es', 'ru']) {
  test(`${locale}: the GNSS source failure is translated on the card`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    for (const message of [
      'GNSS feed unavailable (HTTP 503)',
      'GNSS feed rate limited (HTTP 429)',
    ]) {
      const layer = await failedLayer(message);
      setLocale(locale);
      try {
        const { info } = layer.getRowControls();
        assert.ok(info.includes('HTTP'), info);
        assert.doesNotMatch(info, /feed (unavailable|rate limited)/, info);
      } finally {
        setLocale('en');
        layer.destroy();
      }
    }
  });
}
