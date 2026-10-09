import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPINE_STATIONS_LAYER_ID,
  NEAREST_LIST_LIMIT,
  createAlpineStationsLayer,
} from './index.js';
import {
  ALPINE_OVERLAY_SOURCE_ID,
  MARKER_MIN_PX,
  OFFLINE_ACCENT,
  UNMEASURED_ACCENT,
} from './model.js';
import {
  ALPINE_NETWORK_IDS,
  SLF_NETWORK_ID,
  SMN_NETWORK_ID,
} from './networks.js';
import { DEFAULT_PARAMETER_ID, STATION_PARAMETER_IDS } from './parameters.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0);
const MEASURED = new Date(NOW - 10 * 60_000).toISOString();

/** A Cesium stand-in: enough surface for entity writes, nothing more. */
function fakeCesium() {
  return {
    Math: { toDegrees: (radians) => (radians * 180) / Math.PI },
    Color: {
      BLACK: { withAlpha: (alpha) => ({ black: alpha }) },
      fromCssColorString: (css) => ({ css }),
    },
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }), ZERO: 'zero' },
    BillboardGraphics: class {
      constructor(options) {
        Object.assign(this, { show: true }, options);
      }
    },
    HeightReference: { CLAMP_TO_GROUND: 'clamp' },
    Entity: class {
      constructor(options) {
        Object.assign(this, options);
        // Cesium wraps a Cartesian3 in a ConstantPositionProperty here. The
        // stub did not, which hid that aiming an arrow at `entity.position`
        // hands the projection a PROPERTY and silently never turns it.
        this.position = { isPositionProperty: true, _value: options.position };
      }
    },
    CustomDataSource: class {
      constructor(name) {
        this.name = name;
        this.show = false;
        const values = [];
        this.entities = {
          values,
          add(entity) {
            values.push(entity);
            return entity;
          },
          remove(entity) {
            const at = values.indexOf(entity);
            if (at >= 0) values.splice(at, 1);
            return at >= 0;
          },
          removeAll() {
            values.length = 0;
          },
        };
      }
    },
  };
}

function fakeViewer({ lat = 46.0, lon = 7.75 } = {}) {
  const listeners = new Set();
  const removed = [];
  return {
    removed,
    moveEnd() {
      for (const listener of [...listeners]) listener();
    },
    setCentre(nextLat, nextLon) {
      this.camera.positionCartographic.latitude = (nextLat * Math.PI) / 180;
      this.camera.positionCartographic.longitude = (nextLon * Math.PI) / 180;
    },
    // aimArrows resolves a world bearing against the scene, so a viewer
    // without one draws arrows that never turn.
    scene: {},
    camera: {
      positionCartographic: {
        latitude: (lat * Math.PI) / 180,
        longitude: (lon * Math.PI) / 180,
        height: 20_000,
      },
      moveEnd: {
        addEventListener(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            removed.push(listener);
          };
        },
      },
    },
    dataSources: {
      added: [],
      add(dataSource) {
        this.added.push(dataSource);
      },
      remove(dataSource) {
        this.added = this.added.filter((entry) => entry !== dataSource);
      },
    },
  };
}

function fakeOverlayHost() {
  const calls = { setEntries: [], setVisible: [], clearSource: [] };
  return {
    calls,
    setEntries: (...args) => calls.setEntries.push(args),
    setVisible: (...args) => calls.setVisible.push(args),
    clearSource: (...args) => calls.clearSource.push(args),
    get entries() {
      return calls.setEntries.at(-1)?.[1] ?? [];
    },
  };
}

const station = (overrides = {}) => ({
  id: `${overrides.networkId ?? SLF_NETWORK_ID}:${overrides.code ?? 'DAV2'}`,
  networkId: SLF_NETWORK_ID,
  code: 'DAV2',
  label: 'Bärentälli',
  lat: 46.0,
  lon: 7.75,
  elevationM: 2558,
  region: 'GR',
  country: 'CH',
  measuredAt: MEASURED,
  airTempC: -3.5,
  snowDepthCm: 42,
  precipMm: null,
  pressureQffHpa: null,
  humidityPct: 70,
  windSpeedMs: 6,
  windGustMs: 11,
  windDirDeg: 270,
  ...overrides,
});

const snapshot = (stations = [station()], overrides = {}) => ({
  stations,
  // Every registered network, reachable. `supportingNetworks()` reads this to
  // decide which operators to name for the selected parameter, so a fixture
  // listing only one would under-report them.
  networks: ALPINE_NETWORK_IDS.map((id) => ({
    id,
    status: 'ok',
    stationCount: stations.filter((entry) => entry.networkId === id).length,
  })),
  attribution: 'WSL (CC BY 4.0)',
  fetchedAt: MEASURED,
  stale: false,
  unavailable: false,
  reason: null,
  ...overrides,
});

function build({ stations, snapshotOverrides, fail, rotations } = {}) {
  const overlayHost = fakeOverlayHost();
  const viewer = fakeViewer();
  const cesium = fakeCesium();
  let served = snapshot(stations, snapshotOverrides);
  const source = {
    calls: 0,
    async getSnapshot({ signal } = {}) {
      source.calls++;
      signal?.throwIfAborted();
      if (fail) throw new Error('upstream down');
      return served;
    },
  };
  // The real pair needs a canvas and a live Scene; these stand in for both.
  const projected = [];
  const layer = createAlpineStationsLayer({
    source,
    overlayHost,
    cesium,
    now: () => NOW,
    arrowImage: () => 'data:image/png;base64,ARROW',
    projectRotation: (scene, position, bearingDeg, previous) => {
      projected.push({ position, bearingDeg, previous });
      return rotations ? rotations(bearingDeg) : (bearingDeg * Math.PI) / 180;
    },
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    overlayHost,
    source,
    projected,
    dataSource: viewer.dataSources.added[0],
    serve(next) {
      served = next;
    },
  };
}

test('construction refuses a source or overlay host it cannot use', () => {
  assert.throws(() => createAlpineStationsLayer(), /snapshot source/);
  assert.throws(() => createAlpineStationsLayer({ source: {} }), /snapshot source/);
  assert.throws(
    () => createAlpineStationsLayer({ source: { getSnapshot() {} } }),
    /overlay host/,
  );
});

test('the layer registers under its catalog id with the weather cadence', () => {
  const { layer } = build();
  assert.equal(layer.id, ALPINE_STATIONS_LAYER_ID);
  assert.equal(layer.updateInterval, 300_000);
  assert.equal(layer.getParams().parameter, DEFAULT_PARAMETER_ID);
});

test('a second init is refused rather than leaking the first data source', () => {
  const { layer, viewer } = build();
  assert.throws(() => layer.init(viewer), /already initialized/);
});

test('enabling draws nothing until a poll arrives, and shows the data source', async () => {
  const { layer, dataSource, overlayHost } = build();
  assert.equal(dataSource.show, false);
  layer.enable();
  assert.equal(dataSource.show, true);
  assert.deepEqual(overlayHost.calls.setVisible.at(-1), [
    ALPINE_OVERLAY_SOURCE_ID,
    true,
  ]);
  assert.equal(dataSource.entities.values.length, 0);
  await layer.update();
  assert.equal(dataSource.entities.values.length, 1);
});

test('an update while disabled does nothing and never reaches the source', async () => {
  const { layer, source } = build();
  assert.equal(await layer.update(), false);
  assert.equal(source.calls, 0);
});

test('entity geometry is static: no property is a callback', async () => {
  // A CallbackProperty here would re-evaluate every frame for data that
  // changes every ten minutes.
  const { layer, dataSource } = build();
  layer.enable();
  await layer.update();
  const [entity] = dataSource.entities.values;
  assert.equal(entity.id, `alpine-station:${SLF_NETWORK_ID}:DAV2`);
  for (const value of [
    entity.point.pixelSize,
    entity.point.color,
    entity.position,
  ])
    assert.notEqual(typeof value, 'function');
  assert.equal(typeof entity.point.pixelSize, 'number');
});

test('changing the parameter recolours in place instead of rebuilding', async () => {
  // 650 entities are cheap to tint and expensive to reconstruct, and
  // reconstructing them would throw away the scene's labelling work.
  const { layer, dataSource } = build();
  layer.enable();
  await layer.update();
  const [before] = dataSource.entities.values;
  const windColor = before.point.color;
  layer.setParams({ parameter: 'temperature' });
  const [after] = dataSource.entities.values;
  assert.equal(dataSource.entities.values.length, 1);
  assert.equal(after, before, 'the same entity object is retained');
  assert.notEqual(after.point.color, windColor, 'but it was retinted');
});

test('an unknown parameter degrades to the default rather than throwing', () => {
  const { layer } = build();
  layer.enable();
  layer.setParams({ parameter: 'barometric-vibes' });
  assert.equal(layer.getParams().parameter, DEFAULT_PARAMETER_ID);
  for (const id of STATION_PARAMETER_IDS) {
    layer.setParams({ parameter: id });
    assert.equal(layer.getParams().parameter, id);
  }
});

test('a station that stops being published loses its entity', async () => {
  const { layer, dataSource, serve } = build({
    stations: [station(), station({ code: 'VSC1', id: `${SLF_NETWORK_ID}:VSC1` })],
  });
  layer.enable();
  await layer.update();
  assert.equal(dataSource.entities.values.length, 2);
  serve(snapshot([station()]));
  await layer.update();
  assert.equal(dataSource.entities.values.length, 1);
  assert.equal(
    dataSource.entities.values[0].id,
    `alpine-station:${SLF_NETWORK_ID}:DAV2`,
  );
});

test('only stations with a reading for the selected parameter get a label', async () => {
  const { layer, overlayHost } = build({
    stations: [
      station(),
      station({ code: 'NOPRESS', id: `${SLF_NETWORK_ID}:NOPRESS` }),
    ],
  });
  layer.enable();
  await layer.update();
  assert.equal(overlayHost.entries.length, 2, 'both report wind');
  layer.setParams({ parameter: 'pressure' });
  assert.equal(
    overlayHost.entries.length,
    0,
    'neither carries a barometer, so neither is labelled',
  );
});

test('an offline and an unmeasured station draw at minimum size, in their own greys', async () => {
  const { layer, dataSource } = build({
    stations: [
      station({
        code: 'SILENT',
        id: `${SLF_NETWORK_ID}:SILENT`,
        measuredAt: null,
        airTempC: null,
        snowDepthCm: null,
        humidityPct: null,
        windSpeedMs: null,
        windGustMs: null,
        windDirDeg: null,
      }),
    ],
  });
  layer.enable();
  await layer.update();
  assert.equal(dataSource.entities.values[0].point.color.css, OFFLINE_ACCENT);
  assert.equal(dataSource.entities.values[0].point.pixelSize, MARKER_MIN_PX);
  layer.setParams({ parameter: 'pressure' });
  assert.equal(dataSource.entities.values[0].point.color.css, OFFLINE_ACCENT);
});

test('a reporting station that lacks the selected sensor is unmeasured, not offline', async () => {
  const { layer, dataSource } = build();
  layer.enable();
  await layer.update();
  layer.setParams({ parameter: 'pressure' });
  assert.equal(dataSource.entities.values[0].point.color.css, UNMEASURED_ACCENT);
});

test('the card lists the nearest stations in view, bounded and nearest first', async () => {
  const far = Array.from({ length: 10 }, (_, index) =>
    station({
      code: `S${index}`,
      id: `${SLF_NETWORK_ID}:S${index}`,
      lat: 46.0 + index * 0.05,
    }),
  );
  const { layer } = build({ stations: far });
  layer.enable();
  await layer.update();
  const { list } = layer.getRowControls();
  assert.equal(list.items.length, NEAREST_LIST_LIMIT);
  assert.equal(list.items[0].id, `${SLF_NETWORK_ID}:S0`);
  assert.ok(list.items.every((item) => item.params.stationId === item.id));
  assert.equal(new Set(list.items.map((item) => item.id)).size, list.items.length);
});

test('settling the camera republishes the list only when its membership changes', async () => {
  // The objection this answers: nothing about the geometry depends on the
  // camera, so a settle must never rebuild an entity.
  const near = station({ code: 'NEAR', id: `${SLF_NETWORK_ID}:NEAR`, lat: 46.0 });
  const away = station({ code: 'AWAY', id: `${SLF_NETWORK_ID}:AWAY`, lat: 47.5 });
  const { layer, viewer, dataSource } = build({ stations: [near, away] });
  let notices = 0;
  layer.setRowControlsListener(() => notices++);
  layer.enable();
  await layer.update();
  const entities = [...dataSource.entities.values];
  notices = 0;

  viewer.moveEnd();
  assert.equal(notices, 0, 'a settle that changes nothing is silent');
  viewer.setCentre(46.001, 7.75);
  viewer.moveEnd();
  assert.equal(notices, 0, 'panning within the same neighbourhood is silent too');
  viewer.setCentre(47.5, 7.75);
  viewer.moveEnd();
  assert.equal(notices, 1, 'a changed list is published once');
  assert.deepEqual(
    dataSource.entities.values,
    entities,
    'and no entity was touched',
  );
});

test('disabling releases the camera listener and the overlay source', async () => {
  const { layer, viewer, overlayHost, dataSource } = build();
  layer.enable();
  await layer.update();
  layer.disable();
  assert.equal(viewer.removed.length, 1, 'the moveEnd listener is released');
  assert.equal(dataSource.show, false);
  assert.deepEqual(overlayHost.calls.clearSource.at(-1), [
    ALPINE_OVERLAY_SOURCE_ID,
  ]);
  assert.deepEqual(overlayHost.calls.setVisible.at(-1), [
    ALPINE_OVERLAY_SOURCE_ID,
    false,
  ]);
  viewer.moveEnd();
  assert.equal(viewer.removed.length, 1, 'and a later settle does nothing');
});

test('the card settings offer every parameter with exactly one active', async () => {
  const { layer } = build();
  layer.enable();
  await layer.update();
  const [setting] = layer.getRowControls().summary.settings;
  assert.equal(setting.id, 'parameter');
  assert.deepEqual(
    setting.chips.map((chip) => chip.id),
    [...STATION_PARAMETER_IDS],
  );
  assert.equal(setting.chips.filter((chip) => chip.active).length, 1);
  layer.setParams({ parameter: 'snow' });
  const after = layer.getRowControls().summary.settings[0].chips;
  assert.equal(after.find((chip) => chip.active).id, 'snow');
});

test('the card is a readout with a legend covering the selected parameter', async () => {
  const { layer } = build();
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assert.equal(controls.readout, true, 'the row stays a toggle and a meta line');
  assert.ok(controls.legend.length >= 5);
  for (const entry of controls.legend) {
    assert.match(entry.color, /^#[0-9a-f]{6}$/);
    assert.ok(entry.label.length);
  }
  assert.equal(controls.summary.units, 'km/h');
  layer.setParams({ parameter: 'snow' });
  assert.equal(layer.getRowControls().summary.units, 'cm');
});

test('the card names the networks that publish the selected parameter', async () => {
  const { layer } = build();
  layer.enable();
  await layer.update();
  assert.match(layer.getRowControls().summary.detail, /SLF IMIS/);
  layer.setParams({ parameter: 'pressure' });
  const pressure = layer.getRowControls().summary;
  assert.match(pressure.detail, /SwissMetNet/);
  assert.ok(
    !pressure.detail.includes('SLF IMIS'),
    'a network without a barometer is not claimed',
  );
  assert.ok(
    pressure.actions.every((action) => action.href.startsWith('https://')),
  );
});

test('selecting a station adds its detail and a way to clear it', async () => {
  const { layer } = build();
  layer.enable();
  await layer.update();
  assert.equal(layer.getRowControls().summary.result, undefined);
  layer.setParams({ stationId: `${SLF_NETWORK_ID}:DAV2` });
  const selected = layer.getRowControls();
  assert.equal(selected.summary.result.label, 'Bärentälli');
  assert.ok(selected.summary.result.lines.length);
  assert.deepEqual(selected.summary.result.clear.params, { clear: true });
  assert.match(selected.summary.compact, /Bärentälli selected/);
  assert.equal(selected.list.items[0].active, true);
  layer.setParams({ clear: true });
  assert.equal(layer.getRowControls().summary.result, undefined);
});

test('selecting a station that is not loaded selects nothing', async () => {
  const { layer } = build();
  layer.enable();
  await layer.update();
  layer.setParams({ stationId: 'nope:NOPE' });
  assert.equal(layer.getRowControls().summary.result, undefined);
});

test('feed staleness and late stations are reported separately', async () => {
  // `layerFeedState()` renders the row STALE on any truthy `stats.stale`, so a
  // healthy network with late boxes must not set it.
  const late = station({
    code: 'LATE',
    id: `${SLF_NETWORK_ID}:LATE`,
    measuredAt: new Date(NOW - 7 * 24 * 60 * 60_000).toISOString(),
  });
  const { layer } = build({ stations: [station(), late] });
  layer.enable();
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.stale, false, 'the proxy served fresh data');
  assert.equal(stats.staleStations, 1);
  assert.equal(stats.count, 2);
  assert.match(stats.countLabel, /2\/2 reporting/);
  assert.match(
    layer.getRowControls().summary.lines.find((line) => line.id === 'reporting')
      .text,
    /1 late/,
  );
});

test('a cached payload sets feed staleness', async () => {
  const { layer } = build({ snapshotOverrides: { stale: true } });
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().stale, true);
});

test('an unreachable network is reported without blanking the layer', async () => {
  const { layer } = build({
    snapshotOverrides: {
      networks: [
        { id: SLF_NETWORK_ID, status: 'ok', stationCount: 1 },
        { id: SMN_NETWORK_ID, status: 'unavailable', stationCount: 0 },
      ],
      reason: '1 of 2 networks unavailable',
    },
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.match(layer.getRowControls().summary.status, /1 of 2 networks/);
  assert.equal(layer.getStats().unavailable, false);
  assert.equal(layer.getStats().count, 1, 'the network that answered is drawn');
});

test('a failed poll surfaces as a status, keeping the previous draw', async () => {
  const { layer, dataSource } = build();
  layer.enable();
  await layer.update();
  assert.equal(dataSource.entities.values.length, 1);
  const failing = createAlpineStationsLayer({
    source: {
      async getSnapshot() {
        throw new Error('upstream down');
      },
    },
    overlayHost: fakeOverlayHost(),
    cesium: fakeCesium(),
    now: () => NOW,
  });
  failing.init(fakeViewer());
  failing.enable();
  assert.equal(await failing.update(), false);
  assert.equal(failing.getRowControls().summary.status, 'upstream down');
  assert.equal(failing.getStats().error, 'upstream down');
});

test('a superseded poll cannot overwrite the newer one', async () => {
  // `update` aborts its predecessor; a late reply must not land.
  const { layer, dataSource, serve } = build();
  layer.enable();
  await layer.update();
  serve(snapshot([station({ code: 'NEW', id: `${SLF_NETWORK_ID}:NEW` })]));
  const first = layer.update();
  const second = layer.update();
  await Promise.allSettled([first, second]);
  assert.equal(dataSource.entities.values.length, 1);
  assert.equal(
    dataSource.entities.values[0].id,
    `alpine-station:${SLF_NETWORK_ID}:NEW`,
  );
});

test('analyst records are empty while off, and plain values while on', async () => {
  const { layer } = build();
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.enable();
  await layer.update();
  const [record] = layer.getAnalystRecords();
  assert.equal(record.id, `${SLF_NETWORK_ID}:DAV2`);
  assert.equal(record.measuredAtMs, Date.parse(MEASURED));
  assert.equal(layer.getAnalystRecords(0).length, 0);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
});

test('the card carries the attribution and the not-a-danger-rating caveat', async () => {
  // CC BY is a licence condition, and snow depth is a measurement.
  const { layer } = build();
  layer.enable();
  await layer.update();
  const { info, infoTitle } = layer.getRowControls();
  assert.match(info, /CC BY 4\.0/);
  assert.match(info, /not an avalanche danger rating/);
  assert.match(infoTitle, /not an avalanche danger rating/);
});

test('destroy releases the data source, the listener and the overlay', async () => {
  const { layer, viewer, overlayHost, dataSource } = build();
  layer.enable();
  await layer.update();
  layer.destroy();
  assert.equal(viewer.dataSources.added.includes(dataSource), false);
  assert.equal(viewer.removed.length, 1);
  assert.deepEqual(overlayHost.calls.clearSource.at(-1), [
    ALPINE_OVERLAY_SOURCE_ID,
  ]);
  assert.deepEqual(layer.getAnalystRecords(), []);
  assert.equal(await layer.update(), false);
});

test('a selected station reads once, in the result block, not twice', async () => {
  // The card renders `summary.lines` as a details block AND `summary.result`
  // as its own block. The same readings in both would print twice.
  const { layer } = build();
  layer.enable();
  await layer.update();
  layer.setParams({ stationId: `${SLF_NETWORK_ID}:DAV2` });
  const { summary } = layer.getRowControls();
  assert.ok(summary.result.lines.length);
  const detailText = summary.lines.map((line) => line.text);
  for (const line of summary.result.lines)
    assert.ok(
      !detailText.includes(line.text),
      `"${line.text}" is printed in both blocks`,
    );
  // And the network summary lines are still there.
  assert.ok(summary.lines.some((line) => line.id === 'reporting'));
});

test('the card badge names each country once, not once per network', () => {
  // Two of the three networks are Swiss, so mapping network -> country gave
  // "CH · CH · AT".
  const { layer } = build();
  layer.enable();
  assert.equal(layer.getRowControls().summary.coverage, 'CH · AT');
});

test('a network that did not answer is not named as a source for a reading', async () => {
  // Choosing snow while SLF is unreachable leaves the Swiss half of the snow
  // picture off the map; the card must not go on claiming SLF supplies it.
  const { layer } = build({
    snapshotOverrides: {
      networks: [
        { id: SLF_NETWORK_ID, status: 'unavailable', stationCount: 0 },
        { id: SMN_NETWORK_ID, status: 'ok', stationCount: 1 },
      ],
      reason: '1 of 2 networks unavailable',
    },
  });
  layer.enable();
  await layer.update();
  layer.setParams({ parameter: 'snow' });
  const { summary } = layer.getRowControls();
  assert.ok(!summary.detail.includes('SLF IMIS'), summary.detail);
  assert.deepEqual(summary.actions, [], 'and offers no link to its site');
  // SwissMetNet publishes no snow either, so nothing reachable supplies it.
  assert.match(summary.status, /No reachable network publishes snow depth/);
});

test('with every network reachable the status stays quiet', async () => {
  const { layer } = build();
  layer.enable();
  await layer.update();
  layer.setParams({ parameter: 'snow' });
  const { summary } = layer.getRowControls();
  assert.equal(summary.status, null);
  assert.match(summary.detail, /SLF IMIS/);
});

test('the wind view draws arrows, and every other view draws dots', async () => {
  const { layer, dataSource } = build();
  layer.enable();
  await layer.update();
  const [entity] = dataSource.entities.values;
  assert.ok(entity.billboard, 'the wind view gives a station a billboard');
  assert.equal(entity.billboard.show, true);
  assert.equal(entity.point.show, false, 'and hides its dot');
  assert.equal(entity.billboard.image, 'data:image/png;base64,ARROW');

  layer.setParams({ parameter: 'temperature' });
  assert.equal(entity.billboard.show, false, 'temperature has no direction');
  assert.equal(entity.point.show, true);
  assert.equal(
    dataSource.entities.values.length,
    1,
    'and swapping the symbol never replaces the entity',
  );
  assert.equal(dataSource.entities.values[0], entity);
});

test('the arrow points where the wind is GOING, not where it comes from', async () => {
  // All three networks publish the direction the wind blows FROM, per the WMO
  // convention. The label keeps that reading; the arrow is its reverse.
  const { layer, projected } = build({
    stations: [station({ windDirDeg: 270, windSpeedMs: 6 })],
  });
  layer.enable();
  await layer.update();
  assert.ok(projected.length);
  assert.equal(projected.at(-1).bearingDeg, 90, 'wind FROM the west blows east');
});

test('a station with no vane, or calm air, stays a dot', async () => {
  // Pointing an arrow with a vane in still air would assert a direction the
  // station never really measured.
  const { layer, dataSource } = build({
    stations: [
      station({ code: 'NOVANE', id: `${SLF_NETWORK_ID}:NOVANE`, windDirDeg: null }),
      station({ code: 'CALM', id: `${SLF_NETWORK_ID}:CALM`, windSpeedMs: 0.1 }),
      station({ code: 'BLOWING', id: `${SLF_NETWORK_ID}:BLOWING` }),
    ],
  });
  layer.enable();
  await layer.update();
  const byId = Object.fromEntries(
    dataSource.entities.values.map((entity) => [entity.id, entity]),
  );
  for (const code of ['NOVANE', 'CALM']) {
    const entity = byId[`alpine-station:${SLF_NETWORK_ID}:${code}`];
    assert.ok(!entity.billboard?.show, `${code} should stay a dot`);
    assert.equal(entity.point.show, true, code);
  }
  const blowing = byId[`alpine-station:${SLF_NETWORK_ID}:BLOWING`];
  assert.equal(blowing.billboard.show, true);
});

test('a silent or stale station never gets an arrow', async () => {
  const { layer, dataSource } = build({
    stations: [
      station({
        code: 'STALE',
        id: `${SLF_NETWORK_ID}:STALE`,
        measuredAt: new Date(NOW - 7 * 24 * 60 * 60_000).toISOString(),
      }),
    ],
  });
  layer.enable();
  await layer.update();
  const [entity] = dataSource.entities.values;
  assert.ok(!entity.billboard?.show);
  assert.equal(entity.point.show, true);
});

test('arrows are re-aimed when the camera settles, touching no geometry', async () => {
  // A billboard is a camera-facing quad, so a world bearing is resolved in
  // screen space and therefore depends on the camera. Re-aiming writes one
  // number per arrow; it must not create, destroy or re-tessellate anything.
  let heading = 0;
  const { layer, viewer, dataSource, projected } = build({
    rotations: (bearingDeg) => ((bearingDeg + heading) * Math.PI) / 180,
  });
  layer.enable();
  await layer.update();
  const [entity] = dataSource.entities.values;
  const first = entity.billboard.rotation;
  const drawn = projected.length;

  heading = 90;
  viewer.setCentre(47.5, 13.0);
  viewer.moveEnd();
  assert.ok(projected.length > drawn, 'the settle re-projected the bearing');
  assert.notEqual(entity.billboard.rotation, first, 'and turned the arrow');
  assert.equal(dataSource.entities.values.length, 1);
  assert.equal(dataSource.entities.values[0], entity, 'the same entity object');
  assert.ok(entity.billboard, 'with the same billboard');
});

test('a settle that does not move the arrow leaves it alone', async () => {
  // Sub-degree projection noise must not jitter 600 arrows against their own
  // rounding on every settle.
  const { layer, viewer, dataSource } = build();
  layer.enable();
  await layer.update();
  const [entity] = dataSource.entities.values;
  const before = entity.billboard.rotation;
  viewer.moveEnd();
  assert.equal(entity.billboard.rotation, before);
});

test('an arrow carries the same band colour and grows with the reading', async () => {
  const { layer, dataSource } = build({
    stations: [
      station({ code: 'LIGHT', id: `${SLF_NETWORK_ID}:LIGHT`, windSpeedMs: 2 }),
      station({ code: 'STORM', id: `${SLF_NETWORK_ID}:STORM`, windSpeedMs: 25 }),
    ],
  });
  layer.enable();
  await layer.update();
  const [light, storm] = dataSource.entities.values;
  assert.ok(storm.billboard.width > light.billboard.width);
  assert.notEqual(storm.billboard.color.css, light.billboard.color.css);
  assert.equal(storm.billboard.alignedAxis, 'zero', 'never an aligned axis');
});

test('without a canvas the layer falls back to dots rather than failing', async () => {
  // Server-side rendering and headless harnesses have no document.
  const overlayHost = fakeOverlayHost();
  const layer = createAlpineStationsLayer({
    source: { async getSnapshot() { return snapshot(); } },
    overlayHost,
    cesium: fakeCesium(),
    now: () => NOW,
    arrowImage: () => null,
    projectRotation: () => 0,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const [entity] = viewer.dataSources.added[0].entities.values;
  assert.equal(entity.billboard, undefined);
  assert.equal(entity.point.show, true);
});

test('an arrow is aimed with its cartesian, never with its position property', () => {
  // Cesium wraps an entity position in a PositionProperty. Handing one to the
  // screen projection yields no rotation at all, and the arrows then sit at a
  // fixed screen angle that looks plausible and means nothing.
  const { layer, projected, dataSource } = build();
  layer.enable();
  return layer.update().then(() => {
    assert.ok(projected.length, 'the arrow was aimed');
    const [entity] = dataSource.entities.values;
    assert.ok(
      entity.position.isPositionProperty,
      'the fixture must model Cesium wrapping the position',
    );
    for (const call of projected) {
      assert.ok(call.position, 'a position was passed');
      assert.ok(
        !call.position.isPositionProperty,
        'but it must be the cartesian, not the property',
      );
      assert.equal(call.position.lat, 46.0);
      assert.equal(call.position.lon, 7.75);
    }
  });
});
