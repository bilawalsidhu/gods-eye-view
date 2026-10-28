import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatNumber, getLocale, setLocale, t, tn } from './index.js';
import {
  applyDocumentLanguage,
  intlLocale,
  LOCALE_STORAGE_KEY,
  resolveLocale,
} from './locale.js';
import { hudQuantity, LOCALIZED_LOCALITY } from '../hudLocalityFormat.js';
import { formatCockpitDistance } from '../ui/cockpitPresentation.js';
import { READOUT_WORDS } from '../layers/recentImagery/display.js';
import { formatQuantity } from '../ui/unitLabels.js';

test('Arabic resolves from URL, saved preference and browser language', () => {
  assert.equal(
    resolveLocale({
      location: { search: '?lang=ar-EG' },
      storage: { getItem: () => 'en' },
      languages: ['en'],
    }),
    'ar',
  );
  assert.equal(
    resolveLocale({
      location: { search: '' },
      storage: {
        getItem: (key) => (key === LOCALE_STORAGE_KEY ? 'ar' : null),
      },
      languages: ['en'],
    }),
    'ar',
  );
  assert.equal(
    resolveLocale({
      location: { search: '' },
      storage: { getItem: () => null },
      languages: ['ar-SA', 'en'],
    }),
    'ar',
  );
});

test('Arabic turns the page right-to-left; other languages stay left-to-right', () => {
  const doc = { documentElement: {} };
  applyDocumentLanguage(doc, 'ar');
  assert.deepEqual(doc.documentElement, { lang: 'ar', dir: 'rtl' });
  applyDocumentLanguage(doc, 'zh-CN');
  assert.deepEqual(doc.documentElement, { lang: 'zh-CN', dir: 'ltr' });
});

test('Arabic formats with Western digits whatever ICU defaults to', () => {
  assert.equal(intlLocale('ar'), 'ar-u-nu-latn');
  assert.equal(intlLocale('ru'), 'ru');
  const previous = getLocale();
  try {
    setLocale('ar');
    assert.equal(formatNumber(1234.5), '1,234.5');
    assert.equal(
      formatDate(Date.UTC(2026, 7, 26), {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      '26 أغسطس 2026',
    );
    assert.doesNotMatch(formatNumber(9876543210), /[٠-٩]/);
  } finally {
    setLocale(previous);
  }
});

test('Arabic uses all six plural forms and spaced HUD units', () => {
  const previous = getLocale();
  try {
    setLocale('ar');
    assert.deepEqual(
      [0, 1, 2, 3, 11, 100].map((n) =>
        tn(n, '{count} SOURCE', '{count} SOURCES'),
      ),
      [
        '0 مصدر',
        'مصدر واحد (1)',
        'مصدران (2)',
        '3 مصادر',
        '11 مصدرًا',
        '100 مصدر',
      ],
    );
    assert.equal(hudQuantity(2069, 'km', 1), '2069.0 كم');
    // Isolated, so the number keeps its unit next to Latin words.
    assert.equal(formatCockpitDistance(14000), '\u206814\u00a0كم\u2069');
    assert.equal(
      `Sentinel-2 · ${formatQuantity(30, 'm')}`,
      'Sentinel-2 · \u206830\u00a0م\u2069',
    );
    assert.equal(
      LOCALIZED_LOCALITY.sector({ latDeg: 21.33, lonDeg: -77.5 }),
      'القطاع 21.33ش 77.50غ',
    );
    assert.equal(READOUT_WORDS.daysAgo(9), 'قبل 9 أيام');
    assert.equal(t('SAVE KEYS'), 'حفظ المفاتيح');
    setLocale('ru');
    assert.equal(formatCockpitDistance(14000), '14 КМ');
  } finally {
    setLocale(previous);
  }
});
