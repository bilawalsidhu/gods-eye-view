// The GNSS source's own failures are English data (source.js); the
// card's info line shows them in the UI language, the HTTP form included.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { createGnssIntegrityLayer } from './index.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

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
  const viewer = { scene: { globe: { show: true } } };
  bindFakeDraw(viewer, { camera: fakeCameraPort().port });
  layer.init(viewer);
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
