import assert from 'node:assert/strict';
import test from 'node:test';
import { createVigicruesFloodsLayer } from '../layers/vigicruesFloods/index.js';
import { createCopernicusEmsLayer } from '../layers/copernicusEms/index.js';
import { createEntsoeGridLayer } from '../layers/entsoeGrid/index.js';
import { createIgnGeoplateformeLayer } from '../layers/ignGeoplateforme/index.js';
import { createBikeshareLayer } from '../layers/bikeshare/index.js';
import {
  createQueries as createTransitQueries,
  transitCountLabel,
} from '../layers/transit/queries.js';
import { transitStationSegments } from '../layers/transit/stationModel.js';
import { LayerPanel } from './layerPanel.js';

/**
 * The GUI coherence pass: the French public-data layers present themselves in
 * the SAME visual grammar as the pre-existing layers, using only the three
 * existing sub-block patterns (legend / chips / readout).
 *
 * These tests assert the SHAPE of each row's descriptor, not its wording:
 * a legend is a list of {label, color, count}, chips are {id, label, params}
 * and a readout is {readout: true, summary}.
 *
 * The suite lives HERE, beside the panel that renders the three patterns,
 * because it is a CROSS-LAYER contract: it asserts that six different layer
 * packages and the panel agree on one grammar. No layer owns it alone.
 */

const viewerStub = () => ({
  dataSources: { add() {}, remove() {} },
  imageryLayers: { addImageryProvider() {}, remove() {} },
});

const overlayStub = () => ({
  setEntries() {},
  setVisible() {},
  clearSource() {},
});

/** A legend entry is complete only with a label, a colour and a count. */
function assertLegendShape(legend, label) {
  assert.ok(Array.isArray(legend), label + ': the legend is a list');
  assert.ok(legend.length, label + ': the legend is not empty');
  for (const entry of legend) {
    assert.equal(typeof entry.label, 'string', label + ': every band is named');
    assert.ok(entry.label, label + ': every band has a label');
    assert.match(
      entry.color,
      /^#[0-9a-f]{6}$/i,
      label + ': every band carries a CSS colour',
    );
    assert.equal(
      Number.isInteger(entry.count),
      true,
      label + ': every band carries a live count',
    );
    assert.ok(entry.count >= 0, label + ': a count is never negative');
  }
}

/** A chip is complete only with an id, a label and a way to act. */
function assertChipShape(chips, label) {
  assert.ok(Array.isArray(chips), label + ': the chips are a list');
  assert.ok(chips.length, label + ': there is at least one chip');
  const ids = new Set();
  for (const chip of chips) {
    assert.equal(typeof chip.id, 'string', label + ': every chip is keyed');
    assert.ok(chip.id, label + ': every chip has an id');
    assert.equal(ids.has(chip.id), false, label + ': chip ids are unique');
    ids.add(chip.id);
    assert.equal(
      typeof chip.label,
      'string',
      label + ': every chip is named',
    );
    assert.ok(chip.label, label + ': every chip has a label');
    assert.ok(
      typeof chip.onClick === 'function' ||
        (chip.params && typeof chip.params === 'object'),
      label + ': every chip can be acted on',
    );
  }
}

/** A readout carries a summary with the fields the rail card reads. */
function assertReadoutShape(controls, label) {
  assert.equal(controls.readout, true, label + ': the row is a readout');
  assert.ok(controls.summary, label + ': the readout has a summary');
  assert.equal(
    typeof controls.summary.label,
    'string',
    label + ': the summary is named',
  );
  assert.ok(controls.summary.label, label + ': the summary has a label');
  assert.equal(
    typeof controls.summary.status,
    'string',
    label + ': the summary states a status',
  );
  assert.equal(
    typeof controls.summary.coverage,
    'string',
    label + ': the summary states a coverage',
  );
}

test('the VIGICRUES row is a legend of vigilance bands with live counts', async () => {
  const layer = createVigicruesFloodsLayer({
    source: {
      getSnapshot: async () => ({
        stations: [],
        zones: [
          { id: 'z1', name: 'Z1', label: 'Z1', territory: 'X', level: 1, color: '#ffd43b', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
          { id: 'z2', name: 'Z2', label: 'Z2', territory: 'X', level: 3, color: '#e5383b', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
          { id: 'z3', name: 'Z3', label: 'Z3', territory: 'X', level: 1, color: '#ffd43b', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
        ],
        total: 3,
        observedAt: null,
      }),
    },
    overlayHost: overlayStub(),
  });
  layer.init(viewerStub());
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assert.equal(controls.readout, undefined, 'the row is a legend, not a card');
  assertLegendShape(controls.legend, 'VIGICRUES');
  const counts = Object.fromEntries(
    controls.legend.map((entry) => [entry.label, entry.count]),
  );
  assert.equal(counts['Vigilance 1'], 2, 'the band counts the zones in it');
  assert.equal(counts['Vigilance 3'], 1);
  // The scale is the model's own: the legend's colours are the map's colours.
  assert.equal(
    controls.legend.find((entry) => entry.label === 'Vigilance 3').color,
    '#e5383b',
  );
  layer.destroy();
});

test('the VIGICRUES row has no display mode to switch, so it offers no chips', async () => {
  const layer = createVigicruesFloodsLayer({
    source: {
      getSnapshot: async () => ({
        stations: [],
        zones: [],
        total: 0,
        observedAt: null,
      }),
    },
    overlayHost: overlayStub(),
  });
  layer.init(viewerStub());
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assert.deepEqual(controls.chips, [], 'the legend row carries no chips');
  layer.destroy();
});

test('the Copernicus EMS row is a readout whose badge names the activation status', async () => {
  const layer = createCopernicusEmsLayer({
    source: {
      getSnapshot: async () => ({
        activations: [
          {
            id: 'a1',
            code: 'A1',
            name: 'Flood in X',
            category: 'flood',
            categoryLabel: 'Flood',
            color: '#4cc9f0',
            phase: 'response',
            phaseLabel: 'Response',
            closed: false,
            country: 'France',
            countries: ['France'],
            lon: 1,
            lat: 2,
            activationTime: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
            aoiCount: 1,
            productCount: 1,
          },
        ],
        total: 1,
      }),
    },
    overlayHost: overlayStub(),
  });
  layer.init(viewerStub());
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assertReadoutShape(controls, 'Copernicus EMS');
  assert.equal(
    controls.summary.coverage,
    'New',
    'the badge names the activation status, not the coverage',
  );
  assert.match(
    controls.summary.detail,
    /civil-protection/,
    'the coverage moves into the card body',
  );
  assert.match(controls.summary.units, /1 new/);
  layer.destroy();
});

test('a closed Copernicus activation reads as Closed, not as New', async () => {
  const layer = createCopernicusEmsLayer({
    source: {
      getSnapshot: async () => ({
        activations: [
          {
            id: 'a1',
            code: 'A1',
            name: 'Old',
            category: 'flood',
            categoryLabel: 'Flood',
            color: '#4cc9f0',
            phase: 'recovery',
            phaseLabel: 'Recovery',
            closed: true,
            country: 'France',
            countries: ['France'],
            lon: 1,
            lat: 2,
            activationTime: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
          },
        ],
        total: 1,
      }),
    },
    overlayHost: overlayStub(),
  });
  layer.init(viewerStub());
  layer.enable();
  await layer.update();
  assert.equal(layer.getRowControls().summary.coverage, 'Closed');
  layer.destroy();
});

test('the ENTSO-E row is a readout with an hourly valid-time rail and a mode chip', async () => {
  const day = '2026-10-26';
  const layer = createEntsoeGridLayer({
    source: {
      getSnapshot: async () => ({
        series: [
          { position: 1, value: 30000, band: 'moderate' },
          { position: 2, value: 45000, band: 'high' },
        ],
        unit: 'MW',
        day,
      }),
    },
    overlayHost: overlayStub(),
  });
  layer.init(viewerStub());
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assertReadoutShape(controls, 'ENTSO-E');
  // The valid-time rail: every hour of the series is listed.
  assert.ok(controls.list, 'the card carries the hour-by-hour rail');
  assert.equal(controls.list.items.length, 2);
  assert.equal(controls.list.items[0].lead, '00:00', 'the valid time is shown');
  assert.equal(controls.list.items[1].lead, '01:00');
  // The forecast/observed toggle rides the card as a setting group.
  const settings = controls.summary.settings;
  assert.ok(Array.isArray(settings) && settings.length, 'the card has settings');
  assertChipShape(settings[0].chips, 'ENTSO-E');
  assert.deepEqual(
    settings[0].chips.map((chip) => chip.id),
    ['forecast', 'observed'],
  );
  assert.deepEqual(settings[0].chips[1].params, { mode: 'observed' });
  layer.destroy();
});

test('the ENTSO-E row says which key it needs rather than showing an empty grid', async () => {
  const layer = createEntsoeGridLayer({
    source: {
      getSnapshot: async () => {
        const error = new Error('ENTSO-E requires an API token');
        error.keyRequired = true;
        throw error;
      },
    },
    overlayHost: overlayStub(),
  });
  layer.init(viewerStub());
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assert.equal(controls.summary.status, 'KEY REQUIRED');
  // The layer names the key it needs; the PANEL builds the sentence, so
  // the layer never imports a UI helper.
  assert.equal(controls.summary.keyRequirementId, 'entsoe');
  assert.equal(
    controls.list,
    undefined,
    'a keyless layer has no hour rail to show',
  );
  layer.destroy();
});

test('the IGN row stays a layer row and offers the raster layers as chips', () => {
  const layer = createIgnGeoplateformeLayer({
    source: {
      getDescriptor: (requested) => ({
        url: '/api/ign-geoplateforme/tiles/' + (requested || 'PLANIGNV2') + '/{z}/{x}/{y}.png',
        maximumLevel: 19,
        credit: 'IGN',
      }),
    },
  });
  layer.init(viewerStub());
  const controls = layer.getRowControls();
  assert.equal(controls.readout, undefined, 'the row keeps its own line');
  assertChipShape(controls.chips, 'IGN');
  assert.deepEqual(
    controls.chips.map((chip) => chip.id),
    ['PLANIGNV2', 'PLANIGNV2.L93', 'ORTHOPHOTOS'],
  );
  for (const chip of controls.chips) {
    assert.equal(
      typeof chip.params.raster,
      'string',
      'the chip names the raster it switches to',
    );
  }
  layer.destroy();
});

test('the Bike Share row is a legend of the availability ramp, shared with Velib', async () => {
  const layer = createBikeshareLayer({
    source: { getStations: async () => ({}) },
    services: {
      overlays: {
        setOverlayEntries() {},
        setOverlaySourceVisible() {},
        clearSource() {},
      },
      render: { governorRequestRender() {} },
      sprites: {
        registerSpriteCollection() {},
        unregisterSpriteCollection() {},
        restoreSpriteOrder() {},
      },
      picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    },
  });
  const controls = layer.getRowControls();
  assert.equal(controls.readout, undefined, 'the row is a legend, not a card');
  assertLegendShape(controls.legend, 'Bike Share');
  // The ramp is the one the map draws: the same five colours.
  assert.deepEqual(
    controls.legend.map((entry) => entry.color),
    ['#00ff88', '#ffaa00', '#ff4444', '#687581', '#91a4b4'],
  );
});

test('the healthy meta line is three short segments and carries no detail', async () => {
  const panel = LayerPanel.prototype;
  const text = panel._buildMetaText({
    id: 'transit',
    name: 'Transit',
    source: 'GTFS-RT · SNCF',
    enabled: true,
    stats: { count: 12, lastUpdate: Date.now() },
  });
  // The SOURCE may itself name two datasets, so the segments are counted
  // from the ends: state first, age last.
  assert.match(text, /^ON · GTFS-RT · SNCF · /, 'state, then the source');
  assert.match(text, / · just now$/, 'and the age last');
  assert.equal(
    text.slice('ON · '.length).split(' · ').length,
    3,
    'the nominal row is state, source and age',
  );
});

test('the healthy meta line of a single-source layer is three segments too', async () => {
  const panel = LayerPanel.prototype;
  const text = panel._buildMetaText({
    id: 'vigicrues-floods',
    name: 'Flood Warnings',
    source: 'VIGICRUES',
    enabled: true,
    stats: { count: 4, lastUpdate: Date.now() },
  });
  assert.equal(text.split(' · ').length, 3);
  assert.match(text, /^ON · VIGICRUES · /);
});

test('every degraded path still reports its detail', async () => {
  const panel = LayerPanel.prototype;
  const base = { id: 'x', name: 'X', source: 'Source', enabled: true };
  // An error.
  assert.match(
    panel._buildMetaText({
      ...base,
      stats: { error: 'Connection lost', count: 3, lastUpdate: Date.now() },
    }),
    /Connection lost/,
  );
  // A partial snapshot.
  assert.match(
    panel._buildMetaText({
      ...base,
      stats: {
        partial: true,
        acceptedRowCount: 2,
        rawRowCount: 5,
        count: 2,
        lastUpdate: Date.now(),
      },
    }),
    /2 of 5 records accepted/,
  );
  // A retry countdown.
  assert.match(
    panel._buildMetaText({
      ...base,
      stats: {
        error: 'Connection lost',
        retryInSec: 12,
        count: 3,
        lastUpdate: Date.now(),
      },
    }),
    /retry 12s/,
  );
  // A fallback.
  assert.match(
    panel._buildMetaText({
      ...base,
      stats: {
        mode: 'sim',
        count: 3,
        lastUpdate: Date.now(),
        loadingLabel: 'simulated traffic',
      },
    }),
    /simulated traffic/,
  );
  // A stale feed with a countdown.
  assert.match(
    panel._buildMetaText({
      ...base,
      stats: { stale: true, retryInSec: 8, count: 3, lastUpdate: Date.now() },
    }),
    /retrying in 8s/,
  );
});

test('the Transit count splits the live fleet from the static station network', () => {
  assert.equal(
    transitCountLabel(12, 2792),
    '12 vehicles · 2792 stations',
    'both populations are named separately',
  );
});

test('the Transit count shows only the population that is present', () => {
  assert.equal(
    transitCountLabel(0, 2792),
    '2792 stations',
    'a missing fleet is not shown as a zero',
  );
  assert.equal(
    transitCountLabel(12, 0),
    '12 vehicles',
    'a missing station network is not shown as a zero',
  );
  assert.equal(
    transitCountLabel(0, 0),
    '',
    'nothing loaded means nothing to count',
  );
});

test('the Transit station legend counts the stations in each visual class', () => {
  // The legend now counts the CLASSES the map colours from: a principal
  // station (the catalogue gives it a short code) and a local station (no
  // short code), each within its rail segment. The old legend counted one
  // entry per segment letter, which could not show the rank the pins are
  // drawn in.
  const segments = transitStationSegments([
    { segment: 'A' },
    { segment: 'A' },
    { segment: 'B', shortCode: 'BC' },
    { segment: 'C' },
    { segment: null },
  ]);
  const counts = Object.fromEntries(
    segments.map((entry) => [entry.id, entry.count]),
  );
  assert.equal(counts['local:A'], 2);
  assert.equal(counts['principal:B'], 1);
  assert.equal(counts['local:C'], 1);
  assert.equal(counts['local:other'], 1);
  // The legend's colours are the map's colours.
  assert.equal(
    segments.find((entry) => entry.id === 'principal:B').color,
    '#ffd43b',
  );
});

test('the panel resolves the key sentence a layer only names', () => {
  const panel = new LayerPanel({
    getLayers: () => [
      {
        id: 'entsoe-grid',
        icon: '*',
        enabled: true,
        stats: { count: 0, keyRequired: true },
      },
    ],
    getRowControls: () => ({
      readout: true,
      summary: {
        label: 'European Grid',
        coverage: 'European electricity load',
        status: 'KEY REQUIRED',
        detail: '0 readings',
        keyRequirementId: 'entsoe',
      },
    }),
  });
  let entries = null;
  panel._weatherPanel = {
    update: (next) => {
      entries = next;
    },
  };
  panel._refreshWeatherPanel();
  const summary = entries[0].summary;
  assert.match(
    summary.detail,
    /ENTSOE_TOKEN/,
    'the card names the environment variable to set',
  );
  assert.equal(
    summary.keyRequirementId,
    undefined,
    'the raw key id does not reach the card',
  );
});

test('the source token names the dataset only, never the operator', async () => {
  const { createVigicruesFloodsLayer: vigicrues } = await import(
    '../layers/vigicruesFloods/index.js'
  );
  const { createIgnGeoplateformeLayer: ign } = await import(
    '../layers/ignGeoplateforme/index.js'
  );
  const flood = vigicrues({
    source: { getSnapshot: async () => ({ stations: [], zones: [], total: 0 }) },
    overlayHost: overlayStub(),
  });
  assert.equal(flood.source, 'VIGICRUES');
  const raster = ign({
    source: { getDescriptor: () => ({ url: '/x/{z}/{x}/{y}.png' }) },
  });
  assert.equal(raster.source, 'IGN');
});

/** The Transit row's own descriptor, built from a bare state. */
function transitRowControls({ stations = [], vehicles = 0, display = 'both' } = {}) {
  const state = {
    _stations: stations,
    _vehicles: new Map(
      Array.from({ length: vehicles }, (_, index) => [
        `v${index}`,
        { id: `v${index}` },
      ]),
    ),
    _display: display,
    _stationError: null,
    _lastUpdate: null,
  };
  const { methods } = createTransitQueries({ state, parts: {} });
  return methods;
}

test('the Transit row offers chips that switch between the fleet and the stations', () => {
  const controls = transitRowControls().getRowControls();
  assert.equal(controls.readout, undefined, 'the row is not a card');
  assertChipShape(controls.chips, 'Transit');
  assert.deepEqual(
    controls.chips.map((chip) => chip.id),
    ['vehicles', 'stations', 'both'],
    'the two populations the row draws, and both at once',
  );
  assert.deepEqual(controls.chips[0].params, { display: 'vehicles' });
  assert.deepEqual(controls.chips[1].params, { display: 'stations' });
  assert.deepEqual(controls.chips[2].params, { display: 'both' });
});

test('the Transit chips mark the mode the layer is drawing', () => {
  const byId = (controls) =>
    Object.fromEntries(controls.chips.map((chip) => [chip.id, chip.active]));
  assert.deepEqual(
    byId(transitRowControls({ display: 'both' }).getRowControls()),
    { vehicles: true, stations: true, both: true },
  );
  assert.deepEqual(
    byId(transitRowControls({ display: 'stations' }).getRowControls()),
    { vehicles: false, stations: true, both: false },
  );
  assert.deepEqual(
    byId(transitRowControls({ display: 'vehicles' }).getRowControls()),
    { vehicles: true, stations: false, both: false },
  );
});

test('the Transit row also carries the station legend beside its chips', () => {
  // The legend entries are the visual CLASSES the pins are drawn in: a
  // principal station (short code) and a local station (no short code) per
  // rail segment. The old legend listed the segment letters alone, which
  // could not show the rank the pins now encode.
  const controls = transitRowControls({
    stations: [
      { segment: 'A' },
      { segment: 'B', shortCode: 'BC' },
    ],
  }).getRowControls();
  assertLegendShape(controls.legend, 'Transit');
  const counts = Object.fromEntries(
    controls.legend.map((entry) => [entry.label, entry.count]),
  );
  assert.equal(counts['Local station (Segment A)'], 1);
  assert.equal(counts['Principal station (Segment B)'], 1);
});

test('the panel renders the split Transit count in all three states', () => {
  const panel = new LayerPanel({ getLayers: () => [] });
  const states = [
    [12, 2792, '12 vehicles · 2792 stations'],
    [0, 2792, '2792 stations'],
    [12, 0, '12 vehicles'],
  ];
  for (const [vehicles, stations, text] of states) {
    assert.equal(
      panel._layerCountText({
        count: vehicles + stations,
        countLabel: transitCountLabel(vehicles, stations),
        lastUpdate: Date.now(),
      }),
      text,
      'the split label is what the row shows',
    );
  }
});

test('a Transit row with nothing loaded keeps the empty dash', () => {
  const panel = new LayerPanel({ getLayers: () => [] });
  assert.equal(
    panel._layerCountText({ count: 0 }),
    '—',
    'nothing loaded means the row shows the dash, as before',
  );
  assert.equal(
    panel._layerCountText({ count: 0, countLabel: '' }),
    '—',
    'an empty split label does not become an empty cell',
  );
});

