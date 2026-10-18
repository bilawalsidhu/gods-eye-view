import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindLayer, windStats } from './index.js';
import { setLocale, translateKnown } from '../../i18n/index.js';
import { windProxy } from '../../../server/providers/wind.js';

function harness(feed) {
  const rendering = Object.fromEntries(
    [
      'attach',
      'start',
      'stop',
      'clear',
      'destroy',
      'setField',
      'setOptions',
    ].map((name) => [name, () => {}]),
  );
  rendering.getDiagnostics = () => ({});
  const layer = createWindLayer({ feed, createRendering: () => rendering });
  layer.init({ container: {} });
  layer.enable();
  return layer;
}

async function serverManifestOnUpstreamFailure() {
  let handler;
  const failing = async () => {
    throw new Error('upstream down');
  };
  windProxy({ models: { gfs: failing, ifs: failing } }).configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  let body = '';
  await handler(
    { method: 'GET', url: '/manifest?model=gfs&overlay=none' },
    { writeHead() {}, end: (b) => (body = b), once() {}, removeListener() {} },
  );
  return JSON.parse(body);
}

test('en: the upstream failure reason reads as before', async () => {
  const manifest = await serverManifestOnUpstreamFailure();
  const layer = harness({ getSnapshot: async () => manifest });
  await layer.update();
  assert.equal(
    layer.getRowControls().summary.status,
    'Wind upstream unavailable',
  );
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: upstream failure status is shown in the UI language`, async () => {
    const manifest = await serverManifestOnUpstreamFailure();
    assert.equal(manifest.reason, 'Wind upstream unavailable');
    setLocale(locale);
    try {
      const layer = harness({ getSnapshot: async () => manifest });
      await layer.update();
      const status = layer.getRowControls().summary.status;
      const stats = translateKnown(windStats(manifest).error);
      assert.notEqual(status, 'Wind upstream unavailable');
      assert.notEqual(stats, 'Wind upstream unavailable');
    } finally {
      setLocale('en');
    }
  });

  test(`${locale}: a stale cached forecast is reported in the UI language`, async () => {
    // Shape the server returns when a cached forecast is kept after a failure.
    const manifest = {
      model: 'gfs',
      grid: { nx: 2, ny: 2 },
      cycle: {
        runIso: '2026-09-14T12:00:00Z',
        validIso: '2026-09-14T18:00:00Z',
      },
      stale: true,
      reason: 'Wind upstream unavailable',
    };
    setLocale(locale);
    try {
      const layer = harness({ getSnapshot: async () => manifest });
      await layer.update();
      const status = layer.getRowControls().summary.status;
      assert.doesNotMatch(status, /[A-Za-z]{4,} upstream unavailable/);
    } finally {
      setLocale('en');
    }
  });
}
