import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  STATION_PIN_DISABLE_DEPTH_TEST_DISTANCE,
  STATION_PIN_SCALE_BY_DISTANCE,
  STATION_PIN_SIZE_LOCAL,
  STATION_PIN_SIZE_PRINCIPAL,
  STATION_PIN_TRANSLUCENCY_BY_DISTANCE,
  createStationNetwork,
} from './stations.js';
import { transitStationClass } from './stationModel.js';

/** A viewer-shaped stub: the layer only adds and removes primitives. */
function viewerStub() {
  const primitives = [];
  return {
    primitives,
    viewer: {
      scene: {
        primitives: {
          add(primitive) {
            primitives.push(primitive);
            return primitive;
          },
          remove(primitive) {
            const index = primitives.indexOf(primitive);
            if (index >= 0) primitives.splice(index, 1);
            return index >= 0;
          },
        },
      },
    },
  };
}

/** The minimum state and services the station network needs. */
function harness() {
  const overlaySources = new Map();
  const state = {
    _enabled: true,
    _display: 'both',
    _stations: [],
    _stationPoints: new Cesium.PointPrimitiveCollection(),
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
  return { state, parts, network, renders, overlaySources };
}

test('the station network draws one point pin per station and no ground ellipse', () => {
  const app = harness();
  app.state._stations = [
    { id: 'a', name: 'Paris Gare du Nord', shortCode: 'PV', uic: '1', lon: 2.35, lat: 48.88, segment: 'A' },
    { id: 'b', name: 'Local halt', shortCode: null, uic: null, lon: 1.0, lat: 45.0, segment: 'A' },
  ];
  app.network.renderStations();
  assert.equal(app.state._stationPoints.length, 2);
  // The pins carry the class colour, and the pin sizes follow the rank.
  const principal = transitStationClass(app.state._stations[0]);
  const local = transitStationClass(app.state._stations[1]);
  const pins = app.state._stationPoints.get(0);
  assert.equal(pins.pixelSize, STATION_PIN_SIZE_PRINCIPAL);
  // The pin's RGB is the class colour the legend paints; the pin carries a
  // small alpha, which the distance translucency then fades further.
  const rgb = (color) => [color.red, color.green, color.blue];
  const expected = Cesium.Color.fromCssColorString(principal.color);
  assert.deepEqual(rgb(pins.color), rgb(expected));
  const second = app.state._stationPoints.get(1);
  assert.equal(second.pixelSize, STATION_PIN_SIZE_LOCAL);
  assert.deepEqual(
    rgb(second.color),
    rgb(Cesium.Color.fromCssColorString(local.color)),
  );
  // The distance behaviour is the Bike Share one: shrink and fade, never vanish.
  assert.equal(pins.scaleByDistance.near, STATION_PIN_SCALE_BY_DISTANCE.near);
  assert.equal(pins.scaleByDistance.far, STATION_PIN_SCALE_BY_DISTANCE.far);
  assert.equal(pins.scaleByDistance.nearValue, STATION_PIN_SCALE_BY_DISTANCE.nearScale);
  assert.equal(pins.scaleByDistance.farValue, STATION_PIN_SCALE_BY_DISTANCE.farScale);
  assert.equal(
    pins.translucencyByDistance.far,
    STATION_PIN_TRANSLUCENCY_BY_DISTANCE.far,
  );
  assert.equal(
    pins.translucencyByDistance.farValue,
    STATION_PIN_TRANSLUCENCY_BY_DISTANCE.farTranslucency,
  );
  assert.equal(pins.disableDepthTestDistance, STATION_PIN_DISABLE_DEPTH_TEST_DISTANCE);
  // A render is requested for the rebuilt network.
  assert.ok(app.renders.includes('transit-stations'));
  // The overlay labels are still published.
  assert.equal(app.overlaySources.get('transit-stations').length, 2);
});

test('rendering the network again replaces the pins instead of adding to them', () => {
  const app = harness();
  app.state._stations = [
    { id: 'a', name: 'A', shortCode: null, uic: null, lon: 1, lat: 45, segment: 'A' },
  ];
  app.network.renderStations();
  app.state._stations = [];
  app.network.renderStations();
  assert.equal(app.state._stationPoints.length, 0);
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
