import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';
import { bindRenderer } from '../../render/rendererOf.js';
import { hexColor } from '../../render/color.js';
import {
  STATION_PIN_DISABLE_DEPTH_TEST_DISTANCE,
  STATION_PIN_SCALE_BY_DISTANCE,
  STATION_PIN_SELECTED_SIZE,
  STATION_PIN_SIZE_LOCAL,
  STATION_PIN_SIZE_PRINCIPAL,
  STATION_PIN_TRANSLUCENCY_BY_DISTANCE,
  createStationNetwork,
} from './stations.js';
import { transitStationClass } from './stationModel.js';

/** A viewer double with a fake draw port and a camera the test can move. */
function viewerStub() {
  const viewer = {};
  const draw = fakeDrawPort();
  const camera = { height: 50_000, rect: null };
  bindRenderer(viewer, {
    draw,
    camera: {
      pose: () => ({ height: camera.height }),
      viewRectangle: () => camera.rect,
    },
  });
  return { viewer, draw, camera };
}

/** The minimum state and services the station network needs. */
function harness() {
  const overlaySources = new Map();
  const { viewer, draw, camera } = viewerStub();
  const state = {
    _enabled: true,
    _display: 'both',
    _stations: [],
    _viewer: viewer,
    _overlayHost: {
      setEntries(id, entries) {
        overlaySources.set(id, entries);
      },
      setVisible(id, visible) {
        overlaySources.set(`${id}:visible`, visible);
      },
    },
  };
  const renders = [];
  const parts = { selection: { clearSelection() {} } };
  const network = createStationNetwork({
    state,
    services: {
      render: { governorRequestRender: (why) => renders.push(why) },
    },
    parts,
    source: {},
  });
  network.createPins(viewer);
  state._stationPoints.show = true;
  /** The pin items the set holds, in order. */
  const pins = () => [...draw.set(state._stationPoints.id).items.values()];
  return { state, parts, network, renders, overlaySources, draw, camera, pins };
}

test('the station network draws one point pin per station and no ground ellipse', () => {
  const app = harness();
  app.state._stations = [
    {
      id: 'a',
      name: 'Paris Gare du Nord',
      shortCode: 'PV',
      uic: '1',
      lon: 2.35,
      lat: 48.88,
      segment: 'A',
    },
    {
      id: 'b',
      name: 'Local halt',
      shortCode: null,
      uic: null,
      lon: 1.0,
      lat: 45.0,
      segment: 'A',
    },
  ];
  app.network.renderStations();
  assert.equal(app.pins().length, 2);
  assert.equal(app.draw.set(app.state._stationPoints.id).spec.clampTo, 'both');
  // The pins carry the class colour, and the pin sizes follow the rank.
  const principal = transitStationClass(app.state._stations[0]);
  const local = transitStationClass(app.state._stations[1]);
  const [pins, second] = app.pins();
  assert.equal(pins.pixelSize, STATION_PIN_SIZE_PRINCIPAL);
  assert.equal(pins.height, 'clampGround');
  assert.equal(pins.id, 'sncf-station:a');
  assert.deepEqual(pins.color, hexColor(principal.color, 0.95));
  assert.equal(second.pixelSize, STATION_PIN_SIZE_LOCAL);
  assert.deepEqual(second.color, hexColor(local.color, 0.95));
  // The distance behaviour is the Bike Share one: shrink and fade, never vanish.
  assert.deepEqual(pins.scaleByDistance, {
    near: STATION_PIN_SCALE_BY_DISTANCE.near,
    nearValue: STATION_PIN_SCALE_BY_DISTANCE.nearScale,
    far: STATION_PIN_SCALE_BY_DISTANCE.far,
    farValue: STATION_PIN_SCALE_BY_DISTANCE.farScale,
  });
  assert.deepEqual(pins.fadeByDistance, {
    near: STATION_PIN_TRANSLUCENCY_BY_DISTANCE.near,
    nearValue: STATION_PIN_TRANSLUCENCY_BY_DISTANCE.nearTranslucency,
    far: STATION_PIN_TRANSLUCENCY_BY_DISTANCE.far,
    farValue: STATION_PIN_TRANSLUCENCY_BY_DISTANCE.farTranslucency,
  });
  assert.equal(pins.disableDepthTest, STATION_PIN_DISABLE_DEPTH_TEST_DISTANCE);
  // A render is requested for the rebuilt network.
  assert.ok(app.renders.includes('transit-stations'));
  // The overlay labels are still published.
  assert.equal(app.overlaySources.get('transit-stations').length, 2);
});

test('rendering the network again replaces the pins instead of adding to them', () => {
  const app = harness();
  app.state._stations = [
    {
      id: 'a',
      name: 'A',
      shortCode: null,
      uic: null,
      lon: 1,
      lat: 45,
      segment: 'A',
    },
  ];
  app.network.renderStations();
  app.state._stations = [];
  app.network.renderStations();
  assert.equal(app.pins().length, 0);
});

test('the display chips hide and show the station pins', () => {
  const app = harness();
  app.network.applyDisplayMode('vehicles');
  assert.equal(app.state._stationPoints.show, false);
  assert.equal(app.overlaySources.get('transit-stations:visible'), false);
  app.network.applyDisplayMode('stations');
  assert.equal(app.state._stationPoints.show, true);
  assert.equal(app.overlaySources.get('transit-stations:visible'), true);
  app.network.applyDisplayMode('both');
  assert.equal(app.state._stationPoints.show, true);
});

/** The harness needs the card slot the selection shares with vehicles. */
function selectableHarness() {
  const app = harness();
  const cleared = [];
  app.state._overlayHost.clearSource = (id) => {
    cleared.push(id);
    app.overlaySources.delete(id);
  };
  app.state._stations = [
    {
      id: 'chindrieux',
      name: 'Chindrieux',
      shortCode: 'CWX',
      uic: '87741116',
      insee: '73085',
      segment: 'C',
      lon: 5.8468876,
      lat: 45.8034376,
    },
    {
      id: 'vitry',
      name: 'Vitry-en-Artois',
      shortCode: 'VYN',
      uic: '87342113',
      insee: '62865',
      segment: 'C',
      lon: 2.9820833,
      lat: 50.3276092,
    },
  ];
  app.network.renderStations();
  return { ...app, cleared };
}

test('selecting a station highlights its pin and publishes a card with every catalogue field', () => {
  const app = selectableHarness();
  assert.equal(app.network.selectStation('chindrieux'), true);
  const card = app.overlaySources.get('transit-selected')[0];
  assert.equal(card.title, 'Chindrieux');
  const text = card.details.join('\n');
  for (const field of ['CWX', '87741116', 'Segment C', '73085', '45.80344']) {
    assert.ok(text.includes(field), `the card carries ${field}`);
  }
  const pin = app.pins().find((p) => p.id === 'sncf-station:chindrieux');
  assert.equal(pin.pixelSize, STATION_PIN_SELECTED_SIZE);
  // The other pin is untouched.
  assert.equal(
    app.pins().find((p) => p.id === 'sncf-station:vitry').pixelSize,
    STATION_PIN_SIZE_PRINCIPAL,
  );
});

test('selecting another station moves the highlight; clearing restores the pin and the card slot', () => {
  const app = selectableHarness();
  app.network.selectStation('chindrieux');
  app.network.selectStation('vitry');
  assert.equal(
    app.pins().find((p) => p.id === 'sncf-station:chindrieux').pixelSize,
    STATION_PIN_SIZE_PRINCIPAL,
  );
  assert.equal(
    app.overlaySources.get('transit-selected')[0].title,
    'Vitry-en-Artois',
  );
  assert.equal(app.network.clearStationSelection(), true);
  assert.equal(
    app.pins().find((p) => p.id === 'sncf-station:vitry').pixelSize,
    STATION_PIN_SIZE_PRINCIPAL,
  );
  assert.equal(app.overlaySources.has('transit-selected'), false);
  assert.equal(app.state._stationSelectedId, null);
  // Nothing selected: clearing again is a no-op.
  assert.equal(app.network.clearStationSelection(), false);
});

test('hiding the stations drops a selected station card; an unknown id selects nothing', () => {
  const app = selectableHarness();
  assert.equal(app.network.selectStation('nowhere'), false);
  app.network.selectStation('chindrieux');
  app.network.applyDisplayMode('vehicles');
  assert.equal(app.state._stationSelectedId, null);
  assert.equal(app.overlaySources.has('transit-selected'), false);
  // With the stations hidden they cannot be picked.
  assert.equal(app.network.selectStation('chindrieux'), false);
});

test('a catalogue rebuild keeps the selection, and drops it when the station is gone', () => {
  const app = selectableHarness();
  app.network.selectStation('vitry');
  app.network.renderStations();
  assert.equal(app.state._stationSelectedId, 'vitry');
  assert.equal(
    app.pins().find((p) => p.id === 'sncf-station:vitry').pixelSize,
    STATION_PIN_SELECTED_SIZE,
  );
  app.state._stations = app.state._stations.filter((s) => s.id !== 'vitry');
  app.network.renderStations();
  assert.equal(app.state._stationSelectedId, null);
  assert.equal(app.overlaySources.has('transit-selected'), false);
});

test('labels follow the camera: nearest the view, none from a national view', () => {
  const app = selectableHarness();
  app.camera.rect = { west: 5, south: 45, east: 7, north: 47 };
  app.camera.height = 50_000;
  app.network.refreshLabels();
  assert.deepEqual(
    app.overlaySources.get('transit-stations').map((e) => e.id),
    ['chindrieux'],
    'only the station inside the view is named',
  );
  app.camera.height = 3_000_000;
  app.network.refreshLabels();
  assert.deepEqual(app.overlaySources.get('transit-stations'), []);
});

test('the selected station is not also named by an ambient label', () => {
  const app = selectableHarness();
  app.network.selectStation('chindrieux');
  const ids = app.overlaySources.get('transit-stations').map((e) => e.id);
  assert.equal(ids.includes('chindrieux'), false);
  assert.equal(ids.includes('vitry'), true);
});

test('a failed catalogue read is retried on a backoff, and aborting cancels the retry', async () => {
  const app = harness();
  let calls = 0;
  const network = createStationNetwork({
    state: app.state,
    services: { render: { governorRequestRender() {} } },
    parts: app.parts,
    source: {
      async getStations() {
        calls += 1;
        throw new Error('SNCF stations HTTP 503');
      },
    },
  });
  assert.equal(await network.loadStations(), false);
  assert.equal(calls, 1);
  assert.equal(app.state._stationError, 'SNCF stations HTTP 503');
  assert.equal(app.state._stationFailures, 1);
  assert.ok(app.state._stationRetryTimer, 'a retry is queued');
  network.abortStations();
  assert.equal(app.state._stationRetryTimer, null, 'abort cancels the retry');
});

test('a successful read resets the failure count and the error', async () => {
  const app = harness();
  app.state._stationFailures = 3;
  app.state._stationError = 'old failure';
  const network = createStationNetwork({
    state: app.state,
    services: { render: { governorRequestRender() {} } },
    parts: app.parts,
    source: {
      async getStations() {
        return { stations: [], total: 0 };
      },
    },
  });
  assert.equal(await network.loadStations(), true);
  assert.equal(app.state._stationFailures, 0);
  assert.equal(app.state._stationError, null);
});
