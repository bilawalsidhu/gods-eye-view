import test from 'node:test';
import assert from 'node:assert/strict';
import {
  altitudeLabel,
  buildTurbulenceCard,
  severityLabel,
  turbulenceTitle,
  utcTime,
} from './cards.js';
import {
  applyTurbulenceFilters,
  DEFAULT_TURBULENCE_FILTERS,
  passesTurbulenceFilters,
  severityColor,
} from './model.js';

const forecast = {
  id: 'forecast:1:TURB-HI:2W',
  kind: 'forecast',
  hazard: 'TURB-HI',
  severity: 'moderate',
  band: 'high',
  baseFt: 18_000,
  topFt: 34_000,
  baseIsSurface: false,
  topUnknown: false,
  validAt: Date.parse('2026-11-17T21:00:00Z'),
  region: 'US',
  raw: null,
  polygons: [],
};

test('altitudes read as SFC, flight levels from FL180, feet below', () => {
  assert.equal(altitudeLabel(0, { surface: true }), 'SFC');
  assert.equal(altitudeLabel(18_000), 'FL180');
  assert.equal(altitudeLabel(8_000 + 4_000 * 10), 'FL480');
  assert.equal(altitudeLabel(9_000).replace(/\D/g, ''), '9000');
  assert.match(altitudeLabel(9_000), /ft/);
});

test('times are UTC clock times', () => {
  assert.equal(utcTime(Date.parse('2026-11-17T21:05:00Z')), '21:05 UTC');
  assert.equal(utcTime(NaN), 'Unavailable');
});

test('titles name the product and severity', () => {
  assert.equal(turbulenceTitle(forecast), 'Turbulence forecast · Moderate');
  assert.equal(
    turbulenceTitle({
      ...forecast,
      kind: 'warning',
      hazard: 'TURB',
      severity: 'severe',
    }),
    'Turbulence SIGMET · Severe',
  );
  assert.equal(
    turbulenceTitle({
      ...forecast,
      kind: 'warning',
      hazard: 'MTW',
      severity: 'severe',
    }),
    'Mountain wave SIGMET · Severe',
  );
  assert.equal(
    turbulenceTitle({ ...forecast, kind: 'report', severity: 'light' }),
    'Pilot report · Light',
  );
  assert.equal(severityLabel('extreme'), 'Extreme');
});

test('a forecast card: altitude band, valid time, region, disclaimer', () => {
  const card = buildTurbulenceCard(forecast);
  assert.equal(card.id, 'weather-turbulence-card:forecast:1:TURB-HI:2W');
  assert.equal(card.title, 'TURBULENCE FORECAST · MODERATE');
  assert.deepEqual(card.details, [
    'FL180 to FL340',
    'Valid 21:00 UTC',
    'US',
    'Informational only · not for flight planning',
  ]);
  assert.equal(card.accent, severityColor('moderate'));
  assert.equal(card.placement, 'above');
  assert.equal(JSON.parse(JSON.stringify(card)).title, card.title, 'JSON-safe');
});

test('a warning card: period, unknown top, trimmed raw text', () => {
  const card = buildTurbulenceCard({
    ...forecast,
    kind: 'warning',
    hazard: 'TURB',
    severity: 'severe',
    baseFt: 0,
    baseIsSurface: true,
    topFt: 60_000,
    topUnknown: true,
    validFrom: Date.parse('2026-11-17T17:00:00Z'),
    validTo: Date.parse('2026-11-17T21:00:00Z'),
    region: 'CZEG EDMONTON',
    raw: 'X'.repeat(400),
  });
  assert.equal(card.details[0], 'SFC to FL600 · Top unknown');
  assert.equal(card.details[1], 'Valid 17:00 UTC to 21:00 UTC');
  assert.equal(card.details[2], 'CZEG EDMONTON');
  assert.ok(card.details[3].length <= 160 && card.details[3].endsWith('…'));
});

test('a report card: one level and the aircraft', () => {
  const card = buildTurbulenceCard({
    ...forecast,
    kind: 'report',
    hazard: 'PIREP',
    severity: 'severe',
    baseFt: 34_000,
    topFt: 34_000,
    observedAt: Date.parse('2026-11-17T18:48:00Z'),
    aircraft: 'B764',
    region: null,
  });
  assert.deepEqual(card.details.slice(0, 2), [
    'FL340',
    'Reported 18:48 UTC · B764',
  ]);
});

test('filters: severe includes extreme; a both-band area needs either side', () => {
  const extreme = {
    ...forecast,
    kind: 'warning',
    severity: 'extreme',
    band: 'both',
  };
  assert.equal(
    passesTurbulenceFilters(extreme, DEFAULT_TURBULENCE_FILTERS),
    true,
  );
  const noSevere = applyTurbulenceFilters(DEFAULT_TURBULENCE_FILTERS, {
    severe: false,
  });
  assert.equal(noSevere.changed, true);
  assert.equal(passesTurbulenceFilters(extreme, noSevere.filters), false);
  const lowOnly = applyTurbulenceFilters(DEFAULT_TURBULENCE_FILTERS, {
    high: false,
  }).filters;
  assert.equal(passesTurbulenceFilters(extreme, lowOnly), true);
  assert.equal(passesTurbulenceFilters(forecast, lowOnly), false);
  const unchanged = applyTurbulenceFilters(DEFAULT_TURBULENCE_FILTERS, {
    high: true,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.filters, DEFAULT_TURBULENCE_FILTERS);
});
