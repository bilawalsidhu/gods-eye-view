// Reproduction: a visible view row whose sheet is still loading must keep
// whenSettled() waiting, even when its flat fallback is already packed.
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { createCesiumDraw } from './draw.js';
import { iconAtlas } from '../../data/iconAtlas.js';
import { AIRCRAFT_VIEWS } from '../../data/aircraftViews.js';

function fakeScene() {
  const added = [];
  return {
    added,
    renders: 0,
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: { time: Cesium.JulianDate.now() },
    primitives: {
      add: (p) => (added.push(p), p),
      remove: (p) => {
        const i = added.indexOf(p);
        if (i >= 0) added.splice(i, 1);
        return i >= 0;
      },
      length: 0,
    },
    requestRender() {
      this.renders += 1;
    },
    isDestroyed: () => false,
  };
}

const AT = Cesium.Cartesian3.fromDegrees(4.1, 51.95, 2);

test('a view row waits on its loading sheet even once its fallback is ready', () => {
  const part = createCesiumDraw({
    scene: fakeScene(),
    report: (e) => assert.fail(e),
  });
  const draw = part.port;
  draw.views(AIRCRAFT_VIEWS.id, AIRCRAFT_VIEWS.sheet);
  const set = draw.icons({ id: 'pending-sheet' });
  set.set([
    {
      id: 'a',
      pos: { x: AT.x, y: AT.y, z: AT.z },
      image: {
        views: AIRCRAFT_VIEWS.id,
        first: 0,
        fallback: 'pending-sheet-fallback.png',
      },
      size: [32, 32],
      rotationMode: 'course',
      course: 30,
    },
  ]);
  const record = part.sets.get('pending-sheet');
  const rows = record.gpu.set;
  const fallback = rows.imageNear(rows.row('a'));
  assert.ok(fallback >= 0, 'the fallback has an atlas slot');
  // The fallback is packed (Node packs nothing: mark its rectangle drawn).
  iconAtlas.rects[fallback * 4 + 2] = 1;
  assert.equal(record.host.viewsState(), 'loading', 'the sheet still loads');
  assert.equal(record.gpu.imageState(), 'loading');
  // Control: once the sheet fails for good, the ready fallback is final.
  record.host._viewsFrom = record.host._views();
  record.host._viewEntry = { state: 'failed', texture: null, listeners: new Set() };
  assert.equal(record.gpu.imageState(), 'settled');
  set.dispose();
});
