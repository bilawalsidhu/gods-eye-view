import assert from 'node:assert/strict';
import test from 'node:test';
import { createBriefState } from './cockpitBriefPages.js';
import { setLocale } from '../i18n/index.js';
import {
  renderRegionalBrief,
  renderRegionalBriefStatus,
  showBriefPage,
} from './cockpitBriefing.js';

function controller() {
  const ui = {
    services: {
      weatherCodeLabel: (code) => (code === 0 ? 'CLEAR' : 'UNKNOWN'),
    },
    brief: createBriefState(),
    publishBriefView() {},
    scheduleContextLayout() {},
    briefPageIndex: 2,
  };
  return ui;
}
const weather = {
  source: 'smn',
  temperatureC: 18.5,
  windKph: 11,
  windDirectionDeg: 180,
  conditionText: 'Cubierto',
  reportedAt: '2026-10-15T03:00',
  station: { id: '87178', name: 'POSADAS AERO', distanceKm: 6.747 },
};

test('Local Info renders station provenance and source wall time; page rotation preserves the provider', () => {
  const ui = controller();
  ui.regionalBrief = { weather };
  renderRegionalBrief.call(ui, ui.regionalBrief, {});
  assert.equal(ui.brief.local.temperature, '19°C');
  assert.equal(ui.brief.local.condition, 'Cubierto');
  assert.equal(ui.brief.local.precipitation, '—');
  assert.match(
    ui.brief.local.weatherStation,
    /SMN · POSADAS AERO · 6.7 KM FROM QUERY/,
  );
  assert.match(
    ui.brief.local.weatherTime,
    /2026-10-15 03:00 · TIME ZONE UNSPECIFIED/,
  );
  assert.doesNotMatch(ui.brief.local.weatherTime, /UTC/);
  assert.match(ui.brief.local.weatherCredit, /Atmospheric model by Open-Meteo/);
  showBriefPage.call(ui, 0);
  showBriefPage.call(ui, 2);
  assert.match(ui.brief.source, /SMN STATION OBSERVATION/);
});

test('model fallback and subject changes clear station attribution and old measurements', () => {
  const ui = controller();
  renderRegionalBrief.call(ui, { weather }, {});
  renderRegionalBrief.call(
    ui,
    {
      weather: {
        temperatureC: 20,
        weatherCode: 0,
        observedAt: '2026-10-15T06:00:00.000Z',
      },
    },
    {},
  );
  assert.equal(ui.brief.local.weatherSource, 'OPEN-METEO');
  assert.equal(ui.brief.local.weatherStationHidden, true);
  assert.equal(ui.brief.local.weatherStation, '');
  assert.equal(ui.brief.local.condition, 'CLEAR');
  assert.equal(ui.brief.local.weatherTime, 'MODEL 2026-10-15 06:00 UTC');
  for (const status of ['loading', 'unavailable']) {
    ui.regionalBrief = { weather };
    renderRegionalBrief.call(ui, ui.regionalBrief, {});
    renderRegionalBriefStatus.call(ui, status, {});
    assert.equal(ui.regionalBrief, null);
    assert.equal(ui.brief.local.temperature, '—');
    assert.equal(ui.brief.local.weatherStationHidden, true);
    assert.equal(ui.brief.local.weatherTimeHidden, true);
    showBriefPage.call(ui, 2);
    assert.match(ui.brief.source, /WEATHER UNAVAILABLE/);
  }
});

for (const locale of [
  'de',
  'es',
  'fr',
  'it',
  'ja',
  'pt',
  'ru',
  'uk',
  'zh-CN',
  'zh-Hant',
]) {
  test(`${locale}: station provenance follows the UI language without inventing a timezone`, () => {
    setLocale(locale);
    try {
      const ui = controller();
      renderRegionalBrief.call(ui, { weather }, {});
      assert.ok(!ui.brief.local.weatherStation.includes('KM FROM QUERY'));
      assert.ok(!ui.brief.local.weatherTime.includes('TIME ZONE UNSPECIFIED'));
      assert.ok(!ui.brief.local.weatherStationTitle.includes('Ground station'));
      assert.ok(ui.brief.local.weatherStation.includes('POSADAS AERO'));
      assert.ok(!ui.brief.local.weatherTime.includes('UTC'));
    } finally {
      setLocale('en');
    }
  });
}

for (const locale of [
  'en',
  'de',
  'es',
  'fr',
  'it',
  'ja',
  'pt',
  'ru',
  'uk',
  'zh-CN',
  'zh-Hant',
]) {
  test(`${locale}: simultaneous SMN and DMH readings keep values, clocks and clearing independent`, () => {
    setLocale(locale);
    try {
      const ui = controller();
      const stationObservation = {
        source: 'DMH / DINAC',
        stationName: 'ENCARNACION',
        distanceM: 2000,
        observedAt: new Date().toISOString(),
        temperatureC: 0,
        humidityPct: 0,
        windKph: 0,
      };
      const both = { weather, stationObservation };
      ui.regionalBrief = both;
      renderRegionalBrief.call(ui, both, {});
      showBriefPage.call(ui, 0);
      showBriefPage.call(ui, 2);
      assert.equal(ui.brief.local.temperature, '19°C');
      assert.match(ui.brief.local.weatherStation, /SMN.*POSADAS AERO/);
      assert.doesNotMatch(ui.brief.local.weatherTime, /UTC/);
      assert.equal(ui.brief.local.observationHidden, false);
      assert.match(ui.brief.local.observation, /ENCARNACION/);
      assert.match(ui.brief.local.observation, /0[.,]0°C/);
      assert.match(ui.brief.local.observation, /UTC/);
      assert.match(ui.brief.source, /SMN/);
      assert.match(ui.brief.source, /DMH \/ DINAC/);
      renderRegionalBrief.call(
        ui,
        {
          ...both,
          stationObservation: {
            ...stationObservation,
            observedAt: new Date(Date.now() - 91 * 60_000).toISOString(),
          },
        },
        {},
      );
      assert.equal(ui.brief.local.observationHidden, true);
      assert.equal(ui.brief.local.observation, '');
      assert.match(ui.brief.local.weatherStation, /POSADAS AERO/);
      assert.doesNotMatch(ui.brief.source, /DMH/);
      renderRegionalBrief.call(
        ui,
        {
          ...both,
          weather: { source: 'open-meteo', temperatureC: 24, weatherCode: 0 },
        },
        {},
      );
      assert.equal(ui.brief.local.temperature, '24°C');
      assert.equal(ui.brief.local.weatherStationHidden, true);
      assert.equal(ui.brief.local.weatherStation, '');
      assert.equal(ui.brief.local.observationHidden, false);
      assert.match(ui.brief.local.observation, /ENCARNACION/);
      for (const status of ['loading', 'unavailable']) {
        ui.regionalBrief = both;
        renderRegionalBrief.call(ui, both, {});
        renderRegionalBriefStatus.call(ui, status, {});
        showBriefPage.call(ui, 2);
        assert.equal(ui.regionalBrief, null);
        assert.equal(ui.brief.local.observationHidden, true);
        assert.equal(ui.brief.local.observation, '');
        assert.equal(ui.brief.local.weatherStationHidden, true);
        assert.equal(ui.brief.local.weatherStation, '');
        assert.equal(ui.brief.local.temperature, '—');
        assert.doesNotMatch(ui.brief.source, /SMN|DMH/);
      }
    } finally {
      setLocale('en');
    }
  });
}
