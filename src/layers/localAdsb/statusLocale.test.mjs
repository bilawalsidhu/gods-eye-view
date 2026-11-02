// The Local ADS-B row's working texts ("3 heard · 5.8 msg/s", "listening",
// "USB error", feed problems, even as the whole error) read in the UI language.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale, t } from '../../i18n/index.js';
import { SdrController } from '../../sdr/controller.js';
import { LayerPanel } from '../../ui/layerPanel.js';
import { localAdsbStatus } from './status.js';

const streaming = {
  webUsbSupported: true,
  connected: true,
  mode: 'adsb',
  status: 'streaming',
  messagesPerSecond: 5.8,
};

const idle = {
  webUsbSupported: true,
  connected: false,
  mode: 'adsb',
  status: 'idle',
};

function rowFor(status, count) {
  return LayerPanel.prototype._buildMetaText({
    id: 'local-adsb',
    enabled: true,
    stats: { count, lastUpdate: Date.now(), ...status },
  });
}

function inLocale(locale, run) {
  setLocale(locale);
  try {
    run();
  } finally {
    setLocale('en');
  }
}

for (const locale of ['es', 'ru']) {
  test(`${locale}: the streaming Local ADS-B row is translated`, () => {
    inLocale(locale, () => {
      const row = rowFor(
        localAdsbStatus({ receiver: streaming, feedState: null, heard: 3 }),
        3,
      );
      assert.doesNotMatch(row, /\bheard\b/, row);
    });
  });

  for (const status of ['unreachable', 'invalid']) {
    test(`${locale}: a lone ${status} decoder feed with nothing heard is translated`, () => {
      inLocale(locale, () => {
        const st = localAdsbStatus({
          receiver: idle,
          feedState: {
            configured: true,
            feeds: [{ id: 'a', label: '1090', band: '1090', status }],
          },
          heard: 0,
        });
        const row = rowFor(st, 0);
        assert.doesNotMatch(row, /\b(unreachable|invalid)\b/, row);
      });
    });
  }
}

// A receiver error is English data for the layer (stats, and what the voice
// tools and the analyst read); the Radio card and the row show it translated.
for (const locale of ['es', 'ru']) {
  test(`${locale}: a WebUSB receiver error stays English in stats and reads translated`, async () => {
    const receiver = new SdrController({
      storage: null,
      webUsb: {},
      providerFactory: () => ({
        get: async () => {
          throw new Error('No device was selected.');
        },
      }),
    });
    setLocale(locale);
    try {
      assert.equal(await receiver.connect('adsb'), false);
      const state = receiver.getState();
      assert.equal(state.status, 'error');
      assert.equal(state.errorText, 'No RTL-SDR device selected');
      assert.equal(state.message, t('No RTL-SDR device selected'));
      assert.notEqual(state.message, state.errorText);

      const status = localAdsbStatus({
        receiver: state,
        feedState: null,
        heard: 0,
      });
      assert.equal(status.error, 'No RTL-SDR device selected');
      const row = rowFor(status, 0);
      assert.ok(row.includes(state.message), row);
      assert.doesNotMatch(row, /No RTL-SDR device selected/, row);

      // The English text goes with the error: stop() clears it.
      await receiver.stop();
      assert.equal(receiver.getState().errorText, null);
    } finally {
      setLocale('en');
      await receiver.destroy();
    }
  });
}
