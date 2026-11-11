// Edge cases for the military layer:
// one ICAO present in both feeds yields one target with the military card, and
// when the owning feed loses the contact the follow camera is released.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import flightsLayer, {
  _armFlightTrackingRestoreForTest,
  _setTrackedFlightRefreshStateForTest,
} from './flights.js';
import militaryFlightsLayer, {
  _setTrackedMilitaryRefreshStateForTest,
} from './militaryFlights.js';
import {
  isMilitaryIcao,
  registerMilitaryIcaos,
  setMilitaryLayerActive,
} from './militaryRegistry.js';
import { recordingAircraftRenderer } from '../testSupport/aircraftRecordingRenderer.mjs';

const SHARED_HEX = 'ae5e01';
const CIVIL_HEX = 'a0c1v1';

function collection() {
  const added = [];
  return {
    added,
    show: true,
    add(options) {
      const billboard = { ...options };
      added.push(billboard);
      return billboard;
    },
    remove() {},
  };
}

function militaryRow(fields = {}) {
  return {
    hex: SHARED_HEX,
    lon: -97.1,
    lat: 31.1,
    alt_baro: 24_000,
    alt_geom: 24_100,
    track: 90,
    gs: 380,
    seen: 0,
    seen_pos: 0,
    flight: 'RCH77  ',
    t: 'C17',
    r: '05-8152',
    ownOp: 'United States Air Force',
    ...fields,
  };
}

function openSkyState(icao24, callsign, nowSec, lon, lat) {
  return [
    icao24,
    callsign,
    'United States',
    nowSec - 2,
    nowSec - 2,
    lon,
    lat,
    7_000,
    false,
    200,
    90,
    0,
    null,
    7_050,
    null,
    null,
    0,
  ];
}

test('edge:military: an ICAO in both feeds draws one target and keeps the military card', async () => {
  const realFetch = globalThis.fetch;
  const realWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const viewer = { camera: { positionCartographic: null }, scene: {} };
  const milBillboards = collection();
  const civilBillboards = collection();
  _armFlightTrackingRestoreForTest(null);
  _setTrackedMilitaryRefreshStateForTest({
    renderer: ({ billboardCollection }) => recordingAircraftRenderer(null, {
      fleet: { ...billboardCollection, shown: billboardCollection?.show !== false },
    }),
    icao24: 'seedm0',
    entity: null,
    billboard: { show: false, position: Cesium.Cartesian3.ZERO },
    billboardCollection: milBillboards,
    viewer,
    meta: { rawLat: 0, rawLon: 0, onGround: false },
    tracked: false,
  });
  _setTrackedFlightRefreshStateForTest({
    renderer: ({ billboardCollection }) => recordingAircraftRenderer(null, {
      fleet: { ...billboardCollection, shown: billboardCollection?.show !== false },
    }),
    icao24: 'seedf0',
    entity: null,
    billboard: { show: false, position: Cesium.Cartesian3.ZERO },
    billboardCollection: civilBillboards,
    viewer,
    meta: { rawLat: 0, rawLon: 0, onGround: false },
    tracked: false,
  });
  const nowSec = Math.floor(Date.now() / 1000);
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/flights')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          time: nowSec,
          states: [
            // The civil feed reports the same airframe under its civil callsign.
            openSkyState(SHARED_HEX, 'CIVDUP ', nowSec, -97.11, 31.11),
            openSkyState(CIVIL_HEX, 'SWA1   ', nowSec, -97.5, 31.5),
          ],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ac: [militaryRow()] }),
    };
  };
  try {
    setMilitaryLayerActive(true);
    await militaryFlightsLayer.update(viewer);
    assert.equal(isMilitaryIcao(SHARED_HEX), true);
    await flightsLayer.update(viewer);

    const civilIds = civilBillboards.added.map((billboard) => billboard.id);
    assert.ok(civilIds.includes(CIVIL_HEX), 'the civil contact is drawn');
    assert.equal(
      civilIds.includes(SHARED_HEX),
      false,
      'the civil duplicate of a military ICAO is not drawn',
    );
    assert.equal(flightsLayer.hasContact(SHARED_HEX), false);
    assert.equal(militaryFlightsLayer.hasContact(SHARED_HEX), true);

    const [card] = militaryFlightsLayer
      .getAnalystRecords()
      .filter((record) => record.icao24 === SHARED_HEX);
    assert.equal(card.military, true);
    assert.equal(card.callsign, 'RCH77');
    assert.equal(
      flightsLayer
        .getAnalystRecords()
        .some((record) => record.icao24 === SHARED_HEX),
      false,
      'no second card for the same airframe',
    );
  } finally {
    setMilitaryLayerActive(false);
    globalThis.fetch = realFetch;
    globalThis.window = realWindow;
  }
});

test('edge:military: losing the tracked contact from the owning feed releases the camera', async () => {
  const realFetch = globalThis.fetch;
  const realWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const entity = { gevLabelModel: { title: 'RCH77', details: [] } };
  const viewer = {
    camera: { positionCartographic: null },
    scene: {},
    entities: { add: (value) => value, remove: () => true },
    trackedEntity: entity,
  };
  const renderer = recordingAircraftRenderer(null, { fleet: { shown: true } });
  renderer.follow.start(entity);
  _setTrackedMilitaryRefreshStateForTest({
    renderer: () => renderer,
    icao24: SHARED_HEX,
    entity,
    billboard: {
      show: false,
      position: Cesium.Cartesian3.fromDegrees(-97.1, 31.1, 7_300),
      color: Cesium.Color.WHITE,
    },
    billboardCollection: collection(),
    viewer,
    meta: {
      callsign: 'RCH77',
      type: 'C17',
      klass: 'widebody',
      altitudeFt: 24_000,
      renderAltitudeM: 7_300,
      speedMps: 195,
      track: 90,
      onGround: false,
      wasAirborne: true,
      turnRateDps: 0,
      rawLat: 31.1,
      rawLon: -97.1,
    },
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ac: [militaryRow({ hex: 'ae0ther' })] }),
  });
  try {
    setMilitaryLayerActive(true);
    registerMilitaryIcaos([SHARED_HEX]);
    assert.equal(militaryFlightsLayer.getTrackedInfo()?.icao24, SHARED_HEX);
    for (let poll = 0; poll < 6; poll += 1) {
      await militaryFlightsLayer.update(viewer);
      if (!militaryFlightsLayer.hasContact(SHARED_HEX)) break;
    }
    assert.equal(militaryFlightsLayer.hasContact(SHARED_HEX), false);
    assert.equal(
      renderer.follow.current(),
      undefined,
      'the follow camera is released',
    );
    assert.equal(militaryFlightsLayer.getTrackedInfo(), null);
    // The civil layer does not silently take the camera over.
    assert.equal(flightsLayer.getTrackedInfo?.() ?? null, null);
  } finally {
    setMilitaryLayerActive(false);
    globalThis.fetch = realFetch;
    globalThis.window = realWindow;
  }
});
