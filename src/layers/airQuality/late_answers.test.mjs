// A provider's answer that lands late (after a view switch, after a newer
// answer, or after the layer is switched off) never replaces what is drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirQualityLayer } from './index.js';
import { interpretHourly } from './interpretation.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const ALL = ['PM2.5', 'PM10', 'NO2', 'O3', 'SO2', 'CO'];
/** A network publishing its own monitors. */
const network = (id) => ({
  id,
  title: id,
  label: `Air quality · ${id}`,
  network: id.toUpperCase(),
  direct: true,
  parameters: ALL,
});
const DEFINITIONS = [network('national'), network('regional')];

/** One station's PM2.5, rated on the EEA hourly bands. */
const stationRows = (provider, name = 'Test station') => {
  const stationId = name.toLowerCase().replaceAll(' ', '-');
  return [
    interpretHourly({
      id: `${provider}:${stationId}:PM2.5`,
      provider,
      stationId,
      name,
      zone: 'Delhi',
      lat: 28.6,
      lon: 77.2,
      parameter: 'PM2.5',
      scale: 'PM2.5',
      units: 'µg/m³',
      value: 12,
      label: '12',
      kind: 'observation',
      averagingMinutes: 60,
      observedMs: Date.now() - 10 * 60_000,
    }),
  ];
};

/**
 * A hand-driven snapshot per provider: rows, `'hold'`, or a function of the
 * request returning either.
 */
function heldLayer(answers) {
  const pending = new Map();
  const source = {
    definitions: DEFINITIONS,
    getSnapshot: (request) => {
      const { provider } = request;
      const answer =
        typeof answers[provider] === 'function'
          ? answers[provider](request)
          : answers[provider];
      return answer === 'hold'
        ? new Promise((resolve) => pending.set(provider, resolve))
        : Promise.resolve(answer ?? []);
    },
  };
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  const viewer = {};
  bindFakeDraw(viewer);
  layer.init(viewer);
  return { layer, release: (provider, rows) => pending.get(provider)(rows) };
}

/**
 * Every regional request is held until released, and the stub ignores the
 * abort signal, as a slow network answer would.
 */
function queuedLayer() {
  const held = [];
  const source = {
    definitions: DEFINITIONS,
    getSnapshot: ({ provider }) =>
      provider === 'regional'
        ? new Promise((resolve) => held.push(resolve))
        : Promise.resolve([]),
  };
  const layer = createAirQualityLayer({
    source,
    overlayHost: { setEntries() {}, clearSource() {}, setVisible() {} },
  });
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  layer.init(viewer);
  const drawnIds = () => {
    const set = [...draw.sets.values()].find(
      (candidate) => candidate.kind === 'points' && !candidate.disposed,
    );
    return [...(set?.items.values() ?? [])].map((point) => point.meta.id);
  };
  return { layer, held, drawnIds };
}
/** PM2.5 rows in the PM2.5 view, nothing in the others. */
const pm25Only = (rows) => (request) =>
  request.parameter === 'PM2.5' ? rows : [];

test('switching view clears old markers and a late answer for the old view cannot replace the new one', async () => {
  const { layer, release } = heldLayer({
    national: (request) => (request.mode === 'aqi' ? 'hold' : []),
    regional: pm25Only(stationRows('regional')),
  });
  layer.enable();
  const pending = layer.update();
  layer.setParams({ view: 'PM2.5' });
  await layer.update();
  release('national', stationRows('national'));
  await pending;
  assert.deepEqual(
    layer.getAnalystRecords().map((record) => record.provider),
    ['regional'],
  );
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getParams().view, 'PM2.5');
  layer.destroy();
});

test('a late response after the view changes is dropped', async () => {
  const { layer, release } = heldLayer({
    regional: (request) => (request.parameter === 'PM2.5' ? 'hold' : []),
    national: (request) =>
      request.mode === 'aqi' ? stationRows('national') : [],
  });
  layer.setParams({ view: 'PM2.5' });
  layer.enable();
  const pendingRegional = layer.update();
  layer.setParams({ view: 'aqi' });
  assert.equal(await layer.update(), true);
  release('regional', stationRows('regional'));
  await pendingRegional;
  assert.equal(layer.getParams().view, 'aqi');
  assert.equal(layer.getStats().count, 1);
  assert.deepEqual(
    layer.getAnalystRecords().map((record) => record.provider),
    ['national'],
  );
  assert.equal(layer.getRowControls().legend.length, 6);
  layer.destroy();
});

test('in one view, a superseded answer never replaces the newer one', async () => {
  const { layer, held, drawnIds } = queuedLayer();
  layer.setParams({ view: 'PM2.5' });
  layer.enable();
  const first = layer.update();
  const second = layer.update();
  assert.equal(held.length, 2);
  held[1](stationRows('regional', 'Newer station'));
  await second;
  const newer = drawnIds();
  assert.equal(newer.length, 1);
  assert.match(newer[0], /newer-station/);
  held[0](stationRows('regional', 'Older station'));
  await first;
  assert.deepEqual(drawnIds(), newer);
  assert.equal(layer.getStats().count, 1);
  layer.destroy();
});

test('an answer that lands after the layer is switched off draws nothing', async () => {
  const { layer, held, drawnIds } = queuedLayer();
  layer.setParams({ view: 'PM2.5' });
  layer.enable();
  const pending = layer.update();
  layer.disable();
  held[0](stationRows('regional', 'Late station'));
  await pending;
  assert.deepEqual(drawnIds(), []);
  assert.equal(layer.getStats().count, 0);
  layer.destroy();
});
