import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { localSdrFeedLine } from './localSdrPresentation.js';

for (const locale of ['es', 'ru']) {
  test(`decoder feed line is translated in ${locale}`, () => {
    setLocale(locale);
    try {
      const feeds = [{ id: '1090', band: '1090', status: 'live' }];
      const polling = localSdrFeedLine({
        configured: true,
        polling: true,
        feeds: [{ ...feeds[0], status: 'unreachable' }],
      });
      const idle = localSdrFeedLine({
        configured: true,
        polling: false,
        feeds,
      });
      assert.doesNotMatch(polling, /Decoder feeds|unreachable/);
      assert.match(polling, /1090/);
      assert.doesNotMatch(idle, /Decoder feeds|read while Local ADS-B is on/);
      assert.match(idle, /1090/);
    } finally {
      setLocale('en');
    }
  });
}

test('an unknown feed status is shown as given', () => {
  setLocale('en');
  const feeds = [{ band: '1090', status: 'odd' }];
  assert.equal(
    localSdrFeedLine({ configured: true, polling: true, feeds }),
    'Decoder feeds: 1090 odd',
  );
});

// A feed status agrees with "fuente" in Spanish; the shared "invalid" key
// (any other masculine noun) is left alone.
test('es: an invalid decoder feed reads "no válida"', () => {
  setLocale('es');
  try {
    const line = localSdrFeedLine({
      configured: true,
      polling: true,
      feeds: [
        { band: '1090', status: 'live' },
        { band: '1090', status: 'invalid' },
      ],
    });
    assert.match(line, /no válida/);
    assert.doesNotMatch(line, /no válido\b/);
  } finally {
    setLocale('en');
  }
});
