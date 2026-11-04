import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import {
  convertQuantity,
  formatArea,
  formatCompactLength,
  formatDistance,
  formatMeasure,
  formatQuantity,
  formatScaleLabel,
  formatScaleRange,
  formatSpeed,
  formatTemperature,
  getUnitSystem,
  onUnitSystemChange,
  persistUnitSystem,
  resolveUnitSystem,
  setUnitSystem,
  UNIT_SYSTEM_STORAGE_KEY,
  unitLabel,
} from './unitLabels.js';
import { distanceParts, formatDistanceText } from '../data/distanceFormat.js';

test('English readings and scales read exactly as the unit ids', () => {
  setLocale('en');
  assert.equal(unitLabel('km/h'), 'km/h');
  assert.equal(unitLabel('°C'), '°C');
  assert.equal(unitLabel('dBZ'), 'dBZ');
  assert.equal(unitLabel(''), '');
  assert.equal(formatQuantity(95, 'kt'), '95 kt');
  assert.equal(formatQuantity(1006, 'hPa'), '1006 hPa');
  assert.equal(
    formatQuantity(22, 'km/h', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
    '22.0 km/h',
  );
  assert.deepEqual(
    ['0.1', '-40', '1050+', '300+', 'Calm'].map(formatScaleLabel),
    ['0.1', '-40', '1050+', '300+', 'Calm'],
  );
});

test('other languages get their decimal separator and no digit grouping', () => {
  try {
    setLocale('ru');
    assert.match(
      formatQuantity(22, 'km/h', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
      /^22,0 \S+$/,
    );
    assert.match(formatQuantity(1050, 'hPa'), /^1050 /);
    assert.deepEqual(['0.1', '-40', '1050+'].map(formatScaleLabel), [
      '0,1',
      '-40',
      '1050+',
    ]);
  } finally {
    setLocale('en');
  }
});

test('Japanese unit words follow the number directly; symbols keep the space', () => {
  try {
    setLocale('ja');
    assert.equal(formatQuantity(5, 'min'), '5分');
    assert.equal(formatQuantity(1, 'h'), '1時間');
    assert.equal(formatQuantity(95, 'kt'), '95\u00a0kt');
  } finally {
    setLocale('en');
  }
});

// ---------------------------------------------------------------------------
// Display \u2192 Units: metric or imperial, display only.
// ---------------------------------------------------------------------------

const nbsp = (text) => text.replace(' ', '\u00a0');

/** Run `body` in `system`, then go back to metric. */
function inSystem(system, body) {
  setUnitSystem(system);
  try {
    return body();
  } finally {
    setUnitSystem('metric');
  }
}

/** A localStorage stand-in that keeps what it is given. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

test('distances switch between m/km and ft/mi at their thresholds', () => {
  setLocale('en');
  const metres = [0, 12, 304, 305, 999.6, 1609.344, 15999, 16100, 250000];
  assert.deepEqual(
    metres.map((m) => formatDistance(m)),
    [
      '0 m',
      '12 m',
      '304 m',
      '305 m',
      '1.0 km',
      '1.6 km',
      '16 km',
      '16 km',
      '250 km',
    ].map(nbsp),
  );
  inSystem('imperial', () =>
    assert.deepEqual(
      metres.map((m) => formatDistance(m)),
      [
        '0 ft',
        '39 ft',
        '997 ft',
        '0.2 mi',
        '0.6 mi',
        '1.0 mi',
        '9.9 mi',
        '10 mi',
        '155 mi',
      ].map(nbsp),
    ),
  );
  // Each cut is taken after rounding: 999.9 ft reads 0.2 mi, not 1000 ft,
  // and 9.96 mi reads 10 mi, not 10.0.
  assert.deepEqual(
    [
      distanceParts(304.77, { system: 'imperial' }),
      distanceParts(16_030, { system: 'imperial' }),
    ],
    [
      { value: 0.2, unit: 'mi', digits: 1 },
      { value: 10, unit: 'mi', digits: 0 },
    ],
  );
  // Route steps round to tens in both systems and stay exact when short.
  assert.deepEqual(
    [42, 150, 1234].map((m) =>
      formatDistanceText(m, {
        metreStep: 10,
        exactBelowM: 100,
        system: 'imperial',
      }),
    ),
    ['138 ft', '490 ft', '0.8 mi'],
  );
});

test('missing, negative and non-numeric readings stay "\u2014" in both systems', () => {
  for (const system of ['metric', 'imperial'])
    inSystem(system, () => {
      for (const value of [null, undefined, '', NaN, Infinity, true]) {
        assert.equal(formatMeasure(value, 'km'), '\u2014', `${system} ${value}`);
        assert.equal(formatSpeed(value), '\u2014');
        assert.equal(formatTemperature(value), '\u2014');
        assert.equal(formatDistance(value), '\u2014');
        assert.equal(formatCompactLength(value), '\u2014');
      }
      assert.equal(formatDistance(-5), '\u2014');
    });
  // Zero is a reading, not a missing one.
  assert.equal(formatSpeed(0), '0\u00a0km/h');
  assert.equal(
    inSystem('imperial', () => formatSpeed(0)),
    '0\u00a0mph',
  );
  assert.equal(formatTemperature(0), '0\u00a0\u00b0C');
  assert.equal(
    inSystem('imperial', () => formatTemperature(0)),
    '32\u00a0\u00b0F',
  );
});

test('speeds, temperatures and areas convert; below zero keeps its sign', () => {
  setLocale('en');
  assert.equal(formatSpeed(10), '36\u00a0km/h');
  assert.equal(formatTemperature(-40), '-40\u00a0\u00b0C');
  assert.equal(
    formatTemperature(-3.26, { maximumFractionDigits: 1 }),
    '-3.3\u00a0\u00b0C',
  );
  assert.equal(formatArea(2.5, { maximumFractionDigits: 2 }), '2.5\u00a0km\u00b2');
  inSystem('imperial', () => {
    assert.equal(formatSpeed(10), '22\u00a0mph');
    assert.equal(
      formatSpeed(10, { maximumFractionDigits: 1 }),
      '22.4\u00a0mph',
    );
    assert.equal(formatMeasure(100, 'km/h'), '62\u00a0mph');
    assert.equal(
      formatMeasure(7.8, 'km/s', { useGrouping: true }),
      '17,448\u00a0mph',
    );
    assert.equal(formatTemperature(-40), '-40\u00a0\u00b0F');
    assert.equal(formatTemperature(-20), '-4\u00a0\u00b0F');
    // -17.9 \u00b0C is -0.2 \u00b0F: it rounds to 0, never to "-0".
    assert.equal(formatTemperature(-17.9), '0\u00a0\u00b0F');
    assert.equal(
      formatTemperature(37, { maximumFractionDigits: 1 }),
      '98.6\u00a0\u00b0F',
    );
    assert.equal(
      formatArea(2.5, { maximumFractionDigits: 2 }),
      '0.97\u00a0mi\u00b2',
    );
    // Very large and very small values keep their scale.
    assert.equal(
      formatMeasure(40_075, 'km', { useGrouping: true }),
      '24,901\u00a0mi',
    );
    assert.equal(
      formatMeasure(0.0003, 'km', { maximumFractionDigits: 4 }),
      '0.0002\u00a0mi',
    );
    assert.equal(formatCompactLength(120), '394ft');
    assert.equal(formatCompactLength(0.3, 1), '1.0ft');
  });
  assert.equal(formatCompactLength(120), '120m');
});

test('aviation, marine, pressure and signal units read the same in both systems', () => {
  setLocale('en');
  const units = ['kt', 'kts', 'NM', 'hPa', 'dB', 'dBZ', 'FL', 'mph', 'ft'];
  const metric = units.map((unit) => formatMeasure(250, unit));
  const imperial = inSystem('imperial', () =>
    units.map((unit) => formatMeasure(250, unit)),
  );
  assert.deepEqual(imperial, metric);
  assert.deepEqual(
    inSystem('imperial', () => convertQuantity(1013, 'hPa')),
    { value: 1013, unit: 'hPa' },
  );
  // The plain formatter never converts.
  assert.equal(
    inSystem('imperial', () => formatQuantity(95, 'kt')),
    '95\u00a0kt',
  );
});

test('a \u00b0C legend reads in \u00b0F under imperial; other legends stay as given', () => {
  setLocale('en');
  assert.equal(formatScaleRange('-40', '50+', '\u00b0C'), '-40 \u2014 50+\u00a0\u00b0C');
  inSystem('imperial', () => {
    assert.equal(formatScaleRange('-40', '50+', '\u00b0C'), '-40 \u2014 122+\u00a0\u00b0F');
    assert.equal(
      formatScaleRange('960', '1050+', 'hPa'),
      '960 \u2014 1050+\u00a0hPa',
    );
    // A wind-speed legend follows the wind layer's own unit chips.
    assert.equal(formatScaleRange('0', '108+', 'km/h'), '0 \u2014 108+\u00a0km/h');
    assert.equal(formatScaleRange('0', '30', 'm/s'), '0 \u2014 30\u00a0m/s');
  });
});

test('converted readings follow the language: decimal comma, local unit, isolates', () => {
  try {
    setLocale('ru');
    inSystem('imperial', () => {
      assert.equal(formatDistance(1234), '0,8\u00a0\u043c\u0438');
      assert.equal(
        formatSpeed(10, { maximumFractionDigits: 1 }),
        '22,4\u00a0\u043c\u0438\u043b\u044c/\u0447',
      );
      assert.equal(
        formatTemperature(-3.25, { maximumFractionDigits: 1 }),
        '26,2\u00a0\u00b0F',
      );
      assert.equal(formatCompactLength(120), '394 \u0444\u0442');
    });
    setLocale('ar');
    assert.match(
      inSystem('imperial', () => formatDistance(5000)),
      /^\u2068\S+\u00a0\u0645\u064a\u0644\u2069$/,
    );
  } finally {
    setLocale('en');
  }
});

test('the unit system is the stored choice, else metric', () => {
  const resolve = (initial) =>
    resolveUnitSystem({ storage: memoryStorage(initial) });
  assert.equal(resolve(), 'metric');
  assert.equal(resolve({ [UNIT_SYSTEM_STORAGE_KEY]: 'imperial' }), 'imperial');
  assert.equal(resolve({ [UNIT_SYSTEM_STORAGE_KEY]: 'metric' }), 'metric');
  // A damaged entry or blocked storage falls back to metric.
  assert.equal(resolve({ [UNIT_SYSTEM_STORAGE_KEY]: 'furlongs' }), 'metric');
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(resolveUnitSystem({ storage: blocked }), 'metric');
  assert.equal(persistUnitSystem('imperial', { storage: blocked }), false);

  const storage = memoryStorage();
  assert.equal(persistUnitSystem('IMPERIAL', { storage }), true);
  assert.equal(storage.data.get(UNIT_SYSTEM_STORAGE_KEY), 'imperial');
  assert.equal(resolveUnitSystem({ storage }), 'imperial');
  persistUnitSystem('nonsense', { storage });
  assert.equal(storage.data.get(UNIT_SYSTEM_STORAGE_KEY), 'metric');
});

test('switching the unit system tells its listeners once per change', () => {
  const heard = [];
  const stop = onUnitSystemChange(() => heard.push(getUnitSystem()));
  try {
    assert.equal(setUnitSystem('imperial'), 'imperial');
    assert.equal(setUnitSystem('imperial'), 'imperial');
    assert.equal(setUnitSystem('bogus'), 'metric');
    assert.deepEqual(heard, ['imperial', 'metric']);
  } finally {
    stop();
    setUnitSystem('metric');
  }
  setUnitSystem('imperial');
  setUnitSystem('metric');
  assert.deepEqual(heard, ['imperial', 'metric'], 'a stopped listener hears nothing');
});
