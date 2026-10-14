import assert from 'node:assert/strict';
import test from 'node:test';
import { createOceanStationsLayer } from './index.js';
import { buildOceanStationCard } from './cards.js';

function harness(source, { overlayEntries = [], clicks = [] } = {}) {
  const sources = [];
  const scene = {
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) },
    pick: () => null,
  };
  const viewer = {
    scene,
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        const index = sources.indexOf(value);
        if (index >= 0) sources.splice(index, 1);
      },
    },
  };
  const screenSpaceEventHandlerFactory = () => ({
    setInputAction(callback) {
      clicks.push(callback);
    },
    destroy() {},
  });
  const overlayHost = {
    setEntries(sourceId, entries) {
      overlayEntries.push({ sourceId, entries });
    },
    setVisible() {},
    clearSource() {},
  };
  const layer = createOceanStationsLayer({
    source,
    overlayHost,
    screenSpaceEventHandlerFactory,
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, overlayEntries, clicks };
}

const mockStation = {
  id: '41002',
  lat: 31.759,
  lon: -74.836,
  timeMs: 1760400000000,
  timeIso: '2026-10-14T01:50:00.000Z',
  windDirDeg: 90,
  windSpeedMps: 8.0,
  windGustMps: 10.0,
  waveHeightM: 2.1,
  wavePeriodSec: 8,
  avgWavePeriodSec: 6.5,
  waveDirDeg: 95,
  pressureHpa: 1018.5,
  pressureTendencyHpa: 1.2,
  airTempC: 22.4,
  waterTempC: 24.1,
  dewpointC: 18.0,
  visibilityNmi: 10.0,
  tideFt: null,
};

test('ocean stations layer lifecycle: init, enable, update, disable, destroy', async () => {
  const h = harness({ getSnapshot: async () => [mockStation] });
  assert.equal(h.sources.length, 1);
  assert.equal(h.layer.id, 'ocean-stations');
  assert.equal(h.layer.name, 'Ocean Stations (NDBC)');
  assert.equal(h.layer.source, 'NOAA NDBC');

  const updated = await h.layer.update(h.viewer);
  assert.equal(updated, true);
  assert.equal(h.layer.getStats().count, 1);
  assert.ok(h.layer.getStats().lastUpdate > 0);
  assert.equal(h.layer.getStats().error, null);

  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, '41002');
  assert.equal(records[0].waveHeightM, 2.1);
  assert.equal(records[0].waterTempC, 24.1);

  h.layer.disable(h.viewer);
  assert.deepEqual(h.layer.getAnalystRecords(), [], 'analyst records empty while disabled');

  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);
});

test('late refresh cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve([mockStation]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    h.layer.destroy(h.viewer);
  }
});

test('buildOceanStationCard formats temperatures, waves, wind, and link', () => {
  const card = buildOceanStationCard(mockStation, Date.now());
  assert.equal(card.id, 'ocean-station-card:41002');
  assert.equal(card.title, 'OCEAN STATION · 41002');
  assert.equal(card.interactive, true);
  assert.match(card.link, /ndbc\.noaa\.gov.*station=41002/);

  const text = card.details.join('\n');
  assert.match(text, /Waves: 2\.1 m \(6\.9 ft\) · 8s period/);
  assert.match(text, /Sea: 24\.1°C \(75\.4°F\)/);
  assert.match(text, /Air: 22\.4°C \(72\.3°F\)/);
  assert.match(text, /Wind: 15\.6 kts \(8\.0 m\/s\) @ 90° · gusts 19\.4 kts/);
  assert.match(text, /Pressure: 1018\.5 hPa \(\+1\.2\)/);
  assert.match(text, /Observed: 2026-10-14 01:50 UTC/);
});
