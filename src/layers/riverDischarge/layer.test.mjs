import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  createRiverDischargeLayer,
  RIVER_DISCHARGE_POLL_MS,
  RIVER_OUTLOOK_COLORS,
} from './index.js';

const days = Array.from({ length: 9 }, (_, i) =>
  new Date(Date.UTC(2026, 9, 23 + i)).toISOString().slice(0, 10),
);
const fill = (values) => ({
  time: days,
  discharge: values,
  median: values.map((v) => v * 0.9),
  min: values.map((v) => v * 0.5),
  max: values.map((v) => v * 1.8),
  p25: values.map((v) => v * 0.8),
  p75: values.map((v) => v * 1.1),
});
const point = (id, name, peak) => ({
  id,
  name,
  lat: Number(id.split('_')[0]),
  lon: Number(id.split('_')[1]),
  p50: 100,
  p90: 400,
  p99: 1000,
  mean: 150,
  max: 3000,
  series: fill([100, 120, 130, peak, 140, 120, 110, 100, 90]),
});
const snapshot = (points, extra = {}) => ({
  today: '2026-10-24',
  climatology: { from: '2012', to: '2022' },
  fetchedAt: 1_000,
  total: points.length,
  partial: false,
  stale: false,
  points,
  ...extra,
});

function harness(getOutlook) {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
  };
  globalThis.window = new EventTarget();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const added = [];
  const credits = new Map();
  const contexts = new Map();
  const boxes = [];
  let selected = null;
  let picked;
  let click = null;
  const viewer = {
    trackedEntity: null,
    camera: {
      moveEnd: new Cesium.Event(),
      positionWC: Cesium.Cartesian3.fromDegrees(10, 40, 12_000_000),
      computeViewRectangle: () => Cesium.Rectangle.fromDegrees(-20, 10, 40, 60),
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick: () => picked,
    },
    dataSources: {
      add: (value) => added.push(value),
      remove: (value) => added.splice(added.indexOf(value), 1),
    },
  };
  const layer = createRiverDischargeLayer({
    source: {
      getOutlook: (box, options) => {
        boxes.push(box);
        return getOutlook(box, options);
      },
      label: 'Open-Meteo · GloFAS model',
    },
    services: {
      render: { governorRequestRender() {} },
      picking: { registerPickOwner() {}, unregisterPickOwner() {} },
      context: {
        registerEntityContext: (entity, record) =>
          contexts.set(record.id, { ...record, entity }),
        removeEntityContextsForLayer(layerId, { retainIds } = {}) {
          for (const [id, record] of contexts)
            if (record.layerId === layerId && !retainIds?.has(id))
              contexts.delete(id);
        },
        selectEntityContext(entity) {
          selected = contexts.get(entity.id);
        },
        clearSelectedEntityContextForLayer(layerId) {
          if (selected?.layerId === layerId) selected = null;
        },
        getSelectedEntityContext: () => selected,
      },
      credits: {
        riverDischargeCreditHtml: (year) => `credit ${year}`,
        showOnScreenCredit: (_viewer, owner, html) => credits.set(owner, html),
        hideOnScreenCredit: (_viewer, owner) => credits.delete(owner),
      },
    },
  });
  const setInput = Cesium.ScreenSpaceEventHandler.prototype.setInputAction;
  Cesium.ScreenSpaceEventHandler.prototype.setInputAction = function (
    fn,
    type,
    modifier,
  ) {
    if (type === Cesium.ScreenSpaceEventType.LEFT_CLICK) click = fn;
    return setInput.call(this, fn, type, modifier);
  };
  try {
    layer.init(viewer);
  } finally {
    Cesium.ScreenSpaceEventHandler.prototype.setInputAction = setInput;
  }
  layer.enable();
  return {
    layer,
    credits,
    boxes,
    get selected() {
      return selected;
    },
    entity: (id) => added[0].entities.getById(id),
    count: () => added[0].entities.values.length,
    click(id) {
      const entity = id ? added[0].entities.getById(id) : null;
      picked = entity ? { id: entity } : undefined;
      click({ position: new Cesium.Cartesian2() });
    },
    restore() {
      layer.destroy();
      for (const name of ['window', 'document']) {
        if (originals[name] === undefined) delete globalThis[name];
        else globalThis[name] = originals[name];
      }
    },
  };
}

const colour = (level) =>
  Cesium.Color.fromCssColorString(RIVER_OUTLOOK_COLORS[level]);

test('points are coloured by their own outlook level and credited while shown', async () => {
  const h = harness(async () =>
    snapshot([
      point('30.025_31.225', 'Nile', 1200),
      point('48.175_16.425', 'Danube', 500),
      point('50.975_6.925', 'Rhine', 200),
    ]),
  );
  try {
    assert.equal(await h.layer.update(), true);
    assert.equal(h.count(), 3);
    const now = Cesium.JulianDate.now();
    assert.ok(
      h
        .entity('30.025_31.225')
        .point.color.getValue(now)
        .equals(colour('very-high')),
    );
    assert.ok(
      h
        .entity('48.175_16.425')
        .point.color.getValue(now)
        .equals(colour('high')),
    );
    assert.ok(
      h
        .entity('50.975_6.925')
        .point.color.getValue(now)
        .equals(colour('normal')),
    );
    const stats = h.layer.getStats();
    assert.deepEqual(stats.levels, {
      'very-high': 1,
      high: 1,
      normal: 1,
      unknown: 0,
    });
    assert.equal(stats.modelled, true);
    assert.equal(stats.today, '2026-10-24');
    assert.equal(h.credits.get('river-discharge'), 'credit 2026');
    for (const [key, value] of Object.entries({
      south: 10,
      west: -20,
      north: 60,
      east: 40,
    }))
      assert.ok(Math.abs(h.boxes[0][key] - value) < 1e-9, key);
    assert.deepEqual(
      h.layer.getRowControls().legend.map((row) => row.count),
      [1, 1, 1],
    );
  } finally {
    h.restore();
  }
});

test('a click opens a card that names the river, the numbers and the model caveat', async () => {
  const h = harness(async () =>
    snapshot([point('30.025_31.225', 'Nile', 1200)]),
  );
  try {
    await h.layer.update();
    h.click('30.025_31.225');
    assert.equal(h.selected?.id, '30.025_31.225');
    assert.equal(h.selected.properties.modelled, true);
    assert.equal(h.selected.properties.forecastPeakM3s, 1200);
    const card = h.entity('30.025_31.225').gevLabelModel;
    assert.equal(card.title, 'Nile');
    assert.deepEqual(card.details, [
      'RIVER DISCHARGE OUTLOOK · MODELLED',
      'Above the 99th percentile',
      '7-day forecast peak 1,200 m³/s on 2026-10-26',
      'Today 120 m³/s',
      'Ensemble on peak day: middle half 960–1,320, highest member 2,160 m³/s',
      '2012–2022 daily flow: median 100 · 90th 400 · 99th 1,000 m³/s',
      'Model outlook, not an observed flood or an official warning',
      'Open-Meteo.com · GloFAS (Copernicus EMS)',
    ]);
    h.click(null);
    assert.equal(h.selected, null);
  } finally {
    h.restore();
  }
});

test('a failed refresh keeps earlier points as stale; disable clears them and the credit', async () => {
  let fail = false;
  const h = harness(async () => {
    if (fail)
      throw Object.assign(new Error('Open-Meteo HTTP 503'), { status: 503 });
    return snapshot([point('30.025_31.225', 'Nile', 300)]);
  });
  try {
    await h.layer.update();
    fail = true;
    assert.equal(await h.layer.update(), false);
    const stats = h.layer.getStats();
    assert.equal(stats.error, 'Open-Meteo HTTP 503');
    assert.equal(stats.stale, true);
    assert.equal(stats.status, 'stale');
    assert.equal(h.count(), 1);
    h.layer.disable();
    assert.equal(h.count(), 0);
    assert.equal(h.credits.has('river-discharge'), false);
  } finally {
    h.restore();
  }
});

test('the layer refreshes on its own poll until disabled, so the manager ticks its row', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // Count the intervals the layer holds; a poll left running after disable
  // only shows up here, because a disabled layer's read is a no-op.
  const live = new Set();
  const { setInterval: arm, clearInterval: disarm } = globalThis;
  globalThis.setInterval = (...args) => {
    const id = arm(...args);
    live.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    live.delete(id);
    return disarm(id);
  };
  let reads = 0;
  const h = harness(async () => {
    reads += 1;
    return snapshot([point('30.025_31.225', 'Nile', 300)]);
  });
  try {
    assert.equal(live.size, 1, 'enable arms one poll');
    await h.layer.update();
    assert.equal(reads, 1);
    t.mock.timers.tick(RIVER_DISCHARGE_POLL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    h.layer.disable();
    assert.equal(live.size, 0, 'disable releases the poll');
    t.mock.timers.tick(RIVER_DISCHARGE_POLL_MS * 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2, 'no poll after disable');
    // DataLayerManager ticks a row's stats every second only for a layer
    // without an interval; with one, a camera-driven count waits for the poll.
    assert.equal(h.layer.updateInterval, 0);
  } finally {
    h.restore();
    globalThis.setInterval = arm;
    globalThis.clearInterval = disarm;
  }
});

test('points on the far side of the Earth are hidden, near ones drawn', async () => {
  const h = harness(async () =>
    snapshot([
      point('48.175_16.425', 'Danube', 200),
      point('-38.025_-62.025', 'Far', 200),
    ]),
  );
  try {
    await h.layer.update();
    assert.equal(h.entity('48.175_16.425').show, true);
    assert.equal(h.entity('-38.025_-62.025').show, false);
  } finally {
    h.restore();
  }
});

test('a peak on the analysis day, where members cannot disagree, shows no spread line', async () => {
  const flat = point('48.175_16.425', 'Danube', 100);
  const values = [100, 900, 300, 200, 150, 120, 110, 100, 90];
  flat.series = {
    time: days,
    discharge: values,
    median: values,
    min: values,
    max: values,
    p25: values,
    p75: values,
  };
  const h = harness(async () => snapshot([flat]));
  try {
    await h.layer.update();
    h.click('48.175_16.425');
    const details = h.entity('48.175_16.425').gevLabelModel.details;
    assert.ok(details.includes('7-day forecast peak 900 m³/s on 2026-10-24'));
    assert.equal(
      details.some((line) => line.startsWith('Ensemble')),
      false,
    );
  } finally {
    h.restore();
  }
});
