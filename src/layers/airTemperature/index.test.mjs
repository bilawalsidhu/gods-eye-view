import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirTemperatureLayer } from './index.js';
import { field } from './fixtures.mjs';
import { setLocale } from '../../i18n/index.js';
import { createApplicationCatalog } from '../../app/constructCatalog.js';
import { createSurfaceServices } from '../../app/surfaceServices.js';
import { createStandaloneLayerSources } from '../../standalone/layerSources.js';

function harness(feed) {
  const installed = [];
  const layer = createAirTemperatureLayer({
    feed,
    createRendering: () => ({
      attach() {},
      rehome() {},
      clear() {
        installed.length = 0;
      },
      destroy() {},
      setField(value) {
        installed.push(value);
      },
      getDiagnostics() {
        return {};
      },
    }),
  });
  layer.init({ container: {} });
  layer.enable();
  return { layer, installed };
}

test('disable rejects a late result even when the feed ignores abort', async () => {
  // Given
  let resolve;
  let active;
  const { layer, installed } = harness({
    getSnapshot: ({ signal }) => {
      active = signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const pending = layer.update();
  // When
  layer.disable();
  resolve(field());
  // Then
  assert.equal(await pending, false);
  assert.equal(active.aborted, true);
  assert.equal(installed.length, 0);
  assert.equal(layer.getStats().count, 0);
  layer.destroy();
});

test('point readout converts the captured value without requesting or resampling', async (t) => {
  // Given
  let calls = 0;
  const { layer } = harness({
    getSnapshot: async () => {
      calls++;
      return field();
    },
  });
  t.after(() => {
    layer.destroy();
    setLocale('en');
  });
  await layer.update();
  layer.setParams({ point: { lon: 90, lat: 0 } });
  // When
  layer.setParams({ units: '°F' });
  // Then
  const result = layer.getPanelControls().summary.result;
  assert.equal(
    result.lines.find(({ id }) => id === 'value').text,
    '10.0 °C / 50.0 °F',
  );
  assert.match(
    result.lines.find(({ id }) => id === 'valid').text,
    /GFS forecast, valid /,
  );
  assert.match(
    result.lines.find(({ id }) => id === 'measurement-kind').text,
    /not a station measurement/,
  );
  assert.equal(layer.getRowControls().legend[3].label, '32');
  assert.equal(calls, 1);
  for (const locale of ['es', 'ru']) {
    setLocale(locale);
    const value = layer
      .getPanelControls()
      .summary.result.lines.find(({ id }) => id === 'value').text;
    assert.match(value, /50,0 °F/);
    assert.notEqual(
      layer.getPanelControls().summary.label,
      'Air temperature · 2 m',
    );
  }
});

test('unavailable refresh clears the old image and point sample', async () => {
  // Given
  let next = field();
  const { layer, installed } = harness({ getSnapshot: async () => next });
  await layer.update();
  layer.setParams({ point: { lon: 0, lat: 0 } });
  next = {
    unavailable: true,
    stale: true,
    reason: 'Air temperature upstream unavailable',
  };
  // When
  await layer.update();
  // Then
  assert.equal(installed.length, 0);
  assert.equal(layer.getPanelControls().summary.result, null);
  assert.equal(layer.getPanelControls().summary.actions[0].disabled, true);
  layer.destroy();
});

test('application and standalone compositions construct an independent configured temperature layer', (t) => {
  // Given
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const feed = { getSnapshot: async () => field() };
  const sources = createStandaloneLayerSources({ 'air-temperature': feed });
  // When
  const catalog = createApplicationCatalog({
    sources,
    signal: lifetime.signal,
    surface: createSurfaceServices({
      signal: lifetime.signal,
      terrainSource: { getHeights: async () => [] },
    }),
  });
  // Then
  assert.equal(catalog.get('temperature').id, 'temperature');
  assert.equal(catalog.getSourceAvailability('temperature').available, true);
  assert.notEqual(catalog.get('temperature'), catalog.get('wind'));
  assert.equal(
    catalog.metadata.find(({ id }) => id === 'temperature').token,
    '5',
  );
});
