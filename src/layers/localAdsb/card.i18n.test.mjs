// The Local ADS-B click card follows the UI language; English keeps its
// wording (index.test.mjs pins the full English card).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../../i18n/index.js';
import { localAdsbCardModel, localAdsbSourceText } from './card.js';

const record = {
  icao: 'abc123',
  callsign: '',
  altitudeFt: 12500,
  groundSpeedKt: 240,
  trackDeg: 90,
  verticalRateFpm: -1200,
  lastPositionAt: 1000,
  messageCount: 48,
  bands: ['1090'],
  sources: ['webusb', 'feed'],
};

test('en: the local ADS-B card keeps its English wording', () => {
  setLocale('en');
  assert.deepEqual(localAdsbCardModel(record, 5000).details, [
    'ICAO ABC123 · NO CALLSIGN',
    'ALT 12,500 FT · GS 240 KT · TRK 90°',
    'V/S -1,200 FPM',
    'POSITION 4 S AGO · 48 MSGS',
    'Heard by your receiver · 1090 MHz · browser SDR + decoder feed',
  ]);
  assert.equal(
    localAdsbSourceText(record),
    'Your RTL-SDR receiver and decoder feed',
  );
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: the local ADS-B card is in the UI language`, () => {
    setLocale(locale);
    try {
      const text = [
        ...localAdsbCardModel(record, 5000).details,
        localAdsbSourceText(record),
      ].join(' | ');
      for (const english of [
        'NO CALLSIGN',
        'GS ',
        'POSITION',
        'AGO',
        'MSGS',
        'Heard by',
        'browser SDR',
        'decoder feed',
        'Your RTL-SDR',
        '12,500',
      ])
        assert.ok(
          !text.includes(english),
          `${locale}: "${english}" in ${text}`,
        );
    } finally {
      setLocale('en');
    }
  });
}

test('the class line names the aircraft class in the UI language', async () => {
  const { localAdsbClassLine } = await import('./card.js');
  const { AIRCRAFT_CLASS_LABELS } = await import('../../data/aircraftClass.js');
  const heli = { category: 'A7' };
  try {
    setLocale('en');
    assert.equal(
      localAdsbClassLine(heli, { klass: 'helicopter', evidence: true }),
      'Helicopter · A7',
    );
    for (const locale of ['es', 'ru']) {
      setLocale(locale);
      for (const [klass, label] of Object.entries(AIRCRAFT_CLASS_LABELS)) {
        const line = localAdsbClassLine({}, { klass, evidence: true });
        assert.ok(line, `${locale}: ${klass} has a class line`);
        assert.notEqual(line, label, `${locale}: "${label}" is in English`);
      }
    }
  } finally {
    setLocale('en');
  }
});

// The receiver bands follow the UI language too ("1090 МГц").
test('ru: the receiver line names the bands in Russian', async () => {
  const { localAdsbReceiverLine } = await import('./card.js');
  setLocale('ru');
  try {
    const line = localAdsbReceiverLine({ ...record, bands: ['1090', '978'] });
    assert.match(line, /· 1090 МГц \+ 978 МГц UAT ·/);
    assert.doesNotMatch(line, /MHz/);
  } finally {
    setLocale('en');
  }
});
