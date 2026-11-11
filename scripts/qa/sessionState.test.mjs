import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { optionSpecs, REGISTRY_BY_ID } from '../../src/data/layerState.js';
import { createFakeEngine } from '../../src/globe/testing/fakeEngine.js';
import { createOsmPlacesLayer } from '../../src/layers/osmPlaces/index.js';
import { createWindLayer } from '../../src/layers/wind/index.js';
import { createApplicationLocalAdsb } from '../../src/app/layers/localAdsb.js';
import { radioLayer } from '../../src/data/radio.js';
import {
  withRadioLayer,
  radioStationRow,
} from '../../src/testSupport/radioLayerHarness.mjs';
import { radioTestEngine } from '../../src/testSupport/radioTestEngine.mjs';
import { loadLayerRenderers } from '../../src/app/layers/renderers.js';
import { createApplicationDirectionsLayer } from '../../src/data/directions.js';
import { createDirectionsDisplay } from '../../src/layers/directions/render/display.js';

// Each entry has a non-default retention exercise below. A new declaration
// needs an exercise; spelling a plausible field name alone cannot suppress QA.
const declarations = {
  'src/layers/radio/index.js': ['selected', 'audioState'],
  'src/layers/wind/index.js': ['reading'],
  'src/layers/osmPlaces/index.js': ['enabled', 'results'],
  'src/layers/localAdsb/index.js': ['enabled'],
  'src/layers/directions/index.js': ['route'],
};
test('every declaration is covered by a real handoff exercise, without extra fields', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  const found = {};
  for (const file of files.filter((file) => file.endsWith('.js') && existsSync(file))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/sessionState\s*:\s*(\[[^\]]*\])/g)) {
      assert.ok(!found[file], `Duplicate declaration in ${file}`);
      found[file] = JSON.parse(match[1].replaceAll("'", '"'));
    }
  }
  assert.deepEqual(found, declarations);
});

function verifyFields(layer, before, after) {
  assert.deepEqual([...layer.sessionState].sort(), Object.keys(before).sort());
  for (const field of layer.sessionState) {
    assert.notEqual(before[field], undefined, field);
    assert.deepEqual(
      after[field],
      before[field],
      `${layer.id}.${field} survived detach/attach`,
    );
    assert.ok(
      !optionSpecs(layer.id).some((spec) => spec.key === field),
      `${field} is not a share option`,
    );
  }
}

test('radio selection and playback survive reattachment; volume is shareable', async () => {
  await loadLayerRenderers('cesium');
  const station = radioStationRow();
  await withRadioLayer({ stations: [station] }, async () => {
    radioLayer.selectStation(station.id, {
      autoplay: true,
      focus: false,
      origin: 'user',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const state = () => {
      const { selected, audioState } = radioLayer.getUIState();
      return { selected, audioState };
    };
    const before = state();
    assert.equal(before.selected.id, station.id);
    assert.notEqual(before.audioState, 'idle');
    radioLayer.detachRenderer();
    radioLayer.attachRenderer({ engine: radioTestEngine() });
    verifyFields(radioLayer, before, state());
    assert.ok(optionSpecs('radio').some((spec) => spec.key === 'volume'));
  });
});

test('wind inspection survives reattachment; pause is a share option', async () => {
  const field = {
    model: 'gfs',
    grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180 },
    u: new Float32Array(4).fill(4),
    v: new Float32Array(4).fill(3),
    cycle: { validIso: '2026-11-02T12:00:00Z' },
  };
  const layer = createWindLayer({
    feed: { getSnapshot: async () => field },
    createNativeRendering: () => ({
      attach() {},
      start() {},
      stop() {},
      clear() {},
      destroy() {},
      setField() {},
      getDiagnostics: () => ({}),
    }),
  });
  try {
    layer.init(null, { engine: createFakeEngine() });
    layer.enable();
    await layer.update();
    layer.setParams({ inspect: true });
    const before = { reading: layer.getRowControls().summary.reading };
    assert.ok(before.reading);
    layer.detachRenderer();
    layer.attachRenderer({ engine: createFakeEngine() });
    verifyFields(layer, before, {
      reading: layer.getRowControls().summary.reading,
    });
    assert.ok(optionSpecs('wind').some((spec) => spec.key === 'paused'));
  } finally {
    layer.destroy();
  }
});

test('OSM results and visibility survive reattachment but have no share registry entry', () => {
  const host = { clearSource() {}, setEntries() {}, setVisible() {} };
  const layer = createOsmPlacesLayer({
    overlayHost: host,
    overpassConfigured: async () => true,
  });
  const first = createFakeEngine(),
    second = createFakeEngine();
  const records = [
    { id: 'node/1', lat: 38.9, lon: -77.03, name: 'Fixture Clinic' },
  ];
  try {
    layer.init(null, { engine: first });
    layer.setResults(records, { label: 'Clinics', area: 'Washington' });
    layer.enable();
    const before = {
      enabled: first.movers.list()[0].shown,
      results: layer.getAnalystRecords(),
    };
    assert.equal(before.enabled, true);
    assert.equal(before.results.length, 1);
    layer.detachRenderer();
    layer.attachRenderer({ engine: second });
    verifyFields(layer, before, {
      enabled: second.movers.list()[0].shown,
      results: layer.getAnalystRecords(),
    });
    assert.equal(second.movers.list()[0].count, 1);
    assert.equal(REGISTRY_BY_ID.has(layer.id), false);
  } finally {
    layer.destroy();
    first.destroy();
    second.destroy();
  }
});

test('local receiver visibility survives reattachment without restarting its session', async () => {
  let starts = 0,
    visible = false;
  const layer = createApplicationLocalAdsb({
    receiver: { getState: () => ({ mode: 'adsb', aircraft: [] }) },
    feeds: { getState: () => ({ records: [] }), start: () => starts++ },
    renderer: {
      create: ({ engine }) => ({
        engine,
        attach() {},
        detach() {},
        destroy() {},
        setVisible: (value) => {
          visible = value;
        },
        view: { on: () => () => {} },
      }),
    },
  });
  const first = createFakeEngine(),
    second = createFakeEngine();
  try {
    layer.init(null, { engine: first });
    await layer.enable();
    const before = { enabled: visible };
    assert.equal(visible, true);
    layer.detachRenderer();
    visible = false;
    layer.attachRenderer({ engine: second });
    verifyFields(layer, before, { enabled: visible });
    assert.equal(starts, 1);
    assert.equal(REGISTRY_BY_ID.has(layer.id), false);
  } finally {
    layer.destroy();
    first.destroy();
    second.destroy();
  }
});

test('directions retain the route and its markers; a cold layer has no route', async () => {
  const geometry = [
    [10.78, 55.32],
    [10.8, 55.325],
    [10.82, 55.33],
  ];
  const layer = createApplicationDirectionsLayer({
    source: {
      getRoute: async () => ({
        ok: true,
        geometry,
        distanceM: 9000,
        durationS: 800,
        steps: geometry.map(([lon, lat], i) => ({
          lon,
          lat,
          instruction: `Step ${i}`,
          distanceM: 3000,
          durationS: 120,
        })),
      }),
    },
    groundFloor: {
      GROUND_FLOOR_LIFT_M: 2,
      cachedGroundFloor: () => 0,
      warmGroundFloor() {},
    },
    rendererFactory: createDirectionsDisplay,
  });
  layer._setOverlayHostForTest({
    setEntries() {},
    setVisible() {},
    clearSource() {},
  });
  const first = createFakeEngine(),
    second = createFakeEngine();
  try {
    layer.init(null, { engine: first });
    layer.enable();
    const cold = layer.getRowControls().list;
    layer.placeEndpoint('a', { lat: 55.32, lon: 10.78 });
    layer.placeEndpoint('b', { lat: 55.33, lon: 10.82 });
    await new Promise((resolve) => setImmediate(resolve));
    const before = { route: layer.getRowControls().list };
    assert.notDeepEqual(before.route, cold);
    assert.equal(layer.getStats().count, 3);
    layer.detachRenderer();
    layer.attachRenderer({ engine: second });
    verifyFields(layer, before, { route: layer.getRowControls().list });
    assert.equal(
      second.ground.list().find(({ id }) => id === 'directions-route').count,
      1,
    );
    assert.equal(
      second.movers.list().find(({ id }) => id === 'directions-markers').count,
      2,
    );
  } finally {
    layer.destroy();
    first.destroy();
    second.destroy();
  }
});
