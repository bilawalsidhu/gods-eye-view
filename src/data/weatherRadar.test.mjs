import test from 'node:test';
import assert from 'node:assert/strict';
import weatherRadarLayer from './weatherRadar.js';

test('weatherRadarLayer exports required data layer contract', () => {
  assert.equal(weatherRadarLayer.id, 'weather-radar');
  assert.equal(weatherRadarLayer.name, 'Weather Radar');
  assert.equal(weatherRadarLayer.icon, '🌦');
  assert.equal(weatherRadarLayer.source, 'RainViewer');
  assert.equal(typeof weatherRadarLayer.init, 'function');
  assert.equal(typeof weatherRadarLayer.enable, 'function');
  assert.equal(typeof weatherRadarLayer.update, 'function');
  assert.equal(typeof weatherRadarLayer.disable, 'function');
  assert.equal(typeof weatherRadarLayer.destroy, 'function');
  assert.equal(typeof weatherRadarLayer.getStats, 'function');
  assert.equal(typeof weatherRadarLayer.setParams, 'function');
  assert.equal(typeof weatherRadarLayer.getParams, 'function');
});

test('weatherRadarLayer lifecycle methods execute cleanly with mocked fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/weather-radar/metadata')) {
      return {
        ok: true,
        json: async () => ({
          status: 'ready',
          host: 'https://tilecache.rainviewer.com',
          frames: [{ index: 0, time: 1234567890, path: '/v2/radar/abc123xyz' }],
          latestIndex: 0,
        }),
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    const fakeViewer = {
      creditDisplay: { addStaticCredit() {} },
      imageryLayers: {
        add() {},
        remove() {},
        raiseToTop() {},
      },
    };

    assert.equal(await weatherRadarLayer.init(fakeViewer), true);
    assert.equal(await weatherRadarLayer.enable(fakeViewer), true);
    assert.equal(await weatherRadarLayer.update(fakeViewer), true);

    const params = weatherRadarLayer.getParams();
    assert.equal(params.opacity, 0.7);

    weatherRadarLayer.setParams({ opacity: 0.5 });
    assert.equal(weatherRadarLayer.getParams().opacity, 0.5);

    const stats = weatherRadarLayer.getStats();
    assert.equal(stats.source, 'RainViewer');
    assert.equal(stats.status, 'nominal');
    assert.equal(stats.frames, 1);
  } finally {
    await weatherRadarLayer.destroy();
    globalThis.fetch = originalFetch;
  }
});
