import test from 'node:test';
import assert from 'node:assert/strict';

test('Local ADS-B guidance hint is translated in the layer row', async () => {
  const { setLocale, t } = await import('../i18n/index.js');
  const { LayerPanel } = await import('./layerPanel.js');
  const { localAdsbStatus } = await import('../layers/localAdsb/status.js');
  const english = localAdsbStatus({
    receiver: { webUsbSupported: true, connected: false },
    feedState: null,
    heard: 0,
  });
  assert.equal(
    LayerPanel.prototype._buildMetaText.call(LayerPanel.prototype, {
      id: 'local-adsb',
      enabled: true,
      lifecycleState: 'enabled',
      stats: { count: 0, lastUpdate: null, ...english },
    }),
    'RTL-SDR · WebUSB · connect a receiver in Radio',
  );
  for (const locale of ['es', 'ru']) {
    setLocale(locale);
    for (const receiver of [
      { webUsbSupported: true, connected: false },
      { webUsbSupported: false, connected: false },
      { webUsbSupported: true, connected: true, mode: 'fm' },
    ]) {
      const stats = localAdsbStatus({ receiver, feedState: null, heard: 0 });
      const text = LayerPanel.prototype._buildMetaText.call(
        LayerPanel.prototype,
        {
          id: 'local-adsb',
          enabled: true,
          lifecycleState: 'enabled',
          stats: { count: 0, lastUpdate: null, ...stats },
        },
      );
      assert.notEqual(
        t(stats.statusMessage),
        stats.statusMessage,
        `${locale}: no catalog entry for "${stats.statusMessage}"`,
      );
      assert.ok(
        !text.includes(stats.statusMessage),
        `${locale}: row shows English hint: ${text}`,
      );
    }
  }
  setLocale('en');
});
