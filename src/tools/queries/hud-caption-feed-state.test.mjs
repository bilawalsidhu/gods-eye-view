import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';

// get_hud_caption shows the app's own feed state, not the model's words.
async function staleCaption(reply) {
  const conditions = {
    observedAt: '2026-10-01T19:15:00.000Z',
    temperatureC: 26.3,
    apparentTemperatureC: 32,
    precipitationMm: 0,
    cloudCoverPct: 100,
    windKph: 5.4,
    windDirectionDeg: 318,
    visibilityM: 15400,
    weatherCode: 3,
  };
  const places = {
    resolve: async (name) =>
      name === 'Austin'
        ? {
            name: 'Austin, Texas',
            bounds: { west: -97.94, south: 30.1, east: -97.56, north: 30.52 },
          }
        : null,
  };
  const staleWeather = {
    getConditions: async () => ({ status: 'stale', weather: conditions }),
  };
  let sent = null;
  const summary = {
    async summarize(context) {
      sent = context;
      return { ok: true, status: 200, data: { error: null, ...reply } };
    },
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: { weather: staleWeather, summary, places },
  });
  const result = await catalog.call('get_hud_caption', {
    area: { place: 'Austin' },
  });
  assert.equal(sent.feedProvenance.overall, 'stale');
  return result.data;
}

test('get_hud_caption keeps the canonical feed state of a stale view', async () => {
  const data = await staleCaption({
    summary: 'Austin weather across the area',
    feedState: 'stale',
  });
  assert.equal(data.feedState, 'stale');
  assert.equal(
    data.caption,
    'STALE | Austin weather across the area | WEATHER',
  );
});

test('get_hud_caption drops words whose feed state is not the app one', async () => {
  const data = await staleCaption({
    summary: 'Austin live weather looks fine',
    feedState: 'nominal',
  });
  assert.equal(data.feedState, 'stale');
  assert.equal(data.caption, 'STALE | Austin, Texas | WEATHER');
});
