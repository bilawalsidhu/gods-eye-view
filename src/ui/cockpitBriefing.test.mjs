import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderRegionalBrief,
  renderRegionalBriefStatus,
} from './cockpitBriefing.js';

test('Local Info labels station observations separately from modeled weather and clears obsolete readings', () => {
  const field = () => ({ textContent: '', hidden: true });
  const context = {
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
  assert.equal(context.localObservation.hidden, false);
  assert.match(
    context.localObservation.textContent,
    /DMH \/ DINAC · STATION OBSERVATION/,
  );
  assert.match(
    context.localObservation.textContent,
    /<Station & test> · 1.2 KM/,
  );
  assert.match(
    context.localObservation.textContent,
    /0.0°C · RH 0% · WIND 0 KM\/H/,
  );
  assert.match(context.localObservation.textContent, /UTC/);
  assert.equal(context.localTemperature.textContent, '24°C');
  assert.equal(context.localCondition.textContent, 'OVERCAST');
  assert.equal(context.localPrecipitation.textContent, '0.1');
  payload.stationObservation.observedAt = new Date(
    Date.now() - 91 * 60000,
  ).toISOString();
  renderRegionalBrief.call(context, payload, {});
  assert.equal(context.localObservation.hidden, true);
  assert.equal(context.localObservation.textContent, '');
  payload.stationObservation.observedAt = new Date().toISOString();
  renderRegionalBrief.call(context, payload, {});
  renderRegionalBriefStatus.call(context, 'loading', {});
  assert.equal(context.localObservation.hidden, true);
  assert.equal(context.localObservation.textContent, '');
});
