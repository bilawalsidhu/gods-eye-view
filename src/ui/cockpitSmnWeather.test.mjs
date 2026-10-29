import assert from 'node:assert/strict';
import test from 'node:test';
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
    updateLocalPosition() {},
    scheduleContextLayout() {},
    briefPages: [],
    briefTabs: [],
    briefPageIndex: 2,
  };
  for (const field of [
    'localPlace',
    'localTemperature',
    'localWind',
    'localWindDirection',
    'localCondition',
    'localCloud',
    'localPrecipitation',
    'localWeatherSource',
    'localWeatherStation',
    'localWeatherTime',
    'localWeatherCredit',
    'briefSource',
  ])
    ui[field] = { textContent: '', hidden: false };
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
  assert.equal(ui.localTemperature.textContent, '19°C');
  assert.equal(ui.localCondition.textContent, 'Cubierto');
  assert.equal(ui.localPrecipitation.textContent, '—');
  assert.match(
    ui.localWeatherStation.textContent,
    /SMN · POSADAS AERO · 6.7 KM FROM QUERY/,
  );
  assert.match(
    ui.localWeatherTime.textContent,
    /2026-10-15 03:00 · TIME ZONE UNSPECIFIED/,
  );
  assert.doesNotMatch(ui.localWeatherTime.textContent, /UTC/);
  assert.match(
    ui.localWeatherCredit.textContent,
    /Atmospheric model by Open-Meteo/,
  );
  showBriefPage.call(ui, 0);
  showBriefPage.call(ui, 2);
  assert.match(ui.briefSource.textContent, /SMN STATION OBSERVATION/);
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
  assert.equal(ui.localWeatherSource.textContent, 'OPEN-METEO');
  assert.equal(ui.localWeatherStation.hidden, true);
  assert.equal(ui.localWeatherStation.textContent, '');
  assert.equal(ui.localCondition.textContent, 'CLEAR');
  assert.equal(ui.localWeatherTime.textContent, 'MODEL 2026-10-15 06:00 UTC');
  for (const status of ['loading', 'unavailable']) {
    ui.regionalBrief = { weather };
    renderRegionalBrief.call(ui, ui.regionalBrief, {});
    renderRegionalBriefStatus.call(ui, status, {});
    assert.equal(ui.regionalBrief, null);
    assert.equal(ui.localTemperature.textContent, '—');
    assert.equal(ui.localWeatherStation.hidden, true);
    assert.equal(ui.localWeatherTime.hidden, true);
    showBriefPage.call(ui, 2);
    assert.match(ui.briefSource.textContent, /WEATHER UNAVAILABLE/);
  }
});

for (const locale of ['es', 'it', 'pt', 'ru', 'uk', 'zh-CN', 'zh-Hant']) {
  test(`${locale}: station provenance follows the UI language without inventing a timezone`, () => {
    setLocale(locale);
    try {
      const ui = controller();
      renderRegionalBrief.call(ui, { weather }, {});
      assert.ok(!ui.localWeatherStation.textContent.includes('KM FROM QUERY'));
      assert.ok(
        !ui.localWeatherTime.textContent.includes('TIME ZONE UNSPECIFIED'),
      );
      assert.ok(!ui.localWeatherStation.title.includes('Ground station'));
      assert.ok(ui.localWeatherStation.textContent.includes('POSADAS AERO'));
      assert.ok(!ui.localWeatherTime.textContent.includes('UTC'));
    } finally {
      setLocale('en');
    }
  });
}

for (const locale of ['en', 'es', 'it', 'pt', 'ru', 'uk', 'zh-CN', 'zh-Hant']) {
  test(`${locale}: simultaneous SMN and DMH readings keep values, clocks and clearing independent`, () => {
    setLocale(locale);
    try {
      const ui = controller();
      ui.localObservation = { textContent: '', hidden: true };
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
      assert.equal(ui.localTemperature.textContent, '19°C');
      assert.match(ui.localWeatherStation.textContent, /SMN.*POSADAS AERO/);
      assert.doesNotMatch(ui.localWeatherTime.textContent, /UTC/);
      assert.equal(ui.localObservation.hidden, false);
      assert.match(ui.localObservation.textContent, /ENCARNACION/);
      assert.match(ui.localObservation.textContent, /0[.,]0°C/);
      assert.match(ui.localObservation.textContent, /UTC/);
      assert.match(ui.briefSource.textContent, /SMN/);
      assert.match(ui.briefSource.textContent, /DMH \/ DINAC/);
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
      assert.equal(ui.localObservation.hidden, true);
      assert.equal(ui.localObservation.textContent, '');
      assert.match(ui.localWeatherStation.textContent, /POSADAS AERO/);
      assert.doesNotMatch(ui.briefSource.textContent, /DMH/);
      renderRegionalBrief.call(
        ui,
        {
          ...both,
          weather: { source: 'open-meteo', temperatureC: 24, weatherCode: 0 },
        },
        {},
      );
      assert.equal(ui.localTemperature.textContent, '24°C');
      assert.equal(ui.localWeatherStation.hidden, true);
      assert.equal(ui.localWeatherStation.textContent, '');
      assert.equal(ui.localObservation.hidden, false);
      assert.match(ui.localObservation.textContent, /ENCARNACION/);
      for (const status of ['loading', 'unavailable']) {
        ui.regionalBrief = both;
        renderRegionalBrief.call(ui, both, {});
        renderRegionalBriefStatus.call(ui, status, {});
        showBriefPage.call(ui, 2);
        assert.equal(ui.regionalBrief, null);
        assert.equal(ui.localObservation.hidden, true);
        assert.equal(ui.localObservation.textContent, '');
        assert.equal(ui.localWeatherStation.hidden, true);
        assert.equal(ui.localWeatherStation.textContent, '');
        assert.equal(ui.localTemperature.textContent, '—');
        assert.doesNotMatch(ui.briefSource.textContent, /SMN|DMH/);
      }
    } finally {
      setLocale('en');
    }
  });
}
