import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDate,
  formatNumber,
  getLocale,
  keepCodesWithValues,
  setLocale,
  t,
  tn,
} from './index.js';
import {
  applyDocumentLanguage,
  intlLocale,
  LOCALE_STORAGE_KEY,
  resolveLocale,
} from './locale.js';
import { hudQuantity, LOCALIZED_LOCALITY } from '../hudLocalityFormat.js';
import { formatCockpitDistance } from '../ui/cockpitPresentation.js';
import { READOUT_WORDS } from '../layers/recentImagery/display.js';
import { createPresentation as createCctvPresentation } from '../layers/cctv/presentation.js';
import {
  formatQuantity,
  formatScaleLabel,
  formatScaleRange,
} from '../ui/unitLabels.js';

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

/** The text without the bidi isolates t() puts around values in RTL. */
const plain = (text) => text.replace(/[\u2068\u2069]/g, '');

test('Arabic uses all six plural forms and spaced HUD units', () => {
  const previous = getLocale();
  try {
    setLocale('ar');
    assert.deepEqual(
      [0, 1, 2, 3, 11, 100].map((n) =>
        plain(tn(n, '{count} SOURCE', '{count} SOURCES')),
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
      plain(LOCALIZED_LOCALITY.sector({ latDeg: 21.33, lonDeg: -77.5 })),
      'القطاع 21.33ش 77.50غ',
    );
    assert.equal(READOUT_WORDS.daysAgo(9), 'قبل 9 أيام');
    assert.equal(t('SAVE KEYS'), 'حفظ المفاتيح');
    // Each value is isolated, so a time keeps its order inside Arabic text.
    assert.equal(
      t('Issued: {time}', { time: '10/28 00:00 UTC' }),
      'صدر: \u206810/28 00:00 UTC\u2069',
    );
    // A Latin code stays beside its own value: HDG 68° · FOV 44°.
    assert.equal(
      keepCodesWithValues(
        t('{city} · HDG {heading} · FOV {fov}', {
          city: 'Austin',
          heading: '68°',
          fov: '44°',
        }),
      ),
      '\u2068Austin\u2069 · \u2068HDG \u206868°\u2069\u2069 · \u2068FOV \u206844°\u2069\u2069',
    );
    // A legend's open bound keeps its plus on the written side: 300+.
    assert.deepEqual(['300+', '0.1'].map(formatScaleLabel), [
      '\u2068300+\u2069',
      '\u20680.1\u2069',
    ]);
    // A Latin unit after the range keeps its order: °C, not C°.
    assert.equal(
      formatScaleRange('-40', '50+', '°C'),
      `${formatScaleLabel('-40')} — \u206850+\u2069\u00a0\u2068°C\u2069`,
    );
    // Counted minutes agree with the number (3–10 plural, 11+ singular).
    assert.deepEqual(
      [3, 15].map((n) =>
        formatNumber(n, {
          style: 'unit',
          unit: 'minute',
          unitDisplay: 'long',
        }),
      ),
      ['3 دقائق', '15 دقيقة'],
    );
    setLocale('ru');
    assert.equal(keepCodesWithValues('HDG 68°'), 'HDG 68°');
    assert.equal(formatCockpitDistance(14000), '14 КМ');
  } finally {
    setLocale(previous);
  }
});

test('Arabic keeps each CCTV summary code beside its own value', () => {
  const camera = {
    id: 'cam-1',
    city: 'Austin',
    name: 'Congress Ave',
    headingDeg: 68,
    fovDeg: 44,
    rangeM: 120,
    feedType: 'image',
  };
  const active = { camera };
  const presentation = createCctvPresentation({
    state: {
      _records: [active],
      _healthById: new Map(),
      _showProjection: true,
      _coverageMode: 'sector',
    },
    parts: {
      selection: { getActiveRecord: () => active },
      model: {
        sectorAreaKm2: () => 0.01,
        currentViewContext: () => 'street:1',
      },
      geometry: { coverageNeighborCount: () => 0 },
      calibration: { deriveCalBadge: () => 'auto' },
    },
  });
  const previous = getLocale();
  try {
    setLocale('ar');
    const parts = presentation.buildSummaryText().split(' · ');
    // Each part is its own isolate: «HDG 68° · FOV 44°» cannot form one
    // left-to-right run that hands 44° to the HDG side.
    for (const part of parts) assert.match(part, /^\u2068[\s\S]*\u2069$/);
    assert.ok(parts.includes('\u2068FOV \u206844\u2069°\u2069'), parts.join(' | '));
    setLocale('en');
    assert.doesNotMatch(presentation.buildSummaryText(), /[\u2068\u2069]/);
  } finally {
    setLocale(previous);
  }
});
