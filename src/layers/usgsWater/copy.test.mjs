// USGS water cards must show the gauge readings, not just the name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localInfrastructureOverlayCopy } from '../../data/localGeojsonCore.js';
import {
  formatDate,
  formatNumber,
  isolate,
  setLocale,
  t,
} from '../../i18n/index.js';
import {
  formatReadingValue,
  usgsObservedLine,
  usgsReadingLine,
  usgsWaterCardDetails,
} from './copy.js';

// Real 2026-10-04 export values for USGS-08019500 (schema 2 shape).
const BIG_SANDY = {
  name: 'Big Sandy Ck nr Big Sandy, TX',
  usgs_site_id: 'USGS-08019500',
  site_type_code: 'ST',
  observed_time: '2026-10-04T10:00:00+00:00',
  readings: [
    {
      parameter_code: '00065',
      parameter_name: 'Gage height',
      value: 3.97,
      unit: 'ft',
      observed_time: '2026-10-04T10:00:00+00:00',
    },
    {
      parameter_code: '00060',
      parameter_name: 'Discharge',
      value: 19.6,
      unit: 'ft^3/s',
      observed_time: '2026-10-04T10:00:00+00:00',
    },
  ],
};

test('a river gauge card shows its readings and observation time', () => {
  const copy = localInfrastructureOverlayCopy(
    BIG_SANDY,
    'local-usgs-water',
    usgsWaterCardDetails,
  );
  assert.equal(copy.title, 'Big Sandy Ck nr Big Sandy, TX');
  assert.deepEqual(copy.details.slice(0, 2), [
    'Gage height 3.97 ft',
    'Discharge 19.6 ft³/s',
  ]);
  assert.match(copy.details[2], /^as of Oct 4, /);
  assert.equal(copy.details.length, 3);
});

test('the observation time is shown in the viewer time zone', () => {
  assert.equal(
    usgsObservedLine('2026-10-04T10:00:00+00:00', {
      timeZone: 'America/Chicago',
    }),
    'as of Oct 4, 5:00 AM CDT',
  );
  assert.equal(usgsObservedLine('not a time'), '');
});

test('cards cap readings at two and keep the newest time', () => {
  const lake = {
    name: 'Lake 1',
    readings: [
      {
        parameter_name: 'Lake/reservoir stage',
        value: 38.74,
        unit: 'ft',
        observed_time: '2026-10-03T12:00:00Z',
      },
      {
        parameter_name: 'Lake elevation above NAVD88',
        value: 1132.02,
        unit: 'ft',
        observed_time: '2026-10-04T12:00:00Z',
      },
      {
        parameter_name: 'Lake elevation above NGVD29',
        value: 1131.1,
        unit: 'ft',
        observed_time: '2026-10-02T12:00:00Z',
      },
    ],
  };
  const lines = usgsWaterCardDetails(lake, { timeZone: 'UTC' });
  assert.deepEqual(lines, [
    'Lake/reservoir stage 38.74 ft',
    'Lake elevation above NAVD88 1,132.02 ft',
    'as of Oct 4, 12:00 PM UTC',
  ]);
});

test('schema-1 single-reading features still show their reading', () => {
  const copy = localInfrastructureOverlayCopy(
    {
      name: 'Old format site',
      parameter_name: 'Discharge',
      value: 63800,
      unit: 'ft^3/s',
      observed_time: '2026-10-04T10:45:00+00:00',
    },
    'local-usgs-lakes',
    usgsWaterCardDetails,
  );
  assert.equal(copy.details[0], 'Discharge 63,800 ft³/s');
});

test('a gauge without a numeric reading says so', () => {
  assert.deepEqual(
    usgsWaterCardDetails({
      name: 'x',
      readings: [{ parameter_name: 'Gage height', value: null }],
    }),
    ['No current reading'],
  );
  assert.equal(
    usgsReadingLine({ parameter_name: 'Gage height', value: 'n/a' }),
    '',
  );
  assert.equal(formatReadingValue(0), '0');
});

test('datacenter and dam cards are unchanged', () => {
  const copy = localInfrastructureOverlayCopy(
    { name: 'DC', value: 5, readings: [{ parameter_name: 'x', value: 1 }] },
    'local-datacenters',
  );
  assert.deepEqual(copy.details, []);
});

// The application injects the real translator and formatters
// (src/app/localGeojsonServices.js); the card text then follows the active
// language (docs/I18N.md).
const i18n = { t, formatNumber, formatDate, isolate };
const withLocale = (locale, run) => {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
};
// ICU spaces grouped digits with U+00A0 / U+202F; compare with plain spaces.
const plain = (text) => text.replace(/[\u00a0\u202f]/g, ' ');

test('a German card words, numbers and times its readings in German', () => {
  const lines = withLocale('de', () =>
    usgsWaterCardDetails(BIG_SANDY, { timeZone: 'UTC', i18n }),
  );
  assert.equal(lines[0], 'Pegelstand 3,97 ft');
  assert.equal(lines[1], 'Abfluss 19,6 ft³/s');
  assert.match(lines[2], /^Stand: 4\. Okt\./);
  assert.match(lines[2], /10:00/);
  assert.equal(lines.length, 3);
});

test('a Russian card groups and separates numbers the Russian way', () => {
  const lines = withLocale('ru', () =>
    usgsWaterCardDetails(
      {
        readings: [
          {
            parameter_name: 'Lake elevation above NAVD88',
            value: 1132.02,
            unit: 'ft',
            observed_time: '2026-10-04T10:00:00Z',
          },
        ],
      },
      { i18n },
    ),
  );
  assert.equal(plain(lines[0]), 'Высота озера над NAVD88 1 132,02 ft');
  assert.match(lines[1], /^на 4 окт\./);
  withLocale('ru', () => {
    assert.equal(plain(formatReadingValue(63800.126, { i18n })), '63 800,13');
  });
});

test('a gauge without a reading says so in the active language', () => {
  const empty = { name: 'x', readings: [{ parameter_name: 'Gage height' }] };
  assert.deepEqual(
    withLocale('de', () => usgsWaterCardDetails(empty, { i18n })),
    ['Keine aktuelle Messung'],
  );
  assert.deepEqual(
    withLocale('ja', () => usgsWaterCardDetails(empty, { i18n })),
    ['現在の測定値なし'],
  );
});

test('a reading with no name or code uses the translated fallback label', () => {
  assert.equal(usgsReadingLine({ value: 1, unit: 'ft' }), 'Reading 1 ft');
  assert.equal(
    withLocale('de', () => usgsReadingLine({ value: 1, unit: 'ft' }, { i18n })),
    'Messwert 1 ft',
  );
});

test('a parameter name the server list does not hold shows as sent', () => {
  assert.equal(
    withLocale('de', () =>
      usgsReadingLine(
        { parameter_name: 'Turbidity', value: 2.5, unit: 'FNU' },
        { i18n },
      ),
    ),
    'Turbidity 2,5 FNU',
  );
});

test('the language is read when a card is built, not when the module loads', () => {
  const build = () =>
    usgsWaterCardDetails(BIG_SANDY, { timeZone: 'UTC', i18n });
  const english = build();
  const german = withLocale('de', build);
  assert.notDeepEqual(german, english);
  assert.deepEqual(build(), english);
  assert.equal(english[0], 'Gage height 3.97 ft');
});

test('in a right-to-left language a value stays with its unit', () => {
  const [line] = withLocale('ar', () =>
    usgsWaterCardDetails(BIG_SANDY, { i18n }),
  );
  assert.equal(line, 'ارتفاع المقياس \u20683.97 ft\u2069');
});

test('every parameter name the server sends has a translation', async () => {
  const { USGS_PARAM_NAMES } =
    await import('../../../server/providers/usgsWater.js');
  for (const name of Object.values(USGS_PARAM_NAMES)) {
    const line = withLocale('de', () =>
      usgsReadingLine({ parameter_name: name, value: 1, unit: 'ft' }, { i18n }),
    );
    assert.ok(!line.startsWith(`${name} `), `${name} is not translated`);
  }
});

// Without injected wording the card is English with en-US formats, whatever
// the application language is: copy.js does not read the application locale.
test('without injected wording the card is English in every application language', () => {
  const lake = {
    readings: [
      {
        parameter_name: 'Lake elevation above NAVD88',
        value: 1132.02,
        unit: 'ft',
        observed_time: '2026-10-04T12:00:00Z',
      },
    ],
  };
  const expected = [
    'Lake elevation above NAVD88 1,132.02 ft',
    'as of Oct 4, 12:00 PM UTC',
  ];
  for (const locale of ['de', 'ru', 'ar', 'ja']) {
    assert.deepEqual(
      withLocale(locale, () => usgsWaterCardDetails(lake, { timeZone: 'UTC' })),
      expected,
      locale,
    );
    assert.equal(
      withLocale(locale, () => formatReadingValue(63800.126)),
      '63,800.13',
      locale,
    );
    assert.equal(
      withLocale(locale, () => usgsReadingLine({ value: 1, unit: 'ft' })),
      'Reading 1 ft',
      locale,
    );
    assert.deepEqual(
      withLocale(locale, () =>
        usgsWaterCardDetails({ readings: [{ value: null }] }),
      ),
      ['No current reading'],
      locale,
    );
  }
});

test('injected wording is used in the application language, un-injected stays English', () => {
  const lake = {
    readings: [
      {
        parameter_name: 'Gage height',
        value: 3.97,
        unit: 'ft',
        observed_time: '2026-10-04T12:00:00Z',
      },
    ],
  };
  withLocale('de', () => {
    assert.equal(
      usgsWaterCardDetails(lake, { timeZone: 'UTC' })[0],
      'Gage height 3.97 ft',
    );
    assert.equal(
      usgsWaterCardDetails(lake, { timeZone: 'UTC', i18n })[0],
      'Pegelstand 3,97 ft',
    );
  });
});

test('each wording function is used on its own and the others keep their English default', () => {
  const lake = {
    readings: [
      {
        parameter_name: 'Gage height',
        value: 1132.5,
        unit: 'ft',
        observed_time: '2026-10-04T12:00:00Z',
      },
    ],
  };
  const only = (name, fn) =>
    usgsWaterCardDetails(lake, { timeZone: 'UTC', i18n: { [name]: fn } });
  assert.deepEqual(
    only('t', (text) => `<${text}>`),
    ['<Gage height> 1,132.5 ft', '<as of {time}>'],
  );
  assert.deepEqual(
    only('formatNumber', () => 'N'),
    ['Gage height N ft', 'as of Oct 4, 12:00 PM UTC'],
  );
  assert.deepEqual(
    only('formatDate', () => 'D'),
    ['Gage height 1,132.5 ft', 'as of D'],
  );
  assert.deepEqual(
    only('isolate', (text) => `[${text}]`),
    ['Gage height [1,132.5 ft]', 'as of Oct 4, 12:00 PM UTC'],
  );
  assert.deepEqual(
    usgsWaterCardDetails(lake, {
      timeZone: 'UTC',
      i18n: { t: 'not a function' },
    }),
    ['Gage height 1,132.5 ft', 'as of Oct 4, 12:00 PM UTC'],
  );
});
