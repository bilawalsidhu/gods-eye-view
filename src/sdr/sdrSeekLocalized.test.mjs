import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { SdrController } from './controller.js';
import { localSdrCardView } from '../ui/localSdrPresentation.js';

function makeController() {
  const c = new SdrController({ storage: null, webUsb: null });
  c._device = {};
  c.state.mode = 'fm';
  const seen = [];
  c.subscribe?.((s) => seen.push(localSdrCardView(s)));
  c.tuneFm = async (f) => {
    c.state.frequencyHz = f;
    const sr = c.state.sampleRate;
    const bins = new Float32Array(1024).fill(-80);
    const target = 98_800_000;
    const idx = Math.round((target - f) / (sr / 1024) + 512);
    for (let i = idx - 20; i <= idx + 20; i++)
      if (i >= 0 && i < 1024) bins[i] = -10;
    c._spectrum = bins;
    return true;
  };
  c._waitForSpectrum = async () => true;
  c.state.frequencyHz = 98_500_000;
  return { c, seen };
}

for (const locale of ['es', 'ru']) {
  test(`FM seek messages are localized in ${locale}`, async () => {
    setLocale(locale);
    try {
      const { c, seen } = makeController();
      const peak = await c.seekFm(1);
      assert.ok(peak, 'synthetic peak found');
      const texts = seen.map((view) => view.statusText);
      // Every status line shown during and after the seek is in the UI language.
      for (const text of texts) {
        assert.doesNotMatch(text, /Seeking (up|down)|Scanning \d|Found \d/);
      }
      // Decimal separator follows the locale (98,8 in es and ru).
      assert.match(texts.at(-1), /98,8/);
    } finally {
      setLocale('en');
    }
  });
}

test('FM seek messages keep their English wording and decimal point', async () => {
  setLocale('en');
  const { c, seen } = makeController();
  const peak = await c.seekFm(1);
  assert.ok(peak, 'synthetic peak found');
  const texts = seen.map((view) => view.statusText);
  assert.ok(texts.includes('Seeking up…'));
  assert.ok(texts.includes('Scanning 98.5 MHz…'));
  assert.match(texts.at(-1), /^Found 98\.8 MHz · \d+\.\d dB$/);
});

for (const locale of ['es', 'ru']) {
  test(`a failed seek tune and a decoder overload are localized in ${locale}`, async () => {
    setLocale(locale);
    try {
      const { c } = makeController();
      c.tuneFm = async () => false;
      assert.equal(await c.seekFm(1), null);
      assert.ok(c.state.seekMessage);
      assert.notEqual(c.state.seekMessage, 'Seek stopped');

      c.stop = async () => {};
      for (const reason of ['startup', 'stalled', 'backlog']) {
        c._device = {};
        c._overload(reason);
        assert.doesNotMatch(c.state.message, /SDR decoder|receiver stopped/);
      }
    } finally {
      setLocale('en');
    }
  });
}
