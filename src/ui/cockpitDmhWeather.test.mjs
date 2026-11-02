import test from 'node:test';
import assert from 'node:assert/strict';
import { createBriefState } from './cockpitBriefPages.js';
import { setLocale } from '../i18n/index.js';
import {
  renderRegionalBrief,
  renderRegionalBriefStatus,
} from './cockpitBriefing.js';

test('Local Info labels station observations separately from modeled weather and clears obsolete readings', () => {
  const field = () => ({ textContent: '', hidden: true });
  const context = {
    brief: createBriefState(),
    publishBriefView() {},
    localObservation: field(),
    localTemperature: field(),
    localCondition: field(),
    localWind: field(),
    localCloud: field(),
    localPrecipitation: field(),
    updateLocalPosition() {},
    scheduleContextLayout() {},
    services: { weatherCodeLabel: () => 'OVERCAST' },
  };
  const payload = {
    weather: {
      temperatureC: 24,
      windKph: 20,
      weatherCode: 3,
      cloudCoverPct: 80,
      precipitationMm: 0.1,
    },
    stationObservation: {
      stationName: '<Station & test>',
      distanceM: 1234,
      temperatureC: 0,
      humidityPct: 0,
      windKph: 0,
      windDirectionDeg: 0,
      observedAt: new Date().toISOString(),
    },
  };
  renderRegionalBrief.call(context, payload, {});
  assert.equal(context.brief.local.observationHidden, false);
  assert.match(
    context.brief.local.observation,
    /DMH \/ DINAC · STATION OBSERVATION/,
  );
  assert.match(context.brief.local.observation, /<Station & test> · 1.2 KM/);
  assert.match(context.brief.local.observation, /0.0°C · RH 0% · WIND 0 KM\/H/);
  assert.match(context.brief.local.observation, /UTC/);
  assert.equal(context.brief.local.temperature, '24°C');
  assert.equal(context.brief.local.condition, 'OVERCAST');
  assert.equal(context.brief.local.precipitation, '0.1');
  for (const locale of ['es', 'ru']) {
    setLocale(locale);
    try {
      renderRegionalBrief.call(context, payload, {});
      assert.ok(
        !context.brief.local.observation.includes('STATION OBSERVATION'),
      );
      assert.ok(!context.brief.local.observation.includes('KM FROM LOCATION'));
      assert.ok(context.brief.local.observation.includes('<Station & test>'));
    } finally {
      setLocale('en');
    }
  }
  payload.stationObservation.observedAt = new Date(
    Date.now() - 91 * 60000,
  ).toISOString();
  renderRegionalBrief.call(context, payload, {});
  assert.equal(context.brief.local.observationHidden, true);
  assert.equal(context.brief.local.observation, '');
  payload.stationObservation.observedAt = new Date().toISOString();
  renderRegionalBrief.call(context, payload, {});
  renderRegionalBriefStatus.call(context, 'loading', {});
  assert.equal(context.brief.local.observationHidden, true);
  assert.equal(context.brief.local.observation, '');
});
