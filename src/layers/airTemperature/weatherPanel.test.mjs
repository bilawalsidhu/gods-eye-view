import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherPanel } from '../../ui/weatherPanel.js';
import { railFixture } from '../../ui/railTestFixture.mjs';
import { createAirTemperatureLayer } from './index.js';
import { field } from './fixtures.mjs';

test('Weather card changes temperature units through real descriptor actions', async (t) => {
  // Given
  const f = railFixture();
  const layer = createAirTemperatureLayer({
    feed: { getSnapshot: async () => field() },
    createRendering: () => ({
      attach() {},
      rehome() {},
      setField() {},
      clear() {},
      destroy() {},
      getDiagnostics: () => ({}),
    }),
  });
  layer.init({ container: {} });
  layer.enable();
  await layer.update();
  layer.setParams({ point: { lon: 90, lat: 0 } });
  const panel = createWeatherPanel({
    container: f.container,
    setLayerParams: (id, params) => {
      assert.equal(id, 'air-temperature');
      layer.setParams(params);
    },
  });
  const render = () =>
    panel.update([
      { id: layer.id, icon: layer.icon, ...layer.getPanelControls() },
    ]);
  layer.setRowControlsListener(render);
  t.after(() => {
    layer.setRowControlsListener(null);
    panel.destroy();
    layer.destroy();
  });
  render();
  // When
  f.find((node) => node.dataset.chipId === 'units-°F').click();
  // Then
  assert.equal(layer.getParams().units, '°F');
  assert.ok(f.find((node) => node.textContent === '10.0 °C / 50.0 °F'));
  assert.equal(
    f.find((node) => node.className === 'weather-timeline-block').hidden,
    true,
  );
});
