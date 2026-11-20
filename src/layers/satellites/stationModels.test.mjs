// src/layers/satellites/stationModels.test.mjs — which station a catalog
// entry belongs to, over stand-in model parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ISS_NORAD, STATIONS, TIANGONG_NORAD } from './policy.js';
import {
  modelFor,
  stationModelFor,
  trackedStation,
  trackedStationOf,
} from './stationModels.js';

const NAUKA = 49044;
const SHENZHOU = 60000;
const GPS = 32711;

const part = (norad, standsIn = []) => ({
  norad,
  _standsInFor: (id) => standsIn.includes(id),
});

test('the layer knows the ISS and Tiangong, each with a LIVE key', () => {
  assert.deepEqual(
    STATIONS.map((s) => [s.key, s.norad]),
    [
      ['iss', ISS_NORAD],
      ['tiangong', TIANGONG_NORAD],
    ],
  );
  for (const station of STATIONS) assert.ok(station.companionRadiusM > 0);
});

test('an entry is drawn by the model at its own number, or one standing in for it', () => {
  const iss = part(ISS_NORAD, [NAUKA]);
  const tiangong = part(TIANGONG_NORAD, [SHENZHOU]);
  const models = [iss, tiangong];
  assert.equal(stationModelFor(models, ISS_NORAD), iss);
  assert.equal(stationModelFor(models, NAUKA), iss);
  assert.equal(stationModelFor(models, TIANGONG_NORAD), tiangong);
  assert.equal(stationModelFor(models, SHENZHOU), tiangong);
  assert.equal(stationModelFor(models, GPS), null);
  assert.equal(stationModelFor(models, null), null);
  assert.equal(stationModelFor([], ISS_NORAD), null);
});

test('the selected station: itself, a docked companion by position, by orbit, or by stand-in', () => {
  const models = [part(ISS_NORAD), part(TIANGONG_NORAD, [SHENZHOU])];
  const select = (selection) => trackedStationOf(STATIONS, models, selection);
  assert.equal(select({ trackedNorad: null }), null);
  assert.equal(select({ trackedNorad: GPS }), null);
  assert.equal(select({ trackedNorad: ISS_NORAD })?.key, 'iss');
  assert.equal(select({ trackedNorad: TIANGONG_NORAD })?.key, 'tiangong');
  // Nauka's dot shares the ISS's position.
  assert.equal(
    select({ trackedNorad: NAUKA, dockedCompanions: new Set([ISS_NORAD]) })
      ?.key,
    'iss',
  );
  // A Tianzhou judged docked by orbit when tracking began.
  assert.equal(
    select({ trackedNorad: 60001, trackedDockedToStation: TIANGONG_NORAD })
      ?.key,
    'tiangong',
  );
  // A Shenzhou whose dot the Tiangong model stands in for.
  assert.equal(select({ trackedNorad: SHENZHOU })?.key, 'tiangong');
  // The answer carries the station's model part, or null without one.
  assert.equal(select({ trackedNorad: ISS_NORAD })?.model, models[0]);
  assert.equal(
    trackedStationOf(STATIONS, [], { trackedNorad: TIANGONG_NORAD })?.model,
    null,
  );
});

test('the layer-state readers take the parts as built, or none', () => {
  const parts = {};
  const layerState = {
    _trackedNorad: SHENZHOU,
    _dockedCompanions: new Set(),
    _trackedDockedToStation: TIANGONG_NORAD,
  };
  assert.equal(modelFor(parts, ISS_NORAD), null);
  assert.equal(trackedStation(layerState, parts)?.key, 'tiangong');
  assert.equal(trackedStation(layerState, parts)?.model, null);
  parts.stationModels = [part(TIANGONG_NORAD)];
  assert.equal(
    trackedStation(layerState, parts)?.model,
    parts.stationModels[0],
  );
  assert.equal(modelFor(parts, TIANGONG_NORAD), parts.stationModels[0]);
});
