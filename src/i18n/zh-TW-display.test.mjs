import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t, tn, getLocale } from './index.js';
import { resolveLocale, LOCALE_STORAGE_KEY } from './locale.js';
import { hudQuantity, LOCALIZED_LOCALITY } from '../hudLocalityFormat.js';
import { formatCockpitDistance } from '../ui/cockpitPresentation.js';
import { READOUT_WORDS } from '../layers/recentImagery/display.js';
import { cctvSourceStatusLabel } from '../ui/cctvFrames.js';

test('Traditional Chinese resolves from URL, saved preference and browser language', () => {
  assert.equal(
    resolveLocale({
      location: { search: '?lang=zh-TW' },
      storage: { getItem: () => 'en' },
      languages: ['en'],
    }),
    'zh-TW',
  );
  assert.equal(
    resolveLocale({
      location: { search: '' },
      storage: {
        getItem: (key) => (key === LOCALE_STORAGE_KEY ? 'zh-TW' : null),
      },
      languages: ['en'],
    }),
    'zh-TW',
  );
  assert.equal(
    resolveLocale({
      location: { search: '' },
      storage: { getItem: () => null },
      languages: ['zh-Hant', 'en'],
    }),
    'zh-TW',
  );
});

test('Traditional Chinese readouts preserve unit case, coordinates and natural relative dates', () => {
  const previous = getLocale();
  try {
    setLocale('zh-TW');
    assert.equal(hudQuantity(2069, 'km', 1), '2069.0 km');
    assert.equal(formatCockpitDistance(14000), '14\u00a0km');
    assert.equal(
      LOCALIZED_LOCALITY.sector({ latDeg: 21.33, lonDeg: -77.5 }),
      '扇區 21.33N 77.50W',
    );
    assert.equal(READOUT_WORDS.daysAgo(9), '9 天前');
    assert.equal(READOUT_WORDS.daysAgo(0), '今天');
    assert.equal(cctvSourceStatusLabel('ok'), '正常');
    assert.equal(t('SAVE KEYS'), '儲存金鑰');
    assert.equal(
      tn(2, 'Click {count} more point.', 'Click {count} more points.'),
      '再點選 2 個點。',
    );
  } finally {
    setLocale(previous);
  }
});
