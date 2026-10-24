import test from 'node:test';
import assert from 'node:assert/strict';
import { createTemperatureLayer, TEMPERATURE_MODES } from './index.js';

function fakeController(name, controls) {
  const calls = [];
  let params = {};
  let listener = null;
  return {
    calls,
    enabled: false,
    get listener() {
      return listener;
    },
    init: (viewer) => calls.push(['init', viewer]),
    attachShellServices: (services) => calls.push(['shell', services]),
    enable() {
      this.enabled = true;
      calls.push(['enable']);
    },
    disable() {
      this.enabled = false;
      calls.push(['disable']);
    },
    async update(viewer) {
      calls.push(['update', viewer]);
      return true;
    },
    setParams(next) {
      calls.push(['params', next]);
      params = { ...params, ...next };
    },
    getParams: () => params,
    getPanelControls: () => controls,
    setRowControlsListener: (next) => {
      listener = next;
    },
    getStats: () => ({ source: name }),
    getDiagnostics: () => ({ name }),
    destroy: () => calls.push(['destroy']),
  };
}

/**
 * The land controller as #875 ships it: its own on-map timeline, so no
 * params, row card or row listener, and destroy needs the viewer.
 */
function fakeLand() {
  const calls = [];
  return {
    calls,
    enabled: false,
    init: (viewer) => calls.push(['init', viewer]),
    enable() {
      this.enabled = true;
      calls.push(['enable']);
    },
    disable() {
      this.enabled = false;
      calls.push(['disable']);
    },
    async update(viewer) {
      calls.push(['update', viewer]);
    },
    getStats: () => ({
      source: 'land',
      coverage: 'Clear-sky land only',
      statusMessage: '2026-09 · newest 2026-09',
    }),
    destroy: (viewer) => calls.push(['destroy', viewer]),
  };
}

function setup() {
  const land = fakeLand();
  const air = fakeController('air', {
    readout: true,
    chips: [{ id: 'units-°C' }],
    legend: [{ color: '#000', label: '-40' }],
    summary: {
      label: 'Air temperature · 2 m',
      forecast: true,
      settings: [{ id: 'units', chips: [] }],
    },
  });
  const ocean = fakeController('ocean', {
    readout: true,
    chips: [{ id: 'anomaly' }, { id: 'sst' }, { id: 'nino34' }],
    legend: [],
    summary: {
      label: 'Ocean Temperature',
      settings: [
        { id: 'mode', chips: [] },
        { id: 'context', chips: [] },
      ],
    },
  });
  const layer = createTemperatureLayer({ land, air, ocean });
  layer.init('viewer');
  return { land, air, ocean, layer };
}

test('the land surface is the default view and only the land controller runs', async () => {
  // Given
  const { land, air, ocean, layer } = setup();
  // When
  layer.enable();
  await layer.update('viewer');
  // Then
  assert.equal(layer.getParams().mode, 'land');
  assert.equal(land.enabled, true);
  assert.equal(ocean.enabled, false);
  assert.equal(air.enabled, false);
  assert.deepEqual(land.calls.at(-1), ['update', 'viewer']);
  assert.equal(layer.getStats().source, 'land');
  assert.deepEqual(
    TEMPERATURE_MODES.map(({ id }) => id),
    ['land', 'sst', 'anomaly', 'air'],
  );
});

test('switching to air hands the globe over, so two fields never stack', () => {
  // Given
  const { land, air, ocean, layer } = setup();
  layer.enable();
  // When
  layer.setParams({ mode: 'air' });
  // Then
  assert.equal(land.enabled, false);
  assert.equal(ocean.enabled, false);
  assert.equal(air.enabled, true);
  assert.deepEqual(air.calls.at(-1), ['update', 'viewer']);
  assert.deepEqual(layer.getStats(), { source: 'air' });
  // And back to the sea surface: the ocean is told which product to draw.
  layer.setParams({ mode: 'sst' });
  assert.equal(air.enabled, false);
  assert.equal(ocean.enabled, true);
  assert.ok(
    ocean.calls.some(([kind, p]) => kind === 'params' && p.mode === 'sst'),
  );
});

test('switching between the two sea products stays inside the ocean controller', () => {
  // Given
  const { land, air, ocean, layer } = setup();
  layer.enable();
  layer.setParams({ mode: 'anomaly' });
  const before = ocean.calls.length;
  const landBefore = land.calls.length;
  // When
  layer.setParams({ mode: 'sst' });
  // Then
  assert.deepEqual(ocean.calls.slice(before), [['params', { mode: 'sst' }]]);
  assert.equal(
    air.calls.some(([kind]) => kind === 'enable'),
    false,
  );
  assert.equal(land.calls.length, landBefore);
});

test('a mode change while hidden is remembered without enabling anything', () => {
  // Given
  const { land, air, ocean, layer } = setup();
  // When
  layer.setParams({ mode: 'air' });
  // Then
  assert.equal(land.enabled, false);
  assert.equal(air.enabled, false);
  assert.equal(ocean.enabled, false);
  layer.enable();
  assert.equal(air.enabled, true);
  assert.equal(land.enabled, false);
});

test('options reach the controller that owns them; point tools go to the visible one', () => {
  // Given
  const { air, ocean, layer } = setup();
  layer.enable();
  // The land timeline has no point tool, so a pick there is dropped.
  layer.setParams({ pick: true });
  layer.setParams({ mode: 'anomaly' });
  // When
  layer.setParams({ units: '°F', date: '2026-10-20', showNino34: true });
  layer.setParams({ pick: true });
  // Then
  assert.deepEqual(air.getParams(), { units: '°F' });
  assert.deepEqual(ocean.getParams(), {
    mode: 'anomaly',
    date: '2026-10-20',
    showNino34: true,
    pick: true,
  });
  assert.deepEqual(layer.getParams(), {
    mode: 'anomaly',
    units: '°F',
    date: '2026-10-20',
    showNino34: true,
  });
  // When the air field is shown, the point tool follows it.
  layer.setParams({ mode: 'air' });
  layer.setParams({ point: { lat: 1, lon: 2 } });
  assert.deepEqual(air.calls.at(-1), ['params', { point: { lat: 1, lon: 2 } }]);
});

test('one card: Temperature title, the mode picker first, no duplicate sea chips', () => {
  // Given
  const { layer } = setup();
  // When the land timeline is shown, the card carries its status.
  const land = layer.getPanelControls();
  // Then
  assert.equal(land.summary.label, 'Temperature');
  assert.equal(land.summary.status, '2026-09 · newest 2026-09');
  assert.deepEqual(
    land.chips.map(({ id }) => id),
    ['mode-land', 'mode-sst', 'mode-anomaly', 'mode-air'],
  );
  assert.deepEqual(
    land.summary.settings.map(({ id }) => id),
    ['mode'],
  );
  assert.equal(land.chips[0].active, true);
  // When the anomaly is chosen, the ocean card drops its own product chips.
  layer.setParams({ mode: 'anomaly' });
  const controls = layer.getPanelControls();
  assert.equal(controls.summary.label, 'Temperature');
  assert.deepEqual(
    controls.chips.map(({ id }) => id),
    ['mode-land', 'mode-sst', 'mode-anomaly', 'mode-air', 'nino34'],
  );
  assert.deepEqual(
    controls.summary.settings.map(({ id }) => id),
    ['mode', 'context'],
  );
  assert.equal(
    controls.chips.find(({ id }) => id === 'mode-anomaly').active,
    true,
  );
  // When the air mode is chosen, its own card keeps its forecast timing.
  layer.setParams({ mode: 'air' });
  const air = layer.getPanelControls();
  assert.equal(air.summary.forecast, true);
  assert.equal(air.chips.find(({ id }) => id === 'mode-air').active, true);
  assert.deepEqual(
    air.summary.settings.map(({ id }) => id),
    ['mode', 'units'],
  );
});

test('disable and destroy release every controller and the row listener', () => {
  // Given
  const { land, air, ocean, layer } = setup();
  const listener = () => {};
  layer.setRowControlsListener(listener);
  assert.equal(air.listener, listener);
  assert.equal(ocean.listener, listener);
  layer.enable();
  // When
  layer.destroy();
  // Then
  assert.equal(land.enabled, false);
  assert.equal(air.enabled, false);
  assert.equal(ocean.enabled, false);
  assert.deepEqual(land.calls.at(-1), ['destroy', 'viewer']);
  assert.deepEqual(air.calls.at(-1), ['destroy']);
  assert.deepEqual(ocean.calls.at(-1), ['destroy']);
});

test('missing controllers are a construction error, not a silent half layer', () => {
  assert.throws(() => createTemperatureLayer({ air: {} }), TypeError);
  assert.throws(
    () => createTemperatureLayer({ air: {}, ocean: {} }),
    TypeError,
  );
});
