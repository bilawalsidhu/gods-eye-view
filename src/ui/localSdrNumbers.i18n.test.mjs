// The SDR status line and stats write numbers in the UI language, like
// the frequency next to them ("Сканирование 101,1 МГц…").
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { localSdrCardView } from './localSdrPresentation.js';

const fm = {
  connected: true,
  status: 'streaming',
  mode: 'fm',
  message: 'Tuned',
  seekMessage: '',
  samplesPerSecond: 2_400_000,
  iqLevelDbfs: -21.44,
  audioLevelDbfs: -18.26,
  workerBlocks: 0,
  audioState: 'running',
  gain: 20.7,
  frequencyHz: 101_100_000,
  volume: 0.5,
  messagesPerSecond: 13.8,
  webUsbSupported: true,
};

test('en: SDR readings keep their English digits', () => {
  setLocale('en');
  const view = localSdrCardView(fm);
  assert.match(view.statusText, /· 2\.40 MS\/s IQ ·/);
  assert.match(view.statusText, /· RF -21\.4 dBFS ·/);
  assert.match(view.statusText, /-18\.3 dBFS audio/);
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: SDR readings use the locale's decimal comma`, () => {
    setLocale(locale);
    try {
      const view = localSdrCardView(fm);
      assert.match(view.statusText, /· 2,40 MS\/s IQ ·/);
      assert.match(view.statusText, /· RF -21,4 dBFS ·/);
      assert.match(view.statusText, /-18,3 dBFS/);
      const adsb = localSdrCardView({ ...fm, mode: 'adsb' });
      assert.equal(adsb.stats.rate, '13,8');
      assert.equal(adsb.stats.iq, '-21,4 dBFS');
      assert.equal(adsb.gainValue, '20.7', 'input values stay machine');
    } finally {
      setLocale('en');
    }
  });
}
