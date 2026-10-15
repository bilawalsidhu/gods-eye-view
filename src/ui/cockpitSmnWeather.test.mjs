import assert from 'node:assert/strict';
import test from 'node:test';
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
