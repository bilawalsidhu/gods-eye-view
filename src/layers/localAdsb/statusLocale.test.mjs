// The Local ADS-B row's working texts ("3 heard · 5.8 msg/s", "listening",
// "USB error", feed problems, even as the whole error) read in the UI language.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
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
