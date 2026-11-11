import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import {
  _runSatellitePreRenderForTest,
  _setTrackedSatelliteRefreshStateForTest,
  _trackedFrameCartesianForTest,
} from './satellites.js';
import { setLocale } from '../i18n/index.js';

const L1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

function run(locale) {
  setLocale(locale);
  const entity = { gevLabelModel: { title: 'OLD', details: ['? km'] } };
  const point = { position: new Cesium.Cartesian3() };
  const viewer = { camera: null, scene: { frameState: { frameNumber: 1 } } };
  let nowMs = Date.UTC(2008, 8, 20, 12, 30);
  const near = (metres) => ({
    get position() {
      const tracked = _trackedFrameCartesianForTest();
      return new Cesium.Cartesian3(tracked.x + metres, tracked.y, tracked.z);
    },
  });
  _setTrackedSatelliteRefreshStateForTest({
    noradId: 25544,
    name: 'ISS (ZARYA)',
    satrec: twoline2satrec(L1, L2),
    entity,
    point,
    viewer,
    now: () => nowMs,
    neighbours: [
      { noradId: 55555, name: 'PROGRESS-MS 34', point: near(120) },
      { noradId: 55556, name: 'SOYUZ-MS 12', point: near(-90) },
    ],
  });
  _runSatellitePreRenderForTest();
  nowMs += 2000;
  viewer.scene.frameState.frameNumber = 2;
  _runSatellitePreRenderForTest();
  const details = entity.gevLabelModel.details;
  setLocale('en');
  return details;
}

test('es: tracked ISS card is localized', () => {
  const details = run('es');
  assert.equal(details[0], 'ESTACIÓN · ISS');
  assert.doesNotMatch(
    details[2],
    /^DOCKED/,
    'companions line should be localized',
  );
});

test('ru: tracked ISS card is localized', () => {
  const details = run('ru');
  assert.equal(details[0], 'СТАНЦИЯ · ISS');
  assert.match(details[1], /км/, 'ru glossary: km → км');
  assert.doesNotMatch(
    details[2],
    /^DOCKED/,
    'companions line should be localized',
  );
});
