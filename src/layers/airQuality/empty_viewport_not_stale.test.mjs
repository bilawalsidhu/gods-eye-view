import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { createAirQualitySource } from './providers.js';
import { interpretHourly } from './interpretation.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import {
  LayerPanel,
  layerKeyRequirementTooltip,
  presentLayerToggle,
} from '../../ui/layerPanel.js';

const ALL = ['PM2.5', 'PM10', 'O3', 'NO2', 'SO2', 'CO'];

const definition = (id, extra = {}) => ({
  id,
  title: id,
  label: `Air quality · ${id}`,
  network: id.toUpperCase(),
  coverage: `${id} coverage`,
  observation: true,
  direct: true,
  parameters: ALL,
  ...extra,
});
const OPENAQ = definition('openaq', {
  viewDriven: true,
  worldwide: true,
  direct: false,
  requiresKeyId: 'openaq',
});
const CAPE_TOWN = { lat: -33.92, lon: 18.42, name: 'Cape Town' };
const PARIS = { lat: 48.85, lon: 2.35, name: 'Paris' };
const DURBAN = { lat: -29.86, lon: 31.03, name: 'Durban' };

/** One pollutant reading at a station, as a provider answers it. */
const pollutant = (provider, place, parameter, value, extra = {}) => ({
  id: `${provider}:${place.name.toLowerCase().replace(' ', '-')}:${parameter}`,
  provider,
  stationId: place.name.toLowerCase().replace(' ', '-'),
  name: place.name,
  zone: 'Western Cape',
  lat: place.lat,
  lon: place.lon,
  parameter,
  scale: parameter,
  units: parameter === 'CO' ? 'mg/m³' : 'µg/m³',
  value,
  label: `${value}`,
  kind: 'observation',
  averagingMinutes: 60,
  observedMs: Date.now() - 10 * 60_000,
  color: '#8cb4ce',
  licenses: [{ name: 'CC BY 4.0', attribution: 'Licence holder' }],
  ...extra,
});

/** Every pollutant a station reports, for the AQI view. */
const station = (provider, place, values) =>
  Object.entries(values).map(([parameter, value]) =>
    pollutant(provider, place, parameter, value),
  );

const CAPE_TOWN_VALUES = {
  'PM2.5': 12,
  PM10: 30,
  O3: 80,
  NO2: 20,
  SO2: 5,
  CO: 0.4,
};

/**
 * A layer whose camera looks at `center` (the view centre is the middle of
 * an 800 × 600 canvas). `answers` by provider: readings, an Error, or a
 * function of the request returning either (or a promise).
 */
function cardHarness(
  answers,
  {
    definitions = [OPENAQ, definition('national')],
    coverage = {},
    view = null,
  } = {},
) {
  const calls = [];
  const camera = {
    center: { lon: CAPE_TOWN.lon, lat: CAPE_TOWN.lat },
    rect: { west: 10, south: -40, east: 35, north: -20 },
  };
  const moveEnd = [];
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  bindFakeDraw(viewer, {
    camera: {
      on(event, listener) {
        if (event === 'moveEnd') moveEnd.push(listener);
        return () => {};
      },
      viewRectangle: () => camera.rect,
    },
    query: {
      pickEllipsoid: (x, y) =>
        fromDegrees(
          camera.center.lon + (x - 400) * 0.001,
          camera.center.lat + (300 - y) * 0.001,
        ),
      isOccluded: () => false,
    },
  });
  const layer = createAirQualityLayer({
    source: {
      definitions,
      getCoverage: (id) => coverage[id] ?? null,
      async getSnapshot(request) {
        calls.push(request);
        const entry = answers[request.provider];
        const answer =
          typeof entry === 'function' ? await entry(request) : entry;
        if (answer instanceof Error) throw answer;
        return answer ?? [];
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewer);
  if (view) layer.setParams({ view });
  layer.enable();
  /** Look at `place`; `rect`, when given, is the new view rectangle. */
  const moveTo = (place, rect = camera.rect) => {
    camera.center = { lon: place.lon, lat: place.lat };
    camera.rect = rect;
    for (const listener of moveEnd) listener();
  };
  return { layer, calls, camera, moveTo };
}
import { layerFeedState } from '../../data/feedState.js';

test('a successful empty OpenAQ viewport is not reported stale', async () => {
  const { layer } = cardHarness(
    { openaq: [] },
    {
      definitions: [OPENAQ],
      coverage: { openaq: { schemaVersion: 1, complete: true } },
    },
  );
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  const stats = layer.getStats();
  assert.equal(stats.count, 0);
  assert.notEqual(stats.lastUpdate, null);
  // Now: stale true and layerFeedState 'stale' (Layers row, HUD, voice provenance).
  assert.equal(stats.stale, false);
  assert.notEqual(layerFeedState(stats), 'stale');
});
