import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLocale } from '../../i18n/index.js';
import { LOCALES } from '../../i18n/locale.js';
import {
  buildSondeLabel,
  buildSelectedSondeCard,
  formatAge,
  RADIOSONDES_OVERLAY_OPTIONS,
} from './cards.js';
import { RADIOSONDE_LABEL_CANDIDATE_CAP } from './policy.js';
import { normalizeSondeFrame } from './records.js';

const now = 1_800_000_000_000;
const frame = normalizeSondeFrame(
  {
    serial: 'TEST123',
    datetime: now,
    lat: 50,
    lon: 10,
    alt: 18240,
    subtype: 'RS41-SGP',
    vel_v: 5.2,
    vel_h: 12,
    heading: 74,
    temp: -56.3,
    humidity: 2,
    pressure: 71,
    burst_timer: 750,
    frequency: 403,
    uploader_callsign: 'PRIVATE',
  },
  now,
);

test('selected card groups all metadata in short lines, including frequency and drift wind', () => {
  const card = buildSelectedSondeCard(
    frame,
    [{ ...frame, timeMs: now - 3600000 }],
    now,
  );
  assert.equal(card.title, 'BALLOON · TEST123');
  assert.deepEqual(card.details, [
    'Ascending · 18.2\u00a0km',
    'Vertical +5.2\u00a0m/s · Horizontal 12\u00a0m/s',
    'Heading 074°',
    '-56.3\u00a0°C · 2\u00a0% RH · 71\u00a0hPa',
    'Wind (drift) 12\u00a0m/s from 254°',
    'RS41-SGP · 403\u00a0MHz',
    'heard <1m ago · launched 1h ago',
    'Coverage depends on volunteer receivers',
    'SondeHub contributors · CC BY-SA 2.0',
  ]);
  assert.ok(
    card.details.length > 5,
    'the selected-card C-8 departure is explicit',
  );
  assert.ok(card.details.every((line) => line.length < 80));
  assert.doesNotMatch(JSON.stringify(card), /PRIVATE|kill timer/);
  assert.equal(card.interactive, false);
  assert.equal(card.selected, true);
  assert.equal(card.accent, '#ff8fb1');
});

test('missing selected metadata is omitted, zero measurements remain valid, and equipment stays complete', () => {
  const sparse = buildSelectedSondeCard(
    {
      ...frame,
      subtype: null,
      type: null,
      tempC: null,
      humidityPct: null,
      pressureHpa: null,
      hVelMps: null,
      headingDeg: null,
      frequencyMhz: null,
    },
    [],
    now,
  );
  assert.doesNotMatch(
    JSON.stringify(sparse),
    /kill timer|unknown|null|MHz|Wind|Heading|Horizontal/,
  );
  assert.ok(sparse.details.every(Boolean));
  const complete = buildSelectedSondeCard(
    {
      ...frame,
      type: 'RS41',
      vVelMps: 0,
      hVelMps: 0,
      headingDeg: 0,
      tempC: 0,
      humidityPct: 0,
      pressureHpa: 0,
      frequencyMhz: 403.125,
    },
    [],
    now,
  );
  assert.ok(complete.details.includes('RS41 · RS41-SGP · 403.125\u00a0MHz'));
  assert.ok(
    complete.details.includes('Vertical +0\u00a0m/s · Horizontal 0\u00a0m/s'),
  );
  assert.ok(complete.details.includes('Heading 000°'));
  assert.ok(complete.details.includes('0\u00a0°C · 0\u00a0% RH · 0\u00a0hPa'));
  const duplicate = buildSelectedSondeCard(
    { ...frame, type: 'RS41-SGP' },
    [],
    now,
  );
  assert.ok(duplicate.details.includes('RS41-SGP · 403\u00a0MHz'));
});

test('every ambient title keeps the serial and metric, including low, unknown and terminal contacts', () => {
  assert.equal(buildSondeLabel(frame).title, 'TEST123 ↑ 18.2\u00a0km');
  assert.equal(
    buildSondeLabel({ ...frame, altM: 6100, vVelMps: -16.2 }).title,
    'TEST123 ↓ 6.1\u00a0km',
  );
  // History-derived descent takes precedence over instantaneous velocity.
  assert.equal(
    buildSondeLabel(frame, 'descending').title,
    'TEST123 ↓ 18.2\u00a0km',
  );
  assert.equal(buildSondeLabel(frame, 'landed').title, 'TEST123 landed');
  assert.equal(
    buildSondeLabel(frame, 'landed-inferred').title,
    'TEST123 landed',
  );
  assert.equal(buildSondeLabel(frame, 'signal-lost').title, 'TEST123 lost');
  assert.equal(buildSondeLabel(frame, 'unknown').title, 'TEST123 18.2\u00a0km');
  for (const altM of [0, 999, 1000, 1001])
    assert.equal(
      buildSondeLabel({ ...frame, altM }).title,
      `TEST123 ↑ ${altM === 0 ? '0.0' : '1.0'}\u00a0km`,
    );
  const label = buildSondeLabel(frame);
  assert.equal(label.interactive, false);
  assert.equal(label.horizonCull, true);
  assert.equal(label.collisionGroup, 'ambient-label');
  assert.equal(label.paintLane, 'ambient-label');
  assert.equal(label.gapPx, 12);
  assert.equal(label.stateless, true);
});

test('ambient source leaves capacity for the named candidate cap and host declutter', () => {
  assert.equal(RADIOSONDE_LABEL_CANDIDATE_CAP, 150);
  assert.equal(
    RADIOSONDES_OVERLAY_OPTIONS.cohortLimit,
    RADIOSONDE_LABEL_CANDIDATE_CAP,
  );
  assert.equal(
    RADIOSONDES_OVERLAY_OPTIONS.collisionCapacity,
    RADIOSONDE_LABEL_CANDIDATE_CAP,
  );
  assert.equal(RADIOSONDES_OVERLAY_OPTIONS.moving, true);
  assert.equal(RADIOSONDES_OVERLAY_OPTIONS.solveIntervalMs, 0);
});

test('ages retain shared formatting', () => {
  assert.equal(formatAge(59_999), '<1m');
  assert.equal(formatAge(60_000), '1m');
  assert.equal(formatAge(3_600_000), '1h');
  assert.equal(formatAge(-1), null);
});

test('an observed burst maximum stays in the full card, including historical phases', () => {
  const descending = {
    ...frame,
    altM: 11882,
    vVelMps: -16.2,
    receivedMs: now - 8 * 60000,
  };
  const track = [
    { ...frame, timeMs: now - 3600000, altM: 100 },
    { ...frame, timeMs: now - 600000, altM: 27564 },
    descending,
  ];
  const card = buildSelectedSondeCard(descending, track, now);
  assert.equal(card.details[0], 'Descending · 11.9\u00a0km');
  assert.ok(card.details.includes('max 27.6\u00a0km at burst'));
  assert.ok(card.details.includes('heard 8m ago · launched 1h ago'));
  for (const phase of ['landed', 'landed-inferred', 'signal-lost'])
    assert.ok(
      buildSelectedSondeCard(descending, track, now, phase).details.includes(
        'max 27.6\u00a0km at burst',
      ),
    );
  assert.doesNotMatch(
    buildSelectedSondeCard(descending, [], now).details.join(' '),
    /at burst/,
  );
});

test('unknown or still fixes keep neutral labels and cards without an ascent arrow', () => {
  for (const vVelMps of [null, 0, 0.05, -0.05]) {
    const fix = { ...frame, vVelMps };
    assert.equal(buildSondeLabel(fix).title, 'TEST123 18.2\u00a0km');
    const card = buildSelectedSondeCard(fix, [fix], now);
    assert.equal(card.details[0], 'Direction unknown · 18.2\u00a0km');
    assert.doesNotMatch(card.details.join(' '), /Ascending|Descending|[↑↓]/);
  }
});

test('historical cards retain heard and last-fix ages, and qualify each telemetry group', () => {
  const clock = now + 11 * 60000;
  for (const [altM, phaseText, phase] of [
    [104, 'Landed (inferred)', undefined],
    [18240, 'Signal lost', undefined],
    [104, 'Landed', 'landed'],
  ]) {
    const fix = { ...frame, altM, vVelMps: 0.05, receivedMs: clock };
    const card = buildSelectedSondeCard(fix, [fix], clock, phase);
    assert.ok(
      card.details[0].startsWith(`${phaseText} · Last reported: `),
      card.details[0],
    );
    assert.ok(card.details.includes('heard <1m ago · launched 11m ago'));
    assert.ok(card.details.includes('last fix 11m ago'));
    for (const group of card.details.filter((line) =>
      /Vertical |Heading |RH|Wind /.test(line),
    ))
      assert.ok(group.startsWith('Last reported: '), group);
    assert.equal(
      card.details.some((line) => line.includes('Wind (drift)')),
      phaseText === 'Signal lost',
      'landed motion cannot be interpreted as wind',
    );
    assert.doesNotMatch(card.details.join(' '), /Ascending|Descending|[↑↓]/);
  }
});

test('heading is independent of horizontal speed and wind direction uses meteorological from', () => {
  const headingOnly = buildSelectedSondeCard(
    { ...frame, headingDeg: 359.8, hVelMps: null },
    [],
    now,
  );
  assert.ok(headingOnly.details.includes('Heading 000°'));
  assert.doesNotMatch(headingOnly.details.join(' '), /Horizontal|Wind/);
  const speedOnly = buildSelectedSondeCard(
    { ...frame, headingDeg: null },
    [],
    now,
  );
  assert.ok(speedOnly.details.includes('Wind (drift) 12\u00a0m/s'));
  assert.doesNotMatch(speedOnly.details.join(' '), /Heading|from/);
  const west = buildSelectedSondeCard({ ...frame, headingDeg: 270 }, [], now);
  assert.ok(west.details.includes('Wind (drift) 12\u00a0m/s from 090°'));
});

const cardMessageKeys = [
  'radiosonde-label|landed',
  'radiosonde-label|lost',
  'Vertical {speed}',
  'Horizontal {speed}',
  'Heading {heading}°',
  'Wind (drift) {speed} from {dir}°',
  'Wind (drift) {speed}',
];

for (const locale of LOCALES.filter((value) => value !== 'en')) {
  test(`${locale}: terminal labels and full selected metadata use translated copy`, () => {
    const catalog = JSON.parse(
      readFileSync(
        new URL(`../../i18n/locales/${locale}.json`, import.meta.url),
      ),
    );
    for (const key of cardMessageKeys) {
      assert.equal(typeof catalog[key], 'string', `${locale}: ${key}`);
      assert.notEqual(
        catalog[key],
        key.replace(/^radiosonde-label\|/, ''),
        `${locale}: ${key}`,
      );
    }
    setLocale(locale);
    try {
      assert.equal(
        buildSondeLabel(frame, 'landed').title,
        `TEST123 ${catalog['radiosonde-label|landed']}`,
      );
      assert.equal(
        buildSondeLabel(frame, 'signal-lost').title,
        `TEST123 ${catalog['radiosonde-label|lost']}`,
      );
      const card = buildSelectedSondeCard(frame, [frame], now);
      assert.doesNotMatch(
        card.details.join(' '),
        /Vertical |Horizontal |Heading |Wind \(drift\)/,
      );
      assert.ok(card.details.some((line) => line.includes('403')));
    } finally {
      setLocale('en');
    }
  });
}
